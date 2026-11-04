// Procedural WebAudio: every sound is synthesised at runtime, so the project
// ships no audio files. Distant sounds are delayed by distance / speed of sound
// and panned relative to the listener.
import { clamp } from '../../shared/math.js';

const SPEED_OF_SOUND = 343;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = false;
    this.volume = 0.65;
    this.listenerYaw = 0;
    this.listenerPos = [0, 0, 0];
    this._noise = null;
    this._ambient = null;
    this._zone = null;
    this._lastStep = 0;
  }

  init() {
    if (this.ctx) { this.resume(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 18;
    comp.ratio.value = 5;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;
    comp.connect(this.ctx.destination);
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(comp);
    this._noise = this._makeNoise(2.0);
    this._startAmbient();
    this.enabled = true;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
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
    src.connect(f).connect(g).connect(this._panner(pan));
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
    o.connect(g).connect(this._panner(pan));
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
    if (!this.enabled) return;
    this._tone(320, 0.05, 0.09, 'square', 0.05);
    this._noiseBurst(0.04, 0.1, 'bandpass', 2600, 1.4, 0.18);
    this._tone(240, 0.05, 0.1, 'square', dur * 0.55);
    this._noiseBurst(0.05, 0.12, 'bandpass', 1800, 1.6, dur * 0.8);
  }

  switchWeapon() {
    if (!this.enabled) return;
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
    this._noiseBurst(0.9, 0.8 * s.gain, 'lowpass', s.dist > 80 ? 320 : 900, 0.8, s.delay, s.pan);
    this._tone(62, 0.8, 0.5 * s.gain, 'sine', s.delay, s.pan, 28);
  }

  footstep(surface, speed) {
    if (!this.enabled) return;
    const now = this.ctx.currentTime;
    if (now - this._lastStep < (speed > 5 ? 0.3 : 0.46)) return;
    this._lastStep = now;
    const freq = surface === 'wood' ? 320 : surface === 'metal' ? 620 : surface === 'water' ? 900 : 210;
    this._noiseBurst(0.07, 0.075 + Math.min(0.06, speed * 0.008), 'bandpass', freq, 1.1, 0, 0);
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
  }
}
