// High-quality1080p scene matrix. Every placement is a labelled fixture; these
// pictures inspect real renderer output, not gameplay navigation completion.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchBrowser, boot, frameEvidence } from './browser.mjs';
const out = process.env.QA_OUT || 'qa/shots/scenes'; mkdirSync(out, { recursive: true });
const { browser, page, errors } = await launchBrowser();
const frames = [];
const capture = async name => {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  frames.push({ name, fixture: true, ...await frameEvidence(page) }); console.log(name);
};
try {
  await boot(page); await capture('00-deployment');
  await page.click('[data-mode="tdm"]'); await page.click('#battest');
  await page.waitForFunction(() => window.__frontline?.active);
  await page.evaluate(() => {
    const a = window.__frontline, g = a.offlineGame, p = a.offlinePlayer;
    a._sceneStep = a.stepSim.bind(a); a.stepSim = () => {}; g.matchState = 2; g.countdown = 0;
    for (const other of [...g.players.values()]) if (other !== p) g.removePlayer(other.id);
    g.loot.length = 0; a.loot.length = 0;
    a.placeScene = (x, y, z, tx, ty, tz, armed = true) => {
      p.pos = [x, y, z]; p.vel = [0, 0, 0]; p.stance = 0; p.health = 100; p.alive = true; p.armor = 75;
      p.inVehicle = null; p.seat = -1; p.grounded = true; p.adsing = false; p.reloadT = 0;
      p.inWater = a.world.waterDepth(x, z) > .25; p.swimming = p.inWater && y < a.world.lake.level - 1;
      p.giveLoadout(armed ? ['ar', 'pistol'] : []);
      const dx = tx - x, dz = tz - z;
      a.aimYaw = p.yaw = Math.atan2(-dx, -dz);
      a.aimPitch = p.pitch = Math.atan2(ty - y - p.eyeHeight(), Math.hypot(dx, dz));
      a.input.clearHeld(); a.input.stance = 0; a.shake = 0;
      a.buildOfflineState(); a.hud.toast.classList.remove('show');
    };
  });
  for (const scene of ['town', 'interior', 'upstairs', 'forest', 'industrial', 'shore', 'underwater']) {
    await page.evaluate(scene => {
      const a = window.__frontline, w = a.world;
      const b = w.buildings.find(b => b.floors > 1 && b.doors.some(d => d.kind === 'front'));
      if (scene === 'town') {
        const d = b.doors.find(d => d.kind === 'front' && d.floor === 0), x = d.cx + d.nx * 9, z = d.cz + d.nz * 9;
        a.placeScene(x, w.terrainHeight(x, z), z, b.x, b.y0 + 1.5, b.z);
      } else if (scene === 'interior' || scene === 'upstairs') {
        const floor = scene === 'upstairs' ? 1 : 0;
        const point = w.lootSpawns.find(s => s.indoor && Math.abs(s.x - b.x) < b.w / 2 && Math.abs(s.z - b.z) < b.d / 2 && Math.abs(s.y - (b.y0 + floor * b.floorH)) < .2);
        if (!point) throw new Error(`Missing ${scene} fixture`);
        a.placeScene(point.x, point.y, point.z, b.x, point.y + 1.3, b.z);
      } else if (scene === 'forest') {
        const tree = w.trees.find(t => Math.abs(t.x) < 380 && Math.abs(t.z) < 350 && w.trees.filter(n => Math.hypot(n.x - t.x, n.z - t.z) < 30).length > 10);
        if (!tree) throw new Error('Missing forest fixture');
        const x = tree.x + 4, z = tree.z + 7;
        a.placeScene(x, w.terrainHeight(x, z), z, tree.x - 8, tree.y + 2, tree.z - 20);
      } else if (scene === 'industrial') {
        const town = w.towns.find(t => t.type === 'industrial'), x = town.x - 45, z = town.z + 65;
        a.placeScene(x, w.terrainHeight(x, z), z, town.x, w.terrainHeight(town.x, town.z) + 1.5, town.z);
      } else if (scene === 'shore') {
        const lake = w.lake; let x = lake.x + lake.r;
        while (w.waterDepth(x, lake.z) > .1) x += 3;
        a.placeScene(x, w.terrainHeight(x, lake.z), lake.z, lake.x, lake.level, lake.z);
      } else {
        const lake = w.lake;
        a.placeScene(lake.x, lake.level - 3, lake.z, lake.x - 30, lake.level - 1, lake.z);
      }
    }, scene);
    await capture(`01-${scene}`);
  }
  await page.evaluate(() => {
    const a = window.__frontline, g = a.offlineGame, w = a.world;
    a.placeScene(20, w.terrainHeight(20, -160), -160, 21, w.terrainHeight(21, -164) + 1, -164, false);
    a.poseOperator = g.addPlayer('BLACKSHORE', 1, { connected: false, forceSpawn: { x: 21, z: -164 } });
    a.poseOperator.pos = [21, w.terrainHeight(21, -164), -164];
    a.poseOperator.yaw = Math.PI + .35; a.poseOperator.pitch = -.02;
    a.poseOperator.giveLoadout(['ar', 'pistol']);
  });
  for (const [name, stance] of [['standing', 0], ['crouched', 1], ['prone', 2], ['fallen', 0]]) {
    await page.evaluate(({ name, stance }) => {
      const a = window.__frontline, p = a.poseOperator;
      p.stance = stance; p.alive = name !== 'fallen'; p.health = p.alive ? 100 : 0;
      // Settle the pose numerically, then capture the subsequent actual frame.
      const view = a.characters.get(p.id);
      if (view) for (let i = 0; i < 25; i++) {
        view.applyState({ x: p.pos[0], y: p.pos[1], z: p.pos[2], yaw: p.yaw, pitch: p.pitch,
          stance, alive: p.alive, hp: p.health, name: p.name, team: p.team, weapon: p.curWeapon() });
        view.update(.05, a.renderer.camera.position.toArray());
      }
    }, { name, stance });
    await capture(`02-operator-${name}`);
  }
  await page.evaluate(() => {
    const a = window.__frontline, g = a.offlineGame, w = a.world;
    g.removePlayer(a.poseOperator.id);
    const v = g.vehicles.find(v => v.type === 'truck');
    if (!v) throw new Error('Missing truck');
    const x = v.pos[0] + 5, z = v.pos[2] - 6;
    a.placeScene(x, w.terrainHeight(x, z), z, v.pos[0], v.pos[1] + 1, v.pos[2], false);
  });
  await capture('03-transport-exterior');
} finally {
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ rendering: 'SwiftShader software GL', frames, errors }, null, 2));
  await browser.close(); console.log('Errors:', errors);
  if (errors.length) process.exitCode = 1;
}
