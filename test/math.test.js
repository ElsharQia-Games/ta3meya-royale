import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp, lerp, smoothstep, wrapAngle, angleDelta, lerpAngle, TAU,
  RNG, valueNoise2, fbm2, spreadDirection, dirFromAngles, yawTo, qPos,
} from '../shared/math.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('scalar helpers clamp and interpolate', () => {
  assert.equal(clamp(-1, 0, 1), 0);
  assert.equal(clamp(2, 0, 1), 1);
  assert.equal(clamp(0.5, 0, 1), 0.5);
  near(lerp(10, 20, 0.25), 12.5);
  assert.equal(smoothstep(-3), 0);
  assert.equal(smoothstep(3), 1);
  near(smoothstep(0.5), 0.5);
});

test('wrapAngle keeps angles in (-pi, pi]', () => {
  for (const a of [-10, -TAU, -Math.PI, 0, Math.PI, TAU, 10]) {
    const w = wrapAngle(a);
    assert.ok(w > -Math.PI - 1e-9 && w <= Math.PI + 1e-9, `${a} -> ${w}`);
  }
  near(Math.abs(wrapAngle(3 * Math.PI)), Math.PI);
  near(Math.abs(wrapAngle(-3 * Math.PI)), Math.PI);
});

test('angleDelta takes the short way around', () => {
  near(angleDelta(0.1, 0.2), 0.1);
  near(angleDelta(0.1, -0.1), -0.2);
  const a = 3.0, b = -3.0;
  const d = angleDelta(a, b);
  assert.ok(Math.abs(d) < 0.3, `short arc expected, got ${d}`);
  near(lerpAngle(0, Math.PI / 2, 0.5), Math.PI / 4);
});

test('RNG is deterministic and stays in range', () => {
  const a = new RNG(12345), b = new RNG(12345);
  for (let i = 0; i < 1000; i++) {
    const x = a.next();
    assert.equal(x, b.next());
    assert.ok(x >= 0 && x < 1);
  }
  const c = new RNG(1), d = new RNG(2);
  assert.notEqual(c.next(), d.next());
  const r = new RNG(7);
  for (let i = 0; i < 200; i++) {
    const v = r.range(5, 9);
    assert.ok(v >= 5 && v <= 9);
    const n = r.int(1, 3);
    assert.ok(n >= 1 && n <= 3 && Number.isInteger(n));
  }
});

test('noise is deterministic, bounded and varies', () => {
  near(valueNoise2(1.25, 2.75, 3), valueNoise2(1.25, 2.75, 3));
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const v = fbm2(i * 0.37, i * 0.71, 4, 9);
    assert.ok(v >= 0 && v <= 1);
    seen.add(v.toFixed(4));
  }
  assert.ok(seen.size > 10);
});

test('spreadDirection stays inside the cone and is deterministic', () => {
  const dir = [0, 0, -1];
  const cone = 0.05;
  const r1 = new RNG(99), r2 = new RNG(99);
  let maxAngle = 0;
  for (let i = 0; i < 500; i++) {
    const d = spreadDirection(dir, cone, r1);
    const d2 = spreadDirection(dir, cone, r2);
    for (let k = 0; k < 3; k++) near(d[k], d2[k], 1e-12);
    near(Math.hypot(d[0], d[1], d[2]), 1, 1e-9);
    const ang = Math.acos(clamp(d[2] * -1, -1, 1));
    maxAngle = Math.max(maxAngle, ang);
  }
  assert.ok(maxAngle <= cone + 1e-9, `max angle ${maxAngle} exceeded cone ${cone}`);
  assert.ok(maxAngle > cone * 0.5, 'spread should fill the cone');
});

test('dirFromAngles and yawTo agree', () => {
  const yaw = yawTo(0, 0, -5, -5);
  near(yaw, Math.PI / 4);
  const d = dirFromAngles(yaw, 0);
  near(d[0], -5 / Math.hypot(5, 5));
  near(d[2], -5 / Math.hypot(5, 5));
  near(d[1], 0);
  const up = dirFromAngles(0, Math.PI / 2);
  near(up[1], 1, 1e-9);
});

test('qPos quantises to centimetres', () => {
  assert.equal(qPos(1.2345), 1.23);
  assert.equal(qPos(-1.235), -1.24);
});
