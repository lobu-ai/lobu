import {
  GetSecretValueCommand,
  type GetSecretValueCommandOutput,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
	parseSecretRef,
	createBuiltinSecretRef,
	createLogger,
	getErrorMessage,
	isSecretRef,
	safeJsonParse,
	type SecretRef,
} from "@lobu/core";
import { tryGetOrgId } from "../../lobu/stores/org-context.js";

const logger = createLogger("secret-store");

export interface SecretListEntry {
  ref: SecretRef;
  backend: string;
  name: string;
  updatedAt: number;
}

export interface SecretPutOptions {
  ttlSeconds?: number;
}

export interface SecretStore {
  get(ref: SecretRef): Promise<string | null>;
}

export interface WritableSecretStore extends SecretStore {
  put(
    name: string,
    value: string,
    options?: SecretPutOptions
  ): Promise<SecretRef>;
  delete(nameOrRef: string): Promise<void>;
  list(prefix?: string): Promise<SecretListEntry[]>;
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Reduce a name-or-ref input to its canonical (scheme, decoded-name) pair
 * so two differently-encoded forms of the same secret compare equal.
 * Returns null if we can't derive a canonical form (unknown scheme,
 * malformed ref, undecodable path).
 */
function canonicalSecretIdentity(
  nameOrRef: string
): { scheme: string; name: string } | null {
  const parsed = parseSecretRef(nameOrRef);
  if (parsed) {
    // Strip a single leading slash from aws-sm-style paths so "/foo"
    // and "foo" collapse onto the same identity.
    const rawPath = parsed.path.replace(/^\/+/, "");
    const decoded = safeDecodeURIComponent(rawPath);
    if (decoded === null) return null;
    return { scheme: parsed.scheme, name: decoded };
  }
  // Not a ref — treat as a bare name under the default (`secret://`)
  // backend.
  return { scheme: "secret", name: nameOrRef };
}

export class AwsSecretsManagerSecretStore implements SecretStore {
  private readonly client: SecretsManagerClient;

  constructor(region?: string) {
    this.client = new SecretsManagerClient(region ? { region } : {});
  }

  async get(ref: SecretRef): Promise<string | null> {
    const parsed = parseSecretRef(ref);
    if (!parsed || parsed.scheme !== "aws-sm") return null;

    const decoded = safeDecodeURIComponent(parsed.path.replace(/^\/+/, ""));
    if (decoded === null) {
      logger.warn({ ref }, "Invalid aws-sm secret ref path encoding");
      return null;
    }

    let response: GetSecretValueCommandOutput;
    try {
      response = await this.client.send(
        new GetSecretValueCommand({ SecretId: decoded })
      );
    } catch (error) {
      logger.warn(
        {
          ref,
          error: getErrorMessage(error),
        },
        "AWS Secrets Manager get failed"
      );
      return null;
    }

    const secretValue =
      response.SecretString ??
      (response.SecretBinary
        ? Buffer.from(response.SecretBinary).toString("utf8")
        : null);
    if (secretValue === null) return null;

    if (!parsed.fragment) {
      return secretValue;
    }

    const json = safeJsonParse<Record<string, unknown>>(secretValue);
    if (!json) {
      logger.warn(
        { ref, fragment: parsed.fragment },
        "aws-sm secret payload is not JSON; fragment cannot be extracted"
      );
      return null;
    }
    const selected = json[parsed.fragment];
    return typeof selected === "string" ? selected : null;
  }
}

/**
 * Short-TTL in-memory cache for secret resolution. Dramatically cuts load on
 * the underlying secret store (Postgres) and the AWS Secrets Manager API
 * for hot paths (proxy forwards, env-var injection, auth profile listing).
 * Invalidated on `put`/`delete` of the same name and LRU-capped to prevent
 * unbounded growth under a burst of unique refs within the TTL window.
 */
interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

const DEFAULT_SECRET_CACHE_TTL_MS = 60_000;
const DEFAULT_SECRET_CACHE_MAX = 5_000;

interface SecretStoreRegistryOptions {
  cacheTtlMs?: number;
  cacheMax?: number;
  /** Read-only backends keyed by ref scheme (e.g. `aws-sm`). */
  readOnlyStores?: Record<string, SecretStore>;
}

export class SecretStoreRegistry implements WritableSecretStore {
  // Cache key is `${orgId}|${ref}` so two orgs resolving the same `secret://`
  // ref through PostgresSecretStore (which scopes by AsyncLocalStorage org)
  // never share a cached value. Empty-string orgId covers global/system reads.
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly cacheMax: number;
  private readonly writableStores: Record<string, WritableSecretStore>;
  private readonly readOnlyStores: Record<string, SecretStore>;

  /**
   * @param defaultStore writable backend for the default scheme (usually
   *   `secret://` backed by Postgres). New `put`/`delete(name)` calls land
   *   here. Writes via a ref explicitly routed to another writable store
   *   land in that store.
   * @param writableStores every writable backend keyed by ref scheme,
   *   including the default. Must include the default scheme.
   * @param options read-only backends + cache tuning.
   */
  constructor(
    private readonly defaultStore: WritableSecretStore,
    writableStores: Record<string, WritableSecretStore>,
    options: SecretStoreRegistryOptions = {}
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_SECRET_CACHE_TTL_MS;
    this.cacheMax = options.cacheMax ?? DEFAULT_SECRET_CACHE_MAX;
    this.writableStores = writableStores;
    this.readOnlyStores = options.readOnlyStores ?? {};

    // Sanity-check: the default store must also be registered in
    // `writableStores` under its scheme (usually `secret`) so routing by
    // ref still finds it.
    const hasDefault = Object.values(writableStores).some(
      (store) => store === defaultStore
    );
    if (!hasDefault) {
      throw new Error(
        "SecretStoreRegistry: defaultStore must be present in writableStores"
      );
    }
  }

  async get(ref: SecretRef): Promise<string | null> {
    const now = Date.now();
    const orgId = tryGetOrgId() ?? "";
    const key = cacheKey(ref, orgId);
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.expiresAt > now) {
        return cached.value;
      }
      // Expired — drop it so the Map doesn't grow unbounded with stale
      // entries, then fall through to the backing store.
      this.cache.delete(key);
    }

    const parsed = parseSecretRef(ref);
    if (!parsed) return null;

    const store =
      this.writableStores[parsed.scheme] ?? this.readOnlyStores[parsed.scheme];
    if (!store) {
      logger.warn({ scheme: parsed.scheme }, "Unknown secret backend");
      return null;
    }

    const value = await store.get(ref);
    this.rememberInCache(key, value, now);
    return value;
  }

  async put(
    name: string,
    value: string,
    options?: SecretPutOptions
  ): Promise<SecretRef> {
    const ref = await this.defaultStore.put(name, value, options);
    // Drop every cached entry for this ref across all org scopes — the
    // value just changed in the backing store, and any cached entry under
    // a different org context would now be stale.
    this.invalidateRefAcrossOrgs(ref);
    return ref;
  }

  async delete(nameOrRef: string): Promise<void> {
    const parsed = parseSecretRef(nameOrRef);
    if (parsed) {
      const writable = this.writableStores[parsed.scheme];
      if (writable) {
        await writable.delete(nameOrRef);
      } else if (this.readOnlyStores[parsed.scheme]) {
        // Read-only backend — we can't delete. Warn but don't throw
        // so cascade cleanups (e.g. deleteSecretsByPrefix) keep
        // making progress on the rest of their work.
        logger.warn(
          { scheme: parsed.scheme, ref: nameOrRef },
          "Cannot delete secret from read-only backend"
        );
      } else {
        logger.warn(
          { scheme: parsed.scheme, ref: nameOrRef },
          "Unknown secret backend; delete is a no-op"
        );
      }
    } else {
      // Bare name → default writable backend.
      await this.defaultStore.delete(nameOrRef);
    }
    this.invalidateCacheFor(nameOrRef);
  }

  /**
   * Drop every cache entry that logically refers to the same secret as
   * `nameOrRef`, across every org scope. Cache keys are `${orgId}|${ref}`,
   * so we walk every entry, split off the ref portion, and compare
   * canonically against the input.
   */
  invalidateCacheFor(nameOrRef: string): void {
    const canonical = canonicalSecretIdentity(nameOrRef);
    if (canonical === null) {
      // If we can't derive a canonical form, fall back to dropping every
      // exact `*|<nameOrRef>` and `*|<built-in ref>` key we can predict.
      const builtinRef = isSecretRef(nameOrRef)
        ? null
        : createBuiltinSecretRef(encodeURIComponent(nameOrRef));
      for (const key of Array.from(this.cache.keys())) {
        const ref = parseCacheKey(key)?.ref;
        if (ref === nameOrRef || (builtinRef && ref === builtinRef)) {
          this.cache.delete(key);
        }
      }
      return;
    }

    // Walk every cache entry. LRU is capped at DEFAULT_SECRET_CACHE_MAX
    // (5000) and deletes are rare, so this is cheap in practice.
    for (const key of Array.from(this.cache.keys())) {
      const parsed = parseCacheKey(key);
      if (!parsed) continue;
      const cachedCanonical = canonicalSecretIdentity(parsed.ref);
      if (cachedCanonical === null) continue;
      if (
        cachedCanonical.scheme === canonical.scheme &&
        cachedCanonical.name === canonical.name
      ) {
        this.cache.delete(key);
      }
    }
  }

  /** Drop every cache entry for the exact `ref`, across all org scopes. */
  private invalidateRefAcrossOrgs(ref: SecretRef): void {
    for (const key of Array.from(this.cache.keys())) {
      if (parseCacheKey(key)?.ref === ref) {
        this.cache.delete(key);
      }
    }
  }

  async list(prefix?: string): Promise<SecretListEntry[]> {
    // Fan out across every writable backend so cascade cleanups
    // (deleteSecretsByPrefix) see entries from non-default writable
    // stores. Read-only backends are excluded — they don't support
    // listing, and even if they did, we couldn't delete what we found.
    const schemes = Object.keys(this.writableStores);
    const merged = new Map<SecretRef, SecretListEntry>();

    for (const scheme of schemes) {
      const store = this.writableStores[scheme];
      if (!store) continue;
      try {
        const entries = await store.list(prefix);
        for (const entry of entries) {
          // Later backends don't override earlier ones — first
          // write wins on ref collision.
          if (!merged.has(entry.ref)) {
            merged.set(entry.ref, entry);
          }
        }
      } catch (error) {
        logger.warn(
          {
            scheme,
            error: getErrorMessage(error),
          },
          "list() failed for writable backend"
        );
      }
    }

    if (schemes.length > 1) {
      logger.debug(
        { schemes, count: merged.size },
        "list() merged entries from multiple writable backends"
      );
    }

    const results = Array.from(merged.values());
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
  }

  private rememberInCache(
    key: string,
    value: string | null,
    now: number
  ): void {
    // LRU touch: delete + re-insert so the new entry is the most recent.
    this.cache.delete(key);
    this.cache.set(key, { value, expiresAt: now + this.cacheTtlMs });

    // Cap size by evicting the oldest entry (insertion-order Map).
    if (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }
}

const CACHE_KEY_SEP = "|";

function cacheKey(ref: SecretRef, orgId: string): string {
  return `${orgId}${CACHE_KEY_SEP}${ref}`;
}

function parseCacheKey(key: string): { orgId: string; ref: SecretRef } | null {
  const idx = key.indexOf(CACHE_KEY_SEP);
  if (idx < 0) return null;
  return {
    orgId: key.slice(0, idx),
    ref: key.slice(idx + 1) as SecretRef,
  };
}

/**
 * Delete every secret whose name starts with `prefix`. Used by cascading
 * deletes (agent deletion, connection removal) to avoid orphaned secrets in
 * the store.
 */
export async function deleteSecretsByPrefix(
  secretStore: WritableSecretStore,
  prefix: string
): Promise<number> {
  const entries = await secretStore.list(prefix);
  await Promise.all(entries.map((entry) => secretStore.delete(entry.ref)));
  return entries.length;
}

export async function resolveSecretValue(
  secretStore: SecretStore,
  value: string | undefined | null
): Promise<string | undefined> {
  if (!value) return undefined;
  if (!isSecretRef(value)) return value;
  return (await secretStore.get(value)) ?? undefined;
}

export async function persistSecretValue(
  secretStore: WritableSecretStore,
  name: string,
  value: string | undefined | null,
  options?: SecretPutOptions
): Promise<string | undefined> {
  if (!value) return undefined;
  if (isSecretRef(value)) return value;
  return secretStore.put(name, value, options);
}
