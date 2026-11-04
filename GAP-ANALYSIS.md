# GAP-ANALYSIS.md — What this build is, and what it is not

*Frontline* is a from-scratch browser tactical shooter with an authoritative
Node server. The reference bar is PUBG / Battlefield / The Finals. This document
separates three things that are easy to blur together:

1. **Measured** — numbers produced by scripts in this repository, on this
   machine, for this revision.
2. **Implemented but unmeasured on target hardware** — systems that exist and
   pass automated checks, but whose *quality* (feel, art, animation) cannot be
   established by those checks.
3. **Not implemented** — the parts of the reference bar that are simply absent.

No commercial assets, names, maps or code are used. All geometry, textures and
audio are generated at runtime or by the build (see ASSETS.md).

---

## 1. Measurement environment and caveats

| Item | Value |
|---|---|
| CPU / RAM | 20 logical cores, 15 GiB |
| OS | Fedora Linux |
| Node | v24.15.0 |
| Browser | headless Chromium via Playwright, **SwiftShader software GL** |
| Network | loopback + an application-level delay/jitter/loss proxy |
| Render resolution | 1600×900 (browser QA), 1280×720 (debug probes) |

Caveats that apply to every number below:

- **No hardware-GPU frame-rate measurement was possible.** Headless Chromium
  used SwiftShader (CPU rasterisation). Its 10 FPS says nothing about a real
  GPU. Draw calls and triangle counts are reported instead; they are a budget
  proxy, not proof of 60 FPS at 1080p.
- **No real WAN test.** `npm run nettest` inserts delay/jitter/loss at the
  WebSocket message level over TCP. It does not model TCP head-of-line
  blocking, route changes, or real packet loss/retransmission. It is stricter
  than a clean link and gentler than a bad one.
- **Stress is a load/invariant test, not gameplay.** It respawns every dead
  player to keep all 32 players simulated for the full 30 minutes. A real BR
  empties out, so real server cost falls over a match.
- **Synthetic clients do not render.** The load test measures server cost and
  bandwidth, not client CPU/GPU cost.
- **Bots are scripted.** Their "skill" is a fixed aim-error parameter, not a
  model of human aim or tactics.

---

## 2. Measured results

### 2.1 Unit and integration tests

```
npm test → 64 tests, 64 pass, 0 fail (~0.7 s)
```

Coverage: deterministic math and quantisation, procedural world generation and
raycasts, capsule physics (slope/step/ceiling/water), weapon data and damage
falloff, the shared `Game` step (movement, shooting, healing, zone, TDM
respawn, kills/score), the binary protocol codec, and lag-compensation rewind.

### 2.2 Long-run simulation stress

```
npm run stress → 32 players, 30 simulated minutes, 108,000 ticks
```

| Metric | Value |
|---|---|
| Players simulated | 32 (all kept alive; 6,306 respawns) |
| Wall time | 69.74 s |
| Ticks per wall second | 1,549 |
| Sim cost per tick, mean | **0.638 ms** |
| Sim cost per tick, p95 | **1.185 ms** |
| Sim cost per tick, p99 | **1.903 ms** |
| Sim cost per tick, max | **29.63 ms** (single spike, likely GC) |
| Tick budget at 60 Hz | 16.67 ms |
| Non-finite states | 0 |
| Out-of-bounds positions | 0 |
| Ground penetrations | 0 |
| Teleports > 2.5 m/tick | 0 |
| Largest single-tick move | 0.593 m (fast fall/vehicle, below the 2.5 m teleport threshold) |

Interpretation: the simulation uses ~3.8 % of one core on average at 32
players, ~11 % at p99. The 29.6 ms maximum is a single missed-tick event over
108,000 ticks; it is disclosed rather than averaged away. This is the server
*simulation* only — networking, serialisation and GC are measured by the load
test below.

### 2.3 32-client server load

```
npm run loadtest → 32 real WebSocket clients, one room, 20 s
```

| Metric | Value |
|---|---|
| Clients joined | 32 / 32 |
| Tick cost, mean | **1.071 ms** |
| Tick cost, max | **1.544 ms** |
| Tick budget | 16.67 ms (≈6.4 % used at max) |
| Snapshot bandwidth, total | **588 KB/s** (~4.7 Mbit/s) |
| Snapshot bandwidth, per client | **18.37 KB/s** (~147 kbit/s) |
| Snapshots received (all clients) | 22,126 |
| Server RSS at end | 130.2 MB |
| RSS growth over 20 s | +22.4 MB |

The bandwidth is dominated by 32-player snapshots (≈19.6 KB each, 30/s) and
1 Hz full keyframes. It is within a small-VPS uplink budget for one room, but
it is *not* free: two full 32-player rooms would approach 10 Mbit/s upstream.
The 20-second RSS growth is not proven to be a leak; it is consistent with V8
heap growth during warm-up, but a multi-hour soak was not run and is listed as
an open item in §5.

### 2.4 Latency / jitter / loss matrix

```
npm run nettest → 5 profiles × 12 s, synthetic player using the real
                 shared prediction + reconciliation code
```

| Profile | Snap Hz | Snap jitter | RTT p50 | RTT p95 | Correction p50 | p95 | Max | Snap KB/s |
|---|---|---|---|---|---|---|---|---|
| local | 30.4 | 3.9 ms | 3.6 ms | 4.5 ms | 1.08 cm | 1.86 cm | 8.0 cm | 0.93 |
| 50 ms + jitter + 5 % loss | 28.7 | 10.1 ms | 100.9 ms | 105.4 ms | 1.12 cm | 11.73 cm | 24.82 cm | 0.88 |
| 150 ms + jitter + 5 % loss | 28.4 | 14.4 ms | 298.5 ms | 318.7 ms | 1.23 cm | 12.11 cm | 24.05 cm | 0.88 |
| 300 ms + jitter, no loss | 30.3 | 21.3 ms | 616 ms | 647.2 ms | 1.19 cm | 12.11 cm | 26.29 cm | 0.95 |
| 300 ms + jitter + 5 % loss | 28.6 | 24.8 ms | 620.8 ms | 656.4 ms | 1.33 cm | 21.42 cm | 27.48 cm | 0.89 |

"Correction" is the distance the predicted local position moves when a snapshot
arrives and unacknowledged inputs are replayed — i.e. the visible snap, not the
expected latency gap. It stays around 1 cm at the median and reaches 12–21 cm
at p95 under 300 ms + loss. That is acceptable for movement, but a 25–27 cm
correction is visible if it happens during a duel. The one-player snapshot
stream is ~0.9 KB/s; see §2.3 for the 32-player figure.

### 2.5 Browser QA

```
npm run qa → lobby, spawn, walk, fire, ADS, sprint, settings
```

- No console errors, no page errors, no failed requests.
- HUD nodes all on-screen at 1600×900; compass centred, minimap top-right,
  kill feed right, vitals bottom-left, ammo bottom-right.
- Frame: **770 draw calls, 1.14 M triangles** at 1600×900, including three CSM
  shadow cascades and post-processing.
- Screenshot statistics: no blown-out (pure white) regions in gameplay frames
  after the sky/exposure retune; sky is ~145–180 mean, ground ~45–60 mean.
  Some frames are dark because the scripted walk ends in shadow or against
  geometry; this is a framing artefact, not a lighting regression.
- **FPS: 10 (SwiftShader software GL).** Not a hardware measurement.

```
npm run qa:multiplayer → two browsers, same room
```

- Roster replicated to both clients; remote character views created.
- Movement on client B observed by client A through interpolation.
- Chat delivered (`Bravo: hello from bravo`).
- Forced socket close → reconnect with the same player id (273 → 273).
- No console or page errors.

---

## 3. Per-system gap table

Legend: **Implemented** = exists and is exercised by tests/QA; **Partial** =
works with documented limits; **Absent** = not in this build.

| System | Status | What is there | Gap vs the reference bar |
|---|---|---|---|
| Movement | Implemented | Deterministic 60 Hz capsule: slopes, steps/stairs, crouch, prone, jump buffer, coyote time, air control, sprint, swimming, fall damage | No vault/mantle, no lean, no slide, no stamina, no third-person animation to sell weight; procedural limb swing only |
| Ballistics | Implemented | Muzzle velocity, gravity, quadratic drag, travel-time damage, penetration with material loss, falloff, head/neck/torso/legs, armour | Damage is scheduled from a solved ray rather than a continuously integrated projectile; ricochet, bullet penetration through multiple walls, and attachments are absent |
| Recoil/spread | Implemented | Per-weapon recoil, spread, ADS, movement penalty, sway | No per-gun recoil *patterns* (PUBG-style spray control), no breath/scope steady, no attachment modifiers |
| Netcode | Implemented | 60 Hz authoritative sim, 30 Hz binary delta snapshots, prediction + replay, interpolation, ack, keyframes, reconnect, interest-filtered events | TCP/WebSocket head-of-line blocking; prediction is movement-only; no full combat replay; no packet-level FEC; lag comp rewinds hitboxes by measured RTT, not per-packet timestamps |
| Lag compensation | Implemented | Server rewinds target hitboxes to shooter view time, clamped to 400 ms; unit-tested | No projectile-history rewind, no compensation for the *target's* ping asymmetry beyond the clamp; can favour the shooter at long range |
| Anti-cheat | Partial | Server owns position/damage/ammo; finite/rate/sequence/action validation; speed and ammo enforced by the sim | No aimbot/statistical detection, no HWID/account bans, no server-side replay audit, no encrypted transport beyond the tunnel's TLS |
| Modes | Implemented | BR with zone phases/win, TDM with teams/respawn/score | No squads, no revive, no ranked ruleset, no custom match settings |
| Lobby | Partial | Room codes, invite link, roster, chat, spectate, reconnect | No matchmaking, no host controls beyond start, no password, no account identity |
| Map | Implemented | Seeded 1 km²: 5 towns + compound, enterable buildings, roads, lake, forests, cover, loot | 1 km² vs PUBG's 64 km²; no named landmark art, no streaming, no vehicle routes tuned over weeks, no interior lighting |
| Destruction | Partial | Destructible cover boxes with HP, collider removal, debris particles; grenade LOS damage | No structural collapse, no fractured meshes, no persistent debris physics, no destruction-driven traversal |
| Vehicles | Partial | Raycast-suspension car, enter/exit, occupants carried, minimap markers | One vehicle class, arcade handling, no damage model, no turrets, no aircraft/boats |
| Loot/inventory | Partial | Ground loot, weapon slots, ammo, armour, bandages/medkits, grenades | No grid inventory, drag/drop, attachments, backpacks, or item rarity UI |
| Bots | Partial | Nav grid + A*, same input shape as players, LOS/reaction/aim error, BR/TDM behaviour | Cannot navigate building interiors; fixed skill; no squad coordination, suppression, or looting |
| Animation | Partial | Procedural character limb swing, stance/aim pose, first-person weapon viewmodel with recoil/reload/ADS | No skeletal animation, IK, mocap, ragdolls, vault/mantle transitions, or facial/upper-body layering |
| Audio | Partial | Procedural WebAudio: layered gunshots, distance attenuation, air-absorption lowpass, HRTF panning, occlusion, footsteps, explosions, ambience, UI cues | No convolution reverb per space, no real asset library, no dynamic music, no voice chat |
| Visuals | Partial | Vertex-coloured terrain, procedural PBR-ish textures, CSM shadows, sky, fog, ACES, bloom, vignette/grain, water, instanced vegetation, tracers/decals/particles | Primitive-based art, no scanned/PBR asset pipeline, no LOD/occlusion culling, no photoreal lighting, 770 draw calls is high for the scene complexity |
| HUD/UI | Implemented | Crosshair, health/armour, ammo, weapon, grenades/heals, minimap + zone, compass, kill feed, scoreboard, damage direction, hitmarkers, spectator, respawn/end, settings, ping/FPS | No inventory screen, attachment UI, squad frames, spawn map, or accessibility options (colour-blind, subtitles, remapping) |
| Performance | Partial | Instancing for vegetation, merged building geometry, pooled effects, measured server tick/bandwidth | **No hardware 60 FPS measurement**; no LOD/streaming/occlusion; 1.14 M tris and 770 draw calls at 1600×900 on software GL only |
| Persistence/accounts | Absent | Room code + reconnect token in `localStorage` | No accounts, profiles, stats history, leaderboards, friends, or server browser |
| Security/ops | Partial | Static host + WS, server authority, input sanitisation, room codes, `/health` + `/stats` | No TLS in-process, no per-IP rate limiting, no auth, no metrics/tracing, no horizontal scaling, single process |

---

## 4. Specific correctness and honesty notes

- **Bots in stress tests are not proof of fun or difficulty.** They are a load
  generator with deterministic-ish aim error. Tuning them is a gameplay task,
  not an engineering claim.
- **The interpolation buffer is 100 ms.** Under 300 ms RTT the client renders
  remote players ~100 ms behind the server plus the snapshot interval; that is
  a deliberate smoothness/latency trade, not a bug.
- **Rewind uses the server's RTT estimate.** A client that lies about its view
  time is clamped to a 400 ms window, but a sophisticated cheater can still
  exploit the margin. Real anti-cheat needs server-side statistical review.
- **Snapshot deltas are per room, not per client.** Every client receives the
  same delta against the room baseline; interest management filters *events*
  and loot, not player state. This is simpler and cheaper, but it means a
  client always receives all 32 players' state. Per-client interest management
  is the next bandwidth win.
- **"No blown pixels" is a numeric check, not an art review.** The screenshots
  were inspected with a luminance/colour analyser (`qa/analyze.py`), not by a
  human or vision model. Composition, silhouette readability and animation
  quality were not judged that way.
- **The 29.6 ms stress spike and 22 MB RSS growth are disclosed, not fixed.**
  Both need a longer soak with heap profiling before they can be called
  non-issues.
- **The client bundle is ~723 KB minified / ~198 KB gzip.** It is a single
  chunk; code-splitting Three.js and the game is not done.

---

## 5. Open items (in priority order)

1. **Hardware GPU profiling** at 1080p on a mid-range discrete GPU and a
   laptop iGPU: frame time, GPU time, draw calls, overdraw. Until this exists,
   the 60 FPS requirement is unproven.
2. **Soak test** (2–4 h) of a live room: RSS/heap, snapshot cache growth, room
   cleanup, reconnect churn, leak detection.
3. **Real network test** over a WAN/tunnel with packet capture, plus a
   WebTransport spike to quantify TCP head-of-line blocking.
4. **Per-client interest management** for player state (not just events) to cut
   the 18 KB/s/client figure.
5. **Animation and art pass**: skeletal characters, IK, vault/mantle, ragdolls,
   better materials/LOD. This is the largest visual gap and cannot be closed
   with primitives alone.
6. **Anti-cheat depth**: server-side aim statistics, shot auditing, replay
   review, account bans.
7. **Content and UX**: squads/revive, attachments/inventory UI, spawn map,
   accessibility, localisation.
8. **Ops**: TLS termination in-process or documented reverse proxy, per-IP
   limits, metrics/alerting, multi-room scaling.

---

## 6. Bottom line

The **systems** are real: deterministic shared movement, server-authoritative
ballistics with lag compensation, delta-snapshot netcode with prediction and
reconnect, BR/TDM, zone, loot, vehicles, destruction, bots, HUD and procedural
audio all run end-to-end and are covered by tests or QA scripts.

The **product** is not a commercial shooter. It is a technically serious
prototype with a stylised procedural look, no skeletal animation, 1 km² instead
of 64 km², 32 players instead of 100, and no hardware performance proof. The
measured server numbers (≈0.64 ms mean tick at 32 players, ≈1.1 ms under 32
real clients, ≈18 KB/s/client) are solid for a small VPS. The measured network
behaviour (≈1 cm median correction, 12–19 cm p95 at 300 ms + loss) is usable
but visible under extreme latency.

If the goal is "friends can play a coherent tactical shooter over a link", this
build meets it. If the goal is "indistinguishable from PUBG/Battlefield/The
Finals", the gap is content, animation, art pipeline and hardware-verified
performance — all listed above rather than hidden.
