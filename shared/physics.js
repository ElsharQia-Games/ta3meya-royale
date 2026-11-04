// ============================================================================
// Kinematic capsule character controller. Deterministic, shared by client/server.
// Feet position (`pos`) + stance height. Substeps prevent tunnelling.
// ============================================================================
import { CFG } from './config.js';
import { clamp } from './math.js';
import { vehiclePlayerContact } from './vehicle.js';

const P = CFG.PLAYER;
const MAX_SUBSTEP = 0.16;

const _supportBoxes = [];
const _resHBoxes = [];
const _resVBoxes = [];
const _blockedBoxes = [];
const _contactPos = [0, 0, 0];

export function stanceHeight(stance) {
  return stance === 2 ? P.PRONE_HEIGHT : stance === 1 ? P.CROUCH_HEIGHT : P.HEIGHT;
}
export function stanceEye(stance) {
  return stance === 2 ? P.PRONE_EYE : stance === 1 ? P.CROUCH_EYE : P.EYE;
}

// Highest walkable surface under the capsule at (x,z), within [feetY-0.6, feetY+step].
export function supportHeight(world, x, z, feetY, radius, step = P.STEP_HEIGHT) {
  let support = world.terrainHeight(x, z);
  const boxes = world.queryBoxes(x - radius - 0.5, z - radius - 0.5, x + radius + 0.5, z + radius + 0.5, _supportBoxes);
  for (const b of boxes) {
    if (b.destroyed || b.tag === 'glass') continue;
    const top = b.max[1];
    if (top > feetY + step + 0.02 || top < feetY - 0.7) continue;
    // circle vs rect
    const cx = clamp(x, b.min[0], b.max[0]);
    const cz = clamp(z, b.min[2], b.max[2]);
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz <= radius * radius + 1e-4) support = Math.max(support, top);
  }
  return support;
}

// Resolve horizontal penetration against boxes. Returns true if stepped up.
function resolveHorizontal(world, p, height, grounded) {
  let stepped = false;
  const r = P.RADIUS;
  const boxes = world.queryBoxes(p.pos[0] - r - 1, p.pos[2] - r - 1, p.pos[0] + r + 1, p.pos[2] + r + 1, _resHBoxes);
  for (let iter = 0; iter < 2; iter++) {
    for (const b of boxes) {
      if (b.destroyed || b.tag === 'glass' || b.tag === 'void') continue;
      // Vertical overlap with capsule [feet, feet+height].
      if (p.pos[1] + height <= b.min[1] + 0.02 || p.pos[1] >= b.max[1] - 0.02) continue;
      const cx = clamp(p.pos[0], b.min[0], b.max[0]);
      const cz = clamp(p.pos[2], b.min[2], b.max[2]);
      let dx = p.pos[0] - cx, dz = p.pos[2] - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      // Try step-up on low ledges.
      const rise = b.max[1] - p.pos[1];
      if (grounded && rise > 0.02 && rise <= P.STEP_HEIGHT + 0.02 && p.vel[1] <= 1.0) {
        const oldY = p.pos[1];
        p.pos[1] = b.max[1] + 0.001;
        // check headroom at lifted position
        if (!capsuleBlocked(world, p.pos[0], p.pos[1], p.pos[2], height)) {
          stepped = true;
          continue;
        }
        p.pos[1] = oldY;
      }
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const push = (r - d) + 0.001;
        p.pos[0] += (dx / d) * push;
        p.pos[2] += (dz / d) * push;
        // Kill velocity into the surface.
        const nx = dx / d, nz = dz / d;
        const vn = p.vel[0] * nx + p.vel[2] * nz;
        if (vn < 0) { p.vel[0] -= nx * vn; p.vel[2] -= nz * vn; }
      } else {
        // Centre inside the rect: push along the shallowest axis.
        const pl = p.pos[0] - b.min[0], pr = b.max[0] - p.pos[0];
        const pb = p.pos[2] - b.min[2], pf = b.max[2] - p.pos[2];
        const m = Math.min(pl, pr, pb, pf);
        if (m === pl) { p.pos[0] = b.min[0] - r - 0.001; p.vel[0] = Math.min(p.vel[0], 0); }
        else if (m === pr) { p.pos[0] = b.max[0] + r + 0.001; p.vel[0] = Math.max(p.vel[0], 0); }
        else if (m === pb) { p.pos[2] = b.min[2] - r - 0.001; p.vel[2] = Math.min(p.vel[2], 0); }
        else { p.pos[2] = b.max[2] + r + 0.001; p.vel[2] = Math.max(p.vel[2], 0); }
      }
    }
  }
  return stepped;
}

export function capsuleBlocked(world, x, y, z, height) {
  const r = P.RADIUS;
  const boxes = world.queryBoxes(x - r - 0.2, z - r - 0.2, x + r + 0.2, z + r + 0.2, _blockedBoxes);
  for (const b of boxes) {
    if (b.destroyed || b.tag === 'glass') continue;
    if (y + height <= b.min[1] + 0.02 || y >= b.max[1]) continue;
    const cx = clamp(x, b.min[0], b.max[0]), cz = clamp(z, b.min[2], b.max[2]);
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz < r * r) return true;
  }
  _contactPos[0] = x; _contactPos[1] = y; _contactPos[2] = z;
  for (const v of world.vehicles || []) if (vehiclePlayerContact(v, _contactPos, r, height)) return true;
  return false;
}

// Resolve vertical motion, ceilings, and ground contact.
function resolveVertical(world, p, height, dt) {
  const r = P.RADIUS;
  const boxes = world.queryBoxes(p.pos[0] - r - 0.2, p.pos[2] - r - 0.2, p.pos[0] + r + 0.2, p.pos[2] + r + 0.2, _resVBoxes);
  // Ceiling
  for (const b of boxes) {
    if (b.destroyed || b.tag === 'glass' || b.tag === 'void') continue;
    if (p.pos[1] + height <= b.min[1] + 0.02 || p.pos[1] >= b.max[1]) continue;
    const cx = clamp(p.pos[0], b.min[0], b.max[0]), cz = clamp(p.pos[2], b.min[2], b.max[2]);
    const dx = p.pos[0] - cx, dz = p.pos[2] - cz;
    if (dx * dx + dz * dz < r * r) {
      if (p.vel[1] > 0) {
        p.pos[1] = b.min[1] - height - 0.001;
        p.vel[1] = 0;
      }
    }
  }
  // Ground
  const support = supportHeight(world, p.pos[0], p.pos[2], p.pos[1], r);
  const wasGrounded = p.grounded;
  const impact = -p.vel[1];
  if (p.pos[1] <= support + 0.06 && p.vel[1] <= 0.01) {
    p.pos[1] = support;
    if (!wasGrounded && impact > P.FALL_DAMAGE_MIN) {
      p.fallImpact = Math.max(p.fallImpact || 0, impact);
    }
    if (p.vel[1] < 0) p.vel[1] = 0;
    p.grounded = true;
    p.groundNormal = world.terrainNormal(p.pos[0], p.pos[2]);
    p.coyote = P.COYOTE;
  } else {
    p.grounded = false;
    p.coyote = Math.max(0, (p.coyote || 0) - dt);
  }
}

export function movePlayer(world, p, input, dt) {
  const radius = P.RADIUS;

  // ---- stance ----
  if (input.stance !== undefined && input.stance !== null && input.stance !== p.stance) {
    const want = input.stance;
    const valid = Number.isInteger(want) && want >= 0 && want <= 2;
    const growing = valid && stanceHeight(want) > p.height();
    if (valid && (!growing || !capsuleBlocked(world, p.pos[0], p.pos[1], p.pos[2], stanceHeight(want)))) {
      p.stance = want;
    }
  }
  p.stanceT = Math.min(1, (p.stanceT || 0) + dt / P.STANCE_TIME);

  // ---- environment ----
  const groundH = world.terrainHeight(p.pos[0], p.pos[2]);
  const waterDepth = world.waterDepth(p.pos[0], p.pos[2]);
  p.inWater = waterDepth > 0.25;
  p.swimming = waterDepth > 1.25 && p.pos[1] < world.lake.level - 0.1;
  if (p.swimming) p.stance = 0;
  const height = p.height();

  // ---- wish direction ----
  const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
  let wx = 0, wz = 0;
  if (input.f) { wx -= sy; wz -= cy; }
  if (input.b) { wx += sy; wz += cy; }
  if (input.r) { wx += cy; wz -= sy; }
  if (input.l) { wx -= cy; wz += sy; }
  const wl = Math.hypot(wx, wz);
  if (wl > 0) { wx /= wl; wz /= wl; }

  let maxSpeed = P.WALK;
  if (p.stance === 2) maxSpeed = P.PRONE;
  else if (p.stance === 1) maxSpeed = P.CROUCH;
  else if (input.sprint && !input.ads) maxSpeed = P.SPRINT;
  if (input.ads) maxSpeed = Math.min(maxSpeed, P.ADS);
  if (p.swimming) maxSpeed = P.SWIM;
  else if (p.inWater) maxSpeed *= 0.55;
  if (p.reloadT > 0 || p.healT > 0) maxSpeed *= 0.72;
  if (p.adsing && !p.grounded) maxSpeed *= 0.9;

  p.sprinting = input.sprint && p.stance === 0 && !input.ads && wl > 0 && p.grounded && !p.inWater;
  p.adsing = !!input.ads && p.reloadT <= 0;

  // ---- acceleration ----
  if (p.grounded && !p.swimming) {
    // Quake-style friction + acceleration.
    const sp = Math.hypot(p.vel[0], p.vel[2]);
    if (sp > 0.01) {
      const drop = Math.max(sp, 1.5) * P.GROUND_FRICTION * dt;
      const k = Math.max(0, sp - drop) / sp;
      p.vel[0] *= k; p.vel[2] *= k;
    }
    const tvx = wx * maxSpeed, tvz = wz * maxSpeed;
    const ax = tvx - p.vel[0], az = tvz - p.vel[2];
    const al = Math.hypot(ax, az);
    if (al > 0.001) {
      const acc = Math.min(al, P.GROUND_ACCEL * maxSpeed * dt);
      p.vel[0] += (ax / al) * acc; p.vel[2] += (az / al) * acc;
    }
  } else if (p.swimming) {
    const ax = wx * maxSpeed - p.vel[0], az = wz * maxSpeed - p.vel[2];
    p.vel[0] += ax * Math.min(1, 6 * dt);
    p.vel[2] += az * Math.min(1, 6 * dt);
    // Buoyancy toward the surface.
    // Feet are submerged; the eye, not the feet, floats near the surface.
    const surface = world.lake.level - p.eyeHeight() + .16;
    p.vel[1] += (surface - p.pos[1]) * 12 * dt;
    if (input.jump) p.vel[1] = Math.max(p.vel[1], 3.0);
    p.vel[1] *= Math.pow(0.15, dt);
    p.grounded = false;
  } else {
    const ax = wx * maxSpeed - p.vel[0], az = wz * maxSpeed - p.vel[2];
    const al = Math.hypot(ax, az);
    if (al > 0.001) {
      const acc = Math.min(al, P.AIR_ACCEL * P.AIR_CONTROL * dt * 10);
      p.vel[0] += (ax / al) * acc; p.vel[2] += (az / al) * acc;
    }
  }

  // ---- jump / gravity ----
  if (input.jump) p.jumpBuffer = P.JUMP_BUFFER;
  else p.jumpBuffer = Math.max(0, (p.jumpBuffer || 0) - dt);

  if (p.jumpBuffer > 0 && (p.grounded || (p.coyote || 0) > 0) && !p.swimming) {
    p.vel[1] = P.JUMP;
    p.grounded = false;
    p.jumpBuffer = 0;
    p.coyote = 0;
    p.jumped = true;
  }

  if (!p.swimming) {
    p.vel[1] -= P.GRAVITY * dt;
    if (p.vel[1] < -55) p.vel[1] = -55;
  }

  // ---- horizontal integration with substeps ----
  const dx = p.vel[0] * dt, dz = p.vel[2] * dt;
  const dist = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(dist / MAX_SUBSTEP));
  const sx = dx / steps, sz = dz / steps;
  const maxSlopeY = 1 / Math.sqrt(1 + P.SLOPE_MAX * P.SLOPE_MAX);
  for (let i = 0; i < steps; i++) {
    const oldX = p.pos[0], oldZ = p.pos[2];
    p.pos[0] += sx; p.pos[2] += sz;
    // Terrain wall check: a rise larger than step height blocks.
    const th = world.terrainHeight(p.pos[0], p.pos[2]);
    let blocked = p.grounded && th - p.pos[1] > P.STEP_HEIGHT + 0.06;
    // Slope limit: cannot walk up terrain steeper than SLOPE_MAX.
    if (!blocked && p.grounded) {
      const n = world.terrainNormal(p.pos[0], p.pos[2]);
      if (n[1] < maxSlopeY) {
        const uphill = (-n[0] * sx - n[2] * sz) > 0;
        if (uphill) blocked = true;
      }
    }
    if (blocked) {
      p.pos[0] = oldX; p.pos[2] = oldZ;
      p.vel[0] *= 0.2; p.vel[2] *= 0.2;
      break;
    }
    resolveHorizontal(world, p, height, p.grounded);
    for (const v of world.vehicles || []) {
      const contact = vehiclePlayerContact(v, p.pos, radius, height);
      if (!contact) continue;
      const [nx, nz] = contact.normal;
      p.pos[0] += nx * (contact.depth + .001);
      p.pos[2] += nz * (contact.depth + .001);
      const toward = p.vel[0] * nx + p.vel[2] * nz;
      if (toward < 0) { p.vel[0] -= nx * toward; p.vel[2] -= nz * toward; }
    }
  }
  // Ground snap after horizontal movement (stairs / slopes). This must also
  // snap *down* within a step: with Math.max only, walking downhill left the
  // capsule floating at its old height until it fell off the slope.
  if (p.grounded) {
    const support = supportHeight(world, p.pos[0], p.pos[2], p.pos[1] + 0.1, radius);
    if (support >= p.pos[1] - 0.55 && support <= p.pos[1] + P.STEP_HEIGHT + 0.06) {
      p.pos[1] = support;
    }
  }

  // ---- vertical integration with substeps ----
  const vy = p.vel[1];
  const vdist = Math.abs(vy * dt);
  const vsteps = Math.max(1, Math.ceil(vdist / MAX_SUBSTEP));
  for (let i = 0; i < vsteps; i++) {
    p.pos[1] += (vy * dt) / vsteps;
    resolveVertical(world, p, height, dt / vsteps);
  }

  // ---- slope sliding ----
  if (p.grounded && !p.swimming) {
    const n = p.groundNormal || [0, 1, 0];
    if (n[1] < 0.86 && (p.vel[0] || p.vel[2])) {
      // steep ground: add downhill acceleration
      const slope = Math.hypot(n[0], n[2]) || 1;
      p.vel[0] += (n[0] / slope) * 9 * dt;
      p.vel[2] += (n[2] / slope) * 9 * dt;
    }
  }

  // ---- boundary ----
  const B = CFG.MAP.BOUNDS;
  if (p.pos[0] < -B) { p.pos[0] = -B; p.vel[0] = Math.max(0, p.vel[0]); }
  if (p.pos[0] > B) { p.pos[0] = B; p.vel[0] = Math.min(0, p.vel[0]); }
  if (p.pos[2] < -B) { p.pos[2] = -B; p.vel[2] = Math.max(0, p.vel[2]); }
  if (p.pos[2] > B) { p.pos[2] = B; p.vel[2] = Math.min(0, p.vel[2]); }

  // ---- fall damage ----
  if (p.grounded && p.fallImpact > P.FALL_DAMAGE_MIN) {
    const dmg = Math.round((p.fallImpact - P.FALL_DAMAGE_MIN) * P.FALL_DAMAGE_SCALE);
    if (dmg > 0) {
      p.fallImpact = 0;
      p.pendingFallDamage = (p.pendingFallDamage || 0) + dmg;
    }
  }
  if (p.grounded) p.fallImpact = 0;
}

// Ray vs capsule (feet-based). Returns t or null.
export function rayCapsule(origin, dir, base, radius, height) {
  const a = [base[0], base[1] + radius, base[2]];
  const b = [base[0], base[1] + height - radius, base[2]];
  return rayCapsuleSegment(origin, dir, a, b, radius);
}

export function rayCapsuleSegment(o, d, a, b, radius) {
  // Closest approach between ray and segment, plus analytic cylinder caps.
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const aox = o[0] - a[0], aoy = o[1] - a[1], aoz = o[2] - a[2];
  const ab2 = abx * abx + aby * aby + abz * abz;
  const abd = abx * d[0] + aby * d[1] + abz * d[2];
  const abao = abx * aox + aby * aoy + abz * aoz;
  const closest = ab2 > 1e-10 ? clamp(abao / ab2, 0, 1) : 0;
  if ((aox - abx * closest) ** 2 + (aoy - aby * closest) ** 2 + (aoz - abz * closest) ** 2 <= radius ** 2) return 0;
  const dao = d[0] * aox + d[1] * aoy + d[2] * aoz;
  const A = ab2 - abd * abd;
  const B = ab2 * dao - abao * abd;
  const C = ab2 * (aox * aox + aoy * aoy + aoz * aoz) - abao * abao - radius * radius * ab2;
  let best = Infinity;
  if (Math.abs(A) > 1e-8) {
    const disc = B * B - A * C;
    if (disc >= 0) {
      const t = (-B - Math.sqrt(disc)) / A;
      if (t > 0) {
        const s = (abao + t * abd) / ab2;
        if (s >= 0 && s <= 1) best = t;
      }
    }
  }
  // Spheres at both ends (capsule caps).
  for (const c of [a, b]) {
    const t = raySphere(o, d, c, radius);
    if (t !== null && t < best) best = t;
  }
  return best === Infinity ? null : best;
}

export function raySphere(o, d, c, r) {
  const ox = o[0] - c[0], oy = o[1] - c[1], oz = o[2] - c[2];
  const b = ox * d[0] + oy * d[1] + oz * d[2];
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  if (cc <= 0) return 0;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : null;
}
