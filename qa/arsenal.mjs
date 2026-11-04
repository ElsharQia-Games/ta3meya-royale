// Every weapon at hip/ADS and through reload phases. These are labelled pose
// fixtures; actual input/combat and real-time animation are checked separately.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CFG } from '../shared/config.js';
import { launchBrowser, boot, frameEvidence } from './browser.mjs';

const out = process.env.QA_OUT || 'qa/shots/arsenal'; mkdirSync(out, { recursive: true });
const { browser, page, errors } = await launchBrowser({ quality: process.env.QA_QUALITY || 'high' });
const frames = [], checks = [];
try {
  await boot(page);
  await page.click('[data-mode="tdm"]'); await page.click('#battest');
  await page.waitForFunction(() => window.__frontline?.active);
  await page.evaluate(() => {
    const a = window.__frontline, g = a.offlineGame, p = a.offlinePlayer;
    a.stepSim = () => {}; g.matchState = 2; g.countdown = 0;
    for (const other of [...g.players.values()]) if (other !== p) g.removePlayer(other.id);
    g.loot.length = 0; a.loot.length = 0;
    p.pos = [20, a.world.terrainHeight(20, -160), -160]; p.vel = [0, 0, 0];
    p.health = 100; p.armor = 75; p.alive = true; p.grounded = true; p.stance = 0;
    p.inVehicle = null; p.seat = -1;
    p.yaw = a.aimYaw = 0; p.pitch = a.aimPitch = 0;
    a.input.clearHeld(); a.hadLock = false;
    a.buildOfflineState(); a.hud.toast.classList.remove('show');
    a._vmUpdate = a.viewmodel.update.bind(a.viewmodel);
    a._fxUpdate = a.effects.update.bind(a.effects);
  });
  for (const weapon of CFG.WEAPON_ORDER) {
    for (const pose of ['hip', 'ads', 'reload-remove', 'reload-exchange', 'reload-insert', 'fire']) {
      const timing = await page.evaluate(({ weapon, pose, definition }) => {
        const a = window.__frontline, p = a.offlinePlayer;
        a.viewmodel.update = a._vmUpdate; a.effects.update = a._fxUpdate;
        a.effects.muzzleT = 0; a.effects.muzzleSprite.visible = false; a.effects.muzzleLight.intensity = 0;
        p.giveLoadout([weapon, weapon === 'pistol' ? 'ar' : 'pistol']);
        p.curSlot = 0; p.heat = 0; p.switchT = 0;
        p.adsing = pose === 'ads'; a.input.mouse.right = p.adsing;
        const progress = { 'reload-remove': .29, 'reload-exchange': .48, 'reload-insert': .69 }[pose];
        p.reloadT = progress ? definition.reload * (1 - progress) : 0;
        if (progress) p.inv[weapon].mag = Math.floor(definition.mag / 3);
        a.viewmodel.shotT = Infinity; a.viewmodel.kick = 0; a.viewmodel.kickYaw = 0;
        a.recoilPitch = a.recoilYaw = a.shake = 0;
        const context = { weapon, mag: p.inv[weapon].mag, speed: 0, grounded: true,
          ads: p.adsing, lookDX: 0, lookDY: 0, reloadT: p.reloadT, switchT: 0, hide: false };
        for (let i = 0; i < 35; i++) { a.viewmodel.update(.05, context); a.updateCamera(.05, a.getLocalPlayer(), a.renderer.camera); }
        if (pose === 'fire') {
          a.viewmodel.fire(); a.viewmodel.update(.02, context);
          const muzzle = a.viewmodel.muzzleWorld();
          a.effects.muzzle(muzzle.toArray(), [0, 0, -1], weapon === 'shotgun' ? 1.2 : .9, a.viewmodel.model.muzzle);
          a.viewmodel.update = () => {}; a.effects.update = () => {};
        }
        a.viewmodel.root.updateWorldMatrix(true, true);
        const sight = a.viewmodel.model.sight.getWorldPosition(a.viewmodel.model.sight.position.clone()).project(a.renderer.camera);
        return { reloadProgress: progress ?? null, stage: a.viewmodel.reloadStage,
          opticalErrorPixels: [sight.x * innerWidth / 2, sight.y * innerHeight / 2],
          armsReachable: a.viewmodel.arms.map(arm => arm.reachable) };
      }, { weapon, pose, definition: CFG.WEAPONS[weapon] });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const name = `${weapon}-${pose}`;
      await page.screenshot({ path: path.join(out, `${name}.png`) });
      frames.push({ name, fixture: true, ...timing, ...await frameEvidence(page) });
      if (pose === 'ads') checks.push({ name: `${weapon} optical centre aligned`, pass: Math.hypot(...timing.opticalErrorPixels) < 1 });
      checks.push({ name: `${name} hand targets reachable`, pass: timing.armsReachable.every(Boolean) });
      console.log(name, JSON.stringify(timing));
    }
  }
} finally {
  checks.push({ name: 'zero browser errors', pass: errors.length === 0 });
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ rendering: 'SwiftShader software GL', frames, checks, errors }, null, 2));
  await browser.close();
  console.log('Errors:', errors, 'failed checks:', checks.filter(c => !c.pass));
  if (checks.some(c => !c.pass)) process.exitCode = 1;
}
