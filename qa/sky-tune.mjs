// Sky/exposure sweep for the worst-case "looking toward the sun" vista.
// Captures one frame per candidate so qa/analyze.py can compare clipping.
//
//   node qa/sky-tune.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('qa/shots');
fs.mkdirSync(OUT, { recursive: true });

function findChromium() {
  const base = path.join(process.env.HOME, '.cache/ms-playwright');
  for (const dir of fs.readdirSync(base)) {
    if (!dir.startsWith('chromium')) continue;
    for (const rel of ['chrome-linux/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
      const p = path.join(base, dir, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('chromium not found');
}

const CANDIDATES = [
  { name: 'a-current', turbidity: 9, rayleigh: 0.5, mie: 0.0028, g: 0.78, exposure: 0.95 },
  { name: 'b-haze6', turbidity: 6, rayleigh: 0.5, mie: 0.0018, g: 0.8, exposure: 0.95 },
  { name: 'c-clear', turbidity: 4, rayleigh: 0.6, mie: 0.0012, g: 0.82, exposure: 0.95 },
  { name: 'd-haze6-dark', turbidity: 6, rayleigh: 0.5, mie: 0.0018, g: 0.8, exposure: 0.82 },
  { name: 'e-clear-dark', turbidity: 4, rayleigh: 0.6, mie: 0.0012, g: 0.82, exposure: 0.82 },
];

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.stack || e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(process.env.QA_URL || 'http://127.0.0.1:3000/', { waitUntil: 'load' });
await page.click('#battest');
await page.waitForFunction(() => window.__frontline?.active === true, null, { timeout: 45000 });
await page.waitForTimeout(2000);

await page.evaluate(() => {
  const a = window.__frontline;
  const w = a.world;
  const town = w.towns.find((t) => t.name === 'NORTHGATE');
  let best = null;
  for (let i = 0; i < 96; i++) {
    const ang = (i / 96) * Math.PI * 2;
    for (const d of [town.r + 40, town.r + 80, town.r + 120, town.r + 160]) {
      const x = town.x + Math.cos(ang) * d;
      const z = town.z + Math.sin(ang) * d;
      if (Math.abs(x) > 480 || Math.abs(z) > 480) continue;
      const y = w.terrainHeight(x, z);
      if (!best || y > best.y) best = { x, y, z };
    }
  }
  const p = a.offlinePlayer;
  p.pos = [best.x, best.y + 0.2, best.z];
  p.vel = [0, 0, 0];
  const dx = town.x - best.x, dz = town.z - best.z;
  a.aimYaw = Math.atan2(-dx, -dz);
  a.aimPitch = -0.02;
  // Hide the first-person weapon so the frame is sky/terrain only.
  a._vmUpdate = a.viewmodel.update;
  a.viewmodel.update = () => {};
  a.viewmodel.root.visible = false;
});
await page.waitForTimeout(500);

for (const c of CANDIDATES) {
  await page.evaluate((c) => {
    const a = window.__frontline;
    const u = a.renderer.sky.material.uniforms;
    u.turbidity.value = c.turbidity;
    u.rayleigh.value = c.rayleigh;
    u.mieCoefficient.value = c.mie;
    u.mieDirectionalG.value = c.g;
    a.renderer.renderer.toneMappingExposure = c.exposure;
  }, c);
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, `tune-${c.name}.png`) });
  console.log('captured', c.name);
}

console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
