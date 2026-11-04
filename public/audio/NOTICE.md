# Blackshore sound bank

This bank contains **36 selected, edited CC0 clips (359,719 bytes)**. It is served
locally; the game makes no runtime requests to stock-audio websites.

## Firearm recordings

**The Free Firearm Sound Library** — Ben Jaszczak, Brian Nelson, Kevin Heras and
Matthew Nanney. Archived by OpenGameArt:
https://opengameart.org/content/the-free-firearm-sound-library

The inspected asset page states **CC0 / no rights reserved**, for personal and
professional application, and identifies all four recordists. Original library
websites are no longer available; the archived page and the library's actual
`Prepared Master Sheet.csv` were inspected. The CSV describes recording position,
weapon, shot/burst and format. Only selected single-shot onsets are used here.

Source archive: `Prepared SFX Library.7z`, 193,954,738 bytes.
SHA-256: `cc1ab5a99a0a365105c7c5dd783f4b0b1fe90938114d3ceec53856bfe005f7d6`.

Source recordings supply pistol, carbine, SMG, pump shotgun, precision rifle,
DMR and support-gun layers. These recordings are artistic sound choices for
original game weapons; source firearm names do not imply model endorsement.

## Foley, impacts and interface

**Kenney** — https://kenney.nl

- https://kenney.nl/assets/impact-sounds — footsteps, metal, cloth/body and debris.
- https://kenney.nl/assets/sci-fi-sounds — blast layers and rocket launch.
- https://kenney.nl/assets/interface-sounds — selection/deployment cues.

The free downloads' actual `License.txt` files explicitly specify CC0 and are
included alongside this notice. Asset acquisition used the sites' ordinary
download controls. No paid accounts, purchases or credentials were used.

## Transformation and evidence

`tools/build-audio.py` selects recorded onsets, folds to mono/48kHz, removes DC,
normalises source peak to 0.67, fades edit boundaries, and encodes Vorbis q5.
`manifest.json` records exact source files/hashes, trim starts, duration, output
hash and size. Original archives and source pages stay under ignored
`qa/downloads/audio-research/`.

The runtime samples are mixed with original synthesized layers. HRTF panning,
distance filtering, line-of-sight occlusion and a 48-sample-voice bound are owned
by `src/audio/audio.js`; reload phase cues are cancellable and driven by the
current authoritative reload timer.

## Requested LANDR / Pixabay sources

Evaluated 2026-11-04:

- https://samples.landr.com/sfxs/weapons
- https://www.landr.com/terms-of-service/ (Our Samples Service)
- https://pixabay.com/sound-effects/search/weapon/
- https://pixabay.com/service/terms/ (last updated 20 October 2026)

LANDR's standard Samples Licence requires download credits and explicitly
excludes standalone use as sound effects; no applicable separate game-SFX licence
was established. Pixabay permits incorporated creative use, but its sound-effect
pages/downloads returned HTTP 403 through both fetch and ordinary browser access.
**No LANDR or Pixabay recording is included or claimed as downloaded.**

Owner-selected Pixabay downloads can be supplied under
`qa/downloads/audio-research/owner/` with their item URL, creator and licence
certificate. Import them into the same named clip slots after source review;
retain the source and transformation evidence. A site name alone is not evidence
of rights to a particular audio file.
