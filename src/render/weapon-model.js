// Original procedural equipment. Units are metres; forward is -Z. Geometry,
// animation and muzzle effects share named anchors instead of guessed offsets.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { batchStaticParts } from './geometry.js';
import { texture, stencil } from './textures.js';
import { CFG } from '../../shared/config.js';
import { clamp } from '../../shared/math.js';
import { reloadMotion, boltMotion } from './animation.js';
import { createLauncherModel } from './launcher-model.js';

export const WEAPON_VISUALS = {
  pistol: { receiver: .19, barrel: .02, stock: 0, optic: 'iron', sightY: .051, tint: 0x747d6e, marking: 'P92 / 9MM' },
  smg: { receiver: .24, barrel: .16, stock: .15, optic: 'reflex', sightY: .123, tint: 0x596354, marking: 'VEX / 9MM' },
  ar: { receiver: .28, barrel: .34, stock: .24, optic: 'reflex', sightY: .133, tint: 0x65725c, marking: 'K4 / 5.56' },
  dmr: { receiver: .3, barrel: .42, stock: .26, optic: 'scope', sightY: .143, ocularRadius: .022, ocularZ: .08, objectiveRadius: .032, tint: 0x76725d, marking: 'SABLE / 7.62' },
  shotgun: { receiver: .26, barrel: .4, stock: .25, optic: 'iron', sightY: .068, tint: 0x7b6145, marking: 'M12 / 12GA' },
  sniper: { receiver: .34, barrel: .52, stock: .29, optic: 'scope', sightY: .15, ocularRadius: .022, ocularZ: .08, objectiveRadius: .034, tint: 0x64765e, marking: 'AX / .308' },
  lmg: { receiver: .32, barrel: .4, stock: .23, optic: 'reflex', sightY: .14, tint: 0x596448, marking: '249 / 5.56' },
};

export function createWeaponModel(key = 'ar', detailed = true) {
  if (key === 'rpg') return createLauncherModel(detailed);
  const profile = WEAPON_VISUALS[key] || WEAPON_VISUALS.ar;
  const root = new THREE.Group();
  root.name = `weapon_${key}`;
  const materials = {
    receiver: new THREE.MeshStandardMaterial({ color: profile.tint, map: texture('equipment'), roughness: .57, metalness: .48 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x485250, roughness: .36, metalness: .83 }),
    polymer: new THREE.MeshStandardMaterial({ color: 0x26312c, map: texture('equipment'), roughness: .82, metalness: .08 }),
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
  const box = (w, h, d, x, y, z, mat = 'receiver', parent = root, radius = .003) =>
    mesh(new RoundedBoxGeometry(w, h, d, 1, Math.min(radius, w / 3, h / 3, d / 3)), mat, [x, y, z], parent);
  const cylinder = (r, length, x, y, z, mat = 'steel', open = false) => {
    const m = mesh(new THREE.CylinderGeometry(r, r, length, detailed ? 16 : 8, 1, open), mat, [x, y, z]);
    m.rotation.x = Math.PI / 2; return m;
  };
  const anchor = (name, x, y, z) => {
    const a = new THREE.Object3D(); a.name = name; a.position.set(x, y, z); root.add(a); return a;
  };
  const pistol = key === 'pistol', shotgun = key === 'shotgun';
  const receiverWidth = pistol ? .036 : .053;
  const length = profile.receiver;
  const front = -length * .5 - profile.barrel;
  const muzzleZ = front - (pistol ? .014 : .0315);
  const magazine = new THREE.Group(); magazine.name = 'magazine'; root.add(magazine);
  magazine.position.set(0, -.135, -.025);
  let pump = null, bolt = null, feedCover = null, shell = null;

  // Receiver, separated upper/lower, chamber and pistol grip.
  const slide = key === 'sniper' ? cylinder(.026, length, 0, .016, 0, 'steel')
    : box(receiverWidth, pistol ? .045 : .093, length, 0, .015, 0);
  slide.name = pistol ? 'slide' : 'upper_receiver';
  slide.userData.articulated = pistol;
  box(pistol ? .033 : .049, .045, length * .79, 0, -.049, .008, 'polymer');
  const grip = box(.043, .14, .06, 0, -.13, length * .31, 'polymer');
  grip.rotation.x = -.27;
  box(.052, .018, .08, 0, -.05, length * .22, 'steel');
  // Open trigger guard: the sight line never goes through an opaque slab.
  box(.045, .009, .072, 0, -.112, .014, 'polymer', root, .003);
  box(.045, .055, .009, 0, -.085, -.017, 'polymer', root, .003);
  box(.008, .029, .007, 0, -.09, .014, 'steel', root, .002);

  if (pistol) {
    cylinder(.0065, profile.barrel + .03, 0, .013, -length * .5 - profile.barrel / 2 + .015);
    box(.026, .11, .04, 0, -.024, 0, 'steel', magazine);
    box(.036, .012, .048, 0, -.084, 0, 'polymer', magazine);
    magazine.position.set(0, -.125, .05);
  } else {
    const handguardLength = profile.barrel * .67;
    if (shotgun) {
      cylinder(.02, profile.barrel, 0, .02, -length * .5 - profile.barrel / 2);
      cylinder(.016, profile.barrel * .83, 0, -.028, -length * .5 - profile.barrel * .43, 'polymer');
      pump = new THREE.Group(); pump.name = 'pump'; pump.position.z = -length * .5 - .16; root.add(pump);
      box(.069, .064, .19, 0, -.017, 0, 'receiver', pump);
      if (detailed) for (let i = 0; i < 7; i++) box(.072, .067, .006, 0, -.017, -.07 + i * .024, 'polymer', pump, .002);
      magazine.visible = false;
    } else {
      box(.052, key === 'sniper' ? .058 : .085, handguardLength, 0, key === 'sniper' ? -.005 : .007, -length * .5 - handguardLength * .49, 'receiver');
      cylinder(.013, profile.barrel, 0, .011, -length * .5 - profile.barrel / 2);
      box(.03, .012, handguardLength * .94, 0, .058, -length * .5 - handguardLength * .48, 'steel');
      if (detailed) {
        for (let i = 0; i < 7; i++) {
          const z = -length * .5 - .025 - i * handguardLength / 8;
          for (const side of [-1, 1]) box(.003, .025, .016, side * .027, .013, z, 'rubber', root, .001);
          box(.032, .004, .007, 0, .067, z, 'polymer', root, .001);
        }
      }
      if (key === 'lmg') {
        box(.14, .12, .125, 0, -.04, .01, 'polymer', magazine);
        box(.143, .012, .13, 0, .026, .01, 'receiver', magazine);
        feedCover = new THREE.Group(); feedCover.name = 'feed_cover'; feedCover.position.set(0, .066, .13); root.add(feedCover);
        box(.06, .014, .245, 0, 0, -.09, 'steel', feedCover, .003);
        for (let i = 0; i < 7; i++) {
          const round = mesh(new THREE.CylinderGeometry(.006, .006, .045, 7), 'brass', [.078, .009 + i * .014, -.025], magazine);
          round.rotation.z = Math.PI / 2;
        }
      } else {
        const mag = box(.032, key === 'smg' ? .19 : key === 'sniper' ? .075 : .165, .067, 0, -.034, -.006, 'polymer', magazine);
        mag.rotation.x = -.13;
        if (key === 'sniper') magazine.position.y = -.085;
        if (detailed && key !== 'sniper') for (let i = 0; i < 3; i++) box(.035, .005, .069, 0, -.08 + i * .045, -.006, 'steel', magazine, .001);
      }
    }
    // Buffer tube and a stock with a distinct butt pad and cheek rest.
    cylinder(.019, profile.stock, 0, -.003, length * .5 + profile.stock * .4, 'steel');
    if (key === 'sniper') {
      const brace = box(.026, .019, profile.stock * .82, 0, -.06, length * .5 + profile.stock * .42, 'receiver');
      brace.rotation.x = -.32;
      box(.059, .032, profile.stock * .6, 0, .019, length * .5 + profile.stock * .48, 'polymer');
      for (const side of [-1, 1]) cylinder(.006, .24, side * .035, -.065, -.43, 'steel');
    } else box(.05, .097, profile.stock * .8, 0, -.024, length * .5 + profile.stock * .45, 'polymer');
    box(.048, .02, profile.stock * .64, 0, .035, length * .5 + profile.stock * .46, 'receiver');
    box(.064, .135, .024, 0, -.045, length * .5 + profile.stock * .9, 'rubber');
  }
  if (!pistol && !shotgun) {
    box(.027, .008, length * .92, 0, .066, .003, 'steel');
    if (detailed) for (let i = 0; i < 13; i++) box(.032, .0035, .005, 0, .072, -length * .41 + i * length * .068, 'polymer', root, .001);
  }
  if (key === 'sniper' || key === 'dmr') {
    bolt = new THREE.Group(); bolt.name = 'bolt_handle'; bolt.position.set(.045, .009, .085); root.add(bolt);
    const arm = mesh(new THREE.CylinderGeometry(.006, .006, .046, 8), 'steel', [.014, -.012, 0], bolt);
    arm.rotation.z = -.65;
    mesh(new THREE.SphereGeometry(.013, 10, 7), 'polymer', [.03, -.03, 0], bolt);
  }
  cylinder(pistol ? .0105 : .016, pistol ? .028 : .063, 0, .013, front, 'steel');
  // A recessed muzzle bore gives the weapon a readable barrel opening.
  const bore = mesh(new THREE.CircleGeometry(pistol ? .006 : .009, 12), 'rubber', [0, .013, muzzleZ - .001]);
  bore.rotation.y = Math.PI;

  const sight = anchor('optical_center', 0, profile.sightY, -.05);
  const opticStart = root.children.length;
  let reticle = null;
  if (profile.optic === 'reflex') {
    const mountBottom = .0615, mountTop = profile.sightY - .027;
    box(.04, mountTop - mountBottom, .065, 0, (mountBottom + mountTop) / 2, -.05, 'polymer');
    // Four thin sides leave a genuine opening in the reflex sight.
    box(.008, .054, .045, -.029, profile.sightY, -.05, 'steel');
    box(.008, .054, .045, .029, profile.sightY, -.05, 'steel');
    box(.065, .008, .046, 0, profile.sightY + .026, -.05, 'steel');
    box(.065, .008, .046, 0, profile.sightY - .026, -.05, 'steel');
  } else if (profile.optic === 'scope') {
    box(.043, .017, .19, 0, profile.sightY - .061, -.015, 'steel');
    for (const z of [-.1, .053]) for (const side of [-1, 1]) box(.006, .044, .027, side * (z < 0 ? .028 : .022), profile.sightY - .051, z, 'steel');
    // The visible inner lining closes the annulus between eyepiece/objective.
    // A front-face-only tube looked like two disconnected floating rings.
    const tubeMat = materials.polymer.clone(); tubeMat.side = THREE.DoubleSide; tubeMat.roughness = .91;
    ownMaterials.add(tubeMat);
    // A narrower eyepiece opens into the main tube. Adjustment hardware sits
    // on that tube, entirely outside the projected rear aperture.
    const tube = mesh(new THREE.LatheGeometry([
      new THREE.Vector2(profile.objectiveRadius, -.14), new THREE.Vector2(.03, -.115),
      new THREE.Vector2(.03, .055), new THREE.Vector2(profile.ocularRadius, profile.ocularZ),
    ], detailed ? 32 : 12), tubeMat, [0, profile.sightY, 0]);
    tube.rotation.x = Math.PI / 2;
    for (const [z, radius] of [[-.14, profile.objectiveRadius], [profile.ocularZ, profile.ocularRadius]]) mesh(new THREE.TorusGeometry(radius, .0025, 6, detailed ? 32 : 12), 'steel', [0, profile.sightY, z]);
    const turret = mesh(new THREE.CylinderGeometry(.014, .016, .02, 20), 'steel', [0, profile.sightY + .04, .035]);
    const dial = mesh(new THREE.CylinderGeometry(.014, .014, .016, 20), 'steel', [.038, profile.sightY, .035]); dial.rotation.z = Math.PI / 2;
    for (let i = 0; i < 16; i++) {
      const angle = i / 16 * Math.PI * 2;
      box(.0015, .0006, .003, Math.cos(angle) * .012, turret.position.y + .0104, .035 + Math.sin(angle) * .012, 'accent', root, .0001);
    }
  } else {
    // Rear notch and fine front blade, not a solid fake scope.
    box(.008, .019, .018, -.014, profile.sightY - .0095, length * .36, 'steel');
    box(.008, .019, .018, .014, profile.sightY - .0095, length * .36, 'steel');
    box(.006, .014, .014, 0, profile.sightY - .007, pistol ? -length * .4 : front + .06, 'accent');
  }
  if (detailed && profile.optic !== 'iron') {
    const reticleMat = new THREE.MeshBasicMaterial({ color: 0xefb778, transparent: true, opacity: .95, depthWrite: false, toneMapped: false });
    ownMaterials.add(reticleMat);
    reticle = new THREE.Group(); reticle.name = 'reticle'; reticle.position.set(0, profile.sightY, -.15); root.add(reticle);
    mesh(new THREE.CircleGeometry(profile.optic === 'scope' ? .00033 : .0013, 12), reticleMat, [0, 0, 0], reticle);
    if (profile.optic === 'scope') {
      for (const side of [-1, 1]) {
        box(.018, .00035, .0002, side * .015, 0, 0, reticleMat, reticle, .0001);
        box(.00035, .018, .0002, 0, side * .015, 0, reticleMat, reticle, .0001);
      }
      for (let i = 1; i <= 5; i++) {
        for (const side of [-1, 1]) {
          box(.0028, .00032, .0002, 0, side * i * .0036, 0, reticleMat, reticle, .0001);
          box(.00032, .0028, .0002, side * i * .0036, 0, 0, reticleMat, reticle, .0001);
        }
      }
    }
  }
  if (feedCover) {
    const optic = new THREE.Group();
    for (const child of root.children.slice(opticStart)) optic.add(child);
    root.add(optic); root.updateMatrixWorld(true); feedCover.attach(optic); feedCover.attach(sight);
  }
  if (detailed) {
    // Right-side chamber, selector, pin heads and a restrained painted marking.
    box(.003, .025, .059, receiverWidth / 2 + .001, .008, .005, 'rubber', root, .001);
    for (const z of [-.055, .065]) {
      const pin = mesh(new THREE.CylinderGeometry(.004, .004, receiverWidth + .004, 8), 'steel', [0, -.018, z]);
      pin.rotation.z = Math.PI / 2;
    }
    box(.003, .011, .042, receiverWidth / 2 + .001, -.02, .04, 'accent', root, .001);
    box(.004, .01, .018, receiverWidth / 2 + .001, .029, .056, 'accent', root, .001);
    const marking = new THREE.MeshStandardMaterial({ map: stencil(profile.marking, 'FIELD SYSTEMS'), transparent: true,
      alphaTest: .08, roughness: .8, polygonOffset: true, polygonOffsetFactor: -1 });
    ownMaterials.add(marking);
    for (const side of [-1, 1]) {
      const decal = mesh(new THREE.PlaneGeometry(length * .55, length * .2), marking, [side * (receiverWidth / 2 + .0008), .004, .006]);
      decal.rotation.y = side * Math.PI / 2;
      for (let i = 0; i < 5; i++) box(.002, .025, .003, side * (receiverWidth / 2 + .0008), .011, length * .28 + i * .007, 'steel', root, .001);
    }
  }
  if (shotgun) {
    shell = new THREE.Group(); shell.name = 'reload_shell'; root.add(shell); shell.visible = false;
    const shellMat = new THREE.MeshStandardMaterial({ color: 0x875943, roughness: .7 }); ownMaterials.add(shellMat);
    const body = mesh(new THREE.CylinderGeometry(.01, .01, .05, 10), shellMat, [0, 0, 0], shell); body.rotation.x = Math.PI / 2;
    const cap = mesh(new THREE.CylinderGeometry(.011, .011, .008, 10), 'brass', [0, 0, .026], shell); cap.rotation.x = Math.PI / 2;
  }
  const muzzle = anchor('muzzle', 0, .013, muzzleZ);
  const eject = anchor('ejection_port', receiverWidth / 2 + .012, .015, .01);
  const leftGrip = anchor('support_grip', pistol ? -.028 : -.018, pistol ? -.115 : -.067, pistol ? .035 : -length * .5 - Math.min(.14, profile.barrel * .4));
  const rightGrip = anchor('trigger_grip', .027, -.116, length * .3);
  const magRest = magazine.position.clone();

  batchStaticParts(root);
  return { key, root, magazine, magRest, muzzle, eject, sight, leftGrip, rightGrip, gripRest: leftGrip.position.clone(), reticle, slide, profile,
    pump, pumpRestZ: pump?.position.z || 0, bolt, boltRestZ: bolt?.position.z || 0, feedCover, shell,
    dispose() { root.traverse(o => o.geometry?.dispose()); ownMaterials.forEach(m => m.dispose()); root.removeFromParent(); } };
}

// One presentation timeline for first- and third-person equipment. This reads
// timers/ammo; authoritative inventory is never mutated here.
export function poseWeaponMechanics(model, reloadT, shotT = Infinity, ammo = 0) {
  const W = CFG.WEAPONS[model.key] || CFG.WEAPONS.ar;
  const motion = reloadMotion(reloadT, W.reload);
  const support = model.gripRest.clone();
  const trigger = model.rightGrip.position.clone();
  if (model.key === 'rpg') {
    model.magazine.position.copy(model.magRest); model.magazine.rotation.set(0, 0, 0);
    model.magazine.visible = ammo > 0;
    if (motion.active) {
      // Align outside the muzzle before sliding tail-first into the bore. The
      // hand shifts along the round and releases before it would enter the tube.
      const p = motion.progress;
      const align = clamp((p - .12) / .2, 0, 1);
      const aligned = align * align * (3 - 2 * align);
      const insert = clamp((p - .34) / .44, 0, 1);
      const eased = insert * insert * (3 - 2 * insert);
      const hold = clamp((p - .04) / .12, 0, 1) * (1 - clamp((p - .6) / .13, 0, 1));
      model.magazine.visible = p > .1;
      model.magazine.position.set(-.07 * (1 - aligned), -.15 * (1 - aligned), model.magRest.z - .6 * (1 - eased));
      model.magazine.rotation.x = .24 * (1 - aligned);
      const roundGrip = new THREE.Vector3(-.031, -.025, .14 - eased * .28).applyEuler(model.magazine.rotation).add(model.magazine.position);
      support.lerp(roundGrip, hold);
      motion.stage = p < .12 ? 'grasp' : p < .34 ? 'align' : p < .78 ? 'insert' : 'settle';
    }
    return { motion, support, trigger };
  }
  model.magazine.position.copy(model.magRest); model.magazine.rotation.set(0, 0, 0);
  model.magazine.visible = model.key !== 'shotgun';
  if (model.feedCover) model.feedCover.rotation.x = motion.feed * 1.12;
  if (model.key === 'pistol') {
    model.slide.position.z = Math.sin(Math.PI * clamp(shotT / .15, 0, 1)) * .035 + motion.rack * .035;
  }
  if (model.pump) {
    const pump = Math.sin(Math.PI * clamp((shotT - .08) / .34, 0, 1)) * .09;
    model.pump.position.z = model.pumpRestZ + pump;
    support.z += pump;
  }
  if (model.bolt) {
    const cycle = boltMotion(shotT);
    model.bolt.position.z = model.boltRestZ + Math.max(cycle.travel, motion.rack) * .09;
    model.bolt.rotation.z = -Math.max(cycle.lift, motion.rack) * .95;
    if (model.key === 'sniper' && !motion.active) {
      trigger.lerp(model.bolt.position.clone().add(new THREE.Vector3(.033, -.03, 0)), cycle.hand);
    }
  }
  if (model.shell) model.shell.visible = false;
  if (motion.active) {
    if (model.key !== 'shotgun') {
      const stow = Math.sin(Math.PI * clamp((motion.progress - .38) / .2, 0, 1));
      model.magazine.position.x -= motion.extract * .08;
      model.magazine.position.y -= motion.extract * (model.key === 'pistol' ? .11 : .16) + stow * .2;
      model.magazine.rotation.z = motion.extract * -.16;
      support.lerp(model.magazine.position.clone().add(new THREE.Vector3(-.028, -.035, .01)), motion.grasp);
    } else {
      const rounds = Math.max(1, W.mag - ammo);
      const feed = Math.sin(clamp((motion.progress - .12) / .74, 0, 1) * Math.PI * rounds);
      const target = new THREE.Vector3(-.018, -.14 - Math.abs(feed) * .11, .025);
      support.lerp(target, motion.grasp);
      model.shell.position.copy(support).add(new THREE.Vector3(.015, .025, -.03));
      model.shell.visible = motion.progress > .12 && motion.progress < .85;
    }
  }
  return { motion, support, trigger };
}
