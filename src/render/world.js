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
import { NatureDetail } from './nature.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { createWeaponModel } from './weapon-model.js';
import { mergeSpatialGeometry, splitGridGeometry } from './geometry.js';
import { addCoastalDetails } from './coastal-details.js';
import { FieldAssets } from './field-assets.js';
import { loadCoastalSurfaces } from './surfaces.js';
import { assetUrl } from '../asset.js';

const _v = new THREE.Vector3();

// Loot models of the same shape can be swapped between pickups. Weapon loot
// includes its key so an AR mesh never becomes a pistol.
export function lootPoolKey(item) {
  return item.type === 'weapon'
    ? `weapon:${item.weapon || 'ar'}`
    : `${item.type || 'item'}:${item.sub || ''}`;
}

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

export function prepareStaticGeometry(geo, color) {
  const nonIndexed = geo.index ? geo.toNonIndexed() : geo.clone();
  if (!nonIndexed.attributes.normal) nonIndexed.computeVertexNormals();
  const count = nonIndexed.attributes.position.count;
  if (!nonIndexed.attributes.uv) {
    nonIndexed.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  const colors = new Float32Array(count * 3);
  const r = color ? (color.r !== undefined ? color.r : 1) : 1;
  const g = color ? (color.g !== undefined ? color.g : 1) : 1;
  const b = color ? (color.b !== undefined ? color.b : 1) : 1;
  for (let i = 0; i < count; i++) {
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  nonIndexed.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return nonIndexed;
}

class ArchetypePool {
  constructor(key, meshes, boxes) {
    this.key = key;
    this.meshes = meshes;
    this.maxCount = boxes.length;
    this.activeCount = boxes.length;
    this.boxIdToIndex = new Map();
    this.indexToBoxId = new Array(boxes.length);
    this.baseMatrices = new Map();

    const matrix = new THREE.Matrix4();
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const cx = (b.min[0] + b.max[0]) / 2, cy = b.min[1], cz = (b.min[2] + b.max[2]) / 2;
      matrix.makeTranslation(cx, cy, cz);
      for (const im of meshes) im.setMatrixAt(i, matrix);
      this.boxIdToIndex.set(b.id, i);
      this.indexToBoxId[i] = b.id;
      this.baseMatrices.set(b.id, matrix.clone());
    }
    for (const im of meshes) {
      im.count = this.activeCount;
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
    }
  }

  removeBox(boxId) {
    const idx = this.boxIdToIndex.get(boxId);
    if (idx === undefined || idx >= this.activeCount) return;

    const lastIdx = this.activeCount - 1;
    if (idx !== lastIdx) {
      const lastBoxId = this.indexToBoxId[lastIdx];
      const tempMatrix = new THREE.Matrix4();
      for (const im of this.meshes) {
        im.getMatrixAt(lastIdx, tempMatrix);
        im.setMatrixAt(idx, tempMatrix);
      }
      this.boxIdToIndex.set(lastBoxId, idx);
      this.indexToBoxId[idx] = lastBoxId;
      this.indexToBoxId[lastIdx] = boxId;
      this.boxIdToIndex.set(boxId, lastIdx);
    }

    this.activeCount--;
    for (const im of this.meshes) {
      im.count = this.activeCount;
      im.instanceMatrix.needsUpdate = true;
    }
  }

  syncDestruction(destroyedSet) {
    let i = 0;
    for (const [boxId, mat] of this.baseMatrices) {
      this.boxIdToIndex.set(boxId, i);
      this.indexToBoxId[i] = boxId;
      for (const im of this.meshes) {
        im.setMatrixAt(i, mat);
      }
      i++;
    }
    this.activeCount = this.maxCount;

    for (const id of destroyedSet) {
      if (this.baseMatrices.has(id)) {
        this.removeBox(id);
      }
    }

    for (const im of this.meshes) {
      im.count = this.activeCount;
      im.instanceMatrix.needsUpdate = true;
    }
  }
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
    this.scene = new THREE.Group();
    this.scene.name = 'blackshore_world';
    renderer.scene.add(this.scene);
    this.ownedTextures = [];
    this.disposed = false;
    this.mats = makeMaterials(renderer);
    this.facadeMaterials = [0xb8c4b6, 0x7f9694, 0xc6bc9e, 0x89937d, 0xb5aea0].map(color =>
      renderer.registerMaterial(new THREE.MeshStandardMaterial({ color, map: texture('plaster'), roughness: .9 })));
    this.buildingStyles = new Map(world.buildings.map((building, index) => [building, index % this.facadeMaterials.length]));
    this.fieldAssets = new FieldAssets(renderer, this.mats);
    this.masterStructureMat = renderer.registerMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff, map: texture('plaster'), roughness: 0.88, metalness: 0.08, vertexColors: true
    }));
    this.masterBrickMat = renderer.registerMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff, map: texture('brick'), roughness: 0.95, metalness: 0.0, vertexColors: true
    }));
    this.masterDetailMat = renderer.registerMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff, map: texture('plaster'), roughness: 0.9, metalness: 0.05, vertexColors: true
    }));
    this.pools = new Map();
    this.boxPools = new Map();
    this.pendingDetailGeos = [];
    this.dynamicMeshes = new Map();
    this.dynamicInstances = new Map();
    this.dynamicInstancedGroups = [];
    this.staticMeshes = [];
    this.glassMeshes = [];
    this.glassDestroyed = new Set();
    this.treeMeshes = [];
    this.rockMesh = null;
    this.water = null;
    this.lootGroup = new THREE.Group();
    this.lootGroup.name = 'loot';
    this.scene.add(this.lootGroup);
    this._lootMeshes = new Map();
    this._lootPool = new Map();
    this._lootPoolCount = 0;
    this.lootStats = { created: 0, reused: 0, disposed: 0 };
    this._buildTerrain();
    this._buildRoads();
    this._buildBoxes();
    this._buildArchitecture();
    addCoastalDetails(this);
    this._mergeDetailGeometries();
    this._buildTrees();
    this._buildRocks();
    this._buildWater();
    this._buildBoundaryFog();
    this.groundCover = new GroundCover(renderer, world);
    this.scene.add(this.groundCover.mesh);
    this.nature = new NatureDetail(this);
    this.assetsReady = Promise.all([this.assetsReady, this.nature.ready, loadCoastalSurfaces(this)]).catch(error => {
      this.assetError = String(error); console.error('World asset load failed', error);
    }).then(() => { this.assetsLoaded = true; });
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
      c.lerp(new THREE.Color(0xffffff), .43);
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
    const tiles = splitGridGeometry(geo, N).map((geometry, i) => {
      const mesh = new THREE.Mesh(geometry, mat); mesh.receiveShadow = true; mesh.name = `terrain_${i}`; return mesh;
    });
    this.terrain = tiles[0];
    this.scene.add(...tiles);
    const loader = new THREE.TextureLoader();
    const load = (file, colour) => loader.loadAsync(assetUrl(`textures/${file}.webp`)).then(tex => {
      tex.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(w.size / 2.5, w.size / 2.5);
      tex.anisotropy = Math.min(8, this.renderer.renderer.capabilities.getMaxAnisotropy());
      return tex;
    });
    this.assetsReady = Promise.all([
      load('grass-albedo', true), load('grass-normal', false), load('grass-roughness', false),
    ]).then(([albedo, normal, roughness]) => {
      if (this.disposed) { for (const map of [albedo, normal, roughness]) map.dispose(); return; }
      this.ownedTextures.push(albedo, normal, roughness);
      mat.map = albedo; mat.normalMap = normal; mat.normalScale.set(.5, .5);
      mat.bumpMap = null; mat.roughnessMap = roughness; mat.needsUpdate = true;
    }).catch(error => { this.assetError = String(error); console.error('Terrain texture load failed', error); });
  }

  // -------------------------------------------------------------------------
  // Roads
  // -------------------------------------------------------------------------
  _buildRoads() {
    const positions = [], uvs = [], indices = [];
    const edgePositions = [], edgeUvs = [], edgeIndices = [];
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
      const edgeStart = edgePositions.length / 3;
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
          uvs.push((side * .5 + .5) * road.width / 3, along / 3);
          for (const distance of [half - .02, half + .78]) {
            const ex = x + nx * distance * side, ez = z + nz * distance * side;
            edgePositions.push(ex, this.world.terrainHeight(ex, ez) + .046, ez);
            edgeUvs.push(distance < half ? 0 : 1, along / 4);
          }
        }
        if (i > 0) {
          const a = vOff + (i - 1) * 2, b = a + 1, c2 = a + 2, d = a + 3;
          indices.push(a, b, c2, b, d, c2);
          for (const side of [0, 2]) {
            const a = edgeStart + (i - 1) * 4 + side, c = a + 4;
            edgeIndices.push(a, a + 1, c, a + 1, c + 1, c);
          }
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
    this.roadMaterial = mat;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'roads';
    this.scene.add(mesh);
    const edge = new THREE.BufferGeometry();
    edge.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
    edge.setAttribute('uv', new THREE.Float32BufferAttribute(edgeUvs, 2)); edge.setIndex(edgeIndices); edge.computeVertexNormals();
    const shoulder = new THREE.Mesh(edge, this.renderer.registerMaterial(new THREE.MeshStandardMaterial({
      map: texture('verge'), color: 0xd4d0b6, roughness: 1, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 })));
    shoulder.name = 'road_gravel_verges'; shoulder.receiveShadow = true; this.scene.add(shoulder);
  }

  // -------------------------------------------------------------------------
  // Boxes
  // -------------------------------------------------------------------------
  _buildBoxes() {
    const structureGeos = [];
    const brickGeos = [];
    const decalBins = new Map();

    const archetypeBins = new Map();
    const nonArchetypeDynamic = [];

    for (const b of this.world.boxes) {
      if (!b.render || b.destroyed) continue;
      // Glass is destructible but merged into a few spatial meshes instead of
      // one mesh per pane (248 panes). _rebuildGlass() swaps the merge when a
      // pane breaks, keeping the draw-call count flat during normal play.
      if (b.tag === 'glass') continue;
      if (b.dynamic) {
        let key = null;
        if (b.tag === 'barrel') key = (b.id % 3) ? 'barrel_rust' : 'barrel_amber';
        else if (['sandbag', 'crate', 'fence'].includes(b.tag)) key = b.tag;
        if (key) {
          let list = archetypeBins.get(key);
          if (!list) { list = []; archetypeBins.set(key, list); }
          list.push(b);
        } else {
          nonArchetypeDynamic.push(b);
        }
        continue;
      }

      if (b.tag === 'glass') {
        continue;
      }

      const model = this.fieldAssets.create(b);
      if (model) {
        model.updateMatrixWorld(true);
        model.traverse(part => {
          if (!part.isMesh) return;
          const geometry = (part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone()).applyMatrix4(part.matrixWorld);
          if (part.material.transparent || part.material.userData?.noShadow) {
            if (part.material.map && part.material.alphaTest) {
              const list = decalBins.get(part.material) || []; list.push(geometry); decalBins.set(part.material, list);
            } else {
              geometry.dispose();
            }
          } else if (b.tag === 'furniture') {
            this.pendingDetailGeos.push(prepareStaticGeometry(geometry, part.material.color));
            geometry.dispose();
          } else {
            structureGeos.push(prepareStaticGeometry(geometry, part.material.color));
            geometry.dispose();
          }
        });
      } else {
        const original = boxGeometry(b);
        const mat = this.facadeMaterial(b);
        const color = mat ? mat.color : new THREE.Color(MATERIALS[b.mat]?.color || 0xcccccc);
        if (['floor', 'stairs', 'furniture', 'interior', 'foundation'].includes(b.tag)) {
          this.pendingDetailGeos.push(prepareStaticGeometry(original, color));
        } else if (b.tag === 'wall' && b.mat === 'brick' && mat === this.mats.brick) {
          brickGeos.push(prepareStaticGeometry(original, color));
        } else {
          structureGeos.push(prepareStaticGeometry(original, color));
        }
        original.dispose();
      }
    }

    if (structureGeos.length) {
      const meshes = mergeSpatialGeometry(structureGeos, this.masterStructureMat, 'static_structure', 160);
      for (const mesh of meshes) { mesh.castShadow = true; mesh.receiveShadow = true; }
      this.scene.add(...meshes); this.staticMeshes.push(...meshes);
    }

    if (brickGeos.length) {
      const meshes = mergeSpatialGeometry(brickGeos, this.masterBrickMat, 'static_brick', 160);
      for (const mesh of meshes) { mesh.castShadow = true; mesh.receiveShadow = true; }
      this.scene.add(...meshes); this.staticMeshes.push(...meshes);
    }

    this._rebuildGlass();

    for (const [mat, geos] of decalBins) {
      const meshes = mergeSpatialGeometry(geos, mat, `static_decal_${mat.id}`, 160);
      for (const mesh of meshes) { mesh.castShadow = false; mesh.receiveShadow = true; }
      this.scene.add(...meshes); this.staticMeshes.push(...meshes);
    }

    // Build instanced dynamic archetypes with swap-and-pop pool
    for (const [archetypeKey, boxes] of archetypeBins) {
      const sampleBox = boxes[0];
      const sampleModel = this.fieldAssets.create(sampleBox);
      if (!sampleModel) continue;
      sampleModel.updateMatrixWorld(true);

      const parts = [];
      sampleModel.traverse(child => {
        if (child.isMesh) {
          child.updateMatrix();
          const geo = (child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone()).applyMatrix4(child.matrix);
          parts.push({ geometry: geo, material: child.material, castShadow: child.castShadow, receiveShadow: child.receiveShadow });
        }
      });

      const instancedMeshes = parts.map((part, pIdx) => {
        const im = new THREE.InstancedMesh(part.geometry, part.material, boxes.length);
        im.name = `dynamic_${archetypeKey}_${pIdx}`;
        im.castShadow = part.castShadow;
        im.receiveShadow = part.receiveShadow;
        im.frustumCulled = true;
        this.scene.add(im);
        this.dynamicInstancedGroups.push(im);
        return im;
      });

      const pool = new ArchetypePool(archetypeKey, instancedMeshes, boxes);
      this.pools.set(archetypeKey, pool);
      for (const b of boxes) {
        this.boxPools.set(b.id, pool);
      }

      sampleModel.traverse(c => { c.geometry?.dispose(); });
    }

    for (const b of nonArchetypeDynamic) {
      const mesh = this.fieldAssets.create(b) || new THREE.Mesh(boxGeometry(b), this.mats[b.mat]);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.name = `dyn_${b.id}`;
      this.scene.add(mesh);
      this.dynamicMeshes.set(b.id, mesh);
    }
  }

  _mergeDetailGeometries() {
    if (!this.pendingDetailGeos.length) return;
    const meshes = mergeSpatialGeometry(this.pendingDetailGeos, this.masterDetailMat, 'static_detail', 160);
    for (const m of meshes) {
      m.castShadow = false;
      m.receiveShadow = true;
    }
    this.scene.add(...meshes);
    this.staticMeshes.push(...meshes);
    this.pendingDetailGeos = [];
  }

  // Glass panes share a few merged meshes. Rebuilding only happens when the
  // set of broken panes changes, so normal play keeps the original topology.
  _rebuildGlass() {
    for (const mesh of this.glassMeshes) {
      this.scene.remove(mesh);
      mesh.geometry?.dispose();
    }
    this.glassMeshes.length = 0;
    const geos = [];
    for (const b of this.world.boxes) {
      if (b.tag !== 'glass' || !b.render || b.destroyed) continue;
      const geo = boxGeometry(b);
      geos.push(geo.index ? geo.toNonIndexed() : geo);
    }
    if (!geos.length) return;
    const meshes = mergeSpatialGeometry(geos, this.mats.glass, 'static_glass', 160);
    for (const mesh of meshes) { mesh.castShadow = false; mesh.receiveShadow = true; }
    this.scene.add(...meshes);
    this.glassMeshes.push(...meshes);
  }

  facadeMaterial(box) {
    if (box.tag !== 'wall' || !['plaster', 'brick'].includes(box.mat)) return this.mats[box.mat];
    const x = (box.min[0] + box.max[0]) / 2, z = (box.min[2] + box.max[2]) / 2;
    const building = this.world.buildings.find(b => Math.abs(x - b.x) < b.w / 2 + .25 && Math.abs(z - b.z) < b.d / 2 + .25);
    if (!building) return this.mats[box.mat];
    if (box.mat === 'brick' && building.type === 'urban') return this.mats.brick;
    return this.facadeMaterials[this.buildingStyles.get(building)];
  }

  removeBox(id) {
    const box = this.world.boxes[id];
    if (box?.dynamic) box.destroyed = true;
    if (box?.tag === 'glass') {
      if (!this.glassDestroyed.has(id)) {
        this.glassDestroyed.add(id);
        this._rebuildGlass();
      }
      return;
    }
    const pool = this.boxPools.get(id);
    if (pool) {
      pool.removeBox(id);
      return;
    }
    const mesh = this.dynamicMeshes.get(id);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.traverse(part => part.geometry?.dispose());
    this.dynamicMeshes.delete(id);
  }

  syncDestruction(ids) {
    const destroyed = new Set(ids);
    for (const pool of this.pools.values()) {
      pool.syncDestruction(destroyed);
    }
    for (const b of this.world.boxes) {
      if (!b.render) continue;
      if (b.tag === 'glass') { b.destroyed = destroyed.has(b.id); continue; }
      if (!b.dynamic) continue;
      const gone = destroyed.has(b.id);
      b.destroyed = gone;
      if (this.boxPools.has(b.id)) continue;
      if (gone) {
        this.removeBox(b.id);
      } else if (!this.dynamicMeshes.has(b.id)) {
        b.hp = b.maxHp;
        const mesh = this.fieldAssets.create(b) || new THREE.Mesh(boxGeometry(b), this.mats[b.mat]);
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.name = `dyn_${b.id}`;
        this.scene.add(mesh); this.dynamicMeshes.set(b.id, mesh);
      }
    }
    // Rebuild the merged glass only when the broken-pane set actually changed.
    const nextGlass = new Set();
    for (const b of this.world.boxes) if (b.tag === 'glass' && b.destroyed) nextGlass.add(b.id);
    let glassChanged = nextGlass.size !== this.glassDestroyed.size;
    if (!glassChanged) {
      for (const id of nextGlass) if (!this.glassDestroyed.has(id)) { glassChanged = true; break; }
    }
    if (glassChanged) {
      this.glassDestroyed = nextGlass;
      this._rebuildGlass();
    }
  }

  dispose() {
    this.disposed = true;
    this.nature?.dispose();
    this.scene.removeFromParent();
    const geometries = new Set(), materials = new Set([
      ...Object.values(this.mats),
      this.masterStructureMat, this.masterBrickMat, this.masterDetailMat
    ].filter(Boolean));
    this.scene.traverse(o => {
      if (o.geometry) geometries.add(o.geometry);
      if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
    });
    geometries.forEach(g => g.dispose());
    materials.forEach(m => m.dispose());
    this.ownedTextures.forEach(t => t.dispose());
    // Active loot was traversed above; pooled, detached meshes need explicit
    // ownership cleanup or their buffers survive the match teardown.
    for (const pool of this._lootPool.values()) for (const mesh of pool) this._disposeLootMesh(mesh);
    this._lootPool.clear();
    this._lootMeshes.clear();
    this._lootPoolCount = 0;
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
        add(trim, b.x, top - .12, b.z + side * b.d / 2, b.w + .34, .13, .34);
        add(trim, b.x + side * b.w / 2, top - .12, b.z, .34, .13, b.d + .34);
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
    this.ownedTextures.push(atlas);
    for (const g of trim) {
      this.pendingDetailGeos.push(prepareStaticGeometry(g, new THREE.Color(0xada98b)));
      g.dispose();
    }
    for (const g of bands) {
      this.pendingDetailGeos.push(prepareStaticGeometry(g, new THREE.Color(0x667366)));
      g.dispose();
    }
    if (signGeometries.length) {
      const serialMat = this.renderer.registerMaterial(new THREE.MeshStandardMaterial({ map: atlas, roughness: .85 }));
      const meshes = mergeSpatialGeometry(signGeometries, serialMat, 'building_serials', 160);
      for (const m of meshes) { m.castShadow = false; m.receiveShadow = true; }
      this.scene.add(...meshes); this.staticMeshes.push(...meshes);
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
    const geo = new THREE.CircleGeometry(lake.r * 1.45, 128);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
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
    // Three-dimensional, lit distant land instead of a flat opaque skyline.
    // The innermost radius clears even the square terrain's farthest corner.
    const vertices = [], colors = [], indices = [], count = 144, bands = 5;
    const low = new THREE.Color(0x677c66), high = new THREE.Color(0x9caa96), color = new THREE.Color();
    for (let band = 0; band < bands; band++) for (let i = 0; i < count; i++) {
      const a = i / count * Math.PI * 2;
      const radius = 790 + band * 145 + Math.sin(a * 5 + band * .4) * 34;
      const ridge = 70 + Math.sin(a * 3.0) ** 2 * 65 + Math.cos(a * 7) ** 4 * 25;
      const height = Math.sin(band / (bands - 1) * Math.PI) * ridge - 12;
      vertices.push(Math.cos(a) * radius, height, Math.sin(a) * radius);
      color.copy(low).lerp(high, Math.max(0, height) / 120);
      colors.push(color.r, color.g, color.b);
      if (band < bands - 1) {
        const k = band * count + i, next = band * count + (i + 1) % count;
        indices.push(k, k + count, next, next, k + count, next + count);
      }
    }
    const land = new THREE.BufferGeometry();
    land.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    land.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); land.setIndex(indices); land.computeVertexNormals();
    const material = this.renderer.registerMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
    const hills = new THREE.Mesh(land, material); hills.name = 'distant_coastal_land'; this.scene.add(hills);
    const sea = new THREE.Shape(); sea.moveTo(-2200, -2200); sea.lineTo(2200, -2200); sea.lineTo(2200, 2200); sea.lineTo(-2200, 2200); sea.closePath();
    const island = new THREE.Path(); island.moveTo(-500, -500); island.lineTo(-500, 500); island.lineTo(500, 500); island.lineTo(500, -500); island.closePath(); sea.holes.push(island);
    const geo = new THREE.ShapeGeometry(sea); geo.rotateX(-Math.PI / 2);
    const ocean = new THREE.Mesh(geo, this.water.material); ocean.position.y = this.world.lake.level;
    ocean.name = 'distant_coast'; ocean.renderOrder = 2; this.scene.add(ocean);
  }

  update(dt, time) {
    if (this.water) this.water.material.uniforms.uTime.value = time;
    this.groundCover?.update(this.renderer.camera);
    this.nature?.update(this.renderer.camera);
  }

  // Loot rendering is driven by the server's interest-filtered list. Meshes are
  // created within 65 m, retained until 78 m (hysteresis avoids churn exactly at
  // the boundary) and recycled through a small bounded per-shape pool.
  syncLoot(list) {
    const camera = this.renderer.camera.position;
    const CREATE_SQ = 65 * 65, RETAIN_SQ = 78 * 78;
    const seen = this._lootSeen || (this._lootSeen = new Set());
    seen.clear();
    for (const item of list) {
      const dx = item.x - camera.x, dz = item.z - camera.z;
      const distSq = dx * dx + dz * dz;
      let mesh = this._lootMeshes.get(item.id);
      if (mesh) {
        seen.add(item.id);
        if (distSq > RETAIN_SQ) { mesh.visible = false; continue; }
      } else {
        if (distSq > CREATE_SQ) continue;
        seen.add(item.id);
        const key = lootPoolKey(item);
        mesh = this._takeLootMesh(key) || this._makeLootMesh(item);
        this._lootMeshes.set(item.id, mesh);
        this.lootGroup.add(mesh);
      }
      mesh.visible = true;
      mesh.position.set(item.x, item.y, item.z);
      mesh.rotation.y = (item.id % 7) * 0.9;
    }
    // Absent from the authoritative list means picked up or despawned: release
    // it now rather than retaining every object ever seen.
    for (const [id, mesh] of this._lootMeshes) {
      if (seen.has(id)) continue;
      this._lootMeshes.delete(id);
      this.lootGroup.remove(mesh);
      this._recycleLootMesh(mesh);
    }
  }

  _takeLootMesh(key) {
    const pool = this._lootPool.get(key);
    if (!pool?.length) return null;
    this._lootPoolCount--;
    this.lootStats.reused++;
    return pool.pop();
  }

  _recycleLootMesh(mesh) {
    if (this._lootPoolCount >= 16) { this._disposeLootMesh(mesh); return; }
    const key = mesh.userData.lootKey || 'item';
    mesh.visible = false;
    let pool = this._lootPool.get(key);
    if (!pool) { pool = []; this._lootPool.set(key, pool); }
    pool.push(mesh);
    this._lootPoolCount++;
  }

  _disposeLootMesh(mesh) {
    const geometries = new Set(), materials = new Set();
    mesh.traverse(o => { if (o.geometry) geometries.add(o.geometry); if (o.material) materials.add(o.material); });
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
    this.lootStats.disposed++;
  }

  _makeLootMesh(item) {
    const g = new THREE.Group();
    g.userData.lootKey = lootPoolKey(item);
    this.lootStats.created++;
    let color;
    const material = (colour, metalness = .05) => new THREE.MeshStandardMaterial({ color: colour, roughness: .8, metalness });
    const add = (geometry, mat, x, y, z) => { const mesh = new THREE.Mesh(geometry, mat); mesh.position.set(x, y, z); g.add(mesh); return mesh; };
    if (item.type === 'weapon') {
      const weapon = createWeaponModel(item.weapon, false);
      weapon.root.rotation.z = Math.PI / 2; weapon.root.position.y = .08;
      g.add(weapon.root); color = 0xd9b975;
    } else if (item.type === 'armor') {
      const cloth = material(0x65705b);
      add(new RoundedBoxGeometry(.31, .1, .38, 1, .025), cloth, 0, .08, 0);
      for (const side of [-1, 1]) add(new THREE.BoxGeometry(.03, .035, .4), material(0x353f32), side * .1, .135, 0);
      color = 0x89b9bc;
    } else if (item.type === 'med' || item.type === 'heal') {
      add(new RoundedBoxGeometry(.27, .16, .22, 1, .025), material(0x727659), 0, .11, 0);
      const marking = material(0xe3dfc7);
      add(new THREE.BoxGeometry(.035, .007, .105), marking, 0, .195, 0);
      add(new THREE.BoxGeometry(.105, .007, .035), marking, 0, .195, 0);
      color = 0xd2deb1;
    } else if (item.type === 'grenade') {
      const smoke = item.sub === 'smoke';
      add(smoke ? new THREE.CylinderGeometry(.05, .05, .15, 12) : new THREE.IcosahedronGeometry(.073, 1), material(0x506347, .3), 0, .1, 0);
      add(new THREE.BoxGeometry(.025, .04, .06), material(0x969889, .7), 0, .18, 0);
      color = smoke ? 0xaac4bf : 0xd4b47a;
    } else {
      add(new RoundedBoxGeometry(.21, .12, .17, 1, .01), material(0x94866c), 0, .09, 0);
      add(new THREE.BoxGeometry(.22, .014, .18), material(0x424b39), 0, .158, 0);
      color = 0xc8c9ac;
    }
    this.renderer.registerObject(g);
    const glowGeo = new THREE.RingGeometry(.17, .19, 24);
    const glowMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: .65, depthWrite: false, side: THREE.DoubleSide,
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.02;
    g.add(glow);
    return g;
  }
}
