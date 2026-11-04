import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, MSG, decodeSnapshot, applySnapshot } from '../shared/protocol.js';

test('server rejects incompatible joins before room allocation and accepts the current protocol', { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', BOTS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    await closed;
  });
  const url = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', data => {
      text += data.toString();
      const match = text.match(/Frontline on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) resolve(match[1]);
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`server exited ${code}: ${text}`)));
  });
  const bad = new WebSocket(`${url.replace('http:', 'ws:')}/ws`);
  sockets.push(bad);
  await once(bad, 'open');
  const rejected = once(bad, 'close');
  bad.send(JSON.stringify({ type: 'join', room: 'VERSION', name: 'Old', protocol: PROTOCOL_VERSION - 1 }));
  const [code, reason] = await rejected;
  assert.equal(code, 4003);
  assert.match(reason.toString(), /protocol/i);
  const stats = await (await fetch(`${url}/stats`)).json();
  assert.equal(stats.rooms.length, 0);

  const good = new WebSocket(`${url.replace('http:', 'ws:')}/ws`);
  sockets.push(good);
  await once(good, 'open');
  const accepted = new Promise(resolve => good.on('message', (data, binary) => {
    if (!binary) { const m = JSON.parse(data.toString()); if (m.type === 'welcome') resolve(m); }
  }));
  good.send(JSON.stringify({ type: 'join', room: 'VERSION', name: 'Current', mode: 'tdm', kit: 'heavy',
    weapons: ['sniper', 'sniper'], protocol: PROTOCOL_VERSION }));
  const message = await accepted;
  assert.equal(message.protocol, PROTOCOL_VERSION);
  assert.ok(message.playerId > 0);
  assert.equal(message.kit, 'heavy');
  assert.deepEqual(message.weapons, ['lmg', 'rpg'], 'server chooses the validated kit, never a client-supplied inventory');
});

test('active socket replacement and long-lived reconnect retain the player and input ownership', { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, ['--import', new URL('./fixtures/server-clock.js', import.meta.url).href, 'server/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', BOTS: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
  });
  const url = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', data => { text += data; const m = text.match(/Frontline on (http:\/\/127\.0\.0\.1:\d+)/); if (m) resolve(m[1]); });
    child.once('error', reject); child.once('exit', code => reject(new Error(`server exit ${code}`)));
  });
  const connect = async token => {
    const ws = new WebSocket(`${url.replace('http:', 'ws:')}/ws`); ws.binaryType = 'arraybuffer'; sockets.push(ws);
    const cache = new Map(); let welcome;
    const ready = new Promise(resolve => ws.on('message', (data, binary) => {
      if (!binary) { const m = JSON.parse(data.toString()); if (m.type === 'welcome') welcome = m; return; }
      const buffer = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      if (new DataView(buffer).getUint8(0) !== MSG.SNAPSHOT) return;
      applySnapshot(cache, decodeSnapshot(buffer));
      if (welcome) resolve({ ws, welcome, cache });
    }));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'join', name: 'Reconnect', room: 'AGE', mode: 'br', protocol: PROTOCOL_VERSION, token }));
    return ready;
  };
  const first = await connect();
  const firstClosed = once(first.ws, 'close');
  const replacement = await connect(first.welcome.token); await firstClosed;
  assert.equal(replacement.welcome.playerId, first.welcome.playerId);
  // Let a fresh snapshot reflect the old socket's asynchronous close callback.
  await once(replacement.ws, 'message');
  assert.equal(replacement.cache.get(first.welcome.playerId).connected, true, 'old socket close must not disconnect its replacement');
  const advanced = once(child, 'message'); child.send({ type: 'advance-clock', milliseconds: 90_000 }); await advanced;
  const replacementClosed = once(replacement.ws, 'close'); replacement.ws.close(); await replacementClosed;
  const rejoined = await connect(replacement.welcome.token);
  assert.equal(rejoined.welcome.playerId, first.welcome.playerId, 'active sessions must not expire one minute after join');
});
