'use strict';

/**
 * Tiny in-memory TTL cache. One process, one value per key.
 * Good enough for a single-instance internal portal; swap for Redis if you
 * scale to multiple instances.
 */
class TTLCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expires) {
      this.store.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key, value, ttlSeconds) {
    this.store.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  }

  delete(key) {
    this.store.delete(key);
  }
}

module.exports = new TTLCache();
