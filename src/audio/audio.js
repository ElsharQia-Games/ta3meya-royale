// Local CC0 samples with procedural low-frequency/ambience layers. Distant
// sounds have propagation delay, occlusion filtering and HRTF spatial panning.
//
// Bus: voices -> master gain -> glue compressor -> brick-wall limiter ->
//      analyser -> destination. The limiter keeps overlapping gunfire and
//      explosions below full scale; the analyser is used by QA to measure it.
import { clamp } from '../../shared/math.js';
import { CFG } from '../../shared/config.js';
import { SampleBank, ReloadCues } from './samples.js';

const SPEED_OF_SOUND = 343;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.comp = null;
    this.limiter = null;
    this.analyser = null;
    this.enabled = false;
    this.volume = 0.65;
    this.muted = false;
    this.listenerYaw = 0;
    this.listenerPos = [0, 0, 0];
    this._noise = null;
    this._ambient = null;
    this._zone = null;
    this._lastStep = 0;
    this._steps = new Map();
    this._levelBuf = null;
    this._gesture = null;
    this.voices = new Set();
    this.samples = null;
    this.reloadCues = new ReloadCues();
    this.variant = 0;
    this.world = null;
    this.lastActionWeapon = null;
    this.lastShotAge = Infinity;
  }

  init() {
    if (this.ctx) { this.resume(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
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

    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : clamp(this.volume, 0, 1);
    this.master.connect(this.comp);
    this.comp.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this._noise = this._makeNoise(2.0);
    this.samples = new SampleBank(this.ctx);
    this.samples.load();
    this._startAmbient();
    this.enabled = true;

    // Autoplay policies suspend a context created before the first gesture.
    // Resume on the next pointer/key event as well as the join click.
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
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, .025);
  }

  playSample(key, { gain = 1, rate = 1, position = null, delay = 0, cutoff = 14000, group = null } = {}) {
    const buffer = this.samples?.buffers.get(key);
    if (!this.enabled || !buffer) return false;
    if (this.voices.size >= 48) this.voices.values().next().value.stop();
    const source = this.ctx.createBufferSource(); source.buffer = buffer; source.playbackRate.value = rate;
    const filter = this.ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = cutoff;
    const level = this.ctx.createGain(); level.gain.value = Math.max(0, gain);
    const panner = position ? this.ctx.createPanner() : this.ctx.createStereoPanner();
    if (position) {
      panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; panner.refDistance = 3; panner.maxDistance = 600; panner.rolloffFactor = .65;
      if (panner.positionX && panner.positionY && panner.positionZ) {
        panner.positionX.value = position[0]; panner.positionY.value = position[1]; panner.positionZ.value = position[2];
      } else {
        panner.setPosition(...position);
      }
    }
    source.connect(filter).connect(level).connect(panner).connect(this.master);
    const voice = { group, stop: () => { this.voices.delete(voice); try { source.stop(); } catch {} } };
    const release = () => { source.disconnect(); filter.disconnect(); level.disconnect(); panner.disconnect(); this.voices.delete(voice); };
    source.onended = release;
    this.voices.add(voice); source.start(this.ctx.currentTime + delay);
    return true;
  }

  cancelGroup(group) { for (const voice of this.voices) if (voice.group === group) voice.stop(); }

  updateActions(player, shotAge = Infinity) {
    const active = !!player?.alive && player.reloadT > 0;
    if (!active || this.lastActionWeapon !== player?.weapon) this.cancelGroup('reload');
    const W = CFG.WEAPONS[player?.weapon];
    for (const cue of this.reloadCues.step(player?.weapon, player?.reloadT || 0, W?.reload || 1, !!player?.alive)) {
      if (!this.playSample(cue, { gain: .42, group: 'reload' })) this._noiseBurst(.055, .1, 'bandpass', 2100, 1.2);
    }
    if (shotAge < this.lastShotAge || this.lastActionWeapon !== player?.weapon) this.lastShotAge = -1;
    if (player?.alive && !active) {
      const phases = player.weapon === 'sniper' ? [[.23, .22, .9], [.76, .14, 1.13], [.98, .18, 1.03]]
        : player.weapon === 'shotgun' ? [[.14, .2, .8], [.34, .22, 1.12]] : [];
      for (const [at, gain, rate] of phases) if (this.lastShotAge < at && shotAge >= at && Number.isFinite(shotAge)) {
        this.playSample('bolt', { gain, rate, group: 'mechanism' });
      }
    } else this.cancelGroup('mechanism');
    this.lastShotAge = shotAge; this.lastActionWeapon = player?.weapon;
  }

  // Time-domain levels after the limiter. QA uses this to prove no clipping.
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

  _makeNoise(seconds) {
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      const white = Math.random() * 2 - 1;
      last = 0.97 * last + 0.03 * white;
      d[i] = white * 0.7 + last * 0.3;
    }
    return buf;
  }

  _startAmbient() {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 60;
    const g = this.ctx.createGain();
    g.gain.value = 0.055;
    // slow gust modulation
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.025;
    lfo.connect(lfoGain).connect(g.gain);
    lfo.start();
    src.connect(hp).connect(lp).connect(g).connect(this.master);
    src.start();
    this._ambient = g;

    // distant battle rumble
    const src2 = this.ctx.createBufferSource();
    src2.buffer = this._noise;
    src2.loop = true;
    const lp2 = this.ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = 120;
    const g2 = this.ctx.createGain();
    g2.gain.value = 0.03;
    src2.connect(lp2).connect(g2).connect(this.master);
    src2.start();
  }

  _panner(pan) {
    const p = this.ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    p.connect(this.master);
    return p;
  }

  _noiseBurst(dur, gain, filterType, freq, q, when = 0, pan = 0) {
    const t = this.ctx.currentTime + when;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const panner = this._panner(pan);
    src.connect(f).connect(g).connect(panner);
    src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); panner.disconnect(); };
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  _tone(freq, dur, gain, type = 'sine', when = 0, pan = 0, glide = null) {
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(20, glide), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const panner = this._panner(pan);
    o.connect(g).connect(panner);
    o.onended = () => { o.disconnect(); g.disconnect(); panner.disconnect(); };
    o.start(t); o.stop(t + dur + 0.05);
  }

  // Spatial helper: returns {gain, pan, delay} for a world point.
  spatial(x, y, z) {
    const lx = this.listenerPos[0], ly = this.listenerPos[1], lz = this.listenerPos[2];
    const dx = x - lx, dy = y - ly, dz = z - lz;
    const dist = Math.hypot(dx, dy, dz);
    const yaw = this.listenerYaw;
    // listener forward = (-sin(yaw), -cos(yaw)); right = (cos(yaw), -sin(yaw))
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const pan = dist > 0.01 ? clamp((dx * rx + dz * rz) / dist, -1, 1) * 0.85 : 0;
    const gain = 1 / (1 + dist * 0.045);
    return { gain, pan, delay: Math.min(0.5, dist / SPEED_OF_SOUND), dist };
  }

  shot(weaponKey, x, y, z) {
    if (!this.enabled) return;
    const s = this.spatial(x, y, z);
    if (s.dist > 320) return;
    const near = s.dist < 12;
    const w = weaponKey || 'ar';
    const loud = { sniper: 1.35, dmr: 1.15, shotgun: 1.25, lmg: 1.1, ar: 1, smg: 0.85, pistol: 0.8 }[w] || 1;
    const lp = s.dist > 60 ? 1800 : s.dist > 25 ? 3600 : 9000;
    const occluded = s.dist > 4 && this.world && !this.world.lineOfSight(this.listenerPos, [x, y, z], .4);
    const sample = w === 'rpg' ? 'rocket-launch' : `${s.dist > 65 ? 'rifle-distant' : w}-${++this.variant % 2 + 1}`;
    if (this.playSample(sample, { gain: loud * (occluded ? .48 : .85), rate: .98 + Math.random() * .04,
      position: s.dist < 2 ? null : [x, y, z], delay: s.dist < 2 ? 0 : s.delay, cutoff: occluded ? 1000 : lp })) {
      if (near && ['rpg', 'sniper', 'shotgun'].includes(w)) this._tone(w === 'rpg' ? 52 : 80, .17, .16, 'sine', s.delay, s.pan, 32);
      if (w === 'rpg') this.playSample('shotgun-1', { gain: .34, rate: .72, position: s.dist < 2 ? null : [x, y, z], delay: s.delay, cutoff: 2200 });
      return;
    }
    this._noiseBurst(0.22 * loud, 0.55 * s.gain * loud, 'lowpass', lp, 0.9, s.delay, s.pan);
    this._tone(115 * (0.9 + Math.random() * 0.2), 0.16, 0.34 * s.gain * loud, 'triangle', s.delay, s.pan, 48);
    if (near) {
      this._noiseBurst(0.05, 0.2, 'highpass', 3800, 1.2, s.delay, s.pan);
      this._tone(2200, 0.03, 0.06, 'square', s.delay, s.pan, 900);
    }
  }

  dryFire() {
    if (!this.enabled) return;
    this._tone(1800, 0.03, 0.08, 'square', 0, 0, 700);
  }

  reload(dur = 2) {
    this.cancelGroup('reload');
    this.reloadCues.active = false;
  }

  switchWeapon() {
    if (!this.enabled) return;
    this.cancelGroup('reload'); this.reloadCues.active = false;
    if (this.playSample('mag-out', { gain: .22, rate: .88 })) return;
    this._noiseBurst(0.06, 0.12, 'bandpass', 1900, 1.2);
    this._tone(420, 0.04, 0.06, 'square', 0.06);
  }

  hit(headshot, kill) {
    if (!this.enabled) return;
    this._tone(headshot ? 1450 : 900, 0.05, 0.16, 'sine', 0, 0, headshot ? 1200 : 700);
    if (kill) this._tone(520, 0.18, 0.14, 'triangle', 0.05, 0, 260);
  }

  damage() {
    if (!this.enabled) return;
    this._noiseBurst(0.18, 0.3, 'lowpass', 700, 0.8);
    this._tone(90, 0.22, 0.2, 'sine', 0, 0, 55);
  }

  whiz(pan = 0) {
    if (!this.enabled) return;
    this._noiseBurst(0.16, 0.16, 'bandpass', 2400, 3.5, 0, pan);
  }

  explosion(x, y, z) {
    if (!this.enabled) return;
    const s = this.spatial(x, y, z);
    if (s.dist > 600) return;
    if (this.playSample('blast-1', { gain: 1.1, position: [x, y, z], delay: s.delay, cutoff: s.dist > 80 ? 2000 : 9000 })) {
      this.playSample('blast-2', { gain: .64, position: [x, y, z], delay: s.delay, rate: .9 });
      this._tone(57, .65, .28 * s.gain, 'sine', s.delay, s.pan, 27);
      return;
    }
    this._noiseBurst(0.9, 0.8 * s.gain, 'lowpass', s.dist > 80 ? 320 : 900, 0.8, s.delay, s.pan);
    this._tone(62, 0.8, 0.5 * s.gain, 'sine', s.delay, s.pan, 28);
  }

  impact(material, position, flight = 0) {
    if (!this.enabled || !position) return;
    const spatial = this.spatial(...position);
    if (spatial.dist > 85) return;
    const key = material === 'metal' ? 'impact-metal' : material === 'glass' ? 'impact-glass'
      : material === 'wood' ? 'impact-wood' : 'body-fall';
    this.playSample(key, { gain: material === 'metal' ? .5 : .31, rate: .85 + Math.random() * .22,
      position, delay: flight + spatial.delay, cutoff: material === 'metal' ? 6500 : 2100 });
  }

  // Local footsteps pass no position (centred); remote footsteps pass a world
  // point and are attenuated/panned exactly like gunfire.
  footstep(surface, speed, x, y, z, id = 'self') {
    if (!this.enabled) return;
    const now = this.ctx.currentTime;
    const interval = speed > 5 ? 0.3 : 0.46;
    const last = this._steps.get(id) || 0;
    if (now - last < interval) return;
    this._steps.set(id, now);
    if (this._steps.size > 64) for (const [key, at] of this._steps) if (now - at > 12) this._steps.delete(key);
    this._lastStep = now;
    let gain = 0.075 + Math.min(0.06, speed * 0.008);
    let pan = 0;
    if (x !== undefined) {
      const s = this.spatial(x, y, z);
      if (s.dist > 60) return;
      gain *= s.gain;
      pan = s.pan;
    }
    const freq = surface === 'wood' ? 320 : surface === 'metal' ? 620 : surface === 'water' ? 900 : 210;
    const material = surface === 'wood' ? 'wood' : ['concrete', 'metal', 'road'].includes(surface) ? 'concrete' : 'grass';
    if (surface !== 'water' && this.playSample(`step-${material}-${++this.variant % 2 + 1}`,
      { gain: (x === undefined ? .25 : .4), rate: .93 + Math.random() * .1, position: x === undefined ? null : [x, y, z] })) return;
    this._noiseBurst(0.07, gain, 'bandpass', freq, 1.1, 0, pan);
  }

  heal() {
    if (!this.enabled) return;
    this._tone(520, 0.25, 0.06, 'sine', 0, 0, 660);
    this._tone(780, 0.3, 0.04, 'sine', 0.08, 0, 900);
  }

  pickup() {
    if (!this.enabled) return;
    this._tone(660, 0.07, 0.08, 'triangle', 0, 0, 880);
    this._tone(990, 0.1, 0.05, 'triangle', 0.06);
  }

  zoneAlarm(on) {
    if (!this.enabled) return;
    if (on && !this._zone) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 74;
      const g = this.ctx.createGain();
      g.gain.value = 0.0;
      g.gain.linearRampToValueAtTime(0.05, this.ctx.currentTime + 0.5);
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 260;
      o.connect(f).connect(g).connect(this.master);
      o.start();
      this._zone = { o, g };
    } else if (!on && this._zone) {
      const { o, g } = this._zone;
      g.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 0.3);
      o.stop(this.ctx.currentTime + 0.4);
      this._zone = null;
    }
  }

  setListener(pos, yaw) {
    this.listenerPos = pos;
    this.listenerYaw = yaw;
    if (this.ctx) {
      const listener = this.ctx.listener;
      // Firefox exposes the method-only listener API. Check capabilities rather
      // than browser names: audio must not abort the camera/render frame.
      if (listener.positionX && listener.positionY && listener.positionZ) {
        listener.positionX.value = pos[0]; listener.positionY.value = pos[1]; listener.positionZ.value = pos[2];
      } else {
        listener.setPosition(...pos);
      }
      if (listener.forwardX && listener.forwardY && listener.forwardZ && listener.upX && listener.upY && listener.upZ) {
        listener.forwardX.value = -Math.sin(yaw); listener.forwardY.value = 0; listener.forwardZ.value = -Math.cos(yaw);
        listener.upX.value = 0; listener.upY.value = 1; listener.upZ.value = 0;
      } else {
        listener.setOrientation(-Math.sin(yaw), 0, -Math.cos(yaw), 0, 1, 0);
      }
    }
  }

  death() {
    this.cancelGroup('reload'); this.reloadCues.active = false;
    this.cancelGroup('mechanism');
    this.playSample('body-fall', { gain: .5 });
    if (this.enabled) this._tone(66, .65, .12, 'sine', 0, 0, 28);
  }

  ui(action = 'select') {
    this.playSample(`ui-${action}`, { gain: .18 });
  }

  vehicleLoop(vehicle) {
    if (!this.enabled) return;
    if (!this._engine && vehicle) {
      const gain = this.ctx.createGain(); gain.gain.value = 0;
      const filter = this.ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 500;
      const pan = this._panner(0);
      const fundamental = this.ctx.createOscillator(); fundamental.type = 'triangle';
      const exhaust = this.ctx.createOscillator(); exhaust.type = 'sawtooth';
      const exhaustGain = this.ctx.createGain(); exhaustGain.gain.value = .22;
      fundamental.connect(filter); exhaust.connect(exhaustGain).connect(filter);
      filter.connect(gain).connect(pan);
      fundamental.start(); exhaust.start();
      this._engine = { gain, filter, pan, fundamental, exhaust };
    }
    if (!this._engine) return;
    const loop = this._engine, now = this.ctx.currentTime;
    const spatial = vehicle ? this.spatial(vehicle.x, vehicle.y, vehicle.z) : { gain: 0, pan: 0, dist: Infinity };
    const active = vehicle && vehicle.health > 0 && !vehicle.submerged && spatial.dist < 90;
    const speed = vehicle?.speed || 0;
    loop.gain.gain.setTargetAtTime(active ? .12 * spatial.gain : 0, now, .15);
    loop.fundamental.frequency.setTargetAtTime(55 + speed * 6, now, .1);
    loop.exhaust.frequency.setTargetAtTime(27.5 + speed * 3, now, .1);
    loop.filter.frequency.setTargetAtTime(450 + speed * 20, now, .15);
    loop.pan.pan.setTargetAtTime(spatial.pan, now, .08);
  }
}
