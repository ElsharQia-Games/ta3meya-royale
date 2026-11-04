// Deterministic math helpers shared by client and server.
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
export const smootherstep = (t) => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const TAU = Math.PI * 2;

export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
export function angleDelta(a, b) { return wrapAngle(b - a); }
export function lerpAngle(a, b, t) { return a + angleDelta(a, b) * t; }

export function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
export function dist3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

export function normalize3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  v[0] /= l; v[1] /= l; v[2] /= l; return v;
}

export function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Serializable RNG so the sim state can be snapshotted/restored.
export class RNG {
  constructor(seed) { this.state = seed | 0; }
  next() {
    this.state = (this.state + 0x6D2B79F5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + this.next() * (b - a); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p) { return this.next() < p; }
}

// Hash a 2D cell into [0,1).
export function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519);
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Value noise (smooth bilinear) used for terrain and textures.
export function valueNoise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smoothstep(xf), v = smoothstep(yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

export function fbm2(x, y, octaves = 4, seed = 0, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x * freq, y * freq, seed + i * 31) * amp;
    norm += amp; amp *= gain; freq *= lacunarity;
  }
  return sum / norm;
}

// Cone direction around a forward vector (deterministic given rng).
export function spreadDirection(dir, cone, rng) {
  const a = rng.next() * TAU;
  const r = Math.sqrt(rng.next()) * cone;
  // Build an orthonormal basis around dir.
  let ux, uy, uz;
  if (Math.abs(dir[1]) < 0.9) { ux = 0; uy = 1; uz = 0; } else { ux = 1; uy = 0; uz = 0; }
  // right = normalize(cross(dir, up))
  let rx = dir[1] * uz - dir[2] * uy;
  let ry = dir[2] * ux - dir[0] * uz;
  let rz = dir[0] * uy - dir[1] * ux;
  const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
  // up2 = cross(right, dir)
  const ux2 = ry * dir[2] - rz * dir[1];
  const uy2 = rz * dir[0] - rx * dir[2];
  const uz2 = rx * dir[1] - ry * dir[0];
  const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
  const out = [
    dir[0] + rx * ca + ux2 * sa,
    dir[1] + ry * ca + uy2 * sa,
    dir[2] + rz * ca + uz2 * sa,
  ];
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  return [out[0] / l, out[1] / l, out[2] / l];
}

// Yaw convention: 0 looks toward -Z, positive yaw turns left (Three.js Y-up).
export function dirFromAngles(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
export function yawTo(x, z, tx, tz) { return Math.atan2(-(tx - x), -(tz - z)); }

// Quantisation helpers used by the wire protocol.
export const qPos = (v) => Math.round(v * 100) / 100;
export const qYaw = (a) => Math.round(wrapAngle(a) * 1000) / 1000;
export const qPitch = (a) => Math.round(clamp(a, -1.5, 1.5) * 1000) / 1000;
