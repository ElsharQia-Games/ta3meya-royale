// Original Blackshore utility/transport vehicles. Open cabins, real wheel
// pivots and shared dimensions keep the driving view tied to simulation data.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { vehicleShape, vehicleRideHeight } from '../../shared/vehicle.js';
import { CFG } from '../../shared/config.js';
import { texture, stencil } from './textures.js';
import { batchStaticParts } from './geometry.js';

let _wheelTreadsGeo = null;
const _wheelBoltsGeo = { '1': null, '-1': null };

function getWheelTreadsGeo() {
  if (_wheelTreadsGeo) return _wheelTreadsGeo;
  const geos = [];
  const base = new THREE.BoxGeometry(.275, .055, .095);
  for (let i = 0; i < 16; i++) {
    const a = i * Math.PI * 2 / 16;
    const g = base.clone();
    const m = new THREE.Matrix4().makeRotationX(a);
    m.setPosition(0, Math.cos(a) * .414, Math.sin(a) * .414);
    g.applyMatrix4(m);
    geos.push(g);
  }
  base.dispose();
  _wheelTreadsGeo = mergeGeometries(geos, false);
  geos.forEach(g => g.dispose());
  return _wheelTreadsGeo;
}

function getWheelBoltsGeo(side) {
  const key = String(side);
  if (_wheelBoltsGeo[key]) return _wheelBoltsGeo[key];
  const geos = [];
  const base = new THREE.SphereGeometry(.025, 6, 4);
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    const g = base.clone();
    const m = new THREE.Matrix4().setPosition(side * .151, Math.cos(a) * .12, Math.sin(a) * .12);
    g.applyMatrix4(m);
    geos.push(g);
  }
  base.dispose();
  _wheelBoltsGeo[key] = mergeGeometries(geos, false);
  geos.forEach(g => g.dispose());
  return _wheelBoltsGeo[key];
}

export function createVehicleModel(type) {
  const truck = type === 'truck', shape = vehicleShape(type), offset = vehicleRideHeight();
  const group = new THREE.Group(), chassis = new THREE.Group();
  group.name = `vehicle_${type}`; group.add(chassis);
  const mats = {
    paint: new THREE.MeshStandardMaterial({ color: truck ? 0x606d53 : 0x7b8062, map: texture('equipment'), roughness: .64, metalness: .35 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x222d29, roughness: .75, metalness: .18 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x788079, roughness: .43, metalness: .8 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x202824, roughness: .97 }),
    seat: new THREE.MeshStandardMaterial({ color: 0x414f3e, map: texture('fabric'), roughness: .94 }),
    canvas: new THREE.MeshStandardMaterial({ color: 0x59664c, map: texture('fabric'), roughness: .98 }),
    glass: new THREE.MeshStandardMaterial({ color: 0xb6ccc5, roughness: .1, metalness: .05, transparent: true, opacity: .04, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: .2 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xe1d7b2, emissive: 0xd2b87a, emissiveIntensity: .22, roughness: .3 }),
    rearLamp: new THREE.MeshStandardMaterial({ color: 0x933924, emissive: 0xe35b35, emissiveIntensity: .15, roughness: .32 }),
    marking: new THREE.MeshStandardMaterial({ color: 0xd9d7b1, roughness: .83 }),
    stencil: new THREE.MeshStandardMaterial({ map: stencil(truck ? 'FL—09' : 'FL—07', 'FIELD OPERATIONS'), transparent: true, alphaTest: .08, roughness: .8, polygonOffset: true, polygonOffsetFactor: -1 }),
  };
  const add = (geometry, material, x, y, z, parent = chassis) => {
    const mesh = new THREE.Mesh(geometry, mats[material]);
    mesh.position.set(x, y - (parent === chassis ? offset : 0), z);
    mesh.castShadow = material !== 'glass'; mesh.receiveShadow = true;
    parent.add(mesh); return mesh;
  };
  const box = (w, h, d, x, y, z, material = 'paint', radius = .025) =>
    add(new RoundedBoxGeometry(w, h, d, 1, Math.min(radius, w / 3, h / 3, d / 3)), material, x, y, z);
  const bar = (from, to, radius = .035, material = 'dark') => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to), delta = b.clone().sub(a);
    const centre = a.clone().add(b).multiplyScalar(.5);
    const mesh = add(new THREE.CylinderGeometry(radius, radius, delta.length(), 8), material, centre.x, centre.y, centre.z);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()); return mesh;
  };
  const half = shape.length / 2;
  box(shape.width * .83, .18, shape.length * .9, 0, .5, 0, 'dark');
  box(shape.width, .45, shape.length - .35, 0, .76, 0);
  box(shape.width + .03, .19, .18, 0, .55, -half, 'dark');
  box(shape.width + .03, .19, .18, 0, .58, half, 'dark');
  // Front grille, tow eyes, lamps and hood seams.
  box(shape.width * .56, .29, .045, 0, .9, -half + .055, 'dark');
  for (let i = -3; i <= 3; i++) box(.035, .24, .018, i * .13, .9, -half + .025, 'steel', .006);
  for (const side of [-1, 1]) {
    box(.26, .19, .05, side * shape.width * .35, .94, -half + .022, 'lamp');
    box(.16, .14, .05, side * shape.width * .4, .87, half - .055, 'rearLamp');
    box(.09, .07, .24, side * shape.width * .3, .53, -half - .05, 'steel');
    const mark = add(new THREE.PlaneGeometry(.46, .175), 'stencil', side * (shape.width / 2 + .006), .99, truck ? -1.55 : .24);
    mark.rotation.y = side * Math.PI / 2;
  }
  const frontCab = truck ? -half + .08 : -.7;
  const backCab = truck ? -.72 : 1.38;
  const roof = truck ? 2.2 : 1.90;
  const cabWidth = shape.width - .1;
  // No solid box occupies the cabin: the driver sees through the windscreen.
  box(cabWidth, .09, backCab - frontCab + .06, 0, roof, (backCab + frontCab) / 2);
  box(cabWidth - .13, .15, .33, 0, truck ? 1.35 : 1.08, frontCab + .12, 'dark');
  box(cabWidth - .1, .11, .38, 0, truck ? 1.37 : 1.1, frontCab + .16, 'paint');
  for (const side of [-1, 1]) {
    const x = side * cabWidth / 2;
    for (const z of [frontCab, (frontCab + backCab) / 2, backCab]) bar([x, .95, z], [x, roof - .04, z], .038, 'paint');
    box(.05, .42, backCab - frontCab, x, 1.12, (frontCab + backCab) / 2);
    box(.045, .06, backCab - frontCab, x, 1.36, (frontCab + backCab) / 2, 'dark');
    box(.025, roof - 1.43, backCab - frontCab - .12, x, (roof + 1.39) / 2, (frontCab + backCab) / 2, 'glass', .002);
    box(.04, .035, .18, x + side * .035, 1.24, frontCab + .55, 'dark');
    box(.23, .2, .1, x + side * .13, 1.45, frontCab + .1, 'dark');
    box(.015, .155, .077, x + side * .25, 1.45, frontCab + .1, 'steel', .002);
    box(.19, .075, 1.5, x + side * .09, .5, .2, 'steel');
  }
  box(cabWidth - .12, roof - 1.17, .012, 0, (roof + 1.12) / 2, frontCab + .018, 'glass', .001);
  box(cabWidth - .12, roof - 1.43, .012, 0, (roof + 1.38) / 2, backCab - .014, 'glass', .001);
  bar([-.56, 1.17, frontCab - .012], [-.24, 1.39, frontCab - .016], .01, 'dark');
  bar([.12, 1.17, frontCab - .012], [.42, 1.39, frontCab - .016], .01, 'dark');
  if (truck) {
    box(2.05, .12, 3.1, 0, 1.15, 1.05, 'dark');
    for (const side of [-1, 1]) {
      box(.07, .7, 3.1, side * 1.02, 1.48, 1.08);
      for (let i = 0; i < 4; i++) box(.065, 1.28, .07, side * 1.05, 1.84, -.4 + i * .92, 'dark');
    }
    box(2.1, .75, .1, 0, 1.52, half - .1);
    box(2.15, .12, 3.15, 0, 2.48, 1.06, 'canvas');
    for (const side of [-1, 1]) box(.05, .66, 3.12, side * 1.055, 2.12, 1.06, 'canvas');
  } else {
    box(1.65, .23, 1.23, 0, 1.04, -1.38);
    for (const side of [-1, 1]) {
      box(.045, .025, .65, side * .54, 1.168, -1.3, 'dark', .006);
      box(.035, .03, .1, side * .83, 1.11, -1.82, 'steel', .004);
    }
    box(.8, .24, .3, 0, 1.22, 1.75, 'dark');
    const spare = add(new THREE.TorusGeometry(.29, .1, 8, 18), 'rubber', -.25, 1.17, 2.12);
    spare.castShadow = true;
    box(.17, .3, .12, .56, 1.2, 2.02, 'paint');
  }
  // Seat cushions/backrests and dash instruments, visible through open glass.
  for (let i = 0; i < 4; i++) {
    const x = i % 2 === 0 ? .43 : -.43;
    const z = i < 2 ? (truck ? -1.05 : -.15) : .8;
    box(.48, .16, .52, x, .96, z, 'seat', .055);
    const back = box(.48, .49, .13, x, 1.24, z + .2, 'seat', .05);
    back.rotation.x = -.1;
    box(.29, .14, .11, x, 1.56, z + .24, 'dark');
  }
  const steering = new THREE.Group(); steering.position.set(.43, 1.35 - offset, truck ? -1.38 : -.42);
  steering.rotation.x = -.28; chassis.add(steering);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(.18, .021, 7, 20), mats.dark);
  steering.add(ring);
  for (let i = 0; i < 3; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(.027, .18, .025), mats.steel);
    const a = i * Math.PI * 2 / 3; spoke.position.set(Math.sin(a) * .085, Math.cos(a) * .085, 0); spoke.rotation.z = -a;
    steering.add(spoke);
  }
  box(.31, .16, .025, .43, 1.25, frontCab + .32, 'dark');
  for (let i = 0; i < 3; i++) box(.04, .045, .029, .35 + i * .075, 1.27, frontCab + .34, 'marking', .006);
  bar([-.7, roof, backCab - .2], [-.73, roof + .55, backCab - .2], .007, 'dark');

  const wheels = [];
  for (let axle = 0; axle < 2; axle++) for (const side of [-1, 1]) {
    const pivot = new THREE.Group(), spin = new THREE.Group();
    const z = (axle ? 1 : -1) * shape.wheelBase / 2;
    pivot.position.set(side * shape.track / 2, -.17, z);
    pivot.add(spin); group.add(pivot);
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(.42, .42, .27, 20), mats.rubber);
    tyre.userData.primaryShadowCaster = true;
    tyre.rotation.z = Math.PI / 2; spin.add(tyre);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(.235, .235, .287, 16), mats.steel);
    hub.rotation.z = Math.PI / 2; spin.add(hub);
    const treads = new THREE.Mesh(getWheelTreadsGeo(), mats.dark);
    spin.add(treads);
    const bolts = new THREE.Mesh(getWheelBoltsGeo(side), mats.dark);
    spin.add(bolts);
    const arch = add(new THREE.TorusGeometry(.47, .064, 6, 18, Math.PI), 'dark', side * shape.track / 2, .47, z);
    arch.rotation.y = Math.PI / 2;
    // Physics wheel order is front-right/front-left/rear-right/rear-left.
    wheels.push({ pivot, spin, front: axle === 0, contact: axle * 2 + (side > 0 ? 0 : 1) });
  }
  chassis.userData.primaryShadowCaster = true;
  chassis.traverse(o => { if (o.isMesh) o.userData.primaryShadowCaster = true; });
  group.traverse(o => {
    if (o.isMesh) {
      o.receiveShadow = true;
      o.castShadow = o.material !== mats.glass && !!o.userData.primaryShadowCaster;
    }
  });
  batchStaticParts(group);
  return { group, chassis, wheels, steering, mats,
    dispose() {
      const geometries = new Set(); group.traverse(o => { if (o.geometry) geometries.add(o.geometry); });
      geometries.forEach(g => {
        if (g !== _wheelTreadsGeo && g !== _wheelBoltsGeo['1'] && g !== _wheelBoltsGeo['-1']) g.dispose();
      });
      Object.values(mats).forEach(m => m.dispose()); group.removeFromParent();
    } };
}
