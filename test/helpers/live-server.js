import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { NetClient } from '../../src/net/client.js';

export async function startCombatServer() {
  const child = spawn(process.execPath, ['--import', new URL('../fixtures/combat-arena.js', import.meta.url).href, 'server/server.js'], {
    cwd: new URL('../..', import.meta.url),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', BOTS: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '', requestId = 0;
  child.stderr.on('data', data => { output += data; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Server startup timeout: ${output}`)); }, 10000);
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/Frontline on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
  });
  return {
    url, child,
    fixture(owner, operation, options = {}) {
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        const release = () => { clearTimeout(timer); child.off('message', receive); };
        const receive = message => {
          if (message.type !== 'combat-fixture-result' || message.requestId !== id) return;
          release();
          if (message.error) reject(new Error(message.error)); else resolve(message);
        };
        const timer = setTimeout(() => { release(); reject(new Error(`Fixture ${operation} timed out`)); }, 5000);
        child.on('message', receive);
        child.send({ type: 'combat-fixture', requestId: id, owner, operation, ...options });
      });
    },
    async close() {
      if (child.exitCode !== null) return;
      const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
    },
  };
}

// Use the production decoder/cache; waits are woken by actual protocol traffic.
export function combatPeer(url, options = {}) {
  const net = new NetClient({ WebSocket, url: `${url.replace('http:', 'ws:')}/ws`, mode: 'tdm', room: 'COMBAT', ...options });
  const watchers = new Set();
  const peer = { net, welcome: null, welcomes: 0, states: [], events: [], projectiles: [], errors: [], seq: 0 };
  const notify = () => { for (const watcher of [...watchers]) watcher(); };
  net.onWelcome = message => { peer.welcome = message; peer.welcomes++; notify(); };
  net.onState = state => { peer.states.push(state); if (peer.states.length > 80) peer.states.shift(); notify(); };
  net.onEvents = events => { peer.events.push(...events); notify(); };
  net.onSnapshot = notify;
  net.onProjectiles = message => { peer.projectiles = message.projectiles; notify(); };
  net.onError = error => { peer.errors.push(error); notify(); };
  peer.wait = (predicate, description, milliseconds = 7000) => new Promise((resolve, reject) => {
    const release = () => { clearTimeout(timer); watchers.delete(check); };
    const check = () => {
      if (peer.errors.length) { release(); reject(new Error(peer.errors.join('; '))); }
      else if (predicate(peer)) { release(); resolve(peer); }
    };
    const timer = setTimeout(() => { release(); reject(new Error(`Timed out: ${description}`)); }, milliseconds);
    watchers.add(check); check();
  });
  peer.input = input => net.sendInput({ seq: ++peer.seq, yaw: 0, pitch: 0, ...input });
  peer.connect = async () => {
    const epoch = peer.welcomes;
    net.connect();
    await peer.wait(p => p.welcomes > epoch && net.cache.has(net.playerId), 'welcome and snapshot');
    return peer;
  };
  return peer;
}
