// Phase 3 regressions: authoritative bullet projectiles, the combat timeline,
// vehicle glazing, penetration residual, glass cover and life-cycle damage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, Vehicle, emptyInput } from '../shared/sim.js';
import { CFG, MATCH_STATE, STANCE } from '../shared/config.js';
import {
  hitboxesFor, nearestPlayerHit, stepBullets, tryFire,
} from '../shared/weapons.js';
import { rayVehicle, rayVehicleBallistic } from '../shared/vehicle.js';
import { SnapshotBuffer, remoteRenderTime } from '../src/prediction.js';

const openWorld = () => ({
  raycast: () => null,
  terrainHeight: () => 0,
  terrainNormal: () => [0, 1, 0],
  waterDepth: () => 0,
  lake: { level: -100 },
  queryBoxes: () => [],
  lineOfSight: () => true,
});

function liveGame(world = openWorld()) {
  const game = new Game({ mode: 'br' });
  game.world = world;
  game.matchState = MATCH_STATE.LIVE;
  game.rng.next = () => 0.5; // deterministic spread
  return game;
}

function addShooter(game, weapon = 'dmr', at = [0, 0, 0]) {
  const p = game.addPlayer('S', 0, { forceSpawn: { x: at[0], z: at[2] } });
  p.pos = at.slice();
  p.vel = [0, 0, 0];
  p.yaw = 0; p.pitch = 0;
  p.grounded = true; p.adsing = true;
  p.weapons = [weapon, null];
  p.curSlot = 0;
  p.inv = { [weapon]: { mag: CFG.WEAPONS[weapon].mag, reserve: CFG.WEAPONS[weapon].reserve } };
  return p;
}

function addTarget(game, at = [0, 0, -40], team = 1) {
  const t = game.addPlayer('T', team, { forceSpawn: { x: at[0], z: at[2] } });
  t.pos = at.slice();
  t.vel = [0, 0, 0];
  t.armor = 0;
  return t;
}

function fire(game, player, yaw = player.yaw, pitch = player.pitch) {
  const input = emptyInput();
  input.shoot = true;
  input.yaw = yaw;
  input.pitch = pitch;
  player.yaw = yaw;
  player.pitch = pitch;
  return tryFire(game, player, input, game.buildTargets(), { rng: game.rng });
}

// ---------------------------------------------------------------------------
// F1 — persistent bullets hit moving targets at the position they occupy when
// the round arrives, not the position captured at fire time.
// ---------------------------------------------------------------------------
test('F1: a led shot hits a moving target, an unled shot misses', () => {
  const run = (led) => {
    const game = liveGame();
    const shooter = addShooter(game, 'dmr');
    const target = addTarget(game, [0, 0, -100]);
    target.vel = [7, 0, 0];
    const W = CFG.WEAPONS.dmr;
    const flight = 100 / W.mv;
    const aimX = led ? 7 * flight : 0;
    shooter.yaw = Math.atan2(-aimX, 100);
    shooter.pitch = Math.atan2(target.height() * 0.62 - 1.64 -
      0.5 * 9.81 * (W.grav ?? 1) * flight * flight, 100);
    assert.equal(fire(game, shooter), true);
    const hp = target.health;
    for (let i = 0; i < 30; i++) {
      target.pos[0] += target.vel[0] * CFG.SIM_DT;
      stepBullets(game, CFG.SIM_DT);
    }
    return hp - target.health;
  };
  assert.ok(run(true) > 0, 'led shot must damage the moving target');
  assert.equal(run(false), 0, 'unled shot must miss the moving target');
});

// ---------------------------------------------------------------------------
// F2 — history is interpolated on the server clock, and the firing context is
// bounded rather than trusting a client timestamp.
// ---------------------------------------------------------------------------
test('F2: history interpolation and bounded fire context', () => {
  const frame = (t, x, lifeId = 1) => ({
    t,
    map: new Map([[2, {
      id: 2, pos: [x, 0, -30], height: CFG.PLAYER.HEIGHT, stance: STANCE.STAND,
      yaw: 0, alive: true, team: 1, lifeId, spawnTime: 0,
    }]]),
  });
  const history = [frame(1.0, 0), frame(1.02, 0.14)];

  const mid = Game.sampleHistory(history, 1.01);
  assert.ok(mid, 'timestamp between frames must interpolate');
  assert.ok(Math.abs(mid.get(2).pos[0] - 0.07) < 1e-6);

  assert.equal(Game.sampleHistory(history, 1.5), null, 'outside window falls back');
  assert.equal(Game.sampleHistory([], 1.0), null, 'empty history falls back');

  const ctx = Game.fireContext(history, 1.0, 1.1, CFG.INTERP_DELAY);
  assert.ok(ctx);
  assert.ok(Math.abs(ctx.catchupAge - 0.1) < 1e-9);
  assert.ok(Math.abs(ctx.targets[0].pos[0]) < 1e-9, 'uses the view-time pose');

  const future = Game.fireContext(history, 2.0, 1.1, CFG.INTERP_DELAY);
  assert.ok(future, 'a future timestamp is ignored rather than trusted');
  assert.equal(future.catchupAge, 0, 'future timestamps cannot rewind');

  const longHistory = [frame(0.6, 0), frame(0.7, 0.7), frame(0.8, 1.4)];
  const old = Game.fireContext(longHistory, 0.1, 1.0, CFG.INTERP_DELAY);
  assert.ok(old);
  assert.ok(Math.abs(old.catchupAge - CFG.MAX_REWIND) < 1e-9, 'old timestamps clamp');
});

// A death inside an interpolation bracket must resolve at the death boundary
// instead of dropping the target from the whole bracket. A respawn must not be
// visible before its own spawn time.
test('F2b: death and respawn boundaries inside an interpolation bracket', () => {
  const historyFrame = (game, t) => ({ t, map: game.captureHitboxes() });
  const game = liveGame();
  const target = addTarget(game, [0, 0, -30]);
  game.time = 1.0;
  const aliveFrame = historyFrame(game, game.time);
  game.time = 1.016667;
  game.kill(target, -1, 'test', 'torso', 1);
  const deadFrame = historyFrame(game, game.time);
  game.time = 1.05;
  game.spawnPlayer(target, { x: 5, z: -30 });
  target.pos = [5, 0, -30];
  const respawnFrame = historyFrame(game, game.time);
  const history = [aliveFrame, deadFrame, respawnFrame];

  const at = (t) => Game.sampleHistory(history, t)?.get(target.id) || null;
  assert.equal(at(1.0)?.alive, true, 'alive before the death');
  assert.equal(at(1.008333)?.alive, true,
    'a target alive in the earlier frame survives the bracket');
  assert.equal(at(1.016666)?.alive, true, 'still alive immediately before death');
  assert.equal(at(1.016667), null, 'dead at the captured death time');
  assert.equal(at(1.04), null, 'dead until the respawn');
  assert.equal(at(1.05)?.alive, true, 'alive at the respawn time');
  assert.equal(at(1.05)?.lifeId, target.lifeId, 'the new life replaces the old one');
  assert.ok(Math.abs(at(1.05).pos[0] - 5) < 1e-9, 'respawn pose is not interpolated backward');
});

// viewTime is the rendered pose time, not the local fire timestamp. Under
// controlled RTT/jitter the rewind is exactly the age of the displayed pose;
// the server does not add a second latency estimate on top of it.
test('F2c: rewind follows the displayed pose under RTT/jitter', () => {
  const newest = 10.1;
  const buffer = new SnapshotBuffer();
  // A normal 30 Hz buffer: the rendered pose must fall inside the retained
  // range, otherwise the underrun clamp (F2e) would mask the mapping.
  for (let i = 0; i <= 21; i++) {
    buffer.push({ serverTime: 9.4 + i * (0.7 / 21), seq: i + 1 }, new Map());
  }
  const targetAt = (t) => (t - 9.8) * 7;
  const history = [];
  for (let i = 0; i <= 50; i++) {
    const t = 9.8 + i * 0.01;
    history.push({
      t,
      map: new Map([[7, {
        id: 7, pos: [targetAt(t), 0, -30], height: CFG.PLAYER.HEIGHT,
        stance: STANCE.STAND, yaw: 0, alive: true, team: 1,
        lifeId: 1, spawnTime: 0, deathAt: null,
      }]]),
    });
  }
  let previousAge = -1;
  for (const [rtt, jitter] of [[20, 0], [80, 5], [160, 20], [400, 60]]) {
    const viewTime = remoteRenderTime(buffer, rtt, jitter);
    // The newest snapshot has already spent one one-way trip in flight.
    const now = newest + rtt / 2000 + 0.005;
    const renderedAge = now - viewTime;
    const expected = Math.min(CFG.MAX_REWIND, renderedAge);
    const ctx = Game.fireContext(history, viewTime, now, CFG.INTERP_DELAY);
    assert.ok(ctx);
    assert.ok(Math.abs(ctx.catchupAge - Math.min(CFG.BULLET.catchupMax, expected)) < 1e-9,
      'rewind is the displayed-pose age, not an RTT approximation');
    assert.ok(expected + 1e-9 >= previousAge, 'larger latency/jitter cannot shorten the rewind');
    previousAge = expected;
    const seen = ctx.targets.find(t => t.id === 7);
    assert.ok(seen);
    assert.ok(Math.abs(seen.pos[0] - targetAt(now - expected)) < 0.03,
      'target pose comes from the displayed time');
  }
});

// A sparse or just-reset buffer must not report a render time older than the
// data it can actually play back; that would become an unnecessary rewind.
test('F2e: reported render time is clamped to the buffered range', () => {
  const empty = new SnapshotBuffer();
  assert.equal(remoteRenderTime(empty, 100, 10), 0);

  const buffer = new SnapshotBuffer();
  buffer.push({ serverTime: 10, seq: 1 }, new Map());
  assert.equal(remoteRenderTime(buffer, 200, 20), 10,
    'a single frame cannot claim a pose 0.28 s older than itself');

  buffer.push({ serverTime: 10.033, seq: 2 }, new Map());
  const t = remoteRenderTime(buffer, 200, 20);
  assert.ok(t >= buffer.oldestTime - 1e-9 && t <= buffer.newestTime + 1e-9);
  assert.ok(t < buffer.newestTime, 'normal buffered playback still interpolates behind the newest frame');
});

// Catch-up runs once on the first tick and is then cleared; it cannot compound
// on later ticks.
test('F2d: projectile catch-up is applied exactly once', () => {
  const run = (catchupAge) => {
    const game = liveGame();
    const shooter = addShooter(game, 'ar');
    addTarget(game, [0, 0, -200]);
    const input = emptyInput();
    input.shoot = true;
    assert.equal(tryFire(game, shooter, input, game.buildTargets(), {
      rng: game.rng, catchupAge,
    }), true);
    const bullet = game.bullets[0];
    assert.ok(Math.abs(bullet.bornAt - (game.time - catchupAge)) < 1e-9);
    stepBullets(game, CFG.SIM_DT);
    assert.equal(bullet.catchupAge, 0, 'the catch-up window is consumed');
    assert.equal(bullet.catchupFrom, null);
    return bullet.dist;
  };
  const direct = run(0);
  const caughtUp = run(0.2);
  const extra = caughtUp - direct;
  assert.ok(extra > CFG.WEAPONS.ar.mv * 0.15,
    'the first tick advances across the catch-up window');
  assert.ok(extra < CFG.WEAPONS.ar.mv * 0.25,
    'the advance is one window, not a repeated rewind');
});

// ---------------------------------------------------------------------------
// F3 — the ballistic vehicle hull opens the glazed cabin while doors, roof and
// pillars remain solid. Movement still uses the full closed hull.
// ---------------------------------------------------------------------------
test('F3: occupants are hittable through windscreen and side glass, not doors', () => {
  const game = new Game({ mode: 'tdm', seed: 5 });
  game.matchState = MATCH_STATE.LIVE;
  const shooter = addShooter(game, 'dmr', [0, 0, 8]);
  const occupant = addTarget(game, [0, 0, 0]);
  occupant.pos = [0, 0, 0];
  const vehicle = new Vehicle(game.nextId++, 0, 0, 0, 'car');
  vehicle.pos[1] = 0.6;
  game.vehicles.push(vehicle);
  assert.equal(game.enterVehicle(occupant, vehicle), true);
  game.carryVehicleOccupants(vehicle);

  const hb = hitboxesFor(occupant.pos, occupant.height(), STANCE.CROUCH, occupant.yaw);
  const headY = hb.head.base[1] + hb.head.r;
  const sight = (eye, target) => {
    const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const l = Math.hypot(...d);
    return d.map(n => n / l);
  };
  const probe = (eye, target) => {
    const dir = sight(eye, target);
    const hull = rayVehicle(vehicle, eye, dir, 20);
    const ballistic = rayVehicleBallistic(vehicle, eye, dir, 20);
    const targets = game.buildTargets();
    const hit = nearestPlayerHit(eye, dir, ballistic ? ballistic.t : 20, targets,
      shooter.id, shooter.team, game.mode);
    return { hull, ballistic, hit };
  };

  const front = probe([0, 1.64, 8], [hb.head.base[0], headY, occupant.pos[2]]);
  assert.ok(front.hull, 'closed hull still contains the occupant');
  assert.equal(front.ballistic, null, 'windscreen is an opening for bullets');
  assert.equal(front.hit?.target.id, occupant.id);
  assert.equal(front.hit.zone, 'head');

  const side = probe([8, 1.64, occupant.pos[2]], [occupant.pos[0], headY, occupant.pos[2]]);
  assert.equal(side.ballistic, null, 'side glass is an opening for bullets');
  assert.equal(side.hit?.target.id, occupant.id);

  const door = probe([8, hb.legs.a[1], occupant.pos[2]],
    [occupant.pos[0], hb.legs.a[1], occupant.pos[2]]);
  assert.ok(door.ballistic, 'door below the beltline blocks the round');
  assert.equal(door.hit, null, 'occupant behind the door cannot be hit');
});

test('F3b: a windscreen shot damages the occupant through the live bullet path', () => {
  const game = new Game({ mode: 'tdm', seed: 5 });
  game.matchState = MATCH_STATE.LIVE;
  const shooter = addShooter(game, 'dmr', [0, 0, 8]);
  const occupant = addTarget(game, [0, 0, 0]);
  occupant.pos = [0, 0, 0];
  const vehicle = new Vehicle(game.nextId++, 0, 0, 0, 'car');
  vehicle.pos[1] = 0.6;
  game.vehicles.push(vehicle);
  game.enterVehicle(occupant, vehicle);
  game.carryVehicleOccupants(vehicle);
  // Isolate the vehicle hull: no terrain or buildings in the bullet path.
  game.world = {
    ...openWorld(),
    vehicles: game.vehicles,
    raycast: (o, d, max, opts) => opts?.ballistic
      ? rayVehicleBallistic(vehicle, o, d, max) : rayVehicle(vehicle, o, d, max),
  };

  const hb = hitboxesFor(occupant.pos, occupant.height(), STANCE.CROUCH, occupant.yaw);
  const eye = [0, 1.64, 8];
  const target = [hb.head.base[0], hb.head.base[1] + hb.head.r, occupant.pos[2]];
  const dir = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const l = Math.hypot(...dir);
  const hp = occupant.health;
  assert.equal(fire(game, shooter, Math.atan2(-dir[0], -dir[2]), Math.asin(dir[1] / l)), true);
  for (let i = 0; i < 5 && occupant.health === hp; i++) stepBullets(game, CFG.SIM_DT);
  assert.ok(occupant.health < hp, 'round through the windscreen reaches the occupant');
});

// ---------------------------------------------------------------------------
// F3c — ballistic vehicle geometry keeps solid structure (roof, chassis,
// pillars, truck tailgate) while opening only the glazed cabin.
// ---------------------------------------------------------------------------
test('F3c: ballistic vehicle geometry opens glazing and keeps structure solid', () => {
  const car = new Vehicle(1, 0, 0, 0, 'car');
  car.pos[1] = 0.6;
  const cast = (vehicle, origin, dir) => ({
    solid: rayVehicle(vehicle, origin, dir, 30),
    ballistic: rayVehicleBallistic(vehicle, origin, dir, 30),
  });

  assert.equal(cast(car, [8, 1.7, -0.15], [-1, 0, 0]).ballistic, null,
    'side glass is open to bullets');
  assert.ok(cast(car, [8, 0.7, -0.15], [-1, 0, 0]).ballistic,
    'side door below the beltline stays solid');
  assert.ok(cast(car, [8, 1.7, 1.95], [-1, 0, 0]).ballistic,
    'A/C pillar at the end of the window band stays solid');
  assert.ok(cast(car, [0, 10, -0.15], [0, -1, 0]).ballistic,
    'roof stays solid');
  assert.equal(cast(car, [0, 1.7, 8], [0, 0, -1]).ballistic, null,
    'windscreen is open');
  assert.ok(cast(car, [0, 0.5, 8], [0, 0, -1]).ballistic,
    'chassis below the glazing stays solid');

  const truck = new Vehicle(2, 0, 0, 0, 'truck');
  truck.pos[1] = 0.6;
  assert.ok(cast(truck, [0, 1.7, 8], [0, 0, -1]).ballistic,
    'truck tailgate/bed stays solid');
  const cabThrough = cast(truck, [0, 1.7, -8], [0, 0, 1]);
  assert.ok(cabThrough.ballistic, 'a cab-windscreen entry is stopped by the solid bed');
  assert.ok(cabThrough.ballistic.t > 8, 'the windscreen entry itself is open');
});

// A round may enter through glazing but must still stop at a solid exit face
// inside the same vehicle (roof, chassis, door, bed).
test('F3d: a window entry does not make a solid roof/hull exit transparent', () => {
  const car = new Vehicle(1, 0, 0, 0, 'car');
  car.pos[1] = 0.6;
  const dir = [0, 0.12, -1];
  const l = Math.hypot(...dir);
  const d = dir.map(n => n / l);
  const origin = [0, 1.0, 8];
  const solid = rayVehicle(car, origin, d, 30);
  const ballistic = rayVehicleBallistic(car, origin, d, 30);
  assert.ok(solid, 'the closed hull still intersects the path');
  assert.ok(ballistic, 'the roof exit must be reported');
  assert.ok(ballistic.t > solid.t, 'the entry through glazing is not blocked');
  assert.ok(Math.abs(ballistic.t - solid.tmax) < 1e-6,
    'the round stops at the solid exit face, not at the window');
  assert.ok(ballistic.point[1] > 1.9, 'the reported impact is at the roof');
  assert.ok(ballistic.normal[1] > 0.9, 'the impact normal points out of the roof');

  // Exiting through glazing on the opposite side stays open.
  assert.equal(rayVehicleBallistic(car, [8, 1.7, -0.15], [-1, 0, 0], 30), null,
    'opposite side glass does not block the round');
  // Firing out from inside the cabin uses the same exit rule.
  assert.equal(rayVehicleBallistic(car, [0, 1.1, 0], [0, 0, -1], 30), null,
    'an occupant can fire out through the windscreen');
  assert.ok(rayVehicleBallistic(car, [0, 1.1, 0], [0, 1, -1], 30),
    'an occupant cannot fire through the roof');
});

test('F3e: a live round entering through glass is stopped by the roof', () => {
  const game = liveGame();
  const shooter = addShooter(game, 'ar', [0, 0, 8]);
  shooter.pos[1] = 1.0 - shooter.eyeHeight(); // eye height 1.0 for this path
  const vehicle = new Vehicle(game.nextId++, 0, 0, 0, 'car');
  vehicle.pos[1] = 0.6;
  game.vehicles.push(vehicle);
  game.world = {
    ...openWorld(),
    vehicles: game.vehicles,
    raycast: (o, d, max, opts) => opts?.ballistic
      ? rayVehicleBallistic(vehicle, o, d, max) : rayVehicle(vehicle, o, d, max),
  };
  const dir = [0, 0.12, -1];
  const l = Math.hypot(...dir);
  dir[0] /= l; dir[1] /= l; dir[2] /= l;
  const hp = vehicle.health;
  assert.equal(fire(game, shooter, 0, Math.asin(dir[1])), true);
  const bullet = game.bullets[0];
  for (let i = 0; i < 4 && !bullet.dead; i++) stepBullets(game, CFG.SIM_DT);
  assert.equal(bullet.dead, true, 'the solid roof stops the round');
  assert.ok(vehicle.health < hp, 'the roof impact damages the vehicle');
  const impact = game.events.find(e => e.k === 'impact' && e.vid === vehicle.id);
  assert.ok(impact, 'the authoritative impact is reported');
  assert.ok(impact.y > 1.9, 'the impact is on the roof');
});

// ---------------------------------------------------------------------------
// F4 — penetration consumes the round's travel in the same slice instead of
// discarding everything after the exit point.
// ---------------------------------------------------------------------------
test('F4: penetrating a thin wall preserves the remaining travel in the tick', () => {
  const run = (walls) => {
    const world = {
      ...openWorld(),
      raycast(origin, dir, max) {
        const start = -origin[2], end = start + max;
        let best = null;
        for (const w of walls) {
          if (w.from >= start && w.from <= end && (!best || w.from < best.from)) best = w;
        }
        if (!best) return null;
        const t = best.from - start;
        return {
          t, tmax: t + (best.to - best.from),
          point: [origin[0], origin[1], origin[2] - t], normal: [0, 0, 1],
          box: { id: 1 }, tag: 'wall', mat: best.mat,
        };
      },
    };
    const game = liveGame(world);
    const shooter = addShooter(game, 'sniper');
    assert.equal(fire(game, shooter), true);
    const bullet = game.bullets[0];
    stepBullets(game, CFG.SIM_DT);
    return { dist: bullet.dist, alive: !bullet.dead, impacts: game.events.filter(e => e.k === 'impact').length };
  };
  const free = run([]);
  const wall = run([{ from: 2, to: 2.02, mat: 'wood' }]);
  assert.equal(wall.impacts, 1);
  assert.equal(wall.alive, true);
  assert.ok(wall.dist > 10, 'round continues well past the wall in the same tick');
  assert.ok(Math.abs(wall.dist - free.dist) < 0.2,
    `wall travel ${wall.dist} should match free travel ${free.dist}`);
});

// ---------------------------------------------------------------------------
// F5 — window glass is authoritative destructible cover with hit points.
// ---------------------------------------------------------------------------
test('F5: window glass takes damage, breaks once, and stops blocking', () => {
  const game = liveGame();
  const world = new Game({ seed: 20261104 }).world;
  const glass = world.boxes.find(b => b.tag === 'glass');
  assert.ok(glass, 'world contains window glass');
  assert.equal(glass.dynamic, true);
  assert.ok(glass.hp > 0);
  assert.equal(glass.kind, 'glass');

  const synthetic = {
    ...openWorld(),
    raycast: (o, d, max) => (!glass.destroyed && max > 0.1 ? {
      t: 0.4, tmax: 0.44, point: [o[0], o[1], o[2] - 0.4], normal: [0, 0, 1],
      box: glass, tag: glass.tag, mat: glass.mat,
    } : null),
  };
  game.world = synthetic;
  const shooter = addShooter(game, 'ar');
  const hp = glass.hp;

  for (let shot = 0; shot < 3 && !glass.destroyed; shot++) {
    shooter.cooldown = 0;
    assert.equal(fire(game, shooter), true);
    for (let i = 0; i < 4 && !glass.destroyed; i++) stepBullets(game, CFG.SIM_DT);
  }

  assert.ok(glass.hp < hp, 'bullets damage the pane');
  assert.equal(glass.destroyed, true, 'pane breaks after enough damage');
  assert.equal(game.destroyedBoxes.has(glass.id), true);
  assert.equal(game.events.filter(e => e.k === 'destroy').length, 1, 'destroy emits once');
  assert.equal(synthetic.raycast([0, 1, 0], [0, 0, -1], 5), null, 'broken pane no longer blocks');
});

// ---------------------------------------------------------------------------
// F6 — player hitboxes. Documented rule: the nearest capsule entry wins
// between torso and legs; the head sphere is checked first and keeps priority.
// ---------------------------------------------------------------------------
function hitFor(target, origin, dir) {
  return nearestPlayerHit(origin, dir, 100, [target], 1, 0, 'br');
}

function geometryTarget(pos, stance, height, yaw = 0) {
  return {
    id: 2, pos, height, stance, yaw, alive: true, team: 1,
    hitboxes: hitboxesFor(pos, height, stance, yaw),
  };
}

test('F6: standing and crouched zones classify from every approach', () => {
  for (const [stance, height] of [
    [STANCE.STAND, CFG.PLAYER.HEIGHT],
    [STANCE.CROUCH, CFG.PLAYER.CROUCH_HEIGHT],
  ]) {
    const t = geometryTarget([0, 0, 0], stance, height);
    const hb = t.hitboxes;
    const legsY = hb.legs.a[1] + 0.06; // below the torso capsule's lower cap
    const probes = [
      ['head', hb.head.base[1] + hb.head.r, 'head'],
      ['torso', (hb.torso.a[1] + hb.torso.b[1]) / 2, 'torso'],
      ['legs', legsY, 'legs'],
    ];
    for (const [label, y, zone] of probes) {
      for (const [dx, dz] of [[0, 3], [0, -3], [3, 0], [-3, 0]]) {
        const dir = dx ? [-Math.sign(dx), 0, 0] : [0, 0, -Math.sign(dz)];
        const hit = hitFor(t, [dx, y, dz], dir);
        assert.equal(hit && hit.zone, zone, `${stance} ${label} from ${dx},${dz}`);
      }
    }
  }
});

test('F6: prone hitboxes rotate with yaw and match the rendered body', () => {
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const t = geometryTarget([0, 0, 0], STANCE.PRONE, CFG.PLAYER.PRONE_HEIGHT, yaw);
    const hb = t.hitboxes;
    // Head sits at the front of the body; approach it from ahead.
    const head = [hb.head.base[0], hb.head.base[1] + hb.head.r, hb.head.base[2]];
    const hit = hitFor(t, [
      head[0] - Math.sin(yaw) * 3, head[1], head[2] - Math.cos(yaw) * 3,
    ], [Math.sin(yaw), 0, Math.cos(yaw)]);
    assert.equal(hit && hit.zone, 'head', `prone yaw ${yaw} head`);

    // Torso and legs are lateral: cast along the body's right vector.
    const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
    for (const zone of ['torso', 'legs']) {
      const a = hb[zone].a, b = hb[zone].b;
      const point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const hit2 = hitFor(t, [
        point[0] + right[0] * 3, point[1], point[2] + right[2] * 3,
      ], [-right[0], 0, -right[2]]);
      assert.equal(hit2 && hit2.zone, zone, `prone yaw ${yaw} ${zone}`);
    }
  }
});

test('F6: silhouette bounds, elevated targets and vehicle occupants', () => {
  const t = geometryTarget([0, 0, 0], STANCE.STAND, CFG.PLAYER.HEIGHT);
  const torsoY = (t.hitboxes.torso.a[1] + t.hitboxes.torso.b[1]) / 2;
  assert.equal(hitFor(t, [t.hitboxes.torso.r + 0.02, torsoY, 3], [0, 0, -1]), null,
    'a ray just outside the torso radius misses');

  const elevated = geometryTarget([0, 8, 0], STANCE.STAND, CFG.PLAYER.HEIGHT);
  const headY = elevated.hitboxes.head.base[1] + elevated.hitboxes.head.r;
  assert.equal(hitFor(elevated, [0, headY, 3], [0, 0, -1])?.zone, 'head',
    'hitboxes follow authoritative elevation');

  const game = liveGame();
  const p = addTarget(game, [0, 0, 0]);
  p.stance = STANCE.STAND;
  let target = game.buildTargets().find(x => x.id === p.id);
  assert.equal(target.stance, STANCE.STAND);
  assert.equal(target.height, CFG.PLAYER.HEIGHT);

  // Occupancy pins the combat stance to crouch at the seat, regardless of the
  // stance held before entering.
  p.inVehicle = 999;
  target = game.buildTargets().find(x => x.id === p.id);
  assert.equal(target.stance, STANCE.CROUCH);
  assert.equal(target.height, CFG.VEHICLE.occupantHeight);
  assert.equal(target.hitboxes.head.zone, 'head');

  p.inVehicle = 0;
  p.stance = STANCE.PRONE;
  target = game.buildTargets().find(x => x.id === p.id);
  assert.equal(target.height, CFG.PLAYER.PRONE_HEIGHT);
  assert.equal(target.hitboxes.torso.zone, 'torso');
});

// ---------------------------------------------------------------------------
// F7 — damage resolves at collision time, and in-flight rounds cannot cross a
// respawn into the next life.
// ---------------------------------------------------------------------------
test('F7: bullet damage is applied on arrival, not at fire time', () => {
  const game = liveGame();
  const shooter = addShooter(game, 'dmr');
  const target = addTarget(game, [0, 0, -10]);
  const hp = target.health;
  assert.equal(fire(game, shooter), true);
  assert.equal(target.health, hp, 'no damage at fire time');
  assert.equal(game.pendingDamage.length, 0, 'bullets do not use pending damage');
  assert.equal(game.events.some(e => e.k === 'hit'), false);
  for (let i = 0; i < 3 && target.health === hp; i++) stepBullets(game, CFG.SIM_DT);
  assert.ok(target.health < hp, 'damage is applied when the round arrives');
  assert.equal(game.events.some(e => e.k === 'hit'), true);
});

test('F7b: a round fired before a respawn cannot damage the new life', () => {
  const game = liveGame();
  const shooter = addShooter(game, 'dmr');
  const target = addTarget(game, [0, 0, -30]);
  assert.equal(fire(game, shooter), true);
  game.time += CFG.SIM_DT;
  game.kill(target, shooter.id, 'ar', 'torso', 30);
  game.time += CFG.SIM_DT;
  game.spawnPlayer(target, { x: 0, z: -30 });
  target.armor = 0;
  const hp = target.health;
  for (let i = 0; i < 10; i++) stepBullets(game, CFG.SIM_DT);
  assert.equal(target.health, hp, 'new life is immune to the old round');
});

test('F7c: multiple arriving rounds resolve deterministically and kill once', () => {
  const run = () => {
    const game = liveGame();
    const shooter = addShooter(game, 'dmr');
    const target = addTarget(game, [0, 0, -10]);
    target.health = 40;
    assert.equal(fire(game, shooter), true);
    shooter.cooldown = 0;
    assert.equal(fire(game, shooter), true);
    for (let i = 0; i < 3; i++) stepBullets(game, CFG.SIM_DT);
    return {
      alive: target.alive,
      kills: game.events.filter(e => e.k === 'kill').length,
      hp: target.health,
    };
  };
  const a = run(), b = run();
  assert.deepEqual(a, b);
  assert.equal(a.alive, false);
  assert.equal(a.kills, 1, 'only one kill event despite two rounds');
});

// An ineligible target (old life or a spawn after launch) must be removed from
// the ray before the sweep. Skipping it with `travelled += ph.t + 0.02` burns
// the penetration guard and cuts the tick's travel short.
test('F7d: an ineligible respawned target does not slow an in-flight round', () => {
  const respawnAhead = (game, shooter, target, z) => {
    game.time += CFG.SIM_DT;
    game.kill(target, shooter.id, 'pistol', 'torso', Math.abs(z));
    game.time += CFG.SIM_DT;
    game.spawnPlayer(target, { x: 0, z });
    target.pos = [0, 0, z];
    target.armor = 0;
  };
  const travel = (withRespawn) => {
    const game = liveGame();
    const shooter = addShooter(game, 'pistol');
    const target = withRespawn ? addTarget(game, [0, 0, -1.9]) : null;
    assert.equal(fire(game, shooter), true);
    if (target) respawnAhead(game, shooter, target, -1.9);
    stepBullets(game, CFG.SIM_DT);
    return { game, target, bullet: game.bullets[0] };
  };

  const baseline = travel(false);
  const respawned = travel(true);
  assert.ok(baseline.bullet && respawned.bullet);
  assert.ok(respawned.target.spawnTime > respawned.bullet.bornAt,
    'the target respawned after the round was launched');
  assert.equal(respawned.target.health, 100, 'the new life is not damaged');
  assert.ok(Math.abs(respawned.bullet.dist - baseline.bullet.dist) < 1e-9,
    'one 60 Hz tick travels the same distance as an unobstructed round');
});

test('F7e: an ineligible target does not hide a valid target behind it', () => {
  const game = liveGame();
  const shooter = addShooter(game, 'pistol');
  const stale = addTarget(game, [0, 0, -1.9]);
  const valid = addTarget(game, [0, 0, -5]);
  assert.equal(fire(game, shooter), true);
  game.time += CFG.SIM_DT;
  game.kill(stale, shooter.id, 'pistol', 'torso', 1.9);
  game.time += CFG.SIM_DT;
  game.spawnPlayer(stale, { x: 0, z: -1.9 });
  stale.pos = [0, 0, -1.9];
  stale.armor = 0;

  const bullet = game.bullets[0];
  stepBullets(game, CFG.SIM_DT);
  assert.equal(stale.health, 100, 'the old life is not hit');
  assert.ok(valid.health < 100, 'the valid target behind it is hit');
  assert.equal(bullet.dead, true, 'the valid target stops the round normally');
});

test('F7f: an ineligible target does not hide world geometry behind it', () => {
  const wallAt = (z) => ({
    ...openWorld(),
    raycast(origin, dir, max) {
      if (dir[2] >= -1e-9) return null;
      const t = (z - origin[2]) / dir[2];
      if (t <= 0 || t > max) return null;
      return {
        t, tmax: t + 0.05,
        point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, z],
        normal: [0, 0, 1], box: null, tag: 'wall', mat: 'concrete',
      };
    },
  });
  const game = liveGame(wallAt(-3));
  const shooter = addShooter(game, 'pistol');
  const stale = addTarget(game, [0, 0, -1.9]);
  assert.equal(fire(game, shooter), true);
  game.time += CFG.SIM_DT;
  game.kill(stale, shooter.id, 'pistol', 'torso', 1.9);
  game.time += CFG.SIM_DT;
  game.spawnPlayer(stale, { x: 0, z: -1.9 });
  stale.pos = [0, 0, -1.9];
  stale.armor = 0;

  const bullet = game.bullets[0];
  stepBullets(game, CFG.SIM_DT);
  const impact = game.events.find(e => e.k === 'impact');
  assert.equal(stale.health, 100, 'the old life is not hit');
  assert.ok(impact, 'the wall behind the ineligible target is hit');
  assert.ok(Math.abs(impact.z - (-3)) < 1e-9, 'the impact is at the wall');
  assert.equal(bullet.dead, true, 'the wall stops the round normally');
});

// ---------------------------------------------------------------------------
// F8 — bot lead math now matches the persistent projectile timeline.
// ---------------------------------------------------------------------------
test('F8: bot-style lead hits a moving target under persistent bullets', () => {
  const game = liveGame();
  const shooter = addShooter(game, 'ar');
  const target = addTarget(game, [0, 0, -40]);
  target.vel = [7, 0, 0];
  const W = CFG.WEAPONS.ar;
  // Bots only engage inside 85 m, where a single-shot lead is close to exact.
  const d = 40;
  const eye = [0, 1.64, 0];
  const lead = Math.min(0.35, d / W.mv);
  const tx = target.pos[0] + target.vel[0] * lead;
  const tz = target.pos[2] + target.vel[2] * lead;
  const ty = target.pos[1] + target.height() * 0.62 + target.vel[1] * lead;
  const dx = tx - eye[0], dy = ty - eye[1], dz = tz - eye[2];
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, Math.hypot(dx, dz)) +
    0.5 * 9.81 * (W.grav ?? 1) * (d / W.mv) ** 2 / Math.max(1, d);
  assert.equal(fire(game, shooter, yaw, pitch), true);
  const hp = target.health;
  for (let i = 0; i < 30; i++) {
    target.pos[0] += target.vel[0] * CFG.SIM_DT;
    stepBullets(game, CFG.SIM_DT);
  }
  assert.ok(target.health < hp, 'bot-style led aim reaches the moving target');
});
