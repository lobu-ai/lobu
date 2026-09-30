import { createHash } from "node:crypto";
import type { StoredConnection } from "@lobu/core";
import { getDb } from "../../../db/client.js";
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
): Promise<string> {
  const project = (source.config as any).googleChatProjectNumber;
  if (source.platform !== PROVIDER || source.status !== "active" || !source.organizationId ||
    !/^\d+$/.test(project) || !/^spaces\/[\w-]+$/.test(spaceName) || source.id.startsWith(PREFIX)) {
    throw new GoogleChatScopeError();
  }
  const id = googleChatInstallationId(organizationId, project, spaceName);
  const installation = await store.upsert({
    provider: PROVIDER, providerInstance: "cloud", providerAppId: project,
    externalTenantId: spaceName, organizationId, blockCrossOrgTransfer: true,
    metadata: { external_id: id, source_connection_id: source.id, source_organization_id: source.organizationId },
  });
  const projection: StoredConnection = {
    id, organizationId, platform: PROVIDER, status: "active",
    config: { platform: PROVIDER }, settings: { allowGroups: true },
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
): Promise<void> {
  if (!connection.id.startsWith(PREFIX)) return;
  const body = await request.json() as any;
  const eventType = typeof body.type === "string" ? body.type : body.eventType;
  if (eventType !== "REMOVED_FROM_SPACE" && !body.chat?.removedFromSpacePayload) return;
  await resolveGoogleChatRuntime(connection, deps);
  await revokeGoogleChatSpace({ id: connection.id, organizationId: connection.organizationId! }, deps);
  const sql = getDb();
  const slug = runtimeConnectionIdToSlug(connection.id);
  await sql`
    UPDATE connections SET status = 'paused', updated_at = now()
    WHERE organization_id = ${connection.organizationId!} AND slug = ${slug}
      AND deleted_at IS NULL AND credential_mode = 'managed'
  `;
}
