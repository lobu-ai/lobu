/**
 * Connector intent-search for `search_sdk`.
 *
 * A fresh agent asked to "connect a website" searches by INTENT ("website",
 * "crawl a web page"), not by the exact SDK method path — and a connector may be
 * installed for this org yet absent from the global catalog, so it's easy to
 * wrongly conclude a source is unsupported (the agent-discovery audit's RSS-
 * instead-of-Website failure). This surfaces the matching live connector — with
 * its feed keys and the exact connect→feed→trigger lifecycle — directly in
 * `search_sdk` results, so one discovery call finds the capability whether it's
 * a method or a connector (the "one catalog" idea). Read-only; never emits
 * credentials or raw connector config.
 *
 * Reuses the existing admin handlers (same functions the sandbox namespaces
 * wrap) — no new data path, no cross-replica state. Handlers are injectable so
 * tests supply fakes without `mock.module` (process-global in Bun, it corrupts
 * sibling suites).
 */

import { manageCatalog } from './admin/manage_catalog';
import { manageConnections } from './admin/manage_connections';
import { resolveCloudOrigin } from '../connect/cloud-credential';
import { publicSetupOptions, type SetupOptionsDeps } from '../connect/setup-options';
import { handleSetupOptions } from './admin/manage_connections/handlers/setup-options';
import type { ConnectionSetupOptions } from '@lobu/core/contracts/tools/manage-connections';
import type { Env } from '../index';
import type { AccountToolContext } from './registry';
import { requireWorkspaceContext } from './access-control';
import { getWorkspaceProvider } from '../workspace';
import type { OrgInfo } from '../workspace/types';
import { METHOD_METADATA } from '../sandbox/method-metadata';
import { resolveSdkAccessGuidance } from '../sandbox/sdk-method-access';
import { listLiveGrantedMemberWorkspaces } from '../auth/oauth/workspace-grants';

export interface ConnectorDiscoveryDeps {
  manageCatalog: typeof manageCatalog;
  manageConnections: typeof manageConnections;
  setupOptions: typeof handleSetupOptions;
  listPublicOrganizations: () => Promise<OrgInfo[]>;
  listOrganizations: (userId: string) => Promise<OrgInfo[]>;
  listLiveGrantedOrganizations: (
    userId: string,
    grantedOrganizationIds: readonly string[]
  ) => ReturnType<typeof listLiveGrantedMemberWorkspaces>;
}

const DEFAULT_DEPS: ConnectorDiscoveryDeps = {
  manageCatalog,
  manageConnections,
  setupOptions: handleSetupOptions,
  listPublicOrganizations: () => getWorkspaceProvider().listOrganizations(),
  listOrganizations: async (userId) =>
    getWorkspaceProvider().listOrganizations(undefined, userId),
  listLiveGrantedOrganizations: async (userId, grantedOrganizationIds) =>
    listLiveGrantedMemberWorkspaces({ userId, grantedOrganizationIds }),
};

function asArray<T = Record<string, unknown>>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Feed keys are the top-level keys of a connector's feeds_schema object. */
function feedKeysOf(detail: unknown): string[] | undefined {
  const feeds = (detail as { feeds_schema?: unknown } | null)?.feeds_schema;
  if (!feeds || typeof feeds !== 'object' || Array.isArray(feeds)) return undefined;
  const keys = Object.keys(feeds as Record<string, unknown>);
  return keys.length > 0 ? keys : undefined;
}

/** Connector lines this search returns, and the ceiling on per-line enrichment. */
const MAX_LINES = 8;

/**
 * Token-aware match: an agent rarely searches the bare connector name — it
 * searches a phrase like "website connect source" or "crawl a web page". Match
 * when ANY meaningful token of the query hits a connector field, so a multi-word
 * query still finds the connector. Short/stopword tokens are dropped so common
 * filler words don't match every connector.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'my', 'to', 'of', 'in', 'and', 'or', 'for', 'with', 'into',
  'connect', 'connector', 'source', 'data', 'get', 'add', 'set', 'up', 'from',
  'search', 'ingest', 'collect', 'sync', 'read', 'content', 'page', 'pages',
]);
function matchesQueryTokens(query: string, ...fields: Array<string | null | undefined>): boolean {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  if (tokens.length === 0) return false;
  const hay = fields.filter((f): f is string => typeof f === 'string').map((f) => f.toLowerCase());
  return tokens.some((t) => hay.some((f) => f.includes(t)));
}

/** Render a lifecycle only when every method in it is callable by this caller. */
function lifecycleForCaller(
  methodPaths: readonly string[],
  lifecycle: string,
  ctx: AccountToolContext
): string {
  // Whole metadata, not the bare `access` marker: a connector lifecycle
  // includes `feeds.trigger`, an `external` method whose manage_feeds action is
  // admin-enforced. Dropping its `enforcedTier` reported the lifecycle as
  // operate-tier and told an mcp:write caller to proceed into a hard rejection.
  const accesses = methodPaths.map((path) => {
    const meta = METHOD_METADATA[path];
    if (!meta) throw new Error(`Missing SDK metadata for lifecycle method: ${path}`);
    return meta;
  });
  const guidance = resolveSdkAccessGuidance(accesses, ctx.memberRole, ctx.scopes);
  if (guidance.available) return lifecycle;
  if (guidance.progressivelyAuthorizable) {
    return `${lifecycle} ${guidance.instruction ?? ""}`.trim();
  }
  return guidance.instruction ?? lifecycle;
}

/**
 * Search live connectors (installed + global catalog) for an intent keyword,
 * returning rendered lines in `search_sdk`'s result shape. Installed connectors
 * come first (ready to configure, or already configured), then catalog offerings
 * (installable). Empty for a blank query or no match.
 */
export async function searchLiveConnectors(
  query: string,
  env: Env,
  ctx: AccountToolContext,
  deps: ConnectorDiscoveryDeps = DEFAULT_DEPS
): Promise<string[]> {
  const { manageCatalog, manageConnections } = deps;
  const q = query.trim();
  if (!q) return [];
  // Connector inventory is workspace-member context, not anonymous public data.
  // `search_sdk` is publicly readable (method docs are org-independent), so an
  // anonymous session on a public workspace can reach here — it must NOT be
  // handed the org's connectors. Gate on an authenticated user only: the
  // downstream connections-list handler applies the real per-user visibility
  // (anon → org-visible only; member → own; admin → all), and `memberRole` is
  // NOT reliably populated on scoped `/mcp/{slug}` sessions, so gating on it
  // would wrongly suppress discovery for a legitimate member.
  if (!ctx.userId) return [];
  if (!ctx.organizationId) {
    if (!ctx.allowCrossOrg || !Array.isArray(ctx.grantedOrganizationIds)) return [];
    const workspaces = await deps.listLiveGrantedOrganizations(ctx.userId, ctx.grantedOrganizationIds);
    const matches = await Promise.all(workspaces.map(async (workspace) => {
      const hits = await searchLiveConnectors(query, env, {
        ...ctx, organizationId: workspace.id, memberRole: workspace.role,
      }, deps);
      return hits.map((hit) => `Workspace ${workspace.slug}: use await client.org(${JSON.stringify(workspace.slug)}); the lifecycle below assumes that selected client. ${hit}`);
    }));
    return matches.flat();
  }
  const workspaceCtx = requireWorkspaceContext(ctx);
  const lines: string[] = [];
  try {
    const [inst, cat, organizations] = await Promise.all([
      manageCatalog({ action: 'list_installed', kinds: ['connectors'] } as never, env, workspaceCtx) as Promise<{
        installed?: { connectors?: { items?: unknown } };
      }>,
      manageCatalog({ action: 'list_catalog', kinds: ['connectors'] } as never, env, workspaceCtx) as Promise<{
        catalogs?: { connectors?: { entries?: unknown } };
      }>,
      // Managed-auth offers enrich the normal connector result, but they are
      // not required to discover connectors that are already installed or in
      // the catalog. Keep that base path available if org discovery fails.
      deps.listOrganizations(ctx.userId).catch(() => []),
    ]);
    const liveGrantIds =
      Array.isArray(ctx.grantedOrganizationIds)
        ? new Set(
            (
              await deps.listLiveGrantedOrganizations(
                ctx.userId,
                ctx.grantedOrganizationIds
              )
            ).map((workspace) => workspace.id)
          )
        : null;
    // Only PRIVATE memberships outside the grant snapshot are confidential;
    // public managed-auth offers stay discoverable for their members.
    const visibleOrganizations = organizations.filter(
      (organization) =>
        liveGrantIds === null ||
        !organization.is_member ||
        organization.visibility === 'public' ||
        liveGrantIds.has(organization.id)
    );
    const installed = asArray<{
      id: string;
      name?: string;
      detail?: { description?: string; feeds_schema?: unknown };
    }>(inst.installed?.connectors?.items);
    const catalog = asArray<{
      id: string;
      name?: string;
      description?: string;
      detail?: { installable?: boolean; installability_message?: string; installability_reason?: string };
    }>(cat.catalogs?.connectors?.entries);
    const installedIds = new Set(installed.map((i) => i.id));
    const managedOffers = new Map<
      string,
      Array<{
        organizationSlug: string;
        joinRequired: boolean;
        connectMethod: 'connections.connectManaged';
        localBootstrapCommand: string;
      }>
    >();
    for (const organization of visibleOrganizations) {
      for (const offer of organization.managed_auth?.connectors ?? []) {
        const entries = managedOffers.get(offer.connector_key) ?? [];
        entries.push({
          organizationSlug: offer.managed_by_org,
          joinRequired: organization.managed_auth?.join_required ?? !organization.is_member,
          connectMethod: organization.managed_auth!.connect_method,
          localBootstrapCommand: organization.managed_auth!.local_bootstrap_command,
        });
        managedOffers.set(offer.connector_key, entries);
      }
    }
    // Share public metadata within this request; never cache mutable offers across requests.
    let publicOrganizations: Promise<OrgInfo[]> | undefined;
    let cloudOrigin: Promise<string | null> | undefined;
    const setupDeps: Partial<SetupOptionsDeps> = {
      cloudOrigin: () => (cloudOrigin ??= resolveCloudOrigin()),
      publicOptions: async (key, origin) =>
        publicSetupOptions(key, origin, await (publicOrganizations ??= deps.listPublicOrganizations())),
    };
    const setupByKey = new Map<string, ConnectionSetupOptions>();
    const withManagedAuth = (connectorKey: string, line: string): string => {
      const setup = setupByKey.get(connectorKey);
      const choices = (setup?.options ?? []).filter(
        (option) => option.kind !== 'local' && !!option.url
      );
      if (choices.length) {
        const options = choices.map(option => `${option.label} (${option.kind}, execution: ${option.execution}): ${option.description} Open ${option.url} for human setup. ${option.instructions}`).join(' ');
        return bestStatusByKey.has(connectorKey)
          ? `${line} Other setup options: ${options}`
          : `${options} Alternative local setup: ${line}`;
      }
      // A discovery outage is not "no managed offer exists" — say so, but never
      // INSTEAD of an offer already known from the visible organizations, which
      // are read independently of cloud setup discovery.
      const outage = setup?.cloud_status === 'unavailable'
        ? 'Cloud setup discovery is unavailable; this does not mean no managed offer exists. Retry connections.setupOptions before requesting app credentials. '
        : '';
      const offer = managedOffers.get(connectorKey)?.[0];
      if (!offer) return outage ? `${line} ${outage}`.trimEnd() : line;
      const managedLifecycle = lifecycleForCaller(
        ['connections.connectManaged'],
        `Start it with run_sdk → client.${offer.connectMethod}({ managed_by_org: '${offer.organizationSlug}', connector_key: '${connectorKey}' }); after consent, \`${offer.localBootstrapCommand}\` generates the local managedBy config so provider data stays local.`,
        ctx
      );
      const managed = `${outage}Managed OAuth is available from public org '${offer.organizationSlug}' (Lobu login and one-time provider consent required; ${offer.joinRequired ? 'membership is added automatically' : 'already joined'}). ${managedLifecycle}`;
      // An existing connection needs use/repair guidance, never a recommendation
      // to create another grant. For a new setup, show the managed route first.
      return bestStatusByKey.has(connectorKey)
        ? `${line} ${managed}`
        : `${managed} Alternative local setup (if the user chooses their own app): ${line}`;
    };

    // Only the installed connectors that MATCH the query need a status — resolve
    // their connections. Two targeted probes per connector rather than a single
    // page: first ask "is there an ACTIVE connection?" (status filter, limit 1);
    // only if none, fetch one connection to report its non-active state. This is
    // fully size-independent — an older active connection can't be hidden behind
    // a page of newer revoked ones.
    const matchedInstalled = installed.filter((i) =>
      matchesQueryTokens(q, i.id, i.name, i.detail?.description)
    ).slice(0, MAX_LINES);
    const matchedCatalog = catalog.filter((c) =>
      !installedIds.has(c.id) && matchesQueryTokens(q, c.id, c.name, c.description)
    ).slice(0, MAX_LINES - matchedInstalled.length);
    const listConnections = async (connectorKey: string, status?: string) => {
      const res = (await manageConnections(
        { action: 'list', connector_key: connectorKey, ...(status ? { status } : {}), limit: 1 } as never,
        env,
        workspaceCtx
      )) as { connections?: unknown };
      return asArray<{ status: string }>(res.connections);
    };
    const bestStatusByKey = new Map<string, string>();
    await Promise.all(
      matchedInstalled.map(async (i) => {
        if ((await listConnections(i.id, 'active')).length > 0) {
          bestStatusByKey.set(i.id, 'active');
          return;
        }
        const any = await listConnections(i.id);
        if (any.length > 0) bestStatusByKey.set(i.id, any[0].status);
      })
    );
    // Use the same bounded rows for rendering and setup discovery. Unavailable
    // catalog entries consume a display slot but need no setup request.
    const setupKeys = new Set([
      ...matchedInstalled.map(i => i.id),
      ...matchedCatalog.filter(c => c.detail?.installable !== false).map(c => c.id),
    ]);
    await Promise.all(
      [...setupKeys]
        .map(async (connector_key) => {
          try {
            setupByKey.set(
              connector_key,
              await deps.setupOptions({ connector_key }, workspaceCtx, setupDeps)
            );
          } catch {
            // Base discovery stays available when setup discovery fails.
          }
        })
    );
    const USABLE = new Set(['active']);
    const bestStatus = (key: string): string | undefined => bestStatusByKey.get(key);

    for (const i of matchedInstalled) {
      const feeds = feedKeysOf(i.detail);
      const feedKeyHint = feeds?.[0] ? `'${feeds[0]}'` : '<feed_key>';
      const feedKeysNote = feeds ? ` Feed keys: ${feeds.join(', ')}.` : '';
      // A connector with NO feeds_schema (e.g. an action/chat connector like
      // Slack) does not sync via feeds — telling the agent to feeds.create would
      // send it down an invalid lifecycle. Point it at operations instead.
      const hasFeeds = !!feeds;
      const useHint = hasFeeds
        ? lifecycleForCaller(
            ['feeds.create'],
            `To add a feed: run_sdk → client.feeds.create({ connection_id, feed_key: ${feedKeyHint}, config }); then query_sql on events or search_memory to read.`,
            ctx
          )
        : lifecycleForCaller(
            ['operations.listAvailable', 'operations.execute'],
            `This connector has no data feeds — it exposes operations/actions. Discover them via query_sdk → client.operations.listAvailable({ connector_key: '${i.id}' }) and run with client.operations.execute.`,
            ctx
          );
      const status = bestStatus(i.id);
      if (status && USABLE.has(status)) {
        lines.push(withManagedAuth(i.id,
          `connector '${i.id}' (${i.name ?? i.id}) — INSTALLED and CONNECTED (active connection).${feedKeysNote} ${useHint} Get the connection_id via query_sdk → client.connections.list({ connector_key: '${i.id}' }).`
        ));
      } else if (status) {
        // Connection exists but is NOT usable (revoked/error/paused/pending) —
        // repair it before use.
        lines.push(withManagedAuth(i.id,
          `connector '${i.id}' (${i.name ?? i.id}) — INSTALLED with a connection that needs attention (status: ${status}).${feedKeysNote} ${lifecycleForCaller(
            ['connections.reauthenticate'],
            `Reauthenticate/repair before use: run_sdk → client.connections.reauthenticate(<connection_id>) (or reconnect). Find the connection via query_sdk → client.connections.list({ connector_key: '${i.id}' }).`,
            ctx
          )}`
        ));
      } else if (hasFeeds) {
        lines.push(withManagedAuth(i.id,
          `connector '${i.id}' (${i.name ?? i.id}) — INSTALLED, not yet configured.${feedKeysNote} ${lifecycleForCaller(
            ['connections.connect', 'feeds.create', 'feeds.trigger'],
            `Lifecycle: run_sdk → client.connections.connect({ connector_key: '${i.id}' }) → client.feeds.create({ connection_id, feed_key: ${feedKeyHint}, config }) → client.feeds.trigger({ feed_id }); then query_sql on events or search_memory to read. Use search_sdk 'feeds.create feeds.trigger' for signatures.`,
            ctx
          )}`
        ));
      } else {
        // Feedless connector, not yet connected — connect, then use operations.
        lines.push(withManagedAuth(i.id,
          `connector '${i.id}' (${i.name ?? i.id}) — INSTALLED, not yet connected. It has no data feeds — it exposes operations/actions. ${lifecycleForCaller(
            ['connections.connect', 'operations.listAvailable', 'operations.execute'],
            `Lifecycle: run_sdk → client.connections.connect({ connector_key: '${i.id}' }); then query_sdk → client.operations.listAvailable({ connector_key: '${i.id}' }) and run with client.operations.execute.`,
            ctx
          )}`
        ));
      }
    }
    for (const c of matchedCatalog) {
      // A catalog entry can be non-installable (e.g. a stale/unavailable
      // connector). installConnector on it is guaranteed to fail, so surface the
      // reason instead of the install lifecycle.
      if (c.detail?.installable === false) {
        const why = c.detail.installability_message ?? c.detail.installability_reason;
        lines.push(
          `connector '${c.id}' (${c.name ?? c.id}) — in the global CATALOG but NOT currently installable${
            why ? `: ${why}` : ' here'
          }. It cannot be configured right now.`
        );
        continue;
      }
      lines.push(withManagedAuth(c.id,
        `connector '${c.id}' (${c.name ?? c.id}) — in the global CATALOG, not yet installed here. ${lifecycleForCaller(
          ['connections.installConnector'],
          `Install with run_sdk → client.connections.installConnector({ connector_id: '${c.id}' }), then repeat search_sdk for the live connect/use lifecycle.`,
          ctx
        )}`
      ));
    }
  } catch {
    return [];
  }
  return lines.slice(0, MAX_LINES);
}
