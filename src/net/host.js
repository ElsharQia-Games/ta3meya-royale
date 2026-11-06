// In-browser authoritative game host.
// Runs the shared deterministic Game simulation at 60 Hz and snapshot broadcasts at 30 Hz.
// Can host both local player (zero-latency in-memory channel) and remote peers (WebRTC / MQTT relay).

import { Game } from '../../shared/sim.js';
import { CFG, MATCH_STATE } from '../../shared/config.js';
import { packVehicle } from '../../shared/vehicle.js';
import { packProjectile } from '../../shared/projectiles.js';
import { clamp } from '../../shared/math.js';
import {
  PROTOCOL_VERSION, MSG, encodePing, encodePong, decodePing, decodePong, encodeAck,
  decodeInput, wireToSimInput, encodeSnapshot, snapshotState,
  encodeEvents, encodeLoot, filterEvents, sanitizeName, sanitizeRoom, decodeControl,
  isProtocolCompatible, backlogLimit, pushBoundedInput, isStaleInput, heldSimInput,
  sanitizeWireInput, INPUT_RATE_PER_SECOND, CONTROL_RATE_PER_SECOND,
} from '../../shared/protocol.js';
import { spawnBots, stepBots } from '../../server/bots.js';
import { createLocalPair, DataChannelSocket, RelaySocket, ICE_SERVERS } from './peer.js';
import { canAuthenticateHost, createHostIdentity, signHostOffline } from './host-auth.js';

const INPUT_BACKLOG = backlogLimit(CFG.NET.maxQueuedInputs);
const MAX_PLAYERS = 32;
// Fixed-step scheduling. A single render frame may catch up at most six
// simulation ticks (~100 ms). Anything older is deliberately discarded rather
// than simulated late: the alternative is a spiral of death where a slow frame
// queues even more catch-up work. The dedicated server uses the same bounded
// loop shape with an eight-step budget.
const MAX_CATCHUP_STEPS = 6;
const MAX_CATCHUP_SECONDS = MAX_CATCHUP_STEPS * CFG.SIM_DT;

function randomToken() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'tok_' + Math.random().toString(36).slice(2, 12);
}

export class BrowserHost {
  constructor(opts = {}) {
    this.code = sanitizeRoom(opts.room || 'ALPHA01');
    this.mode = opts.mode === 'tdm' ? 'tdm' : 'br';
    this.mapSeed = opts.mapSeed ?? CFG.MAP.SEED;
    this.game = new Game({ mode: this.mode, mapSeed: this.mapSeed });
    this.clients = new Map();     // socket -> client
    this.byPlayer = new Map();    // playerId -> client
    this.inputQueues = new Map(); // playerId -> []
    this.history = [];
    this.snapshotSeq = 0;
    this.prevStates = null;
    this.snapshotAccum = 0;
    this.lootTimer = 0;
    this.stateTimer = 0;
    this.pingTimer = 0;
    this.closed = false;
    this.relay = opts.relay || null;
    this.botCount = opts.bots !== undefined ? opts.bots : (this.mode === 'tdm' ? 6 : 10);
    this.hadProjectiles = false;
    this.peerConnections = new Map(); // guestId -> RTCPeerConnection
    this.peerGuests = new Map();      // guestId -> peer negotiation state
    this.pendingCandidates = new Map(); // guestId -> queued ICE candidates
    this._lastAnnounceAt = 0;
    this.sockets = new Set();         // every socket this host owns and must close
    this.relayUnsubs = [];            // relay subscriptions owned by this host
    this.timers = new Set();          // host-owned timeouts (fallback, etc.)
    // Stable identity is used by room election and stale-presence rejection.
    this.hostId = opts.hostId || randomToken();
    this.sessionId = opts.sessionId || randomToken();
    this.startedAt = Number.isFinite(opts.startedAt) ? opts.startedAt : Date.now();

    // A relay guest has no peer-close event: without an explicit leave or a
    // liveness deadline it would remain in the authoritative game forever.
    this.guestTimeoutMs = Number.isFinite(opts.guestTimeoutMs)
      ? Math.max(1, opts.guestTimeoutMs) : 45000;
    this.guestSweepMs = Number.isFinite(opts.guestSweepMs)
      ? Math.max(1, opts.guestSweepMs)
      : Math.max(10, Math.min(2000, Math.floor(this.guestTimeoutMs / 4)));
    this.watchdogTimer = null;

    // Host shutdown is signed with a session key pair. The public half is
    // announced during discovery so guests can authenticate host_offline;
    // public host/session ids alone are not proof of origin.
    this.hostIdentity = opts.hostIdentity || null;
    this.hostPublicKey = this.hostIdentity?.publicKey || null;
    this.offlineSignature = null;
    this.signingReady = Promise.resolve();
    if (this.hostIdentity) {
      this.signingReady = this._signOfflineMessage();
    } else if (canAuthenticateHost()) {
      this.signingReady = createHostIdentity().then((identity) => {
        if (this.closed || !identity) return;
        this.hostIdentity = identity;
        this.hostPublicKey = identity.publicKey;
        return this._signOfflineMessage();
      }).catch(() => {});
    }

    // Fixed-step accumulator. `step(dt)` accumulates render time; each fixed
    // tick consumes exactly CFG.SIM_DT regardless of the render frame rate.
    this.accumulator = 0;
    this.maxCatchUpSteps = Number.isFinite(opts.maxCatchUpSteps)
      ? Math.max(1, Math.floor(opts.maxCatchUpSteps)) : MAX_CATCHUP_STEPS;
    // How long a WebRTC negotiation may remain incomplete before the relay
    // fallback wins. Injectable so the single-transport race can be tested.
    this.webrtcFallbackMs = Number.isFinite(opts.webrtcFallbackMs)
      ? Math.max(1, opts.webrtcFallbackMs) : 5000;
    this.tickCount = 0;
    this.catchUpSteps = 0;
    this.droppedSimTime = 0;
    // Injectable clock keeps stale-input and rate-limit tests deterministic.
    this.now = typeof opts.now === 'function' ? opts.now : () => performance.now();

    this.spawnBots();
    this.game.begin();

    if (this.relay) {
      this._initRelayHost();
    }
  }

  spawnBots() {
    if (this.botCount <= 0) return;
    const bots = spawnBots(this.game, this.botCount, this.mode === 'tdm');
    for (const p of bots) {
      this.inputQueues.set(p.id, []);
    }
  }

  ensureCapacity() {
    while (this.game.players.size >= MAX_PLAYERS) {
      const bot = [...this.game.players.values()].find(p => p.isBot);
      if (!bot) return false;
      this.game.removePlayer(bot.id);
      this.inputQueues.delete(bot.id);
    }
    return true;
  }

  pickTeam() {
    let a = 0, b = 0;
    for (const p of this.game.players.values()) {
      if (p.team === 0) a++;
      else b++;
    }
    return a <= b ? 0 : 1;
  }

  createLocalClient(name = 'Host', kit = 'assault') {
    const { clientSocket, serverSocket } = createLocalPair();
    this._registerSocket(serverSocket);
    return clientSocket;
  }

  addClient(socket, joinMsg) {
    if (this.clients.has(socket)) return;
    if (!isProtocolCompatible(joinMsg.protocol)) {
      this._sendText(socket, { type: 'error', reason: `Incompatible protocol ${joinMsg.protocol}` });
      try { socket.close(4003, 'Incompatible protocol'); } catch {}
      return;
    }

    if (!this.ensureCapacity()) {
      this._sendText(socket, { type: 'error', reason: 'Room is full' });
      try { socket.close(4003, 'Room full'); } catch {}
      return;
    }

    const name = sanitizeName(joinMsg.name || 'Soldier');
    const team = this.mode === 'tdm' ? this.pickTeam() : 0;
    const player = this.game.addPlayer(name, team, { connected: true, kit: joinMsg.kit });
    const token = randomToken();

    const client = {
      ws: socket,
      playerId: player.id,
      token,
      lastSeq: 0,
      lastQueuedSeq: 0,
      lastConsumedSeq: 0,
      lastSimInput: null,
      lastInputAt: 0,
      lastSeenAt: this.now(),
      needsKeyframe: true,
      spectateId: null,
      rttEma: 50,
      queue: [],
      // Admission diagnostics. These are intentionally per-client so a single
      // peer cannot hide its drops inside room-wide counters.
      droppedInputs: 0,
      rejectedInputs: 0,
      staleInputs: 0,
      inputWindowStart: this.now(),
      inputCount: 0,
      controlWindowStart: this.now(),
      controlCount: 0,
    };

    socket.client = client;
    this.clients.set(socket, client);
    this.byPlayer.set(player.id, client);
    this.inputQueues.set(player.id, []);

    socket.onmessage = (ev) => this._onSocketMessage(socket, ev.data);
    if (!socket.onclose) socket.onclose = () => this.removeClient(socket);
    if (!socket.onerror) socket.onerror = () => this.removeClient(socket);

    this._sendText(socket, {
      type: 'welcome',
      playerId: player.id,
      name: player.name,
      weapons: player.weapons.slice(),
      kit: player.kit,
      room: this.code,
      mode: this.mode,
      mapSeed: this.game.mapSeed,
      protocol: PROTOCOL_VERSION,
      token,
      serverTime: this.game.time,
      tickRate: CFG.SIM_HZ,
      snapshotRate: CFG.SNAPSHOT_HZ,
      maxPlayers: MAX_PLAYERS,
      reconnectGrace: 30000,
    });

    this.broadcastRoster();
    this.sendState(client);
    this.sendLoot(client);
  }

  removeClient(socket, explicit = true) {
    const c = this.clients.get(socket);
    if (!c) return;
    this.clients.delete(socket);
    this.byPlayer.delete(c.playerId);
    this.inputQueues.delete(c.playerId);
    const p = this.game.players.get(c.playerId);
    if (p) this.game.removePlayer(p.id);
    this.broadcastRoster();
  }

  // Remove a client and, when it belongs to a relay/WebRTC guest negotiation,
  // dispose that negotiation too. Otherwise a graceful leave would delete the
  // player but leave `peerGuests` holding an open socket entry, and the same
  // guest could never rejoin.
  _dropClient(socket, reason = 'client removed') {
    const guestId = socket?.guestId || null;
    this.removeClient(socket, true);
    if (guestId) {
      const g = this.peerGuests.get(guestId);
      if (g && g.socket === socket) this._disposeGuest(guestId);
    }
    this.sockets.delete(socket);
    try { socket?.close?.(1000, reason); } catch {}
  }

  _startGuestWatchdog() {
    if (this.watchdogTimer || this.closed) return;
    this.watchdogTimer = setInterval(() => this._sweepStaleClients(), this.guestSweepMs);
  }

  _sweepStaleClients() {
    if (this.closed) return;
    const now = this.now();
    for (const [socket, c] of [...this.clients]) {
      if (now - c.lastSeenAt <= this.guestTimeoutMs) continue;
      this._dropClient(socket, 'guest timed out');
    }
  }

  _onSocketMessage(socket, data) {
    const c = this.clients.get(socket);
    if (!c) {
      if (typeof data === 'string') {
        const msg = decodeControl(data);
        if (msg && msg.type === 'join') {
          this.addClient(socket, msg);
        }
      }
      return;
    }

    // Any authenticated/assigned client message proves the transport is still
    // alive. This drives the relay-guest watchdog below.
    c.lastSeenAt = this.now();

    if (typeof data === 'string') {
      const msg = decodeControl(data);
      if (!msg) return;
      // Leave is lifecycle control, not gameplay chat: process it even if the
      // client exhausted its control budget so a graceful shutdown always
      // removes the player immediately.
      if (msg.type === 'leave') {
        this._dropClient(socket, 'guest left');
        return;
      }
      if (!this._allowControl(c)) return;
      switch (msg.type) {
        case 'chat': {
          const text = String(msg.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 140);
          if (text) this.broadcastChat(c.playerId, text);
          break;
        }
        case 'resync':
          c.needsKeyframe = true;
          break;
        case 'spectate': {
          const id = Number(msg.id);
          c.spectateId = Number.isInteger(id) && id >= 0 ? id : null;
          break;
        }
        case 'start':
          if (this.game.matchState === MATCH_STATE.LOBBY) this.game.begin();
          break;
      }
      return;
    }

    const buf = data instanceof ArrayBuffer ? data : ArrayBuffer.isView(data)
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null;
    if (!buf || buf.byteLength < 1) return;

    const type = new DataView(buf).getUint8(0);
    if (type === MSG.INPUT) {
      // Rate-limit first, then decode/sanitise/sequence-check. Rejected frames
      // never reach the queue, so they cannot displace valid input or refresh
      // the stale-input timestamp.
      if (!this._allowInput(c)) return;
      const wire = decodeInput(buf);
      if (!wire) { c.rejectedInputs++; return; }
      const clean = sanitizeWireInput(wire, c.lastQueuedSeq);
      if (!clean) { c.rejectedInputs++; return; }
      c.lastQueuedSeq = clean.seq;
      c.lastInputAt = this.now();
      const q = this.inputQueues.get(c.playerId);
      if (!q) { c.rejectedInputs++; return; }
      c.droppedInputs += pushBoundedInput(q, clean, INPUT_BACKLOG);
    } else if (type === MSG.PING) {
      const ping = decodePing(buf);
      if (ping) this._sendBinary(socket, encodePong(ping.clientTime, this.game.time));
    } else if (type === MSG.PONG) {
      const pong = decodePong(buf);
      if (pong && c.pingSentAt) {
        const rtt = Math.max(0, this.now() - c.pingSentAt);
        c.rttEma = c.rttEma ? c.rttEma * 0.7 + rtt * 0.3 : rtt;
        const p = this.game.players.get(c.playerId);
        if (p) p.ping = Math.round(c.rttEma);
      }
    }
  }

  _allowInput(c) {
    const now = this.now();
    if (now - c.inputWindowStart > 1000) {
      c.inputWindowStart = now;
      c.inputCount = 0;
    }
    c.inputCount++;
    return c.inputCount <= INPUT_RATE_PER_SECOND;
  }

  _allowControl(c) {
    const now = this.now();
    if (now - c.controlWindowStart > 1000) {
      c.controlWindowStart = now;
      c.controlCount = 0;
    }
    c.controlCount++;
    return c.controlCount <= CONTROL_RATE_PER_SECOND;
  }

  broadcastChat(senderId, text) {
    const sender = this.game.players.get(senderId);
    if (!sender || !text) return;
    const msg = {
      type: 'chat',
      id: sender.id,
      name: sender.name,
      team: sender.team,
      text: String(text).slice(0, 120),
    };
    for (const c of this.clients.values()) this._sendText(c.ws, msg);
  }

  broadcastRoster() {
    const players = [...this.game.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      bot: p.isBot,
      alive: p.alive,
      kills: p.kills,
      deaths: p.deaths,
      ping: Math.round(p.ping || 0),
    }));
    const msg = {
      type: 'roster',
      players,
      mode: this.mode,
      state: this.game.matchState,
      maxPlayers: MAX_PLAYERS,
    };
    for (const c of this.clients.values()) this._sendText(c.ws, msg);
  }

  sendState(only = null) {
    const game = this.game;
    const payload = {
      type: 'state',
      time: game.time,
      tick: game.tick,
      mode: game.mode,
      matchState: game.matchState,
      countdown: game.countdown,
      roundTime: game.roundTime,
      score: game.score.slice(),
      destroyed: [...game.destroyedBoxes],
      deaths: [...game.players.values()].filter(p => !p.alive && p.death).map(p => ({ id: p.id, pos: p.pos.slice(), ...p.death })),
      winner: game.winner ? { id: game.winner.id ?? null, team: game.winner.team ?? null, name: game.winner.name } : null,
      zone: {
        cx: +game.zone.cx.toFixed(1), cz: +game.zone.cz.toFixed(1),
        r: +game.zone.r.toFixed(1), phase: game.zone.phase,
        shrinking: game.zone.shrinking, dps: game.zone.dps, active: game.zone.active,
        phaseT: +game.zone.phaseT.toFixed(1),
      },
      vehicles: game.vehicles.map(packVehicle),
      projectiles: game.projectiles.map(packProjectile),
      smokes: game.smokes.map(s => ({ id: s.id, x: +s.x.toFixed(1), y: +s.y.toFixed(1), z: +s.z.toFixed(1), r: s.r })),
    };
    if (only) { this._sendText(only.ws, payload); return; }
    for (const c of this.clients.values()) this._sendText(c.ws, payload);
  }

  sendLoot(only = null) {
    const all = this.game.packLoot();
    const targets = only ? [only] : [...this.clients.values()];
    for (const c of targets) {
      const p = this.game.players.get(c.playerId);
      const pos = p ? p.pos : [0, 0, 0];
      const near = all.filter(l => {
        const dx = l.x - pos[0], dz = l.z - pos[2];
        return dx * dx + dz * dz < 180 * 180;
      });
      this._sendBinary(c.ws, encodeLoot(near));
    }
  }

  sendSnapshots() {
    const game = this.game;
    const seq = this.snapshotSeq++ & 0xffff;
    const keyframe = !this.prevStates || (this.snapshotSeq % CFG.NET.snapshotKeyframeEvery === 0);
    const states = snapshotState(game);
    const { buffer, states: newStates } = encodeSnapshot(states, this.prevStates, seq, game.time, keyframe);
    this.prevStates = newStates;

    let keyframeBuffer = keyframe ? buffer : null;

    for (const c of this.clients.values()) {
      this._sendBinary(c.ws, encodeAck(seq, c.lastConsumedSeq >>> 0));
      if (c.needsKeyframe) {
        if (!keyframeBuffer) keyframeBuffer = encodeSnapshot(states, null, seq, game.time, true).buffer;
        this._sendBinary(c.ws, keyframeBuffer);
        c.needsKeyframe = false;
      } else {
        this._sendBinary(c.ws, buffer);
      }
    }
  }

  sendEvents(events) {
    if (!events.length) return;
    for (const c of this.clients.values()) {
      const p = this.game.players.get(c.playerId);
      const viewer = { id: c.playerId, pos: p ? p.pos : [0, 0, 0] };
      const filtered = filterEvents(events, viewer);
      if (filtered.length) this._sendBinary(c.ws, encodeEvents(filtered));
    }
  }

  // Advance authoritative simulation from render/elapsed time. Callers pass
  // the elapsed wall-clock delta; the host converts it into fixed CFG.SIM_DT
  // ticks. Returns the number of ticks executed (useful for diagnostics/tests).
  step(dt) {
    if (this.closed) return 0;
    const elapsed = Number(dt);
    if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
    this.accumulator += elapsed;

    let steps = 0;
    while (this.accumulator + 1e-9 >= CFG.SIM_DT && steps < this.maxCatchUpSteps) {
      this.accumulator -= CFG.SIM_DT;
      this._stepFixed();
      steps++;
    }

    // Bound catch-up work. If more than the budget remains, discard it instead
    // of building a growing backlog (spiral of death). This is what makes a
    // long stall / background-tab resume safe: the simulation skips stale time
    // rather than trying to replay it.
    if (this.accumulator + 1e-9 >= CFG.SIM_DT) {
      this.droppedSimTime += this.accumulator;
      this.accumulator = 0;
    }
    if (this.accumulator < 0) this.accumulator = 0;
    if (steps > 1) this.catchUpSteps += steps - 1;
    return steps;
  }

  _stepFixed() {
    const dt = CFG.SIM_DT;
    const game = this.game;
    const inputs = new Map();

    for (const c of this.clients.values()) {
      const p = game.players.get(c.playerId);
      if (!p || !p.connected) continue;
      const q = this.inputQueues.get(c.playerId);
      if (q && q.length) {
        const w = q.shift();
        // Admission already guarantees a strictly increasing sequence. Keep
        // the defensive check so a future/legacy queue writer cannot replay.
        if (w.seq <= c.lastConsumedSeq) continue;
        c.lastSeq = w.seq;
        const sim = wireToSimInput(w, c.lastSimInput);
        if (sim.enterVehicle !== undefined && sim.enterVehicle !== -1) {
          if (!game.vehicles.some(v => v.id === sim.enterVehicle)) sim.enterVehicle = undefined;
        }
        c.lastSimInput = sim;
        c.lastConsumedSeq = w.seq;
        inputs.set(c.playerId, sim);
      } else if (c.lastSimInput) {
        // Repeat held buttons only inside the grace window; one-shot actions
        // are always cleared by heldSimInput so they cannot fire twice.
        const stale = isStaleInput(c.lastInputAt, this.now());
        const next = heldSimInput(c.lastSimInput, stale);
        if (stale) { c.staleInputs++; c.lastSimInput = next; }
        inputs.set(c.playerId, next);
      }
    }

    stepBots(game, dt, inputs);

    const fireTargets = new Map();
    for (const [pid, sim] of inputs) {
      if (!sim.shoot) continue;
      const c = this.byPlayer.get(pid);
      if (!c) continue;
      const rewind = clamp(c.rttEma / 2000 + CFG.INTERP_DELAY, 0, CFG.MAX_REWIND);
      const hist = this._findHistory(game.time - rewind);
      if (hist) fireTargets.set(pid, Game.targetsFromHistory(hist));
    }

    game.step(inputs, dt, { fireTargets });
    this.tickCount++;

    this.history.push({ t: game.time, map: game.captureHitboxes() });
    const maxHist = Math.ceil(CFG.HISTORY_SECONDS * CFG.SIM_HZ);
    if (this.history.length > maxHist) this.history.shift();

    const events = game.events.splice(0);
    if (events.length) this.sendEvents(events);

    this.snapshotAccum += dt;
    if (this.snapshotAccum >= 1 / CFG.SNAPSHOT_HZ - 1e-6) {
      this.snapshotAccum -= 1 / CFG.SNAPSHOT_HZ;
      this.sendSnapshots();

      const moving = game.vehicles.filter(v => v.occupants.some(id => id !== null) || Math.hypot(v.vel[0], v.vel[2]) > .15);
      if (moving.length) {
        const payload = { type: 'vehicles', time: game.time, vehicles: moving.map(packVehicle) };
        for (const c of this.clients.values()) this._sendText(c.ws, payload);
      }
      const projectiles = game.projectiles.filter(p => !p.deployed);
      if (projectiles.length || this.hadProjectiles) {
        const payload = { type: 'projectiles', time: game.time, projectiles: projectiles.map(packProjectile) };
        for (const c of this.clients.values()) this._sendText(c.ws, payload);
      }
      this.hadProjectiles = projectiles.length > 0;
    }

    this.lootTimer -= dt;
    if (this.lootTimer <= 0) { this.lootTimer = 1.2; this.sendLoot(); }

    this.stateTimer -= dt;
    if (this.stateTimer <= 0) { this.stateTimer = 0.2; this.sendState(); }

    this.pingTimer -= dt;
    if (this.pingTimer <= 0) {
      this.pingTimer = 5;
      const now = this.now();
      for (const c of this.clients.values()) {
        c.pingSentAt = now;
        this._sendBinary(c.ws, encodePing(now));
      }
    }
  }

  _findHistory(t) {
    const h = this.history;
    if (!h.length) return null;
    let best = h[0], bd = Math.abs(h[0].t - t);
    for (let i = 1; i < h.length; i++) {
      const d = Math.abs(h[i].t - t);
      if (d < bd) { bd = d; best = h[i]; }
    }
    return bd <= 0.25 ? best.map : null;
  }

  _sendBinary(ws, buf) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(buf); return true; } catch { return false; }
  }

  _sendText(ws, obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  // ---------------------------------------------------------------------------
  // Relay / WebRTC signaling
  // ---------------------------------------------------------------------------
  _initRelayHost() {
    const relay = this.relay;
    const room = this.code;
    const subscribe = (topic, handler) => {
      const unsub = relay.subscribe(topic, handler);
      if (typeof unsub === 'function') this.relayUnsubs.push(unsub);
      return unsub;
    };

    // Listen for peer join/hello requests. Repeated hellos from the same guest
    // are deduplicated inside _handlePeerHello so they cannot open parallel
    // negotiations.
    subscribe(`ta3meya/${room}/join`, (t, payload) => {
      try {
        const msg = this._parseRelayJson(payload);
        if ((msg.type === 'peer_join' || msg.type === 'peer_hello') && msg.guestId) {
          this._handlePeerHello(msg);
        }
      } catch {}
    });

    // Listen for WebRTC answers / candidates from guests
    subscribe(`ta3meya/${room}/signal/host/+`, (topic, payload) => {
      try {
        const msg = this._parseRelayJson(payload);
        const guestId = topic.split('/').pop();
        this._handlePeerSignal(guestId, msg);
      } catch {}
    });

    // Answer candidate probes with an immediate presence announcement. This
    // shortens discovery for a joiner that started just after a heartbeat and
    // lets simultaneous candidates see that a host already exists. It must
    // bypass the heartbeat throttle: a probe that lands within 500 ms of the
    // previous announcement still has to see a host before its (possibly
    // short) probe window expires, otherwise it would elect itself.
    subscribe(`ta3meya/${room}/presence`, (t, payload) => {
      try {
        const msg = this._parseRelayJson(payload);
        if (msg.type === 'candidate' && msg.nodeId && msg.nodeId !== this.hostId) {
          this.announcePresence(true);
        }
      } catch {}
    });

    // Announce immediately (not only after the first 2 s heartbeat) so a
    // guest that joins during the probe window does not elect itself. When a
    // key pair is still being generated, wait for it so the first announcement
    // already carries the public key a guest will pin.
    const start = () => {
      if (this.closed || this.heartbeatTimer) return;
      this.announcePresence(true);
      this.heartbeatTimer = setInterval(() => this.announcePresence(true), 2000);
    };
    if (this.hostPublicKey) start();
    else this.signingReady.then(start).catch(() => {});
    this._startGuestWatchdog();
  }

  _parseRelayJson(payload) {
    const str = typeof TextDecoder !== 'undefined'
      ? new TextDecoder().decode(payload)
      : Buffer.from(payload).toString('utf8');
    const msg = JSON.parse(str);
    return msg && typeof msg === 'object' ? msg : null;
  }

  _offlineFields() {
    return {
      hostId: this.hostId,
      sessionId: this.sessionId,
      room: this.code,
      startedAt: this.startedAt,
    };
  }

  _signOfflineMessage() {
    return signHostOffline(this.hostIdentity, this._offlineFields()).then((signature) => {
      if (signature && !this.closed) this.offlineSignature = signature;
      return signature;
    });
  }

  // Resolves once the shutdown message is ready to be signed. Session
  // establishment awaits this so a caller cannot close before host_offline can
  // be authenticated.
  ready() {
    return this.signingReady || Promise.resolve();
  }

  announcePresence(force = false) {
    if (this.closed || !this.relay) return false;
    const now = Date.now();
    if (!force && this._lastAnnounceAt && now - this._lastAnnounceAt < 500) return false;
    this._lastAnnounceAt = now;
    return this.relay.publish(`ta3meya/${this.code}/presence`, {
      type: 'host_present',
      hostId: this.hostId,
      sessionId: this.sessionId,
      room: this.code,
      mode: this.mode,
      startedAt: this.startedAt,
      protocol: PROTOCOL_VERSION,
      players: this.game.players.size,
      ...(this.hostPublicKey ? { hostKey: this.hostPublicKey } : {}),
    });
  }

  _handlePeerHello(msg) {
    if (this.closed) return;
    const guestId = String(msg.guestId || '');
    if (!guestId) return;
    if (msg.room !== undefined && msg.room !== this.code) return;
    if (msg.protocol !== undefined && !isProtocolCompatible(msg.protocol)) return;
    const room = this.code;

    let g = this.peerGuests.get(guestId);
    if (g) {
      // Already connected, or a negotiation is in flight: a repeated hello is
      // a retransmission, not a request for a second logical session.
      if (g.socket && g.socket.readyState === 1) return;
      if (g.pc && g.pc.connectionState &&
        !['closed', 'failed', 'disconnected'].includes(g.pc.connectionState)) return;
      this._disposeGuest(guestId);
    }

    g = { guestId, pc: null, socket: null, relaySocket: null, fallbackTimer: null, opened: false };
    this.peerGuests.set(guestId, g);

    // If WebRTC is supported, attempt direct P2P data channel
    if (typeof RTCPeerConnection !== 'undefined') {
      try {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        g.pc = pc;
        this.peerConnections.set(guestId, pc);

        const dc = pc.createDataChannel('ta3meya', { ordered: true });
        dc.binaryType = 'arraybuffer';

        const onOpen = () => {
          if (g.opened || this.closed || this.peerGuests.get(guestId) !== g) return;
          if (g.fallbackTimer) { clearTimeout(g.fallbackTimer); this.timers.delete(g.fallbackTimer); g.fallbackTimer = null; }
          // The relay fallback may have won while this data channel was still
          // negotiating. First transport wins: keep the relay socket and
          // discard the late WebRTC attempt rather than closing the relay out
          // from under an already-connected guest.
          if (g.relaySocket) {
            try { dc.close(); } catch {}
            this._abandonPeerConnection(g, guestId);
            return;
          }
          g.opened = true;
          const socket = new DataChannelSocket(dc);
          g.socket = socket;
          this._registerSocket(socket, guestId);
        };
        if (dc.readyState === 'open') {
          onOpen();
        } else if (typeof dc.addEventListener === 'function') {
          dc.addEventListener('open', onOpen);
        } else {
          dc.onopen = onOpen;
        }

        pc.onicecandidate = (ev) => {
          if (ev.candidate) {
            this.relay?.publish(`ta3meya/${room}/signal/${guestId}`, {
              type: 'candidate',
              candidate: ev.candidate,
              room,
              hostId: this.hostId,
              sessionId: this.sessionId,
              ...(this.hostPublicKey ? { hostKey: this.hostPublicKey } : {}),
            });
          }
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' && !g.opened && !this.closed) {
            this._activateRelayFallback(guestId);
          }
        };

        pc.createOffer().then((offer) => {
          return pc.setLocalDescription(offer).then(() => {
            this.relay?.publish(`ta3meya/${room}/signal/${guestId}`, {
              type: 'offer',
              sdp: offer.sdp,
              room,
              mode: this.mode,
              hostId: this.hostId,
              sessionId: this.sessionId,
              startedAt: this.startedAt,
              ...(this.hostPublicKey ? { hostKey: this.hostPublicKey } : {}),
            });
          });
        }).catch(() => {});

        // Fallback to MQTT relay if WebRTC doesn't open within the configured
        // budget.
        g.fallbackTimer = this._later(() => {
          g.fallbackTimer = null;
          if (!g.opened) this._activateRelayFallback(guestId);
        }, this.webrtcFallbackMs);
        return;
      } catch {}
    }

    // Direct relay mode if WebRTC is unavailable
    this._activateRelayFallback(guestId);
  }

  _activateRelayFallback(guestId) {
    if (this.closed) return null;
    const g = this.peerGuests.get(guestId);
    if (!g || g.opened) return null;
    if (g.relaySocket && g.relaySocket.readyState === 1) return g.relaySocket;
    if (g.fallbackTimer) { clearTimeout(g.fallbackTimer); this.timers.delete(g.fallbackTimer); g.fallbackTimer = null; }

    // The relay is now the chosen transport. Close the unfinished WebRTC
    // attempt so a late `open` event cannot tear down or replace it.
    this._abandonPeerConnection(g, guestId);

    const room = this.code;
    const sendTopic = `ta3meya/${room}/to_guest/${guestId}`;
    const recvTopic = `ta3meya/${room}/to_host/${guestId}`;
    const socket = new RelaySocket(this.relay, sendTopic, recvTopic);
    g.relaySocket = socket;
    g.socket = socket;
    this._registerSocket(socket, guestId);
    // Tell guest host is ready to accept socket messages
    this.relay.publish(`ta3meya/${room}/signal/${guestId}`, {
      type: 'peer_ready',
      guestId,
      room,
      mode: this.mode,
      hostId: this.hostId,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      ...(this.hostPublicKey ? { hostKey: this.hostPublicKey } : {}),
    });
    return socket;
  }

  _abandonPeerConnection(g, guestId) {
    if (g.pc) { try { g.pc.close(); } catch {} g.pc = null; }
    this.peerConnections.delete(guestId);
    this.pendingCandidates?.delete(guestId);
  }

  _later(fn, ms) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.closed) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  _registerSocket(socket, guestId = null) {
    this.sockets.add(socket);
    if (guestId) socket.guestId = guestId;
    socket.onmessage = (ev) => this._onSocketMessage(socket, ev.data);
    const onGone = () => {
      this.sockets.delete(socket);
      if (guestId) this._forgetGuest(guestId, socket);
      this.removeClient(socket);
    };
    socket.onclose = onGone;
    socket.onerror = onGone;
  }

  _forgetGuest(guestId, socket = null) {
    const g = this.peerGuests.get(guestId);
    if (!g) return;
    // A superseded socket must not tear down the replacement.
    if (socket && g.socket && g.socket !== socket) return;
    this._disposeGuest(guestId);
  }

  _disposeGuest(guestId) {
    const g = this.peerGuests.get(guestId);
    if (!g) return;
    // Remove from the maps first: closing a socket can synchronously invoke
    // onclose, which must not recurse into a second dispose.
    this.peerGuests.delete(guestId);
    this.peerConnections.delete(guestId);
    this.pendingCandidates?.delete(guestId);
    if (g.fallbackTimer) { clearTimeout(g.fallbackTimer); this.timers.delete(g.fallbackTimer); }
    if (g.relaySocket) { try { g.relaySocket.close(1000, 'peer disposed'); } catch {} }
    if (g.pc) { try { g.pc.close(); } catch {} }
  }

  _handlePeerSignal(guestId, msg) {
    if (this.closed || !msg) return;
    // Guest answers/candidates are scoped to this host session. Older guests
    // omit the optional identity fields; when present they must match.
    if (msg.room !== undefined && msg.room !== this.code) return;
    if (msg.hostId !== undefined && msg.hostId !== this.hostId) return;
    if (msg.sessionId !== undefined && msg.sessionId !== this.sessionId) return;
    const g = this.peerGuests.get(guestId);
    const pc = g?.pc || this.peerConnections.get(guestId);
    if (!pc) return;

    if (msg.type === 'answer' && msg.sdp) {
      pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).then(async () => {
        const queued = this.pendingCandidates?.get(guestId);
        if (queued) {
          this.pendingCandidates.delete(guestId);
          for (const c of queued) {
            try { await pc.addIceCandidate(c); } catch {}
          }
        }
      }).catch(() => {});
    } else if (msg.type === 'candidate' && msg.candidate) {
      if (pc.remoteDescription && pc.remoteDescription.type) {
        pc.addIceCandidate(msg.candidate).catch(() => {});
      } else {
        if (!this.pendingCandidates) this.pendingCandidates = new Map();
        if (!this.pendingCandidates.has(guestId)) this.pendingCandidates.set(guestId, []);
        this.pendingCandidates.get(guestId).push(msg.candidate);
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    for (const unsub of this.relayUnsubs.splice(0)) {
      try { unsub(); } catch {}
    }
    // Best-effort fast discovery for waiting guests. The relay itself is owned
    // by the session, not by the host, so it is closed by the session. The
    // signature (pre-computed at start) binds the shutdown to this host/session
    // key so a third party cannot forge it from public ids alone.
    try {
      this.relay?.publish(`ta3meya/${this.code}/presence`, {
        type: 'host_offline',
        ...this._offlineFields(),
        ...(this.hostPublicKey ? { hostKey: this.hostPublicKey } : {}),
        ...(this.offlineSignature ? { signature: this.offlineSignature } : {}),
      });
    } catch {}

    for (const socket of [...this.sockets]) {
      try { socket.close(1000, 'Host closed'); } catch {}
    }
    this.sockets.clear();
    for (const c of this.clients.values()) {
      try { c.ws.close(1000, 'Host closed'); } catch {}
    }
    this.clients.clear();
    for (const guestId of [...this.peerGuests.keys()]) this._disposeGuest(guestId);
    for (const pc of this.peerConnections.values()) {
      try { pc.close(); } catch {}
    }
    this.peerConnections.clear();
  }
}
