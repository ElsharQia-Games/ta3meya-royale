import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '../shared/protocol.js';

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
  good.send(JSON.stringify({ type: 'join', room: 'VERSION', name: 'Current', protocol: PROTOCOL_VERSION }));
  const message = await accepted;
  assert.equal(message.protocol, PROTOCOL_VERSION);
  assert.ok(message.playerId > 0);
});
