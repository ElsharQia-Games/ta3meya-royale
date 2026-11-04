import test from 'node:test';
import assert from 'node:assert/strict';
import { NetClient } from '../src/net/client.js';
import { Game } from '../shared/sim.js';
import {
  PROTOCOL_VERSION, encodeAck, encodeSnapshot, snapshotState, decodeSnapshot,
  snapshotAcceptance, isProtocolCompatible, pushBoundedInput, heldSimInput,
} from '../shared/protocol.js';

const welcome = () => JSON.stringify({ type: 'welcome', protocol: PROTOCOL_VERSION,
  playerId: 1, room: 'QA', mode: 'br', token: 'local-fixture' });
const game = new Game({ mode: 'br' });
game.addPlayer('Fixture');
const states = snapshotState(game);
const frame = (seq, current = states, previous = null) => encodeSnapshot(current, previous, seq, seq / 30, !previous).buffer;
const client = () => new NetClient({ url: 'ws://127.0.0.1/fixture' });

test('welcome invalidates old ACKs and an identical new snapshot sequence has no guessed ACK', () => {
  const c = client();
  c._onMessage(welcome());
  c._onMessage(encodeAck(0, 99));
  c._onMessage(frame(0));
  assert.equal(c.lastSnapshot.ackInput, 99);
  c._onMessage(welcome());
  c._onMessage(frame(0));
  assert.equal(c.lastSnapshot.ackInput, null);
  assert.equal(c.buffer.frames.length, 1);
});

test('missing delta is not published, resync is throttled and a later keyframe restores the whole cache', () => {
  const c = client(), published = [], sent = [];
  c.onSnapshot = s => published.push(s.seq);
  c._sendJson = m => { sent.push(m); return true; };
  c._onMessage(welcome());
  c._onMessage(frame(1));
  const changed = new Map([...states].map(([id, p]) => [id, { ...p, x: p.x + 3, hp: 50 }]));
  const changedAgain = new Map([...changed].map(([id, p]) => [id, { ...p, mag: 3 }]));
  // seq2 was lost: seq3 changes ammo only and must not hide the lost move/damage.
  c._onMessage(frame(3, changedAgain, changed));
  c._onMessage(frame(4, changedAgain, changedAgain));
  assert.deepEqual(published, [1]);
  assert.equal(c.cache.get(1).hp, states.get(1).hp);
  assert.equal(sent.filter(m => m.type === 'resync').length, 1);
  c._onMessage(encodeAck(5, 21));
  c._onMessage(frame(5, changedAgain));
  assert.deepEqual(published, [1, 5]);
  assert.equal(c.cache.get(1).hp, 50);
  assert.equal(c.cache.get(1).mag, 3);
  assert.equal(c.lastSnapshot.ackInput, 21);
});

test('snapshot sequence wraps without accepting duplicates or replaying old deltas', () => {
  const c = client();
  c._onMessage(frame(65535));
  c._onMessage(frame(0, states, states));
  assert.equal(c.lastSnapshot.seq, 0);
  c._onMessage(frame(65535));
  c._onMessage(frame(0, states, states));
  assert.equal(c.snapshotCount, 2);
  assert.equal(snapshotAcceptance({ seq: 3, baseSeq: 2, keyframe: false }, null), 'missing-base');
});

test('late events from a replaced socket cannot close or contaminate the current connection', t => {
  const previous = globalThis.WebSocket;
  const sockets = [];
  class Socket {
    constructor() { this.readyState = 0; sockets.push(this); }
    send() {}
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = previous; });
  const c = client();
  t.after(() => c.disconnect());
  c.connect();
  const old = sockets[0];
  c.disconnect();
  c.connect();
  const current = sockets[1];
  current.readyState = 1; current.onopen();
  current.onmessage({ data: welcome() });
  old.onmessage({ data: encodeAck(0, 999) });
  old.onclose({ code: 1006 });
  assert.equal(c.ws, current);
  assert.equal(c.connected, true);
  assert.equal(c.joined, true);
  assert.equal(c.reconnectTimer, null);
  c._onMessage(frame(0));
  assert.equal(c.lastSnapshot.ackInput, null);
});

test('wire version mismatch fails closed, and malformed snapshots are rejected without throwing', () => {
  const c = client(), errors = [];
  c.onError = e => errors.push(e);
  c._onMessage(JSON.stringify({ type: 'welcome', protocol: PROTOCOL_VERSION - 1 }));
  assert.equal(c.joined, false);
  assert.equal(c.closed, true);
  assert.match(errors[0], /protocol/);
  assert.equal(isProtocolCompatible(PROTOCOL_VERSION), true);
  for (const v of [undefined, null, true, String(PROTOCOL_VERSION), PROTOCOL_VERSION - 1]) assert.equal(isProtocolCompatible(v), false);
  const complete = frame(1);
  for (const length of [0, 15, 16, 20, complete.byteLength - 1]) {
    assert.equal(decodeSnapshot(complete.slice(0, length)), null);
  }
});

test('input backlog stays bounded and silent clients lose held actions', () => {
  const q = [];
  let dropped = 0;
  for (let i = 0; i < 500; i++) dropped += pushBoundedInput(q, { seq: i }, 16);
  assert.equal(q.length, 16);
  assert.equal(dropped, 484);
  assert.equal(q[0].seq, 484);
  const held = heldSimInput({ yaw: .2, pitch: .1, f: true, shoot: true, reload: true, enterVehicle: 2 }, false);
  assert.equal(held.f, true);
  assert.equal(held.reload, false);
  assert.equal(held.enterVehicle, undefined);
  const stale = heldSimInput(held, true);
  assert.equal(stale.f, false);
  assert.equal(stale.shoot, false);
  assert.equal(stale.yaw, .2);
});
