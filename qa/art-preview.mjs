// Posed art previews for direct image review. No gameplay acceptance assertions.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchBrowser, boot, frameEvidence } from './browser.mjs';

const out = process.env.QA_OUT || 'qa/shots/coastal-art'; mkdirSync(out, { recursive: true });
const { browser, page, errors } = await launchBrowser({ quality: 'high' });
const frames = [];
const requested = process.env.ART_FRAMES?.split(',');
const waitFrames = (count = 4) => page.evaluate(total => new Promise(resolve => {
  let remaining = total; const frame = () => --remaining ? requestAnimationFrame(frame) : resolve(); requestAnimationFrame(frame);
}), count);
const capture = async name => {
  await waitFrames(4);
  if (requested && !requested.includes(name)) return;
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  const pose = await page.evaluate(() => {
    const vm = window.__frontline.viewmodel;
    return { weapon: vm.weapon, stage: vm.reloadStage, ads: vm.ads,
      roundVisible: vm.weapon === 'rpg' && vm.model.magazine.visible,
      roundPosition: vm.weapon === 'rpg' ? vm.model.magazine.position.toArray() : null,
      armsReachable: vm.arms.map(arm => arm.reachable) };
  });
  frames.push({ name, ...await frameEvidence(page), pose }); console.log('Captured', name);
};

try {
  await boot(page); await page.click('[data-mode="tdm"]'); await page.click('[data-kit="recon"]');
  await capture('01-deployment');
  await page.click('[data-kit="heavy"]'); await page.click('#battest');
  await page.waitForFunction(() => window.__frontline?.active);
  await page.evaluate(() => {
    const a = window.__frontline, g = a.offlineGame, p = a.offlinePlayer;
    a.stepSim = () => {}; g.matchState = 2; g.countdown = 0; g.events.length = 0;
    for (const other of [...g.players.values()]) if (other !== p) g.removePlayer(other.id);
    g.loot.length = 0; a.loot.length = 0;
    p.pos = [88, g.world.terrainHeight(88, -223), -223]; p.vel = [0, 0, 0]; p.grounded = true;
    p.yaw = a.aimYaw = .16; p.pitch = a.aimPitch = -.025; p.curSlot = 1; p.switchT = 0;
    a.input.clearHeld(); a.hud.combat.reset(); a.hud.toast.classList.remove('show');
    a.buildOfflineState(); a._normalVM = a.viewmodel.update.bind(a.viewmodel);
  });
  await capture('02-launcher-checkpoint');
  await page.evaluate(() => {
    const a = window.__frontline, p = a.offlinePlayer;
    p.adsing = true; a.input.mouse.right = true;
    for (let i = 0; i < 35; i++) {
      a.updateCamera(.05, a.getLocalPlayer(), a.renderer.camera);
      a.viewmodel.update(.05, { weapon: 'rpg', mag: 1, speed: 0, grounded: true, ads: true,
        lookDX: 0, lookDY: 0, reloadT: 0, switchT: 0, hide: false });
    }
  });
  await capture('02b-launcher-sight');
  await page.evaluate(() => { const a = window.__frontline; a.offlinePlayer.adsing = false; a.input.mouse.right = false; });
  await page.evaluate(() => { const p = window.__frontline.offlinePlayer; p.reloadT = 1.95; p.inv.rpg.mag = 0; });
  await capture('03-launcher-front-load');
  await page.evaluate(() => { window.__frontline.offlinePlayer.reloadT = .75; });
  await capture('03b-launcher-seated');
  await page.evaluate(() => {
    const a = window.__frontline, p = a.offlinePlayer;
    p.reloadT = 0; p.giveLoadout(['sniper', 'pistol']); p.curSlot = 0;
  });
  await capture('04-sniper-hip');
  await page.evaluate(() => {
    const a = window.__frontline, p = a.offlinePlayer;
    p.adsing = true; a.input.mouse.right = true;
    for (let i = 0; i < 35; i++) {
      a.updateCamera(.05, a.getLocalPlayer(), a.renderer.camera);
      a.viewmodel.update(.05, { weapon: 'sniper', mag: 5, speed: 0, grounded: true, ads: true,
        lookDX: 0, lookDY: 0, reloadT: 0, switchT: 0, hide: false });
    }
  });
  await capture('05-sniper-optic');
  await page.evaluate(() => {
    const a = window.__frontline;
    a.viewmodel.update = (dt, ctx) => { a.viewmodel.shotT = .49 - dt; a._normalVM(dt, ctx); };
  });
  await capture('06-sniper-bolt');
  await page.evaluate(() => {
    const a = window.__frontline, p = a.offlinePlayer, g = a.offlineGame;
    a.viewmodel.update = a._normalVM; a.viewmodel.shotT = Infinity; p.adsing = false; a.input.mouse.right = false;
    p.giveLoadout([]); p.pos = [88, a.world.terrainHeight(88, -221), -221];
    p.yaw = a.aimYaw = .12; p.pitch = a.aimPitch = -.045;
    const actor = g.addPlayer('NORTHLINE', 1, { connected: false });
    actor.pos = [87, a.world.terrainHeight(87, -227), -227]; actor.yaw = Math.PI + .38;
    actor.giveLoadout(['sniper', 'pistol']); a._artActor = actor;
    a.buildOfflineState();
    // Render once so the staged actor's CharacterView exists immediately.
    a.render(0.016);
  });
  // The staged actor's CharacterView is created by the live render loop, so the
  // view must exist before it can be posed. This wait is independent of
  // ART_FRAMES filtering: skipping a capture must not skip the setup.
  await page.waitForFunction(() => {
    const a = window.__frontline;
    return !!a._artActor && a.characters.has(a._artActor.id);
  }, null, { timeout: 10000 });
  await capture('07-operator');
  await page.evaluate(() => {
    const a = window.__frontline;
    a.offlineGame.kill(a._artActor, a.localId, 'sniper', 'head', 6);
    a.handleEvents(a.offlineGame.events.splice(0), a.localId);
    const view = a.characters.get(a._artActor.id);
    view.applyState({ alive: false, x: a._artActor.pos[0], y: a._artActor.pos[1], z: a._artActor.pos[2], death: a._artActor.death });
    view.update(1.4, a.renderer.camera.position.toArray());
  });
  await capture('08-operator-settled');
  await page.evaluate(() => {
    const a = window.__frontline, p = a.offlinePlayer;
    const b = a.world.boxes.find(b => b.tag === 'container' && b.min[0] > 70 && b.min[0] < 85 && b.min[2] < -225 && b.min[2] > -238);
    const x = (b.min[0] + b.max[0]) / 2, z = (b.min[2] + b.max[2]) / 2;
    p.pos = [x + 7, a.world.terrainHeight(x + 7, z + 8), z + 8]; p.yaw = a.aimYaw = .65; p.pitch = a.aimPitch = -.015;
    a._artFXUpdate = a.effects.update.bind(a.effects);
    // Pose a surface impact, not an explosion buried inside opaque cover.
    a.effects.boom({ x: b.max[0] + .08, y: b.min[1] + .35, z: b.max[2] - .35, r: 7, w: 'rpg' });
    a.effects.update(.13); a.effects.update = () => {};
  });
  await capture('09-launcher-impact');
  await page.evaluate(() => window.__frontline._artFXUpdate(.45));
  await capture('10-impact-dust');
  await page.evaluate(() => {
    const a = window.__frontline, g = a.offlineGame;
    a.offlinePlayer.giveLoadout(['rpg', 'pistol']);
    g.kill(a.offlinePlayer, a._artActor.id, 'rpg', 'explosion', 21);
    a.handleEvents(g.events.splice(0), a.localId); a.buildOfflineState();
    // Hold the local death camera mid-fall so the frame shows the weapon drop
    // and the transition rather than the first frame of the collapse.
    if (a.localDeath) a.localDeath.age = .42;
  });
  await waitFrames(10);
  await capture('11-local-death');
} finally {
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ purpose: 'posed art review; gameplay assertions deferred by owner', frames, errors }, null, 2));
  await browser.close(); console.log('Preview errors:', errors);
}
