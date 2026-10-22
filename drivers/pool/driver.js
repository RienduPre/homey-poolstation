'use strict';

const Homey = require('homey');
const {
  PoolstationApi, PoolstationAuthError, PoolstationTwoFactorError, PoolstationHttpError,
} = require('../../lib/PoolstationApi');
const P = require('../../lib/pool');

const TRIGGERS = [
  'relay_turned_on', 'relay_turned_off',
  'input_turned_on', 'input_turned_off',
  'flow_alarm_on', 'flow_alarm_off',
  'ph_changed', 'orp_changed', 'chlorine_changed',
];

const TARGET_ACTIONS = {
  set_target_ph: 'pool_target_ph',
  set_target_orp: 'pool_target_orp',
  set_target_chlorine: 'pool_target_chlorine',
  set_target_production: 'pool_target_production',
};

/** One device per pool on the Poolstation account. */
class PoolDriver extends Homey.Driver {

  async onInit() {
    this.registerFlowCards();
  }

  // ----------------------------------------------------------------- pairing

  async onPair(session) {
    const app = this.homey.app;
    let loggedIn = false;

    session.setHandler('showView', async (view) => {
      if (view !== 'login' || loggedIn || !app.api.isAuthenticated) return;
      try {
        await app.api.withReauth(() => app.api.listPools()); // stored login still works
        loggedIn = true;
        await session.showView('list_devices');
      } catch (err) {
        this.log('Stored login not usable, asking for credentials:', err.message);
      }
    });

    session.setHandler('login', async (data) => {
      const result = await this.login(data);
      if (result.token) loggedIn = true;
      return { needsCode: Boolean(result.needsCode) };
    });

    session.setHandler('list_devices', async () => {
      if (!app.api.isAuthenticated) throw new Error(this.homey.__('error.not_logged_in'));
      return this.listPoolDevices(app.api);
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async (data) => {
      const api = this.newApi(data);
      const result = await this.loginWith(api, data);
      if (result.needsCode) return { needsCode: true };
      const pools = await api.listPools();
      if (!pools.some((p) => String(p.id) === String(device.getData().id))) {
        throw new Error(this.homey.__('error.pool_not_in_account'));
      }
      await this.homey.app.setLogin({ username: api.username, password: api.password, token: api.token });
      return { needsCode: false };
    });
  }

  /** Log in from the pairing view and store the login in the app. */
  async login(data) {
    const api = this.newApi(data);
    const result = await this.loginWith(api, data);
    if (result.token) {
      await this.homey.app.setLogin({ username: api.username, password: api.password, token: api.token });
    }
    return result;
  }

  newApi({ username, password }) {
    return new PoolstationApi({
      username: String(username || '').trim(),
      password: password || '',
      timeZone: this.homey.clock.getTimezone(),
    });
  }

  /** @returns {Promise<{token?: string, needsCode?: boolean}>} */
  async loginWith(api, { code }) {
    const loginCode = String(code || '').trim();
    try {
      return { token: await api.login(loginCode) };
    } catch (err) {
      if (err instanceof PoolstationTwoFactorError) {
        if (loginCode) throw new Error(this.homey.__('error.code_invalid'));
        return { needsCode: true };
      }
      throw new Error(this.loginErrorMessage(err, loginCode));
    }
  }

  loginErrorMessage(err, loginCode) {
    if (err instanceof PoolstationAuthError) {
      return this.homey.__(loginCode ? 'error.code_invalid' : 'error.login_failed');
    }
    // Poolstation answers a wrong password with a server error instead of 401.
    if (err instanceof PoolstationHttpError && err.status === 500) return this.homey.__('error.login_500');
    return `${this.homey.__('error.connection')} (${err.message})`;
  }

  async listPoolDevices(api) {
    const pools = await api.withReauth(() => api.listPools());
    if (!pools.length) throw new Error(this.homey.__('error.no_pools'));
    const t = (key, tokens) => this.homey.__(key, tokens);
    const devices = [];
    for (const item of pools) {
      const pool = P.parsePoolInfo(await api.withReauth(() => api.poolInfo(item.id)));
      const capabilities = P.sortCapabilities(Object.keys(P.capabilityValues(pool)));
      const capabilitiesOptions = {};
      for (const [cap, title] of Object.entries(P.capabilityTitles(pool, t))) {
        if (capabilities.includes(cap)) capabilitiesOptions[cap] = { title };
      }
      devices.push({
        name: pool.alias || `${this.homey.__('pair.pool')} ${item.id}`,
        data: { id: item.id },
        capabilities: capabilities.length ? capabilities : ['measure_temperature'],
        capabilitiesOptions,
        settings: { pool_id: String(item.id) },
      });
    }
    return devices;
  }

  // -------------------------------------------------------------- flow cards

  registerFlowCards() {
    this.triggerCards = {};
    for (const id of TRIGGERS) this.triggerCards[id] = this.homey.flow.getDeviceTriggerCard(id);

    const relays = (query, args) => args.device.relayChoices(query);
    const inputs = (query, args) => args.device.inputChoices(query);
    const sameKey = async (args, state) => Boolean(args.relay || args.input)
      && (args.relay || args.input).id === state.key;

    for (const id of ['relay_turned_on', 'relay_turned_off']) {
      this.triggerCards[id].registerRunListener(sameKey).registerArgumentAutocompleteListener('relay', relays);
    }
    for (const id of ['input_turned_on', 'input_turned_off']) {
      this.triggerCards[id].registerRunListener(sameKey).registerArgumentAutocompleteListener('input', inputs);
    }

    this.homey.flow.getConditionCard('relay_is_on')
      .registerRunListener(async (args) => args.device.isRelayOn(args.relay.id))
      .registerArgumentAutocompleteListener('relay', relays);
    this.homey.flow.getConditionCard('input_is_on')
      .registerRunListener(async (args) => args.device.isInputOn(args.input.id))
      .registerArgumentAutocompleteListener('input', inputs);
    this.homey.flow.getConditionCard('flow_alarm_active')
      .registerRunListener(async (args) => args.device.getCapabilityValue('alarm_generic.flow') === true);

    this.homey.flow.getActionCard('set_relay')
      .registerRunListener(async (args) => args.device.setRelay(args.relay.id, args.state))
      .registerArgumentAutocompleteListener('relay', relays);

    for (const [id, cap] of Object.entries(TARGET_ACTIONS)) {
      this.homey.flow.getActionCard(id).registerRunListener(async (args) => args.device.setTargetValue(cap, args.value));
    }

    this.homey.flow.getActionCard('refresh').registerRunListener(async (args) => args.device.update());
  }

}

module.exports = PoolDriver;
