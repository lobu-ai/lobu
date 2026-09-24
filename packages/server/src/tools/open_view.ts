import { type Static, Type } from "@sinclair/typebox";
import { ViewKeySchema } from "@lobu/core/contracts/tools/manage-views";
import {
	eventAttachmentsFor,
	hasWorkspaceAttachment,
	isEventAttachment,
	matchesRecord,
	matchesType,
} from "@lobu/core/contracts/tools/view-attach";
import type { Env } from "../index";
import { ToolUserError } from "../utils/errors";
import { resolvePublicOrigin } from "../utils/public-origin";
import { viewPathSuffix } from "@lobu/core/contracts/tools/view-path";
import { getOrganizationSlug } from "../utils/url-builder";
import { getView, viewResourceUri } from "../views/views";
import { getDb, pgBigintArray } from "../db/client";
import { requireWorkspaceContext } from "./access-control";
import { getContent } from "./get_content/handler";
import type { AccountToolContext, ToolContext } from "./registry";
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

export const OpenViewResultSchema = Type.Object({
	view: Type.String(),
	scope: Type.Object({
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

/**
 * The event page for `eventId`, when `view` attaches to it. The event is read
 * through `read_knowledge` itself — the exact-id read the web event page
 * renders — so the caller's workspace, connection-visibility and agent read
 * policy decide whether it exists, and a view can never open over an event its
 * caller cannot read. The id names a supersede lineage; the match is made on
 * its current version (the row nothing supersedes).
 */
async function resolveEventViewPath(
	view: StoredView,
	eventId: number,
	orgSlug: string,
	env: Env,
	ctx: ToolContext
): Promise<string> {
	type Row = { semantic_type: string; entity_ids: number[]; superseded_by?: number | null };
	let current: Row | null = null;
	for (let offset = 0; !current; offset += 100) {
		const read = await getContent({ content_ids: [eventId], limit: 100, offset }, env, ctx);
		current = (read.content as Row[]).find((row) => row.superseded_by == null) ?? null;
		if (!read.page?.has_more) break;
	}
	if (!current) {
		throw new ToolUserError(`Event ${eventId} not found`, 404);
	}
	const kinds = eventAttachmentsFor(view.attach, current.semantic_type);
	if (kinds.length === 0) {
		throw new ToolUserError(
			`View '${view.key}' is not attached to '${current.semantic_type}' events`,
			400
		);
	}
	const entityIds = current.entity_ids.filter((id) => Number.isInteger(id));
	const sql = getDb();
	const linkedTypes =
		entityIds.length === 0
			? []
			: await sql<{ slug: string }>`
          SELECT DISTINCT et.slug
          FROM entities e
          JOIN entity_types et ON et.id = e.entity_type_id
          WHERE e.id = ANY(${pgBigintArray(entityIds)}::bigint[])
            AND e.organization_id = ${ctx.organizationId}
            AND e.deleted_at IS NULL
            AND et.deleted_at IS NULL
        `;
	const types = new Set(linkedTypes.map((row) => row.slug));
	if (!kinds.some((a) => types.has(a.type))) {
		throw new ToolUserError(
			`View '${view.key}' renders '${current.semantic_type}' events linked to ${kinds
				.map((a) => `a ${a.type}`)
				.join(" or ")}; event ${eventId} links none`,
			400
		);
	}
	// The permalink id, not the current version's: the page resolves the
	// lineage the same way this did.
	return `/${orgSlug}/events/${eventId}${viewPathSuffix(view.key)}`;
}

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
): Promise<{ pathname: string; card: boolean }> {
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
		const record = {
			type: row.entity_type,
			id: scope.entity,
			slug: row.slug,
			parentId: row.parent_id,
		};
		const recordPath = `/${orgSlug}/${row.entity_type}/${row.slug}`;
		if (view.attach.some((a) => matchesRecord(a, record, "tab"))) {
			return { pathname: `${recordPath}${suffix}`, card: false };
		}
		// An Overview card renders on the record page itself, with its defaults.
		if (view.attach.some((a) => matchesRecord(a, record, "overview"))) {
			return { pathname: recordPath, card: true };
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
		if (view.attach.some((a) => matchesType(a, type, "tab"))) {
			return { pathname: `/${orgSlug}/${scope.type}${suffix}`, card: false };
		}
		throw new ToolUserError(
			`View '${view.key}' is not a tab on type '${scope.type}'`,
			400
		);
	}
	if (hasWorkspaceAttachment(view.attach)) {
		return { pathname: `/${orgSlug}/data${suffix}`, card: false };
	}
	// A type tab is a useful error hint, never an inferred frame scope.
	const typeTabs = [
		...new Set(
			view.attach.flatMap((a) => {
				const type = (a as { type?: string }).type;
				return type !== undefined && matchesType(a, type, "tab") ? [type] : [];
			})
		),
	];
	throw new ToolUserError(
		view.attach.every(isEventAttachment) && view.attach.length > 0
			? `View '${view.key}' renders one event; pass scope.event`
			: `View '${view.key}' has no page without a scope; pass scope.type or scope.entity${
					typeTabs.length === 1 ? ` (it is a tab on '${typeTabs[0]}')` : ""
				}`,
		400
	);
}

async function openViewImpl(
	args: OpenViewArgs,
	env: Env,
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
	if (
		scope.event !== undefined &&
		(scope.type !== undefined || scope.entity !== undefined)
	) {
		throw new ToolUserError(
			"scope.event names the view's subject on its own; drop scope.type and scope.entity",
			400
		);
	}
	const { pathname, card } =
		scope.event !== undefined
			? {
					pathname: await resolveEventViewPath(
						view,
						scope.event,
						orgSlug,
						env,
						target
					),
					card: false,
				}
			: await resolveViewPath(view, scope, orgSlug, target.organizationId);
	const params = resolveViewParams(view, args.params);
	if (card) {
		// The record page mounts a card with its defaults and nothing else, so a
		// link carrying other values would render something different.
		const defaults = resolveViewParams(view, undefined);
		const overridden = Object.keys(params).filter((k) => params[k] !== defaults[k]);
		if (overridden.length > 0) {
			throw new ToolUserError(
				`View '${view.key}' renders as an Overview card on that record, which takes no params (${overridden.join(", ")})`,
				400
			);
		}
	}
	const origin = resolvePublicOrigin(
		ctx.requestUrl ?? ctx.baseUrl ?? "http://127.0.0.1"
	);
	// The view is the path; the query string is its params and nothing else.
	const search = new URLSearchParams();
	if (!card) {
		for (const [k, v] of Object.entries(params)) search.set(k, String(v));
	}
	const query = search.toString();
	return {
		view: args.key,
		scope: {
			...(scope.type !== undefined ? { type: scope.type } : {}),
			...(scope.entity !== undefined ? { entity: scope.entity } : {}),
			...(scope.event !== undefined ? { event: scope.event } : {}),
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
