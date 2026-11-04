# PLAN.md — Milestones, Acceptance Tests, Build Order

**Project:** *Frontline* — a browser-based, server-authoritative multiplayer tactical shooter.
**Reference bar:** PUBG (scale, ballistics, BR pacing), Battlefield (combined arms, destruction, audio), The Finals (movement feel, destruction spectacle, UI polish).

## Architecture (final)
- **Client:** Three.js r170 + WebGL2. Procedural PBR-ish world, CSM shadows, post-processing, WebAudio synthesis. No external art assets (see ASSETS.md).
- **Shared deterministic simulation:** plain ES modules imported by both client and server. Fixed 60 Hz step. Custom kinematic capsule controller over heightfield + AABB world. This is intentionally *not* Rapier: identical code on both sides gives exact prediction/replay, no WASM boot cost, and full control of step/slope/ground behaviour. Justified in DECISIONS.md.
- **Server:** Node.js 20+, `ws`, 60 Hz simulation, 30 Hz snapshots. Authoritative movement, weapons, loot, zone, vehicles, destruction, modes. Lag-compensated hit resolution.
- **Transport:** WebSocket over TCP (universal, tunnel-friendly, ordered/reliable). 60 Hz small binary inputs up, 30 Hz quantised/delta binary snapshots down. Evaluated WebTransport/WebRTC in DECISIONS.md.

## Milestones (vertical slices; each must run end-to-end)
1. **M1 — Foundations & feel.** Config, deterministic math, 1 km world with towns/interiors/forest/water/roads, capsule controller (slope/step/crouch/prone/jump/coyote), collision queries, unit tests.
2. **M2 — Combat.** Data-driven 6 weapon classes + DMR, ballistics (drop/drag/travel/penetration), hit zones, armour, recoil/spread/ADS, grenades, healing, loot.
3. **M3 — Netcode.** Binary protocol, input queue, client prediction + replay reconciliation, interpolation buffer, server rewind, delta snapshots, interest-managed events, reconnect, anti-cheat validation. Latency matrix tests.
4. **M4 — Modes & lobby.** Room codes, host/start, BR zone phases + win, TDM teams/respawn/score, spectate, scoreboard, kill feed, chat.
5. **M5 — World interaction.** Destructible cover, raycast-suspension vehicle, loot economy, bots with navigation, 32-player load.
6. **M6 — Presentation.** Procedural characters + animation, first-person weapon viewmodels, effects (tracers/decals/muzzle/explosions), spatial audio with occlusion, HUD/minimap/compass, sky/CSM/post.
7. **M7 — Hardening.** 30-minute physics stress, 50/150/300 ms + jitter/loss matrix, 32-bot server load, browser FPS/draw-call measurements, screenshots + clip, gap analysis, README.

## Acceptance tests (evidence required)
| # | Criterion | Test |
|---|---|---|
| A1 | 16+ players smooth at 100–150 ms | `npm run nettest` (simulated latency + real WS bots) + load report |
| A2 | Hits register fairly | automated rewind test: moving target, 150 ms, hit verdict matches shooter view |
| A3 | No stuck/tunnel/jitter in 30 min | `npm run simtest` 32 players, 108k ticks, penetration/NaN assertions |
| A4 | Client 60 fps mid-range 1080p | `npm run qa` reports FPS/draw calls (note: CI uses software GL; hardware measurement documented separately) |
| A5 | Server 32 players at 30 Hz | `npm run loadtest` reports tick ms, snapshot KB/s |
| A6 | Cohesive look | `qa/shots/*.png` + `qa/clip/*.webm`, reviewed against REFERENCE.md |
| A7 | 3-command setup | README: `npm install`, `npm run build`, `npm start` |
| A8 | Gap analysis | GAP-ANALYSIS.md with per-system evidence |

## Working rules
- Commit after every working slice; `main` always runnable.
- Keep PROGRESS.md current (done / doing / bugs / gaps / next).
- Never claim a measurement that was not run. Software-GL numbers are labelled as such.
- All tuning lives in `shared/config.js`.
