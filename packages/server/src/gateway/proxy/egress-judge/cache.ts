import type { JudgeVerdict } from "./types.js";

interface Entry {
  verdict: JudgeVerdict;
  expiresAt: number;
}

/**
 * Small LRU with absolute TTL. Keyed by `(orgId, policyHash, request
 * signature)` — the orgId scopes verdicts to a tenant so org A's "allow"
 * for `api.example.com` cannot satisfy org B's identical request, even when
 * the composed policy text hashes the same. A policy edit invalidates
 * prior verdicts automatically — the hash changes, the cache misses.
 *
 * Scale budget: expected to sit in the low thousands of entries. When the
 * map grows past `maxEntries`, the oldest-touched key is evicted.
 */
export class VerdictCache {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {}

  static key(parts: {
    orgId: string;
    policyHash: string;
    hostname: string;
    method?: string;
    path?: string;
  }): string {
    // A JSON tuple, not a delimiter join: no field's content can bleed into
    // its neighbour, so two different requests can never share a verdict.
    return JSON.stringify([
      parts.orgId,
      parts.policyHash,
      parts.hostname.toLowerCase(),
      parts.method?.toUpperCase() ?? "",
      parts.path ?? "",
    ]);
  }

  get(key: string): JudgeVerdict | undefined {
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

  set(key: string, verdict: JudgeVerdict): void {
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
