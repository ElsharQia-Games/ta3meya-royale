# Frontline

A browser-based, server-authoritative multiplayer tactical shooter. One Node
process serves the Three.js client and runs the 60 Hz simulation over
WebSocket. Friends join with a link and a room code.

> **Scope, honestly:** this is a from-scratch, procedural-asset game built to a
> high engineering bar, not a clone of PUBG/Battlefield/The Finals. It has the
> systems (deterministic movement, ballistics, netcode, destruction, vehicles,
> bots, BR/TDM) but not the art, animation or content volume of a commercial
> title. See [GAP-ANALYSIS.md](GAP-ANALYSIS.md) for the measured, per-system
> gap.

## Run it

Requirements: Node.js 20+ (developed and measured on Node 24), npm, a
WebGL2 browser.

```bash
npm install
npm run build
npm start
```

Open <http://localhost:3000>. Choose a callsign and a room code, then
**DEPLOY**. Anyone who opens the same URL with the same room code joins the
same match. **OFFLINE TRAINING** runs the identical simulation and bot AI in
the tab without a server.

- LAN: `HOST=0.0.0.0 npm start`, then `http://<your-ip>:3000`.
- Internet: keep the server on localhost and start a Cloudflare Tunnel (below).
- Server options: `PORT`, `HOST`, `MAX_PLAYERS`, `BOTS` (bot count override).

## Share with friends over the internet

The server binds to `127.0.0.1` by default and is **not** exposed by the build
or by any script in this repo. You start the tunnel yourself:

```bash
# terminal 1
npm run build && npm start

# terminal 2 (install cloudflared first: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
cloudflared tunnel --url http://localhost:3000
```

`cloudflared` prints an `https://…trycloudflare.com` URL. Open it, enter a room
code, then share the URL with `?room=CODE` appended (the lobby also has a
**COPY INVITE LINK** button). WebSocket upgrades work through the quick tunnel,
so no extra configuration is needed.

A named tunnel with a stable hostname is the same idea: create the tunnel,
point its ingress at `http://localhost:3000`, route DNS, and run it.

**Security note:** there is no account system. Anyone with the URL and room
code can join. Use an unguessable room code for private games. Do not put
secrets in the room code or callsign.

## Controls

| Input | Action |
|---|---|
| WASD / arrows | Move |
| Shift | Sprint |
| Space | Jump |
| C / X / V | Crouch / prone / stand |
| Left mouse | Fire |
| Right mouse | Aim down sights |
| R | Reload |
| G / T | Frag / smoke grenade |
| F | Use bandage or medkit |
| E | Pick up / enter or exit vehicle |
| Q / 1 / 2 | Cycle weapon / slot 1 / slot 2 |
| Tab | Scoreboard |
| Enter | Chat (team chat in TDM) |
| Esc | Release mouse / settings |

## Modes

- **Battle Royale** — 1 km² island, loot, shrinking zone, last player standing.
  Default 24 bots fill the room.
- **Team Deathmatch** — Vanguard vs Legion, respawns, first team to 60 kills or
  the 10-minute limit (up to 24 players).

Rooms are created on demand by code. Humans can join a room that already has
bots; bots are server-owned and use the same input shape as network players.

## What is in the box

- **Deterministic movement.** Shared `shared/physics.js` runs identically on
  client and server at a fixed 60 Hz: kinematic capsule, slopes, steps,
  crouch/prone, jump buffering/coyote time, swimming, fall damage.
- **Ballistics.** Muzzle velocity, gravity, quadratic drag, travel-time damage,
  penetration through materials, falloff, hit zones (head/neck/torso/legs),
  armour. Six weapon classes plus a DMR, with recoil, spread, ADS, sway.
- **Netcode.** Binary inputs/snapshots, client prediction and replay
  reconciliation, entity interpolation, 30 Hz delta snapshots with periodic
  keyframes, interest-filtered events, lag-compensated hitboxes, reconnect with
  session tokens, server-side validation.
- **World.** Procedural 1 km² terrain with towns, interiors, forests, hills,
  lake, roads, cover, destructible props, loot, raycast-suspension vehicles.
- **Presentation.** CSM shadows, sky, fog, bloom, tracers, decals, muzzle
  flashes, particles, explosions, first-person weapon viewmodels, procedural
  character animation, spatial WebAudio, full HUD/minimap/compass/kill feed.

## Repository map

```
shared/        simulation shared by client and server
  config.js      all tuning (weapons, map, net, bots, vehicles)
  math.js        deterministic math + quantisation
  world.js       procedural map generation and spatial queries
  physics.js     capsule controller and collision
  weapons.js     weapon behaviour helpers
  sim.js         authoritative Game/Player/Vehicle simulation
  protocol.js    binary wire format + snapshot delta codec
server/
  server.js      HTTP static host, rooms, 60 Hz loop, netcode, anti-cheat
  bots.js        nav grid, A* and bot brains
src/           browser client
  main.js        lobby, online/offline loops, camera, event routing
  prediction.js  prediction/reconciliation + interpolation buffer
  net/client.js  WebSocket client, RTT, snapshot cache
  render/        renderer, world, characters, effects, viewmodel, textures
  ui/hud.js      DOM HUD and overlays
  audio/audio.js procedural spatial audio
test/          64 unit/integration tests (node --test)
tools/         stress, netcode and load-test harnesses
qa/            Playwright screenshot/audit scripts
```

## Verification

```bash
npm test              # 64 tests: math, world, physics, weapons, sim, protocol, lag comp
npm run stress        # 32 players × 30 simulated minutes, invariants
npm run nettest       # message-level latency/jitter/loss matrix
npm run loadtest      # 32 real WebSocket clients against a private server
```

Browser QA needs a server on `:3000`:

```bash
npm start             # in another terminal
npm run qa            # online screenshots + console errors + FPS
npm run qa:offline    # training mode, no server needed
npm run qa:visual     # offline vista/character/viewmodel shots
npm run qa:multiplayer
```

Screenshots land in `qa/shots/`. Headless Chromium uses SwiftShader (software
GL), so its FPS is **not** a hardware performance measurement; the measured
numbers and their caveats are in [GAP-ANALYSIS.md](GAP-ANALYSIS.md).

## Documentation

- [PLAN.md](PLAN.md) — milestones and acceptance criteria
- [RESEARCH.md](RESEARCH.md) — sources and what was taken from them
- [DECISIONS.md](DECISIONS.md) — architecture decisions and rejected options
- [REFERENCE.md](REFERENCE.md) — the quality bar and how it is judged
- [ASSETS.md](ASSETS.md) — asset provenance (all procedural, no external art)
- [PROGRESS.md](PROGRESS.md) — current state, known bugs, next steps
- [GAP-ANALYSIS.md](GAP-ANALYSIS.md) — honest comparison with the reference bar
