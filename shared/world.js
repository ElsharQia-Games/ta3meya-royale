// Deterministic world generation + static collision representation.
// Everything resolves to a list of AABBs and a heightfield so the capsule
// controller in sim.js behaves identically on client and server.
import { CFG } from './config.js';

// Seeded RNG (mulberry32) — same map everywhere.
export function rngStream(seed) {
  const obj = { state: seed | 0 };
  obj.fn = function () {
    obj.state |= 0; obj.state = (obj.state + 0x6D2B79F5) | 0;
    let t = Math.imul(obj.state ^ (obj.state >>> 15), 1 | obj.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return obj;
}
export function mulberry32(a) {
  const s = rngStream(a);
  const fn = () => s.fn();
  return fn;
}

export const MAP_SEED = 20261104;

export class World {
  constructor(seed = MAP_SEED) {
    this.rng = mulberry32(seed);
    this.boxes = [];        // {min:[x,y,z], max:[...], tag}  walls, cover, buildings, trees(approx), crates
    this.heights = null;    // heightfield grid (terrain)
    this.gridN = 128;       // 128x128 samples over MAP_SIZE
    this.trees = [];        // {x,z,r,h} visual + trunk collider
    this.props = [];        // loot / vehicle / destructibles
    this.destructibles = []; // {box index, hp, chunks}
    this.generate();
  }

  // ---------- terrain ----------
  buildHeightfield() {
    const N = this.gridN, S = CFG.MAP_SIZE, rng = this.rng;
    const h = new Float32Array(N * N);
    // value noise fBm from seeded random lattice
    const lat = new Float32Array(33 * 33);
    for (let i = 0; i < lat.length; i++) lat[i] = rng();
    const latS = 33;
    const sampleLattice = (gx, gz, scale) => {
      // bilinear on lattice at given scale (scale = tile count across map)
      const lx = (gx / (N - 1)) * (scale - 1) * (latS - 1);
      const lz = (gz / (N - 1)) * (scale - 1) * (latS - 1);
      let x0 = Math.floor(lx), z0 = Math.floor(lz);
      x0 = Math.max(0, Math.min(latS - 2, x0)); z0 = Math.max(0, Math.min(latS - 2, z0));
      const x1 = x0 + 1, z1 = z0 + 1;
      const fx = Math.max(0, Math.min(1, lx - x0)), fz = Math.max(0, Math.min(1, lz - z0));
      const v00 = lat[z0 * latS + x0], v10 = lat[z0 * latS + x1];
      const v01 = lat[z1 * latS + x0], v11 = lat[z1 * latS + x1];
      return (v00 * (1 - fx) + v10 * fx) * (1 - fz) + (v01 * (1 - fx) + v11 * fx) * fz;
    };
    for (let gz = 0; gz < N; gz++) {
      for (let gx = 0; gx < N; gx++) {
        let v = 0, amp = 1, tot = 0;
        for (let o = 0; o < 4; o++) {
          v += sampleLattice(gx, gz, 1 + o * 2) * amp; tot += amp; amp *= 0.5;
        }
        v /= tot;
        const x = gx / (N - 1) * S - S / 2, z = gz / (N - 1) * S - S / 2;
        // flatten center-ish play area a bit, raise edges into hills
        const d = Math.hypot(x, z) / (S / 2);
        let hh = (v - 0.5) * 10 * (0.5 + d * 0.8);
        hh = Math.max(hh, -2);               // some lowlands
        h[gz * N + gx] = hh;
      }
    }
    this.heights = h;
  }

  terrainH(x, z) {
    const N = this.gridN, S = CFG.MAP_SIZE;
    if (!this.heights) return 0;
    const gx = Math.min(N - 1, Math.max(0, (x + S / 2) / S * (N - 1)));
    const gz = Math.min(N - 1, Math.max(0, (z + S / 2) / S * (N - 1)));
    return this.heights[Math.round(gz) * N + Math.round(gx)];
  }

  // ---------- generation ----------
  generate() {
    this.buildHeightfield();
    const rng = this.rng, S = CFG.MAP_SIZE;

    // scatter forests (trunk colliders)
    for (let i = 0; i < 900; i++) {
      const x = (rng() - 0.5) * S * 0.96, z = (rng() - 0.5) * S * 0.96;
      if (Math.hypot(x, z) < 60) continue; // keep center clear-ish
      const r = 0.3 + rng() * 0.25, h = 4 + rng() * 5;
      this.trees.push({ x, z, r, h });
      const y = this.terrainH(x, z);
      this.boxes.push({ min: [x - r, y, z - r], max: [x + r, y + h, z + r], tag: 'tree' });
    }
    // rocks as boxes
    for (let i = 0; i < 220; i++) {
      const x = (rng() - 0.5) * S * 0.94, z = (rng() - 0.5) * S * 0.94;
      const r = 1 + rng() * 2.2, y = this.terrainH(x, z);
      this.boxes.push({ min: [x - r, y, z - r], max: [x + r, y + r * 0.7, z + r], tag: 'rock' });
    }
    // town: two clusters of buildings
    const towns = [[-180, -140], [220, 180], [60, -260]];
    for (const [tx, tz] of towns) {
      for (let i = 0; i < 14; i++) {
        const bx = tx + (rng() - 0.5) * 130, bz = tz + (rng() - 0.5) * 130;
        const w = 9 + rng() * 14, d = 9 + rng() * 14, hgt = 4 + rng() * 7;
        const y = this.terrainH(bx, bz);
        this.boxes.push({ min: [bx - w / 2, y, bz - d / 2], max: [bx + w / 2, y + hgt, bz + d / 2], tag: 'building' });
        // crates around buildings (cover)
        for (let c = 0; c < 4; c++) {
          const cx = bx + (rng() - 0.5) * (w + 8), cz = bz + (rng() - 0.5) * (d + 8);
          const cy = this.terrainH(cx, cz);
          this.boxes.push({ min: [cx - .6, cy, cz - .6], max: [cx + .6, cy + 1.1, cz + .6], tag: 'crate' });
        }
      }
    }
    // scattered cover walls
    for (let i = 0; i < 160; i++) {
      const x = (rng() - 0.5) * S * 0.9, z = (rng() - 0.5) * S * 0.9;
      const horiz = rng() > 0.5, len = 3 + rng() * 5, y = this.terrainH(x, z);
      const dx = horiz ? len / 2 : 0.25, dz = horiz ? 0.25 : len / 2;
      this.boxes.push({ min: [x - dx, y, z - dz], max: [x + dx, y + 1.6, z + dz], tag: 'wall' });
    }
    // destructible cover (server events when destroyed)
    for (let i = 0; i < 60; i++) {
      const x = (rng() - 0.5) * S * 0.85, z = (rng() - 0.5) * S * 0.85;
      const y = this.terrainH(x, z);
      const idx = this.boxes.length;
      this.boxes.push({ min: [x - 1, y, z - .3], max: [x + 1, y + 2.2, z + .3], tag: 'destructible' });
      this.destructibles.push({ idx, hp: 120, x, z });
    }
    // ground plane box (terrain handled by heightfield in capsule solver)
    this.boxes.push({ min: [-S, -10, -S], max: [S, -0.02, S], tag: 'ground' });
  }

  // raycast against AABBs (DDA-free slab test, fine for gunplay) + terrain sample exit
  raycast(origin, dir, maxDist) {
    let best = null, bestT = maxDist;
    for (const b of this.boxes) {
      const t = rayAABB(origin, dir, b);
      if (t !== null && t < bestT && t > 0) { bestT = t; best = b; }
    }
    // terrain as heightfield: step along ray, check crossing
    const steps = Math.ceil(maxDist / 0.5);
    for (let i = 1; i <= steps; i++) {
      const t = i * 0.5;
      if (t > bestT) break;
      const px = origin[0] + dir[0] * t, pz = origin[2] + dir[2] * t, py = origin[1] + dir[1] * t;
      if (py < this.terrainH(px, pz)) { bestT = t; best = { tag: 'terrain' }; break; }
    }
    return best ? { t: bestT, box: best } : null;
  }
}

function rayAABB(o, d, b) {
  let tmin = 0, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const inv = 1 / (d[i] || 1e-12);
    let t0 = (b.min[i] - o[i]) * inv, t1 = (b.max[i] - o[i]) * inv;
    if (inv < 0) [t0, t1] = [t1, t0];
    tmin = Math.max(tmin, t0); tmax = Math.min(tmax, t1);
    if (tmax < tmin) return null;
  }
  return tmin;
}

// Capsule vs world: resolve horizontal penetration against boxes + ground height.
// Returns corrected position and grounded flag + ground normal (for slopes).
export function collideCapsule(world, pos, vel, radius, height, stepHeight) {
  let grounded = false;
  // ground = terrain height
  const groundY = world.terrainH(pos[0], pos[2]);
  const feetY = pos[1];
  if (feetY <= groundY + 0.001 && vel[1] <= 0.01) {
    pos[1] = groundY; grounded = true;
    if (vel[1] < 0) vel[1] = 0;
  }
  // box collisions (3 iterations for corners)
  for (let iter = 0; iter < 3; iter++) {
    for (const b of world.boxes) {
      if (b.tag === 'ground') continue;
      // expand box by capsule xz radius, treat y slab
      const minX = b.min[0] - radius, maxX = b.max[0] + radius;
      const minZ = b.min[2] - radius, maxZ = b.max[2] + radius;
      if (pos[0] < minX || pos[0] > maxX || pos[2] < minZ || pos[2] > maxZ) continue;
      // vertical overlap?
      if (pos[1] + height < b.min[1] + 0.01 || pos[1] > b.max[1] - 0.01) continue;
      // step-up: if feet close to box top, lift
      if (b.max[1] - pos[1] <= stepHeight && b.max[1] - pos[1] >= -0.05 && vel[1] <= 0.5) {
        pos[1] = b.max[1]; grounded = true; continue;
      }
      // push out along smallest penetration axis
      const pushL = pos[0] - minX, pushR = maxX - pos[0];
      const pushB = pos[2] - minZ, pushF = maxZ - pos[2];
      const m = Math.min(pushL, pushR, pushB, pushF);
      if (m === pushL) pos[0] = minX; else if (m === pushR) pos[0] = maxX;
      else if (m === pushB) pos[2] = minZ; else pos[2] = maxZ;
      // kill velocity into wall
      if (m === pushL) vel[0] = Math.max(vel[0], 0); else if (m === pushR) vel[0] = Math.min(vel[0], 0);
      if (m === pushB) vel[2] = Math.max(vel[2], 0); else if (m === pushF) vel[2] = Math.min(vel[2], 0);
    }
  }
  return grounded;
}
