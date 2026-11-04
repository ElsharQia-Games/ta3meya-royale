// Original scenery and surface detail. Large port structures sit beyond the
// playable boundary; playable-room detail hugs existing wall/floor surfaces.
import * as THREE from 'three';
import { mergeSpatialGeometry } from './geometry.js';

export function addCoastalDetails(view) {
  const bins = new Map();
  const add = (key, geometry) => { const list = bins.get(key) || []; list.push(geometry); bins.set(key, list); };
  const box = (key, x, y, z, w, h, d, angle = 0) => {
    const geo = new THREE.BoxGeometry(w, h, d); geo.rotateZ(angle); geo.translate(x, y, z); add(key, geo);
  };
  const beam = (key, from, to, width) => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to), direction = b.clone().sub(a);
    const geo = new THREE.CylinderGeometry(width, width, direction.length(), 6);
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
    geo.translate(...a.add(b).multiplyScalar(.5).toArray()); add(key, geo);
  };
  for (const b of view.world.boxes) {
    if (b.tag !== 'glass') continue;
    const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    const w = b.max[0] - b.min[0], d = b.max[2] - b.min[2], h = b.max[1] - b.min[1];
    if (w > d) {
      for (const sign of [-1, 1]) box('trim', cx + sign * w / 2, cy, cz, .035, h + .06, .13);
      for (const sign of [-1, 1]) box('trim', cx, cy + sign * h / 2, cz, w + .08, .035, .13);
      box('trim', cx, cy, cz, .024, h, .08);
    } else {
      for (const sign of [-1, 1]) box('trim', cx, cy, cz + sign * d / 2, .13, h + .06, .035);
      for (const sign of [-1, 1]) box('trim', cx, cy + sign * h / 2, cz, .13, .035, d + .08);
      box('trim', cx, cy, cz, .08, h, .024);
    }
  }
  // Roof-mounted service panels and dark seams remain inside existing roof
  // slabs/parapets, so they never pretend to be additional standing cover.
  for (const [index, b] of view.world.buildings.entries()) {
    const top = b.y0 + b.floors * b.floorH;
    box('roof', b.x, top + .006, b.z, Math.min(3, b.w * .3), .014, Math.min(2.4, b.d * .24));
    for (const side of [-1, 1]) {
      const z = b.z + side * (b.d / 2 + .137);
      box('accent', b.x - b.w * .28, b.y0 + 2.6, z, .19, .12, .012);
      if (index % 3 === 0) box('trim', b.x - b.w * .36, b.y0 + 1.2, z, .19, .28, .018);
    }
  }
  // Shipping gantries beyond the northern perimeter establish the coast/port
  // silhouette without changing an accessible combat collision contract.
  for (const [x, z, yaw] of [[-115, -555, 0], [120, -605, .2], [275, -620, -.13]]) {
    const y = view.world.terrainHeight(x, -492) - 8, h = 38;
    for (const side of [-1, 1]) {
      beam('crane', [x + side * 7, y, z], [x + side * 4, y + h, z], .65);
      beam('steel', [x + side * 7, y, z + 7], [x + side * 4, y + h, z], .38);
      beam('steel', [x + side * 6, y + 5, z], [x - side * 4, y + 25, z], .15);
    }
    box('crane', x + 13, y + h, z, 51, 1.45, 2.1, yaw);
    beam('steel', [x - 8, y + h, z], [x + 26, y + h + 7, z], .12);
    beam('steel', [x + 5, y + h + 2, z], [x + 5, y + h + 8, z], .2);
    beam('steel', [x + 28, y + h, z], [x + 28, y + 12, z], .08);
    box('crane', x - 3, y + h - 2, z, 3.1, 2.8, 3.1);
    box('glass', x - 1.42, y + h - 1.8, z, .06, 1.4, 2.2);
  }
  const palette = { trim: 0x404e49, roof: 0x536255, accent: 0xc99753, crane: 0x99754a, steel: 0x526564, glass: 0x97aba2 };
  for (const [key, geometries] of bins) {
    const material = view.renderer.registerMaterial(new THREE.MeshStandardMaterial({ color: palette[key], roughness: key === 'glass' ? .3 : .85, metalness: .22 }));
    const meshes = mergeSpatialGeometry(geometries, material, `coastal_${key}`, 120);
    view.scene.add(...meshes);
  }
}
