import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, MATCH_STATE, STANCE } from '../shared/config.js';
import { movePlayer, advanceMovementTimers } from '../shared/physics.js';
import { Game, emptyInput } from '../shared/sim.js';
import { encodeSnapshot, decodeSnapshot, applySnapshot } from '../shared/protocol.js';
import { Prediction } from '../src/prediction.js';

function flatWorld(opts = {}) {
  return {
    boxes: [],
    lake: { level: opts.lakeLevel ?? -1000 },
    terrainHeight: () => 0,
    terrainNormal: () => [0, 1, 0],
    waterDepth: opts.waterDepth || (() => 0),
    queryBoxes: () => [],
  };
}

function makeAuth() {
  return {
    pos: [0, 0.05, 0],
    vel: [0, 0, 0],
    yaw: 0, pitch: 0, stance: STANCE.STAND, stanceT: 1,
    grounded: false, coyote: 0, jumpBuffer: 0,
    sprinting: false, adsing: false, inWater: false, swimming: false,
    fallImpact: 0, pendingFallDamage: 0, reloadT: 0, healT: 0,
    height() { return CFG.PLAYER.HEIGHT; },
    eyeHeight() { return CFG.PLAYER.EYE; },
  };
}

function wireState(auth, id = 1) {
  return {
    id,
    x: auth.pos[0], y: auth.pos[1], z: auth.pos[2],
    yaw: auth.yaw, pitch: auth.pitch,
    vx: auth.vel[0], vy: auth.vel[1], vz: auth.vel[2],
    coyote: auth.coyote, jumpBuffer: auth.jumpBuffer,
    hp: 100, armor: 0, alive: 1,
    grounded: auth.grounded ? 1 : 0,
    inWater: auth.inWater ? 1 : 0,
    connected: 1, stance: auth.stance,
    sprinting: auth.sprinting ? 1 : 0,
    adsing: auth.adsing ? 1 : 0,
    w: 1, slot: 0, mag: 30, res: 120,
    k: 0, d: 0, dmg: 0, vehicle: 0, seat: -1,
    reload: Math.round(auth.reloadT * 100), heal: Math.round(auth.healT * 100), switchT: 0,
    team: 0, gren: 0, smoke: 0, band: 0, med: 0, ping: 0,
  };
}

function idle(seq) {
  const input = emptyInput();
  input.seq = seq;
  return input;
}

test('prediction reset restores vertical velocity, timers and derived swim state', () => {
  const world = flatWorld({ lakeLevel: 0, waterDepth: () => 3 });
  const pred = new Prediction(world);
  pred.history.push({ seq: 9, input: idle(9), dt: CFG.SIM_DT });
  pred.player.coyote = 0;
  pred.player.jumpBuffer = 0;

  pred.reset({
    x: 1, y: -1, z: 2,
    vx: 1.5, vy: -4.25, vz: -0.5,
    yaw: 0.3, pitch: -0.1,
    stance: STANCE.CROUCH, grounded: 0, inWater: 1,
    coyote: 0.07, jumpBuffer: 0.05,
    sprinting: 1, adsing: 1,
    reload: 0.5, heal: 0.2, vehicle: 0,
  });

  const p = pred.player;
  assert.deepEqual(p.vel, [1.5, -4.25, -0.5]);
  assert.equal(p.coyote, 0.07);
  assert.equal(p.jumpBuffer, 0.05);
  assert.equal(p.sprinting, true);
  assert.equal(p.adsing, true);
  assert.equal(p.inWater, true);
  assert.equal(p.swimming, true, 'swim flag should be derived from the restored position');
  assert.equal(p.stance, STANCE.CROUCH);
  assert.equal(p.stanceT, 1);
  assert.equal(p.reloadT, 0.5);
  assert.equal(p.healT, 0.2);
  assert.equal(pred.history.length, 0);
  assert.equal(pred.acked, 0);
});

test('reconciliation restores authoritative vertical velocity before replay', () => {
  const pred = new Prediction(flatWorld());
  pred.push(idle(1), CFG.SIM_DT);
  const idleVy = 5;

  pred.reconcile({
    x: 0, y: 1, z: 0, vx: 0, vy: idleVy, vz: 0,
    grounded: 0, stance: STANCE.STAND,
    coyote: 0, jumpBuffer: 0,
  }, 0);

  const expected = idleVy - CFG.PLAYER.GRAVITY * CFG.SIM_DT;
  assert.ok(Math.abs(pred.player.vel[1] - expected) < 1e-9,
    `replay should start from authoritative vy, got ${pred.player.vel[1]}`);
});

test('a coyote-time jump is replayed after reconciliation', () => {
  const pred = new Prediction(flatWorld());
  const jump = idle(1);
  jump.jump = true;
  pred.push(jump, CFG.SIM_DT);

  pred.reconcile({
    x: 0, y: 0.5, z: 0, vx: 0, vy: -1, vz: 0,
    grounded: 0, stance: STANCE.STAND,
    coyote: CFG.PLAYER.COYOTE, jumpBuffer: 0,
  }, 0);

  assert.ok(pred.player.vel[1] > CFG.PLAYER.JUMP - CFG.PLAYER.GRAVITY * CFG.SIM_DT - 1e-9,
    `coyote jump did not replay, vy=${pred.player.vel[1]}`);
  assert.equal(pred.player.jumped, true);
});

test('a buffered jump survives reconciliation and fires on landing', () => {
  const pred = new Prediction(flatWorld());
  pred.reconcile({
    x: 0, y: 0.05, z: 0, vx: 0, vy: -1, vz: 0,
    grounded: 0, stance: STANCE.STAND,
    coyote: 0, jumpBuffer: 0.1,
  }, 0);
  assert.equal(pred.player.jumpBuffer, 0.1);

  pred.push(idle(1), CFG.SIM_DT);
  pred.push(idle(2), CFG.SIM_DT);
  assert.equal(pred.player.grounded, false);
  assert.ok(pred.player.vel[1] > 0,
    `buffered jump should fire after landing, vy=${pred.player.vel[1]}`);
});

// Runs an authoritative flat-ground simulation and a delayed prediction client.
// Snapshots are encoded/decoded through the real protocol (including deltas) and
// reconciled against the matching acknowledged input sequence.
function simulate(delayTicks, ticks = 300, opts = {}) {
  const world = flatWorld();
  const auth = makeAuth();
  const pred = new Prediction(world);
  const cache = new Map();
  const snapshots = new Map();
  let previous = null;
  let capture = 0;
  let maxError = 0;
  let maxVyError = 0;

  for (let tick = 0; tick < ticks; tick++) {
    const input = idle(tick + 1);
    input.f = true;
    input.sprint = true;
    input.jump = tick % 50 === 20 || tick % 50 === 21;

    if (opts.timers && tick > 0 && tick % 40 === 0) {
      auth.reloadT = 0.35;
      auth.healT = 0.12;
    }
    if (opts.timers) advanceMovementTimers(auth, CFG.SIM_DT);
    movePlayer(world, auth, input, CFG.SIM_DT);
    pred.push(input, CFG.SIM_DT);

    if (tick % 2 === 0) {
      const seq = ++capture;
      const { buffer, states } = encodeSnapshot(
        new Map([[1, wireState(auth)]]), previous, seq, tick / 60, seq === 1,
      );
      previous = states;
      applySnapshot(cache, decodeSnapshot(buffer));
      snapshots.set(tick, { state: { ...cache.get(1) }, ack: tick + 1 });
    }

    const snapshotTick = tick - delayTicks;
    if (snapshotTick < 0 || !snapshots.has(snapshotTick)) continue;
    const saved = snapshots.get(snapshotTick);
    pred.reconcile(saved.state, saved.ack);
    const dx = pred.player.pos[0] - auth.pos[0];
    const dy = pred.player.pos[1] - auth.pos[1];
    const dz = pred.player.pos[2] - auth.pos[2];
    maxError = Math.max(maxError, Math.hypot(dx, dy, dz));
    maxVyError = Math.max(maxVyError, Math.abs(pred.player.vel[1] - auth.vel[1]));
  }

  return { maxError, maxVyError, auth, pred };
}

test('reconciliation converges at 0/166/300 ms without vertical velocity resets', () => {
  for (const delay of [0, 10, 18]) {
    const { maxError, maxVyError } = simulate(delay);
    // Position quantum is 0.02 m. A converged replay should stay within a few
    // quanta, not drift with the unacknowledged input history.
    assert.ok(maxError < 0.05, `delay ${delay}: position error ${maxError.toFixed(4)} m`);
    assert.ok(maxVyError < 0.02, `delay ${delay}: vertical velocity error ${maxVyError.toFixed(4)} m/s`);
  }
});

test('replay advances reload/heal timers before integration', () => {
  const dt = CFG.SIM_DT;

  function replay(delayTicks) {
    const game = new Game({ mode: 'tdm', seed: 20261106 });
    game.addPlayer('Alpha', 0);
    game.begin();
    game.matchState = MATCH_STATE.LIVE;
    const auth = [...game.players.values()][0];
    auth.pos = [0, 0, 0];
    auth.vel = [0, 0, 0];
    auth.grounded = true;
    auth.coyote = CFG.PLAYER.COYOTE;
    auth.health = 50;
    // Both timers expire during the replay window. The authoritative step
    // advances them before movement, so the last penalty tick is tick 2.
    auth.reloadT = 0.035;
    auth.healT = 0.035;
    auth.healItem = 'bandage';

    const snapshot = {
      x: auth.pos[0], y: auth.pos[1], z: auth.pos[2],
      vx: auth.vel[0], vy: auth.vel[1], vz: auth.vel[2],
      yaw: auth.yaw, pitch: auth.pitch,
      stance: auth.stance, grounded: auth.grounded ? 1 : 0,
      inWater: auth.inWater ? 1 : 0,
      coyote: auth.coyote, jumpBuffer: auth.jumpBuffer,
      sprinting: auth.sprinting ? 1 : 0, adsing: auth.adsing ? 1 : 0,
      reload: auth.reloadT, heal: auth.healT, vehicle: 0,
    };
    const pred = new Prediction(game.world);
    pred.reset(snapshot);
    assert.equal(pred.player.reloadT, 0.035);
    assert.equal(pred.player.healT, 0.035);

    let maxError = 0;
    for (let i = 0; i < delayTicks + 12; i++) {
      const input = emptyInput();
      input.seq = i + 1;
      input.yaw = 0.1;
      input.f = true;
      input.sprint = true;
      game.step(new Map([[auth.id, input]]), dt);
      pred.push(input, dt);
      const err = Math.hypot(
        pred.player.pos[0] - auth.pos[0],
        pred.player.pos[1] - auth.pos[1],
        pred.player.pos[2] - auth.pos[2],
      );
      maxError = Math.max(maxError, err);
    }

    assert.equal(pred.player.reloadT, 0);
    assert.equal(pred.player.healT, 0);
    return maxError;
  }

  // Replay histories for 0/166/300 ms of pending latency. Before the timer
  // fix these drifted 0.30/0.63/0.90 m; the authoritative order keeps them
  // numerically identical because both sides use the same integration.
  for (const delay of [0, 10, 18]) {
    const maxError = replay(delay);
    assert.ok(maxError < 1e-9, `delay ${delay}: timer replay drifted ${maxError.toFixed(4)} m`);
  }
});

test('vehicle snapshots are not replayed through the ground controller', () => {
  const pred = new Prediction(flatWorld());
  pred.push(idle(1), CFG.SIM_DT);
  pred.push(idle(2), CFG.SIM_DT);

  pred.reconcile({
    x: 5, y: 1.2, z: -2,
    vx: 10, vy: 0, vz: -3,
    grounded: 0, stance: STANCE.STAND,
    coyote: 0.1, jumpBuffer: 0.1,
    vehicle: 7, seat: 0,
  }, 0);

  const p = pred.player;
  assert.deepEqual(p.pos, [5, 1.2, -2]);
  assert.deepEqual(p.vel, [10, 0, -3]);
  assert.equal(p.inVehicle, 7);
  assert.equal(p.coyote, 0);
  assert.equal(p.jumpBuffer, 0);
  assert.equal(p.swimming, false);
  assert.equal(pred.history.length, 0, 'unacked ground inputs must not replay in a vehicle');
});
