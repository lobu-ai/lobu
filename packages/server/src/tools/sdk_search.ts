/**
 * Method and sandbox-helper discovery for `query_sdk` / `run_sdk`. Match order:
 * exact path drill-down → namespace prefix listing → substring on path +
 * summary. Client method visibility matches the sandbox dispatch manifests.
 */

import { type Static, Type } from "@sinclair/typebox";
import {
	resolveActingPrincipal,
	resolveWriteEffect,
} from "../authz/entity-policy";
import type { WriteAction } from "../authz/write-action-manifest";
import { resolveSdkMaxAccessLevel } from "../auth/tool-access";
import { getDb } from "../db/client";
import type { Env } from "../index";
import {
	METHOD_METADATA,
	RUNTIME_HELPER_METADATA,
	type MethodMetadata,
} from "../sandbox/method-metadata";
import { SDK_FIELD_ALIASES } from "../sandbox/sdk-aliases";
import {
	formatSdkRequiredTier,
	resolveSdkAccessGuidance,
	sdkMethodVisible,
	type SdkDiscoveryMode,
} from "../sandbox/sdk-method-access";
import type { AccountToolContext } from "./registry";
import { withValidatedArgs } from "./validate-args";
import { searchLiveConnectors } from "./connector-discovery";

/**
 * agents.* paths → agent_config action that must not be blanket-denied for the
 * method to appear in discovery. list/get use read; mutate uses create/update/
 * delete. manage is raw — hide when every agent_config action is denied at the
 * blanket.
 */
export const AGENTS_SDK_ACTION: Record<string, WriteAction | "any"> = {
	"agents.list": "read",
	"agents.get": "read",
	"agents.create": "create",
	"agents.update": "update",
	"agents.delete": "delete",
	"agents.manage": "any",
};

const SDK_DISCOVERY_METADATA: Record<string, MethodMetadata> = {
	...METHOD_METADATA,
	...RUNTIME_HELPER_METADATA,
};

const NAMESPACES = [
	...new Set(
		Object.keys(SDK_DISCOVERY_METADATA)
			.filter((path) => path.includes("."))
			.map((path) => path.split(".")[0])
	),
].sort();

const METADATA_BY_LOWER_PATH = new Map(
	Object.entries(SDK_DISCOVERY_METADATA).map(([path, meta]) => [
		path.toLowerCase(),
		[path, meta] as const,
	])
);

export const SdkSearchSchema = Type.Object({
	query: Type.String({
		description: `SDK method or runtime-helper discovery query. Use a namespace (e.g. 'automations'), one or more dotted paths separated by whitespace (e.g. 'automations.create ctx.sleep'), an optional client. prefix, or free text. Pass mode='read' for query_sdk-safe methods only; omit mode for your full run_sdk tier. Namespaces: ${NAMESPACES.join(", ")}.`,
		minLength: 1,
	}),
	mode: Type.Optional(
		Type.Union(
			[
				Type.Literal("read", {
					description: "Only methods callable via query_sdk (read access).",
				}),
				Type.Literal("full", {
					description:
						"Methods callable via run_sdk at your access tier (default).",
				}),
			],
			{
				description:
					"Filter results to match query_sdk ('read') or run_sdk ('full', default).",
			}
		)
	),
	limit: Type.Optional(
		Type.Number({
			description: "Max matches to return. Default 20, max 100.",
			minimum: 1,
			maximum: 100,
		})
	),
});

type SdkSearchArgs = Static<typeof SdkSearchSchema>;

export const SdkSearchResultSchema = Type.Object({
	query: Type.String({ description: "The query that was searched." }),
	match_count: Type.Integer({
		description: "Number of matches returned.",
	}),
	results: Type.Array(Type.String(), {
		description: "Rendered method-documentation strings, one per match.",
	}),
	notes: Type.Optional(
		Type.String({
			description:
				"Free-text hints (e.g. ambiguity, suggestions) when relevant.",
		})
	),
});

export type SdkSearchResult = Static<typeof SdkSearchResultSchema>;

async function agentConfigBlanketDenied(
	ctx: AccountToolContext,
	action: WriteAction
): Promise<boolean> {
	if (!ctx.organizationId || (!ctx.agentId && !ctx.actingAutomationId)) {
		return false;
	}
	const actor = await resolveActingPrincipal(getDb(), {
		organizationId: ctx.organizationId,
		userId: ctx.userId,
		agentId: ctx.agentId,
		sessionAutomationId: ctx.actingAutomationId ?? null,
	});
	if (actor.kind === "user") return false;
	const effect = await resolveWriteEffect({
		organizationId: ctx.organizationId,
		resourceClass: "agent_config",
		principalKind: actor.kind,
		principalId: actor.id,
		ownerAgentId: actor.ownerAgentId,
		ownerResolved: actor.ownerResolved,
		action,
		targetAgentId: null,
	});
	return effect === "deny" || effect === "disabled";
}

/** Paths hidden for this agent principal by agent_config blanket policy. */
async function deniedAgentsSdkPaths(ctx: AccountToolContext): Promise<Set<string>> {
	const denied = new Set<string>();
	if (!ctx.agentId && !ctx.actingAutomationId) return denied;

	const actions: WriteAction[] = ["read", "create", "update", "delete"];
	const denyByAction = new Map<WriteAction, boolean>();
	for (const action of actions) {
		denyByAction.set(action, await agentConfigBlanketDenied(ctx, action));
	}
	const allDenied = actions.every((a) => denyByAction.get(a));

	for (const [path, mapped] of Object.entries(AGENTS_SDK_ACTION)) {
		if (mapped === "any") {
			if (allDenied) denied.add(path);
			continue;
		}
		if (denyByAction.get(mapped)) denied.add(path);
	}
	return denied;
}

async function catalogForCaller(
	ctx: AccountToolContext,
	mode: SdkDiscoveryMode
): Promise<Array<[string, MethodMetadata]>> {
	const callerMax = resolveSdkMaxAccessLevel(
		ctx.memberRole,
		ctx.scopes,
		ctx.allowCrossOrg,
	);
	const policyDenied = await deniedAgentsSdkPaths(ctx);
	return Object.entries(SDK_DISCOVERY_METADATA).filter(([path, meta]) => {
		if (!sdkMethodVisible(meta.access, callerMax, mode)) return false;
		if (policyDenied.has(path)) return false;
		return true;
	});
}

function hiddenMethodNote(
	path: string,
	meta: MethodMetadata,
	mode: SdkDiscoveryMode,
	policyDenied: Set<string>,
	ctx: AccountToolContext,
): string {
	if (policyDenied.has(path)) {
		return `${path} is blocked by this agent's agent_config permissions.`;
	}
	// Pass the whole metadata, not just `meta.access`: an `external` method
	// carries the tier its manage_* action really enforces on `enforcedTier`, and
	// the reported tier must match enforcement or the caller is sent to retry
	// into a hard admin rejection.
	const guidance = resolveSdkAccessGuidance(
		meta,
		ctx.memberRole,
		ctx.scopes,
		ctx.allowCrossOrg,
	);
	if (mode === "read" && meta.access !== "read") {
		if (guidance.available || guidance.progressivelyAuthorizable) {
			return `${path} exists but requires run_sdk (access: ${formatSdkRequiredTier(meta)}). Retry with mode='full'. ${guidance.progressivelyAuthorizable ? guidance.instruction ?? "" : ""}`.trim();
		}
		return `${path} is not available at your access tier (access: ${formatSdkRequiredTier(meta)}). ${guidance.instruction ?? ""}`.trim();
	}
	return `${path} is not available at your access tier (access: ${formatSdkRequiredTier(meta)}). ${guidance.instruction ?? ""}`.trim();
}

/**
 * Zero-match note for a query nothing matched BY NAME. Access is deliberately
 * not asserted as the cause: both call sites are reached only after every
 * hidden-method explanation (`hiddenMethodNote`, `hiddenNamespaceNote`) came
 * back empty, so the likely cause is wording, not tier. Widening means
 * mode='full' — mode='read' NARROWS the catalog, so it is no help on a miss.
 */
function noNameMatchNote(mode: SdkDiscoveryMode): string {
	const readHint =
		mode === "read"
			? " Only query_sdk-safe methods were searched; pass mode='full' for write and admin methods."
			: "";
	return `No method or runtime-helper name matches that wording. Try a namespace (${NAMESPACES.join(", ")}) or a verb (create, list, search).${readHint} A method above your access tier is also not listed.`;
}

function renderListLine(path: string, meta: MethodMetadata): string {
	return `${path} — ${meta.summary}`;
}

function renderDrillDown(path: string, meta: MethodMetadata): string {
	const lines: string[] = [];
	lines.push(path);
	lines.push(`  ${meta.summary}`);
	lines.push(
		`  access: ${formatSdkRequiredTier(meta)}${meta.cost ? ` (cost: ${meta.cost})` : ""}`
	);
	if (meta.signature) {
		lines.push(`  signature: ${meta.signature}`);
	}
	// Rendered from the SAME registry the sandbox dispatch rewrites at runtime
	// (sdk-aliases.ts), so documented aliases can never drift from accepted ones.
	const aliases = SDK_FIELD_ALIASES[path];
	if (aliases) {
		lines.push(
			`  accepted aliases: ${Object.entries(aliases)
				.map(([alias, canonical]) => `${alias} → ${canonical}`)
				.join(", ")}`,
		);
	}
	if (meta.throws && meta.throws.length > 0) {
		lines.push(`  throws: ${meta.throws.join(", ")}`);
	}
	if (meta.example) {
		lines.push(`  example: ${meta.example}`);
	}
	if (meta.usageExample) {
		lines.push("  usage_example:");
		for (const exampleLine of meta.usageExample.split("\n")) {
			lines.push(`    ${exampleLine}`);
		}
	}
	return lines.join("\n");
}

function normalizeQueryTerm(term: string): string {
	const lower = term.toLowerCase();
	return lower.startsWith("client.") ? lower.slice("client.".length) : lower;
}

/** Whether a discovery query names only the ClientSDK surface, not a connector. */
export function isSdkOnlyDiscoveryQuery(query: string): boolean {
	const q = query.trim();
	const normalized = normalizeQueryTerm(q);
	const firstSegment = normalized.split(".")[0];
	const isSdkNamespace = NAMESPACES.some(
		(ns) => ns.toLowerCase() === firstSegment,
	);
	const isExactNamespace = NAMESPACES.some(
		(ns) => ns.toLowerCase() === normalized,
	);
	return (
		/^client\b/i.test(q) ||
		isExactNamespace ||
		(q.includes(".") && isSdkNamespace)
	);
}

export const sdkSearch = withValidatedArgs(
	"search_sdk",
	SdkSearchSchema,
	sdkSearchImpl
);

async function sdkSearchImpl(
	args: SdkSearchArgs,
	env: Env,
	ctx: AccountToolContext
): Promise<SdkSearchResult> {
	// Unified-catalog search (executor pattern): a query like "website" or "slack"
	// names a CONNECTOR, not an SDK method, so pure method search returns nothing
	// useful. Search live connectors and surface them (+ lifecycle) ABOVE method
	// docs. Skip the connector lookup ONLY for genuine SDK intent — a bare
	// namespace, a `client.`-prefixed term, or a dotted path whose FIRST segment
	// is a real SDK namespace (`feeds.create`). A dotted CONNECTOR id
	// (`google.calendar`) must still be searched: its first segment (`google`) is
	// not an SDK namespace.
	const q = args.query.trim();
	// Bare namespaces are just as explicit as dotted method paths. Searching the
	// connector catalog for `agents`/`feeds` used to prepend unrelated connector
	// matches ahead of the namespace methods the caller explicitly requested.
	const looksLikeMethodPath = isSdkOnlyDiscoveryQuery(q);
	const connectorHits = looksLikeMethodPath
		? []
		: await searchLiveConnectors(q, env, ctx);
	const methodResult = await sdkMethodSearch(args, env, ctx);
	if (!ctx.organizationId && ctx.allowCrossOrg) {
		methodResult.notes = [
			"Workspace examples assume a selected client: const workspace = await client.org(target), then use workspace.<method>. Root organizations discovery, log, and conversations.setTitle need no workspace.",
			methodResult.notes,
		].filter(Boolean).join(" ");
	}
	if (connectorHits.length === 0) return methodResult;

	// Cap the COMBINED list at the same limit the method search honors, so
	// prepended connector hits can't push the response past the documented max.
	// Connector hits are the more specific answer, so they keep priority.
	const limit = Math.min(args.limit ?? 20, 100);
	const combined = [...connectorHits, ...methodResult.results];
	const results = combined.slice(0, limit);
	const dropped = combined.length - results.length;
	// When the method search found nothing, its note may carry the real answer
	// (e.g. "agents.* exists but requires admin") — losing it would leave only
	// the unrelated connector hits.
	const baseNote =
		methodResult.results.length > 0
			? "Top matches are live connectors (with lifecycle); method docs follow."
			: [
					"Matched live connectors (not SDK methods). Follow the lifecycle shown; query a namespace (e.g. 'feeds') for method signatures.",
					methodResult.notes,
				]
					.filter(Boolean)
					.join(" ");
	const truncNote =
		dropped > 0
			? ` ${dropped} more result(s) truncated; raise \`limit\` or refine the query.`
			: "";
	return {
		query: methodResult.query,
		match_count: results.length,
		results,
		notes: `${baseNote}${truncNote}`.trim(),
	};
}

async function sdkMethodSearch(
	args: SdkSearchArgs,
	_env: Env,
	ctx: AccountToolContext
): Promise<SdkSearchResult> {
	const limit = Math.min(args.limit ?? 20, 100);
	const query = args.query.trim();
	const terms = query
		.split(/[\s,]+/)
		.map(normalizeQueryTerm)
		.filter(Boolean);
	const lower = normalizeQueryTerm(query);
	const mode: SdkDiscoveryMode = args.mode ?? "full";
	const catalog = await catalogForCaller(ctx, mode);
	const policyDenied = await deniedAgentsSdkPaths(ctx);
	const callerMax = resolveSdkMaxAccessLevel(
		ctx.memberRole,
		ctx.scopes,
		ctx.allowCrossOrg,
	);
	const isMultiMethodQuery =
		terms.length > 1 &&
		terms.every(
			(term) => term.includes(".") || METADATA_BY_LOWER_PATH.has(term)
		);

	if (isMultiMethodQuery) {
		const seen = new Set<string>();
		const matches: Array<{
			path: string;
			meta: MethodMetadata;
			exact: boolean;
		}> = [];
		const hidden: string[] = [];

		for (const term of terms) {
			const exact = METADATA_BY_LOWER_PATH.get(term);
			if (exact) {
				const [path, meta] = exact;
				if (
					!sdkMethodVisible(meta.access, callerMax, mode) ||
					policyDenied.has(path)
				) {
					hidden.push(hiddenMethodNote(path, meta, mode, policyDenied, ctx));
				} else if (!seen.has(path)) {
					seen.add(path);
					matches.push({ path, meta, exact: true });
				}
				continue;
			}

			for (const [path, meta] of catalog) {
				if (path.toLowerCase().includes(term) && !seen.has(path)) {
					seen.add(path);
					matches.push({ path, meta, exact: false });
				}
			}
			for (const [path, meta] of catalog) {
				if (meta.summary.toLowerCase().includes(term) && !seen.has(path)) {
					seen.add(path);
					matches.push({ path, meta, exact: false });
				}
			}
		}

		if (matches.length > 0) {
			return {
				query,
				match_count: matches.length,
				results: matches
					.slice(0, limit)
					.map(({ path, meta, exact }) =>
						exact ? renderDrillDown(path, meta) : renderListLine(path, meta)
					),
				notes:
					matches.length > limit
						? `${matches.length - limit} more matches; raise \`limit\` or refine the query.`
						: hidden.length > 0
							? hidden.join(" ")
							: mode === "read"
								? "Showing query_sdk-safe methods only. Pass mode='full' for write/admin methods."
								: undefined,
			};
		}

		return {
			query,
			match_count: 0,
			results: [],
			notes:
				hidden.join(" ") ||
				noNameMatchNote(mode),
		};
	}

	const exact = METADATA_BY_LOWER_PATH.get(lower);
	if (exact) {
		const [path, meta] = exact;
		if (
			!sdkMethodVisible(meta.access, callerMax, mode) ||
			policyDenied.has(path)
		) {
			return {
				query,
				match_count: 0,
				results: [],
				notes: hiddenMethodNote(path, meta, mode, policyDenied, ctx),
			};
		}
		return {
			query,
			match_count: 1,
			results: [renderDrillDown(path, meta)],
		};
	}

	// A namespace query whose methods are ALL hidden at this mode/tier must say
	// so by name (e.g. "agents" in mode='read') — otherwise the caller only sees
	// unrelated substring/connector matches and concludes the namespace does not
	// exist.
	let hiddenNamespaceNote: string | undefined;
	if (lower.indexOf(".") === -1) {
		// Case-insensitive like METADATA_BY_LOWER_PATH: the query is lowercased,
		// but namespaces preserve SDK casing (entitySchema, authProfiles) — a
		// case-sensitive prefix match would misreport those as hidden.
		const prefix = `${lower}.`;
		const ns = catalog.filter(([p]) => p.toLowerCase().startsWith(prefix));
		const topLevel = catalog.filter(([p]) => p.toLowerCase() === lower);
		const combined = [...topLevel, ...ns];
		if (combined.length === 0) {
			const hiddenNs = Object.entries(SDK_DISCOVERY_METADATA).filter(([p]) =>
				p.toLowerCase().startsWith(prefix)
			);
			if (hiddenNs.length > 0) {
				// Full metadata, not the bare marker: an `external` method's
				// `enforcedTier` is what the namespace's aggregate tier must reflect.
				const accesses = hiddenNs.map(([, meta]) => meta);
				const accessLabels = [...new Set(accesses.map(formatSdkRequiredTier))]
					.sort()
					.join(", ");
				const guidance = resolveSdkAccessGuidance(
					accesses,
					ctx.memberRole,
					ctx.scopes,
					ctx.allowCrossOrg,
				);
				const nextStep = guidance.available
					? "Retry with mode='full' and call the returned methods via run_sdk."
					: guidance.instruction;
				hiddenNamespaceNote = `${lower}.* exists (${hiddenNs.length} method(s), access: ${accessLabels}) but none are visible${mode === "read" ? " in mode='read'" : ""} at your tier. ${nextStep ?? ""}`.trim();
			}
		}
		if (combined.length > 0) {
			return {
				query,
				match_count: combined.length,
				results: combined.slice(0, limit).map(([p, m]) => renderListLine(p, m)),
				notes:
					combined.length > limit
						? `${combined.length - limit} more matches; raise \`limit\` or refine the query.`
						: mode === "read"
							? "Showing query_sdk-safe methods only. Pass mode='full' for write/admin methods."
							: undefined,
			};
		}
	}

	const seen = new Set<string>();
	const matches: Array<[string, MethodMetadata]> = [];
	for (const [path, meta] of catalog) {
		if (path.toLowerCase().includes(lower) && !seen.has(path)) {
			seen.add(path);
			matches.push([path, meta]);
		}
	}
	for (const [path, meta] of catalog) {
		if (meta.summary.toLowerCase().includes(lower) && !seen.has(path)) {
			seen.add(path);
			matches.push([path, meta]);
		}
	}

	// Natural-language clients commonly search with a bag of concepts rather
	// than an exact phrase (for example "connections sync run"). Preserve the
	// precise phrase results above, then fall back to token-ranked matches so a
	// single extra word does not turn valid discovery into zero results.
	if (matches.length === 0 && terms.length > 1) {
		const ranked = catalog
			.map(([path, meta]) => {
				const pathText = path.toLowerCase();
				const summaryText = meta.summary.toLowerCase();
				const score = terms.reduce(
					(total, term) =>
						total +
						(pathText.includes(term) ? 2 : 0) +
						(summaryText.includes(term) ? 1 : 0),
					0
				);
				return { path, meta, score };
			})
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
		for (const { path, meta } of ranked) matches.push([path, meta]);
	}

	if (matches.length === 0) {
		// Connector intent-search is handled by the sdkSearchImpl wrapper, which
		// merges live-connector hits ahead of these method results — so a
		// zero-method query like "website" still returns the connector.
		const hiddenExact = METADATA_BY_LOWER_PATH.get(lower);
		const existsButHidden = hiddenExact
			? hiddenMethodNote(hiddenExact[0], hiddenExact[1], mode, policyDenied, ctx)
			: undefined;
		return {
			query,
			match_count: 0,
			results: [],
			notes:
				hiddenNamespaceNote ??
				existsButHidden ??
				noNameMatchNote(mode),
		};
	}

	const tailNote =
		matches.length > limit
			? `${matches.length - limit} more matches; raise \`limit\` or refine the query.`
			: mode === "read"
				? "Showing query_sdk-safe methods only. Pass mode='full' for write/admin methods."
				: undefined;
	return {
		query,
		match_count: matches.length,
		results: matches.slice(0, limit).map(([p, m]) => renderListLine(p, m)),
		notes: hiddenNamespaceNote
			? [hiddenNamespaceNote, tailNote].filter(Boolean).join(" ")
			: tailNote,
	};
}
