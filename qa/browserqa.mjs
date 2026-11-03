// Browser QA: screenshot, FPS, console errors, offline mode smoke test.
// Run: node qa/browserqa.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const EXE = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
const fsx = fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : '/tmp';
const shotDir = 'qa/shots';
fs.mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--window-size=1280,720'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: shotDir + '/01-lobby.png' });
console.log('lobby shot done');

// start offline training bots
await page.click('#battest');
await page.waitForTimeout(2500);
await page.screenshot({ path: shotDir + '/02-ingame.png' });

// simulate input: hold W, shoot (pointer lock engages on click)
await page.mouse.move(640, 360);
await page.keyboard.down('w');
await page.waitForTimeout(200);
// capture camera right after pointer lock + a couple frames (pre-drift)
await page.screenshot({ path: shotDir + '/00-spawn.png' });
await page.waitForTimeout(1500);
await page.screenshot({ path: shotDir + '/03-shooting.png' });

// debug dump
await page.keyboard.up('w');
await page.screenshot({ path: shotDir + '/03-shooting.png' });

// debug dump: camera + player state
const dbg = await page.evaluate(() => {
  const qa = window.__qa; if (!qa) return { err: 'no qa handle' };
  const out = { cameraPos: qa.camera.position.toArray(), camRot: { x: qa.camera.rotation.x, y: qa.camera.rotation.y, z: qa.camera.rotation.z }, yaw: qa.yaw, pitch: qa.pitch };
  const me = qa.interp.get(qa.myId);
  out.mePos = me ? me.pos : null; out.meTarget = me ? me.target : null;
  if (qa.game) {
    const p = qa.game.players.get(qa.myId);
    out.simPos = p ? p.pos : null;
    out.terrainH = qa.game.world.terrainH(0, 0);
    out.gridN = qa.game.world.gridN;
  }
  return out;
});
console.log('DEBUG-DUMP', JSON.stringify(dbg));

// FPS measure over 5s
const fps = await page.evaluate(() => new Promise(res => {
  let frames = 0; const start = performance.now();
  function tick() { frames++; if (performance.now() - start < 5000) requestAnimationFrame(tick); else res(frames / ((performance.now() - start) / 1000)); }
  requestAnimationFrame(tick);
}));
console.log('FPS (swiftshader, software GL):', fps.toFixed(1));

await page.screenshot({ path: shotDir + '/04-fps.png' });
console.log('console errors:', errors.length ? errors.slice(0, 10) : 'none');
await browser.close();
