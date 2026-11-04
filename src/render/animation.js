// Two-bone IK used by first-person arms. Pure vector math makes the length and
// reach constraints independently testable. Pole determines the elbow's side.
import { clamp } from '../../shared/math.js';

export function solveTwoBone(shoulder, target, pole, upper, lower) {
  const delta = target.map((v, i) => v - shoulder[i]);
  const raw = Math.hypot(...delta);
  const axis = raw > 1e-8 ? delta.map(v => v / raw) : [0, -1, 0];
  const distance = clamp(raw, Math.abs(upper - lower) + 1e-6, upper + lower - 1e-6);
  let bend = pole.map((v, i) => v - shoulder[i]);
  const projected = bend.reduce((s, v, i) => s + v * axis[i], 0);
  bend = bend.map((v, i) => v - axis[i] * projected);
  if (Math.hypot(...bend) < 1e-8) {
    const fallback = Math.abs(axis[0]) < .8 ? [1, 0, 0] : [0, 0, 1];
    const dot = fallback.reduce((s, v, i) => s + v * axis[i], 0);
    bend = fallback.map((v, i) => v - axis[i] * dot);
  }
  const length = Math.hypot(...bend);
  bend = bend.map(v => v / length);
  const along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
  const height = Math.sqrt(Math.max(0, upper * upper - along * along));
  return {
    elbow: shoulder.map((v, i) => v + axis[i] * along + bend[i] * height),
    hand: shoulder.map((v, i) => v + axis[i] * distance),
    reachable: raw <= upper + lower && raw >= Math.abs(upper - lower),
  };
}
