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
    const h = .19 + .10 * Math.sin(i * 5.3);
    const side = [Math.cos(angle + Math.PI / 2) * .017, Math.sin(angle + Math.PI / 2) * .017];
    const left = [x - side[0], 0, z - side[1]], right = [x + side[0], 0, z + side[1]];
    const midLeft = [x * 1.28 - side[0] * .6, h * .62, z * 1.28 - side[1] * .6];
    const midRight = [x * 1.28 + side[0] * .6, h * .62, z * 1.28 + side[1] * .6];
    vertices.push(...left, ...right, ...midRight, ...left, ...midRight, ...midLeft, ...midLeft, ...midRight, x * 1.9, h, z * 1.9);
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
    this.cell = .83;
    this.radius = 22;
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
    this.roadSegments = world.roads.flatMap(r => r.points.slice(1).map((p, i) => {
      const a = r.points[i], b = p, width = r.width * .5 + .8;
      const minX = Math.min(a[0], b[0]) - width, maxX = Math.max(a[0], b[0]) + width;
      const minZ = Math.min(a[1], b[1]) - width, maxZ = Math.max(a[1], b[1]) + width;
      const vx = b[0] - a[0], vz = b[1] - a[1];
      const lenSq = vx * vx + vz * vz || 1;
      const wSq = width * width;
      return { a, b, width, minX, maxX, minZ, maxZ, vx, vz, lenSq, wSq };
    }));

    // Pre-index road segments into 20m spatial cells for O(1) road testing
    this.roadGridCell = 20;
    this.roadGrid = new Map();
    for (const s of this.roadSegments) {
      const minGx = Math.floor(s.minX / this.roadGridCell), maxGx = Math.floor(s.maxX / this.roadGridCell);
      const minGz = Math.floor(s.minZ / this.roadGridCell), maxGz = Math.floor(s.maxZ / this.roadGridCell);
      for (let gx = minGx; gx <= maxGx; gx++) {
        for (let gz = minGz; gz <= maxGz; gz++) {
          const key = (gx << 16) | (gz & 0xffff);
          let list = this.roadGrid.get(key);
          if (!list) { list = []; this.roadGrid.set(key, list); }
          list.push(s);
        }
      }
    }
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
      const patch = Math.sin(x * .22 + Math.cos(z * .17)) * Math.cos(z * .19);
      if (patch < -.25 && f < .65) continue;
      if (Math.abs(x) > 488 || Math.abs(z) > 488 || w.isWater(x, z) || w.nearBuilding(x, z, .9)) continue;
      
      const rKey = (Math.floor(x / this.roadGridCell) << 16) | (Math.floor(z / this.roadGridCell) & 0xffff);
      const rList = this.roadGrid.get(rKey);
      if (rList) {
        let road = false;
        for (let j = 0; j < rList.length; j++) {
          const s = rList[j];
          if (x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue;
          const t = clamp(((x - s.a[0]) * s.vx + (z - s.a[1]) * s.vz) / s.lenSq, 0, 1);
          const ddx = x - s.a[0] - s.vx * t, ddz = z - s.a[1] - s.vz * t;
          if (ddx * ddx + ddz * ddz < s.wSq) { road = true; break; }
        }
        if (road) continue;
      }

      position.set(x, w.terrainHeight(x, z) - .025, z);
      rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), f * Math.PI * 2);
      const size = .75 + f * .85;
      scale.set(size, size * (.75 + f * .5), size);
      matrix.compose(position, rotation, scale);
      this.mesh.setMatrixAt(count, matrix);
      colour.setHex(BLACKSHORE.foliage[hash % BLACKSHORE.foliage.length]);
      colour.lerp(new THREE.Color(0x9a996b), f * .2).multiplyScalar(.7);
      this.mesh.setColorAt(count++, colour);
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
