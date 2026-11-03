// Binary wire protocol (little-endian, versioned).
// Design mirrors Valve Source / Gambetta: client sends inputs + acks,
// server sends delta snapshots. We use compact JSON for events (small) and
// a packed binary for snapshots at 30 Hz (bandwidth matters).
const enc = new TextEncoder(), dec = new TextDecoder();
export const PROTO = 3;

// client -> server: INPUT (0x01) {playerId, seq, yaw, pitch, buttons, atTime}
// server -> client: SNAP (0x02) {tick, gameTime, packed players, events json}
// server -> client: EVENT (0x03) {json}
// client -> server: CLAIM (0x04) not used (server authoritative)

export function encodeInput(seq, yaw, pitch, buttons, atTime) {
  const b = new ArrayBuffer(1 + 4 + 4 + 4 + 1 + 4 + 4 + 4);
  const v = new DataView(b);
  v.setUint8(0, 0x01); v.setUint32(1, seq, true);
  v.setFloat32(5, yaw, true); v.setFloat32(9, pitch, true);
  v.setUint8(13, buttons);
  v.setFloat32(14, atTime, true);
  v.setUint32(18, 0, true); // reserved ack latest snap
  return b;
}
export function decodeInput(buf) {
  const v = new DataView(buf);
  if (v.getUint8(0) !== 0x01) return null;
  return { seq: v.getUint32(1, true), yaw: v.getFloat32(5, true), pitch: v.getFloat32(9, true), buttons: v.getUint8(13), atTime: v.getFloat32(14, true) };
}
export const BTN = { F: 1, B: 2, L: 4, R: 8, JUMP: 16, SPRINT: 32, ADS: 64, SHOOT: 128 };

export function buttonsToInput(btn, extra) {
  return {
    f: !!(btn & BTN.F), b: !!(btn & BTN.B), l: !!(btn & BTN.L), r: !!(btn & BTN.R),
    jump: !!(btn & BTN.JUMP), sprint: !!(btn & BTN.SPRINT), ads: !!(btn & BTN.ADS),
    shoot: !!(btn & BTN.SHOOT),
    reload: extra.reload, grenade: extra.grenade, heal: extra.heal,
    switch: extra.switch, stance: extra.stance || null
  };
}

export function encodeSnap(packed) {
  const body = enc.encode(JSON.stringify(packed));
  const b = new ArrayBuffer(1 + 4 + body.length);
  const v = new DataView(b);
  v.setUint8(0, 0x02); v.setUint32(1, packed.tick, true);
  new Uint8Array(b, 5).set(body);
  return b;
}
export function decodeSnap(buf) {
  const v = new DataView(buf);
  if (v.getUint8(0) !== 0x02) return null;
  return JSON.parse(dec.decode(new Uint8Array(buf, 5)));
}
export function encodeEvents(events) {
  const body = enc.encode(JSON.stringify(events));
  const b = new ArrayBuffer(1 + 4 + body.length);
  new DataView(b).setUint8(0, 0x03);
  new DataView(b).setUint32(1, events.length, true);
  new Uint8Array(b, 5).set(body);
  return b;
}
export function decodeEvents(buf) {
  if (new DataView(buf).getUint8(0) !== 0x03) return null;
  return JSON.parse(dec.decode(new Uint8Array(buf, 5)));
}
