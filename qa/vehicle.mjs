// Keyboard -> Input -> App -> shared Game vehicle journey, with explicit setup
// fixtures and deterministic stepping. The separate gameplay recording runs in
// real time. This harness verifies controls/poses without calling enterVehicle.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchBrowser, boot, frameEvidence } from './browser.mjs';

const out = process.env.QA_OUT || 'qa/shots/vehicle-journey';
mkdirSync(out, { recursive: true });
const { browser, page, errors } = await launchBrowser({ quality: process.env.QA_QUALITY || 'high' });
const checks = [], frames = [];
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); console.log(pass ? 'PASS' : 'FAIL', name, detail ?? ''); };
const capture = async name => {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  const contacts = await page.evaluate(() => {
    const a = window.__frontline;
    return [...a.vehicleViews.values()].map(v => ({ id: v.id, wheelGroundGaps: v.wheels.map(wheel => {
      const point = wheel.pivot.getWorldPosition(wheel.pivot.position.clone());
      return point.y - .42 - a.world.terrainHeight(point.x, point.z);
    }) }));
  });
  frames.push({ name, fixture: true, contacts, ...await frameEvidence(page) });
};
const steps = async n => page.evaluate(n => {
  const a = window.__frontline;
  for (let i = 0; i < n; i++) a._journeyStep(1 / 60);
  a.buildOfflineState();
}, n);

try {
  await boot(page);
  await page.click('[data-mode="tdm"]');
  await page.click('#battest');
  await page.waitForFunction(() => window.__frontline?.active);
  const setup = await page.evaluate(() => {
    const a = window.__frontline, g = a.offlineGame, p = a.offlinePlayer;
    a._journeyStep = a.stepSim.bind(a); a.stepSim = () => {};
    g.matchState = 2; g.countdown = 0;
    for (const other of [...g.players.values()]) if (other !== p) g.removePlayer(other.id);
    g.loot.length = 0; a.loot.length = 0;
    const vehicle = g.vehicles.find(v => v.type === 'car');
    if (!vehicle) throw new Error('No car fixture available');
    let lane;
    for (let z = -180; z <= 180 && !lane; z += 20) for (let x = -180; x <= 180; x += 20) {
      if (g.world.waterDepth(x, z) > .1 || g.world.terrainNormal(x, z)[1] < .99) continue;
      const y = g.world.terrainHeight(x, z);
      const boxes = g.world.queryBoxes(x - 3, z - 45, x + 3, z + 4);
      if (boxes.some(b => b.tag !== 'glass' && b.max[1] > y + .3 && b.min[0] < x + 3 && b.max[0] > x - 3 && b.min[2] < z + 4 && b.max[2] > z - 45)) continue;
      lane = [x, y, z]; break;
    }
    if (!lane) throw new Error('No clear driving lane found');
    g.vehicles.splice(0, g.vehicles.length, vehicle);
    vehicle.pos = [lane[0], lane[1] + .59, lane[2]];
    vehicle.vel = [0, 0, 0]; vehicle.yaw = 0; vehicle.health = 450; vehicle.steer = 0;
    vehicle.occupants.fill(null);
    p.pos = [lane[0] + 3.4, lane[1], lane[2] - 4.2]; p.vel = [0, 0, 0]; p.health = 100; p.alive = true;
    p.inVehicle = null; p.seat = -1; p.giveLoadout([]);
    p.yaw = a.aimYaw = Math.atan2(3.4, -4.2); p.pitch = a.aimPitch = -.06;
    a.input.clearHeld(); a.hadLock = false; a.syncInputMode();
    a.buildOfflineState(); a.hud.toast.classList.remove('show');
    return { lane, vehicleId: vehicle.id };
  });
  await capture('00-utility-exterior');
  await page.evaluate(() => {
    const a = window.__frontline, p = a.offlinePlayer, v = a.offlineGame.vehicles[0];
    p.pos = [v.pos[0] + 1.6, a.world.terrainHeight(v.pos[0] + 1.6, v.pos[2]), v.pos[2]];
  });
  await page.keyboard.press('e'); await steps(1);
  let status = await page.evaluate(() => {
    const a = window.__frontline, p = a.offlinePlayer, v = a.offlineGame.vehicles[0];
    return { vehicle: p.inVehicle, seat: p.seat, occupant: v.occupants[0] };
  });
  check('E enters the driver seat through production input', status.vehicle === setup.vehicleId && status.seat === 0, status);
  await capture('01-cockpit-idle');
  check('driver HUD hides the weapon crosshair', await page.evaluate(() => window.__frontline.hud.cross.classList.contains('hidden')));
  await page.keyboard.down('w'); await steps(150); await page.keyboard.up('w');
  status = await page.evaluate(() => { const v = window.__frontline.offlineGame.vehicles[0]; return { pos: v.pos.slice(), speed: Math.hypot(v.vel[0], v.vel[2]) }; });
  check('W drives forward with authoritative movement', status.pos[2] < setup.lane[2] - 5 && status.speed > 4, status);
  await capture('02-driving');
  await page.keyboard.down('a'); await steps(30); await page.keyboard.up('a');
  const yaw = await page.evaluate(() => window.__frontline.offlineGame.vehicles[0].yaw);
  check('A steers the moving car', yaw > .01, yaw);
  await page.keyboard.down('Space'); await steps(120); await page.keyboard.up('Space');
  const stopped = await page.evaluate(() => Math.hypot(...window.__frontline.offlineGame.vehicles[0].vel.filter((_, i) => i !== 1)));
  check('Space brakes', stopped < .5, stopped);
  await page.keyboard.down('s'); await steps(150); await page.keyboard.up('s');
  const reverse = await page.evaluate(() => { const v = window.__frontline.offlineGame.vehicles[0]; return -Math.sin(v.yaw) * v.vel[0] - Math.cos(v.yaw) * v.vel[2]; });
  check('S reverses after braking', reverse < -1 && reverse >= -8.02, reverse);
  await page.keyboard.down('Space'); await steps(120); await page.keyboard.up('Space');
  await page.keyboard.press('e'); await steps(1);
  status = await page.evaluate(() => { const a = window.__frontline; return { inVehicle: a.offlinePlayer.inVehicle, occupants: a.offlineGame.vehicles[0].occupants }; });
  check('E exits and releases the seat', status.inVehicle === null && status.occupants.every(id => id === null), status);
  await capture('03-exited');
  await page.evaluate(() => {
    const a = window.__frontline, g = a.offlineGame, v = g.vehicles[0];
    const driver = g.addPlayer('DRIVER FIXTURE', 0, { connected: false, forceSpawn: { x: v.pos[0], z: v.pos[2] } });
    if (!g.enterVehicle(driver, v)) throw new Error('Driver fixture could not enter');
    a.offlinePlayer.giveLoadout(['ar', 'pistol']);
  });
  await page.keyboard.press('e'); await steps(1);
  check('occupied driver seat selects a passenger seat', await page.evaluate(() => window.__frontline.offlinePlayer.seat === 1));
  await page.click('#view'); await page.waitForFunction(() => !!document.pointerLockElement);
  await page.mouse.down({ button: 'right' }); await steps(1);
  await page.waitForFunction(() => window.__frontline.renderer.camera.fov < 70);
  check('passenger can aim with visible equipment', await page.evaluate(() => window.__frontline.viewmodel.root.visible && window.__frontline.offlinePlayer.adsing));
  await capture('04-passenger-ads'); await page.mouse.up({ button: 'right' });
  await page.mouse.down(); await steps(12); await page.mouse.up();
  check('passenger fire consumes authoritative ammo', await page.evaluate(() => window.__frontline.offlinePlayer.inv.ar.mag < 30));
} finally {
  check('zero browser errors', errors.length === 0, errors);
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ rendering: 'SwiftShader software GL', checks, frames, errors }, null, 2));
  await browser.close();
  if (checks.some(c => !c.pass)) process.exitCode = 1;
}
