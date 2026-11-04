// Visual effects: tracers, muzzle flashes, impact sparks, bullet-hole decals,
// blood puffs, explosions, debris and smoke. Everything is pooled.
import * as THREE from 'three';
import { CFG, MATERIALS } from '../../shared/config.js';
import { clamp } from '../../shared/math.js';

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
  constructor(renderer, camera) {
    this.scene = renderer.scene;
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
          gl_PointSize = max(1.0, psize * uScale / max(0.001, -mv.z));
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
        }
      `,
      vertexColors: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.particles = [];
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
    p.color[0] = (color >> 16 & 255) / 255;
    p.color[1] = (color >> 8 & 255) / 255;
    p.color[2] = (color & 255) / 255;
  }

  // -------------------------------------------------------------------------
  // Tracers
  // -------------------------------------------------------------------------
  _initTracers() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0, 0.5);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe6a8, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.tracers = new THREE.InstancedMesh(geo, mat, MAX_TRACERS);
    this.tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracers.frustumCulled = false;
    this.tracers.count = 0;
    this.scene.add(this.tracers);
    this.tracerData = [];
    this.tracerNext = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._dir = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  tracer(from, to, color = 0xffe6a8, width = 0.022) {
    const i = this.tracerNext;
    this.tracerNext = (this.tracerNext + 1) % MAX_TRACERS;
    this.tracerData[i] = { from, to, life: 0.075, max: 0.075, width, color };
    this.tracers.count = Math.min(MAX_TRACERS, Math.max(this.tracers.count, i + 1));
  }

  _updateTracers(dt) {
    const m = this._m, q = this._q, p = this._p, s = this._s, dir = this._dir;
    let any = false;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const t = this.tracerData[i];
      if (!t) continue;
      t.life -= dt;
      if (t.life <= 0) { this.tracerData[i] = null; m.makeScale(0, 0, 0); this.tracers.setMatrixAt(i, m); continue; }
      any = true;
      const f = t.life / t.max;
      dir.set(t.to[0] - t.from[0], t.to[1] - t.from[1], t.to[2] - t.from[2]);
      const len = dir.length() || 0.001;
      dir.divideScalar(len);
      q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      p.set(t.from[0], t.from[1], t.from[2]);
      s.set(t.width * (0.4 + f), t.width * (0.4 + f), len * clamp(f * 1.6, 0, 1));
      m.compose(p, q, s);
      this.tracers.setMatrixAt(i, m);
    }
    if (any) this.tracers.instanceMatrix.needsUpdate = true;
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
  }

  decal(point, normal, size = 0.06) {
    const i = this.decalNext;
    this.decalNext = (this.decalNext + 1) % MAX_DECALS;
    const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    const p = new THREE.Vector3(point[0] + n.x * 0.008, point[1] + n.y * 0.008, point[2] + n.z * 0.008);
    const m = new THREE.Matrix4().compose(p, q, new THREE.Vector3(size, size, size));
    this.decals.setMatrixAt(i, m);
    this.decals.count = Math.min(MAX_DECALS, Math.max(this.decals.count, i + 1));
    this.decals.instanceMatrix.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Muzzle flash
  // -------------------------------------------------------------------------
  _initMuzzle() {
    const geo = new THREE.PlaneGeometry(0.5, 0.5);
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

  muzzle(pos, dir, scale = 1) {
    this.muzzleSprite.position.set(pos[0], pos[1], pos[2]);
    this.muzzleSprite.lookAt(pos[0] + dir[0], pos[1] + dir[1], pos[2] + dir[2]);
    this.muzzleSprite.scale.setScalar(scale * (0.8 + Math.random() * 0.5));
    this.muzzleSprite.visible = true;
    this.muzzleLight.position.set(pos[0], pos[1], pos[2]);
    this.muzzleLight.intensity = 12 * scale;
    this.muzzleT = 0.05;
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
      const key = `${Math.round(s.x)},${Math.round(s.z)}`;
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
  shot(ev, weapon) {
    const o = ev.o || [0, 0, 0];
    const ends = ev.e || [];
    const color = weapon?.tracer ?? 0xffe6a8;
    let prev = o;
    for (const e of ends) {
      this.tracer(prev, e, color, weapon?.pellets > 1 ? 0.016 : 0.024);
      prev = e;
    }
    let d = [0, 0, -1];
    if (ends.length) {
      const e = ends[0];
      const dx = e[0] - o[0], dy = e[1] - o[1], dz = e[2] - o[2];
      const l = Math.hypot(dx, dy, dz) || 1;
      d = [dx / l, dy / l, dz / l];
    }
    this.muzzle(o, d, weapon?.pellets > 1 ? 0.8 : 1.1);
  }

  impact(ev) {
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
    if (mat !== 'dirt') this.decal(p, n, 0.045 + Math.random() * 0.03);
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

  boom(ev) {
    const p = [ev.x, ev.y, ev.z];
    const radius = ev.r || 7;
    const geo = new THREE.SphereGeometry(1, 16, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffb060, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(p[0], p[1], p[2]);
    mesh.scale.setScalar(0.6);
    this.scene.add(mesh);
    const light = new THREE.PointLight(0xff9a40, 40, radius * 5, 2);
    light.position.set(p[0], p[1] + 1, p[2]);
    this.scene.add(light);
    this.explosions.push({ mesh, light, t: 0, radius });
    for (let i = 0; i < 42; i++) {
      const a = Math.random() * Math.PI * 2, b = Math.random() * Math.PI;
      const sp = 5 + Math.random() * 16;
      this.spawnParticle(p[0], p[1] + 0.4, p[2],
        Math.cos(a) * Math.sin(b) * sp, Math.cos(b) * sp * 0.8 + 2, Math.sin(a) * Math.sin(b) * sp,
        0.35 + Math.random() * 0.6, 0.12 + Math.random() * 0.16,
        [0xffd070, 0xff8a3a, 0x6b5a4a][i % 3], 10);
    }
    for (let i = 0; i < 18; i++) {
      this.spawnParticle(p[0], p[1] + 0.6, p[2],
        (Math.random() - 0.5) * 5, 1.5 + Math.random() * 4, (Math.random() - 0.5) * 5,
        1.0 + Math.random() * 1.4, 0.5 + Math.random() * 0.7, 0x4a4642, 1.1);
    }
  }

  destroy(ev) {
    const cx = ev.x, cy = ev.y, cz = ev.z;
    const n = 6;
    const colors = [0x8a643c, 0x6f747b, 0x9b8a63, 0x9a9a92];
    for (let i = 0; i < n; i++) {
      const geo = new THREE.BoxGeometry(
        Math.max(0.1, (ev.sx || 1) / n) * (0.6 + Math.random() * 0.6),
        Math.max(0.1, (ev.sy || 1) / n) * (0.6 + Math.random() * 0.6),
        Math.max(0.1, (ev.sz || 1) / n) * (0.6 + Math.random() * 0.6),
      );
      const mat = new THREE.MeshStandardMaterial({ color: colors[i % colors.length], roughness: 0.9 });
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
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
    if (ev.smoke) return;
    const geo = new THREE.SphereGeometry(0.1, 8, 6);
    const mat = new THREE.MeshStandardMaterial({ color: 0x3a4230, roughness: 0.6, metalness: 0.4 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(ev.o[0], ev.o[1], ev.o[2]);
    mesh.userData.groundY = ev.o[1] - 1.55;
    this.scene.add(mesh);
    this.projectiles.push({
      mesh, pos: ev.o.slice(), vel: ev.v.slice(), fuse: CFG.GRENADE.fuse, bounces: 0,
    });
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------
  update(dt) {
    this.time += dt;
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
      this.muzzleT -= dt;
      this.muzzleLight.intensity *= 0.55;
      if (this.muzzleT <= 0) { this.muzzleSprite.visible = false; this.muzzleLight.intensity = 0; }
    }

    // explosions
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      e.t += dt;
      const f = clamp(e.t / 0.45, 0, 1);
      e.mesh.scale.setScalar(0.6 + f * e.radius * 0.85);
      e.mesh.material.opacity = (1 - f) * 0.9;
      e.light.intensity = 40 * (1 - f) * (1 - f);
      if (f >= 1) {
        this.scene.remove(e.mesh, e.light);
        e.mesh.geometry.dispose(); e.mesh.material.dispose();
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
      if (d.mesh.position.y < -30 || d.t > d.life) {
        this.scene.remove(d.mesh);
        d.mesh.geometry.dispose(); d.mesh.material.dispose();
        this.debris.splice(i, 1);
      }
    }

    // locally simulated grenades (visual only; server owns damage)
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.fuse -= dt;
      p.vel[1] -= 9.8 * dt;
      p.pos[0] += p.vel[0] * dt;
      p.pos[1] += p.vel[1] * dt;
      p.pos[2] += p.vel[2] * dt;
      // cheap ground bounce against y=0-relative terrain is not known here;
      // bounce off a plane at the spawn height to keep the visual plausible.
      if (p.pos[1] < p.mesh.userData.groundY) {
        p.pos[1] = p.mesh.userData.groundY;
        p.vel[1] *= -0.35; p.vel[0] *= 0.6; p.vel[2] *= 0.6;
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
