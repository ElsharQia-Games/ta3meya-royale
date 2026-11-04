// First-person weapon view model: per-weapon silhouette, ADS transition,
// sway, walk bob, recoil kick and reload animation. Attached to the camera.
import * as THREE from 'three';
import { CFG } from '../../shared/config.js';
import { clamp, damp } from '../../shared/math.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { createWeaponModel, poseWeaponMechanics } from './weapon-model.js';
import { solveTwoBone } from './animation.js';
import { texture } from './textures.js';

const UP = new THREE.Vector3(0, 1, 0);

export class ViewModel {
  constructor(camera, scene, renderer = null) {
    this.camera = camera;
    this.renderer = renderer;
    this.root = new THREE.Group();
    this.root.name = 'viewmodel';
    this.root.position.set(0.24, -0.22, -0.5);
    this.camera.add(this.root);
    this.armsRoot = new THREE.Group(); this.armsRoot.name = 'first_person_arms';
    this.armsRoot.visible = false; camera.add(this.armsRoot);
    scene.add(camera);
    this.gun = null;
    this.model = null;
    this.weapon = null;
    this.kick = 0;
    this.kickYaw = 0;
    this.shotT = Infinity;
    this.bob = 0;
    this.swayX = 0; this.swayY = 0;
    this.reload = 0;
    this.switchT = 0;
    this.ads = 0;
    this.lastLook = [0, 0];
    this._mats = {
      sleeve: new THREE.MeshStandardMaterial({ color: 0x768266, map: texture('fabric'), roughness: .95 }),
      glove: new THREE.MeshStandardMaterial({ color: 0x414c3c, roughness: .87 }),
      trim: new THREE.MeshStandardMaterial({ color: 0x222f29, roughness: .65 }),
    };
    this.arms = [this.makeArm(-1), this.makeArm(1)];
    this.renderer?.registerObject(this.armsRoot);
    this.build('ar');
  }

  build(key) {
    if (this.weapon === key) return;
    this.model?.dispose();
    this.weapon = key;
    this.model = createWeaponModel(key, true);
    this.gun = this.model.root;
    this.root.add(this.gun);
    this.renderer?.registerObject(this.root);
    this.basePos = new THREE.Vector3(key === 'pistol' ? .16 : .2, -.215, key === 'pistol' ? -.42 : -.4);
    this.adsPos = new THREE.Vector3(0, -this.model.profile.sightY, key === 'pistol' ? -.37 : -.32);
  }

  makeArm(side) {
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(.055, .068, 1, 16), this._mats.sleeve);
    const lower = new THREE.Mesh(new THREE.CylinderGeometry(.037, .055, 1, 16), this._mats.sleeve);
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(.056, 14, 9), this._mats.sleeve);
    const hand = new THREE.Group();
    hand.name = side < 0 ? 'support_hand' : 'trigger_hand';
    const palm = new THREE.Mesh(new RoundedBoxGeometry(.07, .065, .092, 1, .018), this._mats.glove);
    hand.add(palm);
    for (let i = 0; i < 4; i++) {
      const finger = new THREE.Mesh(new RoundedBoxGeometry(.012, .045, .048, 1, .005), this._mats.glove);
      finger.position.set(-.023 + i * .015, .011, -.043); hand.add(finger);
    }
    const strap = new THREE.Mesh(new RoundedBoxGeometry(.076, .015, .08, 1, .004), this._mats.trim);
    strap.position.set(0, -.025, .015); hand.add(strap);
    this.armsRoot.add(upper, lower, elbow, hand);
    return { side, upper, lower, elbow, hand };
  }

  poseArm(arm, target) {
    const shoulder = arm.side < 0 ? [-.2, -.28, -.05] : [.23, -.28, -.015];
    const pole = [arm.side * .55, -.53, -.12];
    const pose = solveTwoBone(shoulder, target.toArray(), pole, .39, .39);
    const start = new THREE.Vector3(...shoulder), elbow = new THREE.Vector3(...pose.elbow), end = new THREE.Vector3(...pose.hand);
    const place = (mesh, a, b) => {
      const dir = new THREE.Vector3().subVectors(b, a);
      mesh.position.copy(a).add(b).multiplyScalar(.5);
      mesh.scale.y = dir.length();
      mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
    };
    place(arm.upper, start, elbow); place(arm.lower, elbow, end);
    arm.elbow.position.copy(elbow); arm.hand.position.copy(end);
    arm.hand.quaternion.copy(this.root.quaternion).multiply(new THREE.Quaternion().setFromEuler(
      new THREE.Euler(arm.side < 0 ? -.35 : -.1, arm.side < 0 ? -.2 : .12, arm.side < 0 ? .45 : -.1)));
    arm.reachable = pose.reachable;
  }

  fire(strength = 1) {
    this.shotT = 0;
    this.kick = Math.min(1.4, this.kick + 0.55 * strength);
    this.kickYaw += (Math.random() - 0.5) * 0.05 * strength;
  }

  update(dt, ctx) {
    const { speed, grounded, ads, lookDX, lookDY, reloadT, switchT, moving } = ctx;
    if (ctx.weapon && ctx.weapon !== this.weapon) this.build(ctx.weapon);
    this.shotT += dt;
    const targetAds = ads && reloadT <= 0 && !ctx.healT ? 1 : 0;
    this.ads = damp(this.ads, targetAds, 16, dt);
    this.kick = damp(this.kick, 0, 12, dt);
    this.kickYaw = damp(this.kickYaw, 0, 12, dt);

    // walk bob
    this.bob += dt * (4 + speed * 1.5);
    const bobAmt = grounded ? clamp(speed / CFG.PLAYER.SPRINT, 0, 1) : 0.2;
    const bx = Math.sin(this.bob) * 0.012 * bobAmt;
    const by = Math.abs(Math.cos(this.bob)) * 0.011 * bobAmt;
    // sway follows the look velocity, lagging slightly
    this.swayX = damp(this.swayX, clamp(-lookDX * 0.0012, -0.03, 0.03), 8, dt);
    this.swayY = damp(this.swayY, clamp(-lookDY * 0.0012, -0.03, 0.03), 8, dt);

    const hip = this.basePos || new THREE.Vector3(0.24, -0.22, -0.5);
    const aim = this.adsPos || new THREE.Vector3(0, -0.115, -0.36);
    const free = 1 - this.ads;
    const px = hip.x + (aim.x - hip.x) * this.ads + (bx + this.swayX) * free;
    const py = hip.y + (aim.y - hip.y) * this.ads + (by + this.swayY) * free;
    const pz = hip.z + (aim.z - hip.z) * this.ads + this.kick * 0.055;
    this.root.position.set(px, py, pz);
    if (ctx.swimming) this.root.position.y += .12 * (1 - this.ads);

    let rx = this.kick * 0.09 + this.swayY * 2.4 * free;
    let ry = this.kickYaw + this.swayX * 2.2 * free;
    let rz = 0;

    const { motion, support } = poseWeaponMechanics(this.model, reloadT, this.shotT, ctx.mag || 0);
    this.reloadStage = motion.stage;
    if (this.model.reticle) this.model.reticle.visible = this.ads > .6;

    // Magazine out -> replacement in -> settle. The pose is derived solely
    // from authoritative reload time; it never changes ammunition itself.
    if (motion.active) {
      rx += motion.lift * .14; ry += motion.lift * .48; rz += motion.lift * .38;
      this.root.position.y += motion.lift * .23;
      this.root.position.x -= motion.lift * .04;
      this.root.position.z -= motion.lift * .08;
    }
    if (switchT > 0) {
      const s = clamp(switchT / (CFG.WEAPONS[this.weapon]?.switchTime || .5), 0, 1);
      this.root.position.y -= s * 0.28;
      rx += s * 0.5;
    }
    if (ctx.healT > 0) { this.root.position.y -= .28; rx += .4; }
    this.root.rotation.set(rx, ry, rz);
    this.root.updateMatrix();
    this.poseArm(this.arms[0], support.applyMatrix4(this.root.matrix));
    this.poseArm(this.arms[1], this.model.rightGrip.position.clone().applyMatrix4(this.root.matrix));
    this.root.visible = !ctx.hide;
    this.armsRoot.visible = this.root.visible;
  }

  drive(vehicle) {
    this.root.visible = false; this.armsRoot.visible = true;
    for (const arm of this.arms) {
      const grip = vehicle.model.steering.localToWorld(new THREE.Vector3(arm.side * .155, .035, 0));
      this.poseArm(arm, this.camera.worldToLocal(grip));
      const rotation = this.camera.getWorldQuaternion(new THREE.Quaternion()).invert()
        .multiply(vehicle.model.steering.getWorldQuaternion(new THREE.Quaternion()));
      arm.hand.quaternion.copy(rotation);
    }
  }

  muzzleWorld() {
    this.root.updateWorldMatrix(true, true);
    return this.model.muzzle.getWorldPosition(new THREE.Vector3());
  }

  dispose() {
    this.model?.dispose();
    this.root.traverse(o => o.geometry?.dispose());
    this.armsRoot.traverse(o => o.geometry?.dispose());
    Object.values(this._mats).forEach(m => m.dispose());
    this.root.removeFromParent();
    this.armsRoot.removeFromParent();
  }
}
