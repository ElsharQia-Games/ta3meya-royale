// Keyboard / mouse input. Produces the shared simulation input shape plus the
// edge-triggered action flags consumed by the wire protocol.
import { STANCE } from '../shared/config.js';

const MOVE = {
  KeyW: 'f', ArrowUp: 'f',
  KeyS: 'b', ArrowDown: 'b',
  KeyA: 'l', ArrowLeft: 'l',
  KeyD: 'r', ArrowRight: 'r',
};

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouse = { dx: 0, dy: 0, left: false, right: false };
    this.pointerLocked = false;
    this.sensitivity = 1;
    this.invertY = false;
    this.stance = STANCE.STAND;
    this.pendingSlot = -1;
    this.pendingEnter = undefined;
    this.actions = {
      reload: false, grenade: false, smoke: false, heal: false,
      interact: false, cycle: false,
    };
    this.enabled = false;
    this._lockFresh = false;
    this.onKey = null;
    this._bind();
  }

  _bind() {
    addEventListener('keydown', (e) => {
      if (e.code === 'Tab') e.preventDefault();
      if (this.keys.has(e.code)) return;
      this.keys.add(e.code);
      if (!this.enabled) return;
      if (MOVE[e.code]) return;
      switch (e.code) {
        case 'KeyR': this.actions.reload = true; break;
        case 'KeyG': this.actions.grenade = true; break;
        case 'KeyT': this.actions.smoke = true; break;
        case 'KeyF': this.actions.heal = true; break;
        case 'KeyE': this.actions.interact = true; this.pendingEnter = 'toggle'; break;
        case 'KeyQ': this.actions.cycle = true; break;
        case 'Digit1': this.pendingSlot = 0; break;
        case 'Digit2': this.pendingSlot = 1; break;
        case 'KeyC':
          this.stance = this.stance === STANCE.CROUCH ? STANCE.STAND : STANCE.CROUCH;
          break;
        case 'KeyX': this.stance = STANCE.PRONE; break;
        case 'KeyV': this.stance = STANCE.STAND; break;
        default: break;
      }
      if (this.onKey) this.onKey(e.code);
    });
    addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    addEventListener('blur', () => { this.keys.clear(); this.mouse.left = false; this.mouse.right = false; });
    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.pointerLocked) { this.requestLock(); return; }
      if (e.button === 0) this.mouse.left = true;
      if (e.button === 2) this.mouse.right = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      // Browsers can report a huge synthetic delta on the first event after
      // the pointer is locked. Discarding it prevents the camera snapping.
      if (this._lockFresh) { this._lockFresh = false; return; }
      this.mouse.dx += e.movementX;
      this.mouse.dy += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (this.pointerLocked) this._lockFresh = true;
      if (!this.pointerLocked) { this.mouse.left = false; this.mouse.right = false; }
    });
  }

  requestLock() {
    try {
      const p = this.canvas.requestPointerLock?.({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => this.canvas.requestPointerLock());
    } catch { try { this.canvas.requestPointerLock(); } catch {} }
  }

  releaseLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  // Consume accumulated mouse movement, scaled to radians.
  look(yaw, pitch) {
    const s = 0.0021 * this.sensitivity;
    yaw -= this.mouse.dx * s;
    pitch -= this.mouse.dy * s * (this.invertY ? -1 : 1);
    this.mouse.dx = 0; this.mouse.dy = 0;
    const max = 1.5;
    if (pitch > max) pitch = max;
    if (pitch < -max) pitch = -max;
    return [yaw, pitch];
  }

  // Build one simulation input frame. Clears edge actions afterwards.
  frame(yaw, pitch, seq, viewTime = 0) {
    const f = this.keys.has('KeyW') || this.keys.has('ArrowUp');
    const b = this.keys.has('KeyS') || this.keys.has('ArrowDown');
    const l = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const r = this.keys.has('KeyD') || this.keys.has('ArrowRight');
    const jump = this.keys.has('Space');
    const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const input = {
      f, b, l, r, jump, sprint,
      ads: this.mouse.right,
      shoot: this.mouse.left,
      reload: this.actions.reload,
      grenade: this.actions.grenade,
      smoke: this.actions.smoke,
      heal: this.actions.heal,
      interact: this.actions.interact,
      cycle: this.actions.cycle,
      slot: this.pendingSlot,
      stance: this.stance,
      enterVehicle: this.pendingEnter === 'toggle' ? 'toggle' : this.pendingEnter,
      yaw, pitch, seq, viewTime,
    };
    this.actions.reload = false; this.actions.grenade = false;
    this.actions.smoke = false; this.actions.heal = false;
    this.actions.interact = false; this.actions.cycle = false;
    this.pendingSlot = -1;
    this.pendingEnter = undefined;
    return input;
  }

  // Convert to the wire button/action masks.
  static toWire(input) {
    let buttons = 0;
    if (input.f) buttons |= 1;
    if (input.b) buttons |= 2;
    if (input.l) buttons |= 4;
    if (input.r) buttons |= 8;
    if (input.jump) buttons |= 16;
    if (input.sprint) buttons |= 32;
    if (input.ads) buttons |= 64;
    if (input.shoot) buttons |= 128;
    let actions = 0;
    if (input.reload) actions |= 1;
    if (input.grenade) actions |= 2;
    if (input.smoke) actions |= 4;
    if (input.heal) actions |= 8;
    if (input.interact) actions |= 16;
    if (input.cycle) actions |= 32;
    return { buttons, actions };
  }
}
