// Frontline client entry point.
//
// Owns the lobby, the render/audio stack and two game sources:
//   online  — authoritative Node server over WebSocket, movement prediction
//             and snapshot interpolation for everyone else.
//   offline — the identical shared simulation plus bot AI running in-tab,
//             used for training without a server.
import * as THREE from 'three';
import { CFG, MATCH_STATE, TEAMS, STANCE } from '../shared/config.js';
import { weaponKey } from '../shared/protocol.js';
import { Game } from '../shared/sim.js';
import { spawnBots, stepBots } from '../server/bots.js';
import { clamp, damp, lerpAngle } from '../shared/math.js';
import { stanceEye } from '../shared/physics.js';
import { GameRenderer } from './render/renderer.js';
import { WorldRenderer } from './render/world.js';
import { Effects } from './render/effects.js';
import { CharacterView, VehicleView } from './render/entities.js';
import { ViewModel } from './render/viewmodel.js';
import { Input } from './input.js';
import { loadSettings, saveSettings } from './settings.js';
import { HUD } from './ui/hud.js';
import { AudioEngine } from './audio/audio.js';
import { NetClient, defaultUrl } from './net/client.js';
import { Prediction, remoteRenderTime } from './prediction.js';
import { World } from '../shared/world.js';

const $ = (id) => document.getElementById(id);

const WEAPON_LABEL = {
  pistol: 'P92', smg: 'VEX-9', ar: 'K4 CARBINE', dmr: 'SABLE DMR',
  shotgun: 'M12 BREACHER', sniper: 'AX-50', lmg: 'M249 SAW',
};

class App {
  constructor() {
    this.settings = loadSettings();
    this.canvas = $('view');
    this.renderer = new GameRenderer(this.canvas, this.settings);
    this.input = new Input(this.canvas);
    this.hud = new HUD(this.settings);
    this.audio = new AudioEngine();

    this.mode = null;            // 'online' | 'offline'
    this.active = false;
    this.world = null;
    this.worldView = null;
    this.effects = null;
    this.viewmodel = null;
    this.prediction = null;
    this.net = null;

    this.characters = new Map();
    this.vehicleViews = new Map();
    this.names = new Map();
    this.teams = new Map();
    this.loot = [];
    this.state = null;
    this.roster = [];
    this.localId = null;
    this.localSnap = null;
    this.localWeapons = [null, null];

    this.aimYaw = 0;
    this.aimPitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.shake = 0;
    this.bobT = 0;
    this.prevAimYaw = 0;
    this.prevAimPitch = 0;
    this.seq = 0;
    this.localFireT = 0;
    this.prevShoot = false;
    this.adsF = 0;

    this.offlineGame = null;
    this.offlinePlayer = null;
    this.offlineInputs = new Map();
    this.offlineStateT = 0;
    this.offlineLootT = 0;

    this.acc = 0;
    this.last = performance.now();
    this.time = 0;
    this.endShown = false;
    this.hadLock = false;
    this.spectateId = null;
    this.spectateT = 0;
    this.deadAt = 0;
    this.latencyText = '';

    this.hud.world = null;
    this.hud.playerId = null;
    this.hud.onChat = (text) => { this.net?.sendChat(text); };
    this.hud.onSettings = (s) => this.applySettings(s);
    this.hud.onLeave = () => this.leave();
    this.hud.onRestart = () => this.restart();
    this.hud.onUiMode = () => this.syncInputMode();
    this.hud.releasePointer = () => { this.input.clearHeld(); this.input.releaseLock(); };
    this.hud.requestPointer = () => { if (this.active) this.input.requestLock(); };

    this.initLobby();
    this.bindWindow();
    requestAnimationFrame((t) => this.frame(t));
  }

  // -------------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------------
  initLobby() {
    const params = new URLSearchParams(location.search);
    const room = (params.get('room') || params.get('r') || this.settings.room || 'ALPHA01').toUpperCase();
    const name = params.get('name') || this.settings.name || 'Soldier';
    $('in-name').value = name.slice(0, 16);
    $('in-room').value = room.slice(0, 12);
    $('in-mode').value = this.settings.mode || 'br';

    $('join').addEventListener('click', () => this.joinOnline());
    $('battest').addEventListener('click', () => this.joinOffline());
    $('copy-link').addEventListener('click', () => this.copyLink());
    $('in-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.joinOnline(); });
    $('in-room').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.joinOnline(); });

    const mode = $('in-mode').value;
    this.hud.setLobbyRoster([], mode, MATCH_STATE.LOBBY);
  }

  readLobby() {
    const name = ($('in-name').value || 'Soldier').trim().slice(0, 16) || 'Soldier';
    const room = ($('in-room').value || 'ALPHA01').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'ALPHA01';
    const mode = $('in-mode').value === 'tdm' ? 'tdm' : 'br';
    this.settings.name = name;
    this.settings.room = room;
    this.settings.mode = mode;
    saveSettings(this.settings);
    return { name, room, mode };
  }

  setLobbyStatus(text, error = false) {
    const el = $('lobby-status');
    el.textContent = text;
    el.classList.toggle('error', !!error);
  }

  copyLink() {
    const { room } = this.readLobby();
    const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`;
    navigator.clipboard?.writeText(url).then(
      () => this.setLobbyStatus(`Invite link copied: ${url}`),
      () => this.setLobbyStatus(url),
    );
  }

  // -------------------------------------------------------------------------
  // Online session
  // -------------------------------------------------------------------------
  joinOnline() {
    if (this.net) return;
    const { name, room, mode } = this.readLobby();
    this.audio.init();
    this.audio.setVolume(this.settings.volume);
    this.audio.setMuted(this.settings.muted);
    this.setLobbyStatus('Connecting to the server…');
    $('join').disabled = true;

    const net = new NetClient({ name, room, mode, url: defaultUrl() });
    this.net = net;
    net.onStatus = (state, extra) => {
      if (state === 'connecting') this.setLobbyStatus('Connecting…');
      else if (state === 'reconnecting') {
        this.setLobbyStatus(`Reconnecting in ${Math.round((extra || 0) / 100) / 10}s…`);
        if (this.active) this.hud.showReconnect('CONNECTION LOST — RECONNECTING · P TO RETRY');
      } else if (state === 'joined-pending') this.setLobbyStatus('Joining room…');
      else if (state === 'disconnected') this.setLobbyStatus('Disconnected.', true);
      else if (state === 'closed') { /* intentional */ }
    };
    net.onError = (msg) => {
      this.setLobbyStatus(msg, true);
      if (!this.active) { $('join').disabled = false; }
    };
    net.onWelcome = (msg) => this.onWelcome(msg);
    net.onRoster = (msg) => this.onRoster(msg);
    net.onSnapshot = (snap) => this.onSnapshot(snap);
    net.onEvents = (events) => this.handleEvents(events, net.playerId);
    net.onLoot = (loot) => { this.loot = loot; };
    net.onState = (state) => { this.state = state; this.syncState(state); };
    net.onChat = (msg) => this.hud.addChat(msg.name, msg.text, msg.team);
    net.connect();
  }

  onWelcome(msg) {
    this.localId = msg.playerId;
    this.hud.playerId = msg.playerId;
    this.mode = 'online';
    this.audio.setVolume(this.settings.volume);
    this.audio.setMuted(this.settings.muted);

    const first = !this.world;
    if (first) {
      this.setLobbyStatus('Generating the battlefield…');
      setTimeout(() => {
        this.buildSession(msg.mapSeed ?? CFG.MAP.SEED);
        this.localWeapons = msg.mode === 'tdm' ? ['ar', 'pistol'] : ['pistol', null];
        this.active = true;
        this.input.enabled = true;
        this.hud.setLobbyVisible(false);
        this.hud.notify('Deployed. Click the game to capture the mouse.');
        $('join').disabled = false;
        this.hud.hideReconnect();
      }, 30);
    } else {
      // Reconnect: keep the rendered world, resync prediction.
      this.hud.hideReconnect();
      this.net.requestKeyframe();
      const snap = this.net.cache.get(msg.playerId);
      if (snap && this.prediction) this.prediction.reset(snap);
    }
  }

  onRoster(msg) {
    this.roster = msg.players || [];
    for (const p of this.roster) {
      this.names.set(p.id, p.name);
      this.teams.set(p.id, p.team);
    }
    const me = this.roster.find(p => p.id === this.localId);
    if (me) { this.hud.playerId = me.id; this.hud.localTeam = me.team; }
    this.hud.setLobbyRoster(this.roster, msg.mode, msg.state);
  }

  onSnapshot(snap) {
    if (!this.prediction || this.localId === null) return;
    const local = this.net.cache.get(this.localId);
    if (!local) return;
    if (!this.localSnap) {
      this.prediction.reset(local);
      this.aimYaw = local.yaw ?? 0;
      this.aimPitch = local.pitch ?? 0;
    }
    this.localSnap = local;
    if (local.w && local.slot !== undefined) {
      const key = weaponKey(local.w);
      if (key) this.localWeapons[local.slot] = key;
    }
    this.prediction.reconcile(local, snap.ackInput);
  }

  // -------------------------------------------------------------------------
  // Offline session
  // -------------------------------------------------------------------------
  joinOffline() {
    const { name, mode } = this.readLobby();
    this.audio.init();
    this.audio.setVolume(this.settings.volume);
    this.audio.setMuted(this.settings.muted);
    this.setLobbyStatus('Generating the battlefield…');
    setTimeout(() => {
      this.buildSession(CFG.MAP.SEED);
      const game = new Game({ mode, mapSeed: CFG.MAP.SEED, seed: 0x51f15e });
      this.offlineGame = game;
      const me = game.addPlayer(name, 0, { connected: true });
      this.offlinePlayer = me;
      this.localId = me.id;
      this.hud.playerId = me.id;
      spawnBots(game, mode === 'tdm' ? 9 : 15, mode === 'tdm');
      game.begin();
      this.offlineInputs.clear();
      this.mode = 'offline';
      this.active = true;
      this.input.enabled = true;
      this.localWeapons = mode === 'tdm' ? ['ar', 'pistol'] : ['pistol', null];
      this.hud.setLobbyVisible(false);
      this.hud.notify('Offline training. Click the game to capture the mouse.');
    }, 30);
  }

  // -------------------------------------------------------------------------
  // Session construction / teardown
  // -------------------------------------------------------------------------
  buildSession(seed) {
    if (this.world && this.world.seed === seed) return;
    this.world = new World(seed);
    this.worldView = new WorldRenderer(this.renderer, this.world);
    this.effects = new Effects(this.renderer, this.renderer.camera);
    this.viewmodel = new ViewModel(this.renderer.camera, this.renderer.scene);
    this.prediction = new Prediction(this.world);
    this.hud.world = this.world;
    // Frame the camera somewhere sensible while the first snapshot lands.
    this.renderer.camera.position.set(0, 40, 0);
  }

  applySettings(s) {
    this.settings = s;
    this.hud.settings = s;
    saveSettings(s);
    this.audio.setVolume(s.volume);
    this.audio.setMuted(s.muted);
    this.input.sensitivity = s.sensitivity;
    this.input.invertY = s.invertY;
    this.renderer.settings = s;
    this.renderer.setQuality(s.quality);
    this.renderer.camera.fov = s.fov;
    this.renderer.camera.updateProjectionMatrix();
    this.hud.stats.style.display = s.showFps ? '' : 'none';
    this.syncInputMode();
  }

  syncInputMode() {
    this.input.textMode = this.uiBlocked();
  }

  forceReconnect() {
    const net = this.net;
    if (!net) return;
    if (net.connected && net.joined) return;
    if (net.reconnectTimer) { clearTimeout(net.reconnectTimer); net.reconnectTimer = null; }
    net.disconnect();
    net.reconnectAttempts = 0;
    this.hud.showReconnect('RECONNECTING…');
    net.connect();
  }

  leave() {
    this.active = false;
    this.input.enabled = false;
    this.input.releaseLock();
    if (this.net) { this.net.leave(); this.net = null; }
    location.reload();
  }

  restart() {
    this.hud.hideEnd();
    this.endShown = false;
    if (this.mode === 'offline' && this.offlineGame) {
      const g = this.offlineGame;
      g.begin();
      for (const p of g.players.values()) {
        if (p.bot) { p.bot.path = null; p.bot.pathIdx = 0; p.bot.targetId = null; p.bot.replan = 0; }
      }
      this.deadAt = 0;
    } else if (this.net) {
      this.net.start();
    }
  }

  // -------------------------------------------------------------------------
  // Input / simulation stepping
  // -------------------------------------------------------------------------
  uiBlocked() {
    return !this.active || this.hud.chatOpen || this.hud.settingsOpen || this.endShown;
  }

  frame(now) {
    const raw = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.min(0.1, Math.max(0, raw));
    this.time += dt;

    if (this.active) {
      this.tick(dt);
    } else {
      // Slow idle camera over the lobby backdrop.
      this.renderer.camera.position.set(0, 60, 0);
      this.renderer.camera.rotation.set(-0.5, this.time * 0.03, 0);
    }

    this.render(dt);
    requestAnimationFrame((t) => this.frame(t));
  }

  tick(dt) {
    // Look is consumed once per rendered frame so multiple fixed steps share it.
    this.prevAimYaw = this.aimYaw;
    this.prevAimPitch = this.aimPitch;
    this.syncInputMode();
    if (this.input.textMode) { this.input.mouse.dx = 0; this.input.mouse.dy = 0; }
    this.input.sensitivity = this.settings.sensitivity * (this.adsF > 0.5 ? this.settings.adsSensitivity : 1);
    this.input.invertY = this.settings.invertY;
    const [yaw, pitch] = this.input.look(this.aimYaw, this.aimPitch);
    this.aimYaw = yaw;
    this.aimPitch = pitch;

    if (this.net) this.net.tickStats(dt);

    this.acc += dt;
    let steps = 0;
    while (this.acc >= CFG.SIM_DT && steps < 6) {
      this.acc -= CFG.SIM_DT;
      this.stepSim(CFG.SIM_DT);
      steps++;
    }
    if (steps === 6) this.acc = 0;
    this.prediction?.stepCorrection(dt);
  }

  stepSim(dt) {
    const blocked = this.uiBlocked();
    // Recoil recovery.
    const wkey = this.currentWeaponKey();
    const W = wkey ? CFG.WEAPONS[wkey] : null;
    if (W) {
      this.recoilPitch = damp(this.recoilPitch, 0, W.recoilRecover, dt);
      this.recoilYaw = damp(this.recoilYaw, 0, W.recoilRecover * 0.9, dt);
    } else {
      this.recoilPitch = damp(this.recoilPitch, 0, 9, dt);
      this.recoilYaw = damp(this.recoilYaw, 0, 9, dt);
    }
    this.localFireT = Math.max(0, this.localFireT - dt);

    const yaw = this.aimYaw + this.recoilYaw;
    const pitch = clamp(this.aimPitch + this.recoilPitch, -CFG.PLAYER.MAX_PITCH, CFG.PLAYER.MAX_PITCH);
    this.seq = (this.seq + 1) >>> 0;
    const input = this.input.frame(yaw, pitch, this.seq, this.time);
    if (blocked) {
      input.f = input.b = input.l = input.r = false;
      input.jump = input.sprint = input.ads = input.shoot = false;
      input.reload = input.grenade = input.smoke = input.heal = false;
      input.interact = input.cycle = false;
      input.slot = -1;
      input.enterVehicle = undefined;
    }

    // Local shot feedback (the server still decides if the shot is valid).
    this.resolveEnterVehicle(input);
    this.detectLocalShot(input, blocked);

    if (this.mode === 'online') {
      if (this.prediction) this.prediction.push(input, dt);
      this.net?.sendInput(input);
    } else if (this.mode === 'offline' && this.offlineGame) {
      const game = this.offlineGame;
      const inputs = this.offlineInputs;
      inputs.clear();
      if (this.offlinePlayer && this.offlinePlayer.alive) inputs.set(this.offlinePlayer.id, input);
      stepBots(game, dt, inputs);
      game.step(inputs, dt);
      const events = game.events.splice(0);
      if (events.length) this.handleEvents(events, this.localId);
      this.offlineStateT -= dt;
      if (this.offlineStateT <= 0) { this.offlineStateT = 0.2; this.buildOfflineState(); }
      this.offlineLootT -= dt;
      if (this.offlineLootT <= 0) {
        this.offlineLootT = 0.5;
        this.syncOfflineLoot();
      }
    }

    // Footstep audio for the local player.
    const lp = this.getLocalPlayer();
    if (lp && lp.alive && lp.grounded) {
      const speed = Math.hypot(lp.vx || 0, lp.vz || 0);
      if (speed > 1.4) this.audio.footstep(lp.inWater ? 'water' : this.surfaceAt(lp.x, lp.y, lp.z), speed);
    }
  }

  resolveEnterVehicle(input) {
    if (input.enterVehicle !== 'toggle') return;
    input.enterVehicle = undefined;
    const lp = this.getLocalPlayer();
    if (!lp) return;
    if (lp.inVehicle) { input.enterVehicle = -1; return; }
    const list = this.mode === 'offline'
      ? (this.offlineGame?.vehicles || [])
      : (this.state?.vehicles || []);
    let best = null, bd = CFG.VEHICLE.enterRange;
    for (const v of list) {
      const d = Math.hypot(v.x - lp.x, v.z - lp.z);
      if (d < bd) { bd = d; best = v; }
    }
    if (best) input.enterVehicle = best.id;
  }

  currentWeaponKey() {    if (this.mode === 'offline' && this.offlinePlayer) return this.offlinePlayer.curWeapon();
    const snap = this.localSnap;
    if (snap && snap.w) return weaponKey(snap.w);
    return this.localWeapons[0] || null;
  }

  currentMag() {
    if (this.mode === 'offline' && this.offlinePlayer) {
      const w = this.offlinePlayer.curWeapon();
      return w ? (this.offlinePlayer.inv[w]?.mag ?? 0) : 0;
    }
    return this.localSnap?.mag ?? 0;
  }

  detectLocalShot(input, blocked) {
    const wkey = this.currentWeaponKey();
    const W = wkey ? CFG.WEAPONS[wkey] : null;
    const wantFire = !blocked && input.shoot && W;
    if (wantFire && this.localFireT <= 0 && (W.auto || !this.prevShoot)) {
      const mag = this.currentMag();
      this.localFireT = 60 / W.rpm;
      if (mag > 0) this.localShot(wkey, W);
      else if (!this.prevShoot) this.audio.dryFire();
    }
    this.prevShoot = !!input.shoot;
  }

  localShot(wkey, W) {
    if (!this.viewmodel) return;
    this.viewmodel.fire(W.pellets > 1 ? 1.35 : 1);
    const adsScale = this.adsF > 0.5 ? 0.72 : 1;
    this.recoilPitch = Math.min(0.5, this.recoilPitch + W.recoilPitch * adsScale);
    this.recoilYaw += (Math.random() - 0.5) * 2 * W.recoilYaw * adsScale;
    this.shake = Math.min(1, this.shake + (W.cls === 'sniper' ? 0.9 : 0.35));
    const cam = this.renderer.camera;
    this.audio.shot(wkey, cam.position.x, cam.position.y, cam.position.z);
    if (this.effects && this.viewmodel) {
      const m = this.viewmodel.muzzleWorld();
      const d = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      this.effects.muzzle([m.x, m.y, m.z], [d.x, d.y, d.z], W.pellets > 1 ? 0.9 : 1.2);
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------
  handleEvents(events, selfId) {
    for (const ev of events) {
      switch (ev.k) {
        case 'shot': this.onShot(ev, selfId); break;
        case 'hit': this.onHit(ev, selfId); break;
        case 'kill': {
          const names = new Map(this.names);
          if (ev.kname) names.set(ev.killer, ev.kname);
          if (ev.vname) names.set(ev.victim, ev.vname);
          this.hud.addKill(ev, names);
          if (ev.killer === selfId) this.hud.notify(`Eliminated ${ev.vname}${ev.zone === 'head' ? ' — headshot' : ''}`);
          break;
        }
        case 'destroy':
          this.worldView?.removeBox(ev.id);
          this.effects?.destroy(ev);
          break;
        case 'boom':
          this.effects?.boom(ev);
          this.audio.explosion(ev.x, ev.y, ev.z);
          this.shake = Math.min(1.4, this.shake + 0.9);
          break;
        case 'throw':
          this.effects?.projectile(ev);
          break;
        case 'reload':
          if (ev.id === selfId) this.audio.reload(ev.dur);
          break;
        case 'switch':
          if (ev.id === selfId) this.audio.switchWeapon();
          break;
        case 'dry':
          if (ev.id === selfId) this.audio.dryFire();
          break;
        case 'pickup':
          if (ev.id === selfId) {
            this.audio.pickup();
            if (ev.item === 'weapon' && ev.sub) {
              const empty = this.localWeapons.indexOf(null);
              if (empty >= 0) this.localWeapons[empty] = ev.sub;
            }
          }
          break;
        case 'healstart':
          if (ev.id === selfId) this.audio.heal();
          break;
        case 'healed':
          if (ev.id === selfId) this.hud.notify(`Healed to ${ev.hp}`);
          break;
        case 'falldmg':
          if (ev.id === selfId) { this.audio.damage(); this.shake = Math.min(1.2, this.shake + 0.6); }
          break;
        case 'warmup':
          this.hud.notify(`Match starts in ${Math.ceil(ev.countdown)}s`);
          break;
        case 'live':
          this.hud.notify('MATCH LIVE');
          break;
        case 'zone':
          if (ev.shrink) this.hud.notify('The zone is closing — move');
          break;
        case 'enterVehicle':
          if (ev.id === selfId) this.audio.pickup();
          break;
        case 'matchend':
          break;
        default: break;
      }
    }
  }

  onShot(ev, selfId) {
    const weapon = CFG.WEAPONS[ev.w];
    const isSelf = ev.id === selfId;
    if (!isSelf) {
      this.effects?.shot(ev, weapon);
      this.audio.shot(ev.w, ev.o[0], ev.o[1], ev.o[2]);
      // Crack of a round passing near the local player.
      const lp = this.getLocalPlayer();
      if (lp) {
        const d = Math.hypot(ev.o[0] - lp.x, ev.o[2] - lp.z);
        if (d < 45) this.audio.whiz(0);
      }
    }
    if (ev.imps && this.effects) {
      for (const im of ev.imps) {
        this.effects.impact({
          p: im.p, n: im.n || [0, 1, 0], tag: im.tag, mat: im.mat,
        });
      }
    }
  }

  onHit(ev, selfId) {
    if (ev.from === selfId) {
      const kill = (ev.hp ?? 1) <= 0;
      this.hud.hit(ev.dmg, ev.zone === 'head', kill);
      this.audio.hit(ev.zone === 'head', kill);
      if (ev.x !== undefined) this.effects?.blood({ p: [ev.x, ev.y, ev.z] });
    }
    if (ev.to === selfId) {
      this.audio.damage();
      this.shake = Math.min(1.2, this.shake + 0.7);
      const lp = this.getLocalPlayer();
      const attacker = this.net?.cache.get(ev.from) || this.offlineGame?.players.get(ev.from);
      if (lp && attacker) {
        const ax = attacker.pos ? attacker.pos[0] : attacker.x;
        const az = attacker.pos ? attacker.pos[2] : attacker.z;
        const angle = Math.atan2(-(ax - lp.x), -(az - lp.z));
        this.hud.damageFrom(angle, lp.yaw);
      }
    }
  }

  // -------------------------------------------------------------------------
  // State sync
  // -------------------------------------------------------------------------
  syncState(state) {
    if (!state) return;
    this.syncVehicles(state.vehicles || []);
    this.effects?.syncSmoke(state.smokes || []);
  }

  syncVehicles(list) {
    if (!this.worldView) return;
    const seen = new Set();
    for (const v of list) {
      seen.add(v.id);
      let view = this.vehicleViews.get(v.id);
      if (!view) {
        view = new VehicleView(this.renderer.scene, v.id, v.type || 'car');
        this.vehicleViews.set(v.id, view);
      }
      view.applyState(v);
    }
    for (const [id, view] of this.vehicleViews) {
      if (seen.has(id)) continue;
      view.dispose();
      this.vehicleViews.delete(id);
    }
  }

  buildOfflineState() {
    const g = this.offlineGame;
    if (!g) return;
    this.state = {
      type: 'state', mode: g.mode, matchState: g.matchState, countdown: g.countdown,
      roundTime: g.roundTime, score: g.score.slice(),
      winner: g.winner ? { id: g.winner.id ?? null, team: g.winner.team ?? null, name: g.winner.name } : null,
      zone: {
        cx: +g.zone.cx.toFixed(1), cz: +g.zone.cz.toFixed(1), r: +g.zone.r.toFixed(1),
        phase: g.zone.phase, shrinking: g.zone.shrinking, dps: g.zone.dps,
        active: g.zone.active, phaseT: +g.zone.phaseT.toFixed(1),
      },
      vehicles: g.vehicles.map(v => ({
        id: v.id, x: +v.pos[0].toFixed(2), y: +v.pos[1].toFixed(2), z: +v.pos[2].toFixed(2),
        yaw: +v.yaw.toFixed(3), pitch: +v.pitch.toFixed(3), roll: +v.roll.toFixed(3),
        speed: +Math.hypot(v.vel[0], v.vel[2]).toFixed(2), type: v.type,
        occupants: v.occupants.slice(), health: v.health,
      })),
      smokes: g.smokes.map(s => ({ x: +s.x.toFixed(1), y: +s.y.toFixed(1), z: +s.z.toFixed(1), r: s.r })),
    };
    this.syncState(this.state);
  }

  syncOfflineLoot() {
    if (!this.offlineGame || !this.worldView) return;
    const me = this.offlinePlayer;
    if (!me) return;
    const all = this.offlineGame.packLoot();
    this.loot = all.filter(l => {
      const dx = l.x - me.pos[0], dz = l.z - me.pos[2];
      return dx * dx + dz * dz < 180 * 180;
    });
  }

  // -------------------------------------------------------------------------
  // Local player view model
  // -------------------------------------------------------------------------
  getLocalPlayer() {
    if (!this.world) return null;
    if (this.mode === 'offline') {
      const p = this.offlinePlayer;
      if (!p) return null;
      const w = p.curWeapon();
      const inv = w ? p.inv[w] : null;
      return {
        x: p.pos[0], y: p.pos[1], z: p.pos[2],
        vx: p.vel[0], vz: p.vel[2],
        yaw: p.yaw, pitch: p.pitch,
        stance: p.stance, grounded: p.grounded, inWater: p.inWater,
        alive: p.alive, hp: p.health, armor: p.armor,
        weapon: w, weapons: p.weapons.slice(), slot: p.curSlot,
        mag: inv ? inv.mag : 0, reserve: inv ? inv.reserve : 0,
        grenades: p.grenades, smokes: p.smokes, bandages: p.bandages, medkits: p.medkits,
        ads: !!p.adsing, inVehicle: p.inVehicle || 0,
        reloadT: p.reloadT, switchT: p.switchT,
        respawnIn: !p.alive && p.respawnAt ? Math.max(0, p.respawnAt - this.offlineGame.time) : 0,
        spread: this.spreadFor(p, w),
        cameraPos: [p.pos[0], p.pos[1], p.pos[2]],
      };
    }
    if (!this.prediction) return null;
    const snap = this.localSnap || {};
    const pred = this.prediction.player;
    const pos = this.prediction.renderPos();
    const w = snap.w ? weaponKey(snap.w) : this.localWeapons[snap.slot ?? 0];
    const spread = this.spreadFor(pred, w, snap);
    return {
      x: pos[0], y: pos[1], z: pos[2],
      vx: pred.vel[0], vz: pred.vel[2],
      yaw: pred.yaw, pitch: pred.pitch,
      stance: pred.stance, grounded: pred.grounded, inWater: pred.inWater,
      alive: snap.alive !== 0, hp: snap.hp ?? 100, armor: snap.armor ?? 0,
      weapon: w, weapons: this.localWeapons.slice(), slot: snap.slot ?? 0,
      mag: snap.mag ?? 0, reserve: snap.res ?? 0,
      grenades: snap.gren ?? 0, smokes: snap.smoke ?? 0,
      bandages: snap.band ?? 0, medkits: snap.med ?? 0,
      ads: this.input.mouse.right, inVehicle: snap.vehicle || 0,
      reloadT: pred.reloadT, switchT: snap.switchT || 0,
      respawnIn: this.respawnIn(snap, pred),
      spread,
      cameraPos: pos,
    };
  }

  respawnIn(snap, pred) {
    if (snap.alive !== 0 || this.state?.mode !== 'tdm') return 0;
    if (!this.deadAt) this.deadAt = this.time;
    return Math.max(0, CFG.MODES.tdm.respawn - (this.time - this.deadAt));
  }

  spreadFor(p, wkey, snap = null) {
    const W = wkey ? CFG.WEAPONS[wkey] : null;
    if (!W) return 0.03;
    const ads = snap ? !!snap.adsing : !!p.adsing;
    const speed = Math.hypot(p.vel ? p.vel[0] : (p.vx || 0), p.vel ? p.vel[2] : (p.vz || 0));
    let spread = ads ? W.spreadAds : W.spreadHip;
    spread += (speed / CFG.PLAYER.SPRINT) * W.spreadMove;
    if (!p.grounded) spread += W.spreadAir;
    if (p.stance === STANCE.CROUCH) spread *= 0.88;
    if (p.stance === STANCE.PRONE) spread *= 0.72;
    if (p.inWater) spread *= 1.3;
    return Math.min(0.14, spread);
  }

  surfaceAt(x, y, z) {
    if (!this.world) return 'dirt';
    const boxes = this.world.queryBoxes(x - 0.5, z - 0.5, x + 0.5, z + 0.5);
    for (const b of boxes) {
      if (b.destroyed) continue;
      if (Math.abs(b.max[1] - y) < 0.2) return b.mat;
    }
    return 'dirt';
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  render(dt) {
    if (!this.world) { this.renderer.render(dt); return; }
    const camera = this.renderer.camera;
    const lp = this.active ? this.getLocalPlayer() : null;
    const camLp = this.spectateCamera(lp);

    // Third-person fallback / lobby idle camera.
    if (!camLp) {
      camera.position.set(0, 55, 0);
      camera.rotation.set(-0.5, this.time * 0.02, 0);
    } else {
      this.updateCamera(dt, camLp, camera);
    }

    // Local first-person weapon.
    if (this.viewmodel) {
      const hide = !lp || !lp.alive || !!lp.inVehicle || this.spectateId !== null;
      const lookDX = (this.aimYaw - this.prevAimYaw) * 1000;
      const lookDY = (this.aimPitch - this.prevAimPitch) * 1000;
      const speed = lp ? Math.hypot(lp.vx || 0, lp.vz || 0) : 0;
      this.viewmodel.update(dt, {
        weapon: lp?.weapon,
        speed,
        grounded: lp?.grounded ?? true,
        ads: lp?.ads ?? false,
        lookDX, lookDY,
        reloadT: lp?.reloadT ?? 0,
        switchT: lp?.switchT ?? 0,
        hide: hide || this.uiBlocked(),
      });
    }

    // Remote characters.
    if (this.mode === 'online' && this.net) {
      const sample = this.net.buffer.sample(
        remoteRenderTime(this.net.buffer, this.net.rtt, this.net.jitter),
      );
      const seen = new Set();
      const camPos = [camera.position.x, camera.position.y, camera.position.z];
      for (const [id, p] of sample) {
        if (id === this.localId) continue;
        seen.add(id);
        let view = this.characters.get(id);
        if (!view) {
          view = new CharacterView(this.renderer.scene, id);
          this.characters.set(id, view);
        }
        view.applyState({
          ...p,
          name: this.names.get(id) || `#${id}`,
          team: this.teams.get(id) ?? p.team ?? 0,
          hp: p.hp,
          alive: !!p.alive,
          stance: p.stance,
        });
        view.vx = p.vx; view.vz = p.vz;
        view.update(dt, camPos);
        const spd = Math.hypot(p.vx || 0, p.vz || 0);
        if (p.alive && p.grounded && spd > 1.8) {
          this.audio.footstep(this.surfaceAt(p.x, p.y, p.z), spd, p.x, p.y, p.z, id);
        }
      }
      for (const [id, view] of this.characters) {
        if (seen.has(id)) continue;
        view.dispose();
        this.characters.delete(id);
      }
    } else if (this.mode === 'offline' && this.offlineGame) {
      const camPos = [camera.position.x, camera.position.y, camera.position.z];
      const seen = new Set();
      for (const p of this.offlineGame.players.values()) {
        if (p.id === this.localId) continue;
        seen.add(p.id);
        let view = this.characters.get(p.id);
        if (!view) {
          view = new CharacterView(this.renderer.scene, p.id);
          this.characters.set(p.id, view);
        }
        view.applyState({
          x: p.pos[0], y: p.pos[1], z: p.pos[2],
          yaw: p.yaw, pitch: p.pitch, stance: p.stance,
          hp: p.health, alive: p.alive, name: p.name, team: p.team,
        });
        view.vx = p.vel[0]; view.vz = p.vel[2];
        view.update(dt, camPos);
        const spd = Math.hypot(p.vel[0] || 0, p.vel[2] || 0);
        if (p.alive && p.grounded && spd > 1.8) {
          this.audio.footstep(this.surfaceAt(p.pos[0], p.pos[1], p.pos[2]), spd, p.pos[0], p.pos[1], p.pos[2], p.id);
        }
      }
      for (const [id, view] of this.characters) {
        if (seen.has(id)) continue;
        view.dispose();
        this.characters.delete(id);
      }
    }

    // Vehicles.
    for (const view of this.vehicleViews.values()) view.update(dt);

    // World animation and effects.
    this.worldView?.update(dt, this.time);
    if (this.worldView && this.loot.length) this.worldView.syncLoot(this.loot);
    this.effects?.update(dt);

    this.updateHud(dt, lp, camLp);
    this.renderer.render(dt);
  }

  // While dead in BR, follow the player selected by the spectate rotation.
  spectateCamera(lp) {
    if (!lp) return null;
    if (lp.alive || this.spectateId === null) return lp;
    const t = this.mode === 'offline'
      ? this.offlineGame?.players.get(this.spectateId)
      : this.net?.cache.get(this.spectateId);
    if (!t) return lp;
    const px = t.pos ? t.pos[0] : t.x;
    const py = t.pos ? t.pos[1] : t.y;
    const pz = t.pos ? t.pos[2] : t.z;
    return {
      ...lp,
      x: px, y: py, z: pz, cameraPos: [px, py, pz],
      yaw: t.yaw ?? 0, pitch: t.pitch ?? 0,
      stance: t.stance ?? 0, grounded: true, inWater: false,
      vx: t.vel ? t.vel[0] : (t.vx || 0), vz: t.vel ? t.vel[2] : (t.vz || 0),
      ads: false, weapon: null, inVehicle: t.inVehicle || t.vehicle || 0,
      alive: true, reloadT: 0, switchT: 0,
    };
  }

  updateCamera(dt, lp, camera) {
    const targetAds = lp.ads ? 1 : 0;
    this.adsF = damp(this.adsF, targetAds, 14, dt);
    const W = lp.weapon ? CFG.WEAPONS[lp.weapon] : null;
    const zoom = W ? 1 + (W.adsZoom - 1) * this.adsF : 1;
    const targetFov = this.settings.fov / zoom;
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov = damp(camera.fov, targetFov, 18, dt);
      camera.updateProjectionMatrix();
    }

    // Camera shake from recoil and explosions.
    this.shake = damp(this.shake, 0, 7, dt);
    const speed = Math.hypot(lp.vx || 0, lp.vz || 0);
    const grounded = lp.grounded && !lp.inVehicle;
    this.bobT += dt * (4 + speed * 1.2);
    const bobAmt = grounded ? clamp(speed / CFG.PLAYER.SPRINT, 0, 1) : 0;
    const bobY = Math.sin(this.bobT * 2) * 0.018 * bobAmt;
    const bobX = Math.cos(this.bobT) * 0.014 * bobAmt;

    const eye = lp.inVehicle ? 0.95 : stanceEye(lp.stance);
    camera.position.set(
      lp.cameraPos[0] + bobX,
      lp.cameraPos[1] + eye + bobY,
      lp.cameraPos[2],
    );
    const shakePitch = (Math.random() - 0.5) * 0.01 * this.shake;
    const shakeYaw = (Math.random() - 0.5) * 0.01 * this.shake;
    camera.rotation.set(lp.pitch + shakePitch, lp.yaw + shakeYaw, 0);

    this.audio.setListener([camera.position.x, camera.position.y, camera.position.z], lp.yaw);
  }

  updateHud(dt, lp, camLp = lp) {
    if (!lp) return;
    // Position lookup used by the minimap for teammates.
    const rosterPos = {};
    if (this.mode === 'online' && this.net) {
      for (const [id, p] of this.net.buffer.sample(
        remoteRenderTime(this.net.buffer, this.net.rtt, this.net.jitter))) {
        rosterPos[id] = [p.x, p.y, p.z];
      }
    } else if (this.mode === 'offline' && this.offlineGame) {
      for (const p of this.offlineGame.players.values()) rosterPos[p.id] = p.pos.slice();
    }
    rosterPos[this.localId] = [lp.x, lp.y, lp.z];
    this.hud._rosterPos = rosterPos;

    const roster = this.rosterForHud();
    const me = roster.find(p => p.id === this.localId);
    if (me) this.hud.localTeam = me.team;

    // Interaction prompt.
    this.hud.setPrompt(this.interactionPrompt(lp));

    // Zone alarm follows the same authoritative zone data the HUD shows.
    const z = this.state?.zone;
    const outside = !!z && lp.alive && Math.hypot(lp.x - z.cx, lp.z - z.cz) > z.r;
    this.audio.zoneAlarm(outside);

    const spectator = this.spectatorName();
    this.hud.update(dt, {
      player: lp,
      state: this.state,
      roster,
      vehicles: this.state?.vehicles,
      loot: this.loot,
      cameraYaw: camLp?.yaw ?? lp.yaw,
      spectator,
      netStats: this.latencyText,
    });

    // Stats panel.
    if (this.settings.showFps) {
      const fps = Math.round(this.renderer.fps);
      const rtt = this.mode === 'online' ? Math.round(this.net?.rtt || 0) : 0;
      const kb = this.mode === 'online' ? ((this.net?.bytesPerSec || 0) / 1024).toFixed(1) : '0';
      this.latencyText = this.mode === 'online'
        ? `RTT ${rtt}ms · jit ${Math.round(this.net?.jitter || 0)}ms · ${kb} KB/s`
        : 'OFFLINE';
      this.hud.setStats(`${fps} FPS\n${this.mode.toUpperCase()} · ${this.state?.mode?.toUpperCase() || '—'}\ntick ${this.state?.tick ?? this.offlineGame?.tick ?? 0}`);
    }

    // Match end panel.
    const ended = this.state?.matchState === MATCH_STATE.ENDED;
    if (ended && !this.endShown) {
      this.endShown = true;
      this.hud.showEnd(this.state.winner, this.rosterForHud(), this.state.mode, this.state.score);
      this.input.releaseLock();
    } else if (!ended && this.endShown) {
      this.endShown = false;
      this.hud.hideEnd();
    }

    this.updateSpectate(dt, lp);
  }

  interactionPrompt(lp) {
    if (!lp.alive) return '';
    if (lp.inVehicle) return 'E · EXIT VEHICLE';
    const loot = this.loot;
    if (loot) {
      let best = null, bd = CFG.LOOT.pickupRange;
      for (const it of loot) {
        const d = Math.hypot(it.x - lp.x, it.z - lp.z);
        if (d < bd) { bd = d; best = it; }
      }
      if (best) {
        const label = best.type === 'weapon' ? (WEAPON_LABEL[best.weapon] || 'WEAPON')
          : best.type === 'ammo' ? 'AMMO'
            : best.type === 'armor' ? 'ARMOUR'
              : best.type === 'heal' || best.type === 'med' ? (best.sub === 'medkit' ? 'MEDKIT' : 'BANDAGE')
                : best.type === 'grenade' ? (best.sub === 'smoke' ? 'SMOKE' : 'FRAG') : best.type.toUpperCase();
        return `E · PICK UP ${label}`;
      }
    }
    if (this.state?.vehicles) {
      for (const v of this.state.vehicles) {
        if (Math.hypot(v.x - lp.x, v.z - lp.z) < CFG.VEHICLE.enterRange) return 'E · ENTER VEHICLE';
      }
    }
    return '';
  }

  rosterForHud() {
    if (this.mode === 'offline' && this.offlineGame) {
      return [...this.offlineGame.players.values()].map(p => ({
        id: p.id, name: p.name, team: p.team, bot: p.isBot, alive: p.alive,
        kills: p.kills, deaths: p.deaths, ping: 0,
      }));
    }
    return this.roster;
  }

  // -------------------------------------------------------------------------
  // Spectating
  // -------------------------------------------------------------------------
  updateSpectate(dt, lp) {
    if (!lp) return;
    if (lp.alive) {
      this.deadAt = 0;
      if (this.spectateId !== null) {
        this.spectateId = null;
        this.net?.spectate(-1);
      }
      return;
    }
    if (!this.deadAt) this.deadAt = this.time;
    if (this.state?.mode !== 'br') return;
    this.spectateT -= dt;
    if (this.spectateT > 0) return;
    this.spectateT = 3;
    const candidates = this.mode === 'offline'
      ? [...this.offlineGame.players.values()].filter(p => p.alive && p.id !== this.localId)
      : this.roster.filter(p => p.alive && p.id !== this.localId);
    if (!candidates.length) return;
    const idx = candidates.findIndex(p => p.id === this.spectateId);
    const next = candidates[(idx + 1) % candidates.length];
    this.spectateId = next.id;
    this.net?.spectate(next.id);
  }

  // Manual spectator cycle (Q while dead in BR). Automatic rotation continues
  // every 3 s; this just advances immediately.
  cycleSpectate() {
    const lp = this.getLocalPlayer();
    if (!lp || lp.alive) return;
    this.spectateT = 0;
    this.updateSpectate(0.001, lp);
  }

  spectatorName() {
    if (!this.spectateId) return null;
    return this.names.get(this.spectateId)
      || this.offlineGame?.players.get(this.spectateId)?.name
      || 'PLAYER';
  }

  // -------------------------------------------------------------------------
  // Window wiring
  // -------------------------------------------------------------------------
  bindWindow() {
    addEventListener('resize', () => this.renderer.resize());
    addEventListener('keydown', (e) => {
      if (e.code === 'Tab') {
        e.preventDefault();
        if (this.active && !this.hud.chatOpen) this.hud.toggleScoreboard(true);
      }
      if (e.code === 'Enter' && this.active && !this.hud.chatOpen
        && !this.hud.settingsOpen && !this.endShown) {
        e.preventDefault();
        this.hud.openChat();
      }
      if (e.code === 'Escape') {
        if (this.hud.chatOpen) {
          this.hud.closeChat();
        } else if (this.hud.settingsOpen) {
          // Ignore the same physical Esc that just opened the panel after a
          // pointer-lock release, otherwise the menu flickers shut.
          if (performance.now() - this.hud._openedAt > 250) this.hud.toggleSettings(false);
        } else if (this.active && !this.endShown) {
          this.hud.toggleSettings(true);
        }
      }
      if (e.code === 'KeyM' && this.active && !this.hud.chatOpen && !this.hud.settingsOpen) {
        this.settings.muted = !this.settings.muted;
        this.applySettings(this.settings);
        this.hud.notify(this.settings.muted ? 'AUDIO MUTED' : 'AUDIO ON');
      }
      if (e.code === 'KeyP' && this.active && !this.hud.chatOpen && !this.hud.settingsOpen
        && this.net && !this.net.connected) {
        this.forceReconnect();
      }
      if (e.code === 'KeyQ' && this.active && !this.hud.chatOpen && !this.hud.settingsOpen) {
        this.cycleSpectate();
      }
    });
    addEventListener('keyup', (e) => {
      if (e.code === 'Tab') this.hud.toggleScoreboard(false);
    });
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.canvas;
      if (locked) { this.hadLock = true; return; }
      this.input.clearHeld();
      if (this.hadLock && this.active && !this.hud.chatOpen && !this.endShown
        && !this.hud.settingsOpen && performance.now() - this.hud._openedAt > 250) {
        this.hud.toggleSettings(true);
      }
      this.syncInputMode();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.input.clearHeld();
        this.syncInputMode();
      }
    });
  }
}

// Imported here (rather than at the top) so the lobby can paint before the
// world generator is evaluated.

window.addEventListener('DOMContentLoaded', () => {
  try {
    window.__frontline = new App();
  } catch (err) {
    console.error(err);
    const el = document.getElementById('err');
    if (el) el.textContent = String(err && err.message ? err.message : err);
  }
});
