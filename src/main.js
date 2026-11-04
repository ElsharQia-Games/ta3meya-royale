// Frontline client entry point.
//
// Owns the lobby, the render/audio stack and two game sources:
//   online  — authoritative Node server over WebSocket, movement prediction
//             and snapshot interpolation for everyone else.
//   offline — the identical shared simulation plus bot AI running in-tab,
//             used for training without a server.
import * as THREE from 'three';
import { CFG, MATCH_STATE, TEAMS, STANCE, combatKit } from '../shared/config.js';
import { weaponKey } from '../shared/protocol.js';
import { Game } from '../shared/sim.js';
import { spawnBots, stepBots } from '../server/bots.js';
import { clamp, damp, lerpAngle } from '../shared/math.js';
import { stanceEye } from '../shared/physics.js';
import { packVehicle, vehicleInReach } from '../shared/vehicle.js';
import { lootInReach, canPickupLoot } from '../shared/weapons.js';
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
  shotgun: 'M12 BREACHER', sniper: 'AX-50', lmg: 'M249 SAW', rpg: 'R7 LANCER',
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
    this.pendingShots = [];
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
    this.manualOpen = false;
    this.preparing = false;
    this.previewSoldier = null;
    this.hadLock = false;
    this.spectateId = null;
    this.spectateT = 0;
    this.localDeath = null;
    this.deathEvents = new Map();
    this.deadAt = 0;
    this.latencyText = '';

    this.hud.world = null;
    this.hud.playerId = null;
    this.hud.onChat = (text) => {
      if (this.net) this.net.sendChat(text);
      else if (this.mode === 'offline') this.hud.addChat(this.settings.name, text, this.offlinePlayer?.team || 0);
    };
    this.hud.onSettings = (s) => this.applySettings(s);
    this.hud.onLeave = () => this.leave();
    this.hud.onRestart = () => this.restart();
    this.hud.onUiMode = () => this.syncInputMode();
    this.hud.releasePointer = () => { this.input.clearHeld(); this.input.releaseLock(); };
    this.hud.requestPointer = () => { if (this.active) this.input.requestLock(); };

    this.initLobby();
    this.bindWindow();
    requestAnimationFrame((t) => this.frame(t));
    setTimeout(() => this.initBackdrop(), 40);
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
    $('in-mode').value = ['br', 'tdm'].includes(params.get('mode')) ? params.get('mode') : this.settings.mode || 'br';
    this.selectedKit = combatKit(this.settings.kit);
    const selectMode = mode => {
      $('in-mode').value = mode;
      document.querySelectorAll('.mode-option').forEach(button => {
        const selected = button.dataset.mode === mode;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-checked', String(selected));
        button.tabIndex = selected ? 0 : -1;
      });
      $('mode-capacity').textContent = `${CFG.MODES[mode].maxPlayers} MAX`;
      $('kit-rule').textContent = mode === 'tdm' ? 'EQUIPPED ON DEPLOY / RESPAWN' : 'BR / WEAPONS FOUND IN THE FIELD';
    };
    selectMode($('in-mode').value);
    $('in-mode').addEventListener('change', () => selectMode($('in-mode').value));
    document.querySelectorAll('.mode-option').forEach(button => {
      button.addEventListener('click', () => selectMode(button.dataset.mode));
      button.addEventListener('keydown', e => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const next = button.dataset.mode === 'br' ? 'tdm' : 'br';
        selectMode(next);
        document.querySelector(`[data-mode="${next}"]`).focus();
      });
    });
    const selectKit = key => {
      this.selectedKit = combatKit(key);
      this.settings.kit = this.selectedKit;
      document.querySelectorAll('.kit-option').forEach(button => {
        const selected = button.dataset.kit === this.selectedKit;
        button.classList.toggle('active', selected); button.setAttribute('aria-checked', String(selected));
        button.tabIndex = selected ? 0 : -1;
      });
      $('kit-description').textContent = CFG.KITS[this.selectedKit].role;
      if (this.previewSoldier) this.previewSoldier.applyState({ ...this.previewState,
        weapon: CFG.KITS[this.selectedKit].weapons[0] });
      saveSettings(this.settings);
    };
    for (const button of document.querySelectorAll('.kit-option')) {
      button.addEventListener('click', () => selectKit(button.dataset.kit));
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const keys = Object.keys(CFG.KITS), step = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
        selectKit(keys[(keys.indexOf(this.selectedKit) + keys.length + step) % keys.length]);
        document.querySelector(`[data-kit="${this.selectedKit}"]`).focus();
      });
    }
    selectKit(this.selectedKit);
    $('nav-deploy').onclick = () => $('in-name').focus();
    $('nav-settings').onclick = () => this.hud.toggleSettings(true);
    $('nav-manual').onclick = () => this.toggleManual(true);
    $('manual-close').onclick = $('manual-done').onclick = () => this.toggleManual(false);

    $('join').addEventListener('click', () => this.joinOnline());
    $('battest').addEventListener('click', () => this.joinOffline());
    $('copy-link').addEventListener('click', () => this.copyLink());
    $('in-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.joinOnline(); });
    $('in-room').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.joinOnline(); });

    const mode = $('in-mode').value;
    this.hud.setLobbyRoster([], mode, MATCH_STATE.LOBBY);
    this.setLobbyStatus('Use the same room code to play together.');
  }

  toggleManual(open) {
    this.manualOpen = open;
    $('manual-panel').classList.toggle('hidden', !open);
    this.input.clearHeld();
    if (open) { this.input.releaseLock(); $('manual-close').focus(); }
    else $('nav-manual').focus();
    this.syncInputMode();
  }

  initBackdrop() {
    if (this.active || this.world) return;
    this.buildSession(CFG.MAP.SEED);
    this.previewSoldier = new CharacterView(this.renderer.scene, -7, this.world, this.renderer);
    this.renderer.registerObject(this.previewSoldier.model.root);
    this.previewState = {
      x: 20.85, y: this.world.terrainHeight(20.85, -164.3), z: -164.3,
      yaw: Math.PI + .72, pitch: -.17, stance: STANCE.STAND,
      alive: true, hp: 100, name: '', team: 0,
      weapon: CFG.KITS[this.selectedKit].weapons[0],
    };
    this.previewSoldier.applyState(this.previewState);
    this.previewReady = true;
  }

  updateBackdrop(dt) {
    if (!this.world) return;
    const camera = this.renderer.camera;
    const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    camera.position.set(20 + (motion ? Math.sin(this.time * 0.07) * 0.12 : 0), this.world.terrainHeight(20, -160) + 1.65, -160);
    camera.rotation.set(-0.025, motion ? Math.sin(this.time * 0.055) * 0.012 : 0, 0);
    if (camera.fov !== 56) { camera.fov = 56; camera.updateProjectionMatrix(); }
    if (this.previewSoldier) {
      this.previewSoldier.update(dt, camera.position.toArray());
      this.previewSoldier.plate.sprite.visible = false;
    }
    this.worldView.update(dt, this.time);
    if (this.viewmodel) { this.viewmodel.root.visible = false; this.viewmodel.armsRoot.visible = false; }
  }

  finishBackdrop() {
    this.hud.combat.transition('DEPLOYING TO BLACKSHORE');
    this.audio.ui('deploy');
    if (this.previewSoldier) { this.previewSoldier.dispose(); this.previewSoldier = null; }
    this.renderer.camera.fov = this.settings.fov;
    this.renderer.camera.updateProjectionMatrix();
  }

  readLobby() {
    const name = ($('in-name').value || 'Soldier').trim().slice(0, 16) || 'Soldier';
    const room = ($('in-room').value || 'ALPHA01').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'ALPHA01';
    const mode = $('in-mode').value === 'tdm' ? 'tdm' : 'br';
    this.settings.name = name;
    this.settings.room = room;
    this.settings.mode = mode;
    this.settings.kit = this.selectedKit;
    saveSettings(this.settings);
    return { name, room, mode, kit: this.selectedKit };
  }

  setLobbyStatus(text, error = false) {
    const el = $('lobby-status');
    el.textContent = text;
    el.classList.toggle('error', !!error);
  }

  copyLink() {
    const { room, mode } = this.readLobby();
    const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}&mode=${mode}`;
    const copied = navigator.clipboard?.writeText(url);
    if (!copied) { this.setLobbyStatus(url); return; }
    copied.then(
      () => this.setLobbyStatus(`Invite link copied: ${url}`),
      () => this.setLobbyStatus(url),
    );
  }

  // -------------------------------------------------------------------------
  // Online session
  // -------------------------------------------------------------------------
  joinOnline() {
    if (this.net) return;
    const { name, room, mode, kit } = this.readLobby();
    this.audio.init();
    this.audio.setVolume(this.settings.volume);
    this.audio.setMuted(this.settings.muted);
    this.setLobbyStatus('Connecting to the server…');
    $('join').disabled = true;

    const net = new NetClient({ name, room, mode, kit, url: defaultUrl() });
    this.net = net;
    net.onStatus = (state, extra) => {
      if (state === 'connecting') this.setLobbyStatus('Connecting…');
      else if (state === 'reconnecting') {
        this.setLobbyStatus(`Reconnecting in ${Math.round((extra || 0) / 100) / 10}s…`);
        if (this.active) this.hud.showReconnect('CONNECTION LOST — RECONNECTING · P TO RETRY');
      } else if (state === 'joined-pending') this.setLobbyStatus('Joining room…');
      else if (state === 'disconnected') this.setLobbyStatus('Disconnected.', true);
      else if (state === 'error' && !this.active) {
        net.disconnect();
        if (this.net === net) this.net = null;
        $('join').disabled = false;
      }
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
    net.onProjectiles = ({ projectiles }) => this.effects?.syncProjectiles(projectiles);
    net.onVehicles = ({ vehicles }) => {
      if (!this.state) return;
      const combined = new Map((this.state.vehicles || []).map(v => [v.id, v]));
      for (const v of vehicles) combined.set(v.id, v);
      this.state.vehicles = [...combined.values()];
      this.syncVehicles(this.state.vehicles);
    };
    net.onChat = (msg) => this.hud.addChat(msg.name, msg.text, msg.team);
    net.connect();
  }

  onWelcome(msg) {
    this.activeKit = combatKit(msg.kit);
    this.localSnap = null;
    this.pendingShots.length = 0;
    this.localWeapons = msg.weapons?.slice(0, 2) || (msg.mode === 'tdm' ? ['ar', 'pistol'] : ['pistol', null]);
    this.input.clearHeld();
    this.localId = msg.playerId;
    this.hud.playerId = msg.playerId;
    this.mode = 'online';
    this.audio.setVolume(this.settings.volume);
    this.audio.setMuted(this.settings.muted);

    const first = !this.active;
    if (first) {
      this.setLobbyStatus('Generating the battlefield…');
      setTimeout(() => {
        this.buildSession(msg.mapSeed ?? CFG.MAP.SEED);
        this.finishBackdrop();
        this.active = true;
        this.input.enabled = true;
        document.activeElement?.blur();
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
    if (snap.ackInput !== null && snap.ackInput !== undefined) {
      this.pendingShots = this.pendingShots.filter(shot => shot.seq > snap.ackInput);
    }
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
    if (this.active || this.preparing) return;
    this.net?.disconnect(); this.net = null;
    this.preparing = true;
    const { name, mode, kit } = this.readLobby();
    this.audio.init();
    this.audio.setVolume(this.settings.volume);
    this.audio.setMuted(this.settings.muted);
    this.setLobbyStatus('Generating the battlefield…');
    setTimeout(() => {
      this.buildSession(CFG.MAP.SEED);
      this.finishBackdrop();
      const game = new Game({ mode, mapSeed: CFG.MAP.SEED, seed: 0x51f15e });
      this.offlineGame = game;
      const me = game.addPlayer(name, 0, { connected: true, kit });
      this.activeKit = kit;
      this.offlinePlayer = me;
      this.localId = me.id;
      this.hud.playerId = me.id;
      spawnBots(game, mode === 'tdm' ? 9 : 15, mode === 'tdm');
      game.begin();
      this.offlineInputs.clear();
      this.mode = 'offline';
      this.active = true;
      this.preparing = false;
      this.input.clearHeld();
      document.activeElement?.blur();
      this.input.enabled = true;
      this.localWeapons = me.weapons.slice();
      this.hud.setLobbyVisible(false);
      this.hud.notify('Offline training. Click the game to capture the mouse.');
    }, 30);
  }

  // -------------------------------------------------------------------------
  // Session construction / teardown
  // -------------------------------------------------------------------------
  buildSession(seed) {
    if (this.world && this.world.seed === seed) return;
    this.worldView?.dispose();
    this.effects?.dispose();
    this.viewmodel?.dispose();
    for (const view of this.characters.values()) view.dispose();
    for (const view of this.vehicleViews.values()) view.dispose();
    this.characters.clear(); this.vehicleViews.clear();
    this.world = new World(seed);
    this.worldView = new WorldRenderer(this.renderer, this.world);
    this.effects = new Effects(this.renderer, this.renderer.camera, this.world);
    this.audio.world = this.world;
    this.viewmodel = new ViewModel(this.renderer.camera, this.renderer.scene, this.renderer);
    this.prediction = new Prediction(this.world);
    this.hud.world = this.world;
    // Frame the camera somewhere sensible while the first snapshot lands.
    this.renderer.camera.position.set(0, 40, 0);
    if (this.state) this.syncState(this.state);
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
    if (this.hud.settingsOpen) {
      $('settings-resume').textContent = this.active ? 'RESUME OPERATION' : 'BACK TO DEPLOYMENT';
      $('settings-leave').classList.toggle('hidden', !this.active);
    }
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
    this.localDeath = null; this.deathEvents.clear(); this.hud.combat.reset();
    this.hud.combat.transition('NEW OPERATION');
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
    return !this.active || this.manualOpen || this.hud.chatOpen || this.hud.settingsOpen || this.endShown;
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
    if (lp && lp.alive && lp.grounded && !lp.inVehicle) {
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
    const pending = this.pendingShots.filter(shot => shot.weapon === this.currentWeaponKey()).length;
    return Math.max(0, (this.localSnap?.mag ?? 0) - pending);
  }

  detectLocalShot(input, blocked) {
    const wkey = this.currentWeaponKey();
    const W = wkey ? CFG.WEAPONS[wkey] : null;
    const player = this.getLocalPlayer();
    const wantFire = !blocked && input.shoot && W && player?.alive &&
      !input.reload && !input.grenade && !input.smoke && !input.heal && !input.cycle && input.slot < 0 &&
      this.state?.matchState === MATCH_STATE.LIVE && player.reloadT <= 0 && player.switchT <= 0 &&
      !(player.inVehicle && player.seat === 0);
    if (wantFire && this.localFireT <= 0 && (W.auto || !this.prevShoot)) {
      const mag = this.currentMag();
      this.localFireT = 60 / W.rpm;
      if (mag > 0) {
        this.localShot(wkey, W);
        if (this.mode === 'online') this.pendingShots.push({ seq: input.seq, weapon: wkey });
      }
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
      this.effects.muzzle([m.x, m.y, m.z], [d.x, d.y, d.z], W.pellets > 1 ? 1.2 : .9, this.viewmodel.model.muzzle);
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------
  handleEvents(events, selfId) {
    for (const ev of events) {
      switch (ev.k) {
        case 'shot': this.onShot(ev, selfId); break;
        case 'launch':
          this.effects?.launch(ev);
          if (ev.id !== selfId) { this.characters.get(ev.id)?.fire(); this.audio.shot(ev.w, ...ev.o); }
          break;
        case 'projectileend':
          this.effects?.stopProjectile(ev.projectileId);
          break;
        case 'hit': this.onHit(ev, selfId); break;
        case 'kill': {
          if (ev.death) this.deathEvents.set(ev.victim, ev.death);
          if (ev.victim === selfId) this.startDeath(ev);
          const names = new Map(this.names);
          if (ev.kname) names.set(ev.killer, ev.kname);
          if (ev.vname) names.set(ev.victim, ev.vname);
          this.hud.addKill(ev, names);
          if (ev.killer === selfId && ev.victim !== selfId) this.hud.combat.confirm(ev);
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
        case 'smokestart':
          if (ev.projectileId) this.effects?.stopProjectile(ev.projectileId);
          if (this.state) {
            this.state.smokes = [...(this.state.smokes || []).filter(s => s.id !== ev.projectileId),
              { id: ev.projectileId, x: ev.x, y: ev.y, z: ev.z, r: CFG.SMOKE.radius }];
            this.effects?.syncSmoke(this.state.smokes);
          }
          break;
        case 'smokeend':
          if (this.state) {
            this.state.smokes = (this.state.smokes || []).filter(s => s.id !== ev.projectileId);
            this.effects?.syncSmoke(this.state.smokes);
          }
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
          if (ev.lootId !== undefined) this.loot = this.loot.filter(item => item.id !== ev.lootId);
          if (ev.id === selfId) {
            this.audio.pickup();
            if (ev.weapons) this.localWeapons = ev.weapons.slice(0, 2);
            else if (ev.item === 'weapon' && ev.sub && !this.localWeapons.includes(ev.sub)) {
              const empty = this.localWeapons.indexOf(null);
              if (empty >= 0) this.localWeapons[empty] = ev.sub;
            }
          }
          break;
        case 'healstart':
          if (ev.id === selfId) { this.localHealItem = ev.item; this.audio.heal(); }
          break;
        case 'healed':
          if (ev.id === selfId) this.hud.notify(`Healed to ${ev.hp}`);
          break;
        case 'falldmg':
          if (ev.id === selfId) { this.audio.damage(); this.shake = Math.min(1.2, this.shake + 0.6); }
          break;
        case 'warmup':
          this.localDeath = null; this.deathEvents.clear(); this.hud.combat.reset();
          this.localWeapons = ev.mode === 'tdm' ? CFG.KITS[this.activeKit || 'assault'].weapons.slice() : ['pistol', null];
          this.pendingShots.length = 0;
          this.hud.notify(`Match starts in ${Math.ceil(ev.countdown)}s`);
          break;
        case 'live':
          this.hud.notify('MATCH LIVE');
          break;
        case 'respawn':
          this.deathEvents.delete(ev.id);
          if (ev.id === selfId) {
            this.localDeath = null; this.localWeapons = ev.weapons?.slice() || this.localWeapons;
            this.pendingShots.length = 0; this.hud.combat.reset(); this.hud.combat.transition('BACK IN THE FIGHT', 450);
            this.audio.ui('deploy');
          }
          break;
        case 'zone':
          if (ev.shrink) this.hud.notify('The zone is closing — move');
          break;
        case 'enterVehicle':
          if (ev.id === selfId) this.audio.pickup();
          break;
        case 'vehicleblocked':
          if (ev.id === selfId) this.hud.notify('EXIT BLOCKED — move the vehicle to clear space');
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
      const character = this.characters.get(ev.id);
      character?.fire();
      const anchor = character?.model.weapon.muzzle;
      const origin = anchor?.getWorldPosition(new THREE.Vector3()).toArray() || ev.o;
      this.effects?.shot({ ...ev, o: origin }, weapon, anchor);
      this.audio.shot(ev.w, ev.o[0], ev.o[1], ev.o[2]);
      // Crack of a round passing near the local player.
      const lp = this.getLocalPlayer();
      if (lp) {
        const d = Math.hypot(ev.o[0] - lp.x, ev.o[2] - lp.z);
        if (d < 45) this.audio.whiz(0);
      }
    } else if (this.effects && this.viewmodel) {
      const origin = this.viewmodel.muzzleWorld().toArray();
      for (let i = 0; i < (ev.e?.length || 0); i++) this.effects.tracer(origin, ev.e[i], weapon?.tracer, weapon?.pellets > 1 ? .009 : .014, ev.flight?.[i], weapon?.grav);
    }
    if (ev.imps && this.effects) {
      for (const im of ev.imps) {
        if (im.tid) continue;
        this.effects.impact({
          p: im.p, n: im.n || [0, 1, 0], tag: im.tag, mat: im.mat, bid: im.bid,
        }, im.at || 0);
      }
    }
  }

  onHit(ev, selfId) {
    this.characters.get(ev.to)?.hit(ev.dmg);
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
    for (const death of state.deaths || []) this.deathEvents.set(death.id, death);
    this.worldView?.syncDestruction(state.destroyed || []);
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
        view = new VehicleView(this.renderer.scene, v.id, v.type || 'car', this.renderer);
        this.vehicleViews.set(v.id, view);
      }
      view.applyState(v);
    }
    for (const [id, view] of this.vehicleViews) {
      if (seen.has(id)) continue;
      view.dispose();
      this.vehicleViews.delete(id);
    }
    this.world.vehicles = list.map(v => ({ ...v, pos: [v.x, v.y, v.z], vel: [v.vx || 0, v.vy || 0, v.vz || 0] }));
  }

  buildOfflineState() {
    const g = this.offlineGame;
    if (!g) return;
    this.state = {
      type: 'state', mode: g.mode, matchState: g.matchState, countdown: g.countdown,
      roundTime: g.roundTime, score: g.score.slice(),
      destroyed: [...g.destroyedBoxes],
      winner: g.winner ? { id: g.winner.id ?? null, team: g.winner.team ?? null, name: g.winner.name } : null,
      zone: {
        cx: +g.zone.cx.toFixed(1), cz: +g.zone.cz.toFixed(1), r: +g.zone.r.toFixed(1),
        phase: g.zone.phase, shrinking: g.zone.shrinking, dps: g.zone.dps,
        active: g.zone.active, phaseT: +g.zone.phaseT.toFixed(1),
      },
      vehicles: g.vehicles.map(packVehicle),
      smokes: g.smokes.map(s => ({ id: s.id, x: +s.x.toFixed(1), y: +s.y.toFixed(1), z: +s.z.toFixed(1), r: s.r })),
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
        stance: p.stance, grounded: p.grounded, inWater: p.inWater, swimming: !!p.swimming,
        alive: p.alive, hp: p.health, armor: p.armor,
        weapon: w, weapons: p.weapons.slice(), slot: p.curSlot,
        mag: inv ? inv.mag : 0, reserve: inv ? inv.reserve : 0,
        grenades: p.grenades, smokes: p.smokes, bandages: p.bandages, medkits: p.medkits,
        ads: !!p.adsing, inVehicle: p.inVehicle || 0, seat: p.seat,
        healT: p.healT, healItem: p.healItem,
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
      stance: pred.stance, grounded: pred.grounded, inWater: pred.inWater, swimming: !!pred.swimming,
      alive: snap.alive === undefined ? true : !!snap.alive, hp: snap.hp ?? 100, armor: snap.armor ?? 0,
      weapon: w, weapons: this.localWeapons.slice(), slot: snap.slot ?? 0,
      mag: this.currentMag(), reserve: snap.res ?? 0,
      grenades: snap.gren ?? 0, smokes: snap.smoke ?? 0,
      bandages: snap.band ?? 0, medkits: snap.med ?? 0,
      ads: this.input.mouse.right && pred.reloadT <= 0, inVehicle: snap.vehicle || 0, seat: snap.seat ?? -1,
      healT: pred.healT, healItem: this.localHealItem || null,
      reloadT: pred.reloadT, switchT: snap.switchT || 0,
      respawnIn: this.respawnIn(snap, pred),
      spread,
      cameraPos: pos,
    };
  }

  respawnIn(snap, pred) {
    if (snap.alive === undefined || snap.alive || this.state?.mode !== 'tdm') return 0;
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
    if (!this.active) { this.updateBackdrop(dt); this.renderer.render(dt); return; }
    const camera = this.renderer.camera;
    const lp = this.active ? this.getLocalPlayer() : null;
    if (lp && !lp.alive && !this.localDeath) this.startDeath({ kname: 'UNKNOWN', w: '?', pos: [lp.x, lp.y, lp.z] });
    if (lp && !lp.alive && this.localDeath) this.localDeath.seenDead = true;
    if (lp?.alive && this.localDeath?.seenDead) { this.localDeath = null; this.hud.combat.reset(); this.hud.combat.transition('REDEPLOYED', 450); }
    if (this.localDeath) this.localDeath.age += dt;
    const camLp = this.spectateCamera(lp);
    // Camera and chassis use the same rendered vehicle pose. A separately
    // smoothed car otherwise trails its driver by metres at driving speed.
    if (this.mode === 'offline') {
      const vehicles = this.offlineGame.vehicles.map(packVehicle);
      this.syncVehicles(vehicles);
      if (this.state) this.state.vehicles = vehicles;
    }
    for (const view of this.vehicleViews.values()) view.update(dt);

    // Third-person fallback / lobby idle camera.
    if (!camLp) {
      camera.position.set(0, 55, 0);
      camera.rotation.set(-0.5, this.time * 0.02, 0);
    } else {
      this.updateCamera(dt, camLp, camera);
    }
    if (this.localDeath && !lp?.alive && (this.localDeath.age < 1.1 || this.state?.mode === 'tdm')) this.updateDeathCamera(camera);

    // Local first-person weapon.
    this.audio.updateActions(lp);
    if (this.viewmodel) {
      const hide = !lp || !lp.alive || !lp.weapon || (lp.inVehicle && lp.seat === 0) || this.spectateId !== null;
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
        mag: lp?.mag ?? 0,
        swimming: lp?.swimming ?? false,
        switchT: lp?.switchT ?? 0,
        healT: lp?.healT ?? 0,
        hide: hide || this.uiBlocked(),
      });
      if (lp?.inVehicle && lp.seat === 0 && !this.uiBlocked() && lp.alive) {
        const vehicle = this.vehicleViews.get(lp.inVehicle);
        if (vehicle) this.viewmodel.drive(vehicle);
      }
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
          view = new CharacterView(this.renderer.scene, id, this.world, this.renderer);
          this.renderer.registerObject(view.model.root);
          this.characters.set(id, view);
        }
        view.applyState({
          ...p,
          name: this.names.get(id) || `#${id}`,
          team: this.teams.get(id) ?? p.team ?? 0,
          hp: p.hp,
          alive: !!p.alive,
          stance: p.stance,
          weapon: weaponKey(p.w),
          death: this.deathEvents.get(id),
        });
        view.visible = id !== this.spectateId;
        view.smokes = this.state?.smokes || [];
        view.vehicle = this.vehicleViews.get(p.vehicle) || null;
        view.vx = p.vx; view.vz = p.vz;
        view.update(dt, camPos);
        const spd = Math.hypot(p.vx || 0, p.vz || 0);
        if (p.alive && p.grounded && !p.vehicle && spd > 1.8) {
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
          view = new CharacterView(this.renderer.scene, p.id, this.world, this.renderer);
          this.renderer.registerObject(view.model.root);
          this.characters.set(p.id, view);
        }
        view.applyState({
          x: p.pos[0], y: p.pos[1], z: p.pos[2],
          yaw: p.yaw, pitch: p.pitch, stance: p.stance,
          hp: p.health, alive: p.alive, name: p.name, team: p.team,
          weapon: p.curWeapon(), reloadT: p.reloadT, inVehicle: p.inVehicle, seat: p.seat,
          mag: p.inv[p.curWeapon()]?.mag || 0,
          ads: !!p.adsing,
          death: p.death,
        });
        view.visible = p.id !== this.spectateId;
        view.smokes = this.state?.smokes || [];
        view.vehicle = this.vehicleViews.get(p.inVehicle) || null;
        view.vx = p.vel[0]; view.vz = p.vel[2];
        view.update(dt, camPos);
        const spd = Math.hypot(p.vel[0] || 0, p.vel[2] || 0);
        if (p.alive && p.grounded && !p.inVehicle && spd > 1.8) {
          this.audio.footstep(this.surfaceAt(p.pos[0], p.pos[1], p.pos[2]), spd, p.pos[0], p.pos[1], p.pos[2], p.id);
        }
      }
      for (const [id, view] of this.characters) {
        if (seen.has(id)) continue;
        view.dispose();
        this.characters.delete(id);
      }
    }

    // World animation and effects.
    this.worldView?.update(dt, this.time);
    if (this.worldView) this.worldView.syncLoot(this.loot);
    this.effects?.update(dt);

    this.updateHud(dt, lp, camLp);
    this.renderer.render(dt);
  }

  // While dead in BR, follow the player selected by the spectate rotation.
  spectateCamera(lp) {
    if (!lp) return null;
    if (lp.alive || this.spectateId === null || this.localDeath?.age < 1.1) return lp;
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
    const targetAds = lp.ads && !(lp.inVehicle && lp.seat === 0) && lp.reloadT <= 0 && lp.healT <= 0 ? 1 : 0;
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

    const eye = lp.inVehicle ? CFG.VEHICLE.eyeHeight : stanceEye(lp.stance);
    camera.position.set(
      lp.cameraPos[0] + bobX,
      lp.cameraPos[1] + eye + bobY,
      lp.cameraPos[2],
    );
    const vehicleView = lp.inVehicle ? this.vehicleViews.get(lp.inVehicle) : null;
    if (vehicleView) {
      const packet = this.state?.vehicles?.find(v => v.id === lp.inVehicle);
      const seat = lp.seat ?? 0;
      const forward = seat < 2 ? (packet?.type === 'truck' ? 1.05 : .15) : -.8;
      const side = seat % 2 === 0 ? .43 : -.43;
      const offset = new THREE.Vector3(side, .15 + eye, -forward);
      vehicleView.group.updateWorldMatrix(true, false);
      camera.position.copy(vehicleView.group.localToWorld(offset));
      if (this.spectateId === null) {
        if (this.cameraVehicle !== lp.inVehicle) {
          this.aimYaw = vehicleView.yaw; this.aimPitch = -.015;
        } else {
          this.aimYaw += Math.atan2(Math.sin(vehicleView.yaw - this.cameraVehicleYaw), Math.cos(vehicleView.yaw - this.cameraVehicleYaw));
        }
        this.cameraVehicle = lp.inVehicle; this.cameraVehicleYaw = vehicleView.yaw;
        lp.yaw = this.aimYaw; lp.pitch = this.aimPitch;
      }
    } else this.cameraVehicle = null;
    const shakePitch = (Math.random() - 0.5) * 0.01 * this.shake;
    const shakeYaw = (Math.random() - 0.5) * 0.01 * this.shake;
    camera.rotation.set(lp.pitch + shakePitch, lp.yaw + shakeYaw, vehicleView ? vehicleView.roll * .35 : 0);

    this.audio.setListener([camera.position.x, camera.position.y, camera.position.z], lp.yaw);
    this.renderer.setUnderwater(this.world.waterDepth(camera.position.x, camera.position.z) > 0 && camera.position.y < this.world.lake.level - .025);
    const closestVehicle = (this.state?.vehicles || []).filter(v => v.health > 0 && v.occupants?.[0] != null)
      .sort((a, b) => Math.hypot(a.x - lp.x, a.z - lp.z) - Math.hypot(b.x - lp.x, b.z - lp.z))[0];
    this.audio.vehicleLoop?.(closestVehicle);
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
    const outside = this.state?.mode === 'br' && !!z && lp.alive && Math.hypot(lp.x - z.cx, lp.z - z.cz) > z.r;
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
    if (lp.inVehicle) return '';
    const feet = [lp.x, lp.y, lp.z], eye = stanceEye(lp.stance);
    let nearVehicle = null, vehicleDistance = CFG.VEHICLE.enterRange;
    for (const v of this.state?.vehicles || []) {
      const distance = Math.hypot(v.x - lp.x, v.z - lp.z);
      if (distance < vehicleDistance && vehicleInReach(this.world, feet, eye, v)) { nearVehicle = v; vehicleDistance = distance; }
    }
    const loot = this.loot;
    if (loot) {
      let best = null, bd = CFG.LOOT.pickupRange;
      for (const it of loot) {
        const d = Math.hypot(it.x - lp.x, it.z - lp.z);
        if (d < bd && canPickupLoot(lp, it) && lootInReach(this.world, feet, eye, it)) { bd = d; best = it; }
      }
      if (best && (!nearVehicle || bd <= vehicleDistance)) {
        const label = best.type === 'weapon' ? (WEAPON_LABEL[best.weapon] || 'WEAPON')
          : best.type === 'ammo' ? 'AMMO'
            : best.type === 'armor' ? 'ARMOUR'
              : best.type === 'heal' || best.type === 'med' ? (best.sub === 'medkit' ? 'MEDKIT' : 'BANDAGE')
                : best.type === 'grenade' ? (best.sub === 'smoke' ? 'SMOKE' : 'FRAG') : best.type.toUpperCase();
        return `E · PICK UP ${label}`;
      }
    }
    if (nearVehicle) return `E · ENTER ${nearVehicle.type === 'truck' ? 'TRANSPORT' : 'UTILITY'}`;
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
    if (this.state?.mode !== 'br' || this.localDeath?.age < 1.1) return;
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

  startDeath(event) {
    if (this.localDeath) return;
    const camera = this.renderer.camera;
    this.localDeath = { age: 0, seenDead: false, position: camera.position.clone(), pitch: camera.rotation.x, yaw: camera.rotation.y,
      feet: event.pos || [camera.position.x, camera.position.y - 1.64, camera.position.z],
      side: event.death?.direction?.[0] < 0 ? -1 : 1 };
    this.input.clearHeld(); this.audio.death(); this.hud.combat.eliminated(event);
  }

  updateDeathCamera(camera) {
    const death = this.localDeath;
    const t = clamp(death.age / .9, 0, 1), ease = t * t * (3 - 2 * t);
    const ground = this.world.terrainHeight(death.feet[0], death.feet[2]);
    camera.position.copy(death.position);
    camera.position.y += (Math.max(ground + .3, death.feet[1] + .28) - death.position.y) * ease;
    camera.rotation.set(death.pitch * (1 - ease) + .08 * ease, death.yaw, death.side * .38 * ease);
    this.audio.setListener(camera.position.toArray(), death.yaw);
  }

  // -------------------------------------------------------------------------
  // Window wiring
  // -------------------------------------------------------------------------
  bindWindow() {
    addEventListener('resize', () => this.renderer.resize());
    addEventListener('keydown', (e) => {
      if (this.manualOpen) {
        if (e.code === 'Escape') { e.preventDefault(); this.toggleManual(false); }
        if (e.code === 'Tab') this.trapModalFocus(e, $('manual-panel'));
        return;
      }
      if (this.hud.settingsOpen && e.code === 'Tab') {
        this.trapModalFocus(e, $('settings-panel'));
        return;
      }
      if (e.repeat) return;
      if (e.code === 'Tab') {
        if (this.active && !this.uiBlocked()) { e.preventDefault(); this.hud.toggleScoreboard(true); }
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

  trapModalFocus(e, root) {
    const items = [...root.querySelectorAll('button:not(:disabled), input, select, [tabindex="0"]')];
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
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
