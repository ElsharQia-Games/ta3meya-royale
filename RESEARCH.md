# RESEARCH.md — Sources read and how they shaped the build

> Search integration returned HTTP402 again on2026-11-04. Primary sources can be
> fetched directly. Notes distinguish source claims, repository implementation and
> remaining verification; a source's existence is not proof this build implements it.

## Netcode
- **[Gabriel Gambetta, Client-Side Prediction and Server Reconciliation](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html)** (read directly2026-11-04): prediction must replay inputs newer than the exact last-processed input associated with authoritative state. **Applied:**60Hz input sequence numbers, prediction/replay. The server's rewind currently uses measured RTT plus interpolation delay, not client-reported view time.
- **[Glenn Fiedler, Snapshot Compression](https://gafferongames.com/post/snapshot_compression/)** (read directly2026-11-04): a delta requires a baseline the receiver possesses. **Current implementation:**30Hz field-mask deltas against the previous room snapshot over ordered/reliable WebSocket, periodic keyframes. It does not implement per-client acknowledged snapshot baselines. Review identified missing continuity validation under the synthetic message-loss harness; recovery is an active fix.
- **Valve Developer Wiki, *Source Multiplayer Networking* / lag compensation** (blocked by Anubis in this environment; concepts taken from Gambetta's citation and public GDC notes): rewind target hitboxes to the shooter's render time, clamp the rewind window, favour the shooter. **Applied:** 400 ms max rewind, history at 60 Hz, hitboxes rebuilt from stance/height at the rewound tick.
- **Overwatch netcode GDC talk (public summaries):** high tick rate, favour-the-shooter, small packets, interest management. **Applied:** 60 Hz sim / 30 Hz snapshots, event filtering by distance, compact binary protocol.
- **Transport choice:** WebTransport supports streams/datagrams and requires compatible browser/server infrastructure. WebRTC DataChannel requires signalling and ICE, sometimes TURN. WebSocket works with the chosen same-origin HTTP host and tunnel. The application-level `nettest` does not measure TCP head-of-line blocking or establish WAN acceptability; that remains a separate gate. Browser support must be rechecked before any migration.

## Physics / character controller
- **[Rapier JavaScript determinism](https://rapier.rs/docs/user_guides/javascript/determinism/)** (current guide0.21, read2026-11-04): same-version WASM simulation is cross-platform deterministic given identical initial values and construction/removal order. Inputs computed with transcendental functions can still differ across platforms. The current custom controller was chosen for its constrained geometry/control surface; sharing JavaScript code alone is not proof of cross-browser bitwise determinism. Rapier is not currently installed.
- **Quake/Source movement model** (public analyses): separate ground/air acceleration, friction, wish direction, step offset, slope limit, coyote time, jump buffering. **Applied** in `shared/physics.js`.
- **Swept collision / substeps:** cap per-substep displacement (0.15 m) and use circle-vs-rect closest-point resolution to avoid the corner sticking produced by min-axis AABB push-out.

## Rendering
- **Three.js r170 docs + addons:** `CSM` for cascaded shadows, `Sky` (Preetham), `EffectComposer`/`UnrealBloomPass`/`OutputPass`, `InstancedMesh`, `LOD`, `BufferGeometryUtils.mergeGeometries`, `DecalGeometry`. **Applied** in `src/render/`.
- **CSM API:** `new CSM({camera, parent, cascades, maxFar, mode, shadowMapSize})`, `csm.setupMaterial(mat)`, `csm.update()` each frame.
- **Procedural PBR:** canvas-generated albedo/normal/roughness maps keep the project license-clean and remove asset downloads; vertex colours + detail maps give terrain variation.
- **[Three.js r170 colour-management guide](https://raw.githubusercontent.com/mrdoob/three.js/r170/docs/manual/en/introduction/Color-management.html)** (read2026-11-04): lighting/vertex colours use Linear-sRGB; colour maps use sRGB; normal/roughness data have no colour space. Custom ShaderMaterial output must use the correct output conversion. Review sky, cloud and water passes before compensating with arbitrary exposure/fill changes.

## Audio
- **WebAudio API:** `PannerNode` HRTF, `DistanceModelType.inverse`, `BiquadFilterNode` for air absorption/occlusion, `OfflineAudioContext` to pre-render gunshot variants. **Applied** in `src/audio/audio.js`.
- **Game audio practice:** layered gunshot (transient crack + body + tail), surface-specific footsteps, distance lowpass, reverb send.

## Gameplay references (design, not code/assets)
- PUBG weapon/ballistics/zone pacing, Battlefield vehicle/destruction/audio layering, The Finals movement/feedback/UI clarity. Recorded in REFERENCE.md.
- Public Steam app-details endpoints578080/1517290/2073850 returned the verified
  game names and publisher-provided comparison stills. Three images were downloaded
  into ignored `qa/shots/references/` and read directly. Exact sources and concrete
  silhouette/material/composition observations are in REFERENCE.md.
- [Embark Studios](https://www.embark-studios.com/) (read2026-11-04) describes
  THE FINALS' alterable/destroyable arenas and links its *Making THE FINALS:
  Capturing Authentic Sound* and procedural-content/animation talks. The landing
  page was read; those videos were discovered, not watched or cited as measured
  implementation details.
