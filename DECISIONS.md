# DECISIONS.md — Technical choices and why

## D1. Browser + Three.js + Node, not Godot
- Friends join with a URL; no install, no port forwarding if tunnelled.
- Three.js r170 is mature, has CSM/Sky/post addons and excellent instancing.
- Node runs the *same* ES modules as the client, so prediction/replay use byte-identical logic.
- Godot 4 headless + ENet would give better built-in physics/animation, but distributing a native client and explaining port forwarding is worse for this brief. Rejected for sharing friction, not capability.

## D2. Custom deterministic physics, not Rapier
- World is static: heightfield + AABBs (buildings, cover, trees, vehicles). A kinematic capsule controller is enough and gives exact control over step/slope/ground.
- Rapier WASM adds ~1 MB boot, async init, and its solver is not guaranteed bit-identical across client/server builds. Prediction replay needs determinism more than rigid-body realism.
- Vehicles use a raycast-suspension model on the same collision world (documented approximation: yaw + pitch/roll visual, no full 6-DOF rigid body).
- Trade-off recorded in GAP-ANALYSIS: no stacking dynamic crates/ragdoll physics.

## D3. WebSocket transport
- Universal browser support, works through Cloudflare Tunnel/ngrok, ordered/reliable.
- 60 Hz inputs (~26 B) + 30 Hz quantised delta snapshots (≈30 B with one player, ≈19.6 KB with 32 players) stay under 256 kbps/player at the 32-player measured load (~147 kbit/s). WebTransport would remove TCP head-of-line blocking but Safari support and HTTP/3 hosting are not reliable enough for "friends join a link". WebRTC needs TURN for restrictive NATs. Decision can be revisited behind a flag; measured results are in GAP-ANALYSIS.md.
- The per-client input ack lives in the snapshot header, which means one 19.6 KB copy per client per snapshot. Broadcasting one shared buffer plus a 5-byte ack frame was tried and reverted: it removes that copy, but reconciliation then depends on two frames arriving together, and the message-loss harness pushed p95 correction from ~12 cm to ~24 cm. Simplicity and one-frame correctness won over the allocation saving.

## D4. 60 Hz simulation, 30 Hz snapshots
- 60 Hz matches input cadence and makes movement/replay stable.
- 30 Hz snapshots + 100 ms interpolation is the standard bandwidth/latency compromise; 60 Hz snapshots would double bandwidth for little visible gain at 100–150 ms RTT.
- Server processes one input per sim tick, catches up to 4 queued inputs after jitter.

## D5. Ballistics model
- Every bullet is solved as a **ballistic ray**: muzzle velocity, gravity, quadratic drag, penetration, travel-time-scheduled damage. The visible tracer follows the solved path.
- Hitboxes are evaluated against the **rewound** player states (shooter's reported view time) for lag compensation. Damage is applied when the bullet would arrive. This favours the shooter slightly at long range; documented honestly versus PUBG's continuously simulated projectiles.
- Rationale: deterministic, cheap on a 32-player Node server, easy to test, and gives correct drop/penetration/falloff.

## D6. Input/aim authority
- Client sends yaw/pitch/buttons only. Server never accepts positions, damage or hit claims.
- Recoil is applied to the client's aim (camera), so the server sees the compensated aim; spread and fire rate are server-side.
- Anti-cheat validates finite values, sequence monotonicity, input rate, rewind window, action cooldowns (sim-enforced), and sim-enforced speed/ammo.

## D7. Map generation
- Seeded procedural 1 km² map: 5 towns + military compound, enterable multi-storey buildings, roads, lake, forests, rocks, cover, loot. Same seed on client/server → identical colliders.
- Buildings are authored as wall/floor/stair boxes with door/window openings, merged into a handful of draw calls per material.
- No commercial map/asset copying; all geometry and textures are generated (ASSETS.md).

## D8. Presentation
- Stylised realistic look rather than attempting photoreal with no asset pipeline: procedural canvas PBR maps, vertex-coloured terrain, CSM shadows, ACES, bloom, vignette/grain, water shader, instanced vegetation, procedural characters and weapon models.
- Audio fully synthesised with WebAudio (pre-rendered gunshot variants + HRTF panning + occlusion), so no licensing risk.

## D9. Deployment
- One Node process serves `dist/` + WebSocket at `/ws` on `:3000`.
- Cloudflare Tunnel is the documented internet path (user starts it; the agent does not expose the machine).
- Room codes separate matches; reconnect token in `localStorage` for 60 s.
