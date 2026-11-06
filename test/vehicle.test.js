import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, Vehicle, emptyInput } from '../shared/sim.js';
import { CFG, MATCH_STATE } from '../shared/config.js';
import { rayVehicle, packVehicle, vehiclePairContact } from '../shared/vehicle.js';
import { tryFire, explode, stepBullets } from '../shared/weapons.js';

function fixture(boxes = []) {
  const game = new Game({ mode: 'tdm' });
  game.world = {
    terrainHeight: () => 0, terrainNormal: () => [0, 1, 0],
    waterDepth: () => 0, lake: { level: -100 },
    queryBoxes: (x0, z0, x1, z1) => boxes.filter(b => b.min[0] <= x1 && b.max[0] >= x0 && b.min[2] <= z1 && b.max[2] >= z0),
    lineOfSight: () => true, raycast: () => null,
  };
  game.matchState = MATCH_STATE.LIVE;
  const player = game.addPlayer('Driver', 0, { forceSpawn: { x: 0, z: 0 } });
  player.yaw = 0;
  const vehicle = new Vehicle(game.nextId++, 0, 0);
  vehicle.pos[1] = .6;
  game.vehicles.push(vehicle);
  game.world.vehicles = game.vehicles;
  return { game, player, vehicle };
}
const drive = (game, player, vehicle, input, ticks) => {
  const inputs = new Map([[player.id, { ...emptyInput(), ...input }]]);
  for (let i = 0; i < ticks; i++) game.stepVehicle(vehicle, inputs, CFG.SIM_DT);
};
const overlaps = (pos, b, radius = CFG.PLAYER.RADIUS) => {
  const x = Math.max(b.min[0], Math.min(pos[0], b.max[0]));
  const z = Math.max(b.min[2], Math.min(pos[2], b.max[2]));
  return Math.hypot(pos[0] - x, pos[2] - z) < radius && pos[1] < b.max[1] && pos[1] + CFG.PLAYER.HEIGHT > b.min[1];
};

test('vehicle entry requires a live nearby player and a usable unoccupied seat', () => {
  const { game, player, vehicle } = fixture();
  player.alive = false;
  assert.equal(game.enterVehicle(player, vehicle), false);
  player.alive = true; player.pos[1] = 20;
  assert.equal(game.enterVehicle(player, vehicle), false, 'no entry from another floor');
  player.pos[1] = 0; vehicle.health = 0;
  assert.equal(game.enterVehicle(player, vehicle), false, 'wreck cannot be driven');
  vehicle.health = CFG.VEHICLE.health;
  assert.equal(game.enterVehicle(player, vehicle), true);
  assert.equal(player.seat, 0);
  assert.equal(vehicle.occupants[0], player.id);
});

test('exit chooses a clear side and death releases the occupied seat', () => {
  const wall = { min: [1.2, 0, -4], max: [3, 4, 4], tag: 'wall' };
  const { game, player, vehicle } = fixture([wall]);
  game.enterVehicle(player, vehicle);
  game.exitVehicle(player);
  assert.equal(player.inVehicle, null);
  assert.ok(!overlaps(player.pos, wall), `exit intersects wall at ${player.pos}`);
  player.pos = [0, 0, 0];
  game.enterVehicle(player, vehicle);
  game.kill(player, -1, 'fixture');
  assert.equal(vehicle.occupants.includes(player.id), false);
  assert.equal(player.inVehicle, null);
});

test('acceleration, braking and reverse obey separate speed limits', () => {
  const { game, player, vehicle } = fixture();
  game.enterVehicle(player, vehicle);
  drive(game, player, vehicle, { f: true }, 600);
  assert.ok(-vehicle.vel[2] > 12);
  assert.ok(Math.hypot(vehicle.vel[0], vehicle.vel[2]) <= CFG.VEHICLE.maxSpeed + .01);
  drive(game, player, vehicle, { b: true }, 900);
  assert.ok(vehicle.vel[2] > 1, 'S must brake then reverse');
  assert.ok(vehicle.vel[2] <= CFG.VEHICLE.reverseMax + .01, `reverse ${vehicle.vel[2]} exceeds limit`);
});

test('reverse steering reverses yaw response and wheel rotation integrates once per tick', () => {
  const { game, player, vehicle } = fixture();
  game.enterVehicle(player, vehicle);
  vehicle.vel = [0, 0, 4];
  drive(game, player, vehicle, { l: true, b: true }, 30);
  assert.ok(vehicle.yaw < 0, `reversing left should turn yaw negative, got ${vehicle.yaw}`);
  vehicle.yaw = 0; vehicle.steer = 0; vehicle.vel = [0, 0, -4]; vehicle.wheelSpin = 0;
  game.stepVehicle(vehicle, new Map(), CFG.SIM_DT);
  assert.ok(Math.abs(vehicle.wheelSpin) <= 4.1 * CFG.SIM_DT / CFG.VEHICLE.wheelRadius,
    'wheel spin must not be added separately for all four suspension rays');
});

test('suspension supports weight on flat ground without relying on the floor clamp', () => {
  const { game, player, vehicle } = fixture();
  drive(game, player, vehicle, {}, 480);
  const spring = vehicle.wheelComp.reduce((sum, c) => sum + Math.max(0, c) * CFG.VEHICLE.suspensionK, 0);
  const weight = CFG.VEHICLE.mass * 9.81;
  assert.ok(Math.abs(spring - weight) < weight * .05, `spring ${spring}, weight ${weight}`);
  assert.ok(Math.abs(vehicle.vel[1]) < .03);
  assert.ok(vehicle.pos.every(Number.isFinite));
});

test('the car nose stops before a wall and the complete footprint stays inside map bounds', () => {
  const wall = { min: [-10, 0, -5], max: [10, 4, -4.8], tag: 'wall' };
  const { game, player, vehicle } = fixture([wall]);
  game.enterVehicle(player, vehicle);
  vehicle.vel = [0, 0, -18];
  for (let i = 0; i < 90; i++) {
    drive(game, player, vehicle, { f: true }, 1);
    assert.ok(vehicle.pos[2] - 2.1 >= wall.max[2] - .03, `nose penetrates wall at tick${i}: ${vehicle.pos[2]}`);
  }
  vehicle.pos = [490, .6, 0]; vehicle.yaw = -Math.PI / 2; vehicle.vel = [26, 0, 0];
  drive(game, player, vehicle, { f: true }, 60);
  assert.ok(vehicle.pos[0] + 2.1 <= CFG.MAP.BOUNDS + .03);
});

test('the driver cannot fire an invisible weapon while controlling the vehicle', () => {
  const { game, player, vehicle } = fixture();
  game.enterVehicle(player, vehicle);
  const before = player.inv.ar.mag;
  game.stepPlayer(player, { ...emptyInput(), shoot: true }, CFG.SIM_DT);
  assert.equal(player.inv.ar.mag, before);
});

test('players collide with parked vehicles and submerged engines lose propulsion', () => {
  const { game, player, vehicle } = fixture();
  player.pos = [-4, 0, 0]; player.yaw = -Math.PI / 2; player.grounded = true;
  const input = { ...emptyInput(), f: true, yaw: -Math.PI / 2 };
  for (let i = 0; i < 180; i++) game.stepPlayer(player, input, CFG.SIM_DT);
  assert.ok(player.pos[0] <= -.95 - CFG.PLAYER.RADIUS + .01);
  game.enterVehicle(player, vehicle);
  game.world.waterDepth = () => 3; game.world.lake.level = 3;
  vehicle.vel = [0, 0, -8];
  drive(game, player, vehicle, { f: true }, 180);
  assert.equal(vehicle.submerged, true);
  assert.ok(Math.hypot(vehicle.vel[0], vehicle.vel[2]) < .1);
});

test('shots damage the vehicle hull and destruction emits once with seats released', () => {
  const { game, player, vehicle } = fixture();
  player.pos = [0, 0, 10];
  player.grounded = true; player.adsing = true;
  player.pitch = -.08; // aim into the centre of the hull, not over the roof
  game.world.raycast = (origin, direction, max) => rayVehicle(vehicle, origin, direction, max);
  const hp = vehicle.health;
  tryFire(game, player, { ...emptyInput(), shoot: true }, []);
  assert.equal(vehicle.health, hp, 'damage is deferred until the bullet arrives');
  stepBullets(game, CFG.SIM_DT);
  assert.ok(vehicle.health < hp, 'hull must receive authoritative ballistic damage');
  player.pos = [0, 0, 0];
  game.enterVehicle(player, vehicle);
  explode(game, [0, .6, 0], 500, 7, -1);
  assert.equal(vehicle.health, 0);
  assert.equal(game.events.filter(e => e.k === 'vehicleDestroyed').length, 1);
  assert.equal(vehicle.occupants.includes(player.id), false);
  assert.equal(packVehicle(vehicle).health, 0);
});

test('vehicle-to-vehicle impact separates hulls and exchanges normal momentum', () => {
  const { game, vehicle } = fixture();
  const other = new Vehicle(game.nextId++, 0, -4);
  other.pos[1] = .6;
  vehicle.vel[2] = -10;
  game.vehicles.push(other);
  assert.ok(vehiclePairContact(vehicle, other));
  game.resolveVehiclePairs();
  assert.equal(vehiclePairContact(vehicle, other), null);
  assert.ok(other.vel[2] < 0);
  assert.ok(vehicle.vel[2] > -10);
});
