// In-memory stand-in for MQTTRelay used by peer-election tests.
// It implements only the surface joinPeerSession/BrowserHost rely on:
// connect(), subscribe()/unsub, publish(), close(), onStatus and onError.

function matchesTopic(filter, topic) {
  if (filter === topic) return true;
  if (filter.endsWith('/#')) {
    const prefix = filter.slice(0, -2);
    return topic === prefix || topic.startsWith(prefix + '/');
  }
  if (filter.includes('+')) {
    const fparts = filter.split('/');
    const tparts = topic.split('/');
    if (fparts.length !== tparts.length) return false;
    for (let i = 0; i < fparts.length; i++) {
      if (fparts[i] !== '+' && fparts[i] !== tparts[i]) return false;
    }
    return true;
  }
  return false;
}

function toBytes(payload) {
  if (typeof payload === 'string') return new TextEncoder().encode(payload);
  if (payload instanceof Uint8Array) return payload.slice();
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload.slice(0));
  return new TextEncoder().encode(JSON.stringify(payload));
}

export function createFakeBroker() {
  const subscriptions = new Map(); // filter -> Set<{ relay, handler }>
  const relays = [];

  class FakeRelay {
    constructor(opts = {}) {
      this.opts = opts;
      this.closed = false;
      this.connected = false;
      this.onStatus = opts.onStatus || null;
      this.onError = opts.onError || null;
      relays.push(this);
    }

    connect() {
      queueMicrotask(() => {
        if (this.closed) return;
        this.connected = true;
        if (this.onStatus) this.onStatus('connected');
      });
    }

    subscribe(filter, handler) {
      let set = subscriptions.get(filter);
      if (!set) { set = new Set(); subscriptions.set(filter, set); }
      const entry = { relay: this, handler };
      set.add(entry);
      return () => {
        set.delete(entry);
        if (set.size === 0) subscriptions.delete(filter);
      };
    }

    publish(topic, payload) {
      if (this.closed) return false;
      const bytes = toBytes(payload);
      queueMicrotask(() => {
        for (const [filter, set] of [...subscriptions]) {
          if (!matchesTopic(filter, topic)) continue;
          for (const entry of [...set]) {
            if (entry.relay.closed) continue;
            try { entry.handler(topic, bytes); } catch {}
          }
        }
      });
      return true;
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.connected = false;
      for (const set of subscriptions.values()) {
        for (const entry of [...set]) if (entry.relay === this) set.delete(entry);
      }
    }
  }

  return {
    Relay: FakeRelay,
    relays,
    subscriptionCount(filter) {
      return subscriptions.get(filter)?.size || 0;
    },
    activeSubscriptions() {
      let n = 0;
      for (const set of subscriptions.values()) n += set.size;
      return n;
    },
    subscriptionFilters() {
      return [...subscriptions.keys()];
    },
  };
}

export function waitFor(predicate, timeoutMs = 1000, intervalMs = 5) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (predicate()) return resolve(true);
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('waitFor timed out'));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
