import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, emptyInput } from '../shared/sim.js';
import { CFG, MATCH_STATE, STANCE } from '../shared/config.js';

function inputsFor(game, pattern, tick) {
  const map = new Map();
  for (const p of game.players.values()) {
    const i = emptyInput();
    i.yaw = Math.sin(tick * 0.01 + p.id) * 3;
    i.pitch = Math.cos(tick * 0.013) * 0.2;
    i.f = pattern.f ?? true;
    i.sprint = pattern.sprint ?? false;
    i.jump = pattern.jump ? tick % 90 === 0 : false;
    map.set(p.id, i);
  }
  return map;
}

function makeGame(mode = 'br') {
  const g = new Game({ mode, seed: 424242 });
  g.addPlayer('Alpha', 0);
  g.addPlayer('Bravo', 0);
  return g;
}

test('two identical games stay deterministic under identical inputs', () => {
  const a = makeGame(), b = makeGame();
  a.begin(); b.begin();
  for (let tick = 0; tick < 300; tick++) {
    const ia = inputsFor(a, { f: true, sprint: tick % 120 < 60, jump: tick % 150 === 0 }, tick);
    const ib = inputsFor(b, { f: true, sprint: tick % 120 < 60, jump: tick % 150 === 0 }, tick);
    a.step(ia, CFG.SIM_DT);
    b.step(ib, CFG.SIM_DT);
  }
  assert.equal(a.players.size, b.players.size);
  for (const [id, pa] of a.players) {
    const pb = b.players.get(id);
    assert.ok(pb);
    for (let k = 0; k < 3; k++) assert.equal(pa.pos[k], pb.pos[k], `player ${id} axis ${k}`);
    assert.equal(pa.vel[0], pb.vel[0]);
    assert.equal(pa.vel[1], pb.vel[1]);
    assert.equal(pa.vel[2], pb.vel[2]);
    assert.equal(pa.health, pb.health);
    assert.equal(pa.stance, pb.stance);
  }
  assert.equal(a.tick, b.tick);
  assert.equal(a.time, b.time);
});

test('movement keeps the player on the terrain and inside the map bounds', () => {
  const g = makeGame();
  for (let tick = 0; tick < 600; tick++) {
    g.step(inputsFor(g, { f: true, sprint: true }, tick), CFG.SIM_DT);
  }
  for (const p of g.players.values()) {
    const ground = g.world.terrainHeight(p.pos[0], p.pos[2]);
    assert.ok(p.pos[1] >= ground - 0.5, `player ${p.id} below terrain`);
    assert.ok(Math.abs(p.pos[0]) <= CFG.MAP.BOUNDS + 1);
    assert.ok(Math.abs(p.pos[2]) <= CFG.MAP.BOUNDS + 1);
    assert.ok(Number.isFinite(p.pos[1]));
  }
});

test('sprint does not exceed the configured speed cap', () => {
  const g = makeGame();
  let max = 0;
  for (let tick = 0; tick < 240; tick++) {
    g.step(inputsFor(g, { f: true, sprint: true }, tick), CFG.SIM_DT);
    for (const p of g.players.values()) max = Math.max(max, Math.hypot(p.vel[0], p.vel[2]));
  }
  assert.ok(max <= CFG.PLAYER.SPRINT + 0.25, `max speed ${max}`);
});

test('stance changes apply and crouch lowers the eye height', () => {
  const g = makeGame();
  const p = g.players.get(1);
  const standEye = p.eyeHeight();
  for (let tick = 0; tick < 60; tick++) {
    const map = inputsFor(g, {}, tick);
    map.get(p.id).stance = STANCE.CROUCH;
    g.step(map, CFG.SIM_DT);
  }
  assert.equal(p.stance, STANCE.CROUCH);
  assert.ok(p.eyeHeight() < standEye);
});

test('zone waits, then shrinks toward the configured radius', () => {
  const g = makeGame();
  g.begin();
  g.matchState = MATCH_STATE.LIVE;
  const startR = g.zone.r;
  for (let i = 0; i < 50; i++) g.stepZone(1);
  assert.equal(g.zone.shrinking, true);
  for (let i = 0; i < 50; i++) g.stepZone(1);
  assert.ok(g.zone.r < startR, `zone did not shrink: ${g.zone.r}`);
  assert.ok(g.zone.phase >= 1);
  assert.ok(g.zone.r >= CFG.ZONE.phases[0].r - 1);
});

test('players outside the zone take damage over time', () => {
  const g = makeGame();
  g.begin();
  g.matchState = MATCH_STATE.LIVE;
  const p = g.players.get(1);
  p.pos = [g.zone.cx + g.zone.r + 20, 10, g.zone.cz];
  const before = p.health;
  for (let i = 0; i < 10; i++) g.stepZone(1);
  assert.ok(p.health < before, `hp ${p.health} should drop`);
});

test('TDM respawns dead players after the respawn delay', () => {
  const g = new Game({ mode: 'tdm', seed: 7 });
  g.addPlayer('A', 0); g.addPlayer('B', 1);
  g.begin();
  g.matchState = MATCH_STATE.LIVE;
  const p = g.players.get(1);
  g.kill(p, 2, 'ar', 'torso', 10);
  assert.equal(p.alive, false);
  assert.ok(p.respawnAt > g.time);
  g.time = p.respawnAt + 0.01;
  g.stepRespawns();
  assert.equal(p.alive, true);
  assert.equal(p.health, CFG.PLAYER.MAX_HEALTH);
  assert.deepEqual(p.weapons, ['ar', 'pistol']);
});

test('BR ends when one player remains', () => {
  const g = makeGame();
  g.begin();
  g.matchState = MATCH_STATE.LIVE;
  g.kill(g.players.get(2), 1, 'ar', 'torso', 10);
  g.checkMatchEnd();
  assert.equal(g.matchState, MATCH_STATE.ENDED);
  assert.equal(g.winner.id, 1);
});

test('kill events and score are recorded', () => {
  const g = makeGame();
  g.begin();
  g.matchState = MATCH_STATE.LIVE;
  g.kill(g.players.get(2), 1, 'dmr', 'head', 42);
  const kill = g.events.find(e => e.k === 'kill');
  assert.ok(kill);
  assert.equal(kill.killer, 1);
  assert.equal(kill.victim, 2);
  assert.equal(kill.zone, 'head');
  assert.equal(g.players.get(1).kills, 1);
  assert.equal(g.players.get(2).deaths, 1);
});

test('snapshot packing exposes the fields the client needs', () => {
  const g = makeGame();
  g.begin();
  g.matchState = MATCH_STATE.LIVE;
  g.step(new Map(), CFG.SIM_DT);
  const packed = g.pack();
  assert.equal(packed.players.length, 2);
  assert.equal(packed.mode, 'br');
  assert.equal(packed.state, MATCH_STATE.LIVE);
  assert.ok(packed.zone && typeof packed.zone.r === 'number');
  assert.ok(Array.isArray(packed.vehicles));
  assert.ok(Array.isArray(packed.projectiles));
  const p = packed.players[0];
  for (const key of ['id', 'x', 'y', 'z', 'yaw', 'pitch', 'hp', 'alive', 'stance']) {
    assert.ok(key in p, `missing ${key}`);
  }
});

test('removing a player drops their vehicle seat and map entry', () => {
  const g = makeGame();
  g.begin();
  g.spawnVehicles();
  const p = g.players.get(1);
  const v = g.vehicles[0];
  v.pos = p.pos.slice();
  assert.equal(g.enterVehicle(p, v), true);
  assert.equal(p.inVehicle, v.id);
  g.removePlayer(p.id);
  assert.equal(g.players.has(p.id), false);
  assert.equal(v.occupants.includes(p.id), false);
});
