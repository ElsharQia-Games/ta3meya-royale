# Phase 4 Verification — Rendering Performance and Production-Quality Audio

Phase 4 remediation against `report4.md`, based on Phase 3 HEAD `31222dc`.
The working tree contains the Phase 4 changes described here; this document does
not claim the commit or deployment itself.

`report4.md` was treated as a validation specification. Each finding was
re-checked against `31222dc` before changing code. Confirmed defects were fixed
with targeted regressions; findings that were already bounded or that required
gameplay changes were left alone and are recorded below.

## 1. Findings validation

| ID | Reported finding | Status on `31222dc` | Phase 4 result |
|---|---|---|---|
| F1 | Expensive character presentation runs before visibility culling | **Confirmed.** `CharacterView.update()` computed stance, weapon pose, IK, shadow placement and terrain queries before any distance check. Dead characters had a separate path that could also bypass culling. | Presentation is split into essential lifecycle, visibility, animation/IK and shadow/nameplate work. Tiers at 65 m and 140 m; hidden characters keep timers advancing. |
| F2 | Completed death animations keep updating | **Confirmed.** The mixer, world matrices, terrain support queries and hand vectors were recalculated every frame after the 1.4 s collapse. | `settled`/`poseApplied` state stops mixing and terrain queries once the terminal pose is applied; culled corpses only advance their clock. |
| F3 | Per-frame allocations in effects, posing and animation | **Confirmed** in the hot paths inspected: `reloadMotion`, `boltMotion`, `poseWeaponMechanics`, tracer records, particle colour conversion and smoke sight-line arrays. | Caller-owned scratch records for animation/weapon pose, pooled tracer records, reused `THREE.Color`, scalar smoke math. |
| F4 | Loot model construction and GPU churn at the 65 m boundary | **Confirmed.** `syncLoot()` created a full weapon/armour model on entry and disposed it on exit, so boundary oscillation rebuilt geometry and materials. | 65 m create / 78 m retain hysteresis, a bounded per-shape pool (16 detached meshes), keyed weapon identity, and pooled-resource disposal on teardown. |
| F5 | Snapshot and visibility allocation costs | **Partially confirmed.** `smokeObscures()` allocated arrays and closures per character per frame. `SnapshotBuffer.push()` copies bounded snapshot data, but the copy preserves historical immutability and Phase 3 `viewTime`/reconciliation semantics. | Smoke sight-line math is scalar. Snapshot buffering was benchmarked and deliberately left unchanged: 5.5 µs per push with 31 players, retained history 30 frames. |
| F6 | Graphics settings, disposal and long-session stability | **Confirmed** for preset validation and renderer teardown. Quality presets were not normalised; renderer-owned composer/CSM/shadow resources had no single disposal path. No measured case justified a new LOD framework. | Validated monotonic presets, `GameRenderer.stats()` and `GameRenderer.dispose()`, plus loot-pool teardown. |
| F7 | Audio node lifecycle leaks | **Confirmed.** Node ownership was spread across delayed playback, loops and cleanup paths, and the old core bank still used synthesized substitutes. | Recorded-only playback with a central sound table, voice budget, owned loop objects, idempotent cleanup, and session teardown. |
| F8 | Remote footsteps and spatial consistency | **Confirmed.** The sampled-footstep path did not consistently use the same spatial/occlusion path as other world sounds. | Local footsteps are centred; remote footsteps use the same listener, distance, pan, delay, filtering, reverb and occlusion path as gunfire. |

### Root causes

- Update order mixed lifecycle state with presentation, so invisible characters
  paid for animation, IK and terrain work.
- Death animation had no terminal state, so its mixer was resampled forever.
- Convenience allocations were used inside per-frame and per-shot paths.
- Loot lifetime was tied directly to a visibility threshold, with no hysteresis
  or reuse.
- Audio definitions were scattered, core sounds still had synthesis fallbacks,
  and loop/scheduled-node ownership was not centralised.
- Quality presets were not validated, and renderer-owned GPU resources did not
  have a single teardown owner.

## 2. Rendering implementation

### Character presentation tiers (`src/render/entities.js`)

- `characterDetail(distance)` returns `full` at `<= 65 m`, `basic` at
  `65–140 m`, and `hidden` above `140 m`.
- `null`/`NaN` distance keeps the historical `full` path. `Infinity` is the
  explicit “not visible” signal and maps to `hidden`.
- Lifecycle state (`shotT`, hit kick, walk clock, reload/bolt timers, death
  clock) advances before the visibility branch.
- `hidden`: rig, nameplate and shadow are not presented; the corpse clock still
  advances.
- `basic`: body/weapon pose and nameplate stay visible, but arm IK, terrain
  shadow queries and character shadow casting are skipped.
- `full`: normal pose, two-bone IK and shadow placement.
- Re-entry uses a single accelerated damping step (`poseDt = .5`) instead of
  replaying missed frames, so reload/stance state does not pop.

### Death animation (`src/render/death-animation.js`)

- `advance(dt)` changes only the age.
- `applyPose()` samples the mixer and performs terrain support queries once.
- After the terminal pose is applied, `update()` returns the stored hand
  position without resampling the mixer or querying terrain.
- Culled corpses call `advance()` only; on re-entry they sample the correct
  authoritative pose once.

### Allocation reduction

- `reloadMotion`, `boltMotion` and `poseWeaponMechanics` accept caller-owned
  output records; the first-person view model and every character view reuse
  one per instance.
- Tracer records and their coordinate arrays are recycled through a bounded
  96-entry ring and a free list. Caller arrays are copied so they can be reused.
- Particle colour conversion reuses one `THREE.Color`.
- Death-animation hand vectors and world-position scratch are instance/module
  owned.
- `smokeObscures()` uses scalars and no intermediate arrays.

### Loot pooling (`src/render/world.js`)

- Create within 65 m, retain until 78 m, hide rather than dispose while retained.
- Absent items are recycled immediately, not retained indefinitely.
- A per-shape pool is capped at 16 detached meshes; overflow is disposed.
- Weapon keys include the weapon type (`weapon:ar`, `weapon:sniper`), so an AR
  mesh is never reused for a pistol.
- Match teardown disposes pooled meshes as well as active loot.

### Graphics and lifecycle (`src/settings.js`, `src/render/renderer.js`)

- `normalizeQuality` and a frozen monotonic preset ladder reject unknown values
  and cannot leak unbounded pixel ratios/shadow sizes.
- `loadSettings` clamps persisted FOV and volume.
- `GameRenderer.stats()` exposes draw calls, triangles, geometries, textures,
  programs, shadow state, view distance, fog density and FPS.
- `GameRenderer.dispose()` releases composer passes, CSM lights/shadow maps,
  environment target, sky/cloud geometry and materials, then the renderer.
- No new LOD framework was introduced.

## 3. Audio architecture

- `src/audio/sounds.js` is the single sound table. Every definition declares
  category, priority, maximum voices, gain, distance range, filter profile,
  reverb send, playback-rate range, cooldown and variation pool.
  `CATEGORY_DEFAULTS` sets the category mixing contract; the global voice limit
  is 40.
- `src/audio/spatial.js` provides listener basis, monotonic distance gain,
  stereo pan, propagation delay, nearest projectile path, indoor detection and
  distance-dependent cutoff.
- `src/audio/voices.js` enforces the global budget and per-category caps with
  priority stealing. Cancellation is idempotent.
- `src/audio/samples.js` loads `core` eagerly and `vehicle`/`ambience` on demand.
  A failed clip is recorded once and never substituted. `ReloadCues` keeps its
  logical API (`mag-out`, `mag-in`, `bolt`, `shell`) and follows actual reload
  time rather than fixed timers.
- `src/audio/audio.js` performs recorded-only playback, distance filtering,
  stereo placement, propagation delay, occlusion ray filtering, indoor reverb
  send, recorded engine/ambience/alarm loops, cooldowns, voice admission and
  session teardown.
- Engine audio cross-fades recorded idle and drive loops by speed, applies
  subtle Doppler from `forwardSpeed`, and adds the recorded skid loop when
  braking or moving fast. No oscillator or noise engine is present.
- The only generated signal is a convolution impulse used as a reverb tail;
  that is processing of the recorded mix, not a substitute game sound.
- `src/main.js` wires jump/land, vehicle enter/exit/destruction, derived vehicle
  impacts, authoritative destruction, path-based whiz-by (`nearestPath`) and
  session audio lifecycle. Authoritative simulation, physics and networking
  are unchanged.

## 4. Asset acquisition summary

Full detail is in `AUDIO_FETCH_LOG.md`, `AUDIO_NEEDS.md`, `ASSETS.md` and
`public/audio/NOTICE.md`; per-clip source, time, author, URL, date, processing,
hash and byte count are in `public/audio/manifest.json`.

| Route | Result |
|---|---|
| Freesound API | No `FREESOUND_API_KEY` and no `.env`; API path unavailable, no key invented. |
| Freesound public pages/preview | 13 CC0 recordings downloaded after page licence checks. |
| Sonniss GDC bundles | Not used: royalty-free production licence, not CC0 raw-file redistribution; CC0 coverage was already complete. |
| OpenGameArt | CC0 firearm, impact, footsteps, reload, click, alarm and car libraries used. |
| Kenney | Impact, sci-fi and interface archives used; bundled `License.txt` files shipped. |
| Other free/OSS/web sources | Searched within available access; no unverified source was promoted. Search endpoints returned HTTP 402/captcha. |
| Failed downloads | Invalid `Owlish_Media_Sound_Effects.zip`, truncated `swishes.zip`, HTTP 403 Kenney page. |

### Final bank

- **128 recorded clips, 1,636,252 bytes**, 48 kHz mono Ogg Vorbis q5.
- Groups: `core` 110, `vehicle` 15, `ambience` 3.
- Every clip is referenced by a sound definition and every referenced clip
  ships; the closure test fails in either direction.
- `tools/build-audio.py` reproduces the bank from ignored local sources and
  fails closed on missing/silent material. `tools/validate-audio.py` decodes
  every clip.

| Category | Clips | Category | Clips |
|---|---:|---|---:|
| Weapon shots | 26 | Footsteps | 16 |
| Distant gunfire/explosion | 5 | Jump/land | 5 |
| Explosions/rocket/destruction | 5 | Mechanism | 13 |
| Body impacts/fall/damage | 6 | Reloads | 5 |
| Surface impacts | 18 | UI/feedback | 9 |
| Vehicle loops | 7 | Vehicle one-shots | 7 |
| Ambience | 3 | Zone alarm | 1 |
| Bullet whiz-by | 2 | | |

Decoded validation: 128/128 clips, 48 kHz mono, all finite, non-silent, max
decoded peak **0.85544** against the 0.86 ceiling, and 11 loop seams checked.

### Licensing audit

All shipped audio is **CC0-1.0**. No CC-BY, AudioJungle, LANDR, Pixabay or
unclear-licence file is included. The 21 used libraries and 13 Freesound
recordings are listed with URLs/authors in `ASSETS.md`; the three Kenney
licence texts are shipped as `LICENSE-Kenney-*.txt`.

Rejected after inspection:

- `shotgunsounds.zip` and `shotgun-shoot-reload` — CC-BY (attribution).
- `NenadSimic_-_Muffled_Distant_Explosion.wav` — AudioJungle-sourced licence.
- `sounds.zip` / `extracted/sounds/` — CC-BY 3.0, © 2009 Vincent Sevedge.
- LANDR Samples — credits/standalone-SFX restrictions.
- Pixabay weapon SFX — HTTP 403 and no established CC0 grant.

No source archive is committed. `AUDIO_NEEDS.md` lists no missing required
category and no silent placeholder; it records presentation choices such as the
absence of a standalone tyre-rolling loop and reuse of surface footstep pools
for crouched movement.

## 5. Benchmark methodology and environment

Browser measurements use the production build served on
`http://127.0.0.1:3300/`, Playwright Chromium with `--use-angle=swiftshader`
(CPU rendering), an offline TDM match, and 24 synthetic character views. Each
tier is 300 frames × 24 views. Loot and tracer tests run in the same page.
Audio measurements use the live WebAudio context.

Node microbenchmarks use `node --expose-gc`
(`qa/phase4-microbench.mjs`).

**This is not a historical same-machine A/B.** The base `31222dc` tree has no
instrumentation for these new tiers/counters and cannot run this benchmark
unchanged. The numbers below therefore quantify the current full/basic/hidden
paths and deterministic allocation counts, not an old-build frame-time delta.
The SwiftShader FPS values are not hardware GPU frame rates and are not used as
performance claims.

## 6. Measured results

### Character tiers (`qa/reports/phase4-bench-low.json` / `-high.json`)

| Quality | Full | Basic | Hidden | Basic vs full | Hidden vs full |
|---|---:|---:|---:|---:|---:|
| low | 6.9 µs/update | 3.0 µs/update | 1.1 µs/update | −56.5% | −84.1% |
| high | 8.0 µs/update | 3.1 µs/update | 1.0 µs/update | −61.3% | −87.5% |

The historical path paid the `full` cost for every character. These are the
measured costs of the three current branches; a mixed 8-near/15-basic/8-hidden
31-character set would cost about 109 µs/frame versus 214 µs/frame if every
character stayed full. That arithmetic projection is not a browser scenario
measurement.

### Loot churn and reuse

| Scenario | Created | Reused | Disposed | Retained pool |
|---|---:|---:|---:|---:|
| 201 syncs crossing 65/78 m boundary | 1 | 0 | 0 | 0 |
| 50 distinct ids replacing each other | 2 | 48 | 0 | 1 |

The pool cap is 16. Match teardown disposes active and pooled meshes.

### Tracer recycling

5,000 tracer records over 5,000 shots: **1 retained record, 0 live records**;
13.1 ms total at low quality and 10.9 ms at high (about 2.2–2.6 µs per shot).
Historical code allocated a record and coordinate arrays for each shot.

### Smoke visibility and snapshots (`qa/reports/phase4-microbench.json`)

| Path | Calls | Time | Per call | Heap delta |
|---|---:|---:|---:|---:|
| Smoke, pre-change array version | 200,000 | 45.5 ms | 0.228 µs | 33.4 KiB |
| Smoke, current scalar version | 200,000 | 6.3 ms | 0.032 µs | 15.8 KiB |

Smoke sight-line cost fell about 86%. Snapshot push measured **5.5 µs per
push** with 31 players and 30 retained frames (3,000 pushes in 16.4 ms), about
0.17 ms/s at 30 Hz; it was left unchanged to preserve snapshot immutability and
Phase 3 reconciliation semantics.

### GPU-side work and quality ladder

| Setting | Pixel ratio | Shadows | Cascades | Shadow map | View distance | Draw calls | Triangles | Geometries | Textures | Programs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| low | 0.85 | off | 0 | 512 | 650 | 237 | 1,425,038 | 345 | 45 | 29 |
| high | 1.0 | on | 2 | 1024 | 1250 | 382 | 4,013,383 | 374 | 48 | 40 |

High quality therefore costs about 61% more draw calls and 2.8× the triangles
in this scene. Software-renderer FPS was 0.42 (low) and 0.32 (high); those
numbers are recorded only to show the renderer ran, not as a performance result.

### Audio playback and lifecycle (browser)

- Audio context: `running`; bank `enabled=true`; 113 clips decoded (110 core +
  3 ambience); 0 decode errors.
- One shot: played, 1 active voice. 70 rapid shots: peak **40** voices, exactly
  the global budget. Cancel: **0** voices.
- Zone alarm: started; after 20 on/off toggles, **0** retained loops and **0**
  alarm voices.
- Browser errors: 0 in both low and high benchmark runs.
- Combined-arms browser run: all **110 core SFX decode**, voice budget bounded,
  zero browser errors.

## 7. Test and QA results

Everything below was run against this working tree on 2026-11-07.

| Command | Result |
|---|---|
| `npm test` | **231/231 pass**, 0 fail, 10,679.34 ms |
| `node --test test/phase4-audio.test.js test/phase4-render.test.js` | **19/19 pass** |
| `npm run nettest` | **exit 0**; five loopback profiles completed |
| `npm run build` | **success**; 73 modules, 3.17 s; JS 1,079.74 kB (310.37 kB gzip), CSS 31.19 kB |
| `npm run qa:peer` | **20/20 pass** |
| `npm run qa:multiplayer` | **29/29 pass**, errors: none |
| `QA_QUALITY=low node qa/combined-arms.mjs` | **10/10 pass**, including 110 core SFX decode and zero browser errors |
| `QA_QUALITY=low npm run qa:phase4` | pass, report `qa/reports/phase4-bench-low.json` |
| `QA_QUALITY=high npm run qa:phase4` | pass, report `qa/reports/phase4-bench-high.json` |
| `npm run bench:phase4` | pass, report `qa/reports/phase4-microbench.json` |

`nettest` profiles: local, 50 ms one-way / 5% loss, 150 ms one-way / 5% loss,
300 ms one-way / no loss, 300 ms one-way / 5% loss. Local correction p95 was
1.97 cm; the worst profile's correction p95 was 12.82 cm; snapshot traffic was
0.91–0.94 KiB/s and ack traffic 0.25–0.27 KiB/s. These are loopback TCP
measurements, not WAN or hardware-GPU results.

## 8. Audio verification matrix

| ID | Evidence |
|---|---|
| AUD-01 | 26 recorded shot clips cover pistol, SMG, AR, DMR, shotgun, sniper, LMG and RPG; closure test proves every weapon pool resolves to a shipped clip. Browser fire path exercised with the RPG in combined-arms. |
| AUD-02 | `pickClip` regression selects randomly without immediate repetition; rate ranges add small variation. |
| AUD-03 | Separate close shot and dedicated far-field distant gunfire/explosion definitions; distance gain/filter tests. |
| AUD-04 | `ReloadCues` regression covers AR, shotgun and RPG phase order; recorded handgun/rifle/generic reloads plus recorded mechanism cues. |
| AUD-05 | Recorded `dry-fire` clip mapped to `dryFire`; weapon lifecycle test fires every weapon including empty-magazine behavior. |
| AUD-06 | `IMPACT_SOUNDS` maps concrete/wood/metal/dirt/glass/water/flesh; regression asserts every mapping resolves. |
| AUD-07 | `pathProximity`/`nearestPath` regression checks closest pass and delay; `main.js` uses the authoritative `shot` origin/endpoints. |
| AUD-08 | Surface pools for concrete, wood, metal, dirt, grass and water; cadence gates by speed; remote path shares spatial/occlusion logic. |
| AUD-09 | Recorded jump/land pools; main-loop jump/land transitions wired from replicated player state. |
| AUD-10 | Recorded idle/drive loops cross-faded by speed with subtle Doppler; definitions and loop ownership regression. Browser driving was not part of this run. |
| AUD-11 | `observeVehicles` derives impact audio from speed drop/health chunk; recorded vehicle impact variations. Browser collision audio was not separately asserted. |
| AUD-12 | Enter/exit emitted from authoritative `enterVehicle`/`exitVehicle`; recorded door and engine start/stop. |
| AUD-13 | `indoorAt` regression follows building footprints; reverb send increases indoors. |
| AUD-14 | Occlusion ray lowers gain/cutoff and raises wet mix; code path exercised by world-sound playback. Not separately measured in a listening test. |
| AUD-15 | Voice-budget regressions cover global/category caps and priority stealing; browser 70-shot test peaked at 40 voices. |
| AUD-16 | Browser alarm test: 20 toggles, 0 retained loops, 0 alarm voices. |
| AUD-17 | Voice cancellation is idempotent; browser cancel returns to 0 voices. Scheduled cleanup is owned by each voice/loop. |
| AUD-18 | `startSession`/`endSession` cancel voices, stop loops, reset reload cues and observation caches; peer QA rejoins successfully (audio state not directly asserted there). |
| AUD-19 | Disable/re-enable sets gain and resumes the context; no duplicate loop creation because loops are keyed. |
| AUD-20 | Missing/failed clips are recorded once and never synthesized; `SampleBank` returns no buffer. |
| AUD-21 | Manifest/closure/hash tests plus `ASSETS.md`, `AUDIO_FETCH_LOG.md`, `NOTICE.md` and `AUDIO_NEEDS.md`. |
| AUD-22 | `tools/validate-audio.py` decodes all 128 clips; browser decodes all 110 core clips with 0 errors. |

## 9. Remaining limitations

- No historical same-machine frame-time A/B. The base tree cannot run the new
  benchmark without the Phase 4 instrumentation; current tier costs and
  allocation counts are the measured evidence.
- GPU timings are SwiftShader CPU rendering. Draw-call/triangle counts are
  meaningful relative comparisons; FPS is not a hardware result.
- The browser character benchmark uses 24 synthetic views, not a live 31-player
  match. A mixed-distance projection is labelled as arithmetic.
- Vehicle engine/impact/enter-exit audio is covered by definitions, loop
  ownership and the wired authoritative events, but this run did not include a
  subjective listening test while driving. Occlusion/indoor processing is
  covered by unit math and code inspection rather than a measured listening
  test.
- The full screenshot suite `qa:offline` was not used; an earlier attempt
  stalled on a screenshot timeout after the lobby. Combined-arms, peer,
  multiplayer and the Phase 4 browser benchmark passed instead.
- Sonniss was intentionally not used because its production licence is not a
  CC0 raw-file redistribution grant. Optional tyre-rolling material is the only
  noted presentation gap in `AUDIO_NEEDS.md`; no required category is missing.
- Source archives under `qa/downloads/` are ignored. Rebuilding the bank needs
  those local sources; the committed manifest hashes and validation report
  allow the shipped result to be verified without them.
- Network measurements are loopback TCP, not WAN or packet-loss hardware tests.

## 10. Final scope confirmation

- No authoritative combat, physics, networking, snapshot or game-state rule was
  changed. `shared/visibility.js` preserves smoke sight-line behavior while
  removing allocations; render/audio code is presentation-only.
- All core sounds are real recordings with recorded provenance; the only
  generated signal is the reverb impulse tail.
- The bank and definitions are closed: 128 shipped clips, all referenced.
- Rendering work is bounded: 65/140 m tiers, 78 m loot retention, 16-mesh loot
  pool, 96-record tracer ring, 40-voice audio budget.
- Required deliverables: `PHASE4-VERIFICATION.md`, `ASSETS.md`,
  `AUDIO_FETCH_LOG.md`, `AUDIO_NEEDS.md`, `public/audio/NOTICE.md`, manifest,
  validation report and reproducible build/validation/benchmark tools.
