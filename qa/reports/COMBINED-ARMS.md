# Combined-arms continuation

## Presentation / gameplay milestone

Continuation of `f35f8e7`, protocol **7**, Three.js r170. This milestone adds
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

1. Live multi-client journeys on a restarted protocol-7 server, including kit
   inventory, launcher flight, reconnect and late-join death/projectile state.
2. Eight-weapon pose matrix and current sniper/RPG/death transition recording.
3. Current BR/TDM, vehicle and responsive journeys; inspect affected captures.
4. Runtime mixed-audio capture/levels and subjective listening review.
5. Combined 30-sim-minute armed stress, 32-client load and impairment profiles.
6. Reconcile status/design/research/README documentation with revision-scoped data.

Hardware 1080p/60fps, deployment-class VPS and a full 16+ player WAN match remain
unverified. The four original worktrees and quota-blocked sessions are preserved.
