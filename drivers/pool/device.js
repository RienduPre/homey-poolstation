'use strict';

const Homey = require('homey');
const { PoolstationAuthError, PoolstationTwoFactorError } = require('../../lib/PoolstationApi');
const P = require('../../lib/pool');

/** Writable capabilities and the pool setting behind them. */
const TARGETS = {
  pool_target_ph: 'target_ph',
  pool_target_orp: 'target_orp',
  pool_target_chlorine: 'target_clppm',
  pool_target_production: 'target_percentage_electrolysis',
};

/** After a write, ignore polled values for that capability for a while (cloud lag). */
const HOLD_MS = 45 * 1000;
const DEFAULT_POLL_S = 60;
const MIN_POLL_S = 30;
const WARN_AFTER_FAILURES = 3;

const VALUE_TRIGGERS = {
  pool_ph: ['ph_changed', 'ph'],
  pool_orp: ['orp_changed', 'orp'],
  pool_chlorine: ['chlorine_changed', 'chlorine'],
};

class PoolDevice extends Homey.Device {

  async onInit() {
    this.api = this.homey.app.api;
    this.poolId = this.getData().id;
    this.pool = null;
    this.authFailed = false;
    this.failures = 0;
    this.hold = {};
    this.listening = new Set();
    for (const cap of this.getCapabilities()) this.listen(cap);

    await this.update();
    this.startPolling(this.getSetting('poll_interval'));
  }

  async onUninit() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async onDeleted() {
    await this.onUninit();
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('poll_interval')) this.startPolling(newSettings.poll_interval);
  }

  startPolling(seconds) {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    const s = Math.max(MIN_POLL_S, Number(seconds) || DEFAULT_POLL_S);
    this.pollTimer = this.homey.setInterval(() => this.update(), s * 1000);
  }

  /** Called by the app after a new login (pairing or repair). */
  async onReauthenticated() {
    this.authFailed = false;
    await this.setAvailable().catch(() => {});
    await this.update();
  }

  // ------------------------------------------------------------------ polling

  /** Poll once; never throws. */
  async update() {
    if (this.authFailed || this.updating) return;
    this.updating = true;
    try {
      const info = await this.api.withReauth(() => this.api.poolInfo(this.poolId));
      await this.apply(P.parsePoolInfo(info));
      this.failures = 0;
      await this.setAvailable().catch(() => {});
      await this.unsetWarning().catch(() => {});
    } catch (err) {
      await this.handleError(err);
    } finally {
      this.updating = false;
    }
  }

  async handleError(err) {
    if (err instanceof PoolstationTwoFactorError) {
      this.authFailed = true;
      await this.setUnavailable(this.homey.__('error.reauth_2fa')).catch(() => {});
    } else if (err instanceof PoolstationAuthError) {
      this.authFailed = true;
      await this.setUnavailable(this.homey.__('error.reauth')).catch(() => {});
    } else {
      // network hiccup or server error: keep the last values
      this.failures += 1;
      this.error('Update failed:', err.message);
      if (this.failures >= WARN_AFTER_FAILURES) {
        await this.setWarning(this.homey.__('warning.unreachable')).catch(() => {});
      }
    }
  }

  async apply(pool) {
    this.pool = pool;
    const values = P.capabilityValues(pool);

    // Capabilities that appeared since pairing (e.g. a new relay)
    const missing = P.sortCapabilities(Object.keys(values).filter((c) => !this.hasCapability(c)));
    for (const cap of missing) {
      await this.addCapability(cap).catch((e) => this.error(cap, e.message));
      this.listen(cap);
    }

    await this.applyTitles(pool);

    const now = Date.now();
    for (const [cap, value] of Object.entries(values)) {
      if (!this.hasCapability(cap)) continue;
      if (this.hold[cap] && now < this.hold[cap]) continue;
      const old = this.getCapabilityValue(cap);
      if (old === value) continue;
      await this.setCapabilityValue(cap, value).catch((e) => this.error(cap, e.message));
      if (old !== null && old !== undefined) this.onValueChanged(cap, value);
    }
  }

  /** Relay and input names come from the Poolstation account and may change. */
  async applyTitles(pool) {
    const titles = P.capabilityTitles(pool, (key, tokens) => this.homey.__(key, tokens));
    const saved = this.getStoreValue('titles') || {};
    let changed = false;
    for (const [cap, title] of Object.entries(titles)) {
      if (!this.hasCapability(cap) || saved[cap] === title) continue;
      await this.setCapabilityOptions(cap, { title }).catch((e) => this.error(cap, e.message));
      saved[cap] = title;
      changed = true;
    }
    if (changed) await this.setStoreValue('titles', saved).catch(() => {});
  }

  onValueChanged(cap, value) {
    const cards = this.driver.triggerCards || {};
    const fire = (id, tokens = {}, state = {}) => {
      if (cards[id]) cards[id].trigger(this, tokens, state).catch((e) => this.error(id, e.message));
    };

    if (cap.startsWith('onoff.relay_')) {
      const relay = this.relayByCap(cap);
      fire(value ? 'relay_turned_on' : 'relay_turned_off',
        { relay: relay ? relay.name : cap }, { key: relay ? relay.key : '' });
    } else if (cap.startsWith('pool_input.')) {
      const key = cap.slice('pool_input.'.length);
      fire(value ? 'input_turned_on' : 'input_turned_off', { input: this.titleOf(cap) }, { key });
    } else if (cap === 'alarm_generic.flow') {
      fire(value ? 'flow_alarm_on' : 'flow_alarm_off');
    } else if (VALUE_TRIGGERS[cap]) {
      const [id, token] = VALUE_TRIGGERS[cap];
      fire(id, { [token]: value });
    }
  }

  // ------------------------------------------------------------------ writing

  listen(cap) {
    if (this.listening.has(cap) || !this.hasCapability(cap)) return;
    if (TARGETS[cap]) {
      this.registerCapabilityListener(cap, (value) => this.writeTarget(cap, value));
    } else if (cap.startsWith('onoff.relay_')) {
      this.registerCapabilityListener(cap, (value) => this.writeRelay(cap, value));
    } else {
      return;
    }
    this.listening.add(cap);
  }

  async writeTarget(cap, value) {
    try {
      await this.api.withReauth(() => this.api.setTarget(this.poolId, TARGETS[cap], value));
    } catch (err) {
      throw new Error(this.writeErrorMessage(err));
    }
    this.hold[cap] = Date.now() + HOLD_MS;
  }

  async writeRelay(cap, value) {
    const relay = this.relayByCap(cap);
    if (!relay) throw new Error(this.homey.__('error.relay_unknown'));
    const old = this.getCapabilityValue(cap);
    try {
      await this.api.withReauth(() => this.api.setRelay(this.poolId, relay.sign, value));
    } catch (err) {
      throw new Error(this.writeErrorMessage(err));
    }
    relay.active = value;
    this.hold[cap] = Date.now() + HOLD_MS;
    if (old !== value) this.onValueChanged(cap, value);
  }

  writeErrorMessage(err) {
    if (err instanceof PoolstationAuthError) return this.homey.__('error.reauth');
    return `${this.homey.__('error.write_failed')} (${err.message})`;
  }

  // --------------------------------------------------------- flow card helpers

  /** Set a target from a flow card; goes through the capability listener. */
  async setTargetValue(cap, value) {
    if (!this.hasCapability(cap)) throw new Error(this.homey.__('error.not_supported'));
    await this.triggerCapabilityListener(cap, value);
  }

  /** @param {'on'|'off'|'toggle'} state */
  async setRelay(key, state) {
    const cap = `onoff.relay_${key}`;
    if (!this.hasCapability(cap)) throw new Error(this.homey.__('error.relay_unknown'));
    const value = state === 'toggle' ? !this.getCapabilityValue(cap) : state === 'on';
    await this.triggerCapabilityListener(cap, value);
  }

  isRelayOn(key) {
    return this.getCapabilityValue(`onoff.relay_${key}`) === true;
  }

  isInputOn(key) {
    return this.getCapabilityValue(`pool_input.${key}`) === true;
  }

  relayChoices(query) {
    const relays = this.pool ? this.pool.relays : this.storedChoices('onoff.relay_');
    return filterChoices(relays.map((r) => ({ id: r.key, name: r.name })), query);
  }

  inputChoices(query) {
    const inputs = this.pool
      ? this.pool.inputs.map((i) => ({ id: i.key, name: this.titleOf(`pool_input.${i.key}`) }))
      : this.storedChoices('pool_input.');
    return filterChoices(inputs, query);
  }

  /** Choices from the device itself while the pool could not be read yet. */
  storedChoices(prefix) {
    return this.getCapabilities()
      .filter((c) => c.startsWith(prefix))
      .map((c) => ({ id: c.slice(prefix.length), key: c.slice(prefix.length), name: this.titleOf(c) }));
  }

  relayByCap(cap) {
    if (!this.pool) return null;
    return this.pool.relays.find((r) => `onoff.relay_${r.key}` === cap) || null;
  }

  titleOf(cap) {
    const saved = this.getStoreValue('titles') || {};
    if (saved[cap]) return saved[cap];
    let opts = {};
    try {
      opts = this.getCapabilityOptions(cap) || {};
    } catch (err) {
      // no options set for this capability
    }
    if (typeof opts.title === 'string') return opts.title;
    if (opts.title) return opts.title[this.homey.i18n.getLanguage()] || opts.title.en || cap;
    return cap;
  }

}

function filterChoices(choices, query) {
  const q = String(query || '').toLowerCase();
  return choices.filter((c) => !q || c.name.toLowerCase().includes(q));
}

module.exports = PoolDevice;
