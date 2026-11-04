// CC0 leaf/plant/rock templates. Near canopies replace the cheap distant
// silhouettes; the original straight trunks retain the collider footprint.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const FILES = ['Pine_1', 'Pine_3', 'CommonTree_1', 'CommonTree_3', 'Bush_Common', 'Fern_1', 'Rock_Medium_1'];

export class NatureDetail {
  constructor(view) {
    this.view = view;
    this.root = new THREE.Group(); this.root.name = 'coastal_nature';
    view.scene.add(this.root);
    this.templates = new Map(); this.batches = new Map();
    this.geometries = new Set(); this.materials = new Set();
    this.lastX = Infinity; this.lastZ = Infinity; this.lastQuality = null;
    this.disposed = false;
    this.ready = this.load();
  }

  async load() {
    const loader = new GLTFLoader();
    const results = await Promise.allSettled(FILES.map(async name => {
      const asset = await loader.loadAsync(`/models/nature/${name}.gltf`);
      asset.scene.updateMatrixWorld(true);
      const parts = [];
      asset.scene.traverse(o => { if (o.isMesh) parts.push(o); });
      if (parts.length !== 1) throw new Error(`Expected one derived primitive in ${name}`);
      const part = parts[0], geometry = part.geometry.clone().applyMatrix4(part.matrixWorld), material = part.material;
      part.geometry.dispose();
      if (this.disposed) { geometry.dispose(); material.map?.dispose(); material.dispose(); return; }
      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox.clone(), size = bounds.getSize(new THREE.Vector3());
      material.roughness = .97; material.metalness = 0;
      material.envMapIntensity = .35;
      material.color.setHex(name.startsWith('Rock') ? 0xc3c4a7 : 0xe1e4d3);
      if (!name.startsWith('Rock')) { material.alphaTest = .3; material.transparent = false; material.side = THREE.DoubleSide; }
      if (material.map) {
        material.map.anisotropy = Math.min(8, this.view.renderer.renderer.capabilities.getMaxAnisotropy());
        this.view.ownedTextures.push(material.map);
      }
      if (name.startsWith('Rock')) {
        geometry.translate(-(bounds.min.x + bounds.max.x) / 2, -bounds.min.y, -(bounds.min.z + bounds.max.z) / 2);
        geometry.scale(2 / size.x, 1 / size.y, 2 / size.z);
      } else if (name === 'Bush_Common' || name === 'Fern_1') geometry.translate(0, -bounds.min.y, 0);
      this.geometries.add(geometry); this.materials.add(material);
      this.view.renderer.registerMaterial(material);
      this.templates.set(name, { geometry, material, height: Math.max(.1, bounds.max.y), size });
    }));
    if (this.disposed) return;
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    for (const name of FILES.filter(n => !n.startsWith('Rock'))) {
      const template = this.templates.get(name);
      const mesh = new THREE.InstancedMesh(template.geometry, template.material, this.view.world.trees.length * 2);
      mesh.name = `near_${name}`; mesh.count = 0;
      mesh.receiveShadow = true; mesh.castShadow = name.startsWith('Pine') || name.startsWith('CommonTree');
      mesh.frustumCulled = false;
      this.root.add(mesh); this.batches.set(name, mesh);
    }
    this.farPines = this.view.treeMeshes[1]; this.farOaks = this.view.treeMeshes[2];
    this.pineMatrices = this.farPines.instanceMatrix.array.slice();
    this.oakMatrices = this.farOaks.instanceMatrix.array.slice();
    const rock = this.templates.get('Rock_Medium_1');
    const rocks = new THREE.InstancedMesh(rock.geometry, rock.material, this.view.world.rocks.length);
    rocks.name = 'coastal_rocks'; rocks.castShadow = true; rocks.receiveShadow = true;
    const matrix = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Quaternion();
    this.view.world.rocks.forEach((r, i) => {
      p.set(r.x, r.y, r.z);
      // Quarter turns keep the normalised rock bounds inside the shared AABB.
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.floor(r.rot / (Math.PI / 2)) * Math.PI / 2);
      s.set(r.r * .8, r.h * .85, r.r * .8);
      rocks.setMatrixAt(i, matrix.compose(p, q, s));
    });
    this.view.rockMesh.removeFromParent();
    this.view.rockMesh.geometry.dispose(); this.view.rockMesh.material.dispose();
    this.view.rockMesh = rocks; this.root.add(rocks);
    this.loaded = true;
    this.update(this.view.renderer.camera);
  }

  update(camera) {
    if (!this.loaded) return;
    const quality = this.view.renderer.settings.quality;
    const x = camera.position.x, z = camera.position.z;
    if (Math.hypot(x - this.lastX, z - this.lastZ) < 4 && quality === this.lastQuality) return;
    this.lastX = x; this.lastZ = z; this.lastQuality = quality;
    const radius = quality === 'high' ? 120 : quality === 'medium' ? 85 : 45;
    this.farPines.instanceMatrix.array.set(this.pineMatrices);
    this.farOaks.instanceMatrix.array.set(this.oakMatrices);
    for (const batch of this.batches.values()) batch.count = 0;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0), matrix = new THREE.Matrix4();
    const p = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Quaternion(), axis = new THREE.Vector3(0, 1, 0);
    let pi = 0, oi = 0, count = 0, plants = 0;
    this.view.world.trees.forEach((tree, index) => {
      const pine = tree.type === 'pine', farIndex = pine ? pi++ : oi++ * 3;
      const distance = Math.hypot(x - tree.x, z - tree.z);
      if (distance > radius) return;
      if (pine) this.farPines.setMatrixAt(farIndex, zero);
      else for (let k = 0; k < 3; k++) this.farOaks.setMatrixAt(farIndex + k, zero);
      const name = pine ? (index % 2 ? 'Pine_1' : 'Pine_3') : (index % 2 ? 'CommonTree_1' : 'CommonTree_3');
      const template = this.templates.get(name), batch = this.batches.get(name);
      p.set(tree.x, tree.y, tree.z); q.setFromAxisAngle(axis, tree.rot);
      s.set(tree.scale * (pine ? .87 : 1), tree.h / template.height, tree.scale * (pine ? .87 : 1));
      batch.setMatrixAt(batch.count++, matrix.compose(p, q, s)); count++;
      if (quality === 'low' || distance > 45 || index % 3 === 0) return;
      for (let k = 0; k < 2; k++) {
        const angle = index * 2.4 + k * 3.3, px = tree.x + Math.cos(angle) * (tree.r + 1), pz = tree.z + Math.sin(angle) * (tree.r + 1);
        if (this.view.world.nearBuilding(px, pz, .8) || this.view.world.nearRoad(px, pz, 1.2) || this.view.world.isWater(px, pz)) continue;
        const plantName = k ? 'Fern_1' : 'Bush_Common', plant = this.batches.get(plantName);
        const height = this.templates.get(plantName).size.y;
        const scale = (k ? .32 : .52) / height;
        p.set(px, this.view.world.terrainHeight(px, pz) - .015, pz); s.setScalar(scale); q.setFromAxisAngle(axis, angle);
        plant.setMatrixAt(plant.count++, matrix.compose(p, q, s)); plants++;
      }
    });
    for (const batch of this.batches.values()) batch.instanceMatrix.needsUpdate = true;
    this.farPines.instanceMatrix.needsUpdate = true; this.farOaks.instanceMatrix.needsUpdate = true;
    this.treeCount = count; this.plantCount = plants;
  }

  dispose() {
    this.disposed = true; this.root.removeFromParent();
    this.geometries.forEach(g => g.dispose()); this.materials.forEach(m => m.dispose());
  }
}
