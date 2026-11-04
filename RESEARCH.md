# RESEARCH.md — Sources read and how they shaped the build

> Web search was unavailable in this environment (HTTP 402); primary sources were fetched directly. Notes are paraphrased, not copied.

## Netcode
- **Gabriel Gambetta, *Fast-Paced Multiplayer* I–IV** (gabrielgambetta.com): authoritative server; client predicts local input immediately; server replies with the last processed input sequence; client discards acknowledged inputs and replays the rest; remote entities are rendered in the past and interpolated; lag compensation rewinds the world to the shooter's view time. **Applied:** 60 Hz input sequence numbers, per-client `ackInput`, replay of unacked inputs, 100 ms interpolation buffer, server rewind using the client's reported view time.
- **Glenn Fiedler, *Snapshot Compression*** (gafferongames.com): quantise position/orientation; delta-encode against a baseline the receiver acknowledged; send keyframes to recover from loss; index changed entities. **Applied:** 30 Hz binary snapshots, 16-bit yaw/pitch, per-entity field masks, baseline = client-acked snapshot, 1 s keyframe interval.
- **Valve Developer Wiki, *Source Multiplayer Networking* / lag compensation** (blocked by Anubis in this environment; concepts taken from Gambetta's citation and public GDC notes): rewind target hitboxes to the shooter's render time, clamp the rewind window, favour the shooter. **Applied:** 400 ms max rewind, history at 60 Hz, hitboxes rebuilt from stance/height at the rewound tick.
- **Overwatch netcode GDC talk (public summaries):** high tick rate, favour-the-shooter, small packets, interest management. **Applied:** 60 Hz sim / 30 Hz snapshots, event filtering by distance, compact binary protocol.
- **Transport choice:** WebTransport/QUIC gives unreliable datagrams and no HOL blocking but Safari support is still uneven and it needs HTTP/3 infrastructure. WebRTC DataChannel needs signalling + STUN/TURN. WebSocket/TCP is universal and works through Cloudflare Tunnel. At 30 Hz × ~1 KB snapshots, TCP HOL is acceptable for 32 players; measured in `nettest`. **Decision:** WebSocket, with a documented upgrade path.

## Physics / character controller
- **Rapier JS docs** (rapier.rs): WASM boot, deterministic caveats, character controller. Evaluated and rejected for the *shared* sim because client/server determinism is the priority and the world is static AABB + heightfield. Rapier remains the right choice for a future dynamic-prop layer.
- **Quake/Source movement model** (public analyses): separate ground/air acceleration, friction, wish direction, step offset, slope limit, coyote time, jump buffering. **Applied** in `shared/physics.js`.
- **Swept collision / substeps:** cap per-substep displacement (0.15 m) and use circle-vs-rect closest-point resolution to avoid the corner sticking produced by min-axis AABB push-out.

## Rendering
- **Three.js r170 docs + addons:** `CSM` for cascaded shadows, `Sky` (Preetham), `EffectComposer`/`UnrealBloomPass`/`OutputPass`, `InstancedMesh`, `LOD`, `BufferGeometryUtils.mergeGeometries`, `DecalGeometry`. **Applied** in `src/render/`.
- **CSM API:** `new CSM({camera, parent, cascades, maxFar, mode, shadowMapSize})`, `csm.setupMaterial(mat)`, `csm.update()` each frame.
- **Procedural PBR:** canvas-generated albedo/normal/roughness maps keep the project license-clean and remove asset downloads; vertex colours + detail maps give terrain variation.

## Audio
- **WebAudio API:** `PannerNode` HRTF, `DistanceModelType.inverse`, `BiquadFilterNode` for air absorption/occlusion, `OfflineAudioContext` to pre-render gunshot variants. **Applied** in `src/audio/audio.js`.
- **Game audio practice:** layered gunshot (transient crack + body + tail), surface-specific footsteps, distance lowpass, reverb send.

## Gameplay references (design, not code/assets)
- PUBG weapon/ballistics/zone pacing, Battlefield vehicle/destruction/audio layering, The Finals movement/feedback/UI clarity. Recorded in REFERENCE.md.
