import test from 'node:test';
import assert from 'node:assert/strict';
import { joinPeerSession } from '../src/net/peer.js';
import {
  electCandidate, isHostAnnouncementNewer, isUsableHostAnnouncement,
} from '../src/net/election.js';
import { PROTOCOL_VERSION } from '../shared/protocol.js';
import { createFakeBroker, waitFor } from './helpers/fake-relay.js';

const FAST = {
  probeMs: 60,
  announceMs: 10,
  hostRetryMs: 20,
  reElectionMs: 250,
};

function sessionOpts(broker, over = {}) {
  return {
    mode: 'tdm',
    relayFactory: (opts) => new broker.Relay(opts),
    ...FAST,
    ...over,
  };
}

test('election helpers pick a stable winner and reject stale announcements', () => {
  assert.equal(electCandidate(['b', 'a'], 'c'), 'a');
  assert.equal(electCandidate([], 'solo'), 'solo');
  assert.equal(electCandidate([], ''), null);
  assert.equal(electCandidate(['b'], 'a'), 'a');
  assert.equal(electCandidate(['a', 'a', null, 3], 'b'), 'a');

  assert.equal(isHostAnnouncementNewer({ hostId: 'h' }, null), true);
  assert.equal(isHostAnnouncementNewer({ hostId: '' }, null), false);
  assert.equal(isHostAnnouncementNewer({ hostId: 'h', startedAt: 10 }, { hostId: 'g', startedAt: 5 }), true);
  assert.equal(isHostAnnouncementNewer({ hostId: 'h', startedAt: 5 }, { hostId: 'g', startedAt: 10 }), false);
  // Equal start time falls back to the stable host id, not arrival order.
  assert.equal(isHostAnnouncementNewer({ hostId: 'a', startedAt: 10 }, { hostId: 'b', startedAt: 10 }), true);
  assert.equal(isHostAnnouncementNewer({ hostId: 'b', startedAt: 10 }, { hostId: 'a', startedAt: 10 }), false);
  // A duplicated heartbeat from the current session is still usable.
  assert.equal(isHostAnnouncementNewer(
    { hostId: 'a', sessionId: 's', startedAt: 10 },
    { hostId: 'a', sessionId: 's', startedAt: 10 },
  ), true);

  assert.equal(isUsableHostAnnouncement(
    { type: 'host_present', room: 'R', protocol: PROTOCOL_VERSION }, 'R', PROTOCOL_VERSION,
  ), true);
  assert.equal(isUsableHostAnnouncement(
    { type: 'host_present', room: 'R' }, 'R', PROTOCOL_VERSION,
  ), true, 'missing protocol is tolerated for old announcements');
  assert.equal(isUsableHostAnnouncement(
    { type: 'host_present', room: 'R', protocol: PROTOCOL_VERSION - 1 }, 'R', PROTOCOL_VERSION,
  ), false);
  assert.equal(isUsableHostAnnouncement(
    { type: 'candidate', room: 'R', protocol: PROTOCOL_VERSION }, 'R', PROTOCOL_VERSION,
  ), false);
});

test('two simultaneous joiners converge on exactly one host and one guest', async () => {
  const broker = createFakeBroker();
  const room = 'ELEC2';
  const sessions = await Promise.all([
    joinPeerSession(sessionOpts(broker, { name: 'Alpha', room })),
    joinPeerSession(sessionOpts(broker, { name: 'Bravo', room })),
  ]);

  try {
    const hosts = sessions.filter((s) => s.host);
    const guests = sessions.filter((s) => !s.host);
    assert.equal(hosts.length, 1, 'exactly one authoritative host');
    assert.equal(guests.length, 1, 'the other candidate joins as a guest');

    const hostSession = hosts[0];
    const guestSession = guests[0];
    const host = hostSession.host;

    assert.equal(hostSession.hostInfo.self, true);
    assert.equal(host.hostId, hostSession.nodeId);
    assert.equal(guestSession.hostInfo.self, false);
    assert.equal(guestSession.hostInfo.hostId, host.hostId);
    assert.equal(guestSession.hostInfo.sessionId, host.sessionId);
    // Only the host owns an authoritative simulation.
    assert.equal(hostSession.net.allowReconnect, false);
    assert.equal(guestSession.net.allowReconnect, false);

    // The elected host remains the same object across transport status
    // callbacks; a reconnect must not start a second election or host.
    const subscriptions = broker.activeSubscriptions();
    for (let i = 0; i < 3; i++) hostSession.relay.onStatus('connected');
    guestSession.relay.onStatus('connected');
    await waitFor(() => hostSession.host === host, 500);
    assert.equal(hostSession.host, host);
    assert.equal(broker.activeSubscriptions(), subscriptions, 'reconnect did not duplicate subscriptions');

    // Prove the guest can actually join the elected host's room.
    let hostWelcome = false;
    let guestWelcome = false;
    hostSession.net.onWelcome = () => { hostWelcome = true; };
    guestSession.net.onWelcome = () => { guestWelcome = true; };
    hostSession.net.connect();
    guestSession.net.connect();
    await waitFor(() => hostWelcome && guestWelcome, 2000);
    const playerCount = host.game.players.size;
    const names = [...host.game.players.values()].map((p) => p.name);
    assert.ok(names.includes('Alpha'), 'host player is in the room');
    assert.ok(names.includes('Bravo'), 'guest player is in the room');
    assert.ok(playerCount >= 2);
    assert.equal(host.peerGuests.size, 1, 'one logical peer session');

    // A retransmitted hello from the connected guest is ignored rather than
    // creating a second negotiation or player.
    const subscriptionsAfterJoin = broker.activeSubscriptions();
    guestSession.relay.publish(`ta3meya/${room}/join`, {
      type: 'peer_hello',
      guestId: guestSession.nodeId,
      room,
      protocol: PROTOCOL_VERSION,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(host.game.players.size, playerCount);
    assert.equal(host.peerGuests.size, 1);
    assert.equal(broker.activeSubscriptions(), subscriptionsAfterJoin);
  } finally {
    for (const session of sessions) session.close();
  }
});

test('repeated transport-connected callbacks do not rebuild the host or its subscriptions', async () => {
  const broker = createFakeBroker();
  const session = await joinPeerSession(sessionOpts(broker, {
    room: 'ELEC3', name: 'Solo', isHost: false,
  }));

  try {
    assert.ok(session.host, 'single candidate becomes host');
    const host = session.host;
    const subscriptions = broker.activeSubscriptions();
    const nodeId = session.nodeId;

    for (let i = 0; i < 5; i++) session.relay.onStatus('connected');
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(session.host, host);
    assert.equal(host.hostId, nodeId);
    assert.equal(broker.activeSubscriptions(), subscriptions);
    assert.equal(session.hostInfo.sessionId, host.sessionId);
  } finally {
    session.close();
  }
});

test('connected relay guest terminates when the host announces offline', async () => {
  const broker = createFakeBroker();
  const room = 'ELEC5';
  const sessions = await Promise.all([
    joinPeerSession(sessionOpts(broker, { name: 'HostOne', room })),
    joinPeerSession(sessionOpts(broker, { name: 'GuestOne', room })),
  ]);

  const hostSession = sessions.find((s) => s.host);
  const guestSession = sessions.find((s) => !s.host);
  assert.ok(hostSession && guestSession);

  try {
    let hostWelcome = false;
    let guestWelcome = false;
    hostSession.net.onWelcome = () => { hostWelcome = true; };
    guestSession.net.onWelcome = () => { guestWelcome = true; };
    hostSession.net.connect();
    guestSession.net.connect();
    await waitFor(() => hostWelcome && guestWelcome, 2000);

    const statuses = [];
    const errors = [];
    guestSession.net.onStatus = (s) => statuses.push(s);
    guestSession.net.onError = (e) => errors.push(e);

    // A shutdown claim must match both the pinned host and its session. A
    // stale or spoofed presence message must not tear down a live guest.
    hostSession.relay.publish(`ta3meya/${room}/presence`, {
      type: 'host_offline',
      hostId: hostSession.host.hostId,
      sessionId: 'stale-session',
      room,
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(guestSession.net.closed, false, 'stale session host_offline ignored');
    assert.equal(guestSession.net.joined, true);

    // Public host/session ids are not authentication. A third party can copy
    // them, so an unsigned or bad-signature shutdown must be ignored once the
    // host announced its session key.
    assert.ok(hostSession.host.hostPublicKey, 'host advertised a session key');
    hostSession.relay.publish(`ta3meya/${room}/presence`, {
      type: 'host_offline',
      hostId: hostSession.host.hostId,
      sessionId: hostSession.host.sessionId,
      startedAt: hostSession.host.startedAt,
      room,
    });
    hostSession.relay.publish(`ta3meya/${room}/presence`, {
      type: 'host_offline',
      hostId: hostSession.host.hostId,
      sessionId: hostSession.host.sessionId,
      startedAt: hostSession.host.startedAt,
      signature: 'Zm9yZ2Vk',
      room,
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(guestSession.net.closed, false, 'unsigned/forged host_offline ignored');

    // The relay socket has no close signal, so a correctly signed host_offline
    // is the graceful shutdown notification a relayed guest can observe.
    hostSession.close();
    await waitFor(() => guestSession.net.closed, 1000);

    assert.equal(guestSession.net.connected, false);
    assert.equal(guestSession.net.joined, false);
    assert.equal(guestSession.host, null, 'guest never promotes itself on host loss');
    assert.ok(statuses.includes('disconnected') || statuses.includes('error'));
    assert.ok(errors.some((e) => /host closed/i.test(e)), 'failure is surfaced to the caller');
  } finally {
    for (const session of sessions) session.close();
  }
});

test('relay guest leave removes the player and negotiation so it can rejoin', async () => {
  const broker = createFakeBroker();
  const room = 'LEAVE1';
  const hostSession = await joinPeerSession(sessionOpts(broker, {
    name: 'HostLeave', room, isHost: true,
  }));
  const host = hostSession.host;
  const guestSession = await joinPeerSession(sessionOpts(broker, { name: 'GuestLeave', room }));

  try {
    let welcomed = false;
    guestSession.net.onWelcome = () => { welcomed = true; };
    guestSession.net.connect();
    await waitFor(() => welcomed, 2000);
    assert.ok([...host.game.players.values()].some((p) => p.name === 'GuestLeave'));
    assert.equal(host.peerGuests.size, 1);

    // Graceful leave publishes a control frame before the relay socket closes.
    guestSession.close();
    await waitFor(
      () => ![...host.game.players.values()].some((p) => p.name === 'GuestLeave'),
      1000,
    );
    assert.equal(host.peerGuests.size, 0, 'guest negotiation disposed on leave');
    assert.equal(host.clients.size, 0, 'no ghost client remains');
    // The host's own local-client socket remains; no relay guest socket may.
    assert.equal([...host.sockets].filter((s) => s.guestId).length, 0, 'host relay socket was released');

    // The same identity must be able to join again; a stale peerGuests entry
    // would make the host reject its hello forever.
    const rejoin = await joinPeerSession(sessionOpts(broker, { name: 'GuestAgain', room }));
    try {
      let rejoined = false;
      rejoin.net.onWelcome = () => { rejoined = true; };
      rejoin.net.connect();
      await waitFor(() => rejoined, 2000);
      assert.ok([...host.game.players.values()].some((p) => p.name === 'GuestAgain'));
      assert.equal(host.peerGuests.size, 1);
    } finally {
      rejoin.close();
    }
  } finally {
    hostSession.close();
    guestSession.close();
  }
});

test('relay guest watchdog removes an abruptly disconnected player', async () => {
  const broker = createFakeBroker();
  const room = 'DROP1';
  const hostSession = await joinPeerSession(sessionOpts(broker, {
    name: 'HostDrop', room, isHost: true, guestTimeoutMs: 200, guestSweepMs: 20,
  }));
  const host = hostSession.host;
  const guestSession = await joinPeerSession(sessionOpts(broker, { name: 'GuestDrop', room }));

  try {
    let welcomed = false;
    guestSession.net.onWelcome = () => { welcomed = true; };
    guestSession.net.connect();
    await waitFor(() => welcomed, 2000);
    assert.equal(host.peerGuests.size, 1);
    assert.ok([...host.game.players.values()].some((p) => p.name === 'GuestDrop'));

    // Abrupt loss: no leave frame is sent and a RelaySocket has no close event.
    // Only the host-side last-seen watchdog can notice the silent peer.
    guestSession.net._stopPing();
    guestSession.relay.close();
    await waitFor(
      () => ![...host.game.players.values()].some((p) => p.name === 'GuestDrop'),
      3000,
    );
    assert.equal(host.peerGuests.size, 0, 'stale negotiation was disposed');
    assert.equal(host.clients.size, 0, 'stale player and socket were removed');
  } finally {
    hostSession.close();
    guestSession.close();
  }
});

test('session.close releases relay subscriptions, timers and transport exactly once', async () => {
  const broker = createFakeBroker();
  const session = await joinPeerSession(sessionOpts(broker, {
    room: 'ELEC4', name: 'Solo', isHost: true,
  }));

  const host = session.host;
  assert.ok(host);
  assert.ok(broker.activeSubscriptions() > 0);

  session.close();
  assert.equal(broker.activeSubscriptions(), 0, 'every subscription was released');
  assert.equal(host.closed, true);
  assert.equal(session.relay.closed, true);

  // Idempotent close must not throw or double-publish.
  assert.doesNotThrow(() => session.close());
  assert.doesNotThrow(() => host.close());
});

function silentRelay() {
  return {
    closed: false,
    connected: false,
    onStatus: null,
    onError: null,
    connect() {},
    subscribe() { return () => {}; },
    publish() { return true; },
    close() { this.closed = true; },
  };
}

test('pending peer join can be cancelled and releases its relay', async () => {
  const relay = silentRelay();
  const controller = new AbortController();
  const pending = joinPeerSession({
    room: 'CANCEL',
    relayFactory: () => relay,
    signal: controller.signal,
    connectTimeoutMs: 5000,
  });
  controller.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
  assert.equal(relay.closed, true, 'cancelled attempt released the relay');
});

test('unreachable broker rejects instead of hanging the lobby forever', async () => {
  const relay = silentRelay();
  const pending = joinPeerSession({
    room: 'TIMEOUT',
    relayFactory: () => relay,
    connectTimeoutMs: 20,
  });
  await assert.rejects(pending, /Timed out connecting/);
  assert.equal(relay.closed, true, 'failed attempt released the relay');
});

function installFakeRtc() {
  const instances = [];
  const previous = globalThis.RTCPeerConnection;
  class FakeDataChannel {
    constructor() {
      this.readyState = 'connecting';
      this.binaryType = null;
      this.listeners = new Map();
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
  }
  class FakePeerConnection {
    constructor() {
      this.closed = false;
      this.connectionState = 'new';
      this.remoteSdp = null;
      instances.push(this);
    }
    createDataChannel() { this.channel = new FakeDataChannel(); return this.channel; }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'guest-offer' }); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'guest-answer' }); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription(desc) { this.remoteSdp = desc.sdp; return Promise.resolve(); }
    addIceCandidate() { return Promise.resolve(); }
    close() { this.closed = true; this.connectionState = 'closed'; }
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

test('relay fallback disposes the guest WebRTC attempt and ignores a late DataChannel open', async () => {
  const broker = createFakeBroker();
  const rtc = installFakeRtc();
  const room = 'FALLBACK';
  const publisher = new broker.Relay({});
  const pending = joinPeerSession(sessionOpts(broker, { room, probeMs: 2000 }));
  let session = null;

  try {
    let signalTopic = null;
    await waitFor(() => {
      signalTopic = broker.subscriptionFilters().find((t) => t.startsWith(`ta3meya/${room}/signal/`));
      return !!signalTopic;
    }, 500);

    publisher.publish(`ta3meya/${room}/presence`, {
      type: 'host_present', hostId: 'h-fallback', sessionId: 's-fallback', room,
      mode: 'tdm', startedAt: 20, protocol: PROTOCOL_VERSION,
    });
    await waitFor(() => !!signalTopic, 500);

    publisher.publish(signalTopic, {
      type: 'offer', sdp: 'slow-p2p', hostId: 'h-fallback', sessionId: 's-fallback', room, mode: 'tdm',
    });
    await waitFor(() => rtc.instances.length === 1, 500);
    const pc = rtc.instances[0];
    assert.equal(pc.closed, false);

    // The remote DataChannel exists but has not opened yet. The host's fallback
    // timer then selects MQTT; the guest must abandon this WebRTC attempt.
    const channel = {
      readyState: 'connecting',
      closed: false,
      listeners: new Map(),
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      },
      close() { this.closed = true; this.readyState = 'closed'; },
    };
    pc.ondatachannel({ channel });

    publisher.publish(signalTopic, {
      type: 'peer_ready', guestId: 'g', hostId: 'h-fallback', sessionId: 's-fallback', room, mode: 'tdm',
    });
    session = await pending;
    session.net.connect();
    const relaySocket = session.net.ws;

    assert.equal(pc.closed, true, 'guest closed the losing WebRTC connection');
    assert.equal(session.host, null, 'relay fallback is a guest session');

    // An open event queued before the fallback decision must not register a
    // competing transport or displace the relay socket.
    channel.readyState = 'open';
    for (const fn of channel.listeners.get('open') || []) fn();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(channel.closed, true, 'late DataChannel was closed');
    assert.equal(session.net.ws, relaySocket, 'relay remains the active transport');
  } finally {
    if (session) session.close();
    else await pending.catch(() => {});
    rtc.restore();
  }
});

test('guest validates signaling identity and late signals cannot resurrect a closed session', async () => {
  const broker = createFakeBroker();
  const rtc = installFakeRtc();
  const room = 'IDENT';
  const publisher = new broker.Relay({});
  const controller = new AbortController();
  const pending = joinPeerSession(sessionOpts(broker, {
    room, signal: controller.signal, probeMs: 2000,
  }));
  let session = null;

  try {
    let signalTopic = null;
    await waitFor(() => {
      signalTopic = broker.subscriptionFilters().find((t) => t.startsWith(`ta3meya/${room}/signal/`));
      return !!signalTopic;
    }, 500);

    // No presence/election result exists yet. An identity-bearing signal must
    // not be able to pin itself as the host and start negotiation.
    publisher.publish(signalTopic, {
      type: 'peer_ready', guestId: 'g', hostId: 'h-early', sessionId: 's-early', room, mode: 'tdm',
    });
    publisher.publish(signalTopic, {
      type: 'offer', sdp: 'early', hostId: 'h-early', sessionId: 's-early', room,
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(rtc.instances.length, 0, 'pre-presence signal cannot pin a host');
    const afterEarly = await Promise.race([
      pending.then(() => 'resolved', () => 'rejected'),
      new Promise((r) => setTimeout(() => r('pending'), 10)),
    ]);
    assert.equal(afterEarly, 'pending', 'pre-presence peer_ready ignored');

    publisher.publish(`ta3meya/${room}/presence`, {
      type: 'host_present', hostId: 'h-real', sessionId: 's-real', room,
      mode: 'tdm', startedAt: 10, protocol: PROTOCOL_VERSION,
    });
    await new Promise((r) => setTimeout(r, 30));

    // A wrong host/session must not resolve the join or start negotiation.
    publisher.publish(signalTopic, {
      type: 'peer_ready', guestId: 'g', hostId: 'h-evil', sessionId: 's-evil', room, mode: 'tdm',
    });
    publisher.publish(signalTopic, {
      type: 'offer', sdp: 'spoof', hostId: 'h-evil', sessionId: 's-evil', room,
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(rtc.instances.length, 0, 'spoofed offer ignored');
    const afterSpoof = await Promise.race([
      pending.then(() => 'resolved', () => 'rejected'),
      new Promise((r) => setTimeout(() => r('pending'), 10)),
    ]);
    assert.equal(afterSpoof, 'pending', 'spoofed peer_ready ignored');

    // The announced host is accepted normally.
    publisher.publish(signalTopic, {
      type: 'offer', sdp: 'real', hostId: 'h-real', sessionId: 's-real', room, mode: 'tdm',
    });
    await waitFor(() => rtc.instances.length === 1, 500);
    assert.equal(rtc.instances[0].remoteSdp, 'real');

    publisher.publish(signalTopic, {
      type: 'peer_ready', guestId: 'g', hostId: 'h-real', sessionId: 's-real', room, mode: 'tdm',
    });
    session = await pending;
    assert.equal(session.hostInfo.hostId, 'h-real');
    assert.equal(session.hostInfo.sessionId, 's-real');
    assert.ok(session.net);

    session.close();
    const before = rtc.instances.length;
    publisher.publish(signalTopic, {
      type: 'offer', sdp: 'late', hostId: 'h-real', sessionId: 's-real', room,
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(rtc.instances.length, before, 'late signal did not recreate negotiation');
  } finally {
    if (session) session.close();
    else { controller.abort(); await pending.catch(() => {}); }
    rtc.restore();
  }
});
