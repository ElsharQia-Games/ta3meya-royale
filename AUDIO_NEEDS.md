# AUDIO_NEEDS.md — Outstanding audio needs

## Status: no silent placeholders

The Phase 4 bank covers every core gameplay category with real CC0 recordings.
No runtime clip is a silent placeholder, an oscillator, a noise generator or a
synthesized substitute. `public/audio/manifest.json` lists 128 clips; the
`AUDIO_FETCH_LOG.md` records how each category was sourced.

## Coverage

| Required by report4 | Status |
|---|---|
| Close gunfire for pistol, SMG, AR, DMR, shotgun, sniper, LMG, RPG | Covered with 2–4 recorded variations per weapon and a dedicated rocket-launch recording |
| Distant gunfire | Covered by four real distant-gunshot recordings |
| Reload start, mag out/in, completion, bolt/pump, dry-fire | Covered by recorded reloads plus recorded mechanism clicks |
| Concrete, wood, metal, dirt, flesh, glass, water impacts | Covered with 2–3 variations each |
| Bullet whizz-by | Covered by two real fly-by recordings, driven by projectile path |
| Explosion, debris, destruction, vehicle destruction | Covered |
| Footsteps: concrete, wood, metal, dirt, grass, water, jump, land | Covered with 2–3 variations per surface |
| Vehicle idle, low/high RPM, acceleration, start/stop, brake, skid, doors, impacts | Covered by recorded engine and car recordings; idle/drive loops cross-fade by speed |
| Wind, birds, distant battle ambience | Covered by recorded beds |
| UI select/confirm/error/open, pickup, heal, hitmarker, kill confirm | Covered |
| Zone warning | Covered by a recorded alarm loop |

## Known presentation choices, not missing assets

- **Tire rolling** has no standalone loop. Road/tyre presence comes from the
  recorded engine-drive loop and the recorded skid layer; no oscillator fills
  the gap. A dedicated CC0 rolling loop could be added later as another
  `vehicle-loop` clip without changing engine code.
- **Crouched footsteps** reuse the surface pools with movement cadence rather
  than a separate crouch set. Playback rate is not scaled with speed, so clips
  are not mechanically sped up.
- **Weapon shot layering** uses complete recorded shots rather than separately
  acquired attack/body/tail stems. report4 explicitly permits a licensed
  complete recording when isolated layers are unavailable; the audio engine adds
  the environment tail through reverb send.
- **Engine low/high RPM** is a continuous cross-fade and pitch change of two
  recorded states, not a sample-per-RPM library.

## If a new sound is needed

1. Prefer a CC0 recording from Freesound, OpenGameArt or Kenney.
2. Verify the licence on the item page and keep the URL/author in the manifest.
3. Add the source file under the ignored `qa/downloads/audio-research/phase4/`
   tree and a `add(...)`/`freesound(...)` entry in `tools/build-audio.py`.
4. Re-run `python tools/build-audio.py` and `python tools/validate-audio.py`.
5. Add the clip to a sound definition in `src/audio/sounds.js`; the manifest
   closure test fails if a shipped clip is unreferenced or a referenced clip is
   missing.

Do not add a silent placeholder while a licence-verified recording can still be
sourced. If every route fails, ship the placeholder **and** document the failed
URLs, dates and licence checks here.
