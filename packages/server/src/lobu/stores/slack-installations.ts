import { randomUUID } from "node:crypto";
import { createLogger, decrypt, encrypt } from "@lobu/core";
import type { StoredConnection } from "@lobu/core";
import { getDb } from "../../db/client.js";
import type { WritableSecretStore } from "../../gateway/secrets/index.js";
import {
  deleteSecretsByPrefix,
  persistSecretValue,
} from "../../gateway/secrets/index.js";
import {
  type AppInstallationRow,
  type AppInstallationStatus,
  type AppInstallationStore,
  CrossOrgTransferBlockedError,
} from "./app-installation-store.js";
import {
  softDeleteChatConnectionProjection,
  upsertChatConnectionProjection,
} from "./connections-projection.js";
import { orgContext } from "./org-context.js";

/**
 * Slack OAuth workspace installs ("Add to Slack"), projected onto the generic
 * `app_installations` primitive — NO bespoke table, NO bespoke store interface.
 *
 * These are pure functions over {@link AppInstallationStore} + the secret store.
 * They own the genuinely Slack-specific concerns that don't generalize:
 *   - the stable `slackinst-<uuid>` external id (it is the secret-store name
 *     prefix `installations/<id>/botToken` AND the chat-instance-manager memo /
 *     webhook routing key, so it must survive reinstalls — the bigint PK can't
 *     serve as it, and re-keying provisioned secrets would be destructive);
 *   - the Slack tenant tuple mapping (provider=slack, instance/app='cloud',
 *     external_tenant_id=team_id — Slack routing keys on team_id alone, the
 *     `/api/v1/app-webhooks/slack` endpoint carries no org context);
 *   - the bot token, persisted to the secret store by ref (never plaintext in
 *     the row); the ref is carried in `metadata.config.botToken`.
 *
 * Everything else (storage, ownership/transfer, multi-replica convergence) is
 * the generic store's: `upsert` serializes one-active-per-team on the partial
 * unique index `app_installations_active_tenant` + a Postgres advisory lock.
 */

const logger = createLogger("slack-installations");

/** Stable prefix recognizing a Slack install id (secret prefix + routing key). */
export const SLACK_INSTALLATION_ID_PREFIX = "slackinst-";

const SLACK_PROVIDER = "slack";
const SLACK_PROVIDER_INSTANCE = "cloud";
/**
 * The single hosted Lobu Slack app. A constant (not `SLACK_CLIENT_ID`) so the
 * tenant tuple is deployment-independent — Slack routing keys on team_id alone,
 * so a per-app discriminator buys nothing and an env-dependent one would desync
 * historical rows. The actual client id is recorded in metadata for audit.
 */
const SLACK_PROVIDER_APP_ID = "cloud";

/**
 * A per-workspace Slack app install as the Slack call sites consume it. A plain
 * DTO (not a store with its own table) — the storage of record is
 * `app_installations`. The bot token lives in the secret store; `config` carries
 * only the `secret://` ref.
 */
export interface SlackInstallationRow {
  /** The stable `slackinst-<uuid>` external id. */
  id: string;
  organizationId: string;
  teamId: string;
  teamName?: string;
  botUserId?: string;
  /** `{ platform: "slack", botToken: "secret://..." }` — token by ref. */
  config: Record<string, any>;
  status: "active" | "stopped" | "error";
  createdAt: number;
  updatedAt: number;
}

/** Generic app_installation status -> the Slack tri-state the call sites use. */
function toSlackStatus(status: string): SlackInstallationRow["status"] {
  if (status === "active") return "active";
  if (status === "error") return "error";
  // suspended/revoked/pending all read back as the Slack "stopped" off-state.
  return "stopped";
}

/** Project a Slack `app_installations` row to the Slack DTO, or null if it
 * lacks the stable external id (its secret prefix / routing key is unknown). */
function toSlackRow(row: AppInstallationRow): SlackInstallationRow | null {
  const externalId = row.metadata.external_id;
  if (typeof externalId !== "string" || !externalId) return null;
  return {
    id: externalId,
    organizationId: row.organizationId,
    teamId: row.externalTenantId,
    teamName: row.metadata.team_name ?? undefined,
    botUserId: row.metadata.bot_user_id ?? undefined,
    config: row.metadata.config ?? {},
    status: toSlackStatus(row.status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Upsert a per-workspace OAuth install (token + tenant data), keyed on
 * (org, team). Idempotent per (org, team): a reinstall reuses the SAME
 * `slackinst-<uuid>` external id (so the secret prefix, chat-instance-manager
 * memo, and any channel Automations stay stable) and refreshes the token + tenant
 * metadata. A fresh install from another org TRANSFERS ownership (the generic
 * store demotes the prior active row), so `getByTeam` stays unambiguous.
 *
 * One active install per Slack workspace AND one stable external id per (org,
 * team) are both enforced by the generic store's active-tenant advisory lock.
 * The external id is claimed ATOMICALLY inside that lock (step 1 below) before
 * any secret is written, so two concurrent installs of the same workspace
 * converge on a SINGLE external id + a single bot-token secret — no duplicate
 * id, no orphaned secret. Converges across replicas with no in-memory
 * coordination: both racers re-read the winner's external id under the lock
 * (the generic upsert preserves `external_id` on its in-place update path).
 */
export async function upsertSlackInstallByTeam(
  store: AppInstallationStore,
  secretStore: WritableSecretStore,
  organizationId: string,
  teamId: string,
  data: {
    /** Verified Lobu claimant, distinct from Slack installerUserId. */
    createdBy?: string;
    teamName?: string;
    botUserId?: string;
    botToken: string;
    /**
     * The Slack user who installed the workspace (`authed_user.id`). Persisted
     * onto the installation row so the first-agent-binding welcome DM (see
     * {@link maybeSendSlackWorkspaceWelcome}) can reach the installer long after
     * the org-less pending row is retired. Undefined on a BYO/self-heal path
     * that has no installer identity.
     */
    installerUserId?: string;
    /**
     * The Grid enterprise id (`enterprise.id`), persisted so a Grid workspace's
     * `message.im` events — which arrive stamped with a SIBLING workspace's
     * `team_id`, not the install's — still resolve to this install via the
     * enterprise fallback (see {@link getSlackInstallByEnterpriseId}). Undefined /
     * null for a plain (non-Grid) workspace.
     */
    enterpriseId?: string | null;
    /**
     * True when this is a Grid ORG-WIDE install (`is_enterprise_install` from
     * `oauth.v2.access`) — one installation covering every workspace in the
     * enterprise. Persisted so sibling-workspace events route to this row by
     * `enterprise_id` unambiguously (see {@link getSlackEnterpriseInstall}),
     * without the sole-active heuristic. Absent/false for a per-workspace install
     * (Grid single-workspace or standalone).
     */
    isEnterpriseInstall?: boolean;
    /**
     * When true, refuse a SILENT cross-org transfer: if this workspace is already
     * ACTIVE in a different org, the activation aborts
     * ({@link CrossOrgTransferBlockedError}) instead of stealing the slot. Set on
     * the claim path so a second-org claim must be a deliberate, confirmed move.
     * Absent on the OAuth reinstall path (transfer is the intended semantics there).
     */
    blockCrossOrgTransfer?: boolean;
  }
): Promise<SlackInstallationRow> {
  // Bind the org for the secret-store put + the row write so they land in the
  // same tenant bucket regardless of ambient context.
  return orgContext.run({ organizationId }, async () => {
    const candidateId = `${SLACK_INSTALLATION_ID_PREFIX}${randomUUID().replace(
      /-/g,
      ""
    )}`;

    // Determine the CANONICAL external id WITHOUT mutating any row yet: reuse the
    // (org, team) row's id if one exists (reinstall keeps the stable secret prefix
    // + routing key), else mint the candidate. This read carries no side effect,
    // so a token-persist failure below cannot leave a half-activated row. (Two
    // concurrent FIRST installs of the same workspace may each mint a candidate;
    // the activation upsert's `preserveMetadataKeysOnUpdate: ['external_id']` makes
    // them converge on one id under the lock, and the token is persisted under the
    // RETURNED canonical id afterwards — see below — so no secret is orphaned.)
    const existing = await store.getByTenantAndOrg(
      {
        provider: SLACK_PROVIDER,
        providerInstance: SLACK_PROVIDER_INSTANCE,
        providerAppId: SLACK_PROVIDER_APP_ID,
        externalTenantId: teamId,
      },
      organizationId
    );
    const plannedId =
      (existing?.metadata.external_id as string | undefined) ?? candidateId;

    // For a Grid claim, fence on the enterprise id too — but ONLY across a
    // scope-spanning (org-wide) install, never between two independent per-
    // workspace siblings of the same enterprise (those may live in different orgs).
    // `claimIsScopeWide` = this claim is org-wide; the guard also matches a FOREIGN
    // org-wide row (its `is_enterprise_install` flag) even when this claim is per-
    // workspace. Only when actually blocking a transfer AND this is a Grid install.
    const crossOrgFenceEnterpriseMatch =
      data.blockCrossOrgTransfer && data.enterpriseId
        ? {
            key: "enterprise_id",
            value: data.enterpriseId,
            claimIsScopeWide: data.isEnterpriseInstall === true,
            scopeFlagKey: "is_enterprise_install",
          }
        : undefined;

    // TOKEN FIRST — persist the bot token BEFORE any row is created/activated, so
    // the invariant "no active Slack install without a resolvable botToken" holds
    // even if this throws: on failure we simply never wrote/flipped a row. A
    // transfer's prior active owner is also untouched until we're committed to
    // activating (the demote happens inside the activation upsert below).
    let tokenRef = await persistSecretValue(
      secretStore,
      `installations/${plannedId}/botToken`,
      data.botToken
    );

    // Activate — create/reactivate the (org, team) row with the token ref already
    // in config, demoting any different-org prior owner, all inside the store's
    // advisory-locked transaction. `preserveMetadataKeysOnUpdate: ['external_id']`
    // converges concurrent first-installs on a single id.
    const buildMetadata = (extId: string): Record<string, any> => {
      const config = {
        platform: SLACK_PROVIDER,
        ...(tokenRef ? { botToken: tokenRef } : {}),
      };
      const metadata: Record<string, any> = { external_id: extId, config };
      if (data.teamName) metadata.team_name = data.teamName;
      if (data.botUserId) metadata.bot_user_id = data.botUserId;
      if (data.installerUserId) {
        metadata.installer_user_id = data.installerUserId;
      }
      if (data.enterpriseId) {
        metadata.enterprise_id = data.enterpriseId;
      }
      if (data.isEnterpriseInstall) {
        metadata.is_enterprise_install = true;
      }
      if (process.env.SLACK_CLIENT_ID) {
        metadata.slack_client_id = process.env.SLACK_CLIENT_ID;
      }
      return metadata;
    };

    let row: AppInstallationRow;
    try {
      row = await store.upsert({
        organizationId,
        provider: SLACK_PROVIDER,
        providerInstance: SLACK_PROVIDER_INSTANCE,
        providerAppId: SLACK_PROVIDER_APP_ID,
        externalTenantId: teamId,
        authProfileId: null,
        status: "active",
        metadata: buildMetadata(plannedId),
        preserveMetadataKeysOnUpdate: ["external_id", "welcome_dm_sent"],
        blockCrossOrgTransfer: data.blockCrossOrgTransfer,
        crossOrgFenceMetadataMatch: crossOrgFenceEnterpriseMatch,
      });
    } catch (err) {
      // The cross-org fence tripped AFTER we token-first persisted the bot token
      // (above) but BEFORE any row was activated. The minted `plannedId` prefix is
      // known only here, so purge its now-orphaned secret from THIS (refused) org's
      // bucket rather than leaking a live token. Same-org scope as the put (we are
      // inside orgContext.run). Best-effort — a leftover would be harmless (no row
      // references it) but the whole point is to not leave a live token behind.
      if (err instanceof CrossOrgTransferBlockedError) {
        await deleteSecretsByPrefix(
          secretStore,
          `installations/${plannedId}/`
        ).catch((cleanupError) => {
          logger.warn(
            { plannedId, teamId, error: String(cleanupError) },
            "Failed to purge Slack token secret after cross-org fence block"
          );
        });
      }
      throw err;
    }
    const canonicalId = row.metadata.external_id as string;

    // Concurrency reconciliation: if a racing first-install won the id (the store
    // preserved a DIFFERENT external_id than the one we planned), our token sits
    // under the wrong prefix and config.botToken points at it. Re-persist the
    // token under the canonical id and rewrite config so the row's botToken
    // resolves and the secret prefix matches external_id (delete/cleanup keys on
    // it). Then drop our orphaned candidate secret. This only runs on the rare
    // concurrent-first-install race; the common path skips it.
    let finalRow = row;
    if (canonicalId !== plannedId) {
      tokenRef = await persistSecretValue(
        secretStore,
        `installations/${canonicalId}/botToken`,
        data.botToken
      );
      finalRow = await store.upsert({
        organizationId,
        provider: SLACK_PROVIDER,
        providerInstance: SLACK_PROVIDER_INSTANCE,
        providerAppId: SLACK_PROVIDER_APP_ID,
        externalTenantId: teamId,
        authProfileId: null,
        status: "active",
        metadata: buildMetadata(canonicalId),
        preserveMetadataKeysOnUpdate: ["external_id", "welcome_dm_sent"],
        blockCrossOrgTransfer: data.blockCrossOrgTransfer,
        crossOrgFenceMetadataMatch: crossOrgFenceEnterpriseMatch,
      });
      await deleteSecretsByPrefix(
        secretStore,
        `installations/${plannedId}/`
      ).catch((error) => {
        // Best-effort cleanup of the losing candidate's secret; a leftover is
        // harmless (no row references it) and the next reinstall is unaffected.
        logger.warn(
          { plannedId, canonicalId, teamId, error: String(error) },
          "Failed to purge orphaned Slack token secret after id reconciliation"
        );
      });
    }

    const slackRow = toSlackRow(finalRow);
    if (!slackRow) {
      // Should never happen — we just wrote external_id. Defensive log.
      logger.error(
        { teamId, organizationId },
        "Slack install upsert returned a row without external_id"
      );
      throw new Error("Slack install upsert lost its external id");
    }

    // Dual-write-through (connections-unify Stage 2a): mirror the managed install
    // into the `connections` projection (by slug = the slackinst- external id),
    // so the chat runtime — which reads `connections` — sees the install. Its
    // own advisory lock (keyed on the chat tenant tuple) keeps one active row per
    // (org, slack, team) on the partial-unique `connections_active_chat_tenant`
    // index. Separate transaction from the app_installations upsert above; a
    // crash between them is covered by the runtime's read-fallback to
    // `getSlackInstallById`, so a missing projection only costs one fallback.
    const projection: StoredConnection = {
      id: slackRow.id,
      platform: SLACK_PROVIDER,
      organizationId,
      createdBy: data.createdBy,
      config: slackRow.config,
      settings: { allowGroups: true },
      metadata: {
        teamId,
        ...(slackRow.teamName ? { teamName: slackRow.teamName } : {}),
        ...(slackRow.botUserId ? { botUserId: slackRow.botUserId } : {}),
        // Persist Grid identity so a later T… activation can recognize an
        // orphaned E…-keyed projection. An E… row with an active backing install
        // remains valid for org-wide sibling routing and is not retired.
        ...(data.enterpriseId ? { enterpriseId: data.enterpriseId } : {}),
        ...(data.isEnterpriseInstall ? { isEnterpriseInstall: true } : {}),
      },
      status: "active",
      createdAt: slackRow.createdAt,
      updatedAt: slackRow.updatedAt,
    };
    const db = getDb();
    await db.begin(async (tx: typeof db) => {
      // preserveAgentId: an install/reinstall (re)persists tokens + config but
      // carries NO agent-routing intent — the fallback `agent_id` is set by an
      // admin via manage_connections update. Without the flag, this upsert
      // would clobber the configured fallback to NULL on every reinstall.
      await upsertChatConnectionProjection(
        tx,
        (v) => db.json(v),
        projection,
        organizationId,
        "managed",
        { preserveAgentId: true }
      );
    });

    return slackRow;
  });
}

/** Resolve a Slack install by its stable `slackinst-<uuid>` external id. */
export async function getSlackInstallById(
  store: AppInstallationStore,
  id: string
): Promise<SlackInstallationRow | null> {
  const row = await store.resolveByExternalId(SLACK_PROVIDER, id);
  return row ? toSlackRow(row) : null;
}

/**
 * Resolve the ACTIVE install for a team across orgs — the public `/api/v1/app-webhooks/slack`
 * route carries no org context, so routing keys on team_id alone. Returns null
 * when no active install owns the team (a stopped/transferred workspace), which
 * is exactly what the coordinator wants: it then falls through to the OAuth /
 * preview default rather than routing to an off workspace.
 */
export async function getSlackInstallByTeamId(
  store: AppInstallationStore,
  teamId: string
): Promise<SlackInstallationRow | null> {
  const row = await store.resolveActiveByTenant({
    provider: SLACK_PROVIDER,
    providerInstance: SLACK_PROVIDER_INSTANCE,
    providerAppId: SLACK_PROVIDER_APP_ID,
    externalTenantId: teamId,
  });
  return row ? toSlackRow(row) : null;
}

/**
 * Resolve the ACTIVE install for a Slack Enterprise Grid ENTERPRISE id.
 *
 * A Grid workspace is installed against ONE workspace `team_id` (e.g. the one
 * OAuth returned), but its `message.im` / channel events arrive stamped with a
 * DIFFERENT sibling workspace's `team_id` (whichever workspace the message is
 * homed in) — so {@link getSlackInstallByTeamId} misses. Both share the same
 * `enterprise_id`, which the event carries (top-level `enterprise_id` /
 * `context_enterprise_id` / `authorizations[].enterprise_id`). This is the
 * coordinator's fallback: exact team id first, then the enterprise.
 *
 * Matches on `metadata->>'enterprise_id'` (persisted at claim time by
 * {@link upsertSlackInstallByTeam}). A Grid enterprise can host MANY workspaces,
 * each with its own install; the enterprise id alone can't say which one a
 * sibling-workspace event belongs to, so this resolves ONLY when exactly one
 * active install exists for the enterprise (see
 * {@link AppInstallationStore.resolveSoleActiveByMetadata}). Ambiguous (2+) or none
 * ⇒ null, and the caller falls through to the pending / default paths exactly as
 * the team-id miss does.
 */
export async function getSlackInstallByEnterpriseId(
  store: AppInstallationStore,
  enterpriseId: string
): Promise<SlackInstallationRow | null> {
  const row = await store.resolveSoleActiveByMetadata(
    SLACK_PROVIDER,
    SLACK_PROVIDER_APP_ID,
    "enterprise_id",
    enterpriseId
  );
  return row ? toSlackRow(row) : null;
}

/**
 * Resolve the ORG-WIDE (Grid) install for an enterprise. Slack permits exactly
 * one org-wide app installation per enterprise. Lobu may retain both a
 * historical T-keyed row and its canonical E-keyed alias during a tenant-key
 * transition; when every alias belongs to one Lobu org, the store selects the
 * newest. Aliases spanning Lobu orgs still fail closed. This is the routing key
 * that lets one enterprise install serve every sibling workspace's events.
 */
export async function getSlackEnterpriseInstall(
  store: AppInstallationStore,
  enterpriseId: string
): Promise<SlackInstallationRow | null> {
  const row = await store.resolveActiveByMetadataFlag(
    SLACK_PROVIDER,
    SLACK_PROVIDER_APP_ID,
    "enterprise_id",
    enterpriseId,
    "is_enterprise_install"
  );
  return row ? toSlackRow(row) : null;
}

/** Which cross-org conflict the Slack fence matched (see engine `ClaimConflictKind`). */
export type SlackForeignMatchKind = "same_workspace" | "enterprise_scope_overlap";

/** An active Slack install owned by an org OTHER than a claim's target org. */
export interface SlackForeignActiveBinding {
  organizationId: string;
  orgSlug: string | null;
  orgName: string | null;
  matchKind: SlackForeignMatchKind;
}

/**
 * Resolve an ACTIVE Slack install, owned by an org OTHER than
 * `targetOrganizationId`, that CONFLICTS with claiming `teamId` — TYPED by which
 * of two distinct conflicts it is. Null when there is no conflict.
 *
 * The four cases (see the coordinator's spec):
 *  1. Same exact workspace `team_id` in another org → `same_workspace`. The real
 *     "same workspace elsewhere" case; a deliberate move can proceed.
 *  2. Same exact org-wide enterprise `external_tenant_id` in another org → also a
 *     `team_id` match here (external_tenant_id equals the claimed id), so it falls
 *     under case 1's exact-id arm. No special handling.
 *  3. DIFFERENT per-workspace siblings (T_A vs T_B) sharing one enterprise, with
 *     NEITHER side org-wide → ALLOWED. Two independent workspaces of one Grid may
 *     belong to different Lobu orgs, so the enterprise arm must NOT match here.
 *  4. An org-wide install (`is_enterprise_install`) on EITHER side vs a per-
 *     workspace install of a sibling in another org → `enterprise_scope_overlap`.
 *     A real routing overlap (org-wide covers all siblings), surfaced distinctly
 *     and blocked by default.
 *
 * So the enterprise arm trips ONLY when at least one side is org-wide: either the
 * CLAIMING install (`isEnterpriseInstall`) or the FOREIGN row
 * (`metadata->>'is_enterprise_install' = 'true'`). Exact-id matches always win and
 * are reported as `same_workspace`.
 */
export async function resolveSlackActiveBindingElsewhere(
  teamId: string,
  enterpriseId: string | null,
  isEnterpriseInstall: boolean,
  targetOrganizationId: string
): Promise<SlackForeignActiveBinding | null> {
  const sql = getDb();
  // Enterprise arm only when SOME side is org-wide (case 4). When the claiming
  // side is org-wide, any foreign sibling of the enterprise overlaps; otherwise
  // only a foreign ORG-WIDE row overlaps our per-workspace claim.
  const enterpriseArmActive = enterpriseId != null && isEnterpriseInstall;
  const foreignOrgWideArmActive = enterpriseId != null;
  const rows = (await sql`
    SELECT
      ai.organization_id,
      o.slug,
      o.name,
      (ai.external_tenant_id = ${teamId}) AS exact_match
    FROM app_installations ai
    JOIN "organization" o ON o.id = ai.organization_id
    WHERE ai.provider = ${SLACK_PROVIDER}
      AND ai.provider_app_id = ${SLACK_PROVIDER_APP_ID}
      AND ai.status = 'active'
      AND ai.organization_id IS DISTINCT FROM ${targetOrganizationId}
      AND (
        -- Case 1/2: exact same external subject (team id, or org-wide enterprise id).
        ai.external_tenant_id = ${teamId}
        -- Case 4a: WE are org-wide → any foreign sibling of this enterprise overlaps.
        OR (
          ${enterpriseArmActive}
          AND ai.metadata ->> 'enterprise_id' = ${enterpriseId ?? null}
        )
        -- Case 4b: a foreign ORG-WIDE row covers our per-workspace claim's enterprise.
        OR (
          ${foreignOrgWideArmActive}
          AND ai.metadata ->> 'enterprise_id' = ${enterpriseId ?? null}
          AND (ai.metadata -> 'is_enterprise_install') = 'true'::jsonb
        )
      )
    -- Prefer an exact-id (same_workspace) match over an enterprise-scope match.
    ORDER BY exact_match DESC, ai.updated_at DESC, ai.id DESC
    LIMIT 1
  `) as Array<{
    organization_id: string;
    slug: string | null;
    name: string | null;
    exact_match: boolean;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    organizationId: row.organization_id,
    orgSlug: row.slug ?? null,
    orgName: row.name ?? null,
    matchKind: row.exact_match ? "same_workspace" : "enterprise_scope_overlap",
  };
}

/**
 * The winning result of {@link claimSlackWelcomeDm} — the data the caller needs
 * to actually deliver the one-time welcome DM to the installer.
 */
export interface SlackWelcomeDmClaim {
  /** Stable `slackinst-<uuid>` external id (the secret prefix for the token). */
  installationId: string;
  organizationId: string;
  /** The Slack user who installed the workspace — the DM recipient. */
  installerUserId: string;
  /** `secret://` ref for the workspace bot token, or null if the row has none. */
  botTokenRef: string | null;
}

/**
 * ATOMICALLY claim the right to send the workspace's one-time installer welcome
 * DM. This is the multi-replica idempotency gate for
 * {@link maybeSendSlackWorkspaceWelcome}: a single conditional UPDATE flips
 * `metadata.welcome_dm_sent` from unset → true and RETURNS the row ONLY to the
 * winner, so two pods racing the same first-agent binding both call this but at
 * most one gets a non-null result (the other's WHERE no longer matches). No
 * in-memory flag — the marker lives on the `app_installations` row in Postgres,
 * visible to every replica.
 *
 * Returns null when: the workspace has no ACTIVE install (not installed/claimed
 * yet), the install has no recorded installer id (nobody to DM), or the marker
 * was already claimed (a prior binding / a racing pod already sent it). The
 * caller only DMs on a non-null result.
 *
 * `welcome_dm_sent` is preserved across reinstalls (see
 * `preserveMetadataKeysOnUpdate` in {@link upsertSlackInstallByTeam}), so a
 * reinstall of an already-welcomed workspace never re-fires.
 */
export async function claimSlackWelcomeDm(
  teamId: string
): Promise<SlackWelcomeDmClaim | null> {
  const sql = getDb();
  const rows = (await sql`
    UPDATE app_installations
    SET metadata = jsonb_set(metadata, '{welcome_dm_sent}', 'true'::jsonb, true),
        updated_at = now()
    WHERE provider = ${SLACK_PROVIDER}
      AND provider_app_id = ${SLACK_PROVIDER_APP_ID}
      AND external_tenant_id = ${teamId}
      AND status = 'active'
      AND metadata ->> 'installer_user_id' IS NOT NULL
      AND (metadata ->> 'welcome_dm_sent') IS DISTINCT FROM 'true'
    RETURNING organization_id, metadata
  `) as Array<{ organization_id: string; metadata: Record<string, unknown> }>;
  const row = rows[0];
  if (!row) return null;
  const installerUserId = row.metadata.installer_user_id;
  const externalId = row.metadata.external_id;
  if (typeof installerUserId !== "string" || !installerUserId) return null;
  if (typeof externalId !== "string" || !externalId) return null;
  const config = row.metadata.config as { botToken?: unknown } | undefined;
  return {
    installationId: externalId,
    organizationId: row.organization_id,
    installerUserId,
    botTokenRef:
      typeof config?.botToken === "string" ? config.botToken : null,
  };
}

/** All Slack installs for an org. */
export async function listSlackInstalls(
  store: AppInstallationStore,
  organizationId: string
): Promise<SlackInstallationRow[]> {
  const rows = await store.listByProviderAndOrg(SLACK_PROVIDER, organizationId);
  return rows
    .map(toSlackRow)
    .filter((r): r is SlackInstallationRow => r !== null);
}

/** Mark a Slack install stopped (off, but kept for audit/rollback). */
export async function markSlackInstallStopped(
  store: AppInstallationStore,
  id: string
): Promise<void> {
  await store.setStatusByExternalId(
    SLACK_PROVIDER,
    id,
    "suspended" satisfies AppInstallationStatus
  );
  // Keep the connections projection coherent — the chat runtime reads it, so a
  // still-active projection would route to a stopped install. The slackinst-
  // external id is globally unique, so the slug-scoped update needs no org.
  await getDb()`
    UPDATE connections SET status = 'paused', updated_at = now()
    WHERE slug = ${id} AND deleted_at IS NULL AND credential_mode = 'managed'
  `;
}

/**
 * Handle a Slack `app_uninstalled` / `app_deleted` event: stop the install(s)
 * whose bot token Slack just invalidated, so the router stops sending events to a
 * dead token (a zombie `active` row would fail every forward). Tombstones (marks
 * suspended) rather than deletes — audit/rollback, consistent with
 * {@link markSlackInstallStopped}; a later reinstall reactivates the same row.
 *
 * Resolves the affected install WITHOUT assuming the event carries a team id:
 *   - when `team_id` is present, the exact per-workspace install;
 *   - otherwise, the ORG-WIDE install keyed on `enterprise_id` (a Grid org-wide
 *     uninstall often carries only the enterprise id, no team id) — plus every
 *     same-org T/E-keyed alias of it, since aliases share the invalidated token
 *     (see {@link getSlackEnterpriseInstall}).
 * A per-workspace uninstall thus stops only that workspace's row; a sibling's
 * separately-installed row (matched by its own team id) is untouched. Returns the
 * external ids that were stopped (may be empty — an already-inactive or unknown
 * tenant is a no-op).
 */
export async function revokeSlackInstallsForUninstall(
  store: AppInstallationStore,
  tenant: { teamId?: string | null; enterpriseId?: string | null }
): Promise<string[]> {
  const toStop = new Map<string, SlackInstallationRow>();
  if (tenant.teamId) {
    const byTeam = await getSlackInstallByTeamId(store, tenant.teamId);
    if (byTeam) toStop.set(byTeam.id, byTeam);
  } else if (tenant.enterpriseId) {
    const orgWide = await getSlackEnterpriseInstall(store, tenant.enterpriseId);
    if (orgWide) {
      toStop.set(orgWide.id, orgWide);
      // Same-org T/E-keyed aliases are ONE Slack org-wide installation sharing
      // the token this uninstall just invalidated. Stop every alias — stopping
      // only the resolved (newest) row would leave the stale alias active, and
      // the resolver would then route sibling events to the dead token.
      const orgRows = await store.listByProviderAndOrg(
        SLACK_PROVIDER,
        orgWide.organizationId
      );
      for (const raw of orgRows) {
        if (raw.status !== "active") continue;
        if (raw.providerAppId !== SLACK_PROVIDER_APP_ID) continue;
        if (raw.metadata.enterprise_id !== tenant.enterpriseId) continue;
        if (raw.metadata.is_enterprise_install !== true) continue;
        const alias = toSlackRow(raw);
        if (alias) toStop.set(alias.id, alias);
      }
    }
  }
  for (const id of toStop.keys()) {
    await markSlackInstallStopped(store, id);
  }
  return [...toStop.keys()];
}

/** Delete a Slack install and purge its bot-token secret.
 *
 * @param opts.skipConnectionTombstone When true, skip soft-deleting the
 *   unified `connections` projection. The delete path calls this from a
 *   fallible pre-transaction phase and must leave the row visible so the
 *   connection tombstone commits ATOMICALLY with the pending-approval expiry
 *   in `handleDelete` — never in a separate earlier commit.
 */
export async function deleteSlackInstall(
  store: AppInstallationStore,
  secretStore: WritableSecretStore,
  id: string,
  opts?: { skipConnectionTombstone?: boolean }
): Promise<void> {
  // Resolve the org first: the token was stored under the install org's bucket,
  // so the prefix delete must run under that org context.
  const row = await store.resolveByExternalId(SLACK_PROVIDER, id);
  const orgId = row?.organizationId;
  await store.deleteByExternalId(SLACK_PROVIDER, id);
  // Soft-delete the connections projection so the runtime stops reading it (a
  // connections HIT would otherwise shadow the now-deleted install — the
  // read-fallback only covers a MISS). Slug-scoped: slackinst- ids are unique.
  if (!opts?.skipConnectionTombstone) {
    const sql = getDb();
    await sql.begin((tx) => softDeleteChatConnectionProjection(tx, orgId, id));
  }
  const purge = () =>
    deleteSecretsByPrefix(secretStore, `installations/${id}/`);
  if (orgId) {
    await orgContext.run({ organizationId: orgId }, purge);
  } else {
    await purge();
  }
}

// ---------------------------------------------------------------------------
// Marketplace / Slack-initiated installs — the UNCLAIMED (pending) path.
//
// These arrive at the callback with a bot token but no Lobu org. Park them as a
// `pending`, org-less `app_installations` row until an admin claims the
// workspace by signing in with Slack. The org-scoped secret store can't hold an
// org-less token, so the bot token is stored ENCRYPTED in metadata (same
// ENCRYPTION_KEY as the secret store); on claim it's decrypted and re-persisted
// via {@link upsertSlackInstallByTeam}. Routing ignores non-active rows, so the
// bot is inert until claimed.
// ---------------------------------------------------------------------------

export interface SlackPendingInstallInput {
  teamId: string;
  teamName: string | null;
  botUserId: string | null;
  /** Plaintext bot token — stored encrypted, never in the clear. */
  botToken: string;
  /** The Slack user who clicked Allow (`authed_user.id`); the DM/claim target. */
  installerUserId: string | null;
  isEnterpriseInstall: boolean;
  /**
   * The Grid enterprise id (`enterprise.id`), or null for a plain workspace.
   * Non-null even for a single-workspace Grid install (unlike
   * `isEnterpriseInstall`). Gates installer-identity claims in the claim flow.
   */
  enterpriseId: string | null;
}

export interface SlackPendingInstall {
  id: string;
  teamId: string;
  teamName: string | null;
  botUserId: string | null;
  installerUserId: string | null;
  /** Decrypted bot token. */
  botToken: string;
  isEnterpriseInstall: boolean;
  /** The Grid enterprise id, or null for a plain workspace. */
  enterpriseId: string | null;
}

/** Park (or refresh) the single pending install for a Slack workspace. */
export async function writeSlackPendingInstall(
  install: SlackPendingInstallInput
): Promise<{ id: string }> {
  const sql = getDb();
  const metadata = {
    team_name: install.teamName,
    bot_user_id: install.botUserId,
    installer_user_id: install.installerUserId,
    is_enterprise_install: install.isEnterpriseInstall,
    enterprise_id: install.enterpriseId,
    bot_token_enc: encrypt(install.botToken),
  };
  // Refresh: at most one pending row per team (a re-install replaces it).
  await sql`
    DELETE FROM app_installations
    WHERE provider = ${SLACK_PROVIDER}
      AND provider_app_id = ${SLACK_PROVIDER_APP_ID}
      AND external_tenant_id = ${install.teamId}
      AND status = 'pending'
  `;
  const rows = (await sql`
    INSERT INTO app_installations
      (organization_id, provider, provider_instance, provider_app_id,
       external_tenant_id, status, metadata)
    VALUES
      (NULL, ${SLACK_PROVIDER}, ${SLACK_PROVIDER_INSTANCE},
       ${SLACK_PROVIDER_APP_ID}, ${install.teamId}, 'pending',
       ${sql.json(metadata)})
    RETURNING id
  `) as Array<{ id: number | string }>;
  return { id: String(rows[0]!.id) };
}

/** Resolve the pending (unclaimed) install for a Slack workspace, if any. */
export async function resolveSlackPendingByTenant(
  teamId: string,
  enterpriseId?: string | null
): Promise<SlackPendingInstall | null> {
  const sql = getDb();
  // Match the pending row by its own external_tenant_id (the exact workspace, or
  // — for a Grid ORG-WIDE install — the enterprise id). A sibling-workspace event
  // arriving in the post-install/pre-claim window carries the sibling's team_id,
  // which never equals the org-wide pending row's enterprise-id key, so fall back
  // to the enterprise id (only when the org-wide row also flags itself, so a plain
  // per-workspace pending row is never matched by a sibling's enterprise id).
  const rows = (await sql`
    SELECT id, external_tenant_id, metadata
    FROM app_installations
    WHERE provider = ${SLACK_PROVIDER}
      AND provider_app_id = ${SLACK_PROVIDER_APP_ID}
      AND status = 'pending'
      AND (
        external_tenant_id = ${teamId}
        OR (
          ${enterpriseId ?? null}::text IS NOT NULL
          AND external_tenant_id = ${enterpriseId ?? null}
          AND (metadata->'is_enterprise_install') = 'true'::jsonb
        )
      )
    ORDER BY (external_tenant_id = ${teamId}) DESC, created_at DESC
    LIMIT 1
  `) as Array<{
    id: number | string;
    external_tenant_id: string;
    metadata: Record<string, unknown>;
  }>;
  const row = rows[0];
  if (!row) return null;
  const enc = row.metadata.bot_token_enc;
  if (typeof enc !== "string" || !enc) return null;
  return {
    id: String(row.id),
    teamId: row.external_tenant_id,
    teamName:
      typeof row.metadata.team_name === "string"
        ? row.metadata.team_name
        : null,
    botUserId:
      typeof row.metadata.bot_user_id === "string"
        ? row.metadata.bot_user_id
        : null,
    installerUserId:
      typeof row.metadata.installer_user_id === "string"
        ? row.metadata.installer_user_id
        : null,
    botToken: decrypt(enc),
    isEnterpriseInstall: row.metadata.is_enterprise_install === true,
    enterpriseId:
      typeof row.metadata.enterprise_id === "string"
        ? row.metadata.enterprise_id
        : null,
  };
}

/**
 * Claim a pending (unclaimed) Slack workspace into an org. The first UPDATE is
 * the authoritative, durable claim: it atomically assigns the pending row to
 * one org before any secret-store or activation work begins. A racing org's
 * compare-and-set returns no row, so generic active-install transfer semantics
 * can never turn a second pending claim into an ownership steal.
 *
 * The claimed row deliberately stays `pending` until
 * {@link upsertSlackInstallByTeam} has persisted the bot token. That function
 * finds this org-owned row and flips it active in place. If token persistence or
 * activation fails, the encrypted token remains on the durable pending row and
 * the SAME org can retry; a different org still cannot claim it.
 *
 * Caller is responsible for authorizing the claim (workspace-admin check)
 * BEFORE invoking this. Returns the stable `slackinst-<uuid>` install id.
 *
 * When `confirmMove` is false and the workspace is already ACTIVE in another
 * org, activation throws {@link CrossOrgTransferBlockedError} — the atomic fence
 * against a silent second-org claim stealing the active slot. The durable
 * pending-row claim is rolled back to org-less so a genuine first claim can
 * still succeed once the user confirms the move (or claims elsewhere).
 */
export async function claimSlackPendingInstall(
  store: AppInstallationStore,
  secretStore: WritableSecretStore,
  pending: SlackPendingInstall,
  organizationId: string,
  confirmMove = false,
  createdBy?: string,
): Promise<{ installationId: string }> {
  const sql = getDb();
  const claimed = await sql`
    UPDATE app_installations
    SET organization_id = ${organizationId}, updated_at = now()
    WHERE id = ${pending.id}::bigint
      AND provider = ${SLACK_PROVIDER}
      AND provider_instance = ${SLACK_PROVIDER_INSTANCE}
      AND provider_app_id = ${SLACK_PROVIDER_APP_ID}
      AND external_tenant_id = ${pending.teamId}
      AND status = 'pending'
      AND (organization_id IS NULL OR organization_id = ${organizationId})
    RETURNING id
  `;
  if (claimed.length === 0) {
    throw new Error("Slack workspace pending install was already claimed");
  }

  let row: SlackInstallationRow;
  try {
    row = await upsertSlackInstallByTeam(
      store,
      secretStore,
      organizationId,
      pending.teamId,
      {
        createdBy,
        teamName: pending.teamName ?? undefined,
        botUserId: pending.botUserId ?? undefined,
        botToken: pending.botToken,
        installerUserId: pending.installerUserId ?? undefined,
        enterpriseId: pending.enterpriseId,
        isEnterpriseInstall: pending.isEnterpriseInstall,
        blockCrossOrgTransfer: !confirmMove,
      }
    );
  } catch (err) {
    if (err instanceof CrossOrgTransferBlockedError) {
      // The fence tripped: this workspace is already active in another org and
      // the move was not confirmed. Release the durable pending-row claim (back
      // to org-less, still pending) so a genuine first claim from the rightful
      // org — or a later confirmed move — can still proceed. Never leave the row
      // stranded under an org that failed to activate.
      await sql`
        UPDATE app_installations
        SET organization_id = NULL, updated_at = now()
        WHERE id = ${pending.id}::bigint
          AND provider = ${SLACK_PROVIDER}
          AND provider_app_id = ${SLACK_PROVIDER_APP_ID}
          AND external_tenant_id = ${pending.teamId}
          AND organization_id = ${organizationId}
          AND status = 'pending'
      `;
    }
    throw err;
  }
  // Usually the reserved row was activated in place. If a same-org active row
  // already existed, the generic upsert refreshed that row instead; retire only
  // THIS successfully consumed pending row, never a newer reinstall.
  await sql`
    DELETE FROM app_installations
    WHERE id = ${pending.id}::bigint
      AND provider = ${SLACK_PROVIDER}
      AND provider_app_id = ${SLACK_PROVIDER_APP_ID}
      AND external_tenant_id = ${pending.teamId}
      AND organization_id = ${organizationId}
      AND status = 'pending'
  `;
  return { installationId: row.id };
}
