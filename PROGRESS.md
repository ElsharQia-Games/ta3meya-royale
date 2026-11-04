# FRONTLINE / BLACKSHORE — progress

Updated 2026-11-04. Active goal: a cohesive, playable design foundation with
player-journey evidence. Expanded release acceptance is still open.

Combined-arms milestone **88d554d**: protocol7 RPG/kits, sampled audio and
articulated death/respawn presentation. Its131/131 unit tests and10/10 browser
checks predate the current art work.

**Owner steering: focus on design/animation/audio; defer automated tests.**
Current work adds original collider-sized field equipment,12 photographed coastal
surface maps, road/verge dressing, operator proportions/contact shadows,
precision-rifle mechanics/optic falloff, front-loaded rockets, brass, backblast,
dust, dropped weapons and death/uplink transitions. All nine images in both art
passes 2 and 3 were directly inspected. Pass 3 shows a connected front-load/seat
pose and exposed-surface dust; scope-edge clipping prompted a final refinement.
Production build passes: 980.35 kB JS / 280.12 kB gzip; CSS 22.79 kB.

See `qa/reports/COMBINED-ARMS.md` for current scope. Earlier tables below retain
their historical foundation evidence; final multiplayer/load/stress/WAN gates
are deferred rather than claimed complete.

## Integrated

- Original renderer/client work preserved and merged; Blackshore foundation
  checkpoint `54487f8` adds deployment/manual/settings/HUD, local OFL fonts,
  original equipment, articulated characters, grip IK and terrain PBR.
- Network corrections `e8e368a`, merged at `d93e2f7`: protocol6 exact ACKs,
  connection reset/old-socket guards, missing-delta recovery, wire rejection,
  bounded timers and correctly labelled raw tick telemetry.
- Simulation corrections `9a71664`, merged at `1d23b67`: hybrid navigation,
 18/18 indoor routes on three actual map seeds, vehicle suspension/steering/
  braking/reverse/exit/collision/damage, usable loot placement and inventory/
  healing/destruction lifecycle checks.
- Controller continuation: original car/truck cabins and steering hands,
  camera-relative first-person arm IK, thinner equipment/rails, shared staged
  reload/pump/bolt/feed-cover mechanisms, optic/muzzle anchors, moving vehicle
  snapshots, cockpit HUD/audio, local pickup state and late-join cover restore.
- Seven adapted Quaternius CC0 nature templates, original collider-sized trunks,
  bounded near detail, local WebP maps, improved horizon/loot shapes. Sources and
  transformations are in ASSETS.md and shipped notices.
- Corrected prone hit zones/rewind orientation, point-blank ray hits, swimming
  eye height, shared grenade visual motion, smoke-aware bot vision/nameplates,
  independent shotgun tracers and expired-tracer GPU updates.

## Historical observed checks (predate this art pass)

| Scope | Evidence |
|---|---|
| Earlier controller source | `npm test`: **120/120**; production build passed,907.02kB JS /256.28kB gzip |
| Network branch |77 tests; five real-NetClient impairment profiles; zero missing baselines/ACKs in no-loss runs |
|32-client network load |60s,32/32 joined,60Hz input/client,0 drops/skips/resets; raw tick mean0.769ms, last600 p99=2.654ms, lifetime max13.419ms |
| Simulation branch at9a71664 |108,000ticks /30sim minutes /32players,0 recorded player/vehicle invariant violations; p99=2.1322ms, one43.626ms startup tick |
| Browser journey pass2 |62/62 checks,13 captures, zero errors; fixed a reproduced pointer-lock event-order race |
| Vehicle browser journey | `qa/vehicle.mjs`: E enter, W move, A steer, Space brake, S reverse, E exit; zero browser errors; passenger extension pending |
| Arsenal visual pass2 |42 actual1920×1080 pose screenshots;50/50 checks, all7 optical centres aligned within1px, all arm targets reachable, zero browser errors |
| Scene matrix |13 high-quality1080p captures, all directly inspected, zero browser errors |
| Gameplay clip |47.64s silent VP9 capture; six sampled frame sheets inspected. Software-rendered2.06fps and slowed simulation are recorded explicitly |

The controller read all42 arsenal images in contact sheets and inspected eight
full-size frames. Findings included oversized receivers/rails, over-thick arms,
a missing scope inner wall and red foliage conflicting with the palette. Those
refinements are implemented and recaptured in arsenal-pass2. Cockpit review found
excessive roof/opaque-glass framing; eye/glass/steering-hand corrections are visible
in the recorded clip. Its initial overlap exposed a TDM spawn-spacing defect;
24-player spacing now passes a dedicated regression.

Software-GL frame rates are real measurements (roughly1fps on earlier high-quality
1080p views), not the old clamped10fps floor. They do not establish hardware60fps.
Historical stress/load runs are scoped to their revisions; final combined checks
will be rerun after the remaining integration work.

## Active work

1. Finish the focused launcher/scope/death frame review and commit the art slice.
2. Record current sniper/RPG/death motion with honest frame/time metadata; review
   sampled effects and the mix without substituting decoding for listening.
3. Further improve authored world/character detail while preserving collision and
   simulation ownership. Owner-provided LANDR/Pixabay clips need licence evidence.
4. Automated journeys, real-network projectile regression, multiplayer/stress/
   latency/load and full-release gates remain deferred until authorized again.

## Explicitly open

- Hardware-GPU1920×1080/60fps, deployment-class VPS and a full16+player WAN match.
- Long memory soak: the60s server run showed RSS100.4→177.7MiB; no plateau or
  leak-freedom claim follows from that short run.
- General rigid-body/ragdoll simulation, AAA authored art, vault/mantle/lean,
  squads/revive, attachments/inventory grid, accounts/matchmaking/persistence.
- The four original Big Pickle sessions were resumed at the user's request and
  immediately hit quota again. Their worktrees/context are preserved; controller
  work continues locally. No replacement sessions were created.

See `qa/reports/INTEGRATION.md`, `netcode.md`, `simulation.md`, DESIGN.md and
ASSETS.md for ownership, commands, contracts and provenance.
