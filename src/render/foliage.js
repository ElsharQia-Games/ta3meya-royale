// Original geometry for broken, layered tree silhouettes and close ground cover.
import * as THREE from 'three';
import { BLACKSHORE } from './style.js';
import { clamp } from '../../shared/math.js';

export function pineGeometry() {
  const vertices = [];
  const tri = (a, b, c) => vertices.push(...a, ...b, ...c);
  for (let tier = 0; tier < 7; tier++) {
    const y = .08 + tier * .128;
    const radius = 1.05 - tier * .135;
    for (let branch = 0; branch < 11; branch++) {
      const angle = branch / 11 * Math.PI * 2 + tier * .63;
      const length = radius * (.88 + .12 * Math.sin(branch * 7.7 + tier * 3.1));
      const tip = [Math.cos(angle) * length, y - .035, Math.sin(angle) * length];
      const left = [Math.cos(angle - .25) * length * .58, y + .01, Math.sin(angle - .25) * length * .58];
      const right = [Math.cos(angle + .25) * length * .58, y + .01, Math.sin(angle + .25) * length * .58];
      const root = [0, y + .15, 0];
      tri(root, left, tip); tri(root, tip, right);
      tri(left, [0, y - .02, 0], right);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function tuftGeometry() {
  const vertices = [];
  for (let i = 0; i < 9; i++) {
    const angle = i * 2.4;
    const x = Math.cos(angle) * .09, z = Math.sin(angle) * .09;
    const h = .2 + .075 * Math.sin(i * 5.3);
    const side = [Math.cos(angle + Math.PI / 2) * .012, Math.sin(angle + Math.PI / 2) * .012];
    vertices.push(x - side[0], 0, z - side[1], x + side[0], 0, z + side[1], x * 1.7, h, z * 1.7);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export class GroundCover {
  constructor(renderer, world) {
    this.renderer = renderer;
    this.world = world;
    this.cell = 1.55;
    this.radius = 31;
    this.lastX = Infinity; this.lastZ = Infinity;
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .96, side: THREE.DoubleSide });
    renderer.registerMaterial(material);
    const mesh = this.mesh = new THREE.InstancedMesh(tuftGeometry(), material, (this.radius * 2 + 1) ** 2);
    mesh.name = 'near_ground_cover';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    mesh.count = 0;
    renderer.scene.add(mesh);
    this.roadSegments = world.roads.flatMap(r => r.points.slice(1).map((p, i) => ({ a: r.points[i], b: p, width: r.width * .5 + .8 })));
  }

  update(camera) {
    this.mesh.visible = this.renderer.settings.quality !== 'low';
    if (!this.mesh.visible) return;
    const cx = Math.round(camera.position.x / this.cell), cz = Math.round(camera.position.z / this.cell);
    if (Math.abs(cx - this.lastX) < 4 && Math.abs(cz - this.lastZ) < 4) return;
    this.lastX = cx; this.lastZ = cz;
    const w = this.world, matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion();
    const position = new THREE.Vector3(), scale = new THREE.Vector3(), colour = new THREE.Color();
    let count = 0;
    for (let dz = -this.radius; dz <= this.radius; dz++) for (let dx = -this.radius; dx <= this.radius; dx++) {
      if (dx * dx + dz * dz > this.radius ** 2) continue;
      const gx = cx + dx, gz = cz + dz;
      const hash = (Math.imul(gx, 73856093) ^ Math.imul(gz, 19349663) ^ w.seed) >>> 0;
      const f = (hash % 997) / 997;
      const x = (gx + f * .7) * this.cell, z = (gz + ((hash >>> 10) % 991) / 991 * .7) * this.cell;
      if (Math.abs(x) > 488 || Math.abs(z) > 488 || w.isWater(x, z) || w.nearBuilding(x, z, .9)) continue;
      let road = false;
      for (const s of this.roadSegments) {
        if (x < Math.min(s.a[0], s.b[0]) - s.width || x > Math.max(s.a[0], s.b[0]) + s.width || z < Math.min(s.a[1], s.b[1]) - s.width || z > Math.max(s.a[1], s.b[1]) + s.width) continue;
        const vx = s.b[0] - s.a[0], vz = s.b[1] - s.a[1];
        const t = clamp(((x - s.a[0]) * vx + (z - s.a[1]) * vz) / (vx * vx + vz * vz || 1), 0, 1);
        if (Math.hypot(x - s.a[0] - vx * t, z - s.a[1] - vz * t) < s.width) { road = true; break; }
      }
      if (road) continue;
      position.set(x, w.terrainHeight(x, z) - .025, z);
      rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), f * Math.PI * 2);
      const size = .55 + f * .7;
      scale.set(size, size * (.75 + f * .5), size);
      matrix.compose(position, rotation, scale);
      this.mesh.setMatrixAt(count, matrix);
      colour.setHex(BLACKSHORE.foliage[hash % BLACKSHORE.foliage.length]);
      colour.lerp(new THREE.Color(0xb9a574), f * .4);
      this.mesh.setColorAt(count++, colour);
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
