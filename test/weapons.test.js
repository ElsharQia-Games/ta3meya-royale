import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, STANCE } from '../shared/config.js';
import { hitboxesFor, solveBallistic, tryFire, applyDamage, tryReload, finishReload } from '../shared/weapons.js';
import { emptyInput } from '../shared/sim.js';

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
