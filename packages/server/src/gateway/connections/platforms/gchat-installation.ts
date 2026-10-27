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
import { appWebhookUrl } from "../../routes/public/app-webhook-url.js";
import { googleChatEventSpace, GoogleChatScopeError } from "./gchat-scope.js";
import type { ChatRuntimeConfig, ChatRuntimeDeps } from "./types.js";

const PREFIX = "gchatinst-";
const PROVIDER = "gchat";

/**
 * The Google Chat app Lobu itself hosts, read from the env names
 * `@chat-adapter/gchat` already documents. Null when this deployment hosts no
 * app: every hosted path then fails closed and BYO projects are unaffected.
 * The key stays gateway-side; it is never projected or handed to a worker.
 */
function platformGoogleChatApp(): { projectNumber: string; credentials: string } | null {
  const projectNumber = process.env.GOOGLE_CHAT_PROJECT_NUMBER?.trim();
  const credentials = process.env.GOOGLE_CHAT_CREDENTIALS?.trim();
  if (!projectNumber || !/^\d+$/.test(projectNumber) || !credentials) return null;
  return { projectNumber, credentials };
}

/** Hosting is derived: an install is hosted iff its project is the hosted app's. */
export function isHostedGoogleChatProject(project: unknown): boolean {
  return typeof project === "string" && project === platformGoogleChatApp()?.projectNumber;
}

function isDirectMessageSpace(space: any): boolean {
  return space?.type === "DM" || space?.spaceType === "DIRECT_MESSAGE";
}

/** Only called after the Chat SDK has authenticated this provider delivery. */
export async function parkGoogleChatSpace(source: StoredConnection, space: string, installer: string, label: string, added: boolean, direct = false): Promise<string> {
  if (!source.organizationId || !/^users\/\d+$/.test(installer)) throw new Error("Google Chat installer identity is missing");
  const project = source.config.googleChatProjectNumber;
  if (isHostedGoogleChatProject(project)) return parkHostedGoogleChatSpace(project, space, installer, label, added, direct);
  const sql = getDb();
  return sql.begin(async (tx) => {
    // Reuse the owner's row as a durable serialization point for pending refs.
    await tx`SELECT id FROM organization WHERE id = ${source.organizationId!} FOR UPDATE`;
    const [pending] = await tx`
      SELECT metadata FROM app_installations WHERE provider = 'gchat' AND provider_instance = 'cloud'
        AND provider_app_id = ${project} AND external_tenant_id = ${space}
        AND status = 'pending' AND metadata->>'source_connection_id' = ${source.id}
        AND metadata->>'installer_id' = ${installer}
        AND metadata->>'claimed' IS DISTINCT FROM 'true' AND metadata->>'removed' IS DISTINCT FROM 'true'
      ORDER BY updated_at DESC, id DESC LIMIT 1
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
      VALUES ('gchat', 'cloud', ${project}, ${space}, 'pending', ${sql.json({
        external_id: ref, source_connection_id: source.id, source_organization_id: source.organizationId,
        installer_id: installer, space_name: label, verified_added: added,
      })})
    `;
    return ref;
  });
}

/**
 * Park a space of the hosted app. Google proves who added the app only on
 * ADDED_TO_SPACE, and in a 1:1 bot DM, whose only human is the installer. A
 * named-space message from anyone else inherits the installer of that space's
 * latest verified addition, or stays unverified (claimable by nobody).
 */
async function parkHostedGoogleChatSpace(project: string, space: string, sender: string, label: string, added: boolean, direct: boolean): Promise<string> {
  if (!/^users\/\d+$/.test(sender)) throw new Error("Google Chat installer identity is missing");
  const sql = getDb();
  return sql.begin(async (tx) => {
    // No owner org exists to lock: serialize on the provider tenant itself.
    await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [`gchat-park:${project}:${space}`]);
    let installer = sender;
    let verified = added || direct;
    if (!verified) {
      const [covering] = await tx`
        SELECT metadata FROM app_installations WHERE provider = 'gchat' AND provider_instance = 'cloud'
          AND provider_app_id = ${project} AND external_tenant_id = ${space}
          AND metadata->>'verified_added' = 'true' AND metadata->>'installer_id' IS NOT NULL
          AND metadata->>'removed' IS DISTINCT FROM 'true'
        ORDER BY updated_at DESC, id DESC LIMIT 1
      `;
      if (covering) {
        installer = covering.metadata.installer_id;
        verified = true;
      }
    }
    const [pending] = await tx`
      SELECT metadata FROM app_installations WHERE provider = 'gchat' AND provider_instance = 'cloud'
        AND provider_app_id = ${project} AND external_tenant_id = ${space}
        AND status = 'pending' AND metadata->>'installer_id' = ${installer}
        AND metadata->>'claimed' IS DISTINCT FROM 'true' AND metadata->>'removed' IS DISTINCT FROM 'true'
      ORDER BY updated_at DESC, id DESC LIMIT 1
    `;
    if (pending) {
      if (verified && !pending.metadata.verified_added) {
        await tx`UPDATE app_installations SET metadata = metadata || '{"verified_added":true}'::jsonb, updated_at = now()
          WHERE provider = 'gchat' AND metadata->>'external_id' = ${pending.metadata.external_id}`;
      }
      return pending.metadata.external_id;
    }
    const ref = `gchatclaim-${randomUUID()}`;
    await tx`
      INSERT INTO app_installations (provider, provider_instance, provider_app_id, external_tenant_id, status, metadata)
      VALUES ('gchat', 'cloud', ${project}, ${space}, 'pending', ${sql.json({
        external_id: ref, installer_id: installer, space_name: label, verified_added: verified,
      })})
    `;
    return ref;
  });
}

/** Both projection and lookup use the same server-owned namespace. */
export function googleChatInstallationId(org: string, project: string, space: string): string {
  return PREFIX + createHash("sha256").update(JSON.stringify([org, project, space])).digest("hex");
}

/**
 * The caller must verify the installer and chosen org before activation. A
 * `"hosted"` space belongs to the hosted app, so its install names no source.
 */
export async function activateGoogleChatSpace(
  store: AppInstallationStore,
  source: StoredConnection | "hosted",
  organizationId: string,
  spaceName: string,
  confirmMove = false,
  createdBy?: string,
): Promise<string> {
  const hosted = source === "hosted";
  const project = hosted ? platformGoogleChatApp()?.projectNumber : (source.config as any).googleChatProjectNumber;
  if (!hosted && (source.platform !== PROVIDER || source.status !== "active" || !source.organizationId ||
    source.id.startsWith(PREFIX))) {
    throw new GoogleChatScopeError();
  }
  if (typeof project !== "string" || !/^\d+$/.test(project) || !/^spaces\/[\w-]+$/.test(spaceName)) {
    throw new GoogleChatScopeError();
  }
  const id = googleChatInstallationId(organizationId, project, spaceName);
  const installation = await store.upsert({
    provider: PROVIDER, providerInstance: "cloud", providerAppId: project,
    externalTenantId: spaceName, organizationId, blockCrossOrgTransfer: !confirmMove,
    revokeConnectionsOnTransfer: { errorMessage: "Google Chat space moved to another organization" },
    metadata: hosted ? { external_id: id }
      : { external_id: id, source_connection_id: source.id, source_organization_id: source.organizationId },
  });
  const projection: StoredConnection = {
    id, organizationId, createdBy, platform: PROVIDER, status: "active",
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
  const hosted = platformGoogleChatApp();
  if (hosted && install.providerAppId === hosted.projectNumber) {
    // The hosted app's key never enters a tenant vault or the projection.
    const config = {
      platform: PROVIDER, credentials: hosted.credentials,
      googleChatProjectNumber: hosted.projectNumber, disableSignatureVerification: false,
    } as any;
    const revision = createHash("sha256").update(JSON.stringify([
      connection.updatedAt, install.id, install.updatedAt, config,
    ])).digest("hex");
    return {
      config, revision, scope: install.externalTenantId, stateKey: connection.id,
      // The same generator the app-webhook router registers its audience with.
      webhookUrl: deps.publicGatewayUrl ? appWebhookUrl(deps.publicGatewayUrl, PROVIDER) : undefined,
    };
  }
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
  // A hosted space names no source: any transport of the hosted project may
  // carry it, and the installed adapter still verifies Google's token itself.
  if (row.status !== "active" || !isHostedGoogleChatProject(project) && row.metadata.source_connection_id !== connection.id) {
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

/**
 * Pause one space's projection, then revoke its install; re-adding the app
 * claims it again. Revoking last keeps a failed release retryable: the install
 * stays active, so the next attempt finds it.
 */
async function releaseGoogleChatSpace(
  organizationId: string,
  project: string,
  space: string,
  deps: ChatRuntimeDeps,
): Promise<void> {
  const id = googleChatInstallationId(organizationId, project, space);
  await getDb()`UPDATE connections SET status = 'paused', updated_at = now()
    WHERE organization_id = ${organizationId} AND slug = ${runtimeConnectionIdToSlug(id)}
      AND deleted_at IS NULL AND credential_mode = 'managed'`;
  await revokeGoogleChatSpace({ id, organizationId }, deps);
}

/**
 * A deleted bot connection releases the spaces installed through it. Each
 * space's install names its bot connection, and routing refuses any other, so
 * a space left active would stay unreachable even after the bot is set up
 * again; released, re-adding the app runs the normal claim.
 */
export async function releaseGoogleChatSource(
  source: { id: string; organizationId: string },
  deps: ChatRuntimeDeps,
): Promise<void> {
  if (source.id.startsWith(PREFIX)) return;
  const spaces = await getDb()<{ organization_id: string; provider_app_id: string; external_tenant_id: string }>`
    SELECT organization_id, provider_app_id, external_tenant_id FROM app_installations
    WHERE provider = ${PROVIDER} AND provider_instance = 'cloud' AND status = 'active'
      AND metadata->>'source_connection_id' = ${source.id}
      AND metadata->>'source_organization_id' = ${source.organizationId}
  `;
  for (const space of spaces) {
    // Hosted spaces only ever passed through a legacy source; the hosted app
    // keeps serving them after that source is deleted.
    if (isHostedGoogleChatProject(space.provider_app_id)) continue;
    await releaseGoogleChatSpace(space.organization_id, space.provider_app_id, space.external_tenant_id, deps);
  }
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
    let project = connection.config.googleChatProjectNumber;
    let sourceId = connection.id;
    if (connection.id.startsWith(PREFIX)) {
      await resolveGoogleChatRuntime(connection, deps);
      const install = await deps.getAppInstallationStore().resolveByExternalId(PROVIDER, connection.id);
      if (!install) throw new GoogleChatScopeError();
      project = install.providerAppId;
      sourceId = install.metadata.source_connection_id;
    }
    await removeGoogleChatSpace(project, space, isHostedGoogleChatProject(project) ? null : sourceId, deps);
    return;
  }
  // An unclaimed hosted space belongs to nobody yet: it never reaches the
  // legacy transport's own agent or Automations, only the claim link.
  if (!scoped && isHostedGoogleChatProject(connection.config.googleChatProjectNumber)) {
    return setupGoogleChatSpace(connection.config.googleChatProjectNumber, body, added, deps, connection);
  }
  if (!added && connection.agentId) return;
  const linked = !added && await new AutomationSubscriptionService().channelHasMessageSubscription(
    connection.id, `gchat:${space}`, connection.organizationId!, { crossOrganization: (connection.settings as ConnectionSettings).previewMode === true, teamId: space },
  );
  if (linked) return;
  if (scoped) {
    const spaceData = googleChatEventSpaceData(body);
    const [org] = await getDb()`SELECT slug FROM organization WHERE id = ${connection.organizationId!}`;
    if (!org) throw new GoogleChatScopeError();
    const next = claimContinuation(org.slug, { platform: PROVIDER, connection: runtimeConnectionIdToSlug(connection.id), channelId: `gchat:${space}`, teamId: space, label: spaceData?.displayName || space });
    return googleChatSetupReply(body, new URL(next.nextUrl!, deps.publicGatewayUrl).toString());
  }
  return setupGoogleChatSpace(connection.config.googleChatProjectNumber, body, added, deps, connection);
}

/**
 * Invalidate setup refs under the claim's row lock before finding the current
 * active owner; a claim/move that wins first is revoked afterwards. A BYO
 * source only reaches its own rows; the hosted app (null source) reaches all.
 */
async function removeGoogleChatSpace(project: string, space: string, sourceId: string | null, deps: ChatRuntimeDeps): Promise<void> {
  const sql = getDb();
  const sourced = sourceId === null ? sql`` : sql`AND metadata->>'source_connection_id' = ${sourceId}`;
  await sql`UPDATE app_installations SET metadata = metadata || '{"removed":true}'::jsonb, updated_at = now()
    WHERE provider = 'gchat' AND provider_app_id = ${project} AND external_tenant_id = ${space}
      ${sourced} AND status = 'pending'`;
  const [active] = await sql`SELECT organization_id FROM app_installations
    WHERE provider = 'gchat' AND provider_instance = 'cloud' AND provider_app_id = ${project}
      AND external_tenant_id = ${space} AND status = 'active' ${sourced} LIMIT 1`;
  if (active) await releaseGoogleChatSpace(active.organization_id, project, space, deps);
}

function googleChatEventSpaceData(body: any): any {
  return body.space ?? body.chat?.addedToSpacePayload?.space ?? body.chat?.messagePayload?.space ?? body.message?.space;
}

/** Park a verified unclaimed space and answer with its claim link. */
async function setupGoogleChatSpace(
  project: string,
  body: any,
  added: boolean,
  deps: ChatRuntimeDeps,
  source?: StoredConnection,
): Promise<Response> {
  const space = googleChatEventSpace(body);
  const spaceData = googleChatEventSpaceData(body);
  const installer = body.user?.name ?? body.chat?.user?.name ?? body.message?.sender?.name ?? body.chat?.messagePayload?.message?.sender?.name;
  if (typeof installer !== "string" || !/^users\/\d+$/.test(installer)) return new Response("Google Chat installer identity is missing", { status: 400 });
  const label = spaceData?.displayName || space;
  const direct = isDirectMessageSpace(spaceData);
  const ref = source
    ? await parkGoogleChatSpace(source, space, installer, label, added, direct)
    : await parkHostedGoogleChatSpace(project, space, installer, label, added, direct);
  return googleChatSetupReply(body, new URL(`/connector/gchat/connection?${new URLSearchParams({ ref })}`, deps.publicGatewayUrl).toString());
}

function googleChatSetupReply(body: any, url: string): Response {
  const message = { text: `Welcome! Choose the organization and agent for this conversation: ${url}\nUse /lobu help for commands.` };
  return body.chat
    ? Response.json({ hostAppDataAction: { chatDataAction: { createMessageAction: { message } } } })
    : Response.json(message);
}

/**
 * Chat delivery for the hosted app's declared app webhook. The generic engine
 * has already verified Google's token; this only routes by space. A claimed
 * space goes to its own installation, whose adapter verifies again before it
 * dispatches; any other space only ever gets the claim link.
 */
export async function handleGoogleChatAppWebhook(
  request: Request,
  deps: ChatRuntimeDeps,
  deliver: (connectionId: string) => Promise<Response>,
): Promise<Response> {
  const hosted = platformGoogleChatApp();
  if (!hosted) return Response.json({ error: "Google Chat app is not configured" }, { status: 404 });
  let body: any;
  let space: string;
  try {
    body = await request.clone().json();
    space = googleChatEventSpace(body);
  } catch {
    return new Response("Invalid Google Chat space", { status: 400 });
  }
  const [active] = await getDb()`
    SELECT organization_id FROM app_installations
    WHERE provider = ${PROVIDER} AND provider_instance = 'cloud'
      AND provider_app_id = ${hosted.projectNumber} AND external_tenant_id = ${space} AND status = 'active'
    LIMIT 1
  `;
  if (active) return deliver(googleChatInstallationId(active.organization_id, hosted.projectNumber, space));
  const eventType = typeof body.type === "string" ? body.type : body.eventType;
  if (eventType === "REMOVED_FROM_SPACE" || body.chat?.removedFromSpacePayload) {
    await removeGoogleChatSpace(hosted.projectNumber, space, null, deps);
    return Response.json({});
  }
  const added = eventType === "ADDED_TO_SPACE" || !!body.chat?.addedToSpacePayload;
  return setupGoogleChatSpace(hosted.projectNumber, body, added, deps);
}
