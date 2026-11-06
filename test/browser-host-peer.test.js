import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserHost } from '../src/net/host.js';
import { PROTOCOL_VERSION } from '../shared/protocol.js';
import { createFakeBroker, waitFor } from './helpers/fake-relay.js';

function installFakeRtc() {
  const instances = [];
  const previous = globalThis.RTCPeerConnection;

  class FakeDataChannel {
    constructor() {
      this.readyState = 'connecting';
      this.binaryType = null;
      this.listeners = new Map();
      this.closed = false;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    open() {
      this.readyState = 'open';
      for (const fn of this.listeners.get('open') || []) fn();
    }
    close() {
      this.closed = true;
      this.readyState = 'closed';
    }
  }

  class FakePeerConnection {
    constructor() {
      this.closed = false;
      this.connectionState = 'new';
      this.channel = null;
      instances.push(this);
    }
    createDataChannel() {
      this.channel = new FakeDataChannel();
      return this.channel;
    }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'host-offer' }); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
    addIceCandidate() { return Promise.resolve(); }
    close() {
      this.closed = true;
      this.connectionState = 'closed';
    }
  }

  globalThis.RTCPeerConnection = FakePeerConnection;
  return {
    instances,
    restore() {
      if (previous === undefined) delete globalThis.RTCPeerConnection;
      else globalThis.RTCPeerConnection = previous;
    },
  };
}

test('relay fallback is not torn down by a late WebRTC open', async () => {
  const broker = createFakeBroker();
  const rtc = installFakeRtc();
  const relay = new broker.Relay({});
  const host = new BrowserHost({
    room: 'RACE1', mode: 'br', bots: 0, relay, webrtcFallbackMs: 20,
  });

  try {
    host._handlePeerHello({
      type: 'peer_hello', guestId: 'guest-1', room: 'RACE1', protocol: PROTOCOL_VERSION,
    });
    const g = host.peerGuests.get('guest-1');
    assert.ok(g && g.pc, 'WebRTC negotiation started');
    assert.equal(g.relaySocket, null);

    // Let the fallback timer expire and select the relay.
    await waitFor(() => !!g.relaySocket, 500);
    assert.equal(g.opened, false);
    assert.equal(rtc.instances[0].closed, true, 'losing WebRTC attempt was closed');
    assert.equal(host.peerConnections.has('guest-1'), false);
    assert.equal(g.socket, g.relaySocket);

    // The channel open callback may already be queued when the fallback wins.
    // It must not register a second gameplay transport or dispose the guest.
    rtc.instances[0].channel.open();
    assert.equal(g.socket, g.relaySocket, 'relay remains the active transport');
    assert.equal(g.relaySocket.readyState, 1);
    assert.equal(host.peerGuests.get('guest-1'), g, 'guest tracking was preserved');
    assert.equal(host.sockets.has(g.relaySocket), true);
    assert.equal(host.sockets.size, 1, 'no competing socket was registered');
  } finally {
    host.close();
    rtc.restore();
  }
});
