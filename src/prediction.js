// Client-side movement prediction, reconciliation and remote interpolation.
// The authoritative simulation lives on the server; this file only predicts the
// local player and smooths the error when a snapshot arrives.
import { CFG, STANCE } from '../shared/config.js';
import { clamp, lerpAngle, wrapAngle } from '../shared/math.js';
import { movePlayer, stanceHeight, stanceEye } from '../shared/physics.js';

export function makePredictedPlayer() {
  return {
    pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0,
    stance: STANCE.STAND, stanceT: 1, grounded: false, coyote: 0,
    jumpBuffer: 0, sprinting: false, adsing: false, inWater: false,
    swimming: false, fallImpact: 0, pendingFallDamage: 0,
    reloadT: 0, healT: 0, inVehicle: 0,
    height() { return stanceHeight(this.stance); },
    eyeHeight() { return stanceEye(this.stance); },
  };
}

export class Prediction {
  constructor(world) {
    this.world = world;
    this.player = makePredictedPlayer();
    this.history = [];
    this.acked = 0;
    this.correction = [0, 0, 0];
    this.lastServerPos = null;
    this.snapped = false;
    this.maxHistory = 240;
  }

  reset(snapshot) {
    const p = this.player;
    this.acked = 0;
    p.pos = [snapshot.x, snapshot.y, snapshot.z];
    p.vel = [snapshot.vx || 0, 0, snapshot.vz || 0];
    if (snapshot.stance !== undefined) p.stance = snapshot.stance;
    p.grounded = !!snapshot.grounded;
    p.inWater = !!snapshot.inWater;
    p.inVehicle = snapshot.vehicle || 0;
    p.reloadT = snapshot.reload || 0;
    p.healT = snapshot.heal || 0;
    p.yaw = snapshot.yaw ?? p.yaw;
    p.pitch = snapshot.pitch ?? p.pitch;
    this.history.length = 0;
    this.correction = [0, 0, 0];
    this.lastServerPos = p.pos.slice();
  }

  // Record and immediately apply an input frame.
  push(input, dt = CFG.SIM_DT) {
    if (!this.player.inVehicle) this._apply(input, dt);
    else {
      this.player.yaw = input.yaw;
      this.player.pitch = input.pitch;
    }
    this.history.push({ seq: input.seq, input: { ...input }, dt });
    if (this.history.length > this.maxHistory) this.history.shift();
  }

  _apply(input, dt) {
    const p = this.player;
    p.yaw = input.yaw;
    p.pitch = clamp(input.pitch, -CFG.PLAYER.MAX_PITCH, CFG.PLAYER.MAX_PITCH);
    movePlayer(this.world, p, input, dt);
  }

  // Reconcile with the authoritative local player state from a snapshot.
  // ackSeq === null means the ack frame for this snapshot was lost; do not
  // guess which inputs the server had applied. The next snapshot with a known
  // ack corrects the prediction instead.
  reconcile(snapshot, ackSeq) {
    if (!snapshot) return;
    if (ackSeq === null || ackSeq === undefined) return;
    const p = this.player;
    const old = p.pos.slice();
    const inVehicle = snapshot.vehicle || 0;
    p.inVehicle = inVehicle;
    p.reloadT = snapshot.reload || 0;
    p.healT = snapshot.heal || 0;
    if (inVehicle) {
      // Vehicle motion is server-driven; interpolate rather than predict.
      p.pos = [snapshot.x, snapshot.y, snapshot.z];
      p.vel = [snapshot.vx || 0, 0, snapshot.vz || 0];
      this.history.length = 0;
      this.correction = [0, 0, 0];
      return;
    }

    this.acked = Math.max(this.acked, ackSeq || 0);
    this.history = this.history.filter(h => h.seq > this.acked);

    p.pos = [snapshot.x, snapshot.y, snapshot.z];
    p.vel = [snapshot.vx || 0, 0, snapshot.vz || 0];
    p.stance = snapshot.stance ?? p.stance;
    p.grounded = !!snapshot.grounded;
    p.inWater = !!snapshot.inWater;
    p.fallImpact = 0;
    p.pendingFallDamage = 0;

    for (const h of this.history) this._apply(h.input, h.dt);

    const err = [old[0] - p.pos[0], old[1] - p.pos[1], old[2] - p.pos[2]];
    const dist = Math.hypot(err[0], err[1], err[2]);
    if (dist > 3) {
      this.correction = [0, 0, 0];
      this.snapped = true;
    } else {
      // Blend the correction out over the next few frames instead of popping.
      this.correction[0] += err[0];
      this.correction[1] += err[1];
      this.correction[2] += err[2];
      this.snapped = false;
    }
    this.lastServerPos = [snapshot.x, snapshot.y, snapshot.z];
  }

  // Smoothing offset applied to the camera only.
  stepCorrection(dt) {
    const k = Math.exp(-12 * dt);
    this.correction[0] *= k;
    this.correction[1] *= k;
    this.correction[2] *= k;
    if (Math.hypot(...this.correction) < 0.002) this.correction = [0, 0, 0];
  }

  renderPos() {
    return [
      this.player.pos[0] + this.correction[0],
      this.player.pos[1] + this.correction[1],
      this.player.pos[2] + this.correction[2],
    ];
  }

  get unacked() { return this.history.length; }
}

// Buffered snapshots, sampled at a fixed delay for smooth remote motion.
export class SnapshotBuffer {
  constructor(maxFrames = 90) {
    this.frames = [];
    this.maxFrames = maxFrames;
  }

  clear() { this.frames.length = 0; }

  push(snap, cache) {
    const players = new Map();
    for (const [id, p] of cache) players.set(id, { ...p });
    const t = snap.serverTime;
    // Ignore duplicate/older frames (keyframe retransmits).
    const last = this.frames[this.frames.length - 1];
    if (last && t < last.t - 1e-6) {
      this.frames.length = 0;
    }
    this.frames.push({ t, players, seq: snap.seq });
    while (this.frames.length > this.maxFrames) this.frames.shift();
    while (this.frames.length > 2 && this.frames[0].t < t - 1.4) this.frames.shift();
  }

  get newestTime() { return this.frames.length ? this.frames[this.frames.length - 1].t : 0; }
  get oldestTime() { return this.frames.length ? this.frames[0].t : 0; }

  sample(renderTime) {
    const n = this.frames.length;
    if (!n) return new Map();
    if (n === 1 || renderTime <= this.frames[0].t) return this.frames[0].players;
    if (renderTime >= this.frames[n - 1].t) return this.frames[n - 1].players;

    let lo = 0, hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (this.frames[mid].t <= renderTime) lo = mid; else hi = mid;
    }
    const a = this.frames[lo], b = this.frames[hi];
    const span = b.t - a.t;
    const f = span > 1e-6 ? clamp((renderTime - a.t) / span, 0, 1) : 0;
    const out = new Map();
    for (const [id, pb] of b.players) {
      const pa = a.players.get(id);
      if (!pa) { out.set(id, pb); continue; }
      out.set(id, {
        ...pb,
        x: pa.x + (pb.x - pa.x) * f,
        y: pa.y + (pb.y - pa.y) * f,
        z: pa.z + (pb.z - pa.z) * f,
        vx: pa.vx + ((pb.vx ?? 0) - (pa.vx ?? 0)) * f,
        vz: pa.vz + ((pb.vz ?? 0) - (pa.vz ?? 0)) * f,
        yaw: lerpAngle(pa.yaw ?? 0, pb.yaw ?? 0, f),
        pitch: (pa.pitch ?? 0) + ((pb.pitch ?? 0) - (pa.pitch ?? 0)) * f,
      });
    }
    return out;
  }
}

export function remoteRenderTime(buffer, rttMs, jitterMs) {
  const extra = clamp((rttMs * 0.5 + jitterMs * 2) / 1000, 0, 0.18);
  const delay = CFG.INTERP_DELAY + extra;
  return buffer.newestTime - delay;
}
