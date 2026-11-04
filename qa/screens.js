// Browser QA for the current Frontline client.
//
//   node qa/screens.js            # online mode against a server on :3000
//   node qa/screens.js --offline  # offline training mode (no server needed)
//
// Captures screenshots into qa/shots/, reports console errors and measured
// renderer FPS, and asserts HUD/settings/input behaviour against live game
// state. Software GL (SwiftShader) numbers are labelled as such; they are not
// representative of GPU performance.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const OFFLINE = process.argv.includes('--offline');
const BASE = process.env.QA_URL || 'http://127.0.0.1:3000/';
const OUT = path.resolve('qa/shots');
fs.mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  const suffix = detail === undefined ? '' : ` · ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${suffix}`);
}
const near = (a, b, eps = 0.01) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;

function findChromium() {
  const base = path.join(process.env.HOME, '.cache/ms-playwright');
  if (!fs.existsSync(base)) throw new Error('no playwright browsers in ~/.cache/ms-playwright');
  for (const dir of fs.readdirSync(base)) {
    if (!dir.startsWith('chromium')) continue;
    for (const rel of [
      'chrome-linux/chrome',
      'chrome-headless-shell-linux64/chrome-headless-shell',
    ]) {
      const p = path.join(base, dir, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('chromium executable not found');
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: [
    '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-gpu-sandbox',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e && e.stack ? e.stack : e)));

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  console.log('  shot', name);
};
const state = () => page.evaluate(() => {
  const app = window.__frontline;
  if (!app) return null;
  const lp = app.getLocalPlayer?.();
  return {
    mode: app.mode, active: app.active,
    world: !!app.world,
    players: app.mode === 'offline'
      ? app.offlineGame?.players.size ?? 0
      : app.net?.buffer?.snapshots?.length ?? null,
    fps: Math.round(app.renderer?.fps ?? 0),
    drawCalls: app.renderer?.renderer?.info?.render?.calls ?? null,
    tris: app.renderer?.renderer?.info?.render?.triangles ?? null,
    local: lp ? { x: +lp.x.toFixed(1), y: +lp.y.toFixed(1), z: +lp.z.toFixed(1), hp: lp.hp, alive: lp.alive } : null,
    state: app.state ? { mode: app.state.mode, matchState: app.state.matchState } : null,
  };
});

try {
  await page.goto(BASE, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1200);
  await shot('01-lobby');
  check('client booted', await page.evaluate(() => !!window.__frontline));
  check('lobby visible', await page.evaluate(() => !document.getElementById('lobby').classList.contains('hidden')));

  const btn = OFFLINE ? '#battest' : '#join';
  await page.click(btn);
  // World generation takes a moment.
  await page.waitForFunction(() => window.__frontline?.active === true, null, { timeout: 45000 });
  await page.waitForTimeout(2500);
  await shot('02-spawn');
  check('HUD visible after deploy', await page.evaluate(() =>
    !document.getElementById('hud').classList.contains('hidden')));

  // Freeze bot AI in offline mode so HUD assertions are deterministic. Bots
  // stay alive (so the BR match does not end) but stop producing inputs.
  if (OFFLINE) {
    const n = await page.evaluate(() => {
      const g = window.__frontline.offlineGame;
      if (!g) return 0;
      let n = 0;
      for (const p of g.players.values()) if (p.isBot) { p.bot = null; n++; }
      return n;
    });
    check('offline bots frozen for QA', n > 0, { bots: n });
  }

  // Focus the canvas (pointer lock) and look toward the battlefield.
  // Headless pointer lock reports synthetic movement deltas, so aim is set
  // through the same state the real mouse handler writes to.
  const box = await page.locator('#view').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  await page.evaluate(() => { const a = window.__frontline; a.aimPitch = -0.08; a.aimYaw += 0.7; });
  await page.keyboard.down('w');
  await page.waitForTimeout(1400);
  await page.keyboard.up('w');
  await page.waitForTimeout(500);
  await shot('03-walk');

  // ---------------------------------------------------------------- HUD state
  const hud = await page.evaluate(() => {
    const app = window.__frontline;
    const h = app.hud;
    const lp = app.getLocalPlayer();
    const label = { pistol: 'P92', smg: 'VEX-9', ar: 'K4 CARBINE', dmr: 'SABLE DMR', shotgun: 'M12 BREACHER', sniper: 'AX-50', lmg: 'M249 SAW' };
    return {
      hpText: h.hpText.textContent,
      arText: h.arText.textContent,
      magText: h.magText.textContent,
      reserveText: h.reserveText.textContent,
      weaponName: h.weaponName.textContent,
      expectedWeapon: label[lp.weapon] || '—',
      fireMode: h.fireMode.textContent,
      slotNames: h.slots.map(s => s.name.textContent),
      expectedSlots: (lp.weapons || []).map(w => label[w] || (w ? w.toUpperCase() : 'EMPTY')),
      util: [h.grenadeEl, h.smokeEl, h.bandageEl, h.medkitEl].map(e => e.textContent),
      utilCounts: [lp.grenades, lp.smokes, lp.bandages, lp.medkits],
      gap: parseFloat(h.cross.dataset.gap),
      expectedGap: Math.min(70, Math.max(3, (lp.spread ?? 0.02) * 900)),
      compass: [h.compass.width, h.compass.height],
      minimap: [h.minimap.width, h.minimap.height],
      grid: h.mmLabel.textContent,
      zone: h.zoneInfo.textContent,
      state: { hp: Math.round(lp.hp), armor: Math.round(lp.armor), mag: lp.mag, reserve: lp.reserve },
      localTeam: h.localTeam,
      stats: h.stats.textContent,
    };
  });
  check('health bar matches game state', hud.hpText === String(hud.state.hp), { dom: hud.hpText, state: hud.state.hp });
  check('armour bar matches game state', hud.arText === String(hud.state.armor), { dom: hud.arText, state: hud.state.armor });
  check('ammo mag matches game state', hud.magText === String(hud.state.mag), { dom: hud.magText, state: hud.state.mag });
  check('ammo reserve matches game state', hud.reserveText === `/ ${hud.state.reserve}`, { dom: hud.reserveText, state: hud.state.reserve });
  check('weapon name matches equipped weapon', hud.weaponName === hud.expectedWeapon, { dom: hud.weaponName, expected: hud.expectedWeapon });
  check('fire mode rendered', ['AUTO', 'SEMI', ''].includes(hud.fireMode), hud.fireMode);
  check('inventory slot names match weapons', JSON.stringify(hud.slotNames) === JSON.stringify(hud.expectedSlots), hud.slotNames);
  check('utility counters match game state', hud.util.every((t, i) => t.includes(String(hud.utilCounts[i] ?? 0))), { dom: hud.util, state: hud.utilCounts });
  check('crosshair spread matches state spread', near(hud.gap, hud.expectedGap, 0.6), { gap: hud.gap, expected: +hud.expectedGap.toFixed(2) });
  check('compass canvas sized', hud.compass[0] === 620 && hud.compass[1] === 34, hud.compass);
  check('minimap canvas sized', hud.minimap[0] === 220 && hud.minimap[1] === 220, hud.minimap);
  check('minimap grid label', /^GRID [A-H][1-8]$/.test(hud.grid), hud.grid);
  check('zone countdown uses remaining time', /(SHRINKS IN|CLOSING|FINAL ZONE) · \d+s · \d+m/.test(hud.zone), hud.zone);
  check('local team known', Number.isInteger(hud.localTeam), hud.localTeam);

  // ------------------------------------------------------- settings live apply
  const origSettings = await page.evaluate(() => ({ ...window.__frontline.settings }));
  await page.evaluate(() => window.__frontline.hud.toggleSettings(true));
  const applied = await page.evaluate(() => {
    const app = window.__frontline;
    const fire = (id, value, ev = 'input') => {
      const e = document.getElementById(id);
      if (e.type === 'checkbox') e.checked = value; else e.value = value;
      e.dispatchEvent(new Event(ev, { bubbles: true }));
    };
    fire('set-sens', '1.75');
    fire('set-ads-sens', '0.55');
    fire('set-fov', '95');
    fire('set-vol', '0.25');
    fire('set-quality', 'low', 'change');
    fire('set-invert', true, 'change');
    fire('set-shadows', false, 'change');
    fire('set-bloom', false, 'change');
    fire('set-mute', true, 'change');
    const ls = JSON.parse(localStorage.getItem('frontline.settings.v1'));
    return {
      settings: { ...app.settings }, ls,
      fov: app.renderer.camera.fov,
      sens: app.input.sensitivity,
      invert: app.input.invertY,
      pixelRatio: app.renderer.renderer.getPixelRatio(),
      shadows: app.renderer.renderer.shadowMap.enabled,
      bloom: !!app.renderer.composer,
      gain: app.audio.master ? app.audio.master.gain.value : null,
      muted: app.audio.muted,
      textMode: app.input.textMode,
      labels: [app.hud.sensVal.textContent, app.hud.adsVal.textContent, app.hud.fovVal.textContent, app.hud.volVal.textContent],
    };
  });
  check('settings sensitivity applies live', applied.settings.sensitivity === 1.75 && applied.sens >= 1.75, { settings: applied.settings.sensitivity, input: applied.sens });
  check('settings ADS sensitivity applies live', applied.settings.adsSensitivity === 0.55, applied.settings.adsSensitivity);
  check('settings FOV applies live', applied.settings.fov === 95 && near(applied.fov, 95, 0.01), { settings: applied.settings.fov, camera: applied.fov });
  check('settings volume applies live', applied.settings.volume === 0.25 && applied.muted === true && applied.gain === 0, { volume: applied.settings.volume, gain: applied.gain });
  check('settings quality preset applies live', applied.settings.quality === 'low' && near(applied.pixelRatio, 0.85, 0.001) && applied.shadows === false, { quality: applied.settings.quality, pixelRatio: applied.pixelRatio, shadows: applied.shadows });
  check('settings bloom applies live', applied.settings.bloom === false && applied.bloom === false, applied.bloom);
  check('settings invert-Y applies live', applied.settings.invertY === true && applied.invert === true, applied.invert);
  check('settings persist in localStorage', applied.ls.sensitivity === 1.75 && applied.ls.fov === 95 && applied.ls.quality === 'low' && applied.ls.muted === true, applied.ls);
  check('settings labels update live', applied.labels.join('|') === '1.75|0.55|95°|25%', applied.labels);
  check('settings panel suppresses gameplay input', applied.textMode === true, applied.textMode);

  // Cancel must restore the pre-open snapshot.
  const cancelled = await page.evaluate(() => {
    const app = window.__frontline;
    const snapshot = JSON.parse(app.hud._settingsSnapshot);
    const e = document.getElementById('set-sens');
    e.value = '2.90';
    e.dispatchEvent(new Event('input', { bubbles: true }));
    const changed = app.settings.sensitivity;
    document.getElementById('settings-close').click();
    return {
      snapshot: snapshot.sensitivity, changed,
      after: app.settings.sensitivity, open: app.hud.settingsOpen, textMode: app.input.textMode,
    };
  });
  check('settings CANCEL reverts live changes', cancelled.changed === 2.9 && cancelled.after === cancelled.snapshot && cancelled.open === false, cancelled);

  // Restore the original settings before the remaining tests.
  await page.evaluate((orig) => {
    const app = window.__frontline;
    Object.assign(app.settings, orig);
    app.applySettings(app.settings);
    app.hud._syncSettingsInputs();
    app.hud._syncSettingLabels();
  }, origSettings);
  const restored = await page.evaluate(() => ({
    fov: window.__frontline.renderer.camera.fov,
    quality: window.__frontline.settings.quality,
    ls: JSON.parse(localStorage.getItem('frontline.settings.v1')),
  }));
  check('settings restore + persist', restored.quality === origSettings.quality && restored.ls.quality === origSettings.quality, restored);

  // ------------------------------------------------------- input robustness
  const preChat = await page.evaluate(() => {
    const app = window.__frontline;
    const lp = app.getLocalPlayer();
    return {
      x: lp.x, z: lp.z, mag: lp.mag, stance: app.input.stance,
      chatOpen: app.hud.chatOpen, textMode: app.input.textMode,
    };
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const chatOpened = await page.evaluate(() => ({
    chatOpen: window.__frontline.hud.chatOpen,
    textMode: window.__frontline.input.textMode,
    focused: document.activeElement === window.__frontline.hud.chatInput,
  }));
  check('Enter opens chat and focuses input', chatOpened.chatOpen && chatOpened.focused, chatOpened);
  check('chat focus suppresses gameplay input', chatOpened.textMode === true, chatOpened.textMode);

  await page.keyboard.type('wasd c x v 123');
  await page.waitForTimeout(900);
  const typed = await page.evaluate(() => {
    const app = window.__frontline;
    const lp = app.getLocalPlayer();
    return {
      x: lp.x, z: lp.z, mag: lp.mag, stance: app.input.stance,
      keys: app.input.keys.size, left: app.input.mouse.left, right: app.input.mouse.right,
      chatOpen: app.hud.chatOpen, textMode: app.input.textMode,
      value: app.hud.chatInput.value,
    };
  });
  const moved = Math.hypot(typed.x - preChat.x, typed.z - preChat.z);
  check('typing chat never moves the player', moved < 0.05, { moved: +moved.toFixed(4) });
  check('typing chat never registers keys', typed.keys === 0, typed.keys);
  check('typing chat never fires or ADS', typed.left === false && typed.right === false, { left: typed.left, right: typed.right });
  check('typing chat never changes stance', typed.stance === preChat.stance, { before: preChat.stance, after: typed.stance });
  check('typing chat never consumes ammo', typed.mag === preChat.mag, { before: preChat.mag, after: typed.mag });
  check('chat input received the typed text', typed.value === 'wasd c x v 123', typed.value);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const chatClosed = await page.evaluate(() => ({
    chatOpen: window.__frontline.hud.chatOpen,
    textMode: window.__frontline.input.textMode,
  }));
  check('Escape closes chat and restores input', chatClosed.chatOpen === false && chatClosed.textMode === false, chatClosed);

  // OS key repeat must not re-trigger edge actions.
  const repeat = await page.evaluate(() => {
    const app = window.__frontline;
    const before = app.input.stance;
    const fire = (repeat) => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', repeat, bubbles: true }));
    fire(false); fire(true); fire(true);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyC', bubbles: true }));
    const after = app.input.stance;
    app.input.stance = before;
    return { before, after };
  });
  check('key repeat toggles stance exactly once', repeat.after !== repeat.before && repeat.after === (repeat.before === 1 ? 0 : 1), repeat);

  // Blur / tab-out clears every held key and button.
  const blur = await page.evaluate(() => {
    const i = window.__frontline.input;
    i.keys.add('KeyW'); i.keys.add('ShiftLeft');
    i.mouse.left = true; i.mouse.right = true; i.actions.reload = true; i.pendingSlot = 1;
    window.dispatchEvent(new Event('blur'));
    return { keys: i.keys.size, left: i.mouse.left, right: i.mouse.right, reload: i.actions.reload, slot: i.pendingSlot };
  });
  check('tab-out clears held input', blur.keys === 0 && !blur.left && !blur.right && !blur.reload && blur.slot === -1, blur);

  // Pointer-lock loss opens the menu and drops held state.
  await page.evaluate(() => document.exitPointerLock?.());
  await page.waitForTimeout(300);
  const unlock = await page.evaluate(() => {
    const app = window.__frontline;
    app.hadLock = true;
    app.input.keys.add('KeyW'); app.input.mouse.left = true;
    document.dispatchEvent(new Event('pointerlockchange'));
    return { open: app.hud.settingsOpen, keys: app.input.keys.size, left: app.input.mouse.left, textMode: app.input.textMode };
  });
  check('pointer-lock loss opens menu and clears input', unlock.open && unlock.keys === 0 && unlock.left === false && unlock.textMode === true, unlock);
  await page.evaluate(() => { window.__frontline.hud.toggleSettings(false); });
  await page.waitForTimeout(100);

  // Esc opens/closes the menu even without a real pointer lock.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  const escOpen = await page.evaluate(() => ({ open: window.__frontline.hud.settingsOpen, textMode: window.__frontline.input.textMode }));
  check('Esc opens settings', escOpen.open === true && escOpen.textMode === true, escOpen);
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  const escClosed = await page.evaluate(() => ({ open: window.__frontline.hud.settingsOpen, textMode: window.__frontline.input.textMode }));
  check('Esc closes settings', escClosed.open === false && escClosed.textMode === false, escClosed);

  // ------------------------------------------------------------ HUD events
  const feed = await page.evaluate(() => {
    const app = window.__frontline;
    app.handleEvents([
      { k: 'kill', killer: 9001, victim: 9002, kname: 'KillerOne', vname: 'VictimTwo', zone: 'head', team: 1, kteam: 0 },
      { k: 'kill', killer: -1, victim: 9003, vname: 'ZoneVictim', zone: 'torso', team: 0, kteam: -1 },
    ], app.localId);
    const rows = [...document.querySelectorAll('.feed-row')];
    return rows.map(r => ({
      text: r.textContent,
      killer: r.dataset.killer,
      kteam: r.dataset.kteam,
      headshot: r.classList.contains('headshot'),
      killerColor: r.querySelector('.feed-killer')?.style.color,
      victimColor: r.querySelector('.feed-victim')?.style.color,
    }));
  });
  check('kill feed resolves player names (Map bug fixed)', feed.some(r => r.text.includes('KillerOne') && r.text.includes('VictimTwo')), feed.map(r => r.text));
  check('kill feed colours killer by killer team', feed.some(r => r.killer === 'KillerOne' && r.killerColor === 'rgb(90, 169, 255)'), feed.map(r => r.killerColor));
  check('kill feed marks headshots', feed.some(r => r.headshot && r.text.includes('KillerOne')), feed.map(r => r.headshot));
  check('kill feed labels zone kills', feed.some(r => r.killer === 'ZONE'), feed.map(r => r.killer));

  const hit = await page.evaluate(() => {
    const app = window.__frontline;
    app.handleEvents([{ k: 'hit', from: app.localId, to: 9002, dmg: 44, hp: 0, zone: 'head', x: 0, y: 0, z: 0 }], app.localId);
    // Drive one HUD frame deterministically instead of racing the ~10 fps
    // software renderer (the hitmarker has a 0.24 s lifetime).
    app.hud.update(0.016, {
      player: app.getLocalPlayer(), state: app.state, roster: app.rosterForHud(),
      vehicles: [], loot: [], cameraYaw: 0, spectator: null,
    });
    const m = document.querySelector('.hitmarker');
    return { show: m.classList.contains('show'), head: m.classList.contains('head'), kill: m.classList.contains('kill') };
  });
  check('hitmarker shows headshot+kill classes', hit.show && hit.head && hit.kill, hit);

  if (OFFLINE) {
    const arc = await page.evaluate(() => {
      const app = window.__frontline;
      const g = app.offlineGame;
      const bot = [...g.players.values()].find(p => p.isBot);
      const me = g.players.get(app.localId);
      app.aimYaw = 0; me.yaw = 0;
      bot.pos = [me.pos[0] + 10, me.pos[1], me.pos[2]];
      app.handleEvents([{ k: 'hit', from: bot.id, to: me.id, dmg: 10, hp: 90, zone: 'torso' }], me.id);
      const mark = document.querySelector('.dmg-mark');
      return { angle: mark ? parseFloat(mark.dataset.angle) : null, transform: mark?.style.transform };
    });
    check('damage arc points right for a right-side attacker', near(arc.angle, Math.PI / 2, 0.05), arc);

    const low = await page.evaluate(() => {
      const app = window.__frontline;
      const me = app.offlinePlayer;
      me.health = 20;
      const lp = app.getLocalPlayer();
      app.hud.update(0.016, { player: lp, state: app.state, roster: app.rosterForHud(), vehicles: [], loot: [], cameraYaw: 0, spectator: null });
      const shown = document.getElementById('hud').querySelector('.lowhp').classList.contains('show');
      me.health = 100;
      const lp2 = app.getLocalPlayer();
      app.hud.update(0.016, { player: lp2, state: app.state, roster: app.rosterForHud(), vehicles: [], loot: [], cameraYaw: 0, spectator: null });
      return { shown, hiddenAfter: !document.querySelector('.lowhp').classList.contains('show') };
    });
    check('low-health vignette shows and clears', low.shown && low.hiddenAfter, low);

    const zones = await page.evaluate(() => {
      const app = window.__frontline;
      const lp = app.getLocalPlayer();
      const base = app.state;
      const call = (zone) => {
        app.hud.update(0.016, {
          player: lp, state: { ...base, zone }, roster: app.rosterForHud(),
          vehicles: [], loot: [], cameraYaw: 0, spectator: null,
        });
        return { info: app.hud.zoneInfo.textContent, warn: app.hud.zoneWarn.classList.contains('show'), warnText: app.hud.zoneWarn.textContent, closing: app.hud.zoneInfo.classList.contains('closing') };
      };
      const hold = call({ cx: lp.x, cz: lp.z, r: 300, phase: 0, phaseT: 10, shrinking: false, dps: 1, active: true });
      const closing = call({ cx: lp.x + 900, cz: lp.z, r: 300, phase: 0, phaseT: 5, shrinking: true, dps: 1, active: true });
      return { hold, closing };
    });
    check('zone hold shows remaining wait time', /SHRINKS IN · 35s/.test(zones.hold.info) && zones.hold.warn === false, zones.hold);
    check('zone closing shows remaining shrink time + warning', /CLOSING · 35s/.test(zones.closing.info) && zones.closing.warn && /ZONE CLOSING/.test(zones.closing.warnText) && zones.closing.closing, zones.closing);

    const reload = await page.evaluate(() => {
      const app = window.__frontline;
      app.offlinePlayer.reloadT = 1;
      const lp = app.getLocalPlayer();
      app.hud.update(0.016, { player: lp, state: app.state, roster: app.rosterForHud(), vehicles: [], loot: [], cameraYaw: 0, spectator: null });
      const shown = app.hud.reloadTag.classList.contains('show');
      app.offlinePlayer.reloadT = 0;
      const lp2 = app.getLocalPlayer();
      app.hud.update(0.016, { player: lp2, state: app.state, roster: app.rosterForHud(), vehicles: [], loot: [], cameraYaw: 0, spectator: null });
      return { shown, hidden: !app.hud.reloadTag.classList.contains('show') };
    });
    check('reload indicator follows reload timer', reload.shown && reload.hidden, reload);

    const spectate = await page.evaluate(() => {
      const app = window.__frontline;
      const me = app.offlinePlayer;
      me.alive = false;
      app.deadAt = 0; app.spectateT = 0;
      const lp = app.getLocalPlayer();
      app.updateSpectate(0.001, lp);
      app.hud.update(0.016, { player: lp, state: app.state, roster: app.rosterForHud(), vehicles: [], loot: [], cameraYaw: 0, spectator: app.spectatorName() });
      const text = app.hud.center.textContent;
      const shown = app.hud.center.classList.contains('show');
      const id = app.spectateId;
      me.alive = true; me.health = 100;
      app.spectateId = null; app.deadAt = 0; app.spectateT = 0;
      app.updateSpectate(0.001, app.getLocalPlayer());
      return { text, shown, id };
    });
    check('spectate banner names the followed player', spectate.shown && /^SPECTATING .+ · Q NEXT$/.test(spectate.text) && spectate.id !== null, spectate);

    const contacts = await page.evaluate(() => {
      const app = window.__frontline;
      const h = app.hud;
      const roster = [
        { id: app.localId, name: 'Me', team: 0, alive: true },
        { id: 2, name: 'Mate', team: 0, alive: true },
        { id: 3, name: 'Enemy', team: 1, alive: true },
      ];
      h._rosterPos = { [app.localId]: [0, 0, 0], 2: [10, 0, 0], 3: [20, 0, 0] };
      h.localTeam = 0;
      return {
        tdm: h._minimapContacts({ mode: 'tdm' }, roster).map(p => p.id),
        br: h._minimapContacts({ mode: 'br' }, roster).map(p => p.id),
      };
    });
    check('minimap shows living TDM teammates only', JSON.stringify(contacts.tdm) === '[2]', contacts.tdm);
    check('minimap does not reveal BR enemies', contacts.br.length === 0, contacts.br);
  }

  // ------------------------------------------------------------ scoreboard
  const board = await page.evaluate(() => {
    const app = window.__frontline;
    const h = app.hud;
    h.toggleScoreboard(true);
    h.setScoreboard(app.rosterForHud(), app.state?.score, app.state?.mode);
    const headers = [...document.querySelectorAll('.score-row.head span')].map(e => e.textContent);
    const rows = [...document.querySelectorAll('.score-row:not(.head)')];
    const me = document.querySelector('.score-row.me');
    return {
      headers,
      rowCount: rows.length,
      rosterCount: app.rosterForHud().length,
      me: !!me,
      sub: h.scoreSub.textContent,
      teamColor: rows[0]?.children[1]?.style.color,
      ping: rows[0]?.children[5]?.textContent,
      score: rows[0]?.children[4]?.textContent,
    };
  });
  check('scoreboard has K/D/SCORE/PING/team columns', ['PLAYER', 'TEAM', 'K', 'D', 'SCORE', 'PING'].every(x => board.headers.includes(x)), board.headers);
  check('scoreboard lists every player and marks you', board.rowCount === board.rosterCount && board.me, { rows: board.rowCount, roster: board.rosterCount, me: board.me });
  check('scoreboard shows team colours and numeric score/ping', /rgb\(/.test(board.teamColor || '') && /^\d+$/.test(board.score || '') && /^\d+$/.test(board.ping || ''), { color: board.teamColor, score: board.score, ping: board.ping });
  check('scoreboard subtitle shows mode score/alive', board.sub.length > 0, board.sub);
  await shot('08-scoreboard');
  await page.evaluate(() => window.__frontline.hud.toggleScoreboard(false));

  // ---------------------------------------------------------------- end screen
  const end = await page.evaluate(() => {
    const app = window.__frontline;
    app.hud.localTeam = 1;
    app.hud.showEnd({ id: null, team: 1, name: 'Legion' }, app.rosterForHud(), 'tdm', [60, 45]);
    const visible = !document.getElementById('end-panel').classList.contains('hidden');
    const title = document.getElementById('end-title').textContent;
    const sub = document.getElementById('end-sub').textContent;
    const rows = document.querySelectorAll('#end-table .end-row').length;
    app.hud.hideEnd();
    return { visible, title, sub, rows };
  });
  check('end screen shows team victory and scoreline', end.visible && end.title === 'VICTORY' && /60 : 45/.test(end.sub) && end.rows > 0, end);
  await shot('09-end');

  // ----------------------------------------------------------------- audio
  const audio = await page.evaluate(async () => {
    const a = window.__frontline.audio;
    a.resume();
    a.setListener([0, 0, 0], 0);
    const right = a.spatial(10, 0, 0);
    const left = a.spatial(-10, 0, 0);
    for (let i = 0; i < 8; i++) a.shot('ar', 0, 0, 0);
    await new Promise(r => setTimeout(r, 160));
    const lv = a.getLevels();
    const before = a.master ? a.master.gain.value : null;
    a.setMuted(true);
    const muted = a.master ? a.master.gain.value : null;
    a.setMuted(false);
    const unmuted = a.master ? a.master.gain.value : null;
    return {
      rightPan: right.pan, leftPan: left.pan, rightGain: right.gain,
      peak: lv.peak, rms: lv.rms, ctxState: lv.state,
      before, muted, unmuted, volume: a.volume,
    };
  });
  check('spatial audio pans right/left and attenuates', audio.rightPan > 0.8 && audio.leftPan < -0.8 && audio.rightGain > 0.6 && audio.rightGain < 0.75, { rightPan: audio.rightPan, leftPan: audio.leftPan, gain: audio.rightGain });
  check('master limiter keeps peak below clipping', audio.peak <= 1.001, { peak: audio.peak, rms: audio.rms, ctx: audio.ctxState });
  check('mute zeroes master gain and restores', audio.muted === 0 && near(audio.unmuted, audio.volume, 0.001), { muted: audio.muted, unmuted: audio.unmuted });
  check('audio context running after gesture', audio.ctxState === 'running', audio.ctxState);

  // --------------------------------------------------------------- fire/ADS
  await page.evaluate(() => { window.__frontline.input.mouse.left = true; });
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.__frontline.input.mouse.left = false; });
  await page.waitForTimeout(250);
  await shot('04-fire');

  await page.evaluate(() => { window.__frontline.input.mouse.right = true; });
  await page.waitForTimeout(500);
  await shot('05-ads');
  await page.evaluate(() => { window.__frontline.input.mouse.right = false; });
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  await page.waitForTimeout(2200);
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  await shot('06-sprint');

  // Settings overlay.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await shot('07-settings');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  const final = await state();
  console.log('final state:', JSON.stringify(final, null, 2));
  console.log('errors:', errors.length ? errors : 'none');

  const failed = checks.filter(c => !c.ok);
  console.log(`checks: ${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length) console.log('FAILED:', failed.map(f => f.name));
  if (errors.length) process.exitCode = 1;
  if (failed.length) process.exitCode = 1;
} catch (err) {
  console.error('QA harness crashed:', err);
  process.exitCode = 1;
} finally {
  await browser.close();
}

if (errors.length) process.exitCode = 1;
