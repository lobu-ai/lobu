/**
 * POST /api/workers/dispatch-chrome-action
 *
 * Thin bridge: a connector running on the connector-worker fleet wants to
 * call a chrome connector action against the paired Owletto extension in
 * the same org. We:
 *
 *   1. Look up the parent connector run's org (+ optional data connection) from runs.
 *   2. Pick an online chrome connection / extension (prefer an explicit target,
 *      then the parent connection's chrome-extension scrape pin).
 *   3. Enqueue an action run via `createConnectorOperationRun` (the same
 *      helper `manage_operations.execute` uses for device-bound calls).
 *   4. Await completion via the shared `waitForDeviceActionRun` (also
 *      reused from manage_operations).
 *   5. Return the action_output.
 *
 * Multi-replica safe by reuse: all signalling is via Postgres rows on the
 * `runs` table; the chrome extension's `/api/workers/complete-action` POST
 * can land on any replica and finalize the run row.
 */

import type { DispatchChromeActionRequest } from '@lobu/core/contracts/worker/protocol';
import type { Context } from 'hono';
import { resolveAutomationConnectionVisibilityUserId } from '../authz/automation-connection-visibility';
import { compileConnectionRowVisibility } from '../authz/connection-visibility';
import { getDb, parsePgTextArray, pgTextArray } from '../db/client';
import type { Env } from '../index';
import { waitForDeviceActionRun } from '../tools/admin/device-action-wait';
import { DEVICE_ONLINE_WINDOW_SECONDS } from '../utils/device-liveness';
import { DEVICE_PIN_TOMBSTONE_MESSAGES } from '../utils/device-pin-tombstones';
import { dependencyUnavailableError } from '../connectors/dependency-unavailable';
import { errorMessage } from '../utils/errors';
import logger from '../utils/logger';
import { isUniqueViolation } from '../utils/pg-errors';
import { createConnectorOperationRun } from '../runs/queue-service';
import { normalizePageActivationUrl } from '../runs/page-activation';
import {
  browserActionContextFromMetadata,
  browserContextWithFlow,
  runScopedBrowserActionContext,
} from './browser-action-context';

/** Live unique index: one chrome connection per (org, device_worker) pin. */
const CHROME_DEVICE_PIN_UNIQUE = 'idx_connections_org_connector_device_live';

/**
 * In-process rebind mutex on globalThis so duplicate module evaluations
 * (bun test / vitest path variants) still share one lock map.
 * DB locks cover multi-replica; this covers same-process concurrent callers.
 */
const rebindLocks: Map<string, Array<() => void>> = (() => {
  const g = globalThis as typeof globalThis & {
    __lobuChromeRebindLocks?: Map<string, Array<() => void>>;
  };
  if (!g.__lobuChromeRebindLocks) {
    g.__lobuChromeRebindLocks = new Map();
  }
  return g.__lobuChromeRebindLocks;
})();

async function withChromeRebindLock<T>(
  organizationId: string,
  connectionId: number,
  fn: () => Promise<T>
): Promise<T> {
  const key = `${organizationId}:${Number(connectionId)}`;
  while (rebindLocks.has(key)) {
    await new Promise<void>((resolve) => {
      rebindLocks.get(key)!.push(resolve);
    });
  }
  rebindLocks.set(key, []);
  try {
    return await fn();
  } finally {
    const waiters = rebindLocks.get(key) ?? [];
    rebindLocks.delete(key);
    for (const wake of waiters) wake();
  }
}

export interface ChromeActionDispatchResult {
  status: 'completed' | 'failed' | 'timeout';
  output?: Record<string, unknown>;
  error_message?: string;
}

export type ResolveOnlineChromeOptions = {
  /**
   * Prefer this device_workers.id when it is an online debugger-capable
   * chrome-extension. Used for browser affinity: a data connection may set
   * device_worker_id to a chrome-extension worker to mean
   * "scrape with this browser" (the parent connector run stays on the fleet — see
   * poll.ts browser-affinity claim rules).
   */
  preferredDeviceWorkerId?: string | null;
  /**
   * When preferredDeviceWorkerId is set but that extension is offline / not
   * eligible, fail instead of falling back to last_seen (avoids scraping the
   * wrong profile). Default true when a preference is provided.
   */
  failIfPreferredOffline?: boolean;
};

type ChromeConnRow = {
  connection_id: number;
  current_pin: string | null;
  /** Online debugger-capable worker id for current_pin, else null. */
  pin_online_worker_id: string | null;
};

/**
 * Resolve an online Owletto Chrome extension to run a chrome action against.
 *
 * Resolution order:
 *   1. preferredDeviceWorkerId if online + chrome-extension + debugger:
 *      - return the chrome connection already pinned to it (no UPDATE)
 *      - else rebind a safe candidate (NULL / offline pin; or the sole chrome
 *        row for single-connection affinity rebind)
 *   2. No preference: sticky online pin on any chrome row (deterministic by id)
 *   3. Freshest unowned online worker + safe rebind candidate (heal NULL/stale)
 *
 * Never steals a device pin already held by another live chrome connection —
 * that hits idx_connections_org_connector_device_live and used to 500 the
 * dispatcher (multi-Chrome orgs: Mac mini + MacBook).
 */
export async function resolveOnlineChromeConnection(
  organizationId: string,
  sql = getDb(),
  opts: ResolveOnlineChromeOptions = {}
): Promise<{ connectionId: number; deviceWorkerId: string } | null> {
  const preferredId = opts.preferredDeviceWorkerId ?? null;
  const failIfPreferredOffline =
    opts.failIfPreferredOffline ?? preferredId != null;

  const chromeRows = (await sql`
    SELECT
      con.id AS connection_id,
      con.device_worker_id AS current_pin,
      pinned.id AS pin_online_worker_id
    FROM connections con
    LEFT JOIN device_workers pinned
      ON pinned.id = con.device_worker_id
     AND pinned.organization_id = con.organization_id
     AND pinned.platform = 'chrome-extension'
     AND pinned.capabilities::jsonb @> '["browser.debugger"]'::jsonb
     AND pinned.last_seen_at > now() - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS})
    WHERE con.organization_id = ${organizationId}
      AND con.connector_key = 'chrome'
      AND con.status = 'active'
      AND con.deleted_at IS NULL
    ORDER BY con.id ASC
  `) as ChromeConnRow[];

  if (chromeRows.length === 0) return null;

  const onlineWorkers = (await sql`
    SELECT dw.id
    FROM device_workers dw
    WHERE dw.organization_id = ${organizationId}
      AND dw.platform = 'chrome-extension'
      AND dw.capabilities::jsonb @> '["browser.debugger"]'::jsonb
      AND dw.last_seen_at > now() - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS})
    ORDER BY dw.last_seen_at DESC
  `) as Array<{ id: string }>;

  const onlineWorkerIds = new Set(onlineWorkers.map((w) => w.id));

  const logSelection = (
    reason: string,
    connectionId: number,
    deviceWorkerId: string,
    repaired: boolean
  ) => {
    logger.info(
      {
        organization_id: organizationId,
        preferred_device_worker_id: preferredId,
        chrome_connection_id: connectionId,
        device_worker_id: deviceWorkerId,
        selection_reason: reason,
        repaired,
        chrome_connection_count: chromeRows.length,
      },
      '[dispatchChromeAction] chrome connection resolved'
    );
  };

  // Active owner of a target worker (no UPDATE). Always re-read from DB so a
  // paused/deleted row cannot win over the active-only chromeRows snapshot.
  const findOwnerOf = async (
    deviceWorkerId: string
  ): Promise<number | null> => {
    const rows = (await sql`
      SELECT id
      FROM connections
      WHERE organization_id = ${organizationId}
        AND connector_key = 'chrome'
        AND device_worker_id = ${deviceWorkerId}::uuid
        AND deleted_at IS NULL
        AND status = 'active'
      LIMIT 1
    `) as Array<{ id: number }>;
    return rows[0]?.id ?? null;
  };

  /**
   * Rebind `connectionId` onto `deviceWorkerId` only when, under a row lock:
   *   - the source pin still matches `expectedSourcePin` (CAS)
   *   - the connection is still active
   *   - the target worker is still free of any live (non-deleted) chrome pin
   *     — the unique index includes paused rows, so those also block
   * Serializes concurrent rebinds of the same sole/NULL candidate so two
   * replicas cannot each return the connection paired with a different worker.
   */
  const rebindChromeToWorker = async (
    connectionId: number,
    deviceWorkerId: string,
    reason: string,
    expectedSourcePin: string | null
  ): Promise<{ connectionId: number; deviceWorkerId: string } | null> => {
    const existingOwner = await findOwnerOf(deviceWorkerId);
    if (existingOwner != null) {
      logSelection(`${reason}:existing_owner`, existingOwner, deviceWorkerId, false);
      return { connectionId: existingOwner, deviceWorkerId };
    }

    const connIdNum = Number(connectionId);
    return withChromeRebindLock(organizationId, connIdNum, async () => {
    // Re-check owner after acquiring the in-process lock (another concurrent
    // caller in this process may have rebound the target already).
    const ownerAfterLock = await findOwnerOf(deviceWorkerId);
    if (ownerAfterLock != null) {
      logSelection(
        `${reason}:existing_owner`,
        ownerAfterLock,
        deviceWorkerId,
        false
      );
      return { connectionId: ownerAfterLock, deviceWorkerId };
    }

    // Must run on ONE reserved connection: FOR UPDATE only serializes when
    // every statement shares a backend. sql.begin() holds a pool connection.
    try {
      const result = await sql.begin(async (tx) => {
        await tx`
          SELECT pg_advisory_xact_lock(
            hashtext(${`chrome-rebind:${organizationId}`}),
            ${connIdNum}::int
          )
        `;

        const locked = (await tx`
          SELECT id, device_worker_id, status
          FROM connections
          WHERE id = ${connIdNum}
            AND deleted_at IS NULL
          FOR UPDATE
        `) as Array<{
          id: number;
          device_worker_id: string | null;
          status: string;
        }>;

        if (locked.length === 0) {
          return { kind: 'miss' as const };
        }
        const row = locked[0];
        if (row.status !== 'active') {
          return { kind: 'miss' as const };
        }

        const currentPin =
          row.device_worker_id == null ? null : String(row.device_worker_id);
        const expected =
          expectedSourcePin == null ? null : String(expectedSourcePin);
        if (currentPin !== expected) {
          return { kind: 'cas_miss' as const };
        }

        const holders = (await tx`
          SELECT id, status
          FROM connections
          WHERE organization_id = ${organizationId}
            AND connector_key = 'chrome'
            AND device_worker_id = ${deviceWorkerId}::uuid
            AND deleted_at IS NULL
            AND id <> ${connIdNum}
          LIMIT 1
        `) as Array<{ id: number; status: string }>;

        if (holders.length > 0) {
          if (holders[0].status === 'active') {
            return {
              kind: 'owner' as const,
              connectionId: Number(holders[0].id),
              deviceWorkerId,
            };
          }
          return { kind: 'blocked_inactive_holder' as const };
        }

        const updated = (await tx`
          UPDATE connections
          SET device_worker_id = ${deviceWorkerId}::uuid,
              error_message = CASE
                WHEN error_message = ANY(${pgTextArray([...DEVICE_PIN_TOMBSTONE_MESSAGES])}::text[])
                THEN NULL
                ELSE error_message
              END,
              updated_at = now()
          WHERE id = ${connIdNum}
            AND deleted_at IS NULL
            AND status = 'active'
            AND device_worker_id IS NOT DISTINCT FROM ${expectedSourcePin}::uuid
          RETURNING id, device_worker_id
        `) as Array<{ id: number; device_worker_id: string }>;

        if (
          updated.length > 0 &&
          String(updated[0].device_worker_id) === deviceWorkerId
        ) {
          return {
            kind: 'rebound' as const,
            connectionId: connIdNum,
            deviceWorkerId,
          };
        }
        return { kind: 'miss' as const };
      });

      if (result.kind === 'rebound') {
        // Post-commit verify: even with FOR UPDATE, last-writer-wins can leave
        // a concurrent caller holding a stale {connectionId, deviceWorkerId}
        // pair. Only succeed if the committed pin still matches our target.
        const verify = (await sql`
          SELECT device_worker_id
          FROM connections
          WHERE id = ${connectionId}
            AND deleted_at IS NULL
            AND status = 'active'
          LIMIT 1
        `) as Array<{ device_worker_id: string | null }>;
        const committed =
          verify[0]?.device_worker_id == null
            ? null
            : String(verify[0].device_worker_id);
        if (committed === deviceWorkerId) {
          logSelection(reason, connectionId, deviceWorkerId, true);
          return { connectionId, deviceWorkerId };
        }
        logSelection(
          `${reason}:post_commit_mismatch`,
          connectionId,
          deviceWorkerId,
          false
        );
        // Fall through: maybe our target is now owned by an active row.
      } else if (result.kind === 'owner') {
        logSelection(
          `${reason}:existing_owner`,
          result.connectionId,
          result.deviceWorkerId,
          false
        );
        return {
          connectionId: result.connectionId,
          deviceWorkerId: result.deviceWorkerId,
        };
      }

      // CAS miss / blocked inactive holder / post-commit mismatch — claim only
      // if an active owner of *our* target now exists. Never pair this
      // connection with a worker it no longer points at.
      const winner = await findOwnerOf(deviceWorkerId);
      if (winner != null) {
        logSelection(`${reason}:race_winner`, winner, deviceWorkerId, false);
        return { connectionId: winner, deviceWorkerId };
      }
      if (result.kind !== 'rebound') {
        logSelection(`${reason}:${result.kind}`, connectionId, deviceWorkerId, false);
      }
      return null;
    } catch (err) {
      if (isUniqueViolation(err, CHROME_DEVICE_PIN_UNIQUE)) {
        const winner = await findOwnerOf(deviceWorkerId);
        if (winner != null) {
          logSelection(`${reason}:unique_recovery`, winner, deviceWorkerId, false);
          return { connectionId: winner, deviceWorkerId };
        }
        return null;
      }
      throw err;
    }
    });
  };

  /**
   * Pick a chrome row safe to rebind onto an unowned target worker.
   * Never steals a pin held by a *different* live chrome connection on that
   * target (caller checks ownership first). Source candidates:
   *   1. NULL pin
   *   2. Offline / ineligible pin
   *   3. Sole chrome connection (single-connection browser-affinity rebind)
   */
  const pickRebindCandidate = (): ChromeConnRow | null => {
    const nullPinned = chromeRows.find((r) => r.current_pin == null);
    if (nullPinned) return nullPinned;
    const offlinePinned = chromeRows.find((r) => r.pin_online_worker_id == null);
    if (offlinePinned) return offlinePinned;
    if (chromeRows.length === 1) return chromeRows[0];
    return null;
  };

  // --- Preferred browser affinity ---
  if (preferredId) {
    if (onlineWorkerIds.has(preferredId)) {
      const ownerId = await findOwnerOf(preferredId);
      if (ownerId != null) {
        logSelection('preferred_existing_owner', ownerId, preferredId, false);
        return { connectionId: ownerId, deviceWorkerId: preferredId };
      }

      const candidate = pickRebindCandidate();
      if (!candidate) {
        // Multi-chrome: every chrome row is sticky on another online browser
        // and preferred has no chrome lane. Do not steal.
        logger.info(
          {
            organization_id: organizationId,
            preferred_device_worker_id: preferredId,
            chrome_connection_count: chromeRows.length,
            selection_reason: 'preferred_unowned_no_rebind_candidate',
          },
          '[dispatchChromeAction] chrome connection unresolved'
        );
        return null;
      }

      return rebindChromeToWorker(
        candidate.connection_id,
        preferredId,
        'preferred_rebind',
        candidate.current_pin
      );
    }

    if (failIfPreferredOffline) {
      return null;
    }
    // Preferred offline and fallback allowed — continue to sticky / heal.
  }

  // --- Sticky: any chrome already online (multi-Chrome: do not jump to last_seen) ---
  // Re-check active status so a concurrently paused row cannot be selected.
  const sticky = chromeRows.find((r) => r.pin_online_worker_id != null);
  if (sticky?.pin_online_worker_id) {
    const stillActiveOwner = await findOwnerOf(sticky.pin_online_worker_id);
    if (stillActiveOwner != null) {
      logSelection(
        'sticky_online_pin',
        stillActiveOwner,
        sticky.pin_online_worker_id,
        false
      );
      return {
        connectionId: stillActiveOwner,
        deviceWorkerId: sticky.pin_online_worker_id,
      };
    }
    // Snapshot was stale (paused/deleted mid-flight) — fall through to heal.
  }

  // --- Heal: freshest online worker not owned by an *active* chrome row ---
  // Live NOT EXISTS (not the start-of-call snapshot) so a concurrently
  // paused owner does not block healing onto that worker.
  const unownedOnline = (await sql`
    SELECT dw.id
    FROM device_workers dw
    WHERE dw.organization_id = ${organizationId}
      AND dw.platform = 'chrome-extension'
      AND dw.capabilities::jsonb @> '["browser.debugger"]'::jsonb
      AND dw.last_seen_at > now() - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS})
      AND NOT EXISTS (
        SELECT 1
        FROM connections con
        WHERE con.organization_id = ${organizationId}
          AND con.connector_key = 'chrome'
          AND con.device_worker_id = dw.id
          AND con.deleted_at IS NULL
          AND con.status = 'active'
      )
    ORDER BY dw.last_seen_at DESC
    LIMIT 1
  `) as Array<{ id: string }>;
  if (unownedOnline.length === 0) {
    return null;
  }

  const candidate = pickRebindCandidate();
  if (!candidate) {
    return null;
  }

  return rebindChromeToWorker(
    candidate.connection_id,
    unownedOnline[0].id,
    'heal_unowned_online',
    candidate.current_pin
  );
}

/**
 * Reserved key in a chrome action's input: "dispatch this to the browser paired
 * with THIS chrome connection", overriding the parent connection's scrape pin.
 *
 * Why this exists. A connection's `device_worker_id` means "scrape with this
 * browser", and for a sync that is right — it belongs on the always-on machine.
 * But an interactive action exists to put a page in front of a person. Routing
 * it by the scrape pin stages the interaction on whichever box runs the cron,
 * so the human never sees it — exactly the bug this key fixes. Only the connector
 * knows an action is interactive, so the connector names the browser; syncs
 * never set it and are unaffected. Page-activated operations no longer use it:
 * the activated run's device pin below beats it, so this remains only for
 * explicitly targeted actions.
 *
 * Consumed and stripped here — never forwarded to the extension.
 */
export const TARGET_BROWSER_CONNECTION_INPUT_KEY = 'target_browser_connection_id';

/**
 * Resolve the chrome-extension worker paired with an explicitly requested chrome
 * connection. Returns `{ error }` rather than falling back: an interactive action
 * that silently retargets is the defect we are fixing, and a wrong browser can
 * mean a wrong logged-in account.
 */
async function resolveTargetBrowserWorker(
  organizationId: string,
  visibilityUserId: string | null,
  rawTarget: unknown,
  sql: ReturnType<typeof getDb>
): Promise<{ deviceWorkerId: string } | { error: string }> {
  const targetId = typeof rawTarget === 'number' ? rawTarget : Number.NaN;
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    return {
      error: `${TARGET_BROWSER_CONNECTION_INPUT_KEY} must be a positive integer chrome connection id, got ${JSON.stringify(rawTarget)}`,
    };
  }

  // Apply the same org/private boundary used by discovery and execution. A
  // headless run has no principal and can therefore target org-visible rows
  // only; a user may additionally target their own private browser.
  const visibility = sql`${sql.unsafe(
    compileConnectionRowVisibility(
      { organizationId, principal: visibilityUserId },
      'con'
    )
  )}`;
  const rows = (await sql`
    SELECT dw.id
    FROM connections con
    JOIN device_workers dw ON dw.id = con.device_worker_id
      AND dw.organization_id = con.organization_id
      AND dw.user_id = con.created_by
    WHERE con.id = ${targetId}
      AND con.organization_id = ${organizationId}
      AND con.connector_key = 'chrome'
      AND con.status = 'active'
      AND con.deleted_at IS NULL
      ${visibility}
      AND dw.platform = 'chrome-extension'
    LIMIT 1
  `) as Array<{ id: string }>;

  if (rows.length === 0) {
    return {
      error: `${TARGET_BROWSER_CONNECTION_INPUT_KEY}=${targetId} is not an active chrome connection paired to a browser in this organization.`,
    };
  }
  return { deviceWorkerId: rows[0].id };
}

/**
 * Look up browser affinity for a parent connector run: if its data connection is pinned
 * to a chrome-extension worker, that pin means "use this browser" (not "run
 * the parent connector on the extension" — see poll.ts).
 */
export async function preferredBrowserWorkerForConnection(
  connectionId: number | null | undefined,
  sql = getDb()
): Promise<string | null> {
  if (connectionId == null) return null;
  const rows = (await sql`
    SELECT dw.id
    FROM connections con
    JOIN device_workers dw ON dw.id = con.device_worker_id
    WHERE con.id = ${connectionId}
      AND con.deleted_at IS NULL
      AND dw.platform = 'chrome-extension'
    LIMIT 1
  `) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/**
 * Core chrome-action dispatch, callable in-process (no HTTP Context):
 *
 *   1. Pick an online paired Owletto chrome connection in `organizationId`.
 *   2. Enqueue a device-bound chrome action run via `createConnectorOperationRun`.
 *   3. Await completion via `waitForDeviceActionRun` and return its output.
 */
export async function dispatchChromeActionToExtension(params: {
  organizationId: string;
  actionKey: string;
  actionInput: Record<string, unknown>;
  /** Parent connector run id, also used to scope extension-owned tabs. */
  parentRunId?: number;
  /**
   * Data connection that owns the parent connector run. When pinned to
   * a chrome-extension, scrapes target that browser.
   */
  parentConnectionId?: number | null;
  /** User principal used only to resolve private browser visibility. */
  visibilityUserId?: string | null;
  /** Abort the wait early (e.g. the calling reaction hit its budget). */
  abortSignal?: AbortSignal;
}): Promise<ChromeActionDispatchResult> {
  const {
    organizationId,
    actionKey,
    actionInput,
    parentRunId,
    parentConnectionId,
    visibilityUserId = null,
    abortSignal,
  } = params;
  const sql = getDb();

  let createdByUserId = visibilityUserId;
  let automationId: number | null = null;
  let activatedDeviceWorkerId: string | null = null;
  let activationTabId: number | null = null;
  let activationTargetUrls: string[] = [];
  let browserContext: ReturnType<typeof runScopedBrowserActionContext> | null = null;
  if (parentRunId != null) {
    const parentRows = (await sql`
      SELECT created_by_user_id, automation_id,
             activated_by_device_worker_id, activation_tab_id,
             activation_target_urls, run_metadata, activation_kind, status
      FROM runs
      WHERE id = ${parentRunId}
        AND organization_id = ${organizationId}
      LIMIT 1
    `) as Array<{
      created_by_user_id: string | null;
      automation_id: number | null;
      activated_by_device_worker_id: string | null;
      activation_tab_id: number | null;
      activation_target_urls: string | string[] | null;
      run_metadata: Record<string, unknown> | null;
      activation_kind: string | null;
      status: string;
    }>;
    if (parentRows.length === 0) {
      return {
        status: 'failed',
        error_message: `Parent run ${parentRunId} was not found in this organization.`,
      };
    }
    if (parentRows[0].activation_kind === 'page_visit' && (
      parentRows[0].run_metadata?.page_activation_identity !== 'exact' ||
      !['pending', 'running'].includes(parentRows[0].status)
    )) {
      return { status: 'failed', error_message: 'This page activation is no longer executable. Create a new draft with its full URL.' };
    }
    createdByUserId = parentRows[0].created_by_user_id;
    automationId =
      parentRows[0].automation_id == null ? null : Number(parentRows[0].automation_id);
    activatedDeviceWorkerId = parentRows[0].activated_by_device_worker_id;
    activationTabId =
      parentRows[0].activation_tab_id == null
        ? null
        : Number(parentRows[0].activation_tab_id);
    activationTargetUrls = parsePgTextArray(
      parentRows[0].activation_target_urls
    );
    browserContext = browserContextWithFlow(
      browserActionContextFromMetadata(parentRows[0].run_metadata) ??
        runScopedBrowserActionContext(parentRunId),
      parentRunId
    );
  }

  const requiresPageActivation = actionInput.require_page_activation === true;
  if (
    actionKey === 'navigate' &&
    requiresPageActivation &&
    (!activatedDeviceWorkerId || activationTabId == null)
  ) {
    return {
      status: 'failed',
      error_message:
        'This browser operation requires an exact user page visit before it can run.',
    };
  }
  if (
    activatedDeviceWorkerId &&
    activationTabId != null &&
    actionKey === 'navigate'
  ) {
    let requestedUrl: string | null = null;
    if (typeof actionInput.url === 'string') {
      try {
        requestedUrl = normalizePageActivationUrl(actionInput.url);
      } catch {
        requestedUrl = null;
      }
    }
    if (!requestedUrl || !activationTargetUrls.includes(requestedUrl)) {
      return {
        status: 'failed',
        error_message:
          'Activated browser operations may not navigate the user-owned tab away from its matching page.',
      };
    }
    // Chrome must verify the live URL before returning the user-owned tab.
    // A stored activation is not evidence that this tab is still on that page.
  }
  // An interactive action may name the browser it wants to be seen in. That
  // beats the parent connection's scrape pin, which points at whichever machine
  // owns the cron rather than wherever the human is sitting.
  const rawTarget = (actionInput ?? {})[TARGET_BROWSER_CONNECTION_INPUT_KEY];
  let targetedBrowser = false;
  let preferredDeviceWorkerId: string | null;
  if (activatedDeviceWorkerId) {
    preferredDeviceWorkerId = activatedDeviceWorkerId;
    targetedBrowser = true;
  } else if (rawTarget != null) {
    const resolved = await resolveTargetBrowserWorker(
      organizationId,
      visibilityUserId,
      rawTarget,
      sql
    );
    if ('error' in resolved) {
      // Fail closed: never quietly stage on the scrape machine instead.
      return { status: 'failed', error_message: resolved.error };
    }
    preferredDeviceWorkerId = resolved.deviceWorkerId;
    targetedBrowser = true;
  } else {
    preferredDeviceWorkerId = await preferredBrowserWorkerForConnection(
      parentConnectionId,
      sql
    );
  }

  const chromeConnection = await resolveOnlineChromeConnection(organizationId, sql, {
    preferredDeviceWorkerId,
    failIfPreferredOffline: preferredDeviceWorkerId != null,
  });
  if (!chromeConnection) {
    return {
      status: 'failed',
      error_message: dependencyUnavailableError(
        'browser_offline',
        targetedBrowser
          ? 'The browser this action is set to open in is offline. Open Chrome with the Owletto extension on that machine and try again.'
          : preferredDeviceWorkerId
            ? 'The Chrome extension selected for this connection is offline. Open Owletto in that browser (and stay signed in) to continue.'
            : 'No online paired Owletto Chrome extension in this organization. Pair a Chrome extension first (and make sure it is running).',
      ),
    };
  }

  const operationInput: Record<string, unknown> = { ...(actionInput ?? {}) };
  // Routing directive, not an extension argument — the extension must never see it.
  delete operationInput[TARGET_BROWSER_CONNECTION_INPUT_KEY];
  delete operationInput.require_page_activation;
  delete operationInput.browser_context_id;
  delete operationInput.browser_context_title;
  delete operationInput.browser_flow_id;
  delete operationInput.holder_run_id;
  delete operationInput.parent_run_id;

  let runId: number;
  try {
    const claim = await createConnectorOperationRun({
      organizationId,
      connectionId: chromeConnection.connectionId,
      connectorKey: 'chrome',
      operationKey: actionKey,
      operationInput,
      approvalMode: 'device',
      requireCompiledCode: false,
      createdByUserId,
      automationId,
      parentRunId,
      runMetadata: browserContext ? { browser_context: browserContext } : undefined,
    });
    runId = claim.runId;
  } catch (err) {
    const msg = errorMessage(err);
    logger.error(
      { err: msg, parent_run_id: parentRunId, action_key: actionKey },
      '[dispatchChromeAction] createConnectorOperationRun failed'
    );
    return { status: 'failed', error_message: msg };
  }

  logger.info(
    {
      run_id: runId,
      parent_run_id: parentRunId,
      parent_connection_id: parentConnectionId,
      action_key: actionKey,
      chrome_connection_id: chromeConnection.connectionId,
      device_worker_id: chromeConnection.deviceWorkerId,
      preferred_device_worker_id: preferredDeviceWorkerId,
      // true = the action named its browser; false = fell back to the scrape pin.
      targeted_browser: targetedBrowser,
    },
    '[dispatchChromeAction] dispatched'
  );

  const result = await waitForDeviceActionRun(runId, organizationId, abortSignal);
  const output =
    result.output && typeof result.output === 'object' && !Array.isArray(result.output)
      ? (result.output as Record<string, unknown>)
      : undefined;
  return { ...result, output };
}

export async function dispatchChromeAction(c: Context<{ Bindings: Env }>) {
  let body: DispatchChromeActionRequest;
  try {
    body = await c.req.json<DispatchChromeActionRequest>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.parent_run_id !== 'number' || !body.parent_run_id) {
    return c.json({ error: 'parent_run_id is required' }, 400);
  }
  if (!body.worker_id?.trim()) {
    return c.json({ error: 'worker_id is required' }, 400);
  }
  if (!body.action_key?.trim()) {
    return c.json({ error: 'action_key is required' }, 400);
  }

  const sql = getDb();

  // Authorize: parent run must exist, be a running connector execution claimed
  // by this worker. Both sync() and execute() receive chrome_dispatcher.
  // connection_id supplies scrape affinity; an explicit action target
  // overrides it.
  const parentRows = (await sql`
    SELECT r.organization_id, r.status, r.claimed_by, r.run_type, r.connection_id,
           r.created_by_user_id, r.automation_id
    FROM runs r
    WHERE r.id = ${body.parent_run_id}
    LIMIT 1
  `) as Array<{
    organization_id: string;
    status: string;
    claimed_by: string | null;
    run_type: string;
    connection_id: number | null;
    created_by_user_id: string | null;
    automation_id: number | null;
  }>;
  if (parentRows.length === 0) {
    return c.json({ error: 'parent_run not found' }, 404);
  }
  const parentRun = parentRows[0];
  if (parentRun.status !== 'running') {
    return c.json(
      { error: `parent_run is ${parentRun.status}, must be running` },
      409
    );
  }
  if (parentRun.claimed_by !== body.worker_id) {
    return c.json({ error: 'parent_run is not claimed by this worker' }, 403);
  }
  if (parentRun.run_type !== 'sync' && parentRun.run_type !== 'action') {
    return c.json(
      { error: `parent_run must be a sync or action run, got ${parentRun.run_type}` },
      400
    );
  }

  const visibilityUserId = await resolveAutomationConnectionVisibilityUserId(
    {
      organizationId: parentRun.organization_id,
      userId: parentRun.created_by_user_id,
      actingAutomationId: parentRun.automation_id,
    },
    sql
  );
  const result = await dispatchChromeActionToExtension({
    organizationId: parentRun.organization_id,
    actionKey: body.action_key,
    actionInput: body.action_input ?? {},
    parentRunId: body.parent_run_id,
    parentConnectionId: parentRun.connection_id,
    visibilityUserId,
  });
  return c.json(result);
}
