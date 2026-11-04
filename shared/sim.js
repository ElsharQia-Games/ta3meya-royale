// ============================================================================
// Authoritative game simulation. Fixed 60 Hz. Shared by client (prediction)
// and server (truth). No DOM, no rendering, no network I/O.
// ============================================================================
import { CFG, STANCE, MATCH_STATE, TEAMS, combatKit } from './config.js';
import { RNG, clamp, yawTo, TAU, lerp } from './math.js';
import { World } from './world.js';
import { movePlayer, stanceHeight, stanceEye, supportHeight, capsuleBlocked } from './physics.js';
import { vehicleShape, vehicleRideHeight, vehicleAxes, vehicleFootprint, vehicleBoxContact, vehiclePairContact, vehiclePlayerContact, packVehicle, vehicleInReach } from './vehicle.js';
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
    this.kit = 'assault';
    this.death = null;
  }
  height() { return this.inVehicle ? CFG.VEHICLE.occupantHeight : stanceHeight(this.stance); }
  eyeHeight() { return this.inVehicle ? CFG.VEHICLE.eyeHeight : stanceEye(this.stance); }
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
    this.grounded = true;
    this.submerged = false;
  }
}

export class Game {
  constructor(opts = {}) {
    this.mapSeed = opts.mapSeed ?? CFG.MAP.SEED;
    this.world = new World(this.mapSeed);
    this.rng = new RNG((opts.seed ?? 1337) ^ 0x5f3759df);
    this.players = new Map();
    this.vehicles = [];
    this.world.vehicles = this.vehicles;
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
    p.kit = combatKit(opts.kit);
    this.players.set(id, p);
    this.spawnPlayer(p, opts.forceSpawn);
    if (this.mode === 'tdm') {
      p.giveLoadout(CFG.KITS[p.kit].weapons);
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
    if (p.inVehicle) this.exitVehicle(p, true);
    let s = force;
    if (!s) {
      const arr = this.mode === 'tdm'
        ? this.world.teamSpawns[p.team] || this.world.teamSpawns[0] : this.world.spawnPoints;
      const clear = candidate => {
        const { x, z } = candidate, y = this.world.terrainHeight(x, z);
        if (Math.abs(x) > CFG.MAP.BOUNDS - 1 || Math.abs(z) > CFG.MAP.BOUNDS - 1 || this.world.waterDepth(x, z) > .25) return false;
        if (this.mode === 'br' && Math.hypot(x - this.zone.cx, z - this.zone.cz) > this.zone.r * .9) return false;
        if (capsuleBlocked(this.world, x, y + .02, z, CFG.PLAYER.HEIGHT)) return false;
        return ![...this.players.values()].some(other => other !== p && other.alive &&
          Math.abs(other.pos[1] - y) < CFG.PLAYER.HEIGHT && Math.hypot(other.pos[0] - x, other.pos[2] - z) < 1.4);
      };
      for (let tries = 0; tries < 48; tries++) {
        const candidate = arr[Math.floor(this.rng.next() * arr.length)] || { x: 0, z: 0 };
        const radius = tries < 16 ? 0 : 1.6 + (tries % 4) * .8;
        const angle = tries * Math.PI / 4;
        const point = { x: candidate.x + Math.cos(angle) * radius, z: candidate.z + Math.sin(angle) * radius };
        if (clear(point)) { s = point; break; }
      }
      if (!s) s = arr.find(clear) || arr[0] || { x: 0, z: 0 };
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
    p.death = null;
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
    for (const b of this.world.boxes) { b.destroyed = false; b.hp = b.maxHp; }
    this.spawnVehicles();
    for (const p of this.players.values()) {
      this.spawnPlayer(p);
      p.smokes = 0; p.medkits = 0;
      if (this.mode === 'tdm') {
        p.giveLoadout(CFG.KITS[p.kit].weapons);
        p.armor = 50; p.grenades = 1; p.bandages = 2;
      } else {
        p.giveLoadout(['pistol', null]);
        p.armor = 0; p.grenades = 0; p.bandages = 1;
      }
      p.kills = 0; p.deaths = 0; p.damageDealt = 0;
    }
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
    this.resolveVehiclePairs();
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
    // weapon switch
    if (input.slot === 0 || input.slot === 1) switchWeapon(this, p, input.slot);
    else if (input.cycle) switchWeapon(this, p, p.curSlot === 0 ? 1 : 0);

    // reload
    if (input.reload) tryReload(this, p);

    // healing
    if (input.heal && p.healT <= 0 && p.reloadT <= 0 && p.switchT <= 0 && p.health < CFG.PLAYER.MAX_HEALTH) {
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
    if (!(p.inVehicle && p.seat === 0)) {
      if (input.grenade) throwGrenade(this, p, false);
      if (input.smoke) throwGrenade(this, p, true);
    }

    // vehicle entry/exit
    if (input.enterVehicle !== undefined && input.enterVehicle !== null) {
      if (input.enterVehicle === -1) { if (p.inVehicle) this.exitVehicle(p); }
      else {
        const v = this.vehicles.find(vv => vv.id === input.enterVehicle);
        if (v) this.enterVehicle(p, v);
      }
    }

    // shooting
    const key = p.curWeapon();
    if (key && p.alive && this.matchState === MATCH_STATE.LIVE && !(p.inVehicle && p.seat === 0)) {
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
    if (victim.inVehicle) this.exitVehicle(victim, true);
    victim.health = 0;
    victim.deaths++;
    const killer = this.players.get(killerId);
    const dx = victim.pos[0] - (killer?.pos[0] ?? victim.pos[0] + Math.sin(victim.yaw));
    const dz = victim.pos[2] - (killer?.pos[2] ?? victim.pos[2] + Math.cos(victim.yaw));
    const distance = Math.hypot(dx, dz) || 1;
    victim.death = { at: this.time, yaw: victim.yaw, stance: victim.stance,
      direction: [dx / distance, 0, dz / distance], explosive: zone === 'explosion', weapon, killerId };
    victim.reloadT = 0; victim.reloadKey = null; victim.healT = 0; victim.healItem = null;
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
      pos: victim.pos.slice(), death: { ...victim.death },
    });
  }

  stepRespawns() {
    if (this.mode !== 'tdm') return;
    for (const p of this.players.values()) {
      if (!p.alive && p.respawnAt && this.time >= p.respawnAt) {
        this.spawnPlayer(p);
        p.health = CFG.PLAYER.MAX_HEALTH;
        p.armor = 50;
        p.giveLoadout(CFG.KITS[p.kit].weapons);
        p.grenades = 1; p.bandages = 2;
        p.smokes = 0; p.medkits = 0;
        this.events.push({ k: 'respawn', id: p.id, kit: p.kit, weapons: p.weapons.slice() });
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
    if (!p.alive || p.inVehicle || v.health <= 0 || v.submerged) return false;
    const seat = v.occupants.findIndex(o => o === null);
    if (seat < 0) return false;
    if (!vehicleInReach(this.world, p.pos, p.eyeHeight(), v)) return false;
    v.occupants[seat] = p.id;
    p.inVehicle = v.id; p.seat = seat;
    p.vel = [0, 0, 0];
    p.reloadT = 0; p.reloadKey = null; p.healT = 0; p.healItem = null;
    this.events.push({ k: 'enterVehicle', id: p.id, vid: v.id, seat });
    return true;
  }

  exitVehicle(p, silent = false) {
    if (!p.inVehicle) return false;
    const v = this.vehicles.find(vv => vv.id === p.inVehicle);
    if (v) {
      const seat = v.occupants.indexOf(p.id);
      if (!silent) {
        const { right, forward } = vehicleAxes(v.yaw), shape = vehicleShape(v.type);
        const side = shape.width / 2 + CFG.PLAYER.RADIUS + .24;
        const end = shape.length / 2 + CFG.PLAYER.RADIUS + .24;
        const preferred = seat % 2 === 0 ? 1 : -1;
        const options = [[preferred * side, 0], [-preferred * side, 0],
          [preferred * side, -1], [-preferred * side, -1], [0, -end], [0, end]];
        let exit = null;
        for (const [sx, fz] of options) {
          const x = v.pos[0] + right[0] * sx + forward[0] * fz;
          const z = v.pos[2] + right[1] * sx + forward[1] * fz;
          if (Math.abs(x) > CFG.MAP.BOUNDS - CFG.PLAYER.RADIUS || Math.abs(z) > CFG.MAP.BOUNDS - CFG.PLAYER.RADIUS) continue;
          const y = supportHeight(this.world, x, z, v.pos[1] - vehicleRideHeight(), CFG.PLAYER.RADIUS) + .02;
          if (capsuleBlocked(this.world, x, y, z, stanceHeight(p.stance))) continue;
          // Test the static path from the door, outside our own hull.
          const from = [v.pos[0] + right[0] * sx * .7, v.pos[1] + .6, v.pos[2] + right[1] * sx * .7];
          const to = [x, y + .8, z], delta = to.map((n, i) => n - from[i]), distance = Math.hypot(...delta);
          if (distance > 0 && this.world.raycast(from, delta.map(n => n / distance), distance, { ignoreVehicle: v.id })) continue;
          exit = [x, y, z]; break;
        }
        if (!exit) { this.events.push({ k: 'vehicleblocked', id: p.id }); return false; }
        p.pos = exit;
        p.vel = [v.vel[0] * .3, 0, v.vel[2] * .3];
      }
      if (seat >= 0) v.occupants[seat] = null;
    }
    p.inVehicle = null; p.seat = -1;
    if (!silent) this.events.push({ k: 'exitVehicle', id: p.id, vid: v ? v.id : -1 });
    return true;
  }

  stepVehicle(v, inputs, dt) {
    const V = CFG.VEHICLE;
    const shape = vehicleShape(v.type);
    for (let i = 0; i < v.occupants.length; i++) {
      const p = this.players.get(v.occupants[i]);
      if (!p || !p.alive || p.inVehicle !== v.id) v.occupants[i] = null;
    }
    const driverId = v.occupants[0];
    const driver = driverId ? this.players.get(driverId) : null;
    const input = driver?.connected && v.health > 0 ? inputs.get(driverId) : null;
    if (driver) driver.lastVehicleInput = input;
    const oldForward = [-Math.sin(v.yaw), 0, -Math.cos(v.yaw)];
    const fwdSpeed = v.vel[0] * oldForward[0] + v.vel[2] * oldForward[2];
    const speed = Math.hypot(v.vel[0], v.vel[2]);
    v.submerged = this.world.waterDepth(v.pos[0], v.pos[2]) > V.floodDepth &&
      v.pos[1] < this.world.lake.level + .1;

    // Bicycle steering uses signed forward speed. Reverse therefore turns the
    // other way; stationary/airborne steering cannot spin the chassis in place.
    let steerTarget = 0;
    if (input) {
      if (input.l) steerTarget += 1;
      if (input.r) steerTarget -= 1;
    }
    v.steer += (steerTarget - v.steer) * Math.min(1, V.steerSpeed * dt);
    const steeringAngle = v.steer * V.steerMax / (1 + speed * .055);
    const yawRate = clamp(fwdSpeed * Math.tan(steeringAngle) / shape.wheelBase, -1.6, 1.6);
    v.yaw += yawRate * dt * (v.grounded ? 1 : 0);
    const forward = [-Math.sin(v.yaw), 0, -Math.cos(v.yaw)];
    const right = [Math.cos(v.yaw), 0, -Math.sin(v.yaw)];

    // Engine / brake
    let accel = 0;
    v.braking = !!input?.jump;
    if (input && input.f) { accel = fwdSpeed < -1 ? V.brakeForce : V.engineForce; v.braking ||= fwdSpeed < -1; }
    else if (input && input.b) {
      if (fwdSpeed > 1) { accel = -V.brakeForce; v.braking = true; }
      else accel = -V.engineForce * 0.45;
    }
    if (v.submerged || v.health <= 0 || input?.jump) accel = 0;
    v.engine += (accel - v.engine) * Math.min(1, 8 * dt);
    const traction = v.grounded && !v.submerged ? 1 : 0;
    v.vel[0] += forward[0] * (v.engine / V.mass) * dt * traction;
    v.vel[2] += forward[2] * (v.engine / V.mass) * dt * traction;

    // Lateral grip
    const lat = v.vel[0] * right[0] + v.vel[2] * right[2];
    v.vel[0] -= right[0] * lat * Math.min(1, V.grip * dt) * traction;
    v.vel[2] -= right[2] * lat * Math.min(1, V.grip * dt) * traction;
    // Drag
    const drag = 1 - Math.min(0.6, V.drag * dt * (0.4 + speed / V.maxSpeed));
    v.vel[0] *= drag; v.vel[2] *= drag;
    if (input?.jump || v.submerged) {
      const brake = Math.exp(-(v.submerged ? 3.5 : 7) * dt);
      v.vel[0] *= brake; v.vel[2] *= brake;
    }
    // Speed cap
    const updatedSpeed = Math.hypot(v.vel[0], v.vel[2]);
    const speedLimit = v.vel[0] * forward[0] + v.vel[2] * forward[2] < 0 ? V.reverseMax : V.maxSpeed;
    if (updatedSpeed > speedLimit) { const k = speedLimit / updatedSpeed; v.vel[0] *= k; v.vel[2] *= k; }

    // Wheel suspension: 4 raycasts.
    const wheelPositions = [
      [shape.wheelBase / 2, shape.track / 2], [shape.wheelBase / 2, -shape.track / 2],
      [-shape.wheelBase / 2, shape.track / 2], [-shape.wheelBase / 2, -shape.track / 2],
    ];
    let totalSpring = 0;
    let groundCount = 0;
    const grounds = [];
    for (let i = 0; i < 4; i++) {
      const [fz, rx] = wheelPositions[i];
      const wx = v.pos[0] + forward[0] * fz + right[0] * rx;
      const wz = v.pos[2] + forward[2] * fz + right[2] * rx;
      const ground = this.vehicleGround(wx, wz, v.pos[1] + V.wheelMountHeight);
      grounds.push(ground);
      const suspensionLength = v.pos[1] + V.wheelMountHeight - ground - V.wheelRadius;
      const comp = clamp(V.suspensionRest - suspensionLength, 0, V.suspensionTravel);
      if (comp > 0) groundCount++;
      v.wheelComp[i] = comp;
      const spring = comp * V.suspensionK;
      totalSpring += spring;
    }
    v.wheelSpin = (v.wheelSpin + (fwdSpeed / V.wheelRadius) * dt) % TAU;
    // Vertical dynamics
    const gravity = -9.81 * V.mass;
    const damping = -v.vel[1] * V.suspensionD * groundCount / 4;
    v.vel[1] += ((totalSpring + gravity + damping) / V.mass) * dt;
    if (groundCount === 0) v.airTime += dt; else v.airTime = 0;
    v.grounded = groundCount > 0;
    v.pos[1] += v.vel[1] * dt;
    // terrain/box floor clamp
    const floor = this.vehicleGround(v.pos[0], v.pos[2], v.pos[1] + V.wheelMountHeight);
    if (v.pos[1] < floor + V.minClearance) {
      v.pos[1] = floor + V.minClearance;
      if (v.vel[1] < 0) v.vel[1] = 0;
    }

    // Pitch/roll visual from suspension
    const targetPitch = groundCount ? clamp(Math.atan2((grounds[0] + grounds[1] - grounds[2] - grounds[3]) / 2, shape.wheelBase), -.32, .32) : v.pitch;
    const targetRoll = groundCount ? clamp(Math.atan2((grounds[0] + grounds[2] - grounds[1] - grounds[3]) / 2, shape.track), -.3, .3) : v.roll;
    v.pitch += (targetPitch - v.pitch) * Math.min(1, 8 * dt);
    v.roll += (targetRoll - v.roll) * Math.min(1, 8 * dt);

    // Horizontal integration + collision
    const steps = Math.max(1, Math.ceil(Math.hypot(v.vel[0], v.vel[2]) * dt / .2));
    for (let i = 0; i < steps; i++) {
      v.pos[0] += v.vel[0] * dt / steps;
      v.pos[2] += v.vel[2] * dt / steps;
      this.collideVehicle(v);
    }
    const footprint = vehicleFootprint(v);
    for (const [axis, extent] of [[0, footprint.x], [2, footprint.z]]) {
      const bound = CFG.MAP.BOUNDS - extent;
      if (v.pos[axis] > bound) { v.pos[axis] = bound; v.vel[axis] = Math.min(0, v.vel[axis]); }
      if (v.pos[axis] < -bound) { v.pos[axis] = -bound; v.vel[axis] = Math.max(0, v.vel[axis]); }
    }

    // Auto-right if badly tilted (arcade forgiveness)
    if (Math.abs(v.roll) > 1.1) v.roll *= 0.9;

    this.carryVehicleOccupants(v);
  }

  carryVehicleOccupants(v) {
    const forward = [-Math.sin(v.yaw), 0, -Math.cos(v.yaw)];
    const right = [Math.cos(v.yaw), 0, -Math.sin(v.yaw)];
    // Carry occupants after both integration and any vehicle-pair correction.
    for (let i = 0; i < v.occupants.length; i++) {
      const pid = v.occupants[i];
      if (!pid) continue;
      const occ = this.players.get(pid);
      if (!occ) continue;
      const seatF = i < 2 ? (v.type === 'truck' ? 1.05 : .15) : -.8;
      const seatR = i % 2 === 0 ? .43 : -.43;
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

  resolveVehiclePairs() {
    for (let i = 0; i < this.vehicles.length; i++) for (let j = i + 1; j < this.vehicles.length; j++) {
      const a = this.vehicles[i], b = this.vehicles[j], contact = vehiclePairContact(a, b);
      if (!contact) continue;
      const [nx, nz] = contact.normal, half = (contact.depth + .01) / 2;
      a.pos[0] += nx * half; a.pos[2] += nz * half;
      b.pos[0] -= nx * half; b.pos[2] -= nz * half;
      const velocity = (a.vel[0] - b.vel[0]) * nx + (a.vel[2] - b.vel[2]) * nz;
      if (velocity < 0) {
        const impulse = -velocity * .55;
        a.vel[0] += nx * impulse; a.vel[2] += nz * impulse;
        b.vel[0] -= nx * impulse; b.vel[2] -= nz * impulse;
        if (-velocity > 9) {
          this.damageVehicle(a, (-velocity - 9) * 2.5, b.occupants[0] ?? -1);
          this.damageVehicle(b, (-velocity - 9) * 2.5, a.occupants[0] ?? -1);
        }
      }
      this.collideVehicle(a); this.collideVehicle(b);
    }
    for (const v of this.vehicles) {
      const footprint = vehicleFootprint(v);
      v.pos[0] = clamp(v.pos[0], -CFG.MAP.BOUNDS + footprint.x, CFG.MAP.BOUNDS - footprint.x);
      v.pos[2] = clamp(v.pos[2], -CFG.MAP.BOUNDS + footprint.z, CFG.MAP.BOUNDS - footprint.z);
      this.carryVehicleOccupants(v);
      for (const p of this.players.values()) {
        if (!p.alive || p.inVehicle) continue;
        const contact = vehiclePlayerContact(v, p.pos, CFG.PLAYER.RADIUS, p.height());
        if (!contact) continue;
        const [nx, nz] = contact.normal;
        const impactSpeed = v.vel[0] * nx + v.vel[2] * nz;
        p.pos[0] += nx * (contact.depth + .01); p.pos[2] += nz * (contact.depth + .01);
        p.pos[0] = clamp(p.pos[0], -CFG.MAP.BOUNDS, CFG.MAP.BOUNDS);
        p.pos[2] = clamp(p.pos[2], -CFG.MAP.BOUNDS, CFG.MAP.BOUNDS);
        p.pos[1] = Math.max(p.pos[1], this.world.terrainHeight(p.pos[0], p.pos[2]));
        // Contact normal points out of the car; velocity toward the player is
        // positive along it. Slow contact pushes rather than causing damage.
        if (impactSpeed > 5) applyDamage(this, p, (impactSpeed - 5) * 7, v.occupants[0] ?? -1, 'torso', p.pos, 'vehicle');
      }
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
    const shape = vehicleShape(v.type), r = Math.hypot(shape.width, shape.length) / 2;
    const boxes = this.world.queryBoxes(v.pos[0] - r - 1, v.pos[2] - r - 1, v.pos[0] + r + 1, v.pos[2] + r + 1);
    for (let iteration = 0; iteration < 3; iteration++) for (const b of boxes) {
      if (b.destroyed || b.tag === 'glass' || b.tag === 'void') continue;
      const contact = vehicleBoxContact(v, b);
      if (!contact) continue;
      const [nx, nz] = contact.normal;
      v.pos[0] += nx * (contact.depth + .005);
      v.pos[2] += nz * (contact.depth + .005);
      const vn = v.vel[0] * nx + v.vel[2] * nz;
      if (vn < 0) {
        v.vel[0] -= 1.1 * vn * nx; v.vel[2] -= 1.1 * vn * nz;
        if (-vn > 9) this.damageVehicle(v, (-vn - 9) * CFG.VEHICLE.impactDamage, v.occupants[0] ?? -1);
      }
    }
  }

  damageVehicle(v, amount, owner = -1) {
    if (!v || v.health <= 0 || amount <= 0) return;
    v.health = Math.max(0, v.health - amount);
    if (v.health > 0) return;
    v.engine = 0;
    const occupants = v.occupants.slice();
    this.events.push({ k: 'vehicleDestroyed', vid: v.id, x: v.pos[0], y: v.pos[1], z: v.pos[2] });
    explode(this, v.pos.slice(), 90, 5, owner);
    for (const id of occupants) {
      const p = this.players.get(id);
      if (p?.alive && p.inVehicle === v.id) this.exitVehicle(p);
    }
  }

  // --------------------------------------------------------------------------
  // Smoke
  // --------------------------------------------------------------------------
  stepSmokes(dt) {
    this.smokes.length = 0;
    for (const pr of this.projectiles) {
      if (pr.type === 'smoke' && pr.fuse <= 0) this.smokes.push({ id: pr.id, x: pr.pos[0], y: pr.pos[1], z: pr.pos[2], r: CFG.SMOKE.radius });
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
      const stance = p.inVehicle ? STANCE.CROUCH : p.stance;
      out.push({ id: p.id, pos: p.pos, height: h, stance, yaw: p.yaw, alive: p.alive, team: p.team, hitboxes: hitboxesFor(p.pos, h, stance, p.yaw) });
    }
    return out;
  }

  captureHitboxes() {
    const out = new Map();
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const h = p.height();
      out.set(p.id, { id: p.id, pos: p.pos.slice(), height: h, stance: p.inVehicle ? STANCE.CROUCH : p.stance, yaw: p.yaw, alive: true, team: p.team });
    }
    return out;
  }

  static targetsFromHistory(hist) {
    const out = [];
    for (const t of hist.values()) {
      out.push({ ...t, hitboxes: hitboxesFor(t.pos, t.height, t.stance, t.yaw || 0) });
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
      destroyed: [...this.destroyedBoxes],
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
      vehicles: this.vehicles.map(packVehicle),
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
