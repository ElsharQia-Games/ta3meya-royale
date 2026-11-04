import { chromium } from 'playwright-core';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export async function launchBrowser({ width = 1920, height = 1080, quality = 'high', recordVideo } = {}) {
  const cache = path.join(process.env.HOME, '.cache/ms-playwright');
  let executablePath = process.env.CHROMIUM_PATH;
  if (!executablePath) for (const dir of readdirSync(cache)) {
    if (!dir.startsWith('chromium')) continue;
    for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
      const file = path.join(cache, dir, rel);
      if (existsSync(file)) { executablePath = file; break; }
    }
    if (executablePath) break;
  }
  if (!executablePath) throw new Error('Install Playwright Chromium or set CHROMIUM_PATH');
  const browser = await chromium.launch({ executablePath, args: [
    '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required',
  ] });
  if (recordVideo) mkdirSync(recordVideo, { recursive: true });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1,
    reducedMotion: 'reduce', ...(recordVideo ? { recordVideo: { dir: recordVideo, size: { width, height } } } : {}) });
  await context.addInitScript(quality => localStorage.setItem('frontline.settings.v1', JSON.stringify({
    quality, shadows: quality !== 'low', bloom: quality === 'high', muted: true, showFps: false,
  })), quality);
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(120000);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.stack || e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  return { browser, context, page, errors };
}

export async function boot(page, url = process.env.QA_URL || 'http://127.0.0.1:3300/') {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__frontline?.previewReady && window.__frontline?.worldView?.assetsLoaded);
  await page.evaluate(() => document.fonts.ready);
}

export async function frameEvidence(page) {
  return page.evaluate(() => {
    const a = window.__frontline, r = a.renderer;
    return { bundle: document.querySelector('script[type="module"][src]')?.src, viewport: [innerWidth, innerHeight],
      drawingBuffer: [r.renderer.domElement.width, r.renderer.domElement.height], quality: a.settings.quality,
      seed: a.world?.seed, camera: r.camera.position.toArray(), fov: r.camera.fov,
      calls: r.renderer.info.render.calls, triangles: r.renderer.info.render.triangles,
      crosshairs: document.querySelectorAll('.crosshair').length, crossOpacity: getComputedStyle(a.hud.cross).opacity,
      softwareFps: r.fps, player: a.getLocalPlayer(), assetError: a.worldView?.assetError || null };
  });
}
