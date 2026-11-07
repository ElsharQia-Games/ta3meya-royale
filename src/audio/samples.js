import { assetUrl } from '../asset.js';

// Manifest-driven sample bank.
//
// Startup only decodes the `core` group. Vehicle and ambience clips are loaded
// on demand so a match that never touches a car does not pay for engine loops.
// A clip that fails to load is recorded once and simply never plays; there is
// no synthesized substitute.
export class SampleBank {
  constructor(context, base = assetUrl('audio/')) {
    this.context = context;
    this.base = base.endsWith('/') ? base : base + '/';
    this.manifest = null;
    this.clips = new Map();       // name -> manifest entry
    this.buffers = new Map();     // name -> AudioBuffer
    this.errors = [];             // { key, error }
    this.groups = new Map();      // group -> Set(names)
    this.loadedGroups = new Set();
    this._manifestPromise = null;
    this._inflight = new Map();
    this.loading = null;
  }

  // Fetch and index manifest.json exactly once.
  async manifestData() {
    if (!this._manifestPromise) {
      this._manifestPromise = (async () => {
        const response = await fetch(`${this.base}manifest.json`);
        if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
        const data = await response.json();
        this.manifest = data;
        for (const clip of data.clips || []) this.clips.set(clip.name, clip);
        for (const [group, names] of Object.entries(data.groups || {})) {
          this.groups.set(group, new Set(names));
        }
        return data;
      })();
    }
    return this._manifestPromise;
  }

  // Core group is what the menu and every session need. Kept for callers that
  // simply await bank.loading.
  load() {
    if (!this.loading) this.loading = this.loadGroups(['core']);
    return this.loading;
  }

  async loadGroups(groups) {
    let data;
    try { data = await this.manifestData(); }
    catch (error) { this.errors.push({ key: 'manifest', error: String(error) }); return; }
    const jobs = [];
    for (const group of groups) {
      if (this.loadedGroups.has(group)) continue;
      const names = this.groups.get(group);
      if (!names) { this.errors.push({ key: group, error: 'unknown group' }); continue; }
      for (const name of names) jobs.push(this._loadClip(name));
    }
    await Promise.all(jobs);
    for (const group of groups) this.loadedGroups.add(group);
  }

  async loadNames(names) {
    try { await this.manifestData(); }
    catch { return; }
    await Promise.all(names.map(name => this._loadClip(name)));
  }

  _loadClip(name) {
    if (this.buffers.has(name)) return Promise.resolve(this.buffers.get(name));
    if (this._inflight.has(name)) return this._inflight.get(name);
    const job = (async () => {
      const clip = this.clips.get(name);
      if (!clip) { this.errors.push({ key: name, error: 'missing manifest entry' }); return null; }
      try {
        const response = await fetch(`${this.base}${clip.file}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
        this.buffers.set(name, buffer);
        return buffer;
      } catch (error) {
        this.errors.push({ key: name, error: String(error) });
        return null;
      } finally {
        this._inflight.delete(name);
      }
    })();
    this._inflight.set(name, job);
    return job;
  }

  buffer(name) { return this.buffers.get(name) || null; }
  info(name) { return this.clips.get(name) || null; }
  seconds(name) { return this.clips.get(name)?.seconds || 0; }
  hasGroup(group) { return this.loadedGroups.has(group); }
}

// Phase crossings, rather than fixed delayed timers, follow actual reload time.
// Cancellation or changing guns discards all remaining Foley phases.
// Kept API-compatible: callers receive logical ids and map them to recordings.
export class ReloadCues {
  constructor() { this.key = null; this.last = -1; this.active = false; }
  step(key, remaining, duration, enabled = true) {
    if (!enabled || !key || remaining <= 0) { this.active = false; this.key = null; this.last = -1; return []; }
    const progress = Math.max(0, Math.min(1, 1 - remaining / duration));
    if (!this.active || this.key !== key || progress < this.last - .05) { this.last = -1; this.key = key; this.active = true; }
    const phases = key === 'rpg' ? [[.07, 'mag-out'], [.35, 'shell'], [.69, 'mag-in'], [.89, 'bolt']]
      : key === 'shotgun' ? [[.14, 'shell'], [.32, 'shell'], [.5, 'shell'], [.68, 'shell'], [.9, 'bolt']]
        : [[.05, 'mag-out'], [.62, 'mag-in'], [.86, 'bolt']];
    const cues = phases.filter(([at]) => at > this.last && at <= progress).map(([, clip]) => clip);
    this.last = progress;
    return cues;
  }
}
