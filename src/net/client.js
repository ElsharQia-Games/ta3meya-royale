// Browser WebSocket client. Owns the connection, ping/RTT measurement, the
// snapshot delta cache and the interpolation buffer. No rendering here.
import {
  MSG, encodeInput, decodeSnapshot, applySnapshot, decodeEvents, decodeLoot,
  decodeControl, encodePing, decodePong, decodePing, encodePong, decodeAck,
  PROTOCOL_VERSION, isProtocolCompatible, snapshotAcceptance,
} from '../../shared/protocol.js';
import { SnapshotBuffer } from '../prediction.js';

const RECONNECT_MAX_MS = 15000;
// At most one keyframe request per window while a delta baseline is missing.
// The server also emits a periodic keyframe, so recovery stays bounded even if
// the request is lost.
const RESYNC_MIN_MS = 250;

export class NetClient {
  constructor(opts = {}) {
    this.url = opts.url || defaultUrl();
    this.WebSocket = opts.WebSocket || globalThis.WebSocket;
    this.name = opts.name || 'Soldier';
    this.room = opts.room || 'ALPHA01';
    this.mode = opts.mode || 'br';
    this.token = opts.token || null;
    this.ws = null;
    this.connected = false;
    this.joined = false;
    this.closed = false;
    this.playerId = null;
    this.roster = [];
    this.cache = new Map();
    this.buffer = new SnapshotBuffer();
    this.lastSnapshot = null;
    this.lastServerTime = 0;
    this.lastAppliedSeq = null;
    this.ackInput = 0;
    // Acks are keyed by snapshot sequence. A frame may be lost, so never use
    // an ack that belongs to a different tick than the snapshot being applied.
    this.acks = new Map();
    this.lastAckSeq = -1;
    this.lastAckInput = 0;
    this.ackMisses = 0;
    this.baseMismatches = 0;
    this.resyncRequests = 0;
    this.lastResyncAt = -Infinity;
    this.rtt = 0;
    this.jitter = 0;
    this.rttSamples = [];
    this.bytesIn = 0;
    this.bytesWindow = 0;
    this.bytesPerSec = 0;
    this.bytesTimer = 0;
    this.lastRecvAt = 0;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastPingSent = 0;
    this.snapshotCount = 0;
    this.droppedSnapshots = 0;
    this.onWelcome = null;
    this.onRoster = null;
    this.onSnapshot = null;
    this.onEvents = null;
    this.onLoot = null;
    this.onState = null;
    this.onVehicles = null;
    this.onChat = null;
    this.onStatus = null;
    this.onError = null;
  }

  connect() {
    // Detach the previous socket before closing it: its queued callbacks can
    // still run after the new connection is opened.
    const previous = this.ws;
    this.ws = null;
    if (previous) { try { previous.close(); } catch {} }
    this._stopPing();
    this.connected = false;
    this.joined = false;
    this.closed = false;
    // A new socket is a new server epoch. Never carry acks, delta baselines or
    // interpolation frames across it: snapshot seq 0 from the new session must
    // not reuse an ack or cache from the previous one.
    this._resetSessionState();
    this._status(this.reconnectAttempts ? 'reconnecting' : 'connecting');
    let ws;
    try { ws = new this.WebSocket(this.url); } catch (e) { this._error(String(e.message || e)); this._scheduleReconnect(); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.reconnectAttempts = 0;
      this._sendJson({
        type: 'join', name: this.name, room: this.room, mode: this.mode,
        token: this.token || undefined, protocol: PROTOCOL_VERSION,
      });
      this._status('joined-pending');
      this._startPing();
    };
    ws.onmessage = (ev) => { if (this.ws === ws) this._onMessage(ev.data); };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.joined = false;
      this._stopPing();
      if (this.closed) { this._status('closed'); return; }
      this._status('disconnected');
      if (ev.code === 4003) { this._error(ev.reason || 'Rejected by server'); this._status('error'); return; }
      this._scheduleReconnect();
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      if (!this.connected) this._error('Cannot reach the server');
    };
  }

  disconnect() {
    this.closed = true;
    this._stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(1000, 'client leave'); } catch {} }
    this.connected = false;
    this.joined = false;
  }

  leave() {
    this._sendJson({ type: 'leave' });
    this.disconnect();
  }

  // Reset everything that is scoped to one server connection. Identity needed
  // for reconnect (token, name, room, mode) and the caller-owned input sequence
  // are intentionally preserved.
  _resetSessionState() {
    this.acks.clear();
    this.ackInput = 0;
    this.lastAckSeq = -1;
    this.lastAckInput = 0;
    this.ackMisses = 0;
    this.baseMismatches = 0;
    this.resyncRequests = 0;
    this.lastResyncAt = -Infinity;
    this.cache.clear();
    this.buffer.clear();
    this.lastSnapshot = null;
    this.lastServerTime = 0;
    this.lastAppliedSeq = null;
    this.snapshotCount = 0;
    this.droppedSnapshots = 0;
    this.playerId = null;
    this.roster = [];
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || this.closed) return;
    const delay = Math.min(RECONNECT_MAX_MS, 400 * Math.pow(1.7, this.reconnectAttempts++));
    this._status('reconnecting', delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.connected) return;
      this.lastPingSent = performance.now();
      this._send(encodePing(this.lastPingSent));
    }, 1000);
  }
  _stopPing() { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } }

  sendInput(input) {
    if (!this.connected || !this.joined) return false;
    const { buttons, actions } = InputMasks(input);
    const buf = encodeInput({
      seq: input.seq >>> 0,
      clientTime: performance.now() / 1000,
      yaw: input.yaw, pitch: input.pitch,
      buttons, actions,
      slot: input.slot ?? -1,
      stance: input.stance ?? -1,
      enterVehicle: typeof input.enterVehicle === 'number' ? input.enterVehicle : 0,
      viewTime: input.viewTime || 0,
    });
    return this._send(buf);
  }

  sendChat(text) { this._sendJson({ type: 'chat', text }); }
  requestKeyframe() { return this._sendJson({ type: 'resync' }); }
  spectate(id) { this._sendJson({ type: 'spectate', id }); }
  start() { this._sendJson({ type: 'start' }); }

  _send(data) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(data); return true; } catch { return false; }
  }
  _sendJson(obj) { return this._send(JSON.stringify(obj)); }

  _status(state, extra) { if (this.onStatus) this.onStatus(state, extra); }
  _error(msg) { if (this.onError) this.onError(msg); }

  _onMessage(data) {
    const now = performance.now();
    this.lastRecvAt = now;
    if (typeof data === 'string') {
      const msg = decodeControl(data);
      if (!msg) return;
      switch (msg.type) {
        case 'welcome':
          if (!isProtocolCompatible(msg.protocol)) {
            this._error(`Incompatible server protocol ${msg.protocol ?? 'none'} (client ${PROTOCOL_VERSION})`);
            this.disconnect();
            this._status('error');
            break;
          }
          // Welcome marks the authoritative start of this connection epoch.
          // Clear old acks/snapshot baseline before applying any frame.
          this._resetSessionState();
          this.joined = true;
          this.playerId = msg.playerId;
          this.token = msg.token || this.token;
          this.room = msg.room;
          this.mode = msg.mode;
          this.reconnectAttempts = 0;
          this._status('joined');
          if (this.onWelcome) this.onWelcome(msg);
          break;
        case 'roster':
          this.roster = msg.players || [];
          if (this.onRoster) this.onRoster(msg);
          break;
        case 'state':
          if (this.onState) this.onState(msg);
          break;
        case 'vehicles':
          if (this.onVehicles) this.onVehicles(msg);
          break;
        case 'chat':
          if (this.onChat) this.onChat(msg);
          break;
        case 'error':
          this._error(msg.reason || 'Server error');
          break;
        default: break;
      }
      return;
    }

    const buf = data instanceof ArrayBuffer ? data : ArrayBuffer.isView(data)
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null;
    if (!buf || buf.byteLength < 1) return;
    this.bytesWindow += buf.byteLength;
    const type = new DataView(buf).getUint8(0);
    if (type === MSG.ACK) {
      const ack = decodeAck(buf);
      if (ack) this._onAck(ack);
    } else if (type === MSG.SNAPSHOT) {
      const snap = decodeSnapshot(buf);
      if (!snap) return;
      // Never apply a delta whose base was not the last applied snapshot, and
      // never publish duplicate/stale frames. Doing so would either reconcile
      // against a partial cache or double-apply a retransmit.
      const verdict = snapshotAcceptance(snap, this.lastAppliedSeq);
      if (verdict === 'duplicate' || verdict === 'stale') {
        this.droppedSnapshots++;
        return;
      }
      if (verdict === 'missing-base') {
        this.droppedSnapshots++;
        this.baseMismatches++;
        this._requestResync();
        return;
      }
      this.lastAppliedSeq = snap.seq;
      this.lastSnapshot = snap;
      this.lastServerTime = snap.serverTime;
      this.snapshotCount++;
      // Attach the ack that belongs to this exact snapshot. main.js and the
      // prediction layer keep reading snap.ackInput, so the API is unchanged.
      snap.ackInput = this._ackFor(snap.seq);
      applySnapshot(this.cache, snap);
      this.buffer.push(snap, this.cache);
      if (this.onSnapshot) this.onSnapshot(snap);
    } else if (type === MSG.EVENTS) {
      const events = decodeEvents(buf);
      if (events && this.onEvents) this.onEvents(events);
    } else if (type === MSG.LOOT) {
      const loot = decodeLoot(buf);
      if (loot && this.onLoot) this.onLoot(loot);
    } else if (type === MSG.PING) {
      const ping = decodePing(buf);
      if (ping) this._send(encodePong(ping.clientTime, this.lastServerTime));
    } else if (type === MSG.PONG) {
      const pong = decodePong(buf);
      if (pong) this._onPong(pong, now);
    }
  }

  _onAck(ack) {
    const seq = ack.seq >>> 0;
    const value = ack.ackInput >>> 0;
    this.acks.set(seq, value);
    // 256 entries is ~8.5 s at 30 Hz; older snapshots can no longer be applied.
    while (this.acks.size > 256) this.acks.delete(this.acks.keys().next().value);
    // WebSocket delivery is ordered. A maximum would keep a pre-wrap input
    // sequence forever instead of exposing the latest received acknowledgement.
    this.lastAckSeq = seq;
    this.lastAckInput = value;
    this.ackInput = value;
  }

  // Return the ack for this exact snapshot, or null when its ack frame was
  // lost. Guessing an older ack would replay an extra input tick and roughly
  // double the visible correction, so the caller skips reconciliation instead.
  _ackFor(seq) {
    const exact = this.acks.get(seq >>> 0);
    // ACK precedes its snapshot on the same ordered stream. Entries retained
    // for dropped snapshots must not become valid again after the u16 wrap.
    this.acks.clear();
    if (exact !== undefined) return exact;
    this.ackMisses++;
    return null;
  }

  // Ask for a full keyframe after a delta lost its baseline. Throttled so a
  // burst of mismatched deltas cannot turn into a request flood; the server's
  // periodic keyframe also bounds recovery if a request is lost.
  _requestResync() {
    const now = performance.now();
    if (now - this.lastResyncAt < RESYNC_MIN_MS) return false;
    this.lastResyncAt = now;
    this.resyncRequests++;
    return this.requestKeyframe();
  }

  _onPong(pong, now) {
    // The server only sends PONG in reply to a client probe, whose clientTime
    // is a performance.now() timestamp in milliseconds.
    const rtt = Math.max(0, now - pong.clientTime);
    this.rtt = this.rtt ? this.rtt * 0.7 + rtt * 0.3 : rtt;
    this.rttSamples.push(rtt);
    if (this.rttSamples.length > 20) this.rttSamples.shift();
    const mean = this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length;
    this.jitter = Math.sqrt(this.rttSamples.reduce((a, b) => a + (b - mean) ** 2, 0) / this.rttSamples.length);
  }

  tickStats(dt) {
    this.bytesTimer += dt;
    if (this.bytesTimer >= 1) {
      this.bytesPerSec = this.bytesWindow / this.bytesTimer;
      this.bytesWindow = 0;
      this.bytesTimer = 0;
    }
  }

  get latency() {
    return { rtt: Math.round(this.rtt), jitter: Math.round(this.jitter) };
  }
}

function InputMasks(input) {
  let buttons = 0;
  if (input.f) buttons |= 1;
  if (input.b) buttons |= 2;
  if (input.l) buttons |= 4;
  if (input.r) buttons |= 8;
  if (input.jump) buttons |= 16;
  if (input.sprint) buttons |= 32;
  if (input.ads) buttons |= 64;
  if (input.shoot) buttons |= 128;
  let actions = 0;
  if (input.reload) actions |= 1;
  if (input.grenade) actions |= 2;
  if (input.smoke) actions |= 4;
  if (input.heal) actions |= 8;
  if (input.interact) actions |= 16;
  if (input.cycle) actions |= 32;
  return { buttons, actions };
}

export function defaultUrl() {
  if (location.protocol === 'file:') return 'ws://localhost:3000/ws';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
