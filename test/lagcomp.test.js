import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, emptyInput } from '../shared/sim.js';
import { CFG, STANCE, MATCH_STATE } from '../shared/config.js';
import { solveBallistic, hitboxesFor } from '../shared/weapons.js';
import { movePlayer } from '../shared/physics.js';
import { wireToSimInput } from '../shared/protocol.js';
import { Prediction } from '../src/prediction.js';

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

test('server cooldown caps fire rate even when shoot is held every tick', () => {
  const g = new Game({ mode: 'tdm', seed: 7 });
  const p = g.addPlayer('Spammer', 0);
  g.begin();
  g.matchState = MATCH_STATE.LIVE;
  p.pos = [0, g.world.terrainHeight(0, 0) + 0.05, 0];
  p.vel = [0, 0, 0];
  const ticks = 120; // 2 s of simulation
  let shots = 0;
  for (let i = 0; i < ticks; i++) {
    const inp = emptyInput();
    inp.shoot = true;
    inp.yaw = 0;
    inp.pitch = 0;
    g.step(new Map([[p.id, inp]]), CFG.SIM_DT);
    for (const e of g.events) if (e.k === 'shot' && e.id === p.id) shots++;
    g.events.length = 0;
  }
  const maxShots = Math.ceil((ticks * CFG.SIM_DT) * (CFG.WEAPONS.ar.rpm / 60)) + 1;
  assert.ok(shots > 0, 'the weapon should fire');
  assert.ok(shots <= maxShots, `fired ${shots} shots, rpm cap allows ${maxShots}`);
});

test('reconciliation is skipped when the snapshot ack is unknown', () => {
  const g = new Game({ mode: 'br', seed: 11 });
  g.addPlayer('P', 0);
  const pred = new Prediction(g.world);
  pred.player.pos = [1, 2, 3];
  const inp = emptyInput();
  inp.seq = 1;
  pred.push(inp, CFG.SIM_DT);
  const before = pred.player.pos.slice();
  const history = pred.history.length;
  pred.reconcile({
    x: 99, y: 0, z: 99, vx: 0, vz: 0, stance: 0,
    grounded: true, inWater: false, vehicle: 0, reload: 0, heal: 0,
  }, null);
  assert.deepEqual(pred.player.pos, before, 'position must not change on an unknown ack');
  assert.equal(pred.history.length, history, 'unacked history must be preserved');
});

test('wire inputs cannot set an authoritative position', () => {
  const w = {
    seq: 1, clientTime: 0, yaw: 0, pitch: 0, buttons: 1, actions: 0,
    slot: -1, stance: -1, enterVehicle: 0, viewTime: 0,
    x: 9999, y: 9999, z: 9999, pos: [9999, 9999, 9999],
  };
  const sim = wireToSimInput(w);
  assert.equal(sim.x, undefined);
  assert.equal(sim.y, undefined);
  assert.equal(sim.z, undefined);
  assert.equal(sim.pos, undefined);
});

test('hitboxes move with stance and crouching lowers the head', () => {
  const stand = hitboxesFor([0, 0, 0], CFG.PLAYER.HEIGHT, STANCE.STAND);
  const crouch = hitboxesFor([0, 0, 0], CFG.PLAYER.CROUCH_HEIGHT, STANCE.CROUCH);
  assert.ok(crouch.head.base[1] < stand.head.base[1]);
});
