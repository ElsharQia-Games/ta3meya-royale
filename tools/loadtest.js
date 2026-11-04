// Server load test: N synthetic players in one room.
//
//   npm run loadtest                 # 32 players, 20 s
//   PLAYERS=16 SECONDS=30 npm run loadtest
//
// Spawns a private server (port 3200, no bots), connects real WebSocket
// clients that send 60 Hz input with periodic fire bursts, and samples
// /stats for tick time, snapshot bandwidth and memory. Reports measured
// values only.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { performance } from 'node:perf_hooks';

import { CFG } from '../shared/config.js';
import { RNG } from '../shared/math.js';
import {
  MSG, PROTOCOL_VERSION, encodeInput, decodeSnapshot, decodeControl, decodePing, encodePong,
} from '../shared/protocol.js';

const PORT = Number(process.env.PORT || 3200);
const PLAYERS = Number(process.env.PLAYERS || 32);
const SECONDS = Number(process.env.SECONDS || 20);
const ROOM = process.env.ROOM || 'LOAD01';
const SEED = Number(process.env.SEED || 0x5eed);
const rng = new RNG(SEED);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitHealth(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (server.exitCode !== null) throw new Error(`private load server exited (${server.exitCode})`);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return; } catch {}
    await sleep(150);
  }
  throw new Error('server did not become healthy');
}

const server = spawn(process.execPath, ['server/server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BOTS: '0' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

const clients = [];
let totalSnapshots = 0;
let totalBytes = 0;
let connected = 0;
let welcomeErrors = 0;
let snapshotBytes = 0, ackBytes = 0;

function makeClient(i) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.binaryType = 'arraybuffer';
    const c = { ws, id: null, snapshots: 0, bytes: 0, seq: 0, yaw: rng.next() * Math.PI * 2, done: false };
    clients.push(c);
    const to = setTimeout(() => { welcomeErrors++; c.done = true; try { ws.close(); } catch {} resolve(c); }, 12000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'join', name: `Load-${i}`, room: ROOM, mode: 'br', protocol: PROTOCOL_VERSION,
      }));
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const m = decodeControl(data.toString());
        if (m && m.type === 'welcome') {
          clearTimeout(to);
          c.id = m.playerId;
          connected++;
          resolve(c);
        }
        return;
      }
      const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      c.bytes += buf.byteLength;
      totalBytes += buf.byteLength;
      if (new DataView(buf).getUint8(0) === MSG.SNAPSHOT) {
        const snap = decodeSnapshot(buf);
        if (snap) { c.snapshots++; totalSnapshots++; snapshotBytes += buf.byteLength; }
      } else if (new DataView(buf).getUint8(0) === MSG.ACK) {
        ackBytes += buf.byteLength;
      } else if (new DataView(buf).getUint8(0) === MSG.PING) {
        const ping = decodePing(buf);
        if (ping && ws.readyState === 1) ws.send(encodePong(ping.clientTime, 0));
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => { c.done = true; });
  });
}

// Input loop: 60 Hz, walk/sprint in a slow circle, fire in short bursts.
// A drift-corrected deadline scheduler keeps the average rate at inputHz;
// setInterval(16.67ms) actually fires at ~61.7 Hz on Node and would make the
// load generator outrun the 60 Hz simulation.
const timers = new Set();
let maxPendingTimers = 0;
let inputsSent = 0;
function sendInput(c, tick) {
  c.seq = (c.seq + 1) >>> 0;
  c.yaw += 0.004;
  const shooting = tick % 300 > 260 && tick % 10 === 0; // semi-auto trigger pulses
  const buttons = 1 | 32 | (shooting ? 128 : 0);
  const buf = encodeInput({
    seq: c.seq, clientTime: performance.now() / 1000,
    yaw: c.yaw, pitch: -0.02,
    buttons, actions: 0, slot: -1, stance: -1,
    enterVehicle: 0, viewTime: performance.now() / 1000,
  });
  try { c.ws.send(buf); inputsSent++; } catch {}
}

function startInput(c) {
  let tick = 0;
  const interval = 1000 / CFG.NET.inputHz;
  let next = performance.now() + interval;
  const pump = () => {
    if (c.done || c.ws.readyState !== 1) return;
    const now = performance.now();
    let sent = 0;
    while (now >= next && sent < 4) {
      sendInput(c, ++tick);
      next += interval;
      sent++;
    }
    // After a long stall, do not try to replay seconds of missed inputs.
    if (now - next > interval * 8) next = now + interval;
    const timer = setTimeout(() => { timers.delete(timer); pump(); }, Math.max(0, next - performance.now()));
    timers.add(timer);
    maxPendingTimers = Math.max(maxPendingTimers, timers.size);
  };
  pump();
}

try {
  await waitHealth();
  console.log(`connecting ${PLAYERS} players to room ${ROOM} …`);
  await Promise.all(Array.from({ length: PLAYERS }, (_, i) => makeClient(i)));
  console.log(`joined ${connected}/${PLAYERS} (welcome errors ${welcomeErrors})`);
  for (const c of clients) if (!c.done) startInput(c);
  await sleep(3000); // let warmup finish and the match go live

  const samples = [];
  const startStats = await (await fetch(`http://127.0.0.1:${PORT}/stats`)).json();
  const startRoom = startStats.rooms.find(r => r.code === ROOM);
  const bytesAtStart = totalBytes, snapsAtStart = totalSnapshots;
  const snapshotBytesAtStart = snapshotBytes, ackBytesAtStart = ackBytes;
  const inputsAtStart = inputsSent;
  const t0 = performance.now();
  while (performance.now() - t0 < SECONDS * 1000) {
    await sleep(2000);
    const s = await (await fetch(`http://127.0.0.1:${PORT}/stats`)).json();
    const room = s.rooms.find(r => r.code === ROOM);
    samples.push({
      t: +((performance.now() - t0) / 1000).toFixed(0),
      tickMs: room?.tickMs ?? 0,
      snapshotAckKiBps: room?.snapshotKiBps ?? 0,
      rawWindowP95Ms: room?.tickP95Ms ?? 0,
      rawWindowP99Ms: room?.tickP99Ms ?? 0,
      rawWindowMaxMs: room?.tickMaxMs ?? 0,
      tickCount: room?.tickCount ?? 0,
      tickTotalMs: room?.tickTotalMs ?? 0,
      tickOverBudget: room?.tickOverBudget ?? 0,
      lifetimeMaxMs: room?.tickLifetimeMaxMs ?? 0,
      memoryMB: s.memoryMB,
      heapMB: s.heapUsedMB ?? 0,
      players: room?.players ?? 0,
      alive: room?.alive ?? 0,
      state: room?.state ?? -1,
      droppedInputs: room?.droppedInputs ?? 0,
      skippedSnapshots: room?.skippedSnapshots ?? 0,
      simResets: room?.simResets ?? 0,
    });
    process.stdout.write('.');
  }
  console.log();

  const tick = samples.map(s => s.tickMs);
  const bw = samples.map(s => s.snapshotAckKiBps);
  const mem = samples.map(s => s.memoryMB);
  const heap = samples.map(s => s.heapMB);
  const elapsed = (performance.now() - t0) / 1000;
  const summary = {
    seed: SEED,
    players: PLAYERS,
    joined: connected,
    roomPlayers: samples.at(-1)?.players ?? 0,
    seconds: +elapsed.toFixed(1),
    sampledTickEmaMeanMs: +(tick.reduce((a, b) => a + b, 0) / tick.length).toFixed(3),
    sampledTickEmaMaxMs: +Math.max(...tick).toFixed(3),
    rawTickMeanMs: +((samples.at(-1).tickTotalMs - startRoom.tickTotalMs) /
      Math.max(1, samples.at(-1).tickCount - startRoom.tickCount)).toFixed(3),
    rawLast600TickP95Ms: samples.at(-1).rawWindowP95Ms,
    rawLast600TickP99Ms: samples.at(-1).rawWindowP99Ms,
    rawRoomLifetimeMaxMs: samples.at(-1).lifetimeMaxMs,
    rawTicksOverBudgetDuringMeasure: samples.at(-1).tickOverBudget - startRoom.tickOverBudget,
    tickBudgetMs: +(1000 / CFG.SIM_HZ).toFixed(2),
    serverSnapshotAckKiBpsMean: +(bw.reduce((a, b) => a + b, 0) / bw.length).toFixed(1),
    serverSnapshotAckKiBpsPeak: +Math.max(...bw).toFixed(1),
    perClientAllBinaryKiBps: +((totalBytes - bytesAtStart) / elapsed / 1024 / Math.max(1, connected)).toFixed(2),
    snapshotsReceivedDuringMeasure: totalSnapshots - snapsAtStart,
    allBinaryMiBReceivedDuringMeasure: +((totalBytes - bytesAtStart) / 1048576).toFixed(2),
    snapshotMiBReceivedDuringMeasure: +((snapshotBytes - snapshotBytesAtStart) / 1048576).toFixed(2),
    ackMiBReceivedDuringMeasure: +((ackBytes - ackBytesAtStart) / 1048576).toFixed(2),
    maxPendingInputTimers: maxPendingTimers,
    rssStartMB: +mem[0].toFixed(1),
    rssEndMB: +mem.at(-1).toFixed(1),
    rssGrowthMB: +(mem.at(-1) - mem[0]).toFixed(1),
    heapFirstMB: +heap[0].toFixed(1),
    heapMinMB: +Math.min(...heap).toFixed(1),
    heapMaxMB: +Math.max(...heap).toFixed(1),
    heapLastMB: +heap.at(-1).toFixed(1),
    droppedInputs: samples.at(-1)?.droppedInputs ?? 0,
    skippedSnapshots: samples.at(-1)?.skippedSnapshots ?? 0,
    simResets: samples.at(-1)?.simResets ?? 0,
    inputHzPerClient: +(((inputsSent - inputsAtStart) / elapsed) / Math.max(1, connected)).toFixed(1),
  };
  console.table(samples);
  // Compact series so a long soak stays diagnosable even when stdout is tailed.
  console.log('rssMB: ' + mem.map(v => v.toFixed(1)).join(' '));
  console.log('heapMB: ' + heap.map(v => v.toFixed(1)).join(' '));
  console.log(summary);
  console.log('\nRaw tick windows contain the last600 simulation steps. Lifetime max includes warmup; EMA metrics are labelled separately. Binary payload excludes WebSocket/TCP framing and JSON state/roster traffic.');
  if (connected !== PLAYERS || welcomeErrors || maxPendingTimers > PLAYERS) process.exitCode = 1;
} finally {
  for (const t of timers) clearTimeout(t);
  timers.clear();
  for (const c of clients) { try { c.ws.close(); } catch {} }
  server.kill('SIGTERM');
}
