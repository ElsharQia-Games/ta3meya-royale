import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, emptyInput, Vehicle } from '../shared/sim.js';
import { CFG, MATCH_STATE } from '../shared/config.js';
import { tryFire, stepProjectiles } from '../shared/weapons.js';
import { rayVehicle } from '../shared/vehicle.js';

function fixture(mode = 'tdm') {
  const game = new Game({ mode, seed: 223 });
  game.world = { terrainHeight: () => 0, terrainNormal: () => [0, 1, 0], waterDepth: () => 0,
    lake: { level: -100 }, boxes: [], queryBoxes: () => [], lineOfSight: () => true, raycast: () => null };
  game.matchState = MATCH_STATE.LIVE;
  const shooter = game.addPlayer('Lancer', 0, { kit: 'heavy', forceSpawn: { x: 0, z: 0 } });
  shooter.giveLoadout(['rpg', 'pistol']); shooter.pos[1] = 0; shooter.yaw = 0; shooter.pitch = 0; shooter.grounded = true; shooter.adsing = true;
  const target = game.addPlayer('Target', 1, { connected: false, forceSpawn: { x: 0, z: -24 } });
  target.pos[1] = 0; target.armor = 0;
  return { game, shooter, target };
}
const fire = (game, shooter) => tryFire(game, shooter, { ...emptyInput(), shoot: true }, game.buildTargets(), { rng: { next: () => 0 } });

test('launcher creates one travelling rocket and cannot apply hitscan damage', () => {
  const { game, shooter, target } = fixture();
  assert.equal(fire(game, shooter), true);
  assert.equal(shooter.inv.rpg.mag, 0);
  assert.equal(game.projectiles.length, 1);
  assert.equal(game.projectiles[0].type, 'rocket');
  assert.equal(game.pendingDamage.length, 0);
  assert.equal(target.health, 100);
  stepProjectiles(game, CFG.SIM_DT);
  assert.ok(game.projectiles[0].pos[2] < -1);
  assert.equal(target.health, 100, 'distant hit must wait for the flying rocket');
  assert.equal(fire(game, shooter), false);
});

test('swept live rocket hit detonates once and attributes the launcher kill', () => {
  const { game, shooter, target } = fixture(); fire(game, shooter);
  for (let i = 0; i < 90; i++) { game.time += CFG.SIM_DT; stepProjectiles(game, CFG.SIM_DT); }
  assert.equal(target.alive, false);
  assert.equal(game.projectiles.length, 0);
  assert.equal(game.events.filter(e => e.k === 'boom').length, 1);
  assert.equal(game.events.find(e => e.k === 'kill')?.w, 'rpg');
});

test('moving out of a flying rocket trajectory avoids a direct hit', () => {
  const { game, shooter, target } = fixture(); fire(game, shooter);
  target.pos[0] = 30;
  for (let i = 0; i < 25; i++) stepProjectiles(game, CFG.SIM_DT);
  assert.equal(target.health, 100);
  assert.equal(game.events.filter(e => e.k === 'hit').length, 0);
});

test('rockets stop on thin cover and cannot tunnel into a player behind it', () => {
  const { game, shooter, target } = fixture();
  const wall = { id: 0, min: [-3, 0, -6.1], max: [3, 3, -6], mat: 'concrete', tag: 'wall' };
  game.world.raycast = (origin, direction, max) => {
    const t = (-6 - origin[2]) / direction[2];
    return t >= 0 && t <= max ? { t, point: origin.map((n, i) => n + direction[i] * t), normal: [0, 0, 1], box: wall, mat: 'concrete' } : null;
  };
  fire(game, shooter);
  for (let i = 0; i < 30; i++) stepProjectiles(game, CFG.SIM_DT);
  assert.equal(target.health, 100);
  assert.ok(Math.abs(game.events.find(e => e.k === 'boom').z + 6) < .1);
});

test('RPG blast damages a vehicle hull and preserves TDM friendly-fire rules', () => {
  const { game, shooter, target } = fixture();
  const friend = game.addPlayer('Friendly', 0, { forceSpawn: { x: 2, z: -19 } }); friend.armor = 0;
  const vehicle = new Vehicle(game.nextId++, 0, -20); vehicle.pos[1] = .59;
  game.vehicles.push(vehicle);
  target.pos[0] = 40;
  game.world.raycast = (o, d, max) => rayVehicle(vehicle, o, d, max);
  fire(game, shooter);
  for (let i = 0; i < 45; i++) stepProjectiles(game, CFG.SIM_DT);
  assert.ok(vehicle.health < CFG.VEHICLE.health - 250, `hull health ${vehicle.health}`);
  assert.equal(friend.health, 100);
});

test('launcher misses expire and cannot accumulate unbounded projectiles', () => {
  const { game, shooter, target } = fixture(); target.pos[0] = 40; fire(game, shooter);
  for (let i = 0; i < 400; i++) stepProjectiles(game, CFG.SIM_DT);
  assert.equal(game.projectiles.length, 0);
  assert.equal(game.events.filter(e => e.k === 'projectileend').length, 1);
});

test('validated combat kits persist through respawn and BR stays loot-based', () => {
  const game = new Game({ mode: 'tdm' });
  for (const key of Object.keys(CFG.KITS)) {
    const p = game.addPlayer(key, 0, { kit: key });
    assert.deepEqual(p.weapons, CFG.KITS[key].weapons);
    game.kill(p, -1, 'fixture'); game.time = p.respawnAt + .1; game.stepRespawns();
    assert.deepEqual(p.weapons, CFG.KITS[key].weapons);
  }
  assert.deepEqual(game.addPlayer('invalid', 0, { kit: '__proto__' }).weapons, CFG.KITS.assault.weapons);
  const br = new Game({ mode: 'br' });
  assert.deepEqual(br.addPlayer('Heavy', 0, { kit: 'heavy' }).weapons, ['pistol', null]);
});
