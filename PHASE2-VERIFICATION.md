# Phase 2 Verification — Movement, Prediction and Snapshot Synchronization

Phase 2 remediation against `report2.md`, based on Phase 1 HEAD `1b7dd83`.
The working tree contains the Phase 2 changes; they are not committed or
deployed by this document.

## Scope

Fixed the confirmed mechanisms in `report2.md` F1–F7:

| ID | Defect | Fix |
|---|---|---|
| F1 | Vertical velocity missing from snapshots | `snapshotState()` and the binary player block now carry `vy`; `Prediction.reset()` and `reconcile()` restore it. |
| F2 | Movement state not restored during reconciliation | `coyote` and `jumpBuffer` are part of the wire state (`F.MOVE`); the client derives `swimming` from the restored position with the same helper as the authority. |
| F3 | Delta baseline used raw simulation values | `encodeSnapshot()` quantises the current state first and builds the next delta baseline from the exact values the client can reconstruct. Cumulative sub-quantum movement is no longer dropped until a keyframe. |
| F4 | Vertical substeps reused stale velocity | Each substep applies the current `vel[1]`; integration stops as soon as a floor/ceiling contact clears it. |
| F5 | Wall overlap treated as a ceiling | A box is only a ceiling when the capsule top crossed its underside during the current substep (`prevTop`); pre-existing side overlaps are left to horizontal resolution. |
| F6 | Ground snap ignored headroom | Upward step-up/ground-snap now requires `!capsuleBlocked(...)` at the destination. Terrain step-up gets the same check. Downward snapping is unchanged. |
| F7 | Movement lifecycle reset / floor clamp | Respawn explicitly resets `stanceT`, `coyote`, `jumpBuffer`, `sprinting`, `adsing`, `inWater`, `swimming`, `groundNormal` and `jumped`, in addition to the existing position/velocity/stance/health resets. The `terrainHeight - 0.4` recovery tolerance is retained and documented as a recovery net, not a floor snap. |

### Phase 2 follow-up fixes (P1/P3)

Two issues found while validating the F1–F7 changes were also fixed:

| ID | Defect | Fix |
|---|---|---|
| P1 | Prediction replay skipped the reload/heal timer advance | `advanceMovementTimers()` in `shared/physics.js` is now used by both `Game.stepPlayer()` and `Prediction._apply()`, so the speed penalty expires on the same tick in prediction and authority. Completion side effects (ammo transfer, healing, events) remain authoritative-only. |
| P3 | Negative yaw was re-wrapped during encoding, shifting the wire code by one LSB from the delta baseline | Representation is now one unsigned 16-bit code (`Math.round(wrapAngle(yaw) * 65536/TAU) & 0xffff`); the baseline stores `code / scale` and the encoder writes that same code without re-wrapping. The scale change from `65535/TAU` also removes a systematic ~`0.000096 rad` bias on negative angles. |

## Protocol compatibility

- `PROTOCOL_VERSION` is now **8** (was 7).
- `F.MOVE` (`1 << 12`) was added and `F_ALL` expanded to `(1 << 13) - 1`.
- `F.VEL` now carries three `int16` components instead of two.
- Snapshot yaw uses one 16-bit code over `65536 / TAU`; negative and positive
  angles decode symmetrically and match their delta baseline exactly.
- `isProtocolCompatible()` still accepts only the exact current version, so a
  version 7 client is rejected at join rather than corrupting its cache.
- Dedicated server and Browser Host both use the same `snapshotState()` /
  `encodeSnapshot()` path, so their snapshots stay compatible.
- Keyframes, `baseSeq` continuity checks, resync requests and ACK handling are
  unchanged.

## Regression evidence

New or strengthened tests are in:

- `test/protocol.test.js` — vertical velocity, movement timers, delta velocity
  changes, sub-threshold position accumulation, velocity reaching zero, a
  player joining an existing delta baseline, and negative-yaw
  baseline/round-trip stability.
- `test/prediction-sync.test.js` (new) — reset/reconcile state restoration,
  coyote replay, buffered jump replay, vehicle-transition handling, a 300-tick
  authoritative/predicted simulation over the real encoder at 0 / 10 / 18 tick
  delay, and reload/heal replay from a snapshot over 0 / 10 / 18 pending
  ticks.
- `test/physics.test.js` — high-speed falls (ground and elevated platform),
  ceiling jumps, wall-overlap jumps, inside corners, low-headroom crouch
  step-up, and descending stairs.
- `test/sim.test.js` — clean respawn state and underground recovery without
  pulling down elevated floors.

The F1–F7 regression tests were also run against an unmodified `1b7dd83`
worktree:

- `test/protocol.test.js` + `test/prediction-sync.test.js`: **9 of 25 tests
  failed** on HEAD (missing `vy`, missing movement state, delta drift).
- `test/physics.test.js`: the corridor wall-overlap case failed with
  `maxY=0` (the jump was cancelled as a ceiling contact), and the low-ceiling
  crouch case failed with `top=1.53` against a `1.5 m` ceiling. Both pass on
  the fixed tree.
- F4's final position is partly masked by the existing per-substep ground snap
  and `terrainHeight - 0.4` recovery net on HEAD, so its regressions assert the
  contract (single landing impact, no tunnelling, stable position) rather than a
  final-state differential. The stale-displacement path itself is removed.

Reproduction values after the fix:

- Snapshot decode: `vy=5.5`, `coyote=0.11`, `jumpBuffer=0.12`; prediction reset
  restores the same values and derives `swimming` from position.
- Slow movement at `0.008 m/tick`: client cache tracks the raw position within
  one 2 cm quantum (previously it stayed at the keyframe value).
- Reconciliation over 300 ticks: max position error `≤0.0134 m`, max vertical
  velocity error `≤0.0033 m/s` at 0/166/300 ms delay (measured independently of
  camera smoothing).
- P1 replay from an exact snapshot with `reloadT = healT = 0.035 s`: before the
  fix the prediction drifted `0.30 / 0.63 / 0.90 m` over 12 ticks after
  0 / 10 / 18 pending ticks; after the fix the timer-replay residual is `0 m`
  for all three cases. Wire timer quantisation and delayed timer onset are
  separate effects noted under remaining limitations.
- P3 negative yaw: decoded wire yaw now equals the delta baseline exactly
  (previously one LSB apart), and the remaining quantisation error is at most
  half a code step (`≈4.8e-5 rad`).

## Verification results

Environment: Linux, Node `>=20`, Vite 6.4.5, Chromium with SwiftShader.

### Unit and integration tests

```
npm test
```

**Passed: 189/189 tests, exit 0.**

### Production build

```
npm run build
```

**Passed** (70 modules, 1.88 s). Output:
`dist/assets/index-_9Ejla5i.js` 1,052.54 kB (gzip 301.76 kB) and
`dist/assets/index-C8gMJUrC.css` 31.19 kB (gzip 8.06 kB).
Only the existing chunk-size warning remains.

### Network harness

```
npm run nettest
```

**Exit 0**, all five profiles completed on loopback:

| Profile | Applied snapshots | Input rate | Correction p95 | Snapshot bandwidth |
|---|---:|---:|---:|---:|
| local | 30.3 Hz | 60.00 Hz | 1.98 cm | 0.94 KiB/s |
| 50 ms / 5% loss | 25.2 Hz | 59.91 Hz | 12.59 cm | 0.93 KiB/s |
| 150 ms / 5% loss | 21.7 Hz | 59.92 Hz | 12.79 cm | 0.94 KiB/s |
| 300 ms / no loss | 30.0 Hz | 59.91 Hz | 1.89 cm | 0.91 KiB/s |
| 300 ms / 5% loss | 17.6 Hz | 59.92 Hz | 11.61 cm | 0.92 KiB/s |

Lossy profiles exercised missing-base resync; no dropped/replayed snapshot was
accepted into the cache. These are application-level loopback measurements, not
WAN/TCP-loss or GPU measurements.

### Dedicated multiplayer QA

```
PORT=3112 BOTS=0 node server/server.js
QA_URL='http://127.0.0.1:3112/?server=ws://127.0.0.1:3112/ws' npm run qa:multiplayer
```

**Passed: 29/29 checks, exit 0, no page errors.** The movement probe measured
4.17 m of local movement; A's replicated copy of B updated over the wire
(matching x, z within the expected interpolation distance). Snapshots were
flowing (2755 observed, ≈196 KiB/s for the reporting client). `BOTS=0` is used
because Battle Royale has no respawn, so the movement probe cannot be killed
before it walks. Chromium was software-rendered (~1 FPS), so this is functional
coverage only.

### Peer-hosted QA

```
npm run qa:peer
```

**Passed: 20/20 checks, exit 0.** Covers host election, guest join over relay,
remote replication (0.37 m error), fixed-step host timing, relay
disconnect/reconnect, terminal peer failure returning to the lobby, redeploy,
and simultaneous/delayed election (exactly one host and one guest).

### Snapshot bandwidth (R7)

Measured on an identical deterministic 4-player TDM movement scene (300
deltas, 3 keyframes) using the pre-change encoder from `1b7dd83` and the fixed
encoder:

| Metric | Before (v7) | After (v8) |
|---|---:|---:|
| Average snapshot | 89.04 B | 97.58 B |
| Delta per snapshot | — | +8.54 B (+9.59%) |
| At 30 Hz | 2.61 KiB/s | 2.86 KiB/s |

The overhead is the new `vy` (2 B per moving player per snapshot) plus
`coyote`/`jumpBuffer` when they change. It is bounded and does not affect the
nettest snapshot rate or continuity checks.

## Remaining limitations

- **F4 observability:** because the controller re-snaps to support every tick,
  HEAD's stale-substep bug rarely changes the final position. The fix removes
  repeated post-contact displacement; the tests protect the landing contract.
- **Terrain recovery tolerance:** `terrainHeight - 0.4` is intentionally kept.
  Interior/elevated floors sit above terrain, so the rule only catches invalid
  positions; changing it could displace legitimate interior movement.
- **Timer onset and resolution are snapshot-driven:** P1 makes replay of known
  reload/heal timers correct, but prediction still learns a newly started
  reload/heal only from the next snapshot. Under high latency the penalty can
  start a few ticks late on the client; this is pre-existing action-prediction
  scope, not replay divergence. Reload/heal values are also sent at 10 ms
  resolution, so expiry within one tick of a snapshot boundary can differ by a
  single penalty tick until the next snapshot corrects it.
- **Dynamic world consistency (R5):** prediction still assumes the client and
  authority share the same static geometry. Destroyed props and moving vehicles
  can still diverge; this was out of Phase 2 scope.
- **Public MQTT trust model:** peer QA still uses public brokers. Broker
  failover/reconnect behavior and its trust limits are unchanged from Phase 1.
- **QA environment:** the Chromium runs use SwiftShader and measure functional
  behavior, not GPU/render performance. `qa:peer` stubs the draw call.
- **Not committed/deployed:** the Phase 2 changes, the new test file and this
  document are in the working tree only.

## Changed files

```
shared/protocol.js          snapshot fields, F.MOVE, quantised delta baseline,
                            16-bit yaw code, v8
shared/physics.js           swimmingAt(), ceiling classification, substep velocity,
                            headroom-checked step-up and ground snap,
                            advanceMovementTimers()
shared/sim.js               shared movement-timer advance, explicit respawn reset
src/prediction.js           vy/coyote/jumpBuffer/swim restoration, movement-timer
                            replay, interpolated vy
test/browser-host.test.js   use PROTOCOL_VERSION
test/protocol.test.js       snapshot/delta/yaw regressions
test/physics.test.js        collision/headroom/fall regressions
test/sim.test.js            respawn and recovery regressions
test/prediction-sync.test.js (new) reconciliation, timer replay and vehicle regressions
```
