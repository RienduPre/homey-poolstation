'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  PoolstationApi, PoolstationAuthError, PoolstationTwoFactorError, PoolstationHttpError,
  authHeaders, pyFloat, saveSignBody, connectDate,
} = require('../lib/PoolstationApi');

/** Fake fetch: answers by URL path and records every call. */
function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, opts) => {
    const path = new URL(url).pathname;
    calls.push({ path, headers: opts.headers, body: opts.body });
    let out = handlers[path];
    if (typeof out === 'function') out = out(opts, calls);
    if (out === undefined) throw new Error(`unexpected request ${path}`);
    const status = out.status || 200;
    return { ok: status < 400, status, json: async () => out.body };
  };
  fn.calls = calls;
  return fn;
}

test('authHeaders XORs token and timestamp with a random number and sends its MD5', () => {
  const { authorization, q } = authHeaders('abc123', { random: () => 0.5, now: () => 1700000000000 });
  const i = Math.floor(0.5 * 51); // 25
  const decoded = Buffer.from(authorization, 'base64');
  const plain = String.fromCharCode(...decoded.map((b) => b ^ i));
  assert.equal(plain, 'abc123&2&21700000000000');
  assert.equal(q, crypto.createHash('md5').update(String(i)).digest('hex'));
});

test('authHeaders keeps the random number between 0 and 50', () => {
  const { q: low } = authHeaders('t', { random: () => 0, now: () => 1 });
  const { q: high } = authHeaders('t', { random: () => 0.9999999, now: () => 1 });
  assert.equal(low, crypto.createHash('md5').update('0').digest('hex'));
  assert.equal(high, crypto.createHash('md5').update('50').digest('hex'));
  assert.deepEqual(authHeaders('', {}), { authorization: '', q: '' });
});

test('pyFloat formats like Python str(float)', () => {
  assert.equal(pyFloat(7), '7.0');
  assert.equal(pyFloat(7.2), '7.2');
  assert.equal(pyFloat(7.199999999), '7.2');
  assert.equal(pyFloat(1.25), '1.25');
});

test('saveSignBody matches what pypoolstation sends', () => {
  assert.equal(saveSignBody(1234, 'sp', '7.2'), '&data={"id": 1234, "sign": "sp", "value": "7.2"}');
  assert.equal(saveSignBody('ab', 'r1', '1'), '&data={"id": "ab", "sign": "r1", "value": "1"}');
});

test('connectDate uses dd/mm/yyyy HH:MM:SS in the given zone', () => {
  const d = new Date(Date.UTC(2026, 9, 22, 16, 5, 9));
  assert.equal(connectDate(d, 'Europe/Amsterdam'), '22/10/2026 18:05:09');
  assert.equal(connectDate(d, 'UTC'), '22/10/2026 16:05:09');
});

test('login stores the token and reports it', async () => {
  let saved = null;
  const fetch = fakeFetch({ '/session/login': { body: { token: 'tok1' } } });
  const api = new PoolstationApi({
    username: 'a@b.nl', password: 'pw', fetch, onToken: (t) => { saved = t; }, timeZone: 'UTC',
  });
  assert.equal(await api.login(), 'tok1');
  assert.equal(api.isAuthenticated, true);
  assert.equal(saved, 'tok1');
  const body = JSON.parse(fetch.calls[0].body);
  assert.equal(body.username, 'a@b.nl');
  assert.equal(body.remember, true);
  assert.equal(body.login_code, '');
  assert.match(body.connectdate, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
});

test('login asks for a code when Poolstation wants two-factor login', async () => {
  const fetch = fakeFetch({
    '/session/login': (opts) => (JSON.parse(opts.body).login_code === '123456'
      ? { body: { token: 'tok2' } }
      : { status: 410, body: { error_code: 'REQUEST_LOGIN_CODE' } }),
  });
  const api = new PoolstationApi({ username: 'a', password: 'b', fetch });
  await assert.rejects(api.login(), PoolstationTwoFactorError);
  assert.equal(await api.login('123456'), 'tok2');
});

test('login errors: 401 and other 410 are auth errors, 500 is an HTTP error', async () => {
  const api401 = new PoolstationApi({ fetch: fakeFetch({ '/session/login': { status: 401, body: {} } }) });
  await assert.rejects(api401.login(), (err) => err instanceof PoolstationAuthError
    && !(err instanceof PoolstationTwoFactorError));
  const api410 = new PoolstationApi({ fetch: fakeFetch({ '/session/login': { status: 410, body: {} } }) });
  await assert.rejects(api410.login(), PoolstationAuthError);
  const api500 = new PoolstationApi({ fetch: fakeFetch({ '/session/login': { status: 500, body: {} } }) });
  await assert.rejects(api500.login(), (err) => err instanceof PoolstationHttpError && err.status === 500);
});

test('requests send the obfuscated Authorization and Q headers', async () => {
  const fetch = fakeFetch({ '/devices/10/0': { body: { items: [{ id: 7 }] } } });
  const api = new PoolstationApi({ token: 'tok', fetch, random: () => 0.1 });
  assert.deepEqual(await api.listPools(), [{ id: 7 }]);
  const { headers } = fetch.calls[0];
  assert.match(headers.Authorization, /^Bearer [A-Za-z0-9+/=]+$/);
  assert.equal(headers.Q, crypto.createHash('md5').update('5').digest('hex'));
  assert.equal(headers['content-type'], 'application/x-www-form-urlencoded');
});

test('setTarget and setRelay post the right sign and value format', async () => {
  const fetch = fakeFetch({ '/devices/saveSign': { body: { ok: true } } });
  const api = new PoolstationApi({ token: 'tok', fetch });
  await api.setTarget(42, 'target_ph', 7);
  await api.setTarget(42, 'target_orp', 718.6);
  await api.setTarget(42, 'target_clppm', 1.2);
  await api.setTarget(42, 'target_percentage_electrolysis', 80);
  await api.setRelay(42, 'r2', true);
  await api.setRelay(42, 'r2', false);
  assert.deepEqual(fetch.calls.map((c) => c.body), [
    '&data={"id": 42, "sign": "sp", "value": "7.0"}',
    '&data={"id": 42, "sign": "so", "value": "718"}',
    '&data={"id": 42, "sign": "sh", "value": "1.2"}',
    '&data={"id": 42, "sign": "sn", "value": "80"}',
    '&data={"id": 42, "sign": "r2", "value": "1"}',
    '&data={"id": 42, "sign": "r2", "value": "0"}',
  ]);
  await assert.rejects(api.setTarget(42, 'nope', 1));
});

test('expired token: withReauth logs in again once and retries', async () => {
  let tokenSeen = [];
  const fetch = fakeFetch({
    '/session/login': { body: { token: 'fresh' } },
    '/devices/42': (opts, calls) => {
      tokenSeen.push(calls.filter((c) => c.path === '/session/login').length);
      return tokenSeen.length === 1 ? { status: 401, body: {} } : { body: { alias: 'Pool' } };
    },
  });
  const api = new PoolstationApi({ token: 'old', username: 'a', password: 'b', fetch });
  const info = await api.withReauth(() => api.poolInfo(42));
  assert.equal(info.alias, 'Pool');
  assert.equal(api.token, 'fresh');
  assert.deepEqual(tokenSeen, [0, 1]);
});

test('concurrent re-logins share one login request', async () => {
  let n = 0;
  const fetch = fakeFetch({
    '/session/login': { body: { token: 'fresh' } },
    '/devices/1': () => (++n <= 2 ? { status: 403, body: {} } : { body: { alias: 'x' } }),
  });
  const api = new PoolstationApi({ token: 'old', username: 'a', password: 'b', fetch });
  await Promise.all([api.withReauth(() => api.poolInfo(1)), api.withReauth(() => api.poolInfo(1))]);
  assert.equal(fetch.calls.filter((c) => c.path === '/session/login').length, 1);
});

test('without stored credentials an auth error is passed on', async () => {
  const fetch = fakeFetch({ '/devices/1': { status: 401, body: {} } });
  const api = new PoolstationApi({ token: 'old', fetch });
  await assert.rejects(api.withReauth(() => api.poolInfo(1)), PoolstationAuthError);
});

test('server errors are not mistaken for auth errors', async () => {
  const fetch = fakeFetch({ '/devices/1': { status: 504, body: {} } });
  const api = new PoolstationApi({ token: 't', username: 'a', password: 'b', fetch });
  await assert.rejects(api.withReauth(() => api.poolInfo(1)), (err) => err instanceof PoolstationHttpError
    && err.status === 504);
  assert.equal(fetch.calls.length, 1); // no login attempt
});

test('pool list HTTP errors count as an expired token (like pypoolstation)', async () => {
  const fetch = fakeFetch({ '/devices/10/0': { status: 500, body: {} } });
  const api = new PoolstationApi({ token: 't', fetch });
  await assert.rejects(api.listPools(), PoolstationAuthError);
});
