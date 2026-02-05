/**
 * Message Deduplication using TTL Map
 * Prevents processing the same message multiple times
 */

import { TTLMap } from './ttlMap.js';
import logger from './logger.js';

// Default TTL of 10 minutes for deduplication
const DEDUPE_TTL = 10 * 60 * 1000;

// Maximum entries to prevent memory bloat (LRU-like behavior)
const MAX_ENTRIES = 10000;

class MessageDeduplicator {
  constructor(ttl = DEDUPE_TTL, maxEntries = MAX_ENTRIES) {
    this.seen = new TTLMap(ttl);
    this.maxEntries = maxEntries;
    this.ttl = ttl;
  }

  /**
   * Check if a message has been seen before
   * @param {string} messageId - The serialized message ID
   * @returns {boolean} - True if duplicate, false if new
   */
  isDuplicate(messageId) {
    if (!messageId) {
      logger.warn('Dedupe check with empty messageId');
      return false;
    }

    if (this.seen.has(messageId)) {
      logger.debug('Duplicate message detected', { messageId });
      return true;
    }

    return false;
  }

  /**
   * Mark a message as seen
   * @param {string} messageId - The serialized message ID
   */
  markSeen(messageId) {
    if (!messageId) return;

    // Simple LRU-like eviction: if we're at max, delete oldest 10%
    if (this.seen.size >= this.maxEntries) {
      this.evictOldest();
    }

    this.seen.set(messageId, true, this.ttl);
  }

  /**
   * Check and mark in one operation (atomic-ish)
   * @param {string} messageId
   * @returns {boolean} - True if duplicate (should skip), false if new (proceed)
   */
  checkAndMark(messageId) {
    if (this.isDuplicate(messageId)) {
      return true; // Is duplicate, skip
    }
    this.markSeen(messageId);
    return false; // Not duplicate, proceed
  }

  /**
   * Evict oldest entries when at capacity
   */
  evictOldest() {
    // Delete about 10% of entries
    const toDelete = Math.floor(this.maxEntries * 0.1);
    let deleted = 0;

    for (const [key] of this.seen.map) {
      if (deleted >= toDelete) break;
      this.seen.delete(key);
      deleted++;
    }

    logger.debug('Evicted old dedupe entries', { count: deleted });
  }

  /**
   * Get current size
   * @returns {number}
   */
  get size() {
    return this.seen.size;
  }

  /**
   * Clean up resources
   */
  destroy() {
    this.seen.destroy();
  }
}

// Singleton instance
export const deduplicator = new MessageDeduplicator();

export default deduplicator;
