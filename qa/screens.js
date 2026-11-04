// Browser QA for the current Frontline client.
//
//   node qa/screens.js            # online mode against a server on :3000
//   node qa/screens.js --offline  # offline training mode (no server needed)
//
// Captures screenshots into qa/shots/, reports console errors and measured
// renderer FPS. Software GL (SwiftShader) numbers are labelled as such; they
// are not representative of GPU performance.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const OFFLINE = process.argv.includes('--offline');
const BASE = process.env.QA_URL || 'http://127.0.0.1:3000/';
const OUT = path.resolve('qa/shots');
fs.mkdirSync(OUT, { recursive: true });

function findChromium() {
  const base = path.join(process.env.HOME, '.cache/ms-playwright');
  if (!fs.existsSync(base)) throw new Error('no playwright browsers in ~/.cache/ms-playwright');
  for (const dir of fs.readdirSync(base)) {
    if (!dir.startsWith('chromium')) continue;
    for (const rel of [
      'chrome-linux/chrome',
      'chrome-headless-shell-linux64/chrome-headless-shell',
    ]) {
      const p = path.join(base, dir, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('chromium executable not found');
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: [
    '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-gpu-sandbox',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e && e.stack ? e.stack : e)));

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  console.log('  shot', name);
};
const state = () => page.evaluate(() => {
  const app = window.__frontline;
  if (!app) return null;
  const lp = app.getLocalPlayer?.();
  return {
    mode: app.mode, active: app.active,
    world: !!app.world,
    players: app.mode === 'offline'
      ? app.offlineGame?.players.size ?? 0
      : app.net?.buffer?.snapshots?.length ?? null,
    fps: Math.round(app.renderer?.fps ?? 0),
    drawCalls: app.renderer?.renderer?.info?.render?.calls ?? null,
    tris: app.renderer?.renderer?.info?.render?.triangles ?? null,
    local: lp ? { x: +lp.x.toFixed(1), y: +lp.y.toFixed(1), z: +lp.z.toFixed(1), hp: lp.hp, alive: lp.alive } : null,
    state: app.state ? { mode: app.state.mode, matchState: app.state.matchState } : null,
  };
});

try {
  await page.goto(BASE, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1200);
  await shot('01-lobby');
  console.log('lobby:', await page.evaluate(() => !!window.__frontline));

  const btn = OFFLINE ? '#battest' : '#join';
  await page.click(btn);
  // World generation takes a moment.
  await page.waitForFunction(() => window.__frontline?.active === true, null, { timeout: 45000 });
  await page.waitForTimeout(2500);
  await shot('02-spawn');

  // Focus the canvas (pointer lock) and look toward the battlefield.
  // Headless pointer lock reports synthetic movement deltas, so aim is set
  // through the same state the real mouse handler writes to.
  const box = await page.locator('#view').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  await page.evaluate(() => { const a = window.__frontline; a.aimPitch = -0.08; a.aimYaw += 0.7; });
  await page.keyboard.down('w');
  await page.waitForTimeout(1400);
  await page.keyboard.up('w');
  await page.waitForTimeout(500);
  await shot('03-walk');

  // Fire a few rounds (set the input bit directly; avoids headless mouse noise).
  await page.evaluate(() => { window.__frontline.input.mouse.left = true; });
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.__frontline.input.mouse.left = false; });
  await page.waitForTimeout(250);
  await shot('04-fire');

  // Aim down sights, then sprint across terrain.
  await page.evaluate(() => { window.__frontline.input.mouse.right = true; });
  await page.waitForTimeout(500);
  await shot('05-ads');
  await page.evaluate(() => { window.__frontline.input.mouse.right = false; });
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  await page.waitForTimeout(2200);
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  await shot('06-sprint');

  // Settings overlay.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await shot('07-settings');
  await page.keyboard.press('Escape');

  console.log('final state:', JSON.stringify(await state(), null, 2));
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}

if (errors.length) process.exitCode = 1;
