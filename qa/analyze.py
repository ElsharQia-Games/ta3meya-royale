#!/usr/bin/env python3
"""Programmatic screenshot inspection (no vision model required).

Prints a coarse luminance/colour map plus region statistics so gross visual
defects (black frames, missing HUD, blown-out sky, flat fog) are detectable in
text form.
"""
import sys
from PIL import Image

RAMP = " .:-=+*#%@"

def ascii_map(img, w=100, h=34):
    g = img.convert("L").resize((w, h))
    px = list(g.getdata())
    out = []
    for y in range(h):
        row = px[y * w:(y + 1) * w]
        out.append("".join(RAMP[min(len(RAMP) - 1, v * len(RAMP) // 256)] for v in row))
    return "\n".join(out)

def stats(img, label, box=None):
    im = img.crop(box) if box else img
    small = im.convert("RGB").resize((64, 36))
    px = list(small.getdata())
    n = len(px)
    mean = tuple(round(sum(p[i] for p in px) / n) for i in range(3))
    uniq = len(set(px))
    dark = sum(1 for p in px if sum(p) < 30) / n
    bright = sum(1 for p in px if sum(p) > 690) / n
    # dominant colour buckets (32-step)
    buckets = {}
    for p in px:
        k = (p[0] // 32, p[1] // 32, p[2] // 32)
        buckets[k] = buckets.get(k, 0) + 1
    top = sorted(buckets.items(), key=lambda kv: -kv[1])[:4]
    top = [((tuple(c * 32 + 16 for c in k)), round(v / n, 3)) for k, v in top]
    print(f"{label:<10} mean={mean} uniq={uniq} dark={dark:.2f} blown={bright:.2f} top={top}")

def main(path):
    img = Image.open(path)
    W, H = img.size
    print(f"== {path} {W}x{H}")
    stats(img, "full")
    stats(img, "top", (0, 0, W, H // 4))
    stats(img, "center", (W // 4, H // 4, 3 * W // 4, 3 * H // 4))
    stats(img, "bottom", (0, 3 * H // 4, W, H))
    print(ascii_map(img))

for p in sys.argv[1:]:
    main(p)
