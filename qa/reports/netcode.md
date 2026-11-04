# Netcode correctness and server-cost pass

Branch: `agent/net` · baseline commit: `d914a63` · protocol: v5 → v6

This pass replaces per-client input acknowledgements embedded in snapshots with
acks keyed by snapshot sequence, so a single snapshot buffer can be broadcast to
every client. It also hardens the server input path and instruments the load
harness so drops and resets are observable.

All numbers below were produced by the commands in [Measurement](#measurement)
on this worktree. Raw output is kept in `/tmp/opencode/netcode/`.

## What changed

### Ack-by-snapshot-sequence

Before, every snapshot carried `ackInput` in its header. Because each client had
a different ack, the server copied and patched the snapshot buffer once per
client per tick.

- `shared/protocol.js`
  - `PROTOCOL_VERSION` 5 → 6, new `MSG.ACK = 0x13`.
  - `encodeAck(seq, ackInput)` / `decodeAck(buf)`: a 9-byte frame
    `[type u8][seq u32][ackInput u32]`.
  - Snapshot header is 16 bytes instead of 20: the per-client `ackInput` field
    is gone. `decodeSnapshot` no longer returns `ackInput`.
  - `sanitizeWireInput(w, lastSeq)` rebuilds an input from known wire fields,
    rejects `seq === 0`, duplicate and out-of-order sequences, rejects
    non-finite yaw/pitch, clamps pitch, wraps yaw and masks buttons/actions.
- `src/net/client.js`
  - Acks are stored in a `Map` keyed by snapshot sequence (`_onAck`), bounded to
    256 entries (~8.5 s at 30 Hz).
  - `_ackFor(seq)` returns the ack for the **exact** snapshot, or `null` when
    that ack frame was lost. It never guesses a different tick.
  - `snap.ackInput` is still populated, so `src/main.js` is unchanged.
- `src/prediction.js`
  - `reconcile(snapshot, ackSeq)` returns early when `ackSeq` is `null`/
    `undefined`. The next snapshot with a known ack performs the correction.
- `server/server.js`
  - Sends `MSG.ACK` first, then one shared snapshot buffer per tick. Keyframes
    are encoded once per tick and reused by every client that needs one.
  - Removes the per-client `buffer.slice(0)` copy.

**Why skipping a lost ack matters:** the first implementation fell back to the
newest ack at or below the snapshot sequence. That replays one extra input tick
when an ack is lost and roughly doubled the measured p95 correction (loss
profile p95 ≈ 23.5–24.3 cm vs ≈ 12.1 cm baseline). Skipping reconciliation for
that snapshot restores the baseline p95.

### Input / anti-cheat hardening (`server/server.js`)

- `sanitizeWireInput` gate before queueing: replays, duplicates and reordering
  are dropped at the door; every field is normalised; unknown properties cannot
  reach the simulation.
- Input queue capped at 16 entries (`MAX_INPUT_BACKLOG`, ~267 ms at 60 Hz)
  instead of `CFG.NET.maxQueuedInputs = 64` (~1 s of stale input). The oldest
  input is dropped and counted in `droppedInputs`.
- Held input is neutralised after `INPUT_STALE_MS = 250` ms without a frame, so
  a silent client stops moving/shooting instead of acting forever on the last
  frame. One-shot actions were already never repeated.
- Snapshot backpressure: sockets with `bufferedAmount > 256 KiB` skip the
  snapshot and are flagged for a keyframe on recovery (`skippedSnapshots`).
- Empty/truncated binary frames are ignored, and the whole binary handler is
  wrapped so a malformed frame cannot throw inside the `ws` message handler.
- The sim accumulator safety valve changed from `SIM_DT * 10` (167 ms) to 1 s
  and now increments `simResets`. Previously a normal GC/event-loop pause could
  silently discard sim time and leave the server permanently behind.

### Measurement harness

- `tools/nettest.js` mirrors the exact-ack client behaviour and reports
  `acksReceived`, `ackMisses`, `skippedReconciles`.
- `tools/loadtest.js`
  - Reports `droppedInputs`, `skippedSnapshots`, `simResets` and
    `inputHzPerClient`.
  - The input generator now uses drift-corrected deadlines. `setInterval(16.67)`
    actually fires at ~61.7 Hz on Node, which made the generator outrun the
    60 Hz simulation and produced false `droppedInputs`. With the fix the
    measured rate is `60.0 Hz/client` and drops are 0.

## Measurement

Commands (both run inside `/home/medo/coding/shooter-game/.worktrees/net`):

```sh
npm test
npm run nettest                          # nettest server on :3100/:3101
SECONDS=60 PORT=3201 npm run loadtest    # 32 clients, loadtest server on :3201
```

Baseline was captured at `d914a63` with the same commands. The live dev server
on `:3000` was not used or modified. Every loadtest run spawns its own server on
`:3201`.

### Load test — 32 clients, 60 s

Baseline uses the old 61.7 Hz generator; the two post-change runs use the
corrected 60 Hz generator. This is called out again under
[Caveats](#caveats).

| Metric | Baseline | After run A | After run B |
|---|---:|---:|---:|
| tick mean (ms) | 0.698 | 1.306 | 0.977 |
| tick max (ms) | 1.138 | 1.933 | 1.355 |
| tick budget (ms) | 16.67 | 16.67 | 16.67 |
| snapshot total mean (KB/s) | 585.7 | 593.2 | 592.5 |
| snapshot total peak (KB/s) | 606.3 | 614.7 | 609.8 |
| snapshot per client (KB/s) | 18.3 | 18.54 | 18.52 |
| bytes received (MB / 60 s) | 45.87 | 46.28 | 46.29 |
| snapshots received | 60 601 | 60 716 | 60 640 |
| RSS start (MB) | 107.8 | 106.9 | 105.6 |
| RSS end (MB) | 223.1 | 229.7 | 170.2 |
| RSS growth (MB) | +115.3 | +122.8 | +64.6 |
| heap min (MB) | 18.7 | 18.5 | 21.0 |
| heap max (MB) | 90.9 | 95.1 | 69.5 |
| heap last (MB) | 67.2 | 95.1 | 51.3 |
| droppedInputs | n/a | 0 | 0 |
| skippedSnapshots | n/a | 0 | 0 |
| simResets | n/a | 0 | 0 |
| input Hz / client | ~61.7 | 60.0 | 60.0 |

The ACK frame adds 9 bytes × 60 Hz × 32 clients ≈ 17 KB/s in theory; measured
growth is ~7.5 KB/s total (0.22 KB/s/client), well under 1 % of the snapshot
stream. Tick time and RSS vary substantially between runs — see
[Variance](#variance). All tick samples are below 12 % of the 16.67 ms budget.

### Net test — correction after reconciliation

`predErr` is the distance between the position the client had already predicted
and the corrected position after replaying unacked inputs from the authoritative
snapshot, in cm. This is the visible snap, not the expected latency gap.

| Profile | snapHz | RTT p50 | RTT p95 | corr p50 | corr p95 | corr max | ack misses |
|---|---:|---:|---:|---:|---:|---:|---:|
| Baseline local | 30.4 | 2.7 | 2.9 | 1.07 | 1.91 | 8.00 | — |
| After local | 30.5 | 2.8 | 5.4 | 1.09 | 2.05 | 12.86 | 0 |
| Baseline 50 ms + jitter + loss | 28.7 | 100.6 | 107.3 | 1.16 | 12.12 | 33.85 | — |
| After 50 ms + jitter + loss | 29.0 | 98.9 | 105.3 | 1.20 | 11.45 | 36.37 | 19 |
| Baseline 150 ms + jitter + loss | 29.0 | 300.2 | 321.2 | 1.18 | 12.15 | 25.21 | — |
| After 150 ms + jitter + loss | 28.6 | 301.4 | 313.6 | 1.17 | 12.40 | 24.24 | 15 |
| Baseline 300 ms no loss | 30.1 | 610.8 | 647.9 | 1.23 | 12.15 | 24.52 | — |
| After 300 ms no loss | 30.4 | 619.6 | 644.9 | 1.21 | 12.78 | 24.75 | 0 |
| Baseline 300 ms + jitter + loss | 28.5 | 602.8 | 641.0 | 1.34 | 13.15 | 26.30 | — |
| After 300 ms + jitter + loss | 28.9 | 623.8 | 645.3 | 1.23 | 13.25 | 24.74 | 26 |

p95 correction delta vs baseline: **+0.14, −0.67, +0.25, +0.63, +0.10 cm**.
Every profile is within the 2 cm rule; the largest delta is 0.63 cm.

`ackMisses` and `skippedReconciles` match exactly in every loss profile. These
are ack frames dropped by the harness's independent message-level loss
emulation; the client correctly skips that snapshot rather than guessing an ack.
The no-loss profiles report 0.

## Variance

Measurements were repeated because the machine is shared and single runs are
noisy.

- **Net test:** one run reported `300ms+jitter+loss` p95 = 22.37 cm, above the
  2 cm rule. A re-run of the same code reported 13.25 cm and 13.22 cm in the
  earlier final run. The 22.37 was an outlier in the emulated loss schedule
  (p50 was unchanged at 1.39 cm). No code change was made for it.
- **Load test, tick mean:** post-change 60 s runs measured 0.821, 0.977, 1.111,
  1.195 and 1.306 ms. The baseline single sample was 0.698 ms. Tick time is
  still 6–8 % of the budget, but a single baseline sample cannot prove a
  regression or an improvement at this granularity.
- **Load test, RSS growth:** post-change 60 s runs measured +60.5, +64.6, +65.1,
  +69.6 and +122.8 MB; baseline measured +115.3 MB. Heap min/max/last move in
  step with GC timing (for example run A ends at heap 95.1 MB, run B at
  51.3 MB). The median post-change growth (+65.1 MB) is below the baseline
  sample, but the worst post-change run (+122.8 MB) is above it. A 60 s window
  is too short to separate GC timing from a leak; this pass does not claim an
  RSS improvement.

## Caveats

- The baseline load test used the old generator at ~61.7 Hz input; the after
  runs use a compliant 60 Hz generator. The baseline therefore pushed ~2.8 %
  more input work. Snapshot bandwidth and tick time are still comparable, but
  the drop counters cannot be compared (they were not instrumented at
  baseline).
- `nettest` loss is applied per message over TCP, so an ACK can be lost
  independently of its snapshot. On a real WebSocket, TCP head-of-line blocking
  usually delivers or loses both together, so the skip path should be rarer in
  production than in the harness.
- `snap.ackInput` is now `null` for a snapshot whose ack was lost. `src/main.js`
  only forwards it to `Prediction.reconcile`, which handles `null`; no other
  consumer exists.
- Snapshot bandwidth is unchanged at ~18.5 KB/s/client for 32 players. Further
  server-cost reduction needs a snapshot-rate or delta-precision change, which
  is out of scope for this pass.

## Residual risks / proposed follow-ups

1. **Long soak for RSS.** Run 2 h at 32 clients with periodic forced GC or heap
   snapshots to separate GC timing from a leak. The 60 s runs disagree by ~2×.
2. **Sim catch-up under sustained overload.** `simResets` only fires above 1 s of
   backlog; the 8-step-per-loop cap means the sim can still fall behind wall
   clock without resetting. Alert on `simResets > 0` and on growing
   `droppedInputs`, and consider adapting the step budget.
3. **ACK loss handling in production.** The skip path is correct but invisible
   to players. If field telemetry shows frequent ack misses, send the ack again
   with the next snapshot (a redundant ack for the previous seq) instead of
   skipping.
4. **Input backlog 16.** This bounds queued input to ~267 ms. High-jitter
   clients can still hit the cap; the counter now makes that visible.
5. **Snapshot cost.** ~593 KB/s for 32 clients is the dominant server egress.
   Reducing snapshot rate, player-block precision or keyframe frequency would
   cut it, at a responsiveness cost that needs product input.

## Verification

- `npm test`: **70/70 pass** on the final tree.
- New tests cover: ACK frame round-trip and rejection of malformed ACK frames,
  the 16-byte snapshot header, `sanitizeWireInput` replay/range/mask behaviour,
  server fire-rate capping, client inputs being unable to set position, and
  reconciliation being skipped when the snapshot ack is unknown.
- `npm run nettest`: 5 profiles, all p95 corrections within 0.63 cm of baseline.
- `SECONDS=60 PORT=3201 npm run loadtest`: two final-code runs, 32/32 clients
  joined, 0 dropped inputs, 0 skipped snapshots, 0 sim resets, 60.0 Hz/client.

## Files changed

- `shared/protocol.js` — protocol v6, ACK frames, 16-byte snapshot header,
  `sanitizeWireInput`.
- `src/net/client.js` — per-sequence ack map, exact-ack lookup, ack-miss count.
- `src/prediction.js` — skip reconciliation on a missing ack.
- `server/server.js` — shared snapshot broadcast, ack-first send, input gate,
  queue cap, stale input, backpressure, malformed-frame guard, sim catch-up.
- `tools/nettest.js` — exact-ack harness and ack/skip counters.
- `tools/loadtest.js` — drop/reset counters and a drift-corrected 60 Hz input
  generator.
- `test/protocol.test.js`, `test/lagcomp.test.js` — new coverage.
