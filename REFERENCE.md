# REFERENCE.md — What the best shipped games do, per system

This is the quality bar used to judge *Frontline*. It is written from public technical material and gameplay analysis. No commercial assets, names, maps or code are copied.

## 1. Movement & character feel
- **PUBG:** weighty acceleration, distinct walk/sprint/crouch/prone, vaulting, lean, free-look, stamina; character animation telegraphs stance. Gunplay is punishing, ADS is essential, movement accuracy penalty is large.
- **Battlefield:** momentum + slide, vault, bipods, suppression, vehicles; movement readable at distance, third-person animation sells it.
- **The Finals:** fast acceleration, slide, mantle, destruction-driven traversal, very low input-to-camera latency, strong FOV/sprint/landing feedback.
- **Bar for us:** fixed 60 Hz deterministic controller, no stuck/tunneling, step/slope/ceiling handling, coyote time + jump buffer, air control, smooth crouch height, camera bob/land dip, ADS FOV, responsive mouse.

## 2. Shooting & ballistics
- **PUBG:** real projectile travel, gravity drop, drag, penetration of thin cover, limb/head multipliers, armour, attachments, per-gun recoil patterns, scope sway/breath.
- **Battlefield:** bullet drop + velocity per weapon, suppression, bipods, destructive cover.
- **The Finals:** highly readable tracers/muzzle flash, fast TTK, strong hit feedback, minimal visual noise.
- **Bar for us:** data-driven stats, muzzle velocity + drag + drop, travel-time damage scheduling, penetration with damage loss, falloff, head/torso/limb hitboxes, armour, recoil + spread + ADS + movement penalty, hitmarkers/headshot audio.

## 3. Netcode
- **Valve/Source:** authoritative server, client prediction, lag compensation by rewinding hitboxes to the shooter's view time, interpolation for remote players.
- **Overwatch:** 60 Hz simulation, high-frequency input, favour-the-shooter rewind, robust delta snapshots and interest management.
- **Gambetta / Gaffer:** sequence-numbered inputs, server reconciliation by replaying unacked inputs, snapshot interpolation with a jitter buffer, delta compression against an acknowledged baseline.
- **Bar for us:** 60 Hz sim, 30 Hz snapshots, prediction/replay, 100 ms interpolation buffer, server rewind clamped to 400 ms, binary quantised deltas, per-client ack, event interest management, reconnect, anti-cheat validation.

## 4. Physics & destruction
- **Battlefield (Frostbite):** chunk/structural destruction with server authority, debris that affects gameplay, vehicle deformation.
- **The Finals:** destruction as core traversal/combat, synchronised debris, convincing fracture.
- **PUBG:** vehicles with suspension, bullet penetration, ragdolls.
- **Bar for us:** deterministic static collision, raycast suspension vehicle, destructible cover with HP + collider removal + debris, grenade LOS damage, no simulation explosions.

## 5. Level design & scale
- **PUBG:** 8×8 km with named towns, compounds, interiors, loot density, cover rhythm, sightlines.
- **Battlefield:** combined-arms lanes, verticality, destructible buildings.
- **The Finals:** dense urban verticality, arena flow.
- **Bar for us:** 1 km², 5 towns + military compound, enterable multi-storey buildings, forests, lake, roads, cover, loot spawns, LOD/instancing, 32 players.

## 6. Visuals
- **PUBG:** readable art direction, long draw distance, atmospheric fog, convincing characters/weapons.
- **Battlefield:** PBR materials, dynamic lighting, destruction VFX, strong post stack.
- **The Finals:** bold lighting, bloom, destruction particles, clean UI.
- **Bar for us:** procedural PBR-ish materials, CSM shadows, sky + fog, ACES tone mapping, bloom, vignette/grain, terrain detail, water shader, tracers/decals/particles, procedural characters and weapon viewmodels. Stylised, cohesive, not photoreal — documented honestly.

## 7. Audio
- **PUBG:** distance-filtered gunshots, surface footsteps, ambient bed, directional cues.
- **Battlefield:** layered weapon tails, reverb by space, occlusion, vehicle audio.
- **The Finals:** punchy close-range shots, destruction impacts, clear UI audio.
- **Bar for us:** WebAudio synthesis, HRTF panning, distance attenuation + air-absorption lowpass, occlusion raycast, surface footsteps, layered gunshots, explosions, ambience, UI cues.

## 8. UI/UX
- **PUBG:** inventory, minimap/zone, kill feed, damage direction, compass, team frames.
- **Battlefield:** squad UI, spawn screen, scoreboard.
- **The Finals:** clean HUD, strong hit feedback, spectator flow.
- **Bar for us:** dynamic crosshair, health/armour, ammo, weapon/attachments, grenades/heals, minimap + zone, compass, kill feed, scoreboard, damage indicators, spectator, respawn/round end, settings, ping/FPS.

## 9. Performance
- **PUBG/BF:** aggressive LOD, instancing, streaming, occlusion, server tick budgets.
- **Bar for us:** instanced vegetation, merged building geometry, chunk/frustum culling, pooled effects, 60 fps target at 1080p on mid-range hardware, 32-player server at 30 Hz on a small VPS.

## Honest position
A single-session build cannot equal the content volume, animation fidelity, art pipeline or QA scale of these games. The goal is to close every *systemic* gap that is technically reachable (netcode, ballistics, controller, destruction, audio, UI) and to record the remaining gaps (photoreal assets, mo-cap animation, 100-player scale, anti-cheat depth) in GAP-ANALYSIS.md.
