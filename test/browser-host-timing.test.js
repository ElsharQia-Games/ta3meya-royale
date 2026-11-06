import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserHost } from '../src/net/host.js';
import { CFG } from '../shared/config.js';
import { PROTOCOL_VERSION, encodeInput } from '../shared/protocol.js';

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function joinLocal(host, name = 'P') {
  const clientSocket = host.createLocalClient(name, 'assault');
  let welcome = null;
  clientSocket.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'welcome') welcome = msg;
    } catch {}
  };
  clientSocket.send(JSON.stringify({
    type: 'join', name, room: host.code, mode: host.mode, kit: 'assault', protocol: PROTOCOL_VERSION,
  }));
  await wait(0);
  assert.ok(welcome, 'local client received welcome');
  return { clientSocket, playerId: welcome.playerId };
}

function makeHost(opts = {}) {
  return new BrowserHost({ room: 'TIMING', mode: 'br', bots: 0, ...opts });
}

test('SIM-01: 0.1 s of elapsed time runs six fixed simulation ticks', () => {
  const host = makeHost();
  try {
    const before = host.game.tick;
    const steps = host.step(0.1);
    assert.equal(steps, 6);
    assert.equal(host.game.tick - before, 6);
    assert.equal(host.tickCount, 6);
    assert.ok(host.accumulator < CFG.SIM_DT);
  } finally {
    host.close();
  }
});

test('SIM-02..04: simulation rate is independent of render frame rate', () => {
  const run = (fps, seconds) => {
    const host = makeHost();
    try {
      const frames = Math.round(fps * seconds);
      const before = host.game.tick;
      for (let i = 0; i < frames; i++) host.step(1 / fps);
      return host.game.tick - before;
    } finally {
      host.close();
    }
  };

  const at30 = run(30, 2);
  const at60 = run(60, 2);
  const at120 = run(120, 2);
  assert.ok(Math.abs(at30 - 120) <= 1, `30 FPS produced ${at30} ticks`);
  assert.ok(Math.abs(at60 - 120) <= 1, `60 FPS produced ${at60} ticks`);
  assert.ok(Math.abs(at120 - 120) <= 1, `120 FPS produced ${at120} ticks`);
  assert.ok(Math.abs(at30 - at60) <= 1);
  assert.ok(Math.abs(at120 - at60) <= 1);
});

test('SIM-05/06: jitter and long stalls stay inside the bounded catch-up budget', () => {
  const host = makeHost();
  try {
    // Jittered frame intervals still follow accumulated elapsed time.
    const frames = [1 / 60, 1 / 30, 1 / 120, 1 / 45, 1 / 75, 1 / 20];
    const total = frames.reduce((a, b) => a + b, 0);
    const steps = frames.reduce((n, dt) => n + host.step(dt), 0);
    assert.ok(steps >= Math.floor(total / CFG.SIM_DT) - 1);
    assert.ok(steps <= Math.ceil(total / CFG.SIM_DT) + 1);

    // A two-second stall must not replay two seconds of simulation.
    const before = host.tickCount;
    const stalled = host.step(2);
    assert.equal(stalled, host.maxCatchUpSteps);
    assert.equal(host.tickCount - before, host.maxCatchUpSteps);
    assert.ok(host.droppedSimTime > 1.5, 'stale backlog is discarded, not simulated');
    assert.equal(host.accumulator, 0);
  } finally {
    host.close();
  }
});

test('SIM-08: snapshots are emitted at the configured rate from fixed ticks', () => {
  const host = makeHost();
  try {
    const before = host.snapshotSeq;
    for (let i = 0; i < 60; i++) host.step(1 / 60);
    const snapshots = host.snapshotSeq - before;
    assert.ok(Math.abs(snapshots - CFG.SNAPSHOT_HZ) <= 1, `emitted ${snapshots} snapshots in 1 s`);
  } finally {
    host.close();
  }
});

test('multiple fixed ticks consume a queued input once and keep ack based on consumption', async () => {
  const host = makeHost();
  try {
    const { clientSocket, playerId } = await joinLocal(host);
    const client = host.byPlayer.get(playerId);
    const clientObj = [...host.clients.values()][0];

    const calls = [];
    const original = host.game.step.bind(host.game);
    host.game.step = (inputs, dt, opts) => {
      calls.push({ inputs: new Map(inputs), dt });
      return original(inputs, dt, opts);
    };

    clientSocket.send(encodeInput({
      seq: 1, yaw: 0.5, pitch: 0, buttons: 1 /* forward */, actions: 0,
      slot: -1, stance: -1, enterVehicle: 0,
    }));
    await wait(0);
    assert.equal(host.inputQueues.get(playerId).length, 1);

    const steps = host.step(1 / 30); // exactly two fixed ticks
    assert.equal(steps, 2);
    assert.equal(calls.length, 2);
    assert.equal(host.inputQueues.get(playerId).length, 0);
    assert.equal(clientObj.lastConsumedSeq, 1, 'ack reports the consumed input');
    assert.equal(clientObj.lastQueuedSeq, 1);
    assert.equal(calls[0].inputs.get(playerId).f, true);
    assert.equal(calls[0].dt, CFG.SIM_DT);
    assert.equal(calls[1].dt, CFG.SIM_DT);
    assert.equal(client.lastSeq, 1);
  } finally {
    host.close();
  }
});
