// Phase 4 rendering/audio benchmark.
//
//   npm run qa:phase4
//
// Runs the production build in headless Chromium and measures the JS-side hot
// paths that Phase 4 changed: character presentation tiers, loot boundary churn
// and tracer-record reuse. GPU timings are not meaningful under SwiftShader, so
// this deliberately reports CPU work and deterministic allocation counters.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchBrowser, boot } from './browser.mjs';

const out = process.env.QA_OUT || 'qa/shots/phase4-bench';
mkdirSync(out, { recursive: true });
const report = process.env.QA_REPORT || 'qa/reports/phase4-bench.json';
const { browser, page, errors } = await launchBrowser({ quality: process.env.QA_QUALITY || 'low' });

try {
  await boot(page);
  // The lobby preview soldier is removed when a battle starts, so capture its
  // class first. This keeps the benchmark from adding a production debug export.
  const hasCharacterClass = await page.evaluate(() => {
    window.__phase4CharacterView = window.__frontline.previewSoldier?.constructor || null;
    return !!window.__phase4CharacterView;
  });
  if (!hasCharacterClass) throw new Error('preview soldier exposes no CharacterView class');
  await page.click('[data-mode="tdm"]');
  await page.click('[data-kit="ar"]').catch(() => {});
  await page.click('#battest');
  await page.waitForFunction(() => window.__frontline?.active, null, { timeout: 30000 });
  await page.waitForFunction(() => window.__frontline.audio?.samples?.hasGroup('core'), null, { timeout: 30000 });

  const result = await page.evaluate(() => {
    const time = fn => {
      const start = performance.now();
      const value = fn();
      return { ms: Math.round((performance.now() - start) * 1000) / 1000, value };
    };
    const app = window.__frontline;
    const CharacterView = window.__phase4CharacterView ||
      [...app.characters.values()][0]?.constructor;
    const world = app.offlineGame?.world || app.world;
    const makeView = (id, x, z) => {
      const view = new CharacterView(app.renderer.scene, id, world, app.renderer);
      view.applyState({
        x, y: world?.terrainHeight?.(x, z) ?? 0, z, yaw: 0, pitch: 0,
        stance: 'stand', alive: true, name: `BOT-${id}`, team: id % 2,
        hp: 100, weapon: 'ar', mag: 30, reloadT: 0,
      });
      view.visible = true;
      return view;
    };

    // --- Character presentation tiers -------------------------------------
    const views = [];
    for (let i = 0; i < 24; i++) views.push(makeView(5000 + i, i * 2, -i * 2));
    const measureTier = offset => {
      const cameraPos = [0, 0, 0];
      const frames = 300;
      const start = performance.now();
      for (let f = 0; f < frames; f++) {
        for (const view of views) {
          cameraPos[0] = view.pos[0] + offset;
          cameraPos[1] = view.pos[1] + 1.6;
          cameraPos[2] = view.pos[2] + offset;
          view.update(1 / 60, cameraPos);
        }
      }
      const ms = performance.now() - start;
      const sample = views[0]._detail;
      return { frames, updates: frames * views.length, totalMs: Math.round(ms * 100) / 100,
        usPerUpdate: Math.round(ms / (frames * views.length) * 10000) / 10, tier: sample };
    };
    const tiers = {
      full: measureTier(8),
      basic: measureTier(50),   // ~71 m diagonal from the dummy camera
      hidden: measureTier(120), // ~170 m diagonal
    };
    for (const view of views) view.dispose();

    // --- Loot hysteresis and pool reuse ------------------------------------
    const lw = app.worldView;
    const resetLoot = () => {
      for (const mesh of lw._lootMeshes.values()) lw.lootGroup.remove(mesh);
      lw._lootMeshes.clear();
      for (const pool of lw._lootPool.values()) for (const mesh of pool) lw.lootGroup.remove(mesh);
      lw._lootPool.clear();
      lw._lootPoolCount = 0;
      lw.lootStats = { created: 0, reused: 0, disposed: 0 };
    };
    const camera = app.renderer.camera;
    const savedCamera = camera.position.clone();
    const item = { id: 9001, type: 'weapon', weapon: 'ar', x: savedCamera.x, y: savedCamera.y, z: savedCamera.z - 5 };
    resetLoot();
    const boundary = time(() => {
      for (let i = 0; i < 100; i++) {
        camera.position.set(savedCamera.x, savedCamera.y, savedCamera.z);
        lw.syncLoot([item]);          // within 65 m: create/reuse
        camera.position.z += 200;     // beyond retention: hide, keep for hysteresis
        lw.syncLoot([item]);
      }
      camera.position.copy(savedCamera);
      lw.syncLoot([item]);
      return { ...lw.lootStats };
    });

    resetLoot();
    const pool = time(() => {
      for (let i = 0; i < 50; i++) {
        camera.position.copy(savedCamera);
        lw.syncLoot([{ ...item, id: 10000 + i }]); // previous id leaves the list
      }
      return { ...lw.lootStats, pooled: lw._lootPoolCount };
    });
    camera.position.copy(savedCamera);

    // --- Tracer record reuse ----------------------------------------------
    const fx = app.effects;
    const tracer = time(() => {
      for (let i = 0; i < 5000; i++) {
        fx.tracer([0, 1, 0], [0, 1, -10]);
        fx._updateTracers(1);
        fx._updateTracers(1);
      }
      return { pool: fx._tracerPool.length, live: fx.tracerData.filter(Boolean).length };
    });

    // --- Audio bank / voice budget ----------------------------------------
    const audio = app.audio;
    const bank = audio.samples;
    const playback = time(() => {
      audio.budget.cancel();
      const played = audio.playSample('ar-a', { gain: 0.001 });
      const afterOne = audio.budget.size;
      for (let i = 0; i < 70; i++) audio.playSample('ar-a', { gain: 0.001 });
      const peak = audio.budget.size;
      audio.budget.cancel();
      return {
        played,
        afterOne,
        peak,
        afterCancel: audio.budget.size,
        context: audio.ctx?.state || 'none',
      };
    });
    // Toggling the alarm must not retain a loop or a voice per toggle.
    const alarm = (() => {
      audio.budget.cancel();
      audio.zoneAlarm(true);
      const started = audio._loops.has('zone-alarm');
      for (let i = 0; i < 20; i++) { audio.zoneAlarm(false); audio.zoneAlarm(true); }
      audio.zoneAlarm(false);
      return {
        started,
        retainedLoops: audio._loops.has('zone-alarm') ? 1 : 0,
        alarmVoices: audio.budget.count('alarm'),
      };
    })();

    return {
      tiers,
      lootBoundary: boundary.value,
      lootBoundaryMs: boundary.ms,
      lootPool: pool.value,
      lootPoolMs: pool.ms,
      tracers: tracer.value,
      tracersMs: tracer.ms,
      audio: {
        enabled: audio.enabled,
        core: bank.groups.get('core')?.size || 0,
        vehicle: bank.groups.get('vehicle')?.size || 0,
        ambience: bank.groups.get('ambience')?.size || 0,
        decoded: bank.buffers.size,
        errors: bank.errors.length,
        voiceLimit: audio.budget.limit,
        activeVoices: audio.budget.size,
      },
      playback: playback.value,
      playbackMs: playback.ms,
      alarm,
      renderStats: app.renderer.stats(),
    };
  });

  result.env = {
    url: page.url(),
    quality: process.env.QA_QUALITY || 'low',
    renderer: await page.evaluate(() => {
      const gl = window.__frontline?.renderer?.renderer?.getContext?.();
      return gl ? gl.getParameter(gl.RENDERER) : null;
    }),
    browserErrors: errors.length,
  };
  writeFileSync(out + '.json', JSON.stringify(result, null, 2));
  mkdirSync(path.dirname(report), { recursive: true });
  writeFileSync(report, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) { console.error(errors.slice(0, 5)); process.exitCode = 1; }
} finally {
  await browser.close();
}
