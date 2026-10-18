/**
 * In-memory LRU cache of translations for one page.
 *
 * It lives inside the content script, so it is discarded together with the page:
 * leaving the page or reloading it drops every entry, and nothing is written to disk.
 * The owner clears it whenever a setting that changes the output is modified.
 *
 * Values may be plain strings or promises. A promise lets concurrent callers
 * share one in-flight request (see getOrCreate).
 */
class TranslationCache {
  /** @param {number} limit maximum number of entries kept at once */
  constructor(limit = 500) {
    this.limit = limit;
    this.map = new Map();
  }

  get size() {
    return this.map.size;
  }

  has(key) {
    return this.map.has(key);
  }

  /** Returns the stored value and marks the entry as most recently used. */
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      this.map.delete(this.map.keys().next().value); // evict the least recently used
    }
  }

  delete(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  /**
   * Returns the cached entry for `key`, or stores and returns `factory()`.
   * Concurrent callers with the same key share one promise.
   * A failed factory is removed, so the next call tries again.
   */
  getOrCreate(key, factory) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = Promise.resolve()
      .then(factory)
      .catch((err) => {
        this.delete(key);
        throw err;
      });
    this.set(key, pending);
    return pending;
  }
}

if (typeof module !== 'undefined') {
  module.exports = { TranslationCache };
}
