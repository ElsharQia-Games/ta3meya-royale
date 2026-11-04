// Procedural textures. Everything is generated in a canvas at load time, so the
// project ships with zero third-party art assets and no licensing ambiguity.
import * as THREE from 'three';

const cache = new Map();

function canvas(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function finish(c, repeat = 1, aniso = 8) {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

function grain(ctx, size, r, amount, alpha = 0.06) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  ctx.globalAlpha = alpha;
}

// ---------------------------------------------------------------------------
// Building surfaces
// ---------------------------------------------------------------------------
function concrete() {
  const size = 256, c = canvas(size), ctx = c.getContext('2d');
  const r = rng(11);
  ctx.fillStyle = '#9d9c93';
  ctx.fillRect(0, 0, size, size);
  // aggregate speckle
  for (let i = 0; i < 2600; i++) {
    const g = 110 + r() * 90;
    ctx.fillStyle = `rgba(${g},${g},${g * 0.97},${0.05 + r() * 0.22})`;
    const s = 0.6 + r() * 2.4;
    ctx.fillRect(r() * size, r() * size, s, s);
  }
  // formwork seams
  ctx.strokeStyle = 'rgba(80,78,72,0.30)';
  ctx.lineWidth = 1.4;
  for (let y = 0; y <= size; y += 64) {
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(size, y + 0.5); ctx.stroke();
  }
  for (let x = 0; x <= size; x += 128) {
    ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, size); ctx.stroke();
  }
  // stains
  for (let i = 0; i < 18; i++) {
    const x = r() * size, y = r() * size, rad = 8 + r() * 34;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(70,68,62,${0.04 + r() * 0.08})`);
    g.addColorStop(1, 'rgba(70,68,62,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  grain(ctx, size, r, 16, 0.1);
  return finish(c, 1);
}

function brick() {
  const size = 256, c = canvas(size), ctx = c.getContext('2d');
  const r = rng(23);
  ctx.fillStyle = '#7d7266';
  ctx.fillRect(0, 0, size, size);
  const bw = 42, bh = 19, mortar = 3;
  for (let row = 0, y = 0; y < size + bh; row++, y += bh + mortar) {
    const off = row % 2 ? bw / 2 : 0;
    for (let x = -bw; x < size + bw; x += bw + mortar) {
      const v = 0.72 + r() * 0.5;
      const rr = Math.round(122 * v), gg = Math.round(72 * v), bb = Math.round(56 * v);
      ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
      ctx.fillRect(x + off, y, bw, bh);
      // brick face shading
      ctx.fillStyle = `rgba(255,255,255,${0.03 + r() * 0.05})`;
      ctx.fillRect(x + off, y, bw, 2);
      ctx.fillStyle = 'rgba(30,20,15,0.18)';
      ctx.fillRect(x + off, y + bh - 2, bw, 2);
    }
  }
  grain(ctx, size, r, 20, 0.08);
  return finish(c, 1);
}

function plaster() {
  const size = 256, c = canvas(size), ctx = c.getContext('2d');
  const r = rng(31);
  ctx.fillStyle = '#bdb5a4';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) {
    const a = 0.02 + r() * 0.05;
    ctx.fillStyle = r() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(90,84,72,${a})`;
    const s = 2 + r() * 14;
    ctx.beginPath();
    ctx.arc(r() * size, r() * size, s, 0, Math.PI * 2);
    ctx.fill();
  }
  // hairline cracks
  ctx.strokeStyle = 'rgba(96,88,76,0.22)';
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 5; i++) {
    let x = r() * size, y = r() * size;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let k = 0; k < 7; k++) {
      x += (r() - 0.5) * 30; y += (r() - 0.5) * 30;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  grain(ctx, size, r, 12, 0.08);
  return finish(c, 1);
}

function wood() {
  const size = 256, c = canvas(size), ctx = c.getContext('2d');
  const r = rng(47);
  ctx.fillStyle = '#8b6339';
  ctx.fillRect(0, 0, size, size);
  for (let p = 0; p < 8; p++) {
    const y0 = p * 32;
    const v = 0.85 + r() * 0.3;
    ctx.fillStyle = `rgb(${Math.round(139 * v)},${Math.round(99 * v)},${Math.round(57 * v)})`;
    ctx.fillRect(0, y0, size, 31);
    // plank grain
    for (let i = 0; i < 26; i++) {
      const yy = y0 + 2 + r() * 27;
      ctx.strokeStyle = `rgba(${40 + r() * 40},${26 + r() * 26},${12 + r() * 16},${0.10 + r() * 0.18})`;
      ctx.lineWidth = 0.7 + r();
      ctx.beginPath();
      ctx.moveTo(0, yy);
      for (let x = 0; x <= size; x += 16) ctx.lineTo(x, yy + Math.sin(x * 0.05 + p) * 1.4 + (r() - 0.5) * 1.5);
      ctx.stroke();
    }
    // knots
    if (r() > 0.5) {
      const kx = r() * size, ky = y0 + 8 + r() * 15;
      ctx.strokeStyle = 'rgba(52,32,16,0.45)';
      ctx.lineWidth = 1.2;
      for (let k = 1; k <= 3; k++) {
        ctx.beginPath();
        ctx.ellipse(kx, ky, k * 2.6, k * 1.7, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.fillStyle = 'rgba(35,22,10,0.35)';
    ctx.fillRect(0, y0 + 30, size, 2);
  }
  grain(ctx, size, r, 18, 0.08);
  return finish(c, 1);
}

function metal() {
  const size = 256, c = canvas(size), ctx = c.getContext('2d');
  const r = rng(59);
  ctx.fillStyle = '#767b82';
  ctx.fillRect(0, 0, size, size);
  // brushed streaks
  for (let i = 0; i < 2200; i++) {
    const g = 90 + r() * 70;
    ctx.strokeStyle = `rgba(${g},${g + 3},${g + 7},${0.03 + r() * 0.1})`;
    ctx.lineWidth = 0.5 + r();
    const y = r() * size;
    ctx.beginPath(); ctx.moveTo(r() * size, y); ctx.lineTo(r() * size, y); ctx.stroke();
  }
  // rivets
  for (let y = 24; y < size; y += 64) {
    for (let x = 24; x < size; x += 64) {
      ctx.fillStyle = 'rgba(40,44,48,0.5)';
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(190,198,206,0.28)';
      ctx.beginPath(); ctx.arc(x - 1, y - 1, 1.7, 0, Math.PI * 2); ctx.fill();
    }
  }
  // rust patches
  for (let i = 0; i < 14; i++) {
    const x = r() * size, y = r() * size, rad = 4 + r() * 18;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(122,64,30,${0.16 + r() * 0.2})`);
    g.addColorStop(1, 'rgba(122,64,30,0)');
    ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  grain(ctx, size, r, 12, 0.06);
  return finish(c, 1);
}

function sandbag() {
  const size = 256, c = canvas(size), ctx = c.getContext('2d');
  const r = rng(67);
  ctx.fillStyle = '#9a8a63';
  ctx.fillRect(0, 0, size, size);
  const bw = 64, bh = 30;
  for (let row = 0, y = 0; y < size; row++, y += bh + 2) {
    const off = row % 2 ? bw / 2 : 0;
    for (let x = -bw; x < size + bw; x += bw + 2) {
      const v = 0.85 + r() * 0.28;
      ctx.fillStyle = `rgb(${Math.round(150 * v)},${Math.round(134 * v)},${Math.round(95 * v)})`;
      ctx.beginPath();
      ctx.roundRect(x + off, y, bw, bh, 9);
      ctx.fill();
      ctx.strokeStyle = 'rgba(70,62,42,0.35)';
      ctx.lineWidth = 1.5; ctx.stroke();
    }
  }
  for (let i = 0; i < 1600; i++) {
    ctx.fillStyle = `rgba(${60 + r() * 60},${55 + r() * 50},${30 + r() * 40},${0.04 + r() * 0.12})`;
    ctx.fillRect(r() * size, r() * size, 1.5, 1.5);
  }
  grain(ctx, size, r, 14, 0.08);
  return finish(c, 1);
}

function glass() {
  const size = 128, c = canvas(size), ctx = c.getContext('2d');
  const r = rng(71);
  ctx.fillStyle = '#a9c8d6';
  ctx.fillRect(0, 0, size, size);
  // grime and streaks
  for (let i = 0; i < 60; i++) {
    const g = ctx.createLinearGradient(0, r() * size, 0, r() * size + 20);
    g.addColorStop(0, 'rgba(255,255,255,0.06)');
    g.addColorStop(1, 'rgba(120,140,150,0.10)');
    ctx.fillStyle = g;
    ctx.fillRect(r() * size, r() * size, 2 + r() * 8, 20 + r() * 40);
  }
  ctx.strokeStyle = 'rgba(220,235,240,0.30)';
  ctx.lineWidth = 1;
  ctx.strokeRect(4, 4, size - 8, size - 8);
  return finish(c, 1);
}

function rock() {
  const size = 256, c = canvas(size), ctx = c.getContext('2d');
  const r = rng(83);
  ctx.fillStyle = '#7b7d80';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 220; i++) {
    const g = 90 + r() * 70;
    ctx.fillStyle = `rgba(${g},${g},${g + 4},${0.08 + r() * 0.2})`;
    const s = 3 + r() * 26;
    ctx.beginPath();
    ctx.moveTo(r() * size, r() * size);
    for (let k = 0; k < 5; k++) ctx.lineTo(r() * size, r() * size);
    ctx.closePath(); ctx.fill();
  }
  for (let i = 0; i < 6; i++) {
    ctx.strokeStyle = 'rgba(45,46,48,0.4)';
    ctx.lineWidth = 1 + r();
    ctx.beginPath();
    ctx.moveTo(r() * size, r() * size);
    ctx.lineTo(r() * size, r() * size);
    ctx.stroke();
  }
  grain(ctx, size, r, 22, 0.1);
  return finish(c, 1);
}

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------
function ground() {
  const size = 256, c = canvas(size), ctx = c.getContext('2d');
  const r = rng(97);
  ctx.fillStyle = '#b8b59f';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 5200; i++) {
    const g = 130 + r() * 80;
    ctx.fillStyle = `rgba(${g * .98},${g},${g * .86},${.04 + r() * .16})`;
    const x = r() * size, y = r() * size, s = 1 + r() * 4;
    ctx.fillRect(x, y, s, s * 1.6);
  }
  // dry patches
  for (let i = 0; i < 24; i++) {
    const x = r() * size, y = r() * size, rad = 8 + r() * 30;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(133,123,94,${.10 + r() * .16})`);
    g.addColorStop(1, 'rgba(133,123,94,0)');
    ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  grain(ctx, size, r, 20, 0.06);
  return finish(c, 1);
}

function asphalt() {
  const size = 256, c = canvas(size), ctx = c.getContext('2d');
  const r = rng(101);
  ctx.fillStyle = '#3f4246';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 8000; i++) {
    const g = 40 + r() * 80;
    ctx.fillStyle = `rgba(${g},${g + 2},${g + 4},${0.05 + r() * 0.2})`;
    const s = 0.6 + r() * 2;
    ctx.fillRect(r() * size, r() * size, s, s);
  }
  for (let i = 0; i < 10; i++) {
    ctx.strokeStyle = 'rgba(25,26,28,0.35)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    let x = r() * size, y = r() * size;
    ctx.moveTo(x, y);
    for (let k = 0; k < 8; k++) { x += (r() - 0.5) * 24; y += (r() - 0.5) * 24; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  grain(ctx, size, r, 16, 0.06);
  return finish(c, 1);
}

function skyGradient() {
  const c = canvas(4);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 4);
  g.addColorStop(0, '#6f9fd0');
  g.addColorStop(1, '#dfeaf2');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 4);
  return finish(c, 1);
}

// Tileable cloud sheet. Value-noise octaves are generated on wrapped lattices so
// the alpha map repeats without a seam when the sky plane scrolls.
function clouds() {
  const size = 256, c = canvas(size), ctx = c.getContext('2d');
  const r = rng(77);
  const octaves = [[4, 0.55], [8, 0.25], [16, 0.14], [32, 0.06]];
  const lattice = new Map();
  for (const [f] of octaves) {
    const arr = new Float32Array(f * f);
    for (let i = 0; i < arr.length; i++) arr[i] = r();
    lattice.set(f, arr);
  }
  const smooth = (t) => t * t * (3 - 2 * t);
  const sample = (arr, g, x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const x0 = ((xi % g) + g) % g, x1 = (x0 + 1) % g;
    const y0 = ((yi % g) + g) % g, y1 = (y0 + 1) % g;
    const v00 = arr[y0 * g + x0], v10 = arr[y0 * g + x1];
    const v01 = arr[y1 * g + x0], v11 = arr[y1 * g + x1];
    const sx = smooth(fx), sy = smooth(fy);
    return (v00 * (1 - sx) + v10 * sx) * (1 - sy)
      + (v01 * (1 - sx) + v11 * sx) * sy;
  };
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0;
      for (const [f, amp] of octaves) {
        n += sample(lattice.get(f), f, (x / size) * f, (y / size) * f) * amp;
      }
      const t = Math.max(0, Math.min(1, (n - 0.48) / 0.24));
      const a = Math.round(255 * t * t * (3 - 2 * t));
      const shade = 200 + Math.round(n * 55);
      const i = (y * size + x) * 4;
      img.data[i] = shade;
      img.data[i + 1] = shade;
      img.data[i + 2] = Math.min(255, shade + 10);
      img.data[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(c, 1);
}

function grainHeight() {
  const c = canvas(256), ctx = c.getContext('2d'), r = rng(4507);
  const data = ctx.createImageData(256, 256);
  for (let i = 0; i < data.data.length; i += 4) {
    const value = 105 + r() * 50;
    data.data[i] = data.data[i + 1] = data.data[i + 2] = value;
    data.data[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  const map = finish(c);
  map.colorSpace = THREE.NoColorSpace;
  return map;
}

function fabric() {
  const c = canvas(256), ctx = c.getContext('2d'), r = rng(914);
  ctx.fillStyle = '#c9c6ae'; ctx.fillRect(0, 0, 256, 256);
  const colours = ['#a4a587', '#ddd4b0', '#8a947a', '#bcb895'];
  for (let i = 0; i < 120; i++) {
    const x = r() * 256, y = r() * 256;
    ctx.fillStyle = colours[i % colours.length];
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4, d = 6 + r() * 20; ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d); }
    ctx.fill();
  }
  ctx.strokeStyle = '#202c2015'; ctx.lineWidth = .6;
  for (let i = 0; i < 256; i += 3) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke(); }
  grain(ctx, 256, r, 9);
  return finish(c);
}

function bark() {
  const c = canvas(256), ctx = c.getContext('2d'), r = rng(5601);
  ctx.fillStyle = '#9e9480'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 240; i++) {
    const x = r() * 256, y = r() * 256;
    ctx.strokeStyle = i % 3 ? '#4d493948' : '#e8dcc35a';
    ctx.lineWidth = 1 + r() * 3;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + r() * 8 - 4, y + 14 + r() * 64); ctx.stroke();
  }
  grain(ctx, 256, r, 15);
  return finish(c);
}

const FACTORIES = {
  concrete, brick, plaster, wood, metal, sandbag, glass, rock,
  ground, asphalt, skyGradient, clouds, grainHeight, fabric, bark,
};

export function texture(name) {
  if (!cache.has(name)) {
    const f = FACTORIES[name];
    cache.set(name, f ? f() : null);
  }
  return cache.get(name);
}

// Per-material texture tiling in metres (world-space UVs are divided by this).
export const TILE = {
  concrete: 2.6, brick: 2.2, plaster: 2.8, wood: 1.6, metal: 2.0,
  sandbag: 2.4, glass: 2.0, rock: 3.0, ground: 5.0, asphalt: 6.0,
};
