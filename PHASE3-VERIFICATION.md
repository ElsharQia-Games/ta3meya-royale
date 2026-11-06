# Phase 3 Verification — Ballistics, Lag Compensation and Combat Lifecycle

Phase 3 remediation against `report3.md`, based on Phase 2 HEAD `dc3e4c8`.
The working tree contains the Phase 3 changes; they are not committed or
deployed by this document.

## Scope

`report3.md` was treated as a validation specification. Each finding was first
reproduced against `dc3e4c8`; confirmed defects were fixed and now have targeted
regressions. F6 was validated as a geometry audit and did not require a
gameplay-geometry change. A second independent review after remediation raised
three further P1 items; all three were revalidated against the current tree and
the two confirmed defects were fixed with additional regressions. That round is
recorded below.

| ID | Finding | Status on `dc3e4c8` | Phase 3 result |
|---|---|---|---|
| F1 | Ballistic flight is evaluated against frozen historical targets | **Confirmed.** An unled shot hit a moving target; a correctly led shot missed. | Ordinary rounds are persistent authoritative bullets swept against live targets every tick. |
| F2 | Lag compensation uses approximate historical timing | **Confirmed.** `viewTime` was not used, and `findHistory()` selected the nearest 60 Hz frame. | Server-clock `viewTime`, interpolated history and a bounded one-time catch-up. |
| F3 | Vehicle hulls block all external shots at occupants | **Confirmed.** A windscreen shot hit the closed hull (`tag:'vehicle'`, `mat:'metal'`) before the occupant. | `rayVehicleBallistic()` opens the glazed cabin while doors, pillars, roof and chassis stay solid. |
| F4 | Penetration discards remaining movement within a bullet substep | **Confirmed.** A 0.2 s sniper ray travelled 4.04 m through 10 thin walls versus 191.52 m in free air. | Penetration continues from the exit point inside the same slice; residual travel is preserved. |
| F5 | Static glass and destructible materials are inconsistent | **Confirmed.** Window glass was non-dynamic with `hp = 0`; four AR impacts left it intact. | World window glass is destructible cover (`hp = 34`, `kind:'glass'`) and stops blocking after breaking. |
| F6 | Player hitboxes and damage zones require validation | **Geometry audited; no new defect proven.** Intended zones, prone yaw, stance and occupant state behaved consistently. | Added geometry regressions and documented the capsule/priority rule; no hitbox reshape. |
| F7 | Damage/events are not fully aligned with projectile time | **Confirmed.** Bullet damage was queued (`pendingDamage`) at fire time and crossed a respawn boundary (100 → 72.5 HP). | Damage, impacts and destruction are emitted on collision; `lifeId`/`spawnTime` reject stale or cross-life rounds. |
| F8 | Bot target leading must match the corrected ballistic model | **Confirmed.** Bot-style led aim missed because the solver still hit the frozen fire-time pose. | Bot lead now hits under persistent bullets; bot decision code is unchanged. |

## Independent review round

A second review targeted the remediated tree rather than the original findings.
Each report was reproduced with a focused probe before changing code.

| Review item | Validation | Resolution |
|---|---|---|
| P1 — a glazing entry makes a later solid vehicle face transparent | **Confirmed.** A path entering the rear glass at `t≈5.94` and exiting the roof at `t≈8.07` returned no ballistic hit, so the round would ignore the roof. | `rayVehicleBallistic()` now classifies both slab intersections. The entry must be glazing; the exit must also be glazing for the hull to stay open. Solid exits report an impact at the exit face. |
| P1 — a target alive in the earlier frame vanishes from an interpolation bracket | **Confirmed.** With an alive frame at `t=1.000` and an absent (dead) frame at `t=1.017`, samples at `t=1.008333` contained no target at all. | Dead players remain in history with `alive:false` and `deathAt`. `sampleHistory()` iterates the union of both frames and resolves death/respawn boundaries exactly. |
| P1 — `now - viewTime` might double-count latency for catch-up | **Validated, no model change.** `viewTime` is the server time of the pose the client was rendering, not the local fire timestamp. `now - viewTime` is therefore the age of that displayed pose, including interpolation delay and the one-way trip already spent in flight. The server does not add RTT/2 again. | Added controlled RTT/jitter coverage (20/80/160/400 ms, 0–60 ms jitter) proving the rewind tracks the displayed-pose age, plus a one-time catch-up assertion. Also clamped `remoteRenderTime()` to the buffered range so a sparse/joining buffer cannot request a rewind older than its data. |

### Vehicle entry/exit collision

The ballistic hull now runs the same slab intersection as the closed hull but
tracks the entry axis/face and the exit axis/face separately:

- entry through chassis, roof, door, pillar or truck bed → solid impact at entry;
- entry through side/front glazing → open;
- open entry followed by an exit through the roof, chassis, door, pillar or truck
  bed → solid impact at the **exit** point;
- open entry followed by an exit through another glazed face → no vehicle hit, so
  the round continues;
- a ray that starts inside the cabin is treated as an open entry, so an occupant
  can fire out through glazing but not through the roof or floor.

Regression `F3c` was updated: a truck cab-windscreen entry is now stopped by the
solid rear bed rather than reporting the whole truck as open. `F3d` covers the
ray-level case (windscreen/rear-glass entry → roof exit, side-glass pass-through,
occupant firing out through glass vs. roof), and `F3e` drives a live persistent
round through the same path and asserts the roof impact damages the vehicle.

### Historical target lifecycle

`captureHitboxes()` keeps a dead player's final pose until the player respawns.
`sampleHistory()` now:

- builds the id set from both bracketing frames, not only `after.map`;
- treats a `deathAt` in the later frame as the exact alive/dead boundary, so the
  target is still hittable immediately before death and absent at/after it;
- does not show a new life before its own `spawnTime`;
- carries an earlier-frame-only entry only while that life is alive at `t`
  (disconnect/removal edge case).

`F2b` exercises alive → dead → respawn across three frames, including the
reported `1.008333` midpoint, the exact death time and the respawn boundary.

### `viewTime` versus fire time

`remoteRenderTime()` returns `newestTime - (INTERP_DELAY + rtt/2 + 2·jitter)`,
clamped to the retained buffer. That value is sent as `viewTime`. The client is
displaying the server state from that time, so when the input reaches the server
at `now`, the age of what the player saw is `now - viewTime`. The RTT term is
already embedded in `viewTime`; adding it again in `fireContext()` would
over-rewind. `fireContext()` therefore uses `age = now - viewTime` directly,
clamped to `MAX_REWIND`, with the RTT fallback used only when `viewTime` is
missing. The catch-up is consumed on the first bullet tick and cleared, so it
cannot compound. `F2c`–`F2e` cover the mapping, one-time application and buffer
clamp.

## Follow-up review round

A third review found one remaining P1 in the persistent bullet sweep.

| Item | Validation | Resolution |
|---|---|---|
| P1 — an ineligible target repeatedly consumes the sweep guard and shortens travel | **Confirmed.** `advanceBullet()` asked `nearestPlayerHit()` for the nearest target, then skipped an old-life/future-spawn target with `travelled += ph.t + 0.02`. A respawned target 1.9 m ahead exhausted the 8-iteration guard, so a 60 Hz pistol tick travelled 1.95 m instead of the unobstructed 6.285 m. | `eligibleTargets()` now removes dead/missing, old-life and post-launch-spawn targets before the ray. Ineligible targets cannot consume travel; valid targets and world geometry behind them are considered normally. |

`eligibleTargets(game, bullet, targets)` mirrors the previous eligibility checks
exactly: the target must still exist and be alive, its `lifeId` must match the
current player's life, and its `spawnTime` must not be later than
`bullet.bornAt`. Filtering the list once per sweep also fixes the case where an
ineligible target is nearest to the ray: the nearest eligible target or world
surface behind it is now selected directly.

The old ineligible-hit branch remains as a defensive fallback, but normal
respawn/old-life targets no longer reach it. Lifecycle protection is unchanged:
a round fired before a respawn still cannot damage the new life (`F7b`), and the
new regressions assert both immunity and normal travel.

### Ineligible target regressions

- `F7d`: a respawned target at 1.9 m is not damaged, and one 60 Hz pistol tick
  travels the same distance as a round with no target (6.2852 m in this fixture).
- `F7e`: an ineligible target does not hide a **valid target** behind it; the
  valid target takes damage and stops the round.
- `F7f`: an ineligible target does not hide **world geometry** behind it; the
  wall impact is emitted at the wall and stops the round.

## Combat timeline design

The authoritative timeline for an ordinary round is:

1. **Client input.** The client samples the server-clock render time
   (`remoteRenderTime(buffer, rtt, jitter)`, or `offlineGame.time` offline) into
   `input.viewTime`. This is the time the player was actually looking at, not
   local uptime and not the arrival tick.
2. **Fire acceptance.** Dedicated server and Browser Host build the same
   per-shooter context with `Game.fireContext(history, viewTime, game.time,
   fallback)`:
   - missing/non-positive `viewTime` → `fallback = rtt/2 + INTERP_DELAY`, clamped
     to `MAX_REWIND` (0.4 s);
   - future `viewTime` → zero rewind, never a negative age;
   - valid `viewTime` → `age = now - viewTime`, clamped to 0.4 s.
   `Game.sampleHistory()` interpolates the two bracketing 60 Hz history frames
   (position, height, yaw, stance) rather than taking the nearest frame.
3. **Bullet launch.** `tryFire()` creates a persistent bullet with
   `bornAt = now - catchupAge`, `catchupFrom` (view-time targets) and
   `catchupTo` (live targets). The `shot` event carries only the predicted tracer
   endpoint for visuals.
4. **One-time catch-up.** On the first `stepBullets()` tick, the bullet is
   advanced in slices from the view-time pose to the live pose using
   interpolated targets. Lag compensation is applied exactly once.
5. **Live simulation.** Every following tick sweeps the bullet against live
   target hitboxes and the world with the residual slice loop. Hits, world
   impacts, glass/prop destruction and damage are emitted when the round reaches
   them.
6. **Ordering.** `Game.step()` moves players and vehicles, then sweeps bullets,
   then runs the legacy `pendingDamage` path, smokes, respawns and match end.
   Damage is therefore applied against the positions targets occupy on the
   collision tick.

Bullets are deliberately **not** part of the snapshot stream. They are bounded
by `CFG.BULLET.maxActive = 2048`, `maxLife = 2.2 s`, `maxPenetrations = 8` per
tick and `catchupMax = 0.4 s`.

## Protocol impacts

- `PROTOCOL_VERSION` is **9** (was 8). A version 8 client is rejected at join.
- `viewTime` changes meaning from local/uptime-style data to server-clock render
  time. Both dedicated and Browser Host validate and clamp it identically.
- `shot` keeps its predicted tracer endpoints and flight times, but now has
  `hit: false` and `imps: []`; it is no longer a damage or impact authority.
- New `impact` event:
  `{ k:'impact', id, w, x, y, z, n, tag, mat, bid, vid, dist }`, emitted at the
  collision point and interest-filtered by position. `destroy` is emitted at the
  same point in time when a destructible box breaks.
- The binary snapshot layout is unchanged. Destroyed glass rides the existing
  `destroyed` id set, so a late joiner reconstructs broken panes from the
  snapshot.
- Both authorities use `Game.fireContext()`, `Game.step()` and the shared
  `stepBullets()` implementation; there is no server-only or host-only combat
  path.

## Regression evidence

New tests are in `test/phase3-combat.test.js` (23 tests), plus an updated
`test/vehicle.test.js` expectation:

| Test | Contract |
|---|---|
| F1 | Led moving-target shot damages; unled shot misses and the round stays in flight. |
| F2 | History interpolates between frames; future timestamps give zero rewind; over-old timestamps fall back; catch-up is bounded. |
| F2b | A death inside a bracket resolves at `deathAt`; the target does not vanish while alive; a respawn is not visible before `spawnTime`. |
| F2c | Rewind equals the displayed-pose age across RTT/jitter profiles, without adding a second latency estimate. |
| F2d | Projectile catch-up is applied once on the first tick and then cleared. |
| F2e | `remoteRenderTime()` never reports a pose older/newer than the buffered range. |
| F3 | Windscreen and side glass expose the occupant; the door below the beltline blocks. |
| F3b | A live bullet path through the windscreen damages the seated occupant. |
| F3c | Ballistic vehicle geometry opens side/front glazing but keeps roof, chassis, pillar, door and truck tailgate solid; a cab windscreen entry is stopped by the bed. |
| F3d | A glazing entry does not make a roof/chassis exit transparent; opposite glazing and occupant fire-out remain open. |
| F3e | A live round entering through glass is stopped by and damages the roof. |
| F4 | A penetrating sniper round keeps essentially the same one-tick travel as free air (15.65 m) and emits one impact. |
| F5 | Window glass takes damage, breaks once, emits one destroy, and stops blocking. |
| F6 (×3) | Standing/crouched zones from four approaches; prone yaw rotation at 0/90/180/270°; silhouette bounds, elevation and vehicle-occupant hitboxes. |
| F7 | No damage or hit event at fire time; damage lands on arrival. |
| F7b | A round fired before a respawn cannot damage the new life. |
| F7c | Two arriving rounds resolve deterministically and kill once. |
| F7d | An ineligible respawned target is not damaged and does not shorten a tick's travel. |
| F7e | An ineligible target does not hide a valid target behind it. |
| F7f | An ineligible target does not hide world geometry behind it. |
| F8 | A bot-style lead damages a moving target under persistent bullets. |

`test/vehicle.test.js` now asserts that hull damage is deferred until the bullet
arrives and occurs after `stepBullets()`.

### Before/after reproduction values

Measured with the same probes on an unmodified `dc3e4c8` worktree and on the
current tree:

| Scenario | Before | After |
|---|---|---|
| Moving target, led DMR shot | miss | 47.31 damage, bullet consumed |
| Moving target, unled DMR shot | hit (frozen pose) | 0 damage, bullet still in flight |
| Windscreen shot at seated occupant | closed hull hit, occupant unreachable | hull still reports solid, ballistic path open, occupant hit |
| Sniper ray over its 0.2 s cap | 191.52 m free air / 4.04 m through 10 thin walls | n/a (persistent round) |
| Sniper round, first 1/60 tick | n/a (no persistent round) | 15.65 m free / 15.65 m through a 2 cm wall, one impact, round alive |
| Window glass after AR fire | `dynamic:false`, `hp:0`, 4 impacts, intact | `hp:34 → -12.5`, destroyed, one destroy event |
| Bullet damage at fire time | queued in `pendingDamage` | no damage until arrival |
| Round fired before respawn | 100 → 72.5 HP across the new life | new life stays at 100 HP |
| Bot-style led AR shot at 40 m | missed | 31 damage |
| Rear-glass entry crossing the roof | no ballistic hit (roof treated as open) | impact at the roof exit (`t≈8.07`), vehicle damaged |
| Target alive at `t=1.000`, dead frame at `t=1.017` | absent from the whole bracket, including `t=1.008333` | present and hittable until `deathAt=1.016667`, absent thereafter |
| Sparse/joining snapshot buffer under high RTT | could report a pose older than the buffer | clamped to `[oldestTime, newestTime]` |
| Respawned target 1.9 m ahead, 60 Hz pistol tick | 1.95 m travelled (guard exhausted) | 6.285 m, same as an unobstructed round; new life undamaged |

### F6 geometry validation

The documented rule is: check the head sphere first; torso and legs are vertical
capsules; the nearest capsule entry wins; a head hit keeps priority over a body
hit up to 0.3 m behind. Prone uses yaw-oriented horizontal head/torso/leg
capsules. Validation confirmed:

- head, torso and leg centres classify correctly from front, back, left and
  right for standing and crouched stances;
- prone zones rotate correctly at 0°, 90°, 180° and −90°, matching the rendered
  horizontal body and its yaw;
- rays just outside the torso radius miss;
- elevated targets keep hitboxes at their authoritative elevation;
- occupants use the crouched seat hitbox (`occupantHeight = 1.0`) regardless of
  the stance they held before entering.

The torso capsule's lower spherical cap overlaps the upper-leg band (standing
≈0.48–0.97 m, crouched ≈0.22–0.71 m). A shot entering that band from the
front/side therefore classifies as torso. This is the nearest-entry capsule rule
and represents the pelvis/hip region; it is documented here rather than adding
extra body regions or reshaping the model without gameplay evidence.

## Verification results

Environment: Linux, Node 24.15.0, Vite 6.4.5, Chromium with SwiftShader.

### Unit and integration tests

```
npm test
```

**Passed: 212/212 tests, exit 0** (baseline `dc3e4c8`: 189/189). The increase is
the 23 Phase 3 regressions, including the six added by the second review
(`F2b`–`F2e`, `F3d`, `F3e`) and the three added by the follow-up review
(`F7d`–`F7f`).

### Production build

```
npm run build
```

**Passed**, exit 0, 70 modules, 1.84 s:

- `dist/assets/index-CVmh1RZ8.js` 1,060.00 kB (gzip 304.38 kB)
- `dist/assets/index-C8gMJUrC.css` 31.19 kB (gzip 8.06 kB)

Only the existing chunk-size warning remains.

### Network harness

```
npm run nettest
```

**Exit 0**, all five profiles completed on loopback:

| Profile | Applied snapshots | Input rate | Correction p95 | Snapshot bandwidth |
|---|---:|---:|---:|---:|
| local | 30.2 Hz | 59.92 Hz | 1.88 cm | 0.94 KiB/s |
| 50 ms / 5% loss | 24.4 Hz | 59.92 Hz | 12.45 cm | 0.93 KiB/s |
| 150 ms / 5% loss | 20.3 Hz | 59.91 Hz | 12.41 cm | 0.93 KiB/s |
| 300 ms / no loss | 30.1 Hz | 59.91 Hz | 1.86 cm | 0.91 KiB/s |
| 300 ms / 5% loss | 20.2 Hz | 59.91 Hz | 12.46 cm | 0.92 KiB/s |

Lossy profiles exercised resync requests and missing-base deltas; no
dropped/replayed snapshot was accepted. These are application-level loopback
measurements, not WAN/TCP-loss or GPU measurements.

### Dedicated multiplayer QA

```
PORT=3211 HOST=127.0.0.1 BOTS=0 node server/server.js
QA_URL='http://127.0.0.1:3211/?server=ws://127.0.0.1:3211/ws' npm run qa:multiplayer
```

**Passed: 29/29 checks, exit 0, no page errors.** Roster, remote replication,
local movement, replicated movement, HUD/ammo/crosshair, compass/minimap, Tab
scoreboard, kill feed, chat isolation/round-trip and reconnect were covered.
Snapshots continued flowing (2,872 observed, ≈233 KiB/s including the QA
sampling burst). `BOTS=0` keeps the Battle Royale movement probe deterministic.
Port 3211 was used to avoid the unrelated servers already bound on 3000/3110/
3200/3300/5173. Chromium was software-rendered, so this is functional coverage
only.

### Peer-hosted QA

```
QA_URL=http://127.0.0.1:3211/ npm run qa:peer
```

**Passed: 20/20 checks, exit 0.** Covers host election, guest join, replication
(0.44 m error), fixed-step host timing, relay disconnect/reconnect, terminal
failure recovery, redeploy, and simultaneous/delayed election.

### Combat performance and event traffic

Synthetic benchmark, identical script on both trees. It uses an open world with
no movement, AI, rendering or world boxes, so it measures combat code only:

| Scenario | Before (`dc3e4c8`) | After |
|---|---:|---:|
| 600 ticks, one AR, close target: shots/hits | 100 / 100 | 100 / 100 |
| … step time p50 / p95 / max | 0.0025 / 0.0184 / 0.417 ms | 0.0026 / 0.0291 / 0.3598 ms |
| … total step time | 4.5 ms | 5.2 ms |
| … event bytes / traffic | 39,396 B / 3.85 KiB/s | 28,719 B / 2.80 KiB/s |
| 600 ticks, 8 AR shooters at a 300 m wall: shots | 800 | 800 |
| … step time p50 / p95 / max | 0.0067 / 1.0244 / 1.3381 ms | 0.0428 / 0.8001 / 1.2925 ms |
| … total step time | 100.6 ms | 97.6 ms |
| … events / event bytes / traffic | 800 / 185,124 B / 18.08 KiB/s | 1,576 / 201,735 B / 19.70 KiB/s |
| … concurrent rounds | n/a (`pendingDamage`) | max 72, mean 65.4 |

The long-range fixture's 2 cm wall is penetrable, so some rounds survive to full
life; the concurrency figure is a synthetic stress bound, not typical gameplay.
The event-count increase is the new standalone `impact` events that previously
rode inside the `shot` payload. Snapshot bandwidth in the real harness is
unchanged at 0.91–0.94 KiB/s.

### Speculative tracing vs persistent bullets

`tryFire()` still traces a speculative `solveBallistic()` ray per pellet to build
the predicted tracer. A focused benchmark measured that trace separately from
the persistent bullet tick (`/tmp/opencode/bench-solve3.mjs`, 400 iterations per
fixture, open world unless noted):

| Scenario | Speculative trace p50 / p95 | Full `tryFire()` p50 / p95 |
|---|---:|---:|
| AR, open air | 0.0301 / 0.0400 ms | 0.0340 / 0.0483 ms |
| DMR, open air | 0.0293 / 0.0487 ms | 0.0263 / 0.0739 ms |
| Sniper, open air | 0.0225 / 0.0677 ms | 0.0252 / 0.0610 ms |
| Shotgun, 8 pellets, open air | 0.0210 / 0.0395 ms per call | 0.1842 / 0.1901 ms total |
| AR, target at 40 m | 0.0053 / 0.0133 ms | 0.0397 / 0.0688 ms |
| Sniper, target at 40 m | 0.0009 / 0.0011 ms | 0.0375 / 0.0561 ms |
| AR, wall at 300 m | 0.0302 / 0.0532 ms | 0.0256 / 0.0356 ms |

Persistent simulation costs about 0.0014–0.0015 ms per tick for 1–8 rounds and
0.0108 ms p50 (0.0130 ms p95) for 72 rounds. The speculative trace is therefore
roughly 0.02–0.03 ms per pellet in open air and ~0.19 ms for an eight-pellet
shotgun blast at 78 RPM. In absolute terms this is small next to a 16.7 ms tick,
even for several simultaneous shooters, and it does not grow with flight time.
No optimization or removal of the tracer path was made; the numbers are a cost
check, not a performance claim.

## Remaining limitations

- **Rounds are server-only state.** In-flight bullets are not replicated as
  objects. Remote players see the predicted tracer at fire time and the
  authoritative impact when it lands; a late joiner cannot see a round already
  in flight. This is intentional to keep snapshots unchanged.
- **Interpolated catch-up assumes the endpoints.** The gap between `viewTime`
  and acceptance is interpolated linearly between two poses, up to 0.4 s. A
  target that reverses direction mid-gap is modelled by its endpoints, not its
  full path; the live phase after catch-up is exact.
- **The shooter is not rewound.** The origin is the shooter's authoritative eye
  at acceptance time, not at `viewTime`. Firing while strafing under high
  latency can still produce an origin offset.
- **History-edge fallback.** When only one history frame brackets a requested
  time, `sampleHistory()` returns the nearest map filtered for spawn/death
  state, without interpolation. The window is bounded to 0.25 s and this is only
  an edge case.
- **Vehicle glazing is penetrable but not destructible.** World window panes
  have HP and a destroyed state; vehicle windows are an always-open ballistic
  band. Per-vehicle glass state would require new replication.
- **Ballistic opening is geometric, not per-pane.** The vehicle model treats the
  whole glazed band as open. Entry is open and a solid exit still blocks, but
  individual vehicle window panes and pillars between them are not separately
  modelled.
- **Tracer/impact mismatch.** The client tracer endpoint is predicted from the
  fire-time pose. For long flights, moving targets and penetrations the final
  authoritative impact can differ from the drawn tracer; the impact event is
  correct.
- **F6 hip overlap.** Upper-leg shots entering the torso capsule's lower cap
  classify as torso. The rule is documented and intentional; only the centres
  and outside-silhouette bounds are asserted.
- **Benchmark scope.** The CPU/event figures come from a synthetic headless
  fixture, not a WAN or GPU test. No performance improvement is claimed; the
  close-range difference is within run-to-run noise.
- **QA environment.** Chromium runs use SwiftShader and cover functional
  behavior, not GPU/render performance. `qa:peer` stubs draw calls.
- **Not committed/deployed.** The Phase 3 changes, the new test file and this
  document are in the working tree only.

## Changed files

```
shared/config.js          CFG.BULLET bounds; glass material hp
shared/weapons.js         persistent bullets, one-time catch-up, swept collision,
                          residual penetration, eligible-target filtering,
                          arrival-time impacts/destruction, ballistic tracer preview
shared/sim.js             bullet lifecycle, sampleHistory() with death/respawn
                          boundaries, fireContext(), lifeId/spawnTime, step ordering
shared/vehicle.js         rayVehicleBallistic() entry/exit glazing classification
shared/world.js           ballistic raycast dispatch, destructible world glass
shared/protocol.js        PROTOCOL_VERSION 9
server/server.js          viewTime-based fire context; nearest-frame rewind removed
src/net/host.js           identical Browser Host fire context
src/main.js               server-clock viewTime, impact event handling
src/prediction.js         remoteRenderTime() clamped to the buffered range
src/render/world.js       merged glass meshes rebuilt on the broken-pane set
test/phase3-combat.test.js (new) 23 F1–F8 and review-round regressions
test/vehicle.test.js      deferred hull damage through stepBullets()
```
