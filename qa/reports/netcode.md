# Network integration evidence — protocol 6

Updated 2026-11-04. Original agent commits `0f788a4`, `331fed1`, `d4ee71f`
are preserved. The controller completed the interrupted corrections in the same
worktree after all four resumed Big Pickle sessions again hit provider quota.
Historical handoff prose is retained in Git; the measurements below supersede its
mislabelled EMA maxima and its unvalidated missing-baseline behavior.

## Contracts and corrections

- 9-byte ACK identifies the exact u16 snapshot sequence (stored in a u32 wire
  field). One shared 16-byte-header snapshot buffer per room update; input is32B.
- Welcome/connect clears cache, interpolation, ACK and sequence state. Stale
  callbacks from replaced sockets cannot close/contaminate the new connection.
- A delta only applies to its exact preceding baseline. Missing baselines trigger
  throttled keyframe recovery; stale/duplicate snapshots are discarded, including
  wraparound cases. Missing exact ACK skips reconciliation; it is never guessed.
- Explicit protocol mismatch rejection occurs before a room/player is allocated.
  Truncated/non-finite snapshots return null instead of throwing.
- Server input backlog is bounded to16; stale held input is neutralized after250ms.
  The load generator retains at most one pending input timer per client.
- Net emulation now uses the production `NetClient`, not a second ACK/delta
  implementation. FIFO queues guarantee relay order. The first controller relay
  used independent timers and exposed unintended sub-ms reordering even without
  loss; `net-matrix-controller.log` is superseded by `net-matrix-ordered.log`.
- `/stats` distinguishes raw600-tick-window percentiles, lifetime raw maximum,
  over-budget count and sampled EMA. Binary payload labels use KiB/MiB.

## Observed profile results

Command: `NET_SERVER_PORT=3310 NET_PROXY_PORT=3311 node tools/nettest.js`.
12 seconds/profile; seeded message schedules24301–24305. One-way delays below;
measured RTT is roughly twice that delay. Raw log: `qa/reports/net-matrix-ordered.log`.

| One-way profile | Received / applied snapshots Hz | RTT p50 ms | Correction p95 / max cm | Max applied gap ms | Missing-base deltas |
|---|---:|---:|---:|---:|---:|
| Local, no loss |30.4 /30.4|3.0|2.00 /8.00|37.4|0|
|50ms ±5ms,5% loss|28.9 /25.4|107.6|12.28 /25.63|234.6|42|
|150ms ±15ms,5% loss|28.7 /21.8|311.6|12.11 /25.00|413.7|83|
|300ms ±30ms, no loss|30.0 /30.0|626.6|1.84 /2.23|85.2|0|
|300ms ±30ms,5% loss|28.5 /20.2|606.8|12.34 /13.21|760.3|100|

No-loss profiles assert zero ACK misses and zero missing baselines. Loss profiles
recover correctly but visibly lose update cadence while waiting for a keyframe;
the760ms gap is a remaining quality limitation under this synthetic extreme,
not a smooth-WAN claim. Input scheduling measured59.91–59.92Hz.

##32-client,60-second load

Command: `PORT=3320 PLAYERS=32 SECONDS=60 node tools/loadtest.js`.
Seed24301, local isolated server, BOTS=0, BR starter pistols with semi-auto pulses.
Raw log: `qa/reports/load-controller.log`.

-32/32 joined;60.0 inputs/s/client; zero input drops, skipped snapshots or sim resets.
- Raw measured tick mean0.769ms; last600 ticks p95=1.793ms, p99=2.654ms;
  room-lifetime raw max13.419ms; zero measured ticks over16.67ms.
- Snapshot+ACK mean592.3KiB/s across room. Client-observed all-binary payload
 24.09KiB/s/client, including events/loot; JSON/transport overhead excluded.
- Maximum pending input timers32. This confirms bounded ownership for this run.
- Server RSS100.4→177.7MiB; heap22.3→53.6MiB, range22.3–63.7MiB.
  GC sawtooth and growth remain a soak question; this60-second run does not prove
  a plateau or leak freedom. A route fixture ran briefly on the shared host.

## Verification scope

Current controller worktree: `npm test` **77/77 pass**, including the real-server
protocol handshake. `git diff --check` passes.

The lifecycle regression suite covers reset, lost delta/full recovery, exact ACK,
u16 wrap, replaced socket callbacks, wire mismatch, malformed snapshots and input
backlog/staleness. A real local WebSocket handshake checks rejection before room
allocation. Combined-master unit/build/browser/load/stress results are recorded
by the controller after merging.

These are application-message impairment tests over loopback TCP. They do not
model packet retransmission/head-of-line blocking, real WAN peers or a VPS. A
full16+player WAN match and long memory soak remain separate acceptance gates.
