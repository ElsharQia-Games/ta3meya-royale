# Renderer visual pass — evidence report

Branch `agent/render`, baseline `d914a63`. All work is inside
`/home/medo/coding/shooter-game/.worktrees/render`; no other checkout was
modified. Changes are limited to `src/render/{renderer,entities,textures}.js`,
`qa/visual.mjs` and this report.

## Commands actually run

```sh
npm run build
PORT=3102 node server/server.js            # serves dist/ on :3102
QA_URL=http://127.0.0.1:3102/ node qa/visual.mjs
python3 qa/analyze.py qa/shots/*.png
npm test
```

The final visual run reported `errors: none`. `npm test` passed 64/64.

## 1. Sky clipping

**Cause:** the stock three.js `Sky` shader pushes the horizon toward white
around the sun; ACES then clipped large parts of the upper frame.

**Fix:** patch the sky fragment source before first compile with a sky-only
Reinhard shoulder (`SKY_ROLLOFF = { gain: 1.0, knee: 0.32 }`):

```glsl
retColor = uSkyGain * retColor / (1.0 + uSkyKnee * retColor);
```

**Proof the patched program is live** (probe against the final build):

```
skyRolloffApplied=true
fragHasKnee=true
fragHasGain=true
uSkyGain=1  uSkyKnee=0.32
programs=32
```

### Vista numbers (`qa/shots/10-vista.png`, 1600x900)

| region | baseline | after |
|---|---|---|
| full mean | (114,126,125) | (105,116,111) |
| full blown | 0.18 | **0.05** |
| full dark | 0.06 | 0.02 |
| top mean | — | (173,185,192) |
| top blown | **0.39** | **0.04** |
| center blown | 0.24 | 0.08 |
| bottom mean | (35,42,27) | (42,51,34) |
| bottom dark | 0.26 | 0.07 |

The sky knee was chosen from a measured sweep: `knee=0.32` was the lowest
tested value that kept top blown ≤0.15 and full blown ≤0.08; `knee=0.28`
produced top blown 0.22.

## 2. Shadowed-ground readability

`HemisphereLight(0xa8c8ff, 0x74624a, 3.0)`, `AmbientLight(0x8ea2b8, 0.6)` and
CSM `lightIntensity: 3.6`. The sun was raised with the fill so lit surfaces do
not flatten.

Measured on the vista: bottom mean rose from (35,42,27) to (42,51,34)
(Rec.709 luminance ≈ 48.8) and bottom dark fell from 0.26 to 0.07. The chosen
fill came from the `M-h30-a060` sweep point; lower fill (`hemi 2.6 / ambient
0.7`) left bottom dark at 0.13.

## 3. Characters

* Two-segment legs with knee joints replace rigid legs.
* Crouch folds thigh forward to horizontal and shin back to vertical.
* Prone folds the torso down, extends the legs behind, and keeps the rifle
  level (`gun.rotation.x = 1.28`) so the muzzle no longer points into the
  ground. The rifle is hidden in the death pose (dropped weapon).
* Nameplates use a shrink-to-fit 36 px name, a distance-scaled sprite and a
  stance-dependent height (2.15 / 1.78 / 0.78 m).
* Team accent emissive raised from 0.25 to 0.4; team colour verified as
  `#5aa9ff` with non-zero emissive.

Pose audit from the final `qa/visual.mjs` run (positive `footPen` means
geometry below the terrain sampled at the root):

| pose | footPen (m) | height (m) | text px @3/15/40 m |
|---|---|---|---|
| stand | -0.10 / -0.08 / -0.09 | 1.75 | 39 / 15 / 12 |
| crouch | -0.10 / -0.09 / -0.10 | 1.39 | 40 / 15 / 12 |
| prone | 0.00 / 0.00 / 0.11 | 1.00 | 39 / 15 / 12 |
| dead | 0.44 (5 m, sloped ground) | 2.07 | hidden |

Facing is correct: at `yaw = π` the gun points `+z` and `root.rotation.y = 3.14`
for every stance.

## 4. Viewmodel

Numeric audit from `qa/visual.mjs`:

| state | NDC bounds (x0,x1,y0,y1) | nearest view Z | muzzle dot(camera forward) | muzzle distance |
|---|---|---|---|---|
| hip | 0.21, 0.50, -0.89, -0.27 | 0.348 m | 0.919 | 0.81 m |
| ADS | -0.09, 0.09, -1.11, -0.10 | 0.208 m | 0.985 | 0.61 m |

Camera near plane is 0.04 m, so neither pose clips the near plane. The ADS
bounds intentionally extend below the bottom edge (the receiver is at the
bottom of the screen). ADS FOV moves 80° → 67.8° with `adsF=1`.
Recoil: `kick` peaks at 0.55 and damps to 0.015 within 0.8 s, `kickYaw` from
−0.018 to −0.0005.

## 5. Extra visible system — procedural cloud sheet

One camera-following `CircleGeometry` at y=260 with a procedurally generated
tileable cloud alpha map (`textures.js: clouds()`), one extra draw call.
It drifts slowly and fades out toward its edge.

A/B from the same vista camera (`qa/shots/15-vista-noclouds.png` vs
`16-vista-clouds.png`):

| metric | no clouds | clouds |
|---|---|---|
| draw calls | 740 | 741 (+1) |
| triangles | 1,149,682 | 1,149,746 (+64) |
| top blown | 0.11 | **0.04** |
| top unique colours | 886 | **1,032** |
| full blown | 0.07 | 0.05 |

The cloud sheet is visible variety rather than a brightness trick: it reduces
the blown sky area while adding colour variation.

## 6. Residual issues

* Prone/dead poses are correct on flat ground, but the rigid death pose can
  sink up to ~0.4 m into a slope because the body extends ~1.7 m from the
  root. A terrain-aware death pose (sample ground at head and feet) is the
  correct next step; it needs a world reference in `CharacterView`.
* The 40 m prone sample reports 0.11 m because the extended legs cross a
  slope; the 3 m and 15 m samples report 0.00.
* This QA runs on SwiftShader software rendering (1600x900): 764 draw calls,
  1,154,472 triangles, ~10–11 fps. These frame numbers are **not** a hardware
  60 fps claim.
* The nameplate at 3 m is large (≈39 px text) by design for readability; it
  can overlap the head at very close range.
* HUD overlap was not assessed here; HUD ownership is separate.

## 7. Image inspection limit

I attempted to open the generated PNGs with the harness `read` tool. It
returned:

```
Image read successfully
ERROR: Cannot read ".../qa/shots/10-vista.png" (this model does not support image input).
```

So this agent cannot visually inspect the frames; the evidence above is
numeric plus the reproducible scripts. The controller can open these paths
directly:

* `qa/shots/10-vista.png`
* `qa/shots/11-character.png`
* `qa/shots/12-character-nohud.png`
* `qa/shots/13-viewmodel.png`
* `qa/shots/14-ads.png`
* `qa/shots/15-vista-noclouds.png`
* `qa/shots/16-vista-clouds.png`

## 8. Cross-file proposals (not edited)

* Death pose needs terrain sampling, which requires passing `World` or a
  height callback into `CharacterView`; that touches `src/main.js` or the
  character update caller.
* The HUD can overlap the 3 m nameplate; owner should decide whether plates
  fade inside ~4 m or move above the helmet.
