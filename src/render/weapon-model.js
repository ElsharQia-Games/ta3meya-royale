// Original procedural equipment. Units are metres; forward is -Z. Geometry,
// animation and muzzle effects share named anchors instead of guessed offsets.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const WEAPON_VISUALS = {
  pistol: { receiver: .19, barrel: .08, stock: 0, optic: 'iron', sightY: .071, tint: 0x7a8170 },
  smg: { receiver: .24, barrel: .16, stock: .15, optic: 'reflex', sightY: .123, tint: 0x77806d },
  ar: { receiver: .28, barrel: .34, stock: .24, optic: 'reflex', sightY: .133, tint: 0x8a8c68 },
  dmr: { receiver: .3, barrel: .42, stock: .26, optic: 'scope', sightY: .143, tint: 0x8e896b },
  shotgun: { receiver: .26, barrel: .4, stock: .25, optic: 'iron', sightY: .068, tint: 0x8b7050 },
  sniper: { receiver: .34, barrel: .52, stock: .29, optic: 'scope', sightY: .15, tint: 0x899477 },
  lmg: { receiver: .32, barrel: .4, stock: .23, optic: 'reflex', sightY: .14, tint: 0x727b64 },
};

export function createWeaponModel(key = 'ar', detailed = true) {
  const profile = WEAPON_VISUALS[key] || WEAPON_VISUALS.ar;
  const root = new THREE.Group();
  root.name = `weapon_${key}`;
  const materials = {
    receiver: new THREE.MeshStandardMaterial({ color: profile.tint, roughness: .57, metalness: .48 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x485250, roughness: .36, metalness: .83 }),
    polymer: new THREE.MeshStandardMaterial({ color: 0x26312c, roughness: .82, metalness: .08 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x131e1b, roughness: .95, metalness: 0 }),
    accent: new THREE.MeshStandardMaterial({ color: 0xc9c99b, roughness: .65, metalness: .15 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc6a354, roughness: .33, metalness: .78 }),
  };
  const ownMaterials = new Set(Object.values(materials));
  const mesh = (geometry, material, position, parent = root, name) => {
    const m = new THREE.Mesh(geometry, materials[material] || material);
    m.position.set(...position); m.castShadow = !detailed; m.receiveShadow = !detailed;
    if (name) m.name = name;
    parent.add(m); return m;
  };
  const box = (w, h, d, x, y, z, mat = 'receiver', parent = root, radius = .009) =>
    mesh(detailed ? new RoundedBoxGeometry(w, h, d, 1, radius) : new THREE.BoxGeometry(w, h, d), mat, [x, y, z], parent);
  const cylinder = (r, length, x, y, z, mat = 'steel', open = false) => {
    const m = mesh(new THREE.CylinderGeometry(r, r, length, detailed ? 16 : 8, 1, open), mat, [x, y, z]);
    m.rotation.x = Math.PI / 2; return m;
  };
  const anchor = (name, x, y, z) => {
    const a = new THREE.Object3D(); a.name = name; a.position.set(x, y, z); root.add(a); return a;
  };
  const pistol = key === 'pistol', shotgun = key === 'shotgun';
  const length = profile.receiver;
  const front = -length * .5 - profile.barrel;
  const muzzleZ = front - .035;
  const magazine = new THREE.Group(); magazine.name = 'magazine'; root.add(magazine);
  magazine.position.set(0, -.135, -.025);

  // Receiver, separated upper/lower, chamber and pistol grip.
  const slide = box(pistol ? .066 : .078, pistol ? .062 : .093, length, 0, .015, 0);
  slide.name = pistol ? 'slide' : 'upper_receiver';
  box(.069, .045, length * .79, 0, -.049, .008, 'polymer');
  const grip = box(.055, .14, .067, 0, -.13, length * .31, 'polymer');
  grip.rotation.x = -.27;
  box(.052, .018, .08, 0, -.05, length * .22, 'steel');
  // Open trigger guard: the sight line never goes through an opaque slab.
  box(.045, .009, .072, 0, -.112, .014, 'polymer', root, .003);
  box(.045, .055, .009, 0, -.085, -.017, 'polymer', root, .003);
  box(.008, .029, .007, 0, -.09, .014, 'steel', root, .002);

  if (pistol) {
    cylinder(.014, .053, 0, .017, -length * .5 - .012);
    box(.058, .022, .063, 0, -.08, .05, 'polymer', magazine);
    magazine.position.set(0, -.125, .05);
  } else {
    const handguardLength = profile.barrel * .67;
    if (shotgun) {
      cylinder(.02, profile.barrel, 0, .02, -length * .5 - profile.barrel / 2);
      cylinder(.016, profile.barrel * .83, 0, -.028, -length * .5 - profile.barrel * .43, 'polymer');
      const pump = box(.069, .064, .19, 0, -.017, -length * .5 - .16, 'receiver');
      pump.name = 'pump';
      if (detailed) for (let i = 0; i < 7; i++) box(.072, .067, .006, 0, -.017, -length * .5 - .23 + i * .024, 'polymer', root, .002);
      magazine.visible = false;
    } else {
      box(.073, .085, handguardLength, 0, .007, -length * .5 - handguardLength * .49, 'receiver');
      cylinder(.013, profile.barrel, 0, .011, -length * .5 - profile.barrel / 2);
      box(.059, .018, handguardLength * .94, 0, .058, -length * .5 - handguardLength * .48, 'steel');
      if (detailed) {
        for (let i = 0; i < 7; i++) {
          const z = -length * .5 - .025 - i * handguardLength / 8;
          for (const side of [-1, 1]) box(.004, .025, .016, side * .038, .013, z, 'rubber', root, .003);
          box(.062, .006, .008, 0, .071, z, 'polymer', root, .002);
        }
      }
      if (key === 'lmg') {
        box(.14, .12, .125, 0, -.04, .01, 'polymer', magazine);
        box(.143, .012, .13, 0, .026, .01, 'receiver', magazine);
      } else {
        const mag = box(.052, key === 'smg' ? .19 : .165, .087, 0, -.034, -.006, 'polymer', magazine);
        mag.rotation.x = -.13;
        if (detailed) for (let i = 0; i < 3; i++) box(.055, .008, .089, 0, -.08 + i * .045, -.006, 'steel', magazine, .002);
      }
    }
    // Buffer tube and a stock with a distinct butt pad and cheek rest.
    cylinder(.019, profile.stock, 0, -.003, length * .5 + profile.stock * .4, 'steel');
    box(.066, .097, profile.stock * .8, 0, -.024, length * .5 + profile.stock * .45, 'polymer');
    box(.06, .028, profile.stock * .64, 0, .035, length * .5 + profile.stock * .46, 'receiver');
    box(.076, .145, .024, 0, -.045, length * .5 + profile.stock * .9, 'rubber');
  }
  cylinder(pistol ? .016 : .022, pistol ? .028 : .063, 0, .013, front, 'steel');
  // A recessed muzzle bore gives the weapon a readable barrel opening.
  const bore = mesh(new THREE.CircleGeometry(pistol ? .01 : .013, 12), 'rubber', [0, .013, muzzleZ - .001]);
  bore.rotation.y = Math.PI;

  const sight = anchor('optical_center', 0, profile.sightY, -.05);
  let reticle = null;
  if (profile.optic === 'reflex') {
    box(.045, .035, .07, 0, .077, -.05, 'polymer');
    // Four thin sides leave a genuine opening in the reflex sight.
    box(.008, .054, .045, -.029, profile.sightY, -.05, 'steel');
    box(.008, .054, .045, .029, profile.sightY, -.05, 'steel');
    box(.065, .008, .046, 0, profile.sightY + .026, -.05, 'steel');
    box(.065, .008, .046, 0, profile.sightY - .026, -.05, 'steel');
  } else if (profile.optic === 'scope') {
    box(.043, .05, .19, 0, .079, -.015, 'steel');
    cylinder(.036, .22, 0, profile.sightY, -.03, 'polymer', true);
    for (const z of [-.14, .08]) mesh(new THREE.TorusGeometry(.035, .006, 6, 20), 'steel', [0, profile.sightY, z]);
    box(.025, .019, .032, 0, profile.sightY + .042, -.025, 'steel');
    box(.02, .026, .028, .042, profile.sightY, -.025, 'steel');
  } else {
    // Rear notch and fine front blade, not a solid fake scope.
    box(.008, .019, .018, -.014, profile.sightY - .005, length * .36, 'steel');
    box(.008, .019, .018, .014, profile.sightY - .005, length * .36, 'steel');
    box(.006, .017, .014, 0, profile.sightY - .004, front + .06, 'accent');
  }
  if (detailed && profile.optic !== 'iron') {
    const reticleMat = new THREE.MeshBasicMaterial({ color: 0xefb778, transparent: true, opacity: .95, depthWrite: false, toneMapped: false });
    ownMaterials.add(reticleMat);
    reticle = mesh(new THREE.CircleGeometry(profile.optic === 'scope' ? .00085 : .0013, 12), reticleMat, [0, profile.sightY, -.15]);
  }
  if (detailed) {
    // Right-side chamber, selector, pin heads and a restrained painted marking.
    box(.003, .03, .059, .04, .008, .005, 'rubber', root, .002);
    for (const z of [-.055, .065]) {
      const pin = mesh(new THREE.CylinderGeometry(.004, .004, .082, 8), 'steel', [0, -.018, z]);
      pin.rotation.z = Math.PI / 2;
    }
    box(.003, .011, .042, .042, -.02, .04, 'accent', root, .001);
    box(.004, .01, .018, .043, .029, .056, 'accent', root, .001);
  }
  const muzzle = anchor('muzzle', 0, .013, muzzleZ);
  const leftGrip = anchor('support_grip', pistol ? -.028 : -.018, pistol ? -.115 : -.067, pistol ? .035 : -length * .5 - Math.min(.14, profile.barrel * .4));
  const rightGrip = anchor('trigger_grip', .027, -.116, length * .3);
  const magRest = magazine.position.clone();

  if (!detailed) {
    // Remote equipment shares the same silhouette, batched by material.
    root.updateMatrixWorld(true);
    const groups = new Map();
    root.traverse(o => {
      if (!o.isMesh || !o.visible || !o.parent.visible) return;
      const list = groups.get(o.material) || [];
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      list.push(g.applyMatrix4(o.matrixWorld));
      groups.set(o.material, list);
    });
    root.traverse(o => o.geometry?.dispose());
    root.clear();
    for (const [mat, geos] of groups) {
      const merged = mergeGeometries(geos, false);
      geos.forEach(g => g.dispose());
      mesh(merged, mat, [0, 0, 0]);
    }
    root.add(muzzle, sight, leftGrip, rightGrip);
  } else {
    // Keep magazine/slide animation independent, but render all immutable
    // receiver details in a handful of material batches rather than ~70 calls.
    for (const parent of [root, magazine]) {
      const byMaterial = new Map();
      for (const child of parent.children) {
        if (!child.isMesh || child === reticle || child === slide) continue;
        const list = byMaterial.get(child.material) || [];
        list.push(child); byMaterial.set(child.material, list);
      }
      for (const [material, parts] of byMaterial) {
        if (parts.length < 2) continue;
        const geos = parts.map(p => {
          p.updateMatrix();
          const g = p.geometry.index ? p.geometry.toNonIndexed() : p.geometry.clone();
          return g.applyMatrix4(p.matrix);
        });
        const merged = mergeGeometries(geos, false);
        geos.forEach(g => g.dispose());
        parts.forEach(p => { p.removeFromParent(); p.geometry.dispose(); });
        mesh(merged, material, [0, 0, 0], parent, 'equipment_details');
      }
    }
  }
  return { root, magazine, magRest, muzzle, sight, leftGrip, rightGrip, reticle, slide, profile,
    dispose() { root.traverse(o => o.geometry?.dispose()); ownMaterials.forEach(m => m.dispose()); root.removeFromParent(); } };
}
