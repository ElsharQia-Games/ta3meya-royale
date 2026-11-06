// Browser-hosted peer-mode QA (report1.md scenarios A–E).
//
//   npm run qa:peer
//   QA_URL=http://127.0.0.1:3110/ npm run qa:peer
//
// Peer mode needs a static app server (the same dist/ server is fine) and
// outbound access to the public MQTT broker. Each client gets its own browser
// process because two pages in one software-GL browser starve each other.
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

const cache = process.env.HOME + '/.cache/ms-playwright';
let exe;
for (const d of fs.readdirSync(cache)) {
  if (!d.startsWith('chromium')) continue;
  for (const r of ['chrome-linux/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
    const p = cache + '/' + d + '/' + r;
    if (fs.existsSync(p)) exe = p;
  }
}

function peerUrl() {
  const url = new URL(BASE);
  url.search = '';
  url.searchParams.set('net', 'peer');
  return url.toString();
}

const browsers = [];
const errors = [];
async function openClient(name, room, { rafFps = 0, viewport = { width: 640, height: 360 }, stubRender = true } = {}) {
  const browser = await chromium.launch({
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
  browsers.push(browser);
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => localStorage.setItem('frontline.settings.v1', JSON.stringify({
    quality: 'low', shadows: false, bloom: false, showFps: true, muted: true, mode: 'tdm',
  })));
  if (rafFps) {
    await ctx.addInitScript((fps) => {
      const native = window.requestAnimationFrame.bind(window);
      const interval = 1000 / fps;
      window.requestAnimationFrame = (cb) => setTimeout(() => native(cb), interval);
    }, rafFps);
  }
  const page = await ctx.newPage();
  page.setDefaultTimeout(90000);
  page.on('pageerror', (e) => errors.push(name + ': ' + (e.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
  await page.goto(peerUrl(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__frontline, null, { timeout: 30000 });
  if (stubRender) {
    // SwiftShader renders this scene at ~1 FPS, which would cap the host's
    // bounded catch-up. The peer QA verifies simulation/networking, not GPU
    // draw cost, so remove only the draw call and let rAF run normally.
    await page.evaluate(() => { window.__frontline.render = () => {}; });
  }
  await page.fill('#in-name', name);
  await page.fill('#in-room', room);
  return { name, browser, page };
}

async function join(client) {
  await client.page.bringToFront();
  await client.page.click('#join');
  await client.page.waitForFunction(() => window.__frontline?.active === true, null, { timeout: 90000 });
}

async function closeClient(client) {
  try { await client.browser.close(); } catch {}
}

const state = (client) => client.page.evaluate(() => {
  const a = window.__frontline;
  const lp = a?.getLocalPlayer?.();
  return {
    active: a?.active,
    mode: a?.mode,
    self: a?.peerSession?.hostInfo?.self,
    hostId: a?.peerSession?.hostInfo?.hostId,
    sessionId: a?.peerSession?.hostInfo?.sessionId,
    hostHasKey: !!a?.peerSession?.host?.hostPublicKey,
    hostTick: a?.host?.tickCount,
    catchUp: a?.host?.catchUpSteps,
    droppedSim: a?.host?.droppedSimTime,
    netConnected: a?.net?.connected,
    netJoined: a?.net?.joined,
    hasPeerSession: !!a?.peerSession,
    snapshots: a?.net?.snapshotCount,
    relayConnected: a?.relay?.connected,
    relayIndex: a?.relay?.relayIndex,
    roster: a?.roster?.map((r) => r.name) || [],
    // Character views are only created inside render(); this QA stubs the
    // draw call, so observe the snapshot cache the simulation consumes.
    remoteViews: [...(a?.characters?.keys() || [])],
    cacheIds: [...(a?.net?.cache?.keys() || [])],
    localId: a?.localId,
    local: lp ? { x: lp.x, z: lp.z, alive: lp.alive, mag: lp.mag } : null,
    status: document.querySelector('#lobby-status')?.textContent,
  };
});

const waitFor = async (fn, timeout = 10000, interval = 100) => {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
};

const room = () => 'QAP' + Math.random().toString(36).slice(2, 8).toUpperCase();

try {
  console.log('peer url', peerUrl());

  // ---------------------------------------------------------------- Scenario A
  // One browser becomes the host; local movement, shooting, snapshots and
  // fixed-tick state must all advance without any other client.
  const roomA = room();
  const A = await openClient('PeerA', roomA);
  await join(A);
  await A.page.waitForTimeout(1200);
  const a0 = await state(A);
  check('A: browser client becomes authoritative host', !!a0.self && a0.hostTick > 0 && a0.hostHasKey, {
    self: a0.self, tick: a0.hostTick, key: a0.hostHasKey,
  });
  check('A: local join receives a live roster and snapshots', a0.netJoined && a0.snapshots > 0 && a0.roster.includes('PeerA'), {
    joined: a0.netJoined, snapshots: a0.snapshots,
  });

  await A.page.bringToFront();
  const moveStart = await state(A);
  await A.page.keyboard.down('w');
  await A.page.waitForTimeout(1800);
  await A.page.keyboard.up('w');
  const moveEnd = await state(A);
  const moved = Math.hypot(moveEnd.local.x - moveStart.local.x, moveEnd.local.z - moveStart.local.z);
  check('A: local movement is simulated', moveEnd.local.alive && moved > 0.5, { moved: +moved.toFixed(2), alive: moveEnd.local.alive });

  // Shooting is only admitted while the match is LIVE. With the draw call
  // stubbed the host reaches that state in a few seconds of real time.
  const live = await waitFor(async () => A.page.evaluate(() =>
    window.__frontline.host?.game?.matchState === 2), 30000, 100);
  const magBefore = (await state(A)).local.mag;
  await A.page.evaluate(() => { window.__frontline.input.mouse.left = true; });
  await A.page.waitForTimeout(900);
  await A.page.evaluate(() => { window.__frontline.input.mouse.left = false; });
  const magAfter = (await state(A)).local.mag;
  check('A: shooting drains the local authoritative magazine', live && magAfter < magBefore, {
    live, before: magBefore, after: magAfter,
  });

  const tick0 = (await state(A)).hostTick;
  const snap0 = (await state(A)).snapshots;
  await A.page.waitForTimeout(2000);
  const a1 = await state(A);
  check('A: host ticks and snapshots advance', a1.hostTick > tick0 + 80 && a1.snapshots > snap0, {
    tickDelta: a1.hostTick - tick0, snapshotDelta: a1.snapshots - snap0,
  });

  // ---------------------------------------------------------------- Scenario B
  // A second browser process joins the same room. Exactly one host remains and
  // both clients observe the same authoritative roster and remote characters.
  const B = await openClient('PeerB', roomA);
  await join(B);
  await B.page.waitForTimeout(1000);
  const aAfterB = await state(A);
  const b0 = await state(B);
  check('B: second browser joins as guest of the same host', b0.self === false && b0.hostId === aAfterB.hostId && b0.sessionId === aAfterB.sessionId, {
    self: b0.self, host: b0.hostId, expected: aAfterB.hostId,
  });
  // Character views are created inside render(), which peer QA stubs out, so
  // use the snapshot cache the simulation actually consumes. Poll because a
  // roster entry and its first snapshot can arrive in separate messages.
  const replicated = await waitFor(async () => {
    const [aNow, bNow] = [await state(A), await state(B)];
    return bNow.cacheIds.includes(aNow.localId) && aNow.cacheIds.includes(bNow.localId);
  }, 10000, 100);
  const [aRep, bRep] = [await state(A), await state(B)];
  check('B: both clients share one roster and replicate remote players', replicated && bRep.roster.includes('PeerA') && aRep.roster.includes('PeerB'), {
    rosterA: aRep.roster.length, rosterB: bRep.roster.length,
    aSeesB: aRep.cacheIds.includes(bRep.localId), bSeesA: bRep.cacheIds.includes(aRep.localId),
  });

  const transport = await A.page.evaluate(() => {
    const g = [...(window.__frontline.peerSession.host?.peerGuests?.values() || [])][0];
    return g ? { opened: !!g.opened, relay: !!g.relaySocket, pc: !!g.pc } : null;
  });
  console.log('selected guest transport:', JSON.stringify(transport));

  // TDM respawns, so a guest killed while connecting cannot leave this check
  // permanently unable to observe movement.
  const guestAlive = await waitFor(async () => (await state(B)).local?.alive === true, 15000, 100);
  const bStart = await state(B);
  await B.page.bringToFront();
  await B.page.keyboard.down('w');
  await B.page.waitForTimeout(2500);
  await B.page.keyboard.up('w');
  const bEnd = await state(B);
  const bMoved = Math.hypot(bEnd.local.x - bStart.local.x, bEnd.local.z - bStart.local.z);
  const aSeesB = await A.page.evaluate((id) => {
    const p = window.__frontline.net.cache.get(id);
    return p ? { x: p.x, z: p.z } : null;
  }, bEnd.localId);
  const replicationError = aSeesB ? Math.hypot(aSeesB.x - bEnd.local.x, aSeesB.z - bEnd.local.z) : Infinity;
  check('B: guest movement replicates to the host', guestAlive && bEnd.local.alive && bMoved > 0.5 && replicationError < 4, {
    alive: bEnd.local.alive, moved: +bMoved.toFixed(2), replicationError: +replicationError.toFixed(2),
  });

  // ---------------------------------------------------------------- Scenario C
  // Degrade the host's render loop to ~30 FPS. The fixed-step host must keep
  // ticking near real time instead of slowing to the render frame rate.
  await A.page.bringToFront();
  await A.page.evaluate(() => {
    const native = window.requestAnimationFrame.bind(window);
    window.__peerQaRestoreRaf = () => { window.requestAnimationFrame = native; };
    window.requestAnimationFrame = (cb) => setTimeout(() => native(cb), 20);
  });
  await A.page.waitForTimeout(800);
  const c0 = await state(A);
  const cSnap0 = (await state(B)).snapshots;
  await A.page.waitForTimeout(3000);
  const c1 = await state(A);
  const cSnap1 = (await state(B)).snapshots;
  await A.page.evaluate(() => {
    window.__peerQaRestoreRaf();
    delete window.__peerQaRestoreRaf;
  });
  const cTickDelta = c1.hostTick - c0.hostTick;
  check('C: ~30 FPS host still advances simulation at fixed-step rate', cTickDelta >= 120 && cTickDelta <= 230, {
    tickDelta: cTickDelta, catchUp: c1.catchUp - c0.catchUp, dropped: +(c1.droppedSim - c0.droppedSim).toFixed(2),
  });
  check('C: guest keeps receiving snapshots while host renders slower', cSnap1 > cSnap0, {
    snapshots: cSnap1 - cSnap0,
  });

  // ---------------------------------------------------------------- Scenario D
  // Drop both MQTT sockets and let only the relay's own reconnect path restore
  // them. The logical host/session and both gameplay clients must survive.
  const dHostBefore = await state(A);
  await A.page.evaluate(() => window.__frontline.peerSession.relay.ws.close());
  const hostDown = await waitFor(async () => !(await state(A)).relayConnected, 5000, 50);
  const hostBack = await waitFor(async () => (await state(A)).relayConnected, 20000, 100);
  const dHostAfter = await state(A);
  check('D: host relay disconnects and reconnects', hostDown && hostBack, {
    down: hostDown, back: hostBack, relayIndex: dHostAfter.relayIndex,
  });
  check('D: reconnect preserves the logical host session', dHostAfter.hostId === dHostBefore.hostId && dHostAfter.sessionId === dHostBefore.sessionId && dHostAfter.self === true, {
    host: dHostAfter.hostId, session: dHostAfter.sessionId,
  });

  await B.page.evaluate(() => window.__frontline.peerSession.relay.ws.close());
  const guestBack = await waitFor(async () => (await state(B)).relayConnected, 20000, 100);
  await B.page.waitForTimeout(1000);
  const dGuest = await state(B);
  check('D: guest relay reconnects without rebuilding the session', guestBack && dGuest.hostId === dHostBefore.hostId && dGuest.sessionId === dHostBefore.sessionId, {
    back: guestBack, host: dGuest.hostId,
  });

  // A gameplay message after reconnect proves the session is still usable.
  const chatBefore = await A.page.evaluate(() => document.querySelectorAll('.chat-row').length);
  await B.page.evaluate(() => window.__frontline.net.sendChat('peer-reconnect-ok'));
  const chatArrived = await waitFor(async () =>
    (await A.page.evaluate(() => [...document.querySelectorAll('.chat-row')].some((e) => e.textContent.includes('peer-reconnect-ok')))), 8000, 100);
  check('D: gameplay messages flow after relay reconnect', chatArrived, { chatBefore });

  // A peer transport cannot reconnect. Closing the guest's active DataChannel
  // is terminal, so the client must leave gameplay and expose the lobby again
  // instead of ticking forever with net/host/relay already released.
  await B.page.evaluate(() => window.__frontline.net.ws.close(1000, 'qa terminal failure'));
  const failedToLobby = await waitFor(async () => {
    const s = await state(B);
    return s.active === false && !s.netConnected && !s.hasPeerSession;
  }, 10000, 100);
  const failureUi = await B.page.evaluate(() => ({
    active: window.__frontline.active,
    net: !!window.__frontline.net,
    peer: !!window.__frontline.peerSession,
    lobbyVisible: !document.querySelector('#lobby')?.classList.contains('hidden'),
    hudHidden: document.querySelector('#hud')?.classList.contains('hidden'),
    joinDisabled: document.querySelector('#join')?.disabled,
    status: document.querySelector('#lobby-status')?.textContent,
  }));
  check('D: terminal peer failure returns the guest to a recoverable lobby', failedToLobby && failureUi.lobbyVisible && failureUi.hudHidden && failureUi.joinDisabled === false && /Peer connection/.test(failureUi.status), failureUi);

  // Recoverability means the same lobby can actually deploy again, not merely
  // show an enabled button.
  await B.page.bringToFront();
  await B.page.click('#join');
  let rejoined = false;
  try {
    await B.page.waitForFunction(() => window.__frontline?.active === true, null, { timeout: 30000 });
    rejoined = true;
  } catch {}
  const bRejoined = await state(B);
  check('D: guest can deploy again after terminal failure', rejoined && bRejoined.active && bRejoined.netJoined && bRejoined.roster.includes('PeerB'), {
    rejoined, active: bRejoined.active, joined: bRejoined.netJoined, host: bRejoined.hostId,
  });

  await closeClient(A);
  await closeClient(B);

  // ---------------------------------------------------------------- Scenario E
  // Fresh room, two clients that start discovery almost simultaneously. Both
  // must agree on one host; a delayed second candidate must also join as guest.
  const rounds = [
    { label: 'simultaneous', suffix: 'S', delayMs: 0 },
    { label: 'delayed', suffix: 'D', delayMs: 600 },
  ];
  for (const round of rounds) {
    const roomE = room();
    const leftName = 'Echo' + round.suffix;
    const rightName = 'Foxtrot' + round.suffix;
    const left = await openClient(leftName, roomE);
    const right = await openClient(rightName, roomE);
    try {
      await Promise.all([left.page.bringToFront(), right.page.bringToFront()]);
      const leftJoin = left.page.click('#join');
      await new Promise((r) => setTimeout(r, round.delayMs));
      const rightJoin = right.page.click('#join');
      await Promise.all([leftJoin, rightJoin]);
      await Promise.all([
        left.page.waitForFunction(() => window.__frontline?.active === true, null, { timeout: 90000 }),
        right.page.waitForFunction(() => window.__frontline?.active === true, null, { timeout: 90000 }),
      ]);
      await new Promise((r) => setTimeout(r, 1000));
      const [le, re] = [await state(left), await state(right)];
      const hosts = [le, re].filter((s) => s.self === true);
      check(`E (${round.label}): exactly one host and one guest`, hosts.length === 1 && le.hostId === re.hostId && le.sessionId === re.sessionId, {
        delayMs: round.delayMs, self: [le.self, re.self], hosts: hosts.length,
      });
      check(`E (${round.label}): both clients are active in the same match`, le.active && re.active && le.netJoined && re.netJoined && le.roster.includes(rightName) && re.roster.includes(leftName), {
        active: [le.active, re.active], joined: [le.netJoined, re.netJoined],
        rosters: [le.roster.length, re.roster.length],
      });
    } finally {
      await closeClient(left);
      await closeClient(right);
    }
  }

  if (errors.length) console.log('page errors:', errors.slice(0, 5));
  const failed = checks.filter((c) => !c.ok);
  console.log(`checks: ${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length) console.log('FAILED:', failed.map((f) => f.name));
  if (errors.length || failed.length) process.exitCode = 1;
} catch (err) {
  console.error('peer multiplayer QA crashed:', err);
  process.exitCode = 1;
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
}
