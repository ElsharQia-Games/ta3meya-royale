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
import {
  MSG, PROTOCOL_VERSION, encodeInput, decodeSnapshot, decodeControl,
} from '../shared/protocol.js';

const PORT = Number(process.env.PORT || 3200);
const PLAYERS = Number(process.env.PLAYERS || 32);
const SECONDS = Number(process.env.SECONDS || 20);
const ROOM = process.env.ROOM || 'LOAD01';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitHealth(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
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

function makeClient(i) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.binaryType = 'arraybuffer';
    const c = { ws, id: null, snapshots: 0, bytes: 0, seq: 0, yaw: Math.random() * 6.28, done: false };
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
        if (snap) { c.snapshots++; totalSnapshots++; }
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => { c.done = true; });
  });
}

// Input loop: 60 Hz, walk/sprint in a slow circle, fire in short bursts.
const timers = [];
function startInput(c) {
  let tick = 0;
  timers.push(setInterval(() => {
    if (c.done || c.ws.readyState !== 1) return;
    tick++;
    c.seq = (c.seq + 1) >>> 0;
    c.yaw += 0.004;
    const shooting = tick % 300 > 260;          // 0.65 s burst every 5 s
    const buttons = 1 | 32 | (shooting ? 128 : 0);
    const buf = encodeInput({
      seq: c.seq, clientTime: performance.now() / 1000,
      yaw: c.yaw, pitch: -0.02,
      buttons, actions: 0, slot: -1, stance: -1,
      enterVehicle: 0, viewTime: performance.now() / 1000,
    });
    try { c.ws.send(buf); } catch {}
  }, 1000 / CFG.NET.inputHz));
}

try {
  await waitHealth();
  console.log(`connecting ${PLAYERS} players to room ${ROOM} …`);
  await Promise.all(Array.from({ length: PLAYERS }, (_, i) => makeClient(i)));
  console.log(`joined ${connected}/${PLAYERS} (welcome errors ${welcomeErrors})`);
  for (const c of clients) if (!c.done) startInput(c);
  await sleep(3000); // let warmup finish and the match go live

  const samples = [];
  const t0 = performance.now();
  while (performance.now() - t0 < SECONDS * 1000) {
    await sleep(2000);
    const s = await (await fetch(`http://127.0.0.1:${PORT}/stats`)).json();
    const room = s.rooms.find(r => r.code === ROOM);
    samples.push({
      t: +((performance.now() - t0) / 1000).toFixed(0),
      tickMs: room?.tickMs ?? 0,
      snapshotKBps: room?.snapshotKBps ?? 0,
      memoryMB: s.memoryMB,
      heapMB: s.heapUsedMB ?? 0,
      players: room?.players ?? 0,
      alive: room?.alive ?? 0,
      state: room?.state ?? -1,
    });
    process.stdout.write('.');
  }
  console.log();

  const tick = samples.map(s => s.tickMs);
  const bw = samples.map(s => s.snapshotKBps);
  const mem = samples.map(s => s.memoryMB);
  const heap = samples.map(s => s.heapMB);
  const elapsed = (performance.now() - t0) / 1000;
  const summary = {
    players: PLAYERS,
    joined: connected,
    roomPlayers: samples.at(-1)?.players ?? 0,
    seconds: +elapsed.toFixed(1),
    tickMsAvg: +(tick.reduce((a, b) => a + b, 0) / tick.length).toFixed(3),
    tickMsMax: +Math.max(...tick).toFixed(3),
    tickBudgetMs: +(1000 / CFG.SIM_HZ).toFixed(2),
    snapshotKBpsAvg: +(bw.reduce((a, b) => a + b, 0) / bw.length).toFixed(1),
    snapshotKBpsPeak: +Math.max(...bw).toFixed(1),
    perClientKBps: +((bw.reduce((a, b) => a + b, 0) / bw.length) / Math.max(1, connected)).toFixed(2),
    snapshotsReceived: totalSnapshots,
    bytesReceivedMB: +(totalBytes / 1048576).toFixed(2),
    rssStartMB: +mem[0].toFixed(1),
    rssEndMB: +mem.at(-1).toFixed(1),
    rssGrowthMB: +(mem.at(-1) - mem[0]).toFixed(1),
    heapFirstMB: +heap[0].toFixed(1),
    heapMinMB: +Math.min(...heap).toFixed(1),
    heapMaxMB: +Math.max(...heap).toFixed(1),
    heapLastMB: +heap.at(-1).toFixed(1),
  };
  console.table(samples);
  // Compact series so a long soak stays diagnosable even when stdout is tailed.
  console.log('rssMB: ' + mem.map(v => v.toFixed(1)).join(' '));
  console.log('heapMB: ' + heap.map(v => v.toFixed(1)).join(' '));
  console.log(summary);
  console.log(`\nserver CPU measured as tick time only; see /stats on the live server for tickMs.`);
} finally {
  for (const t of timers) clearInterval(t);
  for (const c of clients) { try { c.ws.close(); } catch {} }
  server.kill('SIGTERM');
}
