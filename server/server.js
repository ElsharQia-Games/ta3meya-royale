// ============================================================================
// Frontline authoritative server.
//
//   HTTP  : serves dist/ (production build) + /health + /stats
//   WS    : /ws  — binary inputs/snapshots, JSON control/roster/chat
//
// Authority: the server owns position, damage, ammo, loot, zone and match
// state. Clients only send yaw/pitch/buttons/edge actions. Movement is replayed
// by the shared deterministic simulation at 60 Hz; snapshots go out at 30 Hz.
// Lag compensation rewinds target hitboxes using the server-measured RTT.
// ============================================================================
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

import { Game } from '../shared/sim.js';
import { CFG, MATCH_STATE } from '../shared/config.js';
import { packVehicle } from '../shared/vehicle.js';
import { clamp } from '../shared/math.js';
import {
  PROTOCOL_VERSION, MSG, encodePong, decodePing, decodePong, encodeAck,
  decodeInput, sanitizeWireInput, wireToSimInput, encodeSnapshot, snapshotState,
  encodeEvents, encodeLoot, filterEvents, sanitizeName, sanitizeRoom, decodeControl,
  isProtocolCompatible, backlogLimit, pushBoundedInput, isStaleInput, heldSimInput,
} from '../shared/protocol.js';
import { spawnBots, stepBots } from './bots.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = join(process.cwd(), 'dist');
const MAX_PLAYERS = clamp(Number(process.env.MAX_PLAYERS || CFG.NET.maxPlayers), 2, 64);
const BOT_OVERRIDE = process.env.BOTS !== undefined ? Number(process.env.BOTS) : null;
const RECONNECT_GRACE_MS = 45_000;
const SESSION_MS = 60_000;
const ROOM_IDLE_MS = 5 * 60_000;
const AUTO_RESTART_S = 12;
// Bound input backlog to a few ticks so a flooding client cannot add ~1 s of
// stale input latency (the token bucket allows 150 inputs/s, the sim eats 60).
// 16 entries at 60 Hz is ~267 ms, below a 300 ms one-way target.
const INPUT_BACKLOG = backlogLimit(CFG.NET.maxQueuedInputs);
// Skip snapshots to sockets that are not draining. The client asks for (and
// the server will send) a keyframe as soon as it catches up.
const MAX_BUFFERED_BYTES = 256 * 1024;
const ACK_BYTES = 9;
// Raw per-tick samples kept for /stats. 600 ticks is ~10 s at 60 Hz; percentiles
// are computed on demand so the hot path only writes one number.
const TICK_SAMPLE_WINDOW = 600;

const rooms = new Map();          // roomCode -> Room
const sessions = new Map();       // token -> { roomCode, playerId, expires }
const clients = new Map();        // ws -> client (also room.clients)

// ---------------------------------------------------------------------------
// HTTP static server
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ttf': 'font/ttf',
  '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.map': 'application/json', '.wasm': 'application/wasm',
};

const http = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') return json(res, { ok: true, uptime: process.uptime(), rooms: rooms.size });
    if (url.pathname === '/stats') return json(res, stats());
    if (url.pathname === '/api/rooms') return json(res, [...rooms.values()].map(roomInfo));
    if (url.pathname === '/ws') { res.writeHead(426); return res.end('WebSocket upgrade required'); }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    // Prevent path traversal outside dist/.
    const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    let file = join(ROOT, rel);
    if (!file.startsWith(ROOT + sep) && file !== ROOT) { res.writeHead(403); return res.end('forbidden'); }
    let data;
    try {
      const st = await stat(file);
      if (st.isDirectory()) file = join(file, 'index.html');
      data = await readFile(file);
    } catch {
      // SPA fallback.
      try { data = await readFile(join(ROOT, 'index.html')); file = join(ROOT, 'index.html'); }
      catch { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('Client not built. Run: npm run build'); }
    }
    const ext = extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(data);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('server error');
  }
});

function json(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
class Room {
  constructor(code, mode) {
    this.code = code;
    this.mode = mode;
    this.game = new Game({ mode });
    this.clients = new Map();       // ws -> client
    this.byPlayer = new Map();      // playerId -> client
    this.inputQueues = new Map();   // playerId -> wire inputs
    this.history = [];              // { t, map } at 60 Hz
    this.snapshotSeq = 0;
    this.prevStates = null;
    this.snapshotAccum = 0;
    this.pingTimer = 0;
    this.lootTimer = 0;
    this.stateTimer = 0;
    this.accum = 0;
    this.simResets = 0;
    this.tickMsEma = 0;
    this.tickSamples = new Float32Array(TICK_SAMPLE_WINDOW);
    this.tickSampleIndex = 0;
    this.tickSampleCount = 0;
    this.tickOverBudget = 0;
    this.tickCount = 0;
    this.tickTotalMs = 0;
    this.tickLifetimeMaxMs = 0;
    this.bytesTimer = 0;
    this.snapshotBytesWindow = 0;
    this.snapshotBytesPerSec = 0;
    this.started = false;
    this.createdAt = Date.now();
    this.lastHumanAt = Date.now();
    this.endRestartT = 0;
    this.botCount = BOT_OVERRIDE !== null ? clamp(BOT_OVERRIDE | 0, 0, 48) : CFG.MODES[mode].bots;
    this.spawnBots();
  }

  spawnBots() {
    if (this.botCount <= 0) return;
    const bots = spawnBots(this.game, this.botCount, this.mode === 'tdm');
    for (const p of bots) {
      this.inputQueues.set(p.id, []);
    }
  }

  humanCount() {
    let n = 0;
    for (const c of this.clients.values()) if (c.ws.readyState === 1) n++;
    return n;
  }

  maxPlayers() { return Math.min(MAX_PLAYERS, CFG.MODES[this.mode].maxPlayers); }

  ensureCapacity() {
    while (this.game.players.size >= this.maxPlayers()) {
      const bot = [...this.game.players.values()].find(p => p.isBot);
      if (!bot) return false;
      this.game.removePlayer(bot.id);
      this.inputQueues.delete(bot.id);
    }
    return true;
  }

  resetBrains() {
    for (const p of this.game.players.values()) {
      if (!p.bot) continue;
      p.bot.path = null;
      p.bot.pathIdx = 0;
      p.bot.targetId = null;
      p.bot.patrol = null;
      p.bot.repathT = 0;
      p.bot.thinkT = 0;
    }
  }

  start() {
    if (this.game.matchState === MATCH_STATE.LIVE || this.game.matchState === MATCH_STATE.WARMUP) return;
    this.game.begin();
    this.resetBrains();
    this.started = true;
    this.endRestartT = 0;
    broadcastRoster(this);
    log(`[room ${this.code}] match start (${this.mode}) players=${this.game.players.size}`);
  }
}

function createRoom(code, mode) {
  const room = new Room(code, mode);
  rooms.set(code, room);
  log(`[room ${code}] created mode=${mode} bots=${room.botCount}`);
  return room;
}

function pickTeam(room) {
  let a = 0, b = 0;
  for (const p of room.game.players.values()) { if (p.team === 0) a++; else b++; }
  return a <= b ? 0 : 1;
}

function viewerPos(room, client) {
  const p = room.game.players.get(client.playerId);
  if (p && p.alive) return p.pos;
  if (client.spectateId) {
    const t = room.game.players.get(client.spectateId);
    if (t && t.alive) return t.pos;
  }
  const z = room.game.zone;
  return [z.cx, 0, z.cz];
}

// ---------------------------------------------------------------------------
// Join / leave / reconnect
// ---------------------------------------------------------------------------
function handleJoin(ws, msg) {
  if (ws.client) return;
  // Reject an incompatible wire format before allocating a room/player. The
  // client is told why and closed with 4003, so it does not retry forever.
  if (!isProtocolCompatible(msg.protocol)) {
    reject(ws, `Incompatible protocol: server ${PROTOCOL_VERSION}, client ${msg.protocol ?? 'none'}`);
    return;
  }
  const name = sanitizeName(msg.name);
  const requestedMode = msg.mode === 'tdm' ? 'tdm' : 'br';
  const code = sanitizeRoom(msg.room);

  let room = rooms.get(code);
  let player = null;
  let token = null;

  if (msg.token) {
    const sess = sessions.get(String(msg.token));
    if (sess && sess.expires > Date.now()) {
      const r = rooms.get(sess.roomCode);
      const p = r && r.game.players.get(sess.playerId);
      if (r && p && !p.isBot) {
        room = r; player = p; token = String(msg.token);
      }
    }
  }
  if (!room) room = createRoom(code, requestedMode);
  if (!player) {
    if (!room.ensureCapacity()) return reject(ws, 'Room is full');
    const team = room.mode === 'tdm' ? pickTeam(room) : 0;
    player = room.game.addPlayer(name, team, { connected: true });
    token = randomBytes(16).toString('hex');
    sessions.set(token, { roomCode: room.code, playerId: player.id, expires: Date.now() + SESSION_MS });
  } else {
    player.connected = true;
    player.name = name;
  }

  // If the same player already has a socket, replace it.
  const existing = room.byPlayer.get(player.id);
  if (existing && existing.ws !== ws) {
    try { existing.ws.close(4001, 'replaced by reconnect'); } catch {}
    room.clients.delete(existing.ws);
    clients.delete(existing.ws);
  }

  const client = existing && existing.ws === ws ? existing : {
    ws, room, playerId: player.id, token,
    lastSeq: 0, lastConsumedSeq: 0, lastQueuedSeq: 0, lastSimInput: null,
    lastInputAt: 0, droppedInputs: 0, skippedSnapshots: 0, staleInputs: 0,
    queue: [], needsKeyframe: true, spectateId: null,
    rttEma: 120, pingSentAt: 0,
    inputWindowStart: performance.now(), inputCount: 0,
    disconnectedAt: 0, joinedAt: Date.now(), chatTimes: [],
  };
  client.ws = ws;
  client.room = room;
  client.playerId = player.id;
  client.token = token;
  client.disconnectedAt = 0;
  client.needsKeyframe = true;
  client.lastSeq = 0;
  client.lastConsumedSeq = 0;
  client.lastQueuedSeq = 0;
  client.queue = [];
  client.lastSimInput = null;
  client.lastInputAt = 0;
  client.droppedInputs = 0;
  client.skippedSnapshots = 0;
  client.staleInputs = 0;
  ws.client = client;
  room.clients.set(ws, client);
  room.byPlayer.set(player.id, client);
  clients.set(ws, client);
  room.inputQueues.set(player.id, []);
  room.lastHumanAt = Date.now();

  // Starting a round resets loadouts and cover. Welcome/state must describe
  // that new round, rather than publishing the ended round's inventory first.
  if (room.game.matchState === MATCH_STATE.LOBBY || room.game.matchState === MATCH_STATE.ENDED) room.start();

  sendText(ws, {
    type: 'welcome',
    playerId: player.id,
    name: player.name,
    weapons: player.weapons.slice(),
    room: room.code,
    mode: room.mode,
    mapSeed: room.game.mapSeed,
    protocol: PROTOCOL_VERSION,
    token,
    serverTime: room.game.time,
    tickRate: CFG.SIM_HZ,
    snapshotRate: CFG.SNAPSHOT_HZ,
    maxPlayers: room.maxPlayers(),
    reconnectGrace: RECONNECT_GRACE_MS,
  });
  broadcastRoster(room);
  sendLoot(room, client);
  sendState(room, client);

  log(`[room ${room.code}] join ${player.name}#${player.id} (${room.game.players.size} players)`);
}

function reject(ws, reason) {
  sendText(ws, { type: 'error', reason });
  try { ws.close(4003, reason); } catch {}
}

function disconnect(ws, explicit = false) {
  const c = clients.get(ws) || ws.client;
  if (!c) return;
  const room = c.room;
  const player = room.game.players.get(c.playerId);
  clients.delete(ws);
  ws.client = null;

  if (explicit) {
    room.clients.delete(ws);
    room.byPlayer.delete(c.playerId);
    room.inputQueues.delete(c.playerId);
    if (player) room.game.removePlayer(player.id);
    sessions.delete(c.token);
    broadcastRoster(room);
    log(`[room ${room.code}] leave ${c.playerId}`);
    return;
  }

  c.disconnectedAt = Date.now();
  if (player) player.connected = false;
  room.inputQueues.delete(c.playerId);
  broadcastRoster(room);
  log(`[room ${room.code}] disconnect ${c.playerId} (grace ${RECONNECT_GRACE_MS / 1000}s)`);
}

function expireDisconnected(room) {
  const now = Date.now();
  for (const c of [...room.clients.values()]) {
    if (!c.disconnectedAt || now - c.disconnectedAt < RECONNECT_GRACE_MS) continue;
    room.clients.delete(c.ws);
    room.byPlayer.delete(c.playerId);
    room.inputQueues.delete(c.playerId);
    const p = room.game.players.get(c.playerId);
    if (p) room.game.removePlayer(p.id);
    sessions.delete(c.token);
    broadcastRoster(room);
    log(`[room ${room.code}] expired ${c.playerId}`);
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
function sendBinary(ws, buf) {
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(buf, { binary: true }); return true; } catch { return false; }
}
function sendText(ws, obj) {
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
}

function broadcastRoster(room) {
  const players = [...room.game.players.values()].map(p => ({
    id: p.id, name: p.name, team: p.team, bot: p.isBot,
    alive: p.alive, kills: p.kills, deaths: p.deaths, ping: Math.round(p.ping || 0),
  }));
  const msg = { type: 'roster', players, mode: room.mode, state: room.game.matchState, maxPlayers: room.maxPlayers() };
  for (const c of room.clients.values()) sendText(c.ws, msg);
}

function sendLoot(room, only = null) {
  const all = room.game.packLoot();
  const targets = only ? [only] : [...room.clients.values()];
  for (const c of targets) {
    if (c.ws.readyState !== 1) continue;
    const pos = viewerPos(room, c);
    const near = all.filter(l => {
      const dx = l.x - pos[0], dz = l.z - pos[2];
      return dx * dx + dz * dz < 180 * 180;
    });
    sendBinary(c.ws, encodeLoot(near));
  }
}

function statePayload(room) {
  const game = room.game;
  return {
    type: 'state',
    time: game.time,
    tick: game.tick,
    mode: game.mode,
    matchState: game.matchState,
    countdown: game.countdown,
    roundTime: game.roundTime,
    score: game.score.slice(),
    destroyed: [...game.destroyedBoxes],
    winner: game.winner ? { id: game.winner.id ?? null, team: game.winner.team ?? null, name: game.winner.name } : null,
    zone: {
      cx: +game.zone.cx.toFixed(1), cz: +game.zone.cz.toFixed(1),
      r: +game.zone.r.toFixed(1), phase: game.zone.phase,
      shrinking: game.zone.shrinking, dps: game.zone.dps, active: game.zone.active,
      phaseT: +game.zone.phaseT.toFixed(1),
    },
    vehicles: game.vehicles.map(packVehicle),
    projectiles: game.projectiles.map(pr => ({
      id: pr.id,
      type: pr.type, x: +pr.pos[0].toFixed(2), y: +pr.pos[1].toFixed(2), z: +pr.pos[2].toFixed(2),
      fuse: +pr.fuse.toFixed(2), deployed: !!pr.deployed,
    })),
    smokes: game.smokes.map(s => ({ id: s.id, x: +s.x.toFixed(1), y: +s.y.toFixed(1), z: +s.z.toFixed(1), r: s.r })),
  };
}

function sendState(room, only = null) {
  const payload = statePayload(room);
  if (only) { sendText(only.ws, payload); return; }
  for (const c of room.clients.values()) sendText(c.ws, payload);
}

function sendSnapshots(room) {
  const game = room.game;
  const seq = room.snapshotSeq++ & 0xffff;
  const keyframe = !room.prevStates || (room.snapshotSeq % CFG.NET.snapshotKeyframeEvery === 0);
  const states = snapshotState(game);
  const { buffer, states: newStates } = encodeSnapshot(states, room.prevStates, seq, game.time, keyframe);
  room.prevStates = newStates;

  // One keyframe buffer per tick, built only if a client actually needs one.
  let keyframeBuffer = keyframe ? buffer : null;

  for (const c of room.clients.values()) {
    if (c.ws.readyState !== 1) continue;
    // Do not grow an unbounded send queue for a stalled socket. The client
    // cannot apply a delta it missed, so force a keyframe on recovery.
    if (c.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      c.needsKeyframe = true;
      c.skippedSnapshots++;
      continue;
    }
    // Ack first: it names this exact snapshot sequence, so it is applied only
    // if that snapshot is the one the client actually applies.
    sendBinary(c.ws, encodeAck(seq, c.lastConsumedSeq >>> 0));
    if (c.needsKeyframe) {
      if (!keyframeBuffer) keyframeBuffer = encodeSnapshot(states, null, seq, game.time, true).buffer;
      sendBinary(c.ws, keyframeBuffer);
      c.needsKeyframe = false;
      room.snapshotBytesWindow += keyframeBuffer.byteLength + ACK_BYTES;
    } else {
      sendBinary(c.ws, buffer);
      room.snapshotBytesWindow += buffer.byteLength + ACK_BYTES;
    }
  }
}

function sendEvents(room, events) {
  if (!events.length) return;
  for (const c of room.clients.values()) {
    if (c.ws.readyState !== 1) continue;
    const p = room.game.players.get(c.playerId);
    const viewer = { id: c.playerId, pos: viewerPos(room, c) };
    const filtered = filterEvents(events, viewer);
    if (filtered.length) sendBinary(c.ws, encodeEvents(filtered));
  }
}

// ---------------------------------------------------------------------------
// Simulation step
// ---------------------------------------------------------------------------
function findHistory(room, t) {
  const h = room.history;
  if (!h.length) return null;
  let best = h[0], bd = Math.abs(h[0].t - t);
  for (let i = 1; i < h.length; i++) {
    const d = Math.abs(h[i].t - t);
    if (d < bd) { bd = d; best = h[i]; }
  }
  return bd <= 0.25 ? best.map : null;
}

function stepRoom(room, dt) {
  const game = room.game;
  const inputs = new Map();

  // ---- collect one input per connected player ----
  for (const c of room.clients.values()) {
    const p = game.players.get(c.playerId);
    if (!p || !p.connected) continue;
    const q = room.inputQueues.get(c.playerId);
    if (q && q.length) {
      const w = q.shift();
      if (w.seq <= c.lastSeq) continue; // duplicate / replay
      c.lastSeq = w.seq;
      const sim = wireToSimInput(w, c.lastSimInput);
      // Validate client-supplied identifiers against server truth.
      if (sim.enterVehicle !== undefined && sim.enterVehicle !== -1) {
        if (!game.vehicles.some(v => v.id === sim.enterVehicle)) sim.enterVehicle = undefined;
      }
      c.lastSimInput = sim;
      c.lastConsumedSeq = w.seq;
      inputs.set(c.playerId, sim);
    } else if (c.lastSimInput) {
      // Repeat held buttons for a short grace period, but never repeat
      // one-shot actions. After the grace window without a frame, stop moving
      // and shooting so a silent client cannot keep acting on a stale input.
      const stale = isStaleInput(c.lastInputAt, performance.now());
      const next = heldSimInput(c.lastSimInput, stale);
      if (stale) { c.staleInputs++; c.lastSimInput = next; }
      inputs.set(c.playerId, next);
    }
  }

  // ---- bots ----
  stepBots(game, dt, inputs);

  // ---- lag compensation targets ----
  const fireTargets = new Map();
  for (const [pid, sim] of inputs) {
    if (!sim.shoot) continue;
    const c = room.byPlayer.get(pid);
    if (!c) continue;
    const rewind = clamp(c.rttEma / 2000 + CFG.INTERP_DELAY, 0, CFG.MAX_REWIND);
    const hist = findHistory(room, game.time - rewind);
    if (hist) fireTargets.set(pid, Game.targetsFromHistory(hist));
  }

  game.step(inputs, dt, { fireTargets });
  sanitizePlayers(room);

  // ---- history for next rewinds ----
  room.history.push({ t: game.time, map: game.captureHitboxes() });
  const maxHist = Math.ceil(CFG.HISTORY_SECONDS * CFG.SIM_HZ);
  if (room.history.length > maxHist) room.history.shift();

  // ---- events ----
  const events = game.events.splice(0);
  if (events.length) sendEvents(room, events);

  // ---- snapshots at 30 Hz ----
  room.snapshotAccum += dt;
  if (room.snapshotAccum >= 1 / CFG.SNAPSHOT_HZ - 1e-6) {
    room.snapshotAccum -= 1 / CFG.SNAPSHOT_HZ;
    sendSnapshots(room);
    // Moving/occupied vehicles need the same cadence as player snapshots. Full
    // world/zone state remains low-rate; parked cars do not add motion traffic.
    const moving = game.vehicles.filter(v => v.occupants.some(id => id !== null) || Math.hypot(v.vel[0], v.vel[2]) > .15);
    if (moving.length) {
      const payload = { type: 'vehicles', time: game.time, vehicles: moving.map(packVehicle) };
      for (const c of room.clients.values()) sendText(c.ws, payload);
    }
  }

  // ---- loot refresh (interest filtered) ----
  room.lootTimer -= dt;
  if (room.lootTimer <= 0) { room.lootTimer = 1.2; sendLoot(room); }

  // ---- low-rate world state (zone, vehicles, grenades, smoke) ----
  room.stateTimer -= dt;
  if (room.stateTimer <= 0) { room.stateTimer = 0.2; sendState(room); }

  // ---- server-initiated RTT probe ----
  room.pingTimer -= dt;
  if (room.pingTimer <= 0) {
    room.pingTimer = 1;
    for (const c of room.clients.values()) {
      if (c.ws.readyState !== 1) continue;
      c.pingSentAt = performance.now();
      const b = new ArrayBuffer(9); const v = new DataView(b);
      v.setUint8(0, MSG.PING); v.setFloat64(1, game.time, true);
      sendBinary(c.ws, b);
    }
  }

  // ---- match lifecycle ----
  if (game.matchState === MATCH_STATE.ENDED) {
    room.endRestartT += dt;
    if (room.endRestartT > AUTO_RESTART_S && room.humanCount() > 0) room.start();
  }
}

function sanitizePlayers(room) {
  for (const p of room.game.players.values()) {
    if (!Number.isFinite(p.pos[0]) || !Number.isFinite(p.pos[1]) || !Number.isFinite(p.pos[2]) ||
      !Number.isFinite(p.vel[0]) || !Number.isFinite(p.vel[1]) || !Number.isFinite(p.vel[2]) ||
      p.pos[1] < -80 || p.pos[1] > 400) {
      log(`[anti-cheat] invalid state for ${p.id}; respawning`);
      room.game.spawnPlayer(p);
      p.vel = [0, 0, 0];
    }
    // Update the ping value shown in snapshots/roster.
    const c = room.byPlayer.get(p.id);
    if (c) p.ping = c.rttEma;
  }
}

// ---------------------------------------------------------------------------
// WS handling
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 64 * 1024, perMessageDeflate: false });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    const client = ws.client;
    if (!isBinary) {
      const msg = decodeControl(data.toString());
      if (!msg) return;
      if (msg.type === 'join') return handleJoin(ws, msg);
      if (!client) return;
      handleControl(client, msg);
      return;
    }
    // Binary frames. Empty or truncated frames are ignored rather than
    // throwing inside the ws message handler (which would take down the room).
    if (!data || data.byteLength < 1) return;
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    let type;
    try { type = new DataView(ab).getUint8(0); } catch { return; }
    try {
      if (type === MSG.INPUT) {
        if (!client) return;
        handleInput(client, ab);
      } else if (type === MSG.PING) {
        const ping = decodePing(ab);
        if (ping && client) sendBinary(client.ws, encodePong(ping.clientTime, client.room.game.time));
      } else if (type === MSG.PONG) {
        const pong = decodePong(ab);
        if (pong && client && client.pingSentAt) {
          const rtt = performance.now() - client.pingSentAt;
          client.rttEma = client.rttEma * 0.7 + clamp(rtt, 1, 1000) * 0.3;
        }
      }
    } catch (e) {
      log(`[ws] malformed binary frame from ${client ? client.playerId : 'unjoined'}: ${e.message}`);
    }
  });
  ws.on('close', () => disconnect(ws, false));
  ws.on('error', () => { try { ws.close(); } catch {} });
});

function handleInput(client, ab) {
  const w = decodeInput(ab);
  if (!w) return;
  const now = performance.now();
  // Token bucket: 150 inputs/s sustained, burst 90.
  if (now - client.inputWindowStart > 1000) {
    client.inputWindowStart = now;
    client.inputCount = 0;
  }
  client.inputCount++;
  if (client.inputCount > 150) return;

  // Reject duplicates/replays/out-of-order frames and normalise every
  // client-controlled field before it can enter the simulation.
  const clean = sanitizeWireInput(w, client.lastQueuedSeq);
  if (!clean) return;
  client.lastQueuedSeq = clean.seq;
  client.lastInputAt = now;

  const q = client.queue;
  client.droppedInputs += pushBoundedInput(q, clean, INPUT_BACKLOG);
  client.room.inputQueues.set(client.playerId, q);
}

function handleControl(client, msg) {
  const room = client.room;
  const player = room.game.players.get(client.playerId);
  if (!player) return;
  switch (msg.type) {
    case 'start':
      room.start();
      break;
    case 'leave':
      disconnect(client.ws, true);
      break;
    case 'resync':
      client.needsKeyframe = true;
      break;
    case 'spectate': {
      const id = Number(msg.id);
      const t = room.game.players.get(id);
      client.spectateId = t && t.alive ? id : null;
      break;
    }
    case 'chat': {
      const now = Date.now();
      client.chatTimes = client.chatTimes.filter(t => now - t < 5000);
      if (client.chatTimes.length >= 6) return;
      client.chatTimes.push(now);
      const text = String(msg.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 140);
      if (!text) return;
      const out = { type: 'chat', name: player.name, team: player.team, text };
      for (const c of room.clients.values()) sendText(c.ws, out);
      break;
    }
    case 'rtt':
      // Client-reported RTT is diagnostic only; lag comp uses server probes.
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const LOOP_MS = 4;
let lastLoop = performance.now();

setInterval(() => {
  const now = performance.now();
  let frameDt = (now - lastLoop) / 1000;
  lastLoop = now;
  if (frameDt > 0.5) frameDt = 0.5;

  for (const room of [...rooms.values()]) {
    room.accum += frameDt;
    let steps = 0;
    while (room.accum >= CFG.SIM_DT && steps < 8) {
      const t0 = performance.now();
      stepRoom(room, CFG.SIM_DT);
      const ms = performance.now() - t0;
      room.tickMsEma = room.tickMsEma * 0.94 + ms * 0.06;
      // Raw per-tick samples for p50/p95/p99/max. The EMA above is what the
      // live HUD uses; do not present it as a raw maximum.
      room.tickSamples[room.tickSampleIndex] = ms;
      room.tickSampleIndex = (room.tickSampleIndex + 1) % TICK_SAMPLE_WINDOW;
      if (room.tickSampleCount < TICK_SAMPLE_WINDOW) room.tickSampleCount++;
      if (ms > CFG.SIM_DT * 1000) room.tickOverBudget++;
      room.tickCount++;
      room.tickTotalMs += ms;
      room.tickLifetimeMaxMs = Math.max(room.tickLifetimeMaxMs, ms);
      room.accum -= CFG.SIM_DT;
      steps++;
    }
    // Catch up after a GC/event-loop stall instead of silently dropping sim
    // time. The 8-step budget bounds work per loop iteration; only give up if
    // the backlog is a full second (severe overload, not a normal pause).
    if (room.accum > 1) { room.accum = 0; room.simResets++; }

    room.bytesTimer += frameDt;
    if (room.bytesTimer >= 1) {
      room.snapshotBytesPerSec = room.snapshotBytesWindow / room.bytesTimer;
      room.snapshotBytesWindow = 0;
      room.bytesTimer = 0;
    }

    expireDisconnected(room);

    if (room.humanCount() === 0) {
      if (Date.now() - room.lastHumanAt > ROOM_IDLE_MS) {
        rooms.delete(room.code);
        log(`[room ${room.code}] closed (idle)`);
      }
    } else {
      room.lastHumanAt = Date.now();
    }
  }
}, LOOP_MS);

// WebSocket-level liveness.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30_000);

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
function tickPercentiles(room) {
  const n = room.tickSampleCount;
  if (!n) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const arr = Array.from(room.tickSamples.subarray(0, n)).sort((a, b) => a - b);
  const at = (p) => arr[Math.min(n - 1, Math.floor(n * p))];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: arr[n - 1] };
}

function roomInfo(room) {
  const game = room.game;
  const alive = [...game.players.values()].filter(p => p.alive).length;
  let pingSum = 0, pingN = 0, droppedInputs = 0, skippedSnapshots = 0, staleInputs = 0;
  for (const c of room.clients.values()) {
    pingSum += c.rttEma; pingN++;
    droppedInputs += c.droppedInputs || 0;
    skippedSnapshots += c.skippedSnapshots || 0;
    staleInputs += c.staleInputs || 0;
  }
  const tp = tickPercentiles(room);
  return {
    code: room.code, mode: room.mode, state: game.matchState,
    tick: game.tick, time: +game.time.toFixed(1),
    players: game.players.size, humans: room.humanCount(), bots: game.players.size - room.humanCount(),
    alive, score: game.score, zone: { r: +game.zone.r.toFixed(1), phase: game.zone.phase, shrinking: game.zone.shrinking },
    // tickMs is the live EMA. tickP*Ms/tickMaxMs are raw per-sim-step samples
    // over the last TICK_SAMPLE_WINDOW steps (not an EMA maximum).
    tickMs: +room.tickMsEma.toFixed(3),
    tickP50Ms: +tp.p50.toFixed(3),
    tickP95Ms: +tp.p95.toFixed(3),
    tickP99Ms: +tp.p99.toFixed(3),
    tickMaxMs: +tp.max.toFixed(3),
    tickOverBudget: room.tickOverBudget,
    tickSamples: room.tickSampleCount,
    tickWindowCapacity: TICK_SAMPLE_WINDOW,
    tickCount: room.tickCount,
    tickTotalMs: +room.tickTotalMs.toFixed(3),
    tickLifetimeMaxMs: +room.tickLifetimeMaxMs.toFixed(3),
    // Snapshot+ACK payload only. Client-observed all-binary traffic is reported
    // separately by tools/loadtest.js.
    snapshotKiBps: +(room.snapshotBytesPerSec / 1024).toFixed(2),
    droppedInputs, skippedSnapshots, staleInputs, simResets: room.simResets,
    avgPing: pingN ? Math.round(pingSum / pingN) : 0,
    uptime: Math.round((Date.now() - room.createdAt) / 1000),
  };
}
function stats() {
  const mem = process.memoryUsage();
  return {
    ok: true, uptime: +process.uptime().toFixed(1), protocol: PROTOCOL_VERSION,
    simHz: CFG.SIM_HZ, snapshotHz: CFG.SNAPSHOT_HZ,
    memoryMB: +(mem.rss / 1048576).toFixed(1),
    heapUsedMB: +(mem.heapUsed / 1048576).toFixed(1),
    heapTotalMB: +(mem.heapTotal / 1048576).toFixed(1),
    externalMB: +(mem.external / 1048576).toFixed(1),
    rooms: [...rooms.values()].map(roomInfo),
  };
}

function log(...args) { console.log(new Date().toISOString().slice(11, 19), ...args); }

http.listen(PORT, HOST, () => {
  log(`[server] Frontline on http://${HOST}:${http.address().port}  (ws /ws, ${CFG.SIM_HZ} Hz sim, ${CFG.SNAPSHOT_HZ} Hz snapshots)`);
  log(`[server] static root: ${ROOT}`);
  if (HOST === '127.0.0.1') log('[server] bound to localhost only. For LAN set HOST=0.0.0.0; for internet use a Cloudflare Tunnel (see README).');
});
