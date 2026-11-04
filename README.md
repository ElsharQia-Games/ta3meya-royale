# FRONTLINE / BLACKSHORE

An original browser tactical shooter with an authoritative Node/WebSocket
server, a1km² coastal battlefield, Battle Royale, Team Deathmatch and local
training. Blackshore's interface, equipment/animation contracts and asset pipeline
are the foundation for subsequent development; see [DESIGN.md](DESIGN.md).

## Run

Node20+ and a WebGL2 browser with keyboard/mouse:

```sh
npm install
npm run build
npm start
```

Open **http://localhost:3000**. Select a mode, enter a callsign/room, and deploy.
Friends use the same server URL and room code. **Enter Training** runs the shared
simulation and bots in the browser. Graphics quality is adjustable in Settings.

The server defaults to localhost. Options: `HOST`, `PORT`, `BOTS`, `MAX_PLAYERS`.
For LAN hosting: `HOST=0.0.0.0 npm start`.

## Internet play

Start the tunnel yourself after starting the local server:

```sh
cloudflared tunnel --url http://localhost:3000
```

[Install cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
if needed. Open its HTTPS URL and use the invite arrow beside the room field to
copy the room/mode link. WebSocket uses the same origin. A stable named tunnel
or HTTPS reverse proxy can front a persistent Node host in the same way.

Room codes select matches; the game has no account/matchmaking service. A
connection token supports reconnecting within the running page. A full16+player
WAN match and target-GPU performance are still open validation gates.

## Controls

| Input | Action |
|---|---|
| WASD / arrows | Move; W/S throttle/brake/reverse and A/D steer while driving |
| Shift | Sprint |
| Space | Jump; vehicle brake |
| C / X / V | Crouch / prone / stand |
| Left / right mouse | Fire / aim |
| R | Reload |
|1 /2 / Q| Equip slots / cycle weapon |
| G / T | Frag / smoke |
| F | Bandage or medkit |
| E | Nearest usable pickup / vehicle entry / exit |
| Tab | Scoreboard |
| Enter | Chat |
| Escape | Mouse release / settings |

Drivers use the steering wheel; passengers can use weapons. Vehicle HUD shows
speed, seats, hull health and controls. Bandages cap health at75; medkits at100.
Damage and weapon switches interrupt healing. Picking up an owned weapon class
supplies spare ammunition. Smoke affects bot vision and obscures nameplates.

## Modes

- **Battle Royale:** up to32 players, loot, shrinking perimeter and last survivor.
  Default24 bots fill an online room.
- **Team Deathmatch:** up to24 players, Vanguard/Legion teams,4-second respawns,
 60-point or10-minute limit. Default16 bots online.
- Humans replace bots when a room fills. Rounds use an automatic warmup and restart
  flow. Training uses a smaller local bot population.

## Systems

- Shared fixed60Hz movement, step/slope/headroom handling, jump buffering/coyote
  time, swimming and fall damage. Repeatability is tested in Node; sharing JS is
  not proof of cross-browser bitwise determinism.
- Seven weapon classes, gravity/drag/penetration ballistic solving, scheduled
  travel-time damage, armour, head/torso/leg zones and capped server rewind.
- Protocol6:32-byte inputs,30Hz delta snapshots, exact snapshot-keyed ACKs,
  missing-baseline recovery, prediction/reconciliation, remote interpolation,
  connection lifecycle guards and bounded input queues.
- Navigable buildings, deterministic loot placement, destructible cover and
  state recovery for late join/restart. Bots use coarse outdoor and fine indoor
  navigation grids.
- Car/truck hull collisions, four-contact suspension, signed steering/reverse,
  braking, seats, clear exits, flood cutoff and ballistic/blast/impact damage.
  Handling remains a constrained arcade model rather than full rigid-body physics.
- Original equipment with named sights/muzzles/grips, two-bone arm IK, reload/
  pump/bolt/feed-cover poses, articulated characters and steering hands.
- Local CC0 terrain/nature assets, OFL fonts, generated IBL, CSM, sky/fog/water,
  pooled tracers/particles/decals and procedural stereo spatial audio.

## Validation

```sh
npm test
npm run stress
npm run nettest
npm run loadtest
```

Browser scripts need a running server and installed Playwright Chromium (or
`CHROMIUM_PATH`). Set `QA_URL` to your server; `QA_OUT` selects an evidence folder.

```sh
QA_URL=http://127.0.0.1:3000/ npm run qa:journeys
QA_URL=http://127.0.0.1:3000/ npm run qa:vehicle
QA_URL=http://127.0.0.1:3000/ npm run qa:arsenal
QA_URL=http://127.0.0.1:3000/ npm run qa:scenes
QA_URL=http://127.0.0.1:3000/ npm run qa:multiplayer
QA_URL=http://127.0.0.1:3000/ npm run qa:record
```

Screenshots/manifests are in `qa/shots/`; clips in `qa/clip/`. Fixtures are labelled.
The record script uses real-time input but software rasterisation can slow the
simulation clock; it records both clocks/frame times. Video is silent, with
audio-engine level measurements stored separately. SwiftShader FPS is not a
hardware-GPU benchmark.

## Project map / evidence

- `shared/`: configuration, world, physics, weapons, vehicles, visibility, wire codec.
- `server/`: authoritative rooms/network loop and bot navigation.
- `src/`: client/prediction, rendering, UI, input and procedural audio.
- `public/`: shipped assets and license notices. Asset import is optional Python;
  the game/build does not require it.
- [PLAN.md](PLAN.md), [PROGRESS.md](PROGRESS.md): scope and current status.
- [DESIGN.md](DESIGN.md), [DECISIONS.md](DECISIONS.md): design/engineering contracts.
- [ASSETS.md](ASSETS.md), [RESEARCH.md](RESEARCH.md), [REFERENCE.md](REFERENCE.md): provenance and reference evidence.
- [GAP-ANALYSIS.md](GAP-ANALYSIS.md), `qa/reports/`: measured results and open gates.
