// Static world rendering. The server's collision boxes are the single source of
// truth: static geometry is merged per material, destructible props stay
// individual so they can be removed when the server says they broke.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CFG, MATERIALS } from '../../shared/config.js';
import { texture, TILE } from './textures.js';
import { clamp, smoothstep } from '../../shared/math.js';
import { BLACKSHORE } from './style.js';
import { pineGeometry, GroundCover } from './foliage.js';

const _v = new THREE.Vector3();

// Project a box's UVs in world space so textures tile at a constant scale and
// never stretch on long walls. Must be called after the geometry is translated.
function applyWorldUVs(geo, tile) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let u, v;
    if (nx >= ny && nx >= nz) { u = z; v = y; }
    else if (ny >= nx && ny >= nz) { u = x; v = z; }
    else { u = x; v = y; }
    uv[i * 2] = u / tile;
    uv[i * 2 + 1] = v / tile;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

function boxGeometry(b) {
  const w = Math.max(0.02, b.max[0] - b.min[0]);
  const h = Math.max(0.02, b.max[1] - b.min[1]);
  const d = Math.max(0.02, b.max[2] - b.min[2]);
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  return applyWorldUVs(geo, TILE[b.mat] || 2.5);
}

function makeMaterials(renderer) {
  const mats = {};
  for (const [key, def] of Object.entries(MATERIALS)) {
    const map = texture(key);
    if (key === 'glass') {
      mats[key] = renderer.registerMaterial(new THREE.MeshStandardMaterial({
        map, color: 0xbfe0ea, roughness: 0.06, metalness: 0.15,
        transparent: true, opacity: 0.34, depthWrite: false,
        side: THREE.DoubleSide, envMapIntensity: 1.2,
      }));
      continue;
    }
    mats[key] = renderer.registerMaterial(new THREE.MeshStandardMaterial({
      map, color: def.color, roughness: def.roughness, metalness: def.metalness,
      vertexColors: false,
    }));
    // Tint the texture toward the configured material colour so the palette is
    // consistent even though each map has its own baked hue.
    mats[key].color = new THREE.Color(def.color).lerp(new THREE.Color(0xffffff), 0.55);
  }
  return mats;
}

export class WorldRenderer {
  constructor(renderer, world) {
    this.renderer = renderer;
    this.world = world;
    this.scene = renderer.scene;
    this.mats = makeMaterials(renderer);
    this.dynamicMeshes = new Map();
    this.staticMeshes = [];
    this.treeMeshes = [];
    this.rockMesh = null;
    this.water = null;
    this.lootGroup = new THREE.Group();
    this.lootGroup.name = 'loot';
    this.scene.add(this.lootGroup);
    this._buildTerrain();
    this._buildRoads();
    this._buildBoxes();
    this._buildArchitecture();
    this._buildTrees();
    this._buildRocks();
    this._buildWater();
    this._buildBoundaryFog();
    this.groundCover = new GroundCover(renderer, world);
  }

  // -------------------------------------------------------------------------
  // Terrain
  // -------------------------------------------------------------------------
  _buildTerrain() {
    const w = this.world, N = w.N;
    const geo = new THREE.PlaneGeometry(w.size, w.size, N - 1, N - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const grass = new THREE.Color(BLACKSHORE.terrain.grass);
    const dry = new THREE.Color(BLACKSHORE.terrain.dry);
    const rock = new THREE.Color(BLACKSHORE.terrain.rock);
    const sand = new THREE.Color(BLACKSHORE.terrain.sand);
    const dark = new THREE.Color(BLACKSHORE.terrain.shade);
    const c = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const y = w.terrainHeight(x, z);
      pos.setY(i, y);
      const n = w.terrainNormal(x, z);
      const slope = 1 - n[1];
      const nz = (Math.sin(x * 0.021) + Math.cos(z * 0.017) + Math.sin((x + z) * 0.009)) * 0.25 + 0.5;
      c.copy(grass).lerp(dark, clamp(nz * 0.8, 0, 1));
      c.lerp(dry, clamp((w.terrainHeight(x + 40, z + 40) - y) * 0.06 + 0.35, 0, 0.55));
      c.lerp(rock, smoothstep((slope - 0.14) / 0.3) * 0.9);
      const wet = w.waterDepth(x, z);
      if (wet > 0) c.lerp(sand, clamp(wet * 0.35, 0, 0.85));
      else if (wet === 0 && Math.hypot(x - w.lake.x, z - w.lake.z) < w.lake.r * 1.5) {
        c.lerp(sand, 0.35);
      }
      // Town pads read as worn ground.
      if (w.nearTown(x, z, 1.0)) c.lerp(new THREE.Color(0x7e7a62), 0.35);
      // The photographed albedo supplies the fine colour detail; vertex colour
      // is a gentle macro tint, not a second dark albedo multiplied over it.
      c.lerp(new THREE.Color(0xffffff), .72);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const map = texture('ground');
    map.repeat.set(140, 140);
    const bumpMap = texture('grainHeight');
    bumpMap.repeat.set(450, 450);
    const mat = this.renderer.registerMaterial(new THREE.MeshStandardMaterial({
      map, bumpMap, bumpScale: .035, vertexColors: true, roughness: .97, metalness: 0,
    }));
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.terrain.name = 'terrain';
    this.scene.add(this.terrain);
    const loader = new THREE.TextureLoader();
    const load = (file, colour) => loader.loadAsync(`/textures/${file}.webp`).then(tex => {
      tex.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(150, 150);
      tex.anisotropy = Math.min(8, this.renderer.renderer.capabilities.getMaxAnisotropy());
      return tex;
    });
    this.assetsReady = Promise.all([
      load('grass-albedo', true), load('grass-normal', false), load('grass-roughness', false),
    ]).then(([albedo, normal, roughness]) => {
      mat.map = albedo; mat.normalMap = normal; mat.normalScale.set(.5, .5);
      mat.bumpMap = null; mat.roughnessMap = roughness; mat.needsUpdate = true;
      this.assetsLoaded = true;
    }).catch(error => { this.assetError = String(error); this.assetsLoaded = true; console.error('Terrain texture load failed', error); });
  }

  // -------------------------------------------------------------------------
  // Roads
  // -------------------------------------------------------------------------
  _buildRoads() {
    const positions = [], uvs = [], indices = [];
    let vOff = 0;
    for (const road of this.world.roads) {
      const pts = road.points, half = road.width / 2;
      const path = [];
      // Subdivide long segments so the ribbon follows the terrain.
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, z1] = pts[i], [x2, z2] = pts[i + 1];
        const len = Math.hypot(x2 - x1, z2 - z1);
        const steps = Math.max(1, Math.ceil(len / 6));
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          path.push([x1 + (x2 - x1) * t, z1 + (z2 - z1) * t]);
        }
      }
      path.push(pts[pts.length - 1]);
      let along = 0;
      for (let i = 0; i < path.length; i++) {
        const [x, z] = path[i];
        const prev = path[Math.max(0, i - 1)], next = path[Math.min(path.length - 1, i + 1)];
        let dx = next[0] - prev[0], dz = next[1] - prev[1];
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        const nx = -dz, nz = dx;
        if (i > 0) along += Math.hypot(x - path[i - 1][0], z - path[i - 1][1]);
        for (const side of [-1, 1]) {
          const px = x + nx * half * side, pz = z + nz * half * side;
          const py = this.world.terrainHeight(px, pz) + 0.06;
          positions.push(px, py, pz);
          uvs.push(side * 0.5 + 0.5, along / 8);
        }
        if (i > 0) {
          const a = vOff + (i - 1) * 2, b = a + 1, c2 = a + 2, d = a + 3;
          indices.push(a, c2, b, b, c2, d);
        }
      }
      vOff += path.length * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const map = texture('asphalt');
    map.repeat.set(1, 1);
    const mat = this.renderer.registerMaterial(new THREE.MeshStandardMaterial({
      map, color: 0x6a6d70, roughness: 0.96, metalness: 0.02,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'roads';
    this.scene.add(mesh);
  }

  // -------------------------------------------------------------------------
  // Boxes
  // -------------------------------------------------------------------------
  _buildBoxes() {
    const byMat = new Map();
    for (const b of this.world.boxes) {
      if (!b.render || b.destroyed) continue;
      if (b.dynamic) {
        const mesh = new THREE.Mesh(boxGeometry(b), this.mats[b.mat]);
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.name = `dyn_${b.id}`;
        this.scene.add(mesh);
        this.dynamicMeshes.set(b.id, mesh);
        continue;
      }
      const geo = boxGeometry(b);
      let arr = byMat.get(b.mat);
      if (!arr) { arr = []; byMat.set(b.mat, arr); }
      arr.push(geo);
    }
    for (const [mat, geos] of byMat) {
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      const mesh = new THREE.Mesh(merged, this.mats[mat]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `static_${mat}`;
      this.scene.add(mesh);
      this.staticMeshes.push(mesh);
    }
  }

  removeBox(id) {
    const mesh = this.dynamicMeshes.get(id);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    this.dynamicMeshes.delete(id);
  }

  _buildArchitecture() {
    // Thin trim/paint follows existing wall colliders. It creates no apparent
    // extra cover or traversable structure that the simulation does not know.
    const trim = [], bands = [];
    const add = (list, x, y, z, w, h, d) => {
      const geometry = new THREE.BoxGeometry(w, h, d);
      geometry.translate(x, y, z); list.push(geometry);
    };
    for (const b of this.world.boxes) {
      if (b.tag !== 'wall' || !b.render) continue;
      const w = b.max[0] - b.min[0], h = b.max[1] - b.min[1], d = b.max[2] - b.min[2];
      if (h < .65 || Math.max(w, d) < 1.0) continue;
      const x = (b.min[0] + b.max[0]) / 2, z = (b.min[2] + b.max[2]) / 2;
      add(bands, x, b.min[1] + .24, z, w + .013, .17, d + .013);
    }
    const labels = document.createElement('canvas'); labels.width = 1024; labels.height = 512;
    const ctx = labels.getContext('2d');
    const signGeometries = [];
    this.world.buildings.forEach((b, i) => {
      const top = b.y0 + b.floors * b.floorH;
      for (const side of [-1, 1]) {
        add(trim, b.x, top - .12, b.z + side * b.d / 2, b.w + .16, .13, .3);
        add(trim, b.x + side * b.w / 2, top - .12, b.z, .3, .13, b.d + .16);
        for (const end of [-1, 1]) {
          add(trim, b.x + side * (b.w / 2 - .08), b.y0 + (top - b.y0) / 2, b.z + end * b.d / 2, .13, top - b.y0, .27);
        }
      }
      const column = i % 8, row = Math.floor(i / 8) % 8;
      ctx.fillStyle = '#263c37'; ctx.fillRect(column * 128, row * 64, 128, 64);
      ctx.fillStyle = '#d1d9b9'; ctx.font = 'bold 31px monospace'; ctx.textAlign = 'left';
      ctx.fillText(String(i + 1).padStart(2, '0'), column * 128 + 9, row * 64 + 35);
      ctx.font = '8px monospace'; ctx.fillText('BLACKSHORE', column * 128 + 9, row * 64 + 51);
      ctx.fillStyle = '#d7a866'; ctx.fillRect(column * 128 + 90, row * 64 + 12, 26, 4);
      for (const side of [-1, 1]) {
        const sign = new THREE.PlaneGeometry(.95, .46);
        if (side < 0) sign.rotateY(Math.PI);
        sign.translate(b.x + b.w * .26, b.y0 + 2.68, b.z + side * (b.d / 2 + .131));
        const uv = sign.attributes.uv;
        for (let n = 0; n < uv.count; n++) uv.setXY(n, (column + uv.getX(n)) / 8, 1 - (row + 1 - uv.getY(n)) / 8);
        signGeometries.push(sign);
      }
    });
    const atlas = new THREE.CanvasTexture(labels); atlas.colorSpace = THREE.SRGBColorSpace;
    for (const [geometries, material, name] of [
      [trim, new THREE.MeshStandardMaterial({ color: 0xada98b, roughness: .9 }), 'architecture_trim'],
      [bands, new THREE.MeshStandardMaterial({ color: 0x667366, roughness: .93 }), 'painted_plinths'],
      [signGeometries, new THREE.MeshStandardMaterial({ map: atlas, roughness: .85 }), 'building_serials'],
    ]) {
      if (!geometries.length) continue;
      const merged = mergeGeometries(geometries, false); geometries.forEach(g => g.dispose());
      const mesh = new THREE.Mesh(merged, this.renderer.registerMaterial(material));
      mesh.name = name; mesh.receiveShadow = true; mesh.castShadow = false;
      this.scene.add(mesh); this.staticMeshes.push(mesh);
    }
  }

  // -------------------------------------------------------------------------
  // Vegetation
  // -------------------------------------------------------------------------
  _buildTrees() {
    const trees = this.world.trees;
    const pines = trees.filter(t => t.type === 'pine');
    const oaks = trees.filter(t => t.type === 'oak');
    const trunkGeo = new THREE.CylinderGeometry(0.62, 1, 1, 7, 1, false);
    trunkGeo.translate(0, 0.5, 0);
    const trunkMat = this.renderer.registerMaterial(new THREE.MeshStandardMaterial({
      map: texture('bark'), color: 0xb9b7a1, roughness: 0.95,
    }));
    const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
    trunkMesh.castShadow = true; trunkMesh.receiveShadow = true;
    trunkMesh.name = 'tree_trunks';

    const pineGeo = pineGeometry();
    const pineMat = this.renderer.registerMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
    }));
    const pineMesh = new THREE.InstancedMesh(pineGeo, pineMat, pines.length);
    pineMesh.castShadow = true; pineMesh.receiveShadow = true;
    pineMesh.name = 'pine_canopy';

    const oakGeo = new THREE.IcosahedronGeometry(1, 1);
    const oakPos = oakGeo.attributes.position;
    for (let i = 0; i < oakPos.count; i++) {
      const x = oakPos.getX(i), y = oakPos.getY(i), z = oakPos.getZ(i);
      const f = 1 + .1 * Math.sin(x * 11 + y * 8 + z * 17);
      oakPos.setXYZ(i, x * f, y * f, z * f);
    }
    oakGeo.computeVertexNormals();
    const oakMat = this.renderer.registerMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.95, flatShading: true,
    }));
    const oakMesh = new THREE.InstancedMesh(oakGeo, oakMat, oaks.length * 3);
    oakMesh.castShadow = true; oakMesh.receiveShadow = true;
    oakMesh.name = 'oak_canopy';

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const color = new THREE.Color();
    let ti = 0, pi = 0, oi = 0;
    for (const t of trees) {
      const trunkH = t.h * 0.62;
      e.set(0, t.rot, 0); q.setFromEuler(e);
      p.set(t.x, t.y - 0.2, t.z);
      s.set(t.r, trunkH, t.r);
      m.compose(p, q, s);
      trunkMesh.setMatrixAt(ti, m);
      color.setHex(0x8c826b).lerp(new THREE.Color(0xb8ac8d), (ti % 7) * .045);
      trunkMesh.setColorAt(ti, color);
      ti++;
      if (t.type === 'pine') {
        p.set(t.x, t.y + t.h * .22, t.z);
        e.set(.015 * Math.sin(t.rot), t.rot, .018 * Math.cos(t.rot)); q.setFromEuler(e);
        s.set(t.scale * 2.15, t.h * .75, t.scale * 2.15);
        m.compose(p, q, s); pineMesh.setMatrixAt(pi, m);
        color.setHex(BLACKSHORE.foliage[pi % BLACKSHORE.foliage.length]);
        pineMesh.setColorAt(pi++, color);
      } else {
        const base = t.y + trunkH * 0.82;
        for (let k = 0; k < 3; k++) {
          const a = t.rot + k * 2.1;
          const rad = t.scale * (1.75 - k * 0.22);
          p.set(t.x + Math.cos(a) * t.scale * 0.55, base + t.h * 0.14 + k * t.scale * 0.75,
            t.z + Math.sin(a) * t.scale * 0.55);
          e.set(k * 0.4, a, k * 0.2); q.setFromEuler(e);
          s.set(rad, rad * 0.82, rad);
          m.compose(p, q, s);
          oakMesh.setMatrixAt(oi, m);
          color.setHex(BLACKSHORE.foliage[oi % BLACKSHORE.foliage.length]);
          color.lerp(new THREE.Color(0xada570), k * .12);
          oakMesh.setColorAt(oi, color);
          oi++;
        }
      }
    }
    trunkMesh.instanceMatrix.needsUpdate = true;
    pineMesh.instanceMatrix.needsUpdate = true;
    oakMesh.instanceMatrix.needsUpdate = true;
    if (trunkMesh.instanceColor) trunkMesh.instanceColor.needsUpdate = true;
    if (pineMesh.instanceColor) pineMesh.instanceColor.needsUpdate = true;
    if (oakMesh.instanceColor) oakMesh.instanceColor.needsUpdate = true;
    this.scene.add(trunkMesh, pineMesh, oakMesh);
    this.treeMeshes.push(trunkMesh, pineMesh, oakMesh);
  }

  _buildRocks() {
    const rocks = this.world.rocks;
    const geo = new THREE.DodecahedronGeometry(1, 1);
    const mat = this.renderer.registerMaterial(new THREE.MeshStandardMaterial({
      map: texture('rock'), color: 0xffffff, roughness: 0.96, metalness: 0.02, flatShading: true,
    }));
    const mesh = new THREE.InstancedMesh(geo, mat, rocks.length);
    mesh.castShadow = true; mesh.receiveShadow = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const s = new THREE.Vector3(), p = new THREE.Vector3(), color = new THREE.Color();
    rocks.forEach((r, i) => {
      e.set(r.rot * 0.4, r.rot, r.rot * 0.2); q.setFromEuler(e);
      p.set(r.x, r.y + r.h * 0.42, r.z);
      s.set(r.r * 0.9, r.h * 0.62, r.r * 0.9);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      color.setHex(0xa8aea3).lerp(new THREE.Color(0xc9bca2), (i % 9) * .035);
      mesh.setColorAt(i, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = 'rocks';
    this.scene.add(mesh);
    this.rockMesh = mesh;
  }

  // -------------------------------------------------------------------------
  // Water
  // -------------------------------------------------------------------------
  _buildWater() {
    const lake = this.world.lake;
    const geo = new THREE.CircleGeometry(lake.r * 1.36, 72);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSun: { value: new THREE.Vector3(...BLACKSHORE.sunDirection).normalize() },
        uShallow: { value: new THREE.Color(0x3f7a78) },
        uDeep: { value: new THREE.Color(0x12333c) },
        uSky: { value: new THREE.Color(0x9dc4dd) },
      },
      vertexShader: /* glsl */`
        uniform float uTime;
        varying vec3 vWorld;
        varying vec3 vNormalW;
        void main() {
          vec3 p = position;
          float w1 = sin(p.x * 0.22 + uTime * 1.1) * 0.06;
          float w2 = cos(p.z * 0.31 + uTime * 0.8) * 0.05;
          p.y += w1 + w2;
          vec4 wp = modelMatrix * vec4(p, 1.0);
          vWorld = wp.xyz;
          vNormalW = normalize(mat3(modelMatrix) * vec3(
            -cos(p.x * 0.22 + uTime * 1.1) * 0.013,
            1.0,
            sin(p.z * 0.31 + uTime * 0.8) * 0.015));
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform vec3 uSun, uShallow, uDeep, uSky;
        varying vec3 vWorld;
        varying vec3 vNormalW;
        void main() {
          vec3 V = normalize(cameraPosition - vWorld);
          vec3 N = normalize(vNormalW);
          float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
          float ripple = sin(vWorld.x * 1.7 + uTime * 2.0) * sin(vWorld.z * 1.3 - uTime * 1.6);
          N.x += ripple * 0.05; N.z += ripple * 0.04; N = normalize(N);
          vec3 col = mix(uDeep, uShallow, clamp(ripple * 0.3 + 0.5, 0.0, 1.0));
          col = mix(col, uSky, fres * 0.85);
          vec3 H = normalize(uSun + V);
          float spec = pow(max(dot(N, H), 0.0), 220.0) * 1.6;
          spec += pow(max(dot(N, H), 0.0), 18.0) * 0.12;
          col += vec3(1.0, 0.96, 0.88) * spec;
          gl_FragColor = vec4(col, 0.9);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(lake.x, lake.level, lake.z);
    mesh.name = 'water';
    mesh.renderOrder = 2;
    this.scene.add(mesh);
    this.water = mesh;
  }

  _buildBoundaryFog() {
    // Distant landforms and sea occupy the scenery outside the playable bounds.
    // A height-varying silhouette replaces the old flat cylindrical fog wall.
    for (let ring = 0; ring < 2; ring++) {
      const vertices = [], count = 112;
      const ridge = i => {
        const a = i / count * Math.PI * 2;
        const radius = 710 + ring * 250 + Math.sin(a * 7) * 42;
        const height = 35 + ring * 24 + Math.pow(Math.sin(a * 3.5 + ring), 2) * 90 + Math.pow(Math.cos(a * 8.5), 6) * 55;
        return [[Math.cos(a) * radius, -14, Math.sin(a) * radius], [Math.cos(a) * (radius + 80), height, Math.sin(a) * (radius + 80)]];
      };
      for (let i = 0; i < count; i++) {
        const [a, b] = ridge(i), [c, d] = ridge(i + 1);
        vertices.push(...a, ...b, ...c, ...c, ...b, ...d);
      }
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geo.computeVertexNormals();
      const mat = new THREE.MeshBasicMaterial({ color: ring ? 0x8e9f98 : 0x73897f, side: THREE.DoubleSide, fog: true });
      const mesh = new THREE.Mesh(geo, mat); mesh.name = `distant_ridge_${ring}`; this.scene.add(mesh);
    }
    const sea = new THREE.Shape(); sea.moveTo(-2200, -2200); sea.lineTo(2200, -2200); sea.lineTo(2200, 2200); sea.lineTo(-2200, 2200); sea.closePath();
    const island = new THREE.Path(); island.moveTo(-500, -500); island.lineTo(-500, 500); island.lineTo(500, 500); island.lineTo(500, -500); island.closePath(); sea.holes.push(island);
    const geo = new THREE.ShapeGeometry(sea); geo.rotateX(-Math.PI / 2);
    const ocean = new THREE.Mesh(geo, this.water.material); ocean.position.y = this.world.lake.level;
    ocean.name = 'distant_coast'; ocean.renderOrder = 2; this.scene.add(ocean);
  }

  update(dt, time) {
    if (this.water) this.water.material.uniforms.uTime.value = time;
    this.groundCover?.update(this.renderer.camera);
  }

  // Loot rendering is driven by the server's interest-filtered list.
  syncLoot(list) {
    const seen = new Set();
    for (const item of list) {
      seen.add(item.id);
      let mesh = this._lootMeshes?.get(item.id);
      if (!mesh) {
        mesh = this._makeLootMesh(item);
        if (!this._lootMeshes) this._lootMeshes = new Map();
        this._lootMeshes.set(item.id, mesh);
        this.lootGroup.add(mesh);
      }
      mesh.position.set(item.x, item.y, item.z);
      mesh.rotation.y = (item.id % 7) * 0.9;
    }
    if (this._lootMeshes) {
      for (const [id, mesh] of this._lootMeshes) {
        if (seen.has(id)) continue;
        this.lootGroup.remove(mesh);
        mesh.geometry?.dispose();
        this._lootMeshes.delete(id);
      }
    }
  }

  _makeLootMesh(item) {
    const g = new THREE.Group();
    let geo, color;
    if (item.type === 'weapon') {
      geo = new THREE.BoxGeometry(0.72, 0.16, 0.2);
      color = 0xffc861;
    } else if (item.type === 'armor') {
      geo = new THREE.BoxGeometry(0.42, 0.46, 0.2);
      color = 0x6fa8ff;
    } else if (item.type === 'heal') {
      geo = new THREE.BoxGeometry(0.34, 0.3, 0.24);
      color = 0xff6f7a;
    } else {
      geo = new THREE.BoxGeometry(0.32, 0.24, 0.24);
      color = 0xd9d2b4;
    }
    const mat = new THREE.MeshStandardMaterial({
      color, emissive: new THREE.Color(color).multiplyScalar(0.35),
      roughness: 0.55, metalness: 0.2,
    });
    const body = new THREE.Mesh(geo, mat);
    body.position.y = 0.18;
    g.add(body);
    const glowGeo = new THREE.PlaneGeometry(0.9, 0.9);
    const glowMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.16, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.02;
    g.add(glow);
    return g;
  }
}
