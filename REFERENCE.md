# REFERENCE.md — What the best shipped games do, per system

This is the quality bar used to judge *Frontline*. It is written from public technical material and gameplay analysis. No commercial assets, names, maps or code are copied.

## 1. Movement & character feel
- **PUBG:** distinct walk/sprint/crouch/prone, vaulting, lean and free-look; character animation telegraphs stance. Evaluate movement weight and aimed-fire readability. The earlier stamina claim was not substantiated and is removed.
- **Battlefield:** momentum + slide, vault, bipods, suppression, vehicles; movement readable at distance, third-person animation sells it.
- **The Finals:** fast acceleration, slide, mantle, destruction-driven traversal, very low input-to-camera latency, strong FOV/sprint/landing feedback.
- **Bar for us:** fixed 60 Hz deterministic controller, no stuck/tunneling, step/slope/ceiling handling, coyote time + jump buffer, air control, smooth crouch height, camera bob/land dip, ADS FOV, responsive mouse.

## 2. Shooting & ballistics
- **PUBG:** projectile travel/drop, hit zones, armour, attachments, recoil control and scope handling are gameplay reference points. Penetration/destruction behaviour is version/material-specific; generic wall penetration is not asserted here.
- **Battlefield:** bullet drop + velocity per weapon, suppression, bipods, destructive cover.
- **The Finals:** readable tracers/muzzle flash and strong hit feedback amid destruction. TTK varies by class/weapon; no blanket fast-TTK claim is used as a tuning target.
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
- **Bar for us:** spatially readable synthesis, distance filtering, surface footsteps, vehicle feedback and controlled levels. The current implementation uses stereo panning; HRTF, geometric audio occlusion and room reverb remain gaps.

## 8. UI/UX
- **PUBG:** inventory, minimap/zone, kill feed, damage direction, compass, team frames.
- **Battlefield:** squad UI, spawn screen, scoreboard.
- **The Finals:** clean HUD, strong hit feedback, spectator flow.
- **Bar for us:** dynamic crosshair, health/armour, ammo, weapon/attachments, grenades/heals, minimap + zone, compass, kill feed, scoreboard, damage indicators, spectator, respawn/round end, settings, ping/FPS.

## 9. Performance
- **PUBG/BF:** aggressive LOD, instancing, streaming, occlusion, server tick budgets.
- **Bar for us:** instancing, bounded near detail, effective culling and pooled effects; hardware60fps at1080p and32 players at60Hz server simulation/30Hz snapshots, verified on a deployment-class host.

## Honest position
The current build remains substantially below the reference bar. Track concrete
gaps and iterate on reachable improvements; elapsed development time is not an
acceptance criterion. Commercial-scale content, animation quality and hardware/WAN
performance are not established by unit tests or brightness statistics.

## Direct reference-image review — 2026-11-04

Source metadata was fetched from the public Steam app-details API and the
following publisher-provided stills were read as images. These are promotional
stills, including staged compositions, not timed gameplay measurements. Battlefield
2042's selected store image has historical/Portal-era styling; it does not establish
the mechanics of every Battlefield title.

| Reference | Source | Local inspection copy |
|---|---|---|
| PUBG: BATTLEGROUNDS | [Store](https://store.steampowered.com/app/578080/) · [still](https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/578080/bf9b3de5896d4ec7ef9531938b26946cded81fdf/ss_bf9b3de5896d4ec7ef9531938b26946cded81fdf.1920x1080.jpg) | `qa/shots/references/pubg-02.jpg` |
| Battlefield 2042 | [Store](https://store.steampowered.com/app/1517290/) · [still](https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1517290/cf954bff997292185b157a6024a59350544f8147/ss_cf954bff997292185b157a6024a59350544f8147.1920x1080.jpg) | `qa/shots/references/battlefield-02.jpg` |
| THE FINALS | [Store](https://store.steampowered.com/app/2073850/) · [still](https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2073850/a68fbbac0318c9fa01330f564b83a14feafcbf44/ss_a68fbbac0318c9fa01330f564b83a14feafcbf44.1920x1080.jpg) | `qa/shots/references/finals-02.jpg` |

Images remain copyright their respective owners. Inspection copies are ignored
under `qa/shots/`, are not bundled or distributed as game assets, and supply no
geometry, textures, logos or audio to Frontline.

| Observed reference quality | Observed Frontline baseline gap | Improvement/verification target |
|---|---|---|
| Cloth folds, helmets, gloves, seams and hands visibly contacting weapons | Primitive body proportions and little small-scale material definition; mannequin capture reads as a rear view | Clear front/back silhouette, connected grip/arms, articulated stances, representative near/mid-distance frames |
| Metal, cloth, masonry and ground remain distinct in light and shade | Large dark props and black weapon silhouettes lose surface definition | Correct linear/sRGB pipeline, readable shadow fill and material contrast in both sun directions and interiors |
| Detailed vegetation and foreground/midground/background layers | Repeated cone trees, sparse open ground and weak locality of cover | Varied vegetation silhouettes and ground detail; maintain sightline/readability and measure draw/triangle cost |
| Muzzle light, smoke and debris differ in scale, colour and motion role | Current stills do not prove convincing destruction or temporal effects | Capture impact/after state plus an actual moving clip; test synchronized collision removal separately |
| Poses and scene composition keep the subject/action readable | Tall nameplates overlap countdown text; ADS fills the centre with a solid model | Unobstructed sight picture and HUD priorities, verified at 1080p and smaller viewports |

These observations inform the next pass; they do not assert those gaps have
already been closed. Baseline images inspected directly: `10-vista.png`,
`11-character.png`, and `14-ads.png` under `qa/shots/`.

## Blackshore iteration evidence

Actual images in `arsenal-pass1` and `arsenal-pass2` cover all seven weapons at
hip/ADS/fire and three reload phases. The controller inspected contact sheets
and full-size frames; the first pass exposed excessive receiver/rail/arm size,
unlined scope tubes and overly saturated foliage. Refinements preserve the
shared anchor/timer contracts. Stable optical alignment passed for all classes.

`scenes-pass1` adds13 directly inspected1080p images spanning deployment,
town/interiors/upstairs, forest/industrial areas, shore/underwater, standing/
crouched/prone/fallen characters and a truck. Materials and hierarchy improved;
simple furnishings, repeated buildings and stylized characters still fall well
short of the commercial art bar.

The first47.64s gameplay recording was sampled at2fps into six reviewed contact
sheets. It shows magazine motion, ADS, movement and steering hands, and exposed
an initial overlapping-spawn defect. Its2.06 measured render FPS on SwiftShader
is a severe environment limitation, not temporal-quality or hardware-performance
proof. See the clip metadata and GAP-ANALYSIS.md.
