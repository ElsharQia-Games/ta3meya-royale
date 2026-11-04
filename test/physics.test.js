import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../shared/world.js';
import { CFG, STANCE } from '../shared/config.js';
import {
  stanceHeight, stanceEye, supportHeight, movePlayer, rayCapsule, raySphere,
} from '../shared/physics.js';
import { emptyInput } from '../shared/sim.js';

const world = new World(CFG.MAP.SEED);

function makePlayer(x, z, y = null) {
  return {
    pos: [x, y ?? world.terrainHeight(x, z) + 0.05, z],
    vel: [0, 0, 0],
    yaw: 0, pitch: 0, stance: STANCE.STAND, stanceT: 1,
    grounded: false, coyote: 0, jumpBuffer: 0,
    sprinting: false, adsing: false, inWater: false, swimming: false,
    fallImpact: 0, pendingFallDamage: 0, reloadT: 0, healT: 0,
    height() { return stanceHeight(this.stance); },
    eyeHeight() { return stanceEye(this.stance); },
  };
}

test('stance dimensions are ordered stand > crouch > prone', () => {
  assert.ok(stanceHeight(STANCE.STAND) > stanceHeight(STANCE.CROUCH));
  assert.ok(stanceHeight(STANCE.CROUCH) > stanceHeight(STANCE.PRONE));
  assert.ok(stanceEye(STANCE.STAND) > stanceEye(STANCE.CROUCH));
  assert.ok(stanceEye(STANCE.CROUCH) > stanceEye(STANCE.PRONE));
});

test('support height on open terrain matches the terrain', () => {
  const x = 120, z = -220;
  const h = world.terrainHeight(x, z);
  assert.equal(supportHeight(world, x, z, h + 0.1, CFG.PLAYER.RADIUS), h);
});

test('support height rises onto a low box top', () => {
  const box = world.boxes.find(b => b.tag !== 'glass' && !b.destroyed &&
    b.max[1] - b.min[1] > 0.2 && b.max[1] - b.min[1] < 1.2 &&
    world.terrainHeight((b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2) < b.max[1]);
  assert.ok(box, 'expected at least one low walkable box');
  const cx = (box.min[0] + box.max[0]) / 2, cz = (box.min[2] + box.max[2]) / 2;
  const support = supportHeight(world, cx, cz, box.max[1] - 0.1, CFG.PLAYER.RADIUS);
  assert.ok(Math.abs(support - box.max[1]) < 1e-9);
});

test('a player dropped above terrain settles on the ground', () => {
  const p = makePlayer(30, 40, world.terrainHeight(30, 40) + 4);
  const input = emptyInput();
  for (let i = 0; i < 180; i++) movePlayer(world, p, input, CFG.SIM_DT);
  assert.ok(p.grounded, 'should be grounded after 3 s');
  const ground = world.terrainHeight(p.pos[0], p.pos[2]);
  assert.ok(Math.abs(p.pos[1] - ground) < 0.2, `y ${p.pos[1]} vs ground ${ground}`);
  assert.ok(Math.abs(p.vel[1]) < 0.1);
});

test('sprint speed is capped near the configured value', () => {
  const p = makePlayer(0, 0);
  const input = emptyInput();
  input.f = true; input.sprint = true;
  for (let i = 0; i < 240; i++) movePlayer(world, p, input, CFG.SIM_DT);
  const speed = Math.hypot(p.vel[0], p.vel[2]);
  assert.ok(speed > 6.5, `expected sprint, got ${speed}`);
  assert.ok(speed <= CFG.PLAYER.SPRINT + 0.2, `sprint ${speed} exceeded cap`);
});

test('crouch speed is slower than walk and stance lowers the capsule', () => {
  const p = makePlayer(0, 0);
  const input = emptyInput();
  input.f = true;
  input.stance = STANCE.CROUCH;
  for (let i = 0; i < 180; i++) movePlayer(world, p, input, CFG.SIM_DT);
  assert.equal(p.stance, STANCE.CROUCH);
  assert.ok(Math.hypot(p.vel[0], p.vel[2]) <= CFG.PLAYER.CROUCH + 0.2);
});

test('jump leaves the ground and returns', () => {
  const p = makePlayer(0, 0);
  const input = emptyInput();
  for (let i = 0; i < 30; i++) movePlayer(world, p, input, CFG.SIM_DT);
  const startY = p.pos[1];
  input.jump = true;
  movePlayer(world, p, input, CFG.SIM_DT);
  input.jump = false;
  let peak = p.pos[1];
  for (let i = 0; i < 120; i++) {
    movePlayer(world, p, input, CFG.SIM_DT);
    peak = Math.max(peak, p.pos[1]);
  }
  assert.ok(peak > startY + 0.5, `jump peak ${peak} vs start ${startY}`);
  assert.ok(p.grounded, 'should land again');
});

test('walls stop horizontal movement without tunnelling', () => {
  const wall = world.boxes.find(b => b.tag === 'wall' && !b.destroyed && b.max[1] - b.min[1] > 2);
  assert.ok(wall);
  const cz = (wall.min[2] + wall.max[2]) / 2;
  const startX = wall.min[0] - 4;
  const p = makePlayer(startX, cz);
  p.pos[1] = Math.max(p.pos[1], wall.min[1] + 0.1);
  const input = emptyInput();
  input.f = true;
  input.yaw = Math.PI / 2; // face +X
  for (let i = 0; i < 120; i++) movePlayer(world, p, input, CFG.SIM_DT);
  assert.ok(p.pos[0] < wall.min[0], `tunnelled through wall: x ${p.pos[0]} vs face ${wall.min[0]}`);
});

test('raySphere and rayCapsule return sensible entry distances', () => {
  assert.equal(raySphere([0, 0, 0], [0, 0, -1], [0, 0, -5], 1), 4);
  assert.equal(raySphere([0, 0, 0], [0, 0, 1], [0, 0, -5], 1), null);
  const t = rayCapsule([0, 1, 0], [0, 0, -1], [0, 0, -5], 0.4, 1.8);
  assert.ok(t !== null && t > 3.5 && t < 4.7, `capsule t ${t}`);
});
