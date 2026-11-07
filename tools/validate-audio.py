#!/usr/bin/env python3
"""Decode every shipped audio clip and verify delivery constraints.

Checks: 48 kHz mono, finite samples, peak ceiling, non-silence, and loop seam
continuity for clips marked `loop`. Writes qa/reports/audio-bank-validation.json
and exits non-zero on any failure.
"""
from __future__ import annotations

import json
import subprocess
import sys
from array import array
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AUDIO = ROOT / "public" / "audio"
REPORT = ROOT / "qa" / "reports" / "audio-bank-validation.json"
PEAK_CEILING = 0.86
SILENCE = 1e-4


def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate,channels,duration",
         "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout
    stream = json.loads(out)["streams"][0]
    return {
        "sampleRate": int(stream["sample_rate"]),
        "channels": int(stream["channels"]),
        "duration": float(stream.get("duration") or 0),
    }


def decode(path: Path) -> array:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", "48000",
         "-f", "f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    samples = array("f")
    samples.frombytes(raw[: len(raw) - (len(raw) % 4)])
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def rms(samples: array, start: int, end: int) -> float:
    count = max(1, end - start)
    total = 0.0
    for i in range(start, end):
        value = samples[i]
        total += value * value
    return (total / count) ** 0.5


def main() -> int:
    manifest = json.loads((AUDIO / "manifest.json").read_text())
    rows = []
    failures = []
    loops = {}
    max_peak = 0.0
    total_bytes = 0

    for clip in manifest["clips"]:
        path = AUDIO / clip["file"]
        info = probe(path)
        samples = decode(path)
        peaks = [abs(value) for value in samples]
        peak = max(peaks) if peaks else 0.0
        non_finite = sum(1 for value in samples if value != value or value in (float("inf"), float("-inf")))
        duration = len(samples) / 48000
        max_peak = max(max_peak, peak)
        total_bytes += path.stat().st_size

        if info["sampleRate"] != 48000:
            failures.append(f"{clip['name']}: sample rate {info['sampleRate']}")
        if info["channels"] != 1:
            failures.append(f"{clip['name']}: channels {info['channels']}")
        if non_finite:
            failures.append(f"{clip['name']}: {non_finite} non-finite samples")
        if peak > PEAK_CEILING:
            failures.append(f"{clip['name']}: peak {peak:.3f} above {PEAK_CEILING}")
        if peak < SILENCE:
            failures.append(f"{clip['name']}: silent")

        row = {
            "file": clip["file"],
            "name": clip["name"],
            "category": clip["category"],
            "group": clip["group"],
            "duration": round(duration, 4),
            "decodedPeak": round(peak, 5),
            "rms": round(rms(samples, 0, len(samples)), 5),
            "nonFinite": non_finite,
        }

        if clip.get("loop"):
            head = rms(samples, 0, min(len(samples), 480))
            tail = rms(samples, max(0, len(samples) - 480), len(samples))
            seam = abs(samples[0] - samples[-1]) if samples else 0.0
            loops[clip["name"]] = {
                "headRms": round(head, 5),
                "tailRms": round(tail, 5),
                "edgeDelta": round(seam, 5),
            }
            # Edge sample continuity plus comparable energy across the seam.
            if seam > 0.08 or abs(head - tail) > 0.05:
                failures.append(
                    f"{clip['name']}: loop seam head={head:.4f} tail={tail:.4f} delta={seam:.4f}"
                )

        rows.append(row)

    report = {
        "clips": len(rows),
        "bytes": total_bytes,
        "sampleRate": 48000,
        "channels": 1,
        "peakCeiling": PEAK_CEILING,
        "maxDecodedPeak": round(max_peak, 5),
        "allFinite": not any(row["nonFinite"] for row in rows),
        "groups": {group: len(names) for group, names in manifest["groups"].items()},
        "loopSeams": loops,
        "failures": failures,
        "rows": rows,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2) + "\n")

    print(f"{len(rows)} clips / {total_bytes} bytes / max peak {max_peak:.3f}")
    if failures:
        print("FAILURES:")
        for failure in failures:
            print(" -", failure)
        return 1
    print("all clips decode at 48 kHz mono, finite, non-silent and below peak ceiling")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
