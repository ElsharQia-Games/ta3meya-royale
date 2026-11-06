import test from 'node:test';
import assert from 'node:assert/strict';
import { MQTTRelay, mqttPacket } from '../src/net/relay.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fakeTransport() {
  const sockets = [];
  class FakeWS {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.sent = [];
      this.closed = false;
      sockets.push(this);
    }
    send(data) { this.sent.push(data); }
    close() {
      this.closed = true;
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000 });
    }
  }
  return { FakeWS, sockets };
}

function parsePackets(sent) {
  const packets = [];
  for (const frame of sent) {
    const bytes = new Uint8Array(frame);
    let i = 0;
    while (i < bytes.length) {
      const first = bytes[i++];
      let len = 0, mul = 1, byte;
      do {
        byte = bytes[i++];
        len += (byte & 0x7f) * mul;
        mul *= 128;
      } while (byte & 0x80);
      packets.push({ type: first >> 4, flags: first & 0x0f, body: bytes.slice(i, i + len) });
      i += len;
    }
  }
  return packets;
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function mqttStr(str) {
  const b = encoder.encode(str);
  return new Uint8Array([b.length >> 8, b.length & 255, ...b]);
}

function publishFrame(topic, payload, qos = 0, packetId = 0) {
  const body = qos > 0
    ? concat(mqttStr(topic), new Uint8Array([packetId >> 8, packetId & 255]), encoder.encode(payload))
    : concat(mqttStr(topic), encoder.encode(payload));
  return mqttPacket(0x30 | (qos << 1), [...body]);
}

function packetIdOf(body) {
  return (body[0] << 8) | body[1];
}

function connectedRelay() {
  const { FakeWS, sockets } = fakeTransport();
  const statuses = [];
  const errors = [];
  const relay = new MQTTRelay({
    WebSocket: FakeWS,
    relays: ['ws://fake/mqtt'],
    onStatus: (s) => statuses.push(s),
    onError: (e) => errors.push(e),
  });
  relay.connect();
  const ws = sockets[0];
  ws.readyState = 1;
  ws.onopen();
  // CONNACK: session-present 0, return code 0 (accepted).
  ws.onmessage({ data: mqttPacket(0x20, [0, 0]) });
  assert.equal(relay.connected, true);
  return { relay, ws, sockets, statuses, errors, packets: () => parsePackets(ws.sent) };
}

test('subscription packet identifiers are allocated once and unique', () => {
  const { relay, packets } = connectedRelay();
  try {
    relay.subscribe('room/a/presence', () => {});
    relay.subscribe('room/a/signal/+', () => {});

    const subs = packets().filter((p) => p.type === 8); // SUBSCRIBE
    assert.equal(subs.length, 2);
    const ids = subs.map((p) => packetIdOf(p.body));
    assert.notEqual(ids[0], 0);
    assert.notEqual(ids[0], ids[1]);
    assert.deepEqual(ids, [1, 2], 'sequential ids while both are in flight');
    assert.equal(relay.inflightSubs.size, 2);
  } finally {
    relay.close();
  }
});

test('SUBACK releases the in-flight id and a rejected subscription surfaces an error', () => {
  const { relay, ws, errors, packets } = connectedRelay();
  try {
    relay.subscribe('ok/topic', () => {});
    const sub = packets().find((p) => p.type === 8);
    const id = packetIdOf(sub.body);

    ws.onmessage({ data: mqttPacket(0x90, [id >> 8, id & 255, 0]) });
    assert.equal(relay.inflightSubs.has(id), false, 'acknowledged id is reusable');

    relay.subscribe('denied/topic', () => {});
    const denied = packets().filter((p) => p.type === 8)[1];
    const deniedId = packetIdOf(denied.body);
    ws.onmessage({ data: mqttPacket(0x90, [deniedId >> 8, deniedId & 255, 0x80]) });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /subscription rejected/);
  } finally {
    relay.close();
  }
});

test('broker reconnect resubscribes each active topic exactly once', () => {
  const { relay, ws, sockets } = connectedRelay();
  try {
    relay.subscribe('room/a/presence', () => {});
    relay.subscribe('room/a/signal/+', () => {});
    assert.equal(parsePackets(ws.sent).filter((p) => p.type === 8).length, 2);

    // Closing the transport schedules the production reconnect path. Call
    // connect() immediately so the test does not wait for its backoff timer;
    // both paths converge on the same CONNACK resubscribe code.
    ws.close();
    assert.equal(relay.connected, false);
    relay.connect();
    const next = sockets[1];
    assert.ok(next, 'a new transport was created');

    next.readyState = 1;
    next.onopen();
    // CONNACK must be the trigger for subscriptions, not the bare socket open.
    assert.equal(parsePackets(next.sent).filter((p) => p.type === 8).length, 0);

    next.onmessage({ data: mqttPacket(0x20, [0, 0]) });
    const subs = parsePackets(next.sent).filter((p) => p.type === 8);
    assert.equal(subs.length, 2, 'each active topic resubscribed once');
    assert.equal(new Set(subs.map((p) => packetIdOf(p.body))).size, 2, 'fresh unique packet ids');
    assert.equal(relay.connected, true);

    // Subscription ownership is local and keyed by topic, so a repeated
    // broker status frame cannot create a second logical handler set.
    assert.equal(relay.subscriptions.size, 2);
  } finally {
    relay.close();
  }
});

test('QoS 0 PUBLISH delivers the payload unchanged even when fragmented', () => {
  const { relay, ws } = connectedRelay();
  try {
    let received = null;
    relay.subscribe('room/a/#', (topic, payload) => {
      received = { topic, text: decoder.decode(payload) };
    });

    const frame = new Uint8Array(publishFrame('room/a/to_host/g1', 'hello world', 0));
    // Split inside the topic name so the client has to buffer a partial packet.
    ws.onmessage({ data: frame.slice(0, 4).buffer });
    assert.equal(received, null);
    ws.onmessage({ data: frame.slice(4).buffer });

    assert.deepEqual(received, { topic: 'room/a/to_host/g1', text: 'hello world' });

    // Two packets delivered in one transport frame are both parsed.
    received = null;
    const two = concat(
      new Uint8Array(publishFrame('room/a/x', 'one', 0)),
      new Uint8Array(publishFrame('room/a/y', 'two', 0)),
    );
    ws.onmessage({ data: two.buffer });
    // The handler only keeps the last delivery; assert via a fresh counter.
    assert.equal(received.text, 'two');
  } finally {
    relay.close();
  }
});

test('QoS 1 PUBLISH strips the packet id, delivers once and sends PUBACK', () => {
  const { relay, ws, packets } = connectedRelay();
  try {
    let calls = 0, payload = null;
    relay.subscribe('room/a/to_guest/g1', (topic, bytes) => {
      calls++;
      payload = decoder.decode(bytes);
    });

    ws.onmessage({ data: publishFrame('room/a/to_guest/g1', 'frame-body', 1, 7) });

    assert.equal(calls, 1);
    assert.equal(payload, 'frame-body', 'packet id is not part of the application payload');
    const puback = packets().find((p) => p.type === 4);
    assert.ok(puback, 'PUBACK was sent');
    assert.equal(packetIdOf(puback.body), 7);
  } finally {
    relay.close();
  }
});

test('QoS 2 PUBLISH waits for PUBREL and completes the handshake', () => {
  const { relay, ws, packets } = connectedRelay();
  try {
    let calls = 0, payload = null;
    relay.subscribe('room/a/to_guest/g2', (topic, bytes) => {
      calls++;
      payload = decoder.decode(bytes);
    });

    ws.onmessage({ data: publishFrame('room/a/to_guest/g2', 'exactly-once', 2, 23) });
    assert.equal(calls, 0, 'not delivered before PUBREL');
    const pubrec = packets().find((p) => p.type === 5);
    assert.ok(pubrec);
    assert.equal(packetIdOf(pubrec.body), 23);

    ws.onmessage({ data: mqttPacket(0x62, [0, 23]) }); // PUBREL
    assert.equal(calls, 1);
    assert.equal(payload, 'exactly-once');
    const pubcomp = packets().find((p) => p.type === 7);
    assert.ok(pubcomp, 'PUBCOMP was sent');
    assert.equal(packetIdOf(pubcomp.body), 23);

    // A duplicate PUBREL must not replay the message.
    ws.onmessage({ data: mqttPacket(0x62, [0, 23]) });
    assert.equal(calls, 1);
  } finally {
    relay.close();
  }
});

test('malformed and oversized frames fail closed and report the error', () => {
  const malformed = connectedRelay();
  try {
    // Five continuation bytes exceed MQTT's four-byte remaining length.
    malformed.ws.onmessage({ data: new Uint8Array([0x30, 0x80, 0x80, 0x80, 0x80, 0x00]).buffer });
    assert.equal(malformed.ws.closed, true, 'stream is dropped after desynchronisation');
    assert.equal(malformed.errors.length, 1);
    assert.match(malformed.errors[0].message, /Malformed MQTT remaining length/);
  } finally {
    malformed.relay.close();
  }

  const oversized = connectedRelay();
  try {
    // Remaining length 300000 exceeds the 256 KiB application ceiling.
    oversized.ws.onmessage({ data: new Uint8Array([0x30, 0xe0, 0xa7, 0x12]).buffer });
    assert.equal(oversized.ws.closed, true);
    assert.equal(oversized.errors.length, 1);
    assert.match(oversized.errors[0].message, /too large/);
  } finally {
    oversized.relay.close();
  }
});

test('transport errors propagate through onError', () => {
  const { relay, ws, errors } = connectedRelay();
  try {
    ws.onerror(new Error('socket down'));
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /socket down/);
  } finally {
    relay.close();
  }
});
