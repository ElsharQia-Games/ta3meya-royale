# ASSETS.md — Sources and licenses

## External runtime assets
No commercial game geometry, textures, audio, maps or logos are used. Original
procedural equipment/world assets are supplemented by the locally hosted fonts,
CC0 ground/coastal maps, firearm/Foley recordings and selected CC0 foliage/rock
models below. Runtime assets are
served from this project.

| Asset | Source | License / local notice |
|---|---|---|
| Barlow Condensed, Bold and ExtraBold | [Google Fonts](https://fonts.google.com/specimen/Barlow+Condensed), [project](https://github.com/jpt/barlow); files from `fonts.gstatic.com/s/barlowcondensed/v13/` | SIL OFL-1.1, `public/fonts/Barlow-OFL.txt` |
| IBM Plex Mono, Regular and Medium | [Google Fonts](https://fonts.google.com/specimen/IBM+Plex+Mono), [project](https://github.com/IBM/plex); files from `fonts.gstatic.com/s/ibmplexmono/v20/` | SIL OFL-1.1, reserved font name Plex, unmodified binaries; `public/fonts/IBMPlex-OFL.txt` |
| Grass Ground albedo, OpenGL normal and roughness | [Poly Haven asset](https://polyhaven.com/a/grass_ground), [license](https://polyhaven.com/license) | CC0-1.0; local WebP conversions in `public/textures/`, source/hash details in `public/textures/NOTICE.md` |
| Seven derived nature templates and their maps | [Quaternius Stylized Nature MegaKit, free Standard](https://quaternius.itch.io/stylized-nature-megakit) | CC0-1.0; `public/models/nature/LICENSE.txt`, `NOTICE.md` and `manifest.json` |
| Coastal plaster, layered concrete, worn brick and asphalt: 12 local 1K maps | [Poly Haven](https://polyhaven.com/) | CC0-1.0; `public/textures/coastal/NOTICE.md`, source URLs/hashes in `manifest.json`; 2,963,644 bytes |

Downloaded 2026-11-04 from the URLs returned by the Google Fonts CSS API for the
specified families/weights. Copyright and license notices accompany the fonts.

## Generated assets (original, created by this project)
| Asset | Method | License |
|---|---|---|
| Terrain, towns, buildings, roads, props | Procedural generation from seeded noise/layout code | Original, project-owned |
| Concrete, brick, wood, metal, fallback ground, rock, camouflage, bark, decals, sky textures | Canvas2D / DataTexture generation at runtime | Original, project-owned |
| Characters, weapons, vehicles | Procedural Three.js geometry | Original, project-owned |
| Field equipment, rocket rounds, scope details, contact-shadow/dust textures | Original Three.js geometry and Canvas2D generation | Original, project-owned; no commercial-game assets |
| Additional ambience, sub-bass and tonal feedback | WebAudio synthesis, mixed with the CC0 recordings below | Original, project-owned |
| UI, icons, minimap | CSS/Canvas drawn | Original, project-owned |

## Dependencies (npm)
| Package | Version | License | Use |
|---|---|---|---|
| three | 0.170.0 | MIT | Renderer, math, addons (CSM, Sky, post) |
| ws | 8.18.x | MIT | WebSocket server |
| vite | 6.x | MIT | Build/dev server |
| playwright-core | 1.x | Apache-2.0 | Headless browser QA |
| node | 24 | MIT | Runtime |

Three.js addons, including the generated RoomEnvironment lighting scene, are MIT.
Further external assets must be recorded here with source URL and license.

## Nature derivation

Quaternius [Stylized Nature MegaKit Standard](https://quaternius.itch.io/stylized-nature-megakit)
was downloaded using its free Standard option on 2026-11-04. Its included
`License_Standard.txt` explicitly licenses the 68-model Standard subset as
CC0-1.0. The ignored 104,088,529-byte archive is in `qa/downloads/`; it is not a
runtime dependency. Seven templates were derived with `tools/import-nature.py`:
four leaf-only canopies, a small bush, a fern and a rock. The payload is1,706,538B
before its manifest/notice. Source vertex buffers remain unchanged; unused bark
primitives/materials were removed from the tree descriptors to retain the
project's collider-sized trunks. Maps are512px WebP via `EXT_texture_webp`.
Runtime near-detail limits, model transforms, tint and ownership are documented
in `public/models/nature/NOTICE.md`. Pro/Source editions were not purchased.

## Sampled audio

36 local CC0 clips now supplement the original synthesis: firearm recordings by
Ben Jaszczak, Brian Nelson, Kevin Heras and Matthew Nanney (archived Free Firearm
Sound Library), plus selected Kenney impacts/steps/interface/blast layers.
`public/audio/NOTICE.md` identifies the sources, actual licences and the requested
LANDR/Pixabay access/licensing result. `manifest.json` and `tools/build-audio.py`
record exact selections, edits, hashes and encoding. Runtime payload:359,719B.
No LANDR/Pixabay files were acquired; owner-provided licensed selections can be
imported through the documented clip-slot workflow.

## Reference-only imagery

`qa/shots/references/` contains ignored inspection copies of publisher-provided
Steam store screenshots for PUBG: BATTLEGROUNDS, Battlefield 2042 and THE FINALS.
These are copyrighted comparison material, **not permissively licensed runtime
assets**. They are not imported by the game, bundled in `dist/`, or committed.
Exact source links and visual-review notes are in `REFERENCE.md`.
