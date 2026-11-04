# ASSETS.md — Sources and licenses

## External runtime assets
**None.** No commercial game assets, names, maps, logos or code are used. No downloaded models, textures, sounds or fonts are required at runtime.

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
