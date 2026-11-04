// Original field equipment built to the authoritative box dimensions. Static
// models are flattened into the world's spatial batches; breakable models keep
// their box ID and a single removable/disposable group.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { texture, stencil } from './textures.js';
import { batchStaticParts } from './geometry.js';

export class FieldAssets {
  constructor(renderer, surfaces) {
    const material = (color, roughness = .8, metalness = .1, map = 'equipment') => renderer.registerMaterial(
      new THREE.MeshStandardMaterial({ color, roughness, metalness, map: texture(map) }));
    this.materials = {
      concrete: surfaces.concrete,
      steel: material(0x455250, .62, .65), dark: material(0x242e2b, .93, .1),
      timber: material(0x9a957c, .91, 0, 'wood'), canvas: material(0xa49e7c, .98, 0, 'webbing'),
      olive: material(0x586a5e, .76, .38), blue: material(0x49666b, .72, .36),
      rust: material(0x845a40, .9, .22), amber: material(0xc3a15e, .73, .32),
      rubber: material(0x222927, .99, 0), glass: material(0x253e3e, .27, .4),
      hazard: material(0xe0d4ab, .84, .1, 'hazard'),
      shadow: new THREE.MeshBasicMaterial({ map: texture('contactShadow'), transparent: true,
        opacity: .35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }),
    };
    this.materials.shadow.userData.noShadow = true;
    for (const [key, title, sub] of [['cargo', 'NORTHLINE', 'INTERMODAL / 06'], ['crateLabel', 'FIELD SUPPLY', 'FL—07 / KEEP DRY'], ['fuel', 'FUEL / 03', 'FLAMMABLE']]) {
      this.materials[key] = renderer.registerMaterial(new THREE.MeshStandardMaterial({ map: stencil(title, sub),
        transparent: true, alphaTest: .05, roughness: .8, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2 }));
    }
  }

  create(b) {
    if (!['crate', 'barrel', 'sandbag', 'fence', 'barrier', 'wreck', 'container', 'pole', 'log', 'furniture'].includes(b.tag)) return null;
    const w = b.max[0] - b.min[0], h = b.max[1] - b.min[1], d = b.max[2] - b.min[2];
    const root = new THREE.Group(); root.name = `field_${b.tag}_${b.id}`;
    root.position.set((b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2);
    root.userData.boxId = b.id;
    const mesh = (geometry, key, x, y, z) => {
      const m = new THREE.Mesh(geometry, this.materials[key]); m.position.set(x, y, z);
      m.castShadow = !m.material.userData.noShadow; m.receiveShadow = true; root.add(m); return m;
    };
    const box = (key, x, y, z, width, height, depth, radius = .015) =>
      mesh(new RoundedBoxGeometry(width, height, depth, 1, Math.min(radius, width / 3, height / 3, depth / 3)), key, x, y, z);
    const cylinder = (key, x, y, z, radius, length, segments = 18) =>
      mesh(new THREE.CylinderGeometry(radius, radius, length, segments), key, x, y, z);
    const decal = (key, x, y, z, width, height, yaw = 0) => {
      const m = mesh(new THREE.PlaneGeometry(width, height), key, x, y, z); m.rotation.y = yaw; return m;
    };
    const shadow = mesh(new THREE.PlaneGeometry(w * 1.55, d * 1.55), 'shadow', 0, .014, 0);
    shadow.rotation.x = -Math.PI / 2; shadow.castShadow = false;

    if (b.tag === 'container') {
      const paint = ['blue', 'olive', 'rust', 'amber'][b.id % 4];
      box(paint, 0, h / 2, 0, w - .035, h - .03, d - .035, .025);
      for (const side of [-1, 1]) {
        for (let i = 0; i < 25; i++) box(paint, -w / 2 + .17 + i * (w - .34) / 24, h / 2, side * (d / 2 - .014), .07, h - .22, .037, .008);
        box('steel', 0, .065, side * d / 2, w, .13, .08);
        box('steel', 0, h - .06, side * d / 2, w, .12, .08);
        for (const end of [-1, 1]) box('steel', end * (w / 2 - .055), h / 2, side * (d / 2 - .025), .12, h, .12);
        decal('cargo', -.8, h * .64, side * (d / 2 + .011), 2.6, .86, side < 0 ? Math.PI : 0);
        decal('hazard', w / 2 - .32, .35, side * (d / 2 + .023), .33, .3, side < 0 ? Math.PI : 0);
      }
      for (const end of [-1, 1]) {
        for (const side of [-1, 1]) {
          box(paint, end * (w / 2 + .005), h / 2, side * d * .243, .024, h - .2, d * .475);
          cylinder('steel', end * (w / 2 + .034), h / 2, side * d * .27, .018, h - .38, 8);
          box('steel', end * (w / 2 + .05), h * .42, side * d * .27, .022, .042, .22);
        }
      }
    } else if (b.tag === 'barrel') {
      const paint = b.id % 3 ? 'rust' : 'amber';
      cylinder(paint, 0, h / 2, 0, w / 2, h - .025, 24);
      for (const y of [.035, h * .3, h * .69, h - .035]) cylinder('steel', 0, y, 0, w / 2 + .012, .035, 24);
      cylinder('steel', .13, h, .06, .043, .014, 12);
      decal('fuel', 0, h * .52, d / 2 + .012, .46, .19);
    } else if (b.tag === 'sandbag') {
      for (let row = 0; row < 4; row++) {
        const count = row % 2 ? 4 : 5;
        const width = w / count;
        for (let i = 0; i < count; i++) for (const side of [-1, 1]) {
          const bag = box('canvas', -w / 2 + width * (i + .5), h / 4 * (row + .5), side * d * .24,
            width - .018, h / 4 - .012, d * .515, .09);
          bag.rotation.y = Math.sin(i * 3.7 + row * 4.1 + side) * .035;
          box('timber', -w / 2 + width * (i + .5), h / 4 * (row + .75), side * d * .49, width * .72, .009, .007, .002);
        }
      }
    } else if (b.tag === 'barrier') {
      const length = Math.max(w, d), depth = Math.min(w, d);
      if (d > w) root.rotation.y = Math.PI / 2;
      const profile = new THREE.Shape();
      profile.moveTo(-depth / 2, 0); profile.lineTo(depth / 2, 0);
      profile.lineTo(depth / 2, h * .19); profile.lineTo(depth * .24, h * .55);
      profile.lineTo(depth * .19, h); profile.lineTo(-depth * .19, h);
      profile.lineTo(-depth * .24, h * .55); profile.lineTo(-depth / 2, h * .19); profile.closePath();
      const geo = new THREE.ExtrudeGeometry(profile, { depth: length, bevelEnabled: false, steps: 1 });
      geo.translate(0, 0, -length / 2); geo.rotateY(Math.PI / 2);
      mesh(geo, 'concrete', 0, 0, 0);
      for (const side of [-1, 1]) {
        const strip = decal('hazard', 0, h * .73, side * depth * .225, length - .18, h * .28, side < 0 ? Math.PI : 0);
        strip.rotation.x = side * .065;
        for (const end of [-1, 1]) box('amber', end * length * .32, h * .88, side * depth * .204, .13, .06, .01, .003);
      }
    } else if (b.tag === 'wreck') {
      box('dark', 0, .62, 0, w, .71, d, .12);
      box('rust', -.16, .94, 0, w * .92, .2, d * .91, .06);
      box('dark', .21, 1.17, 0, w * .47, .52, d * .83, .08);
      box('steel', .21, 1.45, 0, w * .52, .075, d * .87, .024);
      for (const side of [-1, 1]) {
        box('glass', .21, 1.19, side * d * .421, w * .43, .32, .018, .022);
        box('steel', .21, 1.19, side * d * .44, .075, .42, .04);
        box('rust', -.12, .78, side * d * .499, w * .6, .28, .026);
        for (const end of [-1, 1]) {
          const tyre = cylinder('rubber', end * w * .32, .36, side * (d / 2 - .11), .35, .23, 16); tyre.rotation.x = Math.PI / 2;
          const hub = cylinder('steel', end * w * .32, .36, side * (d / 2 + .012), .18, .025, 10); hub.rotation.x = Math.PI / 2;
        }
      }
      for (const end of [-1, 1]) box('steel', end * (w / 2 - .025), .45, 0, .1, .12, d * .98);
    } else if (b.tag === 'pole') {
      cylinder('steel', 0, h / 2, 0, .09, h, 10);
      box('steel', .36, h - .13, 0, .83, .07, .08);
      box('dark', .69, h - .18, 0, .34, .12, .23);
      box('amber', .69, h - .245, 0, .26, .022, .17);
      cylinder('dark', 0, .09, 0, .18, .18, 10);
    } else if (b.tag === 'log') {
      const length = Math.max(w, d), radius = h / 2;
      const log = cylinder('timber', 0, radius, 0, radius, length, 14);
      if (w > d) log.rotation.z = Math.PI / 2; else log.rotation.x = Math.PI / 2;
      const bands = Math.max(2, Math.floor(length));
      for (let i = 1; i < bands; i++) {
        const cap = cylinder('dark', w > d ? -length / 2 + length * i / bands : 0, radius,
          d > w ? -length / 2 + length * i / bands : 0, radius * 1.015, .025, 14);
        if (w > d) cap.rotation.z = Math.PI / 2; else cap.rotation.x = Math.PI / 2;
      }
    } else if (b.tag === 'fence') {
      box('timber', 0, h / 2, 0, w, h - .03, d * .5, .008);
      for (let i = 0; i < 12; i++) box('dark', -w / 2 + i * w / 11, h / 2, d * .27, .008, h - .05, .009, .002);
      for (const side of [-1, 1]) box('steel', side * (w / 2 - .055), h / 2, 0, .11, h, d);
      box('steel', 0, h * .21, d * .37, w, .072, .048);
      box('steel', 0, h * .8, d * .37, w, .072, .048);
    } else if (b.tag === 'furniture' && h > 1.5) {
      // Shelving is backed/filled so it reads as solid cover like its collider.
      box('olive', 0, h / 2, 0, w, h, d, .025);
      for (const y of [.13, h * .36, h * .65, h - .08]) {
        box('steel', 0, y, d / 2 + .005, w - .08, .045, .025);
        for (const side of [-1, 1]) box('canvas', side * w * .23, y + .18, d / 2 + .008, w * .36, .31, .03);
      }
    } else {
      // Reinforced supply crates also provide a coherent silhouette for the
      // existing low furniture boxes rather than an empty table collider.
      box('timber', 0, h / 2, 0, w, h, d, .022);
      for (const x of [-w * .38, w * .38]) {
        box('olive', x, h / 2, 0, .075, h + .018, d + .022, .006);
      }
      for (const side of [-1, 1]) {
        for (const y of [.09, h - .09]) box('timber', 0, y, side * (d / 2 + .012), w, .14, .036, .005);
        decal('crateLabel', 0, h * .55, side * (d / 2 + .015), w * .54, Math.min(.3, h * .28), side < 0 ? Math.PI : 0);
      }
    }
    batchStaticParts(root);
    return root;
  }
}
