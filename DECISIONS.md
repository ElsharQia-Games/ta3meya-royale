# DECISIONS.md — Technical choices and why

## D1. Browser + Three.js + Node, not Godot
- Friends join with a URL; no install, no port forwarding if tunnelled.
- Three.js r170 is mature, has CSM/Sky/post addons and excellent instancing.
- Node and browser import the same simulation modules. Node replay is tested; cross-browser bitwise determinism remains unproven.
- Godot 4 headless + ENet would give better built-in physics/animation, but distributing a native client and explaining port forwarding is worse for this brief. Rejected for sharing friction, not capability.

## D2. Custom deterministic physics, not Rapier
- Static terrain/buildings use a heightfield and AABBs. Moving vehicles use oriented hull queries. The shared kinematic controller keeps step/slope/headroom behavior explicit.
- The existing controller was chosen for direct control of a heightfield/AABB world and a small integration surface. This is not evidence against Rapier determinism: its current JavaScript/WASM documentation explicitly guarantees cross-platform determinism for the same version and identical initialization/order. The earlier blanket determinism/size objection was unsupported and is withdrawn. A future dynamic-body layer should evaluate that supported path.
- Vehicles use a raycast-suspension model on the same collision world (documented approximation: yaw + pitch/roll visual, no full 6-DOF rigid body).
- Trade-off recorded in GAP-ANALYSIS: no stacking dynamic crates/ragdoll physics.

## D3. WebSocket transport
- Universal browser support, works through Cloudflare Tunnel/ngrok, ordered/reliable.
- Inputs are 32 bytes at 60 Hz. At the baseline measured load, 588 KiB/s across 32 clients at 30 snapshots/s implies roughly 627 bytes per transmitted snapshot, not19.6KB per client snapshot. A direct v5 codec probe with32 players produced a1556-byte full keyframe and20-byte unchanged delta. These payload figures exclude transport framing and other state/events/loot traffic.
- Protocol6's separate9-byte ACK names the exact snapshot. It is now integrated with epoch reset, stale-socket guards, u16 wrap and missing-baseline recovery tests. An earlier unsequenced ACK experiment regressed synthetic loss behavior. The old18.8MB/s allocation estimate confused room-total and per-client bytes and was incorrect.

## D4. 60 Hz simulation, 30 Hz snapshots
- 60 Hz matches input cadence and makes movement/replay stable.
-30Hz snapshots and a nominal100ms interpolation buffer balance bandwidth and delay. This is a chosen tradeoff, not a measured claim that higher rates cannot help. Moving/occupied vehicle poses also update at30Hz.
- Server processes one input per simulation tick; fixed-step catch-up consumes queued inputs across multiple ticks, never multiple movement steps inside one tick.

## D5. Ballistics model
- Bullets use a ballistic solver with gravity/drag/penetration and scheduled damage. Wire data includes endpoints/flight times; visible short tracers approximate that trajectory, while damage uses the solver. Grenade presentation reuses the shared fixed-step motion function against replicated world geometry.
- Hitboxes are evaluated against **rewound** player states using the server's measured half-RTT plus the configured interpolation delay, clamped to the rewind window. Client-reported view time is not used by the current server. Damage is applied when the solved bullet would arrive; this differs from continuously integrating a projectile against moving targets.
- Rationale: deterministic, cheap on a 32-player Node server, easy to test, and gives correct drop/penetration/falloff.

## D6. Input/aim authority
- Client sends yaw/pitch/buttons only. Server never accepts positions, damage or hit claims.
- Recoil is applied to the client's aim (camera), so the server sees the compensated aim; spread and fire rate are server-side.
- Anti-cheat validates finite values, sequence monotonicity, input rate, rewind window, action cooldowns (sim-enforced), and sim-enforced speed/ammo.

## D7. Map generation
- Seeded procedural 1 km² map: 5 towns + military compound, enterable multi-storey buildings, roads, lake, forests, rocks, cover, loot. Same seed on client/server → identical colliders.
- Buildings are authored as wall/floor/stair boxes with door/window openings, merged into a handful of draw calls per material.
- Original map/equipment/character geometry is supplemented with documented CC0 nature and terrain assets (ASSETS.md).

## D8. Presentation
- Blackshore uses a restrained olive/amber interface, original equipment with named anchors and articulated IK poses, local PBR/nature assets, CSM, generated IBL and bounded near detail. DESIGN.md defines the extension contracts.
- Audio is synthesized with WebAudio noise/oscillators, stereo panning, distance filtering, dynamic compression and a vehicle loop. HRTF, pre-rendered gunshot variants and geometric audio occlusion were previously claimed incorrectly.

## D9. Deployment
- One Node process serves `dist/` + WebSocket at `/ws` on `:3000`.
- Cloudflare Tunnel is the documented internet path (user starts it; the agent does not expose the machine).
- Room codes select matches. A token is held by the running NetClient; active server sessions stay valid, and a disconnect starts a45s player grace period. Browser settings persist, but refreshing the page is not an account/session persistence feature.

## D10. Verification-driven presentation
- Stable ADS centres and finite reachable arm targets are asserted for all seven classes, then the actual images are read. Numeric alignment alone did not catch a missing scope inner wall or oversized weapon dimensions; those were corrected through the screenshot loop.
- Browser Input/App/Game journeys complement unit tests. Pointer-lock grant/event ordering and TDM spawn overlap were found in browser/clip review and gained regressions.
- Record rendered frame timing separately from encoded video FPS. SwiftShader recordings can repeat frames and slow the clamped client clock; neither proves hardware60fps or a WAN match.
