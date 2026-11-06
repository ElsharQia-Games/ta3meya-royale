import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserHost } from '../src/net/host.js';
import { CFG } from '../shared/config.js';
import {
  PROTOCOL_VERSION, ACT, encodeInput, INPUT_RATE_PER_SECOND, CONTROL_RATE_PER_SECOND,
  MAX_INPUT_BACKLOG,
} from '../shared/protocol.js';

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
  return new BrowserHost({ room: 'INPUTS', mode: 'br', bots: 0, ...opts });
}

function input(seq, over = {}) {
  return encodeInput({
    seq, yaw: 0, pitch: 0, buttons: 0, actions: 0,
    slot: -1, stance: -1, enterVehicle: 0, ...over,
  });
}

// encodeInput intentionally normalises NaN at the producer. A hostile/buggy
// peer can still put a non-finite float on the wire, so build that frame by
// hand and let the host's admission gate reject it.
function rawInput(seq, { yaw = 0, pitch = 0 } = {}) {
  const buf = new ArrayBuffer(32);
  const v = new DataView(buf);
  v.setUint8(0, 0x10);
  v.setUint32(1, seq >>> 0, true);
  v.setFloat64(5, 0, true);
  v.setFloat32(13, yaw, true);
  v.setFloat32(17, pitch, true);
  v.setUint16(21, 0, true);
  v.setUint8(23, 0);
  v.setInt8(24, -1);
  v.setInt8(25, -1);
  v.setInt16(26, 0, true);
  v.setFloat32(28, 0, true);
  return buf;
}

// Intercept every authoritative simulation step so assertions look at exactly
// the input the host handed to game.step rather than at inferred movement.
function captureSteps(host) {
  const calls = [];
  const original = host.game.step.bind(host.game);
  host.game.step = (inputs, dt, opts) => {
    calls.push({ inputs: new Map(inputs), dt });
    return original(inputs, dt, opts);
  };
  return calls;
}

test('malformed and out-of-order input frames never reach the queue', async () => {
  const host = makeHost();
  try {
    const { clientSocket, playerId } = await joinLocal(host);
    const client = host.byPlayer.get(playerId);
    const queue = host.inputQueues.get(playerId);

    // Non-finite view angles are the classic NaN-propagation vector.
    clientSocket.send(rawInput(1, { yaw: NaN }));
    clientSocket.send(rawInput(2, { pitch: Infinity }));
    clientSocket.send(rawInput(0, { yaw: 0 })); // sequence 0 is reserved
    await wait(0);
    assert.equal(queue.length, 0);
    assert.equal(client.rejectedInputs, 3);
    assert.equal(client.lastQueuedSeq, 0);

    clientSocket.send(input(5));
    clientSocket.send(input(5)); // duplicate
    clientSocket.send(input(4)); // reordered behind 5
    await wait(0);
    assert.deepEqual(queue.map((w) => w.seq), [5]);
    assert.equal(client.lastQueuedSeq, 5);
    assert.equal(client.rejectedInputs, 5);

    // A later monotonic frame is still accepted after the rejected ones.
    clientSocket.send(input(6));
    await wait(0);
    assert.deepEqual(queue.map((w) => w.seq), [5, 6]);
    assert.equal(client.rejectedInputs, 5);
  } finally {
    host.close();
  }
});

test('input queue is bounded and drops oldest frames instead of growing latency', async () => {
  const host = makeHost();
  try {
    const { clientSocket, playerId } = await joinLocal(host);
    const client = host.byPlayer.get(playerId);
    const queue = host.inputQueues.get(playerId);

    const sent = MAX_INPUT_BACKLOG + 6;
    for (let seq = 1; seq <= sent; seq++) clientSocket.send(input(seq));
    await wait(0);

    assert.equal(queue.length, MAX_INPUT_BACKLOG);
    assert.equal(queue[queue.length - 1].seq, sent, 'newest frame wins');
    assert.equal(queue[0].seq, sent - MAX_INPUT_BACKLOG + 1);
    assert.equal(client.droppedInputs, sent - MAX_INPUT_BACKLOG);
    assert.equal(client.lastQueuedSeq, sent);
  } finally {
    host.close();
  }
});

test('per-second input admission limits flood but resets on the next window', async () => {
  let clock = 1000;
  const host = makeHost({ now: () => clock });
  try {
    const { clientSocket, playerId } = await joinLocal(host);
    const client = host.byPlayer.get(playerId);
    const queue = host.inputQueues.get(playerId);

    const flood = INPUT_RATE_PER_SECOND + 10;
    for (let seq = 1; seq <= flood; seq++) clientSocket.send(input(seq));
    await wait(0);

    assert.equal(client.inputCount, flood);
    // Only the first INPUT_RATE_PER_SECOND frames were admitted; the queue
    // bound then dropped the oldest of those admitted frames.
    const admitted = INPUT_RATE_PER_SECOND;
    assert.equal(queue.length, MAX_INPUT_BACKLOG);
    assert.equal(queue.length + client.droppedInputs, admitted);
    assert.equal(client.lastQueuedSeq, admitted);

    clock += 1001; // next admission window
    clientSocket.send(input(flood + 1));
    await wait(0);
    assert.equal(client.lastQueuedSeq, flood + 1);
    assert.equal(queue[queue.length - 1].seq, flood + 1);
  } finally {
    host.close();
  }
});

test('silent clients stop held movement/shoot and one-shot actions never repeat', async () => {
  let clock = 5000;
  const host = makeHost({ now: () => clock });
  try {
    const { clientSocket, playerId } = await joinLocal(host);
    const client = host.byPlayer.get(playerId);
    const calls = captureSteps(host);

    // Forward + shoot held, plus a one-shot reload.
    clientSocket.send(input(1, { yaw: 0.4, buttons: 0x01 | 0x80, actions: ACT.RELOAD }));
    await wait(0);
    assert.equal(host.inputQueues.get(playerId).length, 1);

    host.step(CFG.SIM_DT);
    assert.equal(calls.length, 1);
    const first = calls[0].inputs.get(playerId);
    assert.equal(first.f, true);
    assert.equal(first.shoot, true);
    assert.equal(first.reload, true, 'one-shot action is delivered once');
    assert.equal(client.lastConsumedSeq, 1);

    // Fresh frame was consumed; within the grace window held buttons persist
    // but the edge-triggered action must be cleared.
    clock += 100;
    host.step(CFG.SIM_DT);
    const held = calls[1].inputs.get(playerId);
    assert.equal(held.f, true);
    assert.equal(held.shoot, true);
    assert.equal(held.reload, false, 'heldInput clears one-shot actions');
    assert.equal(held.seq, 1, 'held frame retains the last admitted sequence');

    // Beyond the stale window even movement/shoot are neutralised; view angles
    // survive so the character keeps looking where the player left it.
    // Malformed and duplicate frames must not refresh the stale timestamp.
    clientSocket.send(rawInput(2, { yaw: NaN }));
    clientSocket.send(input(1, { yaw: 0.4 }));
    await wait(0);
    assert.equal(host.inputQueues.get(playerId).length, 0);
    clock += 300;
    const staleBefore = client.staleInputs;
    host.step(CFG.SIM_DT);
    const stale = calls[2].inputs.get(playerId);
    assert.equal(stale.f, false);
    assert.equal(stale.shoot, false);
    assert.equal(stale.reload, false);
    assert.equal(stale.yaw, first.yaw);
    assert.equal(client.staleInputs, staleBefore + 1);
  } finally {
    host.close();
  }
});

test('acknowledgement tracks the last consumed frame, not the last admitted frame', async () => {
  const host = makeHost();
  try {
    const { clientSocket, playerId } = await joinLocal(host);
    const client = host.byPlayer.get(playerId);

    for (const seq of [1, 2, 3]) clientSocket.send(input(seq));
    await wait(0);
    assert.equal(client.lastQueuedSeq, 3);
    assert.equal(client.lastConsumedSeq, 0);

    host.step(CFG.SIM_DT);
    assert.equal(client.lastConsumedSeq, 1, 'only the consumed frame is acknowledged');
    assert.equal(client.lastQueuedSeq, 3);

    host.step(CFG.SIM_DT);
    assert.equal(client.lastConsumedSeq, 2);
  } finally {
    host.close();
  }
});

test('control frames are rate limited per client and recover next window', async () => {
  let clock = 9000;
  const host = makeHost({ now: () => clock });
  try {
    const { clientSocket, playerId } = await joinLocal(host);
    const client = host.byPlayer.get(playerId);
    let chats = 0;
    clientSocket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      try { if (JSON.parse(ev.data).type === 'chat') chats++; } catch {}
    };

    const flood = CONTROL_RATE_PER_SECOND + 5;
    for (let i = 0; i < flood; i++) {
      clientSocket.send(JSON.stringify({ type: 'chat', text: `m${i}` }));
    }
    await wait(0);
    assert.equal(chats, CONTROL_RATE_PER_SECOND, 'excess control frames are dropped');
    assert.equal(client.controlCount, flood);

    clock += 1001;
    clientSocket.send(JSON.stringify({ type: 'chat', text: 'next-window' }));
    await wait(0);
    assert.equal(chats, CONTROL_RATE_PER_SECOND + 1);
  } finally {
    host.close();
  }
});
