# Blackshore sound bank

This bank contains **128 selected, edited CC0 recordings (1,636,252 bytes)**.
It is served locally; the game makes no runtime requests to stock-audio sites.
Every core gameplay sound is a real recording. There are no oscillators, noise
generators or synthesized substitutes; the only generated signal is a
convolution impulse used as a reverb tail (processing of the recorded mix).

`manifest.json` is the authoritative inventory. It records, for every clip: the
logical name, category, group, duration, loop flag, source library, source file,
source start time, author, URL, download date, processing description, output
SHA-256 and byte count. `AUDIO_FETCH_LOG.md` at the repository root records the
routes that failed, the rejected licences and the final coverage matrix.

## Firearm recordings

**The Free Firearm Sound Library** — Ben Jaszczak, Brian Nelson, Kevin Heras and
Matthew Nanney. Archived by OpenGameArt:
https://opengameart.org/content/the-free-firearm-sound-library

The inspected asset page states **CC0 / no rights reserved**, and identifies all
four recordists. Original library websites are no longer available; the archived
page and the library's actual `Prepared Master Sheet.csv` were inspected. Only
selected single-shot onsets are used. Source recordings supply pistol, carbine,
SMG, pump shotgun, precision rifle, DMR and support-gun layers. These recordings
are artistic sound choices for original game weapons; source firearm names do not
imply model endorsement.

## Foley, impacts, footsteps and interface

**Kenney** — https://kenney.nl

- https://kenney.nl/assets/impact-sounds — mechanism clicks, shell casing,
  metal/heavy impacts.
- https://kenney.nl/assets/sci-fi-sounds — explosions, rocket launch, vehicle
  destruction.
- https://kenney.nl/assets/interface-sounds — selection, confirmation, error,
  open, click, hitmarker and kill-confirm cues.

The free downloads' actual `License.txt` files explicitly specify CC0 and are
included alongside this notice as `LICENSE-Kenney-impact-sounds.txt`,
`LICENSE-Kenney-interface-sounds.txt` and `LICENSE-Kenney-sci-fi-sounds.txt`.
Asset acquisition used the sites' ordinary download controls. No paid accounts,
purchases or credentials were used.

**OpenGameArt CC0 libraries** — all pages inspected and licence-checked:

- rubberduck: [75 CC0 breaking/falling/hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx),
  [100 CC0 SFX #2](https://opengameart.org/content/100-cc0-sfx-2),
  [25 CC0 mud sfx](https://opengameart.org/content/25-cc0-mud-sfx),
  [40 CC0 water splash/slime sfx](https://opengameart.org/content/40-cc0-water-splash-slime-sfx).
- qubodup: [Impact](https://opengameart.org/content/impact),
  [Jump Landing Sound](https://opengameart.org/content/jump-landing-sound).
- TinyWorlds: [Different steps on wood, stone, leaves, gravel and mud](https://opengameart.org/content/different-steps-on-wood-stone-leaves-gravel-and-mud).
- Thimras: [Metal footsteps on concrete](https://opengameart.org/content/metal-footsteps-on-concrete),
  [Park ambiences](https://opengameart.org/content/park-ambiences).
- SpringySpringo: [Gun reload sounds](https://opengameart.org/content/gun-reload-sounds).
- zer0_sol: [Handgun Reload Sound Effect](https://opengameart.org/content/handgun-reload-sound-effect).
- StarNinjas: [2 Gun Reloads](https://opengameart.org/content/2-gun-reloads).
- LFA: [equipment clicks III](https://opengameart.org/content/equipment-clicks-iii).
- Macro: [Jump Landing](https://opengameart.org/content/jump-landing).
- GGBotNet: [Car Sound Effects Pack (Low Quality)](https://opengameart.org/content/car-sound-effects-pack-low-quality).
- yd: [Short Alarm](https://opengameart.org/content/short-alarm).

**Freesound CC0 recordings** — selected item pages, all declaring CC0:

- morganpurkis: distant gunshots
  [384717](https://freesound.org/people/morganpurkis/sounds/384717/),
  [384715](https://freesound.org/people/morganpurkis/sounds/384715/),
  [384714](https://freesound.org/people/morganpurkis/sounds/384714/),
  [384716](https://freesound.org/people/morganpurkis/sounds/384716/).
- Kostrava: [distant explosion 324277](https://freesound.org/people/Kostrava/sounds/324277/).
- jawbutch: [flesh impacts 344409](https://freesound.org/people/jawbutch/sounds/344409/).
- MPierluissi: [dry fire 460852](https://freesound.org/people/MPierluissi/sounds/460852/).
- qubodup: [bullet fly-by 855248](https://freesound.org/people/qubodup/sounds/855248/).
- modusmogulus: [subsonic whiz 789222](https://freesound.org/people/modusmogulus/sounds/789222/).
- AndrewAlexander: [car idle loop 369053](https://freesound.org/people/AndrewAlexander/sounds/369053/).
- audible-edge: tire squeal
  [71737](https://freesound.org/people/audible-edge/sounds/71737/),
  [71738](https://freesound.org/people/audible-edge/sounds/71738/).
- Jim-Bretherick: [distant battle 823852](https://freesound.org/people/Jim-Bretherick/sounds/823852/).

No Freesound API key was present. The selected sounds were downloaded through
their public pages/preview files after checking the item licence; no key is
stored in this repository or in the build scripts.

## Rejected sources

The following were inspected and **not** shipped:

- `shotgunsounds.zip` / `shotgun-shoot-reload` — CC-BY, attribution required.
- `NenadSimic_-_Muffled_Distant_Explosion.wav` — AudioJungle-sourced, licence
  incompatible with a CC0-only public bank.
- `sounds.zip` / `extracted/sounds/` (Vincent Sevedge) — Creative Commons
  Attribution 3.0 Unported (`creativecommons.txt` in the archive).
- `Owlish_Media_Sound_Effects.zip` — truncated/invalid archive.
- `swishes.zip` — incomplete download.
- Sonniss GDC bundles — royalty-free for productions but not CC0 and not
  redistributable as raw source files; not needed because CC0 coverage was
  complete.
- LANDR Samples — licence requires credits and excludes standalone SFX use.
- Pixabay weapon SFX — HTTP 403 and no established CC0 grant.

## Transformation and evidence

`tools/build-audio.py`:

- decodes each source to 48 kHz mono and removes DC;
- selects recorded onsets for one-shots and trims surrounding silence;
- builds loops by cross-fading the segment tail into its head (equal-power),
  with a proportional edge-fade guard for very short transients;
- matches per-category loudness on the loudest 50 ms window, then shaves peaks
  with a `tanh` soft limiter to a 0.75 sample ceiling before encoding;
- encodes Ogg Vorbis q5 and records the output hash/size in `manifest.json`;
- removes stale clips, so the directory cannot accumulate unreferenced audio.

`tools/validate-audio.py` decodes every shipped clip and writes
`qa/reports/audio-bank-validation.json`. Current result: **128 clips, 48 kHz
mono, finite, non-silent, max decoded peak 0.855 < 0.86 ceiling, 11 loop seams
checked**.

## Runtime audio architecture

- `src/audio/sounds.js` centralises every logical sound, category mixing
  defaults, per-sound priority, voice caps, variation pools, distance range,
  filtering profile, reverb send, loop flag and cooldown.
- `src/audio/spatial.js` owns listener basis, distance gain, stereo pan,
  propagation delay, path proximity for whiz-bys, indoor detection and cutoff.
- `src/audio/voices.js` enforces a 40-voice global budget plus category caps
  with priority stealing.
- `src/audio/samples.js` loads `core` eagerly and `vehicle`/`ambience` lazily.
- `src/audio/audio.js` performs recorded-only playback, distance filtering,
  line-of-sight occlusion, indoor reverb send, recorded engine/ambience/alarm
  loops, cooldowns and idempotent session teardown.

The previous synthesized-substitute language and the 36-clip inventory in this
notice have been retired. The current bank is the 128-clip CC0 inventory above.
No LANDR/Pixabay file is included or claimed as downloaded. Owner-selected
licensed downloads can be supplied under
`qa/downloads/audio-research/owner/` with item URL, creator and licence
certificate; import them through `tools/build-audio.py` after source review.
