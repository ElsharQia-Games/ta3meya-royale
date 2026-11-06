// Pure room-election helpers.
//
// MQTT without a trusted coordinator cannot guarantee global uniqueness during
// a partition. Under a healthy broker, every candidate observes the same set
// of announcements within the discovery window, so a deterministic comparator
// converges on exactly one host. The comparator is intentionally small and
// side-effect free so it can be tested without a broker.

// Pick the winning candidate by stable node id. Lower ids win; every client
// applies the same rule to the same observed set, so there is one winner.
export function electCandidate(candidateIds, selfId) {
  const ids = new Set();
  for (const id of candidateIds || []) {
    if (typeof id === 'string' && id) ids.add(id);
  }
  if (typeof selfId === 'string' && selfId) ids.add(selfId);
  if (!ids.size) return null;
  return [...ids].sort()[0];
}

// A host announcement carries the host's local start time. A later valid
// session wins; equal timestamps fall back to the stable host id so two
// candidates that start in the same millisecond still order deterministically.
export function isHostAnnouncementNewer(next, current) {
  if (!next || typeof next.hostId !== 'string' || !next.hostId) return false;
  if (!current) return true;
  if (current.hostId === next.hostId && current.sessionId === next.sessionId) return true;
  const nextStart = Number(next.startedAt) || 0;
  const curStart = Number(current.startedAt) || 0;
  if (nextStart !== curStart) return nextStart > curStart;
  return String(next.hostId) < String(current.hostId);
}

// A presence message is only useful for this room/protocol. Old protocol
// versions are ignored rather than allowed to capture a newer client.
export function isUsableHostAnnouncement(msg, room, protocol) {
  return !!msg && msg.type === 'host_present' && msg.room === room &&
    (msg.protocol === undefined || msg.protocol === protocol);
}
