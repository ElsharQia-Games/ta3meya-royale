import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, STANCE } from '../shared/config.js';
import { Player, emptyInput, Game } from '../shared/sim.js';
import { movePlayer, raySphere, rayCapsuleSegment } from '../shared/physics.js';
import { hitboxesFor, nearestPlayerHit } from '../shared/weapons.js';

test('deep-water buoyancy puts the eye just above the surface rather than walking on it', () => {
  const world = { terrainHeight: () => -5, terrainNormal: () => [0, 1, 0],
    waterDepth: () => 5, lake: { level: 0 }, queryBoxes: () => [] };
  const p = new Player(1, 'Swimmer'); p.pos = [0, -.2, 0];
  for (let i = 0; i < 600; i++) movePlayer(world, p, emptyInput(), CFG.SIM_DT);
  const eye = p.pos[1] + p.eyeHeight();
  assert.ok(p.swimming);
  assert.ok(eye > 0 && eye < .5, `eye ${eye}m above water`);
  assert.ok(Math.abs(p.vel[1]) < .1);
});

test('prone body hit zones follow the rendered horizontal body and its yaw', () => {
  for (const yaw of [0, Math.PI / 2]) {
    const back = [Math.sin(yaw), 0, Math.cos(yaw)], right = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const target = { id: 2, pos: [0, 0, 0], height: CFG.PLAYER.PRONE_HEIGHT, stance: STANCE.PRONE,
      alive: true, team: 1, yaw, hitboxes: hitboxesFor([0, 0, 0], CFG.PLAYER.PRONE_HEIGHT, STANCE.PRONE, yaw) };
    for (const [offset, y, zone] of [[0, .42, 'head'], [.55, .22, 'torso'], [1.35, .15, 'legs']]) {
      const origin = [back[0] * offset + right[0] * 3, y, back[2] * offset + right[2] * 3];
      const hit = nearestPlayerHit(origin, [-right[0], 0, -right[2]], 6, [target], 1, 0, 'br');
      assert.equal(hit?.zone, zone, `yaw ${yaw}, body offset ${offset}`);
    }
  }
});

test('rewind retains prone orientation and point-blank rays starting inside hitboxes hit', () => {
  const game = new Game(); const p = game.addPlayer('Prone'); p.stance = STANCE.PRONE; p.yaw = 1.2;
  const history = game.captureHitboxes(); p.yaw = -1;
  assert.equal(Game.targetsFromHistory(history)[0].yaw, 1.2);
  assert.equal(raySphere([0, 0, 0], [1, 0, 0], [0, 0, 0], .2), 0);
  assert.equal(rayCapsuleSegment([0, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1], .2), 0);
});
