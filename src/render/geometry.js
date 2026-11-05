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
    mesh.userData.primaryShadowCaster = parts.some(p => p.userData?.primaryShadowCaster);
    parts.forEach(p => { p.removeFromParent(); p.geometry.dispose(); });
    group.add(mesh);
  }
}

// World-space geometry is merged by spatial cell AND material so an invisible
// town doesn't keep the entire island in every camera/shadow draw.
export function mergeSpatialGeometry(geometries, material, name, cell = 160) {
  const bins = new Map();
  for (const geometry of geometries) {
    geometry.computeBoundingBox();
    const centre = geometry.boundingBox.getCenter(new THREE.Vector3());
    const key = `${Math.floor(centre.x / cell)},${Math.floor(centre.z / cell)}`;
    const list = bins.get(key) || []; list.push(geometry); bins.set(key, list);
  }
  const meshes = [];
  for (const [key, list] of bins) {
    const merged = mergeGeometries(list, false); list.forEach(g => g.dispose());
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material); mesh.name = `${name}_${key}`;
    mesh.receiveShadow = true; meshes.push(mesh);
  }
  return meshes;
}

export function splitInstances(source, cell = 160) {
  const bins = new Map(), matrix = new THREE.Matrix4(), position = new THREE.Vector3(), color = new THREE.Color();
  for (let i = 0; i < source.count; i++) {
    source.getMatrixAt(i, matrix); position.setFromMatrixPosition(matrix);
    const key = `${Math.floor(position.x / cell)},${Math.floor(position.z / cell)}`;
    const indices = bins.get(key) || []; indices.push(i); bins.set(key, indices);
  }
  const root = new THREE.Group(); root.name = `${source.name}_cells`;
  for (const [key, indices] of bins) {
    const mesh = new THREE.InstancedMesh(source.geometry, source.material, indices.length);
    mesh.name = `${source.name}_${key}`; mesh.castShadow = source.castShadow; mesh.receiveShadow = source.receiveShadow;
    indices.forEach((index, i) => {
      source.getMatrixAt(index, matrix); mesh.setMatrixAt(i, matrix);
      if (source.instanceColor) { source.getColorAt(index, color); mesh.setColorAt(i, color); }
    });
    mesh.computeBoundingSphere(); root.add(mesh);
  }
  source.dispose();
  return root;
}

export function splitGridGeometry(source, size, divisions = 32) {
  const result = [];
  for (let z = 0; z < size - 1; z += divisions) for (let x = 0; x < size - 1; x += divisions) {
    const nx = Math.min(divisions, size - 1 - x), nz = Math.min(divisions, size - 1 - z);
    const geometry = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(source.attributes)) {
      const data = new Float32Array((nx + 1) * (nz + 1) * attribute.itemSize);
      for (let row = 0; row <= nz; row++) for (let col = 0; col <= nx; col++) {
        const from = ((z + row) * size + x + col) * attribute.itemSize;
        data.set(attribute.array.subarray(from, from + attribute.itemSize), (row * (nx + 1) + col) * attribute.itemSize);
      }
      geometry.setAttribute(name, new THREE.BufferAttribute(data, attribute.itemSize));
    }
    const indices = [];
    for (let row = 0; row < nz; row++) for (let col = 0; col < nx; col++) {
      const a = row * (nx + 1) + col, b = a + nx + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
    geometry.setIndex(indices); geometry.computeBoundingSphere(); result.push(geometry);
  }
  source.dispose();
  return result;
}
