// Live rocket integration, shared by server authority and cosmetic prediction.
// The authoritative caller supplies CURRENT player hitboxes for each swept step;
// rockets never use the hitscan rewind or a precomputed damage schedule.
import { CFG } from './config.js';

export function advanceRocket(world, projectile, dt, castPlayers = null) {
  const weapon = CFG.WEAPONS[projectile.weapon || 'rpg'];
  const rocket = weapon.rocket;
  const speed = Math.hypot(...projectile.vel);
  const thrust = Math.min(rocket.maxSpeed, speed + rocket.acceleration * dt) / Math.max(speed, .001);
  for (let i = 0; i < 3; i++) projectile.vel[i] *= thrust * Math.max(0, 1 - weapon.drag * speed * dt);
  projectile.vel[1] -= 9.81 * weapon.grav * dt;
  const displacement = projectile.vel.map(value => value * dt);
  const distance = Math.hypot(...displacement);
  if (distance <= 1e-7) return null;
  const direction = displacement.map(value => value / distance);
  let hit = world.raycast(projectile.pos, direction, distance);
  const playerHit = castPlayers?.(projectile.pos, direction, hit ? hit.t : distance);
  if (playerHit && (!hit || playerHit.t < hit.t)) {
    hit = { ...playerHit, point: projectile.pos.map((value, i) => value + direction[i] * playerHit.t),
      normal: direction.map(value => -value), tag: 'player' };
  }
  const travel = hit ? hit.t : distance;
  projectile.distance = (projectile.distance || 0) + travel;
  if (hit) projectile.pos = hit.point.map((value, i) => value + (hit.normal?.[i] || 0) * .035);
  else for (let i = 0; i < 3; i++) projectile.pos[i] += displacement[i];
  return hit;
}

export function packProjectile(projectile) {
  return { id: projectile.id, type: projectile.type, weapon: projectile.weapon,
    owner: projectile.owner, team: projectile.team, pos: projectile.pos.map(n => +n.toFixed(3)),
    vel: projectile.vel.map(n => +n.toFixed(3)), fuse: +projectile.fuse.toFixed(3),
    distance: +(projectile.distance || 0).toFixed(2), bounces: projectile.bounces || 0 };
}
