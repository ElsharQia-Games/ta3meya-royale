// Browser player journeys through production Input/App/Game. Setup, damage and
// world placements are explicit fixtures; simulation advances deterministically.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CFG } from '../shared/config.js';
import { launchBrowser, boot, frameEvidence } from './browser.mjs';

const out = process.env.QA_OUT || 'qa/shots/journeys'; mkdirSync(out, { recursive: true });
const { browser, page, errors } = await launchBrowser({ width: 1280, height: 720, quality: 'low' });
const checks = [], frames = [];
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); console.log(pass ? 'PASS' : 'FAIL', name, detail ?? ''); };
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const capture = async name => { await settle(); await page.screenshot({ path: path.join(out, `${name}.png`) }); frames.push({ name, fixture: true, ...await frameEvidence(page) }); };
const steps = n => page.evaluate(n => {
  const a = window.__frontline;
  for (let i = 0; i < n; i++) a._journeyStep(1 / 60);
  a.buildOfflineState(); a.syncOfflineLoot();
}, n);
const status = () => page.evaluate(() => {
  const a = window.__frontline, p = a.offlinePlayer;
  return { pos: p.pos.slice(), alive: p.alive, hp: p.health, stance: p.stance, reload: p.reloadT,
    weapon: p.curWeapon(), mag: p.inv[p.curWeapon()]?.mag, reserve: p.inv[p.curWeapon()]?.reserve,
    shots: p.shotsFired || 0, heal: p.healT, grenades: p.grenades, smokes: p.smokes,
    mode: a.state.mode, match: a.state.matchState, spectator: a.spectateId };
});

async function training(mode) {
  await boot(page);
  await page.click(`[data-mode="${mode}"]`); await page.click('#battest');
  await page.waitForFunction(() => window.__frontline?.active);
  await page.evaluate(() => {
    const a = window.__frontline, g = a.offlineGame, p = a.offlinePlayer;
    a._journeyStep = a.stepSim.bind(a); a.stepSim = () => {};
    g.matchState = 2; g.countdown = 0;
    for (const other of [...g.players.values()]) if (other !== p) g.removePlayer(other.id);
    g.loot.length = 0; g.vehicles.length = 0; a.loot.length = 0;
    p.pos = [20, a.world.terrainHeight(20, -160), -160]; p.vel = [0, 0, 0];
    p.health = 100; p.armor = 0; p.alive = true; p.grounded = true; p.stance = 0;
    p.yaw = a.aimYaw = 0; p.pitch = a.aimPitch = 0;
    a.input.clearHeld(); a.hadLock = false; a.syncInputMode(); a.buildOfflineState();
  });
}

try {
  await boot(page);
  check('deployment fits desktop width', await page.evaluate(() => document.getElementById('lobby').scrollWidth <= innerWidth + 1));
  await page.click('#nav-manual'); await page.keyboard.press('Tab');
  check('manual keeps keyboard focus inside the dialog', await page.evaluate(() => document.getElementById('manual-panel').contains(document.activeElement)));
  await capture('00-manual-keyboard'); await page.keyboard.press('Escape');
  check('Escape closes the field manual', await page.locator('#manual-panel').evaluate(el => el.classList.contains('hidden')));
  await page.click('#nav-settings');
  check('settings focuses a control', await page.evaluate(() => document.getElementById('settings-panel').contains(document.activeElement)));
  await capture('01-lobby-settings'); await page.click('#settings-close');

  await training('tdm');
  check('training deploys into TDM', (await status()).mode === 'tdm');
  let before = await status();
  await page.keyboard.down('w'); await steps(60); await page.keyboard.up('w');
  let after = await status();
  check('W moves through the controller', Math.hypot(after.pos[0] - before.pos[0], after.pos[2] - before.pos[2]) > 3, { before: before.pos, after: after.pos });
  for (const [key, stance] of [['c', 1], ['x', 2], ['v', 0]]) {
    await page.keyboard.press(key); await steps(15);
    check(`${key.toUpperCase()} selects stance ${stance}`, (await status()).stance === stance);
  }
  before = await status(); await page.keyboard.down('Space'); await steps(5); await page.keyboard.up('Space');
  after = await status(); check('Space jumps', after.pos[1] > before.pos[1] + .25);
  await steps(90);

  // The browser must deliver real mouse button events to Input.
  await page.click('#view'); await page.waitForFunction(() => !!document.pointerLockElement);
  check('canvas acquires pointer lock', true);
  for (const weapon of CFG.WEAPON_ORDER) {
    await page.evaluate(weapon => {
      const a = window.__frontline, p = a.offlinePlayer;
      p.giveLoadout([weapon, weapon === 'pistol' ? 'ar' : 'pistol']);
      p.reloadT = 0; p.cooldown = 0; p.prevShoot = false;
      a.localFireT = 0; a.prevShoot = false; a.input.clearHeld();
      p.yaw = a.aimYaw = 0; p.pitch = a.aimPitch = 0;
    }, weapon);
    before = await status();
    await page.mouse.down(); await steps(24); await page.mouse.up();
    after = await status();
    check(`${weapon} mouse fire consumes authoritative ammo`, after.mag < before.mag && after.shots > before.shots, { before: before.mag, after: after.mag });
    await page.keyboard.press('r'); await steps(1);
    before = await status();
    check(`${weapon} R starts reload`, before.reload > 0);
    await page.mouse.down(); await steps(5); await page.mouse.up();
    check(`${weapon} reload blocks firing`, before.reload > 0 && (await status()).shots === before.shots);
    await steps(Math.ceil(CFG.WEAPONS[weapon].reload * 60) + 2);
    after = await status();
    check(`${weapon} reload fills magazine from reserve`, after.mag === CFG.WEAPONS[weapon].mag && after.reserve < before.reserve);
  }
  await page.mouse.down({ button: 'right' }); await steps(1); await settle();
  check('RMB engages ADS and hides generic crosshair', await page.evaluate(() => window.__frontline.offlinePlayer.adsing && window.__frontline.hud.cross.classList.contains('hidden')));
  await page.mouse.up({ button: 'right' }); await steps(1);

  await page.evaluate(() => {
    const a = window.__frontline, p = a.offlinePlayer, g = a.offlineGame;
    p.giveLoadout(['ar', 'pistol']); p.inv.ar.reserve = 20;
    g.loot.push({ id: g.nextId++, type: 'ammo', weapon: 'ar', amount: 30, x: p.pos[0] + .4, y: p.pos[1] + .05, z: p.pos[2] });
    a.syncOfflineLoot();
  });
  await settle(); check('nearby usable loot has an interaction prompt', await page.evaluate(() => window.__frontline.interactionPrompt(window.__frontline.getLocalPlayer()).includes('PICK UP')));
  await page.keyboard.press('e'); await steps(1);
  check('E collects ammo and removes the world item', await page.evaluate(() => window.__frontline.offlinePlayer.inv.ar.reserve === 50 && window.__frontline.loot.length === 0));
  await page.evaluate(() => { const a = window.__frontline; a.offlinePlayer.health = 40; a.offlinePlayer.bandages = 1; a.offlinePlayer.lastDamageAt = a.offlineGame.time; });
  await page.keyboard.press('f'); await steps(1);
  check('F begins a timed heal', (await status()).heal > 0);
  await capture('02-healing'); await steps(125);
  check('heal grants health on completion', Math.round((await status()).hp) === 60);

  await page.evaluate(() => { const p = window.__frontline.offlinePlayer; p.grenades = 1; p.smokes = 1; p.cooldown = 0; });
  await page.keyboard.press('g'); await steps(1);
  check('G throws a frag and consumes inventory', await page.evaluate(() => { const a = window.__frontline; return a.offlinePlayer.grenades === 0 && a.offlineGame.projectiles.some(p => p.type === 'grenade'); }));
  await steps(205);
  check('frag fuse produces a blast effect', await page.evaluate(() => window.__frontline.effects.explosions.length > 0));
  await page.keyboard.press('t'); await steps(1);
  check('T throws a smoke canister', (await status()).smokes === 0);
  await steps(126);
  check('smoke deploys into authoritative and rendered state', await page.evaluate(() => window.__frontline.offlineGame.smokes.length > 0 && window.__frontline.effects.smokeGroups.size > 0));
  await capture('03-smoke');

  // A one-HP cover fixture lets real input/ballistics exercise destruction.
  await page.evaluate(() => {
    const a = window.__frontline, g = a.offlineGame, p = a.offlinePlayer;
    const b = g.world.boxes.find(b => b.dynamic && b.maxHp > 0);
    g.projectiles.length = 0; g.smokes.length = 0; b.hp = 1; b.destroyed = false;
    g.destroyedBoxes.delete(b.id); a.worldView.syncDestruction([...g.destroyedBoxes]);
    p.pos = [b.min[0] - 3, b.min[1], (b.min[2] + b.max[2]) / 2]; p.vel = [0, 0, 0];
    p.giveLoadout(['ar', 'pistol']); p.cooldown = 0; p.reloadT = 0; p.alive = true; p.health = 100;
    a.aimYaw = -Math.PI / 2; a.aimPitch = Math.atan2((b.max[1] - b.min[1]) / 2 - p.eyeHeight(), 3);
    a.input.clearHeld(); a._coverId = b.id; a._coverShots = p.shotsFired || 0; a.localFireT = 0; a.prevShoot = false;
  });
  await page.mouse.down(); await steps(36); await page.mouse.up();
  check('gunfire destroys cover and updates render/prediction collision', await page.evaluate(() => {
    const a = window.__frontline; return a.offlinePlayer.shotsFired > a._coverShots && a.offlineGame.destroyedBoxes.has(a._coverId) && a.world.boxes[a._coverId].destroyed && !a.worldView.dynamicMeshes.has(a._coverId);
  }));
  await capture('04-destruction');

  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__frontline.hud.chatOpen);
  before = await status(); await page.keyboard.type('WASD field check'); await steps(30);
  after = await status(); check('typing chat does not move or fire', Math.hypot(...after.pos.map((n, i) => n - before.pos[i])) < .2 && after.shots === before.shots);
  await page.keyboard.press('Enter');
  check('training chat appears locally', await page.evaluate(() => window.__frontline.hud.chatLog.textContent.includes('WASD field check')));
  await capture('05-chat');
  await page.keyboard.press('Escape'); await page.waitForFunction(() => window.__frontline.hud.settingsOpen);
  before = await status(); await page.keyboard.down('w'); await steps(30); await page.keyboard.up('w');
  after = await status(); check('settings suppresses movement input', Math.hypot(...after.pos.map((n, i) => n - before.pos[i])) < .2);
  await page.click('#settings-close');
  await page.keyboard.down('Tab'); await capture('06-scoreboard'); await page.keyboard.up('Tab');
  check('scoreboard closes on Tab release', await page.evaluate(() => !window.__frontline.hud.scoreboardOpen));

  await page.evaluate(() => { const a = window.__frontline; a.offlineGame.kill(a.offlinePlayer, -1, 'fixture'); });
  await steps(1); await capture('07-tdm-death');
  check('TDM death exposes respawn countdown', await page.evaluate(() => !window.__frontline.offlinePlayer.alive && window.__frontline.hud.respawn.textContent.includes('RESPAWN')));
  await steps(245); check('TDM respawns with a fresh loadout', (await status()).alive && (await status()).mag === 30);
  await page.evaluate(() => { window.__frontline.offlineGame.score[0] = 60; }); await steps(1); await capture('08-tdm-end');
  check('TDM score limit opens the end screen', await page.evaluate(() => window.__frontline.endShown));
  await page.locator('#end-panel .btn.primary').click(); await steps(1);
  check('restart restores cover and round state', await page.evaluate(() => { const a = window.__frontline; return a.offlineGame.matchState === 1 && !a.world.boxes[a._coverId].destroyed && a.worldView.dynamicMeshes.has(a._coverId); }));

  await page.goto(process.env.QA_URL || 'http://127.0.0.1:3300/');
  await training('br');
  await page.evaluate(() => {
    const a = window.__frontline, g = a.offlineGame;
    g.addPlayer('Lead', 0); g.addPlayer('Wing', 0); g.kill(a.offlinePlayer, -1, 'fixture');
  });
  await steps(1); await capture('09-br-spectate');
  check('BR elimination spectates a living operator', (await status()).spectator !== null && !(await status()).alive);
  await page.evaluate(() => { const a = window.__frontline, others = [...a.offlineGame.players.values()].filter(p => p.alive); a.offlineGame.kill(others[0], others[1].id, 'fixture'); });
  await steps(1); await capture('10-br-end');
  check('BR ends with one survivor', (await status()).match === 3);

  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page); await capture('11-narrow-deployment');
  check('narrow deployment has no horizontal overflow', await page.evaluate(() => document.getElementById('lobby').scrollWidth <= innerWidth + 1));
  await page.locator('#join').scrollIntoViewIfNeeded(); await capture('12-narrow-deploy-controls');
  check('narrow deployment controls remain reachable', await page.locator('#join').isVisible());
} catch (error) {
  check('journey execution completed', false, String(error.stack || error));
} finally {
  check('zero browser errors', errors.length === 0, errors);
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ rendering: 'SwiftShader software GL',
    method: 'real browser input; labelled setup and deterministic simulation stepping', checks, frames, errors }, null, 2));
  await browser.close();
  if (checks.some(c => !c.pass)) process.exitCode = 1;
}
