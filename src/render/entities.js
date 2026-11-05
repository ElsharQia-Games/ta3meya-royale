// Dynamic entities: player characters, nameplates and vehicles.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CFG, STANCE, TEAMS } from '../../shared/config.js';
import { lerpAngle, clamp, damp } from '../../shared/math.js';
import { stanceHeight, supportHeight } from '../../shared/physics.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { createWeaponModel, poseWeaponMechanics } from './weapon-model.js';
import { solveTwoBone } from './animation.js';
import { texture } from './textures.js';
import { batchStaticParts } from './geometry.js';
import { createVehicleModel } from './vehicle-model.js';
import { smokeObscures } from '../../shared/visibility.js';
import { DeathAnimation } from './death-animation.js';
import { torsoGeometry, carrierPlate, headGeometry } from './character-shapes.js';
import { prepareStaticGeometry } from './world.js';

const SKIN = [0xc99a72, 0x9c6b4a, 0x6f4a32, 0xe0b48c, 0x8a5a3c];
const UNIFORM = [0x737961, 0x80765d, 0x60746c, 0x807763];

const _armA = new THREE.Vector3();
const _armB = new THREE.Vector3();
const _armC = new THREE.Vector3();
const _armDelta = new THREE.Vector3();
const _armUp = new THREE.Vector3(0, 1, 0);
const _armTargetArray = [0, 0, 0];
const _armPoleArray = [0, 0, 0];
const _armPose = { elbow: [0, 0, 0], hand: [0, 0, 0], reachable: false };

function placeBone(mesh, from, to) {
  _armDelta.subVectors(to, from);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.scale.y = _armDelta.length();
  _armDelta.normalize();
  mesh.quaternion.setFromUnitVectors(_armUp, _armDelta);
}

function part(geo, mat, x, y, z, castShadow = false) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = castShadow;
  m.receiveShadow = true;
  m.userData.primaryShadowCaster = castShadow;
  return m;
}

function makeCharacter(color, skin) {
  const root = new THREE.Group();
  root.name = 'character_model';
  root.rotation.order = 'YXZ';
  const cloth = new THREE.MeshStandardMaterial({ color, map: texture('fabric'), bumpMap: texture('webbing'), bumpScale: .004, roughness: .96 });
  const vestMat = new THREE.MeshStandardMaterial({ color: 0x74806b, map: texture('webbing'), roughness: .94 });
  const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.7 });
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x303a2d, roughness: 0.9 });
  const helmetMat = new THREE.MeshStandardMaterial({ color: 0x657056, roughness: 0.72, metalness: 0.15 });
  const lensMat = new THREE.MeshStandardMaterial({ color: 0x4c5b43, roughness: .12, metalness: .8 });
  const strapMat = new THREE.MeshStandardMaterial({ color: 0x747c66, map: texture('webbing'), roughness: .97 });
  const teamMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, emissiveIntensity: 0.08 });
  const rounded = (w, h, d, mat, x, y, z, radius = .025, castShadow = false) => part(new RoundedBoxGeometry(w, h, d, 2, radius), mat, x, y, z, castShadow);

  const hips = new THREE.Group();
  hips.position.y = 0.92;
  root.add(hips);

  const torso = new THREE.Group();
  hips.add(torso);

  const torsoGeos = [];
  const addTorso = (geo, hex) => {
    torsoGeos.push(prepareStaticGeometry(geo, new THREE.Color(hex)));
    geo.dispose();
  };

  addTorso(torsoGeometry(), color);
  const p1 = carrierPlate(); p1.translate(0, .075, -.176); addTorso(p1, 0x74806b);
  const p2 = carrierPlate(); p2.translate(0, .075, .137); addTorso(p2, 0x74806b);
  for (const side of [-1, 1]) {
    const g = new RoundedBoxGeometry(.037, .19, .23, 2, .01); g.translate(side * .187, .23, 0); addTorso(g, 0x74806b);
  }
  const tLow = new RoundedBoxGeometry(.33, .19, .26, 2, .05); tLow.translate(0, -.025, 0); addTorso(tLow, color);
  const pack = new RoundedBoxGeometry(.27, .34, .14, 2, .055); pack.translate(0, .28, .222); addTorso(pack, 0x74806b);
  const tMid = new RoundedBoxGeometry(.22, .11, .045, 2, .025); tMid.translate(0, .18, .31); addTorso(tMid, color);
  for (const side of [-1, 1]) {
    const s1 = new RoundedBoxGeometry(.035, .43, .021, 2, .004); s1.translate(side * .158, .3, -.17); addTorso(s1, 0x747c66);
    const s2 = new RoundedBoxGeometry(.027, .29, .018, 2, .004); s2.translate(side * .095, .32, .3); addTorso(s2, 0x747c66);
    const pch = new RoundedBoxGeometry(.095, .16, .095, 2, .014); pch.translate(side * .23, .07, .02); addTorso(pch, 0x74806b);
  }
  for (let i = 0; i < 3; i++) {
    const mag = new RoundedBoxGeometry(.105, .15, .065, 2, .012); mag.translate(-.12 + i * .12, .17, -.198); addTorso(mag, 0x657056);
    const mst = new RoundedBoxGeometry(.087, .025, .07, 2, .005); mst.translate(-.12 + i * .12, .242, -.2); addTorso(mst, 0x747c66);
  }
  const belt = new RoundedBoxGeometry(.36, .047, .29, 2, .006); belt.translate(0, .006, 0); addTorso(belt, 0x303a2d);
  const bBuckle = new RoundedBoxGeometry(.075, .035, .023, 2, .005); bBuckle.translate(0, .006, -.16); addTorso(bBuckle, 0x747c66);
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    const ml = new RoundedBoxGeometry(.053, .015, .011, 2, .004); ml.translate(-.119 + col * .079, .295 + row * .035, -.188); addTorso(ml, 0x747c66);
  }
  const rad = new RoundedBoxGeometry(.08, .17, .06, 2, .009); rad.translate(-.19, .43, .19); addTorso(rad, 0x303a2d);
  const ant = new THREE.CylinderGeometry(.006, .006, .23, 5); ant.translate(-.19, .62, .19); addTorso(ant, 0x303a2d);

  const mergedTorso = mergeGeometries(torsoGeos, false);
  torsoGeos.forEach(g => g.dispose());
  const torsoMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture('fabric'), bumpMap: texture('webbing'), bumpScale: .004, roughness: .96, vertexColors: true });
  const torsoMesh = new THREE.Mesh(mergedTorso, torsoMat);
  torsoMesh.castShadow = true; torsoMesh.receiveShadow = true;
  torsoMesh.userData.primaryShadowCaster = true;
  torso.add(torsoMesh);

  // team patch on the chest
  torso.add(rounded(.08, .041, .014, teamMat, .1, .393, -.171, .003));
  // shoulder armbands read clearly at range
  torso.add(rounded(.06, .06, .11, teamMat, -.266, .38, 0, .009));
  torso.add(rounded(.06, .06, .11, teamMat, .266, .38, 0, .009));

  const head = new THREE.Group();
  head.position.y = .69;
  torso.add(head);

  const headGeos = [];
  const addHead = (geo, hex) => {
    headGeos.push(prepareStaticGeometry(geo, new THREE.Color(hex)));
    geo.dispose();
  };
  addHead(headGeometry(), skin);
  const helmet = new THREE.SphereGeometry(.139, 24, 16, 0, Math.PI * 2, 0, Math.PI * .57);
  helmet.scale(1, .87, 1.08); helmet.translate(0, .037, .005);
  addHead(helmet, 0x657056);
  const hVis = new RoundedBoxGeometry(.22, .014, .06, 2, .009); hVis.translate(0, .06, -.125); addHead(hVis, 0x657056);
  const hGog = new RoundedBoxGeometry(.2, .049, .034, 2, .013); hGog.translate(0, .008, -.105); addHead(hGog, 0x303a2d);
  for (const side of [-1, 1]) {
    const lens = new RoundedBoxGeometry(.082, .029, .013, 2, .01); lens.translate(side * .05, .012, -.126); addHead(lens, 0x4c5b43);
    const cup = new RoundedBoxGeometry(.029, .076, .076, 2, .013); cup.translate(side * .126, -.012, .007); addHead(cup, 0x303a2d);
    const rim = new RoundedBoxGeometry(.027, .062, .058, 2, .012); rim.translate(side * .14, -.007, .006); addHead(rim, 0x657056);
    const stp = new RoundedBoxGeometry(.012, .11, .019, 2, .005); stp.translate(side * .094, -.077, -.006); addHead(stp, 0x747c66);
    const mnt = new RoundedBoxGeometry(.017, .023, .091, 2, .006); mnt.translate(side * .135, .061, .005); addHead(mnt, 0x303a2d);
  }
  const bal = new RoundedBoxGeometry(.163, .103, .092, 2, .034); bal.translate(0, -.083, -.048); addHead(bal, color);
  const col = new THREE.CylinderGeometry(.058, .071, .105, 16); col.translate(0, -.166, .004); addHead(col, color);
  const chin = new RoundedBoxGeometry(.026, .036, .014, 2, .004); chin.translate(0, .105, -.124); addHead(chin, 0x303a2d);

  const mergedHead = mergeGeometries(headGeos, false);
  headGeos.forEach(g => g.dispose());
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72, metalness: 0.15, vertexColors: true });
  const headMesh = new THREE.Mesh(mergedHead, headMat);
  headMesh.castShadow = true; headMesh.receiveShadow = true;
  headMesh.userData.primaryShadowCaster = true;
  head.add(headMesh);

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
    leg.add(part(new THREE.CapsuleGeometry(.105, .23, 5, 12), cloth, 0, -.2, 0, true));
    leg.add(rounded(.05, .15, .13, vestMat, leg === legL ? -.1 : .1, -.17, .01, .013));
    knee.position.set(0, -0.42, 0);
    leg.add(knee);

    const kneeGeos = [];
    const addKnee = (geo, hex) => {
      kneeGeos.push(prepareStaticGeometry(geo, new THREE.Color(hex)));
      geo.dispose();
    };
    const kShin = new THREE.CapsuleGeometry(.083, .3, 5, 12); kShin.translate(0, -.2, 0); addKnee(kShin, color);
    const kPad = new RoundedBoxGeometry(.14, .12, .055, 2, .025); kPad.translate(0, -.025, -.1); addKnee(kPad, 0x303a2d);
    const kBoot = new RoundedBoxGeometry(.148, .11, .255, 2, .041); kBoot.translate(0, -.415, -.058); addKnee(kBoot, 0x303a2d);
    const kSole = new RoundedBoxGeometry(.153, .027, .265, 2, .012); kSole.translate(0, -.463, -.058); addKnee(kSole, 0x303a2d);
    const kStrap = new RoundedBoxGeometry(.11, .048, .12, 2, .019); kStrap.translate(0, -.374, -.072); addKnee(kStrap, 0x747c66);

    const mergedKnee = mergeGeometries(kneeGeos, false);
    kneeGeos.forEach(g => g.dispose());
    const kneeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, vertexColors: true });
    const kneeMesh = new THREE.Mesh(mergedKnee, kneeMat);
    kneeMesh.castShadow = true; kneeMesh.receiveShadow = true;
    kneeMesh.userData.primaryShadowCaster = true;
    knee.add(kneeMesh);
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
    this.droppedWeapon = null; this.hasWeapon = true;
    this.weaponKey = 'ar'; this.reloadT = 0; this.shotT = Infinity;
    this.inVehicle = 0; this.seat = -1; this.vehicle = null;
    this.hitKick = 0;
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: texture('contactShadow'), transparent: true, opacity: .35, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1 }));
    this.shadow.rotation.x = -Math.PI / 2; scene.add(this.shadow);
    this._hands = [new THREE.Vector3(), new THREE.Vector3()];
    this._seatedOffset = new THREE.Vector3();
    this.primaryShadowMeshes = [];
    this.model.root.traverse(o => {
      if (o.isMesh && o.userData?.primaryShadowCaster) this.primaryShadowMeshes.push(o);
    });
    this._charShadowsEnabled = true;
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
    this.deathAge = p.deathAge;
    this.name = p.name || this.name;
    if (p.team !== undefined && p.team !== this.team) this.setTeam(p.team);
    this.hp = p.hp;
    this.reloadT = p.reloadT ?? p.reload ?? 0;
    this.ads = !!(p.ads ?? p.adsing);
    this.ammo = p.mag || 0;
    if ('weapon' in p) this.hasWeapon = !!p.weapon;
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
      const offset = this._seatedOffset.set(this.seat % 2 === 0 ? .43 : -.43, .15, -forward);
      this.vehicle.group.updateWorldMatrix(true, false);
      r.position.copy(this.vehicle.group.localToWorld(offset));
      r.rotation.y = this.vehicle.yaw;
    }
    const plateY = prone ? .75 : crouch ? 1.42 : 2.0;
    this.plateY = damp(this.plateY ?? plateY, plateY, 12, dt);
    this.plate.sprite.position.set(this.pos[0], this.pos[1] + this.plateY, this.pos[2]);
    this.plate.update(this.name || '', this.team, this.hp ?? 100, 100, !this.alive);

    if (!this.alive) {
      if (!this.deathAnimation) {
        if (this.hasWeapon) {
          m.gun.updateWorldMatrix(true, true);
          const weapon = createWeaponModel(this.weaponKey, false);
          const position = m.gun.getWorldPosition(new THREE.Vector3()), rotation = m.gun.getWorldQuaternion(new THREE.Quaternion());
          this.scene.add(weapon.root); this.renderer?.registerObject(weapon.root);
          this.droppedWeapon = { weapon, position, rotation };
        }
        this.deathAnimation = new DeathAnimation(m, this.world, this.pos,
          this.death || { yaw: this.yaw, stance: this.stance }, this.id);
      }
      const delta = Number.isFinite(this.deathAge) ? Math.max(0, this.deathAge - this.deathAnimation.age) : dt;
      const hands = this.deathAnimation.update(delta);
      this.deathT = this.deathAnimation.age;
      this.updateDroppedWeapon();
      this.poseArms(hands);
      m.gun.visible = false;
      this.plate.sprite.visible = false;
      this.updateShadow();
      return;
    }
    if (this.deathAnimation) {
      this.deathAnimation.dispose(); this.deathAnimation = null; this.death = null;
      this.droppedWeapon?.weapon.dispose(); this.droppedWeapon = null;
    }
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
    for (let i = 0; i < m.arms.length; i++) {
      const arm = m.arms[i];
      const target = this._hands[i];
      if (seated && this.seat === 0) {
        target.set(arm.side * .155, .5, -.27);
      } else {
        target.copy(arm.side < 0 ? support : trigger).applyMatrix4(m.gun.matrix);
      }
    }
    this.poseArms(this._hands);
    this.updateShadow();

    const d3 = cameraPos
      ? Math.hypot(cameraPos[0] - this.pos[0], cameraPos[1] - (this.pos[1] + this.plateY), cameraPos[2] - this.pos[2]) : 99;
    if (d3 > 140) {
      r.visible = false;
      this.plate.sprite.visible = false;
      this.shadow.visible = false;
      return;
    }
    r.visible = this.visible;
    const enableShadow = d3 < 65;
    if (this._charShadowsEnabled !== enableShadow) {
      this._charShadowsEnabled = enableShadow;
      for (let i = 0; i < this.primaryShadowMeshes.length; i++) {
        this.primaryShadowMeshes[i].castShadow = enableShadow;
      }
    }
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
      _armTargetArray[0] = target.x; _armTargetArray[1] = target.y; _armTargetArray[2] = target.z;
      _armPoleArray[0] = arm.side * .5; _armPoleArray[1] = .02; _armPoleArray[2] = .03;
      solveTwoBone(shoulder, _armTargetArray, _armPoleArray, .29, .3, _armPose);
      _armA.set(shoulder[0], shoulder[1], shoulder[2]);
      _armB.set(_armPose.elbow[0], _armPose.elbow[1], _armPose.elbow[2]);
      _armC.set(_armPose.hand[0], _armPose.hand[1], _armPose.hand[2]);
      placeBone(arm.upper, _armA, _armB);
      placeBone(arm.lower, _armB, _armC);
      arm.elbow.position.copy(_armB);
      arm.hand.position.copy(_armC);
      arm.hand.quaternion.copy(m.gun.quaternion);
    }
  }

  updateShadow() {
    const position = this.model.root.position;
    const y = this.world ? supportHeight(this.world, position.x, position.z, this.pos[1], .15, .25) : this.pos[1];
    const gap = Math.max(0, position.y - y);
    this.shadow.visible = this.visible && !this.inVehicle && gap < 3;
    this.shadow.position.set(position.x, y + .018, position.z);
    this.shadow.rotation.set(-Math.PI / 2, 0, -this.yaw);
    this.shadow.scale.set(this.alive ? .67 + gap * .3 : 1.65, this.alive ? .6 + gap * .3 : .85, 1);
    this.shadow.material.opacity = .35 / (1 + gap);
  }

  updateDroppedWeapon() {
    const dropped = this.droppedWeapon;
    if (!dropped) return;
    const t = clamp((this.deathT - .1) / .65, 0, 1), ease = t * t * (3 - 2 * t);
    const side = this.id % 2 ? 1 : -1;
    const x = dropped.position.x + side * .23, z = dropped.position.z + .12;
    const y = this.world ? supportHeight(this.world, x, z, this.pos[1], .1, .25) : this.pos[1];
    dropped.weapon.root.position.copy(dropped.position).lerp(new THREE.Vector3(x, y + .075, z), ease);
    dropped.weapon.root.position.y += Math.sin(t * Math.PI) * .07;
    dropped.weapon.root.quaternion.copy(dropped.rotation).slerp(
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, this.yaw + .18, Math.PI / 2, 'YXZ')), ease);
  }

  dispose() {
    this.deathAnimation?.dispose();
    this.droppedWeapon?.weapon.dispose();
    this.shadow.removeFromParent(); this.shadow.geometry.dispose(); this.shadow.material.dispose();
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
    this.shadowMeshes = [];
    this.group.traverse(o => {
      if (o.isMesh && o.userData.primaryShadowCaster) this.shadowMeshes.push(o);
    });
    this._shadowsEnabled = true;
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
    const dx = this.pos[0] - this.target[0], dy = this.pos[1] - this.target[1], dz = this.pos[2] - this.target[2];
    if (!this.initialized || (dx * dx + dy * dy + dz * dz) > 144) {
      this.pos[0] = this.target[0]; this.pos[1] = this.target[1]; this.pos[2] = this.target[2];
      this.yaw = this.targetYaw; this.initialized = true;
    }
  }

  update(dt, cameraPos = null) {
    if (cameraPos) {
      const cx = Number.isFinite(cameraPos.x) ? cameraPos.x : (cameraPos[0] || 0);
      const cy = Number.isFinite(cameraPos.y) ? cameraPos.y : (cameraPos[1] || 0);
      const cz = Number.isFinite(cameraPos.z) ? cameraPos.z : (cameraPos[2] || 0);
      const dx = this.pos[0] - cx, dy = this.pos[1] - cy, dz = this.pos[2] - cz;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq > 150 * 150) {
        this.group.visible = false;
        return;
      }
      this.group.visible = true;

      const enableShadow = distSq < 75 * 75;
      if (this._shadowsEnabled !== enableShadow) {
        this._shadowsEnabled = enableShadow;
        for (let i = 0; i < this.shadowMeshes.length; i++) {
          this.shadowMeshes[i].castShadow = enableShadow;
        }
      }
    } else {
      this.group.visible = true;
    }

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
