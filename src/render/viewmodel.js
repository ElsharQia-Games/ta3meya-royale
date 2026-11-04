// First-person weapon view model: per-weapon silhouette, ADS transition,
// sway, walk bob, recoil kick and reload animation. Attached to the camera.
import * as THREE from 'three';
import { CFG } from '../../shared/config.js';
import { clamp, damp } from '../../shared/math.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { createWeaponModel } from './weapon-model.js';
import { solveTwoBone } from './animation.js';

const UP = new THREE.Vector3(0, 1, 0);
const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

export class ViewModel {
  constructor(camera, scene, renderer = null) {
    this.camera = camera;
    this.renderer = renderer;
    this.root = new THREE.Group();
    this.root.name = 'viewmodel';
    this.root.position.set(0.24, -0.22, -0.5);
    this.camera.add(this.root);
    scene.add(camera);
    this.gun = null;
    this.model = null;
    this.weapon = null;
    this.kick = 0;
    this.kickYaw = 0;
    this.bob = 0;
    this.swayX = 0; this.swayY = 0;
    this.reload = 0;
    this.switchT = 0;
    this.ads = 0;
    this.lastLook = [0, 0];
    this._mats = {
      sleeve: new THREE.MeshStandardMaterial({ color: 0x657056, roughness: .95 }),
      glove: new THREE.MeshStandardMaterial({ color: 0x414c3c, roughness: .87 }),
      trim: new THREE.MeshStandardMaterial({ color: 0x222f29, roughness: .65 }),
    };
    this.arms = [this.makeArm(-1), this.makeArm(1)];
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
    this.basePos = new THREE.Vector3(key === 'pistol' ? .2 : .27, -.24, key === 'pistol' ? -.55 : -.68);
    this.adsPos = new THREE.Vector3(0, -this.model.profile.sightY, -.55);
  }

  makeArm(side) {
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(.072, .087, 1, 10), this._mats.sleeve);
    const lower = new THREE.Mesh(new THREE.CylinderGeometry(.053, .07, 1, 10), this._mats.sleeve);
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(.071, 10, 6), this._mats.sleeve);
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
    this.root.add(upper, lower, elbow, hand);
    return { side, upper, lower, elbow, hand };
  }

  poseArm(arm, target) {
    const shoulder = arm.side < 0 ? [-.25, -.39, .22] : [.28, -.35, .26];
    const pole = [arm.side * .6, -.5, -.08];
    const pose = solveTwoBone(shoulder, target.toArray(), pole, .38, .38);
    const start = new THREE.Vector3(...shoulder), elbow = new THREE.Vector3(...pose.elbow), end = new THREE.Vector3(...pose.hand);
    const place = (mesh, a, b) => {
      const dir = new THREE.Vector3().subVectors(b, a);
      mesh.position.copy(a).add(b).multiplyScalar(.5);
      mesh.scale.y = dir.length();
      mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
    };
    place(arm.upper, start, elbow); place(arm.lower, elbow, end);
    arm.elbow.position.copy(elbow); arm.hand.position.copy(end);
    arm.hand.rotation.set(arm.side < 0 ? -.35 : -.1, arm.side < 0 ? -.2 : .12, arm.side < 0 ? .45 : -.1);
  }

  fire(strength = 1) {
    this.kick = Math.min(1.4, this.kick + 0.55 * strength);
    this.kickYaw += (Math.random() - 0.5) * 0.05 * strength;
  }

  update(dt, ctx) {
    const { speed, grounded, ads, lookDX, lookDY, reloadT, switchT, moving } = ctx;
    if (ctx.weapon && ctx.weapon !== this.weapon) this.build(ctx.weapon);
    const targetAds = ads ? 1 : 0;
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
    const free = 1 - this.ads * .96;
    const px = hip.x + (aim.x - hip.x) * this.ads + (bx + this.swayX) * free;
    const py = hip.y + (aim.y - hip.y) * this.ads + (by + this.swayY) * free;
    const pz = hip.z + (aim.z - hip.z) * this.ads + this.kick * 0.055;
    this.root.position.set(px, py, pz);

    let rx = this.kick * 0.09 + this.swayY * 2.4 * free;
    let ry = this.kickYaw + this.swayX * 2.2 * free;
    let rz = 0;

    const support = this.model.leftGrip.position.clone();
    this.model.magazine.position.copy(this.model.magRest);
    this.model.magazine.rotation.set(0, 0, 0);
    this.model.magazine.visible = this.weapon !== 'shotgun';
    if (this.model.reticle) this.model.reticle.visible = this.ads > .6;
    if (this.weapon === 'pistol') this.model.slide.position.z = this.kick * .025;

    // Magazine out -> replacement in -> settle. The pose is derived solely
    // from authoritative reload time; it never changes ammunition itself.
    if (reloadT > 0) {
      const w = ctx.weapon ? CFG.WEAPONS[ctx.weapon] : null;
      const dur = w?.reload || 2;
      const t = 1 - clamp(reloadT / dur, 0, 1);
      const s = Math.sin(t * Math.PI);
      rx += s * .16; ry += s * .25; rz += s * .38;
      this.root.position.y += s * .065;
      const handToMag = smooth(t / .17) * (1 - smooth((t - .81) / .19));
      const extract = smooth((t - .15) / .23) * (1 - smooth((t - .56) / .25));
      if (this.weapon !== 'shotgun') {
        this.model.magazine.position.y -= extract * .23;
        this.model.magazine.rotation.z = extract * -.18;
        support.lerp(this.model.magazine.position.clone().add(new THREE.Vector3(-.025, -.045, .015)), handToMag);
      } else {
        support.y -= .035 + Math.sin(t * Math.PI * 4) * .035;
        support.z += .12 * s;
      }
    }
    if (switchT > 0) {
      const s = clamp(switchT / 0.5, 0, 1);
      this.root.position.y -= s * 0.28;
      rx += s * 0.5;
    }
    this.root.rotation.set(rx, ry, rz);
    this.poseArm(this.arms[0], support);
    this.poseArm(this.arms[1], this.model.rightGrip.position);
    this.root.visible = !ctx.hide;
  }

  muzzleWorld() {
    this.root.updateWorldMatrix(true, true);
    return this.model.muzzle.getWorldPosition(new THREE.Vector3());
  }
}
