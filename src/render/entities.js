// Dynamic entities: player characters, nameplates and vehicles.
import * as THREE from 'three';
import { CFG, STANCE, TEAMS } from '../../shared/config.js';
import { lerpAngle, clamp, damp } from '../../shared/math.js';
import { stanceHeight } from '../../shared/physics.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { createWeaponModel, poseWeaponMechanics } from './weapon-model.js';
import { solveTwoBone } from './animation.js';
import { texture } from './textures.js';
import { batchStaticParts } from './geometry.js';
import { createVehicleModel } from './vehicle-model.js';
import { smokeObscures } from '../../shared/visibility.js';
import { DeathAnimation } from './death-animation.js';
import { torsoGeometry, carrierPlate } from './character-shapes.js';

const SKIN = [0xc99a72, 0x9c6b4a, 0x6f4a32, 0xe0b48c, 0x8a5a3c];
const UNIFORM = [0x737961, 0x80765d, 0x60746c, 0x807763];

function part(geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function makeCharacter(color, skin) {
  const root = new THREE.Group();
  root.rotation.order = 'YXZ';
  const cloth = new THREE.MeshStandardMaterial({ color, map: texture('fabric'), roughness: 0.9 });
  const vestMat = new THREE.MeshStandardMaterial({ color: 0x657253, map: texture('fabric'), roughness: .92 });
  const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.7 });
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x303a2d, roughness: 0.9 });
  const helmetMat = new THREE.MeshStandardMaterial({ color: 0x657056, roughness: 0.72, metalness: 0.15 });
  const lensMat = new THREE.MeshStandardMaterial({ color: 0x263f37, roughness: .16, metalness: .7 });
  const strapMat = new THREE.MeshStandardMaterial({ color: 0x9b9674, roughness: .95 });
  const teamMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, emissiveIntensity: 0.08 });
  const rounded = (w, h, d, mat, x, y, z, radius = .025) => part(new RoundedBoxGeometry(w, h, d, 2, radius), mat, x, y, z);

  const hips = new THREE.Group();
  hips.position.y = 0.92;
  root.add(hips);

  const torso = new THREE.Group();
  hips.add(torso);
  torso.add(part(torsoGeometry(), cloth, 0, 0, 0));
  torso.add(part(carrierPlate(), vestMat, 0, .075, -.176));
  torso.add(part(carrierPlate(), vestMat, 0, .075, .137));
  for (const side of [-1, 1]) torso.add(rounded(.037, .19, .23, vestMat, side * .187, .23, 0, .01));
  torso.add(rounded(.33, .19, .26, cloth, 0, -.025, 0, .05));
  const pack = rounded(.29, .37, .16, vestMat, 0, .28, .225, .055);
  torso.add(pack);
  torso.add(rounded(.24, .13, .06, cloth, 0, .16, .35));
  for (const side of [-1, 1]) {
    torso.add(rounded(.035, .43, .021, strapMat, side * .158, .3, -.17, .004));
    torso.add(rounded(.034, .31, .02, strapMat, side * .1, .32, .342, .004));
    torso.add(rounded(.095, .16, .095, vestMat, side * .23, .07, .02, .014));
  }
  for (let i = 0; i < 3; i++) {
    torso.add(rounded(.105, .15, .065, helmetMat, -.12 + i * .12, .17, -.198, .012));
    torso.add(rounded(.087, .025, .07, strapMat, -.12 + i * .12, .242, -.2, .005));
  }
  torso.add(rounded(.36, .047, .29, bootMat, 0, .006, 0, .006));
  torso.add(rounded(.075, .035, .023, strapMat, 0, .006, -.16, .005));
  torso.add(rounded(.08, .17, .06, bootMat, -.19, .43, .19, .009));
  torso.add(part(new THREE.CylinderGeometry(.006, .006, .23, 5), bootMat, -.19, .62, .19));
  // team patch on the chest
  torso.add(rounded(.08, .041, .014, teamMat, .1, .393, -.171, .003));
  // shoulder armbands read clearly at range
  torso.add(rounded(.06, .06, .11, teamMat, -.266, .38, 0, .009));
  torso.add(rounded(.06, .06, .11, teamMat, .266, .38, 0, .009));

  const head = new THREE.Group();
  head.position.y = .69;
  torso.add(head);
  const face = part(new THREE.SphereGeometry(.143, 14, 10), skinMat, 0, 0, 0);
  face.scale.set(.91, 1.03, .96); head.add(face);
  const helmet = part(new THREE.SphereGeometry(.164, 16, 10, 0, Math.PI * 2, 0, Math.PI * .55), helmetMat, 0, .032, 0);
  head.add(helmet);
  head.add(rounded(.28, .037, .1, helmetMat, 0, .075, -.14, .01));
  head.add(rounded(.264, .079, .067, bootMat, 0, .005, -.14, .02));
  head.add(rounded(.224, .046, .014, lensMat, 0, .008, -.178, .01));
  head.add(rounded(.22, .105, .145, cloth, 0, -.075, -.072, .04));
  head.add(part(new THREE.CylinderGeometry(.132, .145, .08, 12), strapMat, 0, -.166, 0));
  head.add(rounded(.045, .025, .09, bootMat, -.17, .044, -.025, .007));
  head.add(rounded(.045, .025, .09, bootMat, .17, .044, -.025, .007));
  head.add(rounded(.035, .027, .046, strapMat, 0, .188, -.05, .005));

  const armL = new THREE.Group(), armR = new THREE.Group();
  torso.add(armL, armR);
  const arms = [];
  for (const [arm, side] of [[armL, -1], [armR, 1]]) {
    arm.userData.articulated = true;
    const upper = part(new THREE.CylinderGeometry(.062, .077, 1, 14), cloth, 0, 0, 0);
    const lower = part(new THREE.CylinderGeometry(.042, .058, 1, 14), cloth, 0, 0, 0);
    const elbow = part(new THREE.SphereGeometry(.069, 8, 6), vestMat, 0, 0, 0);
    const hand = rounded(.081, .074, .095, bootMat, 0, 0, 0, .022);
    arm.add(upper, lower, elbow, hand);
    arms.push({ side, upper, lower, elbow, hand });
  }

  // Two-segment legs with a knee joint. Without the knee the crouch/prone
  // poses lowered the hips while the rigid legs stayed straight, pushing the
  // boots up to 0.58 m into the terrain.
  const legL = new THREE.Group(), legR = new THREE.Group();
  const kneeL = new THREE.Group(), kneeR = new THREE.Group();
  legL.position.set(-0.14, -0.02, 0); legR.position.set(0.14, -0.02, 0);
  hips.add(legL, legR);
  for (const [leg, knee] of [[legL, kneeL], [legR, kneeR]]) {
    leg.add(part(new THREE.CapsuleGeometry(0.11, 0.22, 3, 8), cloth, 0, -0.2, 0));
    knee.position.set(0, -0.42, 0);
    leg.add(knee);
    knee.add(part(new THREE.CapsuleGeometry(0.09, 0.3, 3, 8), cloth, 0, -0.2, 0));
    knee.add(rounded(.14, .12, .055, bootMat, 0, -.025, -.1, .025));
    knee.add(rounded(.16, .13, .28, bootMat, 0, -.41, -.05, .045));
    leg.add(rounded(.05, .15, .13, vestMat, leg === legL ? -.1 : .1, -.17, .01, .013));
  }

  const weapon = createWeaponModel('ar', false);
  const gun = weapon.root;
  gun.position.set(.08, .31, -.19);
  torso.add(gun);
  batchStaticParts(root);

  return {
    root, hips, torso, head, armL, armR, arms, legL, legR, kneeL, kneeR, gun, weapon,
    mats: { cloth, vestMat, teamMat },
  };
}

class Nameplate {
  constructor(scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256; this.canvas.height = 64;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.tex, transparent: true, depthTest: true, depthWrite: false, sizeAttenuation: true,
    }));
    this.sprite.scale.set(1.7, 0.42, 1);
    this.sprite.renderOrder = 10;
    scene.add(this.sprite);
    this.last = '';
  }

  update(name, team, hp, maxHp, dead) {
    const key = `${name}|${team}|${Math.round(hp)}|${dead}`;
    if (key === this.last) return;
    this.last = key;
    const c = this.ctx, w = 256, h = 64;
    c.clearRect(0, 0, w, h);
    // Use most of the plate height for the name so the text stays legible at
    // 15-40 m once the sprite is distance-scaled, then shrink only long names.
    let size = 36;
    c.font = `bold ${size}px system-ui, sans-serif`;
    while (size > 18 && c.measureText(name).width > w - 20) {
      size -= 2;
      c.font = `bold ${size}px system-ui, sans-serif`;
    }
    this.fontSize = size;
    c.textAlign = 'center';
    c.lineWidth = 6;
    c.strokeStyle = 'rgba(0,0,0,0.8)';
    c.fillStyle = dead ? '#8b9099' : (TEAMS[team]?.css || '#fff');
    c.strokeText(name, w / 2, 42);
    c.fillText(name, w / 2, 42);
    if (!dead) {
      c.fillStyle = 'rgba(0,0,0,0.6)';
      c.fillRect(40, 48, 176, 10);
      const f = clamp(hp / maxHp, 0, 1);
      c.fillStyle = f > 0.6 ? '#6fe08a' : f > 0.3 ? '#f2c14e' : '#f2635a';
      c.fillRect(41, 49, 174 * f, 8);
    }
    this.tex.needsUpdate = true;
  }

  dispose() {
    this.sprite.material.dispose();
    this.tex.dispose();
    this.sprite.parent?.remove(this.sprite);
  }
}

export class CharacterView {
  constructor(scene, id, world = null, renderer = null) {
    this.scene = scene;
    this.world = world;
    this.renderer = renderer;
    this.id = id;
    this.team = 0;
    const style = Math.abs(id | 0);
    const skin = SKIN[style % SKIN.length];
    this.model = makeCharacter(UNIFORM[style % UNIFORM.length], skin);
    scene.add(this.model.root);
    this.plate = new Nameplate(scene);
    this.pos = [0, 0, 0];
    this.yaw = 0; this.pitch = 0;
    this.stance = STANCE.STAND;
    this.alive = true;
    this.walk = 0;
    this.deathT = 0;
    this.name = '';
    this.teamColor = new THREE.Color(TEAMS[0].color);
    this.setTeam(0);
    this.visible = true;
    this.deathAnimation = null;
    this.death = null;
    this.weaponKey = 'ar'; this.reloadT = 0; this.shotT = Infinity;
    this.inVehicle = 0; this.seat = -1; this.vehicle = null;
    this.hitKick = 0;
  }

  setTeam(team) {
    this.team = team;
    this.teamColor.set(TEAMS[team]?.color ?? 0xffffff);
    this.model.mats.teamMat.color.copy(this.teamColor);
    this.model.mats.teamMat.emissive.copy(this.teamColor).multiplyScalar(0.08);
  }

  applyState(p) {
    if (!p) return;
    this.pos[0] = p.x; this.pos[1] = p.y; this.pos[2] = p.z;
    this.yaw = p.yaw ?? this.yaw;
    this.pitch = p.pitch ?? this.pitch;
    this.stance = p.stance ?? this.stance;
    this.alive = !!p.alive;
    if (p.death) this.death = p.death;
    this.name = p.name || this.name;
    if (p.team !== undefined && p.team !== this.team) this.setTeam(p.team);
    this.hp = p.hp;
    this.reloadT = p.reloadT ?? p.reload ?? 0;
    this.ads = !!(p.ads ?? p.adsing);
    this.ammo = p.mag || 0;
    this.inVehicle = p.inVehicle || p.vehicle || 0;
    this.seat = p.seat ?? -1;
    if (p.weapon && p.weapon !== this.weaponKey) {
      const previous = this.model.gun;
      const weapon = createWeaponModel(p.weapon, false);
      weapon.root.position.copy(previous.position); weapon.root.quaternion.copy(previous.quaternion);
      this.model.weapon.dispose();
      this.model.weapon = weapon; this.model.gun = weapon.root;
      this.model.torso.add(weapon.root);
      this.renderer?.registerObject(weapon.root);
      this.weaponKey = p.weapon;
    }
  }

  fire() { this.shotT = 0; }
  hit(amount = 20) { this.hitKick = Math.min(.19, this.hitKick + amount * .002); }

  update(dt, cameraPos) {
    const m = this.model;
    const r = m.root;
    const seated = !!this.inVehicle;
    const prone = !seated && this.stance === STANCE.PRONE;
    const crouch = !seated && this.stance === STANCE.CROUCH;
    this.shotT += dt;
    this.hitKick *= Math.exp(-9 * dt);

    r.position.set(this.pos[0], this.pos[1], this.pos[2]);
    r.rotation.y = this.yaw;
    r.visible = this.visible;
    if (seated && this.vehicle) {
      const forward = this.seat < 2 ? (this.vehicle.model.group.name === 'vehicle_truck' ? 1.05 : .15) : -.8;
      const offset = new THREE.Vector3(this.seat % 2 === 0 ? .43 : -.43, .15, -forward);
      this.vehicle.group.updateWorldMatrix(true, false);
      r.position.copy(this.vehicle.group.localToWorld(offset));
      r.rotation.y = this.vehicle.yaw;
    }
    const plateY = prone ? .75 : crouch ? 1.42 : 2.0;
    this.plateY = damp(this.plateY ?? plateY, plateY, 12, dt);
    this.plate.sprite.position.set(this.pos[0], this.pos[1] + this.plateY, this.pos[2]);
    this.plate.update(this.name || '', this.team, this.hp ?? 100, 100, !this.alive);

    if (!this.alive) {
      if (!this.deathAnimation) this.deathAnimation = new DeathAnimation(m, this.world, this.pos,
        this.death || { yaw: this.yaw, stance: this.stance }, this.id);
      const hands = this.deathAnimation.update(dt);
      this.deathT = this.deathAnimation.age;
      this.poseArms(hands);
      m.gun.visible = false;
      this.plate.sprite.visible = false;
      return;
    }
    if (this.deathAnimation) { this.deathAnimation.dispose(); this.deathAnimation = null; this.death = null; }
    this.deathT = 0;
    r.rotation.x = 0;
    r.rotation.z = 0;
    m.gun.visible = !(seated && this.seat === 0);
    this.plate.sprite.visible = true;

    // Stance: lower the hips and fold the knees so the boots stay on the
    // ground; prone folds the whole body down and extends the legs behind it.
    const targetHip = seated ? .31 : prone ? .34 : crouch ? .54 : .94;
    m.hips.position.y = damp(m.hips.position.y, targetHip, 12, dt);
    m.hips.position.z = damp(m.hips.position.z, prone ? .66 : 0, 12, dt);
    m.torso.position.y = damp(m.torso.position.y, seated ? -.2 : prone ? -.15 : crouch ? -.18 : 0, 12, dt);
    m.torso.rotation.x = damp(m.torso.rotation.x,
      seated ? 0 : prone ? -1.28 : crouch ? .32 : clamp(this.pitch * .2, -.2, .2), 10, dt);
    m.torso.rotation.z = this.hitKick * (this.id % 2 ? 1 : -1);

    // Walk cycle from horizontal velocity estimate.
    const speed = seated ? 0 : Math.hypot(this.vx || 0, this.vz || 0);
    this.walk += dt * (2.2 + speed * 1.35);
    const swing = Math.min(1, speed / 5) * 0.62;
    let thighL = Math.sin(this.walk) * swing;
    let thighR = -Math.sin(this.walk) * swing;
    let shin = 0;
    if (seated) {
      thighL = thighR = 1.34; shin = -1.2;
    } else if (crouch) {
      // Thigh forward to horizontal, shin back down to vertical: the knee
      // folds instead of the boots being driven through the ground.
      thighL = 1.45 + thighL * 0.12;
      thighR = 1.45 + thighR * 0.12;
      shin = -1.45;
    } else if (prone) {
      thighL = thighR = -1.35;
      shin = 0.1;
    }
    m.legL.rotation.x = damp(m.legL.rotation.x, thighL, 12, dt);
    m.legR.rotation.x = damp(m.legR.rotation.x, thighR, 12, dt);
    m.kneeL.rotation.x = damp(m.kneeL.rotation.x, shin, 12, dt);
    m.kneeR.rotation.x = damp(m.kneeR.rotation.x, shin, 12, dt);
    m.head.rotation.x = damp(m.head.rotation.x, clamp(this.pitch - m.torso.rotation.x, -.85, 1.25), 10, dt);
    m.head.rotation.y = seated && this.vehicle ? clamp(Math.atan2(Math.sin(this.yaw - this.vehicle.yaw), Math.cos(this.yaw - this.vehicle.yaw)), -.8, .8) : 0;
    // Keep the rifle level in prone: the torso is pitched ~73 degrees forward,
    // so an unrotated gun would point its muzzle into the terrain.
    const { motion, support, trigger } = poseWeaponMechanics(m.weapon, this.reloadT, this.shotT, this.ammo);
    m.gun.rotation.x = damp(m.gun.rotation.x, this.pitch - m.torso.rotation.x + motion.lift * .14, 10, dt);
    m.gun.rotation.z = motion.lift * .3;
    m.gun.position.y = damp(m.gun.position.y, (this.ads && !motion.active ? .47 : .31) + (prone ? .23 : 0) + Math.sin(this.walk * .7) * .003 + motion.lift * .07, 14, dt);
    const recoil = Math.sin(Math.PI * clamp(this.shotT / .19, 0, 1)) * .035;
    m.gun.position.z = damp(m.gun.position.z, (prone ? -.18 : -.19) + recoil, 14, dt);
    m.gun.updateMatrix();
    const hands = m.arms.map(arm => seated && this.seat === 0 ? new THREE.Vector3(arm.side * .155, .5, -.27)
      : (arm.side < 0 ? support.clone() : trigger.clone()).applyMatrix4(m.gun.matrix));
    this.poseArms(hands);

    const d3 = cameraPos
      ? Math.hypot(cameraPos[0] - this.pos[0], cameraPos[1] - (this.pos[1] + this.plateY), cameraPos[2] - this.pos[2]) : 99;
    const plateHeight = clamp(d3 * .032, .15, 1.45);
    this.plate.sprite.scale.set(plateHeight * 4, plateHeight, 1);
    this.plate.sprite.visible = this.alive && this.visible && !seated && d3 > 1.6 &&
      (!cameraPos || !smokeObscures(this.smokes, cameraPos, [r.position.x, r.position.y + this.plateY - .3, r.position.z]));
  }

  poseArms(hands) {
    const m = this.model;
    for (let i = 0; i < m.arms.length; i++) {
      const arm = m.arms[i], target = hands[i];
      const shoulder = [arm.side * .245, .405, 0];
      const pose = solveTwoBone(shoulder, target.toArray(), [arm.side * .5, .02, .03], .29, .3);
      const a = new THREE.Vector3(...shoulder), b = new THREE.Vector3(...pose.elbow), c = new THREE.Vector3(...pose.hand);
      const place = (mesh, from, to) => {
        const delta = new THREE.Vector3().subVectors(to, from);
        mesh.position.copy(from).add(to).multiplyScalar(.5);
        mesh.scale.y = delta.length();
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
      };
      place(arm.upper, a, b); place(arm.lower, b, c);
      arm.elbow.position.copy(b); arm.hand.position.copy(c);
      arm.hand.quaternion.copy(m.gun.quaternion);
    }
  }

  dispose() {
    this.deathAnimation?.dispose();
    this.scene.remove(this.model.root);
    const materials = new Set();
    this.model.root.traverse(o => { o.geometry?.dispose(); if (o.material) materials.add(o.material); });
    materials.forEach(m => m.dispose());
    this.plate.dispose();
  }
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------
export class VehicleView {
  constructor(scene, id, type, renderer = null) {
    this.scene = scene;
    this.id = id;
    this.model = createVehicleModel(type);
    const { group, wheels } = this.model;
    this.group = group;
    this.wheels = wheels;
    scene.add(group);
    renderer?.registerObject(group);
    this.pos = [0, 0, 0];
    this.target = [0, 0, 0];
    this.yaw = 0; this.targetYaw = 0;
    this.pitch = 0; this.roll = 0;
    this.speed = 0;
    this.wheelSpin = 0;
    this.smoke = 0;
  }

  applyState(v) {
    this.target[0] = v.x; this.target[1] = v.y; this.target[2] = v.z;
    this.targetYaw = v.yaw;
    this.pitch = v.pitch || 0;
    this.roll = v.roll || 0;
    this.speed = v.forwardSpeed ?? v.speed ?? 0;
    this.steer = v.steer || 0;
    this.wheelComp = v.wheelComp || [0, 0, 0, 0];
    this.braking = !!v.braking;
    this.health = v.health ?? 100;
    if (!this.initialized || Math.hypot(...this.pos.map((n, i) => n - this.target[i])) > 12) {
      this.pos = this.target.slice(); this.yaw = this.targetYaw; this.initialized = true;
    }
  }

  update(dt) {
    const k = 1 - Math.exp(-14 * dt);
    this.pos[0] += (this.target[0] - this.pos[0]) * k;
    this.pos[1] += (this.target[1] - this.pos[1]) * k;
    this.pos[2] += (this.target[2] - this.pos[2]) * k;
    this.yaw = lerpAngle(this.yaw, this.targetYaw, k);
    this.group.position.set(this.pos[0], this.pos[1], this.pos[2]);
    this.group.rotation.set(0, this.yaw, 0, 'YXZ');
    this.model.chassis.rotation.set(this.pitch, 0, this.roll);
    this.wheelSpin += this.speed * dt / 0.42;
    for (const wheel of this.wheels) {
      wheel.pivot.position.y = CFG.VEHICLE.wheelMountHeight - CFG.VEHICLE.suspensionRest + this.wheelComp[wheel.contact];
      wheel.pivot.rotation.y = wheel.front ? this.steer * CFG.VEHICLE.steerMax : 0;
      wheel.spin.rotation.x = -this.wheelSpin;
    }
    this.model.steering.rotation.z = -this.steer * 1.7;
    this.model.mats.rearLamp.emissiveIntensity = this.braking ? 1.4 : .15;
    const wreck = this.health <= 0;
    this.model.mats.paint.color.setHex(wreck ? 0x343b33 : this.model.group.name === 'vehicle_truck' ? 0x606d53 : 0x7b8062);
    this.model.mats.lamp.emissiveIntensity = wreck ? 0 : .22;
  }

  dispose() {
    this.model.dispose();
  }
}
