"""Import selected Poly Haven CC0 surfaces for the coastal art pass.

Run from the project root with Python and Pillow. Sources and API responses are
retained under ignored qa/downloads; shipped maps are local 1K WebP files.
"""
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

from PIL import Image, ImageEnhance

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'qa/downloads/coastal-surfaces'
OUTPUT = ROOT / 'public/textures/coastal'
ASSETS = {'plaster': 'blue_plaster_weathered', 'concrete': 'concrete_layers', 'asphalt': 'asphalt_02', 'brick': 'brick_wall_001'}
MAPS = {'albedo': 'Diffuse', 'normal': 'nor_gl', 'roughness': 'Rough'}


def download(url):
    return urlopen(Request(url, headers={'User-Agent': 'Blackshore asset import / local game development'}), timeout=60).read()


def main():
    SOURCE.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    manifest = {'license': 'CC0-1.0', 'licenseUrl': 'https://polyhaven.com/license', 'maps': []}
    for name, asset in ASSETS.items():
        metadata = json.loads(download(f'https://api.polyhaven.com/files/{asset}'))
        (SOURCE / f'{asset}.json').write_text(json.dumps(metadata, indent=2))
        for suffix, channel in MAPS.items():
            record = metadata[channel]['1k']['jpg']
            source = SOURCE / f'{name}-{suffix}.jpg'
            original = source.read_bytes() if source.exists() else download(record['url'])
            source.write_bytes(original)
            image = Image.open(source).convert('RGB')
            image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
            transform = '1K RGB WebP; original map channels'
            if name == 'plaster' and suffix == 'albedo':
                image = ImageEnhance.Color(image).enhance(.28)
                transform += '; blue plaster saturation reduced to 28% for salt-grey facade palette'
            file = OUTPUT / f'{name}-{suffix}.webp'
            image.save(file, 'WEBP', quality=88 if suffix == 'albedo' else 92, method=6)
            manifest['maps'].append({'file': file.name, 'asset': asset, 'page': f'https://polyhaven.com/a/{asset}',
                                     'sourceUrl': record['url'], 'sourceSha256': hashlib.sha256(original).hexdigest(),
                                     'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'bytes': file.stat().st_size,
                                     'size': list(image.size), 'transform': transform})
    manifest['totalBytes'] = sum(m['bytes'] for m in manifest['maps'])
    (OUTPUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f"Imported {len(manifest['maps'])} maps / {manifest['totalBytes']} bytes")


if __name__ == '__main__':
    main()
