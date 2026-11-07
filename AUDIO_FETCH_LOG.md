# AUDIO_FETCH_LOG.md — Phase 4 sourcing record

This is the sourcing and licensing record for the Phase 4 sound bank. It lists
the routes that were tried, what they returned, which files were rejected and
why, and what was finally shipped. The authoritative per-clip evidence is
`public/audio/manifest.json`; the reproduction script is
`tools/build-audio.py`; validation is `tools/validate-audio.py` and
`qa/reports/audio-bank-validation.json`.

## Policy

1. Every runtime sound must come from a real recording. Oscillators, noise
   generators and other synthesis are not acceptable substitutes for a game
   sound. The only generated signal in the engine is a convolution impulse used
   as a reverb tail (processing of the recorded mix, not a source sound).
2. Only **CC0-1.0** recordings are shipped, so the distributed bank imposes no
   attribution or share-alike obligation on downstream builds.
3. Source URL, author, source file, source start time, download date, edit
   description, output hash and byte count are recorded for every clip.
4. API keys and credentials are never written to the repository or logs. No
   `.env` and no `FREESOUND_API_KEY` were present in this checkout.
5. A file that cannot be license-verified is not used, even if it sounds good.

## Route order and results

### 1. Freesound

**API route — unavailable.** There was no `FREESOUND_API_KEY` in the
environment or in `.env`, so the documented API search/download path could not
be used. No key was fabricated or committed.

**Search route — degraded.** `websearch` returned HTTP 402. DuckDuckGo HTML
searches returned a captcha page. Freesound discovery therefore relied on direct
sound-page URLs and the public preview download endpoint, which is reachable
without an API token for the selected sounds. Only sounds whose page declares
CC0 were downloaded.

| Local file | Freesound sound | Author | Declared licence |
|---|---|---|---|
| `distant-gunshot-384717.mp3` | [384717](https://freesound.org/people/morganpurkis/sounds/384717/) | morganpurkis | CC0 |
| `distant-gunshot-384715.mp3` | [384715](https://freesound.org/people/morganpurkis/sounds/384715/) | morganpurkis | CC0 |
| `distant-gunshot-384714.mp3` | [384714](https://freesound.org/people/morganpurkis/sounds/384714/) | morganpurkis | CC0 |
| `distant-gunshot-384716.mp3` | [384716](https://freesound.org/people/morganpurkis/sounds/384716/) | morganpurkis | CC0 |
| `distant-explosion-kostrava.mp3` | [324277](https://freesound.org/people/Kostrava/sounds/324277/) | Kostrava | CC0 |
| `flesh-impacts-jawbutch.mp3` | [344409](https://freesound.org/people/jawbutch/sounds/344409/) | jawbutch | CC0 |
| `dry-fire-mpierluissi.mp3` | [460852](https://freesound.org/people/MPierluissi/sounds/460852/) | MPierluissi | CC0 |
| `bullet-flyby-qubodup.mp3` | [855248](https://freesound.org/people/qubodup/sounds/855248/) | qubodup | CC0 |
| `whiz-subsonic-modusmogulus.mp3` | [789222](https://freesound.org/people/modusmogulus/sounds/789222/) | modusmogulus | CC0 |
| `car-idle-loop-andrew-alexander.mp3` | [369053](https://freesound.org/people/AndrewAlexander/sounds/369053/) | AndrewAlexander | CC0 |
| `tire-squeal-1-audible-edge.mp3` | [71737](https://freesound.org/people/audible-edge/sounds/71737/) | audible-edge | CC0 |
| `tire-squeal-2-audible-edge.mp3` | [71738](https://freesound.org/people/audible-edge/sounds/71738/) | audible-edge | CC0 |
| `distant-battle-jim-bretherick.mp3` | [823852](https://freesound.org/people/Jim-Bretherick/sounds/823852/) | Jim-Bretherick | CC0 |

These files live under the ignored `qa/downloads/audio-research/phase4/freesound/`
directory and are not committed. Their derived clips are in `public/audio/`.

### 2. Sonniss GDC bundles

Not used. The Sonniss GDC game-audio bundles are distributed for royalty-free
use in productions, but the bundle terms do not make the raw recordings CC0 and
do not grant unrestricted redistribution of the source files. Shipping them in a
public repository/browser payload would conflict with the CC0-only policy. The
CC0 routes below already cover every required category, so Sonniss was not
needed.

### 3. OpenGameArt CC0 libraries

Downloaded and license-checked:

| Library | Author | Source | Clips used |
|---|---|---|---|
| The Free Firearm Sound Library | Ben Jaszczak, Brian Nelson, Kevin Heras, Matthew Nanney | [OpenGameArt](https://opengameart.org/content/the-free-firearm-sound-library) | 26 weapon shots |
| 75 CC0 breaking / falling / hit sfx | rubberduck | [OpenGameArt](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | impacts, body fall, destruction, vehicle impact |
| 100 CC0 SFX #2 | rubberduck | [OpenGameArt](https://opengameart.org/content/100-cc0-sfx-2) | impacts, steps, jump, pickup |
| 25 CC0 mud sfx | rubberduck | [OpenGameArt](https://opengameart.org/content/25-cc0-mud-sfx) | dirt impacts and steps |
| 40 CC0 water splash / slime sfx | rubberduck | [OpenGameArt](https://opengameart.org/content/40-cc0-water-splash-slime-sfx) | water impacts and steps |
| Impact | qubodup | [OpenGameArt](https://opengameart.org/content/impact) | stone/wood/metal/meat impacts |
| Different steps on wood, stone, leaves, gravel and mud | TinyWorlds | [OpenGameArt](https://opengameart.org/content/different-steps-on-wood-stone-leaves-gravel-and-mud) | concrete/wood/grass/dirt steps |
| Metal footsteps on concrete | Thimras | [OpenGameArt](https://opengameart.org/content/metal-footsteps-on-concrete) | metal steps |
| Park ambiences | Thimras | [OpenGameArt](https://opengameart.org/content/park-ambiences) | wind and bird beds |
| Ambient Bird Sounds | isaiah658 | [OpenGameArt](https://opengameart.org/content/ambient-bird-sounds) | inspected, kept as a fallback source |
| Jump Landing | Macro | [OpenGameArt](https://opengameart.org/content/jump-landing) | landing variations |
| Jump Landing Sound | qubodup | [OpenGameArt](https://opengameart.org/content/jump-landing-sound) | landing variation |
| Gun reload sounds | SpringySpringo | [OpenGameArt](https://opengameart.org/content/gun-reload-sounds) | pump, rifle/generic reloads |
| Handgun Reload Sound Effect | zer0_sol | [OpenGameArt](https://opengameart.org/content/handgun-reload-sound-effect) | handgun reload |
| 2 Gun Reloads | StarNinjas | [OpenGameArt](https://opengameart.org/content/2-gun-reloads) | alternative reloads |
| equipment clicks III | LFA | [OpenGameArt](https://opengameart.org/content/equipment-clicks-iii) | weapon-switch clicks |
| Short Alarm | yd | [OpenGameArt](https://opengameart.org/content/short-alarm) | zone alarm loop |
| Car Sound Effects Pack (Low Quality) | GGBotNet | [OpenGameArt](https://opengameart.org/content/car-sound-effects-pack-low-quality) | engine idle/drive/start/stop, door, brake |
| 37 hits/punches | qubodup | [OpenGameArt](https://opengameart.org/content/37-hitspunches) | inspected for flesh impacts; not selected |
| 150 combat sounds | mixed CC0 contributors | local `150-combat.zip`, `LICENSES.txt` | inspected; not selected |

### 4. Kenney

The Kenney asset pages (`kenney.nl/assets/impact-sounds` and siblings) returned
HTTP 403 to a direct fetch, but the free archives were already present from the
earlier download and were used directly. Their bundled `License.txt` files
explicitly state CC0 and are shipped as
`public/audio/LICENSE-Kenney-impact-sounds.txt`,
`LICENSE-Kenney-interface-sounds.txt` and `LICENSE-Kenney-sci-fi-sounds.txt`.

Used for: metal/plate/tin mechanism layers, impacts, explosions, thruster/rocket
launch, vehicle destruction, and interface clicks/confirmations.

### 5. Open-source repositories and other web sources

Searches for additional open-source game-audio repositories were attempted
through the available web search, which was also affected by the 402/captcha
failures above. The already-downloaded CC0 libraries covered the remaining
categories, so no repository import was required. No unverified web download was
promoted to the runtime bank.

## Rejected candidates

| Candidate | Reason |
|---|---|
| `shotgunsounds.zip` (`ShotgunSounds/…`, including shotgun reload material) | CC-BY, attribution required. Replaced with CC0 SpringySpringo/zer0_sol/StarNinjas reloads and Kenney mechanism layers. |
| `shotgun-shoot-reload` | CC-BY, attribution required. Not shipped. |
| `NenadSimic_-_Muffled_Distant_Explosion.wav` | AudioJungle-sourced; licence incompatible with a CC0-only public bank. Replaced with the Freesound Kostrava distant explosion. |
| `sounds.zip` / `extracted/sounds/` (cz.wav, mosin.wav, shotty.wav, sks.wav) | `creativecommons.txt` states “Creative Commons Attribution 3.0 Unported” (© 2009 Vincent Sevedge). Attribution-required, so not shipped. |
| `Owlish_Media_Sound_Effects.zip` | Truncated/invalid archive; `unzip -t` cannot find the central directory. |
| `swishes.zip` | Incomplete download. |
| LANDR Samples | Licence requires download credits and excludes standalone sound-effect use; no game-SFX licence established. |
| Pixabay weapon SFX | Pages/downloads returned HTTP 403; terms also do not establish CC0. No file included or claimed. |

## Failed acquisition attempts

- `websearch` HTTP 402 for all queries during the sourcing window.
- DuckDuckGo HTML endpoint served a captcha instead of results.
- No Freesound API credential; public API search/download unavailable.
- `kenney.nl/assets/impact-sounds` direct page HTTP 403 (archives already on disk
  and used).
- `Owlish_Media_Sound_Effects.zip` corrupt; `swishes.zip` truncated.
- Some Freesound alternative candidates were only available as preview streams
  with non-CC0 licences; they were skipped rather than guessed.

None of these failures left a category uncovered. No silent placeholder was
needed, so the runtime bank contains no placeholder files.

## Final coverage

128 recorded clips, 1,636,252 bytes, 48 kHz mono Ogg Vorbis q5.

| Category | Clips | Source route |
|---|---|---|
| Weapon shots | 26 | Free Firearm Sound Library (CC0) |
| Distant gunfire / explosion | 5 | Freesound CC0 (morganpurkis, Kostrava) |
| Explosions / rocket / vehicle destruction | 5 | Kenney sci-fi (CC0) |
| Body impacts / fall / damage | 6 | Freesound jawbutch, qubodup impact, rubberduck |
| Surface impacts | 18 | qubodup, rubberduck, Kenney |
| Footsteps | 16 | TinyWorlds, rubberduck, Thimras |
| Jump / land | 5 | rubberduck, Macro, qubodup |
| Weapon mechanism | 13 | Kenney impact, SpringySpringo, LFA, Freesound |
| Reloads | 5 | zer0_sol, SpringySpringo, StarNinjas |
| Interface / feedback | 9 | Kenney interface, rubberduck |
| Vehicle loops | 7 | GGBotNet, Freesound AndrewAlexander, audible-edge |
| Vehicle one-shots | 7 | GGBotNet, rubberduck, Kenney |
| Ambience | 3 | Thimras park ambiences, Freesound Jim-Bretherick |
| Zone alarm | 1 | yd (OpenGameArt) |
| Bullet whiz-by | 2 | Freesound qubodup, modusmogulus |

## Reproduction

```sh
python tools/build-audio.py        # rebuilds public/audio/ from local sources
python tools/validate-audio.py     # decodes every clip and writes the QA report
```

`tools/build-audio.py` fails closed: a missing source archive, an empty decode,
a silent sample or a too-short loop aborts the build instead of emitting a
placeholder. The ignored source tree is
`qa/downloads/audio-research/phase4/` plus the Free Firearm library under
`qa/downloads/audio-research/firearms/`.
