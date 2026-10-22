'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePoolInfo, capabilityValues, capabilityTitles, sortCapabilities, toFloat, toInt, relayKey,
} = require('../lib/pool');

/** Shaped like a real chlorinator with pH, ORP, chlorine, UV, 3 relays and 4 inputs. */
const FULL = {
  alias: 'Casa du Pre',
  d3_name: 'Pooldeck',
  vars: {
    ta: '18.5º',
    cn: '4.2g',
    mp: '7.31',
    sp: '7.20',
    mo: '705',
    so: '718',
    mh: '0.85',
    sh: '1.00',
    pa: '0',
    sn: '80',
    d1: '0',
    d2: '1',
    d3: '1',
    d4: '0',
    ac: '1',
    lu: '1',
    hu: '1520',
    xu: '8710',
    bu: '1',
    fu: '0',
    r1: '1',
    r2: '0',
    r3: '0',
  },
  relays: [
    { id: 11, nombre: 'Filterpomp', sign: 'r1' },
    { id: 12, nombre: 'Zwembad Lamp', sign: 'r2' },
    { id: 13, nombre: 'Not Used', sign: 'r3' },
  ],
};

const t = (key, tokens) => (tokens ? `${key}:${JSON.stringify(tokens)}` : key);

test('toFloat follows Python float(), with optional trailing unit character', () => {
  assert.equal(toFloat('7.31'), 7.31);
  assert.equal(toFloat('18.5º', true), 18.5);
  assert.equal(toFloat(' 7 '), 7);
  assert.equal(toFloat(''), null);
  assert.equal(toFloat('', true), null);
  assert.equal(toFloat('x', true), null);
  assert.equal(toFloat('abc'), null);
  assert.equal(toFloat(undefined), null);
  assert.equal(toFloat(null), null);
});

test('toInt only accepts whole numbers, like Python int()', () => {
  assert.equal(toInt('80'), 80);
  assert.equal(toInt(' 80 '), 80);
  assert.equal(toInt('80.5'), null);
  assert.equal(toInt('-'), null);
  assert.equal(toInt(undefined), null);
  assert.equal(toInt(81.9), 81);
});

test('parses a full pool', () => {
  const p = parsePoolInfo(FULL);
  assert.equal(p.alias, 'Casa du Pre');
  assert.equal(p.temperature, 18.5);
  assert.equal(p.salt_concentration, 4.2);
  assert.equal(p.current_ph, 7.31);
  assert.equal(p.target_ph, 7.2);
  assert.equal(p.current_orp, 705);
  assert.equal(p.target_orp, 718);
  assert.equal(p.current_clppm, 0.85);
  assert.equal(p.target_clppm, 1);
  assert.equal(p.percentage_electrolysis, 0);
  assert.equal(p.target_percentage_electrolysis, 80);
  assert.equal(p.waterflow_problem, false);
  assert.deepEqual(p.inputs.map((i) => [i.key, i.name, i.active]), [
    ['d1', null, false], ['d2', null, true], ['d3', 'Pooldeck', true], ['d4', null, false],
  ]);
  assert.deepEqual(p.relays.map((r) => [r.key, r.name, r.sign, r.active]), [
    ['11', 'Filterpomp', 'r1', true], ['12', 'Zwembad Lamp', 'r2', false], ['13', 'Not Used', 'r3', false],
  ]);
  assert.deepEqual(p.uv, {
    available: true, on: true, enabled: true, ballast_problem: false,
    current_timer: 1520, total_timer: 8710, fuse_problem: false,
  });
});

test('water flow "0" is a problem', () => {
  assert.equal(parsePoolInfo({ vars: { ac: '0' } }).waterflow_problem, true);
  assert.equal(parsePoolInfo({ vars: {} }).waterflow_problem, null);
});

test('UV ballast state machine', () => {
  const uv = (bu, lu = '1') => parsePoolInfo({ vars: { lu, ...(bu === undefined ? {} : { bu }) } }).uv;
  assert.deepEqual([uv('1').on, uv('1').enabled, uv('1').ballast_problem], [true, true, false]);
  assert.deepEqual([uv('0').on, uv('0').enabled, uv('0').ballast_problem], [false, true, false]);
  assert.deepEqual([uv('-').on, uv('-').enabled, uv('-').ballast_problem], [false, false, false]);
  assert.deepEqual([uv('E3').on, uv('E3').enabled, uv('E3').ballast_problem], [false, false, true]);
  assert.deepEqual([uv(undefined).on, uv(undefined).ballast_problem], [false, false]);
  assert.equal(uv('0', '-').available, false);
  assert.equal(parsePoolInfo({ vars: {} }).uv, null);
});

test('a basic pool (temperature and pH only) gets only those capabilities', () => {
  const p = parsePoolInfo({ alias: 'Basic', vars: { ta: '24.0º', mp: '7.4', sp: '7.2' } });
  assert.deepEqual(Object.keys(capabilityValues(p)).sort(), ['measure_temperature', 'pool_ph', 'pool_target_ph']);
});

test('malformed values are skipped, not fatal', () => {
  const p = parsePoolInfo({ vars: { ta: '', mp: 'n/a', pa: '7.5' }, relays: [null, { nombre: 'x' }] });
  assert.equal(p.temperature, null);
  assert.equal(p.current_ph, null);
  assert.equal(p.percentage_electrolysis, null);
  assert.deepEqual(p.relays, []);
  assert.deepEqual(parsePoolInfo(null).relays, []);
});

test('capability values for a full pool', () => {
  const values = capabilityValues(parsePoolInfo(FULL));
  assert.equal(values.measure_temperature, 18.5);
  assert.equal(values.pool_ph, 7.31);
  assert.equal(values.pool_target_orp, 718);
  assert.equal(values.pool_electrolysis, 0); // zero is a value, not missing
  assert.equal(values['alarm_generic.flow'], false);
  assert.equal(values['onoff.relay_11'], true);
  assert.equal(values['onoff.relay_12'], false);
  assert.equal(values['pool_input.d3'], true);
  assert.equal(values.pool_uv_on, true);
  assert.equal(values['alarm_generic.uv_fuse'], false);
  assert.equal(Object.keys(values).length, 25); // 11 values + 3 relays + 4 inputs + 7 UV
});

test('titles name relays and inputs from the account, with fallbacks', () => {
  const titles = capabilityTitles(parsePoolInfo(FULL), t);
  assert.equal(titles['onoff.relay_11'], 'Filterpomp');
  assert.equal(titles['pool_input.d3'], 'Pooldeck');
  assert.equal(titles['pool_input.d1'], 'cap.input:{"n":"1"}');
  assert.equal(titles['alarm_generic.flow'], 'cap.flow_alarm');
});

test('relay ids become safe sub-capability ids', () => {
  assert.equal(relayKey(12), '12');
  assert.equal(relayKey('a-b c'), 'a_b_c');
});

test('capabilities are sorted for the device tile', () => {
  const sorted = sortCapabilities(Object.keys(capabilityValues(parsePoolInfo(FULL))));
  assert.equal(sorted[0], 'measure_temperature');
  assert.equal(sorted[1], 'pool_ph');
  assert.deepEqual(sorted.filter((c) => c.startsWith('onoff.')), ['onoff.relay_11', 'onoff.relay_12', 'onoff.relay_13']);
  assert.ok(sorted.indexOf('onoff.relay_13') < sorted.indexOf('pool_target_ph'));
  assert.equal(sorted[sorted.length - 1], 'alarm_generic.uv_fuse');
});
