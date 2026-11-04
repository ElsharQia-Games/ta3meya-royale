// ============================================================================
// Authoritative game simulation. Fixed 60 Hz. Shared by client (prediction)
// and server (truth). No DOM, no rendering, no network I/O.
// ============================================================================
import { CFG, STANCE, MATCH_STATE, TEAMS } from './config.js';
import { RNG, clamp, yawTo, TAU, lerp } from './math.js';
import { World } from './world.js';
import { movePlayer, stanceHeight, stanceEye, supportHeight } from './physics.js';
import {
  tryFire, tryReload, finishReload, switchWeapon, throwGrenade, stepProjectiles,
  tryInteract, spawnWorldLoot, dropInventory, hitboxesFor, applyDamage, explode,
} from './weapons.js';

export function emptyInput() {
  return {
    f: false, b: false, l: false, r: false, jump: false, sprint: false, ads: false,
    shoot: false, reload: false, grenade: false, smoke: false, heal: false, interact: false,
    slot: -1, cycle: false, stance: null, enterVehicle: undefined,
    yaw: 0, pitch: 0, seq: 0, viewTime: 0,
  };
}

export class Player {
  constructor(id, name, team = 0) {
    this.id = id;
    this.name = name;
    this.team = team;
    this.pos = [0, 0, 0];
    this.vel = [0, 0, 0];
    this.yaw = 0; this.pitch = 0;
    this.health = CFG.PLAYER.MAX_HEALTH;
    this.armor = 0;
    this.alive = true;
    this.stance = STANCE.STAND;
    this.stanceT = 1;
    this.grounded = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.sprinting = false;
    this.adsing = false;
    this.inWater = false;
    this.swimming = false;
    this.fallImpact = 0;
    this.pendingFallDamage = 0;
    this.weapons = [null, null];
    this.inv = {};
    this.curSlot = 0;
    this.switchT = 0;
    this.reloadT = 0;
    this.reloadKey = null;
    this.cooldown = 0;
    this.heat = 0;
    this.prevShoot = false;
    this.grenades = 0;
    this.smokes = 0;
    this.bandages = 0;
    this.medkits = 0;
    this.healT = 0;
    this.healItem = null;
    this.kills = 0; this.deaths = 0;
    this.damageDealt = 0;
    this.lastAttacker = null;
    this.lastDamageAt = -999;
    this.respawnAt = 0;
    this.inVehicle = null;
    this.seat = -1;
    this.isBot = false;
    this.bot = null;
    this.connected = true;
    this.ping = 0;
    this.spectate = null;
    this.zoneT = 0;
  }
  height() { return stanceHeight(this.stance); }
  eyeHeight() { return stanceEye(this.stance); }
  curWeapon() { return this.weapons[this.curSlot]; }
  hasWeapon() { return !!this.curWeapon(); }
  giveLoadout(loadout) {
    this.weapons = [null, null]; this.inv = {};
    loadout.forEach((w, i) => {
      if (i > 1 || !w) return;
      this.weapons[i] = w;
      this.inv[w] = { mag: CFG.WEAPONS[w].mag, reserve: CFG.WEAPONS[w].reserve };
    });
    this.curSlot = this.weapons[0] ? 0 : 1;
    this.switchT = 0;
  }
}

export class Vehicle {
  constructor(id, x, z, yaw = 0, type = 'car') {
    this.id = id;
    this.pos = [x, 0, z];
    this.vel = [0, 0, 0];
    this.yaw = yaw;
    this.steer = 0;
    this.type = type;
    this.health = CFG.VEHICLE.health;
    this.occupants = [null, null, null, null];
    this.pitch = 0; this.roll = 0;
    this.wheelSpin = 0;
    this.engine = 0;
    this.braking = false;
    this.wheelComp = [0, 0, 0, 0];
    this.airTime = 0;
    this.lastDriverInput = null;
  }
}

export class Game {
  constructor(opts = {}) {
    this.mapSeed = opts.mapSeed ?? CFG.MAP.SEED;
    this.world = new World(this.mapSeed);
    this.rng = new RNG((opts.seed ?? 1337) ^ 0x5f3759df);
    this.players = new Map();
    this.vehicles = [];
    this.projectiles = [];
    this.pendingDamage = [];
    this.loot = [];
    this.events = [];
    this.time = 0;
    this.tick = 0;
    this.mode = opts.mode || 'br';
    this.matchState = MATCH_STATE.LOBBY;
    this.countdown = 0;
    this.roundTime = 0;
    this.winner = null;
    this.score = [0, 0];
    this.nextId = 1;
    this.zone = {
      cx: 0, cz: 0, r: CFG.ZONE.initialRadius, phase: 0, phaseT: 0,
      shrinking: false, fromR: CFG.ZONE.initialRadius, targetR: CFG.ZONE.initialRadius,
      dps: 1, active: false,
    };
    this.lootDirty = true;
    this.destroyedBoxes = new Set();
    this.smokes = [];
    this.stats = { shots: 0, hits: 0, kills: 0, damage: 0 };
  }

  // --------------------------------------------------------------------------
  // Players
  // --------------------------------------------------------------------------
  addPlayer(name, team = 0, opts = {}) {
    const id = this.nextId++;
    const p = new Player(id, name, team);
    p.isBot = !!opts.bot;
    p.connected = opts.connected !== false;
    this.players.set(id, p);
    this.spawnPlayer(p, opts.forceSpawn);
    if (this.mode === 'tdm') {
      p.giveLoadout(['ar', 'pistol']);
      p.armor = 50;
      p.grenades = 1; p.bandages = 2;
    } else {
      p.giveLoadout(['pistol', null]);
      p.bandages = 1;
    }
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (p && p.inVehicle) this.exitVehicle(p, true);
    this.players.delete(id);
    this.lootDirty = true;
  }

  spawnPlayer(p, force = null) {
    let s = force;
    if (!s) {
      if (this.mode === 'tdm') {
        const arr = this.world.teamSpawns[p.team] || this.world.teamSpawns[0];
        s = arr.length ? arr[Math.floor(this.rng.next() * arr.length)] : { x: 0, z: 0 };
      } else {
        const arr = this.world.spawnPoints;
        // Prefer spawns inside the current/initial circle.
        for (let tries = 0; tries < 24; tries++) {
          const cand = arr[Math.floor(this.rng.next() * arr.length)];
          if (Math.hypot(cand.x - this.zone.cx, cand.z - this.zone.cz) < this.zone.r * 0.9) { s = cand; break; }
        }
        if (!s) s = arr[0] || { x: 0, z: 0 };
      }
    }
    p.pos = [s.x, this.world.terrainHeight(s.x, s.z) + 0.1, s.z];
    p.vel = [0, 0, 0];
    p.health = CFG.PLAYER.MAX_HEALTH;
    p.alive = true;
    p.stance = STANCE.STAND;
    p.grounded = false;
    p.inVehicle = null; p.seat = -1;
    p.yaw = this.rng.next() * TAU;
    p.pitch = 0;
    p.cooldown = 0; p.reloadT = 0; p.reloadKey = null; p.switchT = 0;
    p.healT = 0; p.healItem = null;
    p.lastDamageAt = -999;
    p.zoneT = 0;
    p.fallImpact = 0; p.pendingFallDamage = 0;
    p.prevShoot = false;
    p.respawnAt = 0;
  }

  begin() {
    if (this.matchState !== MATCH_STATE.LOBBY && this.matchState !== MATCH_STATE.ENDED) return;
    this.matchState = MATCH_STATE.WARMUP;
    this.countdown = CFG.MODES[this.mode]?.startCountdown ?? 8;
    this.roundTime = 0;
    this.winner = null;
    this.score = [0, 0];
    this.zone = {
      cx: 0, cz: 0, r: CFG.ZONE.initialRadius, phase: 0, phaseT: 0,
      shrinking: false, fromR: CFG.ZONE.initialRadius, targetR: CFG.ZONE.initialRadius,
      dps: 1, active: false,
    };
    this.loot.length = 0;
    this.projectiles.length = 0;
    this.pendingDamage.length = 0;
    this.smokes.length = 0;
    this.stats = { shots: 0, hits: 0, kills: 0, damage: 0 };
    this.destroyedBoxes.clear();
    for (const b of this.world.boxes) b.destroyed = false;
    for (const p of this.players.values()) {
      this.spawnPlayer(p);
      if (this.mode === 'tdm') {
        p.giveLoadout(['ar', 'pistol']);
        p.armor = 50; p.grenades = 1; p.bandages = 2;
      } else {
        p.giveLoadout(['pistol', null]);
        p.armor = 0; p.grenades = 0; p.bandages = 1;
      }
      p.kills = 0; p.deaths = 0; p.damageDealt = 0;
    }
    this.spawnVehicles();
    this.events.push({ k: 'warmup', countdown: this.countdown, mode: this.mode });
  }

  spawnVehicles() {
    this.vehicles.length = 0;
    for (const s of this.world.vehicleSpawns) {
      const v = new Vehicle(this.nextId++, s.x, s.z, s.yaw, s.type);
      v.pos[1] = this.world.terrainHeight(s.x, s.z) + 0.65;
      this.vehicles.push(v);
    }
  }

  // --------------------------------------------------------------------------
  // Main step
  // --------------------------------------------------------------------------
  step(inputs, dt = CFG.SIM_DT, opts = {}) {
    this.time += dt;
    this.tick++;

    if (this.matchState === MATCH_STATE.WARMUP) {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.matchState = MATCH_STATE.LIVE;
        this.roundTime = 0;
        this.zone.active = true;
        this.zone.phaseT = 0;
        this.spawnWorldLootNow();
        this.events.push({ k: 'live', mode: this.mode });
      }
    } else if (this.matchState === MATCH_STATE.LIVE) {
      this.roundTime += dt;
    }

    const fireTargets = opts.fireTargets || null;
    const cosmetic = !!opts.cosmetic;
    for (const [id, p] of this.players) {
      const input = inputs.get(id) || null;
      if (p.alive && p.connected) this.stepPlayer(p, input, dt, {
        targets: fireTargets ? fireTargets.get(id) : null,
        cosmetic,
      });
      else if (p.alive && !p.connected) {
        // disconnected players freeze but still collide with the world
        p.vel[0] *= 0.8; p.vel[2] *= 0.8;
      }
    }

    for (const v of this.vehicles) this.stepVehicle(v, inputs, dt);
    stepProjectiles(this, dt);
    this.stepPendingDamage();
    this.stepSmokes(dt);
    if (this.matchState === MATCH_STATE.LIVE) {
      if (this.mode === 'br') this.stepZone(dt);
      this.stepRespawns();
      this.checkMatchEnd();
    }
    // prune old events (safety)
    if (this.events.length > 4000) this.events.splice(0, this.events.length - 4000);
  }

  stepPlayer(p, input, dt, opts = {}) {
    if (!input) input = emptyInput();
    // timers
    p.cooldown = Math.max(0, p.cooldown - dt);
    p.switchT = Math.max(0, p.switchT - dt);
    p.heat = Math.max(0, p.heat - dt * 1.35);
    if (p.reloadT > 0) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) finishReload(p);
    }
    if (p.healT > 0) {
      p.healT -= dt;
      if (p.healT <= 0) {
        const def = CFG.HEAL[p.healItem] || CFG.HEAL.bandage;
        p.health = Math.min(def.cap, p.health + def.amount);
        this.events.push({ k: 'healed', id: p.id, hp: Math.round(p.health) });
        p.healItem = null;
      }
    }

    if (p.inVehicle) {
      p.vel = [0, 0, 0];
      p.yaw = input.yaw; p.pitch = input.pitch;
      p.adsing = !!input.ads;
      // passengers can shoot from vehicles (except driver for now)
      this.handleActions(p, input, opts);
      return;
    }

    p.yaw = input.yaw;
    p.pitch = clamp(input.pitch, -CFG.PLAYER.MAX_PITCH, CFG.PLAYER.MAX_PITCH);
    // Stance changes are validated inside the controller (headroom checks).
    movePlayer(this.world, p, input, dt);
    p.pos[1] = Math.max(p.pos[1], this.world.terrainHeight(p.pos[0], p.pos[2]) - 0.4);

    // fall damage accumulated by the controller
    if (p.pendingFallDamage > 0) {
      const dmg = p.pendingFallDamage;
      p.pendingFallDamage = 0;
      if (this.matchState === MATCH_STATE.LIVE && dmg > 0) {
        applyDamage(this, p, dmg, p.lastAttacker ?? -1, 'fall', p.pos, 'fall');
        this.events.push({ k: 'falldmg', id: p.id, dmg });
      }
    }

    // health regeneration out of combat
    if (p.alive && this.matchState === MATCH_STATE.LIVE && p.health < CFG.PLAYER.MAX_HEALTH &&
      this.time - p.lastDamageAt > CFG.PLAYER.HEALTH_REGEN_DELAY && p.healT <= 0) {
      p.health = Math.min(CFG.PLAYER.MAX_HEALTH, p.health + CFG.PLAYER.HEALTH_REGEN_RATE * dt);
    }

    this.handleActions(p, input, opts);
  }

  handleActions(p, input, opts = {}) {
    const key = p.curWeapon();
    // weapon switch
    if (input.slot === 0 || input.slot === 1) switchWeapon(this, p, input.slot);
    else if (input.cycle) switchWeapon(this, p, p.curSlot === 0 ? 1 : 0);

    // reload
    if (input.reload) tryReload(this, p);

    // healing
    if (input.heal && p.healT <= 0 && p.health < CFG.PLAYER.MAX_HEALTH) {
      if (p.bandages > 0 && p.health < CFG.HEAL.bandage.cap) {
        p.bandages--; p.healT = CFG.HEAL.bandage.time; p.healItem = 'bandage';
        this.events.push({ k: 'healstart', id: p.id, item: 'bandage' });
      } else if (p.medkits > 0) {
        p.medkits--; p.healT = CFG.HEAL.medkit.time; p.healItem = 'medkit';
        this.events.push({ k: 'healstart', id: p.id, item: 'medkit' });
      }
    }

    // interact (loot / vehicle)
    if (input.interact) tryInteract(this, p);

    // grenades
    if (input.grenade) throwGrenade(this, p, false);
    if (input.smoke) throwGrenade(this, p, true);

    // vehicle entry/exit
    if (input.enterVehicle !== undefined && input.enterVehicle !== null) {
      if (input.enterVehicle === -1) { if (p.inVehicle) this.exitVehicle(p); }
      else {
        const v = this.vehicles.find(vv => vv.id === input.enterVehicle);
        if (v) this.enterVehicle(p, v);
      }
    }

    // shooting
    if (key && p.alive && this.matchState === MATCH_STATE.LIVE) {
      const W = CFG.WEAPONS[key];
      const wantFire = W.auto ? input.shoot : (input.shoot && !p.prevShoot);
      if (wantFire) {
        const targets = opts.targets || this.buildTargets();
        tryFire(this, p, input, targets, { rng: this.rng, cosmetic: opts.cosmetic });
        if (opts.cosmetic) this.pendingDamage.length = 0;
      }
    }
    p.prevShoot = !!input.shoot;
  }

  // --------------------------------------------------------------------------
  // Damage / kills / respawn
  // --------------------------------------------------------------------------
  stepPendingDamage() {
    if (!this.pendingDamage.length) return;
    for (let i = this.pendingDamage.length - 1; i >= 0; i--) {
      const d = this.pendingDamage[i];
      if (this.time < d.at) continue;
      this.pendingDamage.splice(i, 1);
      const victim = this.players.get(d.victimId);
      const attacker = this.players.get(d.attackerId);
      if (!victim || !victim.alive) continue;
      if (attacker && attacker.id !== victim.id) attacker.damageDealt += d.amount;
      applyDamage(this, victim, d.amount, d.attackerId, d.zone, d.point, d.weapon, d.dist);
      this.stats.hits++;
      this.stats.damage += d.amount;
    }
  }

  kill(victim, killerId, weapon = '?', zone = 'torso', dist = 0) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.health = 0;
    victim.deaths++;
    const killer = this.players.get(killerId);
    if (killer && killer.id !== victim.id) killer.kills++;
    if (this.mode === 'tdm') {
      this.score[victim.team === 0 ? 1 : 0]++;
      victim.respawnAt = this.time + CFG.MODES.tdm.respawn;
    }
    dropInventory(this, victim);
    this.stats.kills++;
    this.events.push({
      k: 'kill', victim: victim.id, killer: killerId, vname: victim.name,
      kname: killer ? killer.name : (killerId === -1 ? 'ZONE' : '?'),
      w: weapon, zone, dist: Math.round(dist), team: victim.team, kteam: killer ? killer.team : -1,
    });
  }

  stepRespawns() {
    if (this.mode !== 'tdm') return;
    for (const p of this.players.values()) {
      if (!p.alive && p.respawnAt && this.time >= p.respawnAt) {
        this.spawnPlayer(p);
        p.health = CFG.PLAYER.MAX_HEALTH;
        p.armor = 50;
        p.giveLoadout(['ar', 'pistol']);
        p.grenades = 1; p.bandages = 2;
        this.events.push({ k: 'respawn', id: p.id });
      }
    }
  }

  checkMatchEnd() {
    if (this.matchState !== MATCH_STATE.LIVE) return;
    if (this.mode === 'br') {
      const alive = [...this.players.values()].filter(p => p.alive);
      if (alive.length <= 1 && this.players.size > 1) {
        this.matchState = MATCH_STATE.ENDED;
        this.winner = alive[0] || null;
        this.events.push({ k: 'matchend', mode: 'br', winner: this.winner ? this.winner.id : -1, wname: this.winner ? this.winner.name : 'NOBODY' });
      }
    } else if (this.mode === 'tdm') {
      if (this.score[0] >= CFG.MODES.tdm.scoreLimit || this.score[1] >= CFG.MODES.tdm.scoreLimit || this.roundTime >= CFG.MODES.tdm.timeLimit) {
        this.matchState = MATCH_STATE.ENDED;
        this.winner = this.score[0] === this.score[1] ? null : (this.score[0] > this.score[1] ? { team: 0, name: TEAMS[0].name } : { team: 1, name: TEAMS[1].name });
        this.events.push({ k: 'matchend', mode: 'tdm', winner: this.winner ? this.winner.team : -1, wname: this.winner ? this.winner.name : 'DRAW', score: this.score });
      }
    }
  }

  // --------------------------------------------------------------------------
  // Zone
  // --------------------------------------------------------------------------
  stepZone(dt) {
    const Z = CFG.ZONE;
    const z = this.zone;
    z.active = true;
    if (z.phase >= Z.phases.length) {
      // final zone holds
      z.r = Z.phases[Z.phases.length - 1].r;
    } else {
      z.phaseT += dt;
      const ph = Z.phases[z.phase];
      z.dps = ph.dps;
      if (!z.shrinking) {
        if (z.phaseT >= ph.wait) {
          z.shrinking = true; z.phaseT = 0;
          z.fromR = z.r; z.targetR = ph.r;
          // pick a new centre inside the current circle
          const maxOff = Math.max(0, z.r - ph.r) * 0.72;
          const a = this.rng.next() * TAU, r = Math.sqrt(this.rng.next()) * maxOff;
          z.cx += Math.cos(a) * r; z.cz += Math.sin(a) * r;
          this.events.push({ k: 'zone', phase: z.phase, shrink: true, r: ph.r, cx: z.cx, cz: z.cz, wait: 0, dps: ph.dps });
        }
      } else {
        const k = clamp(z.phaseT / ph.shrink, 0, 1);
        z.r = lerp(z.fromR, z.targetR, k * k * (3 - 2 * k));
        if (k >= 1) {
          z.r = z.targetR;
          z.shrinking = false;
          z.phaseT = 0;
          z.phase++;
          if (z.phase < Z.phases.length) {
            this.events.push({ k: 'zone', phase: z.phase, shrink: false, r: z.r, cx: z.cx, cz: z.cz, wait: Z.phases[z.phase].wait, dps: Z.phases[z.phase].dps });
          }
        }
      }
    }
    // damage outside
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.pos[0] - z.cx, p.pos[2] - z.cz);
      if (d > z.r) {
        p.health -= z.dps * dt;
        p.lastDamageAt = this.time;
        p.lastAttacker = -1;
        p.zoneT += dt;
        if (p.health <= 0) this.kill(p, -1, 'zone', 'torso', 0);
      } else p.zoneT = 0;
    }
  }

  // --------------------------------------------------------------------------
  // Vehicles (raycast suspension, simplified 6-DOF)
  // --------------------------------------------------------------------------
  enterVehicle(p, v) {
    if (p.inVehicle) return false;
    const seat = v.occupants.findIndex(o => o === null);
    if (seat < 0) return false;
    if (Math.hypot(v.pos[0] - p.pos[0], v.pos[2] - p.pos[2]) > CFG.VEHICLE.enterRange) return false;
    v.occupants[seat] = p.id;
    p.inVehicle = v.id; p.seat = seat;
    p.vel = [0, 0, 0];
    this.events.push({ k: 'enterVehicle', id: p.id, vid: v.id, seat });
    return true;
  }

  exitVehicle(p, silent = false) {
    if (!p.inVehicle) return;
    const v = this.vehicles.find(vv => vv.id === p.inVehicle);
    if (v) {
      const seat = v.occupants.indexOf(p.id);
      if (seat >= 0) v.occupants[seat] = null;
      const right = [Math.cos(v.yaw), 0, -Math.sin(v.yaw)];
      const side = seat % 2 === 0 ? 1.8 : -1.8;
      p.pos = [v.pos[0] + right[0] * side, this.world.terrainHeight(v.pos[0] + right[0] * side, v.pos[2] + right[2] * side) + 0.1, v.pos[2] + right[2] * side];
      p.vel = [v.vel[0] * 0.3, 0, v.vel[2] * 0.3];
    }
    p.inVehicle = null; p.seat = -1;
    if (!silent) this.events.push({ k: 'exitVehicle', id: p.id, vid: v ? v.id : -1 });
  }

  stepVehicle(v, inputs, dt) {
    const V = CFG.VEHICLE;
    const driverId = v.occupants[0];
    const driver = driverId ? this.players.get(driverId) : null;
    const input = driver ? inputs.get(driverId) : null;
    if (driver) driver.lastVehicleInput = input;
    const forward = [-Math.sin(v.yaw), 0, -Math.cos(v.yaw)];
    const right = [Math.cos(v.yaw), 0, -Math.sin(v.yaw)];

    // Steering
    let steerTarget = 0;
    if (input) {
      if (input.l) steerTarget += 1;
      if (input.r) steerTarget -= 1;
    }
    v.steer += (steerTarget - v.steer) * Math.min(1, 6 * dt);
    const speed = Math.hypot(v.vel[0], v.vel[2]);
    const speedFactor = clamp(speed / 8, 0, 1);
    v.yaw += v.steer * V.steerMax * speedFactor * Math.sign(Math.max(0.1, v.vel[0] * forward[0] + v.vel[2] * forward[2])) * dt * 3.2;

    // Engine / brake
    const fwdSpeed = v.vel[0] * forward[0] + v.vel[2] * forward[2];
    let accel = 0;
    v.braking = false;
    if (input && input.f) accel = V.engineForce;
    else if (input && input.b) {
      if (fwdSpeed > 1) { accel = -V.brakeForce; v.braking = true; }
      else accel = -V.engineForce * 0.45;
    }
    v.engine += (accel - v.engine) * Math.min(1, 8 * dt);
    v.vel[0] += forward[0] * (v.engine / V.mass) * dt;
    v.vel[2] += forward[2] * (v.engine / V.mass) * dt;

    // Lateral grip
    const lat = v.vel[0] * right[0] + v.vel[2] * right[2];
    v.vel[0] -= right[0] * lat * Math.min(1, V.grip * dt);
    v.vel[2] -= right[2] * lat * Math.min(1, V.grip * dt);
    // Drag
    const drag = 1 - Math.min(0.6, V.drag * dt * (0.4 + speed / V.maxSpeed));
    v.vel[0] *= drag; v.vel[2] *= drag;
    // Speed cap
    if (speed > V.maxSpeed) { const k = V.maxSpeed / speed; v.vel[0] *= k; v.vel[2] *= k; }

    // Wheel suspension: 4 raycasts.
    const wheelPositions = [
      [V.wheelBase / 2, V.track / 2], [V.wheelBase / 2, -V.track / 2],
      [-V.wheelBase / 2, V.track / 2], [-V.wheelBase / 2, -V.track / 2],
    ];
    let totalSpring = 0, frontSpring = 0, backSpring = 0, leftSpring = 0, rightSpring = 0;
    let groundCount = 0;
    for (let i = 0; i < 4; i++) {
      const [fz, rx] = wheelPositions[i];
      const wx = v.pos[0] + forward[0] * fz + right[0] * rx;
      const wz = v.pos[2] + forward[2] * fz + right[2] * rx;
      const ground = this.vehicleGround(wx, wz, v.pos[1] + 0.7);
      const rayLen = 1.15;
      let comp = 0;
      if (ground !== null && v.pos[1] + 0.7 - ground < rayLen) {
        const dist = v.pos[1] + 0.7 - ground;
        comp = clamp(V.suspensionRest - (dist - V.wheelRadius), -0.12, 0.42);
        groundCount++;
      }
      v.wheelComp[i] = comp;
      const spring = comp * V.suspensionK;
      totalSpring += spring;
      if (i < 2) frontSpring += spring; else backSpring += spring;
      if (i % 2 === 0) rightSpring += spring; else leftSpring += spring;
      v.wheelSpin += (fwdSpeed / V.wheelRadius) * dt;
    }
    // Vertical dynamics
    const gravity = -9.81 * V.mass;
    const damping = -v.vel[1] * V.suspensionD;
    v.vel[1] += ((totalSpring + gravity + damping) / V.mass) * dt;
    if (groundCount === 0) v.airTime += dt; else v.airTime = 0;
    v.pos[1] += v.vel[1] * dt;
    // terrain/box floor clamp
    const floor = this.vehicleGround(v.pos[0], v.pos[2], v.pos[1] + 0.7);
    if (floor !== null && v.pos[1] < floor + 0.35) {
      v.pos[1] = floor + 0.35;
      if (v.vel[1] < 0) v.vel[1] *= -0.15;
    }

    // Pitch/roll visual from suspension
    const targetPitch = clamp((frontSpring - backSpring) / (V.suspensionK * 0.6), -0.22, 0.22);
    const targetRoll = clamp((rightSpring - leftSpring) / (V.suspensionK * 0.6), -0.22, 0.22);
    v.pitch += (targetPitch - v.pitch) * Math.min(1, 8 * dt);
    v.roll += (targetRoll - v.roll) * Math.min(1, 8 * dt);

    // Horizontal integration + collision
    const px = v.pos[0], pz = v.pos[2];
    v.pos[0] += v.vel[0] * dt;
    v.pos[2] += v.vel[2] * dt;
    this.collideVehicle(v);
    // crude collision response
    if (Math.abs(v.pos[0] - px) < Math.abs(v.vel[0] * dt) * 0.5) v.vel[0] *= -0.15;
    if (Math.abs(v.pos[2] - pz) < Math.abs(v.vel[2] * dt) * 0.5) v.vel[2] *= -0.15;

    // Auto-right if badly tilted (arcade forgiveness)
    if (Math.abs(v.roll) > 1.1) v.roll *= 0.9;

    // Carry occupants
    for (let i = 0; i < v.occupants.length; i++) {
      const pid = v.occupants[i];
      if (!pid) continue;
      const occ = this.players.get(pid);
      if (!occ) continue;
      const seatF = i === 0 ? 0.15 : i === 1 ? -0.25 : i === 2 ? -0.7 : -0.9;
      const seatR = i % 2 === 0 ? 0.34 : -0.34;
      occ.pos = [
        v.pos[0] + forward[0] * seatF + right[0] * seatR,
        v.pos[1] + 0.15,
        v.pos[2] + forward[2] * seatF + right[2] * seatR,
      ];
      occ.vel = [v.vel[0], v.vel[1], v.vel[2]];
      occ.grounded = false;
      // The driver/passengers keep their own look direction (set from input).
    }
  }

  vehicleGround(x, z, fromY) {
    let g = this.world.terrainHeight(x, z);
    const boxes = this.world.queryBoxes(x - 1, z - 1, x + 1, z + 1);
    for (const b of boxes) {
      if (b.destroyed || b.tag === 'glass') continue;
      const top = b.max[1];
      if (top <= fromY && top > fromY - 3 && top > g) {
        if (x > b.min[0] - 0.3 && x < b.max[0] + 0.3 && z > b.min[2] - 0.3 && z < b.max[2] + 0.3) g = top;
      }
    }
    return g;
  }

  collideVehicle(v) {
    const r = 1.15;
    const boxes = this.world.queryBoxes(v.pos[0] - r - 1, v.pos[2] - r - 1, v.pos[0] + r + 1, v.pos[2] + r + 1);
    for (const b of boxes) {
      if (b.destroyed || b.tag === 'glass' || b.tag === 'void') continue;
      if (v.pos[1] + 1.4 < b.min[1] || v.pos[1] > b.max[1]) continue;
      const cx = clamp(v.pos[0], b.min[0], b.max[0]);
      const cz = clamp(v.pos[2], b.min[2], b.max[2]);
      const dx = v.pos[0] - cx, dz = v.pos[2] - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r) {
        const d = Math.sqrt(d2) || 0.001;
        v.pos[0] += (dx / d) * (r - d + 0.01);
        v.pos[2] += (dz / d) * (r - d + 0.01);
        const vn = v.vel[0] * (dx / d) + v.vel[2] * (dz / d);
        if (vn < 0) { v.vel[0] -= 1.4 * vn * (dx / d); v.vel[2] -= 1.4 * vn * (dz / d); }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Smoke
  // --------------------------------------------------------------------------
  stepSmokes(dt) {
    this.smokes.length = 0;
    for (const pr of this.projectiles) {
      if (pr.type === 'smoke' && pr.fuse <= 0) this.smokes.push({ x: pr.pos[0], y: pr.pos[1], z: pr.pos[2], r: CFG.SMOKE.radius });
    }
  }

  // --------------------------------------------------------------------------
  // Targeting / history
  // --------------------------------------------------------------------------
  buildTargets() {
    const out = [];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const h = p.height();
      out.push({ id: p.id, pos: p.pos, height: h, stance: p.stance, alive: p.alive, team: p.team, hitboxes: hitboxesFor(p.pos, h, p.stance) });
    }
    return out;
  }

  captureHitboxes() {
    const out = new Map();
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const h = p.height();
      out.set(p.id, { id: p.id, pos: p.pos.slice(), height: h, stance: p.stance, alive: true, team: p.team });
    }
    return out;
  }

  static targetsFromHistory(hist) {
    const out = [];
    for (const t of hist.values()) {
      out.push({ ...t, hitboxes: hitboxesFor(t.pos, t.height, t.stance) });
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Packing for the wire
  // --------------------------------------------------------------------------
  pack() {
    return {
      t: this.time, tick: this.tick, mode: this.mode, state: this.matchState,
      countdown: this.countdown, roundTime: this.roundTime,
      winner: this.winner ? { id: this.winner.id ?? null, team: this.winner.team ?? null, name: this.winner.name } : null,
      score: this.score.slice(),
      zone: {
        cx: this.zone.cx, cz: this.zone.cz, r: this.zone.r, phase: this.zone.phase,
        phaseT: this.zone.phaseT, shrinking: this.zone.shrinking, dps: this.zone.dps,
        active: this.zone.active,
      },
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, bot: p.isBot, team: p.team, x: p.pos[0], y: p.pos[1], z: p.pos[2],
        yaw: p.yaw, pitch: p.pitch, hp: Math.max(0, p.health), armor: p.armor,
        alive: p.alive, stance: p.stance, grounded: p.grounded,
        w: p.curWeapon(), slot: p.curSlot,
        mag: p.curWeapon() && p.inv[p.curWeapon()] ? p.inv[p.curWeapon()].mag : 0,
        res: p.curWeapon() && p.inv[p.curWeapon()] ? p.inv[p.curWeapon()].reserve : 0,
        gren: p.grenades, smoke: p.smokes, band: p.bandages, med: p.medkits,
        k: p.kills, d: p.deaths, dmg: Math.round(p.damageDealt),
        vehicle: p.inVehicle || 0, seat: p.seat, ping: p.ping,
        reload: p.reloadT, heal: p.healT, switchT: p.switchT,
        inWater: p.inWater, connected: p.connected,
      })),
      vehicles: this.vehicles.map(v => ({
        id: v.id, x: v.pos[0], y: v.pos[1], z: v.pos[2], yaw: v.yaw,
        pitch: v.pitch, roll: v.roll, speed: Math.hypot(v.vel[0], v.vel[2]),
        type: v.type, occupants: v.occupants.slice(), health: v.health,
      })),
      projectiles: this.projectiles.map(pr => ({ id: pr.id || 0, type: pr.type, x: pr.pos[0], y: pr.pos[1], z: pr.pos[2], fuse: pr.fuse })),
    };
  }

  // Loot list (sent occasionally, not per snapshot).
  packLoot() {
    return this.loot.map(l => ({ id: l.id, type: l.type, weapon: l.weapon || null, sub: l.sub || null, amount: l.amount || 0, x: l.x, y: l.y, z: l.z, rot: l.rot || 0, mag: l.mag || 0, reserve: l.reserve || 0 }));
  }

  spawnWorldLootNow() {
    if (this.loot.length) return;
    spawnWorldLoot(this);
    this.lootDirty = true;
  }
}
