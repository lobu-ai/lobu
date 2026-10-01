import { createHash, randomUUID } from "node:crypto";
import type { StoredConnection } from "@lobu/core";
import { getDb } from "../../../db/client.js";
import { AutomationSubscriptionService } from "../../channels/automation-subscription-service.js";
import { claimContinuation } from "../connection-claim.js";
import type { ConnectionSettings } from "../types.js";
import {
  chatTenantAdvisoryLockKey,
  managedTenantAdvisoryLockKey,
  runtimeConnectionIdToSlug,
  upsertChatConnectionProjection,
} from "../../../lobu/stores/connections-projection.js";
import type { AppInstallationStore } from "../../../lobu/stores/app-installation-store.js";
import { lockOrganizationForRelationshipClaims } from "../../../utils/relationship-claims.js";
import { googleChatEventSpace, GoogleChatScopeError } from "./gchat-scope.js";
import type { ChatRuntimeConfig, ChatRuntimeDeps } from "./types.js";

const PREFIX = "gchatinst-";
const PROVIDER = "gchat";

/** Only called after the Chat SDK has authenticated this provider delivery. */
export async function parkGoogleChatSpace(source: StoredConnection, space: string, installer: string, label: string, added: boolean): Promise<string> {
  if (!source.organizationId || !/^users\/\d+$/.test(installer)) throw new Error("Google Chat installer identity is missing");
  const sql = getDb();
  return sql.begin(async (tx) => {
    // Reuse the owner's row as a durable serialization point for pending refs.
    await tx`SELECT id FROM organization WHERE id = ${source.organizationId!} FOR UPDATE`;
    const [pending] = await tx`
      SELECT metadata FROM app_installations WHERE provider = 'gchat' AND provider_instance = 'cloud'
        AND provider_app_id = ${source.config.googleChatProjectNumber} AND external_tenant_id = ${space}
        AND status = 'pending' AND metadata->>'source_connection_id' = ${source.id}
        AND metadata->>'installer_id' = ${installer}
        AND metadata->>'claimed' IS DISTINCT FROM 'true' AND metadata->>'removed' IS DISTINCT FROM 'true'
        AND updated_at > now() - interval '24 hours' LIMIT 1
    `;
    if (pending) {
      if (added && !pending.metadata.verified_added) {
        await tx`UPDATE app_installations SET metadata = metadata || '{"verified_added":true}'::jsonb, updated_at = now()
          WHERE provider = 'gchat' AND metadata->>'external_id' = ${pending.metadata.external_id}`;
      }
      return pending.metadata.external_id;
    }
    const ref = `gchatclaim-${randomUUID()}`;
    await tx`
      INSERT INTO app_installations (provider, provider_instance, provider_app_id, external_tenant_id, status, metadata)
      VALUES ('gchat', 'cloud', ${source.config.googleChatProjectNumber}, ${space}, 'pending', ${sql.json({
        external_id: ref, source_connection_id: source.id, source_organization_id: source.organizationId,
        installer_id: installer, space_name: label, verified_added: added,
      })})
    `;
    return ref;
  });
}


/** Both projection and lookup use the same server-owned namespace. */
export function googleChatInstallationId(org: string, project: string, space: string): string {
  return PREFIX + createHash("sha256").update(JSON.stringify([org, project, space])).digest("hex");
}

/** The caller must verify the installer and chosen org before activation. */
export async function activateGoogleChatSpace(
  store: AppInstallationStore,
  source: StoredConnection,
  organizationId: string,
  spaceName: string,
  confirmMove = false,
): Promise<string> {
  const project = (source.config as any).googleChatProjectNumber;
  if (source.platform !== PROVIDER || source.status !== "active" || !source.organizationId ||
    !/^\d+$/.test(project) || !/^spaces\/[\w-]+$/.test(spaceName) || source.id.startsWith(PREFIX)) {
    throw new GoogleChatScopeError();
  }
  const id = googleChatInstallationId(organizationId, project, spaceName);
  const installation = await store.upsert({
    provider: PROVIDER, providerInstance: "cloud", providerAppId: project,
    externalTenantId: spaceName, organizationId, blockCrossOrgTransfer: !confirmMove,
    revokeConnectionsOnTransfer: { errorMessage: "Google Chat space moved to another organization" },
    metadata: { external_id: id, source_connection_id: source.id, source_organization_id: source.organizationId },
  });
  const projection: StoredConnection = {
    id, organizationId, platform: PROVIDER, status: "active",
    config: { platform: PROVIDER, installation_ref: String(installation.id) }, settings: { allowGroups: true },
    metadata: { teamId: spaceName, teamName: spaceName },
    createdAt: installation.createdAt, updatedAt: installation.updatedAt,
  };
  const sql = getDb();
  await sql.begin(async (tx) => {
    // Use the projection writer's existing lock order before locking authority;
    // it reenters these same advisory keys rather than inventing another lane.
    for (const key of [chatTenantAdvisoryLockKey(projection, organizationId), managedTenantAdvisoryLockKey(projection)]) {
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    }
    await lockOrganizationForRelationshipClaims(tx, organizationId);
    const active = await tx`
      SELECT id FROM app_installations WHERE id = ${installation.id}
        AND status = 'active' AND organization_id = ${organizationId}
      FOR UPDATE
    `;
    if (!active.length) throw new GoogleChatScopeError();
    await upsertChatConnectionProjection(tx, (value) => sql.json(value as any), projection,
      organizationId, "managed", { preserveAgentId: true });
  });
  return id;
}

export async function resolveGoogleChatRuntime(
  connection: StoredConnection,
  deps: ChatRuntimeDeps,
): Promise<ChatRuntimeConfig | undefined> {
  if (!connection.id.startsWith(PREFIX)) return undefined;
  const install = await deps.getAppInstallationStore().resolveByExternalId(PROVIDER, connection.id);
  if (!install || connection.platform !== PROVIDER || install.status !== "active" || install.organizationId !== connection.organizationId ||
    connection.status === "stopped" || install.providerInstance !== "cloud" ||
    connection.id !== googleChatInstallationId(install.organizationId, install.providerAppId, install.externalTenantId) ||
    connection.metadata?.teamId !== install.externalTenantId) throw new GoogleChatScopeError();
  const sourceId = install.metadata.source_connection_id;
  if (typeof sourceId !== "string" || sourceId.startsWith(PREFIX)) throw new GoogleChatScopeError();
  const source = await deps.getConnection(sourceId);
  if (!source || source.status !== "active" || source.platform !== PROVIDER ||
    source.organizationId !== install.metadata.source_organization_id || !source.organizationId ||
    (source.config as any).googleChatProjectNumber !== install.providerAppId) throw new GoogleChatScopeError();
  const config = { ...await deps.resolveSecrets(source), disableSignatureVerification: false } as any;
  // Secret-only rotations need not bump the source row. Keep this opaque and
  // gateway-local; never log it or expose it in the connection projection.
  const revision = createHash("sha256").update(JSON.stringify([
    connection.updatedAt, install.id, install.updatedAt, source.updatedAt, config,
  ])).digest("hex");
  return {
    config, revision, scope: install.externalTenantId, stateKey: connection.id,
    webhookUrl: deps.publicGatewayUrl
      ? `${deps.publicGatewayUrl}/api/v1/webhooks/${source.id}` : undefined,
  };
}

export async function routeGoogleChatWebhook(
  connection: StoredConnection,
  request: Request,
  deps: ChatRuntimeDeps,
): Promise<string | Response | undefined> {
  if (connection.id.startsWith(PREFIX)) return undefined;
  const project = (connection.config as any).googleChatProjectNumber;
  // Only explicitly configured projects can own space installations. Existing
  // endpoint-authenticated BYO connections continue through their own adapter.
  if (typeof project !== "string" || !/^\d+$/.test(project)) return undefined;
  let space: string;
  try {
    space = googleChatEventSpace(await request.clone().json());
  } catch {
    return new Response("Invalid Google Chat space", { status: 400 });
  }
  const sql = getDb();
  // Include inactive rows: falling back to the private transport after revoke
  // would resurrect the old personal binding. This is a bounded indexed lookup.
  const rows = await sql`
    SELECT organization_id, status, metadata FROM app_installations
    WHERE provider = ${PROVIDER} AND provider_instance = 'cloud'
      AND provider_app_id = ${project} AND external_tenant_id = ${space}
    ORDER BY (status = 'active') DESC, updated_at DESC, id DESC LIMIT 1
  `;
  const row = rows[0];
  if (!row) return undefined;
  const body = await request.clone().json() as any;
  // Pending setup remains on the source's verified adapter, where dispatch is
  // gated. Reinstall lifecycle deliveries must also reach that verifier.
  const added = body.type === "ADDED_TO_SPACE" || body.eventType === "ADDED_TO_SPACE" || body.chat?.addedToSpacePayload;
  if (row.status === "pending" && !row.metadata.removed || row.status !== "active" && added) return undefined;
  if (row.status !== "active" || row.metadata.source_connection_id !== connection.id) {
    return new Response("Google Chat installation is unavailable", { status: 403 });
  }
  const id = googleChatInstallationId(row.organization_id, project, space);
  const target = await deps.getConnection(id);
  if (!target || target.organizationId !== row.organization_id || target.status === "stopped") {
    return new Response("Google Chat installation is unavailable", { status: 403 });
  }
  await resolveGoogleChatRuntime(target, deps);
  return id;
}

export async function revokeGoogleChatSpace(
  connection: { id: string; organizationId: string },
  deps: ChatRuntimeDeps,
): Promise<void> {
  const store = deps.getAppInstallationStore();
  const install = await store.resolveByExternalId(PROVIDER, connection.id);
  if (!install || install.organizationId !== connection.organizationId) throw new GoogleChatScopeError();
  // The shared bot key stays in its owner's vault and serves other spaces.
  await store.revoke(install.id);
}

export async function acceptGoogleChatWebhook(
  connection: StoredConnection,
  request: Request,
  deps: ChatRuntimeDeps,
): Promise<Response | void> {
  const scoped = connection.id.startsWith(PREFIX);
  // Endpoint-authenticated transports do not own project-scoped installations.
  if (!scoped && !/^\d+$/.test(String(connection.config.googleChatProjectNumber))) return;
  const body = await request.json() as any;
  const eventType = typeof body.type === "string" ? body.type : body.eventType;
  const removed = eventType === "REMOVED_FROM_SPACE" || !!body.chat?.removedFromSpacePayload;
  const added = eventType === "ADDED_TO_SPACE" || !!body.chat?.addedToSpacePayload;
  const space = googleChatEventSpace(body);
  if (removed) {
    const sql = getDb();
    let project = connection.config.googleChatProjectNumber;
    let sourceId = connection.id;
    if (connection.id.startsWith(PREFIX)) {
      await resolveGoogleChatRuntime(connection, deps);
      const install = await deps.getAppInstallationStore().resolveByExternalId(PROVIDER, connection.id);
      if (!install) throw new GoogleChatScopeError();
      project = install.providerAppId;
      sourceId = install.metadata.source_connection_id;
    }
    // Invalidate setup refs under the claim's row lock before finding the
    // current active owner. A claim/move that wins first is revoked afterwards.
    await sql`UPDATE app_installations SET metadata = metadata || '{"removed":true}'::jsonb, updated_at = now()
      WHERE provider = 'gchat' AND provider_app_id = ${project} AND external_tenant_id = ${space}
        AND metadata->>'source_connection_id' = ${sourceId} AND status = 'pending'`;
    const [active] = await sql`SELECT organization_id, metadata FROM app_installations
      WHERE provider = 'gchat' AND provider_instance = 'cloud' AND provider_app_id = ${project}
        AND external_tenant_id = ${space} AND status = 'active'
        AND metadata->>'source_connection_id' = ${sourceId} LIMIT 1`;
    if (active) {
      const id = googleChatInstallationId(active.organization_id, project, space);
      await revokeGoogleChatSpace({ id, organizationId: active.organization_id }, deps);
      await sql`UPDATE connections SET status = 'paused', updated_at = now()
        WHERE organization_id = ${active.organization_id} AND slug = ${runtimeConnectionIdToSlug(id)}
          AND deleted_at IS NULL AND credential_mode = 'managed'`;
    }
    return;
  }
  if (!added && connection.agentId) return;
  const linked = !added && await new AutomationSubscriptionService().channelHasMessageSubscription(
    connection.id, `gchat:${space}`, connection.organizationId!, { crossOrganization: (connection.settings as ConnectionSettings).previewMode === true, teamId: space },
  );
  if (linked) return;
  const spaceData = body.space ?? body.chat?.addedToSpacePayload?.space ?? body.chat?.messagePayload?.space;
  let url: string;
  if (scoped) {
    const [org] = await getDb()`SELECT slug FROM organization WHERE id = ${connection.organizationId!}`;
    if (!org) throw new GoogleChatScopeError();
    const next = claimContinuation(org.slug, { platform: PROVIDER, connection: runtimeConnectionIdToSlug(connection.id), channelId: `gchat:${space}`, teamId: space, label: spaceData?.displayName || space });
    url = new URL(next.nextUrl!, deps.publicGatewayUrl).toString();
  } else {
    const installer = body.user?.name ?? body.chat?.user?.name ?? body.message?.sender?.name ?? body.chat?.messagePayload?.message?.sender?.name;
    if (typeof installer !== "string" || !/^users\/\d+$/.test(installer)) return new Response("Google Chat installer identity is missing", { status: 400 });
    const ref = await parkGoogleChatSpace(connection, space, installer, spaceData?.displayName || space, added);
    url = new URL(`/connector/gchat/connection?${new URLSearchParams({ ref })}`, deps.publicGatewayUrl).toString();
  }
  const message = { text: `Welcome! Choose the organization and agent for this conversation: ${url}\nUse /lobu help for commands.` };
  return body.chat
    ? Response.json({ hostAppDataAction: { chatDataAction: { createMessageAction: { message } } } })
    : Response.json(message);
}
