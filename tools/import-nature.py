"""Derive the shipped CC0 nature subset from the free Standard archive.

Optional asset-build tool: Python 3.11+ and Pillow. Runtime/building the game
does not require Python. No downloads, purchases or files outside the project.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
from io import BytesIO
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

from PIL import Image

MODELS = ("Pine_1", "Pine_3", "CommonTree_1", "CommonTree_3", "Bush_Common", "Fern_1", "Rock_Medium_1")
SOURCE = "https://quaternius.itch.io/stylized-nature-megakit"
LEAF_PALETTE = {
    "Leaf_Pine_C.png": (99, 120, 78),
    "Leaves_NormalTree_C.png": (120, 137, 93),
    "Leaves_TwistedTree_C.png": (107, 125, 81),
}


def local_name(uri: str) -> str:
    path = PurePosixPath(uri)
    if path.is_absolute() or ".." in path.parts or len(path.parts) != 1:
        raise ValueError(f"Expected one local asset filename, got {uri!r}")
    return path.name


def texture_references(material: dict):
    for key in ("normalTexture", "occlusionTexture", "emissiveTexture"):
        if key in material:
            yield material[key]
    pbr = material.get("pbrMetallicRoughness", {})
    for key in ("baseColorTexture", "metallicRoughnessTexture"):
        if key in pbr:
            yield pbr[key]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--out", type=Path, default=Path("public/models/nature"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    with args.archive.open("rb") as handle:
        archive_hash = hashlib.file_digest(handle, "sha256").hexdigest()
    manifest = {"source": SOURCE, "edition": "free Standard", "license": "CC0-1.0",
                "archiveSha256": archive_hash, "textureSize": 512, "webpQuality": 90,
                "leafPalette": LEAF_PALETTE, "assets": []}
    copied_images: set[str] = set()
    with ZipFile(args.archive) as archive:
        notice = archive.read("License_Standard.txt")
        (args.out / "LICENSE.txt").write_bytes(notice)
        for name in MODELS:
            original = archive.read(f"glTF/{name}.gltf")
            model = json.loads(original)
            leaves_only = name.startswith(("Pine_", "CommonTree_"))
            if leaves_only:
                for mesh in model["meshes"]:
                    mesh["primitives"] = [p for p in mesh["primitives"]
                                          if model["materials"][p["material"]]["name"].startswith("Leaves")]
            used_materials = sorted({p["material"] for m in model["meshes"] for p in m["primitives"]})
            material_map = {old: new for new, old in enumerate(used_materials)}
            model["materials"] = [model["materials"][i] for i in used_materials]
            for mesh in model["meshes"]:
                for primitive in mesh["primitives"]:
                    primitive["material"] = material_map[primitive["material"]]
            used_textures = sorted({r["index"] for m in model["materials"] for r in texture_references(m)})
            texture_map = {old: new for new, old in enumerate(used_textures)}
            model["textures"] = [model["textures"][i] for i in used_textures]
            for material in model["materials"]:
                for reference in texture_references(material):
                    reference["index"] = texture_map[reference["index"]]
            used_images = sorted({t["source"] for t in model["textures"]})
            image_map = {old: new for new, old in enumerate(used_images)}
            model["images"] = [model["images"][i] for i in used_images]
            for texture in model["textures"]:
                source = texture.pop("source")
                texture["extensions"] = {"EXT_texture_webp": {"source": image_map[source]}}
            model["extensionsUsed"] = ["EXT_texture_webp"]
            model["extensionsRequired"] = ["EXT_texture_webp"]
            for image in model["images"]:
                source = local_name(image["uri"])
                dest = str(Path(source).with_suffix(".webp"))
                if source not in copied_images:
                    with Image.open(BytesIO(archive.read(f"glTF/{source}"))) as pixels:
                        pixels.thumbnail((512, 512), Image.Resampling.LANCZOS)
                        if source in LEAF_PALETTE:
                            # Preserve the licensed silhouettes/alpha, replacing
                            # flat red/green source fills with restrained coastal
                            # tones and subtle variation visible in close leaves.
                            pixels = pixels.convert("RGBA")
                            rng = random.Random(431)
                            base = LEAF_PALETTE[source]
                            values = []
                            for i, (_, _, _, alpha) in enumerate(pixels.getdata()):
                                shade = .92 + .15 * (1 - (i // pixels.width) / pixels.height)
                                noise = rng.uniform(-3, 3)
                                values.append(tuple(round(channel * shade + noise) for channel in base) + (alpha,))
                            pixels.putdata(values)
                        pixels.save(args.out / dest, "WEBP", quality=90, method=6, exact=True)
                    copied_images.add(source)
                image["uri"] = dest
                image["mimeType"] = "image/webp"
            # Preserve the original vertex buffers exactly; the renderer bakes
            # transforms and normalises only its in-memory template geometry.
            for buffer in model["buffers"]:
                uri = local_name(buffer["uri"])
                (args.out / uri).write_bytes(archive.read(f"glTF/{uri}"))
            dest = args.out / f"{name}.gltf"
            dest.write_text(json.dumps(model, separators=(",", ":")) + "\n")
            triangles = sum(model["accessors"][p["indices"]]["count"] // 3
                            for m in model["meshes"] for p in m["primitives"])
            manifest["assets"].append({"file": dest.name, "sourceSha256": hashlib.sha256(original).hexdigest(),
                                       "leavesOnly": leaves_only, "triangles": triangles})
    manifest["shippedBytes"] = sum(p.stat().st_size for p in args.out.iterdir()
                                   if p.is_file() and p.name not in {"manifest.json", "NOTICE.md"})
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
