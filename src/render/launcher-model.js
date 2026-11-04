// Original R7 shoulder launcher. Same weapon anchor/ownership contract:
// -Z forward, physical muzzle, optical centre, two grips and a moving round.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { texture, stencil } from './textures.js';
import { batchStaticParts } from './geometry.js';

export function createRocketGeometry(detailed = true) {
  const root = new THREE.Group(); root.name = 'rocket_round';
  const olive = new THREE.MeshStandardMaterial({ color: 0x717458, map: texture('equipment'), metalness: .28, roughness: .62 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x343d35, metalness: .42, roughness: .54 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xbb9453, metalness: .65, roughness: .45 });
  const cyl = (top, bottom, length, z, mat) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, length, detailed ? 24 : 10), mat);
    mesh.rotation.x = -Math.PI / 2; mesh.position.z = z; root.add(mesh); return mesh;
  };
  cyl(.048, .026, .19, -.035, olive);
  cyl(.003, .048, .11, -.185, dark);
  cyl(.026, .026, .21, .165, dark);
  cyl(.05, .05, .022, -.112, brass);
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(.042, .003, .09), dark);
    const angle = i * Math.PI / 2;
    fin.position.set(Math.cos(angle) * .026, Math.sin(angle) * .026, .21); fin.rotation.z = angle; root.add(fin);
  }
  batchStaticParts(root);
  return { root, materials: [olive, dark, brass] };
}

export function createLauncherModel(detailed) {
  const root = new THREE.Group(); root.name = 'r7_lancer';
  const mats = {
    tube: new THREE.MeshStandardMaterial({ color: 0x667458, map: texture('equipment'), metalness: .35, roughness: .59 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x414c48, metalness: .72, roughness: .44 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x222e29, roughness: .91 }),
    mark: new THREE.MeshStandardMaterial({ map: stencil('R7 / LANCER', 'SINGLE ROUND — 70 MM'), transparent: true, alphaTest: .08, roughness: .8 }),
  };
  const box = (size, pos, mat = 'steel', parent = root) => {
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(...size, 1, .004), mats[mat]); mesh.position.set(...pos); parent.add(mesh); return mesh;
  };
  const cyl = (radius, length, z, mat = 'tube', taper = radius) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, taper, length, detailed ? 28 : 12, 1, true), mats[mat]);
    mesh.rotation.x = Math.PI / 2; mesh.position.z = z; root.add(mesh); return mesh;
  };
  cyl(.042, .83, -.04);
  cyl(.065, .16, .37, 'steel', .045);
  for (const z of [-.43, -.16, .14, .42]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(z === .42 ? .064 : .046, .005, 6, detailed ? 28 : 12), mats.steel);
    ring.position.z = z; root.add(ring);
  }
  box([.115, .083, .24], [.01, -.06, .18], 'rubber');
  box([.043, .13, .073], [0, -.11, .047], 'rubber').rotation.x = -.14;
  box([.035, .105, .047], [0, -.085, -.25], 'rubber');
  box([.012, .073, .078], [.024, -.065, .006], 'steel');
  box([.015, .105, .1], [-.057, .066, -.04]);
  const sight = new THREE.Object3D(); sight.name = 'optical_center'; sight.position.set(-.063, .142, -.043); root.add(sight);
  const housing = new THREE.Mesh(new THREE.TorusGeometry(.029, .004, 6, 24), mats.steel);
  housing.position.copy(sight.position); root.add(housing);
  box([.073, .007, .065], [-.063, .111, -.043]);
  const reticle = new THREE.Group(); reticle.name = 'reticle'; reticle.position.set(-.063, .142, -.065); root.add(reticle);
  const red = new THREE.MeshBasicMaterial({ color: 0xecb36b, depthTest: false, depthWrite: false, toneMapped: false });
  const dot = new THREE.Mesh(new THREE.CircleGeometry(.0011, 12), red); reticle.add(dot);
  for (let i = 1; i <= 3; i++) {
    const rung = new THREE.Mesh(new THREE.PlaneGeometry(.008 + i * .004, .00065), red);
    rung.position.y = -i * .005; reticle.add(rung);
  }
  if (detailed) {
    const mark = new THREE.Mesh(new THREE.PlaneGeometry(.27, .102), mats.mark);
    mark.rotation.y = Math.PI / 2; mark.position.set(.043, .006, -.07); root.add(mark);
    for (let i = 0; i < 6; i++) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(.0435, .0017, 5, 24), mats.rubber);
      rib.position.z = -.09 + i * .027; root.add(rib);
    }
  }
  const round = createRocketGeometry(detailed);
  const magazine = round.root; magazine.position.set(0, 0, -.51); root.add(magazine);
  const anchor = (name, x, y, z) => { const o = new THREE.Object3D(); o.name = name; o.position.set(x, y, z); root.add(o); return o; };
  const muzzle = anchor('muzzle', 0, 0, -.75);
  const rightGrip = anchor('right_grip', 0, -.095, .04);
  const leftGrip = anchor('left_grip', -.012, -.063, -.25);
  const backblast = anchor('backblast', 0, 0, .46);
  batchStaticParts(root);
  return { key: 'rpg', root, magazine, magRest: magazine.position.clone(), muzzle, backblast,
    sight, rightGrip, leftGrip, gripRest: leftGrip.position.clone(), reticle, slide: null,
    profile: { optic: 'launcher', sightY: .142 },
    dispose() {
      const geometries = new Set(); root.traverse(o => { if (o.geometry) geometries.add(o.geometry); });
      geometries.forEach(g => g.dispose());
      for (const material of [...Object.values(mats), ...round.materials, red]) material.dispose();
      root.removeFromParent();
    } };
}
