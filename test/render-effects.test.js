import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Effects } from '../src/render/effects.js';

test('shotgun tracers originate at the muzzle instead of connecting pellet endpoints', () => {
  const traces = [];
  const effects = Object.create(Effects.prototype);
  effects.tracer = (...args) => traces.push(args);
  effects.muzzle = () => {};
  const origin = [1, 2, 3], ends = [[10, 3, -20], [13, 2, -22], [11, 1, -25]];
  effects.shot({ o: origin, e: ends }, { pellets: 8, mv: 390 });
  assert.equal(traces.length, ends.length);
  for (const trace of traces) assert.deepEqual(trace[0], origin);
});

test('the final expired tracer invalidates the GPU instance data', () => {
  const effects = Object.create(Effects.prototype);
  effects.scene = new THREE.Scene();
  effects._initTracers();
  effects.tracer([0, 1, 0], [0, 1, -10]);
  effects._updateTracers(.01);
  const before = effects.tracers.instanceMatrix.version;
  effects._updateTracers(2);
  assert.ok(effects.tracers.instanceMatrix.version > before);
  assert.equal(effects.tracerData.filter(Boolean).length, 0);
  const matrix = new THREE.Matrix4(); effects.tracers.getMatrixAt(0, matrix);
  assert.equal(matrix.elements[0], 0);
  effects.tracers.geometry.dispose(); effects.tracers.material.dispose();
});
