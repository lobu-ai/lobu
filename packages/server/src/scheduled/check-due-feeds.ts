/**
 * Due-feed materialization
 *
 * The production caller is worker-api/poll.ts: once an idle worker proves it
 * is actively polling, the gateway finds due feeds that exact worker can claim,
 * creates at most one pending sync, then claims it in the same request.
 *
 * Primary feed scheduler for the V1 integration platform.
 */

import type { DbClient } from '../db/client';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { DEVICE_ONLINE_WINDOW_SECONDS } from '../utils/device-liveness';
import {
  delegatedBrowserAffinitySql,
  selectedConnectorVersionArtifactSql,
} from '../utils/connector-execution-placement';
import logger from '../utils/logger';
import { createSyncRun } from '../runs/queue-service';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../utils/run-statuses';
import {
  type ConnectorClaimContext,
  connectorClaimLaneSql,
} from '../worker-api/connector-claim-lanes';
import { materializeDueItems } from './due-materializer';

interface CheckDueFeedsResult {
  dueFeeds: number;
  runsCreated: number;
  skipped: number;
}

interface DueFeedRow {
  id: number;
  organization_id: string;
  connection_id: number;
  feed_key: string;
  connector_key: string;
  eligibility_lane: DueFeedEligibilityLane;
}

export type DueFeedEligibilityLane =
  | 'unscoped'
  | 'fleet'
  | 'fleet_browser_affinity'
  | 'device_capability'
  | 'device_pin';

export interface MaterializedDueFeedRun {
  runId: number;
  feedId: number;
  eligibilityLane: DueFeedEligibilityLane;
}

/** Claim facts already authorized by worker-api/poll.ts for this exact poller. */
export type DueFeedClaimContext = ConnectorClaimContext;

interface MaterializeDueFeedsOptions {
  /** When present, only materialize work this exact idle poller can claim. */
  claimContext?: DueFeedClaimContext;
  /** Poll-triggered materialization fills one successful queue slot per poll. */
  maxRunsCreated?: number;
  /** Reports creation details to the poll caller, which defers its structured
   * log until the surrounding transaction commits successfully. */
  onRunCreated?: (run: MaterializedDueFeedRun) => void;
}

export async function materializeDueFeeds(
  env: Env,
  db?: DbClient,
  options?: MaterializeDueFeedsOptions
): Promise<CheckDueFeedsResult> {
  const sql = db ?? getDb();
  const claimContext = options?.claimContext;
  const isUserScopedWorker = claimContext?.isUserScopedWorker ?? false;
  const deviceWorkerId = claimContext?.deviceWorkerId ?? null;
  const claimEligibility = claimContext
    ? connectorClaimLaneSql(sql, claimContext, {
        connectorKey: sql`c.connector_key`,
        connectorVersion: sql`COALESCE(f.pinned_version, cd.version)`,
        organizationId: sql`f.organization_id`,
        activationKind: sql`NULL::text`,
        activatedAt: sql`NULL::timestamptz`,
        connectionDeviceWorkerId: sql`c.device_worker_id`,
        pinPlatform: sql`pin_dw.platform`,
        runRequiredCapability: sql`cd.run_required_capability`,
        runManifestBacked: sql`run_cv.manifest_backed`,
        runManifestHash: sql`run_cv.artifact_hash`,
        runRuntime: sql`cd.run_runtime`,
      })
    : sql`true`;

  const counts = await materializeDueItems<DueFeedRow>({
    label: 'CheckDueFeeds',
    fetchDue: () => sql<DueFeedRow>`
      SELECT f.id, f.organization_id, f.connection_id, f.feed_key, c.connector_key,
        CASE
          WHEN ${claimContext == null} THEN 'unscoped'
          WHEN ${!isUserScopedWorker} AND c.device_worker_id IS NOT NULL
            THEN 'fleet_browser_affinity'
          WHEN ${!isUserScopedWorker} THEN 'fleet'
          WHEN c.device_worker_id IS NOT NULL THEN 'device_pin'
          ELSE 'device_capability'
        END AS eligibility_lane
      FROM feeds f
      JOIN connections c ON c.id = f.connection_id
      LEFT JOIN device_workers pin_dw ON pin_dw.id = c.device_worker_id
      LEFT JOIN LATERAL (
        SELECT
          cd.id AS definition_id,
          cd.version,
          COALESCE(cd.feeds_schema -> f.feed_key -> 'operations', '[]'::jsonb)
            AS feed_operations,
          CASE
            WHEN f.pinned_version IS NULL OR cd.version = f.pinned_version
              THEN cd.required_capability
            ELSE NULL
          END AS run_required_capability,
          CASE
            WHEN f.pinned_version IS NULL OR cd.version = f.pinned_version
              THEN cd.runtime
            ELSE NULL
          END AS run_runtime
        FROM connector_definitions cd
        WHERE cd.key = c.connector_key
          AND cd.organization_id = f.organization_id
          AND (
            (f.pinned_version IS NULL AND cd.status = 'active')
            OR (
              f.pinned_version IS NOT NULL
              AND (cd.version = f.pinned_version OR cd.status = 'active')
            )
          )
        -- Prefer exact historical metadata when it exists. Device-manifest
        -- upgrades update the single active definition in place, so a pinned
        -- artifact may have no matching definition row; in that case the
        -- active feed contract remains capability truth for the same key.
        ORDER BY (cd.version = f.pinned_version) DESC,
                 (cd.status = 'active') DESC,
                 cd.updated_at DESC,
                 cd.id DESC
        LIMIT 1
      ) cd ON true
      LEFT JOIN LATERAL (
        ${selectedConnectorVersionArtifactSql(sql, {
          connectorKey: sql`c.connector_key`,
          version: sql`COALESCE(f.pinned_version, cd.version)`,
          organizationId: sql`f.organization_id`,
        })}
      ) run_cv ON true
      WHERE f.status = 'active'
        AND c.status = 'active'
        AND c.deleted_at IS NULL
        AND f.deleted_at IS NULL
        AND (
          cd.definition_id IS NULL
          OR cd.feed_operations @> '["sync"]'::jsonb
        )
        -- A connection pinned for EXECUTION can only run while that device is
        -- polling. In worker-api/poll.ts the fleet lane (1A) takes a pinned
        -- connection only for a page-activated run, and createSyncRun leaves
        -- activation_kind NULL, so a scheduled sync is never one; the device
        -- lanes take it only when the pin matches the polling device. A run
        -- queued now would therefore just age into a worker_claim_timeout.
        -- Leave the feed past next_run_at instead, so that device's next poll
        -- picks it up.
        --
        -- A chrome-extension pin on a connector that does not execute natively
        -- in the extension is NOT an execution pin — it means "scrape with
        -- this browser", and poll.ts keeps the parent sync on the fleet (lane
        -- 1A claims it; the extension's own lane explicitly refuses it). Those
        -- feeds must keep syncing while the browser is closed, so they are
        -- never deferred here.
        AND (
          c.device_worker_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM device_workers dw
            WHERE dw.id = c.device_worker_id
              AND (
                dw.last_seen_at > current_timestamp
                  - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS})
                -- The device polling RIGHT NOW is online by construction:
                -- this materialization runs inside its own poll. That poll
                -- normally already stamped last_seen_at = now() on the
                -- device_workers upsert, so this arm is what keeps the feed
                -- eligible on the fallback path where that upsert failed
                -- (non-fatal) and poll.ts resolved deviceWorkerId by lookup.
                OR (
                  ${isUserScopedWorker}
                  AND dw.id = ${deviceWorkerId}::uuid
                )
                OR (${delegatedBrowserAffinitySql(sql, {
                  platform: sql`dw.platform`,
                  connectorKey: sql`c.connector_key`,
                })})
              )
          )
        )
        -- Use the same connector claim predicate as worker-api/poll.ts before
        -- creating the run. A scheduler-admitted sync is therefore eligible
        -- for the exact poller that materialized it.
        AND ${claimEligibility}
        AND f.next_run_at <= current_timestamp
        AND NOT EXISTS (
          SELECT 1 FROM runs r
          WHERE r.feed_id = f.id
            AND r.run_type = 'sync'
            AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
        )
      ORDER BY f.next_run_at ASC
      LIMIT 100
    `,
    onFound: (feeds) => {
      logger.info(`[CheckDueFeeds] Found ${feeds.length} due feeds`);
    },
    createRun: async (feed) => {
      const created = await createSyncRun(feed.id, env, sql, { feedDue: true });
      if (!created.ok) {
        // A skip is no longer necessarily a race: the connector may be
        // cloud-restricted, uninstalled, or have no runnable version.
        logger.debug(
          `[CheckDueFeeds] Skipped feed ${feed.id} (${feed.connector_key}/${feed.feed_key}): ${created.reason}`
        );
        return 'skipped';
      }
      const runId = created.runId;
      options?.onRunCreated?.({
        runId,
        feedId: feed.id,
        eligibilityLane: feed.eligibility_lane,
      });
      logger.debug(
        `[CheckDueFeeds] Created run ${runId} for feed ${feed.id} (${feed.connector_key}/${feed.feed_key})`
      );
      return 'created';
    },
    onError: (feed, error) => {
      logger.error({ error, feedId: feed.id }, '[CheckDueFeeds] Failed to create run');
    },
    onDone: ({ runsCreated, skipped }) => {
      if (runsCreated > 0) {
        logger.info(`[CheckDueFeeds] Created ${runsCreated} runs (${skipped} skipped)`);
      }
    },
    maxRunsCreated: options?.maxRunsCreated,
  });

  return { dueFeeds: counts.due, runsCreated: counts.runsCreated, skipped: counts.skipped };
}
