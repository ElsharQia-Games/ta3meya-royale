// ============================================================================
// Weapons, ballistics, hit zones, damage, loot, grenades.
// Bullets are solved as ballistic rays (gravity + quadratic drag + penetration)
// with travel-time-scheduled damage. Hitboxes can be supplied rewound for lag
// compensation. All randomness uses the game RNG for determinism.
// ============================================================================
import { CFG, MATERIALS, STANCE } from './config.js';
import { clamp, spreadDirection, dirFromAngles, yawTo, TAU, lerpAngle } from './math.js';
import { rayCapsuleSegment, raySphere, stanceHeight, stanceEye } from './physics.js';
import { vehicleInReach } from './vehicle.js';
import { advanceRocket } from './projectiles.js';

export const WEAPON_KEYS = Object.keys(CFG.WEAPONS);

export function makeWeaponState(key) {
  const W = CFG.WEAPONS[key];
  return { mag: W.mag, reserve: W.reserve };
}

// Hitbox capsules for a player-like object {pos, height, stance}.
//
// The torso capsule is capped below the head sphere. Without that gap the
// torso's top cap overlaps the head and steals headshots from rays aimed at
// the face. Prone is inherently approximate in a vertical capsule model; the
// head-priority rule in nearestPlayerHit keeps face shots registering. Prone
// uses horizontal, yaw-oriented body segments matching the presentation rig.
export function hitboxesFor(pos, height, stance, yaw = 0) {
  if (stance === STANCE.PRONE) {
    // The controller/camera stays at the leading head position. The rendered
    // torso/legs extend behind it; hits must follow those visible body parts.
    const point = (back, y) => [pos[0] + Math.sin(yaw) * back, pos[1] + y, pos[2] + Math.cos(yaw) * back];
    return {
      head: { base: point(0, .26), r: .16, zone: 'head' },
      torso: { a: point(.24, .25), b: point(.68, .25), r: .2, zone: 'torso' },
      legs: { a: point(.83, .15), b: point(1.4, .15), r: .15, zone: 'legs' },
    };
  }
  const headR = .13;
  const headCenter = pos[1] + height - headR - 0.03;
  const torsoR = .25;
  const pelvis = pos[1] + height * .4;
  let chestTop = headCenter - headR - torsoR;
  if (chestTop < pelvis + 0.05) chestTop = pelvis + 0.05;
  return {
    head: { base: [pos[0], headCenter - headR, pos[2]], r: headR, zone: 'head' },
    torso: { a: [pos[0], pelvis, pos[2]], b: [pos[0], chestTop, pos[2]], r: torsoR, zone: 'torso' },
    legs: { a: [pos[0], pos[1] + 0.08, pos[2]], b: [pos[0], pelvis, pos[2]], r: 0.24, zone: 'legs' },
  };
}

function rayCapsuleBox(o, d, a, b, r) {
  // Use endpoint geometry directly; reconstructing a vertical capsule loses
  // the prone body's horizontal length and orientation.
  return rayCapsuleSegment(o, d, a, b, r);
}

const HEAD_PRIORITY = 0.3; // metres a head hit may sit behind a body hit

export function nearestPlayerHit(origin, dir, maxT, targets, shooterId, shooterTeam, mode) {
  let best = null, bestT = maxT, bestZone = 'torso';
  for (const t of targets) {
    if (!t.alive || t.id === shooterId) continue;
    if (mode === 'tdm' && t.team === shooterTeam) continue;
    const hb = t.hitboxes || hitboxesFor(t.pos, t.height, t.stance || 0, t.yaw || 0);
    let tBest = Infinity, tZone = null;
    // Head first; body zones must be clearly closer to override it. This makes
    // shots aimed at the face register as headshots even where the torso cap
    // and head sphere touch.
    const ht = raySphere(origin, dir, [hb.head.base[0], hb.head.base[1] + hb.head.r, hb.head.base[2]], hb.head.r);
    if (ht !== null) { tBest = ht; tZone = 'head'; }
    let bt = rayCapsuleBox(origin, dir, hb.torso.a, hb.torso.b, hb.torso.r);
    if (bt !== null && bt < tBest - (tZone === 'head' ? HEAD_PRIORITY : 0)) { tBest = bt; tZone = 'torso'; }
    bt = rayCapsuleBox(origin, dir, hb.legs.a, hb.legs.b, hb.legs.r);
    if (bt !== null && bt < tBest - (tZone ? HEAD_PRIORITY : 0)) { tBest = bt; tZone = 'legs'; }
    if (tZone && tBest < bestT) { bestT = tBest; best = t; bestZone = tZone; }
  }
  return best ? { target: best, t: bestT, zone: bestZone } : null;
}

// Solve a single bullet. Returns segments (for tracer), impacts and a hit.
// This remains the pure trajectory preview used for the immediate shot event;
// authoritative damage now comes from stepBullets() against live targets.
export function solveBallistic(world, origin, dir, W, targets, shooterId, shooterTeam, mode, maxTime = 2.2, opts = {}) {
  const rayOpts = opts.ballistic ? { ballistic: true } : undefined;
  const vel = [dir[0] * W.mv, dir[1] * W.mv, dir[2] * W.mv];
  const pos = origin.slice();
  const segments = [pos.slice()];
  const impacts = [];
  let dist = 0;          // total travelled distance (falloff / travel time)
  let elapsed = 0;       // seconds of simulated flight
  let damageMult = 1;
  let hit = null;
  const dt = 1 / 90;
  let guard = 0;
  while (elapsed < maxTime && guard++ < 260) {
    const prev = pos.slice();
    // drag + gravity
    const sp = Math.hypot(vel[0], vel[1], vel[2]);
    const dragK = W.drag * sp;
    vel[0] -= vel[0] * dragK * dt;
    vel[1] -= vel[1] * dragK * dt;
    vel[2] -= vel[2] * dragK * dt;
    vel[1] -= 9.81 * (W.grav ?? 1) * dt;
    pos[0] += vel[0] * dt; pos[1] += vel[1] * dt; pos[2] += vel[2] * dt;
    elapsed += dt;
    const sx = pos[0] - prev[0], sy = pos[1] - prev[1], sz = pos[2] - prev[2];
    const segLen = Math.hypot(sx, sy, sz);
    if (segLen < 1e-6) continue;
    const sdir = [sx / segLen, sy / segLen, sz / segLen];

    const wh = world.raycast(prev, sdir, segLen, rayOpts);
    const ph = nearestPlayerHit(prev, sdir, wh ? wh.t : segLen, targets, shooterId, shooterTeam, mode);

    if (ph && (!wh || ph.t < wh.t)) {
      const point = [prev[0] + sdir[0] * ph.t, prev[1] + sdir[1] * ph.t, prev[2] + sdir[2] * ph.t];
      const d = dist + ph.t;
      let mult = 1;
      const [fs, fe, fm] = W.falloff;
      if (d > fs) mult = clamp(1 - (d - fs) / (fe - fs), fm, 1);
      const zoneMult = ph.zone === 'head' ? W.headshot : ph.zone === 'legs' ? 0.82 : 1;
      const damage = W.dmg * mult * damageMult * zoneMult;
      impacts.push({ point, zone: ph.zone, targetId: ph.target.id, damage, dist: d, hit: true, time: elapsed });
      segments.push(point);
      hit = { targetId: ph.target.id, zone: ph.zone, damage, point, dist: d };
      break;
    }
    if (wh) {
      const point = wh.point;
      impacts.push({ point, zone: null, targetId: null, damage: 0, dist: dist + wh.t, tag: wh.tag, mat: wh.mat, normal: wh.normal, box: wh.box, vehicle: wh.vehicle, time: elapsed });
      segments.push(point);
      // penetration: only thin boxes / glass / wood
      const thickness = (wh.tmax !== undefined && isFinite(wh.tmax) ? wh.tmax - wh.t : Infinity);
      const mat = MATERIALS[wh.mat] || MATERIALS.concrete;
      const canPen = wh.box && thickness > 0 && thickness <= W.penetration * (mat.pen || 1) && damageMult > 0.28;
      if (!canPen) break;
      damageMult *= 0.58;
      // continue just past the exit point
      const exitT = wh.tmax + 0.015;
      const ex = [prev[0] + sdir[0] * exitT, prev[1] + sdir[1] * exitT, prev[2] + sdir[2] * exitT];
      pos[0] = ex[0]; pos[1] = ex[1]; pos[2] = ex[2];
      segments.push(ex.slice());
      dist += exitT;
      continue;
    }
    segments.push(pos.slice());
    dist += segLen;
    if (pos[1] < -20) break;
  }
  return { segments, impacts, hit, travel: dist, time: elapsed };
}

export function tryFire(game, p, input, targets, opts = {}) {
  if (!p.alive || p.reloadT > 0 || p.cooldown > 0 || p.switchT > 0) return false;
  const key = p.weapons[p.curSlot];
  if (!key) return false;
  const W = CFG.WEAPONS[key];
  const slot = p.inv[key];
  if (!slot || slot.mag <= 0) {
    p.cooldown = 0.18;
    game.events.push({ k: 'dry', id: p.id, w: key });
    return false;
  }
  const origin = [p.pos[0], p.pos[1] + p.eyeHeight(), p.pos[2]];
  const baseDir = dirFromAngles(p.yaw, p.pitch);
  // Spread model.
  const speed = Math.hypot(p.vel[0], p.vel[2]);
  let spread = (p.adsing ? W.spreadAds : W.spreadHip);
  spread += (speed / CFG.PLAYER.SPRINT) * W.spreadMove;
  if (!p.grounded) spread += W.spreadAir;
  spread += p.heat * 0.02;
  if (p.stance === STANCE.CROUCH) spread *= 0.88;
  if (p.stance === STANCE.PRONE) spread *= 0.72;
  if (p.inWater) spread *= 1.3;
  spread = Math.min(spread, 0.14);

  slot.mag--;
  p.cooldown = 60 / W.rpm;
  p.heat = Math.min(1, p.heat + (W.pellets > 1 ? 0.35 : 0.09));
  p.healT = 0; p.healItem = null;
  p.shotsFired = (p.shotsFired || 0) + 1;

  const rng = opts.rng || game.rng;
  if (W.projectile === 'rocket') {
    const direction = spreadDirection(baseDir, spread, rng);
    const projectile = { id: `${p.id}:rocket:${input.seq || game.tick || p.shotsFired}`,
      type: 'rocket', weapon: key, owner: p.id, team: p.team, pos: origin.slice(),
      vel: direction.map(value => value * W.mv), fuse: W.rocket.life, distance: 0 };
    game.projectiles.push(projectile);
    game.events.push({ k: 'launch', id: p.id, projectileId: projectile.id, w: key,
      o: origin, v: projectile.vel.slice(), life: projectile.fuse, team: p.team });
    return true;
  }
  // Ordinary bullets become persistent authoritative projectiles. The shot
  // event only carries a *predicted* tracer endpoint; hits, world impacts,
  // destruction and damage are emitted when the projectile actually reaches
  // them in stepBullets(). This removes the frozen-target + pendingDamage path.
  const tracerEnds = [];
  const flightTimes = [];
  const now = Number.isFinite(game.time) ? game.time : 0;
  const bullets = game.bullets || (game.bullets = []);
  const catchupAge = clamp(opts.catchupAge || 0, 0, CFG.BULLET.catchupMax);
  const catchupFrom = catchupAge > 0 ? targets : null;
  const catchupTo = catchupAge > 0 && typeof game.buildTargets === 'function'
    ? game.buildTargets() : null;
  for (let i = 0; i < W.pellets; i++) {
    const dir = spreadDirection(baseDir, spread, rng);
    const bullet = {
      id: game.nextBulletId = (game.nextBulletId || 0) + 1,
      ownerId: p.id, team: p.team, weapon: key,
      pos: origin.slice(), vel: [dir[0] * W.mv, dir[1] * W.mv, dir[2] * W.mv],
      dist: 0, age: 0, damageMult: 1,
      life: CFG.BULLET.maxLife,
      bornAt: now - catchupAge,
      catchupAge, catchupFrom, catchupTo,
      dead: false,
    };
    bullets.push(bullet);
    if (bullets.length > CFG.BULLET.maxActive) bullets.splice(0, bullets.length - CFG.BULLET.maxActive);
    // Predicted tracer endpoint only. It is never used to apply damage.
    const res = solveBallistic(game.world, origin, dir, W, targets, p.id, p.team, game.mode,
      CFG.BULLET.maxLife, { ballistic: true });
    const end = res.segments[res.segments.length - 1];
    tracerEnds.push([+end[0].toFixed(2), +end[1].toFixed(2), +end[2].toFixed(2)]);
    flightTimes.push(+res.time.toFixed(3));
  }
  game.events.push({
    k: 'shot', id: p.id, w: key,
    o: [+origin[0].toFixed(2), +origin[1].toFixed(2), +origin[2].toFixed(2)],
    e: tracerEnds, flight: flightTimes, imps: [], hit: false, team: p.team,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Authoritative bullet projectiles
//
// A bullet persists across simulation ticks and is swept against the live world
// and target hitboxes every tick. The only historical work is the bounded
// catch-up on the first tick, which advances the bullet from the shooter's
// view time to acceptance time using interpolated target positions. Live
// simulation then continues once; lag compensation is never applied twice.
// ---------------------------------------------------------------------------

function interpolateTargets(from, to, f) {
  if (!from || !to) return to || from || [];
  const a = new Map(from.map(t => [t.id, t]));
  const out = [];
  for (const b of to) {
    if (!b.alive) continue;
    const t = a.get(b.id);
    let pos, height, stance, yaw;
    if (!t || !t.alive || (t.lifeId !== undefined && b.lifeId !== undefined && t.lifeId !== b.lifeId)) {
      pos = b.pos.slice(); height = b.height; stance = b.stance || 0; yaw = b.yaw || 0;
    } else {
      pos = [
        t.pos[0] + (b.pos[0] - t.pos[0]) * f,
        t.pos[1] + (b.pos[1] - t.pos[1]) * f,
        t.pos[2] + (b.pos[2] - t.pos[2]) * f,
      ];
      height = t.height + (b.height - t.height) * f;
      stance = f < 0.5 ? (t.stance || 0) : (b.stance || 0);
      yaw = lerpAngle(t.yaw || 0, b.yaw || 0, f);
    }
    out.push({
      id: b.id, pos, height, stance, yaw, alive: true, team: b.team,
      lifeId: b.lifeId, spawnTime: b.spawnTime,
      hitboxes: hitboxesFor(pos, height, stance, yaw),
    });
  }
  return out;
}

function recordWorldImpact(game, bullet, wh, point, distance, W) {
  game.events.push({
    k: 'impact', id: bullet.ownerId, w: bullet.weapon,
    x: +point[0].toFixed(2), y: +point[1].toFixed(2), z: +point[2].toFixed(2),
    n: wh.normal ? [+wh.normal[0].toFixed(2), +wh.normal[1].toFixed(2), +wh.normal[2].toFixed(2)] : null,
    tag: wh.tag || null, mat: wh.mat || null,
    bid: wh.box ? wh.box.id : null, vid: wh.vehicle ? wh.vehicle.id : null,
    dist: Math.round(distance),
  });
  if (wh.vehicle) game.damageVehicle(wh.vehicle, W.dmg * 0.85, bullet.ownerId);
  const box = wh.box;
  if (box && box.dynamic && !box.destroyed) {
    box.hp -= W.dmg * 0.75;
    if (box.hp <= 0) {
      box.destroyed = true;
      const destroyed = game.destroyedBoxes || (game.destroyedBoxes = new Set());
      destroyed.add(box.id);
      game.events.push({
        k: 'destroy', id: box.id, kind: box.kind || box.tag,
        x: +((box.min[0] + box.max[0]) / 2).toFixed(2), y: box.min[1],
        z: +((box.min[2] + box.max[2]) / 2).toFixed(2),
        sx: +(box.max[0] - box.min[0]).toFixed(2),
        sy: +(box.max[1] - box.min[1]).toFixed(2),
        sz: +(box.max[2] - box.min[2]).toFixed(2),
        mat: box.mat,
      });
    }
  }
}

function eligibleTargets(game, bullet, targets) {
  if (!targets || !targets.length) return targets || [];
  const out = [];
  for (const t of targets) {
    const victim = game.players ? game.players.get(t.id) : null;
    // A target that is gone, dead, from a different life, or spawned after
    // this round was fired cannot be hit. Exclude it before the ray so the
    // sweep does not repeatedly rediscover and skip it inside the travel guard.
    if (!t.alive || !victim || !victim.alive) continue;
    if (t.lifeId !== undefined && victim.lifeId !== undefined &&
      victim.lifeId !== t.lifeId) continue;
    if (victim.spawnTime !== undefined &&
      (bullet.bornAt === undefined || victim.spawnTime > bullet.bornAt)) continue;
    out.push(t);
  }
  return out;
}

function advanceBullet(game, bullet, W, dt, targets) {
  if (bullet.dead || dt <= 1e-9) return;
  targets = eligibleTargets(game, bullet, targets);
  // Drag + gravity are integrated once per slice, matching the original
  // solver's per-step model while preserving residual travel on penetration.
  const speed = Math.hypot(bullet.vel[0], bullet.vel[1], bullet.vel[2]);
  const dragK = W.drag * speed;
  bullet.vel[0] -= bullet.vel[0] * dragK * dt;
  bullet.vel[1] -= bullet.vel[1] * dragK * dt;
  bullet.vel[2] -= bullet.vel[2] * dragK * dt;
  bullet.vel[1] -= 9.81 * (W.grav ?? 1) * dt;
  const vlen = Math.hypot(bullet.vel[0], bullet.vel[1], bullet.vel[2]);
  if (vlen < 1e-9) return;
  const dir = [bullet.vel[0] / vlen, bullet.vel[1] / vlen, bullet.vel[2] / vlen];
  const moveLen = vlen * dt;
  let travelled = 0;
  let guard = 0;
  const base = bullet.pos;

  while (travelled < moveLen - 1e-9 && guard++ <= CFG.BULLET.maxPenetrations) {
    const start = [base[0] + dir[0] * travelled, base[1] + dir[1] * travelled, base[2] + dir[2] * travelled];
    const segLen = moveLen - travelled;
    const wh = game.world.raycast(start, dir, segLen, { ballistic: true });
    const ph = nearestPlayerHit(start, dir, wh ? wh.t : segLen, targets, bullet.ownerId, bullet.team, game.mode);

    if (ph) {
      const victim = game.players ? game.players.get(ph.target.id) : null;
      const sameLife = !victim || ph.target.lifeId === undefined || victim.lifeId === undefined ||
        victim.lifeId === ph.target.lifeId;
      const notFutureSpawn = !victim || victim.spawnTime === undefined || victim.spawnTime <= bullet.bornAt;
      if (victim && victim.alive && sameLife && notFutureSpawn) {
        const point = [start[0] + dir[0] * ph.t, start[1] + dir[1] * ph.t, start[2] + dir[2] * ph.t];
        const d = bullet.dist + travelled + ph.t;
        let mult = 1;
        const [fs, fe, fm] = W.falloff;
        if (d > fs) mult = clamp(1 - (d - fs) / (fe - fs), fm, 1);
        const zoneMult = ph.zone === 'head' ? W.headshot : ph.zone === 'legs' ? 0.82 : 1;
        const damage = W.dmg * mult * bullet.damageMult * zoneMult;
        const attacker = game.players ? game.players.get(bullet.ownerId) : null;
        if (attacker && attacker.id !== victim.id) attacker.damageDealt += damage;
        if (game.stats) { game.stats.hits++; game.stats.damage += damage; }
        applyDamage(game, victim, damage, bullet.ownerId, ph.zone, point, bullet.weapon, d);
        bullet.dead = true;
        break;
      }
      // Defensive fallback for an eligibility change between filtering and the
      // ray. Normal dead/respawned targets are removed by eligibleTargets().
      // Treat it as empty space and keep the round moving.
      const skip = Math.max(ph.t + 0.02, 0.02);
      travelled = Math.min(moveLen, travelled + skip);
      continue;
    }

    if (wh) {
      const d = bullet.dist + travelled + wh.t;
      recordWorldImpact(game, bullet, wh, wh.point, d, W);
      const thickness = (wh.tmax !== undefined && isFinite(wh.tmax) ? wh.tmax - wh.t : Infinity);
      const mat = MATERIALS[wh.mat] || MATERIALS.concrete;
      const canPen = wh.box && thickness > 0 && thickness <= W.penetration * (mat.pen || 1) && bullet.damageMult > 0.28;
      if (!canPen) { bullet.dead = true; break; }
      bullet.damageMult *= 0.58;
      // Continue from just past the exit point, still inside this same slice.
      const exitT = wh.tmax + 0.015;
      const advance = Math.max(exitT, wh.t + 0.02);
      travelled = Math.min(moveLen, travelled + advance);
      continue;
    }

    travelled += segLen;
  }

  bullet.pos = [base[0] + dir[0] * travelled, base[1] + dir[1] * travelled, base[2] + dir[2] * travelled];
  bullet.dist += travelled;
  bullet.age += dt;
}

export function stepBullets(game, dt) {
  const bullets = game.bullets;
  if (!bullets || !bullets.length) return;
  const targets = typeof game.buildTargets === 'function' ? game.buildTargets() : [];
  for (const bullet of bullets) {
    if (bullet.dead) continue;
    const W = CFG.WEAPONS[bullet.weapon];
    if (!W) { bullet.dead = true; continue; }

    // Bounded catch-up from the shooter's view time to acceptance time.
    if (bullet.catchupAge > 0) {
      const age = clamp(bullet.catchupAge, 0, CFG.BULLET.catchupMax);
      const steps = Math.max(1, Math.ceil(age / CFG.SIM_DT));
      const slice = age / steps;
      for (let i = 1; i <= steps && !bullet.dead; i++) {
        const interp = interpolateTargets(bullet.catchupFrom, bullet.catchupTo, i / steps);
        advanceBullet(game, bullet, W, slice, interp);
      }
      bullet.catchupAge = 0;
      bullet.catchupFrom = null;
      bullet.catchupTo = null;
      if (bullet.dead) continue;
    }

    advanceBullet(game, bullet, W, dt, targets);
    if (bullet.age >= bullet.life) bullet.dead = true;
    if (bullet.pos[1] < -20 ||
      Math.abs(bullet.pos[0]) > CFG.MAP.BOUNDS + 100 ||
      Math.abs(bullet.pos[2]) > CFG.MAP.BOUNDS + 100) bullet.dead = true;
  }
  if (bullets.some(b => b.dead)) game.bullets = bullets.filter(b => !b.dead);
}

export function applyDamage(game, victim, amount, attackerId, zone, point, weaponKey, dist = 0) {
  if (!victim || !victim.alive || amount <= 0) return;
  const attacker = game.players?.get(attackerId);
  if (game.mode === 'tdm' && attacker && attacker.id !== victim.id && attacker.team === victim.team) return;
  let dmg = amount;
  // Armour absorbs a share until depleted.
  if (victim.armor > 0) {
    const absorbFrac = zone === 'head' ? CFG.ARMOR.headAbsorb : CFG.ARMOR.absorb;
    const absorbed = Math.min(victim.armor, dmg * absorbFrac);
    victim.armor = Math.max(0, victim.armor - absorbed);
    dmg -= absorbed;
  }
  victim.health -= dmg;
  victim.healT = 0; victim.healItem = null;
  victim.lastAttacker = attackerId;
  victim.lastDamageAt = game.time;
  victim.damageTaken = (victim.damageTaken || 0) + dmg;
  game.events.push({
    k: 'hit', from: attackerId, to: victim.id, dmg: Math.round(dmg), zone,
    x: point ? point[0] : victim.pos[0], y: point ? point[1] : victim.pos[1] + 1,
    z: point ? point[2] : victim.pos[2], w: weaponKey, hp: Math.max(0, Math.round(victim.health)),
    armor: Math.round(victim.armor), dist: Math.round(dist),
  });
  if (victim.health <= 0) game.kill(victim, attackerId, weaponKey, zone, dist);
}

export function tryReload(game, p) {
  const key = p.weapons[p.curSlot];
  if (!key || p.reloadT > 0 || p.switchT > 0) return false;
  const W = CFG.WEAPONS[key], slot = p.inv[key];
  if (!slot || slot.mag >= W.mag || slot.reserve <= 0) return false;
  p.reloadT = W.reload;
  p.reloadKey = key;
  p.healT = 0; p.healItem = null;
  game.events.push({ k: 'reload', id: p.id, w: key, dur: W.reload });
  return true;
}

export function finishReload(p) {
  const key = p.reloadKey;
  if (!key || !p.inv[key]) { p.reloadT = 0; return; }
  const W = CFG.WEAPONS[key], slot = p.inv[key];
  const need = W.mag - slot.mag, take = Math.min(need, slot.reserve);
  slot.mag += take; slot.reserve -= take;
  p.reloadT = 0; p.reloadKey = null;
}

export function switchWeapon(game, p, slotIndex) {
  if (slotIndex < 0 || slotIndex > 1 || slotIndex === p.curSlot) return false;
  if (!p.weapons[slotIndex]) return false;
  p.curSlot = slotIndex;
  p.reloadT = 0; p.reloadKey = null;
  p.healT = 0; p.healItem = null;
  p.switchT = CFG.WEAPONS[p.weapons[slotIndex]].switchTime;
  game.events.push({ k: 'switch', id: p.id, w: p.weapons[slotIndex] });
  return true;
}

export function throwGrenade(game, p, smoke = false) {
  if (!smoke && p.grenades <= 0) return false;
  if (smoke && p.smokes <= 0) return false;
  if (p.cooldown > 0 || p.switchT > 0) return false;
  if (smoke) p.smokes--; else p.grenades--;
  p.cooldown = 0.75;
  p.healT = 0; p.healItem = null;
  p.reloadT = 0; p.reloadKey = null;
  const eye = [p.pos[0], p.pos[1] + p.eyeHeight(), p.pos[2]];
  const dir = dirFromAngles(p.yaw, p.pitch + 0.12);
  const speed = CFG.GRENADE.throwSpeed;
  const vel = [dir[0] * speed, dir[1] * speed + 2.4, dir[2] * speed];
  const projectileId = `${p.id}:${game.tick}`;
  game.projectiles.push({
    id: projectileId,
    type: smoke ? 'smoke' : 'grenade',
    pos: eye, vel,
    owner: p.id, fuse: smoke ? CFG.SMOKE.fuse : CFG.GRENADE.fuse, bounces: 0,
    life: smoke ? CFG.SMOKE.duration + CFG.SMOKE.fuse : 6,
  });
  game.events.push({ k: 'throw', id: p.id, projectileId, smoke, o: eye.map(v => +v.toFixed(2)), v: vel.map(v => +v.toFixed(2)) });
  return true;
}

export function moveProjectile(world, pr, dt) {
  const G = CFG.GRENADE;
  pr.vel[1] -= 9.81 * G.gravity * dt;
  pr.vel[0] *= 1 - G.drag * dt; pr.vel[2] *= 1 - G.drag * dt;
  const prev = pr.pos.slice();
  pr.pos[0] += pr.vel[0] * dt; pr.pos[1] += pr.vel[1] * dt; pr.pos[2] += pr.vel[2] * dt;
  const delta = pr.pos.map((value, i) => value - prev[i]), distance = Math.hypot(...delta);
  if (distance <= 1e-5) return;
  const hit = world.raycast(prev, delta.map(value => value / distance), distance);
  if (!hit) return;
  pr.pos = hit.point.map((value, i) => value + hit.normal[i] * .04);
  const vn = pr.vel[0] * hit.normal[0] + pr.vel[1] * hit.normal[1] + pr.vel[2] * hit.normal[2];
  if (vn < 0) for (let i = 0; i < 3; i++) pr.vel[i] -= 1.55 * vn * hit.normal[i];
  for (let i = 0; i < 3; i++) pr.vel[i] *= .55;
  pr.bounces++;
  if (pr.bounces > G.bounces) pr.fuse = Math.min(pr.fuse, .05);
}

export function stepProjectiles(game, dt) {
  const G = CFG.GRENADE;
  let rocketTargets = null;
  for (let i = game.projectiles.length - 1; i >= 0; i--) {
    const pr = game.projectiles[i];
    pr.fuse -= dt;

    if (pr.type === 'rocket') {
      rocketTargets ||= game.buildTargets();
      const hit = advanceRocket(game.world, pr, dt, (origin, direction, distance) =>
        nearestPlayerHit(origin, direction, distance, rocketTargets, pr.owner, pr.team, game.mode));
      if (hit) {
        const W = CFG.WEAPONS[pr.weapon];
        if (hit.target) applyDamage(game, game.players.get(hit.target.id), W.dmg, pr.owner, 'explosion', hit.point, pr.weapon, pr.distance);
        // Remove before blast/secondary explosions, so even chained destruction
        // cannot revisit a spent rocket.
        game.projectiles.splice(i, 1);
        explode(game, pr.pos, W.rocket.damage, W.rocket.radius, pr.owner, pr.id, pr.weapon);
      } else if (pr.fuse <= 0 || Math.abs(pr.pos[0]) > CFG.MAP.BOUNDS + 100 || Math.abs(pr.pos[2]) > CFG.MAP.BOUNDS + 100 || pr.pos[1] < -80) {
        game.projectiles.splice(i, 1);
        game.events.push({ k: 'projectileend', projectileId: pr.id, reason: 'expired' });
      }
      continue;
    }

    // A deployed smoke cloud is stationary and only counts down.
    if (pr.deployed) {
      pr.life -= dt;
      if (pr.life <= 0) {
        game.events.push({ k: 'smokeend', projectileId: pr.id, x: pr.pos[0], z: pr.pos[2] });
        game.projectiles.splice(i, 1);
      }
      continue;
    }

    // Both frag and smoke projectiles fly and bounce until their fuse expires.
    moveProjectile(game.world, pr, dt);
    if (pr.fuse <= 0) {
      if (pr.type === 'smoke') {
        pr.deployed = true;
        pr.vel = [0, 0, 0];
        pr.life = CFG.SMOKE.duration;
        pr.fuse = 0;
        game.events.push({ k: 'smokestart', projectileId: pr.id, x: pr.pos[0], y: pr.pos[1], z: pr.pos[2] });
      } else {
        explode(game, pr.pos, G.dmg, G.radius, pr.owner, pr.id);
        game.projectiles.splice(i, 1);
      }
    }
  }
}

export function explode(game, pos, dmg, radius, owner, projectileId = null, weapon = 'grenade') {
  game.events.push({ k: 'boom', projectileId, w: weapon, x: pos[0], y: pos[1], z: pos[2], r: radius });
  for (const v of game.vehicles || []) {
    const distance = Math.hypot(...pos.map((n, i) => n - v.pos[i]));
    if (distance < radius) game.damageVehicle(v, dmg * (CFG.WEAPONS[weapon]?.rocket?.vehicleScale || 1.5) * (1 - distance / radius), owner);
  }
  // Blast damage to destructible props.
  const boxes = game.world.queryBoxes(pos[0] - radius, pos[2] - radius, pos[0] + radius, pos[2] + radius);
  for (const b of boxes) {
    if (!b.dynamic || b.destroyed) continue;
    const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    const d = Math.hypot(cx - pos[0], cy - pos[1], cz - pos[2]);
    if (d > radius) continue;
    b.hp -= dmg * (1 - d / radius);
    if (b.hp <= 0) {
      b.destroyed = true;
      game.destroyedBoxes.add(b.id);
      game.events.push({
        k: 'destroy', id: b.id, kind: b.kind || b.tag, x: cx, y: b.min[1], z: cz,
        sx: +(b.max[0] - b.min[0]).toFixed(2), sy: +(b.max[1] - b.min[1]).toFixed(2),
        sz: +(b.max[2] - b.min[2]).toFixed(2), mat: b.mat,
      });
    }
  }
  for (const p of game.players.values()) {
    if (!p.alive) continue;
    const chest = [p.pos[0], p.pos[1] + p.height() * 0.55, p.pos[2]];
    const d = Math.hypot(chest[0] - pos[0], chest[1] - pos[1], chest[2] - pos[2]);
    if (d > radius) continue;
    let f = 1 - d / radius;
    f = f * f;
    // line of sight reduces blast
    if (!game.world.lineOfSight(pos, chest, 0.2)) f *= 0.35;
    const amount = dmg * f;
    if (amount > 1) applyDamage(game, p, amount, owner, 'explosion', chest, weapon, d);
  }
}

// ---------------------------------------------------------------------------
// Loot
// ---------------------------------------------------------------------------
export function rollLoot(game, tier = 1) {
  const rng = game.rng;
  const r = rng.next();
  // Higher tier shifts the distribution toward better guns.
  const weaponPool = tier >= 3
    ? ['ar', 'ar', 'dmr', 'sniper', 'lmg', 'shotgun', 'smg', 'rpg']
    : tier === 2
      ? ['ar', 'smg', 'shotgun', 'dmr', 'pistol', 'ar', 'smg']
      : ['pistol', 'smg', 'shotgun', 'ar', 'pistol'];
  if (r < 0.30) {
    const w = rng.pick(weaponPool);
    const W = CFG.WEAPONS[w];
    return { type: 'weapon', weapon: w, mag: W.mag, reserve: Math.round(W.reserve * 0.5) };
  }
  if (r < 0.58) {
    const w = rng.pick(weaponPool);
    const W = CFG.WEAPONS[w];
    return { type: 'ammo', weapon: w, amount: CFG.INVENTORY.ammoPerPickup[w] };
  }
  if (r < 0.72) return { type: 'armor', amount: tier >= 3 ? 75 : tier === 2 ? 50 : 30 };
  if (r < 0.86) return { type: 'med', sub: rng.chance(tier >= 2 ? 0.4 : 0.15) ? 'medkit' : 'bandage', amount: 1 };
  if (r < 0.94) return { type: 'grenade', sub: rng.chance(0.75) ? 'frag' : 'smoke', amount: 1 };
  return { type: 'med', sub: 'bandage', amount: 1 };
}

export function spawnWorldLoot(game) {
  for (const s of game.world.lootSpawns) {
    if (game.rng.next() < 0.18) continue;
    const item = rollLoot(game, s.tier);
    game.loot.push({
      id: game.nextId++, ...item,
      x: s.x, y: s.y, z: s.z, rot: game.rng.next() * TAU,
    });
  }
}

export function lootInReach(world, feet, eyeHeight, item) {
  if (Math.hypot(item.x - feet[0], item.y - feet[1], item.z - feet[2]) > CFG.LOOT.pickupRange) return false;
  return world.lineOfSight([feet[0], feet[1] + eyeHeight, feet[2]], [item.x, item.y + .18, item.z], .18);
}

export function canPickupLoot(player, item) {
  if (item.type === 'weapon') return !!CFG.WEAPONS[item.weapon];
  if (item.type === 'ammo') return player.weapons.includes(item.weapon);
  if (item.type === 'armor') return player.armor < item.amount;
  if (item.type === 'med') return (player.bandages || 0) + (player.medkits || 0) < 5;
  if (item.type === 'grenade') return item.sub === 'smoke' ? player.smokes < 3 : player.grenades < 4;
  return false;
}

export function tryInteract(game, p) {
  if (!p.alive) return false;
  if (p.inVehicle) return game.exitVehicle(p);
  // Nearest loot wins over a vehicle when it is closer to the player.
  let loot = null, lootD = CFG.LOOT.pickupRange;
  for (const it of game.loot) {
    const d = Math.hypot(it.x - p.pos[0], it.z - p.pos[2]);
    if (d < lootD && canPickupLoot(p, it) && lootInReach(game.world, p.pos, p.eyeHeight(), it)) { lootD = d; loot = it; }
  }
  let vehicle = null, vehD = CFG.VEHICLE.enterRange;
  for (const v of game.vehicles) {
    const d = Math.hypot(v.pos[0] - p.pos[0], v.pos[2] - p.pos[2]);
    if (d < vehD && vehicleInReach(game.world, p.pos, p.eyeHeight(), v)) { vehD = d; vehicle = v; }
  }
  if (loot && (!vehicle || lootD <= vehD) && pickupLoot(game, p, loot)) return true;
  if (vehicle && game.enterVehicle(p, vehicle)) return true;
  if (loot) return pickupLoot(game, p, loot);
  return false;
}

export function pickupLoot(game, p, item) {
  if (!p.alive || !game.loot.includes(item) || !canPickupLoot(p, item)) return false;
  if (item.type === 'weapon') {
    const W = CFG.WEAPONS[item.weapon];
    if (p.weapons.includes(item.weapon)) {
      // Inventory is keyed by weapon class. A second slot with the same key
      // would alias/overwrite its magazine; an owned weapon supplies spare ammo.
      p.inv[item.weapon].reserve += (item.mag ?? W.mag) + (item.reserve ?? 0);
    } else {
      // Prefer an empty slot, else replace current.
      const slot = p.weapons[0] ? (p.weapons[1] ? p.curSlot : 1) : 0;
      if (p.weapons[slot]) {
        const old = p.weapons[slot];
        const oldInv = p.inv[old];
        game.loot.push({ id: game.nextId++, type: 'weapon', weapon: old, mag: oldInv.mag, reserve: oldInv.reserve, x: p.pos[0] + 0.5, y: p.pos[1] + 0.1, z: p.pos[2] + 0.5, rot: game.rng.next() * TAU });
        delete p.inv[old];
      }
      p.weapons[slot] = item.weapon;
      p.inv[item.weapon] = { mag: item.mag ?? W.mag, reserve: item.reserve ?? Math.round(W.reserve * 0.5) };
      p.curSlot = slot;
      p.switchT = W.switchTime;
      p.reloadT = 0; p.reloadKey = null;
      p.healT = 0; p.healItem = null;
    }
  } else if (item.type === 'ammo') {
    let added = false;
    for (const w of p.weapons) {
      if (w === item.weapon && p.inv[w]) { p.inv[w].reserve += item.amount; added = true; }
    }
    if (!added) return false;
  } else if (item.type === 'armor') {
    // Armour plates replace lower-tier armour; never downgrade.
    if (p.armor >= item.amount) return false;
    p.armor = item.amount;
  } else if (item.type === 'med') {
    if (p.bandages + p.medkits >= 5) return false;
    if (item.sub === 'medkit') p.medkits++; else p.bandages++;
  } else if (item.type === 'grenade') {
    if (item.sub === 'smoke') { if (p.smokes >= 3) return false; p.smokes++; }
    else { if (p.grenades >= 4) return false; p.grenades++; }
  }
  const idx = game.loot.indexOf(item);
  if (idx >= 0) game.loot.splice(idx, 1);
  game.events.push({ k: 'pickup', id: p.id, lootId: item.id, item: item.type, sub: item.sub || item.weapon || null,
    weapons: p.weapons.slice(), slot: p.curSlot, x: item.x, y: item.y, z: item.z });
  return true;
}

export function dropInventory(game, p) {
  for (let i = 0; i < 2; i++) {
    const w = p.weapons[i];
    if (!w) continue;
    const inv = p.inv[w];
    game.loot.push({
      id: game.nextId++, type: 'weapon', weapon: w, mag: inv.mag, reserve: inv.reserve,
      x: p.pos[0] + (i ? 0.7 : -0.7), y: p.pos[1] + 0.1, z: p.pos[2] + 0.4, rot: game.rng.next() * TAU,
    });
  }
}
