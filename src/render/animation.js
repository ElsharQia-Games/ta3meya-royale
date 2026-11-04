// Two-bone IK used by first-person arms. Pure vector math makes the length and
// reach constraints independently testable. Pole determines the elbow's side.
import { clamp } from '../../shared/math.js';

const smooth = value => { const x = clamp(value, 0, 1); return x * x * (3 - 2 * x); };

export function reloadMotion(remaining, duration) {
  const active = remaining > 0;
  const progress = active ? 1 - clamp(remaining / duration, 0, 1) : 1;
  return { active, progress,
    lift: active ? Math.sin(progress * Math.PI) : 0,
    grasp: smooth(progress / .14) * (1 - smooth((progress - .82) / .18)),
    extract: smooth((progress - .15) / .22) * (1 - smooth((progress - .54) / .26)),
    feed: smooth((progress - .08) / .2) * (1 - smooth((progress - .69) / .23)),
    rack: Math.sin(Math.PI * clamp((progress - .82) / .16, 0, 1)),
    stage: !active ? 'ready' : progress < .15 ? 'grasp' : progress < .42 ? 'remove' : progress < .58 ? 'exchange' : progress < .82 ? 'insert' : 'settle',
  };
}

export function boltMotion(age) {
  if (!Number.isFinite(age)) return { hand: 0, lift: 0, travel: 0 };
  return {
    hand: smooth((age - .12) / .14) * (1 - smooth((age - .94) / .2)),
    lift: smooth((age - .2) / .1) * (1 - smooth((age - .86) / .13)),
    travel: smooth((age - .32) / .17) * (1 - smooth((age - .64) / .2)),
  };
}

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
