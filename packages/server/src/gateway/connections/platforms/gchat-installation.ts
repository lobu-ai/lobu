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
  slugToRuntimeConnectionId,
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
 * The Google Chat app a space belongs to, decided once where a delivery, setup
 * reference or install enters, then passed down. A BYO app is served by its
 * `source` bot connection and reaches only rows naming that source. The app
 * Lobu hosts names no source: its key stays gateway-side, never projected or
 * handed to a worker, and it serves its project through any transport.
 */
export type GoogleChatApp =
  | { project: string; source: StoredConnection }
  | { project: string; source: null; credentials: string };

let hostedApp: GoogleChatApp | null | undefined;

/**
 * The hosted app, from the env names `@chat-adapter/gchat` already documents.
 * Null when this deployment hosts none: every hosted path then fails closed.
 */
function hostedGoogleChatApp(): GoogleChatApp | null {
  if (hostedApp === undefined) {
    const project = process.env.GOOGLE_CHAT_PROJECT_NUMBER?.trim();
    const credentials = process.env.GOOGLE_CHAT_CREDENTIALS?.trim();
    hostedApp = project && /^\d+$/.test(project) && credentials ? { project, source: null, credentials } : null;
  }
  return hostedApp;
}

/** Test-only: re-read the hosted app's env after a test changes it. */
export function resetHostedGoogleChatAppForTests(): void {
  hostedApp = undefined;
}

/** A BYO transport serves its own project, unless that project is the hosted app's. */
export function googleChatTransportApp(transport: StoredConnection): GoogleChatApp {
  const project = String(transport.config.googleChatProjectNumber);
  const hosted = hostedGoogleChatApp();
  return hosted?.project === project ? hosted : { project, source: transport };
}

/**
 * The app behind an install or setup reference: the hosted app owns its
 * project outright; any other project needs the BYO source the row names,
 * still active and still serving that project.
 */
export async function googleChatInstallApp(
  project: string,
  metadata: { source_connection_id?: unknown; source_organization_id?: unknown },
  getConnection: (id: string) => Promise<StoredConnection | null>,
): Promise<GoogleChatApp | null> {
  const hosted = hostedGoogleChatApp();
  if (hosted?.project === project) return hosted;
  const sourceId = metadata.source_connection_id;
  if (typeof sourceId !== "string" || sourceId.startsWith(PREFIX)) return null;
  const source = await getConnection(sourceId);
  if (!source || source.status !== "active" || source.platform !== PROVIDER || !source.organizationId ||
    source.organizationId !== metadata.source_organization_id ||
    source.config.googleChatProjectNumber !== project) return null;
  return { project, source };
}

/** The source fields an install or setup reference records; the hosted app records none. */
function sourceMetadata(app: GoogleChatApp) {
  return app.source ? { source_connection_id: app.source.id, source_organization_id: app.source.organizationId } : {};
}

/**
 * Park an unclaimed space behind a setup reference. Only called after Google's
 * token was verified. Google proves who added the app on ADDED_TO_SPACE. For
 * the hosted app a 1:1 bot DM is proof too (its only human is the installer),
 * and a named-space message inherits the installer of that space's latest
 * verified addition, or stays unverified (claimable by nobody).
 * A pending reference never expires: it is not a bearer secret, because a claim
 * still needs the claimant's linked Google account to be the verified installer
 * (`gchat-claim.ts`), so an old link stays usable for the person who added the app.
 * `announce` is true when this call created the reference, made it claimable,
 * or records a fresh addition of the app; the transaction lock decides it, so
 * concurrent messages on any replica announce one link once.
 */
export async function parkGoogleChatSpace(app: GoogleChatApp, space: string, sender: string, label: string, added: boolean, direct = false): Promise<{ ref: string; announce: boolean }> {
  if ((app.source && !app.source.organizationId) || !/^users\/\d+$/.test(sender)) throw new Error("Google Chat installer identity is missing");
  const sourceId = app.source?.id ?? null;
  const sql = getDb();
  return sql.begin(async (tx) => {
    let installer = sender;
    let verified = added;
    if (app.source) {
      // Reuse the owner's row as a durable serialization point for pending refs.
      await tx`SELECT id FROM organization WHERE id = ${app.source.organizationId!} FOR UPDATE`;
    } else {
      // No owner org exists to lock: serialize on the provider tenant itself.
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [`gchat-park:${app.project}:${space}`]);
      const [covering] = added || direct ? [] : await tx`
        SELECT metadata FROM app_installations WHERE provider = 'gchat' AND provider_instance = 'cloud'
          AND provider_app_id = ${app.project} AND external_tenant_id = ${space}
          AND metadata->>'verified_added' = 'true' AND metadata->>'installer_id' IS NOT NULL
          AND metadata->>'removed' IS DISTINCT FROM 'true'
        ORDER BY updated_at DESC, id DESC LIMIT 1
      `;
      if (covering) installer = covering.metadata.installer_id;
      verified = added || direct || !!covering;
    }
    const [pending] = await tx`
      SELECT metadata FROM app_installations WHERE provider = 'gchat' AND provider_instance = 'cloud'
        AND provider_app_id = ${app.project} AND external_tenant_id = ${space}
        AND status = 'pending' AND (${sourceId}::text IS NULL OR metadata->>'source_connection_id' = ${sourceId})
        AND metadata->>'installer_id' = ${installer}
        AND metadata->>'claimed' IS DISTINCT FROM 'true' AND metadata->>'removed' IS DISTINCT FROM 'true'
      ORDER BY updated_at DESC, id DESC LIMIT 1
    `;
    if (pending) {
      const upgraded = verified && !pending.metadata.verified_added;
      // Only migrates legacy rows that stored the `spaces/…` resource id as
      // their name; a stored real room name is kept.
      const relabeled = pending.metadata.space_name === space;
      if (upgraded || relabeled) {
        await tx`UPDATE app_installations SET metadata = metadata || ${sql.json({
          ...(upgraded ? { verified_added: true } : {}),
          ...(relabeled ? { space_name: label } : {}),
        })}, updated_at = now()
          WHERE provider = 'gchat' AND metadata->>'external_id' = ${pending.metadata.external_id}`;
      }
      return { ref: pending.metadata.external_id, announce: upgraded || added };
    }
    const ref = `gchatclaim-${randomUUID()}`;
    await tx`
      INSERT INTO app_installations (provider, provider_instance, provider_app_id, external_tenant_id, status, metadata)
      VALUES ('gchat', 'cloud', ${app.project}, ${space}, 'pending', ${sql.json({
        external_id: ref, ...sourceMetadata(app), installer_id: installer, space_name: label, verified_added: verified,
      })})
    `;
    return { ref, announce: true };
  });
}

/** Both projection and lookup use the same server-owned namespace. */
export function googleChatInstallationId(org: string, project: string, space: string): string {
  return PREFIX + createHash("sha256").update(JSON.stringify([org, project, space])).digest("hex");
}

/**
 * The caller must verify the installer and chosen org before activation.
 * `label` is what people call the space; the projection's name shows it.
 */
export async function activateGoogleChatSpace(
  store: AppInstallationStore,
  app: GoogleChatApp,
  organizationId: string,
  spaceName: string,
  confirmMove = false,
  createdBy?: string,
  label = spaceName,
): Promise<string> {
  const { project, source } = app;
  if ((source && (source.platform !== PROVIDER || source.status !== "active" || !source.organizationId ||
    source.id.startsWith(PREFIX))) || !/^\d+$/.test(project) || !/^spaces\/[\w-]+$/.test(spaceName)) {
    throw new GoogleChatScopeError();
  }
  const id = googleChatInstallationId(organizationId, project, spaceName);
  const installation = await store.upsert({
    provider: PROVIDER, providerInstance: "cloud", providerAppId: project,
    externalTenantId: spaceName, organizationId, blockCrossOrgTransfer: !confirmMove,
    revokeConnectionsOnTransfer: { errorMessage: "Google Chat space moved to another organization" },
    metadata: { external_id: id, ...sourceMetadata(app) },
  });
  const projection: StoredConnection = {
    id, organizationId, createdBy, platform: PROVIDER, status: "active",
    config: { platform: PROVIDER, installation_ref: String(installation.id) }, settings: { allowGroups: true },
    metadata: { teamId: spaceName, teamName: label },
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

/** The install behind a `gchatinst-` projection and its app, or a scope error. */
async function resolveGoogleChatInstall(connection: StoredConnection, deps: ChatRuntimeDeps) {
  const install = await deps.getAppInstallationStore().resolveByExternalId(PROVIDER, connection.id);
  if (!install || connection.platform !== PROVIDER || install.status !== "active" || install.organizationId !== connection.organizationId ||
    connection.status === "stopped" || install.providerInstance !== "cloud" ||
    connection.id !== googleChatInstallationId(install.organizationId, install.providerAppId, install.externalTenantId) ||
    connection.metadata?.teamId !== install.externalTenantId) throw new GoogleChatScopeError();
  const app = await googleChatInstallApp(install.providerAppId, install.metadata, deps.getConnection);
  if (!app) throw new GoogleChatScopeError();
  return { install, app };
}

export async function resolveGoogleChatRuntime(
  connection: StoredConnection,
  deps: ChatRuntimeDeps,
): Promise<ChatRuntimeConfig | undefined> {
  if (!connection.id.startsWith(PREFIX)) return undefined;
  const { install, app } = await resolveGoogleChatInstall(connection, deps);
  const config = {
    ...(app.source
      ? await deps.resolveSecrets(app.source)
      // Lobu's published Chat app registers its /lobu wrapper as command 1.
      // BYO projects keep the command mapping from their own source config.
      : { platform: PROVIDER, credentials: app.credentials, googleChatProjectNumber: app.project, helpCommandId: "1" }),
    disableSignatureVerification: false,
  } as any;
  // The hosted app's audience comes from the same generator the app-webhook
  // router registers with; a BYO app keeps its source's own webhook URL.
  const base = deps.publicGatewayUrl;
  // Google signs each delivery for the URL it was sent to, and the hosted app
  // serves its project through any transport: until its Chat app config is
  // repointed, a claimed space still arrives through a legacy transport.
  const alternateWebhookUrls = !base || app.source ? [] : await hostedTransportUrls(app.project, base);
  // Secret-only rotations need not bump the source row. Keep this opaque and
  // gateway-local; never log it or expose it in the connection projection.
  const revision = createHash("sha256").update(JSON.stringify([
    connection.updatedAt, install.id, install.updatedAt, app.source?.updatedAt, config, alternateWebhookUrls,
  ])).digest("hex");
  return {
    config, revision, scope: install.externalTenantId, stateKey: connection.id,
    webhookUrl: !base ? undefined
      : app.source ? transportWebhookUrl(base, app.source.id) : appWebhookUrl(base, PROVIDER),
    alternateWebhookUrls,
  };
}

function transportWebhookUrl(base: string, transportId: string): string {
  return `${base}/api/v1/webhooks/${transportId}`;
}

/** Webhook URLs of the active bot connections that carry the hosted project. */
async function hostedTransportUrls(project: string, base: string): Promise<string[]> {
  const rows = await getDb()<{ slug: string }>`
    SELECT slug FROM connections
    WHERE connector_key = ${PROVIDER} AND credential_mode IS NOT NULL AND deleted_at IS NULL
      AND status = 'active' AND config->>'googleChatProjectNumber' = ${project}
      AND slug NOT LIKE ${`${runtimeConnectionIdToSlug(PREFIX)}%`}
    ORDER BY slug
  `;
  return rows.map((row) => transportWebhookUrl(base, slugToRuntimeConnectionId(row.slug)));
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
  let body: any;
  let space: string;
  try {
    body = await request.clone().json();
    space = googleChatEventSpace(body);
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
  // Pending setup remains on the source's verified adapter, where dispatch is
  // gated. Reinstall lifecycle deliveries must also reach that verifier.
  const { added } = googleChatLifecycle(body);
  if (row.status === "pending" && !row.metadata.removed || row.status !== "active" && added) return undefined;
  // A hosted space names no source: any transport of the hosted project may
  // carry it, and the installed adapter still verifies Google's token itself.
  const { source } = googleChatTransportApp(connection);
  if (row.status !== "active" || source && row.metadata.source_connection_id !== source.id) {
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
      -- Hosted spaces only ever passed through a legacy source; the hosted
      -- app keeps serving them after that source is deleted.
      AND provider_app_id IS DISTINCT FROM ${hostedGoogleChatApp()?.project ?? null}
  `;
  for (const space of spaces) {
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

function googleChatLifecycle(body: any): { added: boolean; removed: boolean } {
  const eventType = typeof body.type === "string" ? body.type : body.eventType;
  return {
    added: eventType === "ADDED_TO_SPACE" || !!body.chat?.addedToSpacePayload,
    removed: eventType === "REMOVED_FROM_SPACE" || !!body.chat?.removedFromSpacePayload,
  };
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
  const { added, removed } = googleChatLifecycle(body);
  const space = googleChatEventSpace(body);
  if (removed) {
    const app = scoped ? (await resolveGoogleChatInstall(connection, deps)).app : googleChatTransportApp(connection);
    await removeGoogleChatSpace(app, space, deps);
    return;
  }
  if (scoped) {
    if (await alreadyServed(connection, space, added)) return;
    // Until an Automation routes the space, its setup link is sent once; later
    // messages get an empty reply, never dispatch. Re-adding the app or
    // invoking a command sends it again, as for a pending space.
    const firstAnnouncement = await firstContinuationAnnouncement(connection.id);
    if (!firstAnnouncement && !added && !isGoogleChatCommand(body)) return Response.json({});
    const [org] = await getDb()`SELECT slug FROM organization WHERE id = ${connection.organizationId!}`;
    if (!org) throw new GoogleChatScopeError();
    const next = claimContinuation(org.slug, { platform: PROVIDER, connection: runtimeConnectionIdToSlug(connection.id), channelId: `gchat:${space}`, teamId: space, label: googleChatSpaceLabel(googleChatEventSpaceData(body)) });
    return googleChatSetupReply(body, new URL(next.nextUrl!, deps.publicGatewayUrl).toString());
  }
  const app = googleChatTransportApp(connection);
  // An unclaimed hosted space belongs to nobody yet: it never reaches the
  // legacy transport's own agent or Automations, only the claim link.
  if (app.source && await alreadyServed(connection, space, added)) return;
  return setupGoogleChatSpace(app, body, added, deps);
}

/** A delivery the connection's own agent or a linked Automation serves needs no setup. */
async function alreadyServed(connection: StoredConnection, space: string, added: boolean): Promise<boolean> {
  if (added) return false;
  if (connection.agentId) return true;
  return new AutomationSubscriptionService().channelHasMessageSubscription(
    connection.id, `gchat:${space}`, connection.organizationId!, { crossOrganization: (connection.settings as ConnectionSettings).previewMode === true, teamId: space },
  );
}

/**
 * Whether this delivery is the first to announce a claimed space's setup link.
 * One conditional update under the install row's lock decides it, so concurrent
 * messages on any replica announce it once. `updated_at` is left alone: it
 * feeds the runtime revision, and this bookkeeping must not rebuild the adapter.
 */
async function firstContinuationAnnouncement(connectionId: string): Promise<boolean> {
  const rows = await getDb()`UPDATE app_installations SET metadata = metadata || '{"continuation_announced":true}'::jsonb
    WHERE provider = ${PROVIDER} AND metadata->>'external_id' = ${connectionId} AND status = 'active'
      AND metadata->>'continuation_announced' IS DISTINCT FROM 'true'
    RETURNING id`;
  return rows.length > 0;
}

/**
 * Invalidate setup refs under the claim's row lock before finding the current
 * active owner; a claim/move that wins first is revoked afterwards. A BYO app
 * reaches only its own source's rows; the hosted app reaches all of them.
 */
async function removeGoogleChatSpace(app: GoogleChatApp, space: string, deps: ChatRuntimeDeps): Promise<void> {
  const sql = getDb();
  const sourceId = app.source?.id ?? null;
  await sql`UPDATE app_installations SET metadata = metadata || '{"removed":true}'::jsonb, updated_at = now()
    WHERE provider = 'gchat' AND provider_app_id = ${app.project} AND external_tenant_id = ${space}
      AND (${sourceId}::text IS NULL OR metadata->>'source_connection_id' = ${sourceId}) AND status = 'pending'`;
  const [active] = await sql`SELECT organization_id FROM app_installations
    WHERE provider = 'gchat' AND provider_instance = 'cloud' AND provider_app_id = ${app.project}
      AND external_tenant_id = ${space} AND status = 'active'
      AND (${sourceId}::text IS NULL OR metadata->>'source_connection_id' = ${sourceId}) LIMIT 1`;
  if (active) await releaseGoogleChatSpace(active.organization_id, app.project, space, deps);
}

function googleChatEventSpaceData(body: any): any {
  return body.space ?? body.chat?.addedToSpacePayload?.space ?? body.chat?.messagePayload?.space ??
    body.chat?.appCommandPayload?.space ?? body.message?.space;
}

function isGoogleChatDirectSpace(spaceData: any): boolean {
  return spaceData?.type === "DM" || spaceData?.spaceType === "DIRECT_MESSAGE";
}

/**
 * What a person calls the space: its own name, or for the app's 1:1 DM (which
 * Google leaves unnamed) the conversation they are looking at. Never the raw
 * `spaces/…` resource, which means nothing to them.
 */
function googleChatSpaceLabel(spaceData: any): string {
  if (typeof spaceData?.displayName === "string" && spaceData.displayName.trim()) return spaceData.displayName.trim();
  return isGoogleChatDirectSpace(spaceData) ? "your direct message with Lobu" : "your Google Chat conversation";
}

/**
 * Whether the person explicitly invoked one of the app's commands, which in an
 * unclaimed space means "show me setup again". Read off Google's structured
 * command envelopes (classic slash command, annotation, or Workspace Add-on
 * app command), never off the message text.
 */
function isGoogleChatCommand(body: any): boolean {
  const message = body.message ?? body.chat?.messagePayload?.message;
  return body.type === "APP_COMMAND" || body.eventType === "APP_COMMAND" || !!body.appCommandMetadata ||
    !!body.chat?.appCommandPayload || !!message?.slashCommand ||
    (Array.isArray(message?.annotations) && message.annotations.some((annotation: any) => annotation?.type === "SLASH_COMMAND"));
}

/**
 * Park a verified unclaimed space and answer with its claim link — once per
 * pending setup. Later messages (the "hi" right after adding the app) get an
 * empty reply instead of a duplicate welcome; re-adding the app or invoking a
 * command re-sends the same link.
 */
async function setupGoogleChatSpace(app: GoogleChatApp, body: any, added: boolean, deps: ChatRuntimeDeps): Promise<Response> {
  const space = googleChatEventSpace(body);
  const spaceData = googleChatEventSpaceData(body);
  const installer = body.user?.name ?? body.chat?.user?.name ?? body.message?.sender?.name ?? body.chat?.messagePayload?.message?.sender?.name;
  if (typeof installer !== "string" || !/^users\/\d+$/.test(installer)) return new Response("Google Chat installer identity is missing", { status: 400 });
  const { ref, announce } = await parkGoogleChatSpace(app, space, installer, googleChatSpaceLabel(spaceData), added, isGoogleChatDirectSpace(spaceData));
  // A Response either way: an unclaimed space never falls through to a source's agent.
  if (!announce && !isGoogleChatCommand(body)) return Response.json({});
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
  const app = hostedGoogleChatApp();
  if (!app) return Response.json({ error: "Google Chat app is not configured" }, { status: 404 });
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
      AND provider_app_id = ${app.project} AND external_tenant_id = ${space} AND status = 'active'
    LIMIT 1
  `;
  if (active) return deliver(googleChatInstallationId(active.organization_id, app.project, space));
  const { added, removed } = googleChatLifecycle(body);
  if (removed) {
    await removeGoogleChatSpace(app, space, deps);
    return Response.json({});
  }
  return setupGoogleChatSpace(app, body, added, deps);
}
