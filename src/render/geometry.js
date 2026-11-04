import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Batch rigid siblings, preserving articulated groups as animation boundaries.
// Material and texture ownership stays with the model which calls this helper.
export function batchStaticParts(group) {
  for (const child of [...group.children]) if (child.isGroup) batchStaticParts(child);
  if (group.userData.articulated) return;
  const groups = new Map();
  for (const child of group.children) {
    if (!child.isMesh || child.userData.articulated) continue;
    const parts = groups.get(child.material) || [];
    parts.push(child); groups.set(child.material, parts);
  }
  for (const [material, parts] of groups) {
    if (parts.length < 2) continue;
    const geometries = parts.map(part => {
      part.updateMatrix();
      return (part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone()).applyMatrix4(part.matrix);
    });
    const geometry = mergeGeometries(geometries, false);
    geometries.forEach(g => g.dispose());
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'batched_equipment';
    mesh.castShadow = parts.some(p => p.castShadow);
    mesh.receiveShadow = parts.some(p => p.receiveShadow);
    parts.forEach(p => { p.removeFromParent(); p.geometry.dispose(); });
    group.add(mesh);
  }
}
