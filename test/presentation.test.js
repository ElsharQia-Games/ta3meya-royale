import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DeathAnimation } from '../src/render/death-animation.js';
import { ReloadCues } from '../src/audio/samples.js';
import { STANCE } from '../shared/config.js';

function rig() {
  const root = new THREE.Group(), hips = new THREE.Group(), torso = new THREE.Group(), head = new THREE.Group();
  root.add(hips); hips.position.y = .94; hips.add(torso); torso.add(head); head.position.y = .69;
  const legL = new THREE.Group(), legR = new THREE.Group(), kneeL = new THREE.Group(), kneeR = new THREE.Group();
  hips.add(legL, legR); legL.add(kneeL); legR.add(kneeR); kneeL.position.y = kneeR.position.y = -.42;
  const arms = [-1, 1].map(side => { const hand = new THREE.Object3D(); hand.position.set(side * .2, .2, -.3); return { hand }; });
  return { root, hips, torso, head, legL, legR, kneeL, kneeR, arms };
}

test('death mixer folds joints over time, reaches the floor and releases bindings for respawn', () => {
  const model = rig();
  const world = { raycast: () => null, terrainHeight: () => 0, queryBoxes: () => [] };
  const death = new DeathAnimation(model, world, [0, 0, 0], { yaw: .3, stance: STANCE.STAND, direction: [0, 0, 1] }, 1);
  death.update(.4);
  assert.ok(model.hips.position.y < .8);
  assert.ok(model.kneeL.quaternion.angleTo(new THREE.Quaternion()) > .4);
  death.update(1.2); model.root.updateWorldMatrix(true, true);
  assert.ok(model.head.getWorldPosition(new THREE.Vector3()).y < .65);
  for (let i = 0; i < 20; i++) death.update(.05);
  model.root.updateWorldMatrix(true, true);
  assert.ok(model.head.getWorldPosition(new THREE.Vector3()).y < .65, 'settled body must stay down on subsequent render frames');
  for (const node of [model.hips, model.head, model.kneeL, model.kneeR]) {
    assert.ok(node.getWorldPosition(new THREE.Vector3()).y >= .125);
    assert.ok(node.quaternion.toArray().every(Number.isFinite));
  }
  death.dispose();
  assert.equal(death.mixer.stats.actions.inUse, 0);
  assert.ok(Math.abs(model.hips.position.y - .94) < .001, 'respawn must restore the pre-collapse pose');
});

test('prone death never raises the hips to a standing pose', () => {
  const model = rig(); model.hips.position.set(0, .34, .66); model.torso.rotation.x = -1.28;
  const death = new DeathAnimation(model, null, [0, 0, 0], { stance: STANCE.PRONE }, 2);
  for (let i = 0; i < 30; i++) { death.update(.05); assert.ok(model.hips.position.y <= .35); }
  death.dispose();
});

test('reload Foley follows phase crossings once and cancels on death or a weapon switch', () => {
  const cues = new ReloadCues();
  assert.deepEqual(cues.step('ar', 2.2, 2.2), []);
  assert.deepEqual(cues.step('ar', 1.9, 2.2), ['mag-out']);
  assert.deepEqual(cues.step('ar', 1.85, 2.2), []);
  assert.deepEqual(cues.step('ar', .8, 2.2), ['mag-in']);
  assert.deepEqual(cues.step('ar', .4, 2.2, false), []);
  assert.deepEqual(cues.step('pistol', 0, 1.65), []);
  assert.deepEqual(cues.step('rpg', 3.2, 3.6), ['mag-out']);
});
