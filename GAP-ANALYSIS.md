# Blackshore — evidence and remaining gaps

Updated 2026-11-04. This is an original, server-authoritative browser shooter
and a substantial design/interaction foundation. The PUBG / Battlefield /
THE FINALS comparison remains an aspirational quality bar. Commercial content,
animation fidelity and release-scale performance have not been matched.

## Evidence scope

Code checkpoints: design `54487f8`, network `e8e368a`, simulation `9a71664`,
combined presentation `3adbd7d`, followed by input/deployment QA corrections.
Raw commands/results are in `qa/reports/`, `qa/shots/*/manifest.json` and
`qa/clip/*/metadata.json`. Screenshots were read directly by the controller.

| Check | Observed evidence |
|---|---|
| Combined unit tests |118/118 at the presentation checkpoint; additional pointer-lock/spawn regressions pass in targeted checks |
| Bot interior routes |18/18 on three actual map seeds:20261104,63162945,1356337147 |
| Browser user journeys |`journeys-pass2`: every recorded check passed, including all seven weapons, reload, loot/heal, frag/smoke, destruction, chat/settings, TDM/BR lifecycle and narrow deployment |
| Vehicle input |Real keyboard → Input/App/Game: enter, accelerate, steer, brake, reverse, exit; zero browser errors |
| Equipment matrix |42 poses per pass; seven hip/ADS/fire and three reload phases; every stable optical centre within1px, all arm targets reachable |
| Scene matrix |13 high-quality1920×1080 captures: deployment, town/interiors/upstairs, forest/industry, shore/underwater, four character states, transport |
| Gameplay recording |47.64s VP9,1280×720; real browser actions on a staged training course; silent recording, separate audio levels |

The first browser journey exposed a real pointer-lock event-order race. DOM lock
state was already granted while the cached flag remained false, so mouse fire
was ignored. The regression now passes and the complete journey was rerun.
The clip also exposed initial overlapping TDM spawns; a24-player spacing
regression and clear-spawn selection were added.

## Physics, network and load measurements

The following measurements apply to their named code checkpoints. The final
combined-candidate gate results are appended after the current integration pass.

### Simulation at `9a71664`

32 players,108,000 ticks /30 simulated minutes: mean1.2975ms, p95=1.7733ms,
p99=2.1322ms, max43.626ms. One over-budget tick, tick0, split into35.264ms bot
work and8.383ms game work. Nav construction was317.974ms before tick timing.
Zero player/vehicle finite, boundary or ground violations; zero unexpected
player moves over2.5m/tick. Ground tolerance was0.08m. This identifies the
startup spike's location, not a proven JIT/GC cause.

### Network at `e8e368a`

32 real loopback WebSocket clients over60s:60Hz inputs/client, zero dropped
inputs/skipped snapshots/sim resets. Raw tick mean0.769ms; last600 ticks
p95=1.793ms, p99=2.654ms; room-lifetime maximum13.419ms.

Snapshot+ACK mean592.3KiB/s across the room; all-binary client traffic24.09KiB/s
per client including events/loot. JSON and transport framing are additional.
RSS100.4→177.7MiB, heap22.3→53.6MiB; a long plateau/leak-free soak is unproven.
The load harness retained at most32 pending input timers, matching its clients.

The seeded real-NetClient impairment matrix used **one-way** delays:

| Delay / message loss | Applied snapshots Hz | RTT p50 ms | Correction p95 / max cm | Longest applied gap ms |
|---|---:|---:|---:|---:|
|Local /0%|30.4|3.0|2.00 /8.00|37.4|
|50±5ms /5%|25.4|107.6|12.28 /25.63|234.6|
|150±15ms /5%|21.8|311.6|12.11 /25.00|413.7|
|300±30ms /0%|30.0|626.6|1.84 /2.23|85.2|
|300±30ms /5%|20.2|606.8|12.34 /13.21|760.3|

No-loss profiles have zero ACK/baseline misses. Loss recovery is correct but
waiting for a keyframe can visibly reduce cadence. This is application-message
impairment over TCP, not a packet-loss/HOL or real-WAN result.

## Rendering and temporal review

The environment uses **SwiftShader software rendering**. A separate default
Chromium probe without forced software flags also reported the SwiftShader
Vulkan device. Hardware1080p60fps cannot be inferred from these captures.

The first gameplay recording contained82 measured render frames over39.92s of
action time:2.06fps, median frame460.7ms, p95=700.7ms, maximum1781.1ms. The
clamped client loop advanced7.73 simulation seconds during that period. Its
encoded25fps repeats frames; it is **not** a25fps gameplay result. Six sequential
contact sheets sampled at2fps were read, showing firing, magazine phases, ADS,
walking/stances and steering hands. This verifies the observed sequence and
reveals the severe software-rendering limit; smooth hardware animation remains
an open gate. Post-limiter audio samples peaked at0.071, with maximum RMS0.035;
they do not substitute for a listening review.

Direct visual iteration corrected bulky gun widths/rails, disconnected-looking
scope rings, low reload framing, mismatched foliage colour, over-opaque cabin
glass, giant nearby nameplates and CSM/material ownership problems. The world
still looks stylized: repeated building forms, sparse bespoke props, simple
interior furnishings and primitive-based characters remain evident.

## Per-system limits

| System | Present | Remaining gap |
|---|---|---|
| Movement |Fixed-step capsule, slopes/steps/ceilings, jump/coyote, stances, immersion, fall damage|No vault/mantle/lean; the movement collider is simpler than the articulated body |
| Hit detection |Head/torso/legs, yaw-oriented prone segments, point-blank hits, server rewind|Solved ballistic paths schedule damage; targets are not continuously tested during flight |
| Weapons |Seven classes, ammo/reload/cadence, drop/drag/penetration, shared visual anchors|No attachments, breath control or authored recoil patterns |
| Vehicles |Car/truck hulls, suspension, reverse/steering/brakes, seats/exits, damage, cockpit/steering hands|Constrained arcade dynamics; no general rigid-body rollover/deformation, aircraft or boats |
| Destruction |Cover HP, collision/visual state recovery, blast, debris|No structural collapse or persistent fractured debris physics |
| Bots |Indoor/outdoor navigation, LOS/smoke, reaction/aim error, loot and healing|No squad tactics or human-quality play/difficulty assessment |
| Animation |Articulated poses, two-bone arms, magazine/pump/bolt/feed-cover, steering hands|No skinned/mocap production character pipeline or physical ragdolls |
| UI/UX |Blackshore deployment/manual/HUD, combat/vehicle/heal states, focus, chat/settings, end/spectate/reconnect|No inventory grid, key rebinding, localization, squads/revive or touchscreen controls |
| Audio |Procedural gun/footstep/explosion/engine cues, stereo spatial attenuation/filtering, limiter|No HRTF/convolution spatial engine, authored audio library or voice chat |
| Networking |Protocol6 exact ACK/reset, delta recovery, prediction, interpolation, authoritative validation|WebSocket HOL, movement-focused prediction, no player-state interest culling or full WAN match |
| Operations |Single Node host, room codes, health/stats, documented user-started HTTPS tunnel|No account/matchmaking/persistence service, deployment-scale benchmark or multi-hour soak |

## Open release gates

1. A complete16+player WAN match with recorded RTT/jitter and frame/tick evidence.
2. Hardware-GPU1920×1080 frame-time measurements, including combat/smoke/vehicles.
3. A deployment-class host benchmark and sustained memory/reconnect soak.
4. Further authored art, level dressing and animation refinement against the
   inspected commercial references.

No commercial game assets are shipped. Original procedural assets, CC0 maps/
models and OFL fonts are listed in ASSETS.md. Earlier blanket statements about
all-procedural assets, HRTF audio, absent IK/interior navigation,19.6KB individual
snapshots and a10fps software floor were incorrect and are superseded here.
