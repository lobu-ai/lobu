/**
 * Tool: resolve_path
 *
 * Resolves a URL path like /acme/company/spotify into
 * workspace + entity details by walking the entity hierarchy.
 *
 * URL pattern: /:owner/entity-type/entity-slug/...
 */

import * as Sentry from '@sentry/node';
import { type Static, Type } from '@sinclair/typebox';
import { resolveGrantedWorkspaceTarget } from '../auth/oauth/workspace-grants';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { feedLinkedToBusinessEntitySql } from '../authz/channel-about';
import { entityLinkMatchSql } from '../utils/content-search';
import {
  type DataSourceContext,
  type DataSourceInput,
  executeDataSources,
} from '../utils/execute-data-sources';
import { ToolUserError } from '../utils/errors';
import { resolveMemberSchemaFieldsFromSchema } from '../utils/member-entity-type';
import { stripMemberEmailsFromRows } from '../utils/member-redaction';
import {
  derivedRowName,
  derivedRowSlug,
  getEntityCountsByTypes,
  queryDerivedEntityView,
} from '../utils/entity-management';
import { buildDefaultEntityTemplate } from '../utils/default-entity-template';
import { measureColumns as inferMeasureColumns } from '../utils/infer-measures';
import { RESERVED_PATHS_SET } from '../utils/reserved';
import { getWorkspaceProvider } from '../workspace';
import { isAdminOrOwnerRole, isInProcessSystemCall, requireWorkspaceContext } from './access-control';
import { MEMBER_ENTITY_TYPE_SLUG } from './constants';
import type { AccountToolContext, ToolContext } from './registry';
import { withValidatedArgs } from './validate-args';

export const ResolvePathSchema = Type.Object({
  path: Type.String({
    description: 'URL path like /acme/company/spotify (query string optional)',
    minLength: 1,
  }),
  include_bootstrap: Type.Optional(
    Type.Boolean({
      description:
        'When true, includes shared bootstrap data for sidebar and overview pages in the response',
      default: false,
    })
  ),
});

type ResolvePathArgs = Static<typeof ResolvePathSchema>;

export const ResolvedWorkspaceSchema = Type.Object({
  slug: Type.String(),
  type: Type.Union([Type.Literal('user'), Type.Literal('organization')]),
  id: Type.String(),
  name: Type.Union([Type.String(), Type.Null()]),
});
export type ResolvedWorkspace = Static<typeof ResolvedWorkspaceSchema>;

export const ResolvedPathEntitySchema = Type.Object({
  id: Type.Integer(),
  entity_type: Type.String(),
  slug: Type.String(),
  name: Type.String(),
});
export type ResolvedPathEntity = Static<typeof ResolvedPathEntitySchema>;

const ViewTemplateTabSchema = Type.Object({
  tab_name: Type.String(),
  tab_order: Type.Integer(),
  json_template: Type.Record(Type.String(), Type.Unknown()),
  version: Type.Integer(),
  version_id: Type.Integer(),
  template_data: Type.Union([
    Type.Record(Type.String(), Type.Array(Type.Unknown())),
    Type.Null(),
  ]),
});
type ViewTemplateTab = Static<typeof ViewTemplateTabSchema>;

const MergedRecordSchema = Type.Object({
  id: Type.Integer(),
  name: Type.String(),
  slug: Type.String(),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  merged_at: Type.String(),
  can_unmerge: Type.Boolean(),
});

// ResolvedEntityDetails = ResolvedPathEntity + detail fields. TypeBox has no
// `extends`; compose via intersect so the derived type stays a single source.
export const ResolvedEntityDetailsSchema = Type.Intersect([
  ResolvedPathEntitySchema,
  Type.Object({
    parent_id: Type.Union([Type.Integer(), Type.Null()]),
    metadata: Type.Record(Type.String(), Type.Unknown()),
    /** Per-field human-ownership markers (key present = a human set that field).
     *  Lets the UI badge owned fields + show the correction note. */
    field_controls: Type.Record(
      Type.String(),
      Type.Object({
        note: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        set_by: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        set_at: Type.Optional(Type.String()),
      })
    ),
    json_template: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    json_template_version: Type.Union([Type.Integer(), Type.Null()]),
    template_data: Type.Union([
      Type.Record(Type.String(), Type.Array(Type.Unknown())),
      Type.Null(),
    ]),
    tabs: Type.Array(ViewTemplateTabSchema),
    created_at: Type.String(),
    // Stats
    total_content: Type.Integer(),
    active_connections: Type.Integer(),
    automations_count: Type.Integer(),
    // Derived ("view") entity: synthesized from the type's `backing_sql` filtered
    // to this slug, not a stored `entities` row. `metadata` holds the full view
    // row; `measure_columns` are its aggregate columns. Stored entities omit both.
    is_derived: Type.Optional(Type.Boolean()),
    measure_columns: Type.Optional(Type.Array(Type.String())),
    /** Tombstoned source rows currently forwarded to this canonical entity. */
    merged_records: Type.Optional(Type.Array(MergedRecordSchema)),
  }),
]);
export type ResolvedEntityDetails = Static<typeof ResolvedEntityDetailsSchema>;

export const ChildEntitySchema = Type.Object({
  id: Type.Integer(),
  entity_type: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  market: Type.Union([Type.String(), Type.Null()]),
  content_count: Type.Integer(),
});
export type ChildEntity = Static<typeof ChildEntitySchema>;

interface ResolvedEntityRow {
  id: number;
  entity_type: string;
  slug: string;
  name: string;
  parent_id: number | null;
  metadata: Record<string, any> | null;
  field_controls?: Record<string, unknown> | null;
  created_at: Date;
}

export const SiblingEntitySchema = Type.Object({
  id: Type.Integer(),
  entity_type: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  content_count: Type.Integer(),
});
export type SiblingEntity = Static<typeof SiblingEntitySchema>;

const BootstrapEntityTypeSummarySchema = Type.Object({
  id: Type.Integer(),
  slug: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  icon: Type.Union([Type.String(), Type.Null()]),
  color: Type.Union([Type.String(), Type.Null()]),
  entity_count: Type.Integer(),
});

/**
 * How much of each thing the workspace has. Every field counts a bounded
 * config table — tens of rows, not history — so the whole struct costs one
 * cheap round trip and rides every resolve rather than hiding behind
 * `include_bootstrap`. That is the point: nav badges and onboarding states
 * need to know whether a workspace is empty on pages that have no reason to
 * pull a bootstrap payload, and asking them to fetch whole lists to find out
 * is what this replaces.
 *
 * Content counts are deliberately absent — they aggregate `events`, which
 * grows without bound, so they stay in `bootstrap` where the one consumer
 * that needs them already asks.
 */
const WorkspaceCountsSchema = Type.Object({
  connections: Type.Integer(),
  automations: Type.Integer(),
  agents: Type.Integer(),
  // Devices are owned by the requesting user, not the org — count is per-user.
  devices: Type.Integer(),
  // MCP client registrations ("agents you brought"), counted with the same
  // predicate the connected-apps inventory lists by.
  clients: Type.Integer(),
});
type WorkspaceCounts = Static<typeof WorkspaceCountsSchema>;

const BootstrapContentItemSchema = Type.Object({
  id: Type.Integer(),
  entity_ids: Type.Array(Type.Integer()),
  platform: Type.String(),
  entity_name: Type.Union([Type.String(), Type.Null()]),
  title: Type.Union([Type.String(), Type.Null()]),
  text_content: Type.String(),
  source_url: Type.Union([Type.String(), Type.Null()]),
  author_name: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  occurred_at: Type.Union([Type.String(), Type.Null()]),
});

const BootstrapFeedItemSchema = Type.Object({
  id: Type.Integer(),
  connection_id: Type.Integer(),
  connector_key: Type.String(),
  display_name: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  entity_ids: Type.Array(Type.Integer()),
  connector_name: Type.Union([Type.String(), Type.Null()]),
  connection_name: Type.Union([Type.String(), Type.Null()]),
  event_count: Type.Integer(),
  created_at: Type.String(),
  updated_at: Type.String(),
});

const BootstrapConnectorDefinitionSchema = Type.Object({
  key: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  icon: Type.Union([Type.String(), Type.Null()]),
  favicon_domain: Type.Union([Type.String(), Type.Null()]),
});

export const ResolvePathBootstrapSchema = Type.Object({
  entity_types: Type.Array(BootstrapEntityTypeSummarySchema),
  /**
   * Live event rows in scope. Unlike `counts`, this aggregates an append-only
   * table, so its cost grows with history — it stays bootstrap-gated and out
   * of the always-on payload.
   */
  total_content: Type.Integer(),
  recent_content: Type.Array(BootstrapContentItemSchema),
  recent_feeds: Type.Array(BootstrapFeedItemSchema),
  connector_definitions: Type.Array(BootstrapConnectorDefinitionSchema),
});
export type ResolvePathBootstrap = Static<typeof ResolvePathBootstrapSchema>;
// Handlers reference these by name; alias each from its schema.
type BootstrapEntityTypeSummary = Static<typeof BootstrapEntityTypeSummarySchema>;
type BootstrapContentItem = Static<typeof BootstrapContentItemSchema>;
type BootstrapFeedItem = Static<typeof BootstrapFeedItemSchema>;
type BootstrapConnectorDefinition = Static<typeof BootstrapConnectorDefinitionSchema>;

/**
 * Coerce a timestamp value from a SQL row to an ISO string, tolerating NULL.
 * `new Date(String(null)).toISOString()` throws (`new Date('null')` is Invalid
 * Date → RangeError), and the feed query orders by
 * `COALESCE(updated_at, created_at)` precisely because `updated_at` can be NULL.
 * `fallback` supplies that same coalesced value so a non-null `updated_at`
 * column stays a non-null string in the result. If both are absent, returns the
 * epoch — a valid ISO string keeps the (non-nullable) schema field satisfied
 * rather than throwing or emitting an invalid `structuredContent`.
 */
function toIso(value: unknown, fallback?: unknown): string {
  for (const candidate of [value, fallback]) {
    if (candidate == null) continue;
    const date = new Date(String(candidate));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date(0).toISOString();
}

/**
 * Output schema for `resolve_path`. TypeBox-first: every nested type is
 * `Static<>`-derived from its schema, so this object composes them into one
 * source of truth for both the TS type (`ResolvePathResult`) and the MCP
 * `outputSchema`. No hand-written interface mirrors it.
 */
export const ResolvePathResultSchema = Type.Object({
  workspace: ResolvedWorkspaceSchema,
  segments: Type.Array(
    Type.Object({ entity_type: Type.String(), slug: Type.String() })
  ),
  path: Type.Array(ResolvedPathEntitySchema),
  entity: Type.Union([ResolvedEntityDetailsSchema, Type.Null()]),
  children: Type.Array(ChildEntitySchema),
  siblings: Type.Array(SiblingEntitySchema),
  bootstrap: Type.Union([ResolvePathBootstrapSchema, Type.Null()]),
  counts: WorkspaceCountsSchema,
  redirect: Type.Union([Type.Object({ to: Type.String() }), Type.Null()]),
});
export type ResolvePathResult = Static<typeof ResolvePathResultSchema>;

const BOOTSTRAP_RECENT_LIMIT = 8;

/**
 * Extract `data_sources` from a json_template, execute them, and return
 * the cleaned template + results.
 */
async function processTemplateDataSources(
  jsonTemplate: Record<string, any> | null,
  context: DataSourceContext,
  sql: DbClient,
  options?: { excludeWorkspaceAudit?: boolean }
): Promise<{
  cleanTemplate: Record<string, any> | null;
  templateData: Record<string, unknown[]> | null;
}> {
  if (!jsonTemplate || !jsonTemplate.data_sources) {
    return { cleanTemplate: jsonTemplate, templateData: null };
  }

  const dataSources = jsonTemplate.data_sources as DataSourceInput;
  const { data_sources: _, ...cleanTemplate } = jsonTemplate;
  const templateData = await executeDataSources(dataSources, context, sql, {
    excludeWorkspaceAudit: options?.excludeWorkspaceAudit,
  });
  return { cleanTemplate, templateData };
}

/**
 * Process data sources for an array of tabs.
 */
async function processTabsDataSources(
  tabs: ViewTemplateTab[],
  context: DataSourceContext,
  sql: DbClient,
  options?: { excludeWorkspaceAudit?: boolean }
): Promise<ViewTemplateTab[]> {
  return Promise.all(
    tabs.map(async (tab) => {
      const { cleanTemplate, templateData } = await processTemplateDataSources(
        tab.json_template,
        context,
        sql,
        options
      );
      return {
        ...tab,
        json_template: cleanTemplate ?? tab.json_template,
        template_data: templateData,
      };
    })
  );
}

function parsePathAndQuery(rawPath: string): { path: string; query: Record<string, string> } {
  if (!rawPath) return { path: '/', query: {} };
  const [pathPart = '', queryString] = rawPath.split('?', 2);
  const cleaned = pathPart.split('#')[0];
  const path = `/${cleaned.replace(/^\/+|\/+$/g, '')}`;

  const query: Record<string, string> = {};
  if (queryString) {
    for (const param of queryString.split('&')) {
      const [key, ...rest] = param.split('=');
      if (key) query[decodeURIComponent(key)] = decodeURIComponent(rest.join('='));
    }
  }
  return { path, query };
}

export const resolvePath = withValidatedArgs(
  'resolve_path',
  ResolvePathSchema,
  (args: ResolvePathArgs, _env: Env, ctx: AccountToolContext): Promise<ResolvePathResult> =>
    Sentry.startSpan(
      { name: 'resolve_path', op: 'function', attributes: { path: args.path } },
      () => _resolvePath(args, ctx)
    )
);

async function _resolvePath(
  args: ResolvePathArgs,
  ctx: AccountToolContext
): Promise<ResolvePathResult> {
  const { path: normalized, query: urlQuery } = parsePathAndQuery(args.path);
  const segments = normalized
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);

  if (segments.length === 0) {
    throw new ToolUserError('Path must include an owner', 400);
  }

  const ownerRaw = segments[0];
  const isUserSpace = ownerRaw.startsWith('@');
  const ownerSlug = isUserSpace ? ownerRaw.slice(1) : ownerRaw;

  if (RESERVED_PATHS_SET.has(ownerSlug)) {
    throw new ToolUserError(`Owner '${ownerSlug}' is reserved`, 400);
  }

  // User namespaces have no workspace visibility/grant record to authorize
  // against. Reject them before owner resolution so this hidden direct tool
  // cannot become a username oracle or spend a pointless database lookup.
  if (isUserSpace) {
    throw new ToolUserError('Workspace is not available for this authorization', 404);
  }

  const sql = getDb();

  const resolved = await Sentry.startSpan({ name: 'resolveOwner', op: 'db' }, () =>
    getWorkspaceProvider().resolveOwner(ownerSlug, 'organization')
  );

  if (!resolved) {
    throw new ToolUserError('Workspace is not available for this authorization', 404);
  }

  const workspace: ResolvedWorkspace = {
    slug: resolved.slug,
    type: resolved.type,
    id: resolved.id,
    name: resolved.name,
  };

  // The request boundary has already freshly verified this token/session's
  // membership in ctx.organizationId. Only body-selected foreign targets need
  // the additional grant/public resolution below.
  let resolvedCtx = ctx;
  if (workspace.id !== ctx.organizationId) {
    const grantedTarget =
      ctx.allowCrossOrg &&
      ctx.tokenType === 'oauth' &&
      ctx.userId &&
      Array.isArray(ctx.grantedOrganizationIds)
        ? await resolveGrantedWorkspaceTarget({
            sql,
            userId: ctx.userId,
            grantedOrganizationIds: ctx.grantedOrganizationIds,
            slugOrId: workspace.id,
          })
        : null;
    if (grantedTarget) {
      resolvedCtx = {
        ...ctx,
        organizationId: grantedTarget.id,
        memberRole: grantedTarget.role,
        allowCrossOrg: false,
        grantedOrganizationIds: [grantedTarget.id],
        directSearchFederation: false,
      };
    } else {
      const publicRows = await sql`
        SELECT 1
        FROM organization
        WHERE id = ${workspace.id}
          AND visibility = 'public'
        LIMIT 1
      `;
      if (publicRows.length === 0) {
        // Unknown, ungranted, and private workspaces deliberately collapse to
        // one result so `resolve_path` cannot be used as an org-name oracle.
        throw new ToolUserError('Workspace is not available for this authorization', 404);
      }
      // Cross-workspace public browse is intentionally readable, but never
      // inherits the caller's role or grant capabilities from the URL-bound
      // workspace.
      resolvedCtx = {
        ...ctx,
        organizationId: workspace.id,
        memberRole: null,
        allowCrossOrg: false,
        grantedOrganizationIds: ctx.tokenType === 'oauth' ? [] : null,
        directSearchFederation: false,
      };
    }
  }

  const workspaceCtx = requireWorkspaceContext(resolvedCtx);
  const roleInResolvedWorkspace = workspaceCtx.memberRole;
  // Workspace-identity audit + template events: owner/admin of THIS workspace
  // (or trusted system) only.
  const excludeWorkspaceAudit =
    !isInProcessSystemCall(ctx) && !isAdminOrOwnerRole(roleInResolvedWorkspace);

  const remaining = segments.slice(1);
  let entitySegments: string[];

  if (remaining.length === 0) {
    const [bootstrap, counts] = await Promise.all([
      args.include_bootstrap
        ? fetchBootstrap(sql, workspaceCtx, workspace, null, excludeWorkspaceAudit)
        : null,
      resolveWorkspaceCounts(sql, workspace, workspaceCtx.userId),
    ]);
    return emptyResult(workspace, bootstrap, counts);
  }

  entitySegments = remaining;

  if (entitySegments.length % 2 !== 0) {
    // Frontend routes like /:owner/agents/:slug/settings have a UI subroute
    // appended after the entity tail. Treat the malformed-pair case as a
    // not-found so the client can fall back without surfacing a 500.
    throw new ToolUserError(
      `Entity path '${normalized}' is not resolvable: expected [type]/[slug] pairs after the owner`,
      404
    );
  }

  const parsedSegments: Array<{ entity_type: string; slug: string }> = [];
  for (let i = 0; i < entitySegments.length; i += 2) {
    parsedSegments.push({
      entity_type: entitySegments[i],
      slug: entitySegments[i + 1],
    });
  }

  if (workspace.type !== 'organization') {
    throw new ToolUserError('Entity paths require an organization namespace', 400);
  }

  let parentId: number | null = null;
  const resolvedPath: ResolvedPathEntity[] = [];
  let resolvedEntity: ResolvedEntityDetails | null = null;

  for (let i = 0; i < parsedSegments.length; i += 1) {
    const segment = parsedSegments[i]!;
    const isLeaf = i === parsedSegments.length - 1;

    if (!isLeaf) {
      // Lightweight query for intermediate path entities – no COUNT subqueries, no template joins.
      // Cross-org tolerance: a tenant path can traverse into a public-catalog entity.
      // $member is per-tenant — never fall back to a public catalog's $member row, since
      // member-redaction uses the caller's workspace role, not the resolved entity's org.
      const row = await sql`
        SELECT e.id, et.slug AS entity_type, e.slug, e.name, e.parent_id
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        LEFT JOIN organization eo ON eo.id = e.organization_id
        WHERE (
            e.organization_id = ${workspace.id}
            OR (eo.visibility = 'public' AND et.slug <> ${MEMBER_ENTITY_TYPE_SLUG})
          )
          AND e.deleted_at IS NULL
          AND et.slug = ${segment.entity_type}
          AND e.slug = ${segment.slug}
          AND (
            (${parentId}::bigint IS NULL AND e.parent_id IS NULL)
            OR e.parent_id = ${parentId}
          )
        ORDER BY (e.organization_id = ${workspace.id}) DESC, e.id ASC
        LIMIT 1
      `;

      if (row.length === 0) {
        throw new ToolUserError(
          `Entity not found for ${segment.entity_type}/${segment.slug}`,
          404
        );
      }

      const entityRow = row[0] as unknown as ResolvedEntityRow;
      resolvedPath.push({
        id: entityRow.id,
        entity_type: entityRow.entity_type,
        slug: entityRow.slug,
        name: entityRow.name,
      });
      parentId = entityRow.id;
      continue;
    }

    // Leaf entity: fetch core data (without expensive COUNT subqueries).
    // Cross-org tolerance: same widening as the intermediate query, excluding $member.
    const row = await sql`
        SELECT
          e.id,
          et.slug AS entity_type,
          e.slug,
          e.name,
          e.parent_id,
          e.metadata,
          e.field_controls,
          e.created_at,
          COALESCE(vtv_entity.json_template, vtv_et.json_template) as json_template,
          COALESCE(vtv_entity.version, vtv_et.version) as json_template_version,
          et.metadata_schema as entity_type_metadata_schema
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        LEFT JOIN view_template_versions vtv_entity
          ON vtv_entity.id = e.current_view_template_version_id
        LEFT JOIN view_template_versions vtv_et
          ON vtv_et.id = et.current_view_template_version_id
        LEFT JOIN organization eo ON eo.id = e.organization_id
        WHERE (
            e.organization_id = ${workspace.id}
            OR (eo.visibility = 'public' AND et.slug <> ${MEMBER_ENTITY_TYPE_SLUG})
          )
          AND e.deleted_at IS NULL
          AND et.slug = ${segment.entity_type}
          AND e.slug = ${segment.slug}
          AND (
            (${parentId}::bigint IS NULL AND e.parent_id IS NULL)
            OR e.parent_id = ${parentId}
          )
        ORDER BY (e.organization_id = ${workspace.id}) DESC, e.id ASC
        LIMIT 1
      `;

    if (row.length === 0) {
      // The slug isn't a stored entity. It may be a row of a DERIVED ("view")
      // entity type, whose rows are produced by `backing_sql`, not stored in
      // `entities`. Synthesize the same response shape so the routed detail page
      // renders it like any other entity (read-only, id-keyed tabs hidden).
      const derived = await resolveDerivedLeaf(sql, workspaceCtx, workspace, segment);
      if (derived) {
        resolvedPath.push({
          id: derived.id,
          entity_type: derived.entity_type,
          slug: derived.slug,
          name: derived.name,
        });
        resolvedEntity = derived;
        continue;
      }
      const redirect = await resolveMergedEntityRedirect(sql, workspace, segment, parentId);
      if (redirect) {
        // A redirect response is followed, not rendered — the client re-resolves
        // at `redirect.to` and gets real counts there. Spending a query to fill
        // a field nothing reads would be pure latency, so leave it zeroed.
        return { ...emptyResult(workspace, null), redirect };
      }
      throw new ToolUserError(
        `Entity not found for ${segment.entity_type}/${segment.slug}`,
        404
      );
    }

    const entityRow = row[0] as unknown as ResolvedEntityRow & {
      json_template: Record<string, any> | null;
      json_template_version: number | null;
      entity_type_metadata_schema: Record<string, any> | null;
    };
    resolvedPath.push({
      id: entityRow.id,
      entity_type: entityRow.entity_type,
      slug: entityRow.slug,
      name: entityRow.name,
    });

    parentId = entityRow.id;

    const createdAt = new Date(entityRow.created_at).toISOString();
    const entityDataCtx: DataSourceContext = {
      organizationId: workspace.id,
      entityIds: [entityRow.id],
      query: urlQuery,
    };

    // Run stats, tabs, and template data sources all in parallel
    const [
      [eventsCount],
      [connectionsCount],
      [automationsCount],
      entityTabs,
      entityTypeTabs,
      { cleanTemplate: entityCleanTpl, templateData: entityTemplateData },
    ] = await Sentry.startSpan({ name: 'entity:counts+tabs', op: 'db' }, () =>
      Promise.all([
        sql.unsafe<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM current_event_records ev
             WHERE ${entityLinkMatchSql(`${Number(entityRow.id)}::bigint`, 'ev')}
               AND ev.organization_id = $1`,
          [workspace.id]
        ),
        sql.unsafe<{ cnt: number }>(
          `SELECT COUNT(DISTINCT cn.connector_key) as cnt
           FROM feeds f
           JOIN connections cn ON cn.id = f.connection_id
           WHERE f.organization_id = $1
             AND f.deleted_at IS NULL
             AND cn.deleted_at IS NULL
             AND ${feedLinkedToBusinessEntitySql('$2::int', 'f', 'cn', '$1')}`,
          [workspace.id, Number(entityRow.id)],
        ),
        sql`SELECT COUNT(*) as cnt FROM automations i
              WHERE ${Number(entityRow.id)}::int = ANY(i.entity_ids)
                AND i.organization_id = ${workspace.id}
                AND i.status = 'active'`,
        fetchTabs(sql, 'entity', String(entityRow.id), workspace.id),
        fetchTabs(sql, 'entity_type', entityRow.entity_type, workspace.id),
        processTemplateDataSources(entityRow.json_template, entityDataCtx, sql, {
          excludeWorkspaceAudit,
        }),
      ])
    );
    const mergedTabs = mergeTabs(entityTabs, entityTypeTabs);
    let processedEntityTabs = await processTabsDataSources(mergedTabs, entityDataCtx, sql, {
      excludeWorkspaceAudit,
    });
    let redactedTemplateData = entityTemplateData;
    if (entityRow.entity_type === MEMBER_ENTITY_TYPE_SLUG && !roleInResolvedWorkspace) {
      throw new ToolUserError(
        'Member details are only visible to members of this workspace. Join the workspace to see members.',
        403
      );
    }
    const rawEntityMetadata = entityRow.metadata ?? {};
    let safeEntityMetadata = rawEntityMetadata;
    const canSeeEmail = isAdminOrOwnerRole(roleInResolvedWorkspace);
    if (!canSeeEmail) {
      const schemaRow = await sql`
        SELECT metadata_schema FROM entity_types
        WHERE slug = ${MEMBER_ENTITY_TYPE_SLUG} AND organization_id = ${workspace.id} AND deleted_at IS NULL
        LIMIT 1
      `;
      const memberSchema = (schemaRow[0]?.metadata_schema as Record<string, unknown> | null) ?? null;
      const { emailField } = resolveMemberSchemaFieldsFromSchema(memberSchema);
      if (entityRow.entity_type === MEMBER_ENTITY_TYPE_SLUG && emailField in safeEntityMetadata) {
        const { [emailField]: _drop, ...rest } = safeEntityMetadata;
        safeEntityMetadata = rest;
      }
      // Also strip member emails that surface via template data sources or tabs
      // (e.g. a dashboard tab that lists members). Without this, a data-source
      // query like `SELECT * FROM entities WHERE entity_type='$member'` would
      // leak emails even when the single-entity redaction above is not tripped.
      redactedTemplateData = stripMemberEmailsFromRows(entityTemplateData, emailField);
      processedEntityTabs = processedEntityTabs.map((tab) => ({
        ...tab,
        template_data: stripMemberEmailsFromRows(tab.template_data, emailField),
      }));
    }
    // Rendering resolution tail: when neither the entity nor its type declares
    // a view template, synthesize a default field card from the type's
    // metadata_schema so a typed/promoted entity never renders bare. A type
    // with no schema properties yields null → the client keeps the dashboard
    // overview. Custom tabs (a richer authored view) suppress the auto-default.
    const resolvedTemplate =
      entityCleanTpl ??
      (processedEntityTabs.length === 0
        ? buildDefaultEntityTemplate(entityRow.entity_type_metadata_schema)
        : null);
    resolvedEntity = {
      id: entityRow.id,
      entity_type: entityRow.entity_type,
      slug: entityRow.slug,
      name: entityRow.name,
      parent_id: entityRow.parent_id,
      metadata: safeEntityMetadata,
      field_controls: (entityRow.field_controls as ResolvedEntityDetails['field_controls']) ?? {},
      json_template: resolvedTemplate,
      json_template_version: toVersionNumber(entityRow.json_template_version),
      template_data: redactedTemplateData,
      tabs: processedEntityTabs,
      created_at: createdAt,
      total_content: Number(eventsCount?.cnt) || 0,
      active_connections: Number(connectionsCount?.cnt) || 0,
      automations_count: Number(automationsCount?.cnt) || 0,
    };
  }

  let children: ChildEntity[] = [];
  let siblings: SiblingEntity[] = [];

  if (
    resolvedEntity &&
    !resolvedEntity.is_derived &&
    isAdminOrOwnerRole(roleInResolvedWorkspace)
  ) {
    const mergedRows = await sql<{
      id: number;
      name: string;
      slug: string;
      metadata: Record<string, unknown>;
      merged_at: Date | string;
      can_unmerge: boolean;
    }>`
      SELECT loser.id, loser.name, loser.slug, loser.metadata,
             operation.created_at AS merged_at,
             operation.winner_entity_id = ${resolvedEntity.id}
               AND NOT EXISTS (
                 SELECT 1
                 FROM entity_merge_operations later
                 WHERE later.organization_id = operation.organization_id
                   AND later.winner_entity_id = operation.winner_entity_id
                   AND later.status = 'active'
                   AND later.id > operation.id
               ) AS can_unmerge
      FROM entity_merge_operations operation
      JOIN entities loser
        ON loser.id = operation.loser_entity_id
       AND loser.organization_id = operation.organization_id
      WHERE operation.organization_id = ${workspace.id}
        AND loser.merged_into = ${resolvedEntity.id}
        AND operation.status = 'active'
      ORDER BY operation.created_at DESC, operation.id DESC
    `;
    resolvedEntity = {
      ...resolvedEntity,
      merged_records: mergedRows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        slug: row.slug,
        metadata: row.metadata ?? {},
        merged_at: new Date(row.merged_at).toISOString(),
        can_unmerge: row.can_unmerge,
      })),
    };
  }

  if (resolvedEntity && !resolvedEntity.is_derived) {
    // Fetch children + siblings without per-row COUNT subqueries.
    // content_count is omitted to avoid expensive GIN index scans over the events table.
    const [childRows, siblingRows] = await Promise.all([
      sql`
        SELECT e.id, et.slug AS entity_type, e.slug, e.name,
          e.metadata::jsonb->>'market' as market
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        WHERE e.organization_id = ${workspace.id}
          AND e.parent_id = ${resolvedEntity.id}
        ORDER BY e.name ASC
      `,
      sql`
        SELECT e.id, et.slug AS entity_type, e.slug, e.name
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        WHERE e.organization_id = ${workspace.id}
          AND et.slug = ${resolvedEntity.entity_type}
          AND (
            (${resolvedEntity.parent_id}::bigint IS NULL AND e.parent_id IS NULL)
            OR e.parent_id = ${resolvedEntity.parent_id}
          )
        ORDER BY e.name ASC
      `,
    ]);

    children = childRows.map((row) => ({
      id: Number(row.id),
      entity_type: String(row.entity_type),
      slug: String(row.slug),
      name: String(row.name),
      market: row.market ? String(row.market) : null,
      content_count: 0,
    }));
    siblings = siblingRows.map((row) => ({
      id: Number(row.id),
      entity_type: String(row.entity_type),
      slug: String(row.slug),
      name: String(row.name),
      content_count: 0,
    }));
  }

  const [bootstrap, counts] = await Promise.all([
    args.include_bootstrap
      ? fetchBootstrap(sql, workspaceCtx, workspace, resolvedEntity, excludeWorkspaceAudit)
      : null,
    resolveWorkspaceCounts(sql, workspace, workspaceCtx.userId),
  ]);

  return {
    workspace,
    segments: parsedSegments,
    path: resolvedPath,
    entity: resolvedEntity,
    children,
    siblings,
    bootstrap,
    counts,
    redirect: null,
  };
}

// ============================================
// Helpers
// ============================================

type DbClient = ReturnType<typeof getDb>;

function toVersionNumber(v: unknown): number | null {
  return v ? Number(v) : null;
}

async function resolveMergedEntityRedirect(
  sql: DbClient,
  workspace: ResolvedWorkspace,
  segment: { entity_type: string; slug: string },
  parentId: number | null
): Promise<{ to: string } | null> {
  const rows = await sql<{
    loser_name: string;
    winner_id: number;
  }>`
    SELECT loser.name AS loser_name, winner.id AS winner_id
    FROM entities loser
    JOIN entity_types loser_type ON loser_type.id = loser.entity_type_id
    JOIN entities winner
      ON winner.id = loser.merged_into
     AND winner.organization_id = loser.organization_id
     AND winner.deleted_at IS NULL
    WHERE loser.organization_id = ${workspace.id}
      AND loser.deleted_at IS NOT NULL
      AND loser_type.slug = ${segment.entity_type}
      AND loser.slug = ${segment.slug}
      AND (
        (${parentId}::bigint IS NULL AND loser.parent_id IS NULL)
        OR loser.parent_id = ${parentId}
      )
    LIMIT 1
  `;
  const merged = rows[0];
  if (!merged) return null;

  const path = await sql<{ entity_type: string; slug: string; depth: number }>`
    WITH RECURSIVE canonical_path AS (
      SELECT entity.id, entity.parent_id, type.slug AS entity_type,
             entity.slug, 0 AS depth
      FROM entities entity
      JOIN entity_types type ON type.id = entity.entity_type_id
      WHERE entity.id = ${merged.winner_id}
        AND entity.organization_id = ${workspace.id}
      UNION ALL
      SELECT parent.id, parent.parent_id, type.slug AS entity_type,
             parent.slug, canonical_path.depth + 1
      FROM canonical_path
      JOIN entities parent ON parent.id = canonical_path.parent_id
      JOIN entity_types type ON type.id = parent.entity_type_id
      WHERE parent.organization_id = ${workspace.id}
    )
    SELECT entity_type, slug, depth
    FROM canonical_path
    ORDER BY depth DESC
  `;
  if (path.length === 0) return null;
  const suffix = path
    .flatMap((item) => [item.entity_type, item.slug])
    .map(encodeURIComponent)
    .join('/');
  return {
    to: `/${encodeURIComponent(workspace.slug)}/${suffix}?merged_from=${encodeURIComponent(merged.loser_name)}`,
  };
}

/**
 * Resolve a single row of a derived ("view") entity type by slug. Returns null
 * when the type isn't derived or the slug isn't among its rows — the caller then
 * falls back to the normal 404.
 *
 * Derived rows aren't stored in `entities`; the type's `backing_sql` produces
 * them with stable `id`/`slug` columns. We run that SQL through
 * {@link queryDerivedEntityView} (same executor as list + type counts). An
 * internal view gets the slug pushed down as a bound SQL parameter; a
 * connection-backed view is paged and matched in memory. Neither path ever
 * interpolates the slug into the view SQL.
 */
async function resolveDerivedLeaf(
  sql: DbClient,
  ctx: ToolContext,
  workspace: ResolvedWorkspace,
  segment: { entity_type: string; slug: string }
): Promise<ResolvedEntityDetails | null> {
  const etRows = await sql`
    SELECT backing_sql, backing_source
    FROM entity_types
    WHERE slug = ${segment.entity_type}
      AND organization_id = ${workspace.id}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  const backingSql = etRows[0]?.backing_sql as string | null | undefined;
  if (!backingSql) return null;

  const backingSource = (etRows[0]?.backing_source as string | null | undefined) ?? undefined;
  // measure_columns isn't stored — it's inferred from the backing SQL (same as
  // `get_type`), so the detail view can right-align/badge aggregate columns.
  const measures = inferMeasureColumns(backingSql);

  // Internal views push the slug match into SQL as a bound parameter, so the
  // lookup costs ONE execution of the backing SQL no matter how many rows the
  // view produces. That matters most on a MISS, which has no early exit: paging
  // for it re-ran the backing SQL once per page, and derived views are usually
  // aggregates over `events`, so a 404 on a large view aggregated history once
  // per page on a request path. The returned row is still confirmed with
  // `derivedRowSlug` below, so any SQL/JS disagreement 404s rather than
  // resolving the wrong row.
  if (!backingSource) {
    const exact = await queryDerivedEntityView(
      backingSql,
      undefined,
      { limit: 1, offset: 0 },
      ctx,
      { preservePageRows: true, exactSlug: segment.slug }
    );
    if (exact.error) return null;
    const row = exact.rows.find((r) => derivedRowSlug(r) === segment.slug);
    if (!row) return null;
    return buildDerivedLeaf(row, measures, segment);
  }

  // External (connection-backed) views keep the bounded scan: pushdown hands raw
  // SQL to the connector and we can't assume its dialect supports the predicate.
  const PAGE = 500;
  const MAX_PAGES = 40;
  let match: Record<string, unknown> | undefined;
  let offset = 0;
  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum += 1) {
    const result = await queryDerivedEntityView(
      backingSql,
      backingSource,
      { limit: PAGE, offset },
      ctx,
      // This is an internal exact-slug scan, not an agent response. Retain the
      // database page cardinality so MAX_PAGES remains a source-row guard even
      // when wide rows would produce tiny serialized response chunks.
      { preservePageRows: true }
    );
    if (result.error) return null;
    match = result.rows.find((r) => derivedRowSlug(r) === segment.slug);
    if (match) break;
    if (!result.has_more || result.rows.length === 0) break;
    offset += result.rows.length;
  }
  if (!match) return null;

  return buildDerivedLeaf(match, measures, segment);
}

/** Shape one derived row into the read-only entity both lookup paths return. */
function buildDerivedLeaf(
  row: Record<string, unknown>,
  measures: string[],
  segment: { entity_type: string; slug: string }
): ResolvedEntityDetails {
  const name = derivedRowName(row, segment.slug);

  return {
    // Derived rows have no stored numeric id; routing/identity use the slug, and
    // the id-keyed tabs (knowledge/connectors/automations) are hidden client-side.
    id: 0,
    entity_type: segment.entity_type,
    slug: segment.slug,
    name,
    parent_id: null,
    metadata: row,
    // Derived ("view") rows aren't stored entities — no per-field ownership.
    field_controls: {},
    json_template: null,
    json_template_version: null,
    template_data: null,
    tabs: [],
    created_at: new Date().toISOString(),
    total_content: 0,
    active_connections: 0,
    automations_count: 0,
    is_derived: true,
    measure_columns: measures,
  };
}

function emptyResult(
  workspace: ResolvedWorkspace,
  bootstrap: ResolvePathBootstrap | null,
  counts: WorkspaceCounts = EMPTY_WORKSPACE_COUNTS
): ResolvePathResult {
  return {
    workspace,
    segments: [],
    path: [],
    entity: null,
    children: [],
    siblings: [],
    bootstrap,
    counts,
    redirect: null,
  };
}

async function fetchBootstrap(
  sql: DbClient,
  ctx: ToolContext,
  workspace: ResolvedWorkspace,
  entity: ResolvedEntityDetails | null,
  excludeWorkspaceAudit: boolean
): Promise<ResolvePathBootstrap> {
  if (workspace.type !== 'organization') {
    return {
      entity_types: [],
      total_content: 0,
      recent_content: [],
      recent_feeds: [],
      connector_definitions: [],
    };
  }

  const [entityTypes, totalContent, recentContent, recentFeeds] = await Promise.all([
    listEntityTypes(sql, ctx),
    fetchContentCount(sql, workspace.id, entity, excludeWorkspaceAudit),
    fetchRecentContent(sql, workspace.id, entity?.id ?? null, excludeWorkspaceAudit),
    fetchRecentFeeds(sql, workspace.id, entity?.id ?? null),
  ]);
  const connectorDefinitions = await listWorkspaceConnectorDefinitions(
    sql,
    workspace.id,
  );

  return {
    entity_types: entityTypes,
    total_content: totalContent,
    recent_content: recentContent,
    recent_feeds: recentFeeds,
    connector_definitions: connectorDefinitions,
  };
}

async function listEntityTypes(
  sql: DbClient,
  ctx: ToolContext
): Promise<BootstrapEntityTypeSummary[]> {
  const rows = await sql`
    SELECT
      et.id,
      et.slug,
      et.name,
      et.description,
      et.icon,
      et.color,
      et.backing_sql,
      et.backing_source
    FROM entity_types et
    WHERE et.deleted_at IS NULL
      AND et.organization_id = ${ctx.organizationId}
    ORDER BY et.name ASC
  `;

  // Stored-type counts only. Derived types would re-run their full backing
  // SQL (e.g. the subscription report: 2-5s, authz-wrapped, list + count) on
  // every resolve_path call just for a bootstrap badge; the agent context does
  // not need it. Same policy as manage_entity_schema list/get and the entity
  // list: the exact row count stays available from the derived list response.
  const counts = await getEntityCountsByTypes(
    rows
      .filter((row) => row.backing_sql == null)
      .map((row) => ({
        id: Number(row.id),
        slug: String(row.slug),
        backing_sql: null,
        backing_source: null,
      })),
    ctx
  );

  return rows.map((row) => ({
    id: Number(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    icon: row.icon ? String(row.icon) : null,
    color: row.color ? String(row.color) : null,
    entity_count: counts.get(Number(row.id)) || 0,
  }));
}

const EMPTY_WORKSPACE_COUNTS: WorkspaceCounts = {
  connections: 0,
  automations: 0,
  agents: 0,
  devices: 0,
  clients: 0,
};

/**
 * A user space has no org-scoped config to count, so it skips the query
 * entirely rather than issuing one guaranteed to return zeros.
 */
function resolveWorkspaceCounts(
  sql: DbClient,
  workspace: ResolvedWorkspace,
  userId: string | null
): Promise<WorkspaceCounts> {
  return workspace.type === 'organization'
    ? fetchWorkspaceCounts(sql, workspace.id, userId)
    : Promise.resolve(EMPTY_WORKSPACE_COUNTS);
}

/**
 * Every count the nav and onboarding surfaces need, in one round trip.
 *
 * All five aggregate bounded config tables, so the cost is flat in history
 * size and this can run on every resolve. Keeping them in one statement is
 * what makes that true — the previous split (agents/devices in one query,
 * connections/automations in another) paid two round trips for five scalars.
 *
 * `clients` mirrors the grouped live inventory rendered by AgentsPage: a
 * registration only counts while it has an active grant, and repeat
 * registrations from the same named app and user collapse to one row. This
 * keeps the sidebar count and empty-workspace onboarding aligned with what the
 * user can actually open on the Agents page without another frontend request.
 */
async function fetchWorkspaceCounts(
  sql: DbClient,
  organizationId: string,
  userId: string | null
): Promise<WorkspaceCounts> {
  const [row] = await sql`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM connections cn
        WHERE cn.organization_id = ${organizationId}
          AND cn.deleted_at IS NULL
      ) AS connections,
      (
        SELECT COUNT(*)::int
        FROM automations w
        WHERE w.organization_id = ${organizationId}
          AND w.status = 'active'
      ) AS automations,
      (
        SELECT COUNT(*)::int
        FROM agents a
        WHERE a.organization_id = ${organizationId}
      ) AS agents,
      (
        SELECT COUNT(*)::int
        FROM device_workers dw
        WHERE dw.user_id = ${userId}
      ) AS devices,
      (
        SELECT COUNT(DISTINCT CASE
          WHEN oc.client_name IS NOT NULL AND live_owner.user_id IS NOT NULL
            THEN 'group:' || jsonb_build_array(
              oc.client_name,
              live_owner.user_id,
              ${organizationId}::text
            )::text
          ELSE 'client:' || oc.id
        END)::int
        FROM oauth_clients oc
        JOIN LATERAL (
          SELECT ot.user_id
          FROM oauth_tokens ot
          WHERE ot.client_id = oc.id
            AND ot.organization_id = ${organizationId}
            AND ot.revoked_at IS NULL
            AND ot.expires_at > NOW()
          ORDER BY ot.created_at DESC, ot.id DESC
          LIMIT 1
        ) live_owner ON true
      ) AS clients
  `;
  const counts = row as Partial<Record<keyof WorkspaceCounts, number>> | undefined;
  return {
    connections: Number(counts?.connections) || 0,
    automations: Number(counts?.automations) || 0,
    agents: Number(counts?.agents) || 0,
    devices: Number(counts?.devices) || 0,
    clients: Number(counts?.clients) || 0,
  };
}

/**
 * Live event rows in scope. This one aggregates an append-only table, so it
 * is deliberately NOT part of `fetchWorkspaceCounts` — it is reached only
 * through `include_bootstrap`, so only callers that render bootstrap content
 * (the public page renderer, the workspace landing route) pay for it. An
 * entity scope reuses the count already computed while resolving that entity
 * rather than running a second pass over the same rows.
 */
async function fetchContentCount(
  sql: DbClient,
  organizationId: string,
  entity: ResolvedEntityDetails | null,
  excludeWorkspaceAudit: boolean
): Promise<number> {
  if (entity) return entity.total_content;

  const [row] = await sql`
    SELECT COUNT(*)::int AS total_content
    FROM current_event_records ev
    WHERE ev.organization_id = ${organizationId}
      -- Exclude null-shaped internal events (P1 corrections) from the org content count.
      AND ev.semantic_type <> 'correction'
      -- Workspace-identity audit rows record member/invitation lifecycle; only
      -- owner/admin and trusted system callers may see them.
      ${excludeWorkspaceAudit ? sql`AND NOT (ev.metadata ? '_lobu_workspace_audit')` : sql``}
  `;
  return Number((row as { total_content?: number } | undefined)?.total_content) || 0;
}

async function fetchRecentContent(
  sql: DbClient,
  organizationId: string,
  entityId: number | null,
  excludeWorkspaceAudit: boolean
): Promise<BootstrapContentItem[]> {
  // Inline the entity-link match as raw SQL — this whole query is built as a
  // single sql.unsafe() statement rather than mixing sql.unsafe() fragments
  // inside a tagged template that also carries $N values.
  const entityFilter =
    entityId !== null
      ? `AND ${entityLinkMatchSql(`${Number(entityId)}::bigint`, 'ev')}`
      : '';
  const rows = await sql.unsafe<Record<string, unknown>>(
    `
    SELECT
      ev.id,
      ev.entity_ids,
      COALESCE(ev.connector_key, cn.connector_key) AS platform,
      (
        SELECT ent.name
        FROM entities ent
        WHERE ent.id = ANY(ev.entity_ids)
        ORDER BY ent.name ASC
        LIMIT 1
      ) AS entity_name,
      ev.title,
      ev.payload_type,
      ev.payload_text,
      -- Bootstrap has no per-row author/admin gate, so never serve exact audit requests.
      CASE
        WHEN ev.semantic_type = 'audit' AND ev.origin_type = 'tool_invocation'
          THEN ev.payload_data - 'request'
        ELSE ev.payload_data
      END AS payload_data,
      ev.payload_template,
      ev.source_url,
      ev.author_name,
      ev.created_at,
      ev.occurred_at
    FROM current_event_records ev
    LEFT JOIN connections cn ON cn.id = ev.connection_id
    WHERE ev.organization_id = $1
      -- Exclude null-shaped internal events (P1 corrections) from the recent-content list.
      AND ev.semantic_type <> 'correction'
      -- Workspace-identity audit rows record member/invitation lifecycle; only
      -- owner/admin and trusted system callers may see them in bootstrap.
      ${excludeWorkspaceAudit ? `AND NOT (ev.metadata ? '_lobu_workspace_audit')` : ''}
      ${entityFilter}
    ORDER BY COALESCE(ev.occurred_at, ev.created_at) DESC
    LIMIT $2
  `,
    [organizationId, BOOTSTRAP_RECENT_LIMIT]
  );

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    entity_ids: Array.isArray(row.entity_ids)
      ? (row.entity_ids as number[]).map((value) => Number(value))
      : [],
    platform: row.platform ? String(row.platform) : 'unknown',
    entity_name: row.entity_name ? String(row.entity_name) : null,
    title: row.title ? String(row.title) : null,
    payload_type: (row.payload_type as string) || 'text',
    text_content: String(row.payload_text ?? ''),
    payload_data: row.payload_data as Record<string, unknown> | undefined,
    payload_template: row.payload_template as Record<string, unknown> | null | undefined,
    source_url: row.source_url ? String(row.source_url) : null,
    author_name: row.author_name ? String(row.author_name) : null,
    created_at: toIso(row.created_at),
    occurred_at: row.occurred_at ? toIso(row.occurred_at) : null,
  }));
}

async function fetchRecentFeeds(
  sql: DbClient,
  organizationId: string,
  entityId: number | null
): Promise<BootstrapFeedItem[]> {
  const rows = await sql`
    WITH scoped_feeds AS (
      SELECT
        f.id,
        f.connection_id,
        f.display_name,
        f.feed_key,
        f.status,
        f.entity_ids,
        f.created_at,
        f.updated_at,
        c.connector_key,
        c.display_name AS connection_name,
        cd.name AS connector_name
      FROM feeds f
      JOIN connections c ON c.id = f.connection_id
      LEFT JOIN LATERAL (
        SELECT name
        FROM connector_definitions
        WHERE key = c.connector_key
          AND status = 'active'
          AND organization_id = ${organizationId}
        ORDER BY updated_at DESC
        LIMIT 1
      ) cd ON TRUE
      WHERE f.organization_id = ${organizationId}
        AND f.deleted_at IS NULL
        AND c.deleted_at IS NULL
        AND (${entityId}::int IS NULL OR ${entityId}::int = ANY(f.entity_ids))
      ORDER BY COALESCE(f.updated_at, f.created_at) DESC
      LIMIT ${BOOTSTRAP_RECENT_LIMIT}
    ),
    event_counts AS (
      SELECT ev.feed_id, COUNT(*)::int AS event_count
      FROM current_event_records ev
      WHERE ev.feed_id IN (SELECT id FROM scoped_feeds)
      GROUP BY ev.feed_id
    )
    SELECT
      sf.id,
      sf.connection_id,
      sf.connector_key,
      sf.display_name,
      sf.status,
      sf.entity_ids,
      sf.connector_name,
      sf.connection_name,
      COALESCE(ec.event_count, 0)::int AS event_count,
      sf.created_at,
      sf.updated_at
    FROM scoped_feeds sf
    LEFT JOIN event_counts ec ON ec.feed_id = sf.id
    ORDER BY COALESCE(sf.updated_at, sf.created_at) DESC
  `;

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    connection_id: Number(row.connection_id),
    connector_key: String(row.connector_key),
    display_name: row.display_name ? String(row.display_name) : null,
    status: String(row.status),
    entity_ids: Array.isArray(row.entity_ids)
      ? (row.entity_ids as number[]).map((value) => Number(value))
      : [],
    connector_name: row.connector_name ? String(row.connector_name) : null,
    connection_name: row.connection_name ? String(row.connection_name) : null,
    event_count: Number(row.event_count) || 0,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at, row.created_at),
  }));
}

function extractOAuthDomain(authSchema: Record<string, unknown> | null | undefined): string | null {
  if (!authSchema) return null;

  const methods = (authSchema as { methods?: Array<Record<string, unknown>> }).methods;
  if (!Array.isArray(methods)) return null;

  for (const method of methods) {
    if (method.type !== 'oauth') continue;

    const authUrl = method.authorization_url ?? method.authorizationUrl;
    if (typeof authUrl === 'string') {
      try {
        return new URL(authUrl).hostname;
      } catch {
        // Ignore invalid URLs and keep checking fallback options.
      }
    }

    if (typeof method.provider === 'string' && method.provider.length > 0) {
      return `${method.provider}.com`;
    }
  }

  return null;
}

async function listWorkspaceConnectorDefinitions(
  sql: DbClient,
  organizationId: string
): Promise<BootstrapConnectorDefinition[]> {
  const rows = await sql`
    SELECT
      d.key,
      d.name,
      d.description,
      d.auth_schema,
      NULL::text AS icon,
      NULL::text AS favicon_domain
    FROM connector_definitions d
    WHERE d.status = 'active'
      AND d.organization_id = ${organizationId}
    ORDER BY d.name ASC
  `;

  return rows.map((row) => ({
    key: String(row.key),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    icon: row.icon ? String(row.icon) : null,
    favicon_domain: row.favicon_domain
      ? String(row.favicon_domain)
      : extractOAuthDomain((row.auth_schema as Record<string, unknown> | null) ?? null),
  }));
}

async function fetchTabs(
  sql: DbClient,
  resourceType: string,
  resourceId: string,
  organizationId: string
): Promise<ViewTemplateTab[]> {
  const rows = await sql`
    SELECT
      vtat.tab_name,
      vtat.tab_order,
      vtv.json_template,
      vtv.version,
      vtv.id as version_id
    FROM view_template_active_tabs vtat
    JOIN view_template_versions vtv ON vtv.id = vtat.current_version_id
    WHERE vtat.resource_type = ${resourceType}
      AND vtat.resource_id = ${resourceId}
      AND vtat.organization_id = ${organizationId}
    ORDER BY vtat.tab_order ASC, vtat.tab_name ASC
  `;

  return rows.map((row) => ({
    tab_name: String(row.tab_name),
    tab_order: Number(row.tab_order),
    json_template: row.json_template as Record<string, any>,
    version: Number(row.version),
    version_id: Number(row.version_id),
    template_data: null,
  }));
}

/**
 * Merge entity-level tabs with entity-type-level tabs.
 * Entity tabs override same-named entity-type tabs.
 */
function mergeTabs(
  entityTabs: ViewTemplateTab[],
  entityTypeTabs: ViewTemplateTab[]
): ViewTemplateTab[] {
  const tabMap = new Map<string, ViewTemplateTab>();

  // Add entity-type tabs first
  for (const tab of entityTypeTabs) {
    tabMap.set(tab.tab_name, tab);
  }

  // Entity tabs override same-named tabs
  for (const tab of entityTabs) {
    tabMap.set(tab.tab_name, tab);
  }

  return Array.from(tabMap.values()).sort(
    (a, b) => a.tab_order - b.tab_order || a.tab_name.localeCompare(b.tab_name)
  );
}
