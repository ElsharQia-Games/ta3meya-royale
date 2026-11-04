// ============================================================================
// Deterministic world generation + collision queries.
// Terrain = bilinear heightfield. Structures = AABBs in a spatial hash.
// Client renders from the same descriptors the server collides with.
// ============================================================================
import { CFG, MATERIALS } from './config.js';
import { RNG, clamp, lerp, smoothstep, fbm2, hash2, TAU } from './math.js';

const CELL = 8;

export class World {
  constructor(seed = CFG.MAP.SEED) {
    this.seed = seed | 0;
    this.rng = new RNG(seed);
    this.size = CFG.MAP.SIZE;
    this.half = this.size / 2;
    this.N = CFG.MAP.GRID;
    this.heights = new Float32Array(this.N * this.N);
    this.boxes = [];
    this.grid = new Map();
    this.towns = [];
    this.buildings = [];
    this.trees = [];
    this.rocks = [];
    this.props = [];
    this.roads = [];
    this.lootSpawns = [];
    this.vehicleSpawns = [];
    this.spawnPoints = [];
    this.teamSpawns = [[], []];
    this.destructibles = [];
    this.waterBodies = [];
    this._stamp = 0;
    this.generate();
  }

  // --------------------------------------------------------------------------
  // Terrain
  // --------------------------------------------------------------------------
  buildTerrain() {
    const N = this.N, S = this.size, half = this.half, rng = this.rng;
    // Town/lake layout is needed before flattening.
    this.defineTowns();
    const lake = this.lake = { x: -330, z: 318, r: 105, level: CFG.MAP.WATER_LEVEL };

    const raw = new Float32Array(N * N);
    for (let gz = 0; gz < N; gz++) {
      for (let gx = 0; gx < N; gx++) {
        const x = (gx / (N - 1)) * S - half;
        const z = (gz / (N - 1)) * S - half;
        const nx = x / S, nz = z / S;
        let h = (fbm2(nx * 5.5 + 11.3, nz * 5.5 + 3.7, 5, this.seed) - 0.5) * 24;
        h += (fbm2(nx * 17 + 4.1, nz * 17 + 9.2, 3, this.seed + 71) - 0.5) * 4.5;
        // rolling ridges, stronger toward the map edge
        const rr = Math.hypot(x, z) / half;
        const edge = smoothstep((rr - 0.52) / 0.38);
        h += edge * (fbm2(nx * 9 + 31, nz * 9 + 17, 4, this.seed + 133) * 26);
        // gentle central valley
        h *= 0.72 + 0.28 * smoothstep(rr / 0.7);
        raw[gz * N + gx] = h;
      }
    }
    // Flatten town pads.
    for (const t of this.towns) {
      const cx = t.x, cz = t.z, r = t.r;
      const target = this.sampleRaw(raw, cx, cz);
      for (let gz = 0; gz < N; gz++) {
        for (let gx = 0; gx < N; gx++) {
          const x = (gx / (N - 1)) * S - half, z = (gz / (N - 1)) * S - half;
          const d = Math.hypot(x - cx, z - cz);
          if (d > r * 1.25) continue;
          const k = 1 - smoothstep((d - r * 0.55) / (r * 0.7));
          const i = gz * N + gx;
          raw[i] = lerp(raw[i], target + Math.sin(x * 0.09) * 0.25, k * 0.92);
        }
      }
    }
    // Carve the lake basin.
    for (let gz = 0; gz < N; gz++) {
      for (let gx = 0; gx < N; gx++) {
        const x = (gx / (N - 1)) * S - half, z = (gz / (N - 1)) * S - half;
        const d = Math.hypot(x - lake.x, z - lake.z);
        if (d > lake.r * 1.5) continue;
        const k = 1 - smoothstep((d - lake.r * 0.5) / (lake.r * 0.85));
        const i = gz * N + gx;
        raw[i] = lerp(raw[i], lake.level - 5.5, k);
      }
    }
    // Find the actual lake surface from the carved basin.
    let minLake = Infinity;
    for (let gz = 0; gz < N; gz++) for (let gx = 0; gx < N; gx++) {
      const x = (gx / (N - 1)) * S - half, z = (gz / (N - 1)) * S - half;
      if (Math.hypot(x - lake.x, z - lake.z) < lake.r * 0.4) minLake = Math.min(minLake, raw[gz * N + gx]);
    }
    lake.level = Math.max(CFG.MAP.WATER_LEVEL, minLake + 2.2);
    this.heights.set(raw);
    this.waterBodies.push({ x: lake.x, z: lake.z, r: lake.r, level: lake.level });
  }

  sampleRaw(arr, x, z) {
    const N = this.N, half = this.half;
    const fx = clamp((x + half) / this.size * (N - 1), 0, N - 1);
    const fz = clamp((z + half) / this.size * (N - 1), 0, N - 1);
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    const x1 = Math.min(N - 1, x0 + 1), z1 = Math.min(N - 1, z0 + 1);
    const tx = fx - x0, tz = fz - z0;
    const a = arr[z0 * N + x0], b = arr[z0 * N + x1], c = arr[z1 * N + x0], d = arr[z1 * N + x1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  terrainHeight(x, z) {
    return this.sampleRaw(this.heights, x, z);
  }

  // Flatten a rectangular pad (with a smooth feather) into the heightfield.
  // Used for building footprints so door thresholds stay inside the character
  // step limit. Deterministic: writes the shared heightfield in grid order.
  flattenPad(cx, cz, halfW, halfD, target, feather = 2.4) {
    const N = this.N, S = this.size, half = this.half;
    const x0 = cx - halfW - feather, x1 = cx + halfW + feather;
    const z0 = cz - halfD - feather, z1 = cz + halfD + feather;
    const gx0 = clamp(Math.floor((x0 + half) / S * (N - 1)), 0, N - 1);
    const gx1 = clamp(Math.ceil((x1 + half) / S * (N - 1)), 0, N - 1);
    const gz0 = clamp(Math.floor((z0 + half) / S * (N - 1)), 0, N - 1);
    const gz1 = clamp(Math.ceil((z1 + half) / S * (N - 1)), 0, N - 1);
    for (let gz = gz0; gz <= gz1; gz++) {
      const z = (gz / (N - 1)) * S - half;
      const dz = Math.max(0, Math.abs(z - cz) - halfD);
      for (let gx = gx0; gx <= gx1; gx++) {
        const x = (gx / (N - 1)) * S - half;
        const dx = Math.max(0, Math.abs(x - cx) - halfW);
        const d = Math.hypot(dx, dz);
        if (d > feather) continue;
        const k = 1 - smoothstep(d / feather);
        const i = gz * N + gx;
        this.heights[i] = lerp(this.heights[i], target, k);
      }
    }
  }

  terrainNormal(x, z, out = [0, 1, 0]) {
    const e = 0.6;
    const hL = this.terrainHeight(x - e, z), hR = this.terrainHeight(x + e, z);
    const hD = this.terrainHeight(x, z - e), hU = this.terrainHeight(x, z + e);
    let nx = hL - hR, ny = 2 * e, nz = hD - hU;
    const l = Math.hypot(nx, ny, nz) || 1;
    out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
    return out;
  }

  isWater(x, z, y = null) {
    const h = this.terrainHeight(x, z);
    if (y === null) y = h;
    return y < this.lake.level - 0.15 && Math.hypot(x - this.lake.x, z - this.lake.z) < this.lake.r * 1.45;
  }

  waterDepth(x, z) {
    // Water only exists inside the lake basin; low terrain elsewhere is dry.
    if (Math.hypot(x - this.lake.x, z - this.lake.z) > this.lake.r * 1.45) return 0;
    return Math.max(0, this.lake.level - this.terrainHeight(x, z));
  }

  // --------------------------------------------------------------------------
  // Layout
  // --------------------------------------------------------------------------
  defineTowns() {
    this.towns = [
      { name: 'NORTHGATE', x: 20, z: -300, r: 128, type: 'urban' },
      { name: 'HAVEN', x: -300, z: 118, r: 120, type: 'urban' },
      { name: 'RIDGE', x: 302, z: 176, r: 122, type: 'industrial' },
      { name: 'MILL', x: -158, z: -88, r: 82, type: 'village' },
      { name: 'PORT', x: 205, z: -112, r: 92, type: 'village' },
      { name: 'FORT DRAKE', x: 0, z: 288, r: 72, type: 'military' },
    ];
  }

  generate() {
    this.buildTerrain();
    this.buildRoads();
    for (const t of this.towns) this.buildTown(t);
    this.scatterVegetation();
    this.scatterRocks();
    this.scatterCover();
    this.buildBoundary();
    this.buildLootAndSpawns();
    this.rebuildGrid();
    this.computeStats();
  }

  addBox(min, max, opts = {}) {
    const b = {
      min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]],
      tag: opts.tag || 'structure',
      mat: opts.mat || 'concrete',
      render: opts.render !== false,
      dynamic: !!opts.dynamic,
      destroyed: false,
      id: this.boxes.length,
      hp: opts.hp || 0,
      maxHp: opts.hp || 0,
      kind: opts.kind || null,
    };
    this.boxes.push(b);
    if (b.dynamic && b.hp > 0) this.destructibles.push({ box: b.id, hp: b.hp, maxHp: b.hp, kind: b.kind || 'crate' });
    return b;
  }

  // Wall along X or Z with rectangular openings (doors/windows).
  wallWithOpenings(axis, fixed, start, end, y0, height, thickness, openings, mat = 'concrete', tag = 'wall') {
    const t = thickness / 2;
    const cuts = openings.slice().sort((a, b) => a.at - b.at);
    let cursor = start;
    const addSpan = (a, b, ya, yb) => {
      if (b - a < 0.02 || yb - ya < 0.02) return;
      if (axis === 'x') this.addBox([a, ya, fixed - t], [b, yb, fixed + t], { tag, mat });
      else this.addBox([fixed - t, ya, a], [fixed + t, yb, b], { tag, mat });
    };
    for (const o of cuts) {
      const oa = start + o.at, ob = oa + o.width;
      addSpan(cursor, oa, y0, y0 + height);
      const bottom = o.bottom || 0;
      const top = o.top === undefined ? height : o.top;
      if (bottom > 0) addSpan(oa, ob, y0, y0 + bottom);
      if (top < height) addSpan(oa, ob, y0 + top, y0 + height);
      // Glass panes are visual only.
      if (o.glass) {
        const gy0 = y0 + bottom + 0.02, gy1 = y0 + top - 0.02;
        if (axis === 'x') this.addBox([oa + 0.02, gy0, fixed - 0.02], [ob - 0.02, gy1, fixed + 0.02], { tag: 'glass', mat: 'glass', render: true });
        else this.addBox([fixed - 0.02, gy0, oa + 0.02], [fixed + 0.02, gy1, ob - 0.02], { tag: 'glass', mat: 'glass', render: true });
      }
      cursor = ob;
    }
    addSpan(cursor, end, y0, y0 + height);
  }

  buildTown(t) {
    const rng = this.rng;
    const pad = t.r;
    const targetH = this.terrainHeight(t.x, t.z);
    const cell = 30;
    const plots = [];
    const span = Math.ceil(pad / cell) + 1;
    for (let iz = -span; iz <= span; iz++) {
      for (let ix = -span; ix <= span; ix++) {
        const px = t.x + ix * cell, pz = t.z + iz * cell;
        const d = Math.hypot(px - t.x, pz - t.z);
        if (d > pad - 6) continue;
        // Streets every third row/column.
        if (Math.abs(ix % 3) === 0 || Math.abs(iz % 3) === 0) {
          if (rng.chance(0.35)) plots.push({ px, pz, street: true });
          continue;
        }
        if (rng.chance(t.type === 'military' ? 0.5 : 0.72)) plots.push({ px, pz, street: false });
      }
    }
    // Town street grid (visual roads).
    for (let ix = -span; ix <= span; ix += 3) {
      const x = t.x + ix * cell;
      if (Math.abs(x - t.x) < pad) this.roads.push({ points: [[x, t.z - pad * 0.95], [x, t.z + pad * 0.95]], width: 6.5, town: true });
    }
    for (let iz = -span; iz <= span; iz += 3) {
      const z = t.z + iz * cell;
      if (Math.abs(z - t.z) < pad) this.roads.push({ points: [[t.x - pad * 0.95, z], [t.x + pad * 0.95, z]], width: 6.5, town: true });
    }
    const placed = [];
    for (const plot of plots) {
      if (plot.street) {
        // occasional street props
        if (rng.chance(0.3)) this.addProp(rng.pick(['barrier', 'sandbag', 'barrel', 'wreck']), plot.px + rng.range(-4, 4), plot.pz + rng.range(-4, 4), rng.next() * TAU);
        continue;
      }
      const w = rng.range(9, t.type === 'military' ? 18 : 16);
      const d = rng.range(9, t.type === 'military' ? 16 : 15);
      const rot = rng.chance(0.5) ? 0 : Math.PI / 2;
      const ww = rot === 0 ? w : d, dd = rot === 0 ? d : w;
      let overlap = false;
      for (const p of placed) {
        if (Math.abs(plot.px - p.x) < (ww + p.w) / 2 + 3 && Math.abs(plot.pz - p.z) < (dd + p.d) / 2 + 3) { overlap = true; break; }
      }
      if (overlap) continue;
      placed.push({ x: plot.px, z: plot.pz, w: ww, d: dd });
      const floors = t.type === 'military' ? rng.int(1, 2) : rng.chance(0.35) ? 2 : 1;
      this.buildBuilding(plot.px, plot.pz, ww, dd, floors, targetH, rng, t.type);
    }
    // Town outskirts cover.
    for (let i = 0; i < 10; i++) {
      const a = rng.next() * TAU, rr = pad * rng.range(0.9, 1.12);
      const x = t.x + Math.cos(a) * rr, z = t.z + Math.sin(a) * rr;
      this.addProp(rng.pick(['barrier', 'sandbag', 'crate', 'barrel', 'fence', 'wreck']), x, z, rng.next() * TAU);
    }
  }

  buildBuilding(cx, cz, w, d, floors, padH, rng, townType) {
    const floorH = 3.15;
    const hw = w / 2, hd = d / 2;
    // Flatten the terrain under and just around the footprint to the town pad
    // height. Without this the 1.6 m foundation can sit up to ~1.5 m above the
    // local terrain, making doorways too tall to step through (the character
    // step limit is 0.5 m) and stranding bots outside every building.
    this.flattenPad(cx, cz, hw + 1.2, hd + 1.2, padH, 2.4);
    const y0 = padH + 0.06;
    const wallT = 0.24;
    const b = { x: cx, z: cz, w, d, floors, y0, floorH, type: townType, doors: [] };
    this.buildings.push(b);

    // Foundation pad (slightly larger, sits into terrain).
    this.addBox([cx - hw - 0.4, y0 - 1.6, cz - hd - 0.4], [cx + hw + 0.4, y0 + 0.04, cz + hd + 0.4], { tag: 'foundation', mat: 'concrete' });

    const doorW = 1.45, doorH = 2.35;
    const frontDoor = rng.range(0.25, 0.75) * (w - doorW - 1.0) + 0.5;
    const backDoor = rng.chance(0.55) ? rng.range(0.25, 0.75) * (w - doorW - 1.0) + 0.5 : null;
    const sideDoor = rng.chance(0.4) ? rng.range(0.25, 0.75) * (d - doorW - 1.0) + 0.5 : null;

    for (let f = 0; f < floors; f++) {
      const fy = y0 + f * floorH;
      // perimeter walls
      const winY = 1.05, winH = 1.15;
      const frontOpen = [{ at: frontDoor, width: doorW, bottom: 0, top: doorH }];
      const backOpen = backDoor !== null ? [{ at: backDoor, width: doorW, bottom: 0, top: doorH }] : [];
      const sideOpen = sideDoor !== null ? [{ at: sideDoor, width: doorW, bottom: 0, top: doorH }] : [];
      // windows on each side (skip ground-floor front where the door is)
      const winCount = Math.max(1, Math.floor(w / 7));
      for (let i = 0; i < winCount; i++) {
        const at = 1.2 + i * (w - 2.4) / winCount + rng.range(-0.3, 0.3);
        if (Math.abs(at - frontDoor) > doorW + 1.2) frontOpen.push({ at, width: 1.35, bottom: winY, top: winY + winH, glass: true });
        if (backDoor === null || Math.abs(at - backDoor) > doorW + 1.2) backOpen.push({ at, width: 1.35, bottom: winY, top: winY + winH, glass: true });
      }
      const winCountD = Math.max(1, Math.floor(d / 7));
      for (let i = 0; i < winCountD; i++) {
        const at = 1.2 + i * (d - 2.4) / winCountD + rng.range(-0.3, 0.3);
        if (sideDoor === null || Math.abs(at - sideDoor) > doorW + 1.2) sideOpen.push({ at, width: 1.35, bottom: winY, top: winY + winH, glass: true });
      }
      this.wallWithOpenings('x', cz - hd, cx - hw, cx + hw, fy, floorH, wallT, frontOpen, f === 0 ? 'brick' : 'plaster');
      this.wallWithOpenings('x', cz + hd, cx - hw, cx + hw, fy, floorH, wallT, backOpen, f === 0 ? 'brick' : 'plaster');
      this.wallWithOpenings('z', cx - hw, cz - hd, cz + hd, fy, floorH, wallT, sideOpen, 'plaster');
      this.wallWithOpenings('z', cx + hw, cz - hd, cz + hd, fy, floorH, wallT, [], 'plaster');

      // Doorway metadata is used by the bot nav grid to carve passages. The
      // outward normal points away from the building centre so path planning
      // can insert an approach/exit point on the correct side.
      const addDoor = (axis, fixed, a, width, kind) => {
        const bb = a + width;
        const cx0 = axis === 'x' ? (a + bb) / 2 : fixed;
        const cz0 = axis === 'x' ? fixed : (a + bb) / 2;
        const nx = axis === 'z' ? Math.sign(fixed - cx) || 1 : 0;
        const nz = axis === 'x' ? Math.sign(fixed - cz) || 1 : 0;
        b.doors.push({ axis, fixed, a, b: bb, width, cx: cx0, cz: cz0, nx, nz, floor: f, y: fy, kind });
      };
      addDoor('x', cz - hd, cx - hw + frontDoor, doorW, 'front');
      if (backDoor !== null) addDoor('x', cz + hd, cx - hw + backDoor, doorW, 'back');
      if (sideDoor !== null) addDoor('z', cx - hw, cz - hd + sideDoor, doorW, 'side');

      // interior partition with doorway
      if (w > 11) {
        const px = cx + rng.range(-w * 0.18, w * 0.18);
        const gapAt = rng.range(0.2, 0.8) * (d - 1.4);
        this.wallWithOpenings('z', px, cz - hd + 0.1, cz + hd - 0.1, fy, floorH - 0.15, 0.16,
          [{ at: gapAt, width: 1.25, bottom: 0, top: 2.2 }], 'plaster', 'interior');
        addDoor('z', px, cz - hd + 0.1 + gapAt, 1.25, 'interior');
      }

      // upper floor slab with a stairwell hole
      if (f > 0) {
        const sx = cx - hw + 1.0, sz = cz - hd + 1.0; // stairwell corner
        const holeW = 1.6, holeD = 3.4;
        const slabT = 0.16;
        // four slabs around the hole
        this.addBox([cx - hw, fy - slabT, cz - hd], [sx, fy, cz + hd], { tag: 'floor', mat: 'wood' });
        this.addBox([sx + holeW, fy - slabT, cz - hd], [cx + hw, fy, cz + hd], { tag: 'floor', mat: 'wood' });
        this.addBox([sx, fy - slabT, cz - hd], [sx + holeW, fy, sz], { tag: 'floor', mat: 'wood' });
        this.addBox([sx, fy - slabT, sz + holeD], [sx + holeW, fy, cz + hd], { tag: 'floor', mat: 'wood' });
      }
      // stairs to the next floor
      if (f < floors - 1) {
        const sx = cx - hw + 1.0, sz = cz - hd + 1.0;
        const steps = 13, stepH = floorH / steps, stepD = 3.2 / steps;
        for (let i = 0; i < steps; i++) {
          this.addBox([sx, fy + i * stepH, sz + i * stepD], [sx + 1.5, fy + (i + 1) * stepH, sz + (i + 1) * stepD + 0.02], { tag: 'stairs', mat: 'wood' });
        }
      }
      // furniture
      const furnitureCount = rng.int(2, 5);
      for (let i = 0; i < furnitureCount; i++) {
        const fx = cx + rng.range(-hw + 1.2, hw - 1.2);
        const fz = cz + rng.range(-hd + 1.2, hd - 1.2);
        // Keep every doorway (front/back/side and the interior partition)
        // clear. Furniture used to be skipped only near the front door, which
        // could completely plug the interior doorway and make half a building
        // unreachable for bots.
        let blocksDoor = false;
        for (const dr of b.doors) {
          if (dr.floor !== f) continue;
          if (Math.hypot(fx - dr.cx, fz - dr.cz) < 3.0) { blocksDoor = true; break; }
        }
        if (blocksDoor) continue;
        const kind = rng.pick(['table', 'shelf', 'crate', 'bed']);
        this.addFurniture(kind, fx, fy, fz, rng);
      }
      // loot spawn points on this floor
      const lootN = rng.int(1, 3);
      for (let i = 0; i < lootN; i++) {
        this.lootSpawns.push({
          x: cx + rng.range(-hw + 1, hw - 1), y: fy + 0.05, z: cz + rng.range(-hd + 1, hd - 1),
          tier: townType === 'military' ? 3 : townType === 'urban' ? 2 : 1, indoor: true,
        });
      }
    }

    // Roof + parapet
    const top = y0 + floors * floorH;
    this.addBox([cx - hw - 0.15, top - 0.18, cz - hd - 0.15], [cx + hw + 0.15, top, cz + hd + 0.15], { tag: 'roof', mat: 'concrete' });
    const pw = 0.25, ph = 0.75;
    this.addBox([cx - hw, top, cz - hd], [cx + hw, top + ph, cz - hd + pw], { tag: 'parapet', mat: 'concrete' });
    this.addBox([cx - hw, top, cz + hd - pw], [cx + hw, top + ph, cz + hd], { tag: 'parapet', mat: 'concrete' });
    this.addBox([cx - hw, top, cz - hd], [cx - hw + pw, top + ph, cz + hd], { tag: 'parapet', mat: 'concrete' });
    this.addBox([cx + hw - pw, top, cz - hd], [cx + hw, top + ph, cz + hd], { tag: 'parapet', mat: 'concrete' });
  }

  addFurniture(kind, x, y, z, rng) {
    if (kind === 'table') {
      this.addBox([x - 0.8, y, z - 0.45], [x + 0.8, y + 0.76, z + 0.45], { tag: 'furniture', mat: 'wood' });
    } else if (kind === 'shelf') {
      this.addBox([x - 0.9, y, z - 0.25], [x + 0.9, y + 1.9, z + 0.25], { tag: 'furniture', mat: 'wood' });
    } else if (kind === 'bed') {
      this.addBox([x - 1.0, y, z - 0.5], [x + 1.0, y + 0.55, z + 0.5], { tag: 'furniture', mat: 'wood' });
    } else {
      const s = rng.range(0.5, 0.75);
      this.addBox([x - s, y, z - s], [x + s, y + s * 1.4, z + s], { tag: 'furniture', mat: 'wood' });
    }
  }

  buildRoads() {
    const T = Object.fromEntries(this.towns.map(t => [t.name, t]));
    const links = [
      ['NORTHGATE', 'PORT'], ['PORT', 'RIDGE'], ['RIDGE', 'FORT DRAKE'],
      ['FORT DRAKE', 'HAVEN'], ['HAVEN', 'MILL'], ['MILL', 'NORTHGATE'],
      ['MILL', 'PORT'], ['NORTHGATE', 'RIDGE'],
    ];
    for (const [a, b] of links) {
      const A = T[a], B = T[b];
      const pts = [];
      const n = 26;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        let x = lerp(A.x, B.x, t), z = lerp(A.z, B.z, t);
        // gentle curve + noise
        const dx = B.x - A.x, dz = B.z - A.z;
        const l = Math.hypot(dx, dz) || 1;
        const off = Math.sin(t * Math.PI * 2.3) * 22 + (hash2(i, a.length, 7) - 0.5) * 10;
        x += (-dz / l) * off; z += (dx / l) * off;
        pts.push([x, z]);
      }
      this.roads.push({ points: pts, width: 7.5, highway: true });
    }
  }

  scatterVegetation() {
    const rng = this.rng;
    const S = this.size, half = this.half;
    let attempts = 0;
    while (this.trees.length < 1300 && attempts < 6000) {
      attempts++;
      const x = rng.range(-half + 15, half - 15), z = rng.range(-half + 15, half - 15);
      const density = fbm2(x * 0.006 + 20, z * 0.006 + 40, 4, this.seed + 55);
      if (density < 0.46) continue;
      if (Math.hypot(x - this.lake.x, z - this.lake.z) < this.lake.r * 1.25) continue;
      if (this.nearTown(x, z, 0.92)) continue;
      if (this.nearBuilding(x, z, 4)) continue;
      if (this.nearRoad(x, z, 6)) continue;
      const y = this.terrainHeight(x, z);
      if (this.isWater(x, z, y)) continue;
      const type = rng.chance(0.58) ? 'pine' : 'oak';
      const scale = rng.range(0.75, 1.45);
      const trunkR = rng.range(0.26, 0.45) * scale;
      const h = (type === 'pine' ? rng.range(8, 14) : rng.range(6, 10)) * scale;
      this.trees.push({ x, y, z, type, scale, rot: rng.next() * TAU, h, r: trunkR });
      this.addBox([x - trunkR, y, z - trunkR], [x + trunkR, y + h * 0.62, z + trunkR], { tag: 'tree', mat: 'wood', render: false });
    }
    // fallen logs
    for (let i = 0; i < 45; i++) {
      const x = rng.range(-half + 30, half - 30), z = rng.range(-half + 30, half - 30);
      if (this.nearTown(x, z, 0.9) || this.nearBuilding(x, z, 4) || this.isWater(x, z)) continue;
      const y = this.terrainHeight(x, z), len = rng.range(2.5, 5), r = rng.range(0.25, 0.45);
      const alongX = rng.chance(0.5);
      const min = alongX ? [x - len / 2, y, z - r] : [x - r, y, z - len / 2];
      const max = alongX ? [x + len / 2, y + r * 2, z + r] : [x + r, y + r * 2, z + len / 2];
      this.addBox(min, max, { tag: 'log', mat: 'wood' });
      this.props.push({ type: 'log', x, y, z, rot: alongX ? 0 : Math.PI / 2, s: len });
    }
  }

  scatterRocks() {
    const rng = this.rng;
    const half = this.half;
    for (let i = 0; i < 260; i++) {
      const x = rng.range(-half + 20, half - 20), z = rng.range(-half + 20, half - 20);
      if (this.nearTown(x, z, 0.85) || this.nearBuilding(x, z, 3) || this.nearRoad(x, z, 4)) continue;
      const y = this.terrainHeight(x, z);
      if (this.isWater(x, z, y)) continue;
      const r = rng.range(0.7, 2.8), h = r * rng.range(0.7, 1.3);
      this.rocks.push({ x, y, z, r, h, rot: rng.next() * TAU, scale: rng.range(0.8, 1.3) });
      this.addBox([x - r * 0.8, y, z - r * 0.8], [x + r * 0.8, y + h * 0.85, z + r * 0.8], { tag: 'rock', mat: 'rock', render: false });
    }
  }

  addProp(type, x, z, rot) {
    const rng = this.rng;
    const y = this.terrainHeight(x, z);
    if (this.isWater(x, z, y)) return;
    let b = null;
    if (type === 'crate') {
      const s = 0.62;
      b = this.addBox([x - s, y, z - s], [x + s, y + 1.15, z + s], { tag: 'crate', mat: 'wood', dynamic: true, hp: 120, kind: 'crate' });
      this.props.push({ type: 'crate', x, y, z, rot });
    } else if (type === 'barrel') {
      b = this.addBox([x - 0.38, y, z - 0.38], [x + 0.38, y + 1.15, z + 0.38], { tag: 'barrel', mat: 'metal', dynamic: true, hp: 90, kind: 'barrel' });
      this.props.push({ type: 'barrel', x, y, z, rot });
    } else if (type === 'barrier') {
      const w = rng.chance(0.5);
      const hw = w ? 1.6 : 0.45, hd = w ? 0.45 : 1.6;
      b = this.addBox([x - hw, y, z - hd], [x + hw, y + 1.05, z + hd], { tag: 'barrier', mat: 'concrete' });
      this.props.push({ type: 'barrier', x, y, z, rot: w ? 0 : Math.PI / 2 });
    } else if (type === 'sandbag') {
      const hw = 1.5, hd = 0.55;
      b = this.addBox([x - hw, y, z - hd], [x + hw, y + 1.15, z + hd], { tag: 'sandbag', mat: 'sandbag', dynamic: true, hp: 260, kind: 'sandbag' });
      this.props.push({ type: 'sandbag', x, y, z, rot });
    } else if (type === 'fence') {
      const hw = 1.6, hd = 0.12;
      b = this.addBox([x - hw, y, z - hd], [x + hw, y + 1.25, z + hd], { tag: 'fence', mat: 'wood', dynamic: true, hp: 70, kind: 'fence' });
      this.props.push({ type: 'fence', x, y, z, rot });
    } else if (type === 'wreck') {
      b = this.addBox([x - 2.2, y, z - 1.0], [x + 2.2, y + 1.5, z + 1.0], { tag: 'wreck', mat: 'metal' });
      this.props.push({ type: 'wreck', x, y, z, rot });
    } else if (type === 'container') {
      b = this.addBox([x - 3.0, y, z - 1.25], [x + 3.0, y + 2.6, z + 1.25], { tag: 'container', mat: 'metal' });
      this.props.push({ type: 'container', x, y, z, rot });
    } else if (type === 'streetlight') {
      this.addBox([x - 0.12, y, z - 0.12], [x + 0.12, y + 5.5, z + 0.12], { tag: 'pole', mat: 'metal' });
      this.props.push({ type: 'streetlight', x, y, z, rot });
    } else if (type === 'tree_stump') {
      this.props.push({ type: 'stump', x, y, z, rot });
    }
    return b;
  }

  scatterCover() {
    const rng = this.rng;
    const half = this.half;
    const types = ['barrier', 'sandbag', 'crate', 'barrel', 'fence', 'wreck', 'container'];
    for (let i = 0; i < 320; i++) {
      let x, z;
      if (rng.chance(0.55)) {
        const t = rng.pick(this.towns);
        const a = rng.next() * TAU, rr = rng.range(t.r * 0.35, t.r * 1.15);
        x = t.x + Math.cos(a) * rr; z = t.z + Math.sin(a) * rr;
      } else {
        x = rng.range(-half + 25, half - 25); z = rng.range(-half + 25, half - 25);
      }
      if (this.nearBuilding(x, z, 1.2) || this.isWater(x, z)) continue;
      this.addProp(rng.pick(types), x, z, rng.next() * TAU);
    }
    // Military compound extras
    const fort = this.towns.find(t => t.type === 'military');
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU;
      this.addProp(i % 3 === 0 ? 'container' : 'barrier', fort.x + Math.cos(a) * (fort.r + 6), fort.z + Math.sin(a) * (fort.r + 6), a);
    }
    for (const t of this.towns) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + 0.4;
        this.addProp('streetlight', t.x + Math.cos(a) * (t.r * 0.9), t.z + Math.sin(a) * (t.r * 0.9), 0);
      }
    }
  }

  buildBoundary() {
    const B = CFG.MAP.BOUNDS, H = 160;
    this.addBox([-B - 20, -30, -B - 20], [B + 20, -8, B + 20], { tag: 'void', mat: 'dirt', render: false });
    this.addBox([-B - 2, -10, -B - 2], [B + 2, H, -B + 0.5], { tag: 'boundary', render: false });
    this.addBox([-B - 2, -10, B - 0.5], [B + 2, H, B + 2], { tag: 'boundary', render: false });
    this.addBox([-B - 2, -10, -B - 2], [-B + 0.5, H, B + 2], { tag: 'boundary', render: false });
    this.addBox([B - 0.5, -10, -B - 2], [B + 2, H, B + 2], { tag: 'boundary', render: false });
  }

  buildLootAndSpawns() {
    const rng = this.rng;
    const half = this.half;
    // Outdoor loot.
    for (let i = 0; i < 170; i++) {
      const x = rng.range(-half + 40, half - 40), z = rng.range(-half + 40, half - 40);
      if (this.isWater(x, z)) continue;
      this.lootSpawns.push({ x, y: this.terrainHeight(x, z) + 0.05, z, tier: rng.chance(0.15) ? 3 : rng.chance(0.5) ? 2 : 1, indoor: false });
    }
    // Vehicle spawns along roads.
    for (let i = 0; i < 12; i++) {
      const road = rng.pick(this.roads.filter(r => r.highway));
      const p = road.points[Math.floor(rng.next() * road.points.length)];
      const x = p[0] + rng.range(-5, 5), z = p[1] + rng.range(-5, 5);
      if (this.isWater(x, z)) continue;
      this.vehicleSpawns.push({ x, z, yaw: rng.next() * TAU, type: rng.chance(0.3) ? 'truck' : 'car' });
    }
    // Spawn points (open ground away from buildings).
    for (let i = 0; i < 140; i++) {
      const a = rng.next() * TAU, r = Math.sqrt(rng.next()) * 430;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (this.nearBuilding(x, z, 3) || this.isWater(x, z)) continue;
      this.spawnPoints.push({ x, z, y: this.terrainHeight(x, z) });
    }
    // TDM team spawn areas: Haven (blue) and Ridge (red).
    for (const [team, townName] of [[0, 'HAVEN'], [1, 'RIDGE']]) {
      const t = this.towns.find(t => t.name === townName);
      for (let i = 0; i < 24; i++) {
        const a = rng.next() * TAU, r = rng.range(8, 55);
        const x = t.x + Math.cos(a) * r, z = t.z + Math.sin(a) * r;
        if (this.nearBuilding(x, z, 1.5)) continue;
        this.teamSpawns[team].push({ x, z, y: this.terrainHeight(x, z) });
      }
    }
  }

  nearTown(x, z, mult) {
    for (const t of this.towns) if (Math.hypot(x - t.x, z - t.z) < t.r * mult) return true;
    return false;
  }
  nearBuilding(x, z, pad) {
    for (const b of this.buildings) {
      if (Math.abs(x - b.x) < b.w / 2 + pad && Math.abs(z - b.z) < b.d / 2 + pad) return true;
    }
    return false;
  }
  nearRoad(x, z, pad) {
    for (const r of this.roads) {
      const pts = r.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, z1] = pts[i], [x2, z2] = pts[i + 1];
        if (distToSegment2(x, z, x1, z1, x2, z2) < pad * pad) return true;
      }
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // Spatial hash + queries
  // --------------------------------------------------------------------------
  rebuildGrid() {
    this.grid.clear();
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (b.render === false && b.tag === 'void') continue;
      const x0 = Math.floor(b.min[0] / CELL), x1 = Math.floor(b.max[0] / CELL);
      const z0 = Math.floor(b.min[2] / CELL), z1 = Math.floor(b.max[2] / CELL);
      for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) {
        const k = gx * 73856093 ^ gz * 19349663;
        let arr = this.grid.get(k);
        if (!arr) { arr = []; this.grid.set(k, arr); }
        arr.push(i);
      }
    }
  }

  queryBoxes(minX, minZ, maxX, maxZ, out = []) {
    out.length = 0;
    const stamp = ++this._stamp;
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL), z1 = Math.floor(maxZ / CELL);
    for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) {
      const arr = this.grid.get(gx * 73856093 ^ gz * 19349663);
      if (!arr) continue;
      for (let j = 0; j < arr.length; j++) {
        const idx = arr[j], b = this.boxes[idx];
        if (b._qStamp === stamp) continue;
        b._qStamp = stamp;
        out.push(b);
      }
    }
    return out;
  }

  // Ray vs world. Returns nearest {t, point, normal, box, tag, mat} or null.
  raycast(origin, dir, maxDist, opts = {}) {
    let best = null, bestT = maxDist;
    const stamp = ++this._stamp;
    // Terrain first (cheap raymarch).
    const terr = this.raycastTerrain(origin, dir, maxDist);
    if (terr && terr.t < bestT) { bestT = terr.t; best = terr; }
    // DDA through the spatial grid.
    const ox = origin[0], oz = origin[2];
    const dx = dir[0], dz = dir[2];
    const horizontal = Math.hypot(dx, dz) > 1e-6;
    if (horizontal) {
      let gx = Math.floor(ox / CELL), gz = Math.floor(oz / CELL);
      const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
      // A zero component must never advance that axis: use Infinity, not a
      // huge finite number (which used to march the DDA down the wrong cells
      // for perfectly axis-aligned shots).
      const tDeltaX = Math.abs(dx) < 1e-9 ? Infinity : Math.abs(CELL / dx);
      const tDeltaZ = Math.abs(dz) < 1e-9 ? Infinity : Math.abs(CELL / dz);
      let tMaxX = Math.abs(dx) < 1e-9 ? Infinity : ((gx + (dx > 0 ? 1 : 0)) * CELL - ox) / dx;
      let tMaxZ = Math.abs(dz) < 1e-9 ? Infinity : ((gz + (dz > 0 ? 1 : 0)) * CELL - oz) / dz;
      let tCell = 0, guard = 0;
      while (tCell <= bestT && guard++ < 512) {
        const arr = this.grid.get(gx * 73856093 ^ gz * 19349663);
        if (arr) {
          for (let j = 0; j < arr.length; j++) {
            const b = this.boxes[arr[j]];
            if (b._rayStamp === stamp) continue;
            b._rayStamp = stamp;
            if (b.destroyed || b.tag === 'void') continue;
            if (opts.ignoreTag && opts.ignoreTag.has(b.tag)) continue;
            if (opts.ignoreBox && opts.ignoreBox === b) continue;
            const hit = rayAABB(origin, dir, b, bestT);
            if (hit && hit.t < bestT) { bestT = hit.t; best = { t: hit.t, tmax: hit.tmax, point: pointAt(origin, dir, hit.t), normal: hit.normal, box: b, tag: b.tag, mat: b.mat }; }
          }
        }
        if (tMaxX < tMaxZ) { tCell = tMaxX; gx += stepX; tMaxX += tDeltaX; }
        else { tCell = tMaxZ; gz += stepZ; tMaxZ += tDeltaZ; }
      }
    } else {
      const arr = this.queryBoxes(ox - CELL, oz - CELL, ox + CELL, oz + CELL);
      for (const b of arr) {
        if (b.destroyed || b.tag === 'void') continue;
        if (opts.ignoreTag && opts.ignoreTag.has(b.tag)) continue;
        const hit = rayAABB(origin, dir, b, bestT);
        if (hit && hit.t < bestT) { bestT = hit.t; best = { t: hit.t, tmax: hit.tmax, point: pointAt(origin, dir, hit.t), normal: hit.normal, box: b, tag: b.tag, mat: b.mat }; }
      }
    }
    return best;
  }

  raycastTerrain(origin, dir, maxDist) {
    const oy = origin[1];
    const th0 = this.terrainHeight(origin[0], origin[2]);
    if (oy < th0) return { t: 0, point: origin.slice(), normal: this.terrainNormal(origin[0], origin[2]), box: null, tag: 'terrain', mat: 'dirt' };
    let step = 0.75;
    let prevT = 0;
    for (let t = step; t <= maxDist; t += step) {
      const x = origin[0] + dir[0] * t, y = oy + dir[1] * t, z = origin[2] + dir[2] * t;
      if (y < this.terrainHeight(x, z)) {
        // bisection refine
        let a = prevT, b = t;
        for (let i = 0; i < 6; i++) {
          const m = (a + b) * 0.5;
          const mx = origin[0] + dir[0] * m, my = oy + dir[1] * m, mz = origin[2] + dir[2] * m;
          if (my < this.terrainHeight(mx, mz)) b = m; else a = m;
        }
        const p = pointAt(origin, dir, b);
        return { t: b, point: p, normal: this.terrainNormal(p[0], p[2]), box: null, tag: 'terrain', mat: 'dirt' };
      }
      prevT = t;
      // adaptive step for long shots
      if (t > 80) step = 2.0;
      if (t > 220) step = 4.0;
    }
    return null;
  }

  // Is there line of sight between two points?
  lineOfSight(a, b, pad = 0) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return true;
    const dir = [dx / len, dy / len, dz / len];
    const hit = this.raycast(a, dir, len - pad);
    return !hit || hit.t >= len - pad;
  }

  computeStats() {
    this.stats = {
      boxes: this.boxes.length,
      buildings: this.buildings.length,
      trees: this.trees.length,
      rocks: this.rocks.length,
      props: this.props.length,
      roads: this.roads.length,
      loot: this.lootSpawns.length,
      vehicles: this.vehicleSpawns.length,
      destructibles: this.destructibles.length,
      spawns: this.spawnPoints.length,
    };
    return this.stats;
  }
}

function rayAABB(o, d, b, maxT) {
  // tmax is the true exit distance so penetration thickness is correct.
  let tmin = 0, tmax = Infinity, axis = -1, sign = 1;
  for (let i = 0; i < 3; i++) {
    const inv = 1 / (d[i] || 1e-12);
    let t0 = (b.min[i] - o[i]) * inv, t1 = (b.max[i] - o[i]) * inv;
    if (inv < 0) { const tmp = t0; t0 = t1; t1 = tmp; }
    if (t0 > tmin) { tmin = t0; axis = i; sign = inv < 0 ? 1 : -1; }
    if (t1 < tmax) tmax = t1;
    if (tmax < tmin) return null;
  }
  if (tmin > maxT || tmin < 0) return null;
  const n = [0, 0, 0];
  if (axis >= 0) n[axis] = sign;
  return { t: tmin, tmax, normal: n };
}

function pointAt(o, d, t) { return [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]; }

function distToSegment2(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const l2 = dx * dx + dz * dz;
  let t = l2 ? ((px - x1) * dx + (pz - z1) * dz) / l2 : 0;
  t = clamp(t, 0, 1);
  const x = x1 + t * dx, z = z1 + t * dz;
  return (px - x) * (px - x) + (pz - z) * (pz - z);
}
