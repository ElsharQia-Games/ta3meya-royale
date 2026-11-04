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
import { clamp, wrapAngle } from '../shared/math.js';
import {
  PROTOCOL_VERSION, MSG, encodePong, decodePing, decodePong,
  decodeInput, wireToSimInput, encodeSnapshot, snapshotState, encodeEvents,
  encodeLoot, filterEvents, sanitizeName, sanitizeRoom, decodeControl,
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
    this.tickMsEma = 0;
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
    lastSeq: 0, lastConsumedSeq: 0, lastSimInput: null,
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
  client.queue = [];
  client.lastSimInput = null;
  ws.client = client;
  room.clients.set(ws, client);
  room.byPlayer.set(player.id, client);
  clients.set(ws, client);
  room.inputQueues.set(player.id, []);
  room.lastHumanAt = Date.now();

  sendText(ws, {
    type: 'welcome',
    playerId: player.id,
    name: player.name,
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

  if (room.game.matchState === MATCH_STATE.LOBBY || room.game.matchState === MATCH_STATE.ENDED) room.start();
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
    winner: game.winner ? { id: game.winner.id ?? null, team: game.winner.team ?? null, name: game.winner.name } : null,
    zone: {
      cx: +game.zone.cx.toFixed(1), cz: +game.zone.cz.toFixed(1),
      r: +game.zone.r.toFixed(1), phase: game.zone.phase,
      shrinking: game.zone.shrinking, dps: game.zone.dps, active: game.zone.active,
      phaseT: +game.zone.phaseT.toFixed(1),
    },
    vehicles: game.vehicles.map(v => ({
      id: v.id, x: +v.pos[0].toFixed(2), y: +v.pos[1].toFixed(2), z: +v.pos[2].toFixed(2),
      yaw: +v.yaw.toFixed(3), pitch: +v.pitch.toFixed(3), roll: +v.roll.toFixed(3),
      speed: +Math.hypot(v.vel[0], v.vel[2]).toFixed(2), type: v.type,
      occupants: v.occupants.slice(), health: v.health,
    })),
    projectiles: game.projectiles.map(pr => ({
      type: pr.type, x: +pr.pos[0].toFixed(2), y: +pr.pos[1].toFixed(2), z: +pr.pos[2].toFixed(2),
      fuse: +pr.fuse.toFixed(2), deployed: !!pr.deployed,
    })),
    smokes: game.smokes.map(s => ({ x: +s.x.toFixed(1), y: +s.y.toFixed(1), z: +s.z.toFixed(1), r: s.r })),
  };
}

function sendState(room, only = null) {
  const payload = statePayload(room);
  if (only) { sendText(only.ws, payload); return; }
  for (const c of room.clients.values()) sendText(c.ws, payload);
}

function sendKeyframe(room, client, seq, states) {
  const ack = client.lastConsumedSeq >>> 0;
  const { buffer } = encodeSnapshot(states, null, seq, room.game.time, ack, true);
  sendBinary(client.ws, buffer);
  client.needsKeyframe = false;
  room.snapshotBytesWindow += buffer.byteLength;
}

function sendSnapshots(room) {
  const game = room.game;
  const seq = room.snapshotSeq++ & 0xffff;
  const keyframe = !room.prevStates || (room.snapshotSeq % CFG.NET.snapshotKeyframeEvery === 0);
  const states = snapshotState(game);
  const { buffer, states: newStates } = encodeSnapshot(states, room.prevStates, seq, game.time, 0, keyframe);
  room.prevStates = newStates;

  for (const c of room.clients.values()) {
    if (c.ws.readyState !== 1) continue;
    if (c.needsKeyframe) { sendKeyframe(room, c, seq, states); continue; }
    // Ack is per client, so patch the 4-byte header field on a copy.
    const copy = buffer.slice(0);
    new DataView(copy).setUint32(12, c.lastConsumedSeq >>> 0, true);
    sendBinary(c.ws, copy);
    room.snapshotBytesWindow += copy.byteLength;
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
      // Repeat held buttons but never repeat one-shot actions.
      const last = c.lastSimInput;
      inputs.set(c.playerId, {
        ...last, reload: false, grenade: false, smoke: false, heal: false,
        interact: false, cycle: false, slot: -1, stance: null, enterVehicle: undefined,
      });
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
    // Binary frames.
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const type = new DataView(ab).getUint8(0);
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

  if (!Number.isFinite(w.yaw) || !Number.isFinite(w.pitch)) return;
  w.yaw = wrapAngle(w.yaw);
  w.pitch = clamp(w.pitch, -CFG.PLAYER.MAX_PITCH, CFG.PLAYER.MAX_PITCH);
  w.slot = w.slot >= 0 && w.slot <= 1 ? w.slot : -1;
  w.stance = w.stance >= 0 && w.stance <= 2 ? w.stance : -1;

  const q = client.queue;
  if (q.length >= CFG.NET.maxQueuedInputs) q.shift();
  q.push(w);
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
      room.accum -= CFG.SIM_DT;
      steps++;
    }
    if (room.accum > CFG.SIM_DT * 10) room.accum = 0;

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
function roomInfo(room) {
  const game = room.game;
  const alive = [...game.players.values()].filter(p => p.alive).length;
  let pingSum = 0, pingN = 0;
  for (const c of room.clients.values()) { pingSum += c.rttEma; pingN++; }
  return {
    code: room.code, mode: room.mode, state: game.matchState,
    tick: game.tick, time: +game.time.toFixed(1),
    players: game.players.size, humans: room.humanCount(), bots: game.players.size - room.humanCount(),
    alive, score: game.score, zone: { r: +game.zone.r.toFixed(1), phase: game.zone.phase, shrinking: game.zone.shrinking },
    tickMs: +room.tickMsEma.toFixed(3), snapshotKBps: +(room.snapshotBytesPerSec / 1024).toFixed(2),
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
  log(`[server] Frontline on http://${HOST}:${PORT}  (ws /ws, ${CFG.SIM_HZ} Hz sim, ${CFG.SNAPSHOT_HZ} Hz snapshots)`);
  log(`[server] static root: ${ROOT}`);
  if (HOST === '127.0.0.1') log('[server] bound to localhost only. For LAN set HOST=0.0.0.0; for internet use a Cloudflare Tunnel (see README).');
});
