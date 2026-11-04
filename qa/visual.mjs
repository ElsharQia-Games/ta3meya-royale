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
  // Freeze the mannequin: a connected player is stepped with an empty input,
  // which resets yaw to 0 every tick and turns the pose shot away from camera.
  dummy.connected = false;
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

// ---- viewmodel framing / near-plane / muzzle alignment (hip) ----
const vmAudit = () => {
  const a = window.__frontline;
  const cam = a.renderer.camera;
  const V3 = cam.position.constructor;
  const vm = a.viewmodel;
  vm.root.updateWorldMatrix(true, true);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let minViewZ = Infinity, maxViewZ = -Infinity;
  vm.root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox;
    for (let i = 0; i < 8; i++) {
      const c = new V3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      c.applyMatrix4(o.matrixWorld);
      const view = c.clone().applyMatrix4(cam.matrixWorldInverse);
      minViewZ = Math.min(minViewZ, -view.z);
      maxViewZ = Math.max(maxViewZ, -view.z);
      c.project(cam);
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
      minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
    }
  });
  const muzzle = vm.muzzleWorld();
  const fwd = new V3(0, 0, -1).applyQuaternion(cam.quaternion);
  const toMuzzle = muzzle.clone().sub(cam.position).normalize();
  return {
    ndc: [minX, maxX, minY, maxY].map((v) => +v.toFixed(2)),
    inFrame: minX > -1 && maxX < 1 && minY > -1 && maxY < 1,
    nearZ: +minViewZ.toFixed(3), farZ: +maxViewZ.toFixed(3), near: +cam.near.toFixed(3),
    muzzleDot: +toMuzzle.dot(fwd).toFixed(3),
    muzzleOffset: +(muzzle.clone().sub(cam.position).length()).toFixed(2),
    ads: +vm.ads.toFixed(2), kick: +vm.kick.toFixed(3), kickYaw: +vm.kickYaw.toFixed(3),
    visible: vm.root.visible,
  };
};
const hip = await page.evaluate(vmAudit);
console.log('viewmodel-hip', JSON.stringify(hip));

// ---- ADS ----
const fovHip = await page.evaluate(() => +window.__frontline.renderer.camera.fov.toFixed(1));
await page.evaluate(() => { window.__frontline.input.mouse.right = true; });
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, '14-ads.png') });
const adsInfo = await page.evaluate(() => {
  const a = window.__frontline;
  return { fov: +a.renderer.camera.fov.toFixed(1), adsF: +(a.adsF ?? 0).toFixed(2), vmVisible: a.viewmodel.root.visible };
});
const adsVm = await page.evaluate(vmAudit);
console.log('viewmodel-ads', JSON.stringify(adsVm));
// Recoil must return to zero: kick once, then sample after the damp settles.
const recoil = await page.evaluate(async () => {
  const a = window.__frontline;
  const vm = a.viewmodel;
  vm.fire(1);
  const peak = { kick: +vm.kick.toFixed(3), yaw: +vm.kickYaw.toFixed(3) };
  await new Promise((r) => setTimeout(r, 800));
  return { peak, settled: { kick: +vm.kick.toFixed(4), yaw: +vm.kickYaw.toFixed(4) } };
});
console.log('viewmodel-recoil', JSON.stringify(recoil));
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

// ---- character pose / nameplate / facing audit (no extra screenshots) ----
// The mannequin is frozen (connected=false) so the sim cannot reset its yaw.
const poses = [
  [3, 0, true, '3m-stand'], [3, 1, true, '3m-crouch'], [3, 2, true, '3m-prone'],
  [15, 0, true, '15m-stand'], [15, 1, true, '15m-crouch'], [15, 2, true, '15m-prone'],
  [40, 0, true, '40m-stand'], [40, 1, true, '40m-crouch'], [40, 2, true, '40m-prone'],
  [5, 0, false, '5m-dead'],
];
const poseInfo = await page.evaluate((poses) => {
  const a = window.__frontline;
  const p = a.offlinePlayer;
  const w = a.world;
  const dummy = [...a.offlineGame.players.values()].find((x) => x.name === 'MANNEQUIN');
  return { px: p.pos[0], pz: p.pos[2], py: p.pos[1], dummyId: dummy?.id, poses };
}, poses);
for (const [d, stance, alive, label] of poses) {
  await page.evaluate(({ px, pz, d, stance, alive }) => {
    const a = window.__frontline;
    const dummy = [...a.offlineGame.players.values()].find((x) => x.name === 'MANNEQUIN');
    const z = pz - d;
    dummy.pos = [px, a.world.terrainHeight(px, z) + 0.1, z];
    dummy.vel = [0, 0, 0];
    dummy.stance = stance;
    dummy.alive = alive;
    dummy.yaw = Math.PI;           // face the camera (+z)
    dummy.pitch = 0;
  }, { px: poseInfo.px, pz: poseInfo.pz, d, stance, alive });
  await page.waitForTimeout(alive ? 2200 : 6000);
  const row = await page.evaluate((label) => {
    const a = window.__frontline;
    const cam = a.renderer.camera;
    const V3 = cam.position.constructor;
    const w = a.world;
    const v = [...a.characters.values()].find((c) => c.name === 'MANNEQUIN');
    if (!v) return { label, missing: true };
    const root = v.model.root;
    root.updateWorldMatrix(true, true);
    let minY = Infinity, maxY = -Infinity;
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox;
      for (let i = 0; i < 8; i++) {
        const c = new V3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
        c.applyMatrix4(o.matrixWorld);
        minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
      }
    });
    const ground = w.terrainHeight(v.pos[0], v.pos[2]);
    const plate = v.plate.sprite;
    const platePx = (plate.scale.y / Math.max(0.1, cam.position.distanceTo(plate.position)))
      * (900 / 2) / Math.tan(cam.fov * Math.PI / 360);
    const textPx = platePx * ((v.plate.fontSize || 26) / v.plate.canvas.height);
    const gunTip = new V3(0, 0, -0.62);
    v.model.gun.localToWorld(gunTip);
    const fz = gunTip.z - v.pos[2];
    return {
      label, stance: v.stance, alive: v.alive,
      posY: +v.pos[1].toFixed(2), rootY: +root.position.y.toFixed(2), hipsY: +v.model.hips.position.y.toFixed(2),
      footPen: +(ground - minY).toFixed(2), height: +(maxY - minY).toFixed(2),
      platePx: +platePx.toFixed(1), textPx: +textPx.toFixed(1),
      plateVisible: plate.visible,
      rootRotY: +root.rotation.y.toFixed(2), rootRotX: +root.rotation.x.toFixed(2),
      gunFaces: fz > 0.2 ? '+z' : fz < -0.2 ? '-z' : 'flat',
      teamHex: '#' + v.model.mats.teamMat.color.getHexString(),
      teamEmissive: +v.model.mats.teamMat.emissive.r.toFixed(2),
    };
  }, label);
  console.log('pose', JSON.stringify(row));
}
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');

await browser.close();
if (errors.length) process.exitCode = 1;
