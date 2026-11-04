# ASSETS.md — Sources and licenses

## External runtime assets
No commercial game geometry, textures, audio, maps or logos are used. Original
procedural equipment/world assets are supplemented by the locally hosted fonts
and CC0 terrain textures below. Runtime assets are served from this project.

| Asset | Source | License / local notice |
|---|---|---|
| Barlow Condensed, Bold and ExtraBold | [Google Fonts](https://fonts.google.com/specimen/Barlow+Condensed), [project](https://github.com/jpt/barlow); files from `fonts.gstatic.com/s/barlowcondensed/v13/` | SIL OFL-1.1, `public/fonts/Barlow-OFL.txt` |
| IBM Plex Mono, Regular and Medium | [Google Fonts](https://fonts.google.com/specimen/IBM+Plex+Mono), [project](https://github.com/IBM/plex); files from `fonts.gstatic.com/s/ibmplexmono/v20/` | SIL OFL-1.1, reserved font name Plex, unmodified binaries; `public/fonts/IBMPlex-OFL.txt` |
| Grass Ground albedo, OpenGL normal and roughness | [Poly Haven asset](https://polyhaven.com/a/grass_ground), [license](https://polyhaven.com/license) | CC0-1.0; local WebP conversions in `public/textures/`, source/hash details in `public/textures/NOTICE.md` |

Downloaded 2026-11-04 from the URLs returned by the Google Fonts CSS API for the
specified families/weights. Copyright and license notices accompany the fonts.

## Generated assets (original, created by this project)
| Asset | Method | License |
|---|---|---|
| Terrain, towns, buildings, roads, props | Procedural generation from seeded noise/layout code | Original, project-owned |
| Concrete, brick, wood, metal, fallback ground, rock, camouflage, bark, decals, sky textures | Canvas2D / DataTexture generation at runtime | Original, project-owned |
| Characters, weapons, vehicles | Procedural Three.js geometry | Original, project-owned |
| Gunshots, footsteps, explosions, ambience, UI sounds | WebAudio / OfflineAudioContext synthesis | Original, project-owned |
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

## Downloaded for evaluation

Quaternius [Stylized Nature MegaKit Standard](https://quaternius.itch.io/stylized-nature-megakit)
was downloaded using its free Standard option on 2026-11-04. Its included
`License_Standard.txt` explicitly licenses the 68-model Standard subset as
CC0-1.0. The ignored 104,088,529-byte archive is in `qa/downloads/`; it is not a
runtime dependency. Selected assets, if adopted, require their own shipped notice
and transformation/size record. Pro/Source editions were not purchased.

## Reference-only imagery

`qa/shots/references/` contains ignored inspection copies of publisher-provided
Steam store screenshots for PUBG: BATTLEGROUNDS, Battlefield 2042 and THE FINALS.
These are copyrighted comparison material, **not permissively licensed runtime
assets**. They are not imported by the game, bundled in `dist/`, or committed.
Exact source links and visual-review notes are in `REFERENCE.md`.
