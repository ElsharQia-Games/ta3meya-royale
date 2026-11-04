import * as THREE from 'three';

// A shared photographed surface set per world, including all facade variants.
// Material instances carry colour; texture ownership stays with WorldRenderer.
export async function loadCoastalSurfaces(view) {
  const loader = new THREE.TextureLoader();
  const anisotropy = Math.min(8, view.renderer.renderer.capabilities.getMaxAnisotropy());
  await Promise.all(['plaster', 'concrete', 'asphalt', 'brick'].map(async name => {
    const maps = await Promise.all(['albedo', 'normal', 'roughness'].map(async suffix => {
      const map = await loader.loadAsync(`/textures/coastal/${name}-${suffix}.webp`);
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.anisotropy = anisotropy;
      map.colorSpace = suffix === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      return map;
    }));
    if (view.disposed) { maps.forEach(map => map.dispose()); return; }
    view.ownedTextures.push(...maps);
    const targets = name === 'asphalt' ? [view.roadMaterial] : name === 'plaster'
      ? [view.mats.plaster, ...view.facadeMaterials] : [view.mats[name]];
    for (const material of targets) {
      material.map = maps[0]; material.normalMap = maps[1]; material.roughnessMap = maps[2];
      material.normalScale.set(name === 'brick' ? .65 : .4, name === 'brick' ? .65 : .4);
      material.needsUpdate = true;
    }
    if (name === 'asphalt') view.roadMaterial.color.setHex(0xbbc0b5);
    if (name === 'concrete') view.mats.concrete.color.setHex(0xb8b9ac);
    if (name === 'brick') view.mats.brick.color.setHex(0xc4c4ac);
  }));
}
