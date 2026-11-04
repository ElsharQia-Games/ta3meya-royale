// ============================================================================
// Server-side bot AI. Plain ES module: also used by the browser offline mode.
//
// Bots use the exact same input shape as network players, so the authoritative
// simulation treats them identically. Navigation is a coarse A* grid built from
// the shared world (terrain slope, water, building/prop footprints). Bots do
// not path through building interiors; that limitation is documented in
// GAP-ANALYSIS.md.
// ============================================================================
import { CFG, STANCE, MATCH_STATE } from '../shared/config.js';
import { clamp, yawTo, TAU } from '../shared/math.js';

const navCache = new Map();

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

export class NavGrid {
  constructor(world) {
    this.world = world;
    this.cell = CFG.BOT.navCell;
    this.half = CFG.MAP.SIZE / 2;
    this.n = Math.ceil(CFG.MAP.SIZE / this.cell);
    this.walk = new Uint8Array(this.n * this.n);
    this.build();
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
      'stairs', 'container', 'wreck', 'barrier', 'boundary', 'structure']);
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
          // Cell inner square vs box footprint, with a small body radius.
          if (b.max[0] < x - c * 0.5 + 0.3 || b.min[0] > x + c * 0.5 - 0.3) continue;
          if (b.max[2] < z - c * 0.5 + 0.3 || b.min[2] > z + c * 0.5 - 0.3) continue;
          if (b.max[1] < y + 0.65 || b.min[1] > y + 2.0) continue;
          blocked = true; break;
        }
        if (!blocked) this.walk[this.idx(ix, iz)] = 1;
      }
    }
  }

  nearestWalkable(ix, iz, radius = 6) {
    if (this.walkable(ix, iz)) return [ix, iz];
    for (let r = 1; r <= radius; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          if (this.walkable(ix + dx, iz + dz)) return [ix + dx, iz + dz];
        }
      }
    }
    return null;
  }

  findPath(sx, sz, tx, tz, maxExpansions = 2400) {
    const [six, siz] = this.toCell(sx, sz);
    const [tix, tiz] = this.toCell(tx, tz);
    const start = this.nearestWalkable(six, siz, 4);
    const goal = this.nearestWalkable(tix, tiz, 8);
    if (!start || !goal) return null;
    if (start[0] === goal[0] && start[1] === goal[1]) return [this.center(goal[0], goal[1])];

    const N = this.n, total = N * N;
    const g = new Float32Array(total).fill(Infinity);
    const came = new Int32Array(total).fill(-1);
    const closed = new Uint8Array(total);
    const open = new MinHeap();
    const startIdx = this.idx(start[0], start[1]);
    const goalIdx = this.idx(goal[0], goal[1]);
    const h = (ix, iz) => {
      const dx = Math.abs(ix - goal[0]), dz = Math.abs(iz - goal[1]);
      return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz);
    };
    g[startIdx] = 0;
    open.push({ idx: startIdx, ix: start[0], iz: start[1], f: h(start[0], start[1]) });
    let expansions = 0;
    const dirs = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
    ];
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
      for (const [dx, dz, cost] of dirs) {
        const nx = cur.ix + dx, nz = cur.iz + dz;
        if (!this.walkable(nx, nz)) continue;
        // Do not cut diagonal corners through blocked cells.
        if (dx && dz && (!this.walkable(cur.ix + dx, cur.iz) || !this.walkable(cur.ix, cur.iz + dz))) continue;
        const ni = this.idx(nx, nz);
        if (closed[ni]) continue;
        const ng = g[cur.idx] + cost;
        if (ng < g[ni]) {
          g[ni] = ng; came[ni] = cur.idx;
          open.push({ idx: ni, ix: nx, iz: nz, f: ng + h(nx, nz) });
        }
      }
    }
    return null;
  }
}

export function getNav(world) {
  const key = world.seed;
  if (!navCache.has(key)) navCache.set(key, new NavGrid(world));
  return navCache.get(key);
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
    const path = this.nav.findPath(this.p.pos[0], this.p.pos[2], x, z);
    if (path && path.length) {
      this.path = path; this.pathIdx = 0;
      // Skip a waypoint we are already standing on.
      if (path.length > 1) this.pathIdx = 1;
    } else {
      this.path = null;
    }
    this.repathT = 1.1 + this.rng.next() * 0.8;
  }

  followPath(input) {
    if (!this.path || this.pathIdx >= this.path.length) return false;
    const p = this.p;
    const wp = this.path[this.pathIdx];
    const dx = wp[0] - p.pos[0], dz = wp[1] - p.pos[2];
    const d = Math.hypot(dx, dz);
    if (d < 2.2) {
      this.pathIdx++;
      return this.pathIdx < this.path.length;
    }
    const desired = Math.atan2(-dx, -dz);
    const diff = Math.atan2(Math.sin(desired - p.yaw), Math.cos(desired - p.yaw));
    input.f = Math.abs(diff) < 1.15;
    if (diff > 0.1) input.l = true; else if (diff < -0.1) input.r = true;
    input.sprint = d > 12;
    // Jump over small obstacles when very close to a waypoint but not moving.
    if (this.stuckT > 0.6) { input.jump = true; this.stuckT = 0; }
    return true;
  }

  update(dt) {
    const p = this.p;
    const input = idleInput();
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

    // Stuck detection: little progress while trying to move.
    const moved = Math.hypot(p.pos[0] - this.lastPos[0], p.pos[2] - this.lastPos[2]);
    this.lastPos = p.pos.slice();
    if (moved < 0.03 && (input.f || input.b)) this.stuckT += dt; else this.stuckT = Math.max(0, this.stuckT - dt * 2);

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
    if (!inZone && this.game.mode === 'br') {
      if (this.repathT <= 0) this.setPathTo(z.cx + (this.rng.next() - 0.5) * z.r * 0.4, z.cz + (this.rng.next() - 0.5) * z.r * 0.4);
      this.followPath(input);
    } else if (visible && this.reactionT <= 0) {
      // Combat strafe: keep mid range, circle, avoid standing still.
      const d = Math.hypot(visible.pos[0] - p.pos[0], visible.pos[2] - p.pos[2]);
      if (d > 34) input.f = true;
      else if (d < 9) input.b = true;
      if (this.strafe > 0) input.r = true; else input.l = true;
      if (this.stuckT > 0.4) input.jump = true;
      // Face movement while strafing only if no target.
      input.sprint = false;
    } else {
      // Loot nearby, otherwise patrol.
      const loot = this.lootT <= 0 ? this.nearestLoot() : null;
      if (loot) {
        const d = Math.hypot(loot.x - p.pos[0], loot.z - p.pos[2]);
        if (d < CFG.LOOT.pickupRange) { input.interact = true; this.lootT = 0.35; this.path = null; }
        else {
          if (this.repathT <= 0) this.setPathTo(loot.x, loot.z);
          this.followPath(input);
        }
      } else {
        if (!this.patrol || Math.hypot(this.patrol.x - p.pos[0], this.patrol.z - p.pos[2]) < 5) this.choosePatrol();
        if (this.repathT <= 0 && this.patrol) this.setPathTo(this.patrol.x, this.patrol.z);
        if (!this.followPath(input) && this.patrol) {
          const desired = yawTo(p.pos[0], p.pos[2], this.patrol.x, this.patrol.z);
          const diff = Math.atan2(Math.sin(desired - p.yaw), Math.cos(desired - p.yaw));
          input.f = true;
          if (diff > 0.1) input.l = true; else if (diff < -0.1) input.r = true;
        }
      }
      // Aim where we are going while travelling.
      if (input.f) {
        const mx = (input.l ? 1 : 0) - (input.r ? 1 : 0);
        input.yaw = p.yaw + mx * 0.8 * dt;
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
