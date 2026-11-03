// Deterministic game simulation shared by client and server.
// Fixed dt = 1/60. All randomness from seeded RNG streams so replays/tests agree.
import { CFG } from './config.js';
import { World, rngStream } from './world.js';

export class Player {
  constructor(id, name, x, z, team = 0) {
    this.id = id; this.name = name; this.team = team;
    this.pos = [x, 0, z]; this.vel = [0, 0, 0];
    this.yaw = 0; this.pitch = 0;
    this.health = CFG.PLAYER.MAX_HEALTH; this.alive = true;
    this.stance = 'stand';            // stand | crouch | prone
    this.grounded = false; this.sprinting = false; this.adsing = false;
    this.weapons = ['ar', 'shotgun', 'pistol'];
    this.inv = {};                    // weapon -> {mag, reserve}
    for (const w of this.weapons) this.inv[w] = { mag: CFG.WEAPONS[w].mag, reserve: CFG.WEAPONS[w].mag * 5 };
    this.curW = 0; this.reloadT = 0; this.cooldown = 0; this.grenades = 2; this.med = 3;
    this.kills = 0; this.deaths = 0; this.lastAttacker = null;
    this.recoilPitch = 0; this.recoilYaw = 0; this.heat = 0;
    this.inVehicle = null; this.healT = 0;
    this.respawnAt = 0;
  }
  eyeHeight() {
    const P = CFG.PLAYER;
    return this.stance === 'crouch' ? 0.85 : this.stance === 'prone' ? 0.45 : P.EYE;
  }
  height() {
    return this.stance === 'crouch' ? CFG.PLAYER.CROUCH_HEIGHT :
           this.stance === 'prone' ? CFG.PLAYER.PRONE_HEIGHT : CFG.PLAYER.HEIGHT;
  }
}

export class Vehicle {
  constructor(id, x, z) {
    this.id = id; this.pos = [x, 0, z]; this.yaw = 0; this.speed = 0;
    this.steer = 0; this.occupants = [null, null, null, null];
  }
}

export class Game {
  constructor(seed = 1337) {
    this.world = new World();
    this._rng = rngStream(seed);
    this.rng = () => this._rng.fn();
    this.players = new Map();
    this.vehicles = [];
    this.projectiles = [];   // {pos, vel, owner, type:'grenade'|'bullet', dmg, life}
    this.time = 0; this.tick = 0;
    this.zone = { cx: 0, cz: 0, r: CFG.ZONE.phases[0].r, phase: 0, phaseT: 0, shrinking: false };
    this.events = [];        // transient events (shots, hits, deaths) — server broadcasts, client renders
    this.nextId = 1;
    this.mode = 'br';
    this.phaseNames = ['wait', 'shrink'];
    this.lockpatch = 0;
  }

  addPlayer(name, x, z, team = 0) {
    const id = this.nextId++;
    const p = new Player(id, name, x, z, team);
    p.pos[1] = this.world.terrainH(x, z);
    this.players.set(id, p);
    return p;
  }

  // ---------- movement ----------
  stepPlayer(p, input, dt) {
    const P = CFG.PLAYER;
    if (!p.alive) return;
    if (p.inVehicle) return; // vehicle solver moves driver
    p.cooldown = Math.max(0, p.cooldown - dt);
    p.heat = Math.max(0, p.heat - dt * 1.6);
    if (p.reloadT > 0) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) {  // finish reload
        const w = p.weapons[p.curW], slot = p.inv[w];
        const need = CFG.WEAPONS[w].mag - slot.mag, take = Math.min(need, slot.reserve);
        slot.mag += take; slot.reserve -= take;
      }
    }
    if (p.healT > 0) {
      p.healT -= dt;
      if (p.healT <= 0 && p.alive) { p.health = Math.min(P.MAX_HEALTH, p.health + CFG.HEAL.amount); this.events.push({ k: 'heal', id: p.id }); }
    }
    if (input.stance) p.stance = input.stance;
    p.sprinting = !!input.sprint && p.stance === 'stand' && !input.ads;
    p.adsing = !!input.ads;
    p.yaw = input.yaw; p.pitch = input.pitch;
    const wb = p.weapons[p.curW];

    // weapon slot switch
    if (input.switch !== undefined && input.switch >= 0 && input.switch < p.weapons.length) p.curW = input.switch;

    // wish direction from yaw + input
    const f = [-Math.sin(p.yaw), -Math.cos(p.yaw)];
    const r = [Math.cos(p.yaw), -Math.sin(p.yaw)];
    const want = [ [0, 0], [0, 0] ];
    let mx = 0, mz = 0;
    if (input.f) { mx += f[0]; mz += f[1]; }
    if (input.b) { mx -= f[0]; mz -= f[1]; }
    if (input.r) { mx += r[0]; mz += r[1]; }
    if (input.l) { mx -= r[0]; mz -= r[1]; }
    const len = Math.hypot(mx, mz) || 1;
    want[0] = mx / len; want[1] = mz / len;

    let maxSpeed = p.sprinting ? P.SPRINT : P.WALK;
    if (p.stance === 'crouch') maxSpeed = P.CROUCH;
    if (p.stance === 'prone') maxSpeed = P.PRONE;
    if (p.adsing) maxSpeed = P.ADS;
    // water slow
    if (this.world.terrainH(p.pos[0], p.pos[2]) < CFG.WATER.level - 0.4) maxSpeed *= CFG.WATER.slow;
    // reload/heal slows movement
    if (p.reloadT > 0 || p.healT > 0) maxSpeed *= 0.55;

    const accel = p.grounded ? P.ACCEL_GND : P.ACCEL_AIR;
    const control = p.grounded ? 1 : P.AIR_CONTROL;
    p.vel[0] += (want[0] * maxSpeed - p.vel[0]) * Math.min(1, accel * control * dt * (p.grounded ? 1 : 1));
    p.vel[2] += (want[1] * maxSpeed - p.vel[2]) * Math.min(1, accel * dt);

    // jump
    if (input.jump && p.grounded) { p.vel[1] = P.JUMP; p.grounded = false; }
    // gravity
    p.vel[1] -= CFG.GRAVITY * dt;
    if (p.vel[1] < -40) p.vel[1] = -40;

    p.pos[0] += p.vel[0] * dt; p.pos[1] += p.vel[1] * dt; p.pos[2] += p.vel[2] * dt;

    const { collideCapsule } = { collideCapsule: null }; // placeholder to avoid circular import style issues
    // inline collide (imported at module bottom to keep single-file determinism)
    this.collide(p, dt);

    // --- shooting ---
    if (input.shoot && p.cooldown <= 0 && p.reloadT <= 0 && p.alive) this.tryShoot(p, input, dt);
    if (input.reload && p.reloadT <= 0) {
      const slot = p.inv[wb];
      if (slot.mag < CFG.WEAPONS[wb].mag && slot.reserve > 0 && p.cooldown <= 0) {
        p.reloadT = CFG.WEAPONS[wb].reload; p.cooldown = 0.25;
        this.events.push({ k: 'reload', id: p.id });
      }
    }
    if (input.enterVehicle !== undefined) {
      if (input.enterVehicle !== -1) {
        const v = this.vehicles.find(vv => vv.id === input.enterVehicle);
        if (v && v.occupants.length < 4 && !v.occupants.includes(p.id)) {
          v.occupants.push(p.id); p.inVehicle = v.id;
          this.events.push({ k: 'enterVehicle', id: p.id, vid: v.id });
        }
      } else if (p.inVehicle) {
        const v = this.vehicles.find(vv => vv.id === p.inVehicle);
        if (v) {
          const i = v.occupants.indexOf(p.id); if (i >= 0) v.occupants.splice(i, 1);
          p.pos = [v.pos[0] + 2, v.pos[1], v.pos[2] + 2]; p.pos[1] = this.world.terrainH(p.pos[0], p.pos[2]);
        }
        p.inVehicle = null; this.events.push({ k: 'exitVehicle', id: p.id });
      }
    }
    if (input.grenade && p.grenades > 0) {
      p.grenades--; p.cooldown = 0.6;
      const eye = this.eyePos(p);
      const dir = this.viewDir(p);
      this.projectiles.push({ pos: eye.slice(), vel: [dir[0] * CFG.GRENADE.mv, dir[1] * CFG.GRENADE.mv + 3, dir[2] * CFG.GRENADE.mv], owner: p.id, type: 'grenade', fuse: CFG.GRENADE.fuse, bounces: 0 });
      this.events.push({ k: 'throw', id: p.id });
    }
    if (input.heal && p.med > 0 && p.health < P.MAX_HEALTH && p.healT <= 0) {
      p.med--; p.healT = CFG.HEAL.time; this.events.push({ k: 'healstart', id: p.id });
    }
  }

  collide(p, dt) {
    const r = CFG.PLAYER.RADIUS, h = p.height(), step = CFG.PLAYER.STEP_HEIGHT;
    p.grounded = false;
    const gy = this.world.terrainH(p.pos[0], p.pos[2]);
    if (p.pos[1] <= gy + 0.001 && p.vel[1] <= 0.01) { p.pos[1] = gy; p.grounded = true; if (p.vel[1] < 0) p.vel[1] = 0; }
    for (let iter = 0; iter < 3; iter++) {
      for (const b of this.world.boxes) {
        if (b.tag === 'ground') continue;
        const minX = b.min[0] - r, maxX = b.max[0] + r;
        const minZ = b.min[2] - r, maxZ = b.max[2] + r;
        if (p.pos[0] < minX || p.pos[0] > maxX || p.pos[2] < minZ || p.pos[2] > maxZ) continue;
        if (p.pos[1] + h < b.min[1] + 0.01 || p.pos[1] > b.max[1] - 0.01) continue;
        if (b.max[1] - p.pos[1] <= step && b.max[1] - p.pos[1] >= -0.05 && p.vel[1] <= 0.5) { p.pos[1] = b.max[1]; p.grounded = true; continue; }
        const pushL = p.pos[0] - minX, pushR = maxX - p.pos[0];
        const pushB = p.pos[2] - minZ, pushF = maxZ - p.pos[2];
        const m = Math.min(pushL, pushR, pushB, pushF);
        if (m === pushL) { p.pos[0] = minX; p.vel[0] = Math.max(p.vel[0], 0); }
        else if (m === pushR) { p.pos[0] = maxX; p.vel[0] = Math.min(p.vel[0], 0); }
        else if (m === pushB) { p.pos[2] = minZ; p.vel[2] = Math.max(p.vel[2], 0); }
        else { p.pos[2] = maxZ; p.vel[2] = Math.min(p.vel[2], 0); }
      }
    }
  }

  eyePos(p) { return [p.pos[0], p.pos[1] + p.eyeHeight(), p.pos[2]]; }
  viewDir(p) {
    const cp = Math.cos(p.pitch);
    return [-Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp];
  }

  // ---------- shooting (hitscan + lag info; bullets authoritative) ----------
  tryShoot(p, input, dt) {
    const w = p.weapons[p.curW], W = CFG.WEAPONS[w], slot = p.inv[w];
    const interval = 60 / W.rpm;
    if (slot.mag <= 0) { // auto reload attempt
      this.events.push({ k: 'dry', id: p.id });
      if (slot.reserve > 0) { p.reloadT = W.reload; }
      p.cooldown = 0.2; return;
    }
    slot.mag--; p.cooldown = interval;
    p.heat = Math.min(1, p.heat + 0.12);
    // recoil accumulates
    p.recoilPitch += W.rPitch * (0.7 + p.heat); p.recoilYaw += W.rYaw * (this.rng() - 0.5) * 2;
    const eye = this.eyePos(p);
    const baseDir = this.viewDir(p);
    for (let i = 0; i < W.pellet; i++) {
      const sp = W.spread * (p.adsing ? 0.4 : 1) * (1 + p.heat * 0.6) * (p.grounded ? 1 : 2);
      const d = baseDir.slice();
      d[0] += (this.rng() - 0.5) * 2 * sp; d[1] += (this.rng() - 0.5) * 2 * sp; d[2] += (this.rng() - 0.5) * 2 * sp;
      const l = Math.hypot(...d); d[0] /= l; d[1] /= l; d[2] /= l;
      if (this.onShoot) { const cb = this.onShoot; cb(p, input, dt); this.onShoot = null; }
      else this.fireHitscan(p, eye, d, w, input.atTime || this.time);
    }
    this.events.push({ k: 'shot', id: p.id, w });
  }

  fireHitscan(shooter, origin, dir, wkey, atTime) {
    const W = CFG.WEAPONS[wkey];
    // world hit
    const wHit = this.world.raycast(origin, dir, 600);
    const wDist = wHit ? wHit.t : 600;
    // players: capsule test along ray (body = vertical capsule)
    let best = null, bestT = wDist, bestZone = 'torso';
    for (const q of this.players.values()) {
      if (!q.alive || q.id === shooter.id) continue;
      if (this.mode === 'tdm' && q.team === shooter.team) continue;
      const t = rayCapsule(origin, dir, q.pos, CFG.PLAYER.RADIUS, q.height());
      if (t !== null && t < bestT) {
        best = q; bestT = t;
        // hit zone by height fraction at hit point
        const hy = origin[1] + dir[1] * t - q.pos[1];
        bestZone = hy > q.height() * 0.82 ? 'head' : hy < q.height() * 0.35 ? 'legs' : 'torso';
      }
    }
    const dist = bestT;
    let dmg = W.dmg;
    if (dist > W.falloff[0]) dmg *= Math.max(0.35, 1 - (dist - W.falloff[0]) / (W.falloff[1] - W.falloff[0]));
    if (bestZone === 'head') dmg *= 2.2; else if (bestZone === 'legs') dmg *= 0.8;
    if (best) {
      best.health -= dmg; best.lastAttacker = shooter.id;
      this.events.push({ k: 'hit', from: shooter.id, to: best.id, dmg: Math.round(dmg), zone: bestZone, x: origin[0] + dir[0] * dist, y: origin[1] + dir[1] * dist, z: origin[2] + dir[2] * dist });
      if (best.health <= 0) this.kill(best, shooter.id);
    } else {
      this.events.push({ k: 'impact', x: origin[0] + dir[0] * dist, y: origin[1] + dir[1] * dist, z: origin[2] + dir[2] * dist, tag: wHit ? wHit.box.tag : 'air' });
      // destructible damage
      if (wHit && wHit.box.tag === 'destructible') this.damageDestructible(wHit.box, dmg);
    }
  }

  damageDestructible(box, dmg) {
    for (const d of this.world.destructibles) {
      if (this.world.boxes[d.idx] === box) {
        d.hp -= dmg;
        if (d.hp <= 0) {
          box.min[0] = box.max[0]; box.min[1] = box.max[1]; box.min[2] = box.max[2]; // remove collider
          this.events.push({ k: 'destroyed', x: d.x, z: d.z });
        }
      }
    }
  }

  kill(victim, killerId) {
    if (!victim.alive) return;
    victim.alive = false; victim.health = 0; victim.deaths++;
    const killer = this.players.get(killerId);
    if (killer && killerId !== victim.id) killer.kills++;
    this.events.push({ k: 'kill', victim: victim.id, killer: killerId, vname: victim.name, kname: killer ? killer.name : '?' });
    if (this.mode === 'tdm') victim.respawnAt = this.time + 4;
  }

  // ---------- projectiles (grenades) ----------
  stepProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      if (pr.type === 'grenade') {
        pr.fuse -= dt;
        pr.vel[1] -= CFG.GRAVITY * 0.7 * dt;
        pr.pos[0] += pr.vel[0] * dt; pr.pos[1] += pr.vel[1] * dt; pr.pos[2] += pr.vel[2] * dt;
        const gy = this.world.terrainH(pr.pos[0], pr.pos[2]);
        if (pr.pos[1] < gy) { pr.pos[1] = gy; pr.vel[1] *= -0.35; pr.vel[0] *= 0.7; pr.vel[2] *= 0.7; pr.bounces++; }
        if (pr.fuse <= 0) { this.explode(pr.pos, CFG.GRENADE.dmg, CFG.GRENADE.radius, pr.owner); this.projectiles.splice(i, 1); continue; }
      }
      if (pr.fuse <= 0 && pr.type !== 'grenade') this.projectiles.splice(i, 1);
    }
  }

  explode(pos, dmg, radius, owner) {
    this.events.push({ k: 'boom', x: pos[0], y: pos[1], z: pos[2] });
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.pos[0] - pos[0], p.pos[1] + 1 - pos[1], p.pos[2] - pos[2]);
      if (d < radius) {
        const f = 1 - d / radius;
        p.health -= dmg * f; p.lastAttacker = owner;
        if (p.health <= 0) this.kill(p, owner);
      }
    }
  }

  // ---------- vehicles ----------
  stepVehicle(v, input, dt) {
    const V = CFG.VEHICLE;
    if (input) v.steer += ((input.l ? 1 : 0) - (input.r ? 1 : 0)) * dt * 3;
    v.steer *= Math.pow(0.001, dt); // decay
    if (input && input.f) v.speed = Math.min(V.maxSpeed, v.speed + V.accel * dt);
    if (input && input.b) v.speed = Math.max(-V.maxSpeed * 0.4, v.speed - V.brake * dt);
    if (!input) v.speed *= Math.pow(0.55, dt);
    const turn = v.steer * V.turn * Math.min(1, Math.abs(v.speed) / 6) * Math.sign(v.speed || 1);
    v.yaw += turn * dt;
    v.pos[0] += -Math.sin(v.yaw) * v.speed * dt;
    v.pos[2] += -Math.cos(v.yaw) * v.speed * dt;
    v.pos[1] = this.world.terrainH(v.pos[0], v.pos[2]);
    // carry all occupants (driver + passengers) at the vehicle transform
    for (const pid of v.occupants) {
      const occ = this.players.get(pid);
      if (occ) { occ.pos = [v.pos[0], v.pos[1], v.pos[2]]; occ.vel = [0, 0, 0]; }
    }
  }

  // ---------- zone ----------
  stepZone(dt) {
    const Z = CFG.ZONE;
    if (this.zone.phase >= Z.phases.length) this.zone.phase = Z.phases.length - 1; // stay at final radius
    this.zone.phaseT += dt;
    const ph = Z.phases[this.zone.phase];
    const wait = ph.wait, shrink = ph.shrink;
    if (this.zone.fromR === undefined) { this.zone.fromR = this.zone.r; }
    if (!this.zone.shrinking && this.zone.phaseT >= wait) { this.zone.shrinking = true; this.zone.phaseT = 0; this.nextZoneTarget(); }
    if (this.zone.shrinking) {
      const k = this.zone.phaseT / shrink;
      if (k >= 1) { this.zone.phase++; this.zone.phaseT = 0; this.zone.shrinking = false; this.zone.r = Z.phases[Math.min(this.zone.phase, Z.phases.length - 1)].r; }
      else {
        const fromR = this.zone.fromR ?? this.zone.r, toR = Z.phases[this.zone.phase].r;
        if (isFinite(fromR) && isFinite(toR)) this.zone.r = fromR + (toR - fromR) * easeInOut(k);
      }
    }
    // zone damage
    const dps = Z.dps[Math.min(this.zone.phase, Z.dps.length - 1)];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.pos[0] - this.zone.cx, p.pos[2] - this.zone.cz);
      if (d > this.zone.r) {
        p.health -= dps * dt; p.lastAttacker = -1;
        if (p.health <= 0) this.kill(p, -1);
        if (this.tick % 30 === 0) this.events.push({ k: 'zonetick', id: p.id });
      }
    }
  }
  nextZoneTarget() {
    this.zone.fromR = this.zone.r;
    const nr = CFG.ZONE.phases[Math.min(this.zone.phase, CFG.ZONE.phases.length - 1)].r;
    this.zone.cx += (this.rng() - 0.5) * (this.zone.r - nr) * 0.7;
    this.zone.cz += (this.rng() - 0.5) * (this.zone.r - nr) * 0.7;
  }

  addVehicle(x, z) {
    const v = new Vehicle(this.nextId++, x, z);
    v.pos[1] = this.world.terrainH(x, z);
    this.vehicles.push(v);
    return v;
  }

  // ---------- master step ----------
  step(inputs, dt = CFG.SIM_DT) {
    this.time += dt; this.tick++;
    for (const [id, input] of inputs) {
      const p = this.players.get(id);
      if (p) this.stepPlayer(p, input, dt);
    }
    this.stepProjectiles(dt);
    for (const v of this.vehicles) {
      const drvId = v.occupants[0];
      const dIn = drvId ? inputs.get(drvId) : null;
      this.stepVehicle(v, dIn, dt);
    }
    if (this.mode === 'br') this.stepZone(dt);
    // respawns (TDM)
    for (const p of this.players.values()) {
      if (!p.alive && this.mode === 'tdm' && p.respawnAt && this.time >= p.respawnAt) {
        p.alive = true; p.health = CFG.PLAYER.MAX_HEALTH;
        const a = this.rng() * Math.PI * 2, rr = 30 + this.rng() * 60;
        p.pos = [Math.cos(a) * rr, 0, Math.sin(a) * rr]; p.pos[1] = this.world.terrainH(p.pos[0], p.pos[2]);
        this.events.push({ k: 'respawn', id: p.id });
      }
    }
  }

  // history for lag rewind
  snapshotPlayers() {
    const out = new Map();
    for (const p of this.players.values()) out.set(p.id, { pos: p.pos.slice(), health: p.health, alive: p.alive });
    return out;
  }

  saveState() {
    const state = {
      time: this.time, tick: this.tick,
      zone: { ...this.zone },
      players: new Map(),
      projectiles: this.projectiles.map(pr => ({ ...pr, pos: pr.pos.slice(), vel: pr.vel.slice() })),
      vehicles: this.vehicles.map(v => ({ ...v, pos: v.pos.slice(), occupants: v.occupants.slice() })),
      rngState: this.rngState ?? null,
    };
    if (this._rng) state.rngState = this._rng.state;
    for (const p of this.players.values()) {
      state.players.set(p.id, {
        pos: p.pos.slice(), vel: p.vel.slice(), yaw: p.yaw, pitch: p.pitch,
        health: p.health, alive: p.alive, stance: p.stance, grounded: p.grounded,
        sprinting: p.sprinting, adsing: p.adsing, curW: p.curW,
        inv: JSON.parse(JSON.stringify(p.inv)), reloadT: p.reloadT, cooldown: p.cooldown,
        grenades: p.grenades, med: p.med, kills: p.kills, deaths: p.deaths,
        recoilPitch: p.recoilPitch, recoilYaw: p.recoilYaw, heat: p.heat,
        inVehicle: p.inVehicle, healT: p.healT, respawnAt: p.respawnAt, team: p.team,
        lastAttacker: p.lastAttacker,
      });
    }
    state.destructibles = this.world.destructibles.map(d => ({ ...d }));
    state.boxMinMax = this.world.boxes.map(b => [b.min.slice(), b.max.slice()]);
    return state;
  }

  restoreState(s) {
    this.time = s.time; this.tick = s.tick; this.zone = { ...s.zone };
    this.projectiles = s.projectiles.map(pr => ({ ...pr, pos: pr.pos.slice(), vel: pr.vel.slice() }));
    this.vehicles = s.vehicles.map(v => ({ ...v, pos: v.pos.slice(), occupants: v.occupants.slice() }));
    if (this._rng && s.rngState !== null) { this._rng.state = s.rngState; }
    for (const [id, st] of s.players) {
      const p = this.players.get(id); if (!p) continue;
      Object.assign(p, {
        pos: st.pos.slice(), vel: st.vel.slice(), yaw: st.yaw, pitch: st.pitch,
        health: st.health, alive: st.alive, stance: st.stance, grounded: st.grounded,
        sprinting: st.sprinting, adsing: st.adsing, curW: st.curW,
        inv: JSON.parse(JSON.stringify(st.inv)), reloadT: st.reloadT, cooldown: st.cooldown,
        grenades: st.grenades, med: st.med, kills: st.kills, deaths: st.deaths,
        recoilPitch: st.recoilPitch, recoilYaw: st.recoilYaw, heat: st.heat,
        inVehicle: st.inVehicle, healT: st.healT, respawnAt: st.respawnAt, team: st.team,
        lastAttacker: st.lastAttacker,
      });
    }
    s.destructibles.forEach((d, i) => { if (this.world.destructibles[i]) Object.assign(this.world.destructibles[i], d); });
    s.boxMinMax.forEach((mm, i) => { if (this.world.boxes[i]) { this.world.boxes[i].min = mm[0].slice(); this.world.boxes[i].max = mm[1].slice(); } });
    this.events.length = 0;
  }

  // serialization for server->client snapshots
  pack() {
    return {
      t: this.time, tick: this.tick, mode: this.mode,
      zone: { cx: this.zone.cx, cz: this.zone.cz, r: this.zone.r, phase: this.zone.phase, shrinking: this.zone.shrinking, phaseT: this.zone.phaseT },
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, team: p.team, x: +p.pos[0].toFixed(2), y: +p.pos[1].toFixed(2), z: +p.pos[2].toFixed(2),
        yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3), hp: Math.max(0, Math.round(p.health)), alive: p.alive,
        stance: p.stance, w: p.weapons[p.curW], mag: p.inv[p.weapons[p.curW]].mag, res: p.inv[p.weapons[p.curW]].reserve,
        k: p.kills, d: p.deaths, gren: p.grenades, med: p.med, inV: p.inVehicle
      })),
      vehicles: this.vehicles.map(v => ({ id: v.id, x: +v.pos[0].toFixed(2), y: +v.pos[1].toFixed(2), z: +v.pos[2].toFixed(2), yaw: +v.yaw.toFixed(3), speed: +v.speed.toFixed(2) }))
    };
  }
}

function easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

function rayCapsule(o, d, base, radius, height) {
  // approximate capsule as sphere at mid-height + segment test; fine for hit reg.
  const c = [base[0], base[1] + height / 2, base[2]];
  const oc = [o[0] - c[0], o[1] - c[1], o[2] - c[2]];
  const b = oc[0] * d[0] + oc[1] * d[1] + oc[2] * d[2];
  const cc = oc[0] ** 2 + oc[1] ** 2 + oc[2] ** 2 - (height / 2 + radius) ** 2;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : null;
}
