// Application-level network emulation test.
//
//   npm run nettest
//
// Starts a private server on :3100, puts a WebSocket proxy in front of it that
// adds one-way latency, jitter and message loss, then drives a synthetic player
// that uses the real shared prediction code. Reports measured RTT, snapshot
// cadence, prediction error and effective loss per profile.
//
// This is message-level emulation, not `tc netem`: WebSocket still runs over
// TCP, so head-of-line blocking is not modelled. See GAP-ANALYSIS.md.
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { performance } from 'node:perf_hooks';

import { CFG, MATCH_STATE } from '../shared/config.js';
import { World } from '../shared/world.js';
import { Prediction } from '../src/prediction.js';
import {
  MSG, PROTOCOL_VERSION, encodeInput, decodeSnapshot, applySnapshot,
  decodeControl, encodePing, decodePong, decodeEvents, decodeLoot,
} from '../shared/protocol.js';

const SERVER_PORT = 3100;
const PROXY_PORT = 3101;
const RUN_MS = 12000;
const BOT_HZ = 60;

const PROFILES = [
  { name: 'local', oneWayMs: 0, jitterMs: 0, loss: 0 },
  { name: '50ms+jitter+loss', oneWayMs: 50, jitterMs: 5, loss: 0.05 },
  { name: '150ms+jitter+loss', oneWayMs: 150, jitterMs: 15, loss: 0.05 },
  { name: '300ms no loss', oneWayMs: 300, jitterMs: 30, loss: 0 },
  { name: '300ms+jitter+loss', oneWayMs: 300, jitterMs: 30, loss: 0.05 },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

async function waitHealth(port, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('server did not become healthy');
}

function startServer() {
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(SERVER_PORT), HOST: '127.0.0.1', BOTS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  return child;
}

// One-way delayed, reordered-safe, lossy WebSocket relay.
function startProxy(profile) {
  const wss = new WebSocketServer({ port: PROXY_PORT, host: '127.0.0.1' });
  const stats = { dropped: 0, forwarded: 0 };
  wss.on('connection', (client) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws`);
    upstream.binaryType = 'arraybuffer';
    let lastClientAt = 0;
    let lastServerAt = 0;
    const schedule = (fn, oneWayMs, jitterMs, last) => {
      const j = jitterMs ? (Math.random() * 2 - 1) * jitterMs : 0;
      const at = Math.max(performance.now() + oneWayMs + j, last + 0.5);
      setTimeout(fn, Math.max(0, at - performance.now()));
      return at;
    };
    client.on('message', (data, isBinary) => {
      const buf = isBinary ? data : data.toString();
      if (profile.loss && isBinary && Math.random() < profile.loss) { stats.dropped++; return; }
      const send = () => { if (upstream.readyState === WebSocket.OPEN) upstream.send(buf, { binary: isBinary }); };
      if (upstream.readyState === WebSocket.OPEN) lastClientAt = schedule(send, profile.oneWayMs, profile.jitterMs, lastClientAt);
      else upstream.once('open', send);
      stats.forwarded++;
    });
    upstream.on('message', (data, isBinary) => {
      const buf = isBinary ? data : data.toString();
      if (profile.loss && isBinary && Math.random() < profile.loss) { stats.dropped++; return; }
      lastServerAt = schedule(() => {
        if (client.readyState === WebSocket.OPEN) client.send(buf, { binary: isBinary });
      }, profile.oneWayMs, profile.jitterMs, lastServerAt);
      stats.forwarded++;
    });
    upstream.on('open', () => {});
    upstream.on('close', () => { try { client.close(); } catch {} });
    client.on('close', () => { try { upstream.close(); } catch {} });
    upstream.on('error', () => {});
    client.on('error', () => {});
  });
  return {
    stats,
    close: () => new Promise((r) => wss.close(r)),
  };
}

async function runProfile(profile) {
  const proxy = startProxy(profile);
  await sleep(150);
  const result = {
    name: profile.name,
    sentInputs: 0, ackInputs: 0,
    snapshots: 0, snapshotGaps: [], snapshotBytes: 0,
    rtts: [], predErr: [],
    dropped: 0, errors: [],
    matchState: null,
  };

  const ws = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/ws`);
  ws.binaryType = 'arraybuffer';
  const client = {
    id: null, cache: new Map(), world: null, pred: null,
    lastSnap: null, seq: 0, pingT: 0,
    lastSnapAt: 0, snapIntervals: [], posHistory: new Map(),
  };

  const welcomePromise = new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('no welcome')), 10000);
    const onMsg = (data, isBinary) => {
      if (isBinary) return;
      const m = decodeControl(data.toString());
      if (m && m.type === 'welcome') { clearTimeout(to); ws.off('message', onMsg); res(m); }
    };
    ws.on('message', onMsg);
  });
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await opened;
  ws.send(JSON.stringify({
    type: 'join', name: 'NetProbe', room: 'NET' + Math.floor(Math.random() * 9000 + 1000),
    mode: 'br', protocol: PROTOCOL_VERSION,
  }));
  const welcome = await welcomePromise;
  client.id = welcome.playerId;
  client.world = new World(welcome.mapSeed);
  client.pred = new Prediction(client.world);
  let reset = false;

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const type = new DataView(buf).getUint8(0);
    if (type === MSG.SNAPSHOT) {
      const snap = decodeSnapshot(buf);
      if (!snap) return;
      const now = performance.now();
      if (client.lastSnapAt) client.snapIntervals.push(now - client.lastSnapAt);
      client.lastSnapAt = now;
      client.lastSnap = snap;
      result.snapshots++;
      result.snapshotBytes += buf.byteLength;
      applySnapshot(client.cache, snap);
      const local = client.cache.get(client.id);
      if (local) {
        if (!reset) { client.pred.reset(local); reset = true; }
        else {
          // Prediction correction: the distance between the position the client
          // had already predicted and the corrected position after replaying
          // unacked inputs from the authoritative snapshot. This is the visible
          // snap, not the expected latency gap.
          const old = client.pred.player.pos.slice();
          client.pred.reconcile(local, snap.ackInput);
          const now = client.pred.player.pos;
          result.predErr.push(Math.hypot(old[0] - now[0], old[1] - now[1], old[2] - now[2]));
        }
        result.matchState = local.alive ? 'alive' : 'dead';
      }
    } else if (type === MSG.PONG) {
      const p = decodePong(buf);
      if (p) result.rtts.push(performance.now() - p.clientTime);
    } else if (type === MSG.EVENTS) {
      decodeEvents(buf);
    } else if (type === MSG.LOOT) {
      decodeLoot(buf);
    }
  });

  const inputTimer = setInterval(() => {
    if (!reset) return;
    client.seq = (client.seq + 1) >>> 0;
    const yaw = (client.seq * 0.0007) % (Math.PI * 2);
    const inp = {
      seq: client.seq, yaw, pitch: 0,
      f: true, sprint: true, b: false, l: false, r: false,
      jump: false, ads: false, shoot: false,
      reload: false, grenade: false, smoke: false, heal: false,
      interact: false, cycle: false, slot: -1, stance: 0,
      viewTime: performance.now() / 1000,
    };
    // Keep the synthetic player inside the map.
    const pos = client.pred.player.pos;
    if (Math.abs(pos[0]) > 420 || Math.abs(pos[2]) > 420) { inp.yaw = yaw + Math.PI; }
    client.pred.push(inp, CFG.SIM_DT);
    const buf = encodeInput({
      seq: inp.seq, clientTime: performance.now() / 1000,
      yaw: inp.yaw, pitch: 0, buttons: 1 | 32, actions: 0,
      slot: -1, stance: -1, enterVehicle: 0, viewTime: inp.viewTime,
    });
    if (ws.readyState === WebSocket.OPEN) ws.send(buf);
    result.sentInputs++;
  }, 1000 / BOT_HZ);

  const pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    client.pingT = performance.now();
    ws.send(encodePing(client.pingT));
  }, 500);

  await sleep(RUN_MS);
  clearInterval(inputTimer);
  clearInterval(pingTimer);
  result.ackInputs = client.lastSnap?.ackInput ?? 0;
  result.dropped = proxy.stats.dropped;
  result.snapshotGaps = client.snapIntervals;
  try { ws.close(); } catch {}
  await proxy.close();

  const intervals = result.snapshotGaps;
  const meanInterval = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
  const jitter = intervals.length
    ? Math.sqrt(intervals.reduce((a, b) => a + (b - meanInterval) ** 2, 0) / intervals.length)
    : 0;
  return {
    name: result.name,
    snapshots: result.snapshots,
    snapHz: +(1000 / (meanInterval || 1)).toFixed(1),
    snapJitterMs: +jitter.toFixed(1),
    rttP50: +pct(result.rtts, 0.5).toFixed(1),
    rttP95: +pct(result.rtts, 0.95).toFixed(1),
    predErrP50: +(pct(result.predErr, 0.5) * 100).toFixed(2),
    predErrP95: +(pct(result.predErr, 0.95) * 100).toFixed(2),
    predErrMax: +(Math.max(0, ...result.predErr) * 100).toFixed(2),
    snapshotKBps: +((result.snapshotBytes / (RUN_MS / 1000)) / 1024).toFixed(2),
    inputsSent: result.sentInputs,
    inputsAcked: result.ackInputs,
    droppedMessages: result.dropped,
    note: result.matchState || 'no-local-state',
  };
}

const server = startServer();
try {
  await waitHealth(SERVER_PORT);
  const rows = [];
  for (const p of PROFILES) {
    process.stdout.write(`running ${p.name} … `);
    rows.push(await runProfile(p));
    console.log('done');
    await sleep(400);
  }
  console.table(rows);
  const stats = await (await fetch(`http://127.0.0.1:${SERVER_PORT}/stats`)).json();
  console.log('server memory MB:', stats.memoryMB);
  console.log('\nNote: message-level emulation over TCP; prediction error (p50/p95/max) is in cm.');
} finally {
  server.kill('SIGTERM');
}
