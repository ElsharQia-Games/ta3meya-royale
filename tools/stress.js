// Long-run simulation stress: 32 players, 30 simulated minutes at 60 Hz.
//
//   npm run stress            # full 108,000 ticks
//   STRESS_SECONDS=60 npm run stress
//
// Drives the real shared Game + bot AI with no network and no renderer.
// Asserts finite state, map containment, no teleports and no ground
// penetration, and reports wall-clock cost per tick.
import { Game } from '../shared/sim.js';
import { CFG } from '../shared/config.js';
import { spawnBots, stepBots } from '../server/bots.js';
import { writeFileSync } from 'node:fs';

const SECONDS = Number(process.env.STRESS_SECONDS || 30 * 60);
const TICKS = Math.round(SECONDS * CFG.SIM_HZ);
const BOTS = Number(process.env.STRESS_BOTS || 31);
const DT = CFG.SIM_DT;
const BOUND = CFG.MAP.BOUNDS + 1;

const game = new Game({ mode: 'br', mapSeed: CFG.MAP.SEED, seed: 0x5eed });
const human = game.addPlayer('Stress', 0, { connected: true });
const navStart = performance.now();
spawnBots(game, BOTS, false);
const navigationBootMs = performance.now() - navStart;
game.begin();
game.matchState = 2; // LIVE

const inputs = new Map();
const humanInput = {
  f: true, b: false, l: false, r: false, jump: false, sprint: true,
  ads: false, shoot: false, reload: false, grenade: false, smoke: false,
  heal: false, interact: false, cycle: false, slot: -1, stance: 0,
  yaw: 0, pitch: 0, seq: 0,
};

let teleports = 0, penetrations = 0, nonFinite = 0, outOfBounds = 0;
let maxStep = 0, totalTicks = 0;
let respawns = 0;
const tickTimes = [];
const overBudget = [];
let vehicleNonFinite = 0, vehicleOutOfBounds = 0, vehicleGroundPenetrations = 0;
const t0 = performance.now();

for (let tick = 0; tick < TICKS; tick++) {
  const prev = new Map();
  for (const p of game.players.values()) prev.set(p.id, [p.pos[0], p.pos[1], p.pos[2]]);

  humanInput.seq++;
  humanInput.yaw = (tick * 0.001) % (Math.PI * 2);
  humanInput.pitch = -0.05;
  humanInput.jump = tick % 180 === 0;
  humanInput.shoot = tick % 240 < 30;
  inputs.clear();
  if (human.alive) inputs.set(human.id, humanInput);
  const simStart = performance.now();
  stepBots(game, DT, inputs);
  const afterBots = performance.now();
  game.step(inputs, DT);
  const elapsed = performance.now() - simStart;
  tickTimes.push(elapsed);
  if (elapsed > 1000 / CFG.SIM_HZ) overBudget.push({ tick, ms: +elapsed.toFixed(3),
    botMs: +(afterBots - simStart).toFixed(3), gameMs: +(performance.now() - afterBots).toFixed(3) });
  totalTicks++;

  for (const p of game.players.values()) {
    const [x, y, z] = p.pos;
    if (![x, y, z, p.vel[0], p.vel[1], p.vel[2]].every(Number.isFinite)) { nonFinite++; continue; }
    if (Math.abs(x) > BOUND || Math.abs(z) > BOUND) outOfBounds++;
    const before = prev.get(p.id);
    if (before) {
      const d = Math.hypot(x - before[0], y - before[1], z - before[2]);
      if (d > maxStep) maxStep = d;
      if (d > 2.5) teleports++;
    }
    if (p.alive) {
      const ground = game.world.terrainHeight(x, z);
      if (y < ground - .08) penetrations++;
    }
  }

  for (const v of game.vehicles) {
    if (![...v.pos, ...v.vel, v.yaw, v.pitch, v.roll, ...v.wheelComp].every(Number.isFinite)) vehicleNonFinite++;
    if (Math.abs(v.pos[0]) > BOUND || Math.abs(v.pos[2]) > BOUND) vehicleOutOfBounds++;
    if (v.pos[1] < game.world.terrainHeight(v.pos[0], v.pos[2]) - .03) vehicleGroundPenetrations++;
  }

  // Keep every player in the match so the whole 30 simulated minutes runs with
  // the full 32-player load (a real BR empties out; a stress test should not).
  for (const p of game.players.values()) {
    if (!p.alive) { game.spawnPlayer(p); respawns++; }
  }
  if (game.matchState !== 2) game.matchState = 2;

  if (tick % 6000 === 0) {
    const wall = (performance.now() - t0) / 1000;
    process.stdout.write(`\r${(tick / CFG.SIM_HZ / 60).toFixed(1)} min sim · ${wall.toFixed(1)} s wall · ` +
      `${(tick / Math.max(0.001, wall)).toFixed(0)} ticks/s   `);
  }
}

const wall = (performance.now() - t0) / 1000;
const live = [...game.players.values()].filter(p => p.alive).length;
const sorted = [...tickTimes].sort((a, b) => a - b);
const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
console.log('\n');
const report = {
  simulatedMinutes: +(SECONDS / 60).toFixed(1),
  ticks: totalTicks,
  wallSeconds: +wall.toFixed(2),
  ticksPerSecond: Math.round(totalTicks / wall),
  players: game.players.size,
  alive: live,
  respawns,
  simMsMean: +(tickTimes.reduce((a, b) => a + b, 0) / tickTimes.length).toFixed(4),
  simMsP95: +pct(0.95).toFixed(4),
  simMsP99: +pct(0.99).toFixed(4),
  simMsMax: +sorted.at(-1).toFixed(3),
  navigationBootMs: +navigationBootMs.toFixed(3),
  ticksOverBudget: overBudget.length,
  tickBudgetMs: +(1000 / CFG.SIM_HZ).toFixed(2),
  nonFinite,
  outOfBounds,
  groundPenetrations: penetrations,
  groundToleranceMetres: .08,
  vehicleNonFinite, vehicleOutOfBounds, vehicleGroundPenetrations,
  teleportsOver2_5m: teleports,
  maxStepMetres: +maxStep.toFixed(3),
  zoneRadius: +game.zone.r.toFixed(1),
  matchState: game.matchState,
};
console.table(report);
const slowestTicks = overBudget.sort((a, b) => b.ms - a.ms).slice(0, 16);
console.log('Slowest over-budget ticks:', slowestTicks);
if (process.env.STRESS_REPORT) writeFileSync(process.env.STRESS_REPORT,
  JSON.stringify({ ...report, slowestTicks, capturedAt: new Date().toISOString() }, null, 2));

if (nonFinite || outOfBounds || penetrations || teleports || vehicleNonFinite || vehicleOutOfBounds || vehicleGroundPenetrations) {
  console.error('STRESS FAILED');
  process.exitCode = 1;
} else {
  console.log('STRESS PASSED');
}
