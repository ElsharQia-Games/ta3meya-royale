// Smoke obscures vision, not ballistics or blast propagation. A short edge
// crossing remains translucent; a substantial path through a cloud blocks sight.
export function smokeObscures(smokes, from, to) {
  const delta = to.map((n, i) => n - from[i]), length = Math.hypot(...delta);
  if (length < 1e-6) return false;
  const direction = delta.map(n => n / length);
  for (const smoke of smokes || []) {
    const offset = [smoke.x - from[0], smoke.y + 1.1 - from[1], smoke.z - from[2]];
    const along = offset.reduce((sum, n, i) => sum + n * direction[i], 0);
    const perpendicular = offset.reduce((sum, n) => sum + n * n, 0) - along * along;
    const radius = smoke.r || 5.5;
    if (perpendicular >= radius * radius) continue;
    const half = Math.sqrt(Math.max(0, radius * radius - perpendicular));
    const inside = Math.min(length, along + half) - Math.max(0, along - half);
    if (inside > 1.4) return true;
  }
  return false;
}
