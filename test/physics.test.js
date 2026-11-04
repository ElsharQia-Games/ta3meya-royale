import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../shared/world.js';
import { CFG, STANCE } from '../shared/config.js';
import {
  stanceHeight, stanceEye, supportHeight, movePlayer, rayCapsule, raySphere,
} from '../shared/physics.js';
import { solveBallistic } from '../shared/weapons.js';
import { emptyInput } from '../shared/sim.js';

const world = new World(CFG.MAP.SEED);

function makePlayer(x, z, y = null, w = world) {
  return {
    pos: [x, y ?? w.terrainHeight(x, z) + 0.05, z],
    vel: [0, 0, 0],
    yaw: 0, pitch: 0, stance: STANCE.STAND, stanceT: 1,
    grounded: false, coyote: 0, jumpBuffer: 0,
    sprinting: false, adsing: false, inWater: false, swimming: false,
    fallImpact: 0, pendingFallDamage: 0, reloadT: 0, healT: 0,
    height() { return stanceHeight(this.stance); },
    eyeHeight() { return stanceEye(this.stance); },
  };
}

// Minimal controlled world for physics regressions. Uses only the surface the
// controller actually touches, so a test can isolate one mechanism.
function flatWorld(boxes = [], opts = {}) {
  const terrainHeight = opts.terrainHeight || (() => 0);
  const terrainNormal = opts.terrainNormal || (() => [0, 1, 0]);
  const waterDepth = opts.waterDepth || (() => 0);
  const w = {
    boxes,
    lake: { level: opts.lakeLevel ?? -1000 },
    terrainHeight,
    terrainNormal,
    waterDepth,
    queryBoxes(minX, minZ, maxX, maxZ) {
      return boxes.filter(b => !b.destroyed &&
        b.max[0] >= minX && b.min[0] <= maxX &&
        b.max[2] >= minZ && b.min[2] <= maxZ);
    },
    raycast(o, d, maxDist) {
      let best = null;
      for (const b of boxes) {
        if (b.destroyed) continue;
        let tmin = 0, tmax = maxDist, miss = false;
        for (let a = 0; a < 3; a++) {
          if (Math.abs(d[a]) < 1e-9) {
            if (o[a] < b.min[a] || o[a] > b.max[a]) { miss = true; break; }
          } else {
            let t1 = (b.min[a] - o[a]) / d[a];
            let t2 = (b.max[a] - o[a]) / d[a];
            if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
            tmin = Math.max(tmin, t1);
            tmax = Math.min(tmax, t2);
            if (tmin > tmax) { miss = true; break; }
          }
        }
        if (miss || tmin <= 0 || tmin > maxDist) continue;
        if (!best || tmin < best.t) {
          best = {
            t: tmin,
            point: [o[0] + d[0] * tmin, o[1] + d[1] * tmin, o[2] + d[2] * tmin],
            tag: b.tag, mat: b.mat, box: b, tmax,
          };
        }
      }
      return best;
    },
  };
  return w;
}

function box(min, max, tag = 'wall', mat = 'concrete') {
  return { min, max, tag, mat, destroyed: false };
}

function run(p, w, input, ticks) {
  for (let i = 0; i < ticks; i++) movePlayer(w, p, input, CFG.SIM_DT);
}


test('stance dimensions are ordered stand > crouch > prone', () => {
  assert.ok(stanceHeight(STANCE.STAND) > stanceHeight(STANCE.CROUCH));
  assert.ok(stanceHeight(STANCE.CROUCH) > stanceHeight(STANCE.PRONE));
  assert.ok(stanceEye(STANCE.STAND) > stanceEye(STANCE.CROUCH));
  assert.ok(stanceEye(STANCE.CROUCH) > stanceEye(STANCE.PRONE));
});

test('prone to crouch requires headroom and stance uses the current capsule height', () => {
  const ceiling = { min: [-3, .8, -3], max: [3, 1, 3], tag: 'roof' };
  const lowWorld = { terrainHeight: () => 0, terrainNormal: () => [0, 1, 0],
    waterDepth: () => 0, lake: { level: -10 }, queryBoxes: () => [ceiling] };
  const p = makePlayer(0, 0, 0);
  p.stance = STANCE.PRONE; p.grounded = true;
  const input = { ...emptyInput(), stance: STANCE.CROUCH };
  movePlayer(lowWorld, p, input, CFG.SIM_DT);
  assert.equal(p.stance, STANCE.PRONE);
  ceiling.min[1] = 1.5; ceiling.max[1] = 1.7;
  movePlayer(lowWorld, p, input, CFG.SIM_DT);
  assert.equal(p.stance, STANCE.CROUCH);
  input.stance = STANCE.STAND;
  movePlayer(lowWorld, p, input, CFG.SIM_DT);
  assert.equal(p.stance, STANCE.CROUCH);
  assert.ok(p.pos[1] >= -.01);
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

test('a low step under the step limit is climbed, a tall one is not', () => {
  const low = flatWorld([box([-1, 0, -2.2], [1, 0.35, -1.2])]);
  const p = makePlayer(0, 0, 0.05, low);
  const input = emptyInput();
  input.f = true;
  let peakY = 0;
  for (let i = 0; i < 120; i++) {
    movePlayer(low, p, input, CFG.SIM_DT);
    if (p.pos[2] < -1.2 && p.pos[2] > -2.2) peakY = Math.max(peakY, p.pos[1]);
  }
  assert.ok(peakY > 0.3, `expected step-up onto 0.35 m ledge, peak y=${peakY}`);
  assert.ok(p.pos[2] < -2.2, `expected to cross the ledge, z=${p.pos[2]}`);
  assert.ok(p.grounded);

  const tall = flatWorld([box([-1, 0, -2.2], [1, 0.9, -1.2])]);
  const q = makePlayer(0, 0, 0.05, tall);
  run(q, tall, input, 120);
  assert.ok(q.pos[2] > -1.6, `0.9 m ledge should block, z=${q.pos[2]}`);
  assert.ok(q.pos[1] < 0.5, `should not climb the tall ledge, y=${q.pos[1]}`);
});

test('slope limit blocks steep uphill but allows a gentle climb', () => {
  const slopeWorld = k => flatWorld([], {
    terrainHeight: x => (x > 0 ? k * x : 0),
    terrainNormal: x => (x > 0
      ? [-k / Math.hypot(k, 1), 1 / Math.hypot(k, 1), 0]
      : [0, 1, 0]),
  });
  const input = emptyInput();
  input.f = true;

  const steepW = slopeWorld(1.0); // tan 45 deg, above SLOPE_MAX
  const steep = makePlayer(-2, 0, 0.05, steepW);
  steep.yaw = -Math.PI / 2; // face +X
  run(steep, steepW, input, 240);
  assert.ok(steep.pos[0] < 0.5, `steep slope should block, x=${steep.pos[0]}`);
  assert.ok(steep.pos[1] < 0.5, `steep slope should not lift player, y=${steep.pos[1]}`);

  const gentleW = slopeWorld(0.4);
  const gentle = makePlayer(-2, 0, 0.05, gentleW);
  gentle.yaw = -Math.PI / 2;
  run(gentle, gentleW, input, 240);
  assert.ok(gentle.pos[0] > 1.5, `gentle slope should be climbable, x=${gentle.pos[0]}`);
  assert.ok(gentle.pos[1] > 0.4, `gentle climb should raise the player, y=${gentle.pos[1]}`);
});

test('steep ground adds downhill slide to a moving player', () => {
  const k = 1.0;
  const steepW = flatWorld([], {
    terrainHeight: x => (x > 0 ? k * x : 0),
    terrainNormal: x => (x > 0
      ? [-k / Math.hypot(k, 1), 1 / Math.hypot(k, 1), 0]
      : [0, 1, 0]),
  });
  const flatW = flatWorld();
  const input = emptyInput();
  input.f = true;
  // Walking downhill (-X) should pick up extra speed from the slide term.
  const a = makePlayer(3, 0, 3.0, steepW);
  a.yaw = Math.PI / 2;
  a.grounded = true;
  const b = makePlayer(3, 0, 0.05, flatW);
  b.yaw = Math.PI / 2;
  b.grounded = true;
  run(a, steepW, input, 40);
  run(b, flatW, input, 40);
  const sa = Math.hypot(a.vel[0], a.vel[2]);
  const sb = Math.hypot(b.vel[0], b.vel[2]);
  assert.ok(sa > sb + 0.1,
    `slope should add downhill speed: slope v=${sa} flat v=${sb}`);
  assert.ok(a.grounded, 'slope walker should stay glued to the downhill surface');
});

test('standing is blocked by a low ceiling while crouch and prone fit', () => {
  // Ceiling 1.5 m above the floor: too low to stand, high enough to crouch.
  const crouchW = flatWorld([box([-2, 1.5, -4], [2, 1.7, 0])]);
  const input = emptyInput();
  input.f = true;
  const stand = makePlayer(0, 1, 0.05, crouchW);
  run(stand, crouchW, input, 90);
  assert.ok(stand.pos[2] > 0.3, `standing player entered a 1.5 m tunnel, z=${stand.pos[2]}`);

  const crouch = makePlayer(0, 1, 0.05, crouchW);
  crouch.stance = STANCE.CROUCH;
  run(crouch, crouchW, input, 150);
  assert.ok(crouch.pos[2] < -1, `crouched player failed to enter, z=${crouch.pos[2]}`);

  // Ceiling 0.9 m: even crouch does not fit, prone does.
  const proneW = flatWorld([box([-2, 0.9, -4], [2, 1.1, 0])]);
  const lowCrouch = makePlayer(0, 1, 0.05, proneW);
  lowCrouch.stance = STANCE.CROUCH;
  run(lowCrouch, proneW, input, 120);
  assert.ok(lowCrouch.pos[2] > 0.3, `crouched player entered a 0.9 m tunnel, z=${lowCrouch.pos[2]}`);

  const prone = makePlayer(0, 1, 0.05, proneW);
  prone.stance = STANCE.PRONE;
  run(prone, proneW, input, 180);
  assert.ok(prone.pos[2] < -1, `prone player failed to enter, z=${prone.pos[2]}`);
});

test('a standing player cannot stand up under a low ceiling', () => {
  const w = flatWorld([box([-2, 1.5, -2], [2, 1.7, 2])]);
  const p = makePlayer(0, 0, 0.05, w);
  p.stance = STANCE.CROUCH;
  const input = emptyInput();
  input.stance = STANCE.STAND;
  run(p, w, input, 30);
  assert.equal(p.stance, STANCE.CROUCH, 'stand-up should be refused with no headroom');
  // Move clear of the ceiling, then standing is allowed.
  p.pos[2] = 4;
  run(p, w, input, 30);
  assert.equal(p.stance, STANCE.STAND, 'stand-up should work once clear');
});

test('water entry, swimming and exit behave consistently', () => {
  const terrainHeight = (x, z) => z < 0 ? Math.max(-3, z * .35) : 0;
  const w = flatWorld([], {
    lakeLevel: 0,
    terrainHeight,
    waterDepth: (x, z) => Math.max(0, -terrainHeight(x, z)),
  });
  const p = makePlayer(0, 2, 0.05, w);
  const input = emptyInput();
  input.f = true;
  let sawSwim = false;
  let maxSwimSpeed = 0;
  for (let i = 0; i < 300; i++) {
    movePlayer(w, p, input, CFG.SIM_DT);
    if (p.swimming) {
      sawSwim = true;
      maxSwimSpeed = Math.max(maxSwimSpeed, Math.hypot(p.vel[0], p.vel[2]));
    }
  }
  assert.ok(p.inWater, 'expected to be in water');
  assert.ok(sawSwim, 'expected deep water to trigger swimming');
  const eye = p.pos[1] + p.eyeHeight();
  assert.ok(eye > 0 && eye < .5, `swimmer's eye should float near surface, eye=${eye}`);
  assert.ok(maxSwimSpeed <= CFG.PLAYER.SWIM + 0.35, `swim speed ${maxSwimSpeed} exceeded cap`);

  // Turn around and leave the water.
  p.yaw = Math.PI;
  run(p, w, input, 900);
  assert.ok(!p.inWater, `expected to leave the water, z=${p.pos[2]}`);
  assert.ok(p.grounded, 'expected to be grounded after exiting');
  assert.ok(Math.abs(p.pos[1]) < 0.2, `expected dry ground height, y=${p.pos[1]}`);
});

test('capsule is stopped by a wall at sprint speed without tunnelling', () => {
  const w = flatWorld([box([2, 0, -5], [2.3, 3, 5])]);
  const p = makePlayer(0, 0, 0.05, w);
  const input = emptyInput();
  input.f = true;
  input.sprint = true;
  p.yaw = -Math.PI / 2; // face +X
  run(p, w, input, 180);
  assert.ok(p.pos[0] < 2, `tunnelled through the wall: x=${p.pos[0]}`);
  assert.ok(p.pos[0] > 2 - CFG.PLAYER.RADIUS - 0.05,
    `stopped too far from wall: x=${p.pos[0]}`);
  assert.ok(p.vel[0] <= 0.1, `velocity should be killed at the wall: vx=${p.vel[0]}`);
});

test('high-speed projectile still hits a thin wall between integration steps', () => {
  // 4000 m/s at dt=1/90 moves ~44 m per step, far past this 0.5 m wall. The
  // solver must raycast the whole segment, not just sample the endpoint.
  const w = flatWorld([box([-5, -5, -10], [5, 5, -9.5])]);
  const W = { ...CFG.WEAPONS.sniper, mv: 4000, drag: 0, grav: 0 };
  const res = solveBallistic(w, [0, 0, 0], [0, 0, -1], W, [], 1, 0, 'br');
  const impact = res.impacts[0];
  assert.ok(impact, 'expected a wall impact');
  assert.equal(impact.tag, 'wall');
  assert.ok(Math.abs(impact.dist - 9.5) < 0.05, `impact distance ${impact.dist}`);
  assert.equal(res.hit, null, 'thick wall should stop the bullet');
});
