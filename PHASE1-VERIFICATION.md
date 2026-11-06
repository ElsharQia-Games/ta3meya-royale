# Phase 1 Verification — Multiplayer Foundation

- **Date:** 2026-11-06
- **Specification:** `report1.md`
- **Scope:** Phase 1 only — fixed-step browser simulation, input admission, queue policy, P2P host election, session lifecycle, MQTT hardening, host-shutdown authentication, and regression tests.
- **Repository state:** all changes are uncommitted.

---

## 1. Findings validation

Each reported finding was checked against the pre-change implementation (`HEAD`) before being fixed.

| ID | Finding | Verdict | Pre-change evidence |
|---|---|---|---|
| F1 | Browser host simulation is coupled to render frame rate | **Confirmed** | `BrowserHost.step(dt)` passed the caller's frame delta directly to `game.step(inputs, dt, …)`. At 30 FPS the world advanced in 30 large steps/second; at 120 FPS in 120 small steps/second. Physics and timers therefore changed with rendering throughput. |
| F2 | Browser host input admission is not validated | **Confirmed** | `_onSocketMessage` decoded `MSG.INPUT` and pushed it whenever the queue had room. There was no `sanitizeWireInput`, no NaN/infinity check, no invalid-slot/stance gate, no sequence rejection before enqueueing, and no input/control rate limit. Invalid frames also refreshed `lastInputAt`, keeping stale input alive. |
| F3 | Input scheduling and queue backpressure are inconsistent | **Confirmed** | The browser host dropped the **newest** frame when `queue.length >= INPUT_BACKLOG`; the dedicated server used `pushBoundedInput`, which drops the **oldest**. The browser host had no drop/rejection diagnostics and the server hard-coded `150` inputs/s while the host had no limit. |
| F4 | Concurrent room discovery can create multiple hosts | **Confirmed** | `joinPeerSession` started a 2.5 s probe and unconditionally called `becomeHost()` if no `peer_ready` arrived. With two simultaneous joiners, both could time out and create independent hosts. There was no candidate announcement, stable node identity, or deterministic comparator. |
| F5 | Relay reconnection can create duplicate session resources | **Confirmed** | Every `onStatus('connected')` callback re-ran host creation or restarted discovery. A reconnect could construct an additional `BrowserHost` (or second probe) that the already-resolved promise made unreachable. `cleanup()` was an empty placeholder. |
| F6 | Peer reconnection and cleanup are incomplete | **Confirmed** | Host timers, relay subscriptions, relay sockets, and peer connections were not tracked. `close()` was not idempotent. `NetClient` retried by default, which cannot work for a one-shot DataChannel/relay socket. Late callbacks had no closure guard. |
| F7 | MQTT packet handling and error propagation need hardening | **Confirmed** | Every SUBSCRIBE used packet id `1`. QoS 1/2 PUBLISH packet ids were treated as application payload. There was no SUBACK handling. Malformed remaining-length frames were silently discarded, and transport-construction failures did not report through `onError`. |
| F8 | Relay guests remain in the authoritative match after leaving | **Confirmed** | A graceful guest `session.close()` closed the relay socket without sending `leave`, and `RelaySocket` has no peer-close event. The host kept the player entity and negotiation entry forever. An abruptly disconnected guest had no timeout either. |
| F9 | `host_offline` is unauthenticated | **Confirmed** | `hostId`/`sessionId` are published on the public presence topic, so a third party could publish a matching `host_offline` and terminate a guest. Matching ids are an identity hint, not proof of origin. |
| F10 | Signaling can pin an arbitrary host before discovery | **Confirmed** | An identity-bearing `offer`/`peer_ready` could establish `knownHost` before any usable presence/election result. A stale or hostile signal could therefore become the pinned host. |
| F11 | Required implementation/test files are untracked | **Confirmed (repository state)** | `src/net/election.js`, `src/net/host-auth.js`, `test/peer-election.test.js`, `test/browser-host-peer.test.js`, `test/helpers/fake-relay.js`, and `qa/peer-multiplayer.mjs` existed only as untracked files. They are present, exercised, and documented here; nothing was committed. |

**Rejected findings:** none. All findings were reproduced in the source or verified from repository state.

**Partial coverage:** the explicit authenticated `host_offline` path is implemented and tested, but an **abrupt** relay host loss (broker/network silently drops the host) still cannot be detected by a relayed guest because the MQTT socket has no peer-close signal. This is a documented residual limitation, not a rejected finding. The reverse direction — an abruptly disconnected **guest** — is now bounded by the host's last-seen watchdog.

### 1.1 Diff-review follow-up

A second review of the Phase 1 diff identified the following concerns. Each was re-checked against the working tree before any change was made.

| # | Concern | Verdict | Evidence / correction |
|---|---|---|---|
| R1 | Relay fallback and WebRTC upgrade race can delete the guest and register a competing socket | **Confirmed** | The fallback's `relaySocket` was recorded before the late `onOpen` callback ran. `onOpen` nulled `g.socket` and closed the relay, whose `onclose` disposed the guest and left the DataChannel untracked. Fixed with first-transport-wins: once relay fallback activates, the unfinished peer connection is abandoned; a late `open` is discarded. Regression: `test/browser-host-peer.test.js`. |
| R2 | A pending peer join cannot be cancelled, and an unreachable broker can hang the lobby forever | **Confirmed** | `joinPeerSession()` had no abort input and no connect deadline. It now accepts `signal` and `connectTimeoutMs` (default 15 s) and releases the relay on abort/timeout. Regressions: cancellation and unreachable-broker tests in `test/peer-election.test.js`. |
| R3 | Signaling messages do not prove host/session identity | **Confirmed** | Once presence pins a host, `peer_ready`/`offer`/`candidate` must match `hostId` + `sessionId`; untagged legacy messages are accepted only before identity is known. The host applies the same optional-field rule to answers/candidates. Regression: spoofed-signal and late-signal tests in `test/peer-election.test.js`. |
| R4 | `src/main.js` does not own `session.close()` | **Confirmed** | `joinPeerSession()` returned a session whose host/relay/timers were not owned by any caller field, so leave/error paths could leak them. `main.js` now stores `peerSession`/`pendingJoin`, aborts pending joins, and closes the session exactly once on leave, terminal peer error, offline join, and lobby teardown. |
| R5 | `host_offline` is trusted too broadly | **Confirmed** | A stale or spoofed presence message could terminate a live guest. It is now acted on only when both `hostId` and `sessionId` match the pinned host. Regression: stale `host_offline` test in `test/peer-election.test.js`. |
| R6 | `qa:multiplayer` cannot start two clients and does not reach its assertions | **Confirmed** | Two pages in one browser competed for the single software-GL renderer; the second page never became actionable. Each client now gets its own browser process, Bravo uses a smaller viewport, and the movement probe polls simulated position instead of assuming wall-clock time. Result: **29/29 checks pass**, exit 0. |
| R7 | `election.js` and its required regression tests are missing | **Confirmed absent, now present** | `src/net/election.js` provides `electCandidate`, `isHostAnnouncementNewer`, and `isUsableHostAnnouncement`; helpers and convergence are covered by `test/peer-election.test.js`. |
| R8 | Graceful guest leave and abrupt guest loss leak authoritative players | **Confirmed** | `joinPeerSession().close()` now calls `net.leave()` while the relay is still open, then closes the transport. The host handles `leave` before control-rate limiting and disposes the guest negotiation. Every authenticated/assigned message refreshes `lastSeenAt`; a watchdog removes relay guests that exceed `guestTimeoutMs` (default 45 s). Regressions: leave/rejoin and watchdog tests. |
| R9 | A public host/session id pair is not authentication | **Confirmed** | Added `src/net/host-auth.js`: an ECDSA P-256 session key pair, a canonical offline payload, a pre-signed `host_offline` message, and verification against the key advertised in discovery. A keyed guest now ignores an unsigned/forged shutdown. Regressions: signed, forged, and unsigned `host_offline` tests. |
| R10 | Pre-presence signals can pin a host | **Confirmed** | `acceptHostIdentity()` now requires a host already established by usable presence/election. `offer`, `peer_ready`, and `candidate` received while still discovering are ignored. Regression: pre-presence signaling rejection test. |
| R11 | Untracked files can be omitted from the release | **Confirmed** | The election helpers, host-auth helpers, browser-host/peer regressions, fake relay helper, and peer QA script are all present and exercised. They remain uncommitted by request. |

---

## 2. Root causes and remediation

### 2.1 Fixed-step simulation (F1)

- `BrowserHost.step(dt)` now accumulates elapsed time and advances the world only in `CFG.SIM_DT` increments.
- Catch-up is bounded to six fixed ticks (`MAX_CATCHUP_STEPS = 6`, ≈100 ms). Remaining backlog is discarded and counted in `droppedSimTime`, preventing a spiral of death after a long stall or background-tab resume.
- All simulation-owned timers (snapshot emission, vehicle packets, ping) advance from `_stepFixed()`, not from render time.
- `step()` returns the number of ticks executed and ignores non-finite/non-positive deltas.
- Diagnostics: `tickCount`, `catchUpSteps`, `droppedSimTime`, `snapshotSeq`.
- An injectable `now` function makes stale-input and rate-limit behavior deterministic in tests.
- The documented policy is: after a stall, stale wall-clock time is skipped rather than replayed; game time can lag wall-clock time after a long pause.

### 2.2 Input admission and scheduling (F2, F3)

- Input frames are rate-limited first (`INPUT_RATE_PER_SECOND = 150`), then decoded, then passed through the shared `sanitizeWireInput()` gate **before** enqueueing.
- Sequence validation uses `lastQueuedSeq`, so duplicate and out-of-order frames are rejected before they occupy queue space or refresh the stale timer.
- Invalid frames increment `rejectedInputs`; they never reach `game.step`.
- Both hosts use the same `pushBoundedInput()` policy: newest frame wins, oldest queued frame is dropped, and `droppedInputs` is surfaced per client.
- Acknowledgements use `lastConsumedSeq`, not `lastQueuedSeq`, so the client is told what the simulation actually consumed.
- Stale input uses the shared 250 ms window. Held movement/shoot is neutralised after silence; one-shot actions are cleared by `heldSimInput()` and cannot repeat from a held frame.
- Control frames (chat/resync/spectate) are rate-limited at `CONTROL_RATE_PER_SECOND = 20`, and chat/spectate fields are sanitised. `leave` is lifecycle control and is processed even when the control budget is exhausted.
- The dedicated server now imports the same `INPUT_RATE_PER_SECOND` constant; its old misleading “token bucket” comment was corrected to describe the fixed one-second window.

Documented overflow trade-off: dropping the oldest frame can drop a one-shot action during a flood, but cannot replay one. Queue depth stays bounded and latency does not grow without limit.

### 2.3 P2P election and lifecycle (F4, F5, F6, F8, F10)

- Added pure helpers in `src/net/election.js`:
  - `electCandidate()` — deterministic lowest `nodeId` among observed candidates.
  - `isHostAnnouncementNewer()` — newer `startedAt` wins; equal timestamps fall back to stable `hostId`.
  - `isUsableHostAnnouncement()` — rejects other rooms, non-host presence messages, and old protocol versions.
- Joining now runs an explicit state machine: `idle → discovering → awaiting-host → hosting → connected`, with terminal `failed` and `closed` states.
- Candidates subscribe to presence before announcing, repeat candidate announcements during the probe window, and elect exactly one winner under a healthy broker.
- Hosts publish `hostId`, `sessionId`, `startedAt`, protocol, and (when available) their public key in presence, announce immediately, heartbeat every 2 s, and answer candidate probes immediately. The immediate probe reply bypasses the 500 ms heartbeat throttle; otherwise a probe landing just after a heartbeat could miss the host and elect itself.
- Repeated `onStatus('connected')` events reuse the existing host/session and only refresh announcements; the relay re-subscribes its existing topic set.
- A losing candidate waits for the elected host, retries hello, and re-elects only if the winner never appears.
- Host sockets, subscriptions, timers, peer negotiation state, ICE candidates, and peer connections are tracked. `close()` is idempotent and releases them.
- WebRTC attempts and relay fallback are mutually exclusive per guest. First transport wins: when relay fallback wins, both the host and the guest close their unfinished `RTCPeerConnection`, clear queued ICE state, and ignore a late DataChannel open. The fallback delay is configurable (`webrtcFallbackMs`, default 5 s) so tests can force the race deterministically.
- The host validates guest answers/candidates against the host session when the optional identity fields are present, so a delayed guest cannot complete negotiation with a superseded host.
- The guest pins the first **usable presence/election** host identity. `peer_ready`/`offer`/`candidate` must match it; a signal cannot create the pinned host by itself. Untagged legacy messages are tolerated only before identity is known. A late signal after `session.close()` cannot recreate a negotiation.
- `joinPeerSession()` accepts an `AbortController` signal and a broker connect deadline. Abort or timeout rejects the join, releases the relay, and leaves the lobby in a recoverable state.
- `src/main.js` owns the resolved session handle: `pendingJoin` is aborted on leave/offline, and `peerSession.close()` runs exactly once on leave, terminal peer error, offline transition, or teardown. Closing the handle releases the host, relay, accepted transport, and every timer owned by the session.
- A terminal peer failure while a match is active now leaves gameplay: it clears held input, hides the HUD/reconnect chrome, shows the lobby with an explanatory status, and re-enables Deploy. The player can start a fresh peer session instead of ticking a stale HUD against `net === null`.
- Peer `NetClient`s use `allowReconnect: false` and surface a terminal error instead of retrying a dead socket. The lobby’s manual reconnect refuses to rebuild such a transport.
- A connected relay guest treats a matching, authenticated `host_offline` as terminal (`hostLost`), rather than remaining “connected” to a dead host.
- Graceful guest shutdown sends `leave` while the transport is still open; the host removes the player immediately and disposes the negotiation so the same guest id can rejoin.
- Relay guests have no peer-close event. The host refreshes `lastSeenAt` for every authenticated/assigned message and sweeps clients beyond `guestTimeoutMs` (default 45 s, injectable). `guestSweepMs` defaults to `max(10, min(2000, floor(timeout / 4)))`.

**Election assumption:** convergence is guaranteed for the documented healthy-broker case where all candidates observe the same announcements within the discovery window. This is not a consensus protocol and does not guarantee global uniqueness during arbitrary partitions.

### 2.4 Authenticated host shutdown (F9)

- Added `src/net/host-auth.js` with `createHostIdentity`, `signHostOffline`, `verifyHostOffline`, `hostOfflinePayload`, and `canAuthenticateHost`.
- Host identity is an ECDSA P-256 key pair over `globalThis.crypto.subtle`. The public key is exported as JWK and published in presence, offer, `peer_ready`, and candidate messages.
- The signed payload is canonical JSON: protocol version, `host_offline`, `hostId`, `sessionId`, `room`, and `startedAt`. A signature is valid only for that exact session.
- `BrowserHost` pre-signs the shutdown message at start. `joinPeerSession()` generates the candidate identity up front, `becomeHost()` is async, and session establishment awaits `host.ready()` so a caller cannot close before `host_offline` is authenticatable.
- A guest that pinned a host key verifies the signature before terminating. Forged or unsigned shutdown messages are ignored.
- Public host/session ids remain identity hints only. A keyless legacy host keeps the identity-only path for compatibility and is documented as unauthenticated.
- This is trust-on-first-use: it prevents a third party from forging shutdown for an established host, but it cannot prove who owns a room before any key has been seen.

### 2.5 MQTT transport (F7)

- Packet identifiers are allocated from a monotonic 1–65535 space and tracked until SUBACK.
- SUBACK releases the in-flight id; a rejected subscription (`0x80`) reports an error.
- PUBLISH parsing supports QoS 0, 1, and 2:
  - QoS 0 delivers the payload unchanged.
  - QoS 1 strips the packet id, sends PUBACK, and delivers once.
  - QoS 2 waits for PUBREL, sends PUBREC/PUBCOMP, and deduplicates a repeated PUBREL.
- Remaining-length parsing, packet size (256 KiB), and partial-buffer size (512 KiB) are bounded; malformed/oversized frames report an error and close the stream.
- CONNACK rejection and transport construction failures propagate through `onError`.
- Reconnect clears packet/partial-packet state and resubscribes each active topic once on the new transport.
- `close()` is idempotent and sends DISCONNECT when possible.

### 2.6 Compatibility

- `PROTOCOL_VERSION` remains `7`; no dedicated-server wire frame was restructured.
- Peer presence/signaling JSON gained optional identity fields (`hostId`, `sessionId`, `startedAt`, `protocol`, `hostKey`, `signature`). Existing presence handling ignores unknown fields, and missing protocol/key is tolerated for old announcements.
- No gameplay rules, movement physics, collision, ballistics, hitboxes, rendering, audio, or vehicle behavior were changed.

---

## 3. Changed files

| File | Change |
|---|---|
| `src/net/host.js` | Fixed-step accumulator, input admission/sanitisation/rate limits, bounded queue, diagnostics, host identity/presence, peer negotiation dedupe, first-transport-wins WebRTC/relay fallback (`webrtcFallbackMs`, `_abandonPeerConnection`), guest signal identity checks, graceful leave handling, last-seen guest watchdog, signed `host_offline`, immediate probe discovery, tracked cleanup, idempotent `close()`. |
| `src/net/peer.js` | Discovery/election state machine, candidate and host presence, hello retry, presence-established host pinning, pre-presence signal rejection, authenticated `host_offline` verification, async `becomeHost()` awaiting key readiness, `net.leave()` on close, guest WebRTC disposal when relay fallback wins, join cancellation (`signal`) and connect deadline, closure guards, injectable relay factory/timings, resource cleanup. |
| `src/net/host-auth.js` | **New.** ECDSA P-256 host identity, canonical offline payload, sign/verify helpers, capability check. |
| `src/net/election.js` | **New.** Pure deterministic election and announcement-ordering helpers. |
| `src/net/relay.js` | MQTT packet-id allocation, SUBACK, QoS 0/1/2 parsing, PUBREL/PUBCOMP, size ceilings, error propagation, reconnect resubscription. |
| `src/net/client.js` | `allowReconnect` opt-out, closed-transport detection, terminal peer errors, explicit `leave()`. |
| `shared/protocol.js` | Shared `INPUT_RATE_PER_SECOND` / `CONTROL_RATE_PER_SECOND`, documented queue overflow/ack semantics. |
| `server/server.js` | Uses shared input rate constant; corrected comment. No gameplay changes. |
| `src/main.js` | Owns the resolved peer session (`peerSession`), aborts pending joins, closes the session on leave/offline/terminal error, and refuses to rebuild non-reconnecting peer transports. |
| `qa/multiplayer.mjs` | Separate browser process per client, reduced viewport for the second client, longer join budget, position-polling movement probe, non-fatal diagnostic screenshots. Movement remains deterministic when the QA server is started with `BOTS=0`. |
| `qa/peer-multiplayer.mjs` | **New.** Browser-hosted peer QA for scenarios A–E: two real browsers, public MQTT discovery/relay, real WebRTC, 30 FPS host degradation, relay reconnect, terminal peer-failure lobby recovery and redeploy, and concurrent election rounds. |
| `package.json` | Adds `qa:peer`. |
| `test/helpers/fake-relay.js` | **New.** In-memory broker/relay with topic matching, subscription inspection, and `waitFor`. |
| `test/browser-host-timing.test.js` | **New.** Fixed-step and bounded-catch-up regressions. |
| `test/browser-host-input.test.js` | **New.** Admission, queue, rate, stale-input, ack, and control-frame regressions. |
| `test/browser-host-peer.test.js` | **New.** Relay-fallback/late-WebRTC-open race regression. |
| `test/mqtt-relay.test.js` | **New.** Packet-id, SUBACK, QoS, framing, error, and reconnect regressions. |
| `test/peer-election.test.js` | **New.** Election convergence, repeated connect, stale/forged/unsigned `host_offline`, pre-presence signaling, cleanup, graceful leave/rejoin, guest watchdog, join cancellation, connect timeout, relay-fallback WebRTC disposal. |

---

## 4. Tests added

Baseline before this work: **136** tests. Current: **167** tests (31 new regressions).

| Test file | Tests | Coverage |
|---|---:|---|
| `test/browser-host-timing.test.js` | 5 | SIM-01, SIM-02–04, SIM-05/06, SIM-08, multi-tick input consumption/ack |
| `test/browser-host-input.test.js` | 6 | Malformed/duplicate/out-of-order rejection, bounded queue, rate limit, stale/one-shot behavior, consumed-sequence ack, control-frame limit |
| `test/browser-host-peer.test.js` | 1 | Relay fallback wins over a late WebRTC open; losing peer connection is closed, no competing socket is registered, and guest tracking is preserved |
| `test/mqtt-relay.test.js` | 8 | Unique packet ids, SUBACK/rejection, reconnect resubscription, QoS 0 fragmented, QoS 1 PUBACK, QoS 2 handshake/dedupe, malformed/oversized frames, transport errors |
| `test/peer-election.test.js` | 11 | Election helpers, simultaneous-joiner convergence, repeated `connected` idempotence, matching/forged/unsigned `host_offline`, graceful leave/rejoin, watchdog removal, idempotent cleanup, pending-join cancellation, unreachable-broker timeout, pre-presence/spoofed/late signaling identity, relay-fallback WebRTC disposal and late DataChannel open |
| `test/helpers/fake-relay.js` | — | In-memory broker helper with topic/subscription inspection used by the peer tests |

Existing tests were not weakened, skipped, or deleted.

---

## 5. Verification matrix

### 5.1 Automated

| ID | Status | Evidence |
|---|---|---|
| SIM-01 | Pass | `0.1 s → 6 ticks`, accumulator below one step. |
| SIM-02–04 | Pass | 30/60/120 FPS all produce ~120 ticks over 2 s. |
| SIM-05 | Pass | Jittered intervals follow accumulated elapsed time within one tick. |
| SIM-06 | Pass | 2 s stall runs only 6 ticks and discards >1.5 s. |
| SIM-08 | Pass | 30 snapshots emitted over 1 s of fixed ticks. |
| IN-01 | Pass | Ordered input consumed; ack reports consumed sequence. |
| IN-02 | Pass | Duplicate sequence rejected before enqueue. |
| IN-03 | Pass | Out-of-order sequence rejected. |
| IN-04 | Pass | NaN/Infinity yaw and pitch rejected. |
| IN-05, IN-06 | Pass (shared gate) | Invalid buttons/slot/stance/vehicle IDs go through `sanitizeWireInput`; dedicated-server protocol tests already cover the shared gate. |
| IN-07 | Pass | Queue bounded; oldest dropped; drop counter matches. |
| IN-08 | Pass | 160-frame flood admits 150; next window recovers. |
| IN-09, IN-10, IN-11 | Pass | Silence neutralises movement/shoot; one-shot actions never repeat; held frame retains view. |
| IN-12 | Pass | Ack advances only when the frame is consumed. |
| P2P-01, P2P-02 | Pass | Solo candidate hosts; second candidate joins as guest in the convergence test. |
| P2P-03 | Pass | Two simultaneous joiners produce exactly one host and one guest. |
| P2P-05 | Pass | Repeated `connected` callbacks do not rebuild host or subscriptions. |
| P2P-06 | Pass | Repeated transport status reuses the existing session; no new election. |
| P2P-07 | Pass | Graceful leave removes the player and negotiation so the guest can rejoin; a silent relay guest is removed by the watchdog; explicit `host_offline` terminates the guest. |
| P2P-08 | Pass (explicit close) | A matching, authenticated `host_offline` terminates the relay guest. A wrong or forged shutdown is ignored. Abrupt host loss remains untestable on the relay path. |
| P2P-09, P2P-12 | Pass | Pre-presence and spoofed host identities cannot pin a negotiation; a signal published after `session.close()` does not create another peer connection. |
| P2P-10 | Pass | `session.close()` releases subscriptions/timers/transport and is idempotent; leave/rejoin does not accumulate guests. |
| P2P-10 (join failure) | Pass | Aborting a pending join rejects with `AbortError` and closes its relay; an unreachable broker rejects on the connect deadline instead of hanging. |
| P2P-11 | Partial | First-transport-wins and the late-open race are unit-tested with a fake `RTCPeerConnection`. Real direct WebRTC is exercised by peer QA scenario B (`pc:true`, relay unused); the real **fallback timer** to relay was not isolated in a browser. |
| Host shutdown authentication | Pass | Keyed guests accept a valid signature, reject forged and unsigned signatures, and remain in the room on mismatch. Keyless legacy behavior is retained and documented. |
| MQTT-01 | Pass | QoS 0 payload unchanged, including fragmented input. |
| MQTT-02 | Pass | QoS 1 packet id stripped, PUBACK sent, payload delivered once. |
| MQTT-03 | Pass | Multiple subscriptions receive unique ids. |
| MQTT-04 | Pass | Fragmented packet parsed after remaining bytes arrive. |
| MQTT-05 | Pass | Malformed remaining length and oversized frame fail closed with an error. |
| MQTT-06 | Pass | Reconnect resubscribes each active topic once with fresh ids. |
| MQTT-07 | Pass (session layer) | Repeated `connected` status does not create a duplicate logical session; relay subscription ownership is keyed by topic. |
| MQTT-08 | Pass | Transport and subscription-rejection errors reach `onError`; CONNACK rejection uses the same error path and is code-reviewed. |

### 5.2 Partial or not executed

| ID / scenario | Status | Reason |
|---|---|---|
| SIM-07 (real tab background/resume) | Partial | Bounded long-stall recovery is unit-tested; no real browser tab visibility test was executed. |
| P2P-04 (slow WebRTC negotiation) | Not executed | No isolated slow-negotiation run. Real WebRTC direct connection is exercised, and the fallback race is unit-tested, but this specific timing case was not run. |
| P2P-08 (abrupt host loss) | Partial | Explicit authenticated `host_offline` is tested. A silent broker/network loss has no close signal on the relay path. |
| P2P-11 (real WebRTC → MQTT fallback) | Partial | Direct real WebRTC passed in scenario B. The fallback decision, single-transport rule, and late-open race are covered with a fake `RTCPeerConnection`; the real fallback timer was not forced in a browser. |
| Browser scenarios A–E (browser-hosted peer mode) | **Pass** | Two real Chromium clients against public MQTT brokers; see section 6. |
| Browser scenario F (dedicated-server regression) | **Pass** | `npm run qa:multiplayer`: **29/29 checks pass**, exit 0, no page errors. |
| Hardware-GPU performance | Not executed | The QA environment uses SwiftShader (software GL); no production FPS claim is made. |

---

## 6. Verification results

### `npm test`

```
tests 167
pass  167
fail  0
cancelled 0
skipped 0
todo 0
```

### `npm run nettest`

Exit code **0**. All five profiles completed. Selected measured values (loopback, application-level loss, not a WAN/TCP-loss measurement):

| Profile | Applied snapshots | Input rate | Correction p95 | Ack misses |
|---|---:|---:|---:|---:|
| local | 30.2 Hz | 59.92 Hz | 1.97 cm | 0 |
| 50 ms / 5% loss | 24.7 Hz | 60.00 Hz | 12.82 cm | 10 |
| 150 ms / 5% loss | 21.6 Hz | 59.92 Hz | 12.44 cm | 12 |
| 300 ms / no loss | 30.3 Hz | 59.92 Hz | 1.88 cm | 0 |
| 300 ms / 5% loss | 22.4 Hz | 59.92 Hz | 12.30 cm | 13 |

The lossy profiles exercise delta-cache recovery/resync, not TCP head-of-line behavior. No performance claim beyond these measurements is made.

### `npm run build`

Passed (Vite 6.4.5, 70 modules, built in 1.77 s). Only the existing chunk-size warning:

```
dist/assets/index-CS6m8fDB.js   1,049.18 kB │ gzip: 300.67 kB
(!) Some chunks are larger than 500 kB after minification.
```

### `npm run qa:multiplayer`

**Passed: 29/29 checks, exit 0, no page errors.**

Command:

```
PORT=3112 BOTS=0 node server/server.js
QA_URL='http://127.0.0.1:3112/?server=ws://127.0.0.1:3112/ws' npm run qa:multiplayer
```

Environment: fresh server on `127.0.0.1:3112` serving the current `dist/`, protocol 7, bots disabled. Chromium with SwiftShader (software GL). Measured client FPS was ~1 FPS, so only functional behavior is claimed.

`BOTS=0` is used because Battle Royale has no respawn: with 24 bots, the movement probe can legitimately be killed before it walks. The QA still covers the BR zone/minimap path; bot combat itself is exercised by other QA paths, not asserted here.

Covered in the passing run:

- Both clients join, roster replication, remote character views, live match state.
- HUD health/armour/ammo/weapon/crosshair/compass/minimap/team/FPS.
- Tab scoreboard columns, roster rows, local-player marker, team colour, score/ping, subtitle.
- Online kill feed name resolution, team colours, headshot/zone formatting.
- Local movement simulation and replication of B's position to A.
- Chat open/focus; typed WASD/clicks/stance never leak into gameplay; message round-trip; input restored on close.
- Reconnect key while disconnected; player id preserved.
- Server snapshots and bandwidth still flowing.
- Screenshots written to `qa/shots/` when the browser survives to the end (screenshot failure is non-fatal).

Selected measured values from the recorded passing run: B moved **2.42 m** while alive; A's replicated copy of B was within **0.94 m** of B's final position; 2-player roster (bots disabled); zone text `SHRINKS IN · 23s · 450m`; snapshots **2628**; ~208 KiB/s.

Harness fixes needed to reach this result:

1. The two pages originally shared one browser. Under a single software-GL renderer the second page did not become actionable before `page.fill` timed out. Each client now launches its own browser process.
2. Bravo runs at `640x360` while Alpha keeps `1280x720` for screenshots. This raises the simulated frame rate enough for the interaction checks without weakening any assertion.
3. Join/match-state waits use the 120 s page timeout instead of 45 s.
4. The movement probe runs immediately after the join checks and before the slower HUD/scoreboard checks, while Bravo is still alive. It holds `W` and polls the simulated position until motion is observed (or 12 s per heading) instead of assuming a fixed 1.5 s wall-clock window, requires the player to be alive throughout the measured interval, and never counts a death/respawn teleport as movement.
5. Diagnostic screenshots are captured through a guard so a late browser crash cannot turn a completed check run into a harness crash.
6. The BR movement probe is run against a `BOTS=0` QA server when determinism matters; with bots present, a death before the probe has no respawn in BR.

### `npm run qa:peer` (browser-hosted peer mode, scenarios A–E)

**Passed: 20/20 checks, exit 0, no page errors.**

Command:

```
QA_URL='http://127.0.0.1:3110/' npm run qa:peer
```

Environment: static `dist/` server on `127.0.0.1:3110`; two independent Chromium processes with SwiftShader; public MQTT discovery/signaling through the default broker list (`wss://broker.emqx.io:8084/mqtt`, then HiveMQ). Peer matches were run in **TDM** because Battle Royale has no respawn and peer QA cannot restart a match mid-run.

Render caveat: SwiftShader draws this scene at roughly 1 FPS. The peer QA stubs only `window.__frontline.render`, leaving input, networking, and the fixed-step host intact, so the measured ticks/networking are real but **no GPU/render performance claim** is made.

Scenario results from the recorded passing run:

| Scenario | Result | Evidence |
|---|---|---|
| A — Local browser host | **Pass** | Browser became authoritative host (`self:true`, key present); joined with live roster/snapshots; local movement **7.95 m**; magazine drained **30 → 21**; host advanced **121 ticks** and **61 snapshots** in 2 s. |
| B — Two real browser clients | **Pass** | Second browser joined the same host/session as guest; both snapshot caches contained the other player; transport selected **real WebRTC** (`opened:true`, `pc:true`, no relay socket); guest moved **11.17 m** and the host's cached copy differed by **0.31 m**. |
| C — Host FPS degradation | **Pass** | Host rAF throttled to ~30 FPS: **180 ticks** over 3 s, **46** catch-up steps, **0 s** dropped simulation time; guest received **90** snapshots. |
| D — Network interruption and terminal failure | **Pass** | Host and guest relay sockets were closed and reconnected to the next broker; logical host/session ids were preserved and post-reconnect chat arrived. The guest's active DataChannel was then closed terminally: the client left gameplay (`active:false`, `net:null`, no peer session), showed the lobby with the HUD hidden, re-enabled Deploy, and deployed again successfully. |
| E — Concurrent room creation | **Pass** | Simultaneous and 600 ms-delayed joins each produced exactly one host and one guest in the same room, both active with matching rosters. |
| F — Dedicated-server regression | **Pass** | See `qa:multiplayer` above. |

Harness notes:

- Each client is a separate browser process so two SwiftShader pages do not starve each other.
- The render call is stubbed only to remove GPU draw cost; production rendering is not modified.
- Remote replication is read from `net.cache`, because `characters` views are created inside `render()` and therefore do not exist while draw is stubbed.
- Guest liveness is awaited before the movement probe; TDM respawns make the check deterministic.
- The QA uses real public brokers, so it requires outbound WSS access and is subject to broker availability. The recorded run used the default broker list: EMQX first, with the relay advancing to HiveMQ after the deliberate reconnect in scenario D.

---

## 7. Remaining risks and limitations

1. **Silent relay host loss.** A relay guest only learns about host shutdown from `host_offline`. If the host process dies without publishing it, the guest cannot detect the dead peer from the MQTT socket. A presence watchdog or broker last-will mechanism is the next step.
2. **Guest watchdog latency.** A guest that disconnects without `leave` remains in the authoritative match until `guestTimeoutMs` (default 45 s) expires. Graceful leave is immediate; the timeout is configurable for tighter or looser recovery.
3. **Election is not partition-safe.** Lower-`nodeId` election converges under a healthy broker and a shared discovery window; it cannot guarantee global uniqueness during arbitrary network partitions.
4. **Host shutdown authentication is trust-on-first-use.** A keyed host cannot be impersonated for shutdown after its key is pinned, but the first accepted presence determines that key. Keyless legacy hosts remain unauthenticated for compatibility.
5. **Real WebRTC fallback timing is not isolated.** Direct real WebRTC passed in scenario B. The first-transport-wins rule and late-open race are covered with a fake `RTCPeerConnection`, but the real 5 s fallback timer was not forced in a browser.
6. **Queue overflow can discard a one-shot action.** The documented policy favours bounded latency and no replay. Extremely bursty clients may still lose a reload/use action.
7. **Fixed-window rate limiting allows a boundary burst.** Two windows can admit up to twice the per-second budget across a window edge; this matches the dedicated server and prevents sustained floods.
8. **Background-tab resume skips stale time.** Simulation does not replay missed ticks after a long stall; game time lags wall-clock time by the discarded amount.
9. **Browser-hosted peer coverage is bounded.** Scenarios A–E use two clients, TDM, one public-broker configuration, and software rendering with draw stubbed. Battle Royale, more than two guests, mesh topologies, broker outages, and hardware-GPU behavior were not measured.
10. **Public broker dependency.** Discovery and relay rely on third-party MQTT brokers with no delivery or availability guarantee. Room names are public topics; the host key protects shutdown authenticity, not room privacy.
11. **No measured hardware-GPU performance claims.** The QA environment uses software rendering; any FPS numbers from it would not represent production hardware.

### 7.1 Public-MQTT signaling trust limitations

The peer transport is designed for convenience on public brokers, not as a trusted signaling service. The remaining limitations are explicit:

- **Topics are public and unauthenticated.** Presence uses `ta3meya/<room>/presence`, per-node signaling uses `ta3meya/<room>/signal/<nodeId>`, and relay traffic uses `ta3meya/<room>/to_host/<nodeId>` and `to_guest/<nodeId>`. Anyone who can reach the broker and knows or guesses a room name can subscribe, observe presence/roster traffic, and publish on those topics. No MQTT account, room secret, or access-control layer is configured.
- **First contact is not authenticated.** Election chooses the lowest `nodeId` and accepts a usable first presence announcement. An attacker who publishes first can claim the host role. Host/session identity checks only constrain messages *after* a host has been pinned.
- **The host key protects shutdown only.** The ECDSA P-256 key signs `host_offline`; it does not sign offers, candidates, presence, or relayed gameplay. Keyless legacy hosts remain unauthenticated for shutdown. The key is trust-on-first-use, so it cannot prove room ownership before any key is observed.
- **Signaling is not end-to-end authenticated.** The broker can observe, drop, reorder, or modify signaling messages. A directly established WebRTC DataChannel is DTLS-encrypted, but the public-broker fallback path relies on the broker's transport security rather than an end-to-end host signature. Guests and hosts are identified by random node ids, so chat/name spoofing on the relay path is possible.
- **Availability and rejoin are not guaranteed.** Public brokers may be unavailable or fail over independently. After a terminal peer failure, Deploy starts a fresh discovery session; it may form a new host on a different broker rather than rejoining the original host. The recorded QA run demonstrated exactly this (the redeployed session had a new host id).
- **No room privacy.** Room names and roster/gameplay metadata are visible to anyone watching the broker topic.

These are accepted Phase 1 boundaries. Closing them would require a trusted signaling service or authenticated room membership, which is outside this change set.

---

## 8. Scope confirmation

- No changes to gameplay physics, movement/collision rules, ballistics, hitboxes, vehicle behavior, rendering, audio, or assets.
- No dedicated-server protocol version bump or frame-layout change.
- Dedicated-server behavior changed only to share the input-rate constant and correct a comment.
- Changes are limited to the Phase 1 findings in `report1.md`.
- All changes remain uncommitted; no commit or push was performed.

## 9. Definition-of-done status

| Area | Status |
|---|---|
| Correctness (fixed step, bounded catch-up, admission, queue, one-shots, ack) | Complete and automated. |
| Multiplayer reliability (election, idempotent connect, cleanup, late-callback guards, guest leave/watchdog) | Complete for explicit lifecycle events; silent host loss remains a limitation. |
| Transport (packet ids, QoS formats, malformed frames, error propagation) | Complete and automated. |
| Host shutdown authenticity (`host_offline`) | Complete and automated for keyed hosts; keyless legacy fallback documented. |
| Unit tests / networking integration / build | Passed (167/167 tests, `nettest` exit 0, build passed). |
| Lifecycle follow-up (relay/WebRTC race, cancellation, identity, session ownership, stale/forged `host_offline`, terminal-failure lobby recovery) | Complete and regression-tested. |
| Browser-hosted multi-client test (peer mode, scenarios A–E) | **Passed** (20/20 checks, exit 0). |
| Dedicated-server regression QA (scenario F) | **Passed** (29/29 checks, exit 0). |
| No unrelated gameplay changes | Confirmed. |
| Known limitations documented | Yes (section 7). |

Phase 1 is complete for the automated correctness, reliability, transport, lifecycle, host-authentication, and browser/dedicated multiplayer regression scope in this environment. The limitations in section 7 define the boundary of that claim; no hardware-performance or partition-safety guarantee is implied.
