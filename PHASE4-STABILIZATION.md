# Phase 4 Stabilization — RPG/Glass Performance, Audio Defects and Presentation

Base revision: `6fecb47 perf(audio): complete Phase 4 rendering and recorded-audio remediation`

This pass validates the reported stabilization findings against that revision, fixes
the confirmed defects, and records measured evidence. All changes are presentation
only: authoritative simulation, hit registration, physics and networking are
unchanged. The uncommitted work in this tree is the subject of this document.

## 1. Method and constraints

- Every reported finding was checked in the current source before editing. The
  before numbers below come from the same harnesses run against `6fecb47`.
- Microbenchmarks: `npm run qa:stabilize` → `qa/reports/stabilization-micro-{before,after}.json`.
- Multiplayer: `npm run qa:stabilize:mp` with two real browser clients, a dedicated
  server (`PORT=3312 BOTS=0 node server/server.js`) and a TDM room. Before:
  `qa/reports/stabilization-mp-before.json`. After: `qa/reports/stabilization-mp-after.json`.
- Audio mix audit: `npm run qa:audio-mix` → `qa/reports/stabilization-audio-mix.json`.
- Client rendering was SwiftShader (software GL) because this environment has no
  hardware GPU. Draw-call/triangle counts and JavaScript work are meaningful
  relative measurements; FPS and rAF intervals are not hardware claims.
- The multiplayer reports intentionally include the sample count for every
  percentile. A percentile from two frames is reported as such, not as a stable
  distribution.

## 2. Validated P0 findings and fixes

### 2.1 Confirmed causes

| Reported issue | State on `6fecb47` | Root cause |
|---|---|---|
| Glass break stutter | Confirmed | `WorldRenderer.removeBox()` called `_rebuildGlass()`, which re-merged **all 248 panes** for every destroyed pane. Five panes in one explosion therefore cost five full world-wide merges. |
| Destruction sync cost | Confirmed | `syncDestruction()` scanned every world box and every archetype pool reset all instance matrices even when the destroyed set had not changed. |
| Rocket launch cost | Confirmed | `Effects.launch()` created a rocket geometry/material set per launch and `stopProjectile()` disposed it. |
| Explosion/debris cost | Confirmed | Each boom allocated a `RingGeometry` + material and a sprite material; each debris chunk allocated a `BoxGeometry` + material. |
| Rocket flight cost | Confirmed | Orientation and trail code allocated `Vector3`s per rocket per frame. |

### 2.2 Implementation

`src/render/world.js`

- `removeBoxes(ids)` batches removals. Archetype pools receive one `removeBoxes()`
  call, so an explosion that breaks several props uploads the instance buffer once.
- `ArchetypePool` tracks `destroyedIds`, returns immediately for an unchanged
  destruction set, applies pure additions incrementally, and only performs a full
  order-restoring rebuild when props are restored.
- Glass panes are keyed into the same 160 m spatial cells used by
  `mergeSpatialGeometry`. `_rebuildGlass(cells)` disposes and re-merges only the
  affected cells. `glassIds`, `glassDestroyed` and `dynamicBoxList` avoid scanning
  every world box on every state sync.
- Non-archetype dynamic props stay in `dynamicBoxList` even if already destroyed at
  join time, preserving restoration behaviour.

`src/main.js`

- `handleEvents()` collects every `destroy` event and calls `worldView.removeBoxes()`
  once after the event loop, so one explosion produces one glass-cell rebuild and
  one instance-buffer flush.

`src/render/effects.js` and `src/render/launcher-model.js`

- One shared rocket template is cloned per launch. Geometry and materials are
  created once; `stopProjectile()` no longer disposes shared assets.
- Orientation uses module scratch vectors; trail positions reuse scratch data.
- A shared additive exhaust sprite is attached per rocket.
- Explosion sprite groups, shockwave rings and point lights are pooled. The point
  light pool is fixed at two, avoiding scene light-count changes that force
  material recompiles.
- Debris uses one shared unit box scaled per chunk and four shared roughness
  materials.
- Explosions gained slower dark smoke and fast ember streaks; the existing warm
  core, particles and shockwave remain.

### 2.3 Measured effect (same harness, same software GL)

| Path | Before | After | Change |
|---|---:|---:|---:|
| Five per-pane glass removals (one call each) | 27.4 ms | 1.5 ms | ~18× faster |
| Five pane removals in one batch | 27.8 ms | 0.3 ms | ~93× faster |
| No-op `syncDestruction` × 200 | 125.5 µs/call | 2.5 µs/call | ~50× cheaper |
| 60 rocket launches | 26.4 ms | 4.4 ms | ~6× faster (440 → 73 µs each) |
| Rocket flight, 300 frames | 61.3 µs/frame | 54 µs/frame | ~12% cheaper |
| 40 booms | 8.0 ms | 6.7 ms | ~16% cheaper |
| 20 destroys (120 debris chunks) | 3.0 ms | 1.1 ms | ~2.7× faster |

The glass and rocket figures are the ones that matter for the reported stutter:
the old cost scaled with all world panes / per-rocket allocation, the new cost
scales with the affected cell / a clone.

## 3. Validated P1 audio defects and fixes

| Defect | Evidence on `6fecb47` | Fix |
|---|---|---|
| Duplicate vehicle destruction | Observation transition and authoritative `vehicleDestroyed` event both played; multiplayer probe counted 2. | Latch per vehicle id in `AudioEngine.vehicleDestroyed()`; positive observed health re-arms it. After: 1 audible `vehicleDestroy`. |
| Duplicate dry-fire | Local prediction and authoritative `dry` event both played; probe counted 2 calls. | FIFO prediction window (1.2 s) consumes the matching server event. After: 2 calls, **1 audible** dry-fire. |
| Broken >420 m routing | `shot()` checked `SOUNDS.shot.range` (420 m) before routing to `distantShot` (640 m), so 420–640 m was silent. | Range check uses the 640 m distant profile. Probe now routes 500 m and 620 m events to `distantShot`. |
| Abrupt 110 m near/far switch | Hard `dist > 110` branch. | Crossfade over 90–130 m: close recording at full gain inside 90 m, far recording at full coverage beyond 130 m. |
| Cooldown keyed by sound/variant only | Two players firing the same weapon collided in the cooldown map. | Cooldown key includes `source` (player id, `self`, or a synthetic probe key). |
| Full reload recording layered with cues | `reload()` played a complete recording while `updateActions()` also emitted phase cues. | `reload()` is cue-only; `ReloadCues` is the single Foley path. Probe now reports `magOut`, `magIn`, `bolt` and no full recording. |
| Birds ambience on by default | `_syncAmbience()` always started `amb-birds`. | The recorded clip remains in the library but is explicitly stopped/not started by default. |

The crossfade probe at 100 m observes both layers at partial gain; 70 m is
close-only and 300/500/620 m are far-only. The near/far recordings are distinct
recorded assets, not filtered substitutes.

## 4. Multiplayer verification (two real clients)

Room `STAB7587`, TDM, two human clients, no bots. Client A launched four RPG
rounds at its local glass cluster; client B launched one at its own cluster.
Both clients observed the authoritative destruction.

| Check | Before | After |
|---|---|---|
| Clients found blast-reachable glass | A 4 panes / 9.4 m, B 2 panes / 18.2 m | same |
| Near shot uses close recording | PASS | PASS |
| 300 m / >420 m routing | FAIL | PASS |
| Authoritative far shot routes to `distantShot` | FAIL | PASS |
| Vehicle destruction once | FAIL (2) | PASS (1) |
| Dry-fire at most once | FAIL (2) | PASS (2 calls, 1 play) |
| Reload cue-only | full `reloadRifle` only | `magOut`, `magIn`, `bolt` |
| Birds off by default | FAIL | PASS |
| RPG destroyed authoritative glass | 8 panes | 8 panes (A `[2,2,2,0]`, B 2) |
| Clients observed glass removals | 8 | 8 |
| RPG launch/explosion audio | PASS | PASS |
| No browser errors | PASS | PASS |

Result: **8/14 before, 14/14 after**, with no browser errors.

Client frame windows (SwiftShader; sample counts matter):

| Window | Frames | rAF p50 | rAF p95 | Frame-work p50 | Frame-work p95 |
|---|---:|---:|---:|---:|---:|
| Before, pre-RPG | 8 | 1883.2 ms | 1883.2 ms | 6.8 ms | 8.8 ms |
| Before, post-RPG | 3 | 516.6 ms | 9749.6 ms | 7.0 ms | 7.5 ms |
| After, pre-RPG | 7 | 1916.5 ms | 2033.3 ms | 7.6 ms | 18.0 ms |
| After, post-RPG | 2 | 6766.4 ms | 6766.4 ms | 8.4 ms | 8.4 ms |
| After, second client | 5 | 2049.9 ms | 6166.4 ms | 6.6 ms | 6.6 ms* |

\* The second client's only long outlier is a single stalled frame (p95 of five
samples). With 2–8 frames per window these distributions are not statistically
stable, so this document does **not** claim a client frame-time improvement. The
reliable P0 evidence is the deterministic microbenchmark above. The post-fix run
has no browser errors and no failed gameplay checks.

Server authoritative tick timing (recorded window, 600 samples):

| Window | p50 | p95 | p99 | max | Over budget |
|---|---:|---:|---:|---:|---:|
| Before launches | 0.302 ms | 0.946 ms | 1.799 ms | 2.539 ms | 0 |
| After launches | 0.309 ms | 1.050 ms | 1.764 ms | 5.694 ms | 0 |
| Pre-fix baseline after launches | 0.292 ms | 0.670 ms | 1.822 ms | 2.599 ms | 0 |

The server stayed far below a 16.7 ms tick budget in both runs. Differences are
within run-to-run noise; the single 5.694 ms max is one sample, not a trend.

## 5. Audio mix reassessment (P1.7)

Objective audit (`npm run qa:audio-mix`) measures every shipped shot/reload layer
with EBU R128 true peak and max momentary loudness. It found:

- No clipping: shot true peaks are between −1.2 and −3.6 dBFS.
- Pool level spread remains: max-momentary spread is 4.3 LU (pistol), 5.9 LU
  (SMG), 4.5 LU (AR) and 6.0 LU (LMG); DMR/shotgun/sniper/RPG are within 3 LU.
- Integrated loudness spreads are larger for pools whose clips have different
  decay lengths (SMG 8.5 LU, pistol 4.8 LU), so the audit uses max momentary as
  the primary shot metric.

**No human listening test was performed in this environment.** Automated routing,
layering and level checks cannot judge whether a weapon "feels" right, whether the
90–130 m crossfade is perceptually smooth, or whether the added smoke/embers read
well. The loudness spread above was deliberately **not** blind-rebalanced: doing so
without listening would change an approved CC0 asset mix based on a weak
sub-second loudness metric. It is recorded as an open verification item.

## 6. P2 presentation

- Rocket: shared template + clone, shared exhaust sprite, scratch orientation /
  trail vectors. Launch cost fell from 440 µs to 73 µs per rocket.
- Explosion: pooled sprite group and shockwave, fixed two-light pool, richer dark
  smoke and ember streaks. Boom cost fell from 8.0 to 6.7 ms for 40 booms.
- Debris: one shared unit box and four shared materials; 20 destructions fell from
  3.0 to 1.1 ms.
- Visual quality was not subjectively judged in this run (the environment cannot
  display images to the agent). The changes are structural and covered by the
  rendering regression tests below.

## 7. Tests and regressions

New/extended coverage:

- `test/phase4-render.test.js`
  - glass cell keys match the merged renderer's 160 m bins;
  - `ArchetypePool` batches removals, skips unchanged syncs, applies additions
    incrementally and restores the original order;
  - debris uses shared geometry/materials and shockwave rings are pooled.
- `test/phase4-audio.test.js`
  - 300 m and beyond-420 m gunfire routing;
  - 100 m near/far crossfade with both layers attenuated;
  - per-source cooldowns do not cancel different players;
  - predicted vs authoritative dry-fire plays once;
  - vehicle destruction dedupes and re-arms after repair;
  - default ambience has wind/battle but no birds;
  - `reload()` starts no full recording and resets the cue stepper.

Full suite: `npm test` → **240/240 pass**.

## 8. Preserved behaviour

- No changes to `shared/` simulation, collision, damage, hit registration, input
  prediction or snapshot/reconciliation.
- Destruction still follows authoritative `destroy` events and authoritative
  destroyed-id state; the renderer only batches the presentation work.
- Audio remains recorded-only; no synthesized substitutes were introduced.
- Phase 1–3 character tiers, death settling, loot pooling, renderer teardown,
  voice budget and spatial/occlusion paths are untouched.

## 9. Remaining limitations

- No human listening test (see §5). Spatially the crossfade is verified by gain
  math and routing tests, not by ear.
- No hardware-GPU frame-time A/B. The after-fix multiplayer frame windows contain
  only 2–7 frames; the deterministic microbenchmark is the performance evidence.
- `_rebuildGlass(cells)` re-merges only affected cells but still filters the world
  box list to find panes in those cells. This is cheap for the measured 248-pane
  world; a per-cell pane index is the next step if pane counts grow.
- The mix audit flags pool-level loudness spread; resolving it needs an actual
  listening decision, not another automated normalisation.
- Visual quality of the new rocket/explosion treatment was not subjectively
  reviewed in this environment.

## 10. Reproduction

```sh
npm test
npm run build
npm run qa:stabilize            # microbench → qa/reports/stabilization-micro.json
npm run qa:audio-mix            # objective mix audit → qa/reports/stabilization-audio-mix.json

# Dedicated server for two-client QA (BOTS=0 so the clients are the only actors)
PORT=3312 BOTS=0 node server/server.js
QA_URL=http://127.0.0.1:3312/ \
QA_REPORT=qa/reports/stabilization-mp-after.json \
QA_OUT=qa/shots/stabilization-mp-after \
npm run qa:stabilize:mp
```

Artifacts: `qa/reports/stabilization-micro-{before,after}.json`,
`qa/reports/stabilization-mp-{before,after}.json`,
`qa/reports/stabilization-audio-mix.json`, `qa/shots/stabilization-mp-after/`.
