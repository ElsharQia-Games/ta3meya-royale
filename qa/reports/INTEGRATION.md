# Integration and direct visual review

Updated 2026-11-04. Renderer/client groundwork merged into `master` at `a3ca041`;
the Blackshore foundation follows that merge. Acceptance remains open.

## Existing sessions and ownership

| Session | Worktree / branch | Current handoff |
|---|---|---|
| `ses_e5bae678dffeRgNbTB4vQ8kXQT` | `.worktrees/net` / `agent/net` | Resumed original Big Pickle session for ACK/continuity/timer/protocol/metric corrections |
| `ses_e5bae678cffdqo3wG66w3GOibU` | `.worktrees/sim` / `agent/sim` | Resumed with saved controller hybrid-nav changes; last route fixture 17/18 |
| `ses_e5bae678cffen92zXaGvC4HMOR` | `.worktrees/render` / `agent/render` | Groundwork `b8a71e3` merged; next: scenery/asset/performance refinement |
| `ses_e5bae678cffcwx4bTDiE2utGaU` | `.worktrees/client` / `agent/client` | Groundwork `f486a67` merged; next: full player-journey QA and UX corrections |

No replacement agent sessions are needed. The controller continues local fixes
in stopped worktrees and records them as controller work. Do not overwrite saved
changes or attribute controller verification to an agent.

## Blackshore controller checkpoint

- Current source builds (772.92 kB JS / 215.53 kB gzip), **66/66 tests pass**.
- `qa/shots/blackshore-pass3/`: seven 1920×1080 screenshots, zero browser errors.
  Controller directly read deployment, hip, ADS and reload. Current defects:
  stylized/sparse scenery, plain equipment surfaces, support hand low in reload.
- Pass3 SwiftShader: 319 deployment calls / 1.82M triangles; 375–380 carbine
  calls / 1.81M triangles. Actual software frame rate approximately0.5–1.9fps.
  CPU contention and software rasterization prevent hardware conclusions.
- User explicitly requests all-player-journey validation, especially vehicle
  entry/driving/exit. Track observable behavior and gaps in a dedicated report.
- Asset reuse authorized. Poly Haven terrain maps are local CC0 conversions.
  Quaternius Standard archive downloaded; included CC0 notice read directly.

## Reviewed evidence and confirmed findings

- Independently ran `npm test` in `.worktrees/net`: **70 pass, 0 fail** at the
  completed handoff. Read the agent's final net/load raw outputs. This establishes
  the tested subset, not all connection/failure paths.
- Reproduced stale ACK across a new welcome: ACK(seq=0,input=99), old snapshot0,
  new welcome, new snapshot0 with no ACK still yields `ackInput=99`. Expected
  unknown/null until an ACK from the new connection is available.
- `tools/loadtest.js` retains every expired recursive timeout in `timers`.
  Timer ownership must be bounded before long-soak results are useful.
- Client/nettest delta application lacks a `baseSeq` continuity check. Missing
  baselines must recover from a keyframe instead of publishing a partial cache.
- Protocol-version rejection and unambiguous metric labels need verification.
  The load report's maximum is a maximum of sampled tick EMAs, not raw max tick.
- Independently demonstrated all three original bot fixture seeds created
  `World.seed=20261104`: `Game.seed` is the gameplay RNG, not the map seed.
- After the saved fixture correction to `mapSeed`, ran
  `node --test test/bots.test.js`: **16/18 routes**, one test failure. Seed
  `63162945`, building9 enters but never reaches its interior objective; seed
  `1356337147`, building45 reaches its objective but fails to exit. Keep these
  cases rather than selecting easier seeds.
- NavGrid construction occurs in `spawnBots` before stress tick timing. The
  reported 237.601ms max cannot be attributed to lazy grid construction without
  further evidence. Profile and report over-budget tick count/index.

## Visual baseline observations

Read actual images `qa/shots/10-vista.png`, `11-character.png`, `14-ads.png`.
Image input is available to the controller; the historical statement that only
numeric analysis was possible does not apply to this review.

1. Vista foreground prop loses detail in shade; vegetation repeats simple cone
   silhouettes and ground lacks local detail. Atmospheric depth alone does not
   close the asset/level-art gap.
2. The mannequin image reads as a rear view. Verify that fixture simulation
   does not overwrite the assigned yaw while posing front/back captures.
3. ADS has an oversized dark central weapon shape; inspect sight alignment and
   sight-picture obstruction for each weapon rather than only camera FOV.
4. Countdown text overlaps the large world-space nameplate. Check HUD priority,
   nameplate scale and occlusion in real gameplay and controlled fixtures.
5. Frozen screenshots cannot establish gait, reload contacts, recoil recovery,
   effect timing or temporal stability. A recorded gameplay clip remains required.

Public reference stills were fetched and inspected directly; see `REFERENCE.md`
for exact sources, observations and copyright boundaries.

## Integration gates still to run

- Reviewed commits merged into master with shared protocol/world contracts intact.
- Combined unit tests and production build.
- Online/offline/multiplayer browser assertions and screenshot matrix at1080p.
- Direct review/fix/recapture loop with a manifest tied to the final source revision.
- Actual gameplay clip with duration/resolution/frame metadata and inspected frames.
- Combined30-sim-minute stress, latency matrix and32-client load with corrected
  labels and failure counters.
- Hardware1080p60fps, full16+player WAN match and deployment-class VPS checks:
  unverified. Loopback and SwiftShader results cannot close these acceptance gates.
