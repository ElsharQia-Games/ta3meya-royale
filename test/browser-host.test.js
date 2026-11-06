import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserHost } from '../src/net/host.js';
import { NetClient } from '../src/net/client.js';
import { PROTOCOL_VERSION } from '../shared/protocol.js';

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

test('BrowserHost initializes local client and runs simulation ticks', async () => {
  const host = new BrowserHost({ room: 'HOST01', mode: 'tdm', bots: 2 });
  assert.equal(host.mode, 'tdm');
  assert.equal(host.code, 'HOST01');

  const clientSocket = host.createLocalClient('HostLeader', 'assault');

  let welcomed = false;
  let welcomeMsg = null;
  let rosterMsg = null;
  let snapshotCount = 0;

  const client = new NetClient({
    name: 'HostLeader',
    room: 'HOST01',
    mode: 'tdm',
    kit: 'assault',
    WebSocket: class {
      constructor() { return clientSocket; }
    },
  });

  client.onWelcome = (msg) => {
    welcomed = true;
    welcomeMsg = msg;
  };
  client.onRoster = (msg) => {
    rosterMsg = msg;
  };
  client.onSnapshot = () => {
    snapshotCount++;
  };

  client.connect();

  // Wait a microtask for local socket open and join
  await wait(50);

  assert.ok(welcomed, 'Client received welcome');
  assert.equal(welcomeMsg.mode, 'tdm');
  assert.equal(welcomeMsg.room, 'HOST01');
  assert.ok(rosterMsg, 'Client received roster');

  // Step host for 10 frames
  for (let i = 0; i < 10; i++) {
    client.sendInput({
      seq: i + 1,
      yaw: 0,
      pitch: 0,
      f: true,
      b: false,
      l: false,
      r: false,
    });
    host.step(1 / 60);
    await wait(2);
  }

  assert.ok(snapshotCount > 0, 'Client received snapshots from in-browser host');

  host.close();
  client.disconnect();
});

test('BrowserHost balances teams and relays second player join', async () => {
  const host = new BrowserHost({ room: 'TEAM01', mode: 'tdm', bots: 0 });

  const client1Socket = host.createLocalClient('Alpha', 'assault');
  const client1 = new NetClient({
    name: 'Alpha',
    room: 'TEAM01',
    mode: 'tdm',
    WebSocket: class { constructor() { return client1Socket; } },
  });

  let p1Rosters = [];
  client1.onRoster = (r) => p1Rosters.push(r);
  client1.connect();
  await wait(40);

  // Connect second client via createLocalPair
  const { clientSocket: c2Client, serverSocket: c2Server } = (await import('../src/net/peer.js')).createLocalPair();
  host.addClient(c2Server, {
    type: 'join',
    name: 'Bravo',
    room: 'TEAM01',
    mode: 'tdm',
    kit: 'recon',
    protocol: PROTOCOL_VERSION,
  });

  const client2 = new NetClient({
    name: 'Bravo',
    room: 'TEAM01',
    mode: 'tdm',
    WebSocket: class { constructor() { return c2Client; } },
  });

  let p2Welcomed = false;
  let p2Team = null;
  client2.onWelcome = (msg) => {
    p2Welcomed = true;
  };
  client2.onRoster = (msg) => {
    const me = msg.players.find(p => p.name === 'Bravo');
    if (me) p2Team = me.team;
  };
  client2.connect();
  await wait(50);

  assert.ok(p2Welcomed, 'Player 2 welcomed');
  const p1 = host.game.players.get(client1.playerId);
  const p2 = host.game.players.get(client2.playerId);

  assert.notEqual(p1.team, p2.team, 'Players assigned to opposing teams in TDM');

  host.close();
  client1.disconnect();
  client2.disconnect();
});

test('joinPeerSession connects host and guest over relay', async () => {
  const { WebSocket } = await import('ws');
  const { joinPeerSession } = await import('../src/net/peer.js');

  const testRoom = 'R' + Math.random().toString(36).slice(2, 7).toUpperCase();

  // 1. Player 1 hosts
  const hostSession = await joinPeerSession({
    name: 'P1Leader',
    room: testRoom,
    mode: 'tdm',
    isHost: true,
    WebSocket,
  });

  assert.ok(hostSession.host, 'Host created');
  assert.ok(hostSession.net, 'Host net created');

  let hostWelcomed = false;
  hostSession.net.onWelcome = () => { hostWelcomed = true; };
  hostSession.net.connect();
  await wait(80);
  assert.ok(hostWelcomed, 'Host player welcomed');

  // Step host so heartbeat and simulation run
  const ticker = setInterval(() => {
    hostSession.host.step(1 / 60);
  }, 16);

  // 2. Player 2 joins as guest
  const guestSession = await joinPeerSession({
    name: 'P2Friend',
    room: testRoom,
    mode: 'tdm',
    isHost: false,
    WebSocket,
  });

  assert.ok(guestSession.net, 'Guest net created');

  let guestWelcomed = false;
  let guestRoster = null;
  guestSession.net.onWelcome = () => { guestWelcomed = true; };
  guestSession.net.onRoster = (r) => { guestRoster = r; };

  guestSession.net.connect();

  for (let i = 0; i < 25; i++) {
    if (guestWelcomed && guestRoster && guestRoster.players.length >= 2) break;
    await wait(100);
  }

  clearInterval(ticker);
  hostSession.host.close();
  hostSession.net.disconnect();
  hostSession.relay.close();
  guestSession.net.disconnect();
  guestSession.relay.close();

  assert.ok(guestWelcomed, 'Guest welcomed by host');
  assert.ok(guestRoster.players.some(p => p.name === 'P1Leader'), 'Roster includes host');
  assert.ok(guestRoster.players.some(p => p.name === 'P2Friend'), 'Roster includes guest');
});
