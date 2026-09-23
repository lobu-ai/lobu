import { type Static, Type } from "@sinclair/typebox";
import {
	type ViewAttachment,
	ViewKeySchema,
} from "@lobu/core/contracts/tools/manage-views";
import type { Env } from "../index";
import { ToolUserError } from "../utils/errors";
import { resolvePublicOrigin } from "../utils/public-origin";
import { viewPathSuffix } from "@lobu/core/contracts/tools/view-path";
import { getOrganizationSlug } from "../utils/url-builder";
import { getView, viewResourceUri } from "../views/views";
import { getDb } from "../db/client";
import { requireWorkspaceContext } from "./access-control";
import type { AccountToolContext } from "./registry";
import { withValidatedArgs } from "./validate-args";

const ParamValueSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);

export const OpenViewSchema = Type.Object(
	{
		key: ViewKeySchema,
		scope: Type.Optional(
			Type.Object({
				type: Type.Optional(
					Type.String({ minLength: 1, description: "Entity-type slug the view opens for." })
				),
				entity: Type.Optional(
					Type.Integer({ description: "Entity id the view opens for." })
				),
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

export const OpenViewResultSchema = Type.Object({
	view: Type.String(),
	scope: Type.Object({
		type: Type.Optional(Type.String()),
		entity: Type.Optional(Type.Integer()),
	}),
	params: Type.Record(Type.String(), ParamValueSchema),
	url: Type.String({
		description: "Web URL rendering the same view with the same params.",
	}),
	resource: Type.String({
		description: "MCP App resource uri a frame host renders.",
	}),
});

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

type StoredView = NonNullable<Awaited<ReturnType<typeof getView>>>;

const isTab = (a: ViewAttachment) => (a.placement ?? "tab") === "tab";

/**
 * The page that renders `view` for `scope`, chosen from the view's attachments
 * exactly as the web host selects them, so the link never lands on a
 * "no view named …" page: the Data hub mounts workspace views, a type page its
 * type's tabs, a record page its tabs plus Overview cards.
 */
async function resolveViewPath(
	view: StoredView,
	scope: { type?: string; entity?: number },
	orgSlug: string,
	organizationId: string
): Promise<string> {
	const suffix = viewPathSuffix(view.key);
	const sql = getDb();
	if (scope.entity !== undefined) {
		const rows = await sql<{
			entity_type: string;
			slug: string;
			parent_id: number | null;
		}>`
      SELECT et.slug AS entity_type, e.slug, e.parent_id
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
		// A slug pin names a top-level record: slugs are unique per parent.
		const onRecord = (a: ViewAttachment) =>
			"entity" in a
				? typeof a.entity === "number"
					? a.entity === scope.entity
					: row.parent_id === null && a.entity === row.slug
				: "type" in a && a.type === row.entity_type;
		const recordPath = `/${orgSlug}/${row.entity_type}/${row.slug}`;
		const matches = view.attach.filter(onRecord);
		if (matches.some(isTab)) return `${recordPath}${suffix}`;
		// An Overview card renders on the record page itself.
		if (matches.length > 0) return recordPath;
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
		if (view.attach.some((a) => "type" in a && a.type === scope.type && isTab(a))) {
			return `/${orgSlug}/${scope.type}${suffix}`;
		}
		throw new ToolUserError(
			`View '${view.key}' is not a tab on type '${scope.type}'`,
			400
		);
	}
	if (view.attach.some((a) => "workspace" in a)) {
		return `/${orgSlug}/data${suffix}`;
	}
	// No workspace attachment: the view's one type tab is its only page.
	const typeTabs = [
		...new Set(
			view.attach.flatMap((a) => ("type" in a && isTab(a) ? [a.type] : []))
		),
	];
	if (typeTabs.length === 1) return `/${orgSlug}/${typeTabs[0]}${suffix}`;
	throw new ToolUserError(
		typeTabs.length > 1
			? `View '${view.key}' is a tab on several types (${typeTabs.join(", ")}); pass scope.type`
			: `View '${view.key}' has no page of its own; pass scope.entity for a record it attaches to`,
		400
	);
}

async function openViewImpl(
	args: OpenViewArgs,
	_env: Env,
	ctx: AccountToolContext
): Promise<Static<typeof OpenViewResultSchema>> {
	const target = requireWorkspaceContext(ctx);
	const view = await getView(target.organizationId, args.key);
	if (!view) {
		throw new ToolUserError(`Unknown view: ${args.key}`, 404);
	}
	const scope = args.scope ?? {};
	const orgSlug =
		(await getOrganizationSlug(target.organizationId)) ?? target.organizationId;
	const pathname = await resolveViewPath(
		view,
		scope,
		orgSlug,
		target.organizationId
	);
	const params = resolveViewParams(view, args.params);
	const origin = resolvePublicOrigin(
		ctx.requestUrl ?? ctx.baseUrl ?? "http://127.0.0.1"
	);
	// The view is the path; the query string is its params and nothing else.
	const search = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) search.set(k, String(v));
	const query = search.toString();
	return {
		view: args.key,
		scope: {
			...(scope.type !== undefined ? { type: scope.type } : {}),
			...(scope.entity !== undefined ? { entity: scope.entity } : {}),
		},
		params,
		url: `${origin}${pathname}${query ? `?${query}` : ""}`,
		resource: viewResourceUri(args.key),
	};
}

export const openView = withValidatedArgs(
	"open_view",
	OpenViewSchema,
	openViewImpl
);
