// Node microbenchmark for the two Phase 4 paths that are cheap to isolate:
// smoke sight-line allocation (F5) and snapshot buffering (F5).
//
//   node --expose-gc qa/phase4-microbench.mjs
//
// `oldSmoke` is the pre-Phase-4 implementation copied from the diff; it exists
// only to quantify that change. Browser frame cost lives in qa/phase4-bench.mjs.
import { smokeObscures } from '../shared/visibility.js';
import { SnapshotBuffer } from '../src/prediction.js';

const N = 200000;
const from = [0, 1.6, 0], to = [40, 1.4, 20];
const smokes = Array.from({ length: 8 }, (_, i) => ({ x: 5 + i * 4, y: 1.6, z: 2 + i * 2, r: 2.4 }));

// Historical implementation: array maps/reduces per call.
function oldSmoke(smokes, from, to) {
  const delta = to.map((n, i) => n - from[i]), length = Math.hypot(...delta);
  if (length < 1e-6) return false;
  const direction = delta.map(n => n / length);
  for (const smoke of smokes || []) {
    const offset = [smoke.x - from[0], smoke.y + 1.1 - from[1], smoke.z - from[2]];
    const along = offset.reduce((sum, n, i) => sum + n * direction[i], 0);
    const perpendicular = offset.reduce((sum, n) => sum + n * n, 0) - along * along;
    if (perpendicular < (smoke.r || 2) ** 2 && along > -2 && along < length + 2) return true;
  }
  return false;
}

function bench(fn) {
  fn();
  global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  let hits = 0;
  for (let i = 0; i < N; i++) if (fn()) hits++;
  const ms = performance.now() - start;
  global.gc();
  const heapAfter = process.memoryUsage().heapUsed;
  return {
    calls: N,
    ms: +ms.toFixed(1),
    usPerCall: +(ms / N * 1000).toFixed(3),
    heapDeltaKiB: +((heapAfter - heapBefore) / 1024).toFixed(1),
    hits,
  };
}

const cache = new Map();
for (let i = 0; i < 31; i++) {
  cache.set(i, { x: i, y: 1, z: i * 2, hp: 100, team: i % 2, alive: true, weapon: 'ar', yaw: 0, pitch: 0 });
}
const snaps = Array.from({ length: 90 }, (_, i) => ({ serverTime: i / 30, seq: i }));
const buffer = new SnapshotBuffer(90);
const pushes = 3000;
global.gc();
const pushStart = performance.now();
for (let i = 0; i < pushes; i++) buffer.push(snaps[i % 90], cache);
const pushMs = performance.now() - pushStart;

console.log(JSON.stringify({
  smoke: {
    old: bench(() => oldSmoke(smokes, from, to)),
    current: bench(() => smokeObscures(smokes, from, to)),
  },
  snapshot: {
    pushes,
    players: cache.size,
    ms: +pushMs.toFixed(1),
    usPerPush: +(pushMs / pushes * 1000).toFixed(1),
    retainedFrames: buffer.frames.length,
  },
}, null, 2));
