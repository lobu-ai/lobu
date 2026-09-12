/**
 * Stale-run reaper for the connector lanes.
 *
 * `reapStaleRuns()` marks runs as `timeout` when they are never claimed before
 * the configured threshold, or are stuck `claimed`/`running` with a stale
 * liveness timestamp. Connector workers
 * heartbeat every 30s via `/api/workers/heartbeat`; a missed heartbeat means
 * the worker crashed, was OOM-killed, or was scaled down mid-run. Without the
 * reaper those rows sit "running" forever and the feed never gets a retry.
 *
 * Scope:
 *  - `sync`, `action`, `embed_backfill`, `auth` — all driven by the
 *    out-of-process connector-worker daemon and all emit
 *    `client.heartbeat()` from their executors in
 *    packages/connector-worker/src/daemon/executor.ts. PR lobu#859
 *    temporarily narrowed this set to `sync` + `auth` because the action
 *    and embed_backfill executors were silent; lobu#860 wired heartbeats
 *    into both, so the WHERE clause + partial index widen back to the
 *    full four-lane set here. The browser-worker (Chrome) lane runs out
 *    of a service-worker and also heartbeats now (owletto#186) but uses
 *    its own `chrome.alarms` cadence — it shares this WHERE clause.
 *  - `agent_turn` — the isolate turn lane, on the same fleet worker with the
 *    same claim + heartbeat contract, so it shares the staleness predicate
 *    but not the bulk CTE: an authoritative turn has a client waiting on its
 *    reply, so its timeout must publish a `thread_response` in the same
 *    transaction. `sweepStaleAgentTurnRuns` (worker-api/agent-turn.ts) owns
 *    that, the way `sweepStaleDeviceChatRuns` does for device chat.
 *  - `automation` — driven in-process by the embedded gateway. Lifecycle is
 *    handled by the durable terminal-event resolution (run-completion.ts)
 *    + the dedicated `sweepStaleAutomationRuns` / `resetOrphanedAutomationRuns`
 *    helpers in automations/automation.ts.
 *  - lobu-queue lanes (`chat_message`, `schedule`, `agent_run`, `internal`,
 *    `task`) — claimed by RunsQueue with its own per-claim heartbeat on
 *    `claimed_at` and own 5-min stale sweep. Not touched here.
 *
 * Multi-pod safety: wrapped in `pg_try_advisory_lock`. A second gateway pod
 * trying to reap concurrently no-ops instead of double-failing rows.
 *
 * Cadence: `reapStaleRuns()` is owned by exactly ONE caller — the 30s
 * `setInterval` started by `startStaleRunReaper` in the gateway boot path
 * (server-lifecycle.ts). The 5-minute `checkStalledExecutions` cron no longer
 * calls it (the two firing it was redundant); the cron now only does the
 * surrounding housekeeping (automation reconcile/sweep, connect-token expiry,
 * 30-day retention).
 */

import type { ReservedSql } from 'postgres';
import { intervals } from '../config/intervals';
import { type DbClient, getDb } from '../db/client';
import { incrementCounter } from '../gateway/metrics/prometheus';
import type { Env } from '../index';
import {
  delegatedBrowserAffinitySql,
  selectedConnectorVersionArtifactSql,
} from '../utils/connector-execution-placement';
import { classifyRunOutcome } from '../runs/run-outcome';
import {
  supersedeActionEvent,
  terminalizeApprovalRunCompleted,
} from '../tools/admin/approval-events';
import { expireStaleConnectTokens } from '../utils/connect-tokens';
import logger from '../utils/logger';
import { reconcileAutomationRuns, sweepStaleAutomationRuns } from '../automations/automation';
import {
  DEVICE_FEED_READ_ACTION_KEY,
  DEVICE_FEED_READ_SCRUB_GRACE_SECONDS,
} from '../lib/device-feed-read-protocol';
import { buildStaleRunWhereSql } from './stale-run-sweeper';
import { sweepStaleAgentTurnRuns } from '../worker-api/agent-turn';
import { sweepStaleDeviceChatRuns } from '../worker-api/device-chat';

/** Advisory-lock key for cross-pod coordination of the stale-run reaper.
 *  Picked from the >2^31 range to avoid collisions with the queue-NOTIFY
 *  channel ids and the due-feeds lock; the high bits are arbitrary. */
const REAPER_ADVISORY_LOCK_KEY = 0x726e7372; // 'rnsr' — runs-reaper

/** Statuses a live-read run can still be claimed or completed from. */
const FEED_READ_IN_FLIGHT_STATUSES = "('pending', 'claimed', 'running')";

/**
 * The only in-flight status this sweep may terminalize on an expired horizon.
 *
 * `runs.expires_at` on a device action is the UNCLAIMED claim horizon, not an
 * execution deadline — queue-service stamps it so an unclaimed run cannot sit
 * pending forever, and poll.ts enforces it only against `status = 'pending'`
 * (both the candidate scan and the claiming UPDATE). A CLAIMED run is a device
 * actually working: WhatsApp queries a real archive, and one claimed a second
 * before expiry is legitimately still running. Timing it out here would kill
 * live work on a clock that was never about execution.
 *
 * Claimed/running failures stay with the heartbeat/coarse reaper below — the
 * claim stamps `last_heartbeat_at`, so that predicate governs them properly.
 * Once IT terminalizes them, the terminal-grace lane here clears their payload
 * on a later tick, so nothing is left holding rows either way.
 */
const FEED_READ_EXPIRABLE_STATUS = "'pending'";

const FEED_READ_ORPHAN_MESSAGE =
  'Device feed read expired without an answer (swept by the run reaper).';

/**
 * Scrub abandoned device source-read runs, set-wise.
 *
 * A live read carries the caller's recall terms in `action_input` and a page of
 * the device's rows in `action_output` — the transport that lets a result cross
 * from a laptop to whichever replica is waiting. `readDeviceFeed` clears
 * both in a `finally`, which covers every path the gateway process survives. It
 * covers none of the paths where it does not: an OOM kill, a pod eviction, a
 * rolling deploy mid-read. The promise that a source read keeps no copy cannot
 * rest on a process staying alive, so the same guarantee is re-asserted from
 * the reaper, which any replica runs.
 *
 * Two lanes, one statement:
 *   - TERMINAL rows past the grace window are scrubbed, keeping their status,
 *     outcome and timing — the read's verdict belongs to whoever ran it.
 *   - UNCLAIMED (`pending`) rows whose claim horizon (`expires_at`) has lapsed
 *     are timed out AND scrubbed, so a device that wakes up late cannot claim
 *     one and post a fresh page of messages into a row nobody is waiting on.
 *     Only `pending` — see {@link FEED_READ_EXPIRABLE_STATUS}; a claimed run
 *     is a device mid-query and is the heartbeat reaper's to judge.
 *
 * The grace is what keeps this from racing a HEALTHY waiter: a run marked
 * `completed` seconds ago is about to be read by a poller on a 500ms cadence
 * that will scrub it itself, and sweeping instantly would turn an ordinary read
 * into an empty result.
 *
 * Idempotent: a scrubbed row no longer matches (no output, and its input
 * carries the `scrubbed` marker), so repeat ticks are no-ops. Fenced to the
 * reserved action key, so no real operation's input or output is ever touched.
 */
export async function sweepAbandonedDeviceFeedReadRuns(
  sql: Pick<DbClient, 'unsafe'>
): Promise<number> {
  const result = await sql.unsafe(
    `UPDATE runs
     SET action_output = NULL,
         -- Keep the feed key: it is protocol, not user content, and it is the
         -- only thing that makes the surviving audit row legible.
         action_input = jsonb_build_object(
           'scrubbed', true,
           'feed_key', action_input->>'feed_key'
         ),
         status = CASE WHEN status IN ${FEED_READ_IN_FLIGHT_STATUSES}
                    THEN 'timeout' ELSE status END,
         outcome = CASE WHEN status IN ${FEED_READ_IN_FLIGHT_STATUSES}
                     THEN $2 ELSE outcome END,
         completed_at = CASE WHEN status IN ${FEED_READ_IN_FLIGHT_STATUSES}
                          THEN current_timestamp ELSE completed_at END,
         error_message = CASE WHEN status IN ${FEED_READ_IN_FLIGHT_STATUSES}
                           THEN $3 ELSE error_message END
     WHERE run_type = 'action'
       AND action_key = $1
       -- Already-clean rows must not match, or every tick would rewrite them.
       AND (
         action_output IS NOT NULL
         OR (action_input IS NOT NULL AND NOT jsonb_exists(action_input, 'scrubbed'))
       )
       AND (
         (status NOT IN ${FEED_READ_IN_FLIGHT_STATUSES}
          AND COALESCE(completed_at, created_at)
              <= current_timestamp - ($4::int * interval '1 second'))
         OR (status = ${FEED_READ_EXPIRABLE_STATUS}
             AND expires_at IS NOT NULL
             AND expires_at <= current_timestamp)
       )`,
    [
      DEVICE_FEED_READ_ACTION_KEY,
      classifyRunOutcome({ status: 'timeout' }),
      FEED_READ_ORPHAN_MESSAGE,
      DEVICE_FEED_READ_SCRUB_GRACE_SECONDS,
    ]
  );
  return Number(result.count ?? 0);
}

type DispatchFailureReason =
  | 'fleet_or_unpinned_no_claim'
  | 'fleet_or_browser_affinity_no_claim'
  | 'pinned_device_missing'
  | 'no_device_poll_during_pending_window'
  | 'device_ineligible_required_capability'
  | 'device_activity_seen_but_unclaimed';

interface DispatchFailureDiagnostic {
  runId: number;
  runType: string;
  connectorKey: string | null;
  connectionId: number | null;
  deviceWorkerId: string | null;
  platform: string | null;
  pendingAgeSeconds: number;
  lastDeviceActivityAt: string | null;
  requiredCapability: string | null;
  reason: DispatchFailureReason;
}

interface ReapStaleRunsResult {
  /** Whether the advisory lock was acquired. False means another pod is
   *  already running the sweep; the caller should treat this as a no-op. */
  acquired: boolean;
  /** Rows transitioned to a terminal state (failed/timeout) this tick. */
  reaped: number;
  /** Retry rows inserted for stalled claimed/running sync runs (never pending). */
  retriesCreated: number;
  /** Never-claimed rows, classified independently from connector/source health. */
  dispatchFailures: DispatchFailureDiagnostic[];
}

/**
 * One pass of the stale-run reaper. Idempotent + cheap (single advisory-lock
 * SELECT plus one indexed UPDATE), safe to call on a 30s setInterval.
 */
export async function reapStaleRuns(): Promise<ReapStaleRunsResult> {
  const sql = getDb();
  const thresholdSeconds = intervals.runsReaperStaleAfterSeconds;

  // Shared staleness predicate (scheduled/stale-run-sweeper.ts). Connector
  // claims don't stamp a heartbeat, so any non-NULL `last_heartbeat_at` means
  // the executor beat at least once; rows with none are judged on
  // COALESCE(claimed_at, created_at). One threshold covers both paths.
  const staleWhereSql = buildStaleRunWhereSql({
    // `agent_turn` runs on the SAME worker with the same claim + heartbeat
    // contract, but is reaped by `sweepStaleAgentTurnRuns` below rather than
    // the bulk CTE: an authoritative turn's timeout has to publish the
    // thread_response its client is waiting on, in the same transaction.
    runTypes: ['sync', 'action', 'embed_backfill', 'auth'],
    heartbeatSemantics: 'any-heartbeat',
    heartbeatStaleInterval: `${thresholdSeconds} seconds`,
    coarseStaleInterval: `${thresholdSeconds} seconds`,
    includePending: true,
  });

  // pg_try_advisory_lock is session-scoped — the connection holds the lock
  // until we explicitly release. With postgres.js any random pool connection
  // could serve the lock SELECT and the unlock; we wrap in a single
  // .reserve() so both run on the same physical connection. DbClient doesn't
  // type `reserve()` (it's only on the raw postgres.js surface), so we cast
  // through `unknown` to the postgres.js ReservedSql shape.
  const reserved = (await (
    sql as unknown as { reserve: () => Promise<ReservedSql> }
  ).reserve()) as ReservedSql;
  try {
    const lockRows = (await reserved`
      SELECT pg_try_advisory_lock(${REAPER_ADVISORY_LOCK_KEY}) AS acquired
    `) as unknown as Array<{ acquired: boolean }>;
    const acquired = !!lockRows[0]?.acquired;
    if (!acquired) {
      return { acquired: false, reaped: 0, retriesCreated: 0, dispatchFailures: [] };
    }

    try {
      // First, and independently of the staleness predicate below: a crashed
      // gateway leaves device source reads holding user rows. This is a
      // retention guarantee, not a queue-health one, so it runs even when
      // nothing else is stale.
      try {
        const scrubbed = await sweepAbandonedDeviceFeedReadRuns(reserved);
        if (scrubbed > 0) {
          logger.warn(
            { scrubbed },
            '[reaper] Scrubbed abandoned device feed-read runs'
          );
        }
      } catch (err) {
        logger.error(
          { error: String(err) },
          '[reaper] Failed to scrub abandoned device feed-read runs'
        );
      }

      const heartbeatErrorMessage = 'worker_heartbeat_lost';
      const claimErrorMessage = 'worker_claim_timeout';

      // Approval-gated action runs have a durable card, so their timeout must
      // supersede that card in the SAME transaction as the runs write. Process
      // this rare lane separately from the bulk connector CTE below: one
      // corrupt/missing card then rolls back only its own run and cannot block
      // sync retries or other stale actions. The UPDATE reasserts the complete
      // staleness predicate, so a worker heartbeat/completion that wins after
      // the candidate read makes this a no-op rather than being overwritten.
      const approvedActionCandidates = (await reserved`
        SELECT id, organization_id, action_key, action_output, claimed_by
        FROM public.runs
        WHERE ${reserved.unsafe(staleWhereSql)}
          AND run_type = 'action'
          AND approval_status = 'approved'
        ORDER BY id
      `) as unknown as Array<{
        id: number | string;
        organization_id: string;
        action_key: string | null;
        action_output: Record<string, unknown> | null;
        claimed_by: string | null;
      }>;
      let approvalActionsReaped = 0;
      for (const candidate of approvedActionCandidates) {
        const runId = Number(candidate.id);
        try {
          // A claimed action run with a DURABLE action_output already persisted
          // is a terminalization-PENDING row: the external mutation succeeded
          // and only the 'completed' card write failed. Complete it from the
          // durable output — reporting a FALSE timeout here would mislabel an
          // already-successful mutation as a failure. The completion is guarded
          // (status='running' AND approval_status='approved') and shares its tx
          // with the card, so a concurrent human retry or another pod's reaper
          // tick cannot double-finalize, and a card failure rolls it back for
          // the next tick to retry.
          if (candidate.action_output != null) {
            const actionKey = candidate.action_key ?? 'Action';
            const eventId = await terminalizeApprovalRunCompleted(
              runId,
              candidate.organization_id,
              candidate.action_output,
              {
                title: `${actionKey} — completed`,
                content: `Operation completed: ${actionKey}`,
              },
              null,
              // Finalize the run exactly as read: if the gateway or another
              // pod re-claims it between this candidate read and the write,
              // the write loses instead of overwriting the new owner.
              candidate.claimed_by,
              sql
            );
            if (eventId !== null) approvalActionsReaped += 1;
            continue;
          }

          const didReap = await sql.begin(async (tx) => {
            const rows = await tx.unsafe<{
              organization_id: string;
              action_key: string | null;
            }>(
              `UPDATE public.runs
               SET status = 'timeout',
                   outcome = $2,
                   completed_at = current_timestamp,
                   error_message = $3
               WHERE id = $1
                 AND run_type = 'action'
                 AND approval_status = 'approved'
                 AND ${staleWhereSql}
               RETURNING organization_id, action_key`,
              [
                runId,
                classifyRunOutcome({ status: 'timeout' }),
                heartbeatErrorMessage,
              ]
            );
            if (rows.length === 0) return false;

            const actionKey = rows[0].action_key ?? 'Action';
            const eventId = await supersedeActionEvent(
              runId,
              rows[0].organization_id,
              'failed',
              `${actionKey} — timed out`,
              `Action timed out: ${actionKey} — ${heartbeatErrorMessage}`,
              {
                error_message: heartbeatErrorMessage,
                run_status: 'timeout',
              },
              null,
              tx
            );
            if (eventId === undefined) {
              throw new Error(
                `Cannot time out approval run ${runId}: its approval card is missing`
              );
            }
            return true;
          });
          if (didReap) approvalActionsReaped += 1;
        } catch (error) {
          logger.error(
            { run_id: runId, error: String(error) },
            '[reaper] Failed to atomically time out approved action run'
          );
        }
      }

      // Reap + recover in a single statement using CTEs. Claimed/running sync
      // rows get one fresh retry. Never-claimed rows are audit-only dispatch
      // failures: connector code never ran, so they must not mutate source
      // health, consume its failure budget, or auto-pause its feed. Doing the
      // timeout + claimed-run retry in one statement makes
      // the timeout + retry atomic — if the process crashes after the
      // statement returns, both writes are durable; if it crashes
      // before, neither is. The previous shape (bulk UPDATE RETURNING +
      // per-row INSERT loop) could leave a row in `timeout` with no
      // retry queued when a crash landed between the two writes (lobu#862).
      //
      // The retry INSERT uses `WHERE NOT EXISTS (SELECT 1 FROM runs ...)`
      // to dedupe against any currently-active sync run on the same
      // feed. The partial unique index `idx_runs_active_sync_per_feed`
      // still backs this (it's the same predicate, and the index is
      // what makes the check cheap); the NOT EXISTS shape avoids
      // PostgreSQL `ON CONFLICT` inference quirks against partial
      // unique indexes inside a CTE — which can throw the constraint
      // violation instead of DO NOTHING. NOT EXISTS evaluates the
      // dedup predicate against the same snapshot as the surrounding
      // CTE, so the cross-CTE visibility rule that breaks ON CONFLICT
      // doesn't apply here.
      //
      // The advisory lock still serialises cross-pod sweeps — the CTE
      // narrows the window to "one transaction tick" but doesn't replace
      // the lock.
      const reaped = (await reserved`
        WITH stale_candidates AS (
          SELECT id, status AS stale_status
          FROM public.runs
          WHERE ${reserved.unsafe(staleWhereSql)}
            AND NOT (run_type = 'action' AND approval_status = 'approved')
          FOR UPDATE SKIP LOCKED
        ),
        timed_out AS (
          UPDATE public.runs r
          SET status = 'timeout',
              outcome = ${classifyRunOutcome({ status: "timeout" })},
              completed_at = current_timestamp,
              error_message = CASE
                WHEN c.stale_status = 'pending' THEN ${claimErrorMessage}
                ELSE ${heartbeatErrorMessage}
              END
          FROM stale_candidates c
          WHERE r.id = c.id
          RETURNING r.id, r.run_type, r.feed_id, r.connection_id, r.connector_key,
                    r.connector_version, r.organization_id, r.dry_run, r.created_at, r.action_input,
                    c.stale_status
        ),
        retries AS (
          INSERT INTO public.runs (
            organization_id, run_type, feed_id, connection_id,
            connector_key, connector_version, status, approval_status, created_at, action_input
          )
          SELECT
            t.organization_id, 'sync', t.feed_id, t.connection_id,
            t.connector_key, t.connector_version, 'pending', 'auto', current_timestamp, t.action_input
          FROM timed_out t
          WHERE t.run_type = 'sync'
            AND t.stale_status IN ('claimed', 'running')
            AND t.feed_id IS NOT NULL
            -- Never retry a dry run. This INSERT does not carry the dry_run
            -- flag, so a retried dry run would come back as a REAL sync that
            -- persists everything the operator asked to only preview. A dry
            -- run is also an interactive one-shot — reaping it as 'timeout'
            -- and letting the operator re-trigger is the correct outcome.
            AND NOT t.dry_run
            AND NOT EXISTS (
              -- Look for an unrelated active sync run on the same feed.
              -- Exclude timed_out.id because in PostgreSQL the sibling
              -- CTE UPDATE is not visible here (all CTEs see the same
              -- snapshot), so the row we just reaped still appears as
              -- running. Without this exclusion, every reap would
              -- dedupe against itself and no retries would ever land.
              SELECT 1 FROM public.runs r
              WHERE r.feed_id = t.feed_id
                AND r.run_type = 'sync'
                AND r.status IN ('pending', 'claimed', 'running')
                AND r.id NOT IN (SELECT id FROM timed_out)
            )
          RETURNING id, feed_id
        ),
        dispatch_failures AS (
          SELECT
            t.id,
            t.run_type,
            t.connector_key,
            t.connection_id,
            c.device_worker_id,
            dw.platform,
            EXTRACT(EPOCH FROM (current_timestamp - t.created_at)) AS pending_age_seconds,
            dw.last_seen_at,
            cd.run_required_capability AS required_capability,
            CASE
              WHEN c.device_worker_id IS NULL
                THEN 'fleet_or_unpinned_no_claim'
              WHEN dw.id IS NULL
                THEN 'pinned_device_missing'
              WHEN ${delegatedBrowserAffinitySql(reserved, {
                platform: reserved`dw.platform`,
                connectorKey: reserved`t.connector_key`,
              })}
                THEN 'fleet_or_browser_affinity_no_claim'
              WHEN dw.last_seen_at < t.created_at
                THEN 'no_device_poll_during_pending_window'
              WHEN cd.run_required_capability IS NOT NULL
                AND NOT COALESCE(
                  dw.capabilities @> jsonb_build_array(cd.run_required_capability),
                  false
                )
                THEN 'device_ineligible_required_capability'
              ELSE 'device_activity_seen_but_unclaimed'
            END AS reason
          FROM timed_out t
          LEFT JOIN public.connections c ON c.id = t.connection_id
          LEFT JOIN public.device_workers dw ON dw.id = c.device_worker_id
          LEFT JOIN LATERAL (
            SELECT
              definitions.required_capability AS run_required_capability
            FROM public.connector_definitions definitions
            WHERE definitions.key = t.connector_key
              AND definitions.organization_id = t.organization_id
              AND definitions.version = t.connector_version
              AND definitions.status = 'active'
            ORDER BY definitions.updated_at DESC, definitions.id DESC
            LIMIT 1
          ) cd ON true
          LEFT JOIN LATERAL (
            ${selectedConnectorVersionArtifactSql(reserved, {
              connectorKey: reserved`t.connector_key`,
              version: reserved`t.connector_version`,
              organizationId: reserved`t.organization_id`,
            })}
          ) run_cv ON true
          WHERE t.stale_status = 'pending'
        )
        SELECT
          (SELECT count(*)::int FROM timed_out) AS reaped,
          (SELECT count(*)::int FROM retries) AS retries_created,
          (SELECT count(*)::int FROM timed_out
            WHERE run_type = 'sync'
              AND stale_status IN ('claimed', 'running')
              AND feed_id IS NOT NULL
              -- Same NOT dry_run predicate as the retries CTE. A dry run is
              -- never eligible for retry, so counting it here would inflate
              -- skippedRetries below and attribute the skip to "another
              -- active sync run exists", which would be false.
              AND NOT dry_run) AS sync_eligible,
          (SELECT coalesce(
             json_agg(json_build_object(
               'runId', id,
               'runType', run_type,
               'connectorKey', connector_key,
               'connectionId', connection_id,
               'deviceWorkerId', device_worker_id,
               'platform', platform,
               'pendingAgeSeconds', pending_age_seconds,
               'lastDeviceActivityAt', last_seen_at,
               'requiredCapability', required_capability,
               'reason', reason
             )),
             '[]'::json
           )
           FROM dispatch_failures
          ) AS dispatch_failures
      `) as unknown as Array<{
        reaped: number;
        retries_created: number;
        sync_eligible: number;
        dispatch_failures: unknown;
      }>;

      // Device-placed chat turns are claimed by the device's own poller, so the
      // connector reaper above never sees them; they terminalize through the
      // adapter that also publishes their thread_response.
      let deviceChatsReaped = 0;
      try {
        deviceChatsReaped = await sweepStaleDeviceChatRuns(thresholdSeconds);
      } catch (err) {
        logger.error(
          { error: String(err) },
          '[reaper] Failed to sweep stale device chat runs'
        );
      }

      // Agent turns share the connector lanes' claim + heartbeat contract but
      // not their terminal semantics: a crashed fleet worker leaves a client
      // waiting on an authoritative turn's reply, so the sweep that times the
      // run out also publishes the thread_response the completion route would
      // have. A shadow turn terminalizes silently.
      let agentTurnsReaped = 0;
      let agentTurnErrorsDelivered = 0;
      try {
        const swept = await sweepStaleAgentTurnRuns(thresholdSeconds);
        agentTurnsReaped = swept.reaped;
        agentTurnErrorsDelivered = swept.delivered;
      } catch (err) {
        logger.error(
          { error: String(err) },
          '[reaper] Failed to sweep stale agent turn runs'
        );
      }

      const reapedRow = reaped[0];
      const reapedCount =
        deviceChatsReaped +
        agentTurnsReaped +
        approvalActionsReaped +
        (reapedRow?.reaped ?? 0);
      const retriesCreated = reapedRow?.retries_created ?? 0;
      const syncEligible = reapedRow?.sync_eligible ?? 0;

      if (reapedCount === 0) {
        return { acquired: true, reaped: 0, retriesCreated: 0, dispatchFailures: [] };
      }

      const dispatchFailuresRaw = reapedRow?.dispatch_failures;
      const parsedDispatchFailures = Array.isArray(dispatchFailuresRaw)
        ? dispatchFailuresRaw
        : typeof dispatchFailuresRaw === 'string'
          ? JSON.parse(dispatchFailuresRaw)
          : [];
      const dispatchFailures = (parsedDispatchFailures as Array<Record<string, unknown>>).map(
        (failure): DispatchFailureDiagnostic => ({
          runId: Number(failure.runId),
          runType: String(failure.runType),
          connectorKey: failure.connectorKey == null ? null : String(failure.connectorKey),
          connectionId: failure.connectionId == null ? null : Number(failure.connectionId),
          deviceWorkerId:
            failure.deviceWorkerId == null ? null : String(failure.deviceWorkerId),
          platform: failure.platform == null ? null : String(failure.platform),
          pendingAgeSeconds: Number(failure.pendingAgeSeconds),
          lastDeviceActivityAt:
            failure.lastDeviceActivityAt == null
              ? null
              : String(failure.lastDeviceActivityAt),
          requiredCapability:
            failure.requiredCapability == null ? null : String(failure.requiredCapability),
          reason: String(failure.reason) as DispatchFailureReason,
        })
      );
      for (const failure of dispatchFailures) {
        incrementCounter('lobu_worker_dispatch_failures_total', {
          run_type: failure.runType,
          reason: failure.reason,
        });
        logger.warn(
          {
            classification: 'dispatch_unavailable',
            run_id: failure.runId,
            run_type: failure.runType,
            connector_key: failure.connectorKey,
            connection_id: failure.connectionId,
            device_worker_id: failure.deviceWorkerId,
            platform: failure.platform,
            pending_age_seconds: failure.pendingAgeSeconds,
            device_last_activity_at: failure.lastDeviceActivityAt,
            required_capability: failure.requiredCapability,
            claim_eligibility_reject_reason: failure.reason,
          },
          '[reaper] Worker never claimed connector run'
        );
      }

      logger.warn(
        {
          reaped: reapedCount,
          approvalActionsReaped,
          deviceChatsReaped,
          agentTurnsReaped,
          agentTurnErrorsDelivered,
          retriesCreated,
          thresholdSeconds,
        },
        '[reaper] Marked stale connector runs as timeout'
      );

      // Surface the conflict-dedup count so operators can spot when two
      // pods are competing for the same stale row across an advisory-
      // lock release boundary (the only case where `ON CONFLICT DO
      // NOTHING` should fire on the partial unique index). The delta is
      // sync-eligible reaped rows that did not produce a retry insert.
      const skippedRetries = syncEligible - retriesCreated;
      if (skippedRetries > 0) {
        logger.info(
          { count: skippedRetries },
          '[reaper] Skipped sync retries — another active sync run exists (ON CONFLICT DO NOTHING)'
        );
      }

      return {
        acquired: true,
        reaped: reapedCount,
        retriesCreated,
        dispatchFailures,
      };
    } finally {
      await reserved`SELECT pg_advisory_unlock(${REAPER_ADVISORY_LOCK_KEY})`;
    }
  } finally {
    reserved.release();
  }
}

/**
 * Start the 30s reaper interval. Returns a teardown function — call it from
 * the gateway's shutdown path so the interval doesn't keep the process alive.
 * Repeat invocations are a no-op; one interval per process.
 */
let activeInterval: ReturnType<typeof setInterval> | null = null;

export function startStaleRunReaper(): () => void {
  if (activeInterval) {
    return () => stopStaleRunReaper();
  }
  const tick = async () => {
    try {
      await reapStaleRuns();
    } catch (err) {
      logger.warn({ err }, '[reaper] tick failed');
    }
  };
  // Fire once on boot so a crash-recovered gateway clears the queue without
  // waiting a full interval.
  void tick();
  activeInterval = setInterval(tick, intervals.runsReaperTickMs);
  if (typeof activeInterval.unref === 'function') {
    activeInterval.unref();
  }
  return stopStaleRunReaper;
}

function stopStaleRunReaper(): void {
  if (activeInterval) {
    clearInterval(activeInterval);
    activeInterval = null;
  }
}

/**
 * Periodic housekeeping run by the 5-minute `check-stalled-executions`
 * TaskScheduler cron: automation reconcile + stale automation sweep + connect-token
 * expiry + 30-day retention. These don't justify a dedicated interval each.
 *
 * Stale-run reaping is NOT done here — it is owned exclusively by the 30s
 * `startStaleRunReaper` setInterval (server-lifecycle.ts), which is the single
 * reaper cadence. Both calling `reapStaleRuns()` was redundant.
 */
export async function checkStalledExecutions(_env: Env): Promise<void> {
  const sql = getDb();

  // Isolate each phase so a throw in one (e.g. the `malformed array literal`
  // bug, lobu#1046) doesn't disable the rest of the housekeeping.
  try {
    await reconcileAutomationRuns(sql);
  } catch (error) {
    logger.error({ error }, '[StalledRuns] reconcileAutomationRuns failed');
  }
  try {
    await sweepStaleAutomationRuns(sql);
  } catch (error) {
    logger.error({ error }, '[StalledRuns] sweepStaleAutomationRuns failed');
  }

  try {
    const expiredCount = await expireStaleConnectTokens();
    if (expiredCount > 0) {
      logger.info(`[StalledRuns] Expired ${expiredCount} stale connect tokens`);
    }
  } catch (connectTokenError) {
    logger.error({ error: connectTokenError }, '[StalledRuns] Error expiring connect tokens');
  }

  // Clean up old completed runs (keep last 30 days). Delete in bounded
  // batches to avoid long-held locks.
  const deleted = await sql`
    DELETE FROM runs
    WHERE id IN (
      SELECT id FROM runs
      WHERE status IN ('completed', 'failed', 'timeout', 'cancelled')
        AND completed_at < current_timestamp - INTERVAL '30 days'
      LIMIT 1000
    )
  `;
  if (deleted.count > 0) {
    logger.info(`[StalledRuns] Cleaned up ${deleted.count} old runs (> 30 days)`);
  }
}
