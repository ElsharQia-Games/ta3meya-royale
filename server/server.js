// Authoritative server: 30 Hz tick, lag rewind, anti-cheat, bots, vehicle spawn.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Game } from '../shared/sim.js';
import { CFG } from '../shared/config.js';
import { decodeInput, buttonsToInput } from '../shared/net.js';

const PORT = process.env.PORT || 3000;
const http = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Crouton Alpha server OK — connect via ws'); });
const wss = new WebSocketServer({ server: http, path: '/' });

const rooms = new Map(); // code -> Game

function getRoom(code, mode) {
  if (!rooms.has(code)) {
    const g = new Game(); g.mode = mode; rooms.set(code, g);
    // spawn vehicles: 3 cars spread on the map
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.7;
      g.addVehicle(Math.cos(a) * 140, Math.sin(a) * 140);
    }
  }
  return rooms.get(code);
}

const clients = new Map(); // ws -> {room, playerId, game, lastInputAt}
const inputs = new Map();  // playerId -> latest input
const histories = new Map(); // game -> [{tick, snap}]
const HIST_MAX = 600; // 20s at 30 Hz covers even 300ms rtt x2 rewound

function historyFor(game) {
  if (!histories.has(game)) histories.set(game, []);
  return histories.get(game);
}

function spawnBots(game, n) {
  for (let i = 0; i < n; i++) {
    const a = game.rng() * Math.PI * 2, r = 40 + game.rng() * 200;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const p = game.addPlayer('Bot-' + (i + 1), x, z, 0);
    p.bot = true;
    p.botState = { yaw: game.rng() * 6.28, shootT: 0, strafeDir: 1, think: game.rng() * 60 };
  }
}
function botInput(game, p, dt) {
  const s = p.botState; s.think -= dt * 60;
  if (s.think <= 0) {
    s.think = 20 + game.rng() * 40;
    let best = null, bd = 1e9;
    for (const q of game.players.values()) if (q.alive && q.id !== p.id) { const d = Math.hypot(q.pos[0] - p.pos[0], q.pos[2] - p.pos[2]); if (d < bd) { bd = d; best = q; } }
    s.target = best; s.dist = bd;
    s.strafeDir = game.rng() > 0.5 ? 1 : -1;
    s.wantShoot = !!best && bd < 55 && game.rng() > 0.3;
  }
  const t = s.target;
  const input = { f: false, b: false, l: false, r: false, jump: false, sprint: true, ads: false, shoot: false, yaw: s.yaw, pitch: 0, reload: false, grenade: false, heal: false, switch: -1, stance: null };
  if (t && t.alive) {
    s.yaw = Math.atan2(-(t.pos[0] - p.pos[0]), -(t.pos[2] - p.pos[2]));
    const d = Math.hypot(t.pos[0] - p.pos[0], t.pos[2] - p.pos[2]);
    if (d > 18) input.f = true; else if (d < 8) input.b = true;
    if (s.strafeDir > 0) input.r = true; else input.l = true;
    if (d < 60 && s.wantShoot) input.shoot = true;
    input.pitch = Math.max(-0.2, Math.min(0.2, ((t.pos[1] + 1.2) - (p.pos[1] + 1.4)) / Math.max(5, d)));
    if (p.inv[p.weapons[p.curW]].mag === 0) input.reload = true;
    if (p.health < 35 && p.med > 0) input.heal = true;
  }
  return input;
}

// Rewind target figure: given the shooter's claimed input time (client clock
// in seconds ~= game seconds at connect), find the history snapshot whose
// game time was closest to that. Client clocks differ slightly, so we only
// trust relative ordering: clamp to the last 20s of history.
function rewindFrac(input, game) {
  const hist = historyFor(game);
  if (!hist.length) return null;
  const claimed = input.yawTime ?? null;
  if (claimed === null || !isFinite(claimed)) return null;
  let best = hist[0], bd = Math.abs(hist[0].time - claimed);
  for (const h of hist) { const d = Math.abs(h.time - claimed); if (d < bd) { bd = d; best = h; } }
  // only rewind if claimed is within recent window (avoid stale/cheat claims)
  if (bd > 2.5) return null;
  return best;
}

// Fire a rewound shot: temporarily restore the shooter's recorded position
// (all players at that snapshot), run ONE step with a ray-only hook that
// resolves the hit, then restore the live state. The hook reuses fireHitscan
// against the rewound positions so hit registration matches what the shooter saw.
function fireRewound(game, shooter, input, dt, histSnap) {
  if (!histSnap) { game.fireHitscan(shooter, game.eyePos(shooter), game.viewDir(shooter), shooter.weapons[shooter.curW], game.time); return; }
  const saved = game.saveState();
  game.restoreState(histSnap.state);
  game.onShoot = (sh, inp, d) => {
    game.fireHitscan(sh, game.eyePos(sh), game.viewDir(sh), sh.weapons[sh.curW], game.time);
  };
  game.step(new Map([[shooter.id, input]]), dt);
  const evs = game.events.splice(0);
  // merge rewound events into live event stream (they report hits/kills)
  game.events.push(...evs);
  game.restoreState(saved);
  // Note: destructible changes made during rewound step are discarded;
  // the next live step re-applies them if the player keeps shooting.
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'join') {
        const roomCode = (msg.room || 'ALPHA01').toUpperCase();
        const game = getRoom(roomCode, msg.mode || 'br');
        const a = game.rng() * Math.PI * 2, r = 20 + game.rng() * 120;
        const p = game.addPlayer(msg.name || 'Soldier', Math.cos(a) * r, Math.sin(a) * r, game.mode === 'tdm' ? (game.players.size % 2) : 0);
        clients.set(ws, { room: roomCode, playerId: p.id, game });
        ws.send(JSON.stringify({ type: 'welcome', playerId: p.id, tick: game.tick, mapSeed: 20261104 }));
        if (game.players.size <= 3) spawnBots(game, CFG.BOT_COUNT - game.players.size + 1);
      } else if (msg.type === 'input') {
        const c = clients.get(ws); if (!c) return;
        const raw = decodeInput(msg.buf);
        // ANTI-CHEAT: rate limit + finite sanity + teleports rejected by sim bounds
        const now = Date.now();
        c.lastInputAt = c.lastInputAt || 0;
        if (now - c.lastInputAt < 10) return;
        c.lastInputAt = now;
        if (!isFinite(raw.yaw) || !isFinite(raw.pitch)) return;
        if (Math.abs(raw.yaw) > 1e6 || Math.abs(raw.pitch) > 100) return;
        const inp = buttonsToInput(raw.buttons, msg.extra || {});
        inp.yaw = raw.yaw; inp.pitch = raw.pitch;
        inp.yawTime = raw.atTime; // client claimed time for rewind
        // validate vehicle id if requested
        if (inp.enterVehicle !== undefined && inp.enterVehicle !== -1) {
          const v = c.game.vehicles.find(vv => vv.id === inp.enterVehicle);
          if (!v) inp.enterVehicle = -1;
        }
        inputs.set(c.playerId, inp);
      }
    } catch (e) { /* ignore malformed */ }
  });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// ---- 30 Hz authoritative loop ----
const TICK_MS = 1000 / CFG.TICK_HZ;
let last = Date.now();
setInterval(() => {
  const now = Date.now(); const dt = Math.max(0, (now - last) / 1000); last = now;
  for (const game of rooms.values()) {
    const stepInputs = new Map();
    for (const [ws, c] of clients) {
      if (c.game !== game) continue;
      const inp = inputs.get(c.playerId);
      if (inp) { stepInputs.set(c.playerId, inp); inputs.delete(c.playerId); }
    }
    for (const p of game.players.values()) if (p.bot && p.alive) stepInputs.set(p.id, botInput(game, p, dt));

    const hist = historyFor(game);

    // Rewound-fire handling: if a human player wants to shoot, consume that
    // shot at the rewound time instead of the current position step.
    const shooters = [...stepInputs.entries()].filter(([id, inp]) => inp.shoot && !game.players.get(id)?.bot);
    for (const [id, inp] of shooters) {
      const shooter = game.players.get(id);
      if (!shooter || !shooter.alive) continue;
      inp.shoot = false; // rewound step hides this flag; cooldown inside prevents double fire
      const histSnap = rewindFrac(inp, game);
      // run the rewound shot as its own micro-step
      fireRewound(game, shooter, inp, CFG.SIM_DT, histSnap);
      // cooldown prevents double-fire in the same tick
    }

    game.step(stepInputs, CFG.SIM_DT);
    const snap = game.pack();

    hist.push({ tick: game.tick, time: game.time, state: game.saveState() });
    if (hist.length > HIST_MAX) hist.shift();

    const ev = game.events.splice(0);
    for (const [ws, c] of clients) {
      if (c.game !== game) continue;
      try {
        ws.send(JSON.stringify({ type: 'snap', snap }));
        if (ev.length) ws.send(JSON.stringify({ type: 'events', events: ev }));
      } catch {}
    }
  }
}, TICK_MS);

http.listen(PORT, () => console.log(`[server] Crouton Alpha on :${PORT} (30 Hz authoritative)`));
