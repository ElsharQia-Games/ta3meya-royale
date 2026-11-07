"""Build the local game-audio bank from verified CC0 recordings.

Only mastered Ogg clips are shipped; source archives stay under the ignored
qa/downloads/audio-research tree. Every shipped clip records its original
file, author, source URL, license and processing in public/audio/manifest.json.

Requires Python 3.11+, numpy, ffmpeg and 7z. Run:
    python tools/build-audio.py
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
from pathlib import Path
from zipfile import ZipFile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "qa/downloads/audio-research"
P4 = SOURCE / "phase4"
BUILD = P4 / "work/build"
OUTPUT = ROOT / "public/audio"
SR = 48000
DOWNLOAD_DATE = "2026-11-06"
FS_DATE = "2026-11-07"

# Loudness is normalised by category (RMS dBFS) and then peak-limited so that
# weapon transients, footsteps, ambience and UI keep sensible relative levels.
TARGETS = {
    "shot": -11.5, "distant": -19.0, "explosion": -12.5, "impact": -19.0,
    "footstep": -23.0, "mechanism": -20.0, "reload": -21.0, "ui": -21.0,
    "vehicle-one": -18.5, "vehicle-loop": -20.0, "ambience": -27.5,
    "alarm": -18.0, "whiz": -22.0, "jump": -21.0, "body": -18.0,
}
PEAK_CEILING = 0.75

LIBS = {
    "firearm": dict(library="Free Firearm Sound Library", license="CC0-1.0",
                    author="Free Firearm Sound Library contributors",
                    url="https://opengameart.org/content/free-firearm-sound-library",
                    date=DOWNLOAD_DATE),
    "kenney-impact": dict(library="Kenney Impact Sounds", license="CC0-1.0", author="Kenney",
                          url="https://kenney.nl/assets/impact-sounds", date=DOWNLOAD_DATE),
    "kenney-scifi": dict(library="Kenney Sci-fi Sounds", license="CC0-1.0", author="Kenney",
                         url="https://kenney.nl/assets/sci-fi-sounds", date=DOWNLOAD_DATE),
    "kenney-ui": dict(library="Kenney Interface Sounds", license="CC0-1.0", author="Kenney",
                      url="https://kenney.nl/assets/interface-sounds", date=DOWNLOAD_DATE),
    "car": dict(library="Car Sound Effects Pack (Low Quality)", license="CC0-1.0", author="GGBotNet",
                url="https://opengameart.org/content/car-sound-effects-pack-low-quality", date=DOWNLOAD_DATE),
    "steps": dict(library="Different steps on wood, stone, leaves, gravel and mud", license="CC0-1.0",
                  author="TinyWorlds",
                  url="https://opengameart.org/content/different-steps-on-wood-stone-leaves-gravel-and-mud",
                  date=DOWNLOAD_DATE),
    "mud": dict(library="25 CC0 mud sfx", license="CC0-1.0", author="rubberduck",
                url="https://opengameart.org/content/25-cc0-mud-sfx", date=DOWNLOAD_DATE),
    "sfx100": dict(library="100 CC0 SFX #2", license="CC0-1.0", author="rubberduck",
                   url="https://opengameart.org/content/100-cc0-sfx-2", date=DOWNLOAD_DATE),
    "bfh": dict(library="75 CC0 breaking / falling / hit sfx", license="CC0-1.0", author="rubberduck",
                url="https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx", date=DOWNLOAD_DATE),
    "water": dict(library="40 CC0 water splash / slime sfx", license="CC0-1.0", author="rubberduck",
                  url="https://opengameart.org/content/40-cc0-water-splash-slime-sfx", date=DOWNLOAD_DATE),
    "metalsteps": dict(library="Metal footsteps on concrete", license="CC0-1.0", author="Thimras",
                        url="https://opengameart.org/content/metal-footsteps-on-concrete", date=DOWNLOAD_DATE),
    "park": dict(library="Park ambiences", license="CC0-1.0", author="Thimras",
                 url="https://opengameart.org/content/park-ambiences", date=DOWNLOAD_DATE),
    "birds": dict(library="Ambient Bird Sounds", license="CC0-1.0", author="isaiah658",
                  url="https://opengameart.org/content/ambient-bird-sounds", date=DOWNLOAD_DATE),
    "reload-gun": dict(library="Gun reload sounds", license="CC0-1.0", author="SpringySpringo",
                       url="https://opengameart.org/content/gun-reload-sounds", date=DOWNLOAD_DATE),
    "reload-handgun": dict(library="Handgun Reload Sound Effect", license="CC0-1.0", author="zer0_sol",
                           url="https://opengameart.org/content/handgun-reload-sound-effect", date=DOWNLOAD_DATE),
    "reload-star": dict(library="2 Gun Reloads", license="CC0-1.0", author="StarNinjas",
                        url="https://opengameart.org/content/2-gun-reloads", date=DOWNLOAD_DATE),
    "clicks": dict(library="equipment clicks III", license="CC0-1.0", author="LFA",
                   url="https://opengameart.org/content/equipment-clicks-iii", date=DOWNLOAD_DATE),
    "alarm": dict(library="Short Alarm", license="CC0-1.0", author="yd",
                  url="https://opengameart.org/content/short-alarm", date=DOWNLOAD_DATE),
    "jump": dict(library="Jump Landing", license="CC0-1.0", author="Macro",
                 url="https://opengameart.org/content/jump-landing", date=DOWNLOAD_DATE),
    "land": dict(library="Jump Landing Sound", license="CC0-1.0", author="qubodup",
                 url="https://opengameart.org/content/jump-landing-sound", date=DOWNLOAD_DATE),
    "impact-qa": dict(library="Impact", license="CC0-1.0", author="qubodup",
                      url="https://opengameart.org/content/impact", date=DOWNLOAD_DATE),
    "hits": dict(library="37 hits/punches", license="CC0-1.0", author="qubodup",
                 url="https://opengameart.org/content/37-hitspunches", date=DOWNLOAD_DATE),
}

ZIPS = {
    "kenney-impact": (SOURCE / "kenney-impact-sounds.zip", "Audio/"),
    "kenney-scifi": (SOURCE / "kenney-sci-fi-sounds.zip", "Audio/"),
    "kenney-ui": (SOURCE / "kenney-interface-sounds.zip", "Audio/"),
    "car": (P4 / "car_sound_effects_pack.zip", ""),
    "steps": (P4 / "[kdd]DifferentSteps_0.zip", ""),
    "mud": (P4 / "mud-sfx.zip", ""),
    "sfx100": (P4 / "sfx_100_v2.zip", ""),
    "bfh": (P4 / "sfx_breaking_and_falling.zip", ""),
    "water": (P4 / "water-splash-slime-sfx.zip", ""),
    "reload-star": (P4 / "gun_reload_-_starninjas.zip", ""),
}
DIRS = {
    "firearm": BUILD / "firearms" / "Prepared SFX Library",
    "metalsteps": BUILD / "metalsteps",
    "impact-qa": BUILD / "qubodup" / "qubodupImpact",
    "hits": BUILD / "hits" / "hits",
}
# Loose recordings: key -> (path, library preset).
LOOSE = {
    "shotguncock": (P4 / "shotguncock_0.wav", "reload-gun"),
    "equipment": (P4 / "equipment_clicks3.wav", "clicks"),
    "reload-rifle": (P4 / "assaultriflereload1_0.wav", "reload-gun"),
    "reload-handgun": (P4 / "reload.wav", "reload-handgun"),
    "reload-generic": (P4 / "gunreload1.wav", "reload-gun"),
    "alarm": (P4 / "alarm_0.ogg", "alarm"),
    "jump": (P4 / "Jump_1.wav", "jump"),
    "jump2": (P4 / "Jump_2.wav", "jump"),
    "land": (P4 / "jumpland.wav", "land"),
    "park-wind": (P4 / "park_ambience_wind.wav", "park"),
    "park-birds": (P4 / "park_ambience_birds.wav", "park"),
    "birds": (P4 / "birds-isaiah658_0.ogg", "birds"),
}
FREESOUND = P4 / "freesound"


def extract_archives() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    jobs = [
        (SOURCE / "Prepared-SFX-Library.7z", BUILD / "firearms"),
        (P4 / "metal_steps_48k24b.7z", BUILD / "metalsteps"),
        (P4 / "qubodupImpact.7z", BUILD / "qubodup"),
        (P4 / "independent_nu_ljudbank-hits_and_punches.7z", BUILD / "hits"),
    ]
    for archive, dest in jobs:
        if not archive.exists():
            raise FileNotFoundError(archive)
        dest.mkdir(parents=True, exist_ok=True)
        if not any(dest.iterdir()):
            subprocess.run(["7z", "x", "-y", f"-o{dest}", str(archive)], check=True,
                           stdout=subprocess.DEVNULL)
    # The zip readers are used in-memory; only verify they exist up front.
    for archive, _prefix in ZIPS.values():
        if not archive.exists():
            raise FileNotFoundError(archive)


def read_source(kind: str, rel: str) -> bytes:
    if kind == "freesound":
        return (FREESOUND / rel).read_bytes()
    if kind == "loose":
        return LOOSE[rel][0].read_bytes()
    if kind in ZIPS:
        archive, prefix = ZIPS[kind]
        with ZipFile(archive) as z:
            return z.read(prefix + rel)
    if kind in DIRS:
        return (DIRS[kind] / rel).read_bytes()
    raise KeyError(kind)


def decode(data: bytes) -> np.ndarray:
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        input=data, stdout=subprocess.PIPE, check=True)
    pcm = np.frombuffer(result.stdout, dtype="<f4").copy()
    if not len(pcm) or not np.isfinite(pcm).all():
        raise ValueError("invalid or empty PCM")
    return pcm - float(np.mean(pcm))


def find_onsets(pcm: np.ndarray, threshold: float = .16, gap: float = .13) -> list[int]:
    """Rising edges of the smoothed envelope above a fraction of the peak."""
    if not len(pcm):
        return []
    env = np.abs(pcm)
    win = max(1, int(.005 * SR))
    env = np.convolve(env, np.ones(win) / win, mode="same")
    peak = float(env.max())
    if peak < 1e-5:
        return []
    above = env > peak * threshold
    rising = np.flatnonzero(above & ~np.r_[False, above[:-1]])
    out: list[int] = []
    last = -10 ** 9
    for index in rising:
        if index - last >= gap * SR:
            out.append(int(index))
            last = int(index)
    if not out:
        out = [int(np.argmax(env))]
    return out


def slice_from(pcm: np.ndarray, onset: int, seconds: float) -> np.ndarray:
    start = max(0, onset - int(.006 * SR))
    end = min(len(pcm), start + int(seconds * SR))
    chunk = pcm[start:end].copy()
    return trim_silence(chunk)


def trim_silence(pcm: np.ndarray, floor_db: float = -52.0) -> np.ndarray:
    if not len(pcm):
        return pcm
    threshold = float(np.max(np.abs(pcm))) * (10 ** (floor_db / 20))
    loud = np.flatnonzero(np.abs(pcm) > max(threshold, 1e-6))
    if not len(loud):
        return pcm
    a = max(0, int(loud[0]) - int(.004 * SR))
    b = min(len(pcm), int(loud[-1]) + int(.02 * SR))
    return pcm[a:b].copy()


def dense_rms(pcm: np.ndarray, frame: float = .05) -> float:
    """RMS of the loudest short-term window.

    Whole-clip RMS punishes transient recordings (gunshots, clicks) for their
    quiet tails, so levels are matched on the loudest part that is actually
    heard while the peak ceiling keeps transients intact.
    """
    if not len(pcm):
        return 0.0
    win = min(len(pcm), max(1, int(frame * SR)))
    power = pcm * pcm
    if win >= len(power):
        return float(np.sqrt(np.mean(power)))
    env = np.convolve(power, np.ones(win) / win, mode="valid")
    return float(np.sqrt(np.max(env)))


def normalize(pcm: np.ndarray, category: str) -> np.ndarray:
    """Match category loudness, then gently limit the remaining peaks.

    A gain-only solution would leave quiet members of a pool far below the
    others whenever their brief peaks hit the ceiling. A tanh soft limiter
    shaves only those peaks (transient material, where the harmonic distortion
    is inaudible) and lets the steady loudness converge on the category target.
    """
    pcm = pcm - float(np.mean(pcm))
    if float(np.max(np.abs(pcm))) < 1e-4:
        raise ValueError("silent sample")
    target = 10 ** (TARGETS[category] / 20)
    out = pcm.astype(np.float64)
    for _ in range(6):
        loud = dense_rms(out)
        if loud > 1e-9:
            out *= target / loud
        if float(np.max(np.abs(out))) <= PEAK_CEILING:
            break
        out = PEAK_CEILING * np.tanh(out / PEAK_CEILING)
    peak = float(np.max(np.abs(out)))
    if peak > PEAK_CEILING:
        out *= PEAK_CEILING / peak
    return out


def fade_edges(pcm: np.ndarray, head: float = .004, tail: float = .045) -> np.ndarray:
    """Short fades, capped proportionally so very short transients survive."""
    out = pcm.copy()
    h = min(int(head * SR), max(1, int(len(out) * .02)))
    if h < len(out):
        out[:h] *= np.linspace(0.0, 1.0, h)
    t = min(int(tail * SR), max(1, int(len(out) * .05)))
    if t < len(out):
        out[-t:] *= np.linspace(1.0, 0.0, t)
    return out


def make_loop(pcm: np.ndarray, offset: float, seconds: float, crossfade: float) -> np.ndarray:
    """Crossfade the segment tail into its head so sample wrap is continuous."""
    start = min(len(pcm) - 1, int(offset * SR))
    n = int(seconds * SR)
    cf = int(crossfade * SR)
    need = n + cf
    seg = pcm[start:start + need]
    if len(seg) < need:
        raise ValueError(f"source too short for {seconds}s loop (have {len(seg) / SR:.2f}s)")
    out = seg[:n].copy()
    tail = seg[n:n + cf]
    t = np.linspace(0.0, 1.0, cf)
    out[:cf] = seg[:cf] * t + tail * (1.0 - t)
    return out


LEDGER: list[dict] = []
GROUPS: dict[str, list[str]] = {"core": [], "vehicle": [], "ambience": []}


def write_clip(name: str, pcm: np.ndarray, category: str, meta: dict, group: str,
               loop: bool = False) -> None:
    if len(pcm) < 32:
        raise ValueError(f"clip too short: {name}")
    pcm = normalize(np.asarray(pcm, dtype=np.float32), category)
    if not loop:
        pcm = fade_edges(pcm)
    target = OUTPUT / f"{name}.ogg"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-",
         "-c:a", "libvorbis", "-q:a", "5", "-map_metadata", "-1", str(target)],
        input=pcm.astype("<f4").tobytes(), check=True)
    row = {
        "file": target.name, "name": name, "group": group, "category": category,
        "seconds": round(len(pcm) / SR, 4), "loop": loop, "bytes": target.stat().st_size,
        "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        **meta,
    }
    LEDGER.append(row)
    GROUPS[group].append(name)


def add(name: str, kind: str, rel: str, *, category: str, group: str = "core",
        onsets: int = 1, seconds: float = 1.0, loop: float | None = None,
        loop_offset: float = 0.0, crossfade: float = .25, lib: str | None = None,
        url: str | None = None, author: str | None = None,
        title: str | None = None, note: str = "", onset_index: int = 0) -> None:
    data = read_source(kind, rel)
    pcm = decode(data)
    if lib is None and kind == "loose":
        lib = LOOSE[rel][1]
    lib_key = lib or kind
    base = dict(LIBS[lib_key]) if lib_key in LIBS else {}
    if url:
        base["url"] = url
    if author:
        base["author"] = author
    source_file = title if (kind == "loose" and title) else rel
    proc = "48 kHz mono; DC removal; category loudness normalisation; peak limit; fades"
    if loop is not None:
        pcm = make_loop(pcm, loop_offset, loop, crossfade)
        proc = (f"48 kHz mono; {loop_offset:.2f}s offset; {loop:.2f}s seamless loop "
                f"({crossfade * 1000:.0f} ms equal-power edge crossfade); "
                "category loudness normalisation; peak limit")
        meta = {**base, "sourceFile": source_file, "license": base.get("license", "CC0-1.0"),
                "downloadDate": base.get("date", DOWNLOAD_DATE), "processing": proc,
                "sourceTitle": title or rel, "notes": note}
        meta.pop("date", None)
        write_clip(name, pcm, category, meta, group, loop=True)
        return
    starts = find_onsets(pcm)
    take = [0] if onsets == 0 else starts[onset_index:onset_index + max(1, onsets)]
    if not take:
        raise ValueError(f"no onset: {name}")
    meta = {**base, "sourceFile": source_file, "license": base.get("license", "CC0-1.0"),
            "downloadDate": base.get("date", DOWNLOAD_DATE), "processing": proc + "; onset slice",
            "sourceTitle": title or rel, "notes": note}
    meta.pop("date", None)
    for index, onset in enumerate(take):
        chunk = slice_from(pcm, onset, seconds)
        at = onset / SR
        row_meta = {**meta, "sourceStartSeconds": round(at, 4)}
        out_name = name if onsets <= 1 else f"{name}-{index + 1}"
        write_clip(out_name, chunk, category, row_meta, group)


def freesound(name: str, rel: str, *, category: str, group: str, onsets: int = 1,
              seconds: float = 1.0, title: str, author: str, url: str,
              loop: float | None = None, loop_offset: float = 0.0,
              crossfade: float = .25, note: str = "") -> None:
    add(name, "freesound", rel, category=category, group=group, onsets=onsets,
        seconds=seconds, loop=loop, loop_offset=loop_offset, crossfade=crossfade,
        lib="freesound", url=url, author=author, title=title, note=note)


def build_freesound_meta() -> None:
    LIBS["freesound"] = dict(library="Freesound", license="CC0-1.0", author="", url="",
                             date=FS_DATE)


def main() -> None:
    OUTPUT.mkdir(exist_ok=True)
    extract_archives()
    build_freesound_meta()

    # -- Weapon close gunfire -------------------------------------------------
    for suffix, rel, sec in [
        ("a", "1911/A_42P.wav", .85), ("b", "1911/A_34P.wav", .95),
        ("c", "Walther PPQ/X_39P.wav", .85), ("d", "Walther PPQ/X_31P.wav", .95),
    ]:
        add(f"pistol-{suffix}", "firearm", rel, category="shot", seconds=sec)
    for suffix, rel in [("a", "AR-15/D_32P.wav"), ("b", "AR-15/D_24P.wav")]:
        add(f"ar-{suffix}", "firearm", rel, category="shot", seconds=1.15)
    add("smg-a", "firearm", "Carl Gustav M45/G_31P.wav", category="shot", seconds=.8)
    add("smg-b", "firearm", "Carl Gustav M45/G_33P.wav", category="shot", seconds=1.0)
    add("smg-c", "firearm", "Carl Gustav M45/G_35P.wav", category="shot", onsets=2, seconds=.8)

    add("shotgun-a", "firearm", "Model 12/K_22P.wav", category="shot", seconds=1.25)
    add("shotgun-b", "firearm", "CD/H_21P.wav", category="shot", seconds=1.15)
    add("shotgun-c", "firearm", "Nova/O_21P.wav", category="shot", seconds=1.15)
    add("shotgun-d", "firearm", "Model 12/K_17P.wav", category="shot", seconds=1.2)

    add("sniper-a", "firearm", "Savage 10 .300 Blackout/T_27P.wav", category="shot", seconds=1.7)
    add("sniper-b", "firearm", "Mosin Nagant/M_21P.wav", category="shot", seconds=1.7)
    add("sniper-c", "firearm", "Tikka/W_24P.wav", category="shot", seconds=1.7)
    add("sniper-d", "firearm", "Mosin Nagant/M_26P.wav", category="shot", seconds=1.7)

    add("dmr-a", "firearm", "SKS/U_14P.wav", category="shot", seconds=1.25)
    add("dmr-b", "firearm", "SKS/U_19P.wav", category="shot", seconds=1.3)
    add("dmr-c", "firearm", "Marlin 336/I_22P.wav", category="shot", seconds=1.2)
    add("dmr-d", "firearm", "Model 1894/L_23P.wav", category="shot", seconds=1.2)

    add("lmg-a", "firearm", "AK-47/C_28P.wav", category="shot", seconds=1.15)
    add("lmg-b", "firearm", "AK-47/C_27P.wav", category="shot", seconds=1.2)
    add("lmg-c", "firearm", "AK-47/C_29P.wav", category="shot", onsets=2, seconds=1.0)

    # -- Distant gunfire (real distant recordings) ----------------------------
    for i, (rel, title) in enumerate([
        ("distant-gunshot-384717.mp3", "Distant Gunshot 1"),
        ("distant-gunshot-384715.mp3", "Distant Gunshot 3"),
        ("distant-gunshot-384714.mp3", "Distant Gunshot 4 (Mono)"),
        ("distant-gunshot-384716.mp3", "Distant Gunshot 2 (Mono)"),
    ]):
        freesound(f"distant-{i + 1}", rel, category="distant", group="core", onsets=1,
                  seconds=2.8, title=title, author="morganpurkis",
                  url=f"https://freesound.org/people/morganpurkis/sounds/{rel[-8:-4]}/")
    # Correct source URLs (filename suffix is not the sound id).
    for row, ident in zip(LEDGER[-4:], (384717, 384715, 384714, 384716)):
        row["url"] = f"https://freesound.org/people/morganpurkis/sounds/{ident}/"

    # -- Reload / handling ----------------------------------------------------
    add("mag-out-a", "kenney-impact", "impactMetal_light_001.ogg", category="mechanism", seconds=.45)
    add("mag-out-b", "kenney-impact", "impactPlate_light_002.ogg", category="mechanism", seconds=.45)
    add("mag-in-a", "kenney-impact", "impactMetal_light_002.ogg", category="mechanism", seconds=.45)
    add("mag-in-b", "kenney-impact", "impactPlate_medium_001.ogg", category="mechanism", seconds=.5)
    add("bolt-a", "kenney-impact", "impactMetal_medium_002.ogg", category="mechanism", seconds=.55)
    add("bolt-b", "kenney-impact", "impactMetal_light_004.ogg", category="mechanism", seconds=.45)
    add("shell-a", "kenney-impact", "impactTin_medium_002.ogg", category="mechanism", seconds=.4)
    add("shell-b", "kenney-impact", "impactTin_medium_000.ogg", category="mechanism", seconds=.4)
    add("pump-1", "loose", "shotguncock", category="mechanism", seconds=.55)
    add("weapon-switch-a", "loose", "equipment", category="mechanism", onsets=3, seconds=.5)
    add("reload-handgun", "loose", "reload-handgun", category="reload", onsets=0, seconds=30)
    add("reload-rifle", "loose", "reload-rifle", category="reload", onsets=0, seconds=30)
    add("reload-generic", "loose", "reload-generic", category="reload", onsets=0, seconds=30)
    add("reload-alt-a", "reload-star", "gun_reload.1.ogg", category="reload", onsets=0, seconds=30)
    add("reload-alt-b", "reload-star", "gun_reload.2.ogg", category="reload", onsets=0, seconds=30)
    freesound("dry-fire", "dry-fire-mpierluissi.mp3", category="mechanism", group="core",
              onsets=1, seconds=.55, title="GUNRif_M1 GARAND DRY FIRE_MP.wav",
              author="MPierluissi", url="https://freesound.org/people/MPierluissi/sounds/460852/")

    # -- Impacts / destruction ------------------------------------------------
    add("impact-concrete-a", "impact-qa", "qubodupImpactStone.ogg", category="impact", seconds=.8)
    add("impact-concrete-b", "bfh", "bfh1_rock_hit_01.ogg", category="impact", seconds=.8)
    add("impact-concrete-c", "sfx100", "sfx100v2_stones_01.ogg", category="impact", seconds=.7)
    add("impact-wood-a", "impact-qa", "qubodupImpactWood.ogg", category="impact", seconds=.8)
    add("impact-wood-b", "bfh", "bfh1_wood_hit_01.ogg", category="impact", seconds=.7)
    add("impact-wood-c", "sfx100", "sfx100v2_wood_hit_01.ogg", category="impact", seconds=.7)
    add("impact-metal-a", "impact-qa", "qubodupImpactMetal.ogg", category="impact", seconds=.8)
    add("impact-metal-b", "bfh", "bfh1_metal_hit_01.ogg", category="impact", seconds=.7)
    add("impact-metal-c", "sfx100", "sfx100v2_metal_hit_01.ogg", category="impact", seconds=.7)
    add("impact-dirt-a", "mud", "mud_01.ogg", category="impact", seconds=.6)
    add("impact-dirt-b", "mud", "mud_02.ogg", category="impact", seconds=.6)
    add("impact-glass-a", "bfh", "bfh1_glass_hit_01.ogg", category="impact", seconds=.7)
    add("impact-glass-b", "sfx100", "sfx100v2_glass_01.ogg", category="impact", seconds=.7)
    add("impact-water-a", "water", "splash_01.ogg", category="impact", seconds=.8)
    add("impact-water-b", "water", "splash_02.ogg", category="impact", seconds=.8)
    add("impact-flesh-a", "freesound", "flesh-impacts-jawbutch.mp3", category="body",
        onsets=3, seconds=.6, lib="freesound", url="https://freesound.org/people/jawbutch/sounds/344409/",
        author="jawbutch", title="Three Flesh Impacts.wav")
    add("impact-flesh-d", "impact-qa", "qubodupImpactMeat01.ogg", category="body", seconds=.6)
    add("destruction-a", "bfh", "bfh1_wood_breaking_01.ogg", category="impact", seconds=1.2)
    add("destruction-b", "bfh", "bfh1_rock_breaking_01.ogg", category="impact", seconds=1.2)
    add("shell-casing", "kenney-impact", "impactTin_medium_001.ogg", category="impact", seconds=.4)
    add("body-fall", "bfh", "bfh1_falling_01.ogg", category="body", seconds=1.1)

    # -- Explosions / rockets -------------------------------------------------
    add("explosion-a", "kenney-scifi", "explosionCrunch_000.ogg", category="explosion", seconds=2.2)
    add("explosion-b", "kenney-scifi", "explosionCrunch_002.ogg", category="explosion", seconds=2.2)
    add("explosion-c", "kenney-scifi", "lowFrequency_explosion_000.ogg", category="explosion", seconds=2.2)
    freesound("distant-explosion", "distant-explosion-kostrava.mp3", category="distant",
              group="core", onsets=1, seconds=3.2, title="distant explosion", author="Kostrava",
              url="https://freesound.org/people/Kostrava/sounds/324277/")
    add("rocket-launch", "kenney-scifi", "thrusterFire_000.ogg", category="explosion", seconds=.9)

    # -- Footsteps, jump and landing -----------------------------------------
    add("step-concrete-a", "steps", "stone01.ogg", category="footstep", seconds=.55)
    add("step-concrete-b", "sfx100", "sfx100v2_footstep_01.ogg", category="footstep", seconds=.55)
    add("step-concrete-c", "sfx100", "sfx100v2_footstep_02.ogg", category="footstep", seconds=.55)
    for suffix, item in [("a", "wood01.ogg"), ("b", "wood02.ogg"), ("c", "wood03.ogg")]:
        add(f"step-wood-{suffix}", "steps", item, category="footstep", seconds=.55)
    add("step-grass-a", "steps", "leaves01.ogg", category="footstep", seconds=.55)
    add("step-grass-b", "steps", "leaves02.ogg", category="footstep", seconds=.55)
    add("step-grass-c", "steps", "leaves01.ogg", category="footstep", seconds=.55, onset_index=1)
    add("step-dirt-a", "steps", "mud02.ogg", category="footstep", seconds=.55)
    add("step-dirt-b", "mud", "mud_03.ogg", category="footstep", seconds=.55)
    add("step-dirt-c", "mud", "mud_04.ogg", category="footstep", seconds=.55)
    add("step-metal-a", "metalsteps", "metal_steps_01.wav", category="footstep", seconds=.6)
    add("step-metal-b", "metalsteps", "metal_steps_02.wav", category="footstep", seconds=.6)
    add("step-water-a", "water", "splash_03.ogg", category="footstep", seconds=.6)
    add("step-water-b", "water", "splash_04.ogg", category="footstep", seconds=.6)
    add("jump-a", "sfx100", "sfx100v2_air_01.ogg", category="jump", seconds=.55)
    add("jump-b", "sfx100", "sfx100v2_air_02.ogg", category="jump", seconds=.55)
    add("land-a", "loose", "land", category="jump", seconds=.55)
    add("land-b", "loose", "jump", category="jump", seconds=.7)
    add("land-c", "loose", "jump2", category="jump", seconds=.7)

    # -- Whiz-bys -------------------------------------------------------------
    freesound("whiz-a", "bullet-flyby-qubodup.mp3", category="whiz", group="core",
              onsets=1, seconds=.35, title="Real Bullet Flyby Sound", author="qubodup",
              url="https://freesound.org/people/qubodup/sounds/855248/")
    freesound("whiz-b", "whiz-subsonic-modusmogulus.mp3", category="whiz", group="core",
              onsets=1, seconds=.7, title="Fly-by whiz SFX (subsonic)", author="modusmogulus",
              url="https://freesound.org/people/modusmogulus/sounds/789222/")

    # -- Vehicle --------------------------------------------------------------
    add("engine-idle-a", "car", "Car_Engine_Loop.ogg", category="vehicle-loop", group="vehicle",
        loop=2.5, loop_offset=.2, crossfade=.18)
    add("engine-idle-b", "car", "Car_Engine_Loop_2.ogg", category="vehicle-loop", group="vehicle",
        loop=3.0, loop_offset=.2, crossfade=.18)
    freesound("engine-idle-c", "car-idle-loop-andrew-alexander.mp3", category="vehicle-loop",
              group="vehicle", loop=2.5, loop_offset=1.0, crossfade=.2,
              title="car_idle_loop.wav", author="AndrewAlexander",
              url="https://freesound.org/people/AndrewAlexander/sounds/369053/")
    add("engine-drive-a", "car", "Car_Acceleration.ogg", category="vehicle-loop", group="vehicle",
        loop=2.4, loop_offset=.15, crossfade=.18)
    add("engine-drive-b", "car", "Car_Acceleration_2.ogg", category="vehicle-loop", group="vehicle",
        loop=2.4, loop_offset=.15, crossfade=.18)
    add("engine-start", "car", "Car_Engine_Start_Up.ogg", category="vehicle-one", group="vehicle",
        seconds=2.0)
    add("engine-stop", "car", "Car_Engine_Turning_Off.ogg", category="vehicle-one", group="vehicle",
        seconds=2.0)
    freesound("tire-skid-a", "tire-squeal-1-audible-edge.mp3", category="vehicle-loop",
              group="vehicle", loop=1.6, loop_offset=1.5, crossfade=.2,
              title="Chrysler LHS tire squeal 02 (04-25-2009).wav", author="audible-edge",
              url="https://freesound.org/people/audible-edge/sounds/71737/")
    freesound("tire-skid-b", "tire-squeal-2-audible-edge.mp3", category="vehicle-loop",
              group="vehicle", loop=1.6, loop_offset=1.2, crossfade=.2,
              title="Chrysler LHS tire squeal 03 (04-25-2009).wav", author="audible-edge",
              url="https://freesound.org/people/audible-edge/sounds/71738/")
    add("brake", "car", "Car_Parking_Brake.ogg", category="vehicle-one", group="vehicle", seconds=.6)
    add("door-open", "car", "Car_Door_Open.ogg", category="vehicle-one", group="vehicle", seconds=.6)
    add("door-close", "car", "Car_Door_Close.ogg", category="vehicle-one", group="vehicle", seconds=.8)
    add("vehicle-impact-a", "bfh", "bfh1_metal_hit_02.ogg", category="vehicle-one",
        group="vehicle", seconds=.8)
    add("vehicle-impact-b", "kenney-impact", "impactMetal_heavy_001.ogg", category="vehicle-one",
        group="vehicle", seconds=.8)
    add("vehicle-destroy", "kenney-scifi", "explosionCrunch_003.ogg", category="explosion",
        group="vehicle", seconds=2.2)

    # -- Ambience -------------------------------------------------------------
    add("amb-wind", "loose", "park-wind", category="ambience", group="ambience",
        loop=8.0, loop_offset=4.0, crossfade=.6,
        title="park_ambience_wind.wav")
    add("amb-birds", "loose", "park-birds", category="ambience", group="ambience",
        loop=8.0, loop_offset=6.0, crossfade=.6,
        title="park_ambience_birds.wav")
    freesound("amb-battle", "distant-battle-jim-bretherick.mp3", category="ambience",
              group="ambience", loop=10.0, loop_offset=20.0, crossfade=.8,
              title="(Distant)rumbling battle1", author="Jim-Bretherick",
              url="https://freesound.org/people/Jim-Bretherick/sounds/823852/")

    # -- UI / feedback / warning ---------------------------------------------
    add("ui-select", "kenney-ui", "select_002.ogg", category="ui", seconds=.5)
    add("ui-confirm", "kenney-ui", "confirmation_002.ogg", category="ui", seconds=.7)
    add("ui-error", "kenney-ui", "error_004.ogg", category="ui", seconds=.7)
    add("ui-open", "kenney-ui", "open_002.ogg", category="ui", seconds=.7)
    add("ui-click", "kenney-ui", "click_004.ogg", category="ui", seconds=.35)
    add("pickup", "sfx100", "sfx100v2_items_01.ogg", category="ui", seconds=.6)
    add("heal", "kenney-ui", "confirmation_004.ogg", category="ui", seconds=.8)
    add("hitmarker", "kenney-ui", "click_001.ogg", category="ui", seconds=.35)
    add("kill-confirm", "kenney-ui", "confirmation_003.ogg", category="ui", seconds=.8)
    add("damage", "freesound", "flesh-impacts-jawbutch.mp3", category="body", onsets=1,
        seconds=.7, lib="freesound", url="https://freesound.org/people/jawbutch/sounds/344409/",
        author="jawbutch", title="Three Flesh Impacts.wav")
    add("zone-alarm", "loose", "alarm", category="alarm", group="core",
        loop=1.5, loop_offset=0.0, crossfade=.12, title="alarm_0.ogg")

    # LICENSE files for the Kenney archives that are actually shipped.
    licenses = {
        "kenney-impact-sounds.zip": "LICENSE-Kenney-impact-sounds.txt",
        "kenney-sci-fi-sounds.zip": "LICENSE-Kenney-sci-fi-sounds.txt",
        "kenney-interface-sounds.zip": "LICENSE-Kenney-interface-sounds.txt",
    }
    for archive, dest in licenses.items():
        with ZipFile(SOURCE / archive) as z:
            (OUTPUT / dest).write_bytes(z.read("License.txt"))

    # Remove stale clips that are no longer part of the inventory.
    keep = {row["file"] for row in LEDGER} | {"manifest.json", "NOTICE.md"} | set(licenses.values())
    for path in OUTPUT.iterdir():
        if path.suffix == ".ogg" and path.name not in keep:
            path.unlink()
    for path in list(OUTPUT.glob("LICENSE-Kenney-*.txt")):
        if path.name not in licenses.values():
            path.unlink()

    manifest = {
        "sampleRate": SR, "channels": 1, "encoding": "Ogg Vorbis q5",
        "normalisation": "per-category RMS loudness, peak ceiling "
                         f"{PEAK_CEILING:.2f}",
        "groups": GROUPS,
        "libraries": {key: {k: v for k, v in value.items() if k != "date"}
                      for key, value in sorted(LIBS.items())},
        "totalBytes": sum(row["bytes"] for row in LEDGER),
        "clips": LEDGER,
    }
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Built {len(LEDGER)} clips / {manifest['totalBytes']} bytes")
    for group, names in GROUPS.items():
        print(f"  {group}: {len(names)}")
    for prefix in ("pistol", "ar", "smg", "shotgun", "sniper", "dmr", "lmg", "distant",
                   "step-concrete", "step-wood", "step-grass", "step-metal", "step-water",
                   "impact-concrete", "impact-flesh", "explosion", "engine"):
        n = sum(1 for row in LEDGER if row["name"].startswith(prefix + "-"))
        print(f"  {prefix}: {n}")


if __name__ == "__main__":
    main()
