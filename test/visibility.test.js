import test from 'node:test';
import assert from 'node:assert/strict';
import { smokeObscures } from '../shared/visibility.js';
import { BotBrain } from '../server/bots.js';
import { Player } from '../shared/sim.js';

test('smoke blocks sight through the cloud but not a clear or short edge path', () => {
  const cloud = [{ x: 0, y: 0, z: 10, r: 5.5 }];
  assert.equal(smokeObscures(cloud, [0, 1, 0], [0, 1, 20]), true);
  assert.equal(smokeObscures(cloud, [8, 1, 0], [8, 1, 20]), false);
  assert.equal(smokeObscures(cloud, [0, 20, 0], [0, 20, 20]), false);
  assert.equal(smokeObscures(cloud, [0, 1, 10], [0, 1, 10.5]), false);
});

test('bot perception respects smoke even with a clear geometric line of sight', () => {
  const observer = new Player(1, 'Observer'), target = new Player(2, 'Target');
  target.pos = [0, 0, -20];
  const brain = Object.create(BotBrain.prototype);
  brain.p = observer;
  brain.game = { mode: 'br', players: new Map([[1, observer], [2, target]]),
    world: { lineOfSight: () => true }, smokes: [] };
  assert.equal(brain.findEnemy(true), target);
  brain.game.smokes = [{ x: 0, y: 0, z: -10, r: 5.5 }];
  assert.equal(brain.findEnemy(true), null);
});
