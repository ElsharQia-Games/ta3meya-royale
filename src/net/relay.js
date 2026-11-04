// Lightweight MQTT 3.1.1 client over WebSocket.
// Connects to public brokers (EMQX / HiveMQ) for serverless room discovery,
// signaling, and message relay without requiring any external dependencies.

export const MQTT_RELAYS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

function encodeUtf8(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  return Buffer.from(str, 'utf8');
}

function decodeUtf8(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  return Buffer.from(bytes).toString('utf8');
}

function mqttStr(str) {
  const b = encodeUtf8(str);
  return [b.length >> 8, b.length & 255, ...b];
}

function mqttPacket(type, body) {
  let len = body.length;
  const lenBytes = [];
  do {
    let digit = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) digit |= 0x80;
    lenBytes.push(digit);
  } while (len > 0);
  const header = new Uint8Array(1 + lenBytes.length + body.length);
  header[0] = type;
  header.set(lenBytes, 1);
  header.set(body, 1 + lenBytes.length);
  return header.buffer;
}

export class MQTTRelay {
  constructor(opts = {}) {
    this.relays = opts.relays || MQTT_RELAYS;
    this.relayIndex = 0;
    this.WebSocket = opts.WebSocket || globalThis.WebSocket;
    this.clientId = opts.clientId || ('troy_' + Math.random().toString(36).slice(2, 10));
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.subscriptions = new Map(); // topic filter -> Set of callbacks
    this.buffer = new Uint8Array(0);
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.onStatus = opts.onStatus || null;
    this.onError = opts.onError || null;
  }

  connect() {
    if (this.closed) return;
    this._cleanup();
    const url = this.relays[this.relayIndex % this.relays.length];
    try {
      this.ws = new this.WebSocket(url, ['mqtt']);
    } catch (e) {
      this._scheduleReconnect();
      return;
    }
    this.ws.binaryType = 'arraybuffer';
    const ws = this.ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      // CONNECT frame: CleanSession=1, KeepAlive=30s
      const body = [
        ...mqttStr('MQTT'), 4, 0x02, 0, 30,
        ...mqttStr(this.clientId),
      ];
      this._send(mqttPacket(0x10, body));
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data)
        : ArrayBuffer.isView(ev.data) ? new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength)
        : null;
      if (!buf) return;
      this._handleBytes(buf);
    };

    ws.onerror = (e) => {
      if (this.ws !== ws) return;
      if (this.onError) this.onError(e);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this._stopPing();
      if (!this.closed) {
        this.relayIndex++;
        this._scheduleReconnect();
      }
    };
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  _cleanup() {
    this._stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(); } catch {}
    }
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.connected && this.ws && this.ws.readyState === 1) {
        this._send(mqttPacket(0xc0, [])); // PINGREQ
      }
    }, 20000);
  }

  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  _send(buf) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(buf);
      return true;
    } catch {
      return false;
    }
  }

  _handleBytes(incoming) {
    let buf = incoming;
    if (this.buffer.length) {
      const merged = new Uint8Array(this.buffer.length + incoming.length);
      merged.set(this.buffer);
      merged.set(incoming, this.buffer.length);
      buf = merged;
    }

    let i = 0;
    while (i < buf.length) {
      const start = i;
      const first = buf[i++];
      const type = first >> 4;
      let len = 0, mul = 1, b, digits = 0;
      do {
        if (i >= buf.length) { this.buffer = buf.slice(start); return; }
        if (++digits > 4) { this.buffer = new Uint8Array(0); return; }
        b = buf[i++];
        len += (b & 0x7f) * mul;
        mul *= 128;
      } while (b & 0x80);

      if (i + len > buf.length) {
        this.buffer = buf.slice(start);
        return;
      }

      const body = buf.subarray(i, i + len);
      i += len;

      if (type === 2) {
        // CONNACK: return code in body[1]
        if (body.length >= 2 && body[1] === 0) {
          this.connected = true;
          this._startPing();
          // Resubscribe active subscriptions
          for (const topic of this.subscriptions.keys()) {
            this._sendSubscribe(topic);
          }
          if (this.onStatus) this.onStatus('connected');
        }
      } else if (type === 3) {
        // PUBLISH
        this._handlePublish(first, body);
      } else if (type === 13) {
        // PINGRESP
      }
    }
    this.buffer = new Uint8Array(0);
  }

  _sendSubscribe(topic) {
    const packetId = 1;
    const subBody = [packetId >> 8, packetId & 255, ...mqttStr(topic), 0];
    this._send(mqttPacket(0x82, subBody));
  }

  _handlePublish(first, body) {
    if (body.length < 2) return;
    const topicLen = (body[0] << 8) | body[1];
    if (body.length < 2 + topicLen) return;
    const topic = decodeUtf8(body.subarray(2, 2 + topicLen));
    const payloadBytes = body.subarray(2 + topicLen);

    for (const [filter, handlers] of this.subscriptions) {
      if (this._matchesTopic(filter, topic)) {
        for (const handler of handlers) {
          handler(topic, payloadBytes);
        }
      }
    }
  }

  _matchesTopic(filter, topic) {
    if (filter === topic) return true;
    if (filter.endsWith('/#')) {
      const prefix = filter.slice(0, -2);
      return topic === prefix || topic.startsWith(prefix + '/');
    }
    if (filter.includes('+')) {
      const fparts = filter.split('/');
      const tparts = topic.split('/');
      if (fparts.length !== tparts.length) return false;
      for (let i = 0; i < fparts.length; i++) {
        if (fparts[i] !== '+' && fparts[i] !== tparts[i]) return false;
      }
      return true;
    }
    return false;
  }

  subscribe(topic, handler) {
    let handlers = this.subscriptions.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.subscriptions.set(topic, handlers);
      if (this.connected) this._sendSubscribe(topic);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.subscriptions.delete(topic);
    };
  }

  publish(topic, payload) {
    let bytes;
    if (typeof payload === 'string') {
      bytes = encodeUtf8(payload);
    } else if (payload instanceof Uint8Array) {
      bytes = payload;
    } else if (payload instanceof ArrayBuffer) {
      bytes = new Uint8Array(payload);
    } else {
      bytes = encodeUtf8(JSON.stringify(payload));
    }
    const pubBody = new Uint8Array(2 + encodeUtf8(topic).length + bytes.length);
    const tBytes = encodeUtf8(topic);
    pubBody[0] = tBytes.length >> 8;
    pubBody[1] = tBytes.length & 255;
    pubBody.set(tBytes, 2);
    pubBody.set(bytes, 2 + tBytes.length);
    return this._send(mqttPacket(0x30, pubBody));
  }

  close() {
    this.closed = true;
    this.connected = false;
    this._cleanup();
    this.subscriptions.clear();
  }
}
