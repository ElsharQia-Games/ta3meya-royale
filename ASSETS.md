# ASSETS.md — Sources and licenses

## External runtime assets
No commercial game geometry, textures, audio, maps or logos are used. Models,
textures and sounds are generated locally. The Blackshore interface uses the
following locally hosted, permissively licensed fonts; it makes no runtime
requests to a font CDN.

| Asset | Source | License / local notice |
|---|---|---|
| Barlow Condensed, Bold and ExtraBold | [Google Fonts](https://fonts.google.com/specimen/Barlow+Condensed), [project](https://github.com/jpt/barlow); files from `fonts.gstatic.com/s/barlowcondensed/v13/` | SIL OFL-1.1, `public/fonts/Barlow-OFL.txt` |
| IBM Plex Mono, Regular and Medium | [Google Fonts](https://fonts.google.com/specimen/IBM+Plex+Mono), [project](https://github.com/IBM/plex); files from `fonts.gstatic.com/s/ibmplexmono/v20/` | SIL OFL-1.1, reserved font name Plex, unmodified binaries; `public/fonts/IBMPlex-OFL.txt` |

Downloaded 2026-11-04 from the URLs returned by the Google Fonts CSS API for the
specified families/weights. Copyright and license notices accompany the fonts.

## Generated assets (original, created by this project)
| Asset | Method | License |
|---|---|---|
| Terrain, towns, buildings, roads, props | Procedural generation from seeded noise/layout code | Original, project-owned |
| All textures (concrete, brick, wood, metal, grass, dirt, rock, decals, sky) | Canvas2D / DataTexture generation at runtime | Original, project-owned |
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

No GPL/AGPL code is linked. Three.js addons are MIT. If any external CC0 asset is added later it must be recorded here with source URL and license.

## Reference-only imagery

`qa/shots/references/` contains ignored inspection copies of publisher-provided
Steam store screenshots for PUBG: BATTLEGROUNDS, Battlefield 2042 and THE FINALS.
These are copyrighted comparison material, **not permissively licensed runtime
assets**. They are not imported by the game, bundled in `dist/`, or committed.
Exact source links and visual-review notes are in `REFERENCE.md`.
