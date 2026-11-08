// Visual effects: tracers, muzzle flashes, impact sparks, bullet-hole decals,
// blood puffs, explosions, debris and smoke. Points/tracers/decals are pooled;
// mesh effects have bounded lifetimes and explicit resource cleanup.
import * as THREE from 'three';
import { CFG, MATERIALS } from '../../shared/config.js';
import { clamp } from '../../shared/math.js';
import { moveProjectile } from '../../shared/weapons.js';
import { advanceRocket } from '../../shared/projectiles.js';
import { createRocketGeometry } from './launcher-model.js';
import { Casings } from './casings.js';

const MAX_PARTICLES = 900;
const MAX_TRACERS = 96;
const MAX_DECALS = 220;

const SPARK_COLORS = {
  concrete: [0xd8d2c4, 0xb9b3a4], brick: [0xb87a5c, 0xd8b090],
  plaster: [0xd8d2c4, 0xb9b3a4], wood: [0x9a7444, 0xc8a068],
  metal: [0xffe2a0, 0xffb060], sandbag: [0xc8b482, 0x9b8a63],
  glass: [0xcfeaf5, 0x9fc7d8], rock: [0xa8aaa8, 0x7a7c7c],
  dirt: [0x8a7752, 0x6a5940], road: [0x6d7074, 0x4a4d52],
};

export class Effects {
  constructor(renderer, camera, world = null) {
    this.renderer = renderer;
    this.world = world;
    this.scene = new THREE.Group();
    this.scene.name = 'combat_effects';
    renderer.scene.add(this.scene);
    this.camera = camera;
    this.time = 0;
    this._initParticles();
    this._initTracers();
    this._initDecals();
    this._initMuzzle();
    this._initSmoke();
    this.explosions = [];
    this.debris = [];
    this.projectiles = [];
    this.flashes = [];
    this.pendingImpacts = [];
    this.rockets = new Map();
    this.blastTexture = blastTexture();
    this.dustTexture = dustTexture();
    this.puffs = []; this.shockwaves = [];
    this._puffPool = [];
    // Shared rocket assets: one template is cloned per rocket, so geometry and
    // materials are created once instead of per launch/disposal.
    this._rocketTemplateAsset = null;
    this._exhaustMaterial = new THREE.SpriteMaterial({
      map: this.dustTexture, color: 0xffb066, transparent: true, opacity: .5,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    // Explosion lights are a fixed pool: adding/removing lights changes the
    // scene's light count and forces every lit material to recompile.
    this._lights = [];
    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight(0xff9a40, 0, 40, 2);
      this.scene.add(light);
      this._lights.push({ light, busy: false });
    }
    this._explosionPool = [];
    this._shockPool = [];
    this._shockGeometry = new THREE.RingGeometry(.74, 1, 40);
    // Debris shares one unit box scaled per chunk and four roughness materials.
    this._debrisGeometry = new THREE.BoxGeometry(1, 1, 1);
    this._debrisMaterials = [0x8a643c, 0x6f747b, 0x9b8a63, 0x9a9a92].map(color =>
      renderer.registerMaterial(new THREE.MeshStandardMaterial({ color, roughness: 0.9 })));
    this._trailFrom = new THREE.Vector3();
    this._trailTo = new THREE.Vector3();
    this._rocketForward = new THREE.Vector3(0, 0, -1);
    this._rocketDir = new THREE.Vector3();
    this._trailPos = [0, 0, 0];
    this.casings = new Casings(this.scene, renderer, world);
  }

  // -------------------------------------------------------------------------
  // Particles (points)
  // -------------------------------------------------------------------------
  _initParticles() {
    const geo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PARTICLES * 3);
    this.pCol = new Float32Array(MAX_PARTICLES * 3);
    this.pSize = new Float32Array(MAX_PARTICLES);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('psize', new THREE.BufferAttribute(this.pSize, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: 420 } },
      vertexShader: /* glsl */`
        attribute float psize;
        varying vec3 vColor;
        uniform float uScale;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = mv.z < -0.03 ? min(180.0, psize * uScale / -mv.z) : 0.0;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        varying vec3 vColor;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.05, length(d));
          if (a < 0.02) discard;
          gl_FragColor = vec4(vColor, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      vertexColors: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.particles = [];
    this._particleColor = new THREE.Color();
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({ live: false, pos: [0, 0, 0], vel: [0, 0, 0], life: 0, max: 1, size: 0.05, grav: 9, color: [1, 1, 1] });
    }
    this.pNext = 0;
    this._hideUnusedParticles();
  }

  _hideUnusedParticles() {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pPos[i * 3 + 1] = -10000;
      this.pSize[i] = 0;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.psize.needsUpdate = true;
  }

  spawnParticle(x, y, z, vx, vy, vz, life, size, color, grav = 9) {
    const p = this.particles[this.pNext];
    this.pNext = (this.pNext + 1) % MAX_PARTICLES;
    p.live = true;
    p.pos[0] = x; p.pos[1] = y; p.pos[2] = z;
    p.vel[0] = vx; p.vel[1] = vy; p.vel[2] = vz;
    p.life = life; p.max = life; p.size = size; p.grav = grav;
    const linear = this._particleColor.set(color);
    p.color[0] = linear.r; p.color[1] = linear.g; p.color[2] = linear.b;
  }

  // -------------------------------------------------------------------------
  // Tracers
  // -------------------------------------------------------------------------
  _initTracers() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0, 0.5);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.tracers = new THREE.InstancedMesh(geo, mat, MAX_TRACERS);
    this.tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracers.frustumCulled = false;
    this.tracers.count = 0;
    this.scene.add(this.tracers);
    // Records are recycled through tracerData; crossing the tracer ring must
    // not allocate after the first MAX_TRACERS shots. Coordinates are copied
    // because callers reuse their arrays.
    this.tracerData = [];
    this._tracerPool = [];
    this.tracerNext = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._axis = new THREE.Vector3(0, 0, 1);
    this._dir = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._tracerColor = new THREE.Color();
  }

  tracer(from, to, color = 0xffe6a8, width = 0.015, flight = null, gravity = .62) {
    const i = this.tracerNext;
    this.tracerNext = (this.tracerNext + 1) % MAX_TRACERS;
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const distance = Math.hypot(dx, dy, dz);
    flight = Math.max(.01, flight ?? distance / 880);
    const t = this._tracerPool.pop() || {
      live: false, from: [0, 0, 0], to: [0, 0, 0], age: 0, flight: .01,
      max: .01, width: .015, color: 0, distance: 0, gravity: .62, fresh: false,
    };
    t.live = true; t.fresh = true; t.age = 0;
    t.from[0] = from[0]; t.from[1] = from[1]; t.from[2] = from[2];
    t.to[0] = to[0]; t.to[1] = to[1]; t.to[2] = to[2];
    t.flight = flight; t.max = flight + .055; t.width = width;
    t.color = color; t.distance = distance; t.gravity = gravity;
    this.tracerData[i] = t;
    this.tracers.setColorAt(i, this._tracerColor.setHex(color));
    this.tracers.instanceColor.needsUpdate = true;
    this.tracers.count = Math.min(MAX_TRACERS, Math.max(this.tracers.count, i + 1));
  }

  _updateTracers(dt) {
    const m = this._m, q = this._q, p = this._p, s = this._s, dir = this._dir;
    let any = false, dirty = false;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const t = this.tracerData[i];
      if (!t) continue;
      t.age += t.fresh ? Math.min(dt, t.flight) : dt; t.fresh = false;
      dirty = true;
      if (t.age >= t.max) {
        t.live = false;
        this.tracerData[i] = null;
        this._tracerPool.push(t);
        m.makeScale(0, 0, 0); this.tracers.setMatrixAt(i, m);
        continue;
      }
      any = true;
      const f = clamp((t.max - t.age) / .055, 0, 1);
      const end = clamp(t.age / t.flight, 0, 1), start = Math.max(0, end - Math.min(7, t.distance) / Math.max(.001, t.distance));
      // Ballistic drop is only applied on Y, matching the historical path.
      const drop = t.flight * t.flight * 9.81 * t.gravity * .5;
      const ax = t.from[0] + (t.to[0] - t.from[0]) * start;
      const ay = t.from[1] + (t.to[1] - t.from[1]) * start + drop * start * (1 - start);
      const az = t.from[2] + (t.to[2] - t.from[2]) * start;
      const bx = t.from[0] + (t.to[0] - t.from[0]) * end;
      const by = t.from[1] + (t.to[1] - t.from[1]) * end + drop * end * (1 - end);
      const bz = t.from[2] + (t.to[2] - t.from[2]) * end;
      dir.set(bx - ax, by - ay, bz - az);
      const len = dir.length() || 0.001;
      dir.divideScalar(len);
      q.setFromUnitVectors(this._axis, dir);
      p.set(ax, ay, az);
      s.set(t.width * (.25 + f), t.width * (.25 + f), len);
      m.compose(p, q, s);
      this.tracers.setMatrixAt(i, m);
    }
    if (dirty) this.tracers.instanceMatrix.needsUpdate = true;
    this.tracers.visible = any;
  }

  // -------------------------------------------------------------------------
  // Decals
  // -------------------------------------------------------------------------
  _initDecals() {
    const geo = new THREE.CircleGeometry(1, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x1a1a18, transparent: true, opacity: 0.72,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
    });
    this.decals = new THREE.InstancedMesh(geo, mat, MAX_DECALS);
    this.decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.decals.frustumCulled = false;
    this.decals.count = 0;
    this.scene.add(this.decals);
    this.decalNext = 0;
    this.decalData = [];
    this._dq = new THREE.Quaternion();
    this._dn = new THREE.Vector3();
    this._dm = new THREE.Matrix4();
    this._dp = new THREE.Vector3();
    this._ds = new THREE.Vector3();
    this._daxis = new THREE.Vector3(0, 0, 1);
  }

  decal(point, normal, size = 0.06, boxId = null) {
    const i = this.decalNext;
    this.decalNext = (this.decalNext + 1) % MAX_DECALS;
    const n = this._dn.set(normal[0], normal[1], normal[2]).normalize();
    const q = this._dq.setFromUnitVectors(this._daxis, n);
    const p = this._dp.set(point[0] + n.x * 0.008, point[1] + n.y * 0.008, point[2] + n.z * 0.008);
    const m = this._dm.compose(p, q, this._ds.set(size, size, size));
    this.decals.setMatrixAt(i, m);
    this.decalData[i] = boxId;
    this.decals.count = Math.min(MAX_DECALS, Math.max(this.decals.count, i + 1));
    this.decals.instanceMatrix.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Muzzle flash
  // -------------------------------------------------------------------------
  _initMuzzle() {
    const geo = new THREE.PlaneGeometry(.2, .2);
    const mat = new THREE.MeshBasicMaterial({
      map: radialTexture(0xfff0c0), transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.muzzleSprite = new THREE.Mesh(geo, mat);
    this.muzzleSprite.visible = false;
    this.muzzleSprite.renderOrder = 6;
    this.scene.add(this.muzzleSprite);
    this.muzzleLight = new THREE.PointLight(0xffcf80, 0, 14, 2);
    this.scene.add(this.muzzleLight);
    this.muzzleT = 0;
  }

  muzzle(pos, dir, scale = 1, anchor = null) {
    this.muzzleSprite.position.set(pos[0], pos[1], pos[2]);
    this.muzzleSprite.lookAt(pos[0] + dir[0], pos[1] + dir[1], pos[2] + dir[2]);
    this.muzzleSprite.scale.setScalar(scale * (0.8 + Math.random() * 0.5));
    this.muzzleSprite.visible = true;
    this.muzzleLight.position.set(pos[0], pos[1], pos[2]);
    this.muzzleLight.intensity = 12 * scale;
    this.muzzleT = 0.05;
    this.muzzleFresh = true; this.muzzleAnchor = anchor;
  }

  // -------------------------------------------------------------------------
  // Smoke volumes
  // -------------------------------------------------------------------------
  _initSmoke() {
    this.smokeGroups = new Map();
    this.smokeTex = radialTexture(0xdfe3e6, true);
  }

  syncSmoke(list) {
    const seen = new Set();
    for (const s of list) {
      if (Math.hypot(s.x - this.camera.position.x, s.z - this.camera.position.z) > 200) continue;
      const key = s.id || `${Math.round(s.x)},${Math.round(s.z)}`;
      seen.add(key);
      let g = this.smokeGroups.get(key);
      if (!g) {
        g = new THREE.Group();
        g.position.set(s.x, s.y, s.z);
        const mat = new THREE.SpriteMaterial({
          map: this.smokeTex, color: 0xc6ccd0, transparent: true,
          opacity: 0.62, depthWrite: false,
        });
        for (let i = 0; i < 14; i++) {
          const sp = new THREE.Sprite(mat);
          const a = (i / 14) * Math.PI * 2;
          const rr = (i % 3) * 0.8;
          sp.position.set(Math.cos(a) * rr, 0.6 + (i % 4) * 0.7, Math.sin(a) * rr);
          sp.scale.setScalar(3.2 + (i % 5) * 0.7);
          g.add(sp);
        }
        this.scene.add(g);
        this.smokeGroups.set(key, g);
      }
      g.userData.phase = (g.userData.phase || 0) + 1;
    }
    for (const [key, g] of this.smokeGroups) {
      if (!seen.has(key)) {
        this.scene.remove(g);
        g.children[0]?.material?.dispose();
        this.smokeGroups.delete(key);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event entry points
  // -------------------------------------------------------------------------
  shot(ev, weapon, anchor = null) {
    const o = ev.o || [0, 0, 0];
    const ends = ev.e || [];
    const color = weapon?.tracer ?? 0xffe6a8;
    for (let i = 0; i < ends.length; i++) {
      this.tracer(o, ends[i], color, weapon?.pellets > 1 ? .009 : .014, ev.flight?.[i], weapon?.grav);
    }
    let d = [0, 0, -1];
    if (ends.length) {
      const e = ends[0];
      const dx = e[0] - o[0], dy = e[1] - o[1], dz = e[2] - o[2];
      const l = Math.hypot(dx, dy, dz) || 1;
      d = [dx / l, dy / l, dz / l];
    }
    this.muzzle(o, d, weapon?.pellets > 1 ? 1.2 : .9, anchor);
  }

  impact(ev, delay = 0) {
    if (delay > 0) {
      if (this.pendingImpacts.length >= 512) this.pendingImpacts.shift();
      this.pendingImpacts.push({ ev, at: this.time + delay }); return;
    }
    const p = ev.p;
    const mat = ev.mat || 'concrete';
    const cols = SPARK_COLORS[mat] || SPARK_COLORS.concrete;
    const n = ev.n || [0, 1, 0];
    const count = ev.tag === 'glass' ? 10 : 5;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, up = Math.random();
      const sp = 1.5 + Math.random() * 4;
      this.spawnParticle(
        p[0], p[1], p[2],
        n[0] * 2 + Math.cos(a) * sp * 0.5,
        n[1] * 2 + up * sp,
        n[2] * 2 + Math.sin(a) * sp * 0.5,
        0.18 + Math.random() * 0.3, 0.035 + Math.random() * 0.05,
        cols[i % cols.length], 12,
      );
    }
    if (ev.tag === 'glass') {
      for (let i = 0; i < 8; i++) {
        this.spawnParticle(p[0], p[1], p[2],
          (Math.random() - 0.5) * 2.4, Math.random() * 2, (Math.random() - 0.5) * 2.4,
          0.5 + Math.random() * 0.4, 0.05, 0xbfe0ea, 9);
      }
      return;
    }
    const destroyed = ev.bid !== null && ev.bid !== undefined && this.world?.boxes[ev.bid]?.destroyed;
    if (mat !== 'dirt' && ev.tag !== 'vehicle' && !destroyed) this.decal(p, n, 0.045 + Math.random() * 0.03, ev.bid);
    // dust puff
    for (let i = 0; i < 3; i++) {
      this.spawnParticle(p[0] + (Math.random() - 0.5) * 0.2, p[1] + (Math.random() - 0.5) * 0.2, p[2] + (Math.random() - 0.5) * 0.2,
        n[0] * 0.7, 0.6 + Math.random(), n[2] * 0.7, 0.4 + Math.random() * 0.4, 0.11, 0x9a938a, 1.5);
    }
  }

  blood(ev) {
    const p = ev.p || [0, 1, 0];
    for (let i = 0; i < 7; i++) {
      this.spawnParticle(p[0], p[1], p[2],
        (Math.random() - 0.5) * 2.4, Math.random() * 2.2, (Math.random() - 0.5) * 2.4,
        0.25 + Math.random() * 0.3, 0.045, 0x8e1b1b, 10);
    }
  }

  _acquireLight() {
    for (const entry of this._lights) if (!entry.busy) { entry.busy = true; return entry; }
    return null;
  }

  _acquireExplosion() {
    let entry = this._explosionPool.pop();
    if (!entry) {
      const material = new THREE.SpriteMaterial({ map: this.blastTexture, color: 0xffbc75,
        transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
      const mesh = new THREE.Group(); mesh.material = material;
      for (let i = 0; i < 5; i++) {
        const card = new THREE.Sprite(material);
        const angle = i * 2.399;
        card.position.set(Math.cos(angle) * .3, .05 + i * .12, Math.sin(angle) * .3);
        card.scale.set(.9 + i * .06, .95 + i * .1, 1); mesh.add(card);
      }
      entry = { mesh, material };
    }
    this.scene.add(entry.mesh);
    return entry;
  }

  _acquireShock() {
    let entry = this._shockPool.pop();
    if (!entry) {
      const material = new THREE.MeshBasicMaterial({ color: 0xc4b48e, transparent: true,
        opacity: 0, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(this._shockGeometry, material);
      mesh.rotation.x = -Math.PI / 2;
      entry = { mesh, material };
    }
    this.scene.add(entry.mesh);
    return entry;
  }

  boom(ev) {
    if (ev.projectileId) this.stopProjectile(ev.projectileId);
    const p = [ev.x, ev.y, ev.z];
    const radius = ev.r || 7;
    const explosion = this._acquireExplosion();
    explosion.material.color.setHex(0xffbc75);
    explosion.material.opacity = 0;
    explosion.mesh.position.set(p[0], p[1], p[2]);
    explosion.mesh.scale.setScalar(0.6);
    const lightEntry = this._acquireLight();
    const light = lightEntry?.light || null;
    if (light) {
      light.color.setHex(0xff9a40);
      light.position.set(p[0], p[1] + 1, p[2]);
      light.distance = radius * 5;
      light.intensity = 40;
    }
    this.explosions.push({ mesh: explosion.mesh, material: explosion.material, light: lightEntry, t: 0, radius });
    // Expanding smoke body: warm core cards plus slower, darker lingering
    // smoke so the explosion reads as volume rather than a single bright flash.
    for (let i = 0; i < 18; i++) {
      const a = i * 2.399, speed = 2 + i % 4;
      this.puff([p[0], p[1] + .2, p[2]], [Math.cos(a) * speed, .55 + i % 3 * .7, Math.sin(a) * speed],
        i % 3 ? 0x9c9178 : 0x55564d, 1.1 + (i % 3) * .45, 2 + (i % 4) * .2, .6);
    }
    for (let i = 0; i < 8; i++) {
      const a = i * 2.399 + 0.7, speed = 1 + (i % 3) * .8;
      this.puff([p[0], p[1] + .7 + i * .12, p[2]],
        [Math.cos(a) * speed, 1.2 + (i % 3) * .6, Math.sin(a) * speed],
        i % 2 ? 0x38352f : 0x554c40, 1.6 + (i % 3) * .5, 3.2 + (i % 4) * .5, .5);
    }
    const shock = this._acquireShock();
    shock.material.opacity = .26;
    shock.mesh.position.set(p[0], (this.world?.terrainHeight(p[0], p[2]) ?? p[1]) + .07, p[2]);
    shock.mesh.scale.setScalar(1);
    this.shockwaves.push({ entry: shock, t: 0, radius });
    for (let i = 0; i < 42; i++) {
      const a = Math.random() * Math.PI * 2, b = Math.random() * Math.PI;
      const sp = 5 + Math.random() * 16;
      this.spawnParticle(p[0], p[1] + 0.4, p[2],
        Math.cos(a) * Math.sin(b) * sp, Math.cos(b) * sp * 0.8 + 2, Math.sin(a) * Math.sin(b) * sp,
        0.35 + Math.random() * 0.6, 0.12 + Math.random() * 0.16,
        [0xffd070, 0xff8a3a, 0x6b5a4a][i % 3], 10);
    }
    // Fast ember streaks arc further and fall under gravity.
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, sp = 9 + Math.random() * 12;
      this.spawnParticle(p[0], p[1] + 0.5, p[2],
        Math.cos(a) * sp, 3 + Math.random() * 7, Math.sin(a) * sp,
        0.5 + Math.random() * 0.5, 0.06 + Math.random() * 0.05, i % 2 ? 0xffe2a0 : 0xff9a3a, 16);
    }
    for (let i = 0; i < 18; i++) {
      this.spawnParticle(p[0], p[1] + 0.6, p[2],
        (Math.random() - 0.5) * 5, 1.5 + Math.random() * 4, (Math.random() - 0.5) * 5,
        1.0 + Math.random() * 1.4, 0.5 + Math.random() * 0.7, 0x4a4642, 1.1);
    }
  }

  destroy(ev) {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.decalData.length; i++) {
      if (this.decalData[i] === ev.id) { this.decals.setMatrixAt(i, zero); this.decalData[i] = null; this.decals.instanceMatrix.needsUpdate = true; }
    }
    const cx = ev.x, cy = ev.y, cz = ev.z;
    const n = 6;
    for (let i = 0; i < 5; i++) this.puff([cx, cy + .3, cz], [(Math.random() - .5) * 2, .4 + Math.random(), (Math.random() - .5) * 2], 0x928d79, .5, 1.4, .43);
    for (let i = 0; i < n; i++) {
      const mat = this._debrisMaterials[i % this._debrisMaterials.length];
      const m = new THREE.Mesh(this._debrisGeometry, mat);
      m.castShadow = true;
      m.scale.set(
        Math.max(0.1, (ev.sx || 1) / n) * (0.6 + Math.random() * 0.6),
        Math.max(0.1, (ev.sy || 1) / n) * (0.6 + Math.random() * 0.6),
        Math.max(0.1, (ev.sz || 1) / n) * (0.6 + Math.random() * 0.6),
      );
      m.position.set(cx + (Math.random() - 0.5) * (ev.sx || 1), cy + Math.random() * (ev.sy || 1), cz + (Math.random() - 0.5) * (ev.sz || 1));
      this.scene.add(m);
      this.debris.push({
        mesh: m, t: 0, life: 2.2 + Math.random(),
        vel: [(Math.random() - 0.5) * 5, 2 + Math.random() * 4, (Math.random() - 0.5) * 5],
        spin: [(Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8],
      });
    }
  }

  projectile(ev) {
    const geo = ev.smoke ? new THREE.CylinderGeometry(.045, .045, .14, 10) : new THREE.IcosahedronGeometry(.065, 1);
    const mat = this.renderer.registerMaterial(new THREE.MeshStandardMaterial({ color: ev.smoke ? 0x839481 : 0x3a4230, roughness: .7, metalness: .3 }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(ev.o[0], ev.o[1], ev.o[2]);
    this.scene.add(mesh);
    this.projectiles.push({
      mesh, id: ev.projectileId, pos: ev.o.slice(), vel: ev.v.slice(),
      fuse: ev.smoke ? CFG.SMOKE.fuse : CFG.GRENADE.fuse, bounces: 0, accumulator: 0,
    });
  }

  _rocketTemplate() {
    if (!this._rocketTemplateAsset) {
      this._rocketTemplateAsset = createRocketGeometry(false);
      this.renderer.registerObject(this._rocketTemplateAsset.root);
    }
    return this._rocketTemplateAsset;
  }

  launch(ev) {
    if (this.rockets.has(ev.projectileId)) return;
    const template = this._rocketTemplate();
    const root = template.root.clone();
    // Cloned meshes share the template's geometry/materials; only the sprites
    // and transform state below are per-rocket.
    const exhaust = new THREE.Sprite(this._exhaustMaterial);
    exhaust.position.set(0, 0, 0.34);
    exhaust.scale.set(0.3, 0.42, 1);
    root.add(exhaust);
    this.scene.add(root);
    const rocket = { id: ev.projectileId, model: { root, materials: template.materials, shared: true },
      exhaust, weapon: ev.w || 'rpg', pos: ev.o.slice(),
      vel: ev.v.slice(), fuse: ev.life || CFG.WEAPONS.rpg.rocket.life, accumulator: 0,
      correction: new THREE.Vector3(), held: false, trailT: 0, trailPosition: new THREE.Vector3(...ev.o) };
    root.position.set(...rocket.pos); this.rockets.set(rocket.id, rocket);
    for (let i = 0; i < 10; i++) this.spawnParticle(...ev.o,
      (Math.random() - .5) * 2, Math.random() * 1.2, (Math.random() - .5) * 2, .3 + Math.random() * .3, .15, 0xa5ac93, 0);
    const direction = this._rocketDir.set(ev.v[0], ev.v[1], ev.v[2]).normalize();
    for (let i = 0; i < 4; i++) this.puff(this._trailFrom.set(ev.o[0], ev.o[1], ev.o[2]).addScaledVector(direction, -.8 - i * .4).toArray(),
      direction.clone().multiplyScalar(-2).add(new THREE.Vector3(0, .3, 0)).toArray(), 0xb5b2a0, .24 + i * .08, .55, .26);
  }

  puff(position, velocity, color, size, life, opacity = .35) {
    let p = this._puffPool.pop();
    if (!p) {
      if (this.puffs.length >= 80) {
        p = this.puffs.shift();
      } else {
        const material = new THREE.SpriteMaterial({ map: this.dustTexture, color, transparent: true, opacity,
          depthWrite: false, rotation: Math.random() * Math.PI * 2 });
        const mesh = new THREE.Sprite(material);
        this.scene.add(mesh);
        p = { mesh, velocity: new THREE.Vector3(), size, life, max: life, opacity };
      }
    }
    p.mesh.position.set(position[0], position[1], position[2]);
    p.mesh.scale.setScalar(size);
    p.mesh.material.color.set(color);
    p.mesh.material.opacity = opacity;
    p.mesh.material.rotation = Math.random() * Math.PI * 2;
    p.mesh.visible = true;
    p.velocity.set(velocity[0], velocity[1], velocity[2]);
    p.size = size;
    p.life = life;
    p.max = life;
    p.opacity = opacity;
    this.puffs.push(p);
  }

  syncProjectiles(list) {
    const seen = new Set();
    for (const p of list) {
      if (p.type !== 'rocket') continue;
      seen.add(p.id);
      if (!this.rockets.has(p.id)) this.launch({ projectileId: p.id, w: p.weapon, o: p.pos, v: p.vel, life: p.fuse });
      const view = this.rockets.get(p.id);
      view.correction.copy(view.model.root.position).sub(new THREE.Vector3(...p.pos));
      if (view.correction.length() > 12) view.correction.set(0, 0, 0);
      view.pos = p.pos.slice(); view.vel = p.vel.slice(); view.fuse = p.fuse; view.held = false;
    }
    for (const id of this.rockets.keys()) if (!seen.has(id)) this.stopProjectile(id);
  }

  stopProjectile(id) {
    const rocket = this.rockets?.get(id);
    if (rocket) {
      if (rocket.model.shared) {
        // Geometry/materials belong to the shared template; only the clone's
        // transform and exhaust sprite are per-rocket.
        rocket.exhaust?.removeFromParent();
        rocket.model.root.removeFromParent();
      } else {
        rocket.model.root.traverse(o => o.geometry?.dispose());
        rocket.model.materials.forEach(material => material.dispose());
        rocket.model.root.removeFromParent();
      }
      this.rockets.delete(id);
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      if (p.id !== id) continue;
      p.mesh.removeFromParent(); p.mesh.geometry.dispose(); p.mesh.material.dispose();
      this.projectiles.splice(i, 1);
    }
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------
  update(dt) {
    this.time += dt;
    this.casings.update(dt);
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]; p.life -= dt;
      if (p.life <= 0) {
        p.mesh.visible = false;
        this.puffs.splice(i, 1);
        this._puffPool.push(p);
        continue;
      }
      const t = 1 - p.life / p.max;
      p.mesh.position.addScaledVector(p.velocity, dt); p.velocity.multiplyScalar(Math.exp(-1.8 * dt));
      p.mesh.position.x += dt * .19; p.mesh.position.y += dt * .2;
      p.mesh.scale.setScalar(p.size * (1 + t * 2.1));
      p.mesh.material.opacity = p.opacity * Math.min(1, t * 14) * Math.pow(1 - t, .75);
      p.mesh.material.rotation += dt * .05;
    }
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const wave = this.shockwaves[i]; wave.t += dt;
      const { mesh, material } = wave.entry;
      mesh.scale.setScalar(.4 + wave.t * wave.radius * 2.6);
      material.opacity = Math.max(0, 1 - wave.t / .6) ** 2 * .2;
      if (wave.t >= .6) {
        mesh.removeFromParent();
        this._shockPool.push(wave.entry);
        this.shockwaves.splice(i, 1);
      }
    }
    for (const rocket of this.rockets.values()) {
      rocket.accumulator += dt; rocket.trailT += dt;
      while (rocket.accumulator + 1e-9 >= CFG.SIM_DT) {
        rocket.accumulator -= CFG.SIM_DT; rocket.fuse -= CFG.SIM_DT;
        if (!rocket.held) rocket.held = !!advanceRocket(this.world, rocket, CFG.SIM_DT);
      }
      rocket.correction.multiplyScalar(Math.exp(-18 * dt));
      const model = rocket.model.root;
      model.position.set(...rocket.pos).add(rocket.correction);
      this._rocketDir.set(rocket.vel[0], rocket.vel[1], rocket.vel[2]);
      if (this._rocketDir.lengthSq() > 1e-8) {
        this._rocketDir.normalize();
        model.quaternion.setFromUnitVectors(this._rocketForward, this._rocketDir);
      }
      if (rocket.exhaust) {
        const flicker = .78 + Math.random() * .45;
        rocket.exhaust.scale.set(.3 * flicker, .42 * flicker, 1);
      }
      if (rocket.trailT > .024) {
        rocket.trailT = 0;
        const distance = model.position.distanceTo(rocket.trailPosition), count = Math.min(5, Math.ceil(distance / 1.5));
        for (let i = 1; i <= count; i++) {
          this._trailFrom.copy(rocket.trailPosition).lerp(model.position, i / count);
          this._trailPos[0] = this._trailFrom.x;
          this._trailPos[1] = this._trailFrom.y;
          this._trailPos[2] = this._trailFrom.z;
          this.puff(this._trailPos, [0, .1, 0], 0xb7bbaf, .13, .7, .22);
        }
        rocket.trailPosition.copy(model.position);
        this.spawnParticle(model.position.x, model.position.y, model.position.z, 0, 0, 0, .07, .12, 0xffc17d, 0);
      }
      if (rocket.fuse <= 0) this.stopProjectile(rocket.id);
    }
    for (let i = this.pendingImpacts.length - 1; i >= 0; i--) {
      if (this.pendingImpacts[i].at > this.time) continue;
      const impact = this.pendingImpacts.splice(i, 1)[0]; this.impact(impact.ev);
    }
    this.points.material.uniforms.uScale.value = this.renderer.renderer.domElement.height /
      (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    // particles
    const geo = this.points.geometry;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (!p.live) { this.pSize[i] = 0; continue; }
      p.life -= dt;
      if (p.life <= 0) { p.live = false; this.pSize[i] = 0; continue; }
      p.vel[1] -= p.grav * dt;
      p.pos[0] += p.vel[0] * dt;
      p.pos[1] += p.vel[1] * dt;
      p.pos[2] += p.vel[2] * dt;
      p.vel[0] *= 1 - 1.6 * dt;
      p.vel[2] *= 1 - 1.6 * dt;
      const f = p.life / p.max;
      this.pPos[i * 3] = p.pos[0];
      this.pPos[i * 3 + 1] = p.pos[1];
      this.pPos[i * 3 + 2] = p.pos[2];
      this.pCol[i * 3] = p.color[0] * f;
      this.pCol[i * 3 + 1] = p.color[1] * f;
      this.pCol[i * 3 + 2] = p.color[2] * f;
      this.pSize[i] = p.size * (0.5 + f * 0.8);
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.psize.needsUpdate = true;

    this._updateTracers(dt);

    // muzzle flash
    if (this.muzzleT > 0) {
      if (this.muzzleAnchor?.parent?.parent) {
        this.muzzleAnchor.getWorldPosition(this.muzzleSprite.position);
        this.muzzleLight.position.copy(this.muzzleSprite.position);
      }
      if (!this.muzzleFresh) this.muzzleT -= dt;
      this.muzzleFresh = false;
      this.muzzleLight.intensity *= 0.55;
      if (this.muzzleT <= 0) { this.muzzleSprite.visible = false; this.muzzleLight.intensity = 0; }
    }

    // explosions
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      e.t += dt;
      const f = clamp(e.t / 0.45, 0, 1);
      e.mesh.scale.setScalar(.4 + Math.sqrt(f) * e.radius * .48);
      e.material.opacity = Math.pow(1 - f, 1.4) * .86;
      if (e.light) e.light.light.intensity = 40 * (1 - f) * (1 - f);
      if (f >= 1) {
        this.scene.remove(e.mesh);
        this._explosionPool.push({ mesh: e.mesh, material: e.material });
        if (e.light) { e.light.busy = false; e.light.light.intensity = 0; }
        this.explosions.splice(i, 1);
      }
    }

    // debris
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.t += dt;
      d.vel[1] -= 18 * dt;
      d.mesh.position.x += d.vel[0] * dt;
      d.mesh.position.y += d.vel[1] * dt;
      d.mesh.position.z += d.vel[2] * dt;
      d.mesh.rotation.x += d.spin[0] * dt;
      d.mesh.rotation.y += d.spin[1] * dt;
      d.mesh.rotation.z += d.spin[2] * dt;
      if (this.world) {
        const floor = this.world.terrainHeight(d.mesh.position.x, d.mesh.position.z) + .06;
        if (d.mesh.position.y < floor) {
          d.mesh.position.y = floor; d.vel[1] = Math.abs(d.vel[1]) * .12;
          d.vel[0] *= .65; d.vel[2] *= .65;
        }
      }
      if (d.mesh.position.y < -30 || d.t > d.life) {
        this.scene.remove(d.mesh);
        this.debris.splice(i, 1);
      }
    }

    // locally simulated grenades (visual only; server owns damage)
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.accumulator += dt;
      while (p.accumulator + 1e-9 >= CFG.SIM_DT) {
        p.accumulator -= CFG.SIM_DT; p.fuse -= CFG.SIM_DT;
        moveProjectile(this.world, p, CFG.SIM_DT);
      }
      p.mesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
      if (p.fuse <= 0) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose(); p.mesh.material.dispose();
        this.projectiles.splice(i, 1);
      }
    }

    // smoke drift
    for (const [key, g] of this.smokeGroups) {
      g.rotation.y += dt * 0.05;
      const pulse = 1 + Math.sin(this.time * 0.6 + g.position.x) * 0.02;
      g.scale.setScalar(pulse);
    }
  }

  dispose() {
    for (const id of this.rockets.keys()) this.stopProjectile(id);
    this.scene.removeFromParent();
    const geometries = new Set(), materials = new Set(), maps = new Set();
    this.scene.traverse(o => {
      if (o.geometry) geometries.add(o.geometry);
      if (o.material) { materials.add(o.material); if (o.material.map) maps.add(o.material.map); }
    });
    // Shared assets live outside the scene graph between uses.
    for (const template of [this._rocketTemplateAsset]) {
      if (!template) continue;
      template.root.traverse(o => { if (o.geometry) geometries.add(o.geometry); });
      for (const material of template.materials) materials.add(material);
    }
    geometries.add(this._shockGeometry);
    geometries.add(this._debrisGeometry);
    for (const material of this._debrisMaterials) materials.add(material);
    materials.add(this._exhaustMaterial);
    for (const entry of this._explosionPool) materials.add(entry.material);
    for (const entry of this._shockPool) materials.add(entry.material);
    geometries.forEach(g => g.dispose());
    materials.forEach(m => m.dispose());
    maps.forEach(t => t.dispose());
    this.blastTexture.dispose();
    this.dustTexture.dispose();
  }
}

function blastTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d');
  for (let i = 0; i < 27; i++) {
    const a = i * 2.399, radius = 10 + (i % 5) * 6;
    const x = 64 + Math.cos(a) * (i % 6) * 6, y = 64 + Math.sin(a) * (i % 6) * 6;
    const gradient = context.createRadialGradient(x, y, 1, x, y, radius);
    gradient.addColorStop(0, 'rgba(255,247,196,.9)'); gradient.addColorStop(.3, 'rgba(246,183,99,.72)');
    gradient.addColorStop(.65, 'rgba(116,76,42,.45)'); gradient.addColorStop(1, 'rgba(46,43,34,0)');
    context.fillStyle = gradient; context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace; return map;
}

function dustTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d');
  for (let i = 0; i < 39; i++) {
    const a = i * 2.399, r = 12 + i % 7 * 2, d = Math.sqrt(i / 39) * 36;
    const x = 64 + Math.cos(a) * d, y = 64 + Math.sin(a) * d;
    const gradient = context.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, '#ffffff85'); gradient.addColorStop(.42, '#dddddd55'); gradient.addColorStop(1, '#aaaaaa00');
    context.fillStyle = gradient; context.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace; return map;
}

function radialTexture(color, soft = false) {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const r = color >> 16 & 255, gg = color >> 8 & 255, b = color & 255;
  g.addColorStop(0, `rgba(${r},${gg},${b},1)`);
  g.addColorStop(soft ? 0.35 : 0.18, `rgba(${r},${gg},${b},${soft ? 0.5 : 0.85})`);
  g.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
