/**
 * Short in-memory cache of stable upstream reads (MAIR-525): a directory, assignable users... read on every
 * page load but rarely changed. Each BFF instance has its own copy, so entries live only a short time
 * (`ttlMs`) and the BFF invalidates them on each of its own writes.
 *
 * The key must hold everything the answer depends on, **the caller first**: an upstream answer filtered by the
 * caller's rights must never be served to another caller (see `callerKey`).
 */

export interface MemoryCacheOptions {
  /** How long an entry is served, in ms. */
  ttlMs: number;
  /** Entries kept at most; the oldest one is dropped beyond it. Default 1000. */
  maxEntries?: number;
  /** Clock, for the tests. */
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class MemoryCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly loading = new Map<string, Promise<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** Bumped by every invalidation: a load started before it must not store its (stale) result. */
  private generation = 0;

  constructor(options: MemoryCacheOptions) {
    if (!(options.ttlMs > 0)) throw new RangeError(`Invalid cache TTL: ${options.ttlMs}`);
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries ?? 1000;
    this.now = options.now ?? Date.now;
  }

  /** The live value of `key`, or `undefined`. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  /**
   * The live value of `key`, or the result of `load` stored under it. Concurrent calls for the same key share
   * one `load`. A failed load stores nothing. A load that an invalidation overtook answers its caller but is
   * not stored.
   */
  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const pending = this.loading.get(key);
    if (pending !== undefined) return pending;

    const generation = this.generation;
    const promise = load().then((value) => {
      if (generation === this.generation) this.set(key, value);
      return value;
    }).finally(() => {
      if (this.loading.get(key) === promise) this.loading.delete(key);
    });
    this.loading.set(key, promise);
    return promise;
  }

  /** Drops `key`, or every key starting with `prefix` when `{ prefix: true }`. */
  delete(key: string, options: { prefix?: boolean } = {}): void {
    this.generation += 1;
    for (const map of [this.entries, this.loading]) {
      for (const existing of [...map.keys()]) {
        if (options.prefix ? existing.startsWith(key) : existing === key) map.delete(existing);
      }
    }
  }

  /** Drops everything: call it after any write that may change the cached reads. */
  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.loading.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Cache key of an answer for `userId`, made of `parts` (joined with `:`): `callerKey(2, 'directory')`. */
export function callerKey(userId: number, ...parts: readonly (string | number)[]): string {
  return [`user:${userId}`, ...parts.map(String)].join(':');
}
