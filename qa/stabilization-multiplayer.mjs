// Two-client Phase 4 stabilization QA.
//
//   PORT=3311 BOTS=0 node server/server.js
//   QA_URL=http://127.0.0.1:3311/ node qa/stabilization-multiplayer.mjs
//
// Exercises real authoritative RPG launches next to destructible glass, near/
// far shot delivery, dry-fire duplication, vehicle-destruction duplication,
// reload layering, and records client rAF intervals plus server tick
// percentiles from /stats. SwiftShader frame times are relative, not a hardware
// GPU claim.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.QA_URL || 'http://127.0.0.1:3300/';
const OUT = path.resolve(process.env.QA_OUT || 'qa/shots/stabilization-mp');
const REPORT = process.env.QA_REPORT || 'qa/reports/stabilization-mp.json';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.dirname(REPORT), { recursive: true });

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` · ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

const cache = process.env.HOME + '/.cache/ms-playwright';
let exe;
for (const d of fs.readdirSync(cache)) {
  if (!d.startsWith('chromium')) continue;
  for (const r of ['chrome-linux/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
    const p = path.join(cache, d, r);
    if (fs.existsSync(p)) exe = p;
  }
}

const ROOM = 'STAB' + Math.floor(Math.random() * 9000 + 1000);
const browsers = [];
const errors = [];
const launch = () => chromium.launch({
  executablePath: exe,
  args: [
    '--no-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required',
  ],
});

async function openClient(name) {
  const browser = await launch();
  browsers.push(browser);
  const ctx = await browser.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => localStorage.setItem('frontline.settings.v1', JSON.stringify({
    quality: 'low', shadows: false, bloom: false, showFps: false, muted: true, mode: 'tdm', kit: 'heavy',
  })));
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);
  page.on('pageerror', e => errors.push(`${name}: ${e.stack || e}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.click('[data-mode="tdm"]').catch(() => {});
  await page.click('[data-kit="heavy"]').catch(() => {});
  await page.fill('#in-name', name);
  await page.fill('#in-room', ROOM);
  // The lobby defaults to ws://localhost:3000/ws; the QA server intentionally
  // runs on another port, so point the client at the same origin as the page.
  const ws = new URL(BASE);
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
  ws.pathname = '/ws'; ws.search = ''; ws.hash = '';
  await page.fill('#in-server', ws.toString());
  await page.click('#join');
  await page.waitForFunction(() => window.__frontline?.active === true, null, { timeout: 120000 });
  await page.waitForFunction(() => window.__frontline?.state?.matchState === 2, null, { timeout: 120000 });
  await page.waitForFunction(() => window.__frontline?.audio?.samples?.hasGroup('core'), null, { timeout: 120000 });
  await installProbes(page);
  return page;
}

async function installProbes(page) {
  await page.evaluate(() => {
    const app = window.__frontline;
    const qa = window.__qaStab = {
      frames: [], frameWork: [], frameStart: 0, plays: [], dryFireCalls: 0, vehicleDestroyPlays: 0,
      localShots: 0, song: null,
    };
    // rAF interval includes software-GL presentation wait; the work sample is
    // the executable frame body (tick + render submission) and is the number
    // that actually competes with the 16.7 ms budget on real hardware.
    const frame = app.frame.bind(app);
    app.frame = (now) => {
      const start = performance.now();
      frame(now);
      qa.frameWork.push(performance.now() - start);
    };
    let last = performance.now();
    const sample = now => {
      if (qa.frameStart) qa.frames.push(now - last);
      last = now;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    const play = app.audio.play.bind(app.audio);
    app.audio.play = (sound, opts = {}) => {
      const ok = play(sound, opts);
      if (ok) qa.plays.push({
        sound, at: Math.round(performance.now()),
        position: opts.position ? opts.position.map(n => Math.round(n)) : null,
        gain: opts.gain ?? null, variant: opts.variant ?? null, source: opts.source ?? null,
      });
      return ok;
    };
    const dry = app.audio.dryFire.bind(app.audio);
    app.audio.dryFire = (...args) => { qa.dryFireCalls++; return dry(...args); };
    const vd = app.audio.vehicleDestroyed.bind(app.audio);
    app.audio.vehicleDestroyed = (...args) => { qa.vehicleDestroyPlays++; return vd(...args); };
    const shot = app.localShot.bind(app);
    app.localShot = (...args) => { qa.localShots++; return shot(...args); };
  });
}

const startFrames = page => page.evaluate(() => {
  window.__qaStab.frames.length = 0;
  window.__qaStab.frameWork.length = 0;
  window.__qaStab.frameStart = performance.now();
});
const takeFrames = page => page.evaluate(() => {
  window.__qaStab.frameStart = 0;
  const pct = (list, p) => list.length ? Math.round(list[Math.min(list.length - 1, Math.floor(list.length * p))] * 100) / 100 : null;
  const list = window.__qaStab.frames.slice().sort((a, b) => a - b);
  const work = window.__qaStab.frameWork.slice().sort((a, b) => a - b);
  return {
    count: list.length,
    p50: pct(list, 0.5), p95: pct(list, 0.95), p99: pct(list, 0.99),
    max: list.length ? Math.round(list[list.length - 1] * 100) / 100 : null,
    workCount: work.length,
    workP50: pct(work, 0.5), workP95: pct(work, 0.95), workP99: pct(work, 0.99),
    workMax: work.length ? Math.round(work[work.length - 1] * 100) / 100 : null,
  };
});
const serverStats = async () => {
  const response = await fetch(new URL('/stats', BASE));
  const data = await response.json();
  const rooms = data.rooms || [];
  return rooms.find(room => room.code === ROOM) || rooms[0] || null;
};

const rpgSetup = page => page.evaluate(() => {
  const app = window.__frontline;
  const lp = app.getLocalPlayer();
  const world = app.worldView.world;
  const eye = [lp.x, lp.y + 1.62, lp.z];
  const glasses = world.boxes.filter(b => b.tag === 'glass' && b.render && !b.destroyed);
  const center = g => [(g.min[0] + g.max[0]) / 2, (g.min[1] + g.max[1]) / 2, (g.min[2] + g.max[2]) / 2];
  // Aim at the first glass surface actually exposed along the sight line. Aiming
  // at a pane centre can put the crosshair on a column/frame between windows, so
  // probe each nearby pane and keep the one whose first ray hit is glass.
  const probes = glasses
    .map(g => {
      const c = center(g);
      const d = Math.hypot(c[0] - lp.x, c[1] - eye[1], c[2] - lp.z);
      return { g, c, d };
    })
    .filter(x => x.d >= 5 && x.d < 60)
    .sort((a, b) => a.d - b.d)
    .map(x => {
      const dir = [x.c[0] - eye[0], x.c[1] - eye[1], x.c[2] - eye[2]];
      const len = Math.hypot(...dir);
      for (let i = 0; i < 3; i++) dir[i] /= len;
      const hit = world.raycast(eye, dir, len + 1);
      const impact = hit ? hit.point : x.c;
      const blast = Math.hypot(x.c[0] - impact[0], x.c[1] - impact[1], x.c[2] - impact[2]);
      // Blast reach is the hard constraint; distance breaks ties so a near pane
      // with a frame 0.7 m away beats a 50 m pane that happens to be exposed.
      return { ...x, hit, impact, blast, score: blast + x.d * 0.05, exposed: hit?.box?.tag === 'glass' };
    });
  const ranked = probes.slice().sort((a, b) => a.score - b.score);
  const pick = ranked[0];
  if (!pick) return null;
  const [cx, cy, cz] = pick.c;
  const near = glasses.filter(g => {
    const c = center(g);
    return Math.hypot(c[0] - cx, c[1] - cy, c[2] - cz) < 9;
  });
  const dx = cx - lp.x, dy = cy - eye[1], dz = cz - lp.z;
  app.aimYaw = Math.atan2(-dx, -dz);
  app.aimPitch = Math.atan2(dy, Math.hypot(dx, dz));
  app.input.pendingSlot = 1;
  return {
    targetId: pick.g.id,
    clear: pick.exposed,
    probes: probes.slice(0, 12).map(p => ({
      id: p.g.id, d: Math.round(p.d * 10) / 10, blast: Math.round(p.blast * 10) / 10,
      tag: p.hit?.tag ?? null, box: p.hit?.box?.id ?? null, exposed: p.exposed,
    })),
    glassIds: near.map(g => g.id), panes: near.length,
    target: [Math.round(cx * 10) / 10, Math.round(cy * 10) / 10, Math.round(cz * 10) / 10],
    distance: Math.round(Math.hypot(cx - lp.x, cz - lp.z) * 10) / 10,
    player: [Math.round(lp.x * 10) / 10, Math.round(lp.y * 10) / 10, Math.round(lp.z * 10) / 10],
  };
});

// Under software GL this page renders well below 1 FPS, so sleeping a fixed
// 180 ms can span zero animation frames and the trigger would never be read.
// Wait for the executable frame to consume the input instead. `localFireT` is
// too short-lived for fast weapons, so count the actual shot/dry callbacks.
const pullTrigger = async page => {
  const before = await page.evaluate(() => {
    // Software-GL frames advance simulation ~0.1 s per real second, so the
    // client-side fire cooldown can outlive the QA window. Clearing it only
    // unblocks the next deliberate pull; the server still owns rate of fire.
    window.__frontline.localFireT = 0;
    return { shots: window.__qaStab.localShots, dry: window.__qaStab.dryFireCalls };
  });
  await page.waitForFunction(() => !window.__frontline.prevShoot, null, { timeout: 60000 });
  await page.evaluate(() => { window.__frontline.input.mouse.left = true; });
  await page.waitForFunction(prev => window.__qaStab.localShots > prev.shots ||
    window.__qaStab.dryFireCalls > prev.dry, before, { timeout: 60000 });
};
const fireOnce = async page => {
  await pullTrigger(page);
  await page.evaluate(() => { window.__frontline.input.mouse.left = false; });
};

const selectRpg = async page => {
  // pendingSlot is consumed by the next input frame; wait for the authoritative
  // switch to finish before pulling the trigger.
  await page.waitForFunction(() => {
    const p = window.__frontline.getLocalPlayer(true);
    return p?.weapon === 'rpg' && (p.switchT || 0) <= 0 && (p.reloadT || 0) <= 0;
  }, null, { timeout: 30000 }).catch(() => {});
};

const selectSlot = async (page, slot) => {
  await page.evaluate(s => { window.__frontline.input.pendingSlot = s; }, slot);
  await page.waitForFunction(s => {
    const p = window.__frontline.getLocalPlayer(true);
    return p?.slot === s && (p.switchT || 0) <= 0 && (p.reloadT || 0) <= 0;
  }, slot, { timeout: 30000 }).catch(() => {});
};

const reloadAndWait = async (page, ms) => {
  await page.keyboard.press('r');
  await page.waitForTimeout(ms);
};

let A, B;
try {
  A = await openClient('StabAlpha');
  await A.waitForTimeout(500);
  B = await openClient('StabBravo');
  await Promise.all([A, B].map(p => p.waitForFunction(() => window.__frontline?.state?.matchState === 2, null, { timeout: 120000 })));
  await A.bringToFront();
  await A.waitForTimeout(1500);

  const setupA = await rpgSetup(A);
  const setupB = await rpgSetup(B);
  console.log('RPG setup A:', JSON.stringify(setupA));
  console.log('RPG setup B:', JSON.stringify(setupB));
  check('both clients found a destructible glass cluster', !!setupA && !!setupB, { a: setupA?.panes, b: setupB?.panes });
  check('glass cluster is close enough for an RPG blast', setupA?.distance < 30 && setupB?.distance < 30, { a: setupA?.distance, b: setupB?.distance });

  // ------------------------------------------------------------ audio routing
  const routing = await A.evaluate(() => {
    const app = window.__frontline;
    const listener = app.audio.listenerPos;
    const at = d => [listener[0] + d, listener[1], listener[2]];
    window.__qaStab.plays.length = 0;
    // Distinct sources: the per-source cooldown intentionally suppresses a
    // second shot from the same shooter inside 20 ms.
    const near = app.audio.shot('ar', ...at(20), 'probe-near');
    const far = app.audio.shot('ar', ...at(500), 'probe-far');
    const beyond = app.audio.shot('ar', ...at(620), 'probe-beyond');
    return {
      near, far, beyond,
      plays: window.__qaStab.plays.map(p => ({ sound: p.sound, position: p.position })),
    };
  });
  check('near shot uses close recordings', routing.plays.some(p => p.sound === 'shot'), routing.plays);
  check('mid shot uses distant recordings', routing.plays.some(p => p.sound === 'distantShot'), routing.plays);
  check('shot beyond 420 m still routes to the 640 m distant range', routing.plays.length >= 2 && routing.beyond, routing.plays);

  // --------------------------------------------------- local/remote-shot path
  await A.evaluate(async () => {
    const app = window.__frontline;
    const self = app.getLocalPlayer();
    const remoteId = [...app.characters.keys()][0];
    const y = self.y + 1.6;
    const nearO = [self.x + 20, y, self.z];
    const farO = [self.x + 500, y, self.z];
    app.handleEvents([{ k: 'shot', id: remoteId, w: 'ar', o: farO, e: [[farO[0] + 20, y, farO[2]]], flight: [0.5] }], self.id);
    window.__qaStab.plays.length = 0;
    app.handleEvents([{ k: 'shot', id: remoteId, w: 'ar', o: nearO, e: [[nearO[0] + 20, y, nearO[2]]], flight: [0.03] }], self.id);
    window.__qaStab.plays.length = 0;
    // Same source + same sound sits inside its 20 ms cooldown; wait it out so
    // this probes routing rather than deliberate repetition suppression.
    await new Promise(resolve => setTimeout(resolve, 40));
    app.handleEvents([{ k: 'shot', id: remoteId, w: 'ar', o: farO, e: [[farO[0] + 20, y, farO[2]]], flight: [0.5] }], self.id);
  });
  const eventRouting = await A.evaluate(() => window.__qaStab.plays.map(p => p.sound));
  check('authoritative shot event far away routes to distant sound', eventRouting.includes('distantShot'), eventRouting);

  // -------------------------------------------- vehicle-destruction duplicate
  const vdup = await A.evaluate(async () => {
    const app = window.__frontline;
    const audio = app.audio;
    const id = 77001;
    window.__qaStab.vehicleDestroyPlays = 0;
    window.__qaStab.plays.length = 0;
    audio.observeVehicles([{ id, x: 0, y: 0, z: 0, health: 100, speed: 0 }]);
    audio.vehicleDestroyed([0, 0, 0], id);                    // authoritative event
    audio.observeVehicles([{ id, x: 0, y: 0, z: 0, health: 0, speed: 0 }]); // replicated transition
    // Count audible voices, not method invocations: the second call is the
    // deduped one and must not reach the mixer.
    return window.__qaStab.plays.filter(p => p.sound === 'vehicleDestroy').length;
  });
  check('vehicle destruction plays once across event + observation', vdup === 1, { plays: vdup });

  // ------------------------------------------------------- reload layering
  // Deterministic audio-path probe: the real SwiftShader frame rate advances
  // simulation ~0.1 s per second, so a 4.6 s reload cannot overlap its start
  // recording in wall-clock time here. Drive the same server-event path and the
  // per-phase cue stepper across one reload synchronously instead.
  const reloadPlays = await A.evaluate(() => {
    const audio = window.__frontline.audio;
    window.__qaStab.plays.length = 0;
    audio.reload('lmg', 4.6);
    for (let t = 4.5; t >= 0; t -= 0.05) {
      audio.updateActions({ weapon: 'lmg', alive: true, reloadT: t }, Infinity);
    }
    return window.__qaStab.plays.map(p => p.sound);
  });
  const fullReload = reloadPlays.some(s => /^reload/.test(s));
  const cue = reloadPlays.some(s => ['magOut', 'magIn', 'bolt', 'shell', 'pump'].includes(s));
  check('reload does not layer a full recording and per-phase cues', !(fullReload && cue), reloadPlays);

  // -------------------------------------------------------- birds by default
  const birds = await A.evaluate(() => window.__frontline.audio._loops.has('amb-birds'));
  check('continuous bird ambience is off by default', birds === false, { birdsLoop: birds });

  // --------------------------------------------- RPG launches at glass
  await A.waitForTimeout(1200);
  const before = await serverStats();
  const beforeFrames = await (async () => { await startFrames(A); await A.waitForTimeout(10000); return takeFrames(A); })();
  const launches = [];
  let destroyedBefore = await A.evaluate(() => window.__frontline.state?.destroyed?.length || 0);
  for (let i = 0; i < 4; i++) {
    await A.bringToFront();
    await rpgSetup(A);
    await selectRpg(A);
    await A.evaluate(() => { window.__qaStab.plays.length = 0; });
    await startFrames(A);
    await fireOnce(A);
    // Rocket flight + server destroy event round trip.
    await A.waitForTimeout(1800);
    const frame = await takeFrames(A);
    const state = await A.evaluate(() => ({
      destroyed: window.__frontline.state?.destroyed?.length || 0,
      glass: window.__frontline.worldView?.glassDestroyed?.size || 0,
      sounds: window.__qaStab.plays.map(p => p.sound),
    }));
    launches.push({ attempt: i + 1, frames: frame, destroyedDelta: state.destroyed - destroyedBefore, glass: state.glass, sounds: state.sounds });
    destroyedBefore = state.destroyed;
    if (i < 3) await reloadAndWait(A, 4200);
  }
  const after = await serverStats();

  // ------------------------------------------------------- dry-fire duplicate
  // The launcher is empty now; one trigger pull must not play the local dry
  // prediction and the authoritative dry event as two voices.
  await A.evaluate(() => { window.__qaStab.dryFireCalls = 0; window.__qaStab.plays.length = 0; });
  await fireOnce(A);
  await A.waitForTimeout(1500);
  const dry = await A.evaluate(() => ({
    calls: window.__qaStab.dryFireCalls,
    plays: window.__qaStab.plays.filter(p => p.sound === 'dryFire').length,
  }));
  // Local prediction and the authoritative event both call dryFire(); exactly
  // one may reach the mixer.
  check('dry-fire plays at most once per trigger pull', dry.plays <= 1, dry);

  const afterFrames = await (async () => { await startFrames(A); await A.waitForTimeout(10000); return takeFrames(A); })();

  // B is a second live client; fire a real rocket at its own glass cluster and
  // measure the frame cost while the destruction/explosion presentation runs.
  await B.bringToFront();
  await B.waitForTimeout(500);
  await rpgSetup(B);
  await selectRpg(B);
  const bBefore = await B.evaluate(() => window.__frontline.state?.destroyed?.length || 0);
  await B.evaluate(() => { window.__qaStab.plays.length = 0; });
  await startFrames(B);
  await fireOnce(B);
  await B.waitForTimeout(1800);
  const bFrames = await takeFrames(B);
  const bState = await B.evaluate(() => ({
    destroyed: window.__frontline.state?.destroyed?.length || 0,
    glass: window.__frontline.worldView?.glassDestroyed?.size || 0,
    sounds: window.__qaStab.plays.map(p => p.sound),
  }));
  const bLaunch = {
    destroyedDelta: bState.destroyed - bBefore,
    glass: bState.glass, sounds: bState.sounds,
  };

  const aDestroyed = launches.reduce((n, l) => n + Math.max(0, l.destroyedDelta), 0);
  const totalDestroyed = aDestroyed + Math.max(0, bLaunch.destroyedDelta);
  const observedGlass = Math.max(bLaunch.glass, ...launches.map(l => l.glass));
  check('RPG explosions destroyed authoritative glass panes', totalDestroyed >= 5, { totalDestroyed, alpha: launches.map(l => l.destroyedDelta), bravo: bLaunch.destroyedDelta });
  check('clients observed the glass removals', observedGlass >= 5, { observedGlass, alpha: launches.map(l => l.glass), bravo: bLaunch.glass });
  check('RPG launch played explosion/rocket audio', [...launches.map(l => l.sounds), bLaunch.sounds].some(sounds => sounds.some(s => /explosion|rocket|distantExplosion/.test(s))), [...launches.map(l => l.sounds), bLaunch.sounds]);
  check('no browser errors', errors.length === 0, errors.slice(0, 5));

  const result = {
    env: { base: BASE, room: ROOM, viewport: '640x360', quality: 'low', renderer: 'SwiftShader' },
    setup: { a: setupA, b: setupB },
    audio: { routing, eventRouting, dryFire: dry, vehicleDestroyPlays: vdup, reloadPlays, birds },
    launches,
    secondClientLaunch: bLaunch,
    frameWindows: { before: beforeFrames, after: afterFrames, secondClient: bFrames },
    server: { before, after },
    checks,
    errors,
  };
  fs.writeFileSync(REPORT, JSON.stringify(result, null, 2));
  await A.screenshot({ path: path.join(OUT, 'alpha.png') }).catch(() => {});
  await B.screenshot({ path: path.join(OUT, 'bravo.png') }).catch(() => {});
  console.log('frame windows:', JSON.stringify(result.frameWindows));
  console.log('server ticks:', JSON.stringify({
    before: before && { p50: before.tickP50Ms, p95: before.tickP95Ms, p99: before.tickP99Ms, max: before.tickMaxMs },
    after: after && { p50: after.tickP50Ms, p95: after.tickP95Ms, p99: after.tickP99Ms, max: after.tickMaxMs },
  }));
  const failed = checks.filter(c => !c.ok);
  console.log(`checks: ${checks.length - failed.length}/${checks.length} passed`);
  console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');
  if (failed.length || errors.length) process.exitCode = 1;
} catch (error) {
  console.error('stabilization multiplayer crashed:', error);
  process.exitCode = 1;
} finally {
  for (const browser of browsers) await browser.close();
}
