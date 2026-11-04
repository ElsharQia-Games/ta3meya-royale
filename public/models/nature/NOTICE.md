# Blackshore nature subset — Quaternius

Author: Quaternius. License: **CC0-1.0** (included `LICENSE.txt`).
Source: https://quaternius.itch.io/stylized-nature-megakit
Publisher page: https://quaternius.com/packs/stylizednaturemegakit.html
Downloaded2026-11-04 using the free **Standard** option.

Original archive SHA-256:
`298f6732b872e4cf7b30e6e7abf9641c7f6dc6b326df37ac089533ed7e3d58c9`

Derived with:

```sh
python3 tools/import-nature.py qa/downloads/quaternius-nature-standard.zip
```

The optional importer needs Python3.11+ and Pillow (run here with Python3.14.8 /
Pillow11.3.0). The game does not need Python. `manifest.json` records selected
files, original descriptor hashes and retained triangle counts.

- `Pine_1`, `Pine_3`, `CommonTree_1`, `CommonTree_3`: original leaf primitives;
  bark primitives are omitted. Procedural trunks continue to match shared
  collision footprints. Unused materials/textures are pruned from the descriptor;
  the original `.bin` buffers remain byte-for-byte unchanged.
- `Bush_Common`, `Fern_1`, `Rock_Medium_1`: original geometry.
- Required maps are resized to at most512×512 and encoded as quality90 WebP.
  Flat coloured leaf maps are recoloured to the recorded coastal palette with
  subtle procedural variation; original alpha silhouettes are preserved.
  glTF descriptors use the standard `EXT_texture_webp` extension supported by
  the installed Three.js r170 loader.
- Runtime canopy height follows the existing world tree height. Ground plants
  are cosmetic, at approximately0.32–0.52m. Near canopies are instanced within
 120/85/45m for high/medium/low. Plants are limited to45m and omitted on low.
- Rock geometry is centred/normalised to the existing rock AABB extents, with
  quarter-turn variation. Materials receive project tint, roughness and lighting.

These are derivative asset adaptations, not commercial-game art. No runtime
requests are made to Quaternius/itch.io. The full source archive stays ignored.
