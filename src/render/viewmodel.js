// First-person weapon view model: per-weapon silhouette, ADS transition,
// sway, walk bob, recoil kick and reload animation. Attached to the camera.
import * as THREE from 'three';
import { CFG } from '../../shared/config.js';
import { clamp, damp } from '../../shared/math.js';

const PROFILES = {
  pistol:   { len: 0.26, body: 0x2a2d31, wood: 0x3a2f26, mag: 0.12, sight: false, scale: 0.85 },
  smg:      { len: 0.42, body: 0x26292d, wood: 0x2f3236, mag: 0.22, sight: true, scale: 0.95 },
  ar:       { len: 0.56, body: 0x22262a, wood: 0x3d3a32, mag: 0.26, sight: true, scale: 1.0 },
  dmr:      { len: 0.62, body: 0x2b2f33, wood: 0x3b3229, mag: 0.24, sight: true, scale: 1.0 },
  shotgun:  { len: 0.58, body: 0x2a2622, wood: 0x6b4a2c, mag: 0.18, sight: false, scale: 1.05 },
  sniper:   { len: 0.74, body: 0x25292c, wood: 0x3a3d35, mag: 0.2, sight: true, scale: 1.05 },
  lmg:      { len: 0.66, body: 0x23272b, wood: 0x35383c, mag: 0.34, sight: true, scale: 1.1 },
};

export class ViewModel {
  constructor(camera, scene) {
    this.camera = camera;
    this.root = new THREE.Group();
    this.root.name = 'viewmodel';
    this.root.position.set(0.24, -0.22, -0.5);
    this.camera.add(this.root);
    scene.add(camera);
    this.gun = new THREE.Group();
    this.root.add(this.gun);
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
      body: new THREE.MeshStandardMaterial({ color: 0x24282c, roughness: 0.42, metalness: 0.72 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x5a4229, roughness: 0.75, metalness: 0.05 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x141618, roughness: 0.5, metalness: 0.5 }),
      accent: new THREE.MeshStandardMaterial({ color: 0xf2b63a, roughness: 0.4, metalness: 0.3, emissive: 0x3a2a08 }),
    };
    this.build('ar');
  }

  build(key) {
    if (this.weapon === key) return;
    this.weapon = key;
    const P = PROFILES[key] || PROFILES.ar;
    while (this.gun.children.length) {
      const c = this.gun.children.pop();
      c.geometry?.dispose();
    }
    const add = (w, h, d, x, y, z, mat = 'body') => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this._mats[mat]);
      m.position.set(x, y, z);
      m.castShadow = false; m.receiveShadow = false;
      this.gun.add(m);
      return m;
    };
    const L = P.len;
    add(0.06, 0.085, L, 0, 0, -L / 2 + 0.04);
    add(0.028, 0.028, L * 0.55, 0, 0.008, -L * 0.78);
    add(0.052, 0.075, L * 0.32, 0, -0.055, L * 0.18, 'wood');
    add(0.05, 0.15, 0.07, 0, -0.11, -L * 0.16, 'dark');
    add(0.055, 0.11, P.mag, 0, -0.12, -L * 0.34, 'dark');
    add(0.02, 0.045, 0.02, 0, 0.075, -L * 0.42, 'dark');
    if (P.sight) {
      add(0.035, 0.035, 0.1, 0, 0.075, -L * 0.42, 'dark');
      add(0.012, 0.012, 0.012, 0, 0.09, -L * 0.47, 'accent');
    } else {
      add(0.008, 0.02, 0.01, 0, 0.062, -L * 0.88, 'accent');
    }
    add(0.05, 0.05, 0.16, 0, -0.02, L * 0.38, 'body');
    this.gun.scale.setScalar(P.scale);
    this.basePos = new THREE.Vector3(0.24, -0.22, -0.5);
    this.adsPos = new THREE.Vector3(0, -0.115, -0.36);
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
    const px = hip.x + (aim.x - hip.x) * this.ads + bx + this.swayX;
    const py = hip.y + (aim.y - hip.y) * this.ads + by + this.swayY;
    const pz = hip.z + (aim.z - hip.z) * this.ads + this.kick * 0.055;
    this.root.position.set(px, py, pz);

    let rx = this.kick * 0.12 + this.swayY * 2.4;
    let ry = this.kickYaw + this.swayX * 2.2;
    let rz = 0;

    // reload: drop and rotate the weapon out of frame
    if (reloadT > 0) {
      const w = ctx.weapon ? CFG.WEAPONS[ctx.weapon] : null;
      const dur = w?.reload || 2;
      const t = 1 - clamp(reloadT / dur, 0, 1);
      const s = Math.sin(Math.min(1, t * 1.6) * Math.PI);
      rx += s * 0.55;
      ry += s * 0.35;
      rz += s * 0.5;
      this.root.position.y -= s * 0.12;
    }
    if (switchT > 0) {
      const s = clamp(switchT / 0.5, 0, 1);
      this.root.position.y -= s * 0.28;
      rx += s * 0.5;
    }
    this.root.rotation.set(rx, ry, rz);
    this.root.visible = !ctx.hide;
  }

  muzzleWorld() {
    const v = new THREE.Vector3(0, 0.01, -(this.weapon ? (PROFILES[this.weapon]?.len || 0.5) * 1.1 : 0.5));
    this.gun.localToWorld(v);
    return v;
  }
}
