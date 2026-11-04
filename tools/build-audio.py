"""Build a small local game-audio bank from the verified CC0 source archives.

Requires Python 3.11+, numpy and ffmpeg. Sources remain under ignored
qa/downloads/audio-research; only selected mastered Ogg clips are shipped.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from zipfile import ZipFile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "qa/downloads/audio-research"
OUTPUT = ROOT / "public/audio"
FIREARMS = SOURCE / "firearms/Prepared SFX Library"
SHOTS = {
    "pistol": ("1911/A_42P.wav", .8),
    "ar": ("AR-15/D_32P.wav", .85),
    "smg": ("Carl Gustav M45/G_31P.wav", .6),
    "shotgun": ("Model 12/K_22P.wav", 1.15),
    "sniper": ("Savage 10 .300 Blackout/T_27P.wav", 1.65),
    "dmr": ("SKS/U_14P.wav", 1.0),
    "lmg": ("AK-47/C_28P.wav", .85),
    "rifle-distant": ("AR-15/D_24P.wav", 1.5),
}


def decode(source: Path | bytes) -> np.ndarray:
    data = source if isinstance(source, bytes) else None
    result = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0" if data else str(source),
                             "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
                            input=data, stdout=subprocess.PIPE, check=True)
    return np.frombuffer(result.stdout, dtype="<f4").copy()


def write_clip(name: str, pcm: np.ndarray, metadata: dict, ledger: list) -> None:
    if not len(pcm) or not np.isfinite(pcm).all():
        raise ValueError(f"Invalid PCM for {name}")
    pcm -= np.mean(pcm)
    peak = float(np.max(np.abs(pcm)))
    if peak < .001:
        raise ValueError(f"Silent sample for {name}")
    pcm *= .67 / peak  # -3.48 dBFS source peak, before runtime mixing
    fade = min(len(pcm) // 8, 2400)
    pcm[:48] *= np.linspace(0, 1, min(48, len(pcm)))
    pcm[-fade:] *= np.linspace(1, 0, fade)
    target = OUTPUT / f"{name}.ogg"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", "48000", "-ac", "1", "-i", "-",
                    "-c:a", "libvorbis", "-q:a", "5", "-map_metadata", "-1", str(target)],
                   input=pcm.astype("<f4").tobytes(), check=True)
    ledger.append({"file": target.name, "seconds": round(len(pcm) / 48000, 4), "bytes": target.stat().st_size,
                   "sha256": hashlib.sha256(target.read_bytes()).hexdigest(), **metadata})


def main() -> None:
    OUTPUT.mkdir(exist_ok=True)
    ledger = []
    for name, (source, duration) in SHOTS.items():
        path = FIREARMS / source
        pcm = decode(path)
        loud = np.flatnonzero(np.abs(pcm) > np.max(np.abs(pcm)) * .35)
        # Separate recorded shots by at least 0.35s of non-transient audio.
        onsets = loud[np.r_[True, np.diff(loud) > .35 * 48000]]
        for variant, onset in enumerate(onsets[:2]):
            start = max(0, int(onset) - 240)
            end = min(len(pcm), start + round(duration * 48000))
            write_clip(f"{name}-{variant + 1}", pcm[start:end].copy(),
                       {"source": source, "sourceLibrary": "Free Firearm Sound Library", "license": "CC0-1.0",
                        "sourceSha256": hashlib.sha256(path.read_bytes()).hexdigest(), "startSeconds": round(start / 48000, 6)}, ledger)
    selections = {
        "impact-sounds": {
            "step-grass-1": "footstep_grass_000", "step-grass-2": "footstep_grass_002",
            "step-concrete-1": "footstep_concrete_000", "step-concrete-2": "footstep_concrete_002",
            "step-wood-1": "footstep_wood_000", "step-wood-2": "footstep_wood_002",
            "mag-out": "impactMetal_light_001", "mag-in": "impactPlate_light_002",
            "bolt": "impactMetal_medium_002", "body-fall": "impactSoft_heavy_001",
            "impact-wood": "impactWood_medium_002", "impact-metal": "impactMetal_light_000",
            "impact-glass": "impactGlass_medium_000", "shell": "impactTin_medium_002",
        },
        "sci-fi-sounds": {"blast-1": "explosionCrunch_000", "blast-2": "lowFrequency_explosion_000", "rocket-launch": "thrusterFire_000"},
        "interface-sounds": {"ui-select": "select_002", "ui-deploy": "confirmation_002", "ui-open": "open_002"},
    }
    for pack, files in selections.items():
        archive = SOURCE / f"kenney-{pack}.zip"
        with ZipFile(archive) as source:
            (OUTPUT / f"LICENSE-Kenney-{pack}.txt").write_bytes(source.read("License.txt"))
            for name, item in files.items():
                original = source.read(f"Audio/{item}.ogg")
                pcm = decode(original)
                # Keep every intended transient; long effect tails are bounded.
                pcm = pcm[:round((2.8 if name.startswith('blast') else 1.2) * 48000)]
                write_clip(name, pcm, {"source": f"Audio/{item}.ogg", "sourceLibrary": f"Kenney {pack}",
                                      "sourceSha256": hashlib.sha256(original).hexdigest(), "license": "CC0-1.0"}, ledger)
    manifest = {"sampleRate": 48000, "channels": 1, "encoding": "Ogg Vorbis q5", "sourcePeak": .67,
                "sourceArchives": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                   for p in [SOURCE / "Prepared-SFX-Library.7z", *SOURCE.glob("kenney-*.zip")]},
                "totalBytes": sum(row["bytes"] for row in ledger), "clips": ledger}
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Built {len(ledger)} clips / {manifest['totalBytes']} bytes")


if __name__ == "__main__":
    main()
