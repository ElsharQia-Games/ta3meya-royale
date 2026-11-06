// Two-client online QA: roster, remote replication, movement, chat isolation,
// reconnect key, HUD/scoreboard/kill-feed wiring and bandwidth.
//
//   node qa/multiplayer.mjs
//   QA_URL=http://127.0.0.1:3104/ node qa/multiplayer.mjs
//
// Requires a running server (see README). Numbers come from the live client
// and are reported as measured; software GL (SwiftShader) FPS is labelled.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.QA_URL || 'http://127.0.0.1:3000/';
const SHOTS = path.resolve(process.env.QA_OUT || 'qa/shots');
fs.mkdirSync(SHOTS, { recursive: true });

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  const suffix = detail === undefined ? '' : ` · ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${suffix}`);
}

const base = process.env.HOME + '/.cache/ms-playwright';
let exe;
for (const d of fs.readdirSync(base)) {
  if (!d.startsWith('chromium')) continue;
  for (const r of ['chrome-linux/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
    const p = base + '/' + d + '/' + r;
    if (fs.existsSync(p)) exe = p;
  }
}

const ROOM = 'QA' + Math.floor(Math.random() * 9000 + 1000);
// Each client gets its own browser process. Two pages in one browser compete
// for the single software-GL renderer in this environment, which made the
// second page take minutes to become actionable.
const browsers = [];
const launch = () => chromium.launch({
  executablePath: exe,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});
const errors = [];
// Screenshots are diagnostic artifacts, not assertions. A browser can be
// reclaimed by the OS under memory pressure at the very end of a SwiftShader
// run; that must not turn a completed set of checks into a crash.
const shoot = async (page, file) => {
  try {
    await page.screenshot({ path: path.join(SHOTS, file) });
  } catch (err) {
    console.warn(`screenshot ${file} skipped: ${err.message.split('\n')[0]}`);
  }
};
const mk = async (name, viewport = { width: 1280, height: 720 }) => {
  const browser = await launch();
  browsers.push(browser);
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => localStorage.setItem('frontline.settings.v1', JSON.stringify({
    quality: 'low', shadows: false, bloom: false, showFps: true, muted: true, mode: 'br',
  })));
  const p = await ctx.newPage();
  p.setDefaultNavigationTimeout(120000);
  p.setDefaultTimeout(120000);
  p.on('pageerror', (e) => errors.push(name + ': ' + (e.stack || e)));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p.fill('#in-name', name);
  await p.fill('#in-room', ROOM);
  await p.click('#join');
  await p.waitForFunction(() => window.__frontline?.active === true, null, { timeout: 120000 });
  return p;
};

const dump = (p) => p.evaluate(() => {
  const a = window.__frontline;
  const lp = a.getLocalPlayer();
  return {
    id: a.localId,
    mode: a.mode,
    roster: a.roster.map(r => ({ id: r.id, name: r.name, team: r.team, alive: r.alive })),
    remoteViews: [...a.characters.keys()],
    local: lp && { x: +lp.x.toFixed(2), z: +lp.z.toFixed(2), hp: lp.hp, alive: lp.alive },
    snapshots: a.net?.snapshotCount,
    bytesPerSec: Math.round(a.net?.bytesPerSec || 0),
    rtt: Math.round(a.net?.rtt || 0),
    buffer: a.net?.buffer?.frames?.length,
    matchState: a.state?.matchState,
  };
});

try {
  // Alpha keeps a full-size viewport for screenshots. Bravo uses a smaller one:
  // under SwiftShader the 3D scene is CPU-bound, and a 640x360 surface lets the
  // move/chat/reconnect scenarios finish at a usable frame rate.
  const A = await mk('Alpha');
  await A.waitForTimeout(800);
  const B = await mk('Bravo', { width: 640, height: 360 });
  await Promise.all([A, B].map(p => p.waitForFunction(() => window.__frontline?.state?.matchState === 2, null, { timeout: 120000 })));
  await A.waitForTimeout(2500);
  await B.waitForTimeout(1200);

  const a0 = await dump(A);
  const b0 = await dump(B);
  console.log('A after join:', JSON.stringify(a0));
  console.log('B after join:', JSON.stringify(b0));

  check('both clients joined online', a0.mode === 'online' && b0.mode === 'online' && a0.id !== b0.id, { a: a0.id, b: b0.id });
  check('roster contains both players', a0.roster.some(p => p.id === b0.id) && b0.roster.some(p => p.id === a0.id), { a: a0.roster.length, b: b0.roster.length });
  check('remote character view replicated', a0.remoteViews.includes(b0.id) && b0.remoteViews.includes(a0.id), { a: a0.remoteViews, b: b0.remoteViews });
  check('match state is live', a0.matchState === 2 && b0.matchState === 2, { a: a0.matchState, b: b0.matchState });

  // -------------------------------------------------------- remote movement
  // Walk B in whichever direction is not blocked by nearby geometry; spawn
  // points can face a wall, so try a few headings until one produces motion.
  // Poll the simulated position instead of assuming a wall-clock duration: the
  // software renderer can deliver only a couple of frames per second, and the
  // sim advances a bounded amount per frame.
  const readLocal = () => B.evaluate(() => {
    const l = window.__frontline.getLocalPlayer();
    return { x: l.x, z: l.z, alive: l.alive };
  });
  const ensureAlive = async () => {
    if ((await readLocal()).alive) return true;
    try {
      await B.waitForFunction(
        () => window.__frontline.getLocalPlayer()?.alive === true, null, { timeout: 5000 },
      );
      return true;
    } catch {
      return false;
    }
  };
  await B.bringToFront();
  await B.waitForTimeout(300);
  // BR has no respawn, so run this probe early and never count a death/respawn
  // teleport as movement. Use BOTS=0 on the QA server when a deterministic
  // movement measurement matters more than exercising bot combat.
  let moved = 0;
  let bStart = null;
  let bEnd = null;
  let bAlive = await ensureAlive();
  const headings = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  if (bAlive) {
    search: for (let pass = 0; pass < 2; pass++) {
      for (const yaw of headings) {
        await B.evaluate((y) => { window.__frontline.aimYaw = y; }, yaw);
        const start = await readLocal();
        if (!start.alive) {
          if (!(await ensureAlive())) { bAlive = false; break search; }
          continue;
        }
        bStart = [start.x, start.z];
        let died = false;
        await B.keyboard.down('w');
        for (let i = 0; i < 12; i++) {
          await B.waitForTimeout(1000);
          const now = await readLocal();
          if (!now.alive) { died = true; break; }
          bEnd = [now.x, now.z];
          moved = Math.hypot(bEnd[0] - bStart[0], bEnd[1] - bStart[1]);
          if (moved > 1) break;
        }
        await B.keyboard.up('w');
        await B.waitForTimeout(300);
        const end = await readLocal();
        if (!end.alive) died = true;
        if (!died) {
          bEnd = [end.x, end.z];
          moved = Math.hypot(bEnd[0] - bStart[0], bEnd[1] - bStart[1]);
          if (moved > 0.5) break search;
        } else if (!(await ensureAlive())) {
          bAlive = false;
          break search;
        }
      }
    }
  }
  const aSeesB = await A.evaluate((id) => {
    const p = window.__frontline.net.cache.get(id);
    return p ? { x: +p.x.toFixed(2), z: +p.z.toFixed(2) } : null;
  }, b0.id);
  const startDetail = bStart ? bStart.map(v => +v.toFixed(2)) : null;
  const endDetail = bEnd ? bEnd.map(v => +v.toFixed(2)) : null;
  check('B movement simulated locally', bAlive && moved > 0.5, { from: startDetail, to: endDetail, moved: +moved.toFixed(2), alive: bAlive });
  check('A receives B position over the wire', !!aSeesB && !!bEnd && Math.hypot(aSeesB.x - bEnd[0], aSeesB.z - bEnd[1]) < 4, { aSeesB, bEnd: endDetail });


  // ---------------------------------------------------------------- HUD online
  await A.bringToFront();
  await A.waitForTimeout(500);
  const hud = await A.evaluate(() => {
    const app = window.__frontline;
    const h = app.hud;
    const lp = app.getLocalPlayer();
    const label = { pistol: 'P92', smg: 'VEX-9', ar: 'K4 CARBINE', dmr: 'SABLE DMR', shotgun: 'M12 BREACHER', sniper: 'AX-50', lmg: 'M249 SAW' };
    return {
      hpText: h.hpText.textContent, arText: h.arText.textContent,
      magText: h.magText.textContent, reserveText: h.reserveText.textContent,
      weaponName: h.weaponName.textContent, expectedWeapon: label[lp.weapon] || '—',
      gap: parseFloat(h.cross.dataset.gap),
      expectedGap: Math.min(70, Math.max(3, (lp.spread ?? 0.02) * 900)),
      compass: [h.compass.width, h.compass.height],
      minimap: [h.minimap.width, h.minimap.height],
      grid: h.mmLabel.textContent,
      zone: h.zoneInfo.textContent,
      localTeam: h.localTeam,
      stats: h.stats.textContent,
      state: { hp: Math.round(lp.hp), armor: Math.round(lp.armor), mag: lp.mag, reserve: lp.reserve },
    };
  });
  check('online health/armour match local snapshot', hud.hpText === String(hud.state.hp) && hud.arText === String(hud.state.armor), { dom: [hud.hpText, hud.arText], state: hud.state });
  check('online ammo matches local snapshot', hud.magText === String(hud.state.mag) && hud.reserveText === `/ ${hud.state.reserve}`, { mag: hud.magText, reserve: hud.reserveText, state: hud.state });
  check('online weapon name matches equipped weapon', hud.weaponName === hud.expectedWeapon, { dom: hud.weaponName, expected: hud.expectedWeapon });
  check('online crosshair spread matches predicted spread', Math.abs(hud.gap - hud.expectedGap) <= 0.6, { gap: hud.gap, expected: +hud.expectedGap.toFixed(2) });
  check('online compass/minimap sized', hud.compass[0] === 620 && hud.minimap[0] === 220, { compass: hud.compass, minimap: hud.minimap });
  check('online minimap grid + zone countdown', /^GRID [A-H][1-8]$/.test(hud.grid) && /(SHRINKS IN|CLOSING|FINAL ZONE) · \d+s · \d+m/.test(hud.zone), { grid: hud.grid, zone: hud.zone });
  check('online local team known', Number.isInteger(hud.localTeam), hud.localTeam);
  check('online FPS stat rendered', /FPS/.test(hud.stats) && /\d+/.test(hud.stats), hud.stats);

  // ------------------------------------------------------- scoreboard (Tab)
  await A.keyboard.down('Tab');
  await A.waitForTimeout(400);
  const board = await A.evaluate(() => {
    const app = window.__frontline;
    const h = app.hud;
    h.setScoreboard(app.rosterForHud(), app.state?.score, app.state?.mode);
    const headers = [...document.querySelectorAll('.score-row.head span')].map(e => e.textContent);
    const rows = [...document.querySelectorAll('.score-row:not(.head)')];
    const me = document.querySelector('.score-row.me');
    return {
      open: h.scoreboardOpen,
      headers, rowCount: rows.length, rosterCount: app.rosterForHud().length,
      me: !!me,
      teamColor: rows[0]?.children[1]?.style.color,
      score: rows[0]?.children[4]?.textContent,
      ping: rows[0]?.children[5]?.textContent,
      sub: h.scoreSub.textContent,
    };
  });
  await shoot(A, 'mp-scoreboard.png');
  await A.keyboard.up('Tab');
  await A.waitForTimeout(200);
  check('Tab opens scoreboard', board.open === true, board.open);
  check('scoreboard has K/D/SCORE/PING/team columns', ['PLAYER', 'TEAM', 'K', 'D', 'SCORE', 'PING'].every(x => board.headers.includes(x)), board.headers);
  check('scoreboard lists every online player and marks you', board.rowCount === board.rosterCount && board.me, { rows: board.rowCount, roster: board.rosterCount, me: board.me });
  check('scoreboard shows team colour + numeric score/ping', /rgb\(/.test(board.teamColor || '') && /^\d+$/.test(board.score || '') && /^\d+$/.test(board.ping || ''), { color: board.teamColor, score: board.score, ping: board.ping });
  check('scoreboard subtitle shows mode/alive', board.sub.length > 0, board.sub);

  // ------------------------------------------------------------- kill feed
  const feed = await A.evaluate(() => {
    const app = window.__frontline;
    app.handleEvents([
      { k: 'kill', killer: 9001, victim: 9002, kname: 'KillerOne', vname: 'VictimTwo', zone: 'head', team: 1, kteam: 0 },
      { k: 'kill', killer: -1, victim: 9003, vname: 'ZoneVictim', zone: 'torso', team: 0, kteam: -1 },
    ], app.localId);
    const rows = [...document.querySelectorAll('.feed-row')];
    return rows.map(r => ({
      text: r.textContent, killer: r.dataset.killer,
      headshot: r.classList.contains('headshot'),
      killerColor: r.querySelector('.feed-killer')?.style.color,
    }));
  });
  check('online kill feed resolves names', feed.some(r => r.text.includes('KillerOne') && r.text.includes('VictimTwo')), feed.map(r => r.text));
  check('online kill feed team colours + headshot + zone kill', feed.some(r => r.killer === 'KillerOne' && r.killerColor === 'rgb(90, 169, 255)' && r.headshot) && feed.some(r => r.killer === 'ZONE'), feed);

  // ----------------------------------------- chat typing must not play the game
  // Let residual velocity settle, then drop it so the only possible source of
  // movement is gameplay input leaking through the chat box.
  await B.waitForTimeout(1200);
  await B.evaluate(() => { const lp = window.__frontline.getLocalPlayer(); lp.vx = 0; lp.vz = 0; });
  const beforeChat = await B.evaluate(() => {
    const app = window.__frontline;
    const lp = app.getLocalPlayer();
    return { x: lp.x, z: lp.z, mag: lp.mag, stance: app.input.stance };
  });
  await B.keyboard.press('Enter');
  await B.waitForTimeout(250);
  const chatOpen = await B.evaluate(() => ({
    open: window.__frontline.hud.chatOpen,
    textMode: window.__frontline.input.textMode,
    focused: document.activeElement === window.__frontline.hud.chatInput,
  }));
  check('Enter opens chat online and focuses input', chatOpen.open && chatOpen.focused && chatOpen.textMode, chatOpen);

  await B.keyboard.type('wasd xcv 123');
  await B.waitForTimeout(900);
  const typed = await B.evaluate(() => {
    const app = window.__frontline;
    const lp = app.getLocalPlayer();
    return {
      x: lp.x, z: lp.z, mag: lp.mag, stance: app.input.stance,
      keys: app.input.keys.size, left: app.input.mouse.left, right: app.input.mouse.right,
      value: app.hud.chatInput.value, open: app.hud.chatOpen,
    };
  });
  const movedTyping = Math.hypot(typed.x - beforeChat.x, typed.z - beforeChat.z);
  check('typing chat never moves/shoots/stances online', movedTyping < 0.5 && typed.keys === 0 && typed.left === false && typed.right === false && typed.stance === beforeChat.stance && typed.mag === beforeChat.mag, { moved: +movedTyping.toFixed(4), keys: typed.keys, left: typed.left, right: typed.right, mag: typed.mag });
  check('chat input received typed text', typed.value === 'wasd xcv 123' && typed.open, typed.value);

  await B.keyboard.press('Enter');
  await A.waitForTimeout(700);
  const chat = await A.evaluate(() => [...document.querySelectorAll('.chat-row')].map(e => e.textContent));
  const chatClosed = await B.evaluate(() => ({ open: window.__frontline.hud.chatOpen, textMode: window.__frontline.input.textMode }));
  check('chat message round-trips to the other client', chat.some(t => t.includes('wasd xcv 123')), chat);
  check('sending chat restores gameplay input', chatClosed.open === false && chatClosed.textMode === false, chatClosed);

  // ----------------------------------------------------------- reconnect key
  await B.evaluate(() => {
    const app = window.__frontline;
    window.__forceCount = 0;
    const orig = app.forceReconnect.bind(app);
    app.forceReconnect = () => { window.__forceCount++; return orig(); };
    app.net.ws.close();
  });
  await B.waitForFunction(() => !window.__frontline.net.connected, null, { timeout: 5000, polling: 100 });
  await B.keyboard.press('p');
  let reState = null;
  for (let i = 0; i < 30; i++) {
    await B.waitForTimeout(500);
    reState = await B.evaluate(() => ({
      id: window.__frontline.localId,
      connected: !!window.__frontline.net?.connected,
      joined: !!window.__frontline.net?.joined,
      forceCount: window.__forceCount,
      timer: !!window.__frontline.net?.reconnectTimer,
      chatOpen: window.__frontline.hud.chatOpen,
      settingsOpen: window.__frontline.hud.settingsOpen,
      textMode: window.__frontline.input.textMode,
    }));
    if (reState.joined && reState.id === b0.id) break;
  }
  const bRe = await dump(B);
  const forceCount = reState?.forceCount ?? 0;
  console.log('reconnect state:', JSON.stringify(reState));
  check('P invokes reconnect while disconnected', forceCount >= 1, forceCount);
  check('reconnect preserves the player id', bRe.id === b0.id && bRe.mode === 'online', { before: b0.id, after: bRe.id });

  // ------------------------------------------------------------ bandwidth
  await A.waitForTimeout(2500);
  const aSteady = await dump(A);
  console.log('A steady:', JSON.stringify(aSteady));
  console.log('B steady:', JSON.stringify(await dump(B)));
  check('server snapshots are flowing', (aSteady.snapshots || 0) > 0 && (aSteady.bytesPerSec || 0) > 0, { snapshots: aSteady.snapshots, bytesPerSec: aSteady.bytesPerSec });

  await A.bringToFront();
  await A.waitForTimeout(300);
  await shoot(A, 'mp-alpha.png');
  await B.bringToFront();
  await B.waitForTimeout(300);
  await shoot(B, 'mp-bravo.png');

  const failed = checks.filter(c => !c.ok);
  console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');
  console.log(`checks: ${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length) console.log('FAILED:', failed.map(f => f.name));
  if (errors.length || failed.length) process.exitCode = 1;
} catch (err) {
  console.error('multiplayer QA crashed:', err);
  process.exitCode = 1;
} finally {
  for (const browser of browsers) await browser.close();
}
