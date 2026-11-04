# PROGRESS.md — Current state

_Last updated for the current working tree. Every number here was produced by a
script in this repository; see GAP-ANALYSIS.md for caveats._

## Status

The game is playable end-to-end, online and offline.

- `npm install && npm run build && npm start` → open `http://localhost:3000`,
  enter a room code, deploy. Friends join the same URL/room.
- Offline training runs the same `shared/sim.js` and `server/bots.js` in-tab.
- Online and offline browser QA pass with no console/page errors.
- Two-client QA passes: roster, remote movement, chat, reconnect (same id).

## Verified in this revision

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

- Headless pointer lock emits synthetic movement deltas; QA sets aim/input
  state directly. Real browsers are unaffected (the first post-lock move is
  discarded).
- Some QA screenshots are dark because the scripted walk ends in shadow or
  against geometry. This is framing, not a lighting fault.
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
