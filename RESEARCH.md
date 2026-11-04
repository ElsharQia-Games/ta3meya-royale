# RESEARCH.md — Sources read and how they shaped the build

> Search integration returned HTTP402 again on2026-11-04. Primary sources can be
> fetched directly. Notes distinguish source claims, repository implementation and
> remaining verification; a source's existence is not proof this build implements it.

## Netcode
- **[Gabriel Gambetta, Client-Side Prediction and Server Reconciliation](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html)** (read directly2026-11-04): prediction must replay inputs newer than the exact last-processed input associated with authoritative state. **Applied:**60Hz input sequence numbers, prediction/replay. The server's rewind currently uses measured RTT plus interpolation delay, not client-reported view time.
- **[Glenn Fiedler, Snapshot Compression](https://gafferongames.com/post/snapshot_compression/)** (read directly2026-11-04): a delta requires a baseline the receiver possesses. **Applied:**30Hz previous-room deltas over ordered WebSocket, explicit baseline continuity checks and keyframe recovery. This is not per-client acknowledged-baseline encoding. The impairment harness now uses the production NetClient and FIFO relay queues.
- **Valve Developer Wiki, *Source Multiplayer Networking* / lag compensation** (blocked by Anubis in this environment; concepts taken from Gambetta's citation and public GDC notes): rewind target hitboxes to the shooter's render time, clamp the rewind window, favour the shooter. **Applied:** 400 ms max rewind, history at 60 Hz, hitboxes rebuilt from stance/height at the rewound tick.
- **Overwatch netcode GDC talk (public summaries):** high tick rate, favour-the-shooter, small packets, interest management. **Applied:** 60 Hz sim / 30 Hz snapshots, event filtering by distance, compact binary protocol.
- **Transport choice:** WebTransport supports streams/datagrams and requires compatible browser/server infrastructure. WebRTC DataChannel requires signalling and ICE, sometimes TURN. WebSocket works with the chosen same-origin HTTP host and tunnel. The application-level `nettest` does not measure TCP head-of-line blocking or establish WAN acceptability; that remains a separate gate. Browser support must be rechecked before any migration.

## Physics / character controller
- **[Rapier JavaScript determinism](https://rapier.rs/docs/user_guides/javascript/determinism/)** (current guide0.21, read2026-11-04): same-version WASM simulation is cross-platform deterministic given identical initial values and construction/removal order. Inputs computed with transcendental functions can still differ across platforms. The current custom controller was chosen for its constrained geometry/control surface; sharing JavaScript code alone is not proof of cross-browser bitwise determinism. Rapier is not currently installed.
- **Quake/Source movement model** (public analyses): separate ground/air acceleration, friction, wish direction, step offset, slope limit, coyote time, jump buffering. **Applied** in `shared/physics.js`.
- **Repository collision contracts:** player motion substeps at0.16m; vehicle translation at0.2m. Existing analytic segment-capsule intersection is reused for horizontal prone hit zones, with yaw included in rewind history. These are constrained controllers, not a general rigid-body engine.

## Rendering
- **Installed Three.js r170 addon source:** CSM, Sky, composer/bloom/output, RoundedBoxGeometry, RoomEnvironment/PMREM, GLTFLoader and geometry merging are used. Near-detail selection is project code; there is no claim of using Three.LOD or DecalGeometry.
- **CSM source contract:** register materials, update every frame, call `updateFrustums()` when projection changes, and rebuild/release cascade resources for quality changes. Material disposal must release the shader registry entry.
- **Local assets:** original canvas materials are supplemented with licensed terrain/nature maps, explicit colour/data colour spaces and asset-ready/disposal ownership.
- **[Three.js r170 colour-management guide](https://raw.githubusercontent.com/mrdoob/three.js/r170/docs/manual/en/introduction/Color-management.html)** (read2026-11-04): lighting/vertex colours use Linear-sRGB; colour maps use sRGB; normal/roughness data have no colour space. Custom ShaderMaterial output must use the correct output conversion. Review sky, cloud and water passes before compensating with arbitrary exposure/fill changes.

## Audio
- **Actual WebAudio implementation:** StereoPannerNode, BiquadFilterNode, noise/oscillator envelopes, DynamicsCompressorNode and analyser measurements. HRTF, OfflineAudioContext gunshot baking and room reverb are possible extensions, not implemented facts.
- Layered gunshot transients/body/tails, distance filtering, footsteps and speed-reactive engine audio are implemented. Numerical levels are checked separately from listening quality.

## Reused asset/component evidence
- [Poly Haven Grass Ground metadata](https://api.polyhaven.com/info/grass_ground) identifies Charlotte Baglioni and dry grass/soil material. The [license](https://polyhaven.com/license) is CC0. Source JPEGs were checked against API hashes; local conversion/normal downsizing is recorded in `public/textures/NOTICE.md`.
- [Quaternius Standard pack](https://quaternius.itch.io/stylized-nature-megakit) was downloaded through its free option. The archive's actual `License_Standard.txt` says CC0. Seven templates were derived; leaves retain source alpha with a project palette. Exact original/derived provenance is shipped with the assets.
- Installed `GLTFLoader.js` explicitly supports `EXT_texture_webp`. The importer emits that extension rather than relabelling WebP as PNG. Shader/geometry behavior was then checked in actual Chromium captures.
- Browser event tracing showed `document.pointerLockElement` could update before the queued `pointerlockchange` listener. Input now checks current state at event/frame boundaries; the observed failure was reproduced in a regression before fixing it.

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
