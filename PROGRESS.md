# PROGRESS.md — Current state

_Integration in progress, 2026-11-04. Historical measurements below apply to the
pre-agent baseline, not to the combined candidate. See
`qa/reports/INTEGRATION.md` for current findings, revisions and agent ownership._

## Status

The Blackshore design foundation is implemented and undergoing direct visual
iteration. The expanded acceptance criteria are **not complete**. On 2026-11-04
the user re-enabled the same four Big Pickle sessions; their worktrees are retained.

### Current design checkpoint

- Merged renderer `b8a71e3` and client `f486a67` groundwork into master.
- New deployment/mode/manual/settings/HUD theme, live 3D lobby, shared weapon
  geometry/anchors, seven equipment profiles, two-bone grip IK and reload phases,
  articulated tactical characters, material/lighting corrections and close foliage.
- Local CC0 grass PBR maps, facade trim/serials and distant coastal scenery added.
- Current `npm test`: **66/66**; current production build passes, JS 772.92 kB
  (215.53 kB gzip). Pass3 captured seven 1080p scenes with **zero browser errors**;
  deployment, hip, ADS and reload images were read directly.
- Pass1 and pass2 actual 1920×1080 screenshots had no browser errors. Direct
  review identified bulky foreground equipment, sparse scenery and small type;
  pass3 improves the ground and framing but reload hands remain low in frame,
  equipment surfaces are too plain, and trees/distant land remain stylized.
  Full reload/animation/gameplay coverage is ongoing.
- Correct real frame timing now reports roughly **0.9–3 fps on SwiftShader** in
  pass2, not the old clamped 10 fps floor. This is not hardware performance evidence.
- Quaternius free Standard archive downloaded and its CC0 license read; selected
  nature assets are being evaluated. No paid assets or external server deployed.

The following baseline notes are historical until the combined checks are rerun.

- `npm install && npm run build && npm start` → open `http://localhost:3000`,
  enter a room code, deploy. Friends join the same URL/room.
- Offline training runs the same `shared/sim.js` and `server/bots.js` in-tab.
- Online and offline browser QA pass with no console/page errors.
- Two-client QA passes: roster, remote movement, chat, reconnect (same id).

## Historical baseline verification

| Check | Result |
|---|---|
| `npm test` | 64 tests, 64 pass, 0 fail |
| `npm run stress` | 32 players × 30 sim min (108k ticks), 0 NaN / OOB / penetration / teleport; sim 0.638 ms mean, 1.185 ms p95, 1.903 ms p99, 29.63 ms max |
| `npm run loadtest` | 32 WS clients, tick 1.071 ms mean / 1.544 ms max, 588 KB/s total (18.37 KB/s per client), RSS 130 MB |
| `npm run nettest` | 5 profiles up to 300 ms + jitter + 5 % loss; 28.4–30.4 snapshots/s; correction p50 ≈1.1–1.3 cm, p95 11.7–21.4 cm, max 8–27.5 cm; 0.88–0.95 KB/s single-player |
| `npm run qa` | lobby, spawn, walk, fire, ADS, sprint, settings; no errors; 770 draw calls, 1.14 M tris (incl. 3 CSM cascades); 10 FPS on SwiftShader |
| `npm run qa:multiplayer` | roster + remote views + chat + reconnect (273 → 273); no errors |

## What is implemented

- **Shared deterministic simulation** (`shared/`): fixed 60 Hz, capsule
  controller with slopes, steps/stairs, crouch/prone, jump buffer, coyote
  time, air control, sprint, swimming, fall damage; ballistics with muzzle
  velocity, gravity, drag, travel-time damage, penetration, falloff, hit zones,
  armour; recoil/spread/ADS/sway; grenades, smoke, healing, loot, zone, TDM,
  BR, vehicles, destructible cover.
- **Authoritative server** (`server/`): static hosting + `/ws`, room codes,
  join/reconnect tokens, 60 Hz loop, 30 Hz delta snapshots with keyframes,
  RTT probes, lag-compensated rewind (400 ms clamp), interest-filtered events,
  chat, spectate, input validation/rate limits, idle room cleanup, `/health`
  and `/stats`.
- **Client** (`src/`): Three.js r170 renderer with CSM shadows, sky, fog, ACES,
  bloom, vignette/grain, water, instanced vegetation; procedural characters and
  first-person viewmodels; effects (tracers, decals, muzzle flash, particles,
  explosions); prediction/reconciliation + interpolation; WebAudio spatial
  audio; DOM HUD (crosshair, vitals, ammo, minimap/zone, compass, kill feed,
  scoreboard, damage direction, hitmarkers, chat, settings, end screen);
  dead-player spectate camera.
- **Bots** (`server/bots.js`): nav grid + A*, same input shape as network
  players, LOS/reaction/aim error, BR/TDM behaviour.
- **Tools**: unit/integration tests, 30-minute stress, 32-client load test,
  message-level latency/jitter/loss matrix, Playwright screenshot QA, two-client
  multiplayer QA, numeric screenshot analyser.

## Known bugs / rough edges

- **Integration review:** the bot round-trip fixture used gameplay `seed` instead
  of `mapSeed`; correcting it exposes two failures (16/18 successful round trips).
  These are being fixed before merging `agent/sim`.
- **Net review:** expired timer handles accumulated in the load harness, old ACK
  entries could survive a connection epoch, and deltas lacked missing-baseline
  validation. Fixes and lifecycle tests are required before `agent/net` merges.
- **Direct visual review:** baseline vista has repetitive cone trees, sparse
  foreground detail and harsh shadowed props; the ADS weapon is a large solid
  silhouette; countdown/nameplate overlap occurs. These are active visual issues,
  not dismissed as framing artefacts. Image input works for the controller.

- Headless pointer lock emits synthetic movement deltas; QA sets aim/input
  state directly. Real browsers are unaffected (the first post-lock move is
  discarded).
- Bots cannot enter building interiors.
- Spectate is first-person only and only in BR.
- The stress maximum tick (29.6 ms) and 20 s RSS growth (+22 MB) are
  unexplained single events; a long soak with heap profiling is pending.
- Client bundle is one ~723 KB chunk (no code splitting).

## Explicitly not done

- Hardware-GPU 60 FPS measurement (only SwiftShader numbers exist).
- Real WAN/packet-loss test; TCP head-of-line blocking is not modelled.
- Skeletal animation, IK, ragdolls, vault/mantle, lean.
- Accounts, matchmaking, persistence, leaderboards, squads/revive.
- Per-client interest management for player state.
- Aim/statistical anti-cheat, TLS in-process, per-IP rate limiting, metrics.
- Inventory grid, attachments, spawn map, accessibility options.

## Next steps

0. Finish the integration/visual pass in PLAN.md, recapture all representative
   systems, record and inspect a gameplay clip, then update evidence for the
   combined revision. Quota-blocked agent sessions remain saved; the controller
   continues permitted local review and fixes without creating replacement agents.
1. Hardware GPU profiling at 1080p; then LOD/occlusion and draw-call reduction.
2. Multi-hour soak for memory/snapshot-cache growth.
3. Real WAN test through the Cloudflare Tunnel; WebTransport spike.
4. Per-client player-state interest management.
5. Animation/art pass (skeletal characters, IK, better materials).
6. Anti-cheat statistics and replay audit.
7. Squad/revive, inventory/attachments UI, accessibility.

## Working rules

- Commit after every working slice; `main` always runnable.
- Never claim a measurement that was not run; label software-GL numbers.
- All tuning lives in `shared/config.js`.
