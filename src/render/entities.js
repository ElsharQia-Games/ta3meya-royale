// Dynamic entities: player characters, nameplates and vehicles.
import * as THREE from 'three';
import { CFG, STANCE, TEAMS } from '../../shared/config.js';
import { lerpAngle, clamp, damp } from '../../shared/math.js';
import { stanceHeight } from '../../shared/physics.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { createWeaponModel } from './weapon-model.js';
import { solveTwoBone } from './animation.js';
import { texture } from './textures.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const SKIN = [0xc99a72, 0x9c6b4a, 0x6f4a32, 0xe0b48c, 0x8a5a3c];
const UNIFORM = [0x737961, 0x80765d, 0x60746c, 0x807763];

function part(geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function batchStaticParts(group) {
  for (const child of [...group.children]) if (child.isGroup) batchStaticParts(child);
  if (group.userData.articulated) return;
  const byMaterial = new Map();
  for (const child of group.children) {
    if (!child.isMesh) continue;
    const list = byMaterial.get(child.material) || [];
    list.push(child); byMaterial.set(child.material, list);
  }
  for (const [material, parts] of byMaterial) {
    if (parts.length < 2) continue;
    const geometries = parts.map(p => {
      p.updateMatrix();
      const g = p.geometry.index ? p.geometry.toNonIndexed() : p.geometry.clone();
      return g.applyMatrix4(p.matrix);
    });
    const merged = mergeGeometries(geometries, false);
    geometries.forEach(g => g.dispose());
    parts.forEach(p => { p.removeFromParent(); p.geometry.dispose(); });
    const result = part(merged, material, 0, 0, 0);
    result.name = 'batched_kit'; group.add(result);
  }
}

function makeCharacter(color, skin) {
  const root = new THREE.Group();
  root.rotation.order = 'YXZ';
  const cloth = new THREE.MeshStandardMaterial({ color, map: texture('fabric'), roughness: 0.9 });
  const vestMat = new THREE.MeshStandardMaterial({ color: 0x4c5742, roughness: 0.85 });
  const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.7 });
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x303a2d, roughness: 0.9 });
  const helmetMat = new THREE.MeshStandardMaterial({ color: 0x657056, roughness: 0.72, metalness: 0.15 });
  const lensMat = new THREE.MeshStandardMaterial({ color: 0x263f37, roughness: .16, metalness: .7 });
  const strapMat = new THREE.MeshStandardMaterial({ color: 0x9b9674, roughness: .95 });
  const teamMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, emissiveIntensity: 0.08 });
  const rounded = (w, h, d, mat, x, y, z, radius = .025) => part(new RoundedBoxGeometry(w, h, d, 1, radius), mat, x, y, z);

  const hips = new THREE.Group();
  hips.position.y = 0.92;
  root.add(hips);

  const torso = new THREE.Group();
  hips.add(torso);
  torso.add(rounded(.4, .55, .26, cloth, 0, .24, 0, .07));
  torso.add(rounded(.42, .41, .31, vestMat, 0, .28, 0));
  torso.add(rounded(.33, .19, .26, cloth, 0, -.025, 0, .05));
  const pack = rounded(.31, .37, .19, vestMat, 0, .28, .235);
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
  head.position.y = 0.62;
  torso.add(head);
  const face = part(new THREE.SphereGeometry(.143, 14, 10), skinMat, 0, 0, 0);
  face.scale.set(.91, 1.03, .96); head.add(face);
  const helmet = part(new THREE.SphereGeometry(0.19, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), helmetMat, 0, 0.02, 0);
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
    const upper = part(new THREE.CylinderGeometry(.077, .088, 1, 9), cloth, 0, 0, 0);
    const lower = part(new THREE.CylinderGeometry(.05, .065, 1, 9), cloth, 0, 0, 0);
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
    knee.add(rounded(.17, .14, .29, bootMat, 0, -.41, -.045, .025));
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
  constructor(scene, id, world = null) {
    this.scene = scene;
    this.world = world;
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
    this.name = p.name || this.name;
    if (p.team !== undefined && p.team !== this.team) this.setTeam(p.team);
    this.hp = p.hp;
  }

  update(dt, cameraPos) {
    const m = this.model;
    const r = m.root;
    const prone = this.stance === STANCE.PRONE;
    const crouch = this.stance === STANCE.CROUCH;

    r.position.set(this.pos[0], this.pos[1], this.pos[2]);
    r.rotation.y = this.yaw;
    const plateY = prone ? .75 : crouch ? 1.42 : 2.0;
    this.plateY = damp(this.plateY ?? plateY, plateY, 12, dt);
    this.plate.sprite.position.set(this.pos[0], this.pos[1] + this.plateY, this.pos[2]);
    this.plate.update(this.name || '', this.team, this.hp ?? 100, 100, !this.alive);

    if (!this.alive) {
      this.deathT = Math.min(1, this.deathT + dt * 2.2);
      // Rotate around the feet, then lift enough that the horizontal torso and
      // pack do not sink through the terrain. The rifle is dropped: while the
      // body tips forward its muzzle would sweep ~0.9 m below the feet.
      r.rotation.x = 0;
      r.rotation.z = this.deathT * Math.PI * .48;
      r.position.y = this.pos[1] + this.deathT * .35;
      if (this.world) {
        r.updateWorldMatrix(true, true);
        let lift = 0;
        for (const node of [m.head, m.hips, m.kneeL, m.kneeR]) {
          const at = node.getWorldPosition(new THREE.Vector3());
          lift = Math.max(lift, this.world.terrainHeight(at.x, at.z) + .14 - at.y);
        }
        r.position.y += lift;
      }
      m.gun.visible = false;
      this.plate.sprite.visible = false;
      return;
    }
    this.deathT = 0;
    r.rotation.x = 0;
    r.rotation.z = 0;
    m.gun.visible = true;
    this.plate.sprite.visible = true;

    // Stance: lower the hips and fold the knees so the boots stay on the
    // ground; prone folds the whole body down and extends the legs behind it.
    const targetHip = prone ? .34 : crouch ? .54 : .94;
    m.hips.position.y = damp(m.hips.position.y, targetHip, 12, dt);
    m.torso.position.y = damp(m.torso.position.y, prone ? -.15 : crouch ? -.18 : 0, 12, dt);
    m.torso.rotation.x = damp(m.torso.rotation.x,
      prone ? -1.28 : crouch ? .32 : clamp(this.pitch * .2, -.2, .2), 10, dt);
    m.torso.rotation.z = 0;

    // Walk cycle from horizontal velocity estimate.
    const speed = Math.hypot(this.vx || 0, this.vz || 0);
    this.walk += dt * (2.2 + speed * 1.35);
    const swing = Math.min(1, speed / 5) * 0.62;
    let thighL = Math.sin(this.walk) * swing;
    let thighR = -Math.sin(this.walk) * swing;
    let shin = 0;
    if (crouch) {
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
    m.head.rotation.x = damp(m.head.rotation.x, prone ? 0.9 : -this.pitch * 0.55, 10, dt);
    // Keep the rifle level in prone: the torso is pitched ~73 degrees forward,
    // so an unrotated gun would point its muzzle into the terrain.
    m.gun.rotation.x = damp(m.gun.rotation.x, prone ? 1.28 : 0, 10, dt);
    m.gun.position.y = .31 + Math.sin(this.walk * .7) * .003;
    m.gun.updateMatrix();
    for (const arm of m.arms) {
      const anchor = arm.side < 0 ? m.weapon.leftGrip : m.weapon.rightGrip;
      const target = anchor.position.clone().applyMatrix4(m.gun.matrix);
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
      arm.hand.rotation.x = prone ? 1.28 : 0;
    }

    // Hide our own body and nameplate from the first-person camera by distance.
    // This also prevents the spectated player's nameplate from covering the
    // screen when the camera sits at their eye.
    const d = cameraPos ? Math.hypot(cameraPos[0] - this.pos[0], cameraPos[2] - this.pos[2]) : 99;
    const d3 = cameraPos
      ? Math.hypot(cameraPos[0] - this.pos[0], cameraPos[1] - (this.pos[1] + this.plateY), cameraPos[2] - this.pos[2])
      : 99;
    // Keep the plate at a readable on-screen size out to 40 m. The base sprite
    // is ~5.6 px tall at 40 m with size attenuation, so scale up with distance
    // and cap the growth to avoid giant plates in the far field.
    const plateHeight = clamp(d3 * .032, .15, 1.45);
    this.plate.sprite.scale.set(plateHeight * 4, plateHeight, 1);
    r.visible = d > 0.9;
    this.plate.sprite.visible = this.alive && d3 > 1.6;
  }

  dispose() {
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
function makeVehicle(type) {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({
    color: type === 'truck' ? 0x4e5a4a : 0x6b4a3a, roughness: 0.55, metalness: 0.45,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24272a, roughness: 0.8, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fc3d6, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.5 });
  const wheels = [];

  if (type === 'truck') {
    g.add(part(new THREE.BoxGeometry(2.2, 1.1, 5.6), paint, 0, 0.95, 0));
    g.add(part(new THREE.BoxGeometry(2.15, 1.5, 1.8), paint, 0, 1.6, -1.75));
    g.add(part(new THREE.BoxGeometry(1.9, 0.6, 0.06), glass, 0, 1.85, -2.66));
    g.add(part(new THREE.BoxGeometry(2.3, 1.6, 3.2), dark, 0, 1.55, 0.9));
  } else {
    g.add(part(new THREE.BoxGeometry(1.9, 0.72, 4.2), paint, 0, 0.72, 0));
    g.add(part(new THREE.BoxGeometry(1.75, 0.66, 1.9), paint, 0, 1.28, 0.1));
    g.add(part(new THREE.BoxGeometry(1.6, 0.5, 0.06), glass, 0, 1.34, -0.85));
    g.add(part(new THREE.BoxGeometry(1.6, 0.5, 0.06), glass, 0, 1.34, 1.06));
    g.add(part(new THREE.BoxGeometry(0.06, 0.44, 1.4), glass, -0.88, 1.32, 0.1));
    g.add(part(new THREE.BoxGeometry(0.06, 0.44, 1.4), glass, 0.88, 1.32, 0.1));
  }
  // headlights
  const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff2c4, emissive: 0xffe6a0, emissiveIntensity: 1.2 });
  const front = type === 'truck' ? -2.75 : -2.08;
  g.add(part(new THREE.BoxGeometry(0.34, 0.2, 0.06), lightMat, -0.7, 0.9, front));
  g.add(part(new THREE.BoxGeometry(0.34, 0.2, 0.06), lightMat, 0.7, 0.9, front));

  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 12);
  wheelGeo.rotateZ(Math.PI / 2);
  const positions = type === 'truck'
    ? [[-1.05, 0.42, -1.7], [1.05, 0.42, -1.7], [-1.05, 0.42, 1.8], [1.05, 0.42, 1.8]]
    : [[-0.92, 0.42, -1.35], [0.92, 0.42, -1.35], [-0.92, 0.42, 1.35], [0.92, 0.42, 1.35]];
  for (const p of positions) {
    const w = part(wheelGeo, dark, p[0], p[1], p[2]);
    wheels.push(w);
    g.add(w);
  }
  return { group: g, wheels };
}

export class VehicleView {
  constructor(scene, id, type) {
    this.scene = scene;
    this.id = id;
    const { group, wheels } = makeVehicle(type);
    this.group = group;
    this.wheels = wheels;
    scene.add(group);
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
    this.speed = v.speed || 0;
    this.health = v.health ?? 100;
  }

  update(dt) {
    const k = 1 - Math.exp(-14 * dt);
    this.pos[0] += (this.target[0] - this.pos[0]) * k;
    this.pos[1] += (this.target[1] - this.pos[1]) * k;
    this.pos[2] += (this.target[2] - this.pos[2]) * k;
    this.yaw = lerpAngle(this.yaw, this.targetYaw, k);
    this.group.position.set(this.pos[0], this.pos[1], this.pos[2]);
    this.group.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
    this.wheelSpin += this.speed * dt / 0.42;
    for (const w of this.wheels) w.rotation.x = this.wheelSpin;
  }

  dispose() {
    this.scene.remove(this.group);
  }
}
