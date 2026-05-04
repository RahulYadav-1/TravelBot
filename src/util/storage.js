/**
 * PersistentStore - JSON-file-backed key-value store with TTL support
 *
 * Drop-in compatible with the TTLMap interface so it can replace
 * userRegistry / userMemory in src/index.js for durable persistence
 * across restarts.
 *
 * Storage format:
 * {
 *   "version": 1,
 *   "savedAt": <ms epoch>,
 *   "entries": { "<key>": { "value": <any>, "expiresAt": <number|null> } }
 * }
 *
 * Atomic write: writes to <filePath>.tmp, fsyncs, then renames over <filePath>.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const STORAGE_VERSION = 1;

export class PersistentStore {
  /**
   * @param {object} opts
   * @param {string} opts.filePath - absolute path to the JSON file
   * @param {number} opts.defaultTTL - default TTL in ms (use Infinity for never)
   * @param {number} [opts.flushDebounceMs=500]
   * @param {number} [opts.cleanupIntervalMs=300000]
   */
  constructor(opts = {}) {
    if (!opts.filePath) {
      throw new Error('PersistentStore: filePath is required');
    }
    if (opts.defaultTTL === undefined || opts.defaultTTL === null) {
      throw new Error('PersistentStore: defaultTTL is required');
    }

    this.filePath = opts.filePath;
    this.tmpPath = `${opts.filePath}.tmp`;
    this.defaultTTL = opts.defaultTTL;
    this.flushDebounceMs = opts.flushDebounceMs ?? 500;
    this.cleanupIntervalMs = opts.cleanupIntervalMs ?? 5 * 60 * 1000;

    this.map = new Map();
    this._flushTimer = null;
    this._loaded = false;
    this._destroyed = false;

    this.cleanupInterval = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  /**
   * Load entries from disk synchronously. Call once at startup before reads.
   */
  load() {
    const dir = path.dirname(this.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      logger.error('PersistentStore: failed to ensure data directory', {
        dir,
        error: err.message,
      });
    }

    // Clean up stale temp file from a previously crashed flush.
    try {
      if (fs.existsSync(this.tmpPath)) {
        fs.unlinkSync(this.tmpPath);
        logger.warn('PersistentStore: removed stale temp file', { tmpPath: this.tmpPath });
      }
    } catch (err) {
      logger.warn('PersistentStore: failed to remove stale temp file', {
        tmpPath: this.tmpPath,
        error: err.message,
      });
    }

    if (!fs.existsSync(this.filePath)) {
      this._loaded = true;
      return;
    }

    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      logger.error('PersistentStore: failed to read file', {
        filePath: this.filePath,
        error: err.message,
      });
      this._loaded = true;
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Corrupt file: rename it for inspection, then start empty.
      const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
      logger.error('PersistentStore: corrupt JSON file detected, preserving as backup', {
        filePath: this.filePath,
        corruptPath,
        error: err.message,
      });
      try {
        fs.renameSync(this.filePath, corruptPath);
      } catch (renameErr) {
        logger.error('PersistentStore: failed to rename corrupt file', {
          error: renameErr.message,
        });
      }
      this._loaded = true;
      return;
    }

    if (!parsed || typeof parsed !== 'object' || !parsed.entries) {
      logger.warn('PersistentStore: unexpected file shape, starting empty', {
        filePath: this.filePath,
      });
      this._loaded = true;
      return;
    }

    const now = Date.now();
    let loaded = 0;
    let dropped = 0;
    for (const [key, entry] of Object.entries(parsed.entries)) {
      if (!entry || typeof entry !== 'object') continue;
      const { value, expiresAt } = entry;
      if (expiresAt !== null && typeof expiresAt === 'number' && expiresAt < now) {
        dropped++;
        continue;
      }
      this.map.set(key, { value, expiresAt: expiresAt ?? null });
      loaded++;
    }

    logger.info('PersistentStore: loaded from disk', {
      filePath: this.filePath,
      loaded,
      dropped,
      version: parsed.version,
    });
    this._loaded = true;
  }

  /**
   * Set a value with optional TTL.
   * @param {string} key
   * @param {any} value
   * @param {number} ttl - ms, or Infinity for never
   */
  set(key, value, ttl = this.defaultTTL) {
    const expiresAt = ttl === Infinity ? null : Date.now() + ttl;
    this.map.set(key, { value, expiresAt });
    this._scheduleFlush();
  }

  /**
   * Get a value, or undefined if missing/expired.
   */
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.map.delete(key);
      this._scheduleFlush();
      return undefined;
    }
    return entry.value;
  }

  /**
   * True if key exists and is not expired.
   */
  has(key) {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.map.delete(key);
      this._scheduleFlush();
      return false;
    }
    return true;
  }

  /**
   * Delete a key. Triggers debounced flush.
   */
  delete(key) {
    const existed = this.map.delete(key);
    if (existed) this._scheduleFlush();
    return existed;
  }

  /**
   * Update an existing entry, refreshing its TTL.
   * Mirrors TTLMap.update for drop-in compatibility.
   */
  update(key, updater, ttl = this.defaultTTL) {
    const current = this.get(key);
    const newValue = updater(current);
    this.set(key, newValue, ttl);
  }

  /**
   * Number of entries (may include expired-but-not-yet-swept).
   */
  get size() {
    return this.map.size;
  }

  /**
   * Sweep expired entries.
   */
  cleanup() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        this.map.delete(key);
        removed++;
      }
    }
    if (removed > 0) this._scheduleFlush();
  }

  /**
   * Clear all entries.
   */
  clear() {
    this.map.clear();
    this._scheduleFlush();
  }

  /**
   * Force immediate synchronous flush. Call from graceful shutdown.
   */
  flushSync() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    const payload = this._serialize();
    let fd;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fd = fs.openSync(this.tmpPath, 'w');
      fs.writeSync(fd, payload);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(this.tmpPath, this.filePath);
    } catch (err) {
      logger.error('PersistentStore: flushSync failed', {
        filePath: this.filePath,
        error: err.message,
      });
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
      // Best-effort tmp cleanup so we don't leave a partial file behind.
      try {
        if (fs.existsSync(this.tmpPath)) fs.unlinkSync(this.tmpPath);
      } catch {}
      throw err;
    }
  }

  /**
   * Stop cleanup interval and flush pending writes synchronously.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
      try {
        this.flushSync();
      } catch (err) {
        logger.error('PersistentStore: flush during destroy failed', { error: err.message });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  _serialize() {
    const entries = {};
    for (const [key, { value, expiresAt }] of this.map) {
      entries[key] = { value, expiresAt: expiresAt ?? null };
    }
    return JSON.stringify({
      version: STORAGE_VERSION,
      savedAt: Date.now(),
      entries,
    });
  }

  _scheduleFlush() {
    if (this._destroyed) return;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
    }
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flushAsync().catch((err) => {
        logger.error('PersistentStore: async flush failed', {
          filePath: this.filePath,
          error: err.message,
        });
      });
    }, this.flushDebounceMs);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  async _flushAsync() {
    const payload = this._serialize();
    const { promises: fsp } = fs;
    let handle;
    try {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      handle = await fsp.open(this.tmpPath, 'w');
      await handle.writeFile(payload);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fsp.rename(this.tmpPath, this.filePath);
    } catch (err) {
      if (handle) {
        try { await handle.close(); } catch {}
      }
      try {
        await fsp.unlink(this.tmpPath);
      } catch {}
      throw err;
    }
  }
}

export default PersistentStore;

// ---------------------------------------------------------------------------
// Self-tests: `node src/util/storage.js`
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const os = await import('node:os');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const results = [];
  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    const tag = ok ? 'PASS' : 'FAIL';
    const line = detail ? `[${tag}] ${name} - ${detail}` : `[${tag}] ${name}`;
    console.log(line);
  }

  function freshPath(label) {
    return path.join(
      os.tmpdir(),
      `persistent-store-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
  }

  function safeUnlink(p) {
    try { fs.unlinkSync(p); } catch {}
  }

  // --- Test 1: set + get roundtrip ---
  {
    const fp = freshPath('roundtrip');
    const store = new PersistentStore({ filePath: fp, defaultTTL: 60_000 });
    store.load();
    store.set('hello', { name: 'world', n: 7 });
    const got = store.get('hello');
    const ok = got && got.name === 'world' && got.n === 7;
    record('set + get roundtrip', !!ok, ok ? '' : `got=${JSON.stringify(got)}`);
    store.destroy();
    safeUnlink(fp);
  }

  // --- Test 2: TTL expiration ---
  {
    const fp = freshPath('ttl-expire');
    const store = new PersistentStore({ filePath: fp, defaultTTL: 60_000 });
    store.load();
    store.set('shortlived', 'bye', 50);
    const hadInitially = store.has('shortlived');
    await sleep(120);
    const stillThere = store.has('shortlived');
    const ok = hadInitially === true && stillThere === false;
    record('TTL expiration', ok, ok ? '' : `had=${hadInitially} still=${stillThere}`);
    store.destroy();
    safeUnlink(fp);
  }

  // --- Test 3: Infinity TTL never expires (expiresAt is null on disk) ---
  {
    const fp = freshPath('infinity');
    const store = new PersistentStore({ filePath: fp, defaultTTL: Infinity });
    store.load();
    store.set('forever', 'always', Infinity);
    store.flushSync();
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const entry = raw.entries.forever;
    const ok = entry && entry.value === 'always' && entry.expiresAt === null;
    record('Infinity TTL writes expiresAt=null', !!ok, ok ? '' : `entry=${JSON.stringify(entry)}`);
    store.destroy();
    safeUnlink(fp);
  }

  // --- Test 4: delete removes ---
  {
    const fp = freshPath('delete');
    const store = new PersistentStore({ filePath: fp, defaultTTL: 60_000 });
    store.load();
    store.set('k', 'v');
    store.delete('k');
    const ok = store.get('k') === undefined && store.has('k') === false;
    record('delete removes entry', ok);
    store.destroy();
    safeUnlink(fp);
  }

  // --- Test 5: flushSync persists to disk; new instance loads it ---
  {
    const fp = freshPath('persist');
    const a = new PersistentStore({ filePath: fp, defaultTTL: 60_000 });
    a.load();
    a.set('user:1', { name: 'Ada', city: 'London' });
    a.set('user:2', { name: 'Linus', city: 'Helsinki' }, Infinity);
    a.flushSync();
    a.destroy();

    const b = new PersistentStore({ filePath: fp, defaultTTL: 60_000 });
    b.load();
    const u1 = b.get('user:1');
    const u2 = b.get('user:2');
    const ok =
      u1 && u1.name === 'Ada' && u1.city === 'London' &&
      u2 && u2.name === 'Linus' && u2.city === 'Helsinki' &&
      b.size === 2;
    record('flushSync + reload roundtrip', !!ok, ok ? '' : `u1=${JSON.stringify(u1)} u2=${JSON.stringify(u2)} size=${b.size}`);
    b.destroy();
    safeUnlink(fp);
  }

  // --- Test 6: atomic write leaves no .tmp ---
  {
    const fp = freshPath('atomic');
    const store = new PersistentStore({ filePath: fp, defaultTTL: 60_000 });
    store.load();
    store.set('a', 1);
    store.set('b', 2);
    store.flushSync();
    const tmpExists = fs.existsSync(`${fp}.tmp`);
    const finalExists = fs.existsSync(fp);
    const ok = !tmpExists && finalExists;
    record('atomic write leaves no .tmp', ok, ok ? '' : `tmp=${tmpExists} final=${finalExists}`);
    store.destroy();
    safeUnlink(fp);
  }

  // --- Test 7: corrupt file recovery ---
  {
    const fp = freshPath('corrupt');
    fs.writeFileSync(fp, '{this is not valid json,,,', 'utf8');
    const store = new PersistentStore({ filePath: fp, defaultTTL: 60_000 });
    store.load();
    const startedEmpty = store.size === 0;

    // Look for a sibling .corrupt-<ts> file in the same dir.
    const dir = path.dirname(fp);
    const base = path.basename(fp);
    const siblings = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.corrupt-`));
    const backupCreated = siblings.length === 1;

    // Original file should have been moved (no longer exists at fp until next flush).
    const originalGone = !fs.existsSync(fp);

    const ok = startedEmpty && backupCreated && originalGone;
    record('corrupt file: start empty + backup made', ok, ok ? '' : `empty=${startedEmpty} backup=${backupCreated} originalGone=${originalGone}`);

    store.destroy();
    for (const s of siblings) safeUnlink(path.join(dir, s));
    safeUnlink(fp);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
