import test from 'node:test';
import assert from 'node:assert/strict';
import { solveTwoBone } from '../src/render/animation.js';

const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
test('arm IK keeps both bone lengths and reaches a valid weapon grip', () => {
  const shoulder = [-.24, -.35, .25], target = [-.018, -.067, -.28];
  const pose = solveTwoBone(shoulder, target, [-.6, -.5, -.15], .38, .38);
  assert.ok(pose.reachable);
  assert.ok(distance(pose.hand, target) < 1e-6);
  assert.ok(Math.abs(distance(shoulder, pose.elbow) - .38) < 1e-6);
  assert.ok(Math.abs(distance(pose.elbow, pose.hand) - .38) < 1e-6);
});
test('arm IK remains finite at zero reach, collinear pole and unreachable targets', () => {
  for (const target of [[0, 0, 0], [0, -4, 0], [.1, 0, 0]]) {
    const pose = solveTwoBone([0, 0, 0], target, [0, 0, 0], .3, .25);
    assert.ok([...pose.elbow, ...pose.hand].every(Number.isFinite));
    assert.ok(Math.abs(distance([0, 0, 0], pose.elbow) - .3) < 1e-6);
    assert.ok(Math.abs(distance(pose.elbow, pose.hand) - .25) < 1e-6);
  }
});
