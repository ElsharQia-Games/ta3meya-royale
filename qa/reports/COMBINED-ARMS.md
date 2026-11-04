# Combined-arms continuation

## Presentation / gameplay milestone

Milestone `88d554d`, following `f35f8e7`, protocol **7**, Three.js r170. This milestone adds
validated TDM combat kits, live swept RPG rockets, launcher and sniper mechanics,
sampled spatial audio, articulated collapse clips and death/respawn feedback.

Observed on the milestone source:

- `qa/reports/combined-arms-unit-final.log`: **131/131** tests pass. The sustained
  settled-death regression is included. The strengthened real-server Heavy-kit
  inventory check was subsequently run with `node --test test/net-server.test.js`:
  **2/2**, including reconnect ownership.
- `qa/shots/combined-arms-pass2/manifest.json`: **10/10** browser checks, zero
  browser errors, all 36 samples decoded. Production bundle `index-C6d4a_bL.js`.
- Direct image review: Recon deployment, RPG ADS/loading, settled corpse and
  local death card. The previously reproduced finished-clip reset is corrected;
  the settled body stays down. Optical centre is within 1px.
- Build: **956.12 kB JS / 272.13 kB gzip**. RPG-hip fixture: **583,112 triangles /
  1,023 calls**. Spatial culling reduced triangles; draw calls remain substantial.
- Sound-bank decoding: all 36 finite, maximum decoded peak **0.68935**. Sources,
  licences, transforms and exact hashes are in `public/audio/`.

Browser setup/combat fixtures explicitly stage state and advance simulation;
these checks are not a real-time online match. Rendering used SwiftShader.

## Remaining acceptance work

The owner subsequently requested that tests be deferred and design/motion/audio
take priority. The remaining acceptance list is retained for later execution.

1. Live multi-client journeys on a restarted protocol-7 server, including kit
   inventory, launcher flight, reconnect and late-join death/projectile state.
2. Eight-weapon pose matrix and current sniper/RPG/death transition recording.
3. Current BR/TDM, vehicle and responsive journeys; inspect affected captures.
4. Runtime mixed-audio capture/levels and subjective listening review.
5. Combined 30-sim-minute armed stress, 32-client load and impairment profiles.
6. Reconcile status/design/research/README documentation with revision-scoped data.

Hardware 1080p/60fps, deployment-class VPS and a full 16+ player WAN match remain
unverified. The four original worktrees and quota-blocked sessions are preserved.

## Coastal art continuation

- Original field assets replace plain cover cubes: containers, sandbags, barriers,
  supply cases, drums, wrecks, poles and logs. Their authoritative dimensions/IDs
  drive rendering and destruction ownership.
-12 local Poly Haven CC0 surface maps total2,963,644 bytes. All four imported
  albedos were inspected directly. Source/transform/hash provenance is shipped.
- Restored upward-facing road surfaces; added markings/gravel verges, varied
  facade colour, framed entrances, roof/service details and district serials.
- Refined operators, gloves, precision-rifle silhouette, scope/mil marks and bolt
  handling; front-loaded RPG round, exhaust, layered dust and casing pool.
- Death includes camera/weapon fall, asymmetric settling, dropped equipment and
  compact spectator/deployment/respawn motion.
- `coastal-art-pass1`: nine posed1920×1080 engine frames directly read, zero
  reported browser errors. Review caught coplanar roof trim and an optic turret
  intruding into the aperture; source refinements address both.

Before the owner steering, live protocol work reproduced incomplete initial
rocket state in the private server-combat fixture. The payload now uses
`packProjectile` consistently. Its regression was not rerun after the requested
test pause. Multiplayer browser startup also hit shared SwiftShader contention;
separate-process probes were retained for later harness work. Neither is a
completed multiplayer acceptance gate.

### Focused art review — 2026-11-04

- Corrected pass-2 setup: actor creation and frame advancement do not depend on
  `ART_FRAMES` filtering. All nine pass-2 images, including `06-sniper-bolt`, were
  read directly; the capture reports `Preview errors: []`.
- `coastal-art-pass3`: nine 1920×1080 frames, all directly inspected, zero reported
  browser errors and no asset errors. Bundle `index-BKzp7wJC.js`.
- Launcher round now retains its -Z forward axis and seats inside the bore with
  only its tip proud. Front-load alignment precedes insertion; the support hand
  follows the round and returns to the grip. Muzzle/sight anchors follow geometry.
- The impact fixture previously originated inside opaque cover. It now poses an
  exposed-surface impact; distinct hot blast and later dust are visible. Dust is
  larger/longer-lived but remains cosmetic with an 80-sprite cap.
- Local death settles with .22-radian roll rather than .38. Authoritative alive/
  respawn handoff and the 1.1-second BR death-camera hold remain unchanged.
- Smaller scope bodies/adjustment dials improved the hip silhouette. Pass-3 ADS
  review caught upper-aperture hardware clipping; the final scope uses a contoured
  open tube with externally mounted dials. Geometry and overlay share eyepiece
  dimensions; the overlay no longer nearly blacks out all surrounding geometry.
- Latest build: `index-DIf-943Y.js`, **980.35 kB JS / 280.12 kB gzip**;
  CSS **22.79 kB / 6.42 kB gzip**. The existing >500 kB chunk warning remains.
- Pass-3 launcher-hip cost: **2,085 calls / 1,905,831 triangles**, including render
  passes. This is not a controlled comparison or hardware-performance claim.

No automated test suite was run in this continuation. The initial-state projectile
fix and private server-combat fixtures are retained but their real-network
regression remains unvalidated after the owner's pause. Current motion recording
and subjective/mixed-audio review are the next presentation work, not completed
acceptance evidence. All four agent worktrees remain untouched.
