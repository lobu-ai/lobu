/**
 * Device-connector reconciliation.
 *
 * Extracted verbatim from `worker-api.ts`. On every user-scoped worker poll we
 * reconcile the user's device connectors against what their device fleet can
 * actually serve (capabilities advertised by devices seen recently), in each
 * device's HOME workspace — the one chosen when it was paired (personal by
 * default) or moved to on the Devices page. Wire / re-activate connectors whose
 * capability is served there (a private connection owned by the device's
 * owner); pause the auto-wired feeds of connectors whose capability has dropped
 * out so `materializeDueFeeds` stops creating runs nothing can claim.
 */

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
import {
  clearDevicePinTombstoneIfPinned,
  clearDeviceUpgradeRequired,
  DEVICE_UPGRADE_REQUIRED_PREFIX,
  deviceUpgradeRequiredMessage,
} from '../utils/device-pin-tombstones';
import {
  DEVICE_AUTOWIRE_SUPPRESSION_KEY,
  DEVICE_CONNECTOR_ARTIFACT_SQL,
  IS_DEVICE_CONNECTOR_SQL,
  ORG_INSTALLED_CONNECTOR_ARTIFACT_SQL,
} from '../utils/device-autowire-suppression';
import { DEVICE_WORKER_FRESH_INTERVAL } from '../utils/device-liveness';
import { errorMessage } from '../utils/errors';
import logger from '../utils/logger';
import { feedBackoff } from '../connectors/feed-backoff';
import {
  attestDeviceManifestArtifacts,
  compareSemverish,
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
  operations?: Array<'sync' | 'read'>;
}

/**
 * A device's HOME workspace: `device_workers.organization_id` (chosen when the
 * device was paired, or by a Devices-page move), with a NULL home counted as
 * the owner's personal workspace. Device connectors auto-wire here.
 */
interface DeviceHome {
  organizationId: string;
  personal: boolean;
}

/**
 * The connection rows auto-wire treats as THIS user's device connection in a
 * home workspace, for the `connections` row aliased `c`. A team workspace can
 * hold several members' device connections for one connector key, each private
 * to its creator, so a member must never adopt (and re-pin) a colleague's row.
 * Ownerless rows may be adopted only in the personal workspace. Adopting one
 * in a team workspace could attach a member's device to an org-visible row
 * without that member choosing to share it.
 */
function ownDeviceConnectionPredicate(
  db: ReturnType<typeof getDb>,
  home: DeviceHome,
  userId: string,
  alias: 'c' | 'connections' | 'live' = 'c'
) {
  const column = db.unsafe(`${alias}.created_by`);
  return home.personal
    ? db`TRUE`
    : db`${column} = ${userId}`;
}

/**
 * Install + wire a bundled device connector into the device home workspace:
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
  home: DeviceHome,
  connectorKey: string,
  declaredFeedKeys: string[],
  matchingDeviceIds: string[],
  source?: DeviceConnectorSource,
  pollingDeviceId?: string | null
): Promise<ManifestClaimAuthorization | null> {
  const sql = getDb();
  const organizationId = home.organizationId;

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
      await getDeviceManifestSourcesForUser({ sql: db, userId, connectorKey, home })
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
       AND ${ownDeviceConnectionPredicate(sql, home, userId)}
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
          await clearDeviceUpgradeRequired(tx, {
            connectionId: readyConnectionId,
            feedPauseThreshold: feedBackoff.pauseThreshold,
          });
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
      // writes it only after proving the connection is a credential-free row of
      // this org's active device-connector definition. In a team workspace the
      // opt-out is per member (the row's creator), like the connection itself. A device pin is deliberately
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
          AND ${ownDeviceConnectionPredicate(tx, home, userId, 'connections')}
          AND NOT EXISTS (
            SELECT 1
            FROM connections live
            WHERE live.organization_id = ${organizationId}
              AND live.connector_key = ${connectorKey}
              AND live.auth_profile_id IS NULL
              AND live.app_auth_profile_id IS NULL
              AND live.deleted_at IS NULL
              AND ${ownDeviceConnectionPredicate(tx, home, userId, 'live')}
          )
        LIMIT 1
      `) as unknown as Array<{ '?column?': number }>;
      if (suppressed.length > 0) return null;

      // Auto-wire writes on nobody's behalf, so it has to ask whether this org
      // already installed the key with its OWN code. A device-manifest write
      // replaces the whole artifact family rather than merging into it
      // (`replaceVersionArtifact`) — that atomic crossing is the writer's
      // deliberate INTEGRITY rule, and it applies in both directions, so the
      // writer cannot also be the one to refuse the crossing. The refusal is
      // authorization, and it belongs to the unattended caller.
      //
      // Only chrome.* is a reserved namespace
      // (`assertChromeNamespaceInstallIsDeviceManifest`); os.shell, apple.* and
      // local.directory are all keys a user may legitimately install with their
      // own source, which is exactly the collision.
      // `refreshPinnedOrgDeviceConnectorDefinitions` reaches the same outcome
      // by a stricter route: it SELECTS only orgs whose definition is already a
      // device connector (`IS_DEVICE_CONNECTOR_SQL`), which excludes an
      // org-installed artifact as a side effect. The wire path cannot reuse
      // that — it must also admit the first install, where no definition
      // exists yet — so it asks the ownership question directly.
      const [owned] = (await tx`
        SELECT ${tx.unsafe(ORG_INSTALLED_CONNECTOR_ARTIFACT_SQL)} AS org_installed
        FROM connector_definitions cd
        WHERE cd.organization_id = ${organizationId}
          AND cd.key = ${connectorKey}
          AND cd.status = 'active'
        LIMIT 1
      `) as unknown as Array<{ org_installed: boolean }>;
      if (owned?.org_installed) {
        // Warn, not debug, even though a colliding org can never reach the fast
        // path and so logs this on EVERY poll: the collision is a real config
        // conflict only a human resolves (uninstall one side), and
        // `[auto-wire] Bundled connector file not found` above is the same
        // unhealable-per-poll shape at the same level. Revisit if a real org
        // ever sits here — dedupe per (org, key) would need shared state.
        logger.warn(
          { userId, organizationId, connectorKey },
          '[auto-wire] Declined to wire over an org-installed connector artifact'
        );
        return null;
      }

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
      //    so personal-workspace orphan rows get adopted and self-healed
      //    instead of stranded behind a slug-collision insert. In a team
      //    workspace the identity also includes the member
      //    (`ownDeviceConnectionPredicate`): a colleague's private device
      //    connection is never adopted.
      const existingConn = (await tx`
        SELECT id, created_by FROM connections
        WHERE organization_id = ${organizationId}
          AND connector_key = ${connectorKey}
          AND auth_profile_id IS NULL
          AND app_auth_profile_id IS NULL
          AND deleted_at IS NULL
          AND ${ownDeviceConnectionPredicate(tx, home, userId, 'connections')}
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
          // Re-activate a feed paused only because its capability went away
          // (`pauseStaleDeviceFeeds` leaves `consecutive_failures` untouched),
          // but never resume a feed the failure policy hard-paused
          // (`applyFeedSyncFailure` pauses when `consecutive_failures` reaches
          // `feedBackoff.pauseThreshold`, with `next_run_at=NULL`). That pause
          // is deliberate: this wire path runs on every poll while the feed is
          // paused, so re-arming retries a broken feed forever. Resume of a
          // failure-paused feed stays an explicit `manage_feeds` update, which
          // also resets `consecutive_failures`/`first_failure_at`. No
          // manifest-change exception: a new extension version does not prove
          // the failure is fixed.
          const pauseThreshold = feedBackoff.pauseThreshold;
          await tx`
            UPDATE feeds
            SET status = 'active',
                next_run_at = ${
                  canSync
                    ? // Re-arm only a feed that HAS a cron, where NULL means
                      // "auto-paused / cleared" and NOW() resumes its cadence.
                      // A feed paused by the failure policy never reaches this
                      // statement (see guard below).
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
              AND NOT (status = 'paused' AND consecutive_failures >= ${pauseThreshold})
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
      await clearDeviceUpgradeRequired(tx, {
        connectionId,
        feedPauseThreshold: feedBackoff.pauseThreshold,
      });
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
 * Pause the auto-wired feeds of `connectorKey` in one device home workspace —
 * called when no recently-seen device of the user HOMED THERE still advertises
 * the connector's `requiredCapability`, so a `materializeDueFeeds` pass stops
 * creating runs nothing can claim. Limited to no-auth, user-owned connections
 * in that workspace (exactly what {@link ensureDeviceConnectorWired} creates);
 * that function re-activates them if the capability comes back. With
 * `unpinnedOnly` (a workspace no device of the user is homed in any more) it
 * touches only unpinned `private` rows, the shape auto-wire creates. Best-effort.
 */
async function pauseStaleDeviceFeeds(
  userId: string,
  organizationId: string,
  connectorKey: string,
  { unpinnedOnly = false }: { unpinnedOnly?: boolean } = {}
) {
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
        AND (${!unpinnedOnly} OR (c.device_worker_id IS NULL AND c.visibility = 'private'))
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
 * Pause this member's device connection for `connectorKey` in a TEAM workspace
 * whose one definition runs a newer version than any of the member's devices
 * homed there advertise. The connection can't serve that definition, so it is
 * paused (not left active and unusable) and its `error_message` says to update
 * Lobu on the device. Covers unpinned rows and rows pinned to a device homed
 * in this workspace; a pin to a device homed elsewhere is a deliberate
 * placement and is left alone. Never overwrites a different error. The stamp is
 * cleared by {@link ensureDeviceConnectorWired} once a device of the member
 * advertises the workspace's version. Best-effort.
 */
async function pauseForDeviceUpgrade(
  userId: string,
  organizationId: string,
  source: DeviceConnectorSource,
  deviceVersion: string
) {
  const sql = getDb();
  try {
    const [org] = (await sql`
      SELECT name FROM "organization" WHERE id = ${organizationId}
    `) as unknown as Array<{ name: string | null }>;
    const reason = deviceUpgradeRequiredMessage({
      connectorName: source.metadata.name,
      workspaceName: org?.name || 'this workspace',
      workspaceVersion: source.metadata.version,
      deviceVersion,
    });
    await sql`
      WITH paused AS (
        UPDATE connections c
        SET status = CASE WHEN c.status = 'active' THEN 'paused' ELSE c.status END,
            error_message = ${reason},
            updated_at = NOW()
        WHERE c.organization_id = ${organizationId}
          AND c.connector_key = ${source.key}
          AND c.created_by = ${userId}
          AND c.auth_profile_id IS NULL
          AND c.app_auth_profile_id IS NULL
          AND c.deleted_at IS NULL
          AND (c.error_message IS NULL OR starts_with(c.error_message, ${DEVICE_UPGRADE_REQUIRED_PREFIX}))
          AND (
            c.device_worker_id IS NULL
            OR EXISTS (
              SELECT 1 FROM device_workers dw
              WHERE dw.id = c.device_worker_id
                AND dw.user_id = ${userId}
                AND dw.organization_id = ${organizationId}
            )
          )
        RETURNING c.id
      )
      UPDATE feeds f
      SET status = 'paused', updated_at = current_timestamp
      FROM paused
      WHERE f.connection_id = paused.id
        AND f.status = 'active'
        AND f.deleted_at IS NULL
    `;
  } catch (err) {
    logger.warn(
      { userId, connectorKey: source.key, err: errorMessage(err) },
      '[device-connectors] Failed to pause a device connection pending a device update'
    );
  }
}

/**
 * Keep a manifest-backed device connector's definition current in every org the
 * device may ALREADY claim runs in, not just the workspaces its owner's devices
 * are homed in.
 *
 * A team org reaches a device by pinning a connection to it, and that pin is
 * the consent (`resolveDeviceClaimableOrgs`). Claim scope follows the pin, but
 * the definition refresh above does not: it targets the device homes only, so a
 * pinned org kept whatever `connector_definitions` row it happened to be
 * created with while the fleet moved on. Readiness compares the org's selected
 * artifact against the exact version/hash the device advertises
 * (`device-connector-readiness.ts`), so that drift made the pin permanently
 * unrunnable — every run failed admission with
 * `DEVICE_CONNECTOR_MANIFEST_UNAVAILABLE` and no self-service path repaired it
 * (`setup_options` only offers ways to authenticate, and `install_connector`
 * mints a source-backed artifact, not this identity).
 *
 * This mirrors the pin and nothing more: definition + version rows, only for
 * connector keys the org already pins, and only where the org's active
 * definition is ALREADY a device connector (`IS_DEVICE_CONNECTOR_SQL`). It
 * never creates a connection, feed or pin, and never archives — auto-wire and
 * `archiveVanishedDeviceConnectorDefinitions` stay scoped to device homes, so a
 * pin-only workspace's connector a user assembled by hand is still never
 * created or removed for them. Keys advertised in a home workspace follow that
 * home's winner; refreshing them to the fleet-wide winner would fight the wire
 * path. A workspace visited only to clean up old connections still needs its
 * explicit pins refreshed. `sources` is the manifest inventory, so a connector the catalog ships
 * but no device advertises is absent and is never touched; a key that is both
 * (`os.shell`) is repaired on its manifest identity, which is what readiness
 * compares, and the write is org-scoped — the shared version row a bundled
 * connector points at is never mutated.
 *
 * Best-effort, and a no-op write-side in the steady state: the read is the one
 * per poll, and it opens a transaction only for the orgs whose selected
 * artifact actually differs from what the fleet advertises.
 */
async function refreshPinnedOrgDeviceConnectorDefinitions(
  userId: string,
  homeSources: ReadonlyMap<string, readonly DeviceConnectorSource[]>,
  sources: readonly DeviceConnectorSource[]
): Promise<void> {
  if (sources.length === 0) return;
  const sourceByKey = new Map(sources.map((source) => [source.key, source]));
  const sql = getDb();
  let pinned: Array<{
    organization_id: string;
    connector_key: string;
    definition_version: string;
    artifact_hash: string | null;
  }>;
  try {
    pinned = (await sql`
      SELECT DISTINCT c.organization_id, c.connector_key,
             cd.version AS definition_version,
             cv.compiled_code_hash AS artifact_hash
      FROM connections c
      JOIN device_workers dw ON dw.id = c.device_worker_id
      -- The same membership join claim scope uses: leaving the org revokes it.
      JOIN "member" m
        ON m."organizationId" = c.organization_id AND m."userId" = ${userId}
      JOIN connector_definitions cd
        ON cd.organization_id = c.organization_id
       AND cd.key = c.connector_key
       AND cd.status = 'active'
      -- Resolve the artifact the way execution does, so "stale" here means
      -- exactly the compare readiness will fail on.
      LEFT JOIN LATERAL (
        SELECT v.compiled_code_hash
        FROM connector_versions v
        WHERE v.connector_key = cd.key
          AND v.version = cd.version
          AND (v.organization_id = cd.organization_id OR v.organization_id IS NULL)
        ORDER BY v.organization_id NULLS LAST
        LIMIT 1
      ) cv ON TRUE
      WHERE dw.user_id = ${userId}
        AND c.deleted_at IS NULL
        AND c.connector_key = ANY(${pgTextArray([...sourceByKey.keys()])}::text[])
        -- Repair only what device reconciliation itself installs. A manifest
        -- key the product also lets an org install with its own code (os.shell,
        -- apple.*, local.directory -- only chrome.* is reserved) would otherwise
        -- have those bytes replaced: a device-manifest write replaces the whole
        -- artifact family rather than merging into it.
        AND ${sql.unsafe(IS_DEVICE_CONNECTOR_SQL)}
    `) as unknown as typeof pinned;
  } catch (err) {
    logger.warn(
      { userId, err: errorMessage(err) },
      '[device-connectors] Failed to read pinned-org device connector definitions'
    );
    return;
  }
  // Write only where the org is actually behind what the fleet advertises, so a
  // converged fleet costs one indexed read per poll and opens no transaction.
  const stale = pinned.flatMap((row) => {
    if (homeSources.get(row.organization_id)?.some((source) => source.key === row.connector_key)) return [];
    const source = sourceByKey.get(row.connector_key);
    if (!source) return [];
    const behind =
      row.definition_version !== source.metadata.version ||
      row.artifact_hash !== source.manifestHash;
    return behind ? [{ organizationId: row.organization_id, source }] : [];
  });
  if (stale.length === 0) return;

  const results = await Promise.allSettled(
    stale.map(async ({ organizationId, source }) => {
      await sql.begin(async (tx) => {
        // Same per-(user, connector) lock the wire path takes, so a concurrent
        // poll cannot interleave two versions of the same definition.
        await tx`SELECT pg_advisory_xact_lock(hashtext('lobu:autowire'), hashtext(${`${userId}:${source.key}`}))`;
        await upsertConnectorDefinitionRecords({
          sql: tx,
          organizationId,
          metadata: source.metadata,
          versionRecord: {
            compiledCode: null,
            // Device manifests carry no compiled bytes; compiled_code_hash is
            // the durable slot readiness compares against the device's claim.
            compiledCodeHash: source.manifestHash,
            compileConfigHash: null,
            sourceCode: null,
            sourcePath: source.sourcePath,
          },
          versionScope: 'organization',
        });
      });
    })
  );
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      logger.warn(
        {
          userId,
          organizationId: stale[index]?.organizationId,
          connectorKey: stale[index]?.source.key,
          err: errorMessage(result.reason),
        },
        '[device-connectors] Failed to refresh a pinned-org device connector definition'
      );
    }
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
 * and re-check stored manifests so concurrent polls converge. Scoped to one
 * device home: a key is "still served" only by a fresh device homed in that
 * workspace (any member's, since the definition is the workspace's), so a
 * device moving from A to B never keeps A's definitions alive nor archives B's.
 * Best-effort.
 */
async function archiveVanishedDeviceConnectorDefinitions(
  userId: string,
  home: DeviceHome,
  liveKeys: string[]
): Promise<void> {
  const sql = getDb();
  const organizationId = home.organizationId;
  try {
    const archived = await sql.begin(async (tx) => {
      const candidates = (await tx`
        SELECT cd.key
        FROM connector_definitions cd
        WHERE cd.organization_id = ${organizationId}
          AND cd.status = 'active'
          AND cd.required_capability IS NOT NULL
          AND NOT (cd.key = ANY(${pgTextArray(liveKeys)}::text[]))
          AND ${tx.unsafe(DEVICE_CONNECTOR_ARTIFACT_SQL)}
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
          AND ${tx.unsafe(DEVICE_CONNECTOR_ARTIFACT_SQL)}
          AND NOT EXISTS (
            SELECT 1
            FROM device_workers dw
            WHERE dw.last_seen_at > now() - ${DEVICE_WORKER_FRESH_INTERVAL}::interval
              AND dw.connector_manifests -> cd.key IS NOT NULL
              AND ${
                home.personal
                  ? tx`(
                      dw.user_id = ${userId}
                      AND (dw.organization_id = ${organizationId} OR dw.organization_id IS NULL)
                    )`
                  : tx`(
                      dw.organization_id = ${organizationId}
                      AND EXISTS (
                        SELECT 1 FROM "member" m
                        WHERE m."organizationId" = ${organizationId} AND m."userId" = dw.user_id
                      )
                    )`
              }
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
 * actually serve, per device HOME workspace. The set of device connectors comes
 * from the catalog (any bundled connector with a `runtime` block + a
 * `requiredCapability`) plus the manifests devices advertise. Each fresh device
 * (seen within `DEVICE_WORKER_FRESH_INTERVAL`) serves the workspace it is homed
 * in — chosen at pairing, or by a Devices-page move — and only while its owner
 * is still a member. For each home workspace and device connector: if a device
 * homed there serves a matching implementation, wire / re-activate this user's
 * private connection there; otherwise pause its auto-wired feeds so
 * `materializeDueFeeds` stops creating runs nothing can claim.
 *
 * The workspaces visited are the homes of the user's fresh devices, the user's
 * personal workspace, and any workspace still holding this user's auto-wired
 * device connections — the last two so a workspace every device moved out of
 * still gets its stale feeds paused and its vanished definitions archived.
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

  const personalOrgId = (await findExistingPersonalOrg(userId, sql))?.id ?? null;

  // deviceId → capabilities it advertises, and deviceId → its home workspace
  // (fresh devices only). A NULL home is the personal workspace; a home the
  // owner is no longer a member of serves nothing.
  const deviceCaps = new Map<string, Set<string>>();
  const deviceHomes = new Map<string, string>();
  try {
    const rows = (await sql`
      SELECT dw.id, dw.capabilities, h.home_org_id,
             -- The personal workspace is always its owner's, member row or not
             -- (legacy rows can lack one; auto-wire never required it there).
             h.home_org_id = ${personalOrgId}::text
               OR EXISTS (
                 SELECT 1 FROM "member" m
                 WHERE m."organizationId" = h.home_org_id AND m."userId" = ${userId}
               ) AS home_member
      FROM device_workers dw
      CROSS JOIN LATERAL (
        SELECT COALESCE(dw.organization_id, ${personalOrgId}::text) AS home_org_id
      ) h
      WHERE dw.user_id = ${userId}
        AND dw.last_seen_at > now() - ${DEVICE_WORKER_FRESH_INTERVAL}::interval
    `) as unknown as Array<{
      id: string;
      capabilities: unknown;
      home_org_id: string | null;
      home_member: boolean;
    }>;
    for (const r of rows) {
      const caps = Array.isArray(r.capabilities) ? (r.capabilities as string[]) : [];
      deviceCaps.set(r.id, new Set(caps));
      if (r.home_org_id && r.home_member) deviceHomes.set(r.id, r.home_org_id);
    }
  } catch (err) {
    logger.warn(
      { userId, err: errorMessage(err) },
      '[device-connectors] Failed to read device capabilities'
    );
    return [];
  }
  if (deviceCaps.size === 0) return [];

  const homeOrgIds = new Set(deviceHomes.values());
  if (personalOrgId) homeOrgIds.add(personalOrgId);
  // organization → connector keys of this user's live auto-wired device
  // connections there, so a key no device homed there serves any more still
  // gets its unpinned feeds paused (below), even with no device left in that
  // workspace at all.
  const ownedConnectionKeys = new Map<string, Set<string>>();
  try {
    // Workspaces that still hold this user's auto-wired device connections but
    // may no longer home any of their devices (every device moved away).
    // Auto-wire creates `private` rows; a connection someone created or shared
    // as org-visible is theirs to manage and is never paused from here.
    // `connections` is a bounded config table.
    const rows = (await sql`
      SELECT DISTINCT c.organization_id, c.connector_key
      FROM connections c
      JOIN "member" m
        ON m."organizationId" = c.organization_id AND m."userId" = ${userId}
      WHERE c.created_by = ${userId}
        AND c.visibility = 'private'
        AND c.auth_profile_id IS NULL
        AND c.app_auth_profile_id IS NULL
        AND c.deleted_at IS NULL
        AND ${sql.unsafe(IS_DEVICE_CONNECTOR_SQL)}
    `) as unknown as Array<{ organization_id: string; connector_key: string }>;
    for (const r of rows) {
      homeOrgIds.add(r.organization_id);
      const keys = ownedConnectionKeys.get(r.organization_id) ?? new Set<string>();
      keys.add(r.connector_key);
      ownedConnectionKeys.set(r.organization_id, keys);
    }
  } catch (err) {
    logger.warn(
      { userId, err: errorMessage(err) },
      '[device-connectors] Failed to read device connector workspaces'
    );
  }
  if (homeOrgIds.size === 0) return [];
  const homes: DeviceHome[] = [...homeOrgIds].map((organizationId) => ({
    organizationId,
    personal: organizationId === personalOrgId,
  }));
  const pollingHomeOrgId = pollingDeviceId ? (deviceHomes.get(pollingDeviceId) ?? null) : null;

  let pollingDeviceAuthorizations: Awaited<
    ReturnType<typeof getDeviceManifestClaimAuthorizationsForDevice>
  > = [];
  let pollingManifestClaimsReadable = true;
  if (pollingDeviceId) {
    try {
      // Attest retained hashless rows before reconciliation's selected-artifact
      // check. The attestation is still bounded to this validated device's
      // exact manifest identity and its home's org-scoped artifact row.
      pollingDeviceAuthorizations = await getDeviceManifestClaimAuthorizationsForDevice({
        sql,
        userId,
        deviceId: pollingDeviceId,
      });
      if (pollingHomeOrgId) {
        await attestDeviceManifestArtifacts({
          sql,
          organizationId: pollingHomeOrgId,
          authorizations: pollingDeviceAuthorizations,
        });
      }
    } catch (err) {
      pollingManifestClaimsReadable = false;
      logger.warn(
        { userId, pollingDeviceId, err: errorMessage(err) },
        '[device-connectors] Failed to read polling device manifest claims'
      );
    }
  }

  // The user's fleet-wide winners feed only the pinned-org refresh below; each
  // home reads its own winners.
  let fleetManifestSources: DeviceConnectorSource[] = [];
  const homeManifestSources = new Map<string, DeviceConnectorSource[]>();
  // TEAM workspace → connector key → the newest version this user's own
  // devices homed there advertise. A team workspace runs ONE definition chosen
  // across every member, so a member whose devices all advertise an older
  // version can't serve it: their connection is paused with an
  // upgrade-required reason instead of being wired. Personal workspaces hold
  // only their owner's devices, so the winner is always theirs.
  const homeOwnNewestVersions = new Map<string, Map<string, string>>();
  try {
    fleetManifestSources = await getDeviceManifestSourcesForUser({ sql, userId });
    for (const home of homes) {
      homeManifestSources.set(
        home.organizationId,
        await getDeviceManifestSourcesForUser({ sql, userId, home })
      );
      if (home.personal) continue;
      const newest = new Map<string, string>();
      for (const source of await getDeviceManifestSourcesForUser({
        sql,
        userId,
        home,
        includeRetainedVersions: true,
      })) {
        if (source.advertiserDeviceIds.length === 0) continue;
        const current = newest.get(source.key);
        if (!current || compareSemverish(source.metadata.version, current) > 0) {
          newest.set(source.key, source.metadata.version);
        }
      }
      homeOwnNewestVersions.set(home.organizationId, newest);
    }
  } catch (err) {
    logger.warn(
      { userId, err: errorMessage(err) },
      '[device-connectors] Failed to read device connector manifests'
    );
    sourcesReadable = false;
  }

  if (sourcesReadable) {
    // Pin-only workspaces must not be left running a definition the fleet has
    // moved past — see the function's comment. Keyed off manifest sources: only
    // a manifest identity is what readiness compares.
    await refreshPinnedOrgDeviceConnectorDefinitions(userId, homeManifestSources, fleetManifestSources);
  }

  const reconciliationResults = (
    await Promise.all(
      homes.map(async (home) => {
        const manifestSources = homeManifestSources.get(home.organizationId) ?? [];
        const byKey = new Map<
          string,
          | (BundledDeviceConnector & { source?: undefined })
          | (DeviceConnectorSource & { source: 'device-manifest' })
        >();
        for (const dc of bundledDeviceConnectors) byKey.set(dc.key, dc);
        for (const src of manifestSources) byKey.set(src.key, { ...src, source: 'device-manifest' });

        // Runs BEFORE the empty check: a home whose devices advertise nothing
        // is precisely where every device definition has gone stale. Gated on
        // `sourcesReadable` — a transient read failure must never be read as
        // "the fleet serves nothing" and archive a working set.
        if (sourcesReadable) {
          await archiveVanishedDeviceConnectorDefinitions(userId, home, [...byKey.keys()]);
          // A key this user still holds a connection for but no device homed
          // here advertises (every serving device moved away or stopped
          // advertising it): pause its unpinned feeds so nothing keeps
          // materializing runs no device can claim. Pinned connections are left
          // alone — a pin to a device homed elsewhere is a deliberate
          // cross-workspace placement, and a Devices-page move already paused
          // the pins it broke.
          await Promise.all(
            [...(ownedConnectionKeys.get(home.organizationId) ?? [])]
              .filter((key) => !byKey.has(key))
              .map((key) =>
                pauseStaleDeviceFeeds(userId, home.organizationId, key, { unpinnedOnly: true })
              )
          );
        }
        if (byKey.size === 0) return [];

        const homeDeviceIds = [...deviceHomes.entries()]
          .filter(([, orgId]) => orgId === home.organizationId)
          .map(([id]) => id);
        return Promise.allSettled(
          [...byKey.values()].map((dc) => {
            const matchingDeviceIds =
              'source' in dc && dc.source === 'device-manifest'
                ? dc.advertiserDeviceIds
                : homeDeviceIds.filter((id) => deviceCaps.get(id)?.has(dc.requiredCapability));
            if (
              matchingDeviceIds.length === 0 &&
              'source' in dc &&
              dc.source === 'device-manifest'
            ) {
              const ownVersion = homeOwnNewestVersions.get(home.organizationId)?.get(dc.key);
              if (ownVersion && compareSemverish(ownVersion, dc.metadata.version) < 0) {
                return pauseForDeviceUpgrade(userId, home.organizationId, dc, ownVersion);
              }
            }
            return matchingDeviceIds.length > 0
              ? ensureDeviceConnectorWired(
                  userId,
                  home,
                  dc.key,
                  dc.feedKeys,
                  matchingDeviceIds,
                  'source' in dc && dc.source === 'device-manifest' ? dc : undefined,
                  pollingDeviceId
                )
              : pauseStaleDeviceFeeds(userId, home.organizationId, dc.key);
          })
        );
      })
    )
  ).flat();

  const reconciledAuthorizations = reconciliationResults.flatMap((result) =>
    result.status === 'fulfilled' && result.value ? [result.value] : []
  );
  if (!pollingDeviceId) return reconciledAuthorizations;
  if (!pollingManifestClaimsReadable || !sourcesReadable) return [];

  // If the polling device is the current winner for a manifest key in its
  // home, a failed wire/reconciliation must fail closed for that key.
  // Historical claims are allowed only for keys where this device advertises a
  // retained version and winner reconciliation belongs to another device.
  const currentWinnerKeysForPoller = new Set(
    (pollingHomeOrgId ? (homeManifestSources.get(pollingHomeOrgId) ?? []) : [])
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
