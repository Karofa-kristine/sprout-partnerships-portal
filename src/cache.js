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
    if (Date.now() > hit.expires) return null; // expired, but kept for getStale()
    return hit.value;
  }

  // Last stored value even if expired (up to maxAgeSeconds old), as
  // { value, at }. Used to keep showing the last good RADAR result when a
  // refresh fails.
  getStale(key, maxAgeSeconds = 86400) {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > maxAgeSeconds * 1000) {
      this.store.delete(key);
      return null;
    }
    return { value: hit.value, at: hit.at };
  }

  set(key, value, ttlSeconds) {
    this.store.set(key, { value, expires: Date.now() + ttlSeconds * 1000, at: Date.now() });
  }

  delete(key) {
    this.store.delete(key);
  }
}

module.exports = new TTLCache();
