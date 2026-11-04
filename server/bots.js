// ============================================================================
// Server-side bot AI. Plain ES module: also used by the browser offline mode.
//
// Bots use the exact same input shape as network players, so the authoritative
// simulation treats them identically. A coarse outdoor grid connects small,
// capsule-clearance building grids. Doorways are represented by real free
// space, rather than carving coarse cells through adjacent solid partitions.
// ============================================================================
import { CFG, STANCE, MATCH_STATE } from '../shared/config.js';
import { clamp, yawTo, TAU } from '../shared/math.js';
import { lootInReach } from '../shared/weapons.js';
import { smokeObscures } from '../shared/visibility.js';

const navCache = new WeakMap();
const NAV_DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(node) {
    const a = this.a; a.push(node); let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

// Fine grids are bounded to one building and its approaches. Sampling the same
// capsule clearance as movement makes narrow doors navigable without allowing
// a path to cross a neighbouring wall. Grids are built before the first tick.
class BuildingNav {
  constructor(world, building, margin) {
    this.world = world;
    this.building = building;
    this.cell = CFG.BOT.interiorNavCell;
    this.x0 = building.x - building.w / 2 - margin;
    this.z0 = building.z - building.d / 2 - margin;
    this.nx = Math.ceil((building.w + margin * 2) / this.cell);
    this.nz = Math.ceil((building.d + margin * 2) / this.cell);
    this.boxes = world.queryBoxes(this.x0 - 1, this.z0 - 1,
      this.x0 + this.nx * this.cell + 1, this.z0 + this.nz * this.cell + 1);
    this.walk = new Uint8Array(this.nx * this.nz);
    this.floor = new Float32Array(this.walk.length);
    this.g = new Float32Array(this.walk.length);
    this.came = new Int32Array(this.walk.length);
    this.seen = new Uint32Array(this.walk.length);
    this.closed = new Uint32Array(this.walk.length);
    this.stamp = 0;
    for (let z = 0; z < this.nz; z++) for (let x = 0; x < this.nx; x++) {
      const [px, pz] = this.center(x, z);
      const y = this.support(px, pz);
      const i = z * this.nx + x;
      if (y !== null) { this.walk[i] = 1; this.floor[i] = y; }
    }
  }

  contains(x, z) {
    return x >= this.x0 && z >= this.z0 &&
      x < this.x0 + this.nx * this.cell && z < this.z0 + this.nz * this.cell;
  }

  center(x, z) { return [this.x0 + (x + 0.5) * this.cell, this.z0 + (z + 0.5) * this.cell]; }

  support(x, z) {
    const w = this.world, p = CFG.PLAYER, r = p.RADIUS + 0.025;
    if (w.waterDepth(x, z) > 0.25) return null;
    const ground = w.terrainHeight(x, z);
    let feet = ground;
    const overlaps = b => {
      const dx = x - clamp(x, b.min[0], b.max[0]);
      const dz = z - clamp(z, b.min[2], b.max[2]);
      return dx * dx + dz * dz < r * r;
    };
    for (const b of this.boxes) {
      if (b.destroyed || b.tag === 'glass' || b.tag === 'void') continue;
      if (b.max[1] <= ground + p.STEP_HEIGHT + 0.02 && b.max[1] >= ground - 0.7 && overlaps(b)) {
        feet = Math.max(feet, b.max[1]);
      }
    }
    for (const b of this.boxes) {
      if (b.destroyed || b.tag === 'glass' || b.tag === 'void') continue;
      if (b.max[1] <= feet + 0.02 || b.min[1] >= feet + p.HEIGHT) continue;
      if (overlaps(b)) return null;
    }
    return feet;
  }

  clearSegment(a, b) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.18));
    let lastY = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = this.support(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      if (y === null || (lastY !== null && Math.abs(y - lastY) > CFG.PLAYER.STEP_HEIGHT + 0.03)) return false;
      lastY = y;
    }
    return true;
  }

  nearest(x, z, requireClear) {
    const ix = Math.floor((x - this.x0) / this.cell), iz = Math.floor((z - this.z0) / this.cell);
    let best = -1, distance = Infinity;
    for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
      const cx = ix + dx, cz = iz + dz;
      if (cx < 0 || cz < 0 || cx >= this.nx || cz >= this.nz) continue;
      const i = cz * this.nx + cx;
      if (!this.walk[i]) continue;
      const point = this.center(cx, cz);
      const d = Math.hypot(x - point[0], z - point[1]);
      if (d >= distance || (requireClear && !this.clearSegment([x, z], point))) continue;
      best = i; distance = d;
    }
    return best;
  }

  findPath(sx, sz, tx, tz) {
    if (!this.contains(sx, sz) || !this.contains(tx, tz)) return null;
    const start = this.nearest(sx, sz, true), goal = this.nearest(tx, tz, false);
    if (start < 0 || goal < 0) return null;
    if (++this.stamp === 0xffffffff) { this.seen.fill(0); this.closed.fill(0); this.stamp = 1; }
    const stamp = this.stamp, open = new MinHeap();
    const gx = goal % this.nx, gz = Math.floor(goal / this.nx);
    const heuristic = (x, z) => Math.hypot(gx - x, gz - z);
    this.g[start] = 0; this.came[start] = -1; this.seen[start] = stamp;
    open.push({ idx: start, f: heuristic(start % this.nx, Math.floor(start / this.nx)) });
    while (open.size) {
      const { idx } = open.pop();
      if (this.closed[idx] === stamp) continue;
      this.closed[idx] = stamp;
      if (idx === goal) {
        const path = [];
        for (let i = goal; i !== -1; i = this.came[i]) path.push(this.center(i % this.nx, Math.floor(i / this.nx)));
        path.reverse();
        // Use the actual endpoint when clear; pickups embedded in a prop are
        // approached to the nearest standable point, never through that prop.
        if (this.clearSegment(path.at(-1), [tx, tz])) path.push([tx, tz]);
        const out = [[sx, sz, CFG.BOT.doorwayTolerance]];
        for (let i = 0; i < path.length;) {
          let next = i;
          while (next + 1 < path.length && this.clearSegment(out.at(-1), path[next + 1])) next++;
          out.push([...path[next], CFG.BOT.doorwayTolerance]);
          i = next + 1;
        }
        return out;
      }
      const x = idx % this.nx, z = Math.floor(idx / this.nx);
      for (const [dx, dz, cost] of NAV_DIRS) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= this.nx || nz >= this.nz) continue;
        const ni = nz * this.nx + nx;
        if (!this.walk[ni] || this.closed[ni] === stamp) continue;
        if (dx && dz && (!this.walk[z * this.nx + nx] || !this.walk[nz * this.nx + x])) continue;
        if (Math.abs(this.floor[ni] - this.floor[idx]) > CFG.PLAYER.STEP_HEIGHT + 0.03) continue;
        const g = this.g[idx] + cost;
        if (this.seen[ni] === stamp && g >= this.g[ni]) continue;
        this.seen[ni] = stamp; this.g[ni] = g; this.came[ni] = idx;
        open.push({ idx: ni, f: g + heuristic(nx, nz) });
      }
    }
    return null;
  }
}

export class NavGrid {
  constructor(world) {
    this.world = world;
    this.cell = CFG.BOT.navCell;
    this.half = CFG.MAP.SIZE / 2;
    this.n = Math.ceil(CFG.MAP.SIZE / this.cell);
    this.walk = new Uint8Array(this.n * this.n);
    this.buildingNav = new Map();
    // Reusable A* scratch space. Allocating typed arrays per path call was
    // several MB of garbage every couple of seconds with 32 bots.
    this._g = new Float32Array(this.n * this.n);
    this._came = new Int32Array(this.n * this.n);
    this._closed = new Uint8Array(this.n * this.n);
    this._seen = new Uint32Array(this.n * this.n);
    this._searchStamp = 0;
    this.build();
    for (const b of world.buildings) this.buildingNav.set(b, new BuildingNav(world, b, this.cell + 4));
  }

  idx(ix, iz) { return iz * this.n + ix; }
  toCell(x, z) {
    return [
      clamp(Math.floor((x + this.half) / this.cell), 0, this.n - 1),
      clamp(Math.floor((z + this.half) / this.cell), 0, this.n - 1),
    ];
  }
  center(ix, iz) {
    return [-this.half + (ix + 0.5) * this.cell, -this.half + (iz + 0.5) * this.cell];
  }
  walkable(ix, iz) {
    if (ix < 0 || iz < 0 || ix >= this.n || iz >= this.n) return false;
    return this.walk[this.idx(ix, iz)] === 1;
  }

  build() {
    const W = this.world, c = this.cell, B = CFG.MAP.BOUNDS - 4;
    const maxSlopeY = 1 / Math.sqrt(1 + CFG.PLAYER.SLOPE_MAX * CFG.PLAYER.SLOPE_MAX);
    // Only large structures block navigation; trees/rocks/furniture are dodged
    // by the character collider instead of turning whole cells unwalkable.
    const NAV_BLOCK = new Set(['wall', 'interior', 'foundation', 'roof', 'parapet', 'floor',
      'stairs', 'container', 'wreck', 'barrier', 'boundary', 'structure', 'furniture']);
    for (let iz = 0; iz < this.n; iz++) {
      for (let ix = 0; ix < this.n; ix++) {
        const [x, z] = this.center(ix, iz);
        if (x < -B || x > B || z < -B || z > B) continue;
        if (W.waterDepth(x, z) > 0.25) continue;
        const n = W.terrainNormal(x, z);
        if (n[1] < maxSlopeY - 0.02) continue;
        const y = W.terrainHeight(x, z);
        const near = W.queryBoxes(x - c, z - c, x + c, z + c);
        let blocked = false;
        for (const b of near) {
          if (b.destroyed || b.tag === 'glass' || b.tag === 'void' || !NAV_BLOCK.has(b.tag)) continue;
          // Cell square vs box footprint. Testing the whole cell (rather than
          // a shrunken inner square) matters for thin walls: a 0.24 m wall can
          // pass between two 2 m cell centres, so the old inner-square test let
          // A* paths cross straight through building walls.
          if (b.max[0] < x - c * 0.5 - 0.05 || b.min[0] > x + c * 0.5 + 0.05) continue;
          if (b.max[2] < z - c * 0.5 - 0.05 || b.min[2] > z + c * 0.5 + 0.05) continue;
          if (b.max[1] < y + 0.65 || b.min[1] > y + 2.0) continue;
          blocked = true; break;
        }
        if (!blocked) this.walk[this.idx(ix, iz)] = 1;
      }
    }

    // Outdoor paths route around complete building footprints. Ground-floor
    // interiors use the fine grids; opening coarse cells also erases nearby
    // partitions and produces routes the capsule can never traverse.
    for (const bd of W.buildings) {
      const [x0, z0] = this.toCell(bd.x - bd.w / 2 - c / 2, bd.z - bd.d / 2 - c / 2);
      const [x1, z1] = this.toCell(bd.x + bd.w / 2 + c / 2, bd.z + bd.d / 2 + c / 2);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.walk[this.idx(x, z)] = 0;
    }
  }

  // Rect = { x0, x1, z0, z1 } optional constraint on cell centres. When px/pz
  // are supplied the search ranks candidates by distance from that world
  // point, which keeps a bot pinned on one side of an interior wall from
  // snapping to a cell on the far side.
  nearestWalkable(ix, iz, radius = 6, rect = null, px = null, pz = null) {
    const inside = (cx, cz) => !rect ||
      (cx >= rect.x0 && cx <= rect.x1 && cz >= rect.z0 && cz <= rect.z1);
    const ok = (ax, az) => {
      if (!this.walkable(ax, az)) return false;
      const [cx, cz] = this.center(ax, az);
      return inside(cx, cz);
    };
    if (ok(ix, iz)) return [ix, iz];
    let best = null, bestD = Infinity;
    for (let r = 1; r <= radius; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const ax = ix + dx, az = iz + dz;
          if (!ok(ax, az)) continue;
          let d;
          if (px !== null) {
            const [cx, cz] = this.center(ax, az);
            d = (cx - px) * (cx - px) + (cz - pz) * (cz - pz);
          } else {
            d = dx * dx + dz * dz;
          }
          if (d < bestD) { bestD = d; best = [ax, az]; }
        }
      }
    }
    return best;
  }

  buildingAt(x, z) {
    return this.world.buildings.find(b => Math.abs(x - b.x) <= b.w / 2 + 0.6 && Math.abs(z - b.z) <= b.d / 2 + 0.6);
  }

  approaches(b, x, z, otherX, otherZ, exiting) {
    const local = this.buildingNav.get(b);
    const doors = b.doors.filter(d => d.floor === 0 && d.kind !== 'interior')
      .sort((a, b) => Math.hypot(a.cx - otherX, a.cz - otherZ) - Math.hypot(b.cx - otherX, b.cz - otherZ));
    const options = [];
    for (const d of doors) {
      const [ix, iz] = this.toCell(d.cx + d.nx * (this.cell + 1), d.cz + d.nz * (this.cell + 1));
      const candidates = [];
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        if (!this.walkable(ix + dx, iz + dz)) continue;
        const point = this.center(ix + dx, iz + dz);
        if (local.contains(...point)) candidates.push(point);
      }
      candidates.sort((a, b) => Math.hypot(a[0] - d.cx, a[1] - d.cz) - Math.hypot(b[0] - d.cx, b[1] - d.cz));
      for (const anchor of candidates.slice(0, 6)) {
        const path = exiting ? local.findPath(x, z, ...anchor) : local.findPath(...anchor, x, z);
        if (path) { options.push({ anchor, path }); break; }
      }
    }
    return options;
  }

  findPath(sx, sz, tx, tz, maxExpansions = 2400) {
    const from = this.buildingAt(sx, sz), to = this.buildingAt(tx, tz);
    for (const b of new Set([from, to])) {
      if (!b) continue;
      const local = this.buildingNav.get(b);
      if (local.contains(sx, sz) && local.contains(tx, tz)) {
        const path = local.findPath(sx, sz, tx, tz);
        if (path) return path;
      }
    }
    const starts = from ? this.approaches(from, sx, sz, tx, tz, true) : [{ anchor: [sx, sz], path: [] }];
    const ends = to ? this.approaches(to, tx, tz, sx, sz, false) : [{ anchor: [tx, tz], path: [] }];
    for (const a of starts) for (const b of ends) {
      const outside = this.findOutdoorPath(...a.anchor, ...b.anchor, maxExpansions);
      if (outside) return [...a.path, ...outside, ...b.path];
    }
    return null;
  }

  findOutdoorPath(sx, sz, tx, tz, maxExpansions) {
    const [six, siz] = this.toCell(sx, sz);
    const [tix, tiz] = this.toCell(tx, tz);
    const start = this.nearestWalkable(six, siz, 5, null, sx, sz);
    const goal = this.nearestWalkable(tix, tiz, 8, null, tx, tz);
    if (!start || !goal) return null;
    if (start[0] === goal[0] && start[1] === goal[1]) return [this.center(goal[0], goal[1])];

    const N = this.n;
    const g = this._g, came = this._came, closed = this._closed, seen = this._seen;
    const stamp = this._searchStamp = (this._searchStamp + 1) >>> 0 || 1;
    const open = new MinHeap();
    const startIdx = this.idx(start[0], start[1]);
    const goalIdx = this.idx(goal[0], goal[1]);
    const h = (ix, iz) => {
      const dx = Math.abs(ix - goal[0]), dz = Math.abs(iz - goal[1]);
      return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz);
    };
    seen[startIdx] = stamp; g[startIdx] = 0; came[startIdx] = -1; closed[startIdx] = 0;
    open.push({ idx: startIdx, ix: start[0], iz: start[1], g: 0, f: h(start[0], start[1]) });
    let expansions = 0;
    while (open.size && expansions++ < maxExpansions) {
      const cur = open.pop();
      if (closed[cur.idx]) continue;
      closed[cur.idx] = 1;
      if (cur.idx === goalIdx) {
        const path = [];
        let i = goalIdx;
        while (i !== -1) {
          const ix = i % N, iz = (i / N) | 0;
          path.push(this.center(ix, iz));
          i = came[i];
        }
        path.reverse();
        return path;
      }
      for (const [dx, dz, cost] of NAV_DIRS) {
        const nx = cur.ix + dx, nz = cur.iz + dz;
        if (!this.walkable(nx, nz)) continue;
        // Do not cut diagonal corners through blocked cells.
        if (dx && dz && (!this.walkable(cur.ix + dx, cur.iz) || !this.walkable(cur.ix, cur.iz + dz))) continue;
        const ni = this.idx(nx, nz);
        if (seen[ni] === stamp && closed[ni]) continue;
        const ng = cur.g + cost;
        if (seen[ni] !== stamp || ng < g[ni]) {
          seen[ni] = stamp; g[ni] = ng; came[ni] = cur.idx; closed[ni] = 0;
          open.push({ idx: ni, ix: nx, iz: nz, g: ng, f: ng + h(nx, nz) });
        }
      }
    }
    return null;
  }

}

export function getNav(world) {
  if (!navCache.has(world)) navCache.set(world, new NavGrid(world));
  return navCache.get(world);
}

// ---------------------------------------------------------------------------
// Per-bot brain
// ---------------------------------------------------------------------------
function idleInput() {
  return {
    f: false, b: false, l: false, r: false, jump: false, sprint: false, ads: false,
    shoot: false, reload: false, grenade: false, smoke: false, heal: false,
    interact: false, cycle: false, slot: -1, stance: null, enterVehicle: undefined,
    yaw: 0, pitch: 0, seq: 0, viewTime: 0,
  };
}

export class BotBrain {
  constructor(game, player) {
    this.game = game;
    this.p = player;
    this.nav = getNav(game.world);
    this.rng = game.rng;
    this.path = null;
    this.pathIdx = 0;
    this.repathT = 0;
    this.targetId = null;
    this.targetVisible = false;
    this.thinkT = 0;
    this.reactionT = 0;
    this.aimYaw = player.yaw || 0;
    this.aimPitch = 0;
    this.errYaw = 0;
    this.errPitch = 0;
    this.burstLeft = 0;
    this.burstPause = 0;
    this.semiPulse = false;
    this.strafe = 1;
    this.strafeT = 0;
    this.lootT = 0;
    this.stuckT = 0;
    this.lastPos = player.pos.slice();
    this.lastProgressT = 0;
    this.patrol = null;
    this.stanceT = 0;
    this.desiredStance = STANCE.STAND;
    this.lastTargetSeenAt = -99;
    this.lastKnown = null;
    this.goal = null;
    this.objective = null;
    this.arrived = false;
    this.arriveRadius = 1.6;
    this.lastInputMoving = false;
    this.unstickT = 0;
    this.detourT = 0;
    this.detourSign = 1;
  }

  // Scripted objective (used by tests and future objective modes). The brain
  // still fights when it sees an enemy; otherwise it paths to the point and
  // clears the objective on arrival.
  commandTo(x, z) {
    // An indoor objective is only reached from inside that building. A loose
    // pickup-sized radius must not complete it from the other side of a wall.
    const building = this.game.world.buildings.find(b =>
      Math.abs(x - b.x) < b.w / 2 && Math.abs(z - b.z) < b.d / 2) || null;
    this.objective = { x, z, building };
    this.arrived = false;
    this.path = null;
    this.pathIdx = 0;
    this.repathT = 0;
    this.stuckT = 0;
    this.goal = { x, z };
    return this;
  }

  reachedObjective() {
    const goal = this.objective, p = this.p;
    if (!goal || Math.hypot(goal.x - p.pos[0], goal.z - p.pos[2]) >= this.arriveRadius) return false;
    const b = goal.building;
    if (b && (Math.abs(p.pos[0] - b.x) >= b.w / 2 - CFG.PLAYER.RADIUS ||
      Math.abs(p.pos[2] - b.z) >= b.d / 2 - CFG.PLAYER.RADIUS)) return false;
    const targetY = b ? b.y0 + 1 : this.game.world.terrainHeight(goal.x, goal.z) + 1;
    return this.game.world.lineOfSight(this.eye(), [goal.x, targetY, goal.z], .05);
  }

  clearObjective() {
    this.objective = null;
    this.path = null;
    this.goal = null;
  }

  eye() { return [this.p.pos[0], this.p.pos[1] + this.p.eyeHeight(), this.p.pos[2]]; }
  chest(q) { return [q.pos[0], q.pos[1] + q.height() * 0.62, q.pos[2]]; }

  findEnemy(requireLos) {
    const p = this.p;
    let best = null, bestScore = Infinity;
    for (const q of this.game.players.values()) {
      if (!q.alive || q.id === p.id) continue;
      if (this.game.mode === 'tdm' && q.team === p.team) continue;
      const dx = q.pos[0] - p.pos[0], dz = q.pos[2] - p.pos[2];
      const d = Math.hypot(dx, dz);
      if (d > CFG.BOT.viewRange) continue;
      if (requireLos) {
        const a = this.eye(), b = this.chest(q);
        if (!this.game.world.lineOfSight(a, b, 0.1)) continue;
        if (smokeObscures(this.game.smokes, a, b)) continue;
      }
      const score = d + (q.inVehicle ? 25 : 0);
      if (score < bestScore) { bestScore = score; best = q; }
    }
    return best;
  }

  choosePatrol() {
    const z = this.game.zone;
    const p = this.p;
    for (let i = 0; i < 10; i++) {
      const a = this.rng.next() * TAU;
      const r = Math.sqrt(this.rng.next()) * Math.max(12, z.r * 0.72);
      const x = z.cx + Math.cos(a) * r, zz = z.cz + Math.sin(a) * r;
      if (this.game.world.waterDepth(x, zz) > 0.3) continue;
      if (Math.hypot(x - p.pos[0], zz - p.pos[2]) < 18) continue;
      this.patrol = { x, z: zz };
      this.repathT = 0;
      return;
    }
    this.patrol = { x: z.cx, z: z.cz };
    this.repathT = 0;
  }

  nearestLoot(maxDist = 45) {
    const p = this.p;
    let best = null, bd = maxDist;
    for (const it of this.game.loot) {
      const d = Math.hypot(it.x - p.pos[0], it.z - p.pos[2]);
      if (d >= bd) continue;
      // Only detour for things the bot can actually use.
      if (it.type === 'ammo') {
        if (!p.weapons.includes(it.weapon)) continue;
      } else if (it.type === 'weapon') {
        if (p.weapons[0] && p.weapons[1]) continue;
      } else if (it.type === 'armor') {
        if (p.armor >= it.amount) continue;
      } else if (it.type === 'med') {
        if (p.bandages + p.medkits >= 4) continue;
      } else if (it.type === 'grenade') {
        if (p.grenades + p.smokes >= 4) continue;
      }
      bd = d; best = it;
    }
    return best;
  }

  setPathTo(x, z) {
    this.goal = { x, z };
    const path = this.nav.findPath(this.p.pos[0], this.p.pos[2], x, z);
    if (path && path.length) {
      this.path = path; this.pathIdx = 0;
    } else {
      this.path = null;
    }
    this.repathT = 1.1 + this.rng.next() * 0.8;
  }

  // Turn toward a world point and move forward when roughly aligned. Bots
  // steer with input.yaw (the same field players send) rather than strafing
  // sideways, which is what the old l/r "turn" hack actually did.
  steerTo(input, x, z, sprint = true) {
    const p = this.p;
    const dx = x - p.pos[0], dz = z - p.pos[2];
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) return 0;
    const desired = Math.atan2(-dx, -dz);
    const diff = Math.atan2(Math.sin(desired - p.yaw), Math.cos(desired - p.yaw));
    const turn = 7.0 * (this._dt || CFG.SIM_DT);
    input.yaw = p.yaw + clamp(diff, -turn, turn);
    input.f = Math.abs(diff) < (d < 1.2 ? 0.35 : 0.7);
    input.sprint = sprint && d > 12;
    return d;
  }

  followPath(input) {
    if (!this.path || this.pathIdx >= this.path.length) return false;
    const p = this.p;
    const step = Math.max(0.8, this.nav.cell * 0.55);
    let guard = 0;
    while (this.pathIdx < this.path.length && guard++ < 12) {
      const wp = this.path[this.pathIdx];
      const dx = wp[0] - p.pos[0], dz = wp[1] - p.pos[2];
      const d = Math.hypot(dx, dz);
      if (d < (wp[2] ?? step)) { this.pathIdx++; continue; }
      this.steerTo(input, wp[0], wp[1]);
      // Jump small ledges when pinned against one.
      if (this.stuckT > 0.5) { input.jump = true; this.stuckT = 0; }
      return true;
    }
    return this.pathIdx < this.path.length;
  }

  update(dt) {
    const p = this.p;
    const input = idleInput();
    this._dt = dt;
    input.yaw = p.yaw;
    input.pitch = p.pitch;
    if (!p.alive || this.game.matchState !== MATCH_STATE.LIVE) return input;

    this.thinkT -= dt;
    this.reactionT -= dt;
    this.repathT -= dt;
    this.lootT -= dt;
    this.strafeT -= dt;
    this.burstPause -= dt;
    this.stanceT -= dt;
    this.detourT -= dt;

    // Stuck detection: little progress while trying to move. Compare against
    // last tick's movement intent (input.f is still false at this point in the
    // old code, so stuckT never accumulated and the unstick fallback was dead).
    const moved = Math.hypot(p.pos[0] - this.lastPos[0], p.pos[2] - this.lastPos[2]);
    this.lastPos = p.pos.slice();
    if (moved < 0.03 && this.lastInputMoving) this.stuckT += dt;
    else this.stuckT = Math.max(0, this.stuckT - dt * 2);

    const visible = this.findEnemy(true);
    const anyEnemy = visible || this.findEnemy(false);
    if (visible) {
      if (this.targetId !== visible.id) this.reactionT = CFG.BOT.reaction * (0.75 + this.rng.next() * 0.5);
      this.targetId = visible.id;
      this.targetVisible = true;
      this.lastKnown = visible.pos.slice();
      this.lastTargetSeenAt = this.game.time;
    } else {
      this.targetVisible = false;
      if (this.targetId !== null && !anyEnemy) this.targetId = null;
    }

    // Periodic decisions (aim jitter, strafe direction, burst state).
    if (this.thinkT <= 0) {
      this.thinkT = CFG.BOT.think * (0.7 + this.rng.next() * 0.6);
      const skill = CFG.BOT.difficulty;
      const dist = visible ? Math.hypot(visible.pos[0] - p.pos[0], visible.pos[2] - p.pos[2]) : 60;
      const scale = (0.5 + dist / 110) * (1.25 - skill);
      this.errYaw = (this.rng.next() * 2 - 1) * CFG.BOT.aimError * scale;
      this.errPitch = (this.rng.next() * 2 - 1) * CFG.BOT.aimError * 0.6 * scale;
      if (this.strafeT <= 0) {
        this.strafe = this.rng.next() < 0.5 ? 1 : -1;
        this.strafeT = 0.8 + this.rng.next() * 1.8;
      }
      if (this.burstLeft <= 0 && this.burstPause <= 0) {
        const [lo, hi] = CFG.BOT.burst;
        this.burstLeft = lo + Math.floor(this.rng.next() * (hi - lo + 1));
      }
      // Reload when it is safe or empty.
      const key = p.curWeapon();
      if (key) {
        const W = CFG.WEAPONS[key], slot = p.inv[key];
        if (slot && (slot.mag === 0 || (slot.mag < W.mag * 0.25 && !visible))) input.reload = true;
      }
      // Heal out of contact.
      if (!visible && p.health < 55 && p.healT <= 0) {
        if (p.bandages > 0 && p.health < CFG.HEAL.bandage.cap) input.heal = true;
        else if (p.medkits > 0) input.heal = true;
      }
      // Grenade at a visible mid-range target.
      if (visible && p.grenades > 0 && dist > 9 && dist < 28 && this.rng.next() < 0.02) input.grenade = true;
    }

    // ---- aim ----
    let wantShoot = false;
    if (visible && this.reactionT <= 0) {
      const key = p.curWeapon();
      const W = key ? CFG.WEAPONS[key] : null;
      const eye = this.eye();
      const d = Math.hypot(visible.pos[0] - p.pos[0], visible.pos[2] - p.pos[2]);
      // Lead the target for projectile travel time.
      const lead = W ? Math.min(0.35, d / W.mv) : 0.05;
      const tx = visible.pos[0] + (visible.vel[0] || 0) * lead;
      const tz = visible.pos[2] + (visible.vel[2] || 0) * lead;
      const ty = visible.pos[1] + visible.height() * 0.62 + (visible.vel[1] || 0) * lead;
      const dx = tx - eye[0], dy = ty - eye[1], dz = tz - eye[2];
      const desiredYaw = Math.atan2(-dx, -dz);
      const desiredPitch = Math.atan2(dy, Math.hypot(dx, dz)) + (W ? 0.5 * 9.81 * (W.grav ?? 1) * (d / W.mv) ** 2 / Math.max(1, d) : 0);
      const aimYaw = desiredYaw + this.errYaw;
      const aimPitch = clamp(desiredPitch + this.errPitch, -1.2, 1.2);
      // Turn toward the aim point at a human-ish rate.
      const turn = (4.2 + CFG.BOT.difficulty * 3.5) * dt;
      const dyaw = Math.atan2(Math.sin(aimYaw - p.yaw), Math.cos(aimYaw - p.yaw));
      input.yaw = p.yaw + clamp(dyaw, -turn, turn);
      input.pitch = p.pitch + clamp(aimPitch - p.pitch, -turn, turn);
      const off = Math.abs(Math.atan2(Math.sin(aimYaw - input.yaw), Math.cos(aimYaw - input.yaw)));
      wantShoot = off < 0.06 && d < 85 && this.burstLeft > 0 && this.burstPause <= 0;
      if (wantShoot && W) {
        if (W.auto) {
          this.burstLeft -= dt * (W.rpm / 60);
        } else {
          this.semiPulse = !this.semiPulse;
          wantShoot = this.semiPulse;
        }
      }
      if (this.burstLeft <= 0 && this.burstPause <= 0) this.burstPause = 0.35 + this.rng.next() * 0.55;
      // Combat stance / ADS at range.
      if (d > 28) this.desiredStance = STANCE.CROUCH;
      else this.desiredStance = STANCE.STAND;
      input.ads = d > 18;
    } else {
      input.yaw = this.aimYaw = p.yaw;
      input.pitch = this.aimPitch = 0;
      this.desiredStance = STANCE.STAND;
      this.burstLeft = 0;
    }

    // ---- movement ----
    const z = this.game.zone;
    const inZone = Math.hypot(p.pos[0] - z.cx, p.pos[2] - z.cz) < z.r * 0.86;
    if (this.objective) {
      if (this.reachedObjective()) {
        this.objective = null;
        this.arrived = true;
        this.path = null;
        this.repathT = 0;
      } else {
        if (this.repathT <= 0) this.setPathTo(this.objective.x, this.objective.z);
        if (!this.followPath(input)) this.steerTo(input, this.objective.x, this.objective.z);
      }
    } else if (!inZone && this.game.mode === 'br') {
      if (this.repathT <= 0) this.setPathTo(z.cx + (this.rng.next() - 0.5) * z.r * 0.4, z.cz + (this.rng.next() - 0.5) * z.r * 0.4);
      this.followPath(input);
    } else if (visible && this.reactionT <= 0) {
      // Combat strafe: keep mid range, circle, avoid standing still.
      const d = Math.hypot(visible.pos[0] - p.pos[0], visible.pos[2] - p.pos[2]);
      if (d > 34) input.f = true;
      else if (d < 9) input.b = true;
      if (this.strafe > 0) input.r = true; else input.l = true;
      if (this.stuckT > 0.4) input.jump = true;
      input.sprint = false;
    } else {
      // Loot nearby, otherwise patrol.
      const loot = this.lootT <= 0 ? this.nearestLoot() : null;
      if (loot) {
        const d = Math.hypot(loot.x - p.pos[0], loot.z - p.pos[2]);
        if (d < CFG.LOOT.pickupRange && lootInReach(this.game.world, p.pos, p.eyeHeight(), loot)) {
          input.interact = true; this.lootT = 0.35; this.path = null;
        }
        else {
          if (this.repathT <= 0) this.setPathTo(loot.x, loot.z);
          if (!this.followPath(input)) this.steerTo(input, loot.x, loot.z);
        }
      } else {
        if (!this.patrol || Math.hypot(this.patrol.x - p.pos[0], this.patrol.z - p.pos[2]) < 5) this.choosePatrol();
        if (this.repathT <= 0 && this.patrol) this.setPathTo(this.patrol.x, this.patrol.z);
        if (!this.followPath(input) && this.patrol) this.steerTo(input, this.patrol.x, this.patrol.z);
      }
    }

    // ---- unstick / fallback ----
    // Repath on little progress, then sidestep, then abandon the path and head
    // straight for the goal. This is a recovery attempt; route tests establish
    // which doorway/partition layouts actually complete.
    if (this.lastInputMoving && this.stuckT > 0.45) {
      if (this.repathT > 0) this.repathT = 0;
      if (this.detourT <= 0) { this.detourSign = -this.detourSign; this.detourT = 0.45; }
    }
    if (this.detourT > 0) {
      if (this.detourSign > 0) input.r = true; else input.l = true;
    }
    if (this.stuckT > 1.5) {
      this.path = null;
      const goal = this.objective || this.goal;
      if (goal) this.steerTo(input, goal.x, goal.z);
      if (this.stuckT > 2.5) {
        const [ix, iz] = this.nav.toCell(p.pos[0], p.pos[2]);
        const nw = this.nav.nearestWalkable(ix, iz, 10, null, p.pos[0], p.pos[2]);
        if (nw) {
          const [cx, cz] = this.nav.center(nw[0], nw[1]);
          this.steerTo(input, cx, cz);
          this.goal = { x: cx, z: cz };
        }
        if (this.stuckT > 4.0) { this.stuckT = 0; this.repathT = 0; }
      }
    }

    // ---- stance / fire ----
    if (this.stanceT <= 0 && this.desiredStance !== p.stance) {
      input.stance = this.desiredStance;
      this.stanceT = 0.35;
    }
    input.shoot = wantShoot;
    input.cycle = false;
    input.slot = -1;
    this.lastInputMoving = !!(input.f || input.b);
    return input;
  }
}

// Spawn and wire bots into a game. Returns the created players.
export function spawnBots(game, count, teamMode = false) {
  const bots = [];
  const names = ['Viper', 'Ghost', 'Nomad', 'Rook', 'Saber', 'Mako', 'Kestrel', 'Wraith',
    'Bishop', 'Cinder', 'Dagger', 'Echo', 'Falcon', 'Grit', 'Havoc', 'Iris',
    'Juno', 'Kilo', 'Lynx', 'Moss', 'Nyx', 'Onyx', 'Pike', 'Quill',
    'Raven', 'Sable', 'Talon', 'Umber', 'Vex', 'Wolf', 'Yarrow', 'Zulu'];
  for (let i = 0; i < count; i++) {
    const team = teamMode ? (i % 2) : 0;
    const p = game.addPlayer(names[i % names.length] + '-' + (i + 1), team, { bot: true });
    p.isBot = true;
    p.bot = new BotBrain(game, p);
    bots.push(p);
  }
  return bots;
}

export function stepBots(game, dt, inputs) {
  for (const p of game.players.values()) {
    if (!p.isBot || !p.bot) continue;
    if (!p.alive) { inputs.delete(p.id); continue; }
    inputs.set(p.id, p.bot.update(dt));
  }
}
