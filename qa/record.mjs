// Real-time browser gameplay recording. Only the starting training course and
// target are staged; movement/combat/reload/vehicle actions use browser input.
// Playwright video is silent. Audio-engine levels are logged separately.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchBrowser, boot, frameEvidence } from './browser.mjs';

const out = path.resolve(process.env.QA_CLIP || 'qa/clip/blackshore'); mkdirSync(out, { recursive: true });
const { browser, context, page, errors } = await launchBrowser({ width: 1280, height: 720, quality: 'low', recordVideo: out });
const actions = []; let metadata;
const mark = name => { actions.push({ name, wallTime: Date.now() }); console.log(name); };
const wait = ms => page.waitForTimeout(ms);
try {
  await boot(page); await page.click('[data-mode="tdm"]'); await page.click('#battest');
  await page.waitForFunction(() => window.__frontline?.active);
  const setup = await page.evaluate(() => {
    const a = window.__frontline, g = a.offlineGame, p = a.offlinePlayer;
    for (const other of [...g.players.values()]) if (other !== p) g.removePlayer(other.id);
    g.matchState = 2; g.countdown = 0; g.events.length = 0; g.loot.length = 0; a.loot.length = 0;
    let lane;
    for (let z = -180; z <= 180 && !lane; z += 20) for (let x = -180; x <= 180; x += 20) {
      if (g.world.waterDepth(x, z) > .1 || g.world.terrainNormal(x, z)[1] < .99) continue;
      const y = g.world.terrainHeight(x, z);
      if (g.world.queryBoxes(x - 4, z - 55, x + 4, z + 4).some(b => b.tag !== 'glass' && b.max[1] > y + .3 && b.min[0] < x + 4 && b.max[0] > x - 4 && b.min[2] < z + 4 && b.max[2] > z - 55)) continue;
      lane = [x, y, z]; break;
    }
    if (!lane) throw new Error('No clear recording course');
    p.pos = lane.slice(); p.vel = [0, 0, 0]; p.health = 100; p.armor = 75;
    p.giveLoadout(['ar', 'pistol']); p.stance = 0; p.yaw = a.aimYaw = 0; p.pitch = a.aimPitch = -.035;
    const target = g.addPlayer('RANGE TARGET', 1, { connected: false, forceSpawn: { x: lane[0], z: lane[2] - 18 } });
    target.yaw = Math.PI;
    const car = g.vehicles.find(v => v.type === 'car');
    g.vehicles.splice(0, g.vehicles.length, car);
    car.pos = [lane[0] + 2.4, g.world.terrainHeight(lane[0] + 2.4, lane[2] - 10) + .59, lane[2] - 10];
    car.yaw = 0; car.vel = [0, 0, 0]; car.health = 450; car.occupants.fill(null);
    a.input.clearHeld(); a.hadLock = false; a.buildOfflineState();
    a.audio.setMuted(false); a.audio.setVolume(.4);
    const original = a.renderer.render.bind(a.renderer);
    a._recording = { startedAt: performance.now(), startedSim: g.time, times: [], levels: [] };
    a.renderer.render = dt => {
      const record = a._recording;
      record.times.push(performance.now());
      if (record.times.length % 10 === 0) record.levels.push(a.audio.getLevels());
      original(dt);
    };
    return { lane, vehicleId: car.id };
  });
  await page.click('#view'); await page.waitForFunction(() => window.__frontline.input.pointerLocked);
  await page.evaluate(() => { const a = window.__frontline; a.input.mouse.dx = a.input.mouse.dy = 0; a.aimYaw = 0; a.aimPitch = -.035; });
  mark('live fire'); await page.mouse.down(); await wait(1700); await page.mouse.up();
  mark('reload'); await page.keyboard.press('r');
  await page.waitForFunction(() => window.__frontline.offlinePlayer.reloadT > 0);
  await page.waitForFunction(() => window.__frontline.offlinePlayer.reloadT <= 0);
  mark('aim'); await page.mouse.down({ button: 'right' }); await wait(1500); await page.mouse.up({ button: 'right' });
  mark('advance'); await page.keyboard.down('w');
  await page.waitForFunction(z => window.__frontline.offlinePlayer.pos[2] <= z, setup.lane[2] - 8, { timeout: 20000 });
  await page.keyboard.up('w');
  mark('stances'); await page.keyboard.press('c'); await wait(700); await page.keyboard.press('x'); await wait(800); await page.keyboard.press('v'); await wait(650);
  mark('enter utility'); await page.keyboard.press('e');
  await page.waitForFunction(() => !!window.__frontline.offlinePlayer.inVehicle);
  mark('accelerate'); await page.keyboard.down('w');
  await page.waitForFunction(() => { const v = window.__frontline.offlineGame.vehicles[0]; return Math.hypot(v.vel[0], v.vel[2]) > 10; }, null, { timeout: 20000 });
  await wait(1000); await page.keyboard.down('a'); await wait(750); await page.keyboard.up('a'); await page.keyboard.up('w');
  mark('brake'); await page.keyboard.down('Space'); await wait(1600); await page.keyboard.up('Space');
  mark('exit'); await page.keyboard.press('e'); await wait(900);
  metadata = await page.evaluate(() => {
    const a = window.__frontline, r = a._recording;
    return { ...r, endedAt: performance.now(), endedSim: a.offlineGame.time,
      final: { hp: a.offlinePlayer.health, inVehicle: a.offlinePlayer.inVehicle, score: a.offlineGame.score,
        shotsFired: a.offlinePlayer.shotsFired || 0, vehiclePosition: a.offlineGame.vehicles[0].pos } };
  });
  metadata.frame = await frameEvidence(page);
} catch (error) {
  errors.push(String(error.stack || error));
} finally {
  const video = page.video();
  await context.close();
  const rawPath = await video.path();
  const file = path.join(out, 'gameplay.webm'); renameSync(rawPath, file);
  await browser.close();
  writeFileSync(path.join(out, 'metadata.json'), JSON.stringify({ revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    method: 'real-time browser input on a staged offline training course', rendering: 'SwiftShader software GL',
    audioCaptured: false, viewport: [1280, 720], actions, metadata, errors }, null, 2));
  console.log('Saved', file, 'errors:', errors);
  if (errors.length) process.exitCode = 1;
}
