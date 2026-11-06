// Authenticated host-shutdown messages.
//
// Host/session ids are published on the public presence topic, so matching them
// is only an identity hint, not proof that a message came from the host. The
// host therefore creates a session key pair, publishes the public half in its
// discovery announcements, and signs the `host_offline` message once. Guests
// pin that public key while discovering the host and verify the signature
// before treating the room as closed.
//
// This is trust-on-first-use: the first host announcement a guest accepts is
// pinned. It prevents a third party from forging a shutdown for an established
// host, but it cannot prove who owns a room before any key has been seen.

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' };

function subtle() {
  return globalThis.crypto?.subtle || null;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// Deterministic signed payload. Arrays avoid relying on object key order and
// keep the exact bytes identical on the host and guest.
export function hostOfflinePayload(fields = {}) {
  return JSON.stringify([
    1,
    'host_offline',
    String(fields.hostId || ''),
    String(fields.sessionId || ''),
    String(fields.room || ''),
    Number(fields.startedAt) || 0,
  ]);
}

export function canAuthenticateHost() {
  return !!subtle() && typeof btoa === 'function' && typeof atob === 'function';
}

export async function createHostIdentity() {
  const api = subtle();
  if (!api) return null;
  try {
    const pair = await api.generateKey(ALGORITHM, true, ['sign', 'verify']);
    const publicKey = await api.exportKey('jwk', pair.publicKey);
    return { privateKey: pair.privateKey, publicKey };
  } catch {
    return null;
  }
}

export async function signHostOffline(identity, fields) {
  const api = subtle();
  if (!api || !identity?.privateKey) return null;
  try {
    const data = new TextEncoder().encode(hostOfflinePayload(fields));
    const signature = await api.sign(SIGN_ALGORITHM, identity.privateKey, data);
    return bytesToBase64(new Uint8Array(signature));
  } catch {
    return null;
  }
}

export async function verifyHostOffline(publicKey, fields, signature) {
  const api = subtle();
  if (!api || !publicKey || typeof signature !== 'string' || !signature) return false;
  try {
    const key = await api.importKey('jwk', publicKey, ALGORITHM, false, ['verify']);
    const data = new TextEncoder().encode(hostOfflinePayload(fields));
    return await api.verify(SIGN_ALGORITHM, key, base64ToBytes(signature), data);
  } catch {
    return false;
  }
}
