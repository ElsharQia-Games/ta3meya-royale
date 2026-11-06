// ============================================================================
// Frontline wire protocol.
//
// Control/roster/chat use small JSON text frames (human readable, rare).
// Input, snapshots, events and loot use compact little-endian binary frames.
//
// Snapshot strategy (Gambetta / Source style):
//   - 30 Hz snapshots, 60 Hz simulation.
//   - Per-player field mask, delta against the previous room snapshot.
//   - A full keyframe every CFG.NET.snapshotKeyframeEvery snapshots, on join,
//     and on demand. WebSocket is ordered/reliable so no per-client baseline
//     divergence is expected; a reconnect always starts with a keyframe.
// ============================================================================
import { CFG } from './config.js';
import { WEAPON_KEYS } from './weapons.js';
import { clamp, wrapAngle, TAU } from './math.js';

export const PROTOCOL_VERSION = 9;

// A join is only accepted for the exact wire format this server speaks. The
// snapshot/input layouts are not forward/backward compatible, so silently
// accepting an older client would corrupt its cache instead of failing loudly.
export function isProtocolCompatible(version) {
  return version === PROTOCOL_VERSION;
}

export const MSG = {
  INPUT: 0x10,
  PING: 0x11,
  PONG: 0x12,
  ACK: 0x13,
  SNAPSHOT: 0x14,
  EVENTS: 0x15,
  LOOT: 0x16,
};

export const BTN = {
  F: 1 << 0, B: 1 << 1, L: 1 << 2, R: 1 << 3,
  JUMP: 1 << 4, SPRINT: 1 << 5, ADS: 1 << 6, SHOOT: 1 << 7,
};

export const ACT = {
  RELOAD: 1 << 0, GRENADE: 1 << 1, SMOKE: 1 << 2,
  HEAL: 1 << 3, INTERACT: 1 << 4, CYCLE: 1 << 5,
};

// Player field mask.
export const F = {
  POS: 1 << 0,
  ANG: 1 << 1,
  VEL: 1 << 2,
  VIT: 1 << 3,
  FLAGS: 1 << 4,
  WEAPON: 1 << 5,
  AMMO: 1 << 6,
  SCORE: 1 << 7,
  VEH: 1 << 8,
  TIMERS: 1 << 9,
  META: 1 << 10,
  PING: 1 << 11,
  MOVE: 1 << 12,
};
export const F_ALL = (1 << 13) - 1;

const POS_SCALE = 50;      // 2 cm
const VEL_SCALE = 100;     // 1 cm/s
const PITCH_SCALE = 10000;
// 16-bit code space: 65536 codes spanning one full turn. Using 65535 here
// biases every negative angle by one step when the unsigned code is decoded.
const YAW_SCALE = 65536 / TAU;
const PAD = 256;

const textEnc = new TextEncoder();
const textDec = new TextDecoder();

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
export function encodeInput(inp) {
  const buf = new ArrayBuffer(32);
  const v = new DataView(buf);
  v.setUint8(0, MSG.INPUT);
  v.setUint32(1, inp.seq >>> 0, true);
  v.setFloat64(5, inp.clientTime || 0, true);
  v.setFloat32(13, inp.yaw || 0, true);
  v.setFloat32(17, inp.pitch || 0, true);
  v.setUint16(21, inp.buttons || 0, true);
  v.setUint8(23, inp.actions || 0);
  v.setInt8(24, inp.slot === undefined ? -1 : inp.slot);
  v.setInt8(25, inp.stance === undefined || inp.stance === null ? -1 : inp.stance);
  v.setInt16(26, inp.enterVehicle === undefined || inp.enterVehicle === null ? 0 : inp.enterVehicle, true);
  v.setFloat32(28, inp.viewTime || 0, true);
  return buf;
}

export function decodeInput(buf) {
  if (buf.byteLength < 32) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG.INPUT) return null;
  return {
    seq: v.getUint32(1, true),
    clientTime: v.getFloat64(5, true),
    yaw: v.getFloat32(13, true),
    pitch: v.getFloat32(17, true),
    buttons: v.getUint16(21, true),
    actions: v.getUint8(23),
    slot: v.getInt8(24),
    stance: v.getInt8(25),
    enterVehicle: v.getInt16(26, true),
    viewTime: v.getFloat32(28, true),
  };
}

// Server-side input gate. Rejects replays/out-of-order frames and normalises
// every client-controlled field before it reaches the simulation. The server
// never trusts a client position; only buttons, view angles and item/vehicle
// requests cross this boundary.
const BUTTON_MASK = BTN.F | BTN.B | BTN.L | BTN.R | BTN.JUMP | BTN.SPRINT | BTN.ADS | BTN.SHOOT;
const ACTION_MASK = ACT.RELOAD | ACT.GRENADE | ACT.SMOKE | ACT.HEAL | ACT.INTERACT | ACT.CYCLE;

export function sanitizeWireInput(w, lastSeq = 0) {
  if (!w || !Number.isFinite(w.seq)) return null;
  const seq = w.seq >>> 0;
  // Input sequences start at 1 and must strictly increase. This drops
  // duplicates, replays and reordered frames at the door instead of letting
  // them occupy queue space.
  if (seq === 0 || seq <= (lastSeq >>> 0)) return null;
  if (!Number.isFinite(w.yaw) || !Number.isFinite(w.pitch)) return null;
  let enterVehicle = Number.isInteger(w.enterVehicle) ? w.enterVehicle : 0;
  if (enterVehicle < -1 || enterVehicle > 65535) enterVehicle = 0;
  // Rebuild from known wire fields only: never forward an unknown property to
  // the simulation, even if a future decoder accidentally exposes one.
  return {
    seq,
    clientTime: Number.isFinite(w.clientTime) && w.clientTime >= 0 ? w.clientTime : 0,
    viewTime: Number.isFinite(w.viewTime) && w.viewTime >= 0 ? w.viewTime : 0,
    yaw: wrapAngle(w.yaw),
    pitch: clamp(w.pitch, -CFG.PLAYER.MAX_PITCH, CFG.PLAYER.MAX_PITCH),
    buttons: (w.buttons | 0) & BUTTON_MASK,
    actions: (w.actions | 0) & ACTION_MASK,
    slot: w.slot >= 0 && w.slot <= 1 ? w.slot : -1,
    stance: w.stance >= 0 && w.stance <= 2 ? w.stance : -1,
    enterVehicle,
  };
}

// Convert a decoded wire input into the simulation input shape.
export function wireToSimInput(w, previous = null) {
  const b = w.buttons, a = w.actions;
  return {
    f: !!(b & BTN.F), b: !!(b & BTN.B), l: !!(b & BTN.L), r: !!(b & BTN.R),
    jump: !!(b & BTN.JUMP), sprint: !!(b & BTN.SPRINT), ads: !!(b & BTN.ADS),
    shoot: !!(b & BTN.SHOOT),
    reload: !!(a & ACT.RELOAD), grenade: !!(a & ACT.GRENADE), smoke: !!(a & ACT.SMOKE),
    heal: !!(a & ACT.HEAL), interact: !!(a & ACT.INTERACT), cycle: !!(a & ACT.CYCLE),
    slot: w.slot >= 0 && w.slot <= 1 ? w.slot : -1,
    stance: w.stance >= 0 && w.stance <= 2 ? w.stance : null,
    enterVehicle: w.enterVehicle === 0 ? undefined : w.enterVehicle,
    yaw: w.yaw, pitch: w.pitch, seq: w.seq, viewTime: w.viewTime,
    clientTime: w.clientTime,
    // Retained for reconnect / debug; never trusted for authority.
    prev: previous,
  };
}

// ---------------------------------------------------------------------------
// Server input scheduling
//
// These helpers are pure so the queue bound and the stale-input policy can be
// tested with explicit timestamps instead of wall-clock sleeps.
// ---------------------------------------------------------------------------

// 16 inputs at 60 Hz is ~267 ms of buffered latency: below a 300 ms one-way
// path, but small enough that a flooding client cannot add a full second.
export const MAX_INPUT_BACKLOG = 16;
// Stop repeating held movement/shoot after this long without a fresh frame.
export const INPUT_STALE_MS = 250;
// Admission rate for binary input frames. Shared by the dedicated server and
// the in-browser host so a client cannot buy extra queue service by flooding.
export const INPUT_RATE_PER_SECOND = 150;
// Control frames are rare; this only exists to stop a malformed peer spinning
// on chat/resync/spectate messages.
export const CONTROL_RATE_PER_SECOND = 20;

export function backlogLimit(configMax) {
  const n = Number(configMax);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(Math.floor(n), MAX_INPUT_BACKLOG)) : MAX_INPUT_BACKLOG;
}

// Append one input, dropping the oldest while the queue is at the bound.
// Returns how many inputs were dropped so the caller can expose it in /stats.
//
// Policy shared by both authoritative hosts:
//   - the newest frame always wins, so a burst cannot add unbounded latency;
//   - the oldest queued frame is discarded first, which may drop a one-shot
//     action but can never replay one (one-shots are edge-triggered and are
//     explicitly cleared by heldSimInput, so they cannot execute twice);
//   - sequence acknowledgement is based on the last consumed frame, not the
//     last admitted one (see lastConsumedSeq in the host/server loops).
export function pushBoundedInput(queue, input, limit = MAX_INPUT_BACKLOG) {
  limit = backlogLimit(limit);
  let dropped = 0;
  while (queue.length >= limit) { queue.shift(); dropped++; }
  queue.push(input);
  return dropped;
}

// True once a client has been silent longer than the grace window. Latency
// shifts arrival times but does not widen the gap between 60 Hz frames; only a
// real stall (pause, tab hidden, loss burst) reaches this threshold.
export function isStaleInput(lastInputAt, now, staleMs = INPUT_STALE_MS) {
  return lastInputAt > 0 && now - lastInputAt > staleMs;
}

// Build the simulation input used when no fresh frame is available. A held
// frame keeps movement/shoot for the grace window but never repeats one-shot
// actions; a stale frame is fully neutralised except for view angles.
export function heldSimInput(last, stale) {
  if (stale) {
    return {
      f: false, b: false, l: false, r: false, jump: false, sprint: false,
      ads: false, shoot: false, reload: false, grenade: false, smoke: false,
      heal: false, interact: false, slot: -1, cycle: false, stance: null,
      enterVehicle: undefined, yaw: last.yaw, pitch: last.pitch,
      seq: 0, viewTime: 0,
    };
  }
  return {
    ...last, reload: false, grenade: false, smoke: false, heal: false,
    interact: false, cycle: false, slot: -1, stance: null, enterVehicle: undefined,
  };
}

// ---------------------------------------------------------------------------
// Ping / pong
// ---------------------------------------------------------------------------
export function encodePing(clientTime) {
  const b = new ArrayBuffer(9); const v = new DataView(b);
  v.setUint8(0, MSG.PING); v.setFloat64(1, clientTime, true); return b;
}
export function decodePing(buf) {
  if (buf.byteLength < 9) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG.PING) return null;
  return { clientTime: v.getFloat64(1, true) };
}
export function encodePong(clientTime, serverTime) {
  const b = new ArrayBuffer(17); const v = new DataView(b);
  v.setUint8(0, MSG.PONG); v.setFloat64(1, clientTime, true); v.setFloat64(9, serverTime, true); return b;
}
export function decodePong(buf) {
  if (buf.byteLength < 17) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG.PONG) return null;
  return { clientTime: v.getFloat64(1, true), serverTime: v.getFloat64(9, true) };
}

// ---------------------------------------------------------------------------
// Input acknowledgement
//
// Acks are decoupled from snapshots so one snapshot buffer can be broadcast to
// every client. Each ack names the snapshot sequence it belongs to; the client
// only applies it to that exact snapshot. This keeps acks correct when a frame
// is lost: an ack from a different tick is never used for reconciliation.
// ---------------------------------------------------------------------------
export function encodeAck(seq, ackInput) {
  const b = new ArrayBuffer(9); const v = new DataView(b);
  v.setUint8(0, MSG.ACK);
  v.setUint32(1, seq >>> 0, true);
  v.setUint32(5, ackInput >>> 0, true);
  return b;
}
export function decodeAck(buf) {
  if (buf.byteLength < 9) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG.ACK) return null;
  return { seq: v.getUint32(1, true), ackInput: v.getUint32(5, true) };
}

// ---------------------------------------------------------------------------
// Snapshot state
// ---------------------------------------------------------------------------
export function weaponIndex(key) {
  if (!key) return 0;
  const i = WEAPON_KEYS.indexOf(key);
  return i < 0 ? 0 : i + 1;
}
export function weaponKey(index) {
  if (!index) return null;
  return WEAPON_KEYS[index - 1] || null;
}

export function snapshotState(game) {
  const out = new Map();
  for (const p of game.players.values()) {
    const w = p.curWeapon();
    const inv = w ? p.inv[w] : null;
    out.set(p.id, {
      id: p.id,
      x: p.pos[0], y: p.pos[1], z: p.pos[2],
      yaw: p.yaw, pitch: p.pitch,
      vx: p.vel[0], vy: p.vel[1], vz: p.vel[2],
      // Movement timers that affect the next movePlayer() integration. Stored
      // in seconds; encoded as centiseconds by the wire format.
      coyote: p.coyote || 0,
      jumpBuffer: p.jumpBuffer || 0,
      hp: Math.max(0, Math.min(255, Math.round(p.health))),
      armor: Math.max(0, Math.min(255, Math.round(p.armor))),
      alive: p.alive ? 1 : 0,
      grounded: p.grounded ? 1 : 0,
      inWater: p.inWater ? 1 : 0,
      connected: p.connected ? 1 : 0,
      stance: p.stance,
      sprinting: p.sprinting ? 1 : 0,
      adsing: p.adsing ? 1 : 0,
      w: weaponIndex(w), slot: p.curSlot,
      mag: inv ? inv.mag : 0, res: inv ? inv.reserve : 0,
      k: Math.min(65535, p.kills), d: Math.min(65535, p.deaths),
      dmg: Math.min(65535, Math.round(p.damageDealt)),
      vehicle: p.inVehicle || 0, seat: p.seat,
      reload: Math.min(65535, Math.round(p.reloadT * 100)),
      heal: Math.min(65535, Math.round(p.healT * 100)),
      switchT: Math.min(255, Math.round(p.switchT * 100)),
      team: p.team,
      gren: Math.min(255, p.grenades), smoke: Math.min(255, p.smokes),
      band: Math.min(255, p.bandages), med: Math.min(255, p.medkits),
      ping: Math.min(65535, Math.round(p.ping || 0)),
    });
  }
  return out;
}

function sameField(a, b, key) {
  if (a === undefined || b === undefined) return false;
  const va = a[key], vb = b[key];
  if (typeof va === 'number') return Math.abs(va - vb) < 1e-9;
  return va === vb;
}

// Project a raw simulation state onto the exact values the wire format can
// represent. The delta baseline must be built from these values, not from the
// raw simulation state: otherwise fields that were never transmitted are
// treated as received, and slow movement drifts until the next keyframe (F3).
const finite = value => (Number.isFinite(value) ? value : 0);
function qInt(value, scale, min = -32768, max = 32767) {
  return clamp(Math.round(finite(value) * scale), min, max) / scale;
}
function qByte(value, min = 0, max = 255) {
  return clamp(Math.round(finite(value)), min, max);
}
// Quantize yaw to the exact double represented by its uint16 wire code. The
// code is unsigned (0..TAU), so qYaw(-1) returns ~5.283 rather than -1.
function yawCode(value) {
  return Math.round(wrapAngle(finite(value)) * YAW_SCALE) & 0xffff;
}
function qYaw(value) {
  return yawCode(value) / YAW_SCALE;
}
function qMove(value) {
  return clamp(Math.round(finite(value) * 100), 0, 255);
}

function wireState(cur) {
  return {
    id: cur.id,
    x: qInt(cur.x, POS_SCALE), y: qInt(cur.y, POS_SCALE), z: qInt(cur.z, POS_SCALE),
    yaw: qYaw(cur.yaw),
    pitch: qInt(clamp(finite(cur.pitch), -1.5, 1.5), PITCH_SCALE),
    vx: qInt(cur.vx, VEL_SCALE), vy: qInt(cur.vy, VEL_SCALE), vz: qInt(cur.vz, VEL_SCALE),
    hp: qByte(cur.hp), armor: qByte(cur.armor),
    alive: cur.alive ? 1 : 0, grounded: cur.grounded ? 1 : 0, inWater: cur.inWater ? 1 : 0,
    connected: cur.connected ? 1 : 0, stance: qByte(cur.stance) & 3,
    sprinting: cur.sprinting ? 1 : 0, adsing: cur.adsing ? 1 : 0,
    w: qByte(cur.w), slot: qByte(cur.slot),
    mag: qByte(cur.mag, 0, 65535), res: qByte(cur.res, 0, 65535),
    k: qByte(cur.k, 0, 65535), d: qByte(cur.d, 0, 65535), dmg: qByte(cur.dmg, 0, 65535),
    vehicle: qByte(cur.vehicle, 0, 65535), seat: qByte(cur.seat, -128, 127),
    reload: qByte(cur.reload, 0, 65535), heal: qByte(cur.heal, 0, 65535),
    switchT: qByte(cur.switchT),
    team: qByte(cur.team), gren: qByte(cur.gren), smoke: qByte(cur.smoke),
    band: qByte(cur.band), med: qByte(cur.med),
    ping: qByte(cur.ping, 0, 65535),
    coyote: qMove(cur.coyote) / 100, jumpBuffer: qMove(cur.jumpBuffer) / 100,
  };
}

const WIRE_FIELDS = [
  [F.POS, ['x', 'y', 'z']],
  [F.ANG, ['yaw', 'pitch']],
  [F.VEL, ['vx', 'vy', 'vz']],
  [F.VIT, ['hp', 'armor']],
  [F.FLAGS, ['alive', 'grounded', 'inWater', 'connected', 'stance', 'sprinting', 'adsing']],
  [F.WEAPON, ['w', 'slot']],
  [F.AMMO, ['mag', 'res']],
  [F.SCORE, ['k', 'd', 'dmg']],
  [F.VEH, ['vehicle', 'seat']],
  [F.TIMERS, ['reload', 'heal', 'switchT']],
  [F.META, ['team', 'gren', 'smoke', 'band', 'med']],
  [F.PING, ['ping']],
  [F.MOVE, ['coyote', 'jumpBuffer']],
];

function mergeWireState(prev, cur, mask) {
  const base = { ...prev, id: cur.id };
  for (const [bit, keys] of WIRE_FIELDS) {
    if (!(mask & bit)) continue;
    for (const key of keys) base[key] = cur[key];
  }
  return base;
}

function diffMask(cur, prev) {
  if (!prev) return F_ALL;
  let mask = 0;
  if (Math.abs(cur.x - prev.x) > 0.009 || Math.abs(cur.y - prev.y) > 0.009 || Math.abs(cur.z - prev.z) > 0.009) mask |= F.POS;
  if (Math.abs(wrapAngle(cur.yaw - prev.yaw)) > 0.002 || Math.abs(cur.pitch - prev.pitch) > 0.002) mask |= F.ANG;
  if (Math.abs(cur.vx - prev.vx) >= 0.02 || Math.abs(cur.vy - prev.vy) >= 0.02 || Math.abs(cur.vz - prev.vz) >= 0.02) mask |= F.VEL;
  if (cur.hp !== prev.hp || cur.armor !== prev.armor) mask |= F.VIT;
  if (cur.alive !== prev.alive || cur.grounded !== prev.grounded || cur.inWater !== prev.inWater ||
    cur.connected !== prev.connected || cur.stance !== prev.stance ||
    cur.sprinting !== prev.sprinting || cur.adsing !== prev.adsing) mask |= F.FLAGS;
  if (cur.w !== prev.w || cur.slot !== prev.slot) mask |= F.WEAPON;
  if (cur.mag !== prev.mag || cur.res !== prev.res) mask |= F.AMMO;
  if (cur.k !== prev.k || cur.d !== prev.d || cur.dmg !== prev.dmg) mask |= F.SCORE;
  if (cur.vehicle !== prev.vehicle || cur.seat !== prev.seat) mask |= F.VEH;
  if (cur.reload !== prev.reload || cur.heal !== prev.heal || cur.switchT !== prev.switchT) mask |= F.TIMERS;
  if (cur.team !== prev.team || cur.gren !== prev.gren || cur.smoke !== prev.smoke ||
    cur.band !== prev.band || cur.med !== prev.med) mask |= F.META;
  if (cur.ping !== prev.ping) mask |= F.PING;
  if (cur.coyote !== prev.coyote || cur.jumpBuffer !== prev.jumpBuffer) mask |= F.MOVE;
  return mask;
}

function playerBlockSize(mask) {
  let n = 4; // id + mask
  if (mask & F.POS) n += 6;
  if (mask & F.ANG) n += 4;
  if (mask & F.VEL) n += 6;
  if (mask & F.VIT) n += 2;
  if (mask & F.FLAGS) n += 1;
  if (mask & F.WEAPON) n += 2;
  if (mask & F.AMMO) n += 4;
  if (mask & F.SCORE) n += 6;
  if (mask & F.VEH) n += 3;
  if (mask & F.TIMERS) n += 5;
  if (mask & F.META) n += 5;
  if (mask & F.PING) n += 2;
  if (mask & F.MOVE) n += 2;
  return n;
}

function writePlayer(v, off, cur, mask) {
  v.setUint16(off, cur.id, true); off += 2;
  v.setUint16(off, mask, true); off += 2;
  if (mask & F.POS) {
    v.setInt16(off, clamp(Math.round(cur.x * POS_SCALE), -32768, 32767), true); off += 2;
    v.setInt16(off, clamp(Math.round(cur.y * POS_SCALE), -32768, 32767), true); off += 2;
    v.setInt16(off, clamp(Math.round(cur.z * POS_SCALE), -32768, 32767), true); off += 2;
  }
  if (mask & F.ANG) {
    // cur.yaw is already a qYaw() baseline value. Re-wrapping it here would
    // move negative angles across a rounding boundary and encode the adjacent
    // code, making the transmitted yaw differ from the baseline by one LSB.
    v.setUint16(off, Math.round(finite(cur.yaw) * YAW_SCALE) & 0xffff, true); off += 2;
    v.setInt16(off, clamp(Math.round(clamp(cur.pitch, -1.5, 1.5) * PITCH_SCALE), -32768, 32767), true); off += 2;
  }
  if (mask & F.VEL) {
    v.setInt16(off, clamp(Math.round(cur.vx * VEL_SCALE), -32768, 32767), true); off += 2;
    v.setInt16(off, clamp(Math.round(cur.vy * VEL_SCALE), -32768, 32767), true); off += 2;
    v.setInt16(off, clamp(Math.round(cur.vz * VEL_SCALE), -32768, 32767), true); off += 2;
  }
  if (mask & F.VIT) { v.setUint8(off++, cur.hp); v.setUint8(off++, cur.armor); }
  if (mask & F.FLAGS) {
    v.setUint8(off++, (cur.alive ? 1 : 0) | (cur.grounded ? 2 : 0) | (cur.inWater ? 4 : 0) |
      (cur.connected ? 8 : 0) | ((cur.stance & 3) << 4) | (cur.sprinting ? 64 : 0) | (cur.adsing ? 128 : 0));
  }
  if (mask & F.WEAPON) { v.setUint8(off++, cur.w); v.setUint8(off++, cur.slot); }
  if (mask & F.AMMO) { v.setUint16(off, cur.mag, true); off += 2; v.setUint16(off, cur.res, true); off += 2; }
  if (mask & F.SCORE) {
    v.setUint16(off, cur.k, true); off += 2;
    v.setUint16(off, cur.d, true); off += 2;
    v.setUint16(off, cur.dmg, true); off += 2;
  }
  if (mask & F.VEH) { v.setUint16(off, cur.vehicle, true); off += 2; v.setInt8(off++, cur.seat); }
  if (mask & F.TIMERS) {
    v.setUint16(off, cur.reload, true); off += 2;
    v.setUint16(off, cur.heal, true); off += 2;
    v.setUint8(off++, cur.switchT);
  }
  if (mask & F.META) {
    v.setUint8(off++, cur.team); v.setUint8(off++, cur.gren);
    v.setUint8(off++, cur.smoke); v.setUint8(off++, cur.band); v.setUint8(off++, cur.med);
  }
  if (mask & F.PING) { v.setUint16(off, cur.ping, true); off += 2; }
  if (mask & F.MOVE) {
    v.setUint8(off++, clamp(Math.round((cur.coyote || 0) * 100), 0, 255));
    v.setUint8(off++, clamp(Math.round((cur.jumpBuffer || 0) * 100), 0, 255));
  }
  return off;
}

// Encode a snapshot. `prev` is the previous state map (null => keyframe).
// Returns { buffer, states }. Acks are a separate MSG.ACK frame so this buffer
// is identical for every client in the room.
export function encodeSnapshot(states, prev, seq, serverTime, forceKeyframe = false) {
  const keyframe = forceKeyframe || !prev;
  const ids = [...states.keys()].sort((a, b) => a - b);
  const removed = [];
  if (!keyframe && prev) {
    for (const id of prev.keys()) if (!states.has(id)) removed.push(id);
  }
  let size = 16 + removed.length * 2 + 64;
  const blocks = [];
  const wire = new Map();
  const baseline = new Map();
  for (const id of ids) wire.set(id, wireState(states.get(id)));
  for (const id of ids) {
    const cur = wire.get(id);
    const prevState = keyframe ? null : (prev ? prev.get(id) : null);
    const m = keyframe || !prevState ? F_ALL : diffMask(cur, prevState);
    baseline.set(id, m === F_ALL ? { ...cur } : mergeWireState(prevState, cur, m));
    if (!m) continue;
    blocks.push({ id, mask: m });
    size += playerBlockSize(m);
  }
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  let off = 0;
  v.setUint8(off++, MSG.SNAPSHOT);
  v.setUint8(off++, keyframe ? 1 : 0);
  v.setUint16(off, seq & 0xffff, true); off += 2;
  v.setFloat64(off, serverTime, true); off += 8;
  v.setUint16(off, keyframe ? 0 : (seq - 1) & 0xffff, true); off += 2;
  v.setUint8(off++, blocks.length);
  v.setUint8(off++, removed.length);
  for (const id of removed) { v.setUint16(off, id, true); off += 2; }
  for (const b of blocks) off = writePlayer(v, off, wire.get(b.id), b.mask);
  return { buffer: buf.slice(0, off), states: baseline };
}

function readPlayer(v, off) {
  const id = v.getUint16(off, true); off += 2;
  const mask = v.getUint16(off, true); off += 2;
  const p = { id, mask };
  if (mask & F.POS) {
    p.x = v.getInt16(off, true) / POS_SCALE; off += 2;
    p.y = v.getInt16(off, true) / POS_SCALE; off += 2;
    p.z = v.getInt16(off, true) / POS_SCALE; off += 2;
  }
  if (mask & F.ANG) {
    p.yaw = v.getUint16(off, true) / YAW_SCALE; off += 2;
    p.pitch = v.getInt16(off, true) / PITCH_SCALE; off += 2;
  }
  if (mask & F.VEL) {
    p.vx = v.getInt16(off, true) / VEL_SCALE; off += 2;
    p.vy = v.getInt16(off, true) / VEL_SCALE; off += 2;
    p.vz = v.getInt16(off, true) / VEL_SCALE; off += 2;
  }
  if (mask & F.VIT) { p.hp = v.getUint8(off++); p.armor = v.getUint8(off++); }
  if (mask & F.FLAGS) {
    const f = v.getUint8(off++);
    p.alive = !!(f & 1); p.grounded = !!(f & 2); p.inWater = !!(f & 4);
    p.connected = !!(f & 8); p.stance = (f >> 4) & 3;
    p.sprinting = !!(f & 64); p.adsing = !!(f & 128);
  }
  if (mask & F.WEAPON) { p.w = v.getUint8(off++); p.slot = v.getUint8(off++); }
  if (mask & F.AMMO) { p.mag = v.getUint16(off, true); off += 2; p.res = v.getUint16(off, true); off += 2; }
  if (mask & F.SCORE) {
    p.k = v.getUint16(off, true); off += 2;
    p.d = v.getUint16(off, true); off += 2;
    p.dmg = v.getUint16(off, true); off += 2;
  }
  if (mask & F.VEH) { p.vehicle = v.getUint16(off, true); off += 2; p.seat = v.getInt8(off++); }
  if (mask & F.TIMERS) {
    p.reload = v.getUint16(off, true) / 100; off += 2;
    p.heal = v.getUint16(off, true) / 100; off += 2;
    p.switchT = v.getUint8(off++) / 100;
  }
  if (mask & F.META) {
    p.team = v.getUint8(off++); p.gren = v.getUint8(off++);
    p.smoke = v.getUint8(off++); p.band = v.getUint8(off++); p.med = v.getUint8(off++);
  }
  if (mask & F.PING) { p.ping = v.getUint16(off, true); off += 2; }
  if (mask & F.MOVE) {
    p.coyote = v.getUint8(off++) / 100;
    p.jumpBuffer = v.getUint8(off++) / 100;
  }
  return { player: p, off };
}

export function decodeSnapshot(buf) {
  if (buf.byteLength < 16) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG.SNAPSHOT) return null;
  const keyframe = !!(v.getUint8(1) & 1);
  const seq = v.getUint16(2, true);
  const serverTime = v.getFloat64(4, true);
  if (!Number.isFinite(serverTime)) return null;
  const baseSeq = v.getUint16(12, true);
  const count = v.getUint8(14);
  const removedCount = v.getUint8(15);
  let off = 16;
  const removed = [];
  if (off + removedCount * 2 > buf.byteLength) return null;
  for (let i = 0; i < removedCount; i++) { removed.push(v.getUint16(off, true)); off += 2; }
  const players = [];
  for (let i = 0; i < count; i++) {
    if (off + 4 > buf.byteLength) return null;
    const mask = v.getUint16(off + 2, true);
    if (mask & ~F_ALL || off + playerBlockSize(mask) > buf.byteLength) return null;
    const r = readPlayer(v, off); off = r.off;
    players.push(r.player);
  }
  if (off !== buf.byteLength) return null;
  return { keyframe, seq, serverTime, baseSeq, players, removed, bytes: buf.byteLength };
}

// 16-bit modular sequence comparison. Snapshot sequence wraps at 65535 -> 0,
// so plain `<` would reject the first snapshot after the wrap.
export function seqNewer(a, b) {
  return a !== b && (((a - b) & 0xffff) < 0x8000);
}

// Decide whether a snapshot can be applied to the current cache.
//
// A delta is only valid when its baseSeq equals the last applied snapshot. If
// the baseline is missing (a frame was dropped, or a reconnect reset the
// cache), applying the delta would publish a partial/wrong cache. Return
// 'missing-base' so the caller can drop it and ask for a keyframe instead.
export function snapshotAcceptance(snap, lastAppliedSeq) {
  if (!snap) return 'invalid';
  const hasBaseline = Number.isInteger(lastAppliedSeq) && lastAppliedSeq >= 0;
  if (!hasBaseline) return snap.keyframe ? 'keyframe' : 'missing-base';
  if (snap.seq === lastAppliedSeq) return 'duplicate';
  if (!seqNewer(snap.seq, lastAppliedSeq)) return 'stale';
  if (snap.keyframe) return 'keyframe';
  if (snap.baseSeq !== lastAppliedSeq) return 'missing-base';
  return 'ok';
}

// Apply a decoded snapshot to a client-side cache Map.
export function applySnapshot(cache, snap) {
  if (snap.keyframe) cache.clear();
  for (const id of snap.removed) cache.delete(id);
  for (const p of snap.players) {
    const prev = cache.get(p.id) || { id: p.id };
    cache.set(p.id, { ...prev, ...p });
  }
  return cache;
}

// ---------------------------------------------------------------------------
// Events / loot (binary header + JSON body; small and rare)
// ---------------------------------------------------------------------------
function jsonFrame(type, value) {
  const body = textEnc.encode(JSON.stringify(value));
  const buf = new ArrayBuffer(5 + body.length);
  const v = new DataView(buf);
  v.setUint8(0, type);
  v.setUint32(1, body.length, true);
  new Uint8Array(buf, 5).set(body);
  return buf;
}
function readJsonFrame(buf, type) {
  if (buf.byteLength < 5) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== type) return null;
  const len = v.getUint32(1, true);
  if (buf.byteLength < 5 + len) return null;
  try { return JSON.parse(textDec.decode(new Uint8Array(buf, 5, len))); } catch { return null; }
}

export const encodeEvents = (events) => jsonFrame(MSG.EVENTS, events);
export const decodeEvents = (buf) => readJsonFrame(buf, MSG.EVENTS);
export const encodeLoot = (loot) => jsonFrame(MSG.LOOT, loot);
export const decodeLoot = (buf) => readJsonFrame(buf, MSG.LOOT);

// ---------------------------------------------------------------------------
// Text control frames
// ---------------------------------------------------------------------------
export function encodeControl(obj) { return JSON.stringify(obj); }
export function decodeControl(str) {
  try { const o = JSON.parse(str); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

export function sanitizeName(name) {
  const s = String(name || 'Soldier').replace(/[^\w \-.]/g, '').trim().slice(0, 16);
  return s || 'Soldier';
}
export function sanitizeRoom(code) {
  const s = String(code || 'ALPHA01').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return s || 'ALPHA01';
}

export function randomRoom() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 5; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// Interest filter for events: keep events near the viewer or involving them.
export function filterEvents(events, viewer, radius = CFG.NET.eventRadius) {
  if (!events.length) return events;
  const out = [];
  const vx = viewer.pos[0], vz = viewer.pos[2];
  for (const e of events) {
    if (e.k === 'hit' || e.k === 'kill') {
      if (e.from === viewer.id || e.to === viewer.id || e.victim === viewer.id || e.killer === viewer.id) { out.push(e); continue; }
    }
    if (e.k === 'shot' || e.k === 'launch') {
      if (e.id === viewer.id) { out.push(e); continue; }
      const dx = e.o[0] - vx, dz = e.o[2] - vz;
      if (dx * dx + dz * dz <= radius * radius) out.push(e);
      continue;
    }
    if (e.x !== undefined && e.z !== undefined) {
      const dx = e.x - vx, dz = e.z - vz;
      if (dx * dx + dz * dz <= radius * radius) out.push(e);
      continue;
    }
    out.push(e);
  }
  return out;
}

export { PAD };
