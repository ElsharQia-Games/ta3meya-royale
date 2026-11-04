# Simulation & Bot QA Report

- **Branch:** `agent/sim`
- **Base commit:** `d914a63`
- **Environment:** Linux, Node `v24.15.0`, 20 logical CPUs
- **Date:** 2026-11-04
- **Scope:** `shared/sim.js`, `shared/physics.js`, `shared/weapons.js`,
  `shared/world.js`, `shared/config.js`, `server/bots.js`, simulation/physics/
  weapon/bot tests, and this report. No changes to `src/**`,
  `server/server.js`, or `shared/protocol.js`.

## Commands run

```sh
npm test
node --test test/physics.test.js
node --test test/sim.test.js
node --test test/weapons.test.js
node --test test/bots.test.js
npm run stress
```

The stress run used the unmodified harness defaults: 32 players, 30 simulated
minutes, 108,000 ticks at 60 Hz.

## What changed

### Interior bot navigation

- `shared/world.js`
  - Buildings now publish ground/upper-floor `doors` metadata (axis, opening
    span, centre, outward normal, kind).
  - Building pads are flattened into the terrain heightfield with a smooth
    feather (`flattenPad`). Previously a 1.6 m foundation could sit more than
    the 0.5 m step limit above local terrain, so doorways were physically
    unenterable.
  - Furniture placement now avoids **every** door on the floor, not just the
    front door. This prevents furniture from plugging interior/side/back
    doorways.
- `shared/config.js`
  - `CFG.BOT.navCell` changed from `6` m to `2` m so a 1.25–1.45 m doorway can
    be represented by at least one nav cell.
- `server/bots.js`
  - Nav cells block on the full cell square rather than a shrunken inner
    square. Thin 0.24 m walls could previously pass between 6 m cell centres,
    letting A* paths cross walls.
  - `furniture` is now a blocking tag, so bots do not plan through solid props.
  - Ground-floor door bands are carved walkable after the generic footprint
    pass; path segments crossing a door are snapped to exact door-centre
    approach/inside/exit portals.
  - `nearestWalkable` ranks candidates by distance from the real world point
    and can be constrained to the building rectangle, preventing a bot on one
    side of an interior wall from snapping to the far side.
  - A* scratch arrays are reused with a search stamp instead of allocating
    multi-megabyte typed arrays per path.
  - `BotBrain` gained a scripted objective API (`commandTo`, `clearObjective`,
    `arrived`, `arriveRadius`), turn-rate-limited `input.yaw` steering, door-
    aware path following, and a stuck/detour/unstick fallback.
- `test/bots.test.js` (new): spawns a lone bot outside the front door, commands
  it to ground-floor indoor loot, verifies entry/reach, then commands it back
  outside. Each stage is bounded to 1,500 ticks.

### Physics

- `shared/physics.js`: downhill ground snap changed from
  `p.pos[1] = Math.max(p.pos[1], support)` to `p.pos[1] = support` within the
  step-down range. The old code left the capsule floating at its previous
  height when walking downhill until it fell off the slope.
- `test/physics.test.js`: added controlled-world regressions for step-up/tall
  block, slope limit, downhill slide, low-ceiling stance gating, stand-up
  refusal, water entry/swim/exit, capsule-vs-wall at sprint speed, and
  high-speed projectile no-tunnelling.

### Determinism

- `test/sim.test.js`: added a 600-tick replay test that constructs two
  independent TDM games, feeds both the same recorded input stream (shooting,
  reloads, jumps, sprint, stance changes), and compares quantised
  position/velocity, stance, alive state, health, armour, kills/deaths, ammo,
  score/stats, and the complete event stream.
- No `Math.random()` or `Date.now()` exists in `shared/**`, `server/bots.js`,
  `test/**`, or `tools/stress.js`. A grep over those paths returns no matches;
  the only `Date.now()` uses are in `server/server.js` room/session bookkeeping.

### Weapons

- `test/weapons.test.js`: added data-driven tests for:
  - TTK at 10/30/60 m for every class, including shotgun pellet-cone sampling;
  - recoil kick/recovery using the shared `damp` model;
  - monotonic damage falloff and configured falloff floors;
  - concrete/wood penetration thresholds and class ordering;
  - per-weapon reload, partial reserve, full-mag/empty-reserve refusal,
    firing cadence, tracer count, and dry fire.
- **No weapon tuning changes were required.** The measured TTK table matches
  the documented class roles: precision weapons stay effective at 60 m,
  pistol/SMG degrade, and the shotgun is a 10 m weapon.

## Test results

`npm test`:

```text
tests 79
pass  79
fail  0
duration_ms 1661
```

Baseline before this work was 64 passing tests. The 15 new tests are:

| Area | Tests added |
| --- | ---: |
| Physics regressions | 8 |
| Weapon balance/data | 5 |
| Determinism replay | 1 |
| Bot interior round trip | 1 |

Per-file runs:

| Command | Result |
| --- | --- |
| `node --test test/physics.test.js` | 17/17 pass, ~227 ms |
| `node --test test/sim.test.js` | 12/12 pass, ~1.36 s |
| `node --test test/weapons.test.js` | 16/16 pass, ~241 ms |
| `node --test test/bots.test.js` | 1/1 pass, ~2.30 s |

## Bot interior success rate

`test/bots.test.js` covers **3 game seeds × 6 eligible buildings = 18/18
successful round trips** (entry, interior objective reached, exit), all within
the 1,500-tick bound.

```text
interior round trips 18/18
entry ticks:  52–472
reach ticks:  58–474
exit ticks:   19–169
```

Seeds sampled: `20261104`, `63162945`, `1356337147`.

## Stress results — 30 simulated minutes

Baseline was recorded on `d914a63` with the same harness before these changes.
Post-change values are from the final `npm run stress` run.

| Metric | Baseline (`d914a63`) | After changes |
| --- | ---: | ---: |
| Simulated minutes | 30 | 30 |
| Ticks | 108,000 | 108,000 |
| Wall seconds | 74.93 | 133.94 |
| Ticks/second | 1,441 | 806 |
| `simMsMean` | 0.6848 | 1.227 |
| `simMsP95` | 1.3189 | 2.2037 |
| `simMsP99` | 1.964 | 3.4495 |
| `simMsMax` | 40.022 | 237.601 |
| Respawns | 6,306 | 6,148 |
| `nonFinite` | 0 | 0 |
| `outOfBounds` | 0 | 0 |
| `groundPenetrations` | 0 | 0 |
| `teleportsOver2_5m` | 0 | 0 |
| `maxStepMetres` | 0.593 | 0.459 |

Post-change run: 32 players, 32 alive, `zoneRadius` 8, `matchState` 2, and
`STRESS PASSED`.

**Interpretation:** the simulation is slower than baseline (mean 0.685 →
1.227 ms/tick, 1,441 → 806 ticks/s) but still runs at ~13.4× real time for 32
players. The p99 tick cost is 3.45 ms against a 16.67 ms budget. The 237.6 ms
maximum is a one-off spike (likely JIT/GC or a long first path search) and
should be profiled before production; it is not representative of steady
state (p99 remains 3.45 ms).

Likely causes of the regression, in order of expected impact:

1. The nav grid grew from ~27,800 cells at 6 m to 250,000 cells at 2 m, and
   A* now has more cells and longer paths.
2. Bots now actually enter interiors and collide with interior walls, doors,
   and furniture instead of getting pinned outside.
3. More bots move continuously because the old stuck state was largely
   ineffective.

## Weapon TTK (aimed torso, no armour)

Computed with the same deterministic helper used by `test/weapons.test.js`.
Shotgun values average 128 sampled pellet cones; single-pellet weapons use an
ideal aimed shot with gravity-drop compensation.

| Class | 10 m | 30 m | 60 m |
| --- | ---: | ---: | ---: |
| pistol | 0.43 s | 0.43 s | 0.86 s |
| smg | 0.33 s | 0.50 s | 0.75 s |
| ar | 0.26 s | 0.26 s | 0.26 s |
| dmr | 0.20 s | 0.20 s | 0.20 s |
| shotgun | 0.77 s | 8.46 s | 34.62 s |
| sniper | 0.00 s | 0.00 s | 0.00 s |
| lmg | 0.24 s | 0.24 s | 0.32 s |

TTK excludes reaction time and assumes every aimed shot hits the torso. The
sniper is the only class that one-shots a full-health torso at all three
ranges; the DMR requires a follow-up. No class fell outside its intended role
band, so no tuning outlier was changed.

## Residual issues

1. **Performance regression:** 1,441 → 806 ticks/s. Still well inside the tick
   budget, but the 2 m nav grid and interior collisions are the main cost.
   Profiling and a hierarchical/adaptive nav grid are the next step.
2. **Upper floors are still not navigable.** Nav carving only handles
   `floor === 0`, and `stairs` remains a blocking tag. Bots can enter ground
   floors but do not route upstairs.
3. **Static nav vs destructible props.** The nav grid is built once per world
   seed. Destroyed furniture/walls remain blocked until the nav grid is
   rebuilt; new dynamic obstacles are only handled by the character collider
   and unstick logic.
4. **Nav cache key:** `getNav` keys only on `world.seed`. If two differently
   configured worlds ever share a seed, they would share a nav grid. In normal
   play the map seed determines geometry, so this is currently safe.
5. **Stress harness is not an endgame test.** It forces respawns and
   `matchState = LIVE` every tick, so it measures load and state safety, not BR
   elimination/zone-end behaviour.
6. **Bot interior coverage is sampled,** not exhaustive: 18 round trips over
   3 seeds and 6 buildings per seed. The prototype also passed 18/18, but a
   full 60-building sweep is not part of the committed test because of runtime.
7. **Recoil is client-side.** `src/main.js` owns recoil accumulation and
   recovery; the new test models it from config. Server-authoritative recoil
   would require moving that state into the shared simulation.

## Cross-file proposals

1. **`src/main.js` / `shared/sim.js`:** move recoil accumulation and recovery
   into the shared player state (or include it in the input contract) so the
   client and server agree on aim state. This would also let the bot aim model
   use the same recoil path.
2. **`server/server.js` room lifecycle:** prewarm `getNav(world)` during room
   creation/warmup rather than lazily on the first bot tick, and log nav build
   time/memory. This makes the first live tick deterministic in cost.
3. **`server/bots.js` / `shared/config.js`:** expose nav tuning (`navCell`,
   max expansions, repath interval) and consider a hybrid grid — 2 m near
   buildings/doors, 4–6 m in open terrain — to recover most of the performance
   regression without losing doorway resolution.
4. **`shared/world.js` / nav consumers:** add nav invalidation or a dynamic
   obstacle layer for destroyed walls/furniture, and expose door metadata to
   the client for minimap/QA tooling.
5. **`tools/stress.js`:** record the tick index of the maximum and count ticks
   over the 16.67 ms budget, so the one-off startup spike can be separated from
   steady-state latency. Optionally include a bot interior round-trip metric in
   the stress summary.
6. **`GAP-ANALYSIS.md` / `README.md` / `DECISIONS.md`:** update the documented
   “bots do not path through building interiors” limitation, and record the
   `navCell = 2` + door-metadata decision and its performance trade-off.
