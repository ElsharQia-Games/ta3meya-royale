// Bounded voice admission with category caps and priority stealing.
// Pure bookkeeping: each admitted voice exposes stop(reason). The audio engine
// owns the node graph and registers its cleanup as voice.stop.
export class VoiceBudget {
  constructor(limit = 40) {
    this.limit = Math.max(1, limit | 0);
    this.voices = new Set();
  }

  get size() { return this.voices.size; }

  count(category) {
    let n = 0;
    for (const voice of this.voices) if (voice.category === category) n++;
    return n;
  }

  // Lowest priority (then oldest) voice below the incoming priority.
  _victim(category, priority) {
    let victim = null;
    for (const voice of this.voices) {
      if (category && voice.category !== category) continue;
      if (voice.priority >= priority) continue;
      if (!victim || voice.priority < victim.priority ||
        (voice.priority === victim.priority && voice.startedAt < victim.startedAt)) {
        victim = voice;
      }
    }
    return victim;
  }

  // Returns true when the voice was admitted. A false result means the caller
  // must not create or must immediately dispose the node graph.
  admit(voice) {
    const cap = Math.max(1, voice.maxVoices || 1);
    while (this.count(voice.category) >= cap) {
      const victim = this._victim(voice.category, voice.priority);
      if (!victim) return false;
      victim.stop('category');
    }
    while (this.voices.size >= this.limit) {
      const victim = this._victim(null, voice.priority);
      if (!victim) return false;
      victim.stop('budget');
    }
    this.voices.add(voice);
    return true;
  }

  remove(voice) { this.voices.delete(voice); }

  cancel(category) {
    for (const voice of [...this.voices]) {
      if (!category || voice.category === category) voice.stop('cancel');
    }
  }
}
