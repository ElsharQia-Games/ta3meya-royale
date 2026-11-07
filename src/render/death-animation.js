// Stance-aware, non-physical collapse clips on the existing articulated rig.
// Three's mixer owns interpolation/blending; game authority owns alive/respawn.
import * as THREE from 'three';
import { CFG, STANCE } from '../../shared/config.js';
import { clamp } from '../../shared/math.js';
import { supportHeight } from '../../shared/physics.js';

const UP = new THREE.Vector3(0, 1, 0);
const TIMES = [0, .14, .38, .82, 1.4];
const q = (x, y = 0, z = 0) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
const _worldPos = new THREE.Vector3();
const HAND_ENDS = [new THREE.Vector3(-.32, .06, -.12), new THREE.Vector3(.29, .21, .07)];

export class DeathAnimation {
  constructor(model, world, position, death = {}, id = 0) {
    this.model = model; this.world = world; this.position = position.slice(); this.age = 0;
    this.duration = 1.4;
    this.settled = false;
    this.poseApplied = false;
    const yaw = death.yaw || 0;
    let direction = death.direction || [Math.sin(yaw), 0, Math.cos(yaw)];
    if (world) {
      const alternatives = [direction, [direction[2], 0, -direction[0]], [-direction[2], 0, direction[0]], direction.map(n => -n)];
      let clearance = -1;
      for (const option of alternatives) {
        const hit = world.raycast([position[0], position[1] + .45, position[2]], option, 1.65);
        const available = hit?.t ?? 1.65;
        if (available > clearance) { direction = option; clearance = available; }
      }
    }
    this.yaw = yaw;
    const dx = direction[0] * Math.cos(yaw) - direction[2] * Math.sin(yaw);
    const dz = direction[0] * Math.sin(yaw) + direction[2] * Math.cos(yaw);
    const side = Math.sign(dx) || (id % 2 ? 1 : -1);
    const prone = death.stance === STANCE.PRONE;
    const crouched = death.stance === STANCE.CROUCH;
    this.side = side;
    const fall = new THREE.Quaternion().setFromUnitVectors(UP,
      new THREE.Vector3(dx || side * .24, .055, dz || .7).normalize());
    const tracks = [];
    const rotations = (node, targets) => {
      tracks.push(new THREE.QuaternionKeyframeTrack(`${node.uuid}.quaternion`, TIMES,
        [node.quaternion.clone(), ...targets].flatMap(value => value.toArray())));
    };
    const positions = (node, targets) => {
      tracks.push(new THREE.VectorKeyframeTrack(`${node.uuid}.position`, TIMES,
        [node.position.clone(), ...targets.map(value => new THREE.Vector3(...value))].flatMap(value => value.toArray())));
    };
    const m = model;
    if (prone) {
      // Preserve the existing horizontal pose; it must not stand up to die.
      positions(m.hips, [[0, .31, .66], [side * .05, .25, .67], [side * .08, .23, .68], [side * .08, .23, .68]]);
      rotations(m.hips, [q(0, 0, side * .04), q(0, 0, side * .16), q(0, 0, side * .25), q(0, 0, side * .23)]);
      rotations(m.torso, [q(-1.25), q(-1.36, .05 * side), q(-1.44, .09 * side), q(-1.42, .08 * side)]);
      rotations(m.head, [q(1.0), q(.9, side * .1), q(.75, side * .22), q(.72, side * .2)]);
    } else {
      positions(m.hips, [[0, crouched ? .49 : .89, 0], [side * .04, crouched ? .35 : .6, .02],
        [side * .10, .27, .06], [side * .1, .24, .065]]);
      rotations(m.hips, [new THREE.Quaternion().slerp(fall, .08), new THREE.Quaternion().slerp(fall, .34),
        new THREE.Quaternion().slerp(fall, .96), fall]);
      positions(m.torso, [[0, m.torso.position.y, 0], [0, -.07, 0], [0, -.1, 0], [0, -.1, 0]]);
      rotations(m.torso, [q(-.11, 0, side * .06), q(.34, 0, side * .13), q(.1, 0, side * .07), q(.08, 0, side * .055)]);
      rotations(m.head, [q(-.18, side * .08), q(.3, side * .14), q(.22, side * .23), q(.19, side * .22)]);
    }
    for (const [leg, knee, legSide] of [[m.legL, m.kneeL, -1], [m.legR, m.kneeR, 1]]) {
      const bend = prone ? -1.28 : .45 + (legSide === side ? .45 : 0);
      const restThigh = legSide === side ? .31 : .07, restKnee = legSide === side ? -.46 : -.13;
      rotations(leg, [q(prone ? -1.35 : crouched ? 1.4 : .2), q(bend + .2, 0, legSide * .09),
        q(prone ? bend : restThigh + .08, legSide * .05, legSide * .16), q(prone ? bend : restThigh, legSide * .04, legSide * .14)]);
      rotations(knee, [q(prone ? .1 : -.5), q(prone ? -.08 : -1.2), q(prone ? -.13 : restKnee - .1), q(prone ? -.11 : restKnee)]);
    }
    this.handStart = m.arms.map(arm => arm.hand.position.clone());
    this._hands = this.handStart.map(start => start.clone());
    this._liftNodes = [m.head, m.hips, m.kneeL, m.kneeR];
    this.clip = new THREE.AnimationClip(`collapse-${id}`, this.duration, tracks);
    this.mixer = new THREE.AnimationMixer(m.root);
    this.action = this.mixer.clipAction(this.clip);
    this.action.setLoop(THREE.LoopOnce, 1); this.action.clampWhenFinished = true; this.action.play();
    this.offset = new THREE.Vector3(direction[0], 0, direction[2]).multiplyScalar(death.explosive ? .55 : .2);
    if (world) {
      const from = [position[0], position[1] + .4, position[2]];
      const length = this.offset.length();
      const hit = length > 0 ? world.raycast(from, this.offset.clone().normalize().toArray(), length + .4) : null;
      if (hit) this.offset.multiplyScalar(clamp((hit.t - .4) / length, 0, 1));
    }
  }

  // Advance time without touching the rig. Culled corpses keep correct age so
  // they re-enter view at the pose the authority says they should have.
  advance(dt) {
    const before = this.age;
    this.age = Math.min(this.duration, this.age + dt);
    if (this.age !== before) this.poseApplied = false;
    return this.age;
  }

  // Sample and place the terminal pose. All scratch storage is owned by this
  // instance/module; no vectors or arrays are allocated per rendered frame.
  applyPose() {
    // setTime resets action time. LoopOnce's clamp pauses the action at its end;
    // unpause before sampling or the next frame evaluates time zero again.
    this.action.paused = false;
    this.mixer.setTime(this.age);
    const fraction = clamp(this.age / .82, 0, 1), ease = fraction * fraction * (3 - 2 * fraction);
    this.model.root.position.set(this.position[0], this.position[1], this.position[2]).addScaledVector(this.offset, ease);
    this.model.root.rotation.set(0, this.yaw, 0);
    if (this.world) {
      this.model.root.updateWorldMatrix(true, true);
      let lift = 0;
      for (const node of this._liftNodes) {
        node.getWorldPosition(_worldPos);
        const ground = supportHeight(this.world, _worldPos.x, _worldPos.z, this.position[1], .13, .25);
        lift = Math.max(lift, ground + .13 - _worldPos.y);
      }
      this.model.root.position.y += lift;
    }
    for (let i = 0; i < this._hands.length; i++) {
      this._hands[i].copy(this.handStart[i]).lerp(HAND_ENDS[i], ease);
    }
    this.poseApplied = true;
    return this._hands;
  }

  update(dt) {
    this.advance(dt);
    // Once the clamp pose is on the rig it is stable for a corpse that stays
    // in view: skip mixing, world-matrix and terrain queries entirely.
    if (this.settled && this.poseApplied) return this._hands;
    const hands = this.applyPose();
    this.settled = this.age >= this.duration;
    return hands;
  }

  dispose() {
    this.action.stop(); this.mixer.uncacheRoot(this.model.root); this.mixer.uncacheClip(this.clip);
  }
}
