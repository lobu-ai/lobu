import { type Static, Type } from "@sinclair/typebox";
import { ViewKeySchema } from "@lobu/core/contracts/tools/manage-views";
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
	let pathname: string;
	const orgSlug =
		(await getOrganizationSlug(target.organizationId)) ?? target.organizationId;
	if (scope.entity !== undefined) {
		const sql = getDb();
		const rows = await sql<{ entity_type: string; slug: string }>`
      SELECT et.slug AS entity_type, e.slug
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.id = ${scope.entity}
        AND e.organization_id = ${target.organizationId}
        AND e.deleted_at IS NULL
      LIMIT 1
    `;
		const row = rows[0];
		if (!row) {
			throw new ToolUserError(`Entity ${scope.entity} not found`, 404);
		}
		pathname = `/${orgSlug}/${row.entity_type}/${row.slug}`;
	} else if (scope.type !== undefined) {
		const sql = getDb();
		const rows = await sql<{ id: number }>`
      SELECT id FROM entity_types
      WHERE slug = ${scope.type}
        AND deleted_at IS NULL
        AND organization_id = ${target.organizationId}
      LIMIT 1
    `;
		if (rows.length === 0) {
			throw new ToolUserError(`Entity type '${scope.type}' not found`, 404);
		}
		pathname = `/${orgSlug}/${scope.type}`;
	} else {
		// No scope: a workspace view, a tab on the Data hub.
		pathname = `/${orgSlug}/data`;
	}
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
		url: `${origin}${pathname}${viewPathSuffix(args.key)}${query ? `?${query}` : ""}`,
		resource: viewResourceUri(args.key),
	};
}

export const openView = withValidatedArgs(
	"open_view",
	OpenViewSchema,
	openViewImpl
);
