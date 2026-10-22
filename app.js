'use strict';

const Homey = require('homey');
const { PoolstationApi } = require('./lib/PoolstationApi');

/**
 * The app holds the one Poolstation login that all pool devices share, so a
 * re-login by one device never invalidates another.
 *
 * Like the Home Assistant integration, the e-mail address and password are
 * kept (in the app's own settings on this Homey) so an expired session can be
 * renewed automatically. That is not possible when the account uses a
 * two-factor login code; the device then asks for a repair.
 */
class PoolstationApp extends Homey.App {

  async onInit() {
    const login = this.homey.settings.get('login') || {};
    this.api = new PoolstationApi({
      token: this.homey.settings.get('token'),
      username: login.username,
      password: login.password,
      timeZone: this.homey.clock.getTimezone(),
      onToken: (token) => this.homey.settings.set('token', token),
    });
    this.log('Poolstation app started');
  }

  /** New login from pairing or repair: store it and wake all pool devices. */
  async setLogin({ username, password, token }) {
    this.homey.settings.set('login', { username, password });
    this.homey.settings.set('token', token);
    this.api.setLogin({ username, password, token });
    for (const device of this.poolDevices()) {
      await device.onReauthenticated().catch((err) => this.error(err));
    }
  }

  poolDevices() {
    try {
      return this.homey.drivers.getDriver('pool').getDevices();
    } catch (err) {
      return []; // driver not ready yet
    }
  }

}

module.exports = PoolstationApp;
