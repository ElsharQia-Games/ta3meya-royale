# PLAN.md — Milestones, Acceptance Tests, Build Order

**Project:** *Frontline* — a browser-based, server-authoritative multiplayer tactical shooter.
**Reference bar:** PUBG (scale, ballistics, BR pacing), Battlefield (combined arms, destruction, audio), The Finals (movement feel, destruction spectacle, UI polish).

## Architecture (current)
- **Client:** Three.js r170 + WebGL2. Original procedural equipment/world, CC0 terrain PBR maps, local OFL fonts, CSM, generated IBL, post-processing and WebAudio synthesis (see ASSETS.md).
- **Shared simulation:** plain ES modules imported by both client and server, fixed 60 Hz, custom kinematic capsule controller over heightfield + AABB world. Identical-input replay is tested in Node; cross-browser bitwise determinism is not established. The Rapier decision and corrected determinism evidence are in DECISIONS.md.
- **Server:** Node.js 20+, `ws`, 60 Hz simulation, 30 Hz snapshots. Authoritative movement, weapons, loot, zone, vehicles, destruction, modes. Lag-compensated hit resolution.
- **Transport:** WebSocket over TCP (universal, tunnel-friendly, ordered/reliable). 60 Hz small binary inputs up, 30 Hz quantised/delta binary snapshots down. Evaluated WebTransport/WebRTC in DECISIONS.md.

## Milestones (vertical slices; each must run end-to-end)
1. **M1 — Foundations & feel.** Config, deterministic math, 1 km world with towns/interiors/forest/water/roads, capsule controller (slope/step/crouch/prone/jump/coyote), collision queries, unit tests.
2. **M2 — Combat.** Data-driven 6 weapon classes + DMR, ballistics (drop/drag/travel/penetration), hit zones, armour, recoil/spread/ADS, grenades, healing, loot.
3. **M3 — Netcode.** Binary protocol, input queue, client prediction + replay reconciliation, interpolation buffer, server rewind, delta snapshots, interest-managed events, reconnect, anti-cheat validation. Latency matrix tests.
4. **M4 — Modes & lobby.** Room codes, host/start, BR zone phases + win, TDM teams/respawn/score, spectate, scoreboard, kill feed, chat.
5. **M5 — World interaction.** Destructible cover, raycast-suspension vehicle, loot economy, bots with navigation, 32-player load.
6. **M6 — Presentation.** Procedural characters + animation, first-person weapon viewmodels, effects (tracers/decals/muzzle/explosions), spatial audio with occlusion, HUD/minimap/compass, sky/CSM/post.
7. **M7 — Hardening.** 30-minute physics stress, 50/150/300 ms + jitter/loss matrix, 32-bot server load, browser FPS/draw-call measurements, screenshots + clip, gap analysis, README.

## Acceptance tests (evidence required)
| # | Criterion | Test |
|---|---|---|
| A1 | 16+ players smooth over the internet at 100–150 ms RTT | Local load/proxy tests are prerequisites; a full WAN match with 16+ clients and recorded RTT/frame/tick evidence is required separately |
| A2 | Hits register fairly | automated rewind test: moving target, 150 ms, hit verdict matches shooter view |
| A3 | No stuck/tunnel/jitter in 30 min | `npm run stress` 32 players, 108k ticks, penetration/NaN assertions |
| A4 | Client 60 fps mid-range 1080p | Hardware-GPU frame-time capture at 1920×1080; SwiftShader screenshot QA cannot satisfy this gate |
| A5 | Server 32 players at 60 Hz | `npm run loadtest` with raw tick distribution, input drops, snapshot/ACK bytes and memory; deployment-class VPS measurement separately |
| A6 | Cohesive look | `qa/shots/*.png` + `qa/clip/*.webm`, reviewed against REFERENCE.md |
| A7 | 3-command setup | README: `npm install`, `npm run build`, `npm start` |
| A8 | Gap analysis | GAP-ANALYSIS.md with per-system evidence |

## Active integration and visual-improvement pass

Continue the four existing agent sessions/worktrees; retain their edits through
quota interruptions. The controller reviews actual diffs, reproduces findings,
and integrates verified commits in dependency order. Track this work in
`qa/reports/INTEGRATION.md`.

1. Correct protocol/ACK lifecycle, missing-delta recovery and measurement errors.
2. Verify bot entry/exit on genuinely different map seeds; profile the reported
   long ticks and preserve the shared-world/controller contract.
3. Review and integrate client/HUD/input/audio and renderer changes.
4. Capture a reproducible **1920×1080** scene matrix: BR/TDM; towns, forest,
   hills, lake and interiors; stand/crouch/prone/death; every weapon class at
   hip/ADS/reload/fire; vehicle view/driving; grenade/smoke/destruction; inventory,
   scoreboard, chat, settings, damage, spectate, reconnect and round-end UI.
5. Read the actual images. Record framing, silhouette, material/lighting,
   effect and HUD defects with paths; correct them and recapture affected scenes.
   Keep fixture images distinct from real gameplay captures. Record and inspect
   a gameplay clip, including frame cadence and transitions.
6. Run the combined build/test, browser, stress, latency and load gates. Publish
   current-revision evidence and leave unavailable WAN/GPU/VPS gates open.

Public reference stills are inspiration for evaluation, not runtime assets or
evidence of the reference games' measured performance. `REFERENCE.md` records
their provenance and the concrete visual observations.

## Working rules
- Commit after every working slice; `master` always runnable.
- Keep PROGRESS.md current (done / doing / bugs / gaps / next).
- Never claim a measurement that was not run. Software-GL numbers are labelled as such.
- Gameplay tuning lives in `shared/config.js`; visual tokens/contracts are in `src/render/style.js`, `src/ui/design.css` and DESIGN.md.

## Blackshore / combined-arms presentation pass

User steering: combine grounded tactical pacing with stronger combined-arms
spectacle and graphic/motion polish; improve sound, sniper/RPG and death flows.
Continue the existing four worktrees if their provider becomes available. Their
last attempts hit quota; the controller owns this pass locally.

1. Preserve the current lifecycle corrections. Finish the interrupted multiplayer
   check using bounded, software-renderer-appropriate navigation deadlines.
2. Add authoritative combat kits (Assault, Recon, Breacher, Heavy) with a lobby
   selector and respawn persistence. BR keeps its looted arsenal. Add one-shot
   reloadable RPG: swept live projectile, impacts/blast/cover/vehicle damage,
   bounded lifetime and state/event replication. Upgrade sniper presentation.
3. Introduce sample-based, spatial, cancellable audio. Evaluate requested LANDR/
   Pixabay terms/access and retain source evidence. Source usable recordings
   and Foley under verified redistribution terms; add a documented import path
   for owner-supplied licensed selections.
4. Replace rigid tipping deaths with articulated stance-aware impact/collapse/
   settle motion, terrain/obstacle-aware placement, kill/death information and
   death-to-spectate/respawn transitions. Tie animation/audio to actual state.
5. Refine industrial-coastal world dressing, sightlines and action feedback;
   use spatially bounded render batches so distant content is actually culled.
6. Validate each new kit/weapon/death path in Node and browser, inspect screenshots
   and recorded transitions, then run combined unit/build/multiplayer/stress/
   load/impairment checks. Hardware GPU/VPS/WAN gates still require that environment.
