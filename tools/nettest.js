// Real NetClient + Prediction through an ordered WebSocket message relay.
// Latencies below are ONE-WAY; 5% loss drops application messages, not TCP
// packets. This validates cache/reconciliation recovery, not WAN HOL behavior.
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { CFG } from '../shared/config.js';
import { RNG } from '../shared/math.js';
import { World } from '../shared/world.js';
import { Prediction } from '../src/prediction.js';
import { NetClient } from '../src/net/client.js';
import { MSG } from '../shared/protocol.js';

const SERVER_PORT = Number(process.env.NET_SERVER_PORT || 3100);
const PROXY_PORT = Number(process.env.NET_PROXY_PORT || 3101);
const RUN_MS = Number(process.env.NET_SECONDS || 12) * 1000;
const SEED = Number(process.env.SEED || 0x5eed);
const PROFILES = [
  { name: 'local', oneWayMs: 0, jitterMs: 0, loss: 0 },
  { name: '50ms one-way / 5% loss', oneWayMs: 50, jitterMs: 5, loss: .05 },
  { name: '150ms one-way / 5% loss', oneWayMs: 150, jitterMs: 15, loss: .05 },
  { name: '300ms one-way / no loss', oneWayMs: 300, jitterMs: 30, loss: 0 },
  { name: '300ms one-way / 5% loss', oneWayMs: 300, jitterMs: 30, loss: .05 },
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, p) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;
};

function startProxy(profile, seed) {
  const random = new RNG(seed);
  const wss = new WebSocketServer({ port: PROXY_PORT, host: '127.0.0.1' });
  const timers = new Set(), sockets = new Set();
  const stats = { dropped: 0, forwarded: 0, peakPendingTimers: 0 };
  wss.on('connection', client => {
    const upstream = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws`);
    sockets.add(client); sockets.add(upstream);
    const last = [0, 0];
    const queues = [[], []], pending = [false, false];
    const scheduleHead = direction => {
      const queue = queues[direction];
      if (pending[direction] || !queue.length) return;
      pending[direction] = true;
      const timer = setTimeout(() => {
        timers.delete(timer);
        pending[direction] = false;
        const now = performance.now();
        while (queue.length && queue[0].at <= now) {
          const { target, data, isBinary } = queue.shift();
          if (target.readyState === WebSocket.OPEN) target.send(isBinary ? data : data.toString(), { binary: isBinary });
        }
        scheduleHead(direction);
      }, Math.max(1, Math.ceil(queue[0].at - performance.now())));
      timers.add(timer);
      stats.peakPendingTimers = Math.max(stats.peakPendingTimers, timers.size);
    };
    const relay = (target, data, isBinary, direction) => {
      if (isBinary && random.next() < profile.loss) { stats.dropped++; return; }
      const at = Math.max(performance.now() + profile.oneWayMs +
        (random.next() * 2 - 1) * profile.jitterMs, last[direction] + .5);
      last[direction] = at;
      // A FIFO per direction guarantees ordering even when Node rounds two
      // sub-millisecond deadlines differently. Independent timers did not.
      queues[direction].push({ at, target, data, isBinary });
      scheduleHead(direction);
      stats.forwarded++;
    };
    client.on('message', (data, binary) => {
      if (upstream.readyState === WebSocket.CONNECTING) upstream.once('open', () => relay(upstream, data, binary, 0));
      else relay(upstream, data, binary, 0);
    });
    upstream.on('message', (data, binary) => relay(client, data, binary, 1));
    for (const socket of [client, upstream]) {
      socket.on('error', () => {});
      socket.on('close', () => {
        sockets.delete(socket);
        const other = socket === client ? upstream : client;
        if (other.readyState === WebSocket.OPEN) other.close();
      });
    }
  });
  return { stats, close: async () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
  } };
}

async function runProfile(profile, index) {
  const proxy = startProxy(profile, SEED + index);
  const net = new NetClient({ url: `ws://127.0.0.1:${PROXY_PORT}/ws`, name: 'NetProbe',
    room: `NET${index}`, mode: 'br', WebSocket });
  let prediction, ready = false, seq = 0, inputTimer, timeout;
  const errors = [], corrections = [], appliedIntervals = [], wireIntervals = [];
  let lastAppliedAt = 0, lastWireAt = 0, snapshots = 0, snapshotBytes = 0, ackBytes = 0, skipped = 0;
  let measuring = false;
  // Instrument traffic before the production decoder. Application behavior is
  // the real NetClient; the harness has no second delta/ACK implementation.
  const receive = net._onMessage.bind(net);
  net._onMessage = data => {
    if (measuring && data instanceof ArrayBuffer) {
      const type = new DataView(data).getUint8(0), now = performance.now();
      if (type === MSG.SNAPSHOT) {
        snapshots++; snapshotBytes += data.byteLength;
        if (lastWireAt) wireIntervals.push(now - lastWireAt);
        lastWireAt = now;
      } else if (type === MSG.ACK) ackBytes += data.byteLength;
    }
    receive(data);
  };
  net.onError = e => errors.push(e);
  net.onWelcome = msg => { prediction = new Prediction(new World(msg.mapSeed)); };
  const initialized = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('No authoritative spawn received')), 15000);
    net.onSnapshot = snapshot => {
      const local = net.cache.get(net.playerId);
      if (!local || !prediction) return;
      if (!ready) {
        prediction.reset(local); ready = true; clearTimeout(timeout); resolve();
      } else if (snapshot.ackInput === null) {
        if (measuring) skipped++;
      } else {
        const before = prediction.player.pos.slice();
        prediction.reconcile(local, snapshot.ackInput);
        if (measuring) corrections.push(Math.hypot(...before.map((v, i) => v - prediction.player.pos[i])));
      }
      if (measuring) {
        const now = performance.now();
        if (lastAppliedAt) appliedIntervals.push(now - lastAppliedAt);
        lastAppliedAt = now;
      }
    };
  });
  try {
    net.connect();
    await initialized;
    const ackMissStart = net.ackMisses, baseMissStart = net.baseMismatches, resyncStart = net.resyncRequests;
    const appliedStart = net.snapshotCount;
    const interval = 1000 / CFG.NET.inputHz;
    let deadline = performance.now() + interval;
    const pump = () => {
      const now = performance.now();
      let steps = 0;
      while (now >= deadline && steps++ < 4) {
        const pos = prediction.player.pos;
        const yaw = Math.abs(pos[0]) > 420 || Math.abs(pos[2]) > 420
          ? Math.atan2(pos[0], pos[2]) : seq * .0007;
        const input = { seq: ++seq, yaw, pitch: 0, f: true, sprint: true,
          b: false, l: false, r: false, jump: false, ads: false, shoot: false,
          slot: -1, stance: null, viewTime: performance.now() / 1000 };
        prediction.push(input, CFG.SIM_DT);
        net.sendInput(input);
        deadline += interval;
      }
      if (now - deadline > interval * 8) deadline = now + interval;
      inputTimer = setTimeout(pump, Math.max(0, deadline - performance.now()));
    };
    measuring = true;
    const startedAt = performance.now();
    pump();
    await sleep(RUN_MS);
    const seconds = (performance.now() - startedAt) / 1000;
    const applied = net.snapshotCount - appliedStart;
    if (!applied || !corrections.length || errors.length) throw new Error(`No useful profile evidence: ${errors.join('; ')}`);
    if (!profile.loss && (net.baseMismatches !== baseMissStart || net.ackMisses !== ackMissStart)) {
      throw new Error('Ordered no-loss relay lost snapshot/ACK continuity');
    }
    return {
      profile: profile.name, seed: SEED + index,
      wireSnapHz: +(snapshots / seconds).toFixed(1), appliedSnapHz: +(applied / seconds).toFixed(1),
      appliedGapP95Ms: +percentile(appliedIntervals, .95).toFixed(1),
      appliedGapMaxMs: +Math.max(0, ...appliedIntervals).toFixed(1),
      wireGapP95Ms: +percentile(wireIntervals, .95).toFixed(1),
      rttP50Ms: +percentile(net.rttSamples, .5).toFixed(1),
      rttP95Ms: +percentile(net.rttSamples, .95).toFixed(1),
      correctionP50cm: +(percentile(corrections, .5) * 100).toFixed(2),
      correctionP95cm: +(percentile(corrections, .95) * 100).toFixed(2),
      correctionMaxCm: +(Math.max(...corrections) * 100).toFixed(2),
      snapshotKiBps: +(snapshotBytes / seconds / 1024).toFixed(2),
      ackKiBps: +(ackBytes / seconds / 1024).toFixed(2),
      inputHz: +(seq / seconds).toFixed(2), inputsSent: seq, inputsAcked: net.lastAckInput,
      ackMisses: net.ackMisses - ackMissStart, skippedReconciles: skipped,
      missingBaseDeltas: net.baseMismatches - baseMissStart, resyncRequests: net.resyncRequests - resyncStart,
      droppedMessages: proxy.stats.dropped, peakRelayTimers: proxy.stats.peakPendingTimers,
    };
  } finally {
    clearTimeout(timeout); clearTimeout(inputTimer);
    net.disconnect();
    await proxy.close();
  }
}

const server = spawn(process.execPath, ['server/server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(SERVER_PORT), HOST: '127.0.0.1', BOTS: '0' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', data => process.stderr.write(data));
try {
  const deadline = Date.now() + 15000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`private net server exited (${server.exitCode})`);
    try { healthy = (await fetch(`http://127.0.0.1:${SERVER_PORT}/health`)).ok; } catch {}
    if (healthy) break;
    await sleep(150);
  }
  if (!healthy) throw new Error('private net server not ready');
  const rows = [];
  for (let i = 0; i < PROFILES.length; i++) {
    console.log(`Running ${PROFILES[i].name}`);
    rows.push(await runProfile(PROFILES[i], i));
  }
  console.table(rows);
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), runSecondsPerProfile: RUN_MS / 1000, rows }, null, 2));
  console.log('ONE-WAY message delays over loopback TCP; correction distances are cm. Not a WAN/TCP-loss or hardware-GPU measurement.');
} finally {
  server.kill('SIGTERM');
}
