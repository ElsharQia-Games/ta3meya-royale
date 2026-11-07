// Two-bone IK used by first-person arms. Pure vector math makes the length and
// reach constraints independently testable. Pole determines the elbow's side.
import { clamp } from '../../shared/math.js';

const smooth = value => { const x = clamp(value, 0, 1); return x * x * (3 - 2 * x); };

// These run for every animated character and the first-person view model each
// frame. Callers that own a long-lived record pass `out` so the hot path does
// not allocate a fresh object; omitting it preserves the historical pure API.
export function reloadMotion(remaining, duration, out = null) {
  const active = remaining > 0;
  const progress = active ? 1 - clamp(remaining / duration, 0, 1) : 1;
  const motion = out || {};
  motion.active = active;
  motion.progress = progress;
  motion.lift = active ? Math.sin(progress * Math.PI) : 0;
  motion.grasp = smooth(progress / .14) * (1 - smooth((progress - .82) / .18));
  motion.extract = smooth((progress - .15) / .22) * (1 - smooth((progress - .54) / .26));
  motion.feed = smooth((progress - .08) / .2) * (1 - smooth((progress - .69) / .23));
  motion.rack = Math.sin(Math.PI * clamp((progress - .82) / .16, 0, 1));
  motion.stage = !active ? 'ready' : progress < .15 ? 'grasp' : progress < .42 ? 'remove' : progress < .58 ? 'exchange' : progress < .82 ? 'insert' : 'settle';
  return motion;
}

export function boltMotion(age, out = null) {
  const motion = out || {};
  if (!Number.isFinite(age)) {
    motion.hand = motion.lift = motion.travel = 0;
    return motion;
  }
  motion.hand = smooth((age - .12) / .14) * (1 - smooth((age - .94) / .2));
  motion.lift = smooth((age - .2) / .1) * (1 - smooth((age - .86) / .13));
  motion.travel = smooth((age - .32) / .17) * (1 - smooth((age - .64) / .2));
  return motion;
}

export function solveTwoBone(shoulder, target, pole, upper, lower, out = null) {
  const sx = shoulder[0], sy = shoulder[1], sz = shoulder[2];
  const tx = target[0], ty = target[1], tz = target[2];
  const dx = tx - sx, dy = ty - sy, dz = tz - sz;
  const raw = Math.hypot(dx, dy, dz);

  let ax = 0, ay = -1, az = 0;
  if (raw > 1e-8) {
    const invRaw = 1 / raw;
    ax = dx * invRaw;
    ay = dy * invRaw;
    az = dz * invRaw;
  }

  const distance = clamp(raw, Math.abs(upper - lower) + 1e-6, upper + lower - 1e-6);

  let bx = pole[0] - sx, by = pole[1] - sy, bz = pole[2] - sz;
  const projected = bx * ax + by * ay + bz * az;
  bx -= ax * projected;
  by -= ay * projected;
  bz -= az * projected;

  let bendLen = Math.hypot(bx, by, bz);
  if (bendLen < 1e-8) {
    let fx = 0, fy = 0, fz = 0;
    if (Math.abs(ax) < 0.8) fx = 1; else fz = 1;
    const dot = fx * ax + fy * ay + fz * az;
    bx = fx - ax * dot;
    by = fy - ay * dot;
    bz = fz - az * dot;
    bendLen = Math.hypot(bx, by, bz);
  }

  const invBend = 1 / bendLen;
  bx *= invBend;
  by *= invBend;
  bz *= invBend;

  const along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
  const height = Math.sqrt(Math.max(0, upper * upper - along * along));

  const ex = sx + ax * along + bx * height;
  const ey = sy + ay * along + by * height;
  const ez = sz + az * along + bz * height;

  const hx = sx + ax * distance;
  const hy = sy + ay * distance;
  const hz = sz + az * distance;

  const reachable = raw <= upper + lower && raw >= Math.abs(upper - lower);

  if (out) {
    out.elbow[0] = ex; out.elbow[1] = ey; out.elbow[2] = ez;
    out.hand[0] = hx; out.hand[1] = hy; out.hand[2] = hz;
    out.reachable = reachable;
    return out;
  }
  return {
    elbow: [ex, ey, ez],
    hand: [hx, hy, hz],
    reachable,
  };
}
