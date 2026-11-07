// Smoke obscures vision, not ballistics or blast propagation. A short edge
// crossing remains translucent; a substantial path through a cloud blocks sight.
// Every value is computed with scalars: this runs for each remote character and
// bot every frame, so it must not allocate temporaries.
export function smokeObscures(smokes, from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) return false;
  const ix = dx / length, iy = dy / length, iz = dz / length;
  for (let i = 0; i < (smokes?.length || 0); i++) {
    const smoke = smokes[i];
    const ox = smoke.x - from[0], oy = smoke.y + 1.1 - from[1], oz = smoke.z - from[2];
    const along = ox * ix + oy * iy + oz * iz;
    const perpendicular = ox * ox + oy * oy + oz * oz - along * along;
    const radius = smoke.r || 5.5;
    if (perpendicular >= radius * radius) continue;
    const half = Math.sqrt(Math.max(0, radius * radius - perpendicular));
    const inside = Math.min(length, along + half) - Math.max(0, along - half);
    if (inside > 1.4) return true;
  }
  return false;
}
