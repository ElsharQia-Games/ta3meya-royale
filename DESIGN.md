# FRONTLINE / BLACKSHORE — design foundation

Status: implementation and direct screenshot review in progress. This document
defines the visual/interaction baseline for subsequent agents, not a claim of
commercial-game parity. The existing browser/server gameplay contracts remain
the source of truth.

## Creative direction

**A contested coast. Field equipment. Clear decisions under pressure.**

Blackshore is the operation identity for Frontline's original battlefield.
Use weathered concrete, salt-grey steel, olive equipment, muted foliage, warm
sunlight and cool atmospheric depth. The deployment interface feels like a
well-designed field operations terminal: oversized condensed typography, fine
technical labels, restrained maps and deliberate empty space. Combat information
has a clear hierarchy and leaves the aiming area readable.

### Visual language

- Ink/slate backgrounds, warm off-white type, muted olive primary actions,
  amber selection/alerts; cyan and coral remain team/damage identifiers.
- Barlow Condensed for display typography; IBM Plex Mono for coordinates and
  numeric data; system sans for body copy. Ship fonts locally under OFL-1.1.
- Mostly square geometry with small radii, thin borders, corner ticks and
  disciplined spacing. Bright accents identify action or state.
- Every prominent label communicates a real action or real state. Decorative
  operation/sector labels are fiction, not fabricated server telemetry.

## Implementation layers

1. **Deployment:** live rendered battlefield, strong operation title, mode
   cards, clear callsign/room form, primary deploy action, accessible training,
   settings/help and invite actions. Preserve existing input IDs and mode values.
2. **Combat HUD:** compact compass and match strip; readable vitals, weapon and
   ammunition; purposeful equipment slots and interaction prompts. Scoreboard,
   chat, pause, spectator and end screens share the same component language.
3. **World:** varied foliage silhouettes, near-ground detail, believable building
   trim/material scale, readable terrain and water, distant silhouettes and
   controlled atmosphere. Large visible gameplay obstacles must match colliders;
   small cosmetic detail must not pretend to be usable cover.
4. **Equipment:** distinct class silhouettes, bevelled receiver/stock, muzzle,
   rails, magazine and open sight picture; gloves/sleeves visibly grip the gun.
   Named anchors keep animation and effects attached to the right geometry.
5. **Characters:** coherent tactical kit, articulated knees/elbows, readable
   front/back and stance silhouettes, restrained team identifiers. Nameplates
   respect occlusion and never dominate a close encounter.
6. **Motion/feedback:** idle breathing, movement bob, ADS alignment, recoil
   return, magazine removal/insertion/settle phases, muzzle flash and impact
   scale, short UI transitions and reduced-motion support.

## Contracts for future work

- Simulation positions are feet positions in metres; forward is `[-sin(yaw),
  0,-cos(yaw)]`. Presentation must preserve the shared capsule and aim convention.
- The server owns damage/ammo/reload completion. Reload animation reads remaining
  `reloadT / weapon.reload`; the visual magazine does not modify inventory.
- ADS must align the sight's optical centre with the camera ray. A decorative
  scope must not obscure that ray or imply an unimplemented magnification system.
- `muzzleWorld()` returns the actual model's muzzle anchor; flash/tracers use
  that anchor. Weapon switching disposes old geometries and retains shared maps.
- Gameplay inputs are suppressed while typing or in a modal. Escape/pointer-lock
  transitions clear held input. Keyboard focus must remain visible in menus.
- Theme changes belong in the design/style layer; visual tuning belongs in the
  renderer/theme configuration. Preserve the mode, protocol and shared-world APIs.
- Use instancing/batching for repeated details. Record actual calls/triangles and
  frame distributions; keep software-GPU and hardware-GPU claims distinct.

## Review loop and evidence

Capture deployment, both gameplay modes, representative map areas/interiors,
weapon hip/ADS/reload/fire, character stances, vehicle, destruction and all major
HUD/modal states. Read the images, identify defects, fix and recapture the affected
scenes. Inspect a real gameplay clip for temporal behaviour. Record source revision,
viewport, quality, seed, camera/staging and runtime errors with each evidence pass.

Successful stills require hierarchy, consistent typography, unobscured controls,
readable materials/silhouettes and spatial depth. Correct numerical brightness
alone is insufficient. A staged pose verifies geometry, not live gameplay.

Public comparison stills and current gaps are in `REFERENCE.md`; asset/font
provenance is in `ASSETS.md`; ongoing integration findings are in
`qa/reports/INTEGRATION.md`. Hardware1080p60fps and a16+player WAN match remain
separate release gates.
