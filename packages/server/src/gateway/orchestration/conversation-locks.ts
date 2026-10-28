import { createLogger, getErrorMessage, retryWithBackoff } from "@lobu/core";
import { getDb } from "../../db/client.js";

const logger = createLogger("orchestrator");

/** Stable namespace id for `pg_advisory_lock(key1, key2)` per-conversation locks. */
const CONV_LOCK_KEY1 = 0x6c6f6275; // "lobu" in ASCII, signed int32-safe.

/** Reserve this many connections in the postgres-js pool for non-locked
 *  query traffic (health probes, runs-queue claim, secret-proxy lookups,
 *  every gateway tagged-template query). Sustained pressure here is small
 *  and shorter-lived than the per-worker locks, but the queries can't be
 *  starved entirely or the gateway stops responding. */
const POOL_HEADROOM = 5;

/** Default cap for reserved Postgres connections held by
 *  acquireConversationLock. Derived from `DB_POOL_MAX` so the cap CAN'T
 *  exceed available connections — otherwise callers above the pool size
 *  would block inside `sql.reserve()` instead of returning null at this
 *  cap, defeating the cap's whole purpose. Operators can still raise the
 *  cap with `LOBU_MAX_RESERVED_LOCKS` if they've bumped DB_POOL_MAX
 *  accordingly. Codex round 2 P1#2 on PR #870. */
function getDefaultMaxReservedLocks(): number {
  const poolMax = Number.parseInt(process.env.DB_POOL_MAX || "20", 10);
  if (!Number.isFinite(poolMax) || poolMax <= 0) {
    return Math.max(1, 20 - POOL_HEADROOM);
  }
  return Math.max(1, poolMax - POOL_HEADROOM);
}

export function getMaxReservedLocks(): number {
  const raw = process.env.LOBU_MAX_RESERVED_LOCKS;
  if (!raw) return getDefaultMaxReservedLocks();
  const n = Number.parseInt(raw, 10);
  // Unparseable / negative / non-finite → fall back to default. `0` is
  // honored as an explicit "block all reservations" value (useful for
  // failover drains and load tests; the runs queue will retry).
  if (!Number.isFinite(n) || n < 0) return getDefaultMaxReservedLocks();
  return n;
}

/**
 * In-process counter of currently-held reserved connections from
 * `acquireConversationLock`. Single-process JS is single-threaded so a plain
 * mutable number is "atomic enough" for increment/decrement against this
 * counter — there's no true parallelism inside the gateway event loop.
 * `getReservedLockCount` is exported so the health report can read the
 * counter without reaching into module internals.
 *
 * The counter is incremented BEFORE the `await sql.reserve()` call so the
 * cap check accounts for in-flight acquisitions; decremented in the release
 * path so the slot becomes available the moment the worker exits.
 */
let reservedLockCount = 0;
/** Tracks whether we've already emitted the 80% warning so we don't spam
 *  every acquisition once we're operating near the ceiling. Reset when the
 *  count drops back below the threshold. */
let warnedNearCap = false;

export function getReservedLockCount(): number {
  return reservedLockCount;
}

/**
 * Acquire a session-level (NOT transaction-level) advisory lock on
 * `(org, agent, conversationId)`. Returns a release function that drops the
 * lock and the underlying reserved connection. Returns `null` if the lock is
 * held by another pod — caller should bail and let the runs queue re-deliver.
 *
 * Why session-level (`pg_try_advisory_lock`) over transaction-level: the
 * lock has to outlive any single query — it spans the entire worker
 * subprocess lifetime, which can be tens of minutes. A transaction-scoped
 * lock would release at the next commit/rollback and let a sibling pod
 * steal the conversation mid-run. The `sql.reserve()` connection is
 * dedicated and lock state survives until we explicitly release.
 *
 * The local embedded backend takes this same real path now that it runs on a
 * real multi-connection Postgres (no single-connection pin). In a single
 * process the lock is uncontended and the in-process `workers` Map in
 * `DeploymentManager.spawnDeployment` is the primary per-conversation gate;
 * the advisory lock is the cross-pod gate that matters in clustered
 * deployments.
 */
export async function acquireConversationLock(
  organizationId: string,
  agentId: string,
  conversationId: string
): Promise<{ release: () => Promise<void> } | null> {
  // Hard cap on reserved connections held across all live workers. Each lock
  // pins one postgres-js pool slot for the worker's lifetime; without a cap
  // multi-pod × multi-conversation pressure exhausts the pool and stalls
  // every gateway query. Returning `null` here surfaces as a re-queueable
  // failure in `spawnDeployment` (same code path as a contended advisory
  // lock), so the runs queue retries with a delay on this pod or another.
  const max = getMaxReservedLocks();
  if (reservedLockCount >= max) {
    logger.warn(
      `Reserved-lock cap reached (${reservedLockCount}/${max}); deferring spawn for ${organizationId}/${agentId}/${conversationId}`
    );
    return null;
  }

  // Reserve the slot up-front so concurrent acquirers can see the increment
  // before this one's `await sql.reserve()` settles. Without this an
  // unbounded number of concurrent callers could each observe
  // `reservedLockCount < max` and pile through.
  reservedLockCount += 1;
  // 80% threshold one-shot warn. Re-armed once the count drops back below.
  if (!warnedNearCap && reservedLockCount >= Math.ceil(max * 0.8)) {
    logger.warn(
      `Reserved-lock count near cap: ${reservedLockCount}/${max}. Tune via LOBU_MAX_RESERVED_LOCKS or scale pods.`
    );
    warnedNearCap = true;
  }

  let decremented = false;
  const decrementOnce = (): void => {
    if (decremented) return;
    decremented = true;
    reservedLockCount = Math.max(0, reservedLockCount - 1);
    if (warnedNearCap && reservedLockCount < Math.ceil(max * 0.8)) {
      warnedNearCap = false;
    }
  };

  // `getDb()` returns the wrapped tagged-template client; `.reserve()` is on
  // the raw `postgres()` client. We access it via the shared singleton —
  // same pattern better-auth uses for its dedicated connection (see
  // `getAuthDialect()` in db/client.ts).
  const sql = getDb() as unknown as {
    reserve: () => Promise<
      ((
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<unknown[]>) & {
        release: () => void;
      }
    >;
  };
  let reserved: Awaited<ReturnType<typeof sql.reserve>>;
  try {
    reserved = await sql.reserve();
  } catch (err) {
    decrementOnce();
    throw err;
  }
  const key2 = hashConvKey2(organizationId, agentId, conversationId);
  try {
    const rows = (await reserved`SELECT pg_try_advisory_lock(${CONV_LOCK_KEY1}, ${key2}) AS acquired`) as Array<{ acquired: boolean }>;
    if (!rows[0]?.acquired) {
      reserved.release();
      decrementOnce();
      return null;
    }
  } catch (err) {
    reserved.release();
    decrementOnce();
    throw err;
  }
  return {
    async release() {
      // Retry the unlock query up to 3× with linear backoff (100ms, 200ms).
      // A transient DB hiccup mid-release would otherwise leave the
      // conversation locked until the gateway recycles — every
      // subsequent dispatch for that conv would `pg_try_advisory_lock`
      // → false → DEPLOYMENT_CREATE_FAILED → runs-queue retry → repeat.
      // Codex round 2 quality win E on PR #865.
      const MAX_ATTEMPTS = 3;
      const BACKOFF_MS = 100;
      try {
        await retryWithBackoff(
          async () => {
            await reserved`SELECT pg_advisory_unlock(${CONV_LOCK_KEY1}, ${key2})`;
          },
          {
            maxRetries: MAX_ATTEMPTS - 1,
            baseDelay: BACKOFF_MS,
            strategy: "linear",
            // Intermediate failures stay silent (matches the prior
            // hand-rolled loop); only the terminal failure is logged below.
            onRetry: () => {},
          }
        );
      } catch (lastErr) {
        // Log loudly so an operator notices — a stuck lock blocks every
        // subsequent dispatch for the conversation. Includes the lock
        // key triple so the operator can target a manual
        // pg_advisory_unlock from psql if needed.
        logger.error(
          `Failed to release advisory lock after ${MAX_ATTEMPTS} attempts for ${organizationId}/${agentId}/${conversationId}: ${getErrorMessage(lastErr)}`
        );
      }
      // ALWAYS return the reserved connection to the pool — keeping it
      // pinned would starve the pool faster than the stuck lock starves
      // any one conversation.
      try {
        reserved.release();
      } catch {
        /* postgres.js release is sync best-effort */
      }
      // Decrement after release so a metric snapshot taken mid-release
      // never undercounts. Idempotent — the helper guards against
      // double-decrement if the release path runs twice.
      decrementOnce();
    },
  };
}

/**
 * Derive a 32-bit signed integer from `(org, agent, conv)` for the second
 * advisory-lock key. Postgres takes (int32, int32); we want a stable hash
 * over a string triple. Same shape as the existing
 * `hashtext('lobu:autowire', ${userId}:${connectorKey})` pattern in
 * worker-api/device-reconcile.ts but computed in Node so we don't pay a
 * round-trip just to feed the lock.
 */
function hashConvKey2(
  organizationId: string,
  agentId: string,
  conversationId: string
): number {
  // FNV-1a 32-bit. Cheap, no extra deps, stable across Node versions.
  const input = `${organizationId}:${agentId}:${conversationId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) | 0;
  }
  // pg_advisory_lock takes a signed int32; |0 already brings the value into
  // that range. Return as-is.
  return hash;
}
