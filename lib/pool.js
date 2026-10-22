'use strict';

/**
 * Turns the raw Poolstation pool info into plain values, and maps those
 * onto Homey capabilities. Pure functions, so they can be unit tested.
 *
 * Parsing follows pypoolstation 0.8.0 Pool.sync_info() exactly.
 */

/** API keys ("signs") of the readable values in info.vars. */
const VARS = {
  temperature: 'ta',
  salt_concentration: 'cn',
  current_ph: 'mp',
  target_ph: 'sp',
  current_orp: 'mo',
  target_orp: 'so',
  current_clppm: 'mh',
  target_clppm: 'sh',
  percentage_electrolysis: 'pa',
  target_percentage_electrolysis: 'sn',
  waterflow: 'ac',
  uv_available: 'lu',
  current_uv_timer: 'hu',
  total_uv_timer: 'xu',
  uv_ballast: 'bu',
  uv_fuse: 'fu',
};

const INPUTS = ['d1', 'd2', 'd3', 'd4'];

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== null && obj[key] !== undefined;
}

/** Python float(): number or null; optionally drop a trailing unit character. */
function toFloat(raw, stripTrailingChar = false) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw);
  if (stripTrailingChar && s) s = s.slice(0, -1);
  s = s.trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Python int(): whole numbers only ("80" yes, "80.5" no). */
function toInt(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : null;
  if (typeof raw !== 'string' || !/^\s*[-+]?\d+\s*$/.test(raw)) return null;
  return parseInt(raw, 10);
}

/** Relay id that is safe inside a Homey sub-capability id. */
function relayKey(id) {
  return String(id).replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * @param {object} info response of POST /devices/<id>
 * @returns {object} parsed pool state
 */
function parsePoolInfo(info) {
  const data = info || {};
  const v = data.vars || {};

  const pool = {
    alias: data.alias || null,
    temperature: toFloat(v[VARS.temperature], true), // °C
    salt_concentration: toFloat(v[VARS.salt_concentration], true), // g/l
    current_ph: toFloat(v[VARS.current_ph]),
    target_ph: toFloat(v[VARS.target_ph]),
    current_orp: toFloat(v[VARS.current_orp]),
    target_orp: toFloat(v[VARS.target_orp]),
    current_clppm: toFloat(v[VARS.current_clppm]),
    target_clppm: toFloat(v[VARS.target_clppm]),
    percentage_electrolysis: toInt(v[VARS.percentage_electrolysis]),
    target_percentage_electrolysis: toInt(v[VARS.target_percentage_electrolysis]),
    // "0" means no water flow, which the chlorinator reports as a problem
    waterflow_problem: has(v, VARS.waterflow) ? v[VARS.waterflow] === '0' : null,
    inputs: [],
    relays: [],
    uv: null,
  };

  for (const sign of INPUTS) {
    if (!has(v, sign)) continue;
    pool.inputs.push({
      key: sign,
      name: data[`${sign}_name`] || null,
      active: v[sign] === '1',
    });
  }

  if (has(v, VARS.uv_available)) {
    const bu = has(v, VARS.uv_ballast) ? v[VARS.uv_ballast] : null;
    const uv = {
      available: v[VARS.uv_available] !== '-',
      on: false,
      enabled: false,
      ballast_problem: false,
      current_timer: toInt(v[VARS.current_uv_timer]),
      total_timer: toInt(v[VARS.total_uv_timer]),
      fuse_problem: v[VARS.uv_fuse] === '1',
    };
    // State machine on the ballast value (works for non-priority UV lamps)
    if (bu === '1') {
      uv.on = true;
      uv.enabled = true;
    } else if (bu === '0') {
      uv.enabled = true;
    } else if (bu !== '-') {
      // absent, or an unexpected error code
      uv.ballast_problem = bu !== null;
    }
    pool.uv = uv;
  }

  for (const r of data.relays || []) {
    if (!r || r.id === undefined || r.id === null) continue;
    pool.relays.push({
      id: r.id,
      key: relayKey(r.id),
      name: r.nombre || String(r.id),
      sign: r.sign,
      active: v[r.sign] === '1',
    });
  }

  return pool;
}

/**
 * Capability id -> value for everything this pool reports.
 * A capability is only listed when the pool actually has that value,
 * so pools without ORP, chlorine or UV get no empty tiles.
 */
function capabilityValues(pool) {
  const out = {};
  const put = (cap, value) => {
    if (value !== null && value !== undefined) out[cap] = value;
  };

  put('measure_temperature', pool.temperature);
  put('pool_ph', pool.current_ph);
  put('pool_target_ph', pool.target_ph);
  put('pool_orp', pool.current_orp);
  put('pool_target_orp', pool.target_orp);
  put('pool_chlorine', pool.current_clppm);
  put('pool_target_chlorine', pool.target_clppm);
  put('pool_salt', pool.salt_concentration);
  put('pool_electrolysis', pool.percentage_electrolysis);
  put('pool_target_production', pool.target_percentage_electrolysis);
  put('alarm_generic.flow', pool.waterflow_problem);

  for (const relay of pool.relays) put(`onoff.relay_${relay.key}`, relay.active);
  for (const input of pool.inputs) put(`pool_input.${input.key}`, input.active);

  if (pool.uv) {
    put('pool_uv_available', pool.uv.available);
    put('pool_uv_enabled', pool.uv.enabled);
    put('pool_uv_on', pool.uv.on);
    put('pool_uv_timer', pool.uv.current_timer);
    put('pool_uv_total', pool.uv.total_timer);
    put('alarm_generic.uv_ballast', pool.uv.ballast_problem);
    put('alarm_generic.uv_fuse', pool.uv.fuse_problem);
  }

  return out;
}

/** Fixed display order for the device tile. */
const CAPABILITY_ORDER = [
  'measure_temperature',
  'pool_ph', 'pool_orp', 'pool_chlorine', 'pool_salt', 'pool_electrolysis',
  'onoff.relay_', // all relays
  'pool_target_ph', 'pool_target_orp', 'pool_target_chlorine', 'pool_target_production',
  'alarm_generic.flow',
  'pool_input.',
  'pool_uv_on', 'pool_uv_enabled', 'pool_uv_available', 'pool_uv_timer', 'pool_uv_total',
  'alarm_generic.uv_ballast', 'alarm_generic.uv_fuse',
];

function sortCapabilities(caps) {
  const rank = (cap) => {
    const i = CAPABILITY_ORDER.findIndex((c) => (c.endsWith('_') || c.endsWith('.') ? cap.startsWith(c) : cap === c));
    return i === -1 ? CAPABILITY_ORDER.length : i;
  };
  return [...caps].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Titles for the sub-capabilities (relays, inputs, alarms).
 * @param {object} pool parsed pool
 * @param {Function} t translator: (key, tokens) => string
 */
function capabilityTitles(pool, t) {
  const titles = {
    'alarm_generic.flow': t('cap.flow_alarm'),
    'alarm_generic.uv_ballast': t('cap.uv_ballast_alarm'),
    'alarm_generic.uv_fuse': t('cap.uv_fuse_alarm'),
  };
  for (const relay of pool.relays) titles[`onoff.relay_${relay.key}`] = relay.name;
  for (const input of pool.inputs) {
    titles[`pool_input.${input.key}`] = input.name || t('cap.input', { n: input.key.slice(1) });
  }
  return titles;
}

module.exports = {
  parsePoolInfo,
  capabilityValues,
  capabilityTitles,
  sortCapabilities,
  relayKey,
  toFloat,
  toInt,
  VARS,
};
