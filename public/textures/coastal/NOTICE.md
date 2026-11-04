# Coastal surfaces

Selected **Poly Haven CC0** photographs, served locally in the game:

- [Blue Plaster Weathered](https://polyhaven.com/a/blue_plaster_weathered)
- [Concrete Layers](https://polyhaven.com/a/concrete_layers)
- [Asphalt 02](https://polyhaven.com/a/asphalt_02)
- [Brick Wall 001](https://polyhaven.com/a/brick_wall_001)

[Poly Haven's asset licence](https://polyhaven.com/license) explicitly releases
its texture assets under [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/).

Albedo, OpenGL normal and roughness maps are resized to 1024px and encoded as
WebP. Blue plaster albedo is desaturated for Blackshore's salt-grey palette.
Normal and roughness channels are loaded as linear data. Exact source URLs,
SHA-256 hashes, transformations and shipped sizes are in `manifest.json`.
`tools/import-surfaces.py` is the reproducible importer. Original source files
are retained under ignored `qa/downloads/coastal-surfaces/`.
