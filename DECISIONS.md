# DECISIONS.md

## Engine: Three.js + custom deterministic sim, Node server
- Browser-first so friends join by link (no install). Three.js is the most mature choice; Rapier WASM adds load + nondeterminism risk on a static-box world, so physics is a custom fixed-step capsule-vs-AABB world shared verbatim by client and server (guarantees lockstep sim, zero WASM overhead, full control of slopes/steps/grounding). Vehicle uses raycast suspension model on the same world.
- Godot 4 rejected: native binary download burden for friends + ENet UDP needs port-forwarding anyway; browser + Cloudflare Tunnel is easier sharing.

## Netcode: WebSocket (RFC 6455, `ws`) vs WebRTC vs WebTransport
- WebTransport (HTTP/3 QUIC) is technically ideal but browser support is still incomplete (Safari). WebRTC DataChannel gives DTLS/SCTP reliability control but needs STUN/TURN + signaling and loses TCP fallback on restrictive networks. WebSocket/TCP is universally supported, tunnel-friendly, and at 30 Hz with small binary snapshots (~200–600 B) head-of-line blocking cost is acceptable; jitter buffer + interpolation absorbs it. This is a known tradeoff, recorded honestly: if 300 ms+ loss tests show TCP collapse, revisit with WebTransport behind a feature flag.

## Physics/world representation
- Static world = axis-aligned boxes + terrain heightfield. Everything (terrain, buildings, cover, vehicle) resolves to the same collision query (`collideCapsule`) so client prediction == server truth. Fixed dt = 1/60 sim, 30 Hz server tick sends snapshots at 30 Hz.
