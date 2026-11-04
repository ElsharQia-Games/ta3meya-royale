# DECISIONS.md — Technical choices and why

## D1. Browser + Three.js + Node, not Godot
- Friends join with a URL; no install, no port forwarding if tunnelled.
- Three.js r170 is mature, has CSM/Sky/post addons and excellent instancing.
- Node runs the *same* ES modules as the client, so prediction/replay use byte-identical logic.
- Godot 4 headless + ENet would give better built-in physics/animation, but distributing a native client and explaining port forwarding is worse for this brief. Rejected for sharing friction, not capability.

## D2. Custom deterministic physics, not Rapier
- World is static: heightfield + AABBs (buildings, cover, trees, vehicles). A kinematic capsule controller is enough and gives exact control over step/slope/ground.
- The existing controller was chosen for direct control of a heightfield/AABB world and a small integration surface. This is not evidence against Rapier determinism: its current JavaScript/WASM documentation explicitly guarantees cross-platform determinism for the same version and identical initialization/order. The earlier blanket determinism/size objection was unsupported and is withdrawn. A future dynamic-body layer should evaluate that supported path.
- Vehicles use a raycast-suspension model on the same collision world (documented approximation: yaw + pitch/roll visual, no full 6-DOF rigid body).
- Trade-off recorded in GAP-ANALYSIS: no stacking dynamic crates/ragdoll physics.

## D3. WebSocket transport
- Universal browser support, works through Cloudflare Tunnel/ngrok, ordered/reliable.
- Inputs are 32 bytes at 60 Hz. At the baseline measured load, 588 KiB/s across 32 clients at 30 snapshots/s implies roughly 627 bytes per transmitted snapshot, not19.6KB per client snapshot. A direct v5 codec probe with32 players produced a1556-byte full keyframe and20-byte unchanged delta. These payload figures exclude transport framing and other state/events/loot traffic.
- The baseline per-client ack lives in the snapshot header and requires a small per-client copy. An unsequenced separate-ACK experiment was reverted after synthetic message-loss regressions. `agent/net` has a new snapshot-sequence-keyed design under review; it must pass connection-epoch and missing-baseline checks before integration. The earlier18.8MB/s allocation estimate used room-total bytes as per-client bytes and was incorrect.

## D4. 60 Hz simulation, 30 Hz snapshots
- 60 Hz matches input cadence and makes movement/replay stable.
- 30 Hz snapshots + 100 ms interpolation is the standard bandwidth/latency compromise; 60 Hz snapshots would double bandwidth for little visible gain at 100–150 ms RTT.
- Server processes one input per simulation tick; fixed-step catch-up consumes queued inputs across multiple ticks, never multiple movement steps inside one tick.

## D5. Ballistics model
- Every bullet is solved as a **ballistic ray**: muzzle velocity, gravity, quadratic drag, penetration, travel-time-scheduled damage. The visible tracer follows the solved path.
- Hitboxes are evaluated against **rewound** player states using the server's measured half-RTT plus the configured interpolation delay, clamped to the rewind window. Client-reported view time is not used by the current server. Damage is applied when the solved bullet would arrive; this differs from continuously integrating a projectile against moving targets.
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
