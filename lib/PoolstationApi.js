'use strict';

/**
 * Client for the Poolstation cloud API (api.poolstation.net), used by
 * Fluidra / Idegis / AstralPool chlorinators.
 *
 * Ported from pypoolstation 0.8.0 (MIT, Miguel Camba) as used by the
 * Home Assistant Poolstation integration.
 */

const crypto = require('crypto');

const BASE_URL = 'https://api.poolstation.net';
const LOGIN_URL = `${BASE_URL}/session/login`;
const POOL_LIST_URL = `${BASE_URL}/devices/10/0`;
const POOL_INFO_URL = `${BASE_URL}/devices/`;
const UPDATE_URL = `${BASE_URL}/devices/saveSign`;

const TIMEOUT_MS = 30 * 1000;

/** HTTP statuses that mean "token invalid or expired, log in again". */
const AUTH_ERROR_STATUSES = [401, 403, 410];

/** Short API keys ("signs") for the writable pool settings. */
const SIGNS = {
  target_ph: 'sp',
  target_orp: 'so',
  target_clppm: 'sh',
  target_percentage_electrolysis: 'sn',
};

class PoolstationAuthError extends Error {

  constructor(message) {
    super(message);
    this.name = 'PoolstationAuthError';
  }

}

/** The account has two-factor login enabled and a code is needed. */
class PoolstationTwoFactorError extends PoolstationAuthError {

  constructor(message) {
    super(message);
    this.name = 'PoolstationTwoFactorError';
  }

}

class PoolstationHttpError extends Error {

  constructor(status, message) {
    super(message || `HTTP ${status}`);
    this.name = 'PoolstationHttpError';
    this.status = status;
  }

}

/**
 * The obfuscated Authorization and Q headers the Poolstation web app sends.
 *
 * A random number i (0..50) is XOR-ed into "<token>&2&2<timestamp ms>",
 * the result is base64 encoded, and Q is the MD5 of i so the server can undo it.
 */
function authHeaders(token, { random = Math.random, now = Date.now } = {}) {
  if (!token) return { authorization: '', q: '' };
  const i = Math.floor(random() * 51);
  const plain = `${token}&2&2${Math.floor(now())}`;
  const bytes = [];
  for (const ch of plain) bytes.push((ch.codePointAt(0) ^ i) & 0xff);
  return {
    authorization: Buffer.from(bytes).toString('base64'),
    q: crypto.createHash('md5').update(String(i)).digest('hex'),
  };
}

/** Python's str() for a float: 7 -> "7.0", 7.25 -> "7.25". */
function pyFloat(value) {
  const n = Math.round(Number(value) * 100) / 100;
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

/** Python's json.dumps() spacing, which is what the API has always received. */
function saveSignBody(poolId, sign, value) {
  return `&data={"id": ${JSON.stringify(poolId)}, "sign": ${JSON.stringify(sign)}, "value": ${JSON.stringify(String(value))}}`;
}

/** "dd/mm/yyyy HH:MM:SS" in the given time zone, as the login expects. */
function connectDate(date = new Date(), timeZone = undefined) {
  const parts = {};
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

class PoolstationApi {

  /**
   * @param {object} options
   * @param {string} [options.token] stored session token
   * @param {string} [options.username] e-mail address, for automatic re-login
   * @param {string} [options.password] password, for automatic re-login
   * @param {string} [options.timeZone] IANA zone for the login timestamp
   * @param {Function} [options.onToken] called with every new token
   * @param {Function} [options.fetch] fetch implementation (tests)
   * @param {Function} [options.random] random source (tests)
   */
  constructor(options = {}) {
    this.token = options.token || null;
    this.username = options.username || '';
    this.password = options.password || '';
    this.timeZone = options.timeZone;
    this.onToken = options.onToken || (() => {});
    this.fetch = options.fetch || ((...args) => fetch(...args));
    this.random = options.random || Math.random;
    this.loginPromise = null;
  }

  get isAuthenticated() {
    return Boolean(this.token);
  }

  get canRelogin() {
    return Boolean(this.username && this.password);
  }

  setLogin({ username, password, token }) {
    this.username = username || '';
    this.password = password || '';
    this.token = token || null;
  }

  /**
   * Log in; returns the session token.
   * Throws PoolstationTwoFactorError when the account wants a login code.
   */
  async login(loginCode = '') {
    const res = await this.send(LOGIN_URL, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
        remember: true,
        connectdate: connectDate(new Date(), this.timeZone),
        login_code: loginCode || '',
      }),
    });

    if (res.status === 410) {
      const data = await res.json().catch(() => ({}));
      if (data && data.error_code === 'REQUEST_LOGIN_CODE') {
        throw new PoolstationTwoFactorError('Two-factor login code required');
      }
      throw new PoolstationAuthError('Authentication failed (410)');
    }
    if (res.status === 401) throw new PoolstationAuthError('Authentication failed');
    if (!res.ok) throw new PoolstationHttpError(res.status, `Login failed (HTTP ${res.status})`);

    const data = await res.json();
    if (!data || !data.token) throw new PoolstationAuthError('Login response has no token');
    this.token = data.token;
    this.onToken(this.token);
    return this.token;
  }

  /** All pools on the account: [{ id, ... }]. */
  async listPools() {
    try {
      const data = await this.post(POOL_LIST_URL);
      return (data && data.items) || [];
    } catch (err) {
      // Like pypoolstation: any HTTP error here usually means an expired token.
      if (err instanceof PoolstationHttpError) {
        throw new PoolstationAuthError(`Pool list failed (HTTP ${err.status}), token may have expired`);
      }
      throw err;
    }
  }

  /** Raw info for one pool (alias, vars, relays, input names). */
  async poolInfo(poolId) {
    return this.post(POOL_INFO_URL + encodeURIComponent(String(poolId)));
  }

  /** Write one value ("sign") to a pool. */
  async saveSign(poolId, sign, value) {
    return this.post(UPDATE_URL, saveSignBody(poolId, sign, value));
  }

  async setTarget(poolId, key, value) {
    const sign = SIGNS[key];
    if (!sign) throw new Error(`Unknown setting ${key}`);
    const formatted = key === 'target_ph' || key === 'target_clppm'
      ? pyFloat(value)
      : String(Math.trunc(Number(value)));
    await this.saveSign(poolId, sign, formatted);
    return formatted;
  }

  async setRelay(poolId, sign, active) {
    await this.saveSign(poolId, sign, active ? '1' : '0');
  }

  /**
   * Run fn; on an expired token, log in again with the stored credentials
   * (once, shared by concurrent callers) and retry.
   */
  async withReauth(fn) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof PoolstationAuthError) || !this.canRelogin) throw err;
      await this.relogin();
      return fn();
    }
  }

  async relogin() {
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = null;
      });
    }
    return this.loginPromise;
  }

  // ------------------------------------------------------------------ http

  async post(url, body = '') {
    const { authorization, q } = authHeaders(this.token, { random: this.random });
    const res = await this.send(url, {
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${authorization}`,
        Q: q,
      },
      body,
    });
    if (AUTH_ERROR_STATUSES.includes(res.status)) {
      throw new PoolstationAuthError(`Request failed (HTTP ${res.status}), token may have expired`);
    }
    if (!res.ok) throw new PoolstationHttpError(res.status);
    return res.json();
  }

  async send(url, { headers, body }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await this.fetch(url, {
        method: 'POST', headers, body, signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('Poolstation did not respond in time');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

}

module.exports = {
  PoolstationApi,
  PoolstationAuthError,
  PoolstationTwoFactorError,
  PoolstationHttpError,
  authHeaders,
  pyFloat,
  saveSignBody,
  connectDate,
  SIGNS,
};
