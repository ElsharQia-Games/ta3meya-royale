// Focused live deployment reproduction; no staged player/world state.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchBrowser, boot } from './browser.mjs';

const out = process.env.QA_OUT || 'qa/shots/tdm-deployment-debug';
mkdirSync(out, { recursive: true });
const { browser, page, errors } = await launchBrowser({
  width: Number(process.env.QA_WIDTH || 1280), height: Number(process.env.QA_HEIGHT || 720),
  quality: process.env.QA_QUALITY || 'low',
});
if (process.env.QA_LEGACY_AUDIO) await page.addInitScript(() => {
  // Exercise the Firefox-style method-only API against native Web Audio nodes.
  // This is a capability shim in Chromium, not a native Firefox run.
  window.__legacyAudioCalls = { position: 0, orientation: 0, source: 0 };
  for (const [type, names, methods] of [
    [AudioListener, ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ'], { setPosition: 'position', setOrientation: 'orientation' }],
    [PannerNode, ['positionX', 'positionY', 'positionZ'], { setPosition: 'source' }],
  ]) {
    for (const name of names) Object.defineProperty(type.prototype, name, { configurable: true, get: () => undefined });
    for (const [name, counter] of Object.entries(methods)) {
      const original = type.prototype[name];
      type.prototype[name] = function (...args) {
        window.__legacyAudioCalls[counter]++;
        return original.apply(this, args);
      };
    }
  }
});
try {
  if (process.env.QA_EARLY_JOIN) await page.goto(process.env.QA_URL || 'http://127.0.0.1:3300/', { waitUntil: 'load' });
  else await boot(page);
  await page.click('[data-mode="tdm"]');
  await page.fill('#in-room', process.env.QA_ROOM || `DEPLOY${Date.now().toString(36).toUpperCase()}`.slice(0, 12));
  if (process.env.QA_UNMUTED) {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => { window.__frontline.settings.muted = false; });
  }
  await page.click('#join');
  let ready = false, samplePlayed = false, advanced = false;
  try {
    await page.waitForFunction(() => window.__frontline?.active, null, { timeout: 20000 });
    await page.waitForFunction(() => {
      const a = window.__frontline;
      return a.localSnap && a.hud.weaponName.textContent !== '—' && a.state?.mode === 'tdm';
    }, null, { timeout: 10000 });
    if (process.env.QA_OBSERVE_LIVE) await page.waitForFunction(() => {
      const a = window.__frontline;
      return a.state?.matchState === 2 && a.time > 3;
    }, null, { timeout: 40000 });
    samplePlayed = await page.evaluate(async () => {
      const a = window.__frontline;
      await a.audio.samples.loading;
      const [x, y, z] = a.renderer.camera.position.toArray();
      // A single positioned clip exercises source compatibility separately
      // from the live server join. No gameplay state is altered.
      return a.audio.playSample('ar-a', { gain: .05, position: [x + 8, y, z - 5] });
    });
    const before = await page.evaluate(() => window.__frontline.time);
    await page.waitForFunction(time => window.__frontline.time > time + .2, before, { timeout: 5000 });
    advanced = true; ready = true;
  } catch (error) { console.log('Deployment did not finish:', error.message); }
  const state = await page.evaluate(() => {
    const a = window.__frontline;
    let player, playerError;
    try { player = a.getLocalPlayer(); } catch (error) { playerError = error.stack; }
    return { active: a.active, mode: a.mode, time: a.time, localId: a.localId,
      player, playerError, localSnap: a.localSnap, localWeapons: a.localWeapons,
      cacheSize: a.net?.cache.size, snapshots: a.net?.snapshotCount,
      camera: a.renderer.camera.position.toArray(), worldSeed: a.world?.seed,
      stateMode: a.state?.mode, matchState: a.state?.matchState,
      lobbyStatus: document.querySelector('#lobby-status').textContent,
      legacyAudioCalls: window.__legacyAudioCalls,
      weaponLabel: a.hud.weaponName.textContent, assetError: a.worldView?.assetError,
      bundle: document.querySelector('script[type="module"][src]')?.src };
  });
  await page.screenshot({ path: path.join(out, 'deployment.png') });
  const fallback = !process.env.QA_LEGACY_AUDIO || Object.values(state.legacyAudioCalls || {}).length === 3
    && Object.values(state.legacyAudioCalls).every(count => count > 0);
  const passed = ready && advanced && samplePlayed && fallback && !errors.length && !state.assetError && !state.playerError;
  writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ passed, ready, advanced, samplePlayed, state, errors }, null, 2));
  console.log(JSON.stringify({ passed, ready, advanced, samplePlayed, state, errors }, null, 2));
  if (!passed) process.exitCode = 1;
} finally { await browser.close(); }
