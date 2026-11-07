// New-kit / launcher / death presentation fixtures through real browser input.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchBrowser, boot, frameEvidence } from './browser.mjs';

const out = process.env.QA_OUT || 'qa/shots/combined-arms'; mkdirSync(out, { recursive: true });
const { browser, page, errors } = await launchBrowser({ quality: process.env.QA_QUALITY || 'high' });
const checks = [], frames = [];
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); console.log(pass ? 'PASS' : 'FAIL', name, detail || ''); };
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const capture = async name => {
  await settle(); await page.screenshot({ path: path.join(out, `${name}.png`) });
  frames.push({ name, fixture: true, ...await frameEvidence(page) });
};
const steps = n => page.evaluate(n => {
  const a = window.__frontline;
  for (let i = 0; i < n; i++) a._qaStep(1 / 60);
  a.buildOfflineState();
}, n);

try {
  await boot(page);
  await page.click('[data-mode="tdm"]'); await page.click('[data-kit="recon"]'); await capture('00-recon-deployment');
  await page.click('[data-kit="heavy"]'); await capture('01-heavy-deployment');
  await page.click('#battest'); await page.waitForFunction(() => window.__frontline?.active);
  check('heavy kit equips support gun and launcher', await page.evaluate(() => window.__frontline.offlinePlayer.weapons.join(',') === 'lmg,rpg'));
  await page.evaluate(() => {
    const a = window.__frontline, g = a.offlineGame, p = a.offlinePlayer;
    a._qaStep = a.stepSim.bind(a); a.stepSim = () => {};
    for (const other of [...g.players.values()]) if (other !== p) g.removePlayer(other.id);
    g.matchState = 2; g.countdown = 0; g.events.length = 0; g.loot.length = 0; a.loot.length = 0;
    p.pos = [20, g.world.terrainHeight(20, -160), -160]; p.vel = [0, 0, 0]; p.grounded = true;
    p.health = 100; p.armor = 50; p.yaw = a.aimYaw = 0; p.pitch = a.aimPitch = 0;
    a.input.clearHeld(); a.buildOfflineState(); a.hud.combat.reset();
  });
  await page.keyboard.press('2'); await steps(45); await capture('02-rpg-hip');
  await page.click('#view'); await page.waitForFunction(() => !!document.pointerLockElement);
  await page.mouse.down({ button: 'right' }); await steps(2); await capture('03-rpg-ads');
  check('RPG sight has its optical centre on target', await page.evaluate(() => {
    const a = window.__frontline, model = a.viewmodel.model;
    for (let i = 0; i < 20; i++) a.viewmodel.update(.05, { weapon: 'rpg', mag: 1, speed: 0, grounded: true, ads: true, lookDX: 0, lookDY: 0, reloadT: 0, switchT: 0 });
    model.root.updateWorldMatrix(true, true);
    const point = model.sight.getWorldPosition(model.sight.position.clone()).project(a.renderer.camera);
    return Math.hypot(point.x * innerWidth / 2, point.y * innerHeight / 2) < 1;
  }));
  await page.mouse.up({ button: 'right' }); await steps(1);
  await page.mouse.down(); await steps(1); await page.mouse.up();
  check('mouse fire launches one authoritative rocket', await page.evaluate(() => window.__frontline.offlineGame.projectiles.filter(p => p.type === 'rocket').length === 1 && window.__frontline.offlinePlayer.inv.rpg.mag === 0));
  await capture('04-rpg-fired');
  await page.keyboard.press('r'); await steps(1);
  for (const [name, ticks] of [['remove', 45], ['load', 54], ['seat', 55], ['ready', 70]]) {
    await steps(ticks); await capture(`05-rpg-reload-${name}`);
  }
  check('one-round reload spends one reserve rocket', await page.evaluate(() => { const i = window.__frontline.offlinePlayer.inv.rpg; return i.mag === 1 && i.reserve === 2; }));
  await page.evaluate(() => {
    const a = window.__frontline, g = a.offlineGame, w = a.world;
    a._target = g.addPlayer('HOSTILE', 1, { connected: false, forceSpawn: { x: 21.3, z: -165 } });
    a._target.pos = [21.3, w.terrainHeight(21.3, -165), -165]; a._target.yaw = Math.PI + .3;
    a.aimYaw = a.offlinePlayer.yaw = -.25; a.aimPitch = a.offlinePlayer.pitch = -.08;
    a.offlinePlayer.giveLoadout([]); g.projectiles.length = 0;
  });
  await capture('06-operator-alive');
  await page.evaluate(() => {
    const a = window.__frontline; a.offlineGame.kill(a._target, a.offlinePlayer.id, 'sniper', 'head', 5);
    a.handleEvents(a.offlineGame.events.splice(0), a.localId);
  });
  for (const [name, age] of [['impact', .16], ['collapse', .58], ['settled', 1.4]]) {
    await page.evaluate(age => {
      const a = window.__frontline, view = a.characters.get(a._target.id);
      view.applyState({ x: a._target.pos[0], y: a._target.pos[1], z: a._target.pos[2], yaw: a._target.yaw, stance: 0,
        alive: false, death: a._target.death, hp: 0 });
      view.update(.001, a.renderer.camera.position.toArray());
      view.deathAnimation.age = age; view.deathAnimation.update(0);
    }, age);
    await capture(`07-death-${name}`);
  }
  check('death animation stays physically collapsed', await page.evaluate(() => {
    const a = window.__frontline, view = a.characters.get(a._target.id);
    const head = view.model.head.getWorldPosition(view.model.head.position.clone());
    return view.deathT >= 1.3 && head.y - a._target.pos[1] < .7;
  }));
  await page.evaluate(() => {
    const a = window.__frontline, g = a.offlineGame;
    const enemy = g.addPlayer('OVERWATCH', 1, { connected: false });
    g.kill(a.offlinePlayer, enemy.id, 'sniper', 'head', 82);
    a.handleEvents(g.events.splice(0), a.localId);
  });
  await steps(1); await capture('08-local-death-card');
  check('death information names the attacker and weapon', await page.evaluate(() => window.__frontline.hud.combat.panel.textContent.includes('OVERWATCH') && window.__frontline.hud.combat.panel.textContent.includes('AX-50')));
  await steps(245); await capture('09-respawn');
  check('respawn restores the selected heavy kit', await page.evaluate(() => window.__frontline.offlinePlayer.alive && window.__frontline.offlinePlayer.weapons.join(',') === 'lmg,rpg'));
  await page.waitForFunction(() => window.__frontline.audio.samples?.hasGroup('core'));
  check('all 110 core SFX decode', await page.evaluate(() => {
    const bank = window.__frontline.audio.samples;
    return bank.errors.length === 0 && bank.buffers.size >= bank.groups.get('core').size;
  }));
  check('sample voice budget stays bounded', await page.evaluate(() => {
    const audio = window.__frontline.audio;
    for (let i = 0; i < 70; i++) audio.playSample('ar-a');
    return audio.voices.size <= audio.budget.limit;
  }));
} catch (error) { check('new journeys completed', false, String(error.stack || error)); }
finally {
  check('zero browser errors', !errors.length, errors);
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ checks, frames, errors, renderer: 'SwiftShader software GL' }, null, 2));
  await browser.close(); if (checks.some(c => !c.pass)) process.exitCode = 1;
}
