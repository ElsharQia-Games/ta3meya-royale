import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../shared/world.js';
import { CFG } from '../shared/config.js';

const world = new World(CFG.MAP.SEED);

test('world generation is deterministic for the same seed', () => {
  const a = new World(1234);
  const b = new World(1234);
  assert.equal(a.boxes.length, b.boxes.length);
  assert.equal(a.trees.length, b.trees.length);
  assert.equal(a.buildings.length, b.buildings.length);
  assert.equal(a.spawnPoints.length, b.spawnPoints.length);
  for (let i = 0; i < 200; i++) {
    const x = -450 + i * 4.5, z = -420 + i * 4.2;
    assert.equal(a.terrainHeight(x, z), b.terrainHeight(x, z));
  }
});

test('different seeds produce different terrain', () => {
  const a = new World(1), b = new World(2);
  let diff = 0;
  for (let i = 0; i < 100; i++) {
    const x = i * 3.1 - 150, z = i * -2.7 + 120;
    if (Math.abs(a.terrainHeight(x, z) - b.terrainHeight(x, z)) > 1e-6) diff++;
  }
  assert.ok(diff > 50, `expected most samples to differ, got ${diff}`);
});

test('terrain heights are finite and inside a sane range', () => {
  for (let i = 0; i < 2000; i++) {
    const x = (i * 137.13) % 1000 - 500;
    const z = (i * 91.77) % 1000 - 500;
    const h = world.terrainHeight(x, z);
    assert.ok(Number.isFinite(h), `non-finite height at ${x},${z}`);
    assert.ok(h > -30 && h < 120, `implausible height ${h} at ${x},${z}`);
  }
});

test('water only exists inside the lake', () => {
  const lake = world.lake;
  assert.ok(lake && lake.r > 0);
  assert.equal(world.waterDepth(lake.x, lake.z), lake.level - world.terrainHeight(lake.x, lake.z));
  for (const [x, z] of [[0, 0], [300, -300], [-490, 490], [lake.x + lake.r + 20, lake.z]]) {
    assert.equal(world.waterDepth(x, z), 0, `unexpected water at ${x},${z}`);
  }
  assert.equal(world.waterDepth(lake.x + lake.r + 200, lake.z), 0);
});

test('downward ray hits the ground at the expected point', () => {
  const x = 40, z = -70;
  const ground = world.terrainHeight(x, z);
  const hit = world.raycast([x, ground + 40, z], [0, -1, 0], 100);
  assert.ok(hit, 'expected a ground hit');
  assert.equal(hit.tag, 'terrain');
  assert.ok(Math.abs(hit.point[1] - ground) < 1.5, `hit y ${hit.point[1]} vs ground ${ground}`);
  assert.ok(hit.t > 0);
});

test('raycast reports entry and exit depths for boxes (penetration support)', () => {
  const wall = world.boxes.find(b => b.tag === 'wall' && !b.destroyed && b.max[1] - b.min[1] > 1);
  assert.ok(wall, 'world should contain walls');
  const cx = (wall.min[0] + wall.max[0]) / 2;
  const cy = (wall.min[1] + wall.max[1]) / 2;
  const cz = (wall.min[2] + wall.max[2]) / 2;
  // Cast along +X through the wall from just outside its -X face.
  const origin = [wall.min[0] - 3, cy, cz];
  const hit = world.raycast(origin, [1, 0, 0], 12);
  assert.ok(hit, 'expected wall hit');
  assert.ok(hit.t < 4);
  assert.ok(hit.tmax > hit.t, `exit ${hit.tmax} must be beyond entry ${hit.t}`);
  assert.ok(hit.tmax - hit.t > 0.05);
});

test('walls block line of sight', () => {
  const wall = world.boxes.find(b => b.tag === 'wall' && !b.destroyed && b.max[1] - b.min[1] > 2);
  assert.ok(wall);
  const cx = (wall.min[0] + wall.max[0]) / 2;
  const cz = (wall.min[2] + wall.max[2]) / 2;
  const y = Math.min(wall.max[1] - 0.4, wall.min[1] + 1.4);
  const a = [wall.min[0] - 6, y, cz];
  const b = [wall.max[0] + 6, y, cz];
  assert.equal(world.lineOfSight(a, b), false);
  // Above the wall should be clear.
  const above = Math.max(wall.max[1] + 8, y + 8);
  assert.equal(world.lineOfSight([a[0], above, a[2]], [b[0], above, b[2]]), true);
});

test('queryBoxes returns only nearby geometry', () => {
  const x = 0, z = 0, r = 25;
  const boxes = world.queryBoxes(x - r, z - r, x + r, z + r);
  assert.ok(boxes.length > 0);
  // queryBoxes is a broad phase over 8 m cells, so candidates can sit up to
  // one cell outside the exact rectangle.
  for (const b of boxes) {
    const pad = 8;
    const overlaps = b.max[0] >= x - r - pad && b.min[0] <= x + r + pad &&
      b.max[2] >= z - r - pad && b.min[2] <= z + r + pad;
    assert.ok(overlaps, `box ${b.tag} far outside query area`);
  }
});

test('world contains the promised content counts', () => {
  const s = world.computeStats();
  assert.ok(s.boxes > 2000, `boxes ${s.boxes}`);
  assert.ok(s.buildings >= 20, `buildings ${s.buildings}`);
  assert.ok(s.trees > 500, `trees ${s.trees}`);
  assert.ok(s.loot > 100, `loot spawns ${s.loot}`);
  assert.ok(s.vehicles >= 4, `vehicles ${s.vehicles}`);
  assert.ok(s.destructibles > 20, `destructibles ${s.destructibles}`);
});
