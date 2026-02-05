/**
 * TTL Map - A Map with automatic expiration of entries
 * Used for user memory, cooldowns, and deduplication
 */

export class TTLMap {
  constructor(defaultTTL = 30 * 60 * 1000) {
    this.map = new Map();
    this.timers = new Map();
    this.defaultTTL = defaultTTL;

    // Periodic cleanup every 5 minutes to catch any stragglers
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Set a value with optional custom TTL
   * @param {string} key
   * @param {any} value
   * @param {number} ttl - Time to live in milliseconds (optional)
   */
  set(key, value, ttl = this.defaultTTL) {
    // Clear existing timer if any
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
    }

    this.map.set(key, {
      value,
      expiresAt: Date.now() + ttl,
    });

    // Set expiration timer
    const timer = setTimeout(() => {
      this.delete(key);
    }, ttl);

    // Don't block process exit
    timer.unref();
    this.timers.set(key, timer);
  }

  /**
   * Get a value, returns undefined if expired or not found
   * @param {string} key
   * @returns {any}
   */
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return undefined;
    }

    return entry.value;
  }

  /**
   * Check if key exists and is not expired
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    const entry = this.map.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete a key
   * @param {string} key
   */
  delete(key) {
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
    this.map.delete(key);
  }

  /**
   * Update an existing entry, refreshing its TTL
   * @param {string} key
   * @param {function} updater - Function that receives old value and returns new value
   * @param {number} ttl - Optional new TTL
   */
  update(key, updater, ttl = this.defaultTTL) {
    const current = this.get(key);
    const newValue = updater(current);
    this.set(key, newValue, ttl);
  }

  /**
   * Get the number of active entries
   * @returns {number}
   */
  get size() {
    return this.map.size;
  }

  /**
   * Clean up expired entries
   */
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (now > entry.expiresAt) {
        this.delete(key);
      }
    }
  }

  /**
   * Clear all entries and timers
   */
  clear() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.map.clear();
  }

  /**
   * Destroy the TTL map, clearing interval
   */
  destroy() {
    clearInterval(this.cleanupInterval);
    this.clear();
  }
}

export default TTLMap;
