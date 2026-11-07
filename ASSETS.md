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
| Audio mixing, distance filtering, occlusion, stereo panning and convolution reverb tail | Web Audio processing of the CC0 recordings below | Processing only; no synthesized core sound effect |
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

**128 recorded CC0 clips (1,636,252 bytes)** are served locally; the game makes
no runtime requests to stock-audio sites. Every core gameplay sound is a real
recording. The only generated signal is a convolution impulse used as a reverb
tail — processing of the recorded mix, not a substitute sound.

| Source | Author | Licence | Used for |
|---|---|---|---|
| [The Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library) | Ben Jaszczak, Brian Nelson, Kevin Heras, Matthew Nanney | CC0-1.0 | 26 pistol/SMG/AR/DMR/shotgun/sniper/LMG shot recordings |
| [Kenney Impact Sounds](https://kenney.nl/assets/impact-sounds) | Kenney | CC0-1.0 | mechanism, metal impact, shell and heavy-impact layers |
| [Kenney Sci-fi Sounds](https://kenney.nl/assets/sci-fi-sounds) | Kenney | CC0-1.0 | explosions, rocket launch, vehicle destruction |
| [Kenney Interface Sounds](https://kenney.nl/assets/interface-sounds) | Kenney | CC0-1.0 | UI select/confirm/error/open/click, hitmarker, kill confirm |
| [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | CC0-1.0 | impacts, body fall, destruction, vehicle impact |
| [100 CC0 SFX #2](https://opengameart.org/content/100-cc0-sfx-2) | rubberduck | CC0-1.0 | impacts, footsteps, jump, pickup |
| [25 CC0 mud sfx](https://opengameart.org/content/25-cc0-mud-sfx) | rubberduck | CC0-1.0 | dirt impacts and footsteps |
| [40 CC0 water splash / slime sfx](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | rubberduck | CC0-1.0 | water impacts and footsteps |
| [Impact](https://opengameart.org/content/impact) | qubodup | CC0-1.0 | stone/wood/metal/meat impacts |
| [Different steps on wood, stone, leaves, gravel and mud](https://opengameart.org/content/different-steps-on-wood-stone-leaves-gravel-and-mud) | TinyWorlds | CC0-1.0 | concrete/wood/grass/dirt footsteps |
| [Metal footsteps on concrete](https://opengameart.org/content/metal-footsteps-on-concrete) | Thimras | CC0-1.0 | metal footsteps |
| [Park ambiences](https://opengameart.org/content/park-ambiences) | Thimras | CC0-1.0 | wind and bird beds |
| [Jump Landing](https://opengameart.org/content/jump-landing) | Macro | CC0-1.0 | landing variations |
| [Jump Landing Sound](https://opengameart.org/content/jump-landing-sound) | qubodup | CC0-1.0 | landing variation |
| [Gun reload sounds](https://opengameart.org/content/gun-reload-sounds) | SpringySpringo | CC0-1.0 | pump, rifle and generic reloads |
| [Handgun Reload Sound Effect](https://opengameart.org/content/handgun-reload-sound-effect) | zer0_sol | CC0-1.0 | handgun reload |
| [2 Gun Reloads](https://opengameart.org/content/2-gun-reloads) | StarNinjas | CC0-1.0 | alternative reloads |
| [equipment clicks III](https://opengameart.org/content/equipment-clicks-iii) | LFA | CC0-1.0 | weapon-switch clicks |
| [Short Alarm](https://opengameart.org/content/short-alarm) | yd | CC0-1.0 | zone alarm loop |
| [Car Sound Effects Pack](https://opengameart.org/content/car-sound-effects-pack-low-quality) | GGBotNet | CC0-1.0 | engine idle/drive/start/stop, door, brake |
| [Freesound](https://freesound.org/) (13 recordings) | morganpurkis, Kostrava, jawbutch, MPierluissi, qubodup, modusmogulus, AndrewAlexander, audible-edge, Jim-Bretherick | CC0-1.0 | distant gunfire/explosion, flesh impacts, dry fire, whiz-bys, car idle, tyre skid, battle bed |

`public/audio/NOTICE.md` identifies the sources and `AUDIO_FETCH_LOG.md` records
the acquisition routes, rejected licences and failed downloads. The three Kenney
`License.txt` files are shipped as `LICENSE-Kenney-*.txt`.
`manifest.json` records the exact source file, source start, author, URL,
download date, processing, output SHA-256 and byte count per clip;
`tools/build-audio.py` reproduces the bank and `tools/validate-audio.py` decodes
every clip into `qa/reports/audio-bank-validation.json`.

Rejected for licence reasons: CC-BY `shotgunsounds.zip` / `shotgun-shoot-reload`,
the AudioJungle-sourced `NenadSimic_-_Muffled_Distant_Explosion.wav`, and
CC-BY-3.0 `sounds.zip` (Vincent Sevedge). No LANDR or Pixabay files were acquired.
Owner-provided licensed selections can be imported through the documented
clip-slot workflow.

## Reference-only imagery

`qa/shots/references/` contains ignored inspection copies of publisher-provided
Steam store screenshots for PUBG: BATTLEGROUNDS, Battlefield 2042 and THE FINALS.
These are copyrighted comparison material, **not permissively licensed runtime
assets**. They are not imported by the game, bundled in `dist/`, or committed.
Exact source links and visual-review notes are in `REFERENCE.md`.
