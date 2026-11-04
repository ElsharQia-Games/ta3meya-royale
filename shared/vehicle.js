// Shared vehicle dimensions/contact math. Yaw uses the same -Z-forward
// convention as players. Vehicle.pos is the suspension/chassis anchor, not
// the tyre contact plane; renderers use rideHeight to place the body.
import { CFG } from './config.js';
import { clamp } from './math.js';

export function vehicleShape(type) {
  return CFG.VEHICLE.bodies[type] || CFG.VEHICLE.bodies.car;
}

export function vehicleRideHeight() {
  const v = CFG.VEHICLE;
  const staticCompression = v.mass * 9.81 / (4 * v.suspensionK);
  return v.suspensionRest + v.wheelRadius - v.wheelMountHeight - staticCompression;
}

export function vehicleAxes(yaw) {
  return { right: [Math.cos(yaw), -Math.sin(yaw)], forward: [-Math.sin(yaw), -Math.cos(yaw)] };
}

export function vehicleInReach(world, feet, eyeHeight, vehicle) {
  if (vehicle.health <= 0 || vehicle.submerged || !vehicle.occupants.includes(null)) return false;
  const pos = vehicle.pos || [vehicle.x, vehicle.y, vehicle.z];
  if (Math.hypot(pos[0] - feet[0], pos[2] - feet[2]) > CFG.VEHICLE.enterRange || Math.abs(pos[1] - feet[1]) > 2) return false;
  const from = [feet[0], feet[1] + eyeHeight, feet[2]], to = [pos[0], pos[1] + .4, pos[2]];
  const delta = to.map((n, i) => n - from[i]), distance = Math.hypot(...delta);
  return distance <= .1 || !world.raycast(from, delta.map(n => n / distance), distance - .1, { ignoreVehicle: vehicle.id });
}

export function vehicleFootprint(v) {
  const s = vehicleShape(v.type), c = Math.abs(Math.cos(v.yaw)), n = Math.abs(Math.sin(v.yaw));
  return { x: c * s.width / 2 + n * s.length / 2, z: n * s.width / 2 + c * s.length / 2 };
}

export function packVehicle(v) {
  const round = (n, places = 2) => +n.toFixed(places);
  const forwardSpeed = -Math.sin(v.yaw) * v.vel[0] - Math.cos(v.yaw) * v.vel[2];
  return {
    id: v.id, type: v.type, x: round(v.pos[0]), y: round(v.pos[1]), z: round(v.pos[2]),
    yaw: round(v.yaw, 3), pitch: round(v.pitch, 3), roll: round(v.roll, 3),
    vx: round(v.vel[0]), vy: round(v.vel[1]), vz: round(v.vel[2]),
    speed: round(Math.hypot(v.vel[0], v.vel[2])), forwardSpeed: round(forwardSpeed),
    steer: round(v.steer, 3), wheelComp: v.wheelComp.map(n => round(n, 3)),
    occupants: v.occupants.slice(), health: Math.round(v.health),
    braking: !!v.braking, submerged: !!v.submerged, grounded: !!v.grounded,
  };
}

// OBB vs static AABB via the four separating axes. The returned normal pushes
// the vehicle away from the box, including the centre-inside-box case.
export function vehicleBoxContact(v, b) {
  const shape = vehicleShape(v.type), bottom = v.pos[1] - vehicleRideHeight();
  if (bottom + shape.height <= b.min[1] || bottom + .24 >= b.max[1]) return null;
  const { right, forward } = vehicleAxes(v.yaw);
  const dx = v.pos[0] - (b.min[0] + b.max[0]) / 2;
  const dz = v.pos[2] - (b.min[2] + b.max[2]) / 2;
  const bx = (b.max[0] - b.min[0]) / 2, bz = (b.max[2] - b.min[2]) / 2;
  let depth = Infinity, normal = null;
  for (const axis of [[1, 0], [0, 1], right, forward]) {
    const [nx, nz] = axis;
    const vr = Math.abs(nx * right[0] + nz * right[1]) * shape.width / 2 +
      Math.abs(nx * forward[0] + nz * forward[1]) * shape.length / 2;
    const separation = dx * nx + dz * nz;
    const overlap = vr + Math.abs(nx) * bx + Math.abs(nz) * bz - Math.abs(separation);
    if (overlap <= 0) return null;
    if (overlap < depth) {
      depth = overlap;
      const direction = separation ? Math.sign(separation) : Math.sign(-(v.vel[0] * nx + v.vel[2] * nz)) || 1;
      normal = [nx * direction, nz * direction];
    }
  }
  return { depth, normal };
}

export function vehiclePairContact(a, b) {
  const sa = vehicleShape(a.type), sb = vehicleShape(b.type);
  if (a.pos[1] + sa.height < b.pos[1] || b.pos[1] + sb.height < a.pos[1]) return null;
  const dx = a.pos[0] - b.pos[0], dz = a.pos[2] - b.pos[2];
  if (Math.hypot(dx, dz) > (Math.hypot(sa.width, sa.length) + Math.hypot(sb.width, sb.length)) / 2) return null;
  const aa = vehicleAxes(a.yaw), ab = vehicleAxes(b.yaw);
  let depth = Infinity, normal;
  for (const [nx, nz] of [aa.right, aa.forward, ab.right, ab.forward]) {
    const projectedRadius = (axes, shape) => Math.abs(nx * axes.right[0] + nz * axes.right[1]) * shape.width / 2 +
      Math.abs(nx * axes.forward[0] + nz * axes.forward[1]) * shape.length / 2;
    const separation = dx * nx + dz * nz;
    const overlap = projectedRadius(aa, sa) + projectedRadius(ab, sb) - Math.abs(separation);
    if (overlap <= 0) return null;
    if (overlap < depth) { depth = overlap; const sign = Math.sign(separation) || 1; normal = [nx * sign, nz * sign]; }
  }
  return { depth, normal };
}

// Capsule footprint vs a rotated vehicle hull, used for player collision.
export function vehiclePlayerContact(v, pos, radius, height) {
  const shape = vehicleShape(v.type), bottom = v.pos[1] - vehicleRideHeight();
  if (pos[1] >= bottom + shape.height || pos[1] + height <= bottom + .24) return null;
  const dx = pos[0] - v.pos[0], dz = pos[2] - v.pos[2];
  const range = (shape.width + shape.length) / 2 + radius;
  if (Math.abs(dx) > range || Math.abs(dz) > range) return null;
  const { right, forward } = vehicleAxes(v.yaw);
  const x = dx * right[0] + dz * right[1], z = dx * forward[0] + dz * forward[1];
  const hx = shape.width / 2, hz = shape.length / 2;
  let nx = x - clamp(x, -hx, hx), nz = z - clamp(z, -hz, hz);
  const d = Math.hypot(nx, nz);
  if (d >= radius) return null;
  let depth = radius - d;
  if (d > 1e-8) { nx /= d; nz /= d; }
  else if (hx - Math.abs(x) < hz - Math.abs(z)) { nx = Math.sign(x) || 1; nz = 0; depth += hx - Math.abs(x); }
  else { nx = 0; nz = Math.sign(z) || 1; depth += hz - Math.abs(z); }
  return { depth, normal: [right[0] * nx + forward[0] * nz, right[1] * nx + forward[1] * nz] };
}

// Ray vs rotated vehicle hull. Rays originating inside it (passengers, blast
// origin) may exit; external shots hit the authoritative hull and damage it.
export function rayVehicle(v, origin, direction, maxDistance) {
  const shape = vehicleShape(v.type);
  const cx = v.pos[0] - origin[0], cy = v.pos[1] - vehicleRideHeight() + shape.height / 2 - origin[1], cz = v.pos[2] - origin[2];
  const along = clamp(cx * direction[0] + cy * direction[1] + cz * direction[2], 0, maxDistance);
  const nearX = cx - direction[0] * along, nearY = cy - direction[1] * along, nearZ = cz - direction[2] * along;
  if (nearX * nearX + nearY * nearY + nearZ * nearZ > (shape.width ** 2 + shape.length ** 2 + shape.height ** 2) / 4) return null;
  const { right, forward } = vehicleAxes(v.yaw);
  const dx = origin[0] - v.pos[0], dz = origin[2] - v.pos[2];
  const o = [dx * right[0] + dz * right[1], origin[1] - v.pos[1] + vehicleRideHeight(), dx * forward[0] + dz * forward[1]];
  const d = [direction[0] * right[0] + direction[2] * right[1], direction[1], direction[0] * forward[0] + direction[2] * forward[1]];
  const min = [-shape.width / 2, .24, -shape.length / 2], max = [shape.width / 2, shape.height, shape.length / 2];
  if (o.every((value, i) => value >= min[i] && value <= max[i])) return null;
  let near = 0, far = Infinity, axis = -1, sign = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < min[i] || o[i] > max[i]) return null; continue; }
    let a = (min[i] - o[i]) / d[i], b = (max[i] - o[i]) / d[i];
    if (a > b) [a, b] = [b, a];
    if (a > near) { near = a; axis = i; sign = d[i] > 0 ? -1 : 1; }
    far = Math.min(far, b);
    if (near > far) return null;
  }
  if (near > maxDistance || far < 0 || axis < 0) return null;
  const normal = axis === 1 ? [0, sign, 0] : axis === 0
    ? [right[0] * sign, 0, right[1] * sign] : [forward[0] * sign, 0, forward[1] * sign];
  return { t: near, tmax: far, normal, point: origin.map((n, i) => n + direction[i] * near), vehicle: v, tag: 'vehicle', mat: 'metal', box: null };
}
