import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MSG, BTN, ACT, F, PROTOCOL_VERSION, encodeInput, decodeInput, wireToSimInput,
  encodePing, decodePing, encodePong, decodePong, encodeSnapshot, decodeSnapshot,
  applySnapshot, encodeEvents, decodeEvents, encodeLoot, decodeLoot,
  encodeControl, decodeControl, sanitizeName, sanitizeRoom, filterEvents,
  weaponIndex, weaponKey,
} from '../shared/protocol.js';
import { WEAPON_KEYS } from '../shared/weapons.js';

function state(id, over = {}) {
  return {
    id, x: 1.25, y: 2.5, z: -3.5, yaw: 0.5, pitch: 0.1, vx: 1, vz: -1,
    hp: 99, armor: 50, alive: 1, grounded: 1, inWater: 0, connected: 1,
    stance: 0, sprinting: 0, adsing: 0, w: 1, slot: 0, mag: 30, res: 120,
    k: 0, d: 0, dmg: 0, vehicle: 0, seat: -1, reload: 0, heal: 0, switchT: 0,
    team: 0, gren: 1, smoke: 0, band: 2, med: 0, ping: 42, ...over,
  };
}

test('protocol version and message ids are stable', () => {
  assert.equal(typeof PROTOCOL_VERSION, 'number');
  assert.equal(MSG.INPUT, 0x10);
  assert.equal(MSG.SNAPSHOT, 0x14);
  assert.notEqual(MSG.INPUT, MSG.SNAPSHOT);
});

test('input frames round-trip every field', () => {
  const inp = {
    seq: 42, clientTime: 123.5, yaw: 1.2, pitch: -0.3,
    buttons: BTN.F | BTN.SPRINT | BTN.SHOOT, actions: ACT.RELOAD | ACT.HEAL,
    slot: 1, stance: 2, enterVehicle: 7, viewTime: 99.5,
  };
  const buf = encodeInput(inp);
  assert.equal(buf.byteLength, 32);
  const out = decodeInput(buf);
  assert.equal(out.seq, 42);
  assert.equal(out.clientTime, 123.5);
  assert.ok(Math.abs(out.yaw - 1.2) < 1e-6);
  assert.ok(Math.abs(out.pitch + 0.3) < 1e-6);
  assert.equal(out.buttons, inp.buttons);
  assert.equal(out.actions, inp.actions);
  assert.equal(out.slot, 1);
  assert.equal(out.stance, 2);
  assert.equal(out.enterVehicle, 7);
  assert.equal(out.viewTime, 99.5);

  const sim = wireToSimInput(out);
  assert.equal(sim.f, true);
  assert.equal(sim.sprint, true);
  assert.equal(sim.shoot, true);
  assert.equal(sim.reload, true);
  assert.equal(sim.heal, true);
  assert.equal(sim.l, false);
  assert.equal(sim.stance, 2);
});

test('input decoding rejects malformed frames', () => {
  assert.equal(decodeInput(new ArrayBuffer(4)), null);
  const bad = new ArrayBuffer(32);
  new DataView(bad).setUint8(0, MSG.PING);
  assert.equal(decodeInput(bad), null);
});

test('ping and pong round-trip', () => {
  const ping = decodePing(encodePing(1234.5));
  assert.equal(ping.clientTime, 1234.5);
  const pong = decodePong(encodePong(1234.5, 99.25));
  assert.equal(pong.clientTime, 1234.5);
  assert.equal(pong.serverTime, 99.25);
});

test('snapshot keyframe and delta apply to a client cache', () => {
  const s1 = new Map([[1, state(1)], [2, state(2, { x: 9 })] , [3, state(3)]]);
  const kf = encodeSnapshot(s1, null, 1, 10.5, 7, true);
  const dk = decodeSnapshot(kf.buffer);
  assert.equal(dk.keyframe, true);
  assert.equal(dk.seq, 1);
  assert.equal(dk.serverTime, 10.5);
  assert.equal(dk.ackInput, 7);
  assert.equal(dk.players.length, 3);
  assert.equal(dk.players[0].id, 1);
  assert.ok(Math.abs(dk.players[0].x - 1.25) < 0.021);
  assert.equal(dk.players[0].hp, 99);
  assert.equal(dk.players[0].alive, true);

  const cache = new Map();
  applySnapshot(cache, dk);
  assert.equal(cache.size, 3);

  const s2 = new Map([
    [1, state(1, { x: 6, hp: 20 })],
    [2, state(2, { x: 9 })],
  ]);
  const delta = encodeSnapshot(s2, kf.states, 2, 10.53, 9, false);
  const dd = decodeSnapshot(delta.buffer);
  assert.equal(dd.keyframe, false);
  assert.equal(dd.seq, 2);
  assert.deepEqual(dd.removed, [3]);
  assert.equal(dd.players.length, 1, 'unchanged player should be omitted');
  assert.equal(dd.players[0].id, 1);
  assert.ok(Math.abs(dd.players[0].x - 6) < 0.021);
  assert.equal(dd.players[0].hp, 20);
  assert.ok(delta.buffer.byteLength < kf.buffer.byteLength);

  applySnapshot(cache, dd);
  assert.equal(cache.size, 2);
  assert.equal(cache.has(3), false);
  assert.ok(Math.abs(cache.get(1).x - 6) < 0.021);
  assert.equal(cache.get(1).hp, 20);
});

test('unchanged snapshots are very small', () => {
  const s = new Map([[1, state(1)], [2, state(2)]]);
  const kf = encodeSnapshot(s, null, 1, 1, 1, true);
  const delta = encodeSnapshot(s, kf.states, 2, 1.03, 2, false);
  assert.ok(delta.buffer.byteLength <= 24, `idle delta ${delta.buffer.byteLength} bytes`);
  const d = decodeSnapshot(delta.buffer);
  assert.equal(d.players.length, 0);
});

test('weapon index mapping is a bijection for all weapons', () => {
  for (const key of WEAPON_KEYS) {
    assert.equal(weaponKey(weaponIndex(key)), key);
  }
  assert.equal(weaponKey(0), null);
});

test('events and loot JSON frames round-trip', () => {
  const events = [{ k: 'hit', from: 1, to: 2, dmg: 30 }, { k: 'shot', id: 1, o: [0, 1, 0] }];
  assert.deepEqual(decodeEvents(encodeEvents(events)), events);
  const loot = [{ id: 5, type: 'ammo', weapon: 'ar', x: 1, y: 2, z: 3 }];
  assert.deepEqual(decodeLoot(encodeLoot(loot)), loot);
  assert.equal(decodeEvents(new ArrayBuffer(2)), null);
});

test('control frames are validated JSON objects', () => {
  const msg = { type: 'join', name: 'Ace', room: 'ALPHA01' };
  assert.deepEqual(decodeControl(encodeControl(msg)), msg);
  assert.equal(decodeControl('not json'), null);
  assert.equal(decodeControl('42'), null);
});

test('names and room codes are sanitised', () => {
  assert.equal(sanitizeName('  <b>Ace</b>!!! '), 'bAceb');
  assert.equal(sanitizeName(''), 'Soldier');
  assert.ok(sanitizeName('x'.repeat(100)).length <= 16);
  assert.equal(sanitizeRoom('alpha-01!!'), 'ALPHA01');
  assert.equal(sanitizeRoom(''), 'ALPHA01');
});

test('event interest filter keeps local events and drops far ones', () => {
  const viewer = { id: 1, pos: [0, 0, 0] };
  const events = [
    { k: 'shot', id: 1, o: [0, 0, 0] },
    { k: 'shot', id: 2, o: [10, 0, 0] },
    { k: 'shot', id: 3, o: [900, 0, 900] },
    { k: 'hit', from: 1, to: 9, dmg: 10 },
    { k: 'kill', killer: 1, victim: 9 },
    { k: 'hit', from: 8, to: 9, dmg: 10, x: 800, z: 800 },
  ];
  const out = filterEvents(events, viewer, 100);
  assert.equal(out.length, 4);
  assert.ok(out.includes(events[0]));
  assert.ok(out.includes(events[1]));
  assert.ok(out.includes(events[3]));
  assert.ok(out.includes(events[4]));
});
