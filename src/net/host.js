// In-browser authoritative game host.
// Runs the shared deterministic Game simulation at 60 Hz and snapshot broadcasts at 30 Hz.
// Can host both local player (zero-latency in-memory channel) and remote peers (WebRTC / MQTT relay).

import { Game } from '../../shared/sim.js';
import { CFG, MATCH_STATE } from '../../shared/config.js';
import { packVehicle } from '../../shared/vehicle.js';
import { packProjectile } from '../../shared/projectiles.js';
import { clamp } from '../../shared/math.js';
import {
  PROTOCOL_VERSION, MSG, encodePong, decodePing, decodePong, encodeAck,
  decodeInput, wireToSimInput, encodeSnapshot, snapshotState,
  encodeEvents, encodeLoot, filterEvents, sanitizeName, sanitizeRoom, decodeControl,
  isProtocolCompatible, backlogLimit, isStaleInput, heldSimInput,
} from '../../shared/protocol.js';
import { spawnBots, stepBots } from '../../server/bots.js';
import { createLocalPair, DataChannelSocket, RelaySocket } from './peer.js';

const INPUT_BACKLOG = backlogLimit(CFG.NET.maxQueuedInputs);
const MAX_PLAYERS = 32;

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
      lastConsumedSeq: 0,
      lastSimInput: null,
      lastInputAt: 0,
      needsKeyframe: true,
      spectateId: null,
      rttEma: 50,
      queue: [],
    };

    socket.client = client;
    this.clients.set(socket, client);
    this.byPlayer.set(player.id, client);
    this.inputQueues.set(player.id, []);

    socket.onmessage = (ev) => this._onSocketMessage(socket, ev.data);
    socket.onclose = () => this.removeClient(socket);
    socket.onerror = () => this.removeClient(socket);

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

    if (typeof data === 'string') {
      const msg = decodeControl(data);
      if (!msg) return;
      switch (msg.type) {
        case 'chat':
          this.broadcastChat(c.playerId, msg.text);
          break;
        case 'resync':
          c.needsKeyframe = true;
          break;
        case 'spectate':
          c.spectateId = msg.id >= 0 ? msg.id : null;
          break;
        case 'leave':
          this.removeClient(socket, true);
          break;
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
      const wire = decodeInput(buf);
      if (wire) {
        const q = this.inputQueues.get(c.playerId);
        if (q && q.length < INPUT_BACKLOG) q.push(wire);
        c.lastInputAt = performance.now();
      }
    } else if (type === MSG.PING) {
      const ping = decodePing(buf);
      if (ping) this._sendBinary(socket, encodePong(ping.clientTime, this.game.time));
    } else if (type === MSG.PONG) {
      const pong = decodePong(buf);
      if (pong && c.pingSentAt) {
        const rtt = Math.max(0, performance.now() - c.pingSentAt);
        c.rttEma = c.rttEma ? c.rttEma * 0.7 + rtt * 0.3 : rtt;
        const p = this.game.players.get(c.playerId);
        if (p) p.ping = Math.round(c.rttEma);
      }
    }
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

  step(dt) {
    if (this.closed) return;
    const game = this.game;
    const inputs = new Map();

    for (const c of this.clients.values()) {
      const p = game.players.get(c.playerId);
      if (!p || !p.connected) continue;
      const q = this.inputQueues.get(c.playerId);
      if (q && q.length) {
        const w = q.shift();
        if (w.seq <= c.lastSeq) continue;
        c.lastSeq = w.seq;
        const sim = wireToSimInput(w, c.lastSimInput);
        if (sim.enterVehicle !== undefined && sim.enterVehicle !== -1) {
          if (!game.vehicles.some(v => v.id === sim.enterVehicle)) sim.enterVehicle = undefined;
        }
        c.lastSimInput = sim;
        c.lastConsumedSeq = w.seq;
        inputs.set(c.playerId, sim);
      } else if (c.lastSimInput) {
        const stale = isStaleInput(c.lastInputAt, performance.now());
        const next = heldSimInput(c.lastSimInput, stale);
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
      const now = performance.now();
      for (const c of this.clients.values()) {
        c.pingSentAt = now;
        this._sendBinary(c.ws, encodePong(now, game.time));
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

    // Listen for peer join/hello requests
    relay.subscribe(`ta3meya/${room}/join`, (t, payload) => {
      try {
        const str = typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(payload) : Buffer.from(payload).toString('utf8');
        const msg = JSON.parse(str);
        if ((msg.type === 'peer_join' || msg.type === 'peer_hello') && msg.guestId) {
          this._handlePeerHello(msg);
        }
      } catch {}
    });

    // Listen for WebRTC answers / candidates from guests
    relay.subscribe(`ta3meya/${room}/signal/host/+`, (topic, payload) => {
      try {
        const str = typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(payload) : Buffer.from(payload).toString('utf8');
        const msg = JSON.parse(str);
        const guestId = topic.split('/').pop();
        this._handlePeerSignal(guestId, msg);
      } catch {}
    });

    // Announce host heartbeat
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      relay.publish(`ta3meya/${room}/presence`, {
        type: 'host_present',
        room: this.code,
        mode: this.mode,
        players: this.game.players.size,
      });
    }, 2000);
  }

  _handlePeerHello(msg) {
    const guestId = msg.guestId;
    const room = this.code;

    // If WebRTC is supported, attempt direct P2P data channel
    if (typeof RTCPeerConnection !== 'undefined') {
      try {
        const pc = new RTCPeerConnection({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
          ],
        });
        this.peerConnections.set(guestId, pc);

        const dc = pc.createDataChannel('ta3meya', { ordered: true });
        dc.binaryType = 'arraybuffer';

        let channelOpened = false;

        const onOpen = () => {
          if (channelOpened) return;
          channelOpened = true;
          const socket = new DataChannelSocket(dc);
          this._registerSocket(socket);
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
            });
          }
        };

        pc.createOffer().then((offer) => {
          return pc.setLocalDescription(offer).then(() => {
            this.relay?.publish(`ta3meya/${room}/signal/${guestId}`, {
              type: 'offer',
              sdp: offer.sdp,
              mode: this.mode,
            });
          });
        }).catch(() => {});

        // Fallback to MQTT relay if WebRTC doesn't open within 3.5s
        setTimeout(() => {
          if (!channelOpened && !this.closed) {
            this._activateRelayFallback(guestId);
          }
        }, 3500);
        return;
      } catch {}
    }

    // Direct relay mode if WebRTC unavailable
    this._activateRelayFallback(guestId);
  }

  _activateRelayFallback(guestId) {
    const room = this.code;
    const sendTopic = `ta3meya/${room}/to_guest/${guestId}`;
    const recvTopic = `ta3meya/${room}/to_host/${guestId}`;
    const socket = new RelaySocket(this.relay, sendTopic, recvTopic);
    this._registerSocket(socket);
    // Tell guest host is ready to accept socket messages
    this.relay.publish(`ta3meya/${room}/signal/${guestId}`, {
      type: 'peer_ready',
      guestId,
      mode: this.mode,
    });
  }

  _registerSocket(socket) {
    socket.onmessage = (ev) => this._onSocketMessage(socket, ev.data);
    socket.onclose = () => this.removeClient(socket);
    socket.onerror = () => this.removeClient(socket);
  }

  _handlePeerSignal(guestId, msg) {
    const pc = this.peerConnections.get(guestId);
    if (!pc) return;

    if (msg.type === 'answer' && msg.sdp) {
      pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {});
    } else if (msg.type === 'candidate' && msg.candidate) {
      pc.addIceCandidate(msg.candidate).catch(() => {});
    }
  }

  close() {
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const c of this.clients.values()) {
      try { c.ws.close(1000, 'Host closed'); } catch {}
    }
    this.clients.clear();
    for (const pc of this.peerConnections.values()) {
      try { pc.close(); } catch {}
    }
    this.peerConnections.clear();
  }
}
