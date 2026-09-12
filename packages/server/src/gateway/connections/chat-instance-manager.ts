/**
 * ChatInstanceManager — manages Chat SDK instances for API-driven platform
 * connections. Owns Chat lifecycle and webhook dispatch.
 *
 * Persistence uses `connections` (via AgentConnectionStore) as the
 * single source of truth — one row per connection, no separate
 * `chat_connections` table. Secret fields in the row's `config` JSON are
 * stored as `secret://...` refs that route through `SecretStoreRegistry`
 * at runtime, so any pluggable backend (Postgres / AWS SM / k8s / Vault)
 * can serve the underlying value. Plaintext values handed in by callers
 * are persisted via `secretStore.put()` and replaced with their refs
 * before the row is written.
 */

import { randomUUID } from "node:crypto";
import type { AgentConnectionStore, StoredConnection } from "@lobu/core";
import { createLogger, getErrorMessage, isSecretRef } from "@lobu/core";
import { type Adapter, type AdapterPostableMessage, Chat } from "chat";
import { verifyAtlassianWebhookAuthorization } from "../../connect/atlassian-webhook-auth.js";
import { resolveConnectionWebhookConfig } from "../../connect/webhook-registration.js";
import { getDb } from "../../db/client.js";
import { orgContext, tryGetOrgId } from "../../lobu/stores/org-context.js";
import { deleteSlackInstall } from "../../lobu/stores/slack-installations.js";
import { CommandDispatcher } from "../commands/command-dispatcher.js";
import type { IFileHandler } from "../platform/file-handler.js";
import type { CoreServices, PlatformAdapter } from "../platform.js";
import {
  deleteSecretsByPrefix,
  persistSecretValue,
  resolveSecretValue,
} from "../secrets/index.js";
import { resolveAgentOptions } from "../services/platform-helpers.js";
import { resolveChatUserIdentity } from "../../lobu/stores/chat-identity.js";
import { ChatIdentityInstructionProvider } from "./chat-identity-instruction-provider.js";
import { configsEqual } from "./config-equal.js";
import { ConversationStateStore } from "./conversation-state-store.js";
import { registerInteractionBridge } from "./interaction-bridge.js";
import {
  type MessageHandlerBridge,
  registerMessageHandlers,
} from "./message-handler-bridge.js";
import { getPlatformDescriptor, PLATFORM_REGISTRY } from "./platforms/index.js";
import {
  disableSdkMessageHistory,
  resolveChatTarget,
} from "./platforms/shared.js";
import { SlackConnectionCoordinator } from "./slack-connection-coordinator.js";
import {
  registerSlackAppHome,
  registerSlackPlatformHandlers,
  type SlackHomeContext,
  type SlackHomeInbox,
} from "./slack-platform-bridge.js";
import { createConnectedGatewayStateAdapter } from "./state-adapter.js";
import {
  type ConnectionSettings,
  isSecretField,
  type PlatformAdapterConfig,
  type PlatformConnection,
} from "./types.js";
import { deliverGithubConnectorConnectionWebhook } from "../routes/public/app-webhooks.js";
import { deliverJiraMcpConnectionWebhook } from "../routes/public/jira-mcp-webhook-delivery.js";
import { isAtlassianMcpConfig } from "../../operations/atlassian-mcp-feed.js";
import {
	handleWebhookIngest,
	prepareWebhookIngestConfig,
} from "./webhook-ingest.js";

const logger = createLogger("chat-instance-manager");

/**
 * Org-scoped counts + slug + recent feed for the Slack App Home dashboard
 * card. Runs the counts and recent queries in parallel. All counts are
 * organization-wide because `events` carries no per-agent or per-user
 * attribution. Returns null on any failure so the home tab degrades to a
 * slug-less dashboard link rather than failing to render.
 */
/** How many recent events the home tab's "Recent activity" list shows. */
const SLACK_HOME_RECENT_LIMIT = 5;

/** Collapse whitespace and clamp to a bounded length for a one-line Slack row. */
function clampRecentText(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

/**
 * Title an event for the recent list: its title, else a payload snippet. Both
 * paths are clamped so an unbounded title can't blow past Slack's section text
 * limit and force the home view into its minimal fallback.
 */
function recentDisplayTitle(
  title: string | null,
  payloadText: string | null,
): string {
  const t = title?.trim();
  if (t) return clampRecentText(t);
  const snippet = payloadText?.trim();
  if (snippet) return clampRecentText(snippet);
  return "(untitled)";
}

/** Exported for workspace-audit visibility tests (Slack Home has no member role). */
export async function resolveSlackHomeContext(
  organizationId: string,
): Promise<SlackHomeContext | null> {
  try {
    const db = getDb();
    const [countRows, recentRows] = await Promise.all([
      db`
        SELECT
          (SELECT slug FROM organization WHERE id = ${organizationId}) AS org_slug,
          (SELECT count(*) FROM entities
             WHERE organization_id = ${organizationId} AND deleted_at IS NULL)
            AS entities_tracked,
          (SELECT count(*) FROM events
             WHERE organization_id = ${organizationId}
               AND created_at >= date_trunc('day', now())
               -- Owner/admin-only workspace-identity audit rows (member /
               -- invitation lifecycle). Slack App Home is shown to any
               -- workspace-linked Slack user, so never count them here.
               AND NOT (metadata ? '_lobu_workspace_audit'))
            AS captured_today
      `,
      // Mirrors the web "recent" feed (resolve_path.ts fetchRecentContent):
      // supersession-masked, internal corrections excluded, newest first.
      // Also excludes server-owned workspace audit rows — same boundary as
      // ordinary-member resolve_path bootstrap (not owner/admin).
      db`
        SELECT
          ev.title,
          ev.payload_text,
          COALESCE(ev.connector_key, cn.connector_key) AS platform,
          extract(epoch FROM COALESCE(ev.occurred_at, ev.created_at))::bigint AS ts
        FROM current_event_records ev
        LEFT JOIN connections cn ON cn.id = ev.connection_id
        WHERE ev.organization_id = ${organizationId}
          AND ev.semantic_type <> 'correction'
          AND NOT (ev.metadata ? '_lobu_workspace_audit')
        ORDER BY COALESCE(ev.occurred_at, ev.created_at) DESC
        LIMIT ${SLACK_HOME_RECENT_LIMIT}
      `,
    ]);
    const row = countRows[0] as
      | {
          org_slug: string | null;
          entities_tracked: number | string;
          captured_today: number | string;
        }
      | undefined;
    if (!row) return null;
    const recent = (
      recentRows as {
        title: string | null;
        payload_text: string | null;
        platform: string | null;
        ts: number | string | null;
      }[]
    ).map((r) => ({
      title: recentDisplayTitle(r.title, r.payload_text),
      platform: r.platform,
      ts: Number(r.ts) || 0,
    }));
    return {
      orgSlug: row.org_slug,
      entitiesTracked: Number(row.entities_tracked) || 0,
      capturedToday: Number(row.captured_today) || 0,
      recent,
    };
  } catch (error) {
    logger.warn(
      { error, organizationId },
      "Failed to load Slack home dashboard context",
    );
    return null;
  }
}

/** Newest notifications shown on the Slack App Home tab. */
const SLACK_HOME_NOTIFICATION_LIMIT = 5;

/**
 * The viewing Slack user's personal notification inbox for the App Home tab.
 *
 * `app_home_opened` carries no team_id, so the team_id must come from the
 * connection's own metadata (the caller skips this entirely for a connection
 * without one — identity is always workspace-scoped now). Scoping by team_id
 * prevents a platform_user_id collision across workspaces from leaking one
 * workspace user's inbox onto another. Returns null when the user has no
 * linked identity — the home tab then shows the setup prompt instead.
 * Notifications are the user's own, so they span all their orgs; `resource_url`
 * already carries each item's org slug for the deep link.
 */
export async function resolveSlackHomeUserInbox(
  slackUserId: string,
  teamId: string,
): Promise<SlackHomeInbox | null> {
  try {
    const db = getDb();
    const lobuUserId = await resolveChatUserIdentity(
      "slack",
      teamId,
      slackUserId,
    );
    if (!lobuUserId) return null;

    const [itemRows, unreadRows, orgRows] = await Promise.all([
      db`
        SELECT
          e.title,
          e.metadata->>'resource_url' AS resource_url,
          (t.read_at IS NOT NULL) AS is_read
        FROM notification_targets t
        JOIN events e ON e.id = t.event_id
        WHERE t.user_id = ${lobuUserId}
        ORDER BY e.id DESC
        LIMIT ${SLACK_HOME_NOTIFICATION_LIMIT}
      `,
      db`
        SELECT count(*)::int AS c
        FROM notification_targets
        WHERE user_id = ${lobuUserId} AND read_at IS NULL
      `,
      // The user's primary org slug, for the setup deep link to /{slug} (home).
      db`
        SELECT o.slug
        FROM member m
        JOIN organization o ON o.id = m."organizationId"
        WHERE m."userId" = ${lobuUserId}
        ORDER BY m."createdAt" ASC
        LIMIT 1
      `,
    ]);
    const items = (
      itemRows as {
        title: string | null;
        resource_url: string | null;
        is_read: boolean;
      }[]
    ).map((r) => ({
      title: r.title?.trim() || "(untitled)",
      url: r.resource_url,
      isRead: Boolean(r.is_read),
    }));
    const unreadCount =
      Number((unreadRows as { c: number | string }[])[0]?.c) || 0;
    const orgSlug = (orgRows as { slug: string }[])[0]?.slug ?? null;
    return { unreadCount, items, orgSlug };
  } catch (error) {
    logger.warn(
      { error, slackUserId },
      "Failed to load Slack home notifications",
    );
    return null;
  }
}

/**
 * Exclusive-transport lease cadence. Each replica ticks every
 * `EXCLUSIVE_TICK_MS`; a tick renews the heartbeats of held claims, so a
 * claim whose heartbeat is older than `CLAIM_TTL_SECONDS` (3 missed ticks)
 * belongs to a dead pod and is reclaimable by any replica.
 */
const EXCLUSIVE_TICK_MS = 15_000;
const CLAIM_TTL_SECONDS = 45;

/**
 * Bounded exponential backoff for a failed exclusive start. A transient
 * failure must be retried automatically (instead of latching DEAD until a
 * human edits the row), but the retry must NOT flap: the backoff starts at one
 * tick and doubles, capped so a genuinely-broken connection costs at most one
 * short start attempt per `EXCLUSIVE_FAILURE_MAX_BACKOFF_MS` window.
 */
const EXCLUSIVE_FAILURE_BASE_BACKOFF_MS = EXCLUSIVE_TICK_MS;
const EXCLUSIVE_FAILURE_MAX_BACKOFF_MS = 10 * 60_000;

/**
 * Platforms that are valid to declare on an agent but have no chat adapter to
 * run. `rest` is the HTTP Agent API (`POST /lobu/api/v1/agents/:id/messages`),
 * which is registered unconditionally in gateway/routes/public/agent.ts —
 * declaring it just persists the `connections` row so `lobu apply`
 * converges; there is no instance to start/stop/restart and no webhook to
 * route. `webhook` is the inbound push-source primitive (#1235): deliveries
 * are handled per-request by `handleIngestWebhook` below, which reads the
 * row + secret directly — no warm instance, no per-pod state. Deliberately
 * NOT in the platform descriptor registry: createPlatformAdapters() derives
 * the PlatformRegistry entries from it, and an adapterless platform must not
 * get a registry entry either. Stateless by construction, so it is
 * multi-replica safe — hydration and the health sweep skip it rather than
 * retrying a doomed adapter start.
 */
const ADAPTERLESS_PLATFORMS = new Set<string>(["rest", "webhook"]);

export function isAdapterlessPlatform(platform: string): boolean {
  return ADAPTERLESS_PLATFORMS.has(platform);
}

interface ManagedInstance {
  connection: PlatformConnection;
  chat: any; // Chat SDK instance
  conversationState: ConversationStateStore;
  /**
   * Shared bridge exposing the inbound-enqueue pipeline. Kept on the instance
   * so the interaction bridge can feed button-clicks through the same
   * appendHistory + enqueueMessage path as typed messages.
   */
  messageBridge: MessageHandlerBridge;
  /**
   * `connections.updated_at` of the row this instance was hydrated
   * from. A pod-local instance is a pure memo of the row: when the stored
   * row is newer (config edited on any replica), the next use re-hydrates,
   * so replicas converge without cross-pod restart fan-out.
   */
  rowVersion: number;
  cleanup?: () => Promise<void>;
  interactionCleanup?: () => void;
}

export class ChatInstanceManager {
  private instances = new Map<string, ManagedInstance>();
  private services!: CoreServices;
  private publicGatewayUrl = "";
  private slackCoordinator!: SlackConnectionCoordinator;
  private connectionStore!: AgentConnectionStore;
  /** Identity for `connection_claims.claimed_by` — unique per process. */
  private podId = randomUUID();
  private exclusiveTimer: ReturnType<typeof setInterval> | undefined;
  /** Exclusive connections this replica currently holds the lease for. */
  private exclusiveOwned = new Set<string>();
  /**
   * Backoff bookkeeping for a failed exclusive start, keyed by connection id.
   * `rowVersion` is the post-failure `updated_at` so a row edit resets the
   * backoff; `attempts` drives exponential backoff; `nextRetryAt` is the
   * epoch-ms gate so a TRANSIENT failure (Telegram 5xx, DB blip, secret
   * hiccup) is retried automatically instead of latching DEAD forever, while
   * a genuinely-bad config still only burns one short tick per backoff window.
   * Pod-local on purpose: this replica holds the lease, so its retry cadence
   * is a purely local decision (see the N>1 reasoning in the PR body).
   */
  private exclusiveFailures = new Map<
    string,
    { rowVersion: number; attempts: number; nextRetryAt: number }
  >();
  private exclusiveTickInFlight = false;

  /**
   * Public gateway base URL (`PUBLIC_GATEWAY_URL` or derived) — exposed so the
   * response bridge can build links into the admin UI (e.g. the
   * provider-settings page) for user-facing error messages.
   */
  getPublicGatewayUrl(): string {
    return this.publicGatewayUrl;
  }

  /**
   * Lazy-first initialization: NO eager warm-start. A connection is a row,
   * not a process — webhook-transport connections are hydrated on demand by
   * `ensureConnectionRunning()` (inbound webhook, notification fan-out,
   * platform routing, file uploads), keyed by the row's `updated_at` so
   * config edits on any replica converge here on next use. Status health is
   * owned by the periodic single-claimant `connection-health` task (see
   * `sweepConnectionHealth`), not by boot side-effects racing across pods.
   *
   * The only connections that need a process identity are *exclusive*
   * transports (Telegram long-polling), which the claim runner below starts
   * on exactly one replica via the `connection_claims` lease.
   */
  async initialize(services: CoreServices): Promise<void> {
    this.services = services;
    this.publicGatewayUrl = services.getPublicGatewayUrl();
    this.slackCoordinator = this.buildSlackCoordinator();

    const store = services.getConnectionStore();
    if (!store) {
      logger.warn("No AgentConnectionStore — chat connections disabled");
      return;
    }
    this.connectionStore = store;
    this.startExclusiveRunner();
  }

  async shutdown(): Promise<void> {
    logger.info(
      { count: this.instances.size },
			"Shutting down all connections",
    );
    if (this.exclusiveTimer) {
      clearInterval(this.exclusiveTimer);
      this.exclusiveTimer = undefined;
    }
    // Release exclusive leases eagerly so a peer replica can claim within one
    // tick instead of waiting out the TTL. Best-effort: pod death skips this
    // and the TTL covers it.
    if (this.exclusiveOwned.size > 0) {
      try {
        await getDb()`
          DELETE FROM connection_claims WHERE claimed_by = ${this.podId}
        `;
      } catch (error) {
        logger.warn(
          { error: String(error) },
					"Failed to release exclusive connection claims on shutdown",
        );
      }
      this.exclusiveOwned.clear();
    }
    const shutdownPromises = Array.from(this.instances.values()).map(
      async (instance) => {
        try {
          instance.interactionCleanup?.();
          await instance.cleanup?.();
        } catch (error) {
          logger.error(
            { id: instance.connection.id, error: String(error) },
						"Error shutting down connection",
          );
        }
			},
    );
    await Promise.allSettled(shutdownPromises);
    this.instances.clear();
  }

  async addConnection(
    platform: string,
    agentId: string | undefined,
    config: PlatformAdapterConfig,
    settings?: ConnectionSettings,
    metadata: Record<string, any> = {},
		stableId?: string,
  ): Promise<PlatformConnection> {
    const descriptor = getPlatformDescriptor(platform);
    if (!descriptor && !isAdapterlessPlatform(platform)) {
      throw new Error(`Unsupported platform: ${platform}`);
    }
    if (config.platform !== platform) {
      throw new Error(
				`Config platform mismatch: expected ${platform}, got ${config.platform}`,
      );
    }

    // Platform-specific config refusal (e.g. Telegram rejects explicit
    // polling mode in Lobu Cloud — see the telegram descriptor for why).
    // Adapterless platforms have no descriptor and no config to vet.
    const rejection = descriptor?.getConfigRejection?.(config);
    if (rejection) {
      throw new Error(rejection);
    }

    // Let the platform prime a brand-new config before it is persisted —
    // e.g. Telegram auto-generates a strong webhook `secretToken` when the
    // caller didn't supply one, so its inbound webhook is never forgeable.
    descriptor?.prepareNewConnectionConfig?.(config);

    // Webhook ingest connections are adapterless (no descriptor) but still
    // need the same never-unauthenticated guarantee: auto-generate the
    // bearer token when the caller didn't supply one.
    if (platform === "webhook") {
      prepareWebhookIngestConfig(config as Record<string, unknown>);
    }

    const id = stableId ?? randomUUID().replace(/-/g, "").slice(0, 16);
    const now = Date.now();
    const organizationId = tryGetOrgId() ?? undefined;

    const connection: PlatformConnection = {
      id,
      platform,
      ...(agentId ? { agentId } : {}),
      ...(organizationId ? { organizationId } : {}),
      config,
      settings: settings ?? { allowGroups: true },
      metadata,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    // Persist first (sensitive fields are moved into the secret store as
    // refs) so a start failure can't leave a running instance with no row,
    // and a persist failure can't leave a half-baked entry. The instance is
    // then hydrated from the persisted row — the same path every replica
    // uses — so the memo key matches the row from the first start.
    await this.persistConnection(connection);

    const stored = await this.connectionStore.getConnection(id);
    if (!stored) {
      throw new Error(`Connection ${id} did not persist`);
    }

    if (isAdapterlessPlatform(platform)) {
      logger.info({ id, platform, agentId }, "Connection added");
      return connection;
    }

    if (this.isExclusiveStored(stored)) {
      // Exclusive transports start under the connection_claims lease — kick
      // a tick now so a single-replica/dev setup gets its polling loop
      // immediately. Runtime startup errors surface as status=error within
      // a tick rather than failing the create: the lease owner may be a
      // different replica, so synchronous start feedback is impossible here.
      void this.exclusiveTick().catch((error) => {
        logger.warn(
          { id, error: String(error) },
					"Exclusive tick after connection create failed",
        );
      });
      logger.info({ id, platform, agentId }, "Connection added (lease-owned)");
      return connection;
    }

    try {
      await this.hydrateFromRow(stored);
    } catch (error) {
      // Roll back in the safe order: secrets first, then the row that
      // anchors them. If secret cleanup throws, the row stays so an
      // operator can retry deletion via the same code path; the
      // alternative (delete row first) leaves orphaned secrets with no
      // anchor for retry.
      try {
        await deleteSecretsByPrefix(
          this.services.getSecretStore(),
					`connections/${connection.id}/`,
        );
      } catch {
        // best-effort
      }
      try {
        await this.connectionStore.deleteConnection(connection.id);
      } catch {
        // best-effort
      }
      throw error;
    }

    logger.info({ id, platform, agentId }, "Connection added");
    return connection;
  }

  async removeConnection(
    id: string,
    opts?: { skipTombstone?: boolean },
  ): Promise<void> {
    const instance = await this.stopInstance(id);

    const conversationState =
      instance?.conversationState ??
      new ConversationStateStore(await this.createStateAdapter());

    // Cascade cleanups first, then drop the row last so a cleanup failure
    // leaves the row in place for an operator-driven retry rather than
    // orphaning history/secrets with no anchoring connection record.
    const historyDeleted = await conversationState.clearAllHistory(id);
    const secretsDeleted = await deleteSecretsByPrefix(
      this.services.getSecretStore(),
			`connections/${id}/`,
    );
    // The delete path passes skipTombstone so the unified `connections` row is
    // NOT hidden here: the tombstone must commit atomically with the pending
    // run/card expiry in `handleDelete`, never in a separate earlier commit.
    if (!opts?.skipTombstone) {
      await this.connectionStore.deleteConnection(id);
    }

    // Drop any lease row for this connection. `connection_claims` has no FK
    // cascade onto connections, so without this an exclusive connection's
    // claim leaks if the owner pod crashes before its next tick. Delete by
    // connection_id only (NOT podId-scoped): removeConnection can run on a
    // non-owner replica, which must still be able to clear the dead owner's row.
    await this.deleteClaimForConnection(id);

    logger.info({ id, historyDeleted, secretsDeleted }, "Connection removed");
  }

  /**
   * Revoke a MANAGED connection (a Lobu-hosted OAuth install, e.g. an "Add to
   * Slack" workspace). Unlike `removeConnection` (which drops a BYO
   * `connections` chat row), a managed install originates in `app_installations`
   * with its bot token in the secret store — so revoke purges the install + its
   * token via the provider store, then soft-deletes the unified `connections`
   * projection so it disappears from the UI. The connection id from the UI is
   * the `connections` bigint id; its `slug` is the provider external id
   * (`slackinst-…`) the install store keys on.
   */
  async revokeManagedConnection(
		connectionId: number,
    opts?: { skipTombstone?: boolean },
  ): Promise<{ revoked: true }> {
    const sql = getDb();
    const rows = await sql`
      SELECT organization_id, slug, connector_key, credential_mode
      FROM connections
      WHERE id = ${connectionId} AND deleted_at IS NULL
      LIMIT 1
    `;
    if (rows.length === 0) throw new Error("Connection not found");
    const row = rows[0] as {
      organization_id: string;
      slug: string;
      connector_key: string;
      credential_mode: string | null;
    };
    if (row.credential_mode !== "managed") {
      throw new Error("Only managed installs can be revoked");
    }

    if (row.connector_key === "slack") {
      await deleteSlackInstall(
        this.services.getAppInstallationStore(),
        this.services.getSecretStore(),
				row.slug,
        { skipConnectionTombstone: opts?.skipTombstone },
      );
    } else {
      throw new Error(
				`Revoke not supported for connector "${row.connector_key}"`,
      );
    }

    // Soft-delete the unified projection so the UI stops listing it. Past
    // events stay (append-only); only the connection record is tombstoned.
    // The delete path passes skipTombstone so the row stays VISIBLE here: the
    // tombstone must commit atomically with the pending run/card expiry in
    // `handleDelete`, never in a separate earlier commit.
    if (!opts?.skipTombstone) {
      await sql`
        UPDATE connections SET deleted_at = now(), updated_at = now()
        WHERE id = ${connectionId} AND organization_id = ${row.organization_id}
      `;
    }
    logger.info(
      { connectionId, connectorKey: row.connector_key },
			"Revoked managed connection",
    );
    return { revoked: true };
  }

  async restartConnection(id: string): Promise<void> {
    await this.stopInstance(id);

    let stored = await this.connectionStore.getConnection(id);
    if (!stored) throw new Error(`Connection ${id} not found`);

    // Restart is the explicit "make it run" operation: it un-stops stopped
    // rows and clears error state, regardless of how the row got there.
    if (stored.status !== "active" || stored.errorMessage) {
      await this.writeConnectionStatus(stored, "active", undefined);
      stored = (await this.connectionStore.getConnection(id)) ?? stored;
    }

    if (isAdapterlessPlatform(stored.platform)) return;

    // Exclusive transports are lease-owned: the status reset above makes the
    // claim runner (here or on the owning replica) retry on its next tick,
    // but a request path never starts the polling loop itself.
    if (this.isExclusiveStored(stored)) {
      this.exclusiveFailures.delete(id);
      return;
    }

    try {
      await this.hydrateFromRow(stored);
    } catch (error) {
      await this.writeConnectionStatus(
        stored,
        "error",
				`Startup failed: ${getErrorMessage(error)}`,
      );
      throw error;
    }

    logger.info({ id }, "Connection restarted");
  }

  async stopConnection(id: string): Promise<void> {
    await this.stopInstance(id);

    // updateConnection() routes through saveConnection() which requires
    // getOrgId(); bind the connection's owning org so the stop write succeeds
    // even when reached without an HTTP request's ALS org context.
    const stored = await this.connectionStore.getConnection(id);
    const markStopped = () =>
      this.connectionStore.updateConnection(id, {
        status: "stopped",
      });
    const orgId = stored?.organizationId;
    if (orgId) {
      await orgContext.run({ organizationId: orgId }, markStopped);
    } else {
      await markStopped();
    }

    logger.info({ id }, "Connection stopped");
  }

  async updateConnection(
    id: string,
    updates: {
      agentId?: string | null;
      config?: PlatformAdapterConfig;
      settings?: ConnectionSettings;
      metadata?: Record<string, any>;
		},
  ): Promise<PlatformConnection> {
    const stored = await this.connectionStore.getConnection(id);
    if (!stored) throw new Error(`Connection ${id} not found`);
    const connection = storedToPlatform(stored);

    // Compute the merged config (skipping sanitized `***...` placeholders),
    // then decide whether a restart is needed.
    const previousConfig = connection.config as Record<string, unknown>;
    let nextConfig: Record<string, unknown> | undefined;
    if (updates.config !== undefined) {
      const merged = { ...previousConfig };
      for (const [key, value] of Object.entries(updates.config)) {
        if (typeof value === "string" && value.startsWith("***")) continue;
        merged[key] = value;
      }
      merged.platform = updates.config.platform;
      nextConfig = merged;
    }

    // Refuse a merged config the platform rejects (e.g. flipping a Telegram
    // connection to polling mode under LOBU_CLOUD_MODE) BEFORE persisting —
    // otherwise the refused config would be saved `active` and only the next
    // lease tick / hydrate would error it, mirroring addConnection's
    // create-time rejection.
    if (nextConfig !== undefined) {
      const rejection = getPlatformDescriptor(
				connection.platform,
      )?.getConfigRejection?.(nextConfig as PlatformAdapterConfig);
      if (rejection) {
        throw new Error(rejection);
      }
    }

    // previousConfig holds `secret://` refs; nextConfig from the caller
    // holds plaintext values. Resolve previous to plaintext before
    // comparing so an idempotent re-apply with the same bot token
    // doesn't trip a spurious restart.
    const previousResolved =
      nextConfig !== undefined
        ? ((await this.resolveConfigForRuntime(
            id,
						previousConfig as PlatformAdapterConfig,
          )) as Record<string, unknown>)
        : previousConfig;

    const needsRestart =
      nextConfig !== undefined && !configsEqual(nextConfig, previousResolved);

    if (updates.agentId !== undefined) {
      if (updates.agentId) {
        connection.agentId = updates.agentId;
      } else {
        delete connection.agentId;
      }
    }
    if (nextConfig !== undefined) {
      connection.config = nextConfig as PlatformAdapterConfig;
    }
    if (updates.settings !== undefined) {
      connection.settings = { ...connection.settings, ...updates.settings };
    }
    if (updates.metadata !== undefined) {
      connection.metadata = {
        ...(connection.metadata || {}),
        ...updates.metadata,
      };
    }
    connection.updatedAt = Date.now();

    // Persist FIRST, then (re)start from the persisted row: the row is the
    // source of truth and its post-write `updated_at` is the memo key every
    // replica converges on. Starting before persisting would stamp the
    // instance with a pre-write version and force a spurious re-hydrate on
    // the next inbound request.
    await this.persistConnection(connection);
    const reread = await this.connectionStore.getConnection(id);
    if (!reread) throw new Error(`Connection ${id} disappeared during update`);

    if (
      needsRestart &&
      connection.status === "active" &&
      !isAdapterlessPlatform(connection.platform)
    ) {
      if (this.isExclusiveStored(reread)) {
        // Lease-owned: drop any local loop; the claim owner re-hydrates on
        // its next tick via the rowVersion mismatch.
        await this.stopInstance(id);
        this.exclusiveFailures.delete(id);
      } else {
        // Eager restart on the serving pod for immediate config validation;
        // other replicas converge lazily via the rowVersion memo. On failure
        // mark the row errored before rethrowing — the new config is already
        // persisted, and leaving it `active` would misreport a connection
        // that provably cannot start.
        try {
          await this.hydrateFromRow(reread);
        } catch (error) {
          await this.writeConnectionStatus(
            reread,
            "error",
						`Startup failed: ${getErrorMessage(error)}`,
          );
          throw error;
        }
      }
    } else {
      const instance = this.instances.get(id);
      if (instance) {
        // Mutate the EXISTING connection object in place: message handlers
        // captured this object at start time, so replacing the reference would
        // hide the change from them until an unrelated restart. And never copy
        // `config` here (no blanket Object.assign): this branch means config
        // didn't meaningfully change, and the warm instance's config holds
        // PLAINTEXT credentials resolved at startup while the store row holds
        // `secret://` refs — clobbering it would make the live adapter read
        // `secret://…` as the bot token. Only agentId / settings / metadata
        // propagate.
        const warm = instance.connection;
        if (updates.agentId !== undefined) {
          if (updates.agentId) {
            warm.agentId = updates.agentId;
          } else {
            delete warm.agentId;
          }
        }
        if (updates.settings !== undefined) {
          warm.settings = { ...warm.settings, ...updates.settings };
        }
        if (updates.metadata !== undefined) {
          warm.metadata = { ...(warm.metadata || {}), ...updates.metadata };
        }
        warm.updatedAt = connection.updatedAt;
        instance.rowVersion = reread.updatedAt;
      }
    }

    return this.sanitizeConnection(connection);
  }

  async listConnections(filter?: {
    platform?: string;
    agentId?: string;
  }): Promise<PlatformConnection[]> {
    const all = await this.connectionStore.listConnections(filter);
    return all.map((c) => this.sanitizeConnection(storedToPlatform(c)));
  }

  async getConnection(id: string): Promise<PlatformConnection | null> {
    const conn = await this.connectionStore.getConnection(id);
    return conn ? this.sanitizeConnection(storedToPlatform(conn)) : null;
  }

	/** Secret-aware idempotency check for declarative connection upserts. The
	 * stored config contains secret refs, so callers cannot compare it safely
	 * themselves without either leaking or spuriously rotating credentials. */
	async connectionMatches(
		id: string,
		config: PlatformAdapterConfig,
		settings: ConnectionSettings,
		agentId?: string,
	): Promise<boolean> {
		const stored = await this.connectionStore.getConnection(id);
		if (!stored) return false;
		const connection = storedToPlatform(stored);
		const resolved = await this.resolveConfigForRuntime(id, connection.config);
		// Server-stamped keys (e.g. Telegram's auto-generated secretToken) exist
		// only on the stored side; ignore them unless the declaration sets one.
		const comparable: Record<string, unknown> = { ...resolved };
		const stamped =
			getPlatformDescriptor(connection.platform)?.serverStampedConfigKeys ?? [];
		for (const key of stamped) {
			if (!(key in config)) delete comparable[key];
		}
		// `configsEqual` only reads keys; widen the typed union/interface args to
		// the plain record shape it compares over.
		return (
			configsEqual(comparable, config as Record<string, unknown>) &&
			configsEqual(
				(connection.settings ?? {}) as Record<string, unknown>,
				settings as Record<string, unknown>,
			) &&
			(connection.agentId ?? undefined) === (agentId ?? undefined)
		);
	}

	/** Resolve stored secret refs for server-side credential validation. */
	async resolveConnectionConfig(
		id: string,
		config: PlatformAdapterConfig,
	): Promise<PlatformAdapterConfig> {
		return this.resolveConfigForRuntime(id, config);
	}

  has(id: string): boolean {
    return this.instances.has(id);
  }

  getInstance(id: string): ManagedInstance | undefined {
    return this.instances.get(id);
  }

  /**
   * Post a message to a channel as the bot — a one-shot outbound post, NOT an
   * inbound message that triggers an agent run (that's `routePlatformMessage`).
   * Used by the notification delivery task (`deliverNotificationTask`) to
   * surface an automation digest / approval in a bound channel.
   *
   * `content` is any `chat` `AdapterPostableMessage` — `{ markdown }` (rendered
   * to each platform's native format rather than HTML-escaped), `{ card }` (a
   * `CardElement` → Block Kit / Adaptive Cards / Google Chat Cards), or plain
   * text. All ride the same Chat SDK primitives, so one call works across every
   * connected platform.
   *
   * `channelKey` is the platform-prefixed channel id, e.g. "slack:C0123ABCD".
   * Multi-replica: a connection created or restarted on another replica has no
   * live instance on this pod, so we lazily start it from the store first
   * (`ensureConnectionRunning` is a no-op when it's already running and won't
   * revive a `stopped` connection). That lets any pod that fires the
   * notification deliver it — no cross-pod routing needed.
   */
  async postMessageToChannel(
    connectionId: string,
    channelKey: string,
		content: AdapterPostableMessage,
  ): Promise<{ messageId: string; threadId: string }> {
    // Channel-level post is a thread-less postToConversation; the colon splits
    // `${platform}:${channelId}`. One post path, no duplicated resolution.
    const sep = channelKey.indexOf(":");
    const platform = sep > 0 ? channelKey.slice(0, sep) : channelKey;
    const channelId = sep > 0 ? channelKey.slice(sep + 1) : channelKey;
    return await this.postToConversation(connectionId, {
      platform,
      channelKey,
      channelId,
      content,
    });
  }

  /**
   * Open (or reuse) the bot's DM with a platform user and post there — the
   * owner-routed approval tier. The chat SDK's `openDM` performs the
   * platform-side conversation open (Slack `conversations.open`) with the
   * instance's own credentials, so no token plumbing is needed here. Same
   * multi-replica lazy-hydration guarantee as `postMessageToChannel`.
   */
  async postDirectMessage(
    connectionId: string,
    platformUserId: string,
    content: AdapterPostableMessage,
  ): Promise<{ messageId: string; threadId: string }> {
    const running = await this.ensureConnectionRunning(connectionId);
    const instance = running ? this.instances.get(connectionId) : undefined;
    if (!instance) {
      throw new Error(
        `No active chat instance for connection ${connectionId} (could not start it on this pod)`,
      );
    }
    const thread = await instance.chat.openDM(platformUserId);
    const sent = (await thread.post(content)) as {
      id?: unknown;
      threadId?: unknown;
    };
    return {
      messageId: typeof sent?.id === "string" ? sent.id : "",
      threadId: typeof sent?.threadId === "string" ? sent.threadId : "",
    };
  }

  /**
   * Post to a channel — or a thread within it — and return the platform message
   * id + thread id, so the conversations `send` tool can hand the agent a thread
   * handle to reply into later. `threadId` (a platform thread id like
   * `slack:{channel}:{ts}`) routes the reply into that thread; if the thread
   * can't be resolved (e.g. a non-forum Telegram chat) resolveChatTarget falls
   * back to a channel-level post, so the reply lands at channel level rather
   * than in-thread instead of failing. Multi-replica safe: hydrates the
   * connection on this pod from its row.
   */
  async postToConversation(
    connectionId: string,
    opts: {
      platform: string;
      channelKey: string;
      channelId: string;
      threadId?: string;
      content: AdapterPostableMessage;
      /**
       * Subscribe to the thread this message opens/continues, so the bot
       * RECEIVES (and captures) replies to it. Without this, a thread the bot
       * opens proactively (e.g. an automation's lunch thread) is invisible to it —
       * Slack only delivers thread replies for subscribed threads. Used by
       * send_message; a one-off notify does NOT subscribe.
       */
      subscribe?: boolean;
		},
  ): Promise<{ messageId: string; threadId: string }> {
    const running = await this.ensureConnectionRunning(connectionId);
    const instance = running ? this.instances.get(connectionId) : undefined;
    if (!instance) {
      throw new Error(
				`No active chat instance for connection ${connectionId} (could not start it on this pod)`,
      );
    }
    const target = await resolveChatTarget(instance.chat, opts.platform, {
      channelId: opts.channelId,
      conversationId: opts.threadId,
      responseThreadId: opts.threadId,
    });
    if (!target) {
      throw new Error(
				`Could not resolve target ${opts.channelKey}${opts.threadId ? ` (thread ${opts.threadId})` : ""} for connection ${connectionId}`,
      );
    }
    let sent: { id?: unknown; threadId?: unknown };
    try {
      sent = (await target.post(opts.content)) as {
        id?: unknown;
        threadId?: unknown;
      };
    } catch (err) {
      // A thread the platform can't honor (e.g. replying into a Telegram DM,
      // which has no message threads) must not fail the whole send — fall back
      // to a channel-level post so the message still lands. Only retry when we
      // actually targeted a thread; a plain channel-post failure is real.
      if (!opts.threadId) throw err;
      logger.debug(
        { connectionId, threadId: opts.threadId, err: String(err) },
				"threaded post failed; retrying at channel level",
      );
			const channelTarget = await resolveChatTarget(
				instance.chat,
				opts.platform,
				{
        channelId: opts.channelId,
				},
			);
      if (!channelTarget) throw err;
      sent = (await channelTarget.post(opts.content)) as {
        id?: unknown;
        threadId?: unknown;
      };
    }
    const messageId = typeof sent?.id === "string" ? sent.id : "";

    // Auto-subscribe so replies to this message flow back to the bot (and get
    // captured into the transcript). Best-effort: a subscribe failure never
    // fails the post. Reply to an existing thread → that thread; top-level post
    // → the thread rooted at the new message.
    if (opts.subscribe) {
      // Telegram's message id is `${chatId}:${n}`; strip the redundant channel
      // prefix so the synthesized thread id is a clean `platform:channel:ref`.
      const rootRef =
        messageId && messageId.startsWith(`${opts.channelId}:`)
          ? messageId.slice(opts.channelId.length + 1)
          : messageId;
      const subThreadId =
        opts.threadId ??
				(rootRef ? `${opts.platform}:${opts.channelId}:${rootRef}` : undefined);
      // subscribe() lives on the Chat SDK Thread, NOT on Chat — resolve the
      // thread first (same as the inbound mention/dm path) and subscribe on it.
      // A channel-level target (e.g. a threadless Telegram DM) has no
      // subscribe(), so the guard makes it a no-op there.
      if (subThreadId) {
        try {
					const thread = (await resolveChatTarget(
						instance.chat,
						opts.platform,
						{
            channelId: opts.channelId,
            conversationId: subThreadId,
            responseThreadId: subThreadId,
						},
					)) as { subscribe?: () => Promise<void> } | null;
          if (thread && typeof thread.subscribe === "function") {
            await thread.subscribe();
          }
        } catch (err) {
          logger.debug(
            { connectionId, subThreadId, err: String(err) },
						"thread auto-subscribe failed (non-fatal)",
          );
        }
      }
    }

    return {
      messageId,
      threadId: typeof sent?.threadId === "string" ? sent.threadId : "",
    };
  }

  /**
   * Resolve the running instance for a connection or throw. Shared by the
   * message-mutation helpers below (react/edit/delete), which all address a
   * message by its (threadId, messageId) and go straight to the adapter — the
   * SDK's channel/thread abstraction is post-oriented, but the adapter exposes
   * message-scoped `addReaction`/`editMessage`/`deleteMessage` directly.
   */
  private requireRunningInstance(connectionId: string): ManagedInstance {
    const instance = this.instances.get(connectionId);
    if (!instance) {
      throw new Error(
				`No active chat instance for connection ${connectionId} (could not start it on this pod)`,
      );
    }
    return instance;
  }

  private requireRunningAdapter(connectionId: string): Adapter {
    const instance = this.requireRunningInstance(connectionId);
    const adapter = instance.chat.getAdapter(
      instance.connection.platform,
    ) as Adapter | undefined;
    if (!adapter) {
      throw new Error(
				`No active ${instance.connection.platform} adapter for connection ${connectionId}`,
      );
    }
    return adapter;
  }

  /** Add or remove an emoji reaction on a specific message. */
  async reactToMessage(
    connectionId: string,
		opts: {
			threadId: string;
			messageId: string;
			emoji: string;
			remove?: boolean;
		},
  ): Promise<void> {
    await this.ensureConnectionRunning(connectionId);
    const adapter = this.requireRunningAdapter(connectionId);
    if (opts.remove) {
      await adapter.removeReaction(opts.threadId, opts.messageId, opts.emoji);
    } else {
      await adapter.addReaction(opts.threadId, opts.messageId, opts.emoji);
    }
  }

  /** Replace the text of a message the bot previously sent. */
  async editMessage(
    connectionId: string,
		opts: { threadId: string; messageId: string; text: string },
  ): Promise<void> {
		return this.editMessageContent(connectionId, {
			threadId: opts.threadId,
			messageId: opts.messageId,
			content: { markdown: opts.text },
		});
	}

	/** Replace a bot message with any platform-neutral Chat SDK payload. */
	async editMessageContent(
		connectionId: string,
		opts: {
			threadId: string;
			messageId: string;
			content: AdapterPostableMessage;
		},
	): Promise<void> {
		await this.ensureConnectionRunning(connectionId);
		const adapter = this.requireRunningAdapter(connectionId);
		await adapter.editMessage(opts.threadId, opts.messageId, opts.content);
	}

  /** Delete a message the bot previously sent. */
  async deleteMessage(
    connectionId: string,
		opts: { threadId: string; messageId: string },
  ): Promise<void> {
    await this.ensureConnectionRunning(connectionId);
    const adapter = this.requireRunningAdapter(connectionId);
    await adapter.deleteMessage(opts.threadId, opts.messageId);
  }

  /**
   * Live channel history for a SPECIFIC connection (the conversations
   * read_conversation tool). This:
   *  - is scoped to the caller's authorized `connectionId` (no global
   *    re-selection → no cross-tenant read), and
   *  - pulls real platform history via `channel.messages` (the SDK's
   *    `conversations.history`/`fetchChannelMessages`).
   * Returns newest-N in chronological (oldest-first) order. Multi-replica safe:
   * hydrates the connection on this pod from its row.
   */
  async getLiveConversationHistory(
    connectionId: string,
    channelKey: string,
		limit: number,
  ): Promise<{
    messages: Array<{
      timestamp: string;
      user: string;
      text: string;
      isBot: boolean;
    }>;
  }> {
    const running = await this.ensureConnectionRunning(connectionId);
    const instance = running ? this.instances.get(connectionId) : undefined;
    if (!instance) {
      throw new Error(
				`No active chat instance for connection ${connectionId} (could not start it on this pod)`,
      );
    }
    const collected: Array<{
      timestamp: string;
      user: string;
      text: string;
      isBot: boolean;
    }> = [];
    const channel = instance.chat?.channel?.(channelKey);
    if (channel?.messages) {
      // channel.messages iterates newest-first; take N then return oldest-first.
      for await (const msg of channel.messages as AsyncIterable<any>) {
        const text = (msg?.text ?? "").trim();
        if (text) {
          const sentAt =
            msg?.metadata?.dateSent instanceof Date
              ? msg.metadata.dateSent
              : new Date();
          collected.push({
            timestamp: sentAt.toISOString(),
            user: msg?.author?.fullName || msg?.author?.userId || "user",
            text,
            isBot: !!msg?.author?.isMe,
          });
        }
        if (collected.length >= limit) break;
      }
      collected.reverse();
    }

    // Platforms with NO server-side history API (WhatsApp, Telegram) return
    // nothing from channel.messages — fall back to THIS connection's local
    // history cache (still connection-scoped, so no cross-tenant read; just
    // limited to recently-seen messages).
    if (collected.length === 0) {
      const sep = channelKey.indexOf(":");
      const channelId = sep > 0 ? channelKey.slice(sep + 1) : channelKey;
      const entries =
        (await instance.conversationState?.getEntries(
          connectionId,
          channelId,
					channelId,
        )) ?? [];
      for (const e of entries.slice(-limit)) {
        if (!e.content) continue;
        collected.push({
          timestamp: new Date(e.timestamp).toISOString(),
          user: e.authorName || (e.role === "assistant" ? "assistant" : "user"),
          text: e.content,
          isBot: e.role === "assistant",
        });
      }
    }
    return { messages: collected };
  }

  /**
   * Surface the channels with stored history for a given connection. Used
   * by the local-test-default-target route; falls back to constructing a
   * fresh state-store when the connection isn't currently active.
   */
  async listHistoryChannels(connectionId: string): Promise<string[]> {
    const instance = this.instances.get(connectionId);
    if (instance) {
      return instance.conversationState.listHistoryChannels(connectionId);
    }
    const conversationState = new ConversationStateStore(
			await this.createStateAdapter(),
    );
    return conversationState.listHistoryChannels(connectionId);
  }

  /**
   * Inbound delivery for a `platform: "webhook"` connection (#1235). The
   * public webhook route branches here BEFORE `handleWebhook` — a webhook
   * source has no Chat SDK instance to warm (it's adapterless), so the
   * handler reads the raw row + secret directly. Runs under the connection's
   * own org context: this is an unauthenticated-route path, and both the
   * Postgres secret store and the event insert are org-scoped.
   */
  async handleIngestWebhook(
    connectionId: string,
    request: Request,
		peerAddress?: string | null,
  ): Promise<Response> {
		// Numeric webhook URLs are the canonical provider-connector namespace.
		// Resolve it first so a legacy generic webhook whose stable id is numeric
		// cannot shadow an unrelated provider connection across organizations.
		const bridged = /^\d+$/.test(connectionId)
			? await this.resolveConnectorWebhookConnection(connectionId)
			: null;
      if (bridged) {
        return orgContext.run({ organizationId: bridged.stored.organizationId! }, () =>
          handleWebhookIngest(
            bridged.stored,
            request,
            this.services.getSecretStore(),
						peerAddress,
            bridged.connectorKey === "github"
              ? {
                  // Poll-canonical: mark the feed due (or store stars) so
                  // Automation signals ride the real github poll path. Do not
                  // raw-store under webhook:<id> — that never activates Automations.
                  handleInsteadOfPersist: async ({
                    rawBody,
                    headers,
                    organizationId,
                    connectionId: connId,
                  }) => {
                    const { triggered } =
                      await deliverGithubConnectorConnectionWebhook({
                        sql: getDb(),
                        connectionId: Number(connId),
                        organizationId,
                        connectorKey: "github",
                        rawBody,
                        headers,
                        storeWebhookEvents:
                          process.env.GITHUB_WEBHOOK_STORE_EVENTS !== "false",
                      });
                    return new Response(
                      JSON.stringify({ ok: true, triggered }),
                      {
                        status: 202,
                        headers: { "content-type": "application/json" },
                      },
                    );
                  },
                }
              : bridged.structuredWebhook === "jira_mcp"
                ? {
                    verifyBearerToken: (token: string) =>
                      verifyAtlassianWebhookAuthorization({
                        organizationId: bridged.stored.organizationId!,
                        connectionConfig: bridged.connectionConfig,
                        token,
                      }),
                    handleInsteadOfPersist: async ({
                      rawBody,
                      organizationId,
                      connectionId: connId,
                    }) => {
                      const result = await deliverJiraMcpConnectionWebhook({
                        sql: getDb(),
                        connectionId: Number(connId),
                        organizationId,
                        rawBody,
                      });
                      return new Response(
                        JSON.stringify({
                          ok: result.handled,
                          triggered: result.triggered,
                        }),
                        {
                          status: result.handled ? 202 : 400,
                          headers: { "content-type": "application/json" },
                        },
                      );
                    },
                  }
                : undefined,
					),
        );
      }

    // A stopped row is deliberately off — refuse deliveries exactly like a
    // stopped chat connection (whose instance would not be running). Error
    // status stays accepting: webhook connections have no startup that can
    // fail, and a stray error row should not silently drop deliveries.
    const stored = await this.connectionStore.getConnection(connectionId);
		if (
			!stored ||
			stored.platform !== "webhook" ||
			stored.status === "stopped"
		) {
      return new Response(JSON.stringify({ error: "Connection not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    if (!stored.organizationId) {
      // handleWebhookIngest refuses org-less rows; no context to scope to.
      return handleWebhookIngest(
        stored,
        request,
        this.services.getSecretStore(),
        peerAddress,
        { activateGenericAutomationEvent: true },
      );
    }
    return orgContext.run({ organizationId: stored.organizationId }, () =>
      handleWebhookIngest(
        stored,
        request,
        this.services.getSecretStore(),
        peerAddress,
        { activateGenericAutomationEvent: true },
      ),
    );
  }

  /**
   * Connector-owned webhook resolution. The ingest URL
   * `/api/v1/webhooks/:connectionId` carries a CONNECTOR connection id (a data
   * connector row in `connections`, credential_mode NULL) when the connector
   * registered a provider webhook at connect time — distinct from the chat rows
   * (credential_mode set) the store resolves. When the chat-connection lookup
   * misses, this resolves the connector row, validates it actually registered a
   * webhook
   * (scheme + secret stamped onto its config), and returns a synthetic
   * `StoredConnection` shaped for `handleWebhookIngest`. Non-GitHub deliveries
   * preserve the id so raw events use `connector_key = webhook:<connId>` and the
   * existing `events_webhook_ingest_dedupe` partial unique index. GitHub takes
   * the poll-canonical override above instead.
   * Returns null when there is no such connection or it never registered a
   * webhook — the caller then 404s rather than accepting an unsigned delivery.
   */
  private async resolveConnectorWebhookConnection(
		connectionId: string,
  ): Promise<{
    stored: StoredConnection;
    connectorKey: string;
    structuredWebhook: "jira_mcp" | null;
    connectionConfig: Record<string, unknown>;
  } | null> {
    // Connector connection ids are bigints; a non-numeric id can't match.
    if (!/^\d+$/.test(connectionId)) return null;
    const rows = await getDb()`
      SELECT c.id, c.organization_id, c.connector_key, c.config, c.status,
             cd.mcp_config
      FROM connections c
      LEFT JOIN LATERAL (
        SELECT mcp_config
        FROM connector_definitions
        WHERE organization_id = c.organization_id
          AND key = c.connector_key
          AND status = 'active'
        ORDER BY updated_at DESC
        LIMIT 1
      ) cd ON TRUE
      WHERE c.id = ${connectionId}
        AND c.deleted_at IS NULL
      LIMIT 1
    `;
    const row = rows[0] as
      | {
          id: number;
          organization_id: string;
          connector_key: string;
          config: Record<string, unknown> | null;
          status: string;
          mcp_config: Record<string, unknown> | null;
        }
      | undefined;
    if (!row || !row.organization_id) return null;
    // A revoked/paused connector connection is deliberately off; refuse like a
    // stopped webhook connection. Pending/error stay accepting (a delivery may
    // race activation, and a stray error shouldn't silently drop deliveries).
    if (row.status === "paused" || row.status === "revoked") return null;

    const webhookConfig = await resolveConnectionWebhookConfig(row.config);
    if (!webhookConfig) return null;

    return {
      stored: {
        id: String(row.id),
        platform: "webhook",
        organizationId: row.organization_id,
        config: webhookConfig,
        settings: {},
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      connectorKey: String(row.connector_key),
      structuredWebhook: isAtlassianMcpConfig(row.mcp_config)
        ? "jira_mcp"
        : null,
      connectionConfig: row.config ?? {},
    };
  }

  async handleWebhook(
    connectionId: string,
		request: Request,
  ): Promise<Response> {
    // Multi-replica: hydration is per-request and row-versioned. Any replica
    // can receive any connection's webhook (the LB sprays platform deliveries
    // across pods), so the instance is treated as a memo of the
    // `connections` row: fresh memo → serve, stale/missing → re-hydrate
    // from the row, gone/stopped row → 404. The coordinator's `/api/v1/app-webhooks/slack`
    // pre-call goes through the same check and stays harmless. Mirrors
    // `postMessageToChannel`.
    const running = await this.ensureConnectionRunning(connectionId);
    const instance = running ? this.instances.get(connectionId) : undefined;
    if (!instance) {
      return new Response("Connection not found", { status: 404 });
    }

    // Inbound webhook authentication is performed by the platform's Chat SDK
    // adapter, which owns the per-platform secret and the documented scheme:
    //   - slack    → HMAC-SHA256 over `v0:{ts}:{rawBody}` vs `x-slack-signature`
    //                (`@chat-adapter/slack` `verifySignature`, 401 on mismatch)
    //   - telegram → constant-time compare of `x-telegram-bot-api-secret-token`
    //                to the configured `secretToken` (`@chat-adapter/telegram`)
    //   - discord  → Ed25519 verify of `x-signature-ed25519` /
    //                `x-signature-timestamp` with the app public key
    //   - whatsapp → HMAC-SHA256 over the raw body vs `x-hub-signature-256`
    //                using the Meta app secret
    //   - teams    → Bot Framework bearer-JWT validation in `bridgeAdapter`
    // Each adapter returns 401/403 on failure, so a forged payload never
    // reaches the message pipeline below.
    const { platform } = instance.connection;
    const webhookHandler = instance.chat.webhooks?.[platform];
    if (!webhookHandler) {
      logger.warn(
        { connectionId, platform },
				"No webhook handler found for platform",
      );
      return new Response("No webhook handler", { status: 404 });
    }

    try {
      return await webhookHandler(request);
    } catch (error) {
      logger.error(
        { connectionId, platform, error: String(error) },
				"Webhook handling failed",
      );
      return new Response("Internal error", { status: 500 });
    }
  }

  getServices(): CoreServices {
    return this.services;
  }

  async findSlackConnectionByTeamId(
		teamId: string,
  ): Promise<PlatformConnection | null> {
    return this.slackCoordinator.findConnectionByTeamId(teamId);
  }

  async getDefaultSlackConnection(): Promise<PlatformConnection | null> {
    return this.slackCoordinator.getDefaultConnection();
  }

  /**
   * Forward a verified app-webhook delivery to the chat coordinator for its
   * provider. The generic app-webhook engine has already run the declarative
   * signature verify at the edge; this only routes by provider — no provider
   * literal reaches the gateway wiring. Today only Slack is a chat platform;
   * an unknown provider is a wiring bug (404-equivalent), so we throw.
   */
  async handleChatAppWebhook(
    provider: string,
		request: Request,
  ): Promise<Response> {
    if (provider === "slack") {
      return this.slackCoordinator.handleAppWebhook(request);
    }
    throw new Error(
			`No chat coordinator registered for app-webhook provider "${provider}"`,
    );
  }

  // --- Private ---

  /**
   * Tear down a running managed instance (interaction bridge + chat shutdown)
   * and drop it from the registry. No-op if no instance is tracked for `id`.
   * Returns the instance that was removed, if any, so callers can reuse its
   * conversation-state store.
   */
  private async stopInstance(id: string): Promise<ManagedInstance | undefined> {
    const instance = this.instances.get(id);
    if (instance) {
      instance.interactionCleanup?.();
      await instance.cleanup?.();
      this.instances.delete(id);
    }
    return instance;
  }

  private async startInstance(connection: PlatformConnection): Promise<void> {
    // Adapterless platforms (`rest`) have nothing to boot: no Chat SDK
    // adapter, no webhook, no `instances` entry. Returning early keeps the
    // connection `active` (not `error`), so boot-time reconciliation on every
    // replica treats the row as healthy instead of retrying a doomed adapter
    // start. All lifecycle paths funnel through here (initialize(),
    // addConnection(), restartConnection(), updateConnection()'s restart),
    // so this is the single skip point.
    if (isAdapterlessPlatform(connection.platform)) {
      logger.debug(
        { id: connection.id, platform: connection.platform },
				"Adapterless platform — persisted only, no chat instance to start",
      );
      return;
    }

    // Multi-tenant secret resolution: PostgresSecretStore.get/put route
    // by AsyncLocalStorage org context (see #516). Some callers reach
    // here with org context already bound (HTTP routes via agent-routes
    // middleware); others don't (boot-time initialize(), the public
    // /api/v1/app-webhooks/slack webhook, anywhere ensureConnectionRunning() is
    // triggered without an HTTP request). Always rebind to the
    // connection's owning org id so the per-tenant secret-store query
    // hits the right bucket — including when a caller's org happens to
    // differ from the connection's (a Slack webhook resolved by team_id
    // can land in an admin's session context whose org doesn't match
    // the connection's row).
    if (connection.organizationId) {
      return orgContext.run({ organizationId: connection.organizationId }, () =>
				this.startInstanceUnscoped(connection),
      );
    }
    // Pre-org-scoping rows (legacy connections without organizationId)
    // fall through to the caller's context. PostgresSecretStore.get()
    // accepts the global bucket too, so legacy secrets keep resolving.
    return this.startInstanceUnscoped(connection);
  }

  private async startInstanceUnscoped(
		connection: PlatformConnection,
  ): Promise<void> {
    try {
      // Resolve any `secret://` refs in the connection config to plaintext
      // values for the Chat SDK adapter. This is idempotent — addConnection
      // calls us with plaintext (the caller-supplied values), and reload /
      // restart paths call us with refs read from connections; the
      // resolver leaves non-ref values alone.
      connection.config = await this.resolveConfigForRuntime(
        connection.id,
				connection.config,
      );

      // Backfill a webhook verification secret for connections persisted
      // before auto-generation existed (addConnection only protects
      // newly-created rows) — today only Telegram implements this hook.
      // Without a secretToken the Telegram adapter accepts unsigned webhook
      // payloads, so an EXISTING no-token row would stay forgeable across
      // deploys/restarts. The descriptor generates + persists one here so
      // this boot's adapter verifies it and configurePlatformWebhook
      // registers it, with a row-locked claim so concurrent replicas
      // converge on a single token.
      await this.ensurePlatformWebhookSecret(connection);

      const adapter = await this.createAdapter(connection);
      const stateAdapter = await this.createStateAdapter();
      const conversationState = new ConversationStateStore(stateAdapter);

      const adapterKey = connection.platform;
      const chat = new Chat({
        userName: connection.metadata.botUsername || `bot-${connection.id}`,
        adapters: { [adapterKey]: adapter },
        state: stateAdapter,
        // Not hardcoded: the SDK's silent-drop paths (self-authored, duplicate,
        // lock conflict) log at `debug`, so pinning this to "warn" made a
        // dropped inbound message leave no trace at any LOG_LEVEL. Default
        // stays "warn"; the SDK is loud at info.
        logger: process.env.LOG_LEVEL?.toLowerCase() === "debug"
          ? "debug"
          : "warn",
      });

      const commandDispatcher = new CommandDispatcher({
        registry: this.services.getCommandRegistry(),
        automationSubscriptionService: this.services.getAutomationSubscriptionService(),
      });
      const messageBridge = registerMessageHandlers(
        chat,
        connection,
        this.services,
        this,
				commandDispatcher,
      );
      registerSlackPlatformHandlers(chat, connection, commandDispatcher);
      registerSlackAppHome(chat, connection, {
        // The initialized adapter (with the live Slack WebClient) — `chat.initialize()`
        // below mutates it to add `.client`; event handlers fire only afterwards.
        adapter,
        publicGatewayUrl: this.publicGatewayUrl,
        resolveHomeContext: resolveSlackHomeContext,
        resolveUserInbox: resolveSlackHomeUserInbox,
      });

      chat.registerSingleton();

      // Initialize adapters (starts long-polling for Telegram, etc.)
      await chat.initialize();

      // Set webhook URL if applicable
      const mode =
        getPlatformDescriptor(connection.platform)?.resolveWebhookMode?.(
					connection.config,
        ) ?? "auto";
      const useWebhook =
        mode === "webhook" || (mode === "auto" && !!this.publicGatewayUrl);
      if (useWebhook && this.publicGatewayUrl) {
        const webhookUrl = `${this.publicGatewayUrl}/api/v1/webhooks/${connection.id}`;
        logger.info({ id: connection.id, webhookUrl }, "Setting webhook");
        try {
          await this.configurePlatformWebhook(connection, webhookUrl);
        } catch (error) {
          // Webhook registration failure is non-fatal — the adapter can still
          // receive messages if the webhook URL was set externally (e.g. from
          // a previous deploy or manual configuration).
          logger.warn(
            { id: connection.id, error: String(error) },
						"Webhook registration failed, continuing without it",
          );
        }
      }

      const cleanup = async () => {
        try {
          await chat.shutdown();
        } catch {
          // best effort
        }
      };

      // Populate metadata (bot username, bot user id) from adapter properties.
      // Slack adapters call `auth.test` during initialize and expose `botUserId`
      // via a getter; we mirror it onto connection.metadata so message-bridge
      // mention-strip and the Slack instruction provider can find it.
      try {
        const metadataUpdate: Record<string, string> = {};
        if (!connection.metadata.botUsername) {
          const userName = adapter.userName || adapter.botUsername;
          if (userName) {
            metadataUpdate.botUsername = userName;
          }
        }
        if (!connection.metadata.botUserId) {
          const botUserId = adapter.botUserId;
          if (botUserId) {
            metadataUpdate.botUserId = botUserId;
          }
        }
        if (Object.keys(metadataUpdate).length > 0) {
          Object.assign(connection.metadata, metadataUpdate);
          await this.updateConnection(connection.id, {
            metadata: metadataUpdate,
          });
        }
      } catch {
        // non-critical
      }

      this.instances.set(connection.id, {
        connection,
        chat,
        conversationState,
        messageBridge,
        // Callers that hydrate from a stored row (hydrateFromRow) overwrite
        // this with the row's updated_at; this default covers direct starts.
        rowVersion: connection.updatedAt,
        cleanup,
      });

      const mcpProxy = this.services.getMcpProxy();
      const interactionCleanup = registerInteractionBridge(
        this.services.getInteractionService(),
        this,
        connection,
        chat,
        this.services.getGrantStore(),
				mcpProxy?.executeToolDirect.bind(mcpProxy),
      );
      this.instances.get(connection.id)!.interactionCleanup =
        interactionCleanup;

      // Register slash commands with the platform (e.g. Telegram menu)
      this.registerPlatformCommands(connection).catch((err) => {
        logger.warn(
          { id: connection.id, error: String(err) },
					"Failed to register platform commands",
        );
      });

      logger.info(
        { id: connection.id, platform: connection.platform },
				"Chat instance started",
      );
    } catch (error) {
      connection.status = "error";
      connection.errorMessage = String(error);
      logger.error(
        { id: connection.id, error: String(error) },
				"Failed to start Chat instance",
      );
      throw error;
    }
  }

  private async createAdapter(connection: PlatformConnection): Promise<any> {
    const descriptor = getPlatformDescriptor(connection.platform);
    if (!descriptor) {
      throw new Error(`No adapter factory for: ${connection.platform}`);
    }
    const webhookUrl = this.publicGatewayUrl
      ? `${this.publicGatewayUrl}/api/v1/webhooks/${connection.id}`
      : undefined;
    const adapter = await descriptor.createAdapter(connection.config, {
      webhookUrl,
    });
    return disableSdkMessageHistory(adapter);
  }

  /**
   * Delegate webhook-secret bootstrapping to the platform descriptor (today
   * only Telegram implements the hook — see `platforms/telegram.ts` for the
   * row-locked multi-replica convergence story). No-op for platforms without
   * the hook.
   */
  private async ensurePlatformWebhookSecret(
		connection: PlatformConnection,
  ): Promise<void> {
    const descriptor = getPlatformDescriptor(connection.platform);
    if (!descriptor?.ensureWebhookSecret) return;
    await descriptor.ensureWebhookSecret(connection, {
      secretStore: this.services.getSecretStore(),
      persistConnection: (c) => this.persistConnection(c),
      getStoredConnection: (id) => this.connectionStore.getConnection(id),
    });
  }

  /**
   * Back-compat name for `ensurePlatformWebhookSecret` — existing gateway
   * tests drive the Telegram backfill through this method directly. (Not
   * `private`: nothing inside the class calls it, and `noUnusedLocals`
   * rejects unused private members.)
   */
  async ensureTelegramWebhookSecret(
		connection: PlatformConnection,
  ): Promise<void> {
    return this.ensurePlatformWebhookSecret(connection);
  }

  /**
   * Postgres-backed Chat SDK state, already connected. Fresh adapters outside a
   * warm Chat instance (removeConnection history clear, listHistoryChannels
   * fallback, multi-connection channel resolution) must connect before any
   * store op — otherwise LobuStateAdapter throws "not connected" (which used
   * to block BYO chat connection delete when no warm instance existed).
   */
  private async createStateAdapter(): Promise<any> {
    return createConnectedGatewayStateAdapter();
  }

  /**
   * Register the public per-connection webhook URL with the platform via its
   * descriptor hook (today only Telegram implements it — setWebhook with the
   * verification secret_token). No-op for platforms without the hook.
   */
  private async configurePlatformWebhook(
    connection: PlatformConnection,
		webhookUrl: string,
  ): Promise<void> {
    await getPlatformDescriptor(connection.platform)?.configureWebhook?.(
      connection,
			webhookUrl,
    );
  }

  /**
   * Register slash commands with the platform's native command menu via its
   * descriptor hook (today only Telegram implements it — setMyCommands).
   */
  private async registerPlatformCommands(
		connection: PlatformConnection,
  ): Promise<void> {
    const commands = this.services
      .getCommandRegistry()
      .getAll()
      .map((cmd) => ({
        command: cmd.name,
        description: cmd.description,
      }));

    await getPlatformDescriptor(connection.platform)?.registerCommands?.(
      connection,
			commands,
    );
  }

  private buildSlackCoordinator(): SlackConnectionCoordinator {
    return new SlackConnectionCoordinator({
      createStateAdapter: this.createStateAdapter.bind(this),
      ensureConnectionRunning: this.ensureConnectionRunning.bind(this),
      forwardWebhook: this.handleWebhook.bind(this),
      getRunningChat: (connectionId) => this.getInstance(connectionId)?.chat,
      listSlackConnections: () => this.listConnections({ platform: "slack" }),
      getAppInstallationStore: () => this.services.getAppInstallationStore(),
      getSecretStore: () => this.services.getSecretStore(),
    });
  }

	/** Resolve a chat connection exclusively from the unified connections row. */
  private async resolveStored(id: string): Promise<StoredConnection | null> {
		return this.connectionStore?.getConnection(id) ?? null;
  }

  /**
   * Make sure this replica serves the CURRENT row for `id`. The local
   * instance is a memo keyed on `connections.updated_at`: a fresh memo
   * is served as-is (one PK read), a stale or missing one is re-hydrated
   * from the row, and a deleted/stopped row tears the local instance down.
   * This is the single convergence point that lets any replica handle any
   * webhook-transport connection with no boot warm-start and no cross-pod
   * restart fan-out.
   */
  private async ensureConnectionRunning(id: string): Promise<boolean> {
    const stored = await this.resolveStored(id);
    if (!stored || stored.status === "stopped") {
      if (this.instances.has(id)) {
        await this.stopInstance(id);
      }
      if (stored) logger.info({ id }, "Connection is stopped, not starting");
      return false;
    }

    if (isAdapterlessPlatform(stored.platform)) return false;

    const existing = this.instances.get(id);
    if (existing && existing.rowVersion === stored.updatedAt) return true;

    // Exclusive transports (long-polling) belong to the connection_claims
    // lease holder; a request path on a non-owner replica must not start a
    // second loop. A stale owned instance is refreshed by the claim runner
    // on its next tick.
    if (this.isExclusiveStored(stored)) {
      return existing !== undefined;
    }

    try {
      await this.hydrateFromRow(stored);
      return true;
    } catch (error) {
      logger.error(
        { id, error: String(error) },
				"Failed to hydrate connection",
      );
      await this.writeConnectionStatus(
        stored,
        "error",
				`Startup failed: ${getErrorMessage(error)}`,
      );
      return false;
    }
  }

  /**
   * Public hydration hook for out-of-class consumers that need a warm
   * instance before a synchronous lookup (e.g. the internal file-upload
   * route resolving a platform file handler on a pod that has never seen
   * this connection).
   */
  async warmConnection(id: string): Promise<boolean> {
    return this.ensureConnectionRunning(id);
  }

  /**
   * Stop any stale local instance and start one from the given row,
   * stamping the memo key. Throws on startup failure (caller decides how to
   * persist the error). A successful start clears a pre-existing `error`
   * status — the row provably works.
   */
  private async hydrateFromRow(stored: StoredConnection): Promise<void> {
    // Config refusals (e.g. Telegram polling under LOBU_CLOUD_MODE) gate
    // EVERY start path here — request hydration, the claim runner, restart —
    // so a persisted refused config can never run, matching the create-time
    // rejection in addConnection().
		const rejection = getPlatformDescriptor(
			stored.platform,
		)?.getConfigRejection?.(stored.config as PlatformAdapterConfig);
    if (rejection) {
      throw new Error(rejection);
    }
    await this.stopInstance(stored.id);
    const connection = storedToPlatform(stored);
    await this.startInstance(connection);
    const instance = this.instances.get(stored.id);
    if (!instance) {
      throw new Error(
				`Instance for connection ${stored.id} did not register after start`,
      );
    }
    // startInstance may backfill metadata (e.g. botUsername/botUserId on first
    // start), bumping the row's updated_at. Stamp the memo key from the latest
    // persisted value, not the pre-start snapshot — otherwise the next
    // ensureConnectionRunning sees a version mismatch and needlessly tears the
    // instance down and re-hydrates (re-running setWebhook/setMyCommands).
    const afterStart = await this.resolveStored(stored.id);
    instance.rowVersion = afterStart?.updatedAt ?? stored.updatedAt;
    if (stored.status === "error") {
      await this.writeConnectionStatus(stored, "active", undefined);
      const reread = await this.resolveStored(stored.id);
      if (reread) instance.rowVersion = reread.updatedAt;
      logger.info({ id: stored.id }, "Recovered previously-errored connection");
    }
  }

  /**
   * Persist a status transition under the connection's own org context
   * (status writes happen on request-less paths: claim ticks, health sweep,
   * webhook hydration). No-ops when the row already holds the target state,
   * so repeated failures don't churn `updated_at` (which would invalidate
   * every replica's memo for a connection that didn't change).
   */
  private async writeConnectionStatus(
    row: Pick<
      StoredConnection,
      "id" | "organizationId" | "status" | "errorMessage"
    >,
    status: "active" | "error",
		errorMessage: string | undefined,
  ): Promise<void> {
    if (
      row.status === status &&
      (row.errorMessage ?? undefined) === errorMessage
    ) {
      return;
    }
    const write = () =>
      this.connectionStore.updateConnection(row.id, { status, errorMessage });
    try {
      if (row.organizationId) {
        await orgContext.run({ organizationId: row.organizationId }, write);
      } else {
        await write();
      }
    } catch (error) {
      logger.error(
        { id: row.id, error: String(error) },
				"Failed to write connection status",
      );
    }
  }

  private isExclusiveStored(stored: StoredConnection): boolean {
    return (
      getPlatformDescriptor(stored.platform)?.requiresExclusiveStart?.(
        stored.config as PlatformAdapterConfig,
				{ publicGatewayUrl: this.publicGatewayUrl },
      ) ?? false
    );
  }

  // --- Exclusive-transport claim runner ---

  /**
   * Start the per-replica claim loop for exclusive transports. Every tick
   * each replica tries to claim/renew each exclusive connection's lease in
   * `connection_claims`; the winner runs the (polling) instance, losers make
   * sure they don't. The timer is unref'd so it never holds the process
   * open.
   */
  private startExclusiveRunner(): void {
    if (this.exclusiveTimer) return;
    const timer = setInterval(() => {
      void this.exclusiveTick().catch((error) => {
        logger.warn(
          { error: String(error) },
					"Exclusive connection tick failed",
        );
      });
    }, EXCLUSIVE_TICK_MS);
    timer.unref?.();
    this.exclusiveTimer = timer;
    void this.exclusiveTick().catch((error) => {
      logger.warn(
        { error: String(error) },
				"Initial exclusive connection tick failed",
      );
    });
  }

  private async exclusiveTick(): Promise<void> {
    if (!this.connectionStore) return;
    // Single-flight: a slow hydrate must not overlap the next interval tick
    // (or an addConnection-triggered kick) and stop/start the same
    // connection concurrently.
    if (this.exclusiveTickInFlight) return;
    this.exclusiveTickInFlight = true;
    try {
      await this.exclusiveTickInner();
    } finally {
      this.exclusiveTickInFlight = false;
    }
  }

  private async exclusiveTickInner(): Promise<void> {
    const stored = await this.connectionStore.listConnections();

    const exclusiveRows = new Map<string, StoredConnection>();
    for (const s of stored) {
      if (s.status === "stopped") continue;
      if (this.isExclusiveStored(s)) exclusiveRows.set(s.id, s);
    }

    // Connections we hold that vanished or are no longer exclusive: stop the
    // local loop and free the lease row.
    for (const id of [...this.exclusiveOwned]) {
      if (!exclusiveRows.has(id)) {
        await this.stopInstance(id);
        this.exclusiveOwned.delete(id);
        this.exclusiveFailures.delete(id);
        await this.releaseClaim(id);
      }
    }

    for (const s of exclusiveRows.values()) {
      let owned = false;
      try {
        owned = await this.claimExclusive(s.id);
      } catch (error) {
        logger.warn(
          { id: s.id, error: String(error) },
					"Exclusive claim attempt failed",
        );
        if (this.exclusiveOwned.has(s.id)) {
          // Fail closed: we can't prove the lease is still ours (claims
          // table unreachable). If we kept polling, another replica could
          // legitimately claim after the TTL and we'd have two pollers
          // (split-brain). Stop until a renewal succeeds.
          await this.stopInstance(s.id);
          this.exclusiveOwned.delete(s.id);
        }
        continue;
      }

      if (!owned) {
        if (this.exclusiveOwned.has(s.id)) {
          // Lost the lease (e.g. our heartbeat lapsed during a long stall):
          // another replica owns it now — running here too would 409.
          await this.stopInstance(s.id);
          this.exclusiveOwned.delete(s.id);
        }
        continue;
      }

      this.exclusiveOwned.add(s.id);
      const instance = this.instances.get(s.id);
      if (instance && instance.rowVersion === s.updatedAt) continue;

      // Backoff gate: skip a re-hydration only while a prior failure for THIS
      // row version is still inside its backoff window. Once nextRetryAt has
      // passed we retry even though updated_at is unchanged — that's what turns
      // a transient start failure from "DEAD until a human edits the row" into
      // "retried automatically with exponential backoff". A row edit (different
      // updatedAt) clears the record below and retries immediately.
      const failure = this.exclusiveFailures.get(s.id);
      if (
        failure &&
        failure.rowVersion === s.updatedAt &&
        Date.now() < failure.nextRetryAt
      ) {
        continue;
      }

      try {
        await this.hydrateFromRow(s);
        this.exclusiveFailures.delete(s.id);
      } catch (error) {
        logger.error(
          { id: s.id, error: String(error) },
					"Failed to start exclusive connection",
        );
        // Write the error STATUS only on the FIRST failure for this config
        // version. On a backed-off retry we deliberately do NOT re-write it:
        // transient start errors vary between attempts (ETIMEDOUT vs
        // ECONNRESET, socket addresses, request ids), and writing a *different*
        // message would bump updated_at every tick — which resets the backoff
        // (the record is keyed on updated_at) and churns the DB. The first
        // error is representative; every attempt's detail is in the log above.
        const isRetry = !!failure && failure.rowVersion === s.updatedAt;
        if (!isRetry) {
          await this.writeConnectionStatus(
            s,
            "error",
						`Startup failed: ${getErrorMessage(error)}`,
          );
        }
        // Schedule a bounded, exponentially-backed-off retry. The first-failure
        // status write above bumps updated_at once; subsequent retries leave it
        // stable, so the record keys cleanly on the post-write version. A
        // genuine config edit later produces yet another version and resets the
        // backoff (record cleared on the version mismatch). We KEEP the lease
        // through the failure (no releaseClaim) on purpose — releasing it would
        // just bounce the same transient failure around N replicas (flapping).
        // One owner retrying on a capped backoff is the calmer,
        // multi-replica-correct semantics.
        const reread = await this.connectionStore.getConnection(s.id);
        const rowVersion = reread?.updatedAt ?? s.updatedAt;
        const prior =
          failure && failure.rowVersion === rowVersion ? failure.attempts : 0;
        const attempts = prior + 1;
        const backoff = Math.min(
          EXCLUSIVE_FAILURE_BASE_BACKOFF_MS * 2 ** (attempts - 1),
					EXCLUSIVE_FAILURE_MAX_BACKOFF_MS,
        );
        this.exclusiveFailures.set(s.id, {
          rowVersion,
          attempts,
          nextRetryAt: Date.now() + backoff,
        });
      }
    }
  }

  /**
   * Atomically claim or renew the lease for one exclusive connection. Wins
   * when the row is ours (heartbeat renewal) or its heartbeat is older than
   * the TTL (owner died). Exactly one replica's UPSERT can satisfy the
   * conditional update per row at any moment — Postgres serializes on the
   * row, so two racing replicas resolve to one owner.
   */
  private async claimExclusive(connectionId: string): Promise<boolean> {
    const rows = await getDb()`
      INSERT INTO connection_claims (connection_id, claimed_by, heartbeat_at)
      VALUES (${connectionId}, ${this.podId}, now())
      ON CONFLICT (connection_id) DO UPDATE
        SET claimed_by = EXCLUDED.claimed_by, heartbeat_at = now()
        WHERE connection_claims.claimed_by = EXCLUDED.claimed_by
           OR connection_claims.heartbeat_at <
              now() - make_interval(secs => ${CLAIM_TTL_SECONDS})
      RETURNING connection_id
    `;
    return rows.length > 0;
  }

  private async releaseClaim(connectionId: string): Promise<void> {
    try {
      await getDb()`
        DELETE FROM connection_claims
        WHERE connection_id = ${connectionId} AND claimed_by = ${this.podId}
      `;
    } catch (error) {
      logger.warn(
        { id: connectionId, error: String(error) },
				"Failed to release exclusive claim",
      );
    }
  }

  /**
   * Pod-agnostic claim delete for connection removal. Unlike `releaseClaim`,
   * this is NOT scoped to `this.podId`: the connection row is being deleted, so
   * any replica's lease for it is dead and must go, even if a different replica
   * (or a since-crashed one) owns it.
   */
  private async deleteClaimForConnection(connectionId: string): Promise<void> {
    try {
      await getDb()`
        DELETE FROM connection_claims WHERE connection_id = ${connectionId}
      `;
    } catch (error) {
      logger.warn(
        { id: connectionId, error: String(error) },
				"Failed to delete exclusive claim on connection removal",
      );
    }
  }

  // --- Periodic health sweep (single claimant via TaskScheduler) ---

  /**
   * Validate every non-stopped connection's config without starting it:
   * platform config rejections + secret-ref resolution. Replaces the old
   * boot-time warm-start as the thing that keeps the `status` column honest,
   * but runs on ONE replica per tick (TaskScheduler cron) instead of N pods
   * racing status writes at every deploy.
   *
   * Recovery is deliberately narrow: only rows whose error THIS sweep wrote
   * (`Health check failed: …`) are flipped back by a now-passing check.
   * Runtime startup failures (`Startup failed: …`) are cleared by the paths
   * that can actually prove a start works — request hydration and the claim
   * runner — so the sweep can't flip-flop a connection whose secrets resolve
   * but whose credentials are dead.
   */
  async sweepConnectionHealth(): Promise<{
    checked: number;
    errored: number;
    recovered: number;
  }> {
    const result = { checked: 0, errored: 0, recovered: 0 };
    if (!this.connectionStore) return result;

    const stored = await this.connectionStore.listConnections();
    for (const s of stored) {
      if (s.status === "stopped" || isAdapterlessPlatform(s.platform)) {
        continue;
      }
      result.checked += 1;

			const rejection = getPlatformDescriptor(s.platform)?.getConfigRejection?.(
				s.config as PlatformAdapterConfig,
			);
      if (rejection) {
        if (s.status !== "error") {
          // Prefixed like every sweep-written error so a later sweep can
          // recover the row once the rejection no longer applies (e.g. the
          // config was edited) — recovery keys on this prefix.
          await this.writeConnectionStatus(
            s,
            "error",
						`Health check failed: ${rejection}`,
          );
          result.errored += 1;
        }
        continue;
      }

      try {
        const resolve = () =>
          this.resolveConfigForRuntime(s.id, s.config as PlatformAdapterConfig);
        if (s.organizationId) {
          await orgContext.run({ organizationId: s.organizationId }, resolve);
        } else {
          await resolve();
        }
        // Recover rows whose recorded failure is exactly what this check
        // just proved healthy: sweep-written errors, and secret-resolution
        // startup failures (the #692 class: a deploy-wide env breakage marks
        // every row, the fixed deploy must un-stick them without waiting for
        // traffic). Other startup failures (dead tokens, adapter errors) are
        // NOT recovered here — only a successful real start clears those.
        const recoverable =
          s.status === "error" &&
          (s.errorMessage?.startsWith("Health check failed:") ||
            s.errorMessage?.includes("Failed to resolve secret ref"));
        if (recoverable) {
          await this.writeConnectionStatus(s, "active", undefined);
          result.recovered += 1;
        }
      } catch (error) {
        if (s.status !== "error") {
          await this.writeConnectionStatus(
            s,
            "error",
						`Health check failed: ${getErrorMessage(error)}`,
          );
          result.errored += 1;
        }
      }
    }
    return result;
  }

  private async persistConnection(
		connection: PlatformConnection,
  ): Promise<void> {
    // Move plaintext secrets into the SecretStoreRegistry and store only
    // the returned `secret://` refs in the row's config JSON. Idempotent
    // — already-ref values pass through untouched.
    const persistedConfig = await this.normalizeConfigForStorage(
      connection.id,
			connection.config,
    );
    await this.connectionStore.saveConnection({
      ...connection,
      config: persistedConfig,
    });
  }

  /**
   * Replace any plaintext secret-field value with a `secret://` ref by
   * persisting it via the secret store. Already-ref values are left as-is
   * so re-saving an unchanged config is a no-op.
   */
  private async normalizeConfigForStorage(
    connectionId: string,
		config: PlatformAdapterConfig,
  ): Promise<PlatformAdapterConfig> {
    const normalized = { ...config } as Record<string, unknown>;
    const secretStore = this.services.getSecretStore();

    for (const field of Object.keys(normalized)) {
      const value = normalized[field];
      if (!isSecretField(field) || typeof value !== "string") continue;
      if (isSecretRef(value)) continue;
      normalized[field] = await persistSecretValue(
        secretStore,
        `connections/${connectionId}/${field}`,
				value,
      );
    }

    return normalized as PlatformAdapterConfig;
  }

  /**
   * Resolve every `secret://` ref in a connection's config back to its
   * underlying value. Throws if any ref points at a missing/deleted secret
   * — the caller (startInstance / restartConnection) should mark the
   * connection as errored rather than boot with a half-resolved config.
   */
  private async resolveConfigForRuntime(
    connectionId: string,
		config: PlatformAdapterConfig,
  ): Promise<PlatformAdapterConfig> {
    const resolved = { ...config } as Record<string, unknown>;
    const secretStore = this.services.getSecretStore();

    for (const field of Object.keys(resolved)) {
      const value = resolved[field];
      if (!isSecretField(field) || typeof value !== "string") continue;
      if (!isSecretRef(value)) continue;

      const secretValue = await resolveSecretValue(secretStore, value);
      if (secretValue === undefined) {
        throw new Error(
					`Failed to resolve secret ref for connection ${connectionId} field "${field}"`,
        );
      }
      resolved[field] = secretValue;
    }

    return resolved as PlatformAdapterConfig;
  }

  /** Return connection with secrets redacted for API responses. */
  private sanitizeConnection(
		connection: PlatformConnection,
  ): PlatformConnection {
    const sanitized = {
      ...connection,
      config: { ...connection.config } as any,
    };
    for (const field of Object.keys(sanitized.config)) {
      if (isSecretField(field) && sanitized.config[field]) {
        const val = String(sanitized.config[field]);
        sanitized.config[field] = `***${val.slice(-4)}`;
      }
    }
    return sanitized;
  }

  // ============================================================================
  // Platform adapter methods (used via PlatformRegistry)
  // ============================================================================

  /**
   * Create PlatformAdapter objects for each chat platform.
   * These are lightweight adapters that delegate to this manager.
   */
  createPlatformAdapters(): PlatformAdapter[] {
    return Object.keys(PLATFORM_REGISTRY).map((name) =>
			this.createPlatformAdapter(name),
    );
  }

  private createPlatformAdapter(name: string): PlatformAdapter {
    const descriptor = getPlatformDescriptor(name);
    return {
      name,
      initialize: async () => {
        /* no-op: lifecycle managed by ChatInstanceManager */
      },
      start: async () => {
        /* no-op: lifecycle managed by ChatInstanceManager */
      },
      stop: async () => {
        /* no-op: lifecycle managed by ChatInstanceManager */
      },
      isHealthy: () => true,
      extractRoutingInfo: (body: Record<string, unknown>) =>
        descriptor?.extractRoutingInfo?.(body) ?? null,
      warmConnection: (connectionId: string) =>
        this.warmConnection(connectionId),
      sendMessage: (
        token: string,
        message: string,
        options: {
          agentId: string;
          channelId: string;
          conversationId?: string;
          teamId: string;
          files?: Array<{ buffer: Buffer; filename: string }>;
				},
      ) => this.routePlatformMessage(name, token, message, options),
      getFileHandler: (options) => this.getPlatformFileHandler(name, options),
      // Platform-specific providers extend or replace the shared chat framing.
      getInstructionProvider: () =>
        descriptor?.getInstructionProvider?.(this) ??
        new ChatIdentityInstructionProvider(this, name),
    };
  }

  private getPlatformFileHandler(
    name: string,
    options?: {
      connectionId?: string;
      channelId?: string;
      conversationId?: string;
      teamId?: string;
		},
  ): IFileHandler | undefined {
    const instance = this.resolveFileHandlerInstance(name, options);
    if (!instance) {
      return undefined;
    }

    return getPlatformDescriptor(name)?.createFileHandler?.(instance);
  }

  private resolveFileHandlerInstance(
    name: string,
    options?: {
      connectionId?: string;
      channelId?: string;
      conversationId?: string;
      teamId?: string;
		},
  ): ManagedInstance | undefined {
    if (options?.connectionId) {
      const directInstance = this.instances.get(options.connectionId);
      if (directInstance?.connection.platform === name) {
        return directInstance;
      }
    }

    return Array.from(this.instances.values()).find((instance) => {
      if (instance.connection.platform !== name) {
        return false;
      }
      if (options?.teamId) {
        const configuredTeamId =
          typeof instance.connection.metadata.teamId === "string"
            ? instance.connection.metadata.teamId
            : undefined;
        if (configuredTeamId && configuredTeamId !== options.teamId) {
          return false;
        }
      }
      return true;
    });
  }

  async routePlatformMessage(
    name: string,
    token: string,
    message: string,
    options: {
      agentId: string;
      channelId: string;
      conversationId?: string;
      teamId: string;
      files?: Array<{ buffer: Buffer; filename: string }>;
		},
  ): Promise<{
    messageId: string;
    eventsUrl?: string;
    queued?: boolean;
  }> {
    if (options.files?.length) {
      throw new Error(
				`Platform "${name}" does not support file uploads via Chat SDK routing yet`,
      );
    }

    const connection = await this.selectConnectionForPlatform(
      name,
      options.channelId,
			options.teamId,
    );
    if (!connection) {
      throw new Error(`No active ${name} connection is available`);
    }
    if (!connection.organizationId) {
      throw new Error(
        `Active ${name} connection is missing organization scope`,
      );
    }

    const organizationId = connection.organizationId;

    const sessionManager = this.services.getSessionManager();
    const queueProducer = this.services.getQueueProducer();
    const agentSettingsStore = this.services.getAgentSettingsStore();
    const messageId = randomUUID();
    const conversationId = options.conversationId || options.channelId;
    const sessionId = `platform-chat:${name}:${options.channelId}:${conversationId}`;
    const sessionUserId = `${name}-${token.slice(0, 8) || "anonymous"}`;

    const agentOptions = await resolveAgentOptions(
      options.agentId,
      {},
      agentSettingsStore,
      organizationId,
    );
    const { nixConfig, preApprovedTools, ...remainingAgentOptions } = agentOptions;

    await sessionManager.setSession({
      conversationId: sessionId,
      channelId: sessionId,
      userId: sessionUserId,
      threadCreator: sessionUserId,
      lastActivity: Date.now(),
      createdAt: Date.now(),
      status: "created",
      agentId: options.agentId,
    });

    await queueProducer.enqueueMessage({
      userId: options.channelId,
      conversationId,
      messageId,
      channelId: options.channelId,
      teamId: options.teamId,
      agentId: options.agentId,
      organizationId,
      botId: `${name}-platform`,
      platform: name,
      messageText: message,
      platformMetadata: {
        connectionId: connection.id,
        chatId: options.channelId,
        // Construct the platform-prefixed full thread id so the Chat SDK's
        // `createThread` can decode it. Only set for real threaded replies
        // (conversationId !== channelId); otherwise leave unset and let the
        // DM shortcut in resolveTarget handle routing.
        ...(options.conversationId &&
        options.conversationId !== options.channelId
          ? {
              responseThreadId: `${name}:${options.channelId}:${options.conversationId}`,
            }
          : {}),
        sessionId,
        source: "platform-cli",
      },
      agentOptions: remainingAgentOptions,
      nixConfig,
      preApprovedTools,
    });

    logger.info(
			`Queued platform message via ${name}: agentId=${options.agentId}, channelId=${options.channelId}, conversationId=${conversationId}, sessionId=${sessionId}`,
    );

    return {
      messageId,
      eventsUrl: `/api/v1/agents/${encodeURIComponent(sessionId)}/events`,
      queued: true,
    };
  }

  private async selectConnectionForPlatform(
    name: string,
    channelId: string,
		teamId?: string,
  ): Promise<PlatformConnection | null> {
    // Select from rows, not warm instances: with lazy hydration a fresh pod
    // legitimately has zero instances while active connections exist. A warm
    // instance is preferred only as a tiebreaker (it served traffic here).
    const connections = await this.listConnections({ platform: name });
    const activeConnections = connections.filter(
			(connection) => connection.status === "active",
    );
    if (activeConnections.length === 0) return null;
    if (activeConnections.length === 1) return activeConnections[0] || null;

    const teamMatch = activeConnections.find(
			(connection) => connection.metadata?.teamId === teamId,
    );
    if (teamMatch) return teamMatch;

    // Prefer a connection that already has history for this channel; the
    // state store is row-backed, so no warm instance is required to ask.
    const conversationState = new ConversationStateStore(
			await this.createStateAdapter(),
    );
    for (const connection of activeConnections) {
      if (
        await conversationState.hasHistoryForChannel(connection.id, channelId)
      ) {
        return connection;
      }
    }

    const warm = activeConnections.find((connection) =>
			this.has(connection.id),
    );
    return warm ?? activeConnections[0] ?? null;
  }
}

/** Convert a StoredConnection (decrypted config) to a PlatformConnection. */
function storedToPlatform(stored: StoredConnection): PlatformConnection {
  const out: PlatformConnection = {
    id: stored.id,
    platform: stored.platform,
    config: stored.config as PlatformAdapterConfig,
    // @lobu/core's ConnectionSettings widens userConfigScopes to string[]
    // for cross-package portability; the values are still members of the
    // local UserConfigScope union (validated at the API boundary).
    settings: stored.settings as ConnectionSettings,
    metadata: stored.metadata,
    status: stored.status,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
  if (stored.agentId) out.agentId = stored.agentId;
  if (stored.organizationId) out.organizationId = stored.organizationId;
  if (stored.errorMessage) out.errorMessage = stored.errorMessage;
  return out;
}
