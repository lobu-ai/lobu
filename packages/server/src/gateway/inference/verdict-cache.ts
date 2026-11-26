interface Entry<T> {
  verdict: T;
  expiresAt: number;
}

/**
 * Small LRU with absolute TTL. The caller's key must scope a verdict to its
 * tenant and to everything the verdict depends on, so an edit to any of them
 * misses the cache instead of reusing a stale verdict.
 *
 * Scale budget: expected to sit in the low thousands of entries. When the
 * map grows past `maxEntries`, the oldest-touched key is evicted.
 */
export class VerdictCache<T> {
  private entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert to move this key to the newest position; Map preserves
    // insertion order, so the oldest-touched key sorts first for eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.verdict;
  }

  set(key: string, verdict: T): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      // Map preserves insertion order; the first key is the oldest touched.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, {
      verdict,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** For tests. */
  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
