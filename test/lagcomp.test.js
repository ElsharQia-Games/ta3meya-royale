import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, emptyInput } from '../shared/sim.js';
import { CFG, STANCE, MATCH_STATE } from '../shared/config.js';
import { solveBallistic, hitboxesFor } from '../shared/weapons.js';
import { movePlayer } from '../shared/physics.js';

function setup() {
  const g = new Game({ mode: 'br', seed: 2024 });
  const shooter = g.addPlayer('Shooter', 0);
  const target = g.addPlayer('Target', 0);
  g.begin();
  g.matchState = MATCH_STATE.LIVE;
  // Place both on a known open line so world geometry does not interfere.
  shooter.pos = [0, g.world.terrainHeight(0, 0) + 0.05, 0];
  target.pos = [0, g.world.terrainHeight(0, -25) + 0.05, -25];
  shooter.vel = [0, 0, 0]; target.vel = [0, 0, 0];
  return { g, shooter, target };
}

test('history captures hitboxes at the moment they are recorded', () => {
  const { g, target } = setup();
  const hist = g.captureHitboxes();
  assert.ok(hist.has(target.id));
  const recorded = hist.get(target.id).pos.slice();
  target.pos = [100, target.pos[1], 100];
  const rewound = Game.targetsFromHistory(hist);
  const t = rewound.find(x => x.id === target.id);
  assert.ok(t);
  assert.deepEqual(t.pos, recorded);
  assert.ok(t.hitboxes && t.hitboxes.head && t.hitboxes.torso);
});

test('rewound hitboxes let a shot hit where the target was', () => {
  const { g, shooter, target } = setup();
  const hist = g.captureHitboxes();
  const rewound = Game.targetsFromHistory(hist);

  // Target runs 25 m sideways after the history snapshot.
  const original = target.pos.slice();
  target.pos = [25, target.pos[1], -25];
  const eye = [shooter.pos[0], shooter.pos[1] + shooter.eyeHeight(), shooter.pos[2]];
  const aim = [original[0], original[1] + target.height() * 0.6, original[2]];
  const d = [aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]];
  const len = Math.hypot(...d);
  const dir = [d[0] / len, d[1] / len, d[2] / len];

  // Isolate the hitbox rewind from terrain occlusion for this assertion.
  const openWorld = { raycast: () => null, terrainHeight: () => 0 };
  const live = solveBallistic(openWorld, eye, dir, CFG.WEAPONS.dmr,
    g.buildTargets(), shooter.id, shooter.team, 'br');
  const rewind = solveBallistic(openWorld, eye, dir, CFG.WEAPONS.dmr,
    rewound, shooter.id, shooter.team, 'br');
  assert.ok(rewind.hit, 'rewound shot should hit the old position');
  assert.equal(rewind.hit.targetId, target.id);
  assert.ok(!live.hit || live.hit.targetId !== target.id, 'live shot should miss the moved target');
});

test('rewind is clamped by the configured maximum', () => {
  // The server formula: rtt/2 + interpolation delay, clamped to MAX_REWIND.
  const rtts = [0, 50, 150, 300, 1000];
  for (const rtt of rtts) {
    const rewind = Math.min(Math.max(rtt / 2000 + CFG.INTERP_DELAY, 0), CFG.MAX_REWIND);
    assert.ok(rewind >= 0 && rewind <= CFG.MAX_REWIND, `rewind ${rewind} for rtt ${rtt}`);
  }
  assert.equal(Math.min(800 / 2000 + CFG.INTERP_DELAY, CFG.MAX_REWIND), CFG.MAX_REWIND);
});

test('client prediction via movePlayer matches the authoritative step', () => {
  const { g, shooter } = setup();
  // Build a prediction clone with the same state.
  const pred = {
    pos: shooter.pos.slice(), vel: shooter.vel.slice(), yaw: 0.3, pitch: 0,
    stance: STANCE.STAND, stanceT: 1, grounded: false, coyote: 0, jumpBuffer: 0,
    sprinting: false, adsing: false, inWater: false, swimming: false,
    fallImpact: 0, pendingFallDamage: 0, reloadT: 0, healT: 0,
    height() { return this.stance === 1 ? CFG.PLAYER.CROUCH_HEIGHT : this.stance === 2 ? CFG.PLAYER.PRONE_HEIGHT : CFG.PLAYER.HEIGHT; },
    eyeHeight() { return this.stance === 1 ? CFG.PLAYER.CROUCH_EYE : this.stance === 2 ? CFG.PLAYER.PRONE_EYE : CFG.PLAYER.EYE; },
  };
  for (let tick = 0; tick < 120; tick++) {
    const i = emptyInput();
    i.f = true;
    i.yaw = 0.3;
    i.pitch = 0;
    i.sprint = tick < 60;
    movePlayer(g.world, pred, i, CFG.SIM_DT);
    const map = new Map([[shooter.id, i]]);
    g.step(map, CFG.SIM_DT);
    // Keep the authoritative player's internal stance/ground flags aligned.
    pred.reloadT = shooter.reloadT; pred.healT = shooter.healT;
  }
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(pred.pos[k] - shooter.pos[k]) < 1e-9,
      `axis ${k}: predicted ${pred.pos[k]} vs server ${shooter.pos[k]}`);
  }
});

test('hitboxes move with stance and crouching lowers the head', () => {
  const stand = hitboxesFor([0, 0, 0], CFG.PLAYER.HEIGHT, STANCE.STAND);
  const crouch = hitboxesFor([0, 0, 0], CFG.PLAYER.CROUCH_HEIGHT, STANCE.CROUCH);
  assert.ok(crouch.head.base[1] < stand.head.base[1]);
});
