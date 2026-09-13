/**
 * Device-connector reconciliation.
 *
 * Extracted verbatim from `worker-api.ts`. On every user-scoped worker poll we
 * reconcile the user's device connectors against what their device fleet can
 * actually serve (capabilities advertised by devices seen recently). Wire /
 * re-activate connectors whose capability is served; pause the auto-wired feeds
 * of connectors whose capability has dropped out so `materializeDueFeeds` stops
 * creating runs nothing can claim.
 */

import type { FeedOperation } from '@lobu/connector-sdk';
import { parseJsonObject } from '@lobu/core';
import { getDb, pgTextArray } from '../db/client';
import { findExistingPersonalOrg } from '../auth/personal-org-provisioning';
import { splitConfigByFeedScope, type FeedDefinition } from '../tools/admin/helpers/feed-helpers';
import {
  type BundledDeviceConnector,
  bundledConnectorSourcePath,
  compileConnectorForIsolateFromFile,
  findBundledConnectorFile,
  getBundledDeviceConnectors,
} from '../utils/connector-catalog';
import { extractConnectorMetadata, type ConnectorMetadata } from '../utils/connector-compiler';
import { upsertConnectorDefinitionRecords } from '../utils/connector-definition-install';
import { ensureUniqueConnectionSlug, isConnectionSlugUniqueViolation } from '../utils/connections';
import { clearDevicePinTombstoneIfPinned } from '../utils/device-pin-tombstones';
import { DEVICE_AUTOWIRE_SUPPRESSION_KEY } from '../utils/device-autowire-suppression';
import { errorMessage } from '../utils/errors';
import logger from '../utils/logger';
import {
  attestDeviceManifestArtifacts,
  getDeviceManifestClaimAuthorizationsForDevice,
  getDeviceManifestSourcesForUser,
  sortJson,
  type DeviceConnectorSource,
  type ManifestClaimAuthorization,
} from './device-manifests';

/**
 * The slice of a manifest `feeds_schema[key]` this module reads. Deliberately
 * local and minimal — reconcile is not the place to grow a feed-definition
 * contract, and a manifest is untyped JSON off the wire regardless.
 */
interface ManifestFeed {
  name?: string;
  operations?: FeedOperation[];
}

/** A device worker counts toward "serves capability X" only if seen this recently. */
const DEVICE_WORKER_FRESH_INTERVAL = '7 days';

/**
 * Install + wire a bundled device connector into the user's personal org:
 * connector definition (idempotent), a no-auth connection, the first feed, and
 * re-activate the feed if a previous "capability went away" pass had paused it.
 * New connections are seeded with the org definition's `default_connection_config`
 * (connection-scoped keys only), and surviving NULL-config rows are healed the
 * same way — mirroring manage_connections create/connect — so device swaps
 * don't silently regress action modes to descriptor fallbacks.
 * Called by {@link reconcileDeviceCapabilities} for each device connector whose
 * `requiredCapability` is currently advertised by the user's fleet — which
 * connectors those are is read from the catalog, never hardcoded here.
 *
 * The per-(user, connector) advisory lock serializes concurrent polls / multiple
 * devices so they don't race past the existence checks and create duplicates.
 * Best-effort: failures are logged but never surface to the poll response.
 *
 * Existing device pins are execution placement, not a freshness hint. Initial
 * wiring may bind an unpinned connection to its sole advertiser; later polls
 * must preserve that placement through upgrades, permission loss, and sleep.
 */
async function ensureDeviceConnectorWired(
  userId: string,
  organizationId: string,
  connectorKey: string,
  declaredFeedKeys: string[],
  matchingDeviceIds: string[],
  source?: DeviceConnectorSource,
  pollingDeviceId?: string | null
): Promise<ManifestClaimAuthorization | null> {
  const sql = getDb();

  const initializePin = async (
    db: typeof sql,
    connectionId: number,
    currentMatchingDeviceIds = matchingDeviceIds
  ) => {
    const target = currentMatchingDeviceIds.length === 1 ? currentMatchingDeviceIds[0] : null;
    if (target) {
      // Preserve existing pins and respect idx_connections_org_connector_device_live.
      // Callers hold the autowire lock so concurrent replicas cannot both pass
      // NOT EXISTS before either transaction commits.
      await db`
        UPDATE connections c
        SET device_worker_id = ${target}::uuid, updated_at = NOW()
        WHERE c.id = ${connectionId}
          AND c.device_worker_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM connections other
            WHERE other.organization_id = ${organizationId}
              AND other.connector_key = ${connectorKey}
              AND other.device_worker_id = ${target}::uuid
              AND other.deleted_at IS NULL
          )
      `;
    }
    await clearDevicePinTombstoneIfPinned(db, {
      connectionId,
      matchingDeviceIds: currentMatchingDeviceIds,
    });
  };
  const lockedManifestWinner = async (db: typeof sql): Promise<DeviceConnectorSource | null> => {
    if (!source) return null;
    const current = (
      await getDeviceManifestSourcesForUser({ sql: db, userId, connectorKey })
    ).find((candidate) => candidate.key === connectorKey);
    if (
      !current ||
      current.metadata.version !== source.metadata.version ||
      current.manifestHash !== source.manifestHash
    ) {
      return null;
    }
    return current;
  };
  const claimAuthorization = (
    currentSource: DeviceConnectorSource | null
  ): ManifestClaimAuthorization | null => {
    if (
      !currentSource ||
      !pollingDeviceId ||
      !currentSource.advertiserDeviceIds.includes(pollingDeviceId)
    ) {
      return null;
    }
    return {
      connectorKey: currentSource.key,
      connectorVersion: currentSource.metadata.version,
      manifestHash: currentSource.manifestHash,
      definitionManifestHash: currentSource.definitionManifestHash,
      sourcePath: currentSource.sourcePath,
    };
  };
  const selectedArtifactMatches = async (
    db: typeof sql,
    currentSource: DeviceConnectorSource
  ): Promise<boolean> => {
    const rows = await db`
      SELECT 1
      FROM connector_definitions cd
      JOIN LATERAL (
        SELECT
          cv.source_path,
          cv.compiled_code,
          cv.compiled_code_hash,
          cv.compile_config_hash,
          cv.source_code
        FROM connector_versions cv
        WHERE cv.connector_key = cd.key
          AND cv.version = cd.version
          AND (cv.organization_id = cd.organization_id OR cv.organization_id IS NULL)
        ORDER BY cv.organization_id NULLS LAST
        LIMIT 1
      ) cv ON true
      WHERE cd.organization_id = ${organizationId}
        AND cd.key = ${connectorKey}
        AND cd.status = 'active'
        AND cd.version = ${currentSource.metadata.version}
        AND cv.source_path = ${currentSource.sourcePath}
        AND cv.compiled_code IS NULL
        AND cv.compiled_code_hash = ${currentSource.manifestHash}
        AND cv.compile_config_hash IS NULL
        AND cv.source_code IS NULL
      LIMIT 1
    `;
    return rows.length > 0;
  };

  try {
    // Fast path: definition + version + connection + EVERY declared feed active
    // → nothing to repair or re-activate. The feed list comes from the bundled
    // catalog source, not the installed DB row, so adding a new bundled feed
    // still heals existing installs after deploy.
    const existingReady = (await sql`
      SELECT
        c.id AS connection_id,
        cv.connector_key AS version_key,
        cv.source_path AS version_source_path,
        cv.compiled_code AS version_compiled_code,
        cv.compiled_code_hash AS version_artifact_hash,
        cv.compile_config_hash AS version_compile_config_hash,
        cv.source_code AS version_source_code,
        cd.name AS def_name,
        cd.description AS def_description,
        cd.version AS def_version,
        cd.auth_schema AS def_auth_schema,
        cd.feeds_schema AS def_feeds_schema,
        cd.actions_schema AS def_actions_schema,
        cd.options_schema AS def_options_schema,
        cd.favicon_domain AS def_favicon_domain,
        cd.required_capability AS def_required_capability,
        cd.runtime AS def_runtime,
        cd.default_connection_config AS def_default_config,
        c.config AS conn_config,
        -- jsonb_agg, not array_agg: postgres.js (fetch_types:false) returns a
        -- text[] result column as the literal string "{a,b}", which would make
        -- the fast-path feed check below silently always miss. jsonb arrays are
        -- parsed to JS arrays by the db client's value transform.
        COALESCE(
          jsonb_agg(f.feed_key) FILTER (WHERE f.id IS NOT NULL),
          '[]'::jsonb
        ) AS active_feed_keys
      FROM connector_definitions cd
      LEFT JOIN LATERAL (
        SELECT
          connector_key,
          source_path,
          compiled_code,
          compiled_code_hash,
          compile_config_hash,
          source_code
        FROM connector_versions
        WHERE connector_key = cd.key AND version = cd.version
          AND (organization_id = cd.organization_id OR organization_id IS NULL)
        ORDER BY organization_id NULLS LAST
        LIMIT 1
      ) cv ON TRUE
      LEFT JOIN connections c
        ON c.organization_id = cd.organization_id
       AND c.connector_key = cd.key
       AND c.auth_profile_id IS NULL
       -- Auto-wire's own INSERT writes NULL to BOTH profile columns, so a row
       -- with either one set is credential-backed and user-created. Matching on
       -- auth_profile_id alone let the fast path adopt an app-auth-backed
       -- connection and re-pin it — the poll withholds credentials from
       -- unpinned connections, so that breaks a connection this pass never made.
       AND c.app_auth_profile_id IS NULL
       AND c.deleted_at IS NULL
      LEFT JOIN feeds f
        ON f.connection_id = c.id
       AND f.status = 'active'
       AND f.deleted_at IS NULL
      WHERE cd.organization_id = ${organizationId}
        AND cd.key = ${connectorKey}
        AND cd.status = 'active'
      GROUP BY
        c.id,
        cv.connector_key,
        cv.source_path,
        cv.compiled_code,
        cv.compiled_code_hash,
        cv.compile_config_hash,
        cv.source_code,
        cd.id
      LIMIT 1
    `) as unknown as Array<{
      connection_id: number | null;
      version_key: string | null;
      version_source_path: string | null;
      version_compiled_code: string | null;
      version_artifact_hash: string | null;
      version_compile_config_hash: string | null;
      version_source_code: string | null;
      def_name: string | null;
      def_description: string | null;
      def_version: string | null;
      def_auth_schema: unknown;
      def_feeds_schema: unknown;
      def_actions_schema: unknown;
      def_options_schema: unknown;
      def_favicon_domain: string | null;
      def_required_capability: string | null;
      def_runtime: unknown;
      def_default_config: unknown;
      conn_config: unknown;
      active_feed_keys: string[] | null;
    }>;
    // Device-manifest connectors carry their full metadata in-hand (`source`),
    // so a changed manifest MUST break the fast path or the org catalog is
    // stranded on the old definition forever: the extension re-sends its
    // manifest on every poll, but nothing else ever re-runs the definition
    // upsert once everything is wired (this exact staleness shipped
    // console_capture to device_workers while list_available kept serving the
    // old 12-action chrome catalog). Compare every field the definition upsert
    // writes, in the manifest hash's canonical form. Bundled connectors
    // (`source` undefined) are excluded on purpose — their metadata requires a
    // compile we can't afford per poll; deploys refresh them via other paths.
    const definitionMatchesSource = (row: (typeof existingReady)[0]): boolean => {
      if (!source) return true;
      const m = source.metadata;
      const canon = (v: unknown) => JSON.stringify(sortJson(v ?? null));
      return (
        row.def_name === m.name &&
        (row.def_description ?? null) === (m.description ?? null) &&
        row.def_version === m.version &&
        row.version_source_path === source.sourcePath &&
        row.version_compiled_code == null &&
        row.version_artifact_hash === source.manifestHash &&
        row.version_compile_config_hash == null &&
        row.version_source_code == null &&
        (row.def_favicon_domain ?? null) === (m.faviconDomain ?? null) &&
        (row.def_required_capability ?? null) === (m.requiredCapability ?? null) &&
        canon(row.def_auth_schema) === canon(m.authSchema) &&
        canon(row.def_feeds_schema) === canon(m.feeds) &&
        canon(row.def_actions_schema) === canon(m.actions) &&
        canon(row.def_options_schema) === canon(m.optionsSchema) &&
        canon(row.def_runtime) === canon(m.runtime)
      );
    };
    const activeFeedKeys = new Set(existingReady[0]?.active_feed_keys ?? []);
    const readyConnectionId = existingReady[0]?.connection_id;
    // A ready connection whose config is SQL NULL while the org definition
    // carries a default needs the default seeded — the fast path must not
    // leave it resolving against raw descriptor fallbacks. `conn_config` is the
    // raw jsonb value (`null` only when the column is SQL NULL), so an empty
    // explicit `{}` still counts as configured. Seeded in wireOnce below.
    // The predicate gates on the CONNECTION-scoped half of the default
    // (`splitConfigByFeedScope(…).connectionConfig`), the exact value seeding
    // can write: a wholly feed-scoped default must not keep a NULL-config
    // connection spinning the wire path forever. `def_feeds_schema` equals the
    // manifest feeds on this path (definitionMatchesSource above), so the split
    // here mirrors the one wireOnce performs; don't re-split against a
    // different feeds schema, or the gate and the seed stop agreeing.
    const needsDefaultConfigSeed =
      existingReady[0]?.conn_config == null &&
      splitConfigByFeedScope(
        parseJsonObject(existingReady[0]?.def_default_config),
        (existingReady[0]?.def_feeds_schema as Record<string, FeedDefinition> | null) ?? null,
      ).connectionConfig != null;
    const ready =
      readyConnectionId != null &&
      existingReady[0]?.version_key != null &&
      definitionMatchesSource(existingReady[0]) &&
      !needsDefaultConfigSeed &&
      // userManaged-only connectors (e.g. local.directory, browser/*) report
      // declaredFeedKeys=[]. Once the connection + definition are installed,
      // every subsequent poll has nothing to verify — fast-path out.
      // Composing primitives still hit /api/workers/me/feeds to mint
      // explicit per-instance rows; that path is unchanged.
      (declaredFeedKeys.length === 0 ||
        declaredFeedKeys.every((feedKey) => activeFeedKeys.has(feedKey)));
    if (ready) {
      if (source) {
        return sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtext('lobu:autowire'), hashtext(${`${userId}:${connectorKey}`}))`;
          const currentSource = await lockedManifestWinner(tx);
          if (!currentSource || !(await selectedArtifactMatches(tx, currentSource))) return null;
          await initializePin(
            tx,
            readyConnectionId,
            currentSource.advertiserDeviceIds
          );
          return claimAuthorization(currentSource);
        });
      } else {
        // Keep initial binding serialized, as in the manifest branch above.
        // (No bundled device connectors ship today, so this branch is currently
        // unreachable — keep it serialized anyway rather than leave the race
        // armed for the first one that does.)
        await sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtext('lobu:autowire'), hashtext(${`${userId}:${connectorKey}`}))`;
          await initializePin(tx, readyConnectionId);
        });
      }
      return null;
    }

    let metadata: ConnectorMetadata;
    let sourcePath: string;
    let feedKeys = declaredFeedKeys;
    if (source) {
      metadata = source.metadata;
      sourcePath = source.sourcePath;
    } else {
      // Compile metadata outside the lock (pure CPU + a child process — slow).
      const filePath = findBundledConnectorFile(connectorKey);
      if (!filePath) {
        logger.warn({ connectorKey }, '[auto-wire] Bundled connector file not found');
        return null;
      }
      const compiledCode = await compileConnectorForIsolateFromFile(filePath);
      metadata = await extractConnectorMetadata(compiledCode);
      sourcePath = bundledConnectorSourcePath(filePath);
      if (!metadata.key || !metadata.name || !metadata.version) return null;
      const feedsSchema = metadata.feeds as Record<
        string,
        { configSchema?: unknown; userManaged?: boolean }
      > | null;
      // Skip feeds the connector marks `userManaged` — they need per-instance
      // config (e.g. local.directory.files needs a folder_id per folder) that
      // auto-wire can't supply. The Mac app creates them explicitly via
      // /api/workers/me/feeds once it has the folder bookmark.
      feedKeys = feedsSchema
        ? Object.keys(feedsSchema).filter((k) => !feedsSchema[k]?.userManaged)
        : [];
    }

    let connectionId: number | undefined;
    const wireOnce = () => sql.begin(async (tx): Promise<ManifestClaimAuthorization | null> => {
      // Serialize per (user, connector): two concurrent polls / two devices
      // both reach here, but only one holds the lock at a time, so the
      // existence-check-then-insert below is atomic.
      await tx`SELECT pg_advisory_xact_lock(hashtext('lobu:autowire'), hashtext(${`${userId}:${connectorKey}`}))`;
      // Winner selection before this lock is only a scheduling hint. Recompute
      // the deterministic winner while serialized so a stale waiter can never
      // downgrade metadata after a newer manifest has arrived.
      const currentSource = source ? await lockedManifestWinner(tx) : null;
      if (source && !currentSource) return null;

      // An explicit user delete is durable opt-out for this device connector.
      // The marker is reserved at every public config-write path and delete
      // writes it only after proving the connection belongs to this personal
      // org's active device-connector definition. A device pin is deliberately
      // not required: multi-device auto-wiring leaves the connection unpinned.
      // The live-row anti-join makes an explicit reconnect the sole way to
      // clear the opt-out without mutating the tombstone during heartbeat
      // reconciliation. Only `handleDelete` writes this reserved marker;
      // system retirement paths may tombstone rows but never create an opt-out.
      const suppressed = (await tx`
        SELECT 1
        FROM connections
        WHERE organization_id = ${organizationId}
          AND connector_key = ${connectorKey}
          AND auth_profile_id IS NULL
          AND app_auth_profile_id IS NULL
          AND deleted_at IS NOT NULL
          AND config->>${DEVICE_AUTOWIRE_SUPPRESSION_KEY} = 'true'
          AND NOT EXISTS (
            SELECT 1
            FROM connections live
            WHERE live.organization_id = ${organizationId}
              AND live.connector_key = ${connectorKey}
              AND live.auth_profile_id IS NULL
              AND live.app_auth_profile_id IS NULL
              AND live.deleted_at IS NULL
          )
        LIMIT 1
      `) as unknown as Array<{ '?column?': number }>;
      if (suppressed.length > 0) return null;

      // 2. Ensure the connector definition + version are installed (idempotent).
      await upsertConnectorDefinitionRecords({
        sql: tx,
        organizationId,
        metadata,
        versionRecord: {
          compiledCode: null,
          // Device manifests have no compiled bytes, so compiled_code_hash is
          // the existing durable artifact-hash slot for their validated
          // manifest identity. Claim authorization compares this exact value.
          compiledCodeHash: currentSource?.manifestHash ?? null,
          compileConfigHash: null,
          sourceCode: null,
          sourcePath,
        },
        // A device-manifest connector's sourcePath is meaningful only to the
        // owning user's daemon → their org's row. A bundled device connector
        // points at the shared on-disk catalog → shared row.
        versionScope: source ? 'organization' : 'shared',
      });
      // Seed new/repaired auto-wired connections from the org's definition
      // default, exactly like manage_connections create/connect merge
      // `default_connection_config` into the new row's config — auto-wire is
      // the only creation path that previously skipped this, so a device swap
      // silently regressed action modes to descriptor fallbacks. Feed-scoped
      // default keys are dropped here — auto-wired feeds are minted with
      // `config = NULL` (unchanged from the pre-seed path); the fast-path gate
      // accounts for this so a wholly feed-scoped default does not re-wire
      // forever.
      const defaultConnectionConfig =
        (await tx`
          SELECT default_connection_config
          FROM connector_definitions
          WHERE organization_id = ${organizationId}
            AND key = ${connectorKey}
            AND status = 'active'
          LIMIT 1
        `) as unknown as Array<{ default_connection_config: unknown }>;
      const splitConfig = splitConfigByFeedScope(
        parseJsonObject(defaultConnectionConfig[0]?.default_connection_config),
        (metadata.feeds as unknown as Record<string, FeedDefinition>) ?? null,
      );
      const seedConfig = splitConfig.connectionConfig;

      // 3. Reuse or create the connection (no-auth, active, private). Match on
      //    (org, connector, no auth_profile) — the device-connector identity —
      //    rather than created_by, so orphan rows (created_by IS NULL, or
      //    created by a different user/token) get adopted and self-healed
      //    instead of stranded behind a slug-collision insert.
      const existingConn = (await tx`
        SELECT id, created_by FROM connections
        WHERE organization_id = ${organizationId}
          AND connector_key = ${connectorKey}
          AND auth_profile_id IS NULL
          AND app_auth_profile_id IS NULL
          AND deleted_at IS NULL
        ORDER BY id ASC
        LIMIT 1
      `) as unknown as Array<{ id: number; created_by: string | null }>;
      connectionId = existingConn[0]?.id;
      if (connectionId && existingConn[0].created_by == null) {
        // Backfill ownership so future per-user queries (e.g. /api/me/devices)
        // attribute the connection to the user whose poll wired it.
        await tx`
          UPDATE connections
          SET created_by = ${userId}, updated_at = NOW()
          WHERE id = ${connectionId} AND created_by IS NULL
        `;
      }
      if (connectionId && seedConfig) {
        // Heal a surviving connection whose config is still SQL NULL (a row
        // created before the definition default existed, or by the old
        // no-seed path): seed the same default now. Guarded by `config IS NULL`
        // so an explicit per-connection config is never clobbered. Idempotent —
        // once seeded, this UPDATE stops matching.
        await tx`
          UPDATE connections
          SET config = ${sql.json(seedConfig)}, updated_at = NOW()
          WHERE id = ${connectionId} AND config IS NULL AND deleted_at IS NULL
        `;
      }
      if (!connectionId) {
        // Stable slug for `lobu apply` diffing — same generation path as
        // manage_connections.
        //
        // The advisory lock above does NOT make this race-free, contrary to
        // what this comment used to claim. The lock is keyed on
        // (userId, connectorKey), but the slug derives from the connector's
        // DISPLAY NAME and uniqueness is enforced per-ORG by
        // `connections_org_slug_unique`. Two different connector keys take two
        // different locks and run concurrently, so two connectors sharing a
        // display name compute the same free slug and the loser's INSERT trips
        // the constraint. Reproduced: see
        // device-reconcile-slug-race.test.ts. Lock scope and
        // uniqueness scope simply are not the same scope.
        //
        // The retry lives OUTSIDE this transaction (at the wireOnce call
        // site below), because an aborted transaction cannot be continued —
        // which is the one thing the old comment got right.
        const slug = await ensureUniqueConnectionSlug({
          organizationId,
          connectorKey,
          displayName: metadata.name,
          db: tx,
        });
        const inserted = (await tx`
          INSERT INTO connections (
            organization_id, connector_key, slug, display_name, status,
            auth_profile_id, app_auth_profile_id, config, created_by, visibility
          ) VALUES (
            ${organizationId}, ${connectorKey}, ${slug}, ${metadata.name}, 'active',
            NULL, NULL, ${seedConfig ? sql.json(seedConfig) : null}, ${userId}, 'private'
          )
          RETURNING id
        `) as unknown as Array<{ id: number }>;
        connectionId = inserted[0]?.id;
      }
      if (!connectionId) return null;

      // 4. Ensure every connector-declared feed exists and is active. A feed's
      //    handlers decide its operations; the same row may sync and read.
      const declaredFeeds = metadata.feeds as Record<string, ManifestFeed> | null;

      for (const feedKey of feedKeys) {
        const operations = declaredFeeds?.[feedKey]?.operations ?? [];
        const canSync = operations.includes('sync');
        const existingFeed = (await tx`
          SELECT id FROM feeds
          WHERE connection_id = ${connectionId}
            AND feed_key = ${feedKey}
            AND deleted_at IS NULL
          LIMIT 1
        `) as unknown as Array<{ id: number }>;

        if (existingFeed[0]?.id) {
          await tx`
            UPDATE feeds
            SET status = 'active',
                next_run_at = ${
                  canSync
                    ? // Re-arm only a feed that HAS a cron, where NULL means
                      // "auto-paused / cleared" and NOW() resumes its cadence.
                      // A feed with no cron is manual by #2021, and stamping
                      // NOW() here invented a trigger nobody chose: this branch
                      // runs on the slow wire path, which the `ready` fast path
                      // skips until the manifest hash changes, so the feed
                      // synced exactly once per extension version. Prod: chrome
                      // `tab_events` and `watch_observations` = 9 runs since
                      // 2026-08-04 while their scheduled siblings ran 5,449 —
                      // every one `completed`, so no failure signal ever fired.
                      tx`CASE WHEN schedule IS NULL THEN next_run_at
                              ELSE COALESCE(next_run_at, NOW()) END`
                    : tx`NULL::timestamptz`
                },
                updated_at = current_timestamp
            WHERE id = ${existingFeed[0].id}
          `;
        } else {
          // The manifest's per-feed `name` when it declares one, and only the
          // connector's own name as the fallback.
          const declaredName = declaredFeeds?.[feedKey]?.name;
          const displayName =
            typeof declaredName === 'string' && declaredName.trim().length > 0
              ? declaredName.trim()
              : metadata.name;
          // The initial stamp STAYS, unlike the re-arm above: one backfill on
          // first wire is what makes a newly connected device show anything at
          // all, and it is a one-shot, not a cadence. What it must not do is
          // masquerade as a working feed afterwards — that is now visible as
          // `attention='no_trigger'` rather than hidden behind a lone
          // successful sync (see `connectors/feed-health-semantics.ts`).
          await tx`
            INSERT INTO feeds (
              organization_id, connection_id, feed_key, display_name, status,
              next_run_at
            ) VALUES (
              ${organizationId}, ${connectionId}, ${feedKey},
              ${displayName}, 'active',
              ${canSync ? new Date() : null}
            )
          `;
        }
      }

      // Bind an unpinned connection only when there is a sole advertiser.
      await initializePin(
        tx,
        connectionId,
        currentSource?.advertiserDeviceIds ?? matchingDeviceIds
      );
      if (currentSource && !(await selectedArtifactMatches(tx, currentSource))) return null;
      return claimAuthorization(currentSource);
    });

    let authorization: ManifestClaimAuthorization | null;
    try {
      authorization = await wireOnce();
    } catch (err) {
      // Retry ONCE, and only for the slug collision described above. The
      // retry recomputes the slug against a tree that now contains the
      // winner's committed row, so it converges on `<base>-2` rather than
      // repeating the same losing bet.
      //
      // Bounded at one attempt deliberately. The next poll is the real retry
      // budget for this reconcile — it already heals the collision — so this
      // exists to avoid a spurious error-level log and a poll-cycle delay,
      // not to guarantee convergence here. Anything unbounded would be a
      // second retry budget layered on the existing one.
      if (!isConnectionSlugUniqueViolation(err)) throw err;
      logger.info(
        { userId, connectorKey, organizationId },
        '[device-connectors] Connection slug raced a concurrent wire; retrying once'
      );
      authorization = await wireOnce();
    }

    if (connectionId) {
      logger.info(
        { userId, connectorKey, organizationId, connectionId },
        '[device-connectors] Wired device connector'
      );
    }
    return authorization;
  } catch (err) {
    logger.error(
      { userId, connectorKey, err: errorMessage(err) },
      '[device-connectors] Failed to wire device connector'
    );
    return null;
  }
}

/**
 * Pause the auto-wired feeds of `connectorKey` in the user's personal org —
 * called when no recently-seen device of the user still advertises the
 * connector's `requiredCapability`, so a `materializeDueFeeds` pass stops
 * creating runs nothing can claim. Limited to no-auth, user-owned connections
 * in the personal org (exactly what {@link ensureDeviceConnectorWired} creates);
 * that function re-activates them if the capability comes back. Best-effort.
 */
async function pauseStaleDeviceFeeds(userId: string, organizationId: string, connectorKey: string) {
  const sql = getDb();
  try {
    await sql`
      UPDATE feeds f
      SET status = 'paused', updated_at = current_timestamp
      FROM connections c
      WHERE f.connection_id = c.id
        AND c.organization_id = ${organizationId}
        AND c.connector_key = ${connectorKey}
        AND c.created_by = ${userId}
        AND c.auth_profile_id IS NULL
        AND c.app_auth_profile_id IS NULL
        AND c.deleted_at IS NULL
        AND f.status = 'active'
        AND f.deleted_at IS NULL
    `;
  } catch (err) {
    logger.warn(
      { userId, connectorKey, err: errorMessage(err) },
      '[device-connectors] Failed to pause stale device feeds'
    );
  }
}

/**
 * Archive unreferenced org-scoped definitions created by device reconciliation
 * that no current connector source still advertises. This includes manifest
 * versions and metadata-only shared pointers left by a formerly bundled device
 * connector, but excludes org-custom sources. A live connection always protects
 * its definition: connection fields do not record whether reconcile or a user
 * created the row, so deleting based on a guessed "auto-wire shape" would risk
 * deleting user configuration. The wire and archive paths share a per-key lock
 * and re-check stored manifests so concurrent polls converge. Best-effort.
 */
async function archiveVanishedDeviceConnectorDefinitions(
  userId: string,
  organizationId: string,
  liveKeys: string[]
): Promise<void> {
  const sql = getDb();
  try {
    const archived = await sql.begin(async (tx) => {
      const candidates = (await tx`
        SELECT cd.key
        FROM connector_definitions cd
        WHERE cd.organization_id = ${organizationId}
          AND cd.status = 'active'
          AND cd.required_capability IS NOT NULL
          AND NOT (cd.key = ANY(${pgTextArray(liveKeys)}::text[]))
          AND COALESCE((
            SELECT CASE
              WHEN cv.organization_id IS NOT NULL
                THEN cv.source_path LIKE 'device-manifest://%'
              ELSE cv.source_path IS NOT NULL
                AND cv.compiled_code IS NULL
                AND cv.source_code IS NULL
            END
            FROM connector_versions cv
            WHERE cv.connector_key = cd.key
              AND cv.version = cd.version
              AND (cv.organization_id = cd.organization_id OR cv.organization_id IS NULL)
            ORDER BY cv.organization_id NULLS LAST
            LIMIT 1
          ), false)
          AND NOT EXISTS (
            SELECT 1 FROM connections c
            WHERE c.organization_id = cd.organization_id
              AND c.connector_key = cd.key
              AND c.deleted_at IS NULL
          )
        ORDER BY cd.key
      `) as unknown as Array<{ key: string }>;
      for (const { key } of candidates) {
        await tx`SELECT pg_advisory_xact_lock(hashtext('lobu:autowire'), hashtext(${`${userId}:${key}`}))`;
      }
      if (candidates.length === 0) return [];
      const candidateKeys = candidates.map(({ key }) => key);

      const rows = (await tx`
        UPDATE connector_definitions cd
        SET status = 'archived', updated_at = NOW()
        WHERE cd.organization_id = ${organizationId}
          AND cd.status = 'active'
          AND cd.required_capability IS NOT NULL
          AND cd.key = ANY(${pgTextArray(candidateKeys)}::text[])
          AND COALESCE((
            SELECT CASE
              WHEN cv.organization_id IS NOT NULL
                THEN cv.source_path LIKE 'device-manifest://%'
              ELSE cv.source_path IS NOT NULL
                AND cv.compiled_code IS NULL
                AND cv.source_code IS NULL
            END
            FROM connector_versions cv
            WHERE cv.connector_key = cd.key
              AND cv.version = cd.version
              AND (cv.organization_id = cd.organization_id OR cv.organization_id IS NULL)
            ORDER BY cv.organization_id NULLS LAST
            LIMIT 1
          ), false)
          AND NOT EXISTS (
            SELECT 1
            FROM device_workers dw
            WHERE dw.user_id = ${userId}
              AND dw.last_seen_at > now() - ${DEVICE_WORKER_FRESH_INTERVAL}::interval
              AND dw.connector_manifests -> cd.key IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM connections c
            WHERE c.organization_id = cd.organization_id
              AND c.connector_key = cd.key
              AND c.deleted_at IS NULL
          )
        RETURNING cd.key
      `) as unknown as Array<{ key: string }>;
      return rows;
    });

    if (archived.length > 0) {
      logger.info(
        { userId, organizationId, keys: archived.map((r) => r.key) },
        '[device-connectors] Archived definitions no longer served by any connector source'
      );
    }
  } catch (err) {
    logger.warn(
      { userId, organizationId, err: errorMessage(err) },
      '[device-connectors] Failed to archive vanished device connector definitions'
    );
  }
}

/**
 * Reconcile a user's device connectors against what their device fleet can
 * actually serve. The set of device connectors comes from the catalog (any
 * bundled connector with a `runtime` block + a `requiredCapability`); the set of
 * served capabilities is the union over the user's devices seen within
 * `DEVICE_WORKER_FRESH_INTERVAL`. Manifest sources additionally carry the exact
 * devices advertising the winning version/hash/metadata. For each device
 * connector: if a matching implementation is served, wire / re-activate it;
 * otherwise pause its auto-wired feeds so `materializeDueFeeds` stops creating
 * runs nothing can claim.
 *
 * Best-effort; runs on every user-scoped poll. Nothing connector-specific is
 * hardcoded — adding a new device connector is just a new file in the catalog.
 */
export async function reconcileDeviceCapabilities(
  userId: string,
  pollingDeviceId?: string | null
): Promise<ManifestClaimAuthorization[]> {
  const sql = getDb();

  let bundledDeviceConnectors: BundledDeviceConnector[];
  // Both connector sources are fail-soft (empty on error), which makes "no
  // sources" ambiguous: nothing is served, or we failed to look. Only the
  // latter must suppress the archive pass below — an empty-but-successful read
  // is a legitimate "this fleet serves nothing", and is in fact the normal
  // state for a Chrome-only user (no bundled device connectors exist server
  // side; every one of them arrives as a device manifest).
  let sourcesReadable = true;
  try {
    bundledDeviceConnectors = await getBundledDeviceConnectors();
  } catch (err) {
    logger.warn(
      { userId, err: errorMessage(err) },
      '[device-connectors] Failed to read device connector catalog'
    );
    bundledDeviceConnectors = [];
    sourcesReadable = false;
  }

  // Device data ALWAYS lands in the user's personal org — device tokens are
  // force-bound there (see oauth/device/approve + mint-child-token), and a
  // team org reaches a device by pinning an automation/connection to it
  // (resolveDeviceClaimableOrgs), not by re-binding the device. So auto-wire
  // targets the personal org regardless of where a legacy device_workers row
  // is still homed (older pairings may still carry a team org_id; they
  // converge here on the next poll).
  const personalOrg = await findExistingPersonalOrg(userId, sql);
  if (!personalOrg) {
    // No personal org → nothing to auto-wire. Don't touch team-org connectors
    // a user may have created manually; those survive on their own pins.
    return [];
  }
  const personalOrgId = personalOrg.id;

  // deviceId → capabilities it advertises (fresh devices only). We no longer
  // partition by the device's stored org_id: under the personal-org
  // invariant every device serves the personal workspace, so the fleet's
  // combined capabilities decide what gets wired, irrespective of legacy
  // per-device home rows.
  const deviceCaps = new Map<string, Set<string>>();
  try {
    const rows = (await sql`
      SELECT id, capabilities
      FROM device_workers
      WHERE user_id = ${userId}
        AND last_seen_at > now() - ${DEVICE_WORKER_FRESH_INTERVAL}::interval
    `) as unknown as Array<{ id: string; capabilities: unknown }>;
    for (const r of rows) {
      const caps = Array.isArray(r.capabilities) ? (r.capabilities as string[]) : [];
      deviceCaps.set(r.id, new Set(caps));
    }
  } catch (err) {
    logger.warn(
      { userId, err: errorMessage(err) },
      '[device-connectors] Failed to read device capabilities'
    );
    return [];
  }
  if (deviceCaps.size === 0) return [];
  const devicesWithCapability = (capability: string): string[] =>
    [...deviceCaps.entries()].
      filter(([, caps]) => caps.has(capability))
      .map(([id]) => id);

  let pollingDeviceAuthorizations: Awaited<
    ReturnType<typeof getDeviceManifestClaimAuthorizationsForDevice>
  > = [];
  let pollingManifestClaimsReadable = true;
  if (pollingDeviceId) {
    try {
      // Attest retained hashless rows before reconciliation's selected-artifact
      // check. The attestation is still bounded to this validated device's
      // exact manifest identity and org-scoped artifact row.
      pollingDeviceAuthorizations = await getDeviceManifestClaimAuthorizationsForDevice({
        sql,
        userId,
        deviceId: pollingDeviceId,
      });
      await attestDeviceManifestArtifacts({
        sql,
        organizationId: personalOrgId,
        authorizations: pollingDeviceAuthorizations,
      });
    } catch (err) {
      pollingManifestClaimsReadable = false;
      logger.warn(
        { userId, pollingDeviceId, err: errorMessage(err) },
        '[device-connectors] Failed to read polling device manifest claims'
      );
    }
  }

  let manifestSources: DeviceConnectorSource[] = [];
  try {
    manifestSources = await getDeviceManifestSourcesForUser({
      sql,
      userId,
    });
  } catch (err) {
    logger.warn(
      { userId, err: errorMessage(err) },
      '[device-connectors] Failed to read device connector manifests'
    );
    sourcesReadable = false;
  }

  const byKey = new Map<
    string,
    | (BundledDeviceConnector & { source?: undefined })
    | (DeviceConnectorSource & { source: 'device-manifest' })
  >();
  for (const dc of bundledDeviceConnectors) byKey.set(dc.key, dc);
  for (const src of manifestSources) byKey.set(src.key, { ...src, source: 'device-manifest' });

  // Runs BEFORE the early return: a fleet that advertises nothing is precisely
  // the case where every device definition in the org has gone stale, so
  // bailing on an empty `byKey` would skip the one pass that can clean it up.
  // Gated on `sourcesReadable` rather than on `byKey.size` — a transient read
  // failure must never be read as "the fleet serves nothing" and archive a
  // user's whole working set.
  if (sourcesReadable) {
    await archiveVanishedDeviceConnectorDefinitions(userId, personalOrgId, [...byKey.keys()]);
  }
  if (byKey.size === 0) return [];

  const reconciliationResults = await Promise.allSettled(
    [...byKey.values()].map((dc) => {
      const matchingDeviceIds =
        'source' in dc && dc.source === 'device-manifest'
          ? dc.advertiserDeviceIds
          : devicesWithCapability(dc.requiredCapability);
      return matchingDeviceIds.length > 0
        ? ensureDeviceConnectorWired(
            userId,
            personalOrgId,
            dc.key,
            dc.feedKeys,
            matchingDeviceIds,
            'source' in dc && dc.source === 'device-manifest'
              ? dc
              : undefined,
            pollingDeviceId
          )
        : pauseStaleDeviceFeeds(userId, personalOrgId, dc.key);
    })
  );

  const reconciledAuthorizations = reconciliationResults.flatMap((result) =>
    result.status === 'fulfilled' && result.value ? [result.value] : []
  );
  if (!pollingDeviceId) return reconciledAuthorizations;
  if (!pollingManifestClaimsReadable || !sourcesReadable) return [];

  // If the polling device is the current winner for a manifest key, a failed
  // wire/reconciliation must fail closed for that key. Historical claims are
  // allowed only for keys where this device advertises a retained version and
  // winner reconciliation belongs to another device.
  const currentWinnerKeysForPoller = new Set(
    manifestSources
      .filter((source) => source.advertiserDeviceIds.includes(pollingDeviceId))
      .map((source) => source.key)
  );
  const failedCurrentWinnerKeys = new Set(
    [...currentWinnerKeysForPoller].filter(
      (key) => !reconciledAuthorizations.some((authorization) => authorization.connectorKey === key)
    )
  );
  const all = [
    ...reconciledAuthorizations,
    ...pollingDeviceAuthorizations.filter(
      (authorization) => !failedCurrentWinnerKeys.has(authorization.connectorKey)
    ),
  ];
  return [...new Map(
    all.map((authorization) => [
      `${authorization.connectorKey}\u0000${authorization.connectorVersion}\u0000${authorization.manifestHash}`,
      authorization,
    ])
  ).values()];
}
