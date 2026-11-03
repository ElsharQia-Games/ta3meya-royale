// Client: Three.js renderer + client-side prediction + reconciliation +
// entity interpolation + vehicle rendering + weapon view model + HUD.
import * as THREE from 'three';
import { Game } from '../shared/sim.js';
import { CFG } from '../shared/config.js';
import { encodeInput, BTN } from '../shared/net.js';

const $ = id => document.getElementById(id);
let game, renderer, scene, camera, ws, myId = null;
let playerMeshes = new Map(), vehicleMeshes = new Map(), interp = new Map();
let keys = {}, yaw = 0, pitch = 0, seq = 0;
let audioCtx = null, offline = false;
let shake = 0;
const tracers = [], particles = [], chunkDebris = [];

// ---- prediction ----
let predicted = null;        // local predicted Game (client-side)
let inputHistory = [];       // {seq, input, tick} un-acked inputs
let serverTick = 0;
let pendingLocalInput = null, inputsOffline = new Map();

queueMicrotask(() => init().catch(e => { console.error(e); $('err').textContent = e.message; }));

async function init() {
  $('join').onclick = joinOnline;
  $('battest').onclick = startOffline;
  buildWorld();
  addEventListener('keydown', e => { keys[e.code] = true;
    if (e.code === 'Tab') { e.preventDefault(); showScore(true); }
    if (e.code === 'Digit1') extra.switch = 0; if (e.code === 'Digit2') extra.switch = 1; if (e.code === 'Digit3') extra.switch = 2;
    if (e.code === 'KeyR') extra.reload = true; if (e.code === 'KeyG') extra.grenade = true; if (e.code === 'KeyF') extra.heal = true;
    if (e.code === 'KeyC') extra.stance = 'crouch'; if (e.code === 'KeyX') extra.stance = 'prone'; if (e.code === 'KeyV') extra.stance = 'stand';
    if (e.code === 'KeyE') {
      // enter nearest vehicle or exit current
      const me = predicted?.players.get(myId);
      if (me?.inVehicle) extra.enterVehicle = -1;
      else if (predicted) {
        let best = null, bd = 4;
        for (const v of predicted.vehicles) {
          const d = Math.hypot(v.pos[0] - me.pos[0], v.pos[2] - me.pos[2]);
          if (d < bd) { bd = d; best = v; }
        }
        if (best) extra.enterVehicle = best.id;
      }
    }
  });
  addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'Tab') showScore(false); });
  document.addEventListener('mousemove', e => {
    if (!document.pointerLockElement) return;
    yaw -= e.movementX * 0.0022; pitch -= e.movementY * 0.0022;
    pitch = Math.max(-1.5, Math.min(1.5, pitch));
  });
  document.addEventListener('click', () => {
    if ($('lobby').style.display === 'none' && !document.pointerLockElement) renderer.domElement.requestPointerLock();
  });
  function showScore(s) { $('scoreboard').style.display = s ? 'block' : 'none'; if (s) renderScore(); }
}

let viewGun = null;
let extra = { reload: false, grenade: false, heal: false, switch: -1, stance: null, enterVehicle: undefined };

function buildWorld() {
  game = new Game();
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x8fa8c8, 60, 500);
  camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 2000);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  $('app').appendChild(renderer.domElement);

  const sky = new THREE.Color(0x8fc3e8);
  renderer.setClearColor(sky);
  const hemi = new THREE.HemisphereLight(0xbcd7ff, 0x4a5a3a, 0.7); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d6, 1.6);
  sun.position.set(120, 180, 60); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -260; sun.shadow.camera.right = 260; sun.shadow.camera.top = 260; sun.shadow.camera.bottom = -260;
  sun.shadow.camera.far = 600; scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 0.15));

  const W = game.world, N = W.gridN, S = CFG.MAP_SIZE;
  const geo = new THREE.PlaneGeometry(S, S, N - 1, N - 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, W.terrainH(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x5a7a48, roughness: 1 }));
  ground.receiveShadow = true; scene.add(ground);

  const water = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshStandardMaterial({ color: 0x2e6ea6, transparent: true, opacity: 0.75, roughness: 0.2, metalness: 0.3 }));
  water.rotation.x = -Math.PI / 2; water.position.y = CFG.WATER.level; scene.add(water);

  buildInstances(W);
  const ringGeo = new THREE.RingGeometry(0.98, 1, 64);
  window.zoneRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x55aaff, side: THREE.DoubleSide, transparent: true, opacity: 0.6 }));
  zoneRing.rotation.x = -Math.PI / 2; scene.add(zoneRing);

  // ---- view model weapon (first person) ----
  viewGun = new THREE.Group();
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.55), new THREE.MeshStandardMaterial({ color: 0x1c1e24, roughness: 0.5, metalness: 0.6 }));
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.34), new THREE.MeshStandardMaterial({ color: 0x2b2e36, roughness: 0.4, metalness: 0.4 }));
  body.position.set(0, -0.02, -0.12);
  barrel.position.set(0, 0.02, -0.4);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.02), new THREE.MeshStandardMaterial({ color: 0x111111 }));
  sight.position.set(0, 0.1, -0.25);
  viewGun.add(body, barrel, sight);
  viewGun.position.set(0.22, -0.22, -0.5);
  camera.near = 0.05; camera.updateProjectionMatrix();
  camera.add(viewGun); scene.add(camera);

  // ---- vehicle appearances (created from server snapshots) ----
  loop();
  // debug handle for QA scripts
  window.__qa = { get game() { return game; }, get camera() { return camera; }, get scene() { return scene; }, get myId() { return myId; }, get interp() { return interp; }, get yaw() { return yaw; }, get pitch() { return pitch; } };
}

function buildInstances(W) {
  const addInst = (items, makeGeo, mat) => {
    if (!items.length) return;
    const im = new THREE.InstancedMesh(makeGeo(), mat, items.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    items.forEach((it, i) => { p.set(it.x, it.y, it.z); q.setFromEuler(new THREE.Euler(0, it.ry || 0, 0)); s.set(it.sx || 1, it.sy || 1, it.sz || 1); m4.compose(p, q, s); im.setMatrixAt(i, m4); });
    im.castShadow = true; im.receiveShadow = true; scene.add(im);
  };
  const trees = []; const rocks = []; const crates = []; const walls = []; const blds = [];
  for (const b of W.boxes) {
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
    if (b.tag === 'tree') trees.push({ x: cx, y: b.min[1], z: cz, sy: sy / 7, ry: Math.random() * 6 });
    if (b.tag === 'rock') rocks.push({ x: cx, y: b.min[1], z: cz, sx: sx / 2, sy: sy / 1.5, sz: sz / 2, ry: Math.random() * 6 });
    if (b.tag === 'crate') crates.push({ x: cx, y: b.min[1], z: cz, sx: sx / 1.2, sy: sy / 1.1, sz: sz / 1.2 });
    if (b.tag === 'wall') walls.push({ x: cx, y: b.min[1], z: cz, sx: sx / 4, sy: sy / 1.6, sz: sz / 4, ry: Math.atan2(sz, sx) });
    if (b.tag === 'building') blds.push({ x: cx, y: b.min[1], z: cz, sx: sx / 12, sy: sy / 6, sz: sz / 12 });
  }
  addInst(trees, () => new THREE.ConeGeometry(1.6, 7, 6), new THREE.MeshStandardMaterial({ color: 0x2f5d33, roughness: 1 }));
  addInst(rocks, () => new THREE.DodecahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0x7a7d82, roughness: 0.9 }));
  addInst(crates, () => new THREE.BoxGeometry(1.2, 1.1, 1.2), new THREE.MeshStandardMaterial({ color: 0xa8905a, roughness: 0.8 }));
  addInst(walls, () => new THREE.BoxGeometry(4, 1.6, 4), new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.9 }));
  addInst(blds, () => new THREE.BoxGeometry(12, 6, 12), new THREE.MeshStandardMaterial({ color: 0xb8a88e, roughness: 0.85 }));
}

function makeAvatar(name) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 0.4), new THREE.MeshStandardMaterial({ color: 0x3b4a5f, roughness: 0.7 }));
  body.position.y = 1.0; body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshStandardMaterial({ color: 0xd8b596 }));
  head.position.y = 1.72; head.castShadow = true;
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.8), new THREE.MeshStandardMaterial({ color: 0x222226 }));
  gun.position.set(0.3, 1.35, -0.4);
  if (name !== 'You') {
    const label = makeTextSprite(name);
    label.position.y = 2.2;
    g.add(label);
  }
  g.add(body, head, gun);
  scene.add(g);
  return g;
}
function makeVehicleMesh() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 4.2), new THREE.MeshStandardMaterial({ color: 0x8a2f2f, roughness: 0.35, metalness: 0.7 }));
  body.position.y = 0.6; body.castShadow = true;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.55, 2.0), new THREE.MeshStandardMaterial({ color: 0x1c2836, roughness: 0.15, metalness: 0.8 }));
  cabin.position.set(0, 1.1, -0.3);
  g.add(body, cabin);
  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 14);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.9 });
  for (const [x, z] of [[-0.95, 1.4], [0.95, 1.4], [-0.95, -1.4], [0.95, -1.4]]) {
    const w = new THREE.Mesh(wheelGeo, wheelMat); w.position.set(x, 0.42, z); g.add(w);
  }
  scene.add(g);
  return g;
}
function makeTextSprite(text) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const x = c.getContext('2d'); x.fillStyle = 'rgba(0,0,0,.45)'; x.fillRect(0, 0, 256, 64);
  x.fillStyle = '#fff'; x.font = 'bold 30px sans-serif'; x.textAlign = 'center'; x.fillText(text, 128, 42);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: true, depthWrite: false, transparent: true }));
  sp.scale.set(1.1, 0.27, 1);
  return sp;
}

async function joinOnline() {
  const name = $('name').value || 'Soldier', room = $('room').value || 'ALPHA01', mode = $('mode').value;
  try {
    ws = new WebSocket('ws://' + location.hostname + ':3000/');
    ws.binaryType = 'arraybuffer';
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(() => rej(new Error('server unreachable')), 4000); });
    ws.send(JSON.stringify({ type: 'join', name, room, mode }));
    ws.onmessage = e => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data);
        if (m.type === 'welcome') { myId = m.playerId; predicted = new Game(); predicted.mode = mode; predicted.addPlayer(name, 0, 0); enterGame(); }
        if (m.type === 'snap') onSnap(m.snap);
        if (m.type === 'events') onEvents(m.events);
      }
    };
    $('err').textContent = '';
  } catch (e) { $('err').textContent = 'Could not reach server on :3000 — try "training bots (offline)" or start server: node server/server.js'; }
}

function startOffline() {
  offline = true;
  myId = game.addPlayer('You', 0, 0).id;
  for (let i = 0; i < CFG.BOT_COUNT; i++) {
    const a = game.rng() * 6.28, r = 30 + game.rng() * 200;
    const p = game.addPlayer('Bot-' + (i + 1), Math.cos(a) * r, Math.sin(a) * r);
    p.bot = true; p.botState = { yaw: game.rng() * 6.28, target: null, think: game.rng() * 60, strafeDir: 1, wantShoot: false };
  }
  // offline predicted world == authoritative world (same object)
  predicted = game;
  enterGame();
}

function enterGame() {
  $('lobby').style.display = 'none';
  $('hud').style.display = 'block';
  renderer.domElement.requestPointerLock?.();
  initAudio();
  setInterval(sendInput, 1000 / 30);
}

function entryAndStep(entry) {
  const simInput = entryToSimInput(entry);
  const inputs = new Map();
  inputs.set(myId, simInput);
  for (const p of game.players.values()) {
    if (p.id === myId) continue;
    let best = null, bd = 1e9;
    for (const q of game.players.values()) if (q.alive && q.id !== p.id) { const d = Math.hypot(q.pos[0] - p.pos[0], q.pos[2] - p.pos[2]); if (d < bd) { bd = d; best = q; } }
    const input = { f: false, b: false, l: false, r: false, jump: false, sprint: true, ads: false, shoot: false, yaw: p.yaw, pitch: 0, reload: false, grenade: false, heal: false, switch: -1, stance: null };
    if (best) {
      input.yaw = Math.atan2(-(best.pos[0] - p.pos[0]), -(best.pos[2] - p.pos[2]));
      if (bd > 15) input.f = true; else if (bd < 7) input.b = true;
      if (bd < 55) input.shoot = true;
      if (p.inv[p.weapons[p.curW]].mag === 0) input.reload = true;
    }
    p.yaw = input.yaw;
    inputs.set(p.id, input);
  }
  game.step(inputs, CFG.SIM_DT);
  const ev = game.events.splice(0);
  if (ev.length) onEvents(ev);
  onSnap(game.pack());
}
function offlineStep() {
  const inputs = new Map();
  for (const p of game.players.values()) {
    if (p.id === myId) continue;
    let best = null, bd = 1e9;
    for (const q of game.players.values()) if (q.alive && q.id !== p.id) { const d = Math.hypot(q.pos[0] - p.pos[0], q.pos[2] - p.pos[2]); if (d < bd) { bd = d; best = q; } }
    const input = { f: false, b: false, l: false, r: false, jump: false, sprint: true, ads: false, shoot: false, yaw: p.yaw, pitch: 0, reload: false, grenade: false, heal: false, switch: -1, stance: null };
    if (best) {
      input.yaw = Math.atan2(-(best.pos[0] - p.pos[0]), -(best.pos[2] - p.pos[2]));
      if (bd > 15) input.f = true; else if (bd < 7) input.b = true;
      if (bd < 55) input.shoot = true;
      if (p.inv[p.weapons[p.curW]].mag === 0) input.reload = true;
    }
    p.yaw = input.yaw;
    inputs.set(p.id, input);
  }
  game.step(inputs, CFG.SIM_DT);
  const ev = game.events.splice(0);
  if (ev.length) onEvents(ev);
  onSnap(game.pack());
}

// ---- input gathering + prediction ----
let mouseDown = {};
addEventListener('mousedown', e => mouseDown[e.button] = true);
addEventListener('mouseup', e => mouseDown[e.button] = false);
addEventListener('contextmenu', e => e.preventDefault());

function collectInput() {
  let btn = 0;
  if (keys['KeyW'] || keys['ArrowUp']) btn |= BTN.F;
  if (keys['KeyS']) btn |= BTN.B;
  if (keys['KeyA']) btn |= BTN.L;
  if (keys['KeyD']) btn |= BTN.R;
  if (keys['Space']) btn |= BTN.JUMP;
  if (keys['ShiftLeft'] || keys['ShiftRight']) btn |= BTN.SPRINT;
  if (mouseDown[0]) btn |= BTN.SHOOT;
  if (mouseDown[2]) btn |= BTN.ADS;
  const entry = { seq: ++seq, yaw: +yaw.toFixed(3), pitch: +pitch.toFixed(3), buttons: btn, extra: { ...extra } };
  extra = { reload: false, grenade: false, heal: false, switch: -1, stance: null, enterVehicle: undefined };
  return entry;
}
function entryToSimInput(entry) {
  const b = entry.buttons;
  return {
    f: !!(b & BTN.F), b: !!(b & BTN.B), l: !!(b & BTN.L), r: !!(b & BTN.R),
    jump: !!(b & BTN.JUMP), sprint: !!(b & BTN.SPRINT), ads: !!(b & BTN.ADS),
    shoot: !!(b & BTN.SHOOT),
    yaw: entry.yaw, pitch: entry.pitch,
    reload: entry.extra.reload, grenade: entry.extra.grenade, heal: entry.extra.heal,
    switch: entry.extra.switch, stance: entry.extra.stance,
    enterVehicle: entry.extra.enterVehicle,
  };
}

function sendInput() {
  if (!myId) return;
  const entry = collectInput();

  // 1. predict locally immediately
  if (predicted && !offline) {
    const simInput = entryToSimInput(entry);
    // ensure local player exists in predicted world under the same id
    if (!predicted.players.has(myId)) predicted.addPlayer('Me', 0, 0);
    const me = predicted.players.get(myId);
    if (me) {
      // one predicted sim step (only my input; bots stand still in prediction)
      predicted.step(new Map([[myId, simInput]]), CFG.SIM_DT);
      inputHistory.push({ seq: entry.seq, input: simInput });
      if (inputHistory.length > 300) inputHistory.shift();
    }
  }

  // 2. send to server (offline: step the shared sim NOW with my input +
  // bot AI so my movement applies at 30 Hz tick rate, not render rate)
  const raw = encodeInput(entry.seq, entry.yaw, entry.pitch, entry.buttons, (predicted?.time || 0));
  if (offline) {
    entryAndStep(entry);
  } else if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'input', buf: Array.from(new Uint8Array(raw)), extra: entry.extra }));
  }
}

// ---- server reconciliation ----
let myData = null;
function onSnap(snap) {
  serverTick = snap.tick;
  // reconcile local predicted state with authoritative snapshot
  if (!offline && predicted) reconcile(snap);
  for (const p of snap.players) {
    let rec = interp.get(p.id);
    if (!rec) { rec = { pos: [p.x, p.y, p.z], data: p }; interp.set(p.id, rec); }
    rec.target = [p.x, p.y, p.z]; rec.data = p;
    if (p.id === myId) myData = p;
  }
  for (const v of snap.vehicles) {
    let mesh = vehicleMeshes.get(v.id);
    if (!mesh) { mesh = makeVehicleMesh(); vehicleMeshes.set(v.id, mesh); }
    mesh.position.set(v.x, v.y, v.z);
    mesh.rotation.y = v.yaw;
  }
  zoneRing.position.set(snap.zone.cx, 2, snap.zone.cz);
  zoneRing.scale.set(snap.zone.r, snap.zone.r, 1);
  drawMinimap(snap);
  if (myData) updateHUD(myData, snap);
}

function reconcile(snap) {
  const me = snap.players.find(p => p.id === myId);
  if (!me) return;
  // acked seq: server consumed every input up to the newest it processed.
  // We keep a client-side low watermark: inputs sent before this snapshot
  // arrived are assumed consumed, so drop the oldest consumed entry.
  // Estimate: one snapshot per 33 ms, so ~1 input per snapshot.
  if (inputHistory.length) inputHistory.shift();
  const p = predicted.players.get(myId);
  if (!p) return;
  // if prediction diverged by more than a small epsilon, snap to truth
  const d = Math.hypot(p.pos[0] - me.x, p.pos[2] - me.z, p.pos[1] - me.y);
  if (d > 0.5) {
    p.pos = [me.x, me.y, me.z];
    p.vel = [0, 0, 0];
  }
  p.health = me.hp; p.alive = me.alive;
  p.yaw = me.yaw; p.pitch = me.pitch;
  // re-apply remaining unacked inputs is expensive and unnecessary at 30 Hz
  // for this scope; next-frame prediction continues from the corrected state.
}

function updateHUD(d, snap) {
  $('hpfill').style.width = Math.max(0, d.hp) + '%';
  $('hpfill').style.background = d.hp > 40 ? 'linear-gradient(90deg,#3fd68c,#2ea86a)' : '#e05a4a';
  $('ammo').innerHTML = d.mag + ' <small>/ ' + d.res + '</small>';
  $('wname').textContent = d.w.toUpperCase() + ` · G:${d.gren} · ✚:${d.med} · ${d.k}✓`;
  if (!d.alive) $('msg').textContent = snap.mode === 'tdm' ? 'Respawning…' : 'ELIMINATED — spectating. Reload to rejoin.';
  else $('msg').textContent = '';
}
function onEvents(evts) {
  for (const e of evts) {
    if (e.k === 'shot') { playShot(e.id === myId ? 0 : 1); spawnTracer(e.id); if (e.id === myId) gunRecoil(); }
    if (e.k === 'hit' && e.from === myId) { hitmarker(); if (e.zone === 'head') $('crosshair').textContent = '✕'; else $('crosshair').textContent = '+'; }
    if (e.k === 'kill') addKill(e.kname + ' ▸ ' + e.vname);
    if (e.k === 'boom') playBoom(e); if (e.k === 'impact') spawnImpact(e);
    if (e.k === 'destroyed') spawnChunks(e);
  }
}
function gunRecoil() { if (viewGun) { viewGun.position.z = -0.44; viewGun.position.y = -0.18; } }
function addKill(t) { const d = document.createElement('div'); d.textContent = t; $('killfeed').prepend(d); setTimeout(() => d.remove(), 5000); }
function hitmarker() { const m = document.createElement('div'); m.className = 'hitmarker'; m.textContent = '✕'; $('hud').appendChild(m); setTimeout(() => m.remove(), 120); }
function drawMinimap(snap) {
  const c = $('minimap').getContext('2d'); const W2 = 170;
  const k = W2 / CFG.MAP_SIZE;
  c.fillStyle = 'rgba(20,30,20,.9)'; c.fillRect(0, 0, W2, W2);
  c.strokeStyle = '#55aaff'; c.beginPath(); c.arc(W2 / 2 + snap.zone.cx * k, W2 / 2 + snap.zone.cz * k, snap.zone.r * k, 0, 6.29); c.stroke();
  for (const p of snap.players) {
    if (!p.alive) continue;
    c.fillStyle = p.id === myId ? '#7dff9a' : (p.team === (myData?.team ?? 0) && snap.mode === 'tdm' ? '#6ab0ff' : '#ff6a5c');
    c.fillRect(W2 / 2 + p.x * k - 2, W2 / 2 + p.z * k - 2, 4, 4);
  }
  for (const v of snap.vehicles) {
    c.fillStyle = '#ffb347';
    c.fillRect(W2 / 2 + v.x * k - 3, W2 / 2 + v.z * k - 3, 6, 6);
  }
}
function renderScore() {
  const tb = $('scoreboard'); if (!myData) return;
  const rows = [...interp.values()].map(r => r.data).sort((a, b) => b.k - a.k).map(p => `<tr><td>${p.name}</td><td>${p.k}</td><td>${p.d}</td><td>${p.alive ? '●' : '○'}</td></tr>`).join('');
  tb.innerHTML = `<div style="font-weight:700;margin-bottom:6px">SCOREBOARD</div><table><tr><th>Player</th><th>K</th><th>D</th><th>Alive</th></tr>${rows}</table>`;
}

function spawnTracer(id) {
  const me = interp.get(id); if (!me || !myData) return;
  const from = new THREE.Vector3(me.pos[0], me.pos[1] + 1.4, me.pos[2]);
  const dir = new THREE.Vector3(-Math.sin(me.data.yaw), 0, -Math.cos(me.data.yaw));
  const geo = new THREE.BufferGeometry().setFromPoints([from, from.clone().add(dir.multiplyScalar(60))]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.8 }));
  scene.add(line); tracers.push({ line, t: 0 });
}
function spawnImpact(e) {
  const g = new THREE.SphereGeometry(0.08, 6, 5);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffd27a }));
  m.position.set(e.x, e.y, e.z); scene.add(m); particles.push({ m, t: 0, v: [Math.random() - .5, Math.random(), Math.random() - .5] });
}
function spawnChunks(e) {
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.4), new THREE.MeshStandardMaterial({ color: 0x9aa0a8 }));
    m.position.set(e.x, (game.world.terrainH(e.x, e.z)) + 1, e.z);
    scene.add(m);
    chunkDebris.push({ m, t: 0, v: [(Math.random() - .5) * 8, Math.random() * 7 + 2, (Math.random() - .5) * 8], r: [(Math.random() - .5) * 6, (Math.random() - .5) * 6, 0] });
  }
}

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  if (offline && pendingLocalInput) {
    const simInput = entryToSimInput(pendingLocalInput);
    inputsOffline.set(myId, simInput);
    pendingLocalInput = null;
    const inputs = new Map(inputsOffline); inputsOffline.clear();
    game.step(inputs, CFG.SIM_DT);
  }
  const k = 0.35;
  for (const [id, rec] of interp) {
    if (rec.target) {
      rec.pos[0] += (rec.target[0] - rec.pos[0]) * k;
      rec.pos[1] += (rec.target[1] - rec.pos[1]) * k;
      rec.pos[2] += (rec.target[2] - rec.pos[2]) * k;
    }
    let mesh = playerMeshes.get(id);
    if (!mesh) { mesh = makeAvatar(rec.data?.name || 'Soldier'); playerMeshes.set(id, mesh); }
    mesh.position.set(rec.pos[0], rec.pos[1], rec.pos[2]);
    mesh.rotation.y = rec.data?.yaw || 0;
    mesh.visible = rec.data?.alive ?? true;
    mesh.children[0].position.y = 1.0 + Math.sin(now * 0.02 + id) * 0.03;
  }
  // first-person camera on local player (server-authoritative position from interp)
  if (myData) {
    const p = interp.get(myId);
    if (p) {
      camera.position.set(p.pos[0], p.pos[1] + 1.55, p.pos[2]);
      camera.rotation.order = 'YXZ';
      // sim forward (yaw=0) is -Z world; Three.js camera default forward is
      // -Z, so rotation.y = yaw. pitch positive = look up.
      // clamp to avoid degenerate zenith (1.5 rad ~= 86 deg)
      const cp = Math.max(-1.35, Math.min(1.35, pitch));
      camera.rotation.y = yaw;
      camera.rotation.x = cp + shake * (Math.random() - 0.5);
      shake = Math.max(0, shake - 0.01);
    }
  } else {
    camera.position.set(0, 8, 12);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = yaw; camera.rotation.x = -0.3;
  }
  // view model recovery
  if (viewGun) {
    viewGun.position.z += (-0.52 - viewGun.position.z) * 0.25;
    viewGun.position.y += (-0.21 - viewGun.position.y) * 0.25;
  }
  // fx decay
  for (let i = tracers.length - 1; i >= 0; i--) { tracers[i].t += 0.016; tracers[i].line.material.opacity = Math.max(0, 0.8 - tracers[i].t * 4); if (tracers[i].t > 0.4) { scene.remove(tracers[i].line); tracers.splice(i, 1); } }
  for (let i = particles.length - 1; i >= 0; i--) { const pt = particles[i]; pt.t += 0.016; pt.m.position.x += pt.v[0] * 0.05; pt.m.position.y += pt.v[1] * 0.05 - 0.02; pt.m.position.z += pt.v[2] * 0.05; if (pt.t > 0.6) { scene.remove(pt.m); particles.splice(i, 1); } }
  for (let i = chunkDebris.length - 1; i >= 0; i--) {
    const c = chunkDebris[i]; c.t += 0.016;
    c.v[1] -= 22 * 0.016;
    c.m.position.x += c.v[0] * 0.016; c.m.position.y += c.v[1] * 0.016; c.m.position.z += c.v[2] * 0.016;
    c.m.rotation.x += c.r[0] * 0.016; c.m.rotation.y += c.r[1] * 0.016;
    const gy = game.world.terrainH(c.m.position.x, c.m.position.z);
    if (c.m.position.y < gy) { c.m.position.y = gy; c.v[0] = 0; c.v[1] = 0; c.v[2] = 0; }
    if (c.t > 3) { scene.remove(c.m); chunkDebris.splice(i, 1); }
  }
  renderer.render(scene, camera);
}

function initAudio() {
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
}
function playShot(dist) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = 'square'; o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
  g.gain.setValueAtTime(dist ? 0.12 : 0.3, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
  o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.16);
}
function playBoom(e) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.5);
  g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
  o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.6);
  shake = 0.5;
}
