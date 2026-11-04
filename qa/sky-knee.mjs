// Sky highlight-knee sweep for the sun-facing vista. Temporary QA script.
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
  { name: 'k-none', knee: 0, gain: 1.0 },
  { name: 'k15-g14', knee: 0.15, gain: 1.4 },
  { name: 'k40-g16', knee: 0.4, gain: 1.6 },
  { name: 'k80-g18', knee: 0.8, gain: 1.8 },
  { name: 'k150-g20', knee: 1.5, gain: 2.0 },
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
  a._vmUpdate = a.viewmodel.update;
  a.viewmodel.update = () => {};
  a.viewmodel.root.visible = false;
  document.getElementById('hud').classList.add('hidden');
});
await page.waitForTimeout(500);

for (const c of CANDIDATES) {
  await page.evaluate((c) => {
    const a = window.__frontline;
    const mat = a.renderer.sky.material;
    if (c.knee > 0) {
      mat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          'gl_FragColor = vec4( retColor, 1.0 );',
          `retColor = ${c.gain.toFixed(2)} * retColor / (1.0 + ${c.knee.toFixed(2)} * retColor);\n\tgl_FragColor = vec4( retColor, 1.0 );`,
        );
      };
    } else {
      mat.onBeforeCompile = () => {};
    }
    mat.needsUpdate = true;
  }, c);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `knee-${c.name}.png`) });
  console.log('captured', c.name);
}

console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
