// Blackshore visual review. Captures actual WebGL/DOM output; controlled gameplay
// poses are labelled as fixtures in the manifest. No image synthesis is used.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const out = path.resolve(process.env.QA_OUT || 'qa/shots/blackshore');
const url = process.env.QA_URL || 'http://127.0.0.1:3000/';
const lobbyOnly = process.argv.includes('--lobby-only');
mkdirSync(out, { recursive: true });
const cache = path.join(process.env.HOME, '.cache/ms-playwright');
let executablePath;
for (const dir of readdirSync(cache)) {
  if (!dir.startsWith('chromium')) continue;
  for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
    const file = path.join(cache, dir, rel);
    if (existsSync(file)) { executablePath = file; break; }
  }
  if (executablePath) break;
}
if (!executablePath) throw new Error('Install a Playwright Chromium browser to run visual QA');
const browser = await chromium.launch({ executablePath, args: [
  '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required',
] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const errors = [], frames = [];
page.on('pageerror', e => errors.push(String(e.stack || e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const capture = async (name, fixture = false) => {
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  const state = await page.evaluate(() => {
    const a = window.__frontline, r = a.renderer;
    return { mode: a.mode || 'deployment', viewport: [innerWidth, innerHeight],
      camera: r.camera.position.toArray(), rotation: r.camera.rotation.toArray().slice(0, 3),
      fov: r.camera.fov, seed: a.world?.seed, quality: a.settings.quality,
      calls: r.renderer.info.render.calls, triangles: r.renderer.info.render.triangles,
      softwareFps: +r.fps.toFixed(1), weapon: a.getLocalPlayer()?.weapon || null };
  });
  frames.push({ name, fixture, ...state });
  console.log(name, JSON.stringify(state));
};

try {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__frontline?.previewReady, null, { timeout: 60000 });
  await page.waitForFunction(() => window.__frontline?.worldView?.assetsLoaded, null, { timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  await capture('00-deployment');
  await page.click('#nav-manual');
  await capture('01-field-manual');
  await page.click('#manual-close');
  await page.click('#nav-settings');
  await capture('02-settings');
  await page.click('#settings-close');
  if (!lobbyOnly) {
    await page.click('[data-mode="tdm"]');
    await page.click('#battest');
    await page.waitForFunction(() => window.__frontline?.active, null, { timeout: 60000 });
    await page.evaluate(() => {
      const a = window.__frontline, p = a.offlinePlayer;
      a.offlineGame.matchState = 2;
      a.offlineGame.countdown = 0;
      p.pos = [20, a.world.terrainHeight(20, -160), -160]; p.vel = [0, 0, 0];
      p.health = 100; p.armor = 75; p.alive = true; p.stance = 0; p.grounded = true;
      p.giveLoadout(['ar', 'pistol']);
      a.aimYaw = 0; a.aimPitch = 0;
      a.buildOfflineState();
      a._visualStep = a.stepSim;
      a.stepSim = () => {};
      a.hud.notify(''); a.hud.toast.classList.remove('show');
    });
    await page.waitForTimeout(600);
    await capture('03-carbine-hip', true);
    await page.evaluate(() => { const a = window.__frontline; a.offlinePlayer.adsing = true; a.input.mouse.right = true; });
    await page.waitForTimeout(700);
    await capture('04-carbine-ads', true);
    await page.evaluate(() => { const a = window.__frontline; a.offlinePlayer.adsing = false; a.input.mouse.right = false; a.offlinePlayer.reloadT = 1.3; });
    await page.waitForTimeout(300);
    await capture('05-carbine-reload', true);
    await page.evaluate(() => { const a = window.__frontline; a.offlinePlayer.reloadT = 0; a.hud.toggleScoreboard(true); });
    await capture('06-scoreboard', true);
  }
} finally {
  let revision = 'unknown';
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ revision, capturedAt: new Date().toISOString(),
    rendering: 'Chromium / SwiftShader software GL', url, frames, errors }, null, 2));
  await browser.close();
  console.log('Browser errors:', errors);
  if (errors.length) process.exitCode = 1;
}
