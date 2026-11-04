import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../shared/sim.js';
import { CFG, MATCH_STATE } from '../shared/config.js';
import { spawnBots, stepBots } from '../server/bots.js';

function insideBuilding(b, x, z, pad = 0.25) {
  return Math.abs(x - b.x) < b.w / 2 - pad && Math.abs(z - b.z) < b.d / 2 - pad;
}

// Ground-floor indoor loot makes a good stand-in for a "go inside" objective:
// it is always behind at least the perimeter wall.
function interiorTargets(world, b) {
  return world.lootSpawns.filter(s => s.indoor &&
    Math.abs(s.x - b.x) < b.w / 2 && Math.abs(s.z - b.z) < b.d / 2 &&
    s.y < b.y0 + 1);
}

function eligibleBuildings(world) {
  const out = [];
  for (let i = 0; i < world.buildings.length; i++) {
    const b = world.buildings[i];
    const door = b.doors.find(d => d.kind === 'front' && d.floor === 0);
    if (door && interiorTargets(world, b).length) out.push(i);
  }
  return out;
}

// Spawn a lone bot outside the front door, command it to an interior point,
// then command it back outside. Returns the tick each stage completed on
// (-1 means it never happened within maxTicks).
function interiorRoundTrip(seed, buildingIndex, maxTicks = 1500) {
  const g = new Game({ mode: 'br', mapSeed: seed, seed });
  const [p] = spawnBots(g, 1, false);
  g.begin();
  g.matchState = MATCH_STATE.LIVE;

  const b = g.world.buildings[buildingIndex];
  const door = b.doors.find(d => d.kind === 'front' && d.floor === 0);
  const target = interiorTargets(g.world, b)[0];
  const outX = door.cx + door.nx * 3.5;
  const outZ = door.cz + door.nz * 3.5;
  p.pos = [outX, g.world.terrainHeight(outX, outZ) + 0.1, outZ];
  p.vel = [0, 0, 0];

  const inputs = new Map();
  const step = () => {
    inputs.clear();
    stepBots(g, CFG.SIM_DT, inputs);
    g.step(inputs, CFG.SIM_DT);
  };

  p.bot.commandTo(target.x, target.z);
  let entered = -1;
  let reached = -1;
  for (let t = 0; t < maxTicks; t++) {
    step();
    if (entered < 0 && insideBuilding(b, p.pos[0], p.pos[2])) entered = t;
    if (p.bot.arrived && entered >= 0 &&
      Math.hypot(p.pos[0] - target.x, p.pos[2] - target.z) < p.bot.arriveRadius + .1) {
      reached = t;
      break;
    }
  }

  const exitX = door.cx + door.nx * 4.5;
  const exitZ = door.cz + door.nz * 4.5;
  p.bot.commandTo(exitX, exitZ);
  let exited = -1;
  for (let t = 0; t < maxTicks; t++) {
    step();
    if (!insideBuilding(b, p.pos[0], p.pos[2], -0.2)) { exited = t; break; }
  }

  return { seed, buildingIndex, entered, reached, exited };
}

test('bots enter buildings, reach interior objectives and come back out', (t) => {
  const seeds = [CFG.MAP.SEED, CFG.MAP.SEED ^ 0x2f6e2b1, CFG.MAP.SEED ^ 0x51ed270b];
  const perSeed = 6;
  const results = [];
  // The fixture must vary the *map* seed: Game uses opts.mapSeed for World and
  // opts.seed only for gameplay RNG. Passing seed alone silently reuses the
  // default map for every advertised "seed".
  const worlds = seeds.map(seed => new Game({ mode: 'br', mapSeed: seed, seed }).world);
  assert.equal(new Set(worlds.map(w => w.seed)).size, seeds.length,
    `expected distinct world seeds, got ${worlds.map(w => w.seed).join(', ')}`);
  for (let si = 0; si < seeds.length; si++) {
    const seed = seeds[si];
    const world = worlds[si];
    const eligible = eligibleBuildings(world);
    assert.ok(eligible.length >= perSeed, `expected several enterable buildings for seed ${seed}`);
    const stride = Math.max(1, Math.floor(eligible.length / perSeed));
    for (let n = 0; n < perSeed; n++) {
      const bi = eligible[Math.min(eligible.length - 1, n * stride)];
      results.push(interiorRoundTrip(seed, bi));
    }
  }

  const ok = results.filter(r => r.entered >= 0 && r.reached >= 0 && r.exited >= 0);
  const summary = results.map(r =>
    `seed=${r.seed} building=${r.buildingIndex} enter=${r.entered} reach=${r.reached} exit=${r.exited}`,
  ).join('; ');
  t.diagnostic(`interior round trips ${ok.length}/${results.length}: ${summary}`);

  for (const r of results) {
    assert.ok(r.entered >= 0, `bot never entered building ${r.buildingIndex} (seed ${r.seed})`);
    assert.ok(r.reached >= 0, `bot never reached the interior objective in building ${r.buildingIndex} (seed ${r.seed})`);
    assert.ok(r.exited >= 0, `bot never left building ${r.buildingIndex} (seed ${r.seed})`);
  }
  assert.equal(ok.length, results.length);
});
