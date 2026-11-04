import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, STANCE } from '../shared/config.js';
import { hitboxesFor, solveBallistic, tryFire, applyDamage, tryReload, finishReload } from '../shared/weapons.js';
import { emptyInput } from '../shared/sim.js';
import { damp, spreadDirection } from '../shared/math.js';

const openWorld = { raycast: () => null, terrainHeight: () => 0 };

function target(x, z, y = 0, stance = STANCE.STAND) {
  const height = stance === STANCE.PRONE ? CFG.PLAYER.PRONE_HEIGHT :
    stance === STANCE.CROUCH ? CFG.PLAYER.CROUCH_HEIGHT : CFG.PLAYER.HEIGHT;
  return { id: 2, pos: [x, y, z], height, stance, alive: true, team: 0, hitboxes: hitboxesFor([x, y, z], height, stance) };
}

test('hitboxes cover head, torso and legs with correct zones', () => {
  const hb = hitboxesFor([0, 0, 0], CFG.PLAYER.HEIGHT, STANCE.STAND);
  assert.equal(hb.head.zone, 'head');
  assert.equal(hb.torso.zone, 'torso');
  assert.equal(hb.legs.zone, 'legs');
  assert.ok(hb.head.base[1] + hb.head.r > hb.torso.b[1], 'head above the torso');
  assert.ok(hb.legs.a[1] < hb.torso.a[1], 'legs below torso');
});

test('a flat shot at 20 m hits the torso', () => {
  const t = target(0, -20);
  const res = solveBallistic(openWorld, [0, 1.5, 0], [0, 0, -1], CFG.WEAPONS.ar, [t], 1, 0, 'br');
  assert.ok(res.hit, 'expected a hit');
  assert.equal(res.hit.targetId, 2);
  assert.equal(res.hit.zone, 'torso');
  assert.ok(Math.abs(res.hit.dist - 20) < 1.5, `distance ${res.hit.dist}`);
  assert.ok(Math.abs(res.hit.damage - CFG.WEAPONS.ar.dmg) < 1e-6);
});

test('headshots apply the weapon head multiplier', () => {
  const t = target(0, -20);
  const headY = t.hitboxes.head.base[1] + t.hitboxes.head.r;
  const res = solveBallistic(openWorld, [0, headY, 0], [0, 0, -1], CFG.WEAPONS.ar, [t], 1, 0, 'br');
  assert.ok(res.hit, 'expected a head hit');
  assert.equal(res.hit.zone, 'head');
  assert.ok(res.hit.damage > CFG.WEAPONS.ar.dmg, `headshot ${res.hit.damage}`);
});

test('teammates are ignored in TDM and the shooter cannot hit themselves', () => {
  const t = target(0, -20);
  t.team = 0;
  const res = solveBallistic(openWorld, [0, 1.5, 0], [0, 0, -1], CFG.WEAPONS.ar, [t], 1, 0, 'tdm');
  assert.equal(res.hit, null);
  const self = target(0, -20);
  const res2 = solveBallistic(openWorld, [0, 1.5, 0], [0, 0, -1], CFG.WEAPONS.ar, [self], 2, 0, 'br');
  assert.equal(res2.hit, null);
});

test('bullets have travel time and drop over distance', () => {
  const res = solveBallistic(openWorld, [0, 1.5, 0], [0, 0, -1], CFG.WEAPONS.pistol, [], 1, 0, 'br', 2.2);
  assert.ok(res.time > 0.1, `travel time ${res.time}`);
  assert.ok(res.travel > 50, `distance ${res.travel}`);
  const end = res.segments[res.segments.length - 1];
  assert.ok(end[1] < 1.5 - 0.5, `bullet should drop, end y ${end[1]}`);
});

test('damage falls off with distance', () => {
  const near = solveBallistic(openWorld, [0, 0.9, 0], [0, 0, -1], CFG.WEAPONS.ar, [target(0, -20)], 1, 0, 'br');
  const far = solveBallistic(openWorld, [0, 0.9, 0], [0, 0, -1], CFG.WEAPONS.ar, [target(0, -60)], 1, 0, 'br');
  assert.ok(near.hit && far.hit);
  assert.ok(far.hit.damage < near.hit.damage, `${far.hit.damage} !< ${near.hit.damage}`);
  const W = CFG.WEAPONS.ar;
  const [fs, fe, fm] = W.falloff;
  const expected = W.dmg * (1 - (60 - fs) / (fe - fs));
  assert.ok(Math.abs(far.hit.damage - expected) < 1, `falloff ${far.hit.damage} vs ${expected}`);
});

test('thin wood is penetrated, thick concrete is not', () => {
  let calls = 0;
  const thinWorld = {
    raycast: () => (calls++ === 0
      ? { t: 2, tmax: 2.04, point: [0, 1.5, -2], normal: [0, 0, 1], box: {}, tag: 'wall', mat: 'wood' }
      : null),
    terrainHeight: () => 0,
  };
  const res = solveBallistic(thinWorld, [0, 1.5, 0], [0, 0, -1], CFG.WEAPONS.ar, [], 1, 0, 'br', 0.2);
  assert.equal(res.impacts.length, 1);
  assert.ok(res.segments.length > 2, 'tracer should continue past the thin wall');
  assert.ok(res.travel > 2.5, `travel ${res.travel}`);

  let calls2 = 0;
  const thickWorld = {
    raycast: () => (calls2++ === 0
      ? { t: 2, tmax: 2.6, point: [0, 1.5, -2], normal: [0, 0, 1], box: {}, tag: 'wall', mat: 'concrete' }
      : null),
    terrainHeight: () => 0,
  };
  const res2 = solveBallistic(thickWorld, [0, 1.5, 0], [0, 0, -1], CFG.WEAPONS.ar, [], 1, 0, 'br', 0.2);
  assert.ok(res2.travel < 2.5, `thick wall should stop the bullet, travel ${res2.travel}`);
});

test('armour absorbs part of the damage until depleted', () => {
  const victim = { alive: true, health: 100, armor: 50, pos: [0, 0, 0], id: 2, damageTaken: 0 };
  const game = { time: 0, events: [], kill() { throw new Error('should not die'); } };
  applyDamage(game, victim, 40, 1, 'torso', [0, 1, 0], 'ar', 10);
  const absorbed = 40 * CFG.ARMOR.absorb;
  assert.ok(Math.abs(victim.armor - (50 - absorbed)) < 1e-9);
  assert.ok(Math.abs(victim.health - (100 - (40 - absorbed))) < 1e-9);
  assert.equal(game.events[0].k, 'hit');
});

test('lethal damage triggers a kill exactly once', () => {
  let kills = 0;
  const victim = { alive: true, health: 5, armor: 0, pos: [0, 0, 0], id: 2, damageTaken: 0 };
  const game = {
    time: 1, events: [],
    kill() { kills++; victim.alive = false; },
  };
  applyDamage(game, victim, 50, 1, 'torso', null, 'ar', 5);
  applyDamage(game, victim, 50, 1, 'torso', null, 'ar', 5);
  assert.equal(kills, 1);
});

test('reload moves rounds from reserve into the magazine', () => {
  const p = {
    id: 1, weapons: ['ar', null], curSlot: 0,
    inv: { ar: { mag: 4, reserve: 60 } }, reloadT: 0, switchT: 0, reloadKey: null, healT: 0,
  };
  const game = { events: [] };
  assert.equal(tryReload(game, p), true);
  assert.ok(p.reloadT > 0);
  finishReload(p);
  assert.equal(p.inv.ar.mag, CFG.WEAPONS.ar.mag);
  assert.equal(p.inv.ar.reserve, 60 - (CFG.WEAPONS.ar.mag - 4));
  assert.equal(p.reloadT, 0);
});

test('firing consumes ammo, sets cooldown and emits a shot event', () => {
  const p = {
    id: 1, pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0, team: 0,
    alive: true, reloadT: 0, cooldown: 0, switchT: 0, heat: 0, healT: 0,
    grounded: true, adsing: false, stance: STANCE.STAND, inWater: false,
    weapons: ['ar', null], curSlot: 0, inv: { ar: { mag: 30, reserve: 120 } },
    eyeHeight: () => 1.64, shotsFired: 0, prevShoot: false,
  };
  const game = { world: openWorld, rng: { next: () => 0.5 }, events: [], pendingDamage: [], time: 0, mode: 'br', players: new Map([[1, p]]) };
  const input = emptyInput();
  input.shoot = true;
  assert.equal(tryFire(game, p, input, [], { rng: game.rng }), true);
  assert.equal(p.inv.ar.mag, 29);
  assert.ok(p.cooldown > 0);
  const shot = game.events.find(e => e.k === 'shot');
  assert.ok(shot);
  assert.equal(shot.w, 'ar');
  assert.equal(shot.e.length, 1);
  // Cooldown blocks an immediate second shot.
  assert.equal(tryFire(game, p, input, [], { rng: game.rng }), false);
});

// ---------------------------------------------------------------------------
// Data-driven weapon balance regressions.
//
// These tests derive everything from CFG.WEAPONS, so tuning changes are checked
// against class roles rather than against hard-coded per-weapon numbers. Aimed
// shots compensate for gravity drop at each range; the shotgun is sampled over
// its pellet cone because a single pellet does not represent a blast.
// ---------------------------------------------------------------------------

function ttkTarget(dist) {
  const height = CFG.PLAYER.HEIGHT;
  return {
    id: 2, pos: [0, 0, -dist], height, stance: STANCE.STAND,
    alive: true, team: 0, hitboxes: hitboxesFor([0, 0, -dist], height, STANCE.STAND),
  };
}

function aimAt(target, dist, W) {
  const origin = [0, 1.5, 0];
  const torsoY = (target.hitboxes.torso.a[1] + target.hitboxes.torso.b[1]) / 2;
  const flight = dist / W.mv;
  const drop = 0.5 * 9.81 * (W.grav ?? 1) * flight * flight;
  const aim = [0, torsoY + drop, -dist];
  const d = [aim[0] - origin[0], aim[1] - origin[1], aim[2] - origin[2]];
  const len = Math.hypot(...d);
  return { origin, dir: d.map(v => v / len) };
}

function damagePerShot(W, dist, samples = 128, central = false) {
  const target = ttkTarget(dist);
  const { origin, dir } = aimAt(target, dist, W);
  if (W.pellets === 1 || central) {
    const res = solveBallistic(openWorld, origin, dir, W, [target], 1, 0, 'br');
    return res.hit ? res.hit.damage : 0;
  }
  let seed = 12345;
  const rng = {
    next() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    },
  };
  let total = 0;
  for (let s = 0; s < samples; s++) {
    let damage = 0;
    for (let i = 0; i < W.pellets; i++) {
      const pelletDir = spreadDirection(dir, W.spreadAds, rng);
      const res = solveBallistic(openWorld, origin, pelletDir, W, [target], 1, 0, 'br');
      if (res.hit) damage += res.hit.damage;
    }
    total += damage;
  }
  return total / samples;
}

function ttkSeconds(W, dist) {
  const perShot = damagePerShot(W, dist);
  const shots = Math.max(1, Math.ceil(CFG.PLAYER.MAX_HEALTH / perShot));
  return (shots - 1) * (60 / W.rpm);
}

test('TTK at 10/30/60 m follows the class roles in the weapon table', () => {
  const ranges = [10, 30, 60];
  const ttk = {};
  for (const key of CFG.WEAPON_ORDER) {
    const W = CFG.WEAPONS[key];
    if (W.projectile) continue; // live explosive flight has separate impact/radius tests
    ttk[key] = ranges.map(dist => ttkSeconds(W, dist));
    for (let i = 1; i < ttk[key].length; i++) {
      assert.ok(ttk[key][i] >= ttk[key][i - 1] - 1e-9,
        `${key} TTK must not improve with distance: ${ttk[key].join(', ')}`);
    }
    // Every class can secure a kill inside one second at close range.
    assert.ok(ttk[key][0] <= 1.0, `${key} close-range TTK ${ttk[key][0].toFixed(2)}s`);
  }

  // Precision and sustained-fire classes stay competitive at 60 m.
  for (const key of ['ar', 'dmr', 'sniper', 'lmg']) {
    assert.ok(ttk[key][2] <= 0.5, `${key} 60 m TTK ${ttk[key][2].toFixed(2)}s`);
  }
  // Pistol and SMG trade long-range lethality for close-range handling.
  for (const key of ['pistol', 'smg']) {
    assert.ok(ttk[key][2] >= 0.5, `${key} should degrade at 60 m, got ${ttk[key][2].toFixed(2)}s`);
    assert.ok(ttk[key][2] > ttk[key][0], `${key} should be slower at 60 m than 10 m`);
  }
  // The shotgun is a one-blast-range weapon: devastating up close, useless far.
  assert.ok(ttk.shotgun[0] <= 1.0, `shotgun 10 m TTK ${ttk.shotgun[0].toFixed(2)}s`);
  assert.ok(ttk.shotgun[1] >= 4.0, `shotgun 30 m TTK ${ttk.shotgun[1].toFixed(2)}s`);
  assert.ok(ttk.shotgun[2] >= 10.0, `shotgun 60 m TTK ${ttk.shotgun[2].toFixed(2)}s`);

  // The sniper is the only class that one-shots a full-health torso at range.
  for (const dist of ranges) {
    assert.ok(damagePerShot(CFG.WEAPONS.sniper, dist) >= CFG.PLAYER.MAX_HEALTH,
      `sniper should one-shot at ${dist} m`);
    assert.ok(damagePerShot(CFG.WEAPONS.dmr, dist) < CFG.PLAYER.MAX_HEALTH,
      `DMR should need a follow-up at ${dist} m`);
  }
});

test('recoil recovery returns to rest and heavier weapons recover slower', () => {
  const dt = 1 / 60;
  function recover(W, shots) {
    let pitch = 0;
    for (let i = 0; i < shots; i++) pitch = Math.min(0.5, pitch + W.recoilPitch);
    let t = 0;
    while (pitch > 0.002 && t < 5) {
      pitch = damp(pitch, 0, W.recoilRecover, dt);
      t += dt;
    }
    return t;
  }
  for (const key of CFG.WEAPON_ORDER) {
    const W = CFG.WEAPONS[key];
    assert.ok(W.recoilPitch > 0 && W.recoilYaw > 0, `${key} needs recoil kick`);
    assert.ok(W.recoilRecover > 0, `${key} needs recoil recovery`);
    assert.ok(recover(W, 1) < 1.0, `${key} single-shot recovery ${recover(W, 1).toFixed(2)}s`);
    assert.ok(recover(W, 10) < 1.5, `${key} burst recovery ${recover(W, 10).toFixed(2)}s`);
  }
  // Light, low-recoil weapons settle faster than heavy precision weapons.
  assert.ok(recover(CFG.WEAPONS.pistol, 1) < recover(CFG.WEAPONS.sniper, 1));
  assert.ok(recover(CFG.WEAPONS.lmg, 1) < recover(CFG.WEAPONS.shotgun, 1));
  assert.ok(CFG.WEAPONS.sniper.recoilPitch > CFG.WEAPONS.smg.recoilPitch);
  assert.ok(CFG.WEAPONS.shotgun.recoilPitch > CFG.WEAPONS.dmr.recoilPitch * 0.5);
});

test('damage falloff is monotonic and clamps to its configured floor', () => {
  const ranges = [5, 10, 20, 30, 45, 60, 80, 120];
  for (const key of CFG.WEAPON_ORDER) {
    const W = CFG.WEAPONS[key];
    if (W.projectile) continue;
    const [start, end, floorMult] = W.falloff;
    assert.ok(start > 0 && end > start, `${key} falloff range`);
    assert.ok(floorMult > 0 && floorMult < 1, `${key} falloff floor`);
    const damages = ranges.map(dist => damagePerShot(W, dist, 128, true));
    for (let i = 0; i < damages.length; i++) {
      assert.ok(damages[i] > 0, `${key} must hit at ${ranges[i]} m`);
      if (i > 0) assert.ok(damages[i] <= damages[i - 1] + 1e-9,
        `${key} damage rose with distance at ${ranges[i]} m`);
      if (ranges[i] <= start) assert.ok(Math.abs(damages[i] - W.dmg) < 1e-9,
        `${key} should deal full damage before falloff starts`);
    }
    if (ranges[ranges.length - 1] >= end) {
      assert.ok(Math.abs(damages[damages.length - 1] - W.dmg * floorMult) < 1e-6,
        `${key} should reach its falloff floor by 120 m`);
    }
  }
});

function wallWorld(thickness, mat) {
  let calls = 0;
  return {
    raycast: () => (calls++ === 0
      ? { t: 2, tmax: 2 + thickness, point: [0, 1.5, -2], normal: [0, 0, 1], box: {}, tag: 'wall', mat }
      : null),
    terrainHeight: () => 0,
  };
}

function shootThrough(W, thickness, mat) {
  return solveBallistic(wallWorld(thickness, mat), [0, 1.5, 0], [0, 0, -1], W, [], 1, 0, 'br', 0.5);
}

test('penetration threshold matches weapon data and material toughness', () => {
  for (const key of CFG.WEAPON_ORDER) {
    const W = CFG.WEAPONS[key];
    if (W.projectile) continue;
    assert.ok(W.penetration > 0, `${key} penetration`);
    const under = shootThrough(W, W.penetration * 0.9, 'concrete');
    assert.ok(under.travel > 2.1, `${key} should penetrate ${(W.penetration * 0.9).toFixed(3)} m of concrete`);
    const over = shootThrough(W, W.penetration * 1.1, 'concrete');
    assert.ok(over.travel <= 2.1, `${key} should be stopped by ${(W.penetration * 1.1).toFixed(3)} m of concrete`);
  }
  // Penetration power is ordered from close-range to precision classes.
  const order = ['shotgun', 'pistol', 'smg', 'ar', 'lmg', 'dmr', 'sniper'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(CFG.WEAPONS[order[i]].penetration >= CFG.WEAPONS[order[i - 1]].penetration,
      `${order[i]} should penetrate at least as well as ${order[i - 1]}`);
  }
  // Wood is softer than concrete: the AR punches through wood it cannot punch
  // through concrete.
  const ar = CFG.WEAPONS.ar;
  const woodThickness = ar.penetration * 1.5;
  assert.ok(shootThrough(ar, woodThickness, 'wood').travel > 2.1, 'AR should penetrate wood');
  assert.ok(shootThrough(ar, woodThickness, 'concrete').travel <= 2.1, 'AR should not penetrate the same concrete');
});

test('every weapon reloads, fires and dry-fires according to its data', () => {
  for (const key of CFG.WEAPON_ORDER) {
    const W = CFG.WEAPONS[key];
    assert.ok(W.mag > 0 && W.reserve > 0 && W.reload > 0, `${key} ammo/reload data`);

    const game = { events: [] };
    const p = {
      id: 1, weapons: [key, null], curSlot: 0, inv: { [key]: { mag: 0, reserve: W.reserve } },
      reloadT: 0, switchT: 0, reloadKey: null, healT: 0,
    };
    assert.equal(tryReload(game, p), true, `${key} should start a reload`);
    assert.equal(p.reloadT, W.reload);
    finishReload(p);
    assert.equal(p.inv[key].mag, Math.min(W.mag, W.reserve), `${key} magazine fill`);
    assert.equal(p.inv[key].reserve, Math.max(0, W.reserve - W.mag), `${key} reserve spend`);

    // A partial reserve only moves the rounds that exist.
    const partial = {
      id: 1, weapons: [key, null], curSlot: 0, inv: { [key]: { mag: Math.max(0, W.mag - 3), reserve: 2 } },
      reloadT: 0, switchT: 0, reloadKey: null, healT: 0,
    };
    const game2 = { events: [] };
    assert.equal(tryReload(game2, partial), true);
    finishReload(partial);
    const taken = Math.min(W.mag, 3, 2);
    assert.equal(partial.inv[key].mag, Math.max(0, W.mag - 3) + taken);
    assert.equal(partial.inv[key].reserve, 2 - taken);

    // Full magazines and empty reserves cannot start a reload.
    const full = {
      id: 1, weapons: [key, null], curSlot: 0, inv: { [key]: { mag: W.mag, reserve: 5 } },
      reloadT: 0, switchT: 0, reloadKey: null, healT: 0,
    };
    assert.equal(tryReload({ events: [] }, full), false, `${key} full magazine`);
    const emptyReserve = {
      id: 1, weapons: [key, null], curSlot: 0, inv: { [key]: { mag: 0, reserve: 0 } },
      reloadT: 0, switchT: 0, reloadKey: null, healT: 0,
    };
    assert.equal(tryReload({ events: [] }, emptyReserve), false, `${key} empty reserve`);

    // Firing spends one round, sets the per-weapon cadence and emits one tracer
    // per pellet.
    const shooter = {
      id: 1, pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0, team: 0,
      alive: true, reloadT: 0, cooldown: 0, switchT: 0, heat: 0, healT: 0,
      grounded: true, adsing: false, stance: STANCE.STAND, inWater: false,
      weapons: [key, null], curSlot: 0, inv: { [key]: { mag: W.mag, reserve: W.reserve } },
      eyeHeight: () => 1.64, shotsFired: 0, prevShoot: false,
    };
    const fireGame = {
      world: openWorld, rng: { next: () => 0.5 }, events: [], pendingDamage: [], projectiles: [],
      time: 0, mode: 'br', players: new Map([[1, shooter]]),
    };
    const input = emptyInput();
    input.shoot = true;
    assert.equal(tryFire(fireGame, shooter, input, [], { rng: fireGame.rng }), true, `${key} fires`);
    assert.equal(shooter.inv[key].mag, W.mag - 1, `${key} ammo spend`);
    assert.ok(Math.abs(shooter.cooldown - 60 / W.rpm) < 1e-9, `${key} cadence`);
    const shot = fireGame.events.find(e => e.k === (W.projectile ? 'launch' : 'shot'));
    assert.ok(shot, `${key} shot event`);
    assert.equal(shot.w, key);
    if (W.projectile) assert.equal(fireGame.projectiles.length, 1);
    else assert.equal(shot.e.length, W.pellets, `${key} tracer count`);

    // Dry fire is a distinct, visible failure that still costs a short cooldown.
    shooter.inv[key].mag = 0;
    shooter.cooldown = 0;
    const before = fireGame.events.length;
    assert.equal(tryFire(fireGame, shooter, input, [], { rng: fireGame.rng }), false);
    assert.equal(fireGame.events.length, before + 1);
    assert.equal(fireGame.events[fireGame.events.length - 1].k, 'dry');
    assert.equal(fireGame.events[fireGame.events.length - 1].w, key);
  }
});
