import type { StoredConnection } from "@lobu/core";
import { getDb, type DbClient } from "../../db/client.js";
import { CrossOrgTransferBlockedError, type AppInstallationStore } from "../../lobu/stores/app-installation-store.js";
import { runtimeConnectionIdToSlug } from "../../lobu/stores/connections-projection.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { ClaimMoveBlockedError, type ClaimContinuation, type ClaimProvider } from "./connection-claim.js";
import type { ConnectionSettings } from "./types.js";
import { activateGoogleChatSpace, googleChatInstallApp, googleChatInstallationId } from "./platforms/gchat-installation.js";

interface PendingSpace {
  id: number;
  provider_app_id: string;
  external_tenant_id: string;
  status: string;
  metadata: { external_id: string; source_connection_id?: string; source_organization_id?: string; installer_id: string; space_name: string; verified_added: boolean; claimed?: boolean; removed?: boolean };
}


function continuation(pending: PendingSpace, runtimeId: string): ClaimContinuation {
  return { platform: "gchat", connection: runtimeConnectionIdToSlug(runtimeId), channelId: `gchat:${pending.external_tenant_id}`, label: pending.metadata.space_name, teamId: pending.external_tenant_id };
}

export function googleChatClaimProvider(deps: {
  store: AppInstallationStore;
  getConnection(id: string): Promise<StoredConnection | null>;
}): ClaimProvider<PendingSpace> {
  const sql = getDb();
  // No expiry on the reference: `authorize` below binds the claim to the verified
  // installer's Google identity, so the ref alone grants nothing.
  const read = async (ref: string, tx: DbClient = sql): Promise<PendingSpace | null> => {
    if (!/^gchatclaim-[0-9a-f-]{36}$/.test(ref)) return null;
    const [row] = await tx`
      SELECT id, provider_app_id, external_tenant_id, status, metadata FROM app_installations
      WHERE provider = 'gchat' AND metadata->>'external_id' = ${ref} LIMIT 1
    `;
    return row as PendingSpace ?? null;
  };
  const appFor = (pending: PendingSpace) => googleChatInstallApp(pending.provider_app_id, pending.metadata,
    (id) => orgContext.exit(() => deps.getConnection(id)));
  const authorize = async (userId: string, pending: PendingSpace) => {
    const app = await appFor(pending);
    if (!app) return { status: "not_authorized" as const, code: "source_unavailable" };
    const accounts = await sql`SELECT "accountId" FROM account WHERE "userId" = ${userId} AND "providerId" = 'google'`;
    if (!accounts.some((account) => `users/${account.accountId}` === pending.metadata.installer_id)) {
      return { status: "signin_required" as const, signinProvider: "google" };
    }
    if (!app.source) {
      // The hosted app has no tenant source: Google's verified addition plus
      // the installer's own Google identity is the whole authority, as on Slack.
      if (!pending.metadata.verified_added) return { status: "not_authorized" as const, code: "unverified_installation" };
      return { status: "authorized" as const, subjectName: pending.metadata.space_name };
    }
    const [membership] = await sql`SELECT role FROM member WHERE "organizationId" = ${app.source.organizationId!} AND "userId" = ${userId}`;
    const ownsSource = membership?.role === "owner" || membership?.role === "admin";
    // Hosted access is explicit; an ordinary message is not installation proof.
    if (!ownsSource && !((app.source.settings as ConnectionSettings).previewMode === true && pending.metadata.verified_added)) {
      return { status: "not_authorized" as const, code: "not_admin" };
    }
    return { status: "authorized" as const, subjectName: pending.metadata.space_name };
  };
  const elsewhere = async (pending: PendingSpace, organizationId: string) => {
    const [row] = await sql`
      SELECT o.slug AS "orgSlug", o.name AS "orgName" FROM app_installations ai
      JOIN organization o ON o.id = ai.organization_id
      WHERE ai.provider = 'gchat' AND ai.provider_instance = 'cloud'
        AND ai.provider_app_id = ${pending.provider_app_id} AND ai.external_tenant_id = ${pending.external_tenant_id}
        AND ai.status = 'active' AND ai.organization_id <> ${organizationId} LIMIT 1
    `;
    return row ? { orgSlug: row.orgSlug, orgName: row.orgName, matchKind: "same_workspace" as const } : null;
  };
  return {
    provider: "gchat", signinProvider: "google", subjectKind: "space",
    resolvePending: async (ref) => { const row = await read(ref); return row?.status === "pending" && !row.metadata.claimed && !row.metadata.removed ? row : null; },
    authorize,
    resolveExistingBinding: async (ref, userId) => {
      const pending = await read(ref);
      if (!pending || !pending.metadata.claimed || pending.metadata.removed || (await authorize(userId, pending)).status !== "authorized") return null;
      const app = await appFor(pending);
      if (!app) return null;
      const sourceId = app.source?.id ?? null;
      const [row] = await sql`
        SELECT ai.organization_id, o.slug FROM app_installations ai JOIN organization o ON o.id = ai.organization_id
        JOIN member m ON m."organizationId" = o.id AND m."userId" = ${userId}
        WHERE ai.provider = 'gchat' AND ai.provider_instance = 'cloud' AND ai.status = 'active'
          AND ai.provider_app_id = ${pending.provider_app_id} AND ai.external_tenant_id = ${pending.external_tenant_id}
          AND (${sourceId}::text IS NULL OR ai.metadata->>'source_connection_id' = ${sourceId}) LIMIT 1
      `;
      return row ? { orgSlug: row.slug, continuation: continuation(pending, googleChatInstallationId(row.organization_id, pending.provider_app_id, pending.external_tenant_id)) } : null;
    },
    resolveActiveBindingElsewhere: async (_ref, pending, org) => elsewhere(pending, org),
    bind: async (pending, organizationId, userId, confirmMove) => sql.begin(async (tx) => {
      const [current] = await tx`SELECT status, metadata FROM app_installations WHERE id = ${pending.id} FOR UPDATE`;
      if (!current || current.status !== "pending" || current.metadata.removed) throw new Error("Google Chat setup link expired");
      if ((await authorize(userId, pending)).status !== "authorized") throw new Error("Google Chat installation authority changed");
      const app = await appFor(pending);
      if (!app) throw new Error("Google Chat source is unavailable");
      let bindingId: string;
      try {
        bindingId = await activateGoogleChatSpace(deps.store, app, organizationId, pending.external_tenant_id, confirmMove, userId);
      } catch (error) {
        if (error instanceof CrossOrgTransferBlockedError) {
          const existing = await elsewhere(pending, organizationId);
          if (existing) throw new ClaimMoveBlockedError(existing);
        }
        throw error;
      }
      // A setup reference stays org-less, so the installation store can never
      // mistake it for the target organization's reusable installation row.
      await tx`UPDATE app_installations SET metadata = metadata || '{"claimed":true}'::jsonb, updated_at = now() WHERE id = ${pending.id}`;
      return { bindingId, continuation: continuation(pending, bindingId) };
    }),
  };
}
