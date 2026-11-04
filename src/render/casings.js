import * as THREE from 'three';

// A small cosmetic brass pool; authoritative hits never query these objects.
export class Casings {
  constructor(scene, renderer, world) {
    this.world = world; this.time = 0; this.next = 0; this.pending = []; this.items = [];
    const geometry = new THREE.CylinderGeometry(.0055, .0055, .035, 8);
    const material = renderer.registerMaterial(new THREE.MeshStandardMaterial({ color: 0xba9a58, roughness: .38, metalness: .78 }));
    this.mesh = new THREE.InstancedMesh(geometry, material, 48);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.mesh.frustumCulled = false; this.mesh.count = 0;
    this.matrix = new THREE.Matrix4(); scene.add(this.mesh);
  }

  eject(model, delay = 0) {
    if (!model?.eject || this.pending.length > 16) return;
    this.pending.push({ model, at: this.time + delay });
  }

  update(dt) {
    this.time += dt;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const pending = this.pending[i];
      if (pending.at > this.time) continue;
      this.pending.splice(i, 1);
      if (!pending.model.root.parent?.visible || !pending.model.root.visible) continue;
      const anchor = pending.model.eject;
      const rotation = anchor.getWorldQuaternion(new THREE.Quaternion());
      this.items[this.next] = { position: anchor.getWorldPosition(new THREE.Vector3()),
        velocity: new THREE.Vector3(1.5 + Math.random(), 1.2, .2).applyQuaternion(rotation),
        rotation, age: 0, landed: false };
      this.next = (this.next + 1) % 48;
      this.mesh.count = Math.max(this.mesh.count, this.items.length);
    }
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (!item || (item.age += dt) > 3) { this.items[i] = null; this.mesh.setMatrixAt(i, this.matrix.makeScale(0, 0, 0)); continue; }
      if (!item.landed) {
        item.velocity.y -= 9.81 * dt; item.position.addScaledVector(item.velocity, dt);
        item.rotation.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(dt * 13, dt * 6, dt * 9)));
        const ground = this.world.terrainHeight(item.position.x, item.position.z) + .008;
        if (item.position.y < ground) {
          item.position.y = ground;
          if (Math.abs(item.velocity.y) < .5) item.landed = true;
          item.velocity.y = Math.abs(item.velocity.y) * .3; item.velocity.x *= .45; item.velocity.z *= .45;
        }
      }
      this.matrix.compose(item.position, item.rotation, new THREE.Vector3(1, 1, 1));
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
