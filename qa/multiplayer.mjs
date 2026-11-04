// Two-client online smoke test: roster, remote replication, movement, chat,
// reconnect and bandwidth. Requires a server on :3000.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const base = process.env.HOME + '/.cache/ms-playwright';
let exe;
for (const d of fs.readdirSync(base)) if (d.startsWith('chromium')) for (const r of ['chrome-linux/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) { const p = base + '/' + d + '/' + r; if (fs.existsSync(p)) exe = p; }

const ROOM = 'QA' + Math.floor(Math.random() * 9000 + 1000);
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
const mk = async (name) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(name + ': ' + (e.stack || e)));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
  await p.goto('http://127.0.0.1:3000/');
  await p.fill('#in-name', name);
  await p.fill('#in-room', ROOM);
  await p.click('#join');
  await p.waitForFunction(() => window.__frontline?.active === true, null, { timeout: 45000 });
  return p;
};

const A = await mk('Alpha');
await A.waitForTimeout(800);
const B = await mk('Bravo');
await A.waitForTimeout(2500);
await B.waitForTimeout(1200);

const dump = (p) => p.evaluate(() => {
  const a = window.__frontline;
  const lp = a.getLocalPlayer();
  return {
    id: a.localId,
    mode: a.mode,
    roster: a.roster.map(r => ({ id: r.id, name: r.name, team: r.team, alive: r.alive })),
    remoteViews: [...a.characters.keys()],
    local: lp && { x: +lp.x.toFixed(2), z: +lp.z.toFixed(2), hp: lp.hp, alive: lp.alive },
    snapshots: a.net?.snapshotCount,
    bytesPerSec: Math.round(a.net?.bytesPerSec || 0),
    rtt: Math.round(a.net?.rtt || 0),
    buffer: a.net?.buffer?.frames?.length,
    matchState: a.state?.matchState,
  };
});

const a0 = await dump(A);
console.log('A after join:', JSON.stringify(a0));
console.log('B after join:', JSON.stringify(await dump(B)));

// Move B forward for 2 s; A must observe the change through interpolation.
const bStart = await B.evaluate(() => { const l = window.__frontline.getLocalPlayer(); return [l.x, l.z]; });
await B.keyboard.down('w');
await B.waitForTimeout(2000);
await B.keyboard.up('w');
await B.waitForTimeout(600);
const bEnd = await B.evaluate(() => { const l = window.__frontline.getLocalPlayer(); return [l.x, l.z]; });
const aSeesB = await A.evaluate((id) => {
  const a = window.__frontline;
  const p = a.net.cache.get(id);
  return p ? { x: +p.x.toFixed(2), z: +p.z.toFixed(2) } : null;
}, (await dump(B)).id);
console.log('B moved', bStart.map(v => +v.toFixed(2)), '->', bEnd.map(v => +v.toFixed(2)));
console.log('A sees B at', aSeesB);

// Chat round trip.
await B.evaluate(() => window.__frontline.net.sendChat('hello from bravo'));
await A.waitForTimeout(700);
const chat = await A.evaluate(() => [...document.querySelectorAll('.chat-row')].map(e => e.textContent));
console.log('A chat rows:', chat);

// Reconnect: kill B's socket, the client should rejoin with its token.
const bId = (await dump(B)).id;
await B.evaluate(() => { window.__frontline.net.ws.close(); });
await B.waitForTimeout(4500);
const bRe = await dump(B);
console.log('B reconnect id', bId, '->', bRe.id, 'status ok:', bRe.id === bId && bRe.mode === 'online');

// Bandwidth after a few seconds of steady state.
await A.waitForTimeout(3000);
console.log('A steady:', JSON.stringify(await dump(A)));
await A.screenshot({ path: 'qa/shots/mp-alpha.png' });
await B.screenshot({ path: 'qa/shots/mp-bravo.png' });
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');

await browser.close();
if (errors.length) process.exitCode = 1;
