// Phase 4 rendering regressions: culling tiers, settled death poses, scratch
// reuse in animation/effects, loot pooling keys and the quality ladder.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  characterDetail, CHARACTER_DETAIL_DISTANCE, CHARACTER_CULL_DISTANCE,
} from '../src/render/entities.js';
import { lootPoolKey, glassCellKey, ArchetypePool } from '../src/render/world.js';
import { Effects } from '../src/render/effects.js';
import { DeathAnimation } from '../src/render/death-animation.js';
import { reloadMotion, boltMotion } from '../src/render/animation.js';
import { poseWeaponMechanics } from '../src/render/weapon-model.js';
import { normalizeQuality, qualityPreset, QUALITY_NAMES } from '../src/settings.js';
import { STANCE } from '../shared/config.js';

test('character presentation tiers cut off at the documented distances', () => {
  assert.equal(characterDetail(0), 'full');
  assert.equal(characterDetail(CHARACTER_DETAIL_DISTANCE), 'full');
  assert.equal(characterDetail(CHARACTER_DETAIL_DISTANCE + .01), 'basic');
  assert.equal(characterDetail(CHARACTER_CULL_DISTANCE), 'basic');
  assert.equal(characterDetail(CHARACTER_CULL_DISTANCE + .01), 'hidden');
  assert.equal(characterDetail(Infinity), 'hidden');
  assert.equal(characterDetail(null), 'full', 'unknown distance keeps the historical full path');
  assert.equal(characterDetail(NaN), 'full');
  assert.ok(CHARACTER_DETAIL_DISTANCE < CHARACTER_CULL_DISTANCE);
});

test('loot pool keys separate weapon identities and item subtypes', () => {
  assert.equal(lootPoolKey({ type: 'weapon', weapon: 'ar' }), 'weapon:ar');
  assert.equal(lootPoolKey({ type: 'weapon', weapon: 'sniper' }), 'weapon:sniper');
  assert.equal(lootPoolKey({ type: 'weapon' }), 'weapon:ar', 'missing weapon falls back to the default model');
  assert.equal(lootPoolKey({ type: 'ammo', sub: 'ar' }), 'ammo:ar');
  assert.equal(lootPoolKey({ type: 'heal' }), 'heal:');
  assert.notEqual(lootPoolKey({ type: 'weapon', weapon: 'ar' }), lootPoolKey({ type: 'ammo', sub: 'ar' }));
});

test('quality presets are a monotonic ladder and reject unknown values', () => {
  const low = qualityPreset('low'), medium = qualityPreset('medium'), high = qualityPreset('high');
  assert.ok(low.pixelRatio <= medium.pixelRatio && medium.pixelRatio <= high.pixelRatio);
  assert.ok(low.shadowMap <= medium.shadowMap && medium.shadowMap <= high.shadowMap);
  assert.ok(low.cascades <= medium.cascades && medium.cascades <= high.cascades);
  assert.ok(low.viewDistance <= medium.viewDistance && medium.viewDistance <= high.viewDistance);
  assert.ok(low.fogDensity >= medium.fogDensity && medium.fogDensity >= high.fogDensity, 'fog thins as distance grows');
  assert.equal(low.shadows, false);
  assert.equal(medium.shadows, true);
  assert.equal(normalizeQuality('ultra'), 'high');
  assert.equal(normalizeQuality(undefined), 'high');
  for (const name of QUALITY_NAMES) assert.equal(normalizeQuality(name), name);
  const copy = qualityPreset('low'); copy.viewDistance = 1;
  assert.equal(qualityPreset('low').viewDistance, low.viewDistance, 'preset objects must not be shared');
});

test('tracer records are recycled instead of allocated on every shot', () => {
  const effects = Object.create(Effects.prototype);
  effects.scene = new THREE.Scene();
  effects._initTracers();
  effects.tracer([0, 1, 0], [0, 1, -10]);
  const first = effects.tracerData[0];
  assert.ok(first);
  effects._updateTracers(2);
  effects._updateTracers(2);
  assert.equal(effects.tracerData[0], null);
  assert.equal(effects._tracerPool.length, 1);

  effects.tracer([0, 1, 0], [1, 1, -12]);
  assert.equal(effects.tracerData[1], first, 'the expired record must be reused');
  assert.equal(effects._tracerPool.length, 0);

  // Coordinate arrays are copied, not aliased to caller-owned arrays.
  const from = [0, 0, 0], to = [0, 0, -5];
  effects.tracer(from, to);
  const record = effects.tracerData[2];
  from[0] = 99; to[2] = 99;
  assert.deepEqual(record.from, [0, 0, 0]);
  assert.deepEqual(record.to, [0, 0, -5]);
  effects.tracers.geometry.dispose(); effects.tracers.material.dispose();
});

test('animation and weapon pose helpers reuse caller-owned scratch records', () => {
  const motion = reloadMotion(1.4, 2.2);
  const sameMotion = reloadMotion(1.4, 2.2, motion);
  assert.equal(sameMotion, motion);

  const bolt = boltMotion(.4);
  assert.equal(boltMotion(.4, bolt), bolt);
  assert.equal(boltMotion(Infinity, bolt), bolt);

  // Minimum rig fields the AR presentation branch touches. Creating the real
  // mesh needs a DOM canvas; this isolates the pose contract in Node.
  const model = {
    key: 'ar',
    gripRest: new THREE.Vector3(.1, .2, -.4),
    rightGrip: { position: new THREE.Vector3(.2, -.1, -.3) },
    magRest: new THREE.Vector3(0, 0, -.2),
    magazine: { position: new THREE.Vector3(), rotation: new THREE.Euler() },
    bolt: { position: new THREE.Vector3(), rotation: new THREE.Euler() },
    boltRestZ: -.1,
  };
  const out = { motion: {}, support: new THREE.Vector3(), trigger: new THREE.Vector3() };
  const result = poseWeaponMechanics(model, 1.4, 3, 24, out);
  assert.equal(result, out);
  assert.equal(result.motion, out.motion);
  assert.equal(result.support, out.support);
  assert.equal(result.trigger, out.trigger);
  poseWeaponMechanics(model, 1.1, 3.1, 23, out);
  assert.equal(result.support, out.support);
  assert.ok(result.support.toArray().every(Number.isFinite));
});

test('a settled death pose is not resampled or terrain-queried again', () => {
  const root = new THREE.Group(), hips = new THREE.Group(), torso = new THREE.Group(), head = new THREE.Group();
  root.add(hips); hips.position.y = .94; hips.add(torso); torso.add(head); head.position.y = .69;
  const legL = new THREE.Group(), legR = new THREE.Group(), kneeL = new THREE.Group(), kneeR = new THREE.Group();
  hips.add(legL, legR); legL.add(kneeL); legR.add(kneeR); kneeL.position.y = kneeR.position.y = -.42;
  const arms = [-1, 1].map(side => { const hand = new THREE.Object3D(); hand.position.set(side * .2, .2, -.3); return { hand }; });
  const model = { root, hips, torso, head, legL, legR, kneeL, kneeR, arms };
  const world = { raycast: () => null, terrainHeight: () => 0, queryBoxes: () => [] };
  const death = new DeathAnimation(model, world, [0, 0, 0],
    { yaw: .2, stance: STANCE.STAND, direction: [0, 0, 1] }, 3);
  death.update(1.5);
  assert.equal(death.settled, true);
  const age = death.age;
  let applied = 0;
  const original = death.applyPose.bind(death);
  death.applyPose = () => { applied++; return original(); };
  for (let i = 0; i < 10; i++) death.update(1 / 60);
  assert.equal(applied, 0, 'settled corpse must skip the mixer and terrain queries');
  assert.equal(death.age, age);

  death.advance(.5);
  assert.equal(death.age, death.duration);
  assert.equal(death.settled, true);
  death.dispose();
});

test('glass panes are binned into the merged renderer cells', () => {
  const box = (min, max) => ({ min, max });
  assert.equal(glassCellKey(box([-335, 5, 92], [-334, 6, 93])), '-3,0');
  assert.equal(glassCellKey(box([-1, 0, -1], [1, 1, 1])), '0,0', 'the cell comes from the pane centre');
  assert.equal(glassCellKey(box([159, 0, 159], [161, 1, 161])), '1,1');
  assert.equal(glassCellKey(box([0, 0, 0], [1, 1, 1]), 100), '0,0');
});

test('archetype destruction batches removals, skips no-ops and can restore', () => {
  const boxes = [1, 2, 3, 4].map(id => ({ id, min: [id, 0, 0], max: [id + 1, 1, 1] }));
  const instanced = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), boxes.length);
  const pool = new ArchetypePool('test', [instanced], boxes);
  assert.equal(pool.activeCount, 4);

  pool.syncDestruction(new Set());
  assert.equal(pool.activeCount, 4, 'an unchanged empty set keeps every instance');

  pool.syncDestruction(new Set([1]));
  assert.equal(pool.activeCount, 3);
  pool.syncDestruction(new Set([1, 3]));
  assert.equal(pool.activeCount, 2, 'added ids apply incrementally');
  const count = instanced.count;
  pool.syncDestruction(new Set([1, 3]));
  assert.equal(instanced.count, count, 'an unchanged set does not upload instance buffers');

  // Restoration needs the original order and brings the recovered prop back.
  pool.syncDestruction(new Set([3]));
  assert.equal(pool.activeCount, 3);
  assert.equal(pool.destroyedIds.has(1), false);

  pool.removeBoxes([2, 4]);
  assert.equal(pool.activeCount, 1);
  pool.removeBoxes([2, 4]);
  assert.equal(pool.activeCount, 1, 'batched removal is idempotent');
  instanced.geometry.dispose();
  instanced.material.dispose();
});

test('explosion debris and shockwaves reuse shared geometry', () => {
  const fx = Object.create(Effects.prototype);
  fx.scene = new THREE.Scene();
  fx.debris = [];
  fx.decalData = [];
  fx.puffs = [];
  fx._puffPool = [];
  fx.dustTexture = new THREE.Texture();
  fx._debrisGeometry = new THREE.BoxGeometry(1, 1, 1);
  fx._debrisMaterials = [new THREE.MeshBasicMaterial({ color: 0x8a643c })];
  fx.destroy({ id: 7, x: 0, y: 1, z: 0, sx: 2, sy: 2, sz: 2 });
  fx.destroy({ id: 8, x: 1, y: 1, z: 0, sx: 2, sy: 2, sz: 2 });
  assert.equal(fx.debris.length, 12);
  for (const d of fx.debris) {
    assert.equal(d.mesh.geometry, fx._debrisGeometry, 'debris must not allocate one box per chunk');
    assert.ok(fx._debrisMaterials.includes(d.mesh.material));
  }

  fx._shockPool = [];
  fx._shockGeometry = new THREE.RingGeometry(.74, 1, 40);
  const first = fx._acquireShock();
  const geometry = first.mesh.geometry;
  first.mesh.removeFromParent();
  fx._shockPool.push(first);
  const second = fx._acquireShock();
  assert.equal(second.mesh.geometry, geometry, 'shockwave rings are pooled');
  second.mesh.removeFromParent();
});
