# PROGRESS.md

## Done
- M1 scaffold (package.json, index.html, vite, PLAN/DECISIONS).
- M1 vertical slice: capsule/step/slope physics, hitscan falloff + head/torso/legs, zone, grenades, healing, TDM/BR, 12 bots, 30 Hz WS server, Three.js client with minimap/HUD/killfeed.
- M2 content: 6 weapon classes in config, recoil/spread/ADS all functional.
- M3 netcode: client-side prediction (predicted local sim each send), snapshot reconciliation (epsilon snap), server history (20 s), rewind firing (save/restore + fireHitscan at rewound snapshot), anti-cheat rate/finite/displacement checks.
- M5 vehicle: 3 cars spawned server-side, enter/exit via E, occupants carried, minimap markers, vehicle mesh rendering.
- M6 presentation: weapon view model + recoil kick, tracer/impact particles, destructible chunk debris, shadows/ACES fog.

## In progress
- M7 QA: headless browser screenshot, latency/loss matrix, FPS measure, gap analysis doc, README.

## Known gaps vs reference
- PUBG/Battlefield/The Finals polish remains far ahead (real character animation, PBR asset pipeline, spatial audio with distance model, water interiors, attachments, 100+ players). Recorded honestly in GAP-ANALYSIS.md.
- Prediction is snap-based (not full replay re-simulation of unacked inputs). Recorded as gap.
- No real textures/models — procedural primitives only. CC0 asset pipeline not yet added.

## Next
- Playwright screenshot + fps + bot websocket load test 32 players.
- GAP-ANALYSIS.md, README.md (3-command run), latency/loss matrix.
