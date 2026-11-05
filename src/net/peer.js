// Peer networking adapters: in-memory local channel, WebRTC DataChannel,
// and MQTT-relay fallback socket. All expose a WebSocket-compatible interface.

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

export function joinPeerSession({
  name = 'Soldier',
  room = 'ALPHA01',
  mode = 'br',
  kit = 'assault',
  isHost = false,
  WebSocket = globalThis.WebSocket,
  onStatus = null,
  onError = null,
} = {}) {
  return new Promise((resolve) => {
    const relay = new MQTTRelay({ WebSocket });
    const guestId = 'g_' + Math.random().toString(36).slice(2, 10);

    const cleanup = () => {
      // Don't close relay because host or relay socket might still need it
    };

    relay.onStatus = (status) => {
      if (status !== 'connected') return;

      if (isHost) {
        // Explicit host creation
        if (onStatus) onStatus('hosting');
        const host = new BrowserHost({ room, mode, relay, WebSocket });
        const localSocket = host.createLocalClient(name, kit);
        const net = new NetClient({
          name, room, mode, kit,
          WebSocket: class { constructor() { return localSocket; } },
        });
        resolve({ net, host, relay });
        return;
      }

      if (onStatus) onStatus('probing-room');

      let resolved = false;
      let peerConnection = null;
      let probeTimer = null;

      const becomeHost = () => {
        if (resolved) return;
        resolved = true;
        if (probeTimer) clearTimeout(probeTimer);
        if (onStatus) onStatus('hosting');
        const host = new BrowserHost({ room, mode, relay, WebSocket });
        const localSocket = host.createLocalClient(name, kit);
        const net = new NetClient({
          name, room, mode, kit,
          WebSocket: class { constructor() { return localSocket; } },
        });
        resolve({ net, host, relay });
      };

      const connectAsGuestWithSocket = (socket, actualMode) => {
        if (resolved) return;
        resolved = true;
        if (probeTimer) clearTimeout(probeTimer);
        if (onStatus) onStatus('connecting-guest');
        const net = new NetClient({
          name, room, mode: actualMode || mode, kit,
          WebSocket: class { constructor() { return socket; } },
        });
        resolve({ net, host: null, relay });
      };

      // 1. Listen for WebRTC signals or peer_ready from host
      relay.subscribe(`ta3meya/${room}/signal/${guestId}`, (t, payload) => {
        try {
          const str = typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(payload) : Buffer.from(payload).toString('utf8');
          const msg = JSON.parse(str);
          if (msg.type === 'peer_ready') {
            const sendTopic = `ta3meya/${room}/to_host/${guestId}`;
            const recvTopic = `ta3meya/${room}/to_guest/${guestId}`;
            const socket = new RelaySocket(relay, sendTopic, recvTopic);
            connectAsGuestWithSocket(socket, msg.mode);
            return;
          }
          if (msg.type === 'offer' && msg.sdp && typeof RTCPeerConnection !== 'undefined') {
            if (onStatus) onStatus('connecting-p2p');
            const pc = new RTCPeerConnection({
              iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
              ],
            });
            peerConnection = pc;

            pc.ondatachannel = (ev) => {
              const dc = ev.channel;
              const socket = new DataChannelSocket(dc);
              if (dc.readyState === 'open') {
                connectAsGuestWithSocket(socket, msg.mode);
              } else if (typeof dc.addEventListener === 'function') {
                dc.addEventListener('open', () => connectAsGuestWithSocket(socket, msg.mode));
              } else {
                dc.onopen = () => connectAsGuestWithSocket(socket, msg.mode);
              }
            };

            pc.onicecandidate = (ev) => {
              if (ev.candidate) {
                relay.publish(`ta3meya/${room}/signal/host/${guestId}`, {
                  type: 'candidate',
                  candidate: ev.candidate,
                });
              }
            };

            pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp }).then(() => {
              return pc.createAnswer().then((answer) => {
                return pc.setLocalDescription(answer).then(() => {
                  relay.publish(`ta3meya/${room}/signal/host/${guestId}`, {
                    type: 'answer',
                    sdp: answer.sdp,
                  });
                });
              });
            }).catch(() => {});
          } else if (msg.type === 'candidate' && peerConnection) {
            peerConnection.addIceCandidate(msg.candidate).catch(() => {});
          }
        } catch {}
      });

      // 2. Send hello probe to host
      relay.publish(`ta3meya/${room}/join`, {
        type: 'peer_hello',
        guestId,
        name,
        room,
        mode,
        kit,
        protocol: PROTOCOL_VERSION,
      });

      // If no host answers within 2.5s, this player becomes the host
      probeTimer = setTimeout(() => {
        becomeHost();
      }, 2500);
    };

    relay.connect();
  });
}
