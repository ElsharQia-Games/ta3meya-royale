import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MSG, BTN, ACT, F, F_ALL, PROTOCOL_VERSION, encodeInput, decodeInput, wireToSimInput,
  encodePing, decodePing, encodePong, decodePong, encodeAck, decodeAck,
  encodeSnapshot, decodeSnapshot, applySnapshot, encodeEvents, decodeEvents,
  encodeLoot, decodeLoot, encodeControl, decodeControl, sanitizeName,
  sanitizeRoom, filterEvents, sanitizeWireInput, weaponIndex, weaponKey,
} from '../shared/protocol.js';
import { WEAPON_KEYS } from '../shared/weapons.js';

function state(id, over = {}) {
  return {
    id, x: 1.25, y: 2.5, z: -3.5, yaw: 0.5, pitch: 0.1, vx: 1, vy: 2.5, vz: -1,
    hp: 99, armor: 50, alive: 1, grounded: 1, inWater: 0, connected: 1,
    stance: 0, sprinting: 0, adsing: 0, w: 1, slot: 0, mag: 30, res: 120,
    k: 0, d: 0, dmg: 0, vehicle: 0, seat: -1, reload: 0, heal: 0, switchT: 0,
    team: 0, gren: 1, smoke: 0, band: 2, med: 0, ping: 42,
    coyote: 0.05, jumpBuffer: 0, ...over,
  };
}

test('protocol version and message ids are stable', () => {
  assert.equal(typeof PROTOCOL_VERSION, 'number');
  assert.ok(PROTOCOL_VERSION >= 6);
  assert.equal(MSG.INPUT, 0x10);
  assert.equal(MSG.ACK, 0x13);
  assert.equal(MSG.SNAPSHOT, 0x14);
  assert.notEqual(MSG.INPUT, MSG.SNAPSHOT);
  assert.notEqual(MSG.ACK, MSG.SNAPSHOT);
});

test('ack frames carry the snapshot sequence they belong to', () => {
  const buf = encodeAck(1234, 987654);
  assert.equal(buf.byteLength, 9);
  const ack = decodeAck(buf);
  assert.equal(ack.seq, 1234);
  assert.equal(ack.ackInput, 987654);
  assert.equal(decodeAck(new ArrayBuffer(8)), null);
  const wrong = new ArrayBuffer(9);
  new DataView(wrong).setUint8(0, MSG.SNAPSHOT);
  assert.equal(decodeAck(wrong), null);
});

test('snapshot header no longer carries a per-client ack', () => {
  const s = new Map([[1, state(1)]]);
  const { buffer } = encodeSnapshot(s, null, 1, 1, true);
  const d = decodeSnapshot(buffer);
  assert.equal(d.ackInput, undefined);
  assert.equal(d.seq, 1);
  // 16-byte header + 4-byte player header + one full player block.
  assert.ok(buffer.byteLength > 16);
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

test('server input gate rejects replays and normalises hostile fields', () => {
  const base = {
    seq: 10, clientTime: 1, yaw: 10, pitch: 9,
    buttons: 0xffff, actions: 0xff, slot: 7, stance: 9,
    enterVehicle: 999999, viewTime: -5,
  };
  assert.equal(sanitizeWireInput(null, 0), null);
  assert.equal(sanitizeWireInput({ ...base, seq: 0 }, 0), null, 'seq 0 is invalid');
  assert.equal(sanitizeWireInput({ ...base, seq: 5 }, 5), null, 'duplicate seq');
  assert.equal(sanitizeWireInput({ ...base, seq: 5 }, 9), null, 'out-of-order seq');
  assert.equal(sanitizeWireInput({ ...base, yaw: NaN }, 0), null);
  assert.equal(sanitizeWireInput({ ...base, pitch: Infinity }, 0), null);

  const out = sanitizeWireInput(base, 9);
  assert.equal(out.seq, 10);
  assert.ok(Math.abs(out.yaw) <= Math.PI);
  assert.ok(Math.abs(out.pitch) <= 1.5);
  assert.equal(out.buttons, 0x00ff, 'only defined button bits survive');
  assert.equal(out.actions, 0x3f, 'only defined action bits survive');
  assert.equal(out.slot, -1);
  assert.equal(out.stance, -1);
  assert.equal(out.enterVehicle, 0);
  assert.equal(out.viewTime, 0);
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
  const kf = encodeSnapshot(s1, null, 1, 10.5, true);
  const dk = decodeSnapshot(kf.buffer);
  assert.equal(dk.keyframe, true);
  assert.equal(dk.seq, 1);
  assert.equal(dk.serverTime, 10.5);
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
  const delta = encodeSnapshot(s2, kf.states, 2, 10.53, false);
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
  const kf = encodeSnapshot(s, null, 1, 1, true);
  const delta = encodeSnapshot(s, kf.states, 2, 1.03, false);
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

test('vertical velocity and movement timers survive the snapshot wire format', () => {
  const s = new Map([
    [1, state(1, { vy: 5.5, coyote: 0.11, jumpBuffer: 0.12 })],
    [2, state(2, { vy: -12.34, coyote: 0, jumpBuffer: 0.02 })],
  ]);
  const { buffer } = encodeSnapshot(s, null, 1, 1, true);
  const d = decodeSnapshot(buffer);
  const up = d.players.find(p => p.id === 1);
  const down = d.players.find(p => p.id === 2);
  assert.ok(Math.abs(up.vy - 5.5) < 0.011, `positive vy ${up.vy}`);
  assert.ok(Math.abs(down.vy + 12.34) < 0.011, `negative vy ${down.vy}`);
  assert.equal(up.coyote, 0.11);
  assert.equal(up.jumpBuffer, 0.12);
  assert.equal(down.coyote, 0);
  assert.equal(down.jumpBuffer, 0.02);
});

test('negative yaw decodes exactly to its delta baseline', () => {
  const step = (Math.PI * 2) / 65536;
  for (const yaw of [-1, -0.5, -3, -Math.PI + 0.01, Math.PI - 0.01]) {
    const kf = encodeSnapshot(new Map([[1, state(1, { yaw })]]), null, 1, 1, true);
    const wire = decodeSnapshot(kf.buffer).players.find(p => p.id === 1);
    const baseline = kf.states.get(1).yaw;
    assert.equal(wire.yaw, baseline, `yaw ${yaw}: decoded ${wire.yaw} != baseline ${baseline}`);
    const err = Math.abs(Math.atan2(Math.sin(wire.yaw - yaw), Math.cos(wire.yaw - yaw)));
    assert.ok(err <= step / 2 + 1e-12, `yaw ${yaw}: quantisation error ${err}`);

    // Re-sending the same state must not retransmit ANG or move the baseline.
    const delta = encodeSnapshot(new Map([[1, state(1, { yaw })]]), kf.states, 2, 1.03, false);
    assert.equal(decodeSnapshot(delta.buffer).players.length, 0, `yaw ${yaw}: idle state retransmitted`);
    assert.equal(delta.states.get(1).yaw, baseline, `yaw ${yaw}: baseline drifted`);
  }
});

test('a vertical velocity change is transmitted in a delta frame', () => {
  const kf = encodeSnapshot(new Map([[1, state(1, { vy: 1 })]]), null, 1, 1, true);
  const delta = encodeSnapshot(new Map([[1, state(1, { vy: 2 })]]), kf.states, 2, 1.03, false);
  const d = decodeSnapshot(delta.buffer);
  assert.equal(d.players[0].mask & F.VEL, F.VEL);
  assert.ok(Math.abs(d.players[0].vy - 2) < 0.011);
});

test('sub-threshold movement reaches the client without accumulating baseline drift', () => {
  const cache = new Map();
  let prev = null;
  for (let i = 0; i < 20; i++) {
    const raw = i * 0.008;
    const { buffer, states } = encodeSnapshot(
      new Map([[1, state(1, { x: raw })]]), prev, i + 1, i / 30, i === 0,
    );
    prev = states;
    const d = decodeSnapshot(buffer);
    applySnapshot(cache, d);
    assert.ok(Math.abs(cache.get(1).x - raw) <= 0.021,
      `snapshot ${i}: raw x=${raw.toFixed(3)} client x=${cache.get(1).x}`);
  }
  assert.ok(cache.get(1).x > 0.1, 'slow movement should not remain at the keyframe position');
});

test('velocity reaching zero is eventually transmitted', () => {
  const kf = encodeSnapshot(new Map([[1, state(1, { vx: 5, vy: -3 })]]), null, 1, 1, true);
  const delta = encodeSnapshot(new Map([[1, state(1, { vx: 0, vy: 0 })]]), kf.states, 2, 1.03, false);
  const d = decodeSnapshot(delta.buffer);
  assert.equal(d.players[0].mask & F.VEL, F.VEL);
  assert.equal(d.players[0].vx, 0);
  assert.equal(d.players[0].vy, 0);
});

test('a joining player gets a complete delta block against an existing baseline', () => {
  const kf = encodeSnapshot(new Map([[1, state(1)]]), null, 1, 1, true);
  const delta = encodeSnapshot(
    new Map([[1, state(1)], [2, state(2, { x: 10, vy: -3.5 })]]), kf.states, 2, 1.03, false,
  );
  const d = decodeSnapshot(delta.buffer);
  const joined = d.players.find(p => p.id === 2);
  assert.ok(joined, 'new player should be present');
  assert.equal(joined.mask, F_ALL);
  assert.ok(Math.abs(joined.x - 10) < 0.021);
  assert.ok(Math.abs(joined.vy + 3.5) < 0.011);
});
