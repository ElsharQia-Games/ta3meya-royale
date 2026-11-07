// Pure spatial helpers shared by the audio engine and its regression tests.
// Nothing here touches WebAudio or game state: callers pass plain arrays.

export const SPEED_OF_SOUND = 343;

const _right = [0, 0, 0];
const _offset = [0, 0, 0];

// Listener basis in world space. The camera looks down -Z at yaw 0, matching
// three.js, and yaw grows clockwise when viewed from above.
export function listenerBasis(yaw) {
  return {
    forward: [-Math.sin(yaw), 0, -Math.cos(yaw)],
    right: [Math.cos(yaw), 0, -Math.sin(yaw)],
  };
}

// Predictable inverse-distance falloff with a hard audible boundary.
// ref is the distance inside which the source plays at full gain.
export function distanceGain(dist, { ref = 4, rolloff = 0.35, max = 500 } = {}) {
  if (!Number.isFinite(dist) || dist >= max) return 0;
  if (dist <= ref) return 1;
  return ref / (ref + rolloff * (dist - ref));
}

// Returns null when the source is outside its audible range so callers can
// drop the event before touching the AudioContext.
export function spatialFor(listener, yaw, position, range = {}) {
  if (!listener || !position) return null;
  const dx = position[0] - listener[0];
  const dy = position[1] - listener[1];
  const dz = position[2] - listener[2];
  const dist = Math.hypot(dx, dy, dz);
  const gain = distanceGain(dist, range);
  if (gain <= 0) return null;
  const { forward, right } = listenerBasis(yaw);
  _right[0] = right[0]; _right[2] = right[2];
  const horizontal = Math.hypot(dx, dz);
  let pan = 0;
  if (horizontal > 1e-4) {
    pan = (dx * _right[0] + dz * _right[2]) / horizontal;
    pan = pan < -1 ? -1 : pan > 1 ? 1 : pan;
    pan *= 0.85;
  }
  const front = horizontal > 1e-4 ? (dx * forward[0] + dz * forward[2]) / horizontal : 0;
  return { dist, gain, pan, front, delay: dist / SPEED_OF_SOUND };
}

// Closest approach of a straight projectile segment to the listener. The
// authoritative shot event carries an origin, predicted endpoints and flight
// times; using the path (rather than the muzzle distance) is what makes a
// whizz-by fire when the round actually passes the player.
export function pathProximity(listener, origin, end, flight) {
  if (!listener || !origin || !end) return null;
  const ax = origin[0], ay = origin[1], az = origin[2];
  const bx = end[0] - ax, by = end[1] - ay, bz = end[2] - az;
  const wx = listener[0] - ax, wy = listener[1] - ay, wz = listener[2] - az;
  const len2 = bx * bx + by * by + bz * bz;
  let t = len2 > 1e-9 ? (wx * bx + wy * by + wz * bz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + bx * t, py = ay + by * t, pz = az + bz * t;
  const dx = px - listener[0], dy = py - listener[1], dz = pz - listener[2];
  return {
    distance: Math.hypot(dx, dy, dz),
    t,
    time: Number.isFinite(flight) ? flight * t : 0,
    point: [px, py, pz],
  };
}

// Best (closest) pass across every pellet/tracer endpoint.
export function nearestPath(listener, origin, ends, flights) {
  let best = null;
  if (!Array.isArray(ends)) return best;
  for (let i = 0; i < ends.length; i++) {
    const hit = pathProximity(listener, origin, ends[i], flights?.[i]);
    if (hit && (!best || hit.distance < best.distance)) best = hit;
  }
  return best;
}

// Interior test against the generated building footprints. Used only for
// presentation (reverb/ambience mix); it never feeds simulation state.
export function indoorAt(world, position) {
  if (!world?.buildings || !position) return false;
  const [x, y, z] = position;
  for (const b of world.buildings) {
    const wall = b.wallT || 0.24;
    if (Math.abs(x - b.x) >= b.w / 2 - wall) continue;
    if (Math.abs(z - b.z) >= b.d / 2 - wall) continue;
    const top = b.y0 + b.floors * b.floorH;
    if (y > b.y0 - 0.6 && y < top) return true;
  }
  return false;
}

// Distance-appropriate low-pass cutoff. Close reports keep their crack;
// distant reports lose everything above a few kHz.
export function cutoffFor(dist, profile = {}) {
  const near = profile.near ?? 12000;
  const far = profile.far ?? 1600;
  const ref = profile.ref ?? 6;
  const span = profile.span ?? 70;
  if (dist <= ref) return near;
  const k = Math.exp(-(dist - ref) / span);
  return far + (near - far) * k;
}
