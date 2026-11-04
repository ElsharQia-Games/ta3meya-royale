import test from 'node:test';
import assert from 'node:assert/strict';
import { Input } from '../src/input.js';

test('mouse input observes pointer-lock state before its asynchronous change event', t => {
  const previousDocument = globalThis.document, previousListener = globalThis.addEventListener;
  const document = new EventTarget(), window = new EventTarget(), canvas = new EventTarget();
  document.pointerLockElement = null;
  globalThis.document = document;
  globalThis.addEventListener = window.addEventListener.bind(window);
  t.after(() => { globalThis.document = previousDocument; globalThis.addEventListener = previousListener; });
  const input = new Input(canvas); input.enabled = true;
  // Browser has granted the lock, but pointerlockchange is still queued.
  document.pointerLockElement = canvas;
  canvas.dispatchEvent(Object.assign(new Event('mousedown'), { button: 0 }));
  assert.equal(input.frame(0, 0, 1).shoot, true);
  // A delayed loss notification must not leave the trigger held either.
  document.pointerLockElement = null;
  assert.equal(input.frame(0, 0, 2).shoot, false);
});
