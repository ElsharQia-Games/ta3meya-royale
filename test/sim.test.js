// Unit tests for core sim math — run with `node --test test/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../shared/sim.js';
import { CFG } from '../shared/config.js';

const idle = { f: false, b: false, l: false, r: false, jump: false, sprint: false, ads: false, shoot: false, yaw: 0, pitch: 0, reload: false, grenade: false, heal: false, switch: -1, stance: null };

test('player falls to terrain and grounds', () => {
  const g = new Game(); const p = g.addPlayer('a', 10, 10);
  p.pos[1] += 5;
  for (let i = 0; i < 120; i++) g.step(new Map([[p.id, idle]]), CFG.SIM_DT);
  assert.equal(p.grounded, true);
  assert.ok(Math.abs(p.pos[1] - g.world.terrainH(10, 10)) < 0.05);
});

test('movement speed capped (no speed hack)', () => {
  const g = new Game(); const p = g.addPlayer('a', 0, 0);
  const inp = { ...idle, f: true, sprint: true };
  for (let i = 0; i < 300; i++) g.step(new Map([[p.id, inp]]), CFG.SIM_DT);
  const sp = Math.hypot(p.vel[0], p.vel[2]);
  assert.ok(sp <= CFG.PLAYER.SPRINT + 0.3, `speed ${sp} exceeds sprint max`);
});

test('shooting consumes ammo and damages in line of sight', () => {
  const g = new Game(); const a = g.addPlayer('a', 0, 0); const b = g.addPlayer('b', 0, -20);
  a.yaw = 0; // facing -Z
  const shot = { ...idle, shoot: true, yaw: 0, pitch: 0 };
  const hp0 = b.health;
  g.step(new Map([[a.id, shot]]), CFG.SIM_DT);
  assert.equal(a.inv[a.weapons[a.curW]].mag, CFG.WEAPONS[a.weapons[a.curW]].mag - 1);
  // projectile/hitscan resolution may hit depending on spread; force a clean shot:
  a.yaw = Math.atan2(-(b.pos[0] - a.pos[0]), -(b.pos[2] - a.pos[2]));
  for (let i = 0; i < 40; i++) { a.cooldown = 0; g.step(new Map([[a.id, { ...shot, yaw: a.yaw }]]), CFG.SIM_DT); }
  assert.ok(b.health < hp0, 'target took damage');
});

test('zone damages players outside', () => {
  const g = new Game(); const p = g.addPlayer('a', 900, 900); // outside initial zone r=330
  g.zone.r = 50; g.zone.phase = 2; g.zone.shrinking = true; g.zone.phaseT = 0;
  const hp0 = p.health;
  for (let i = 0; i < 120; i++) g.step(new Map(), CFG.SIM_DT);
  assert.ok(p.health < hp0, 'zone should damage outside players');
});

test('grenade explodes and hurts in radius', () => {
  const g = new Game(); const a = g.addPlayer('a', 0, 0);
  const hp0 = a.health;
  g.projectiles.push({ pos: [a.pos[0], a.pos[1] + 0.5, a.pos[2]], vel: [0, 0, 0], owner: a.id, type: 'grenade', fuse: 0.01, bounces: 0 });
  for (let i = 0; i < 10; i++) g.step(new Map(), CFG.SIM_DT);
  assert.ok(a.health < hp0);
});

test('heal restores health over time', () => {
  const g = new Game(); const p = g.addPlayer('a', 0, 0); p.health = 40;
  g.step(new Map([[p.id, { ...idle, heal: true }]]), CFG.SIM_DT);
  for (let i = 0; i <= CFG.HEAL.time / CFG.SIM_DT + 10; i++) g.step(new Map([[p.id, idle]]), CFG.SIM_DT);
  assert.ok(p.health > 40);
});

test('two runs of identical inputs produce identical state (deterministic)', () => {
  const run = () => {
    const g = new Game(42); const p = g.addPlayer('a', 5, 5);
    const inp = new Map([[p.id, { ...idle, f: true, sprint: true, shoot: true }]]);
    for (let i = 0; i < 240; i++) g.step(new Map(inp), CFG.SIM_DT);
    return [p.pos[0].toFixed(4), p.pos[2].toFixed(4), p.health];
  };
  assert.deepEqual(run(), run());
});
