// Recorded-sample audio engine.
//
// Everything audible in a session comes from a CC0 recording in
// `public/audio/manifest.json`. There are no oscillators or generated noise
// voices: the only generated signal is the convolution impulse used as a
// reverb tail (processing, not a sound source).
//
// Bus: voice -> low-pass -> gain -> panner -> mix
//                                             \-> reverb send -> convolver
//      mix -> glue compressor -> limiter -> master(volume) -> analyser -> out
//
// The engine owns node lifetimes for one-shots, scheduled voices, loops and
// ambience. `stop()` is idempotent and always disconnects the whole graph.
import { clamp } from '../../shared/math.js';
import { CFG } from '../../shared/config.js';
import { SampleBank, ReloadCues } from './samples.js';
import {
  SOUNDS, CATEGORY_DEFAULTS, IMPACT_SOUNDS, FOOTSTEP_SOUNDS,
  UI_SOUNDS, pickClip,
} from './sounds.js';
import { spatialFor, indoorAt, cutoffFor } from './spatial.js';
import { VoiceBudget } from './voices.js';

const GLOBAL_VOICE_LIMIT = 40;
const MAX_AUDIBLE = 800;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.mix = null;
    this.master = null;
    this.comp = null;
    this.limiter = null;
    this.analyser = null;
    this.reverb = null;
    this.reverbGain = null;
    this.enabled = false;
    this.volume = 0.65;
    this.muted = false;
    this.listenerYaw = 0;
    this.listenerPos = [0, 0, 0];
    this.indoor = false;
    this.world = null;
    this.samples = null;
    this.budget = new VoiceBudget(GLOBAL_VOICE_LIMIT);
    this.voices = this.budget.voices;
    this.reloadCues = new ReloadCues();
    this.sessionActive = false;
    this._loops = new Map();
    this._lastClip = new Map();
    this._lastPlayed = new Map();
    this._steps = new Map();
    this._observe = new Map();
    this._impactAt = new Map();
    this._requestedGroups = new Set();
    this._levelBuf = null;
    this._gesture = null;
    this._vehicleId = null;
    this._braking = false;
    this.lastActionWeapon = null;
    this.lastShotAge = Infinity;
  }

  init() {
    if (this.ctx) { this.resume(); return; }
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();

    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 18;
    this.comp.ratio.value = 5;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.22;

    // Brick-wall-ish limiter after the mix so no combination of voices clips.
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;

    this.mix = this.ctx.createGain();
    this.mix.gain.value = 1;

    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : clamp(this.volume, 0, 1);

    this.mix.connect(this.comp);
    this.comp.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    // One shared convolution reverb. Indoor spaces get a longer, louder send.
    this.reverb = this.ctx.createConvolver();
    this.reverb.normalize = true;
    this.reverb.buffer = this._makeImpulse(1.6, 3.4);
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = 0.5;
    this.reverb.connect(this.reverbGain);
    this.reverbGain.connect(this.mix);

    this.samples = new SampleBank(this.ctx);
    this.samples.load();

    this.enabled = true;
    // Autoplay policies suspend a context created before the first gesture.
    this._gesture = () => this.resume();
    addEventListener('pointerdown', this._gesture, { passive: true });
    addEventListener('keydown', this._gesture);
  }

  resume() {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') {
      const p = this.ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
  }

  setVolume(v) {
    this.volume = clamp(Number.isFinite(+v) ? +v : this.volume, 0, 1);
    this._applyGain();
  }

  setMuted(m) {
    this.muted = !!m;
    this._applyGain();
  }

  _applyGain() {
    if (this.master) this.master.gain.value = this.muted ? 0 : clamp(this.volume, 0, 1);
  }

  // -------------------------------------------------------------------------
  // Public playback API used by the game
  // -------------------------------------------------------------------------
  play(sound, opts = {}) {
    const def = SOUNDS[sound];
    if (!def) return false;
    const variant = opts.variant ?? null;
    // Cooldowns are per source, not per sound: two different players firing the
    // same weapon must not cancel each other. Local/unsourced calls share the
    // empty source key.
    const source = opts.source ?? '';
    const cooldownKey = `${sound}:${variant ?? ''}:${source}`;
    const now = this.ctx?.currentTime ?? 0;
    if (!opts.bypassCooldown && def.cooldown > 0) {
      const last = this._lastPlayed.get(cooldownKey);
      if (last !== undefined && now - last < def.cooldown) return false;
    }
    const clipName = opts.clip || pickClip(def, variant, variant == null ? this._lastClip.get(sound) : this._lastClip.get(cooldownKey));
    if (!clipName) return false;
    const played = this._playClip(def, clipName, opts);
    if (played) {
      this._lastPlayed.set(cooldownKey, now);
      if (variant == null) this._lastClip.set(sound, clipName);
      else this._lastClip.set(cooldownKey, clipName);
    }
    return played;
  }

  // Backwards-compatible QA/game hook: play one named clip through the full
  // spatial path. The clip is looked up in the manifest rather than a fixed key
  // list, so stale names fail visibly in tests.
  playSample(name, { gain = 1, rate = 1, position = null, delay = 0, cutoff = 14000, group = 'raw' } = {}) {
    const base = CATEGORY_DEFAULTS.raw;
    const def = {
      ...base,
      category: 'raw',
      clips: [name],
      range: { ...base.range },
      filter: { ...base.filter, near: cutoff, far: Math.min(cutoff, base.filter.far) },
      reverb: base.reverb,
    };
    return this._playClip(def, name, { gain, rate, position, delay, group, bypassCooldown: true });
  }

  _playClip(def, clipName, opts = {}) {
    if (!this.enabled || !this.ctx) return false;
    const buffer = this.samples?.buffer(clipName);
    if (!buffer) { this._ensureGroup(def.group); return false; }

    const spatial = this._resolveSpatial(def, opts);
    if (!spatial) return false;

    const now = this.ctx.currentTime;
    const [lo, hi] = def.rate || [1, 1];
    let rate = opts.rate ?? (lo + Math.random() * (hi - lo));
    if (!Number.isFinite(rate) || rate <= 0) rate = 1;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = !!def.loop;
    source.playbackRate.value = rate;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = clamp(spatial.cutoff, 200, 20000);
    filter.Q.value = def.category === 'shot' ? 0.5 : 0.7;

    const level = this.ctx.createGain();
    level.gain.value = Math.max(0, spatial.gain);

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = clamp(spatial.pan, -1, 1);

    const send = this.ctx.createGain();
    send.gain.value = Math.max(0, spatial.wet);

    source.connect(filter);
    filter.connect(level);
    level.connect(panner);
    panner.connect(this.mix);
    if (spatial.wet > 0) level.connect(send).connect(this.reverb);

    const voice = {
      category: def.category,
      group: opts.group || def.category,
      priority: spatial.priority,
      maxVoices: def.maxVoices,
      startedAt: now,
      loop: !!def.loop,
      stop: () => {},
    };

    let started = false;
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      if (started) { try { source.stop(); } catch {} }
      try { source.disconnect(); } catch {}
      try { filter.disconnect(); } catch {}
      try { level.disconnect(); } catch {}
      try { panner.disconnect(); } catch {}
      try { send.disconnect(); } catch {}
      this.budget.remove(voice);
    };
    voice.stop = cleanup;
    source.onended = cleanup;

    // Admit before scheduling; a rejected voice must not create a live source.
    if (!this.budget.admit(voice)) { cleanup(); return false; }

    const delay = Math.max(0, spatial.delay);
    source.start(now + delay);
    started = true;
    if (!def.loop) {
      try { source.stop(now + delay + buffer.duration / rate + 0.05); } catch {}
    }
    return true;
  }

  _resolveSpatial(def, opts) {
    const gain = opts.gain ?? 1;
    const delay = Math.max(0, opts.delay || 0);
    if (!opts.position) {
      return {
        gain: def.gain * gain, pan: 0, delay, dist: 0,
        cutoff: def.filter.near, wet: def.reverb || 0,
        priority: def.priority, occluded: false,
      };
    }
    if (!Number.isFinite(opts.position[0]) || !Number.isFinite(opts.position[2])) return null;
    const s = spatialFor(this.listenerPos, this.listenerYaw, opts.position, def.range);
    if (!s || s.dist > MAX_AUDIBLE) return null;

    let g = def.gain * gain * s.gain;
    let cutoff = cutoffFor(s.dist, def.filter);
    let wet = (def.reverb || 0) * (this.indoor ? 1.8 : 1);
    let priority = def.priority + clamp((def.range.max - s.dist) / def.range.max * 15, 0, 15);
    let occluded = false;

    // Occlusion is a single ray against the generated world; skip it for very
    // close or very distant sounds where the result is inaudible either way.
    if (this.world && s.dist > 3 && s.dist < 150) {
      if (this.world.lineOfSight(this.listenerPos, opts.position, 0.35) === false) {
        g *= 0.55;
        cutoff = Math.min(cutoff, cutoff * 0.45 + 250);
        wet *= 1.2;
        priority = Math.max(1, priority - 6);
        occluded = true;
      }
    }
    return { gain: g, pan: s.pan, delay: delay + s.delay, dist: s.dist, cutoff, wet, priority, occluded };
  }

  // Spatial helper retained for QA and callers that only need a point estimate.
  spatial(x, y, z) {
    return spatialFor(this.listenerPos, this.listenerYaw, [x, y, z],
      { ref: 4, rolloff: 0.35, max: 500 })
      || { gain: 0, pan: 0, delay: 0, dist: Infinity };
  }

  // -------------------------------------------------------------------------
  // Game actions
  // -------------------------------------------------------------------------
  // Gunfire near/far routing. The audible boundary is the 640 m distant
  // profile, not the 420 m close-shot profile, and the two recordings
  // crossfade over 90-130 m instead of switching hard at 110 m.
  shot(weaponKey, x, y, z, source = null) {
    if (!this.enabled) return false;
    const weapon = weaponKey || 'ar';
    const position = [x, y, z];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    const s = spatialFor(this.listenerPos, this.listenerYaw, position, SOUNDS.distantShot.range);
    if (!s) return false;
    const NEAR_FULL = 90, FAR_FULL = 130;
    const nearWeight = clamp((FAR_FULL - s.dist) / (FAR_FULL - NEAR_FULL), 0, 1);
    const farWeight = 1 - nearWeight;
    let played = false;
    if (nearWeight > 0) {
      played = this.play('shot', { position, variant: weapon, gain: nearWeight, source }) || played;
      if (nearWeight === 1 && s.dist < 14 && weapon !== 'rpg') {
        this.play('shellCasing', { position, gain: 0.55, delay: 0.06 + Math.random() * 0.05, source });
      }
    }
    if (farWeight > 0) {
      const farGain = farWeight * clamp(0.45 + s.dist / 500, 0.45, 1);
      played = this.play('distantShot', {
        position, gain: farGain, source: source == null ? 'far' : `${source}:far`,
      }) || played;
    }
    return played;
  }

  // Local prediction and the authoritative dry event describe the same trigger
  // pull; suppress the event when a prediction was just played.
  dryFire(origin = 'local') {
    const now = this.ctx?.currentTime ?? 0;
    if (!this._dryPredictions) this._dryPredictions = [];
    while (this._dryPredictions.length && now - this._dryPredictions[0] > 1.2) this._dryPredictions.shift();
    if (origin === 'event') {
      if (this._dryPredictions.length) { this._dryPredictions.shift(); return false; }
    } else {
      this._dryPredictions.push(now);
      if (this._dryPredictions.length > 4) this._dryPredictions.shift();
    }
    return this.play('dryFire');
  }

  reload(weapon, dur) {
    // Backwards compatibility: old callers passed only the duration.
    const key = typeof weapon === 'string' ? weapon : null;
    this.budget.cancel('reload');
    this.reloadCues.active = false;
    this.reloadCues.key = null;
    this.reloadCues.last = -1;
    // The per-phase cue stepper in updateActions() is the single reload Foley
    // path. Playing a complete reload recording here as well layered two
    // mechanical performances (and a magazine-insert double) on every reload.
    return !!key || dur !== undefined;
  }

  switchWeapon() {
    this.budget.cancel('reload');
    this.reloadCues.active = false;
    return this.play('weaponSwitch');
  }

  hit(headshot, kill) {
    const played = this.play('hitmarker', { rate: headshot ? 1.12 : 1 });
    if (kill) this.play('killConfirm');
    return played;
  }

  damage() { return this.play('damage', { gain: 1 }); }
  whiz(position, { delay = 0, distance = 0 } = {}) {
    const gain = clamp(1 - distance / 5, 0.25, 1);
    return this.play('whiz', { position, delay, gain });
  }

  explosion(x, y, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const position = [x, y, z];
    const s = spatialFor(this.listenerPos, this.listenerYaw, position, SOUNDS.explosion.range);
    if (s && s.dist > 180) return this.play('distantExplosion', { position });
    return this.play('explosion', { position });
  }

  vehicleDestroyed(position, id = null) {
    if (id != null) {
      if (!this._vehicleDead) this._vehicleDead = new Set();
      if (this._vehicleDead.has(id)) return false;
      this._vehicleDead.add(id);
      if (this._vehicleDead.size > 64) {
        const oldest = this._vehicleDead.values().next().value;
        this._vehicleDead.delete(oldest);
      }
    }
    return this.play('vehicleDestroy', { position, source: id ?? 'vehicle' });
  }

  impact(material, position, flight = 0) {
    if (!position) return false;
    const sound = IMPACT_SOUNDS[material] || 'impactConcrete';
    return this.play(sound, { position, delay: flight });
  }

  // Local footsteps are centred; remote footsteps use exactly the same spatial
  // and occlusion path as gunfire.
  footstep(surface, speed, x, y, z, id = 'self') {
    if (!this.enabled || !this.ctx) return false;
    const now = this.ctx.currentTime;
    const interval = speed > 5 ? 0.3 : 0.46;
    const last = this._steps.get(id) || -Infinity;
    if (now - last < interval) return false;
    this._steps.set(id, now);
    if (this._steps.size > 64) {
      for (const [key, at] of this._steps) if (now - at > 12) this._steps.delete(key);
    }
    const sound = FOOTSTEP_SOUNDS[surface] || 'footstepDirt';
    const position = x === undefined ? null : [x, y, z];
    const gain = clamp(0.75 + Math.min(0.35, speed * 0.04), 0.7, 1.1);
    return this.play(sound, { position, gain });
  }

  jump(position = null) { return this.play('jump', { position }); }
  land(surface, strength = 1, position = null) {
    const sound = FOOTSTEP_SOUNDS[surface] || 'footstepDirt';
    const gain = clamp(0.55 + strength * 0.45, 0.55, 1.2);
    const a = this.play('land', { position, gain });
    // A short surface tick keeps landings distinguishable on wood/metal/water.
    if (sound !== 'footstepDirt') this.play(sound, { position, gain: gain * 0.5, delay: 0.02 });
    return a;
  }

  pickup() { return this.play('pickup'); }
  heal() { return this.play('heal'); }

  ui(action = 'select') {
    return this.play(UI_SOUNDS[action] || 'uiSelect');
  }

  death() {
    this.budget.cancel('reload');
    this.budget.cancel('mechanism');
    this.reloadCues.active = false;
    return this.play('bodyFall');
  }

  // A single recorded alarm loop, owned by exactly one loop key. Repeated
  // toggles either reuse it or fade/stop it; a new toggle after stop creates a
  // fresh loop whose predecessor is already disconnected on `onended`.
  zoneAlarm(on) {
    if (!on) { this._stopLoop('zone-alarm', 0.25); return; }
    if (this._loops.has('zone-alarm')) return;
    const def = SOUNDS.zoneAlarm;
    this._startLoop('zone-alarm', def, def.clips[0], { gain: def.gain });
  }

  // -------------------------------------------------------------------------
  // Vehicle audio
  // -------------------------------------------------------------------------
  enterVehicle(position = null) {
    this.play('doorOpen', { position });
    this.play('engineStart', { position });
  }

  exitVehicle(position = null) {
    this.play('doorClose', { position });
    this.play('engineStop', { position });
  }

  vehicleImpact(position, intensity = 1) {
    return this.play('vehicleImpact', {
      position,
      gain: clamp(0.35 + intensity * 0.8, 0.35, 1.15),
      rate: 0.94 + Math.random() * 0.12,
    });
  }

  // Derive collision audio from replicated state: `shared/sim.js` has no
  // vehicle-collision event, but a sharp speed drop or health chunk is a
  // reliable presentation signal. This never feeds back into simulation.
  observeVehicles(list) {
    if (!this.enabled || !this.sessionActive || !Array.isArray(list)) return;
    const now = this.ctx?.currentTime ?? 0;
    const seen = new Set();
    for (const v of list) {
      seen.add(v.id);
      const prev = this._observe.get(v.id);
      const speed = v.speed || 0;
      const health = v.health ?? 0;
      if (prev) {
        if (prev.health > 0 && health <= 0) {
          this.vehicleDestroyed([v.x, v.y, v.z], v.id);
        } else {
          const dv = prev.speed - speed;
          const hit = dv > 6.5 || prev.health - health > 8;
          if (hit && now - (this._impactAt.get(v.id) || -99) > 0.55) {
            this._impactAt.set(v.id, now);
            this.vehicleImpact([v.x, v.y, v.z],
              clamp(Math.max(dv / 18, (prev.health - health) / 35), 0.35, 1));
          }
        }
      }
      // A repaired/respawned vehicle may be destroyed again later.
      if (health > 0) this._vehicleDead?.delete(v.id);
      this._observe.set(v.id, { speed, health });
    }
    if (this._observe.size > seen.size + 8) {
      for (const id of this._observe.keys()) if (!seen.has(id)) this._observe.delete(id);
    }
  }

  // Nearest occupied vehicle drives the engine mix. Recorded idle and drive
  // loops cross-fade by speed; both are created once and then parameterised.
  vehicleLoop(vehicle) {
    if (!this.enabled) return;
    this._ensureGroup('vehicle');
    if (!vehicle || vehicle.health <= 0 || vehicle.submerged) { this._fadeVehicle(); return; }
    const position = [vehicle.x, vehicle.y, vehicle.z];
    const s = spatialFor(this.listenerPos, this.listenerYaw, position, SOUNDS.engineIdle.range);
    if (!s) { this._fadeVehicle(); return; }

    if (this._vehicleId !== vehicle.id) this._vehicleId = vehicle.id;
    const speed = vehicle.speed || 0;
    const throttle = clamp(speed / 16, 0, 1);
    const idleClip = SOUNDS.engineIdle.clips[(vehicle.id >>> 0) % 3];
    const driveClip = SOUNDS.engineDrive.clips[(vehicle.id >>> 0) % 2];

    const idle = this._startLoop('engine-idle', SOUNDS.engineIdle, idleClip, { gain: 0, pan: s.pan });
    const drive = this._startLoop('engine-drive', SOUNDS.engineDrive, driveClip, { gain: 0, pan: s.pan });
    if (!idle || !drive) return;

    let occluded = false;
    if (this.world && s.dist > 3 && s.dist < 140) {
      occluded = this.world.lineOfSight(this.listenerPos, position, 0.35) === false;
    }
    const base = clamp(0.7 * s.gain * (occluded ? 0.55 : 1), 0, 0.8);
    const cutoff = cutoffFor(s.dist, SOUNDS.engineIdle.filter) * (occluded ? 0.45 : 1);
    const doppler = 1 + clamp((vehicle.forwardSpeed || 0) * 0.0022, -0.05, 0.05);

    this._setLoop(idle, {
      gain: base * (1 - throttle * 0.85),
      rate: (0.82 + throttle * 0.22) * doppler,
      cutoff, pan: s.pan,
    });
    this._setLoop(drive, {
      gain: base * throttle * 1.15,
      rate: (0.95 + throttle * 0.3) * doppler,
      cutoff: cutoff * (1 + throttle * 0.35), pan: s.pan,
    });

    const skid = (vehicle.braking && speed > 4) || speed > 13;
    if (skid) {
      const clip = SOUNDS.tireSkid.clips[(vehicle.id >>> 0) % 2];
      const loop = this._startLoop('tire-skid', SOUNDS.tireSkid, clip, { gain: 0, pan: s.pan });
      if (loop) {
        this._setLoop(loop, {
          gain: clamp((speed - 9) / 10, 0.12, 0.55) * s.gain * (occluded ? 0.6 : 1),
          rate: 0.95 + Math.min(0.12, speed * 0.004),
          cutoff: cutoff + 900, pan: s.pan,
        });
      }
    } else this._stopLoop('tire-skid', 0.3);

    if (vehicle.braking && !this._braking && speed > 3) {
      this.play('brake', { position, gain: 0.85 });
    }
    this._braking = !!vehicle.braking;
  }

  _fadeVehicle() {
    this._stopLoop('engine-idle', 0.6);
    this._stopLoop('engine-drive', 0.6);
    this._stopLoop('tire-skid', 0.25);
    this._vehicleId = null;
    this._braking = false;
  }

  // -------------------------------------------------------------------------
  // Ambience and session lifecycle
  // -------------------------------------------------------------------------
  setListener(pos, yaw) {
    this.listenerPos = pos;
    this.listenerYaw = yaw;
    const indoor = indoorAt(this.world, pos);
    const changed = indoor !== this.indoor;
    this.indoor = indoor;
    if (this.ctx) {
      const listener = this.ctx.listener;
      if (listener.positionX && listener.positionY && listener.positionZ) {
        listener.positionX.value = pos[0];
        listener.positionY.value = pos[1];
        listener.positionZ.value = pos[2];
      } else {
        listener.setPosition(...pos);
      }
      if (listener.forwardX && listener.forwardY && listener.forwardZ &&
        listener.upX && listener.upY && listener.upZ) {
        listener.forwardX.value = -Math.sin(yaw);
        listener.forwardY.value = 0;
        listener.forwardZ.value = -Math.cos(yaw);
        listener.upX.value = 0;
        listener.upY.value = 1;
        listener.upZ.value = 0;
      } else {
        listener.setOrientation(-Math.sin(yaw), 0, -Math.cos(yaw), 0, 1, 0);
      }
    }
    if (changed) this._syncAmbience();
  }

  _ensureGroup(group) {
    if (!group || this._requestedGroups.has(group)) return;
    this._requestedGroups.add(group);
    const pending = this.samples?.loadGroups([group]);
    if (pending?.then) pending.then(() => { if (this.sessionActive) this._syncAmbience(); });
  }

  startSession() {
    if (this.enabled) {
      this.budget.cancel();
      this._stopAllLoops(0.05);
      this.reloadCues = new ReloadCues();
      this._steps.clear();
      this._lastClip.clear();
      this._lastPlayed.clear();
      this._observe.clear();
      this._impactAt.clear();
      this._vehicleDead?.clear();
      this._dryPredictions = [];
      this._vehicleId = null;
      this._braking = false;
      this.lastActionWeapon = null;
      this.lastShotAge = Infinity;
      this.sessionActive = true;
      this._syncAmbience();
    }
  }

  endSession() {
    this.sessionActive = false;
    this.budget.cancel();
    this._stopAllLoops(0.05);
    this.reloadCues = new ReloadCues();
    this._steps.clear();
    this._observe.clear();
    this._impactAt.clear();
    this._vehicleDead?.clear();
    this._dryPredictions = [];
    this._vehicleId = null;
    this._braking = false;
  }

  _syncAmbience() {
    if (!this.enabled || !this.sessionActive) return;
    this._ensureGroup('ambience');
    const inside = this.indoor;
    const set = (key, sound, gain) => {
      const def = SOUNDS[sound];
      const loop = this._startLoop(key, def, def.clips[0], { gain });
      if (loop) this._setLoop(loop, { gain, rate: 1 });
    };
    set('amb-wind', 'ambWind', SOUNDS.ambWind.gain * (inside ? 0.45 : 1));
    // Recorded bird ambience stays in the library but is not part of the
    // default mix: it is a fixed loop that reads as repetitive after minutes of
    // play. Keep it explicitly stopped if an older session started it.
    this._stopLoop('amb-birds', 0.4);
    set('amb-battle', 'ambBattle', SOUNDS.ambBattle.gain * (inside ? 0.7 : 1));
  }

  // -------------------------------------------------------------------------
  // Reload / weapon phase presentation
  // -------------------------------------------------------------------------
  updateActions(player, shotAge = Infinity) {
    const active = !!player?.alive && player.reloadT > 0;
    if (!active || this.lastActionWeapon !== player?.weapon) {
      this.budget.cancel('reload');
      this.reloadCues.active = false;
    }
    const duration = CFG.WEAPONS[player?.weapon]?.reload || 1;
    for (const cue of this.reloadCues.step(player?.weapon, player?.reloadT || 0, duration, !!player?.alive)) {
      if (cue === 'bolt' && player?.weapon === 'shotgun') this.play('pump', { gain: 0.8 });
      else this.play(cue === 'mag-out' ? 'magOut' : cue === 'mag-in' ? 'magIn' : cue === 'bolt' ? 'bolt' : 'shell');
    }
    if (shotAge < this.lastShotAge || this.lastActionWeapon !== player?.weapon) this.lastShotAge = -1;
    if (player?.alive && !active) {
      const phases = player.weapon === 'sniper' ? [[0.23, 0.9], [0.76, 1.13], [0.98, 1.03]]
        : player.weapon === 'shotgun' ? [[0.14, 0.8], [0.34, 1.12]] : [];
      for (const [at, rate] of phases) {
        if (this.lastShotAge < at && shotAge >= at && Number.isFinite(shotAge)) {
          this.play(player.weapon === 'shotgun' ? 'pump' : 'bolt', { rate });
        }
      }
    } else this.budget.cancel('mechanism');
    this.lastShotAge = shotAge;
    this.lastActionWeapon = player?.weapon;
  }

  // -------------------------------------------------------------------------
  // Loops (engine, ambience, alarm, tyre skid)
  // -------------------------------------------------------------------------
  _startLoop(key, def, clipName, { gain = 0, pan = 0 } = {}) {
    if (!this.enabled || !this.ctx) return null;
    const existing = this._loops.get(key);
    if (existing && existing.clip === clipName) return existing;
    if (existing) this._stopLoop(key, 0.12);

    const buffer = this.samples?.buffer(clipName);
    if (!buffer) { this._ensureGroup(def.group); return null; }

    const now = this.ctx.currentTime;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.playbackRate.value = def.rate?.[0] ?? 1;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = def.filter.near;

    const level = this.ctx.createGain();
    level.gain.value = 0;

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = clamp(pan, -1, 1);

    const send = this.ctx.createGain();
    send.gain.value = def.reverb || 0;

    source.connect(filter);
    filter.connect(level);
    level.connect(panner);
    panner.connect(this.mix);
    if (send.gain.value > 0) level.connect(send).connect(this.reverb);

    source.start(now);
    level.gain.setTargetAtTime(Math.max(0, gain), now, 0.06);

    const loop = { key, clip: clipName, def, source, filter, level, panner, send, disposed: false };
    source.onended = () => this._disposeLoop(loop);
    this._loops.set(key, loop);
    return loop;
  }

  _setLoop(loop, { gain, rate, cutoff, pan }) {
    if (!loop || loop.disposed || !this.ctx) return;
    const now = this.ctx.currentTime;
    if (gain !== undefined) loop.level.gain.setTargetAtTime(Math.max(0.0001, gain), now, 0.12);
    if (rate !== undefined) loop.source.playbackRate.setTargetAtTime(Math.max(0.1, rate), now, 0.15);
    if (cutoff !== undefined) loop.filter.frequency.setTargetAtTime(clamp(cutoff, 120, 20000), now, 0.18);
    if (pan !== undefined) loop.panner.pan.setTargetAtTime(clamp(pan, -1, 1), now, 0.1);
  }

  _stopLoop(key, fade = 0.25) {
    const loop = this._loops.get(key);
    if (!loop) return;
    this._loops.delete(key);
    loop.disposed = true;
    if (!this.ctx) { this._disposeLoop(loop); return; }
    const now = this.ctx.currentTime;
    try {
      loop.level.gain.cancelScheduledValues(now);
      loop.level.gain.setTargetAtTime(0.0001, now, Math.max(0.01, fade / 3));
      loop.source.stop(now + fade);
    } catch { this._disposeLoop(loop); return; }
    // onended normally disposes; this is the failure-safe path.
    setTimeout(() => this._disposeLoop(loop), Math.ceil((fade + 0.2) * 1000));
  }

  _disposeLoop(loop) {
    if (!loop || loop._gone) return;
    loop._gone = true;
    for (const node of [loop.source, loop.filter, loop.level, loop.panner, loop.send]) {
      try { node?.disconnect(); } catch {}
    }
    if (this._loops.get(loop.key) === loop) this._loops.delete(loop.key);
  }

  _stopAllLoops(fade = 0.05) {
    for (const key of [...this._loops.keys()]) this._stopLoop(key, fade);
  }

  // -------------------------------------------------------------------------
  // Mixer telemetry / generated reverb tail
  // -------------------------------------------------------------------------
  getLevels() {
    if (!this.ctx || !this.analyser) return { peak: 0, rms: 0, state: 'none' };
    if (!this._levelBuf || this._levelBuf.length !== this.analyser.fftSize) {
      this._levelBuf = new Float32Array(this.analyser.fftSize);
    }
    this.analyser.getFloatTimeDomainData(this._levelBuf);
    let peak = 0, sum = 0;
    for (let i = 0; i < this._levelBuf.length; i++) {
      const v = this._levelBuf[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
    }
    return { peak, rms: Math.sqrt(sum / this._levelBuf.length), state: this.ctx.state };
  }

  // Deterministic-length noise decay used only as a convolution tail. This is
  // processing of the recorded mix, not a substitute for any game sound.
  _makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const buffer = this.ctx.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      let last = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const white = Math.random() * 2 - 1;
        last = 0.97 * last + 0.03 * white;
        data[i] = (white * 0.7 + last * 0.3) * Math.pow(1 - t, decay);
      }
    }
    return buffer;
  }
}
