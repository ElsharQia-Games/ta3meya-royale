// Visual evidence pass (offline, no server needed).
//
//   node qa/visual.mjs
//
// Places the local player at a hilltop overlooking NORTHGATE and next to a bot,
// then captures the vista, a character close-up, the first-person weapon and an
// ADS frame. Screenshots go to qa/shots/ for human review; qa/analyze.py gives
// numeric stats. This script teleports only the offline player.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('qa/shots');
fs.mkdirSync(OUT, { recursive: true });

function findChromium() {
  const base = path.join(process.env.HOME, '.cache/ms-playwright');
  for (const dir of fs.readdirSync(base)) {
    if (!dir.startsWith('chromium')) continue;
    for (const rel of ['chrome-linux/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
      const p = path.join(base, dir, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('chromium not found');
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.stack || e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(process.env.QA_URL || 'http://127.0.0.1:3000/', { waitUntil: 'load' });
await page.click('#battest');
await page.waitForFunction(() => window.__frontline?.active === true, null, { timeout: 45000 });
await page.waitForTimeout(2500);

// ---- vista: highest point in a ring around NORTHGATE, looking at the town ----
const vista = await page.evaluate(() => {
  const a = window.__frontline;
  const w = a.world;
  const town = w.towns.find((t) => t.name === 'NORTHGATE');
  let best = null;
  // Stay south of the town and look north: the sun is in the +z half of the
  // sky, so this keeps the town front-lit and the sky out of the sun's glare.
  for (let i = 0; i < 96; i++) {
    const ang = (i / 96) * Math.PI * 2;
    for (const d of [town.r + 40, town.r + 80, town.r + 120, town.r + 160]) {
      const x = town.x + Math.cos(ang) * d;
      const z = town.z + Math.sin(ang) * d;
      if (Math.abs(x) > 480 || Math.abs(z) > 480) continue;
      if (z < town.z + 70) continue;
      const y = w.terrainHeight(x, z);
      if (!best || y > best.y) best = { x, y, z };
    }
  }
  const p = a.offlinePlayer;
  p.pos = [best.x, best.y + 0.2, best.z];
  p.vel = [0, 0, 0];
  const dx = town.x - best.x, dz = town.z - best.z;
  a.aimYaw = Math.atan2(-dx, -dz);
  a.aimPitch = -0.02;
  return { town: town.name, pos: [best.x, best.y, best.z].map((v) => +v.toFixed(1)) };
});
console.log('vista', JSON.stringify(vista));
await page.waitForTimeout(700);
await page.screenshot({ path: path.join(OUT, '10-vista.png') });

// ---- character close-up: a stationary mannequin on flat open ground ----
// Using a real Player with no input keeps the pose deterministic; a bot would
// walk out of frame while the software renderer takes the screenshot.
const charInfo = await page.evaluate(() => {
  const a = window.__frontline;
  const g = a.offlineGame;
  const w = a.world;
  let stage = null;
  for (let r = 20; r <= 140 && !stage; r += 8) {
    for (let i = 0; i < 24; i++) {
      const ang = (i / 24) * Math.PI * 2;
      const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
      const n = w.terrainNormal(x, z);
      const slope = Math.hypot(n[0], n[2]) / Math.max(0.001, n[1]);
      if (slope > 0.04) continue;
      if (w.isWater(x, z)) continue;
      if (w.nearBuilding(x, z, 7)) continue;
      stage = { x, z };
      break;
    }
  }
  if (!stage) return null;
  const dummy = g.addPlayer('MANNEQUIN', 0, { connected: true, forceSpawn: stage });
  // Face +z (toward the camera) so the sun behind the camera front-lights it.
  dummy.yaw = Math.PI; dummy.pitch = 0; dummy.stance = 0;
  const p = a.offlinePlayer;
  const px = stage.x, pz = stage.z + 3.2;
  const py = w.terrainHeight(px, pz);
  p.pos = [px, py + 0.1, pz];
  p.vel = [0, 0, 0];
  a.aimYaw = 0;                              // look north (-z), away from the sun
  // Aim at the mannequin's chest so the whole body is framed.
  a.aimPitch = Math.atan2((dummy.pos[1] + 1.0) - (py + 1.7), 3.2);
  // Camera and dummy are static; hide the first-person weapon for a clean
  // character read (restored before the viewmodel shot).
  a._vmUpdate = a.viewmodel.update;
  a.viewmodel.update = () => {};
  a.viewmodel.root.visible = false;
  return {
    stage: [stage.x, stage.z].map((v) => +v.toFixed(1)),
    dummy: dummy.name, dummyPos: dummy.pos.map((v) => +v.toFixed(1)),
    playerPos: [px, py, pz].map((v) => +v.toFixed(1)),
  };
});
console.log('character', JSON.stringify(charInfo));
await page.waitForTimeout(500);
const framing = await page.evaluate(() => {
  const a = window.__frontline;
  const v = [...a.characters.values()].find((c) => c.name === 'MANNEQUIN');
  if (!v) return { view: false };
  const cam = a.renderer.camera;
  const V3 = cam.position.constructor;
  const chest = new V3(v.pos[0], v.pos[1] + 1.0, v.pos[2]).project(cam);
  const head = new V3(v.pos[0], v.pos[1] + 1.8, v.pos[2]).project(cam);
  const feet = new V3(v.pos[0], v.pos[1] + 0.05, v.pos[2]).project(cam);
  return {
    view: true, visible: v.model.root.visible, plate: v.plate.sprite.visible,
    chest: [+chest.x.toFixed(2), +chest.y.toFixed(2)],
    head: [+head.y.toFixed(2)], feet: [+feet.y.toFixed(2)],
  };
});
console.log('framing', JSON.stringify(framing));
await page.screenshot({ path: path.join(OUT, '11-character.png') });

// Clean shot without HUD.
await page.evaluate(() => document.getElementById('hud').classList.add('hidden'));
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(OUT, '12-character-nohud.png') });

// ---- first-person weapon, level aim ----
await page.evaluate(() => {
  const a = window.__frontline;
  a.aimPitch = 0.0;
  a.viewmodel.update = a._vmUpdate;
  document.getElementById('hud').classList.remove('hidden');
});
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, '13-viewmodel.png') });

// ---- ADS ----
const fovHip = await page.evaluate(() => +window.__frontline.renderer.camera.fov.toFixed(1));
await page.evaluate(() => { window.__frontline.input.mouse.right = true; });
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, '14-ads.png') });
const adsInfo = await page.evaluate(() => {
  const a = window.__frontline;
  return { fov: +a.renderer.camera.fov.toFixed(1), adsF: +(a.adsF ?? 0).toFixed(2), vmVisible: a.viewmodel.root.visible };
});
await page.evaluate(() => { window.__frontline.input.mouse.right = false; });

const info = await page.evaluate(() => {
  const a = window.__frontline;
  return {
    drawCalls: a.renderer.renderer.info.render.calls,
    tris: a.renderer.renderer.info.render.triangles,
    fps: Math.round(a.renderer.fps),
    characters: a.characters.size,
    alive: [...a.offlineGame.players.values()].filter((p) => p.alive).length,
    vmVisible: a.viewmodel.root.visible,
  };
});
console.log('ads', JSON.stringify({ fovHip, ...adsInfo }));
console.log('render', JSON.stringify(info));
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');

await browser.close();
if (errors.length) process.exitCode = 1;
