// Phase 4 stabilization microbenchmark.
//
//   npm run qa:stabilize
//
// Boots the production build and measures the presentation paths that the
// stabilization report calls out: per-pane glass rebuilds, no-op destruction
// sync, rocket creation/flight, explosion/debris creation and audio admission.
// These are JS-side costs; SwiftShader frame timing is not a GPU claim.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchBrowser, boot } from './browser.mjs';

const out = process.env.QA_OUT || 'qa/shots/stabilization';
mkdirSync(out, { recursive: true });
const report = process.env.QA_REPORT || 'qa/reports/stabilization-micro.json';
const { browser, page, errors } = await launchBrowser({ quality: process.env.QA_QUALITY || 'low' });

try {
  await boot(page);
  await page.click('[data-mode="tdm"]');
  await page.click('[data-kit="heavy"]').catch(() => {});
  await page.click('#battest');
  await page.waitForFunction(() => window.__frontline?.active, null, { timeout: 30000 });
  await page.waitForFunction(() => window.__frontline.audio?.samples?.hasGroup('core'), null, { timeout: 30000 });

  const result = await page.evaluate(() => {
    const app = window.__frontline;
    const wv = app.worldView;
    const fx = app.effects;
    const audio = app.audio;
    const world = app.offlineGame?.world || app.world || wv.world;

    const time = (fn, iterations = 1) => {
      const start = performance.now();
      const value = fn();
      return { ms: Math.round((performance.now() - start) * 1000) / 1000, iterations, value };
    };

    // A real cluster of panes, not synthetic ids.
    const glass = world.boxes.filter(b => b.tag === 'glass' && b.render);
    const cluster = glass.slice(0, 5).map(b => b.id);

    // --- current per-pane glass removal --------------------------------
    wv.syncDestruction([]);
    const perPane = time(() => {
      for (const id of cluster) wv.removeBox(id);
      return { meshes: wv.glassMeshes.length, destroyed: wv.glassDestroyed.size };
    });
    // Restore authoritative glass for the next measurement.
    wv.syncDestruction([]);
    const batchRemoval = time(() => {
      if (typeof wv.removeBoxes === 'function') wv.removeBoxes(cluster);
      else for (const id of cluster) wv.removeBox(id);
      return { meshes: wv.glassMeshes.length, destroyed: wv.glassDestroyed.size, batched: typeof wv.removeBoxes === 'function' };
    });
    wv.syncDestruction([]);

    // --- repeated no-op destruction sync -------------------------------
    const destroyed = new Set(cluster);
    wv.syncDestruction(destroyed);
    const noopSync = time(() => {
      for (let i = 0; i < 200; i++) wv.syncDestruction(destroyed);
      return { destroyed: destroyed.size, glassMeshes: wv.glassMeshes.length };
    });
    wv.syncDestruction([]);

    // --- rocket model creation / launch --------------------------------
    fx.rockets.size && [...fx.rockets.keys()].forEach(id => fx.stopProjectile(id));
    const launch = time(() => {
      for (let i = 0; i < 60; i++) {
        fx.launch({ projectileId: 90000 + i, w: 'rpg', o: [0, 40, 0], v: [0, 0, -20], life: 12 });
      }
      return { rockets: fx.rockets.size };
    });
    for (const id of [...fx.rockets.keys()]) fx.stopProjectile(id);

    // --- rocket flight: one live rocket, 300 frames --------------------
    fx.launch({ projectileId: 91000, w: 'rpg', o: [0, 60, 0], v: [0, 0, -30], life: 12 });
    const flight = time(() => {
      for (let i = 0; i < 300; i++) fx.update(1 / 60);
      return { rockets: fx.rockets.size };
    });
    for (const id of [...fx.rockets.keys()]) fx.stopProjectile(id);

    // --- explosion + debris creation -----------------------------------
    const boom = time(() => {
      for (let i = 0; i < 40; i++) fx.boom({ x: 0, y: 40, z: 0, r: 7 });
      return { explosions: fx.explosions.length, puffs: fx.puffs.length, particlesLive: fx.particles.filter(p => p.live).length };
    });
    const destroy = time(() => {
      for (let i = 0; i < 20; i++) {
        fx.destroy({ id: 1, x: 0, y: 40, z: 0, sx: 2, sy: 2, sz: 2 });
      }
      return { debris: fx.debris.length };
    });
    // Explicit cleanup of measured presentation objects.
    for (const e of fx.explosions.splice(0)) { e.mesh.removeFromParent(); if (e.light) { e.light.busy = false; e.light.light.intensity = 0; } }
    for (const d of fx.debris.splice(0)) { d.mesh.removeFromParent(); }
    for (const r of fx.shockwaves.splice(0)) { r.entry.mesh.removeFromParent(); }

    // --- audio admission ------------------------------------------------
    audio.budget.cancel();
    const audioExplosion = time(() => {
      let played = 0;
      for (let i = 0; i < 200; i++) if (audio.play('explosion', { position: [0, 40, 0], bypassCooldown: true, gain: 0.001 })) played++;
      const peak = audio.budget.size;
      audio.budget.cancel();
      return { played, peak, remaining: audio.budget.size };
    });

    return {
      glass: {
        perPane: perPane.value,
        perPaneMs: perPane.ms,
        batch: batchRemoval.value,
        batchMs: batchRemoval.ms,
        noopSync200: noopSync.value,
        noopSync200Ms: noopSync.ms,
        noopSyncPerCallUs: Math.round(noopSync.ms / 200 * 10000) / 10,
      },
      rocket: {
        launch60: launch.value,
        launch60Ms: launch.ms,
        launchPerUs: Math.round(launch.ms / 60 * 10000) / 10,
        flight300: flight.value,
        flight300Ms: flight.ms,
        flightPerFrameUs: Math.round(flight.ms / 300 * 10000) / 10,
      },
      explosion: {
        boom40Ms: boom.ms,
        boomPerUs: Math.round(boom.ms / 40 * 10000) / 10,
        boom: boom.value,
        destroy20Ms: destroy.ms,
        destroyPerUs: Math.round(destroy.ms / 20 * 10000) / 10,
        destroy: destroy.value,
      },
      audio: {
        explosion200Ms: audioExplosion.ms,
        explosion200: audioExplosion.value,
        birdsLoopDefault: audio._loops.has('amb-birds'),
        loops: [...audio._loops.keys()],
      },
      renderStats: app.renderer.stats(),
    };
  });

  result.env = {
    quality: process.env.QA_QUALITY || 'low',
    url: page.url(),
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
  if (errors.length) { console.error(errors.slice(0, 8)); process.exitCode = 1; }
} finally {
  await browser.close();
}
