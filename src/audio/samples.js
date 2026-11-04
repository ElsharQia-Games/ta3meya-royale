// Decoded once per AudioContext. Missing clips fail individually and callers
// fall back immediately; no old sound is replayed after an asynchronous load.
export const SAMPLE_KEYS = [
  ...['pistol', 'ar', 'smg', 'shotgun', 'sniper', 'dmr', 'lmg', 'rifle-distant'].flatMap(key => [`${key}-1`, `${key}-2`]),
  'step-grass-1', 'step-grass-2', 'step-concrete-1', 'step-concrete-2', 'step-wood-1', 'step-wood-2',
  'mag-out', 'mag-in', 'bolt', 'body-fall', 'impact-wood', 'impact-metal', 'impact-glass', 'shell',
  'blast-1', 'blast-2', 'rocket-launch', 'ui-select', 'ui-deploy', 'ui-open',
];

export class SampleBank {
  constructor(context, base = '/audio/') {
    this.context = context; this.base = base; this.buffers = new Map(); this.errors = [];
    this.loading = null;
  }
  load() {
    if (this.loading) return this.loading;
    this.loading = Promise.all(SAMPLE_KEYS.map(async key => {
      try {
        const response = await fetch(`${this.base}${key}.ogg`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
        this.buffers.set(key, buffer);
      } catch (error) { this.errors.push({ key, error: String(error) }); }
    }));
    return this.loading;
  }
}

// Phase crossings, rather than fixed delayed timers, follow actual reload time.
// Cancellation or changing guns discards all remaining Foley phases.
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
