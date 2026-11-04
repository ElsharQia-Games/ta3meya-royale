# Simulation / player-journey integration

Updated 2026-11-04. Original agent commit `e9f878f` and its handoff remain in Git.
The controller retained that work and completed the following fixes in the same
`agent/sim` worktree after repeated Big Pickle quota errors.

## Verified at this checkpoint

`npm test`: **96 tests passed, zero failed**. This is a Node simulation check;
browser interaction/rendering and combined-master validation follow integration.

### Navigation and world geometry

- Corrected fixture `seed` to **mapSeed**. The original claimed three-map result
  actually ran the default world three times.
- Hybrid6m outdoor grid plus0.4m local building grids, actual capsule clearance,
  world-owned WeakMap cache and reused A* scratch buffers. Doorways no longer rely
  on clearing a coarse cell through a neighboring solid wall.
- Building partitions avoid bisecting entrance corridors. Furniture stays clear
  of doors. Building foundations/pads remain within the player step contract.
- Indoor objectives require physical entry and an unobstructed approach, not
  just proximity through a wall. The remaining seed20261104/building10 failure
  was reproduced at17/18, corrected, and recaptured at18/18.
- Final route fixture: **18/18** entry → interior objective → exit, across
  map seeds20261104,63162945,1356337147. Cases63162945/building9 and
 1356337147/building45 remain in the coverage. Final entry47–52 ticks,
  objective55–253 ticks, exit29–226 ticks; each phase bounded to1500 ticks.
- Direct scans found18/12/15 loot points embedded in geometry on those maps.
  Deterministic local placement repair moves invalid points to clear supported
  floor without changing layouts, RNG consumption or loot counts. All three
  maps now pass the embedded-loot invariant. Repaired points can change route
  endpoints; challenging building selection and the actual-entry requirement stay.

### Vehicle behavior

Ten behavioral regression cases exercise entry, exit, motion and damage:

- Reject dead/far/wrong-floor players and wreck/flooded vehicle entry.
- Choose a capsule-clear exit; keep the seat occupied if no exit is available.
  Death/removal releases the seat.
- Signed bicycle steering, separate27m/s forward and8m/s reverse caps; S brakes
  before reversing, Space brakes, silent/disconnected drivers cannot accelerate.
- Four suspension contacts support the configured weight. The old body floor
  clamp concealed zero spring support; the corrected static compression is
  `mass * gravity / (4 * springK)`. Wheel spin integrates once per tick.
- Oriented car/truck hulls collide with walls and each other. Horizontal motion
  substeps at0.2m; the full footprint is contained by map bounds.
- Players collide with parked hulls. Faster vehicle contact can cause authoritative
  impact damage; flooded engines stop providing propulsion.
- Ballistic/blast/impact damage lowers vehicle health, emits destruction once
  and releases/ejects occupants. The driver cannot shoot a hidden weapon.
- Shared `vehicle.js` owns dimensions, hull queries and packed presentation data.
  Hulls are simplified oriented boxes; suspension pitch/roll is a constrained
  presentation model, not a general six-degree-of-freedom rigid-body engine.

### Combat / inventory / lifecycle

- Existing tests cover all seven weapon classes, cadence, reload/reserve limits,
  falloff, penetration, hit zones and deterministic600-tick replay/event stream.
- Added full-duration/capped bandage and medkit checks. Damage and weapon
  switching interrupt healing; heal/reload are mutually exclusive.
- Duplicate-class weapon pickups supply reserve ammo instead of aliasing two
  slots. Removed loot cannot be granted twice. Pickup range includes height and
  line of sight; objects cannot be grabbed from another floor/through walls.
- Destroyed cover IDs are recorded for state replication; a new round restores
  both visibility state and max health. Renderer/server state hooks must be
  integrated before claiming late-join/restart presentation correctness.
- Growing from prone to crouch, as well as crouch to standing, checks headroom;
  the current stance height is used during the same movement step.

## Stress evidence

The old237.6ms stress maximum was not explained by lazy nav construction: grids
are created in `spawnBots` before the stress timer starts. That earlier causal
claim is withdrawn. The updated harness separately records nav boot, raw tick
times, over-budget tick indices, bot/game cost split, stricter0.08m live-player
ground tolerance and vehicle finite/ground/boundary counters.

The new108,000-tick run is pending at this code checkpoint. Its exact command,
revision and counters will be appended after completion; historical figures are
not treated as evidence for these vehicle/world changes.

## Remaining gates

Combined-master build/unit tests, live browser player journeys, full screenshot
matrix, gameplay clip, final stress/load/latency checks. Cross-browser bitwise
determinism, hardware1080p60fps, deployment-class VPS performance and a full
16+player WAN match are not established by the Node fixtures.
