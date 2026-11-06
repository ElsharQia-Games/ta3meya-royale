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

// Relay application payloads are small signaling/socket frames. Keeping a hard
// ceiling prevents a malformed remaining-length from allocating or buffering
// an unbounded frame.
const MAX_PACKET_BYTES = 256 * 1024;
const MAX_BUFFER_BYTES = 512 * 1024;

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
    // MQTT packet identifiers are 1..65535 and must not collide while an
    // acknowledgement-requiring operation is in flight.
    this.nextPacketId = 1;
    this.inflightSubs = new Map(); // packetId -> topic
    this.inboundQos2 = new Map();  // packetId -> { topic, payload }
  }

  connect() {
    if (this.closed) return;
    this._cleanup();
    this.connected = false;
    const url = this.relays[this.relayIndex % this.relays.length];
    try {
      this.ws = new this.WebSocket(url, ['mqtt']);
    } catch (e) {
      this._error(e);
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
      this._error(e);
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

  _error(reason) {
    if (!this.onError) return;
    const err = reason instanceof Error ? reason : new Error(String(reason || 'MQTT relay error'));
    try { this.onError(err); } catch {}
  }

  // A malformed frame desynchronises the stream, so report it and drop the
  // connection. The normal onclose path performs a clean resubscribe.
  _fail(reason) {
    this.buffer = new Uint8Array(0);
    this._error(reason);
    const ws = this.ws;
    if (ws) { try { ws.close(); } catch {} }
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
    // Packet ids and partial QoS2 state are scoped to one transport epoch.
    this.inflightSubs.clear();
    this.inboundQos2.clear();
    this.buffer = new Uint8Array(0);
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
    if (this.closed) return;
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
        if (i >= buf.length) { this._storePartial(buf, start); return; }
        if (++digits > 4) { this._fail('Malformed MQTT remaining length'); return; }
        b = buf[i++];
        len += (b & 0x7f) * mul;
        mul *= 128;
      } while (b & 0x80);

      if (len > MAX_PACKET_BYTES) { this._fail(`MQTT packet too large (${len} bytes)`); return; }
      if (i + len > buf.length) { this._storePartial(buf, start); return; }

      const body = buf.subarray(i, i + len);
      i += len;

      if (type === 2) {
        // CONNACK: return code in body[1]
        if (body.length >= 2) {
          if (body[1] !== 0) { this._fail(`MQTT CONNACK rejected (${body[1]})`); return; }
          this.connected = true;
          this._startPing();
          // Resubscribe active subscriptions. IDs are allocated fresh for this
          // transport epoch; a previous SUBACK can no longer belong to them.
          this.inflightSubs.clear();
          for (const topic of this.subscriptions.keys()) {
            this._sendSubscribe(topic);
          }
          if (this.onStatus) this.onStatus('connected');
        }
      } else if (type === 3) {
        // PUBLISH
        this._handlePublish(first, body);
      } else if (type === 6) {
        // PUBREL (QoS 2 flow)
        this._handlePubrel(body);
      } else if (type === 9) {
        // SUBACK
        this._handleSuback(body);
      } else if (type === 13) {
        // PINGRESP
      }
    }
    this.buffer = new Uint8Array(0);
  }

  _storePartial(buf, start) {
    if (buf.length - start > MAX_BUFFER_BYTES) {
      this._fail('MQTT partial packet buffer exceeded limit');
      return;
    }
    this.buffer = buf.slice(start);
  }

  _handleSuback(body) {
    if (body.length < 2) return;
    const packetId = (body[0] << 8) | body[1];
    const topic = this.inflightSubs.get(packetId);
    this.inflightSubs.delete(packetId);
    // A return code of 0x80 means the broker rejected the subscription.
    if (topic && body.length >= 3 && body[2] === 0x80) {
      this._error(new Error(`MQTT subscription rejected: ${topic}`));
    }
  }

  _allocPacketId() {
    for (let i = 0; i < 65535; i++) {
      const id = this.nextPacketId;
      this.nextPacketId = this.nextPacketId >= 65535 ? 1 : this.nextPacketId + 1;
      if (id !== 0 && !this.inflightSubs.has(id)) return id;
    }
    return 0;
  }

  _sendSubscribe(topic) {
    const packetId = this._allocPacketId();
    if (!packetId) {
      this._error(new Error('MQTT packet identifier space exhausted'));
      return;
    }
    this.inflightSubs.set(packetId, topic);
    const subBody = [packetId >> 8, packetId & 255, ...mqttStr(topic), 0];
    this._send(mqttPacket(0x82, subBody));
  }

  _handlePublish(first, body) {
    const qos = (first >> 1) & 3;
    if (qos === 3) { this._fail('Invalid MQTT PUBLISH QoS 3'); return; }
    if (body.length < 2) return;
    const topicLen = (body[0] << 8) | body[1];
    let off = 2 + topicLen;
    if (body.length < off) return;
    const topic = decodeUtf8(body.subarray(2, off));

    let packetId = 0;
    if (qos > 0) {
      if (body.length < off + 2) return;
      packetId = (body[off] << 8) | body[off + 1];
      off += 2;
    }
    const payloadBytes = body.subarray(off);

    if (qos === 1) {
      // PUBACK acknowledges receipt without changing the application payload.
      this._send(mqttPacket(0x40, [packetId >> 8, packetId & 255]));
      this._deliver(topic, payloadBytes);
    } else if (qos === 2) {
      // Exactly-once: acknowledge PUBLISH, deliver only when PUBREL arrives.
      this.inboundQos2.set(packetId, { topic, payload: payloadBytes.slice() });
      this._send(mqttPacket(0x50, [packetId >> 8, packetId & 255]));
    } else {
      this._deliver(topic, payloadBytes);
    }
  }

  _handlePubrel(body) {
    if (body.length < 2) return;
    const packetId = (body[0] << 8) | body[1];
    this._send(mqttPacket(0x70, [packetId >> 8, packetId & 255]));
    const msg = this.inboundQos2.get(packetId);
    if (msg) {
      this.inboundQos2.delete(packetId);
      this._deliver(msg.topic, msg.payload);
    }
  }

  _deliver(topic, payloadBytes) {
    for (const [filter, handlers] of this.subscriptions) {
      if (this._matchesTopic(filter, topic)) {
        for (const handler of handlers) {
          try { handler(topic, payloadBytes); } catch {}
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
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    if (this.ws && this.ws.readyState === 1) {
      try { this._send(mqttPacket(0xe0, [])); } catch {}
    }
    this._cleanup();
    this.subscriptions.clear();
  }
}

export { mqttPacket };
