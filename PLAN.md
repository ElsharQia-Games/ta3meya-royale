# PLAN.md — Milestones & Acceptance

Reference target: PUBG / Battlefield / The Finals feel. This doc is the build order.

## Architecture
- Client: Three.js renderer + deterministic shared sim in JS (no WASM needed; physics is custom capsule/box world, fully deterministic fixed-point-friendly floats).
- Server: Node.js authoritative, same sim module, 30 Hz tick, WebSocket binary protocol.
- Netcode: client-side prediction + server reconciliation (Gambetta), entity interpolation (100 ms), server-side lag rewind for hits, delta snapshots, interest management by distance.

## Milestones
1. **M1 Vertical slice** — move/shoot/zone on a 1km map, authoritative server, 2+ humans vs bots. ✅ target for first commit.
2. **M2 Content** — 6 weapon classes, attachments, recoil/spread/ADS, hit zones, loot, healing, grenades.
3. **M3 Netcode hardening** — prediction/reconcile, rewind, latency sim (50/150/300 ms + jitter/loss), anti-cheat validation, load test 32 bots.
4. **M4 Modes/lobby** — room codes, TDM, spectate, reconnect, scoreboard, killer feed.
5. **M5 World** — towns/forests/hills/water, interiors, destructible cover, 1 drivable vehicle (raycast model).
6. **M6 Presentation** — PBR-ish materials, cascaded shadows, fog/sky, particles/tracers/muzzle/decals, procedural gun/character animation, spatial audio.
7. **M7 Performance + QA** — 60 fps client / 32 players server measured, 30-min stress, gap analysis vs references.

## Acceptance (from brief, all must be evidenced)
- 16+ players, 100–150 ms, smooth; rewind test passes.
- No stuck/tunneling/jitter in 30-min stress.
- Perf budgets measured. Screenshots + clip. README 3 commands. Gap analysis doc.
