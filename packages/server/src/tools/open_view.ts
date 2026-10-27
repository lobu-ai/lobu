import { type Static, Type } from "@sinclair/typebox";
import { ViewKeySchema } from "@lobu/core/contracts/tools/manage-views";
import {
	hasWorkspaceAttachment,
	isEventAttachment,
	matchesCollection,
	matchesRecord,
} from "@lobu/core/contracts/tools/view-attach";
import type { Env } from "../index";
import { ToolUserError } from "../utils/errors";
import { resolvePublicOrigin } from "../utils/public-origin";
import { viewPathSuffix } from "@lobu/core/contracts/tools/view-path";
import { getOrganizationSlug } from "../utils/url-builder";
import { getView, LOBU_VIEWS_RESOURCE_URI, viewResourceUri, type StoredView } from "../views/views";
import { listLiveGrantedMemberWorkspaces } from "../auth/oauth/workspace-grants";
import { resolveToolWorkspaceTarget } from "../sandbox/client-sdk";
import { getDb } from "../db/client";
import { requireWorkspaceContext } from "./access-control";
import { resolveEventViewSubject } from "../views/event-subject";
import type { AccountToolContext } from "./registry";
import { withValidatedArgs } from "./validate-args";
import { COLLECTION_QUERY_KEY, CollectionSelectionSchema, type CollectionSelection } from "@lobu/core/contracts/tools/collection-selection";

const ParamValueSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);

export const OpenViewSchema = Type.Object(
	{
		key: Type.Optional(ViewKeySchema),
		organization: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Authorized workspace slug or id. Omit key to browse that workspace's views; omit both to open the workspace picker." })),
		scope: Type.Optional(
			Type.Object({
				collection: Type.Optional(CollectionSelectionSchema),
				type: Type.Optional(
					Type.String({ minLength: 1, description: "Entity-type slug the view opens for." })
				),
				entity: Type.Optional(
					Type.Integer({ description: "Entity id the view opens for." })
				),
				event: Type.Optional(
					Type.Integer({
						description:
							"Event id the view opens for. It names the event's supersede lineage, so the view shows the current version, and it opens at /events/<id>/-/views/<key>.",
					})
				),
			}, {
				description: "Required unless the view is attached to the workspace. Pass scope.type, scope.entity, or scope.event to select its subject.",
			})
		),
		params: Type.Optional(
			Type.Record(Type.String(), ParamValueSchema, {
				description: "Declared view params; unknown names are ignored.",
			})
		),
	},
	{ additionalProperties: false }
);

const OpenedViewResultSchema = Type.Object({
	view: Type.String(),
	scope: Type.Object({
		collection: Type.Optional(CollectionSelectionSchema),
		type: Type.Optional(Type.String()),
		entity: Type.Optional(Type.Integer()),
		event: Type.Optional(Type.Integer()),
	}),
	params: Type.Record(Type.String(), ParamValueSchema),
	url: Type.String({
		description: "Web URL rendering the same view with the same params.",
	}),
	resource: Type.String({
		description: "MCP App resource uri a frame host renders.",
	}),
});

const ViewPickerSchema = Type.Object({
	workspaces: Type.Array(Type.Object({ slug: Type.String(), name: Type.String() })),
	organization: Type.Optional(Type.String()),
	views: Type.Array(Type.Object({ key: Type.String(), name: Type.String(), description: Type.String() })),
});

// Keep one object outputSchema for MCP hosts, preserving the keyed result's
// fields while allowing the no-key launcher to return only a picker.
export const OpenViewResultSchema = Type.Object({
	...Type.Partial(OpenedViewResultSchema).properties,
	resource: OpenedViewResultSchema.properties.resource,
	organization: Type.Optional(Type.String()),
	picker: Type.Optional(ViewPickerSchema),
});

/** Resolve explicit frame targets through the same live grant check as SDK reads. */
export async function resolveViewWorkspace(ctx: AccountToolContext, organization?: string) {
	return organization ? resolveToolWorkspaceTarget(organization, ctx) : requireWorkspaceContext(ctx);
}

async function openViewPicker(args: OpenViewArgs, ctx: AccountToolContext): Promise<Static<typeof OpenViewResultSchema>> {
	if (!ctx.isAuthenticated || !ctx.userId) throw new ToolUserError("Sign in to browse workspace views.", 401);
	if (args.scope !== undefined || args.params !== undefined) throw new ToolUserError("Pass a view key with scope or params.", 400);
	const ids = ctx.allowCrossOrg ? ctx.grantedOrganizationIds ?? [] : ctx.organizationId ? [ctx.organizationId] : [];
	const workspaces = await listLiveGrantedMemberWorkspaces({ userId: ctx.userId, grantedOrganizationIds: ids });
	const selected = args.organization ? await resolveViewWorkspace(ctx, args.organization) : ctx.organizationId ? requireWorkspaceContext(ctx) : null;
	const workspace = selected ? workspaces.find(w => w.id === selected.organizationId) : undefined;
	if (selected && !workspace) throw new ToolUserError("Workspace is not available for this authorization.", 403, "PERMISSION");
	// Read only the catalog metadata needed for navigation. Never send the
	// compiled/source code or guess subjects for record/collection/event views.
	const sql = getDb();
	const rows = workspace ? await sql<{ key: string; name: string; description: string }>`
		SELECT key, name, description FROM views
		WHERE organization_id = ${workspace.id} AND attach @> '[{"workspace":true}]'::jsonb
		ORDER BY key LIMIT 100
	` : [];
	return {
		resource: LOBU_VIEWS_RESOURCE_URI,
		...(workspace ? { url: `${resolvePublicOrigin(ctx.requestUrl ?? ctx.baseUrl ?? "http://127.0.0.1")}/${workspace.slug}` } : {}),
		picker: {
			workspaces: workspaces.map(w => ({ slug: w.slug, name: w.name })),
			...(workspace ? { organization: workspace.slug } : {}),
			views: rows.map(v => ({ key: v.key, name: v.name, description: v.description })),
		},
	};
}

type OpenViewArgs = Static<typeof OpenViewSchema>;

/**
 * Validate caller params against the view's declarations: unknown names are
 * ignored, absent names fall back to their defaults, and declared names must
 * match their declared scalar type. The canonical map is what the frame and
 * the URL both carry, so neither can smuggle an undeclared query into SQL.
 */
function resolveViewParams(
	view: NonNullable<Awaited<ReturnType<typeof getView>>>,
	params: Record<string, string | number | boolean> | undefined
): Record<string, string | number | boolean> {
	const declared = view.params ?? {};
	const provided = params ?? {};
	const resolved: Record<string, string | number | boolean> = {};
	for (const [name, decl] of Object.entries(declared)) {
		if (Object.hasOwn(provided, name)) {
			const value = provided[name];
			if (typeof value !== decl.type) {
				throw new ToolUserError(
					`Param '${name}' must be a ${decl.type}`,
					400
				);
			}
			resolved[name] = value;
		} else if (decl.default !== undefined) {
			if (
				typeof decl.default !== "string" &&
				typeof decl.default !== "number" &&
				typeof decl.default !== "boolean"
			) {
				throw new ToolUserError(
					`Param '${name}' has a non-scalar default; re-save the view`,
					500
				);
			}
			resolved[name] = decl.default;
		}
	}
	return resolved;
}

/**
 * The page that renders `view` for `scope`, chosen from the view's attachments
 * exactly as the web host selects them, so the link never lands on a
 * "no view named …" page: the Data hub mounts workspace views, a list page its
 * collection tabs, and a record view opens full page under its record.
 */
async function resolveViewPath(
	view: StoredView,
	scope: { type?: string; entity?: number; collection?: CollectionSelection },
	orgSlug: string,
	organizationId: string
): Promise<string> {
	const suffix = viewPathSuffix(view.key);
	const sql = getDb();
	if (scope.entity !== undefined) {
		const rows = await sql<{ entity_type: string; slug: string }>`
      SELECT et.slug AS entity_type, e.slug
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.id = ${scope.entity}
        AND e.organization_id = ${organizationId}
        AND e.deleted_at IS NULL
      LIMIT 1
    `;
		const row = rows[0];
		if (!row) {
			throw new ToolUserError(`Entity ${scope.entity} not found`, 404);
		}
		const record = { type: row.entity_type, id: scope.entity };
		if (view.attach.some((a) => matchesRecord(a, record))) {
			return `/${orgSlug}/${row.entity_type}/${row.slug}${suffix}`;
		}
		throw new ToolUserError(
			`View '${view.key}' is not attached to entity ${scope.entity}`,
			400
		);
	}
	if (scope.type !== undefined) {
		const rows = await sql<{ id: number }>`
      SELECT id FROM entity_types
      WHERE slug = ${scope.type}
        AND deleted_at IS NULL
        AND organization_id = ${organizationId}
      LIMIT 1
    `;
		if (rows.length === 0) {
			throw new ToolUserError(`Entity type '${scope.type}' not found`, 404);
		}
		const type = scope.type;
		if (view.attach.some((a) => matchesCollection(a, type, scope.collection))) {
			return `/${orgSlug}/${scope.type}${suffix}`;
		}
		throw new ToolUserError(
			`View '${view.key}' is not a tab on type '${scope.type}'`,
			400
		);
	}
	if (hasWorkspaceAttachment(view.attach)) {
		return `/${orgSlug}/data${suffix}`;
	}
	// A collection tab is a useful error hint, never an inferred frame scope.
	const collections = [
		...new Set(view.attach.flatMap((a) => ("collection" in a ? [a.collection] : []))),
	];
	throw new ToolUserError(
		view.attach.every(isEventAttachment) && view.attach.length > 0
			? `View '${view.key}' renders one event; pass scope.event`
			: `View '${view.key}' has no page without a scope; pass scope.type or scope.entity${
					collections.length === 1 ? ` (it is a tab on '${collections[0]}')` : ""
				}`,
		400
	);
}

async function openViewImpl(
	args: OpenViewArgs,
	env: Env,
	ctx: AccountToolContext
): Promise<Static<typeof OpenViewResultSchema>> {
	if (!args.key) return openViewPicker(args, ctx);
	const target = await resolveViewWorkspace(ctx, args.organization);
	const view = await getView(target.organizationId, args.key);
	if (!view) {
		throw new ToolUserError(`Unknown view: ${args.key}`, 404);
	}
	const scope = args.scope ?? {};
	if (scope.collection !== undefined && (!scope.type || scope.entity !== undefined || scope.event !== undefined)) {
		throw new ToolUserError("Collection selection requires scope.type without entity or event", 400);
	}
	const orgSlug =
		(await getOrganizationSlug(target.organizationId)) ?? target.organizationId;
	if (
		scope.event !== undefined &&
		(scope.type !== undefined || scope.entity !== undefined)
	) {
		throw new ToolUserError(
			"scope.event names the view's subject on its own; drop scope.type and scope.entity",
			400
		);
	}
	const event = scope.event === undefined ? null : await resolveEventViewSubject(view, scope.event, env, target);
	const pathname =
		scope.event !== undefined
			? `/${orgSlug}/events/${scope.event}${viewPathSuffix(view.key)}`
			: await resolveViewPath(view, scope, orgSlug, target.organizationId);
	const params = resolveViewParams(view, args.params);
	const origin = resolvePublicOrigin(
		ctx.requestUrl ?? ctx.baseUrl ?? "http://127.0.0.1"
	);
	// The view is the path; shared collection selection has its own reserved key.
	const search = new URLSearchParams();
	if (scope.collection !== undefined) search.set(COLLECTION_QUERY_KEY, JSON.stringify(scope.collection));
	for (const [k, v] of Object.entries(params)) search.set(k, String(v));
	const query = search.toString();
	return {
		view: args.key,
		scope: {
			...(scope.collection !== undefined ? { collection: scope.collection } : {}),
			...(scope.type !== undefined ? { type: scope.type } : {}),
			...(scope.entity !== undefined ? { entity: scope.entity } : {}),
			...(event ? { event: event.id } : {}),
		},
		params,
		url: `${origin}${pathname}${query ? `?${query}` : ""}`,
		resource: viewResourceUri(args.key, args.organization ? orgSlug : undefined),
		...(args.organization ? { organization: orgSlug } : {}),
	};
}

export const openView = withValidatedArgs(
	"open_view",
	OpenViewSchema,
	openViewImpl
);
