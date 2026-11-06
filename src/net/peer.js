// Peer networking adapters: in-memory local channel, WebRTC DataChannel,
// and MQTT-relay fallback socket. All expose a WebSocket-compatible interface.

export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

export function createLocalPair() {
  let open = true;
  const clientSocket = {
    binaryType: 'arraybuffer',
    get readyState() { return open ? 1 : 3; },
    _onopen: null,
    get onopen() { return this._onopen; },
    set onopen(fn) {
      this._onopen = fn;
      if (fn && open) {
        queueMicrotask(() => {
          if (this._onopen === fn && open) fn();
        });
      }
    },
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      if (!open) return;
      const copy = data instanceof ArrayBuffer ? data.slice(0)
        : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data;
      queueMicrotask(() => {
        if (open && serverSocket.onmessage) {
          serverSocket.onmessage({ data: copy });
        }
      });
    },
    close(code = 1000, reason = '') {
      if (!open) return;
      open = false;
      queueMicrotask(() => {
        if (clientSocket.onclose) clientSocket.onclose({ code, reason });
        if (serverSocket.onclose) serverSocket.onclose({ code, reason });
      });
    },
  };

  const serverSocket = {
    binaryType: 'arraybuffer',
    get readyState() { return open ? 1 : 3; },
    _onopen: null,
    get onopen() { return this._onopen; },
    set onopen(fn) {
      this._onopen = fn;
      if (fn && open) {
        queueMicrotask(() => {
          if (this._onopen === fn && open) fn();
        });
      }
    },
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      if (!open) return;
      const copy = data instanceof ArrayBuffer ? data.slice(0)
        : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data;
      queueMicrotask(() => {
        if (open && clientSocket.onmessage) {
          clientSocket.onmessage({ data: copy });
        }
      });
    },
    close(code = 1000, reason = '') {
      clientSocket.close(code, reason);
    },
  };

  return { clientSocket, serverSocket };
}

export class DataChannelSocket {
  constructor(dc) {
    this.dc = dc;
    this.binaryType = 'arraybuffer';
    dc.binaryType = 'arraybuffer';
    this._onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;

    if (typeof dc.addEventListener === 'function') {
      dc.addEventListener('open', () => { if (this._onopen) this._onopen(); });
      dc.addEventListener('message', (ev) => { if (this.onmessage) this.onmessage(ev); });
      dc.addEventListener('close', (ev) => { if (this.onclose) this.onclose(ev); });
      dc.addEventListener('error', (ev) => { if (this.onerror) this.onerror(ev); });
    } else {
      dc.onopen = () => { if (this._onopen) this._onopen(); };
      dc.onmessage = (ev) => { if (this.onmessage) this.onmessage(ev); };
      dc.onclose = (ev) => { if (this.onclose) this.onclose(ev); };
      dc.onerror = (ev) => { if (this.onerror) this.onerror(ev); };
    }
  }

  get onopen() { return this._onopen; }
  set onopen(fn) {
    this._onopen = fn;
    if (fn && this.readyState === 1) {
      queueMicrotask(() => {
        if (this._onopen === fn && this.readyState === 1) fn();
      });
    }
  }

  get readyState() {
    switch (this.dc.readyState) {
      case 'connecting': return 0;
      case 'open': return 1;
      case 'closing': return 2;
      case 'closed': return 3;
      default: return 3;
    }
  }

  send(data) {
    if (this.dc.readyState === 'open') {
      try { this.dc.send(data); } catch {}
    }
  }

  close(code = 1000, reason = '') {
    try { this.dc.close(); } catch {}
  }
}

export class RelaySocket {
  constructor(relay, sendTopic, recvTopic, opts = {}) {
    this.relay = relay;
    this.sendTopic = sendTopic;
    this.recvTopic = recvTopic;
    this.binaryType = 'arraybuffer';
    this.readyState = 1; // OPEN
    this._onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;

    this.unsub = this.relay.subscribe(this.recvTopic, (topic, bytes) => {
      if (this.readyState !== 1) return;
      if (bytes.length < 1) return;
      // First byte indicates format: 1 = binary, 2 = JSON string
      const mode = bytes[0];
      const payload = bytes.subarray(1);
      if (mode === 2) {
        let text;
        if (typeof TextDecoder !== 'undefined') text = new TextDecoder().decode(payload);
        else text = Buffer.from(payload).toString('utf8');
        if (this.onmessage) this.onmessage({ data: text });
      } else {
        const copy = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
        if (this.onmessage) this.onmessage({ data: copy });
      }
    });
  }

  get onopen() { return this._onopen; }
  set onopen(fn) {
    this._onopen = fn;
    if (fn && this.readyState === 1) {
      queueMicrotask(() => {
        if (this._onopen === fn && this.readyState === 1) fn();
      });
    }
  }

  send(data) {
    if (this.readyState !== 1) return;
    let packet;
    if (typeof data === 'string') {
      let b;
      if (typeof TextEncoder !== 'undefined') b = new TextEncoder().encode(data);
      else b = Buffer.from(data, 'utf8');
      packet = new Uint8Array(1 + b.length);
      packet[0] = 2; // JSON
      packet.set(b, 1);
    } else {
      const src = data instanceof ArrayBuffer ? new Uint8Array(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(0);
      packet = new Uint8Array(1 + src.length);
      packet[0] = 1; // binary
      packet.set(src, 1);
    }
    this.relay.publish(this.sendTopic, packet);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.unsub) { this.unsub(); this.unsub = null; }
    if (this.onclose) this.onclose({ code, reason });
  }
}

import { MQTTRelay } from './relay.js';
import { BrowserHost } from './host.js';
import { NetClient } from './client.js';
import { PROTOCOL_VERSION } from '../../shared/protocol.js';
import { electCandidate, isHostAnnouncementNewer, isUsableHostAnnouncement } from './election.js';
import { createHostIdentity, verifyHostOffline } from './host-auth.js';

function randomId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 10);
}

function parseRelayJson(payload) {
  try {
    const str = typeof TextDecoder !== 'undefined'
      ? new TextDecoder().decode(payload)
      : Buffer.from(payload).toString('utf8');
    const msg = JSON.parse(str);
    return msg && typeof msg === 'object' ? msg : null;
  } catch {
    return null;
  }
}

// Establish one logical peer session: either an explicit host, or a guest that
// probes the room and becomes host only if election selects it.
//
// Session establishment and MQTT transport reconnection are deliberately
// separate. `onStatus('connected')` may fire many times over the life of a
// relay; only the first transition creates a BrowserHost or starts discovery.
export function joinPeerSession({
  name = 'Soldier',
  room = 'ALPHA01',
  mode = 'br',
  kit = 'assault',
  isHost = false,
  WebSocket = globalThis.WebSocket,
  onStatus = null,
  onError = null,
  relayFactory = null,
  signal = null,
  connectTimeoutMs = 15000,
  probeMs = 2500,
  announceMs = 500,
  hostRetryMs = 1000,
  reElectionMs = 3000,
  guestTimeoutMs = 45000,
  guestSweepMs = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const nodeId = randomId('g_');
    const sessionId = randomId('s_');
    const startedAt = Date.now();
    // Generate the host key pair up front. A candidate that wins the election
    // can then publish its public key with the first presence announcement.
    const hostIdentityReady = createHostIdentity().catch(() => null);
    const timers = new Map(); // id -> 'timeout' | 'interval'
    const unsubs = [];
    const candidates = new Map(); // nodeId -> candidate announcement
    let state = 'idle'; // idle | discovering | awaiting-host | hosting | connected | failed | closed
    let closed = false;
    let resolved = false;
    let becomingHost = false;
    let connectTimer = null;
    let abortListener = null;

    let host = null;
    let net = null;
    let guestSocket = null;
    let guestPc = null;
    let knownHost = null;
    let announceTimer = null;
    let probeTimer = null;
    let hostRetryTimer = null;
    let reElectionTimer = null;
    let lastOfferSdp = null;
    const pendingCandidates = [];
    let remoteDescriptionSet = false;

    const makeRelay = relayFactory || ((opts) => new MQTTRelay(opts));
    const relay = makeRelay({ WebSocket, onError: (e) => reportError(e) });

    function reportError(err) {
      if (closed) return;
      const message = err instanceof Error ? err.message : String(err || 'Connection error');
      if (onError) onError(message);
    }

    function abortError() {
      const err = new Error('Join cancelled');
      err.name = 'AbortError';
      return err;
    }

    function releaseAbortListener() {
      if (!abortListener || !signal) return;
      signal.removeEventListener('abort', abortListener);
      abortListener = null;
    }

    function setStatus(status) {
      if (!closed && onStatus) onStatus(status);
    }

    function later(fn, ms) {
      const id = setTimeout(() => {
        timers.delete(id);
        if (!closed) fn();
      }, ms);
      timers.set(id, 'timeout');
      return id;
    }

    function every(fn, ms) {
      const id = setInterval(fn, ms);
      timers.set(id, 'interval');
      return id;
    }

    function clearTimer(id) {
      if (!id) return null;
      if (timers.get(id) === 'interval') clearInterval(id);
      else clearTimeout(id);
      timers.delete(id);
      return null;
    }

    function clearAllTimers() {
      for (const [id, kind] of timers) {
        if (kind === 'interval') clearInterval(id);
        else clearTimeout(id);
      }
      timers.clear();
    }

    function stopDiscovery() {
      announceTimer = clearTimer(announceTimer);
      probeTimer = clearTimer(probeTimer);
      hostRetryTimer = clearTimer(hostRetryTimer);
      reElectionTimer = clearTimer(reElectionTimer);
    }

    function subscribe(topic, handler) {
      const unsub = relay.subscribe(topic, handler);
      if (typeof unsub === 'function') unsubs.push(unsub);
      return unsub;
    }

    function publish(topic, payload) {
      try { return relay.publish(topic, payload); } catch { return false; }
    }

    function sendHello() {
      publish(`ta3meya/${room}/join`, {
        type: 'peer_hello',
        guestId: nodeId,
        sessionId,
        name,
        room,
        mode,
        kit,
        protocol: PROTOCOL_VERSION,
      });
    }

    function announceCandidate() {
      publish(`ta3meya/${room}/presence`, {
        type: 'candidate',
        nodeId,
        sessionId,
        room,
        mode,
        kit,
        startedAt,
        protocol: PROTOCOL_VERSION,
      });
    }

    function startAnnouncing() {
      if (announceTimer) return;
      announceCandidate();
      // Repeat during the election window so a publish that lands before the
      // broker has fully applied a peer's subscription is still observed.
      announceTimer = every(() => {
        if (closed || state !== 'discovering') {
          announceTimer = clearTimer(announceTimer);
          return;
        }
        announceCandidate();
      }, announceMs);
    }

    function scheduleHostRetry() {
      if (hostRetryTimer || closed || net || host) return;
      hostRetryTimer = later(() => {
        hostRetryTimer = null;
        if (closed || net || host) return;
        sendHello();
        scheduleHostRetry();
      }, hostRetryMs);
    }

    function finish(result) {
      if (resolved) return;
      resolved = true;
      connectTimer = clearTimer(connectTimer);
      releaseAbortListener();
      const hostInfo = result.host
        ? { hostId: result.host.hostId, sessionId: result.host.sessionId, startedAt: result.host.startedAt, mode: result.host.mode, self: true }
        : (knownHost
          ? { hostId: knownHost.hostId, sessionId: knownHost.sessionId, startedAt: knownHost.startedAt, mode: knownHost.mode, self: false }
          : null);
      resolve({ ...result, relay, hostInfo, nodeId, sessionId, close });
    }

    function close() {
      if (closed) return;
      closed = true;
      state = 'closed';
      clearAllTimers();
      releaseAbortListener();
      for (const unsub of unsubs.splice(0)) {
        try { unsub(); } catch {}
      }
      // A relay socket has no peer-close signal. Publish the explicit leave
      // while the transport is still open so the host removes this player now
      // instead of waiting for its liveness watchdog. `leave()` also performs
      // the disconnect, which makes the subsequent socket close a no-op.
      try { net?.leave(); } catch {}
      try { guestSocket?.close(1000, 'session closed'); } catch {}
      guestSocket = null;
      try { guestPc?.close(); } catch {}
      guestPc = null;
      try { host?.close(); } catch {}
      try { relay.close(); } catch {}
    }

    // Initial setup can fail before there is any session for the caller to
    // close (broker unreachable, aborted by the lobby). Reject only after
    // releasing everything this attempt owns.
    function fail(err) {
      if (resolved) return;
      resolved = true;
      close();
      reject(err);
    }

    async function becomeHost() {
      if (closed || host || becomingHost) return;
      becomingHost = true;
      stopDiscovery();
      state = 'hosting';
      setStatus('hosting');
      const hostIdentity = await hostIdentityReady;
      if (closed || host) return;
      host = new BrowserHost({
        room, mode, relay, hostId: nodeId, sessionId, startedAt,
        hostIdentity: hostIdentity || null,
        guestTimeoutMs,
        ...(guestSweepMs ? { guestSweepMs } : {}),
      });
      // Wait until the signed shutdown message exists, so a caller that
      // immediately closes the session still sends an authenticated
      // host_offline rather than an unsigned hint.
      try { await host.ready(); } catch {}
      if (closed || host?.closed) {
        try { host?.close(); } catch {}
        host = null;
        return;
      }
      const localSocket = host.createLocalClient(name, kit);
      net = new NetClient({
        name, room, mode, kit, allowReconnect: false,
        WebSocket: class { constructor() { return localSocket; } },
      });
      finish({ net, host });
    }

    function abandonGuestPeer() {
      const pc = guestPc;
      guestPc = null;
      pendingCandidates.length = 0;
      remoteDescriptionSet = false;
      lastOfferSdp = null;
      if (pc) { try { pc.close(); } catch {} }
    }

    function connectAsGuestWithSocket(socket, actualMode, { relayFallback = false } = {}) {
      if (closed) { try { socket.close(); } catch {} return; }
      if (net) { try { socket.close(1000, 'duplicate transport'); } catch {} return; }
      // First transport wins. When `peer_ready` selects the MQTT relay, stop
      // paying for the unfinished WebRTC attempt and clear its queued ICE
      // candidates. A late DataChannel open then has no session to join.
      if (relayFallback) abandonGuestPeer();
      stopDiscovery();
      state = 'connected';
      guestSocket = socket;
      setStatus('connected');
      net = new NetClient({
        name, room, mode: actualMode || mode, kit, allowReconnect: false,
        WebSocket: class { constructor() { return socket; } },
      });
      finish({ net, host: null });
    }

    function joinKnownHost() {
      if (closed || net || host || !knownHost) return;
      stopDiscovery();
      state = 'awaiting-host';
      setStatus('connecting-guest');
      sendHello();
      scheduleHostRetry();
    }

    function finishDiscovery() {
      if (closed || net || host || state !== 'discovering') return;
      probeTimer = clearTimer(probeTimer);
      if (knownHost) { joinKnownHost(); return; }

      const winner = electCandidate([...candidates.keys()], nodeId);
      if (!winner || winner === nodeId) { becomeHost().catch((err) => fail(err)); return; }

      // Another candidate won the deterministic election. Wait for its host
      // presence/offer; do not create a second authoritative simulation.
      state = 'awaiting-host';
      setStatus('connecting-guest');
      announceTimer = clearTimer(announceTimer);
      sendHello();
      scheduleHostRetry();
      reElectionTimer = later(() => {
        reElectionTimer = null;
        if (closed || net || host || state !== 'awaiting-host' || knownHost) return;
        // The winner never appeared (crash/never started). Drop it and retry.
        candidates.delete(winner);
        hostRetryTimer = clearTimer(hostRetryTimer);
        state = 'discovering';
        startAnnouncing();
        probeTimer = later(finishDiscovery, Math.max(50, Math.min(probeMs, 500)));
      }, reElectionMs);
    }

    // A relay transport has no close signal: the guest's MQTT socket stays
    // "open" even after the host disappears. An explicit host_offline presence
    // message is therefore the only graceful shutdown signal on this path.
    // Terminate the logical guest session instead of pretending it is alive;
    // the UI can offer a fresh join. This mirrors the DataChannel close path.
    function hostLost(reason) {
      if (closed || host) return;
      const socket = guestSocket;
      guestSocket = null;
      net = null;
      knownHost = null;
      stopDiscovery();
      state = 'failed';
      reportError(reason);
      if (socket) { try { socket.close(1000, reason); } catch {} }
    }

    function hasHostIdentity(msg) {
      return !!msg && typeof msg.hostId === 'string' && msg.hostId !== '' &&
        typeof msg.sessionId === 'string' && msg.sessionId !== '';
    }

    // Signaling topics are scoped by this node's random id, but a broker (or a
    // stale host session) can still publish on them. Host identity must first
    // be established by a usable presence announcement/election; an
    // identity-bearing offer or peer_ready can never pin a host by itself.
    // Once pinned, only that exact host/session is accepted.
    function acceptHostIdentity(msg) {
      if (!msg || !knownHost || !hasHostIdentity(msg)) return false;
      if (msg.hostId !== knownHost.hostId || msg.sessionId !== knownHost.sessionId) return false;
      // The key can be learnt from a later signal if the first presence
      // announcement was generated before key setup completed. It is never
      // replaced once pinned.
      if (!knownHost.hostKey && msg.hostKey) knownHost.hostKey = msg.hostKey;
      return true;
    }

    function hostSignalIdentity() {
      return knownHost
        ? { room, hostId: knownHost.hostId, sessionId: knownHost.sessionId }
        : { room };
    }

    function onSignal(topic, payload) {
      if (closed || net || host || state === 'failed') return;
      const msg = parseRelayJson(payload);
      if (!msg) return;
      if (msg.room !== undefined && msg.room !== room) return;

      if (msg.type === 'peer_ready') {
        if (!acceptHostIdentity(msg)) return;
        const sendTopic = `ta3meya/${room}/to_host/${nodeId}`;
        const recvTopic = `ta3meya/${room}/to_guest/${nodeId}`;
        const socket = new RelaySocket(relay, sendTopic, recvTopic);
        connectAsGuestWithSocket(socket, msg.mode, { relayFallback: true });
        return;
      }

      if (msg.type === 'offer' && msg.sdp) {
        if (!acceptHostIdentity(msg)) return;
        if (typeof RTCPeerConnection === 'undefined') return;
        if (guestPc && guestPc.connectionState &&
          !['closed', 'failed', 'disconnected'].includes(guestPc.connectionState)) return;
        if (guestPc && lastOfferSdp === msg.sdp) return;
        lastOfferSdp = msg.sdp;
        setStatus('connecting-p2p');

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        guestPc = pc;
        remoteDescriptionSet = false;
        pendingCandidates.length = 0; // candidates from a superseded offer

        pc.ondatachannel = (ev) => {
          if (closed || net) return;
          const dc = ev.channel;
          const socket = new DataChannelSocket(dc);
          const tryConnect = () => connectAsGuestWithSocket(socket, msg.mode);
          if (dc.readyState === 'open') tryConnect();
          else if (typeof dc.addEventListener === 'function') dc.addEventListener('open', tryConnect);
          else dc.onopen = tryConnect;
        };

        pc.onicecandidate = (ev) => {
          if (ev.candidate) {
            publish(`ta3meya/${room}/signal/host/${nodeId}`, {
              type: 'candidate',
              candidate: ev.candidate,
              ...hostSignalIdentity(),
            });
          }
        };

        pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp }).then(async () => {
          remoteDescriptionSet = true;
          while (pendingCandidates.length) {
            const c = pendingCandidates.shift();
            try { await pc.addIceCandidate(c); } catch {}
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          publish(`ta3meya/${room}/signal/host/${nodeId}`, {
            type: 'answer',
            sdp: answer.sdp,
            ...hostSignalIdentity(),
          });
        }).catch(() => {});
        return;
      }

      if (msg.type === 'candidate' && msg.candidate) {
        // Untagged/foreign candidates cannot be attributed to the pinned host.
        if (!acceptHostIdentity(msg)) return;
        if (guestPc && remoteDescriptionSet) {
          guestPc.addIceCandidate(msg.candidate).catch(() => {});
        } else {
          pendingCandidates.push(msg.candidate);
        }
      }
    }

    function hostOfflineMatches(msg) {
      return !!knownHost && msg.hostId === knownHost.hostId && msg.sessionId === knownHost.sessionId;
    }

    function applyHostOffline(msg) {
      if (closed || host || !hostOfflineMatches(msg)) return;
      if (net) { hostLost('Host closed the room'); return; }
      knownHost = null;
      if (state === 'awaiting-host') {
        stopDiscovery();
        state = 'discovering';
        startAnnouncing();
        probeTimer = later(finishDiscovery, probeMs);
      }
    }

    function onPresence(topic, payload) {
      if (closed) return;
      const msg = parseRelayJson(payload);
      if (!msg || msg.room !== room) return;

      if (msg.type === 'host_offline') {
        if (!hostOfflineMatches(msg)) return;
        // Public host/session ids are not authentication. When discovery
        // established a host key, only a signature over this exact
        // session/room can end the session. Keyless legacy hosts retain the
        // identity-only path and are documented as unauthenticated.
        if (knownHost.hostKey) {
          verifyHostOffline(knownHost.hostKey, {
            hostId: msg.hostId,
            sessionId: msg.sessionId,
            room: msg.room,
            startedAt: msg.startedAt,
          }, msg.signature).then((ok) => {
            if (ok) applyHostOffline(msg);
          }).catch(() => {});
        } else {
          applyHostOffline(msg);
        }
        return;
      }

      if (net || host || state === 'failed') return;

      if (msg.type === 'host_present') {
        if (msg.hostId === nodeId) return;
        if (!isUsableHostAnnouncement(msg, room, PROTOCOL_VERSION)) return;
        // Ignore an older delayed heartbeat once a newer host session is known.
        if (!isHostAnnouncementNewer(msg, knownHost)) return;
        const previous = knownHost;
        const next = { ...msg, receivedAt: Date.now() };
        // Never lose a pinned key because a heartbeat omitted it.
        if (previous && previous.hostId === next.hostId &&
          previous.sessionId === next.sessionId && !next.hostKey && previous.hostKey) {
          next.hostKey = previous.hostKey;
        }
        knownHost = next;
        if (state === 'discovering' || state === 'awaiting-host') joinKnownHost();
        return;
      }

      if (msg.type === 'candidate') {
        if (msg.nodeId === nodeId || state !== 'discovering') return;
        candidates.set(msg.nodeId, { ...msg, receivedAt: Date.now() });
        return;
      }
    }

    function startDiscovery() {
      state = 'discovering';
      setStatus('probing-room');
      // Subscribe before announcing: simultaneous candidates must be able to
      // observe one another before any probe timer expires.
      subscribe(`ta3meya/${room}/presence`, onPresence);
      subscribe(`ta3meya/${room}/signal/${nodeId}`, onSignal);
      startAnnouncing();
      probeTimer = later(finishDiscovery, probeMs);
    }

    function onTransportConnected() {
      if (closed || state === 'failed') return;
      if (state === 'idle') {
        if (isHost) becomeHost().catch((err) => fail(err));
        else startDiscovery();
        return;
      }
      // A transport reconnect is not a new logical session. Refresh only the
      // announcements (relay re-subscribes its existing topic set on CONNACK).
      if (state === 'hosting') { host?.announcePresence(true); return; }
      if (state === 'discovering') { announceCandidate(); return; }
      if (state === 'awaiting-host') { sendHello(); }
    }

    relay.onStatus = (status) => {
      if (closed) return;
      if (status === 'connected') onTransportConnected();
    };
    relay.onError = (e) => reportError(e);

    if (signal) {
      if (signal.aborted) { fail(abortError()); return; }
      abortListener = () => fail(abortError());
      signal.addEventListener('abort', abortListener, { once: true });
    }
    // A broker can retry forever without ever delivering a CONNACK. Bound the
    // wait so the lobby receives a recoverable error instead of hanging on a
    // promise that can no longer resolve.
    const timeoutMs = Number.isFinite(connectTimeoutMs) ? Math.max(1, connectTimeoutMs) : 15000;
    connectTimer = later(() => {
      connectTimer = null;
      fail(new Error('Timed out connecting to the room broker'));
    }, timeoutMs);

    relay.connect();
  });
}
