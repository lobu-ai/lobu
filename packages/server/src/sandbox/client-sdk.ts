/**
 * In-process SDK shared by the `query_sdk` / `run_sdk` MCP tools and automation reactions.
 * `mode: "read"` filters namespaces against `METHOD_METADATA[*].access === "read"`;
 * `client.org(...)` requires an OAuth grant or a verified chat sender grant.
 */

import type { Env } from "../index";
import { getDb } from "../db/client";
import { validateAndScopeQuery } from "../utils/execute-data-sources";
import { resolveWindowQueryContext } from "../automations/window-read-context";
import { CrossOrgAccessDenied, isAdminOrOwnerRole, isInProcessSystemCall, isSystemContext, requireWorkspaceContext } from "../tools/access-control";
import {
	ADMIN_ONLY_QUERYABLE_TABLES,
	SAFE_COLUMN_DEFS,
} from "../utils/table-schema";
import type { AccountToolContext, ToolContext } from "../tools/registry";
import type { ChatSenderReach } from "../auth/oauth/types";
import { resolveGrantedWorkspaceTarget, findUngrantedMemberWorkspace, formatUngrantedMemberMessage } from "../auth/oauth/workspace-grants";
import { boundedQuery, classifyReadQueryFailure } from "../utils/bounded-read";
import { ToolUserError, toolErrorHttpStatus } from "../utils/errors";
import { getOrganizationSlug } from "../utils/url-builder";
import { QUERY_SQL_STATEMENT_TIMEOUT_MS } from "../utils/content-read-bounds";
import { METHOD_METADATA } from "./method-metadata";
import { bindClientContext } from "./workspace-activity";
import type { SDKMode } from "./sdk-manifest";

/**
 * Hard row ceiling on `client.query` results. `query_sql` paginates to at most
 * 500 rows, but the sandbox `client.query` takes arbitrary SQL — without an
 * outer LIMIT a script could `SELECT * FROM events` and materialize unbounded
 * rows host-side. The sandbox per-message cap is a backstop; this stops the
 * allocation at the source. Agents page with their own LIMIT/OFFSET.
 */
const CLIENT_QUERY_MAX_ROWS = 5000;

export { enumerateSDKManifest, type SDKMode } from "./sdk-manifest";

import {
	buildAgentsNamespace,
	buildAuthProfilesNamespace,
	buildAutomationsNamespace,
	buildCatalogNamespace,
	buildClassifiersNamespace,
	buildConnectionsNamespace,
	buildConversationsNamespace,
	buildDevicesNamespace,
	buildEntitiesNamespace,
	buildEntitySchemaNamespace,
	buildFeedsNamespace,
	buildKnowledgeNamespace,
	buildMetricsNamespace,
	buildNotificationsNamespace,
	buildOperationsNamespace,
	buildOrganizationsNamespace,
	buildSchedulesNamespace,
	buildViewsNamespace,
} from "./namespaces";
import type { AgentsNamespace } from "./namespaces/agents";
import type { AuthProfilesNamespace } from "./namespaces/auth-profiles";
import type { CatalogNamespace } from "./namespaces/catalog";
import type { ClassifiersNamespace } from "./namespaces/classifiers";
import type { ConnectionsNamespace } from "./namespaces/connections";
import {
	buildMcpConversationTitle,
	type ConversationsNamespace,
} from "./namespaces/conversations";
import type { DevicesNamespace } from "./namespaces/devices";
import type { EntitiesNamespace } from "./namespaces/entities";
import type { EntitySchemaNamespace } from "./namespaces/entity-schema";
import type { FeedsNamespace } from "./namespaces/feeds";
import type { KnowledgeNamespace } from "./namespaces/knowledge";
import type { MetricsNamespace } from "./namespaces/metrics";
import type { NotificationsNamespace } from "./namespaces/notifications";
import type { OperationsNamespace } from "./namespaces/operations";
import type { OrganizationsNamespace } from "./namespaces/organizations";
import type { ViewsNamespace } from "./namespaces/views";
import type { SchedulesNamespace } from "./namespaces/schedules";
import type { AutomationsNamespace } from "./namespaces/automations";
import { authzScopeFromToolContext } from "../authz/scope";

export interface ClientSDK {
	agents: AgentsNamespace;
	entities: EntitiesNamespace;
	entitySchema: EntitySchemaNamespace;
	catalog: CatalogNamespace;
	connections: ConnectionsNamespace;
	conversations: ConversationsNamespace;
	feeds: FeedsNamespace;
	authProfiles: AuthProfilesNamespace;
	operations: OperationsNamespace;
	automations: AutomationsNamespace;
	classifiers: ClassifiersNamespace;
	views: ViewsNamespace;
	knowledge: KnowledgeNamespace;
	metrics: MetricsNamespace;
	notifications: NotificationsNamespace;
	devices: DevicesNamespace;
	organizations: OrganizationsNamespace;
	schedules: SchedulesNamespace;

	org(slugOrId: string): Promise<ClientSDK>;
	query(sql: string, options?: { window_token?: string }): Promise<unknown[]>;
	log(message: string, data?: Record<string, unknown>): void;
}

/**
 * Resolve a workspace selected by an OAuth or eligible chat caller and carry its
 * membership into the handler context. The selected workspace, not the
 * account client, is authoritative for every leaf permission
 * check performed with the returned context.
 */
export async function resolveCrossOrgToolContext(
	slugOrId: string,
	ctx: AccountToolContext,
	allowCrossOrg: boolean = ctx.allowCrossOrg,
): Promise<ToolContext> {
	if (ctx.chatSenderReach) {
		return resolveChatSenderWorkspace(slugOrId, ctx, ctx.chatSenderReach);
	}
	if (!allowCrossOrg) {
		throw new CrossOrgAccessDenied(
			"Cross-org access is not available on this connection. If the same identity already has access to the target workspace, invoke there directly via /mcp/{slug} (CLI: --context <context> --org <slug>) and use client directly. For cross-org calls, use the unscoped /mcp endpoint with an OAuth session authorized for the target workspace."
		);
	}
	if (!ctx.userId || !Array.isArray(ctx.grantedOrganizationIds)) {
		throw new CrossOrgAccessDenied(
			"Workspace is not available for this authorization."
		);
	}
	const member = await resolveGrantedWorkspaceTarget({
		userId: ctx.userId,
		grantedOrganizationIds: ctx.grantedOrganizationIds,
		slugOrId,
	});
	if (!member) {
		// Member-but-ungranted (e.g. an org created after this OAuth consent)
		// gets an actionable hint; unknown and non-member targets keep the
		// generic answer so client.org() never oracles private workspaces.
		// Agent/automation-bound sessions keep the generic answer too: their
		// fix is reconnecting without the binding, not re-consent, and the
		// bound agent is not the audience for membership enumeration.
		if (!ctx.agentId && ctx.actingAutomationId == null) {
			const ungranted = await findUngrantedMemberWorkspace({
				userId: ctx.userId,
				slugOrId,
			});
			if (ungranted) {
				throw new CrossOrgAccessDenied(formatUngrantedMemberMessage(ungranted.slug), {
					reason: "ungranted_member",
					workspaceSlug: ungranted.slug,
				});
			}
		}
		throw new CrossOrgAccessDenied(
			"Workspace is not available for this authorization."
		);
	}
	if (
		member.id !== ctx.organizationId &&
		(ctx.agentId || ctx.actingAutomationId != null)
	) {
		throw new CrossOrgAccessDenied(
			"Agent- and automation-bound sessions cannot change workspaces. Reconnect without that binding for cross-workspace access."
		);
	}
	return {
		...ctx,
		organizationId: member.id,
		memberRole: member.role,
	};
}

/**
 * Resolve a workspace a caller named in a tool argument (`org_slug`,
 * `organization`, …). Naming the connection's own workspace, by id or slug,
 * is the same as omitting it — never a switch — so a scoped `/mcp/{slug}` or
 * PAT connection accepts it although it cannot reach any other workspace.
 * Every other target goes through `resolveCrossOrgToolContext`, whose typed
 * denial becomes a 403 so REST and MCP agree on the status and code.
 */
export async function resolveToolWorkspaceTarget(
	slugOrId: string,
	ctx: AccountToolContext,
): Promise<ToolContext> {
	const target = slugOrId.trim();
	if (
		ctx.organizationId &&
		(target === ctx.organizationId ||
			target === (await getOrganizationSlug(ctx.organizationId)))
	) {
		return requireWorkspaceContext(ctx);
	}
	try {
		return await resolveCrossOrgToolContext(target, ctx);
	} catch (error) {
		if (error instanceof CrossOrgAccessDenied) {
			throw new ToolUserError(error.message, 403, "PERMISSION");
		}
		throw error;
	}
}

/**
 * A member's direct-message chat turn selecting one of the sender's
 * workspaces (docs/design/chat-sender-workspace-scope.md). There is no grant
 * snapshot: the sender's membership is read from `member` rows now, so a
 * removal applies at once, and an unknown or non-member target gets the same
 * answer as any other unavailable workspace. The home workspace keeps the
 * turn's agent. Anywhere else the call acts as the sender alone, so that
 * workspace's role, connector policy and approvals decide, and an approval
 * still needs a human web session.
 */
async function resolveChatSenderWorkspace(
	slugOrId: string,
	ctx: AccountToolContext,
	reach: ChatSenderReach,
): Promise<ToolContext> {
	const member = ctx.userId
		? await findUngrantedMemberWorkspace({ userId: ctx.userId, slugOrId })
		: null;
	if (!member) {
		throw new CrossOrgAccessDenied(
			"Workspace is not available for this authorization."
		);
	}
	return {
		...ctx,
		organizationId: member.id,
		memberRole: member.role,
		agentId: member.id === reach.homeOrganizationId ? reach.homeAgentId : null,
	};
}

interface BuildClientSDKOptions {
	mode?: SDKMode;
	allowCrossOrg?: boolean;
	/**
	 * Forwarded onto every handler's `ToolContext.abortSignal`. Handlers that
	 * opt in (e.g. `query_sql` / `client.query`) stop their work on this
	 * signal, so the awaiting caller unblocks immediately on script timeout and
	 * a bounded read's running statement is cancelled on Postgres — see
	 * `ToolContext.abortSignal` for the full caveat.
	 */
	abortSignal?: AbortSignal;
}

export function buildClientSDK(
	ctx: AccountToolContext,
	env: Env,
	opts?: BuildClientSDKOptions
): ClientSDK {
	const mode: SDKMode = opts?.mode ?? "full";
	const allowCrossOrg = opts?.allowCrossOrg ?? ctx.allowCrossOrg ?? false;
	// ClientSDK calls are headless even when the outer MCP session supports
	// Apps. An inline result card belongs to the directly advertised tool call
	// that produced it (save_memory, get_approval, …); a nested
	// client.knowledge.save inside run_sdk has no card of its own, so it must
	// keep the compact SDK receipt instead of echoing the saved payload into a
	// headless result.
	const headlessCtx: AccountToolContext = {
		...ctx,
		mcpAppsSupported: false,
		headlessResult: true,
		// Nested SDK calls are explicit single-workspace operations. Only the
		// directly invoked search tool may use the bare-session federation bit.
		directSearchFederation: false,
	};
	ctx = opts?.abortSignal
		? { ...headlessCtx, abortSignal: opts.abortSignal }
		: headlessCtx;

	function namespace<T extends object>(name: string, value: T): T {
		if (mode === "read") {
			for (const method of Object.keys(value)) {
				if (METHOD_METADATA[`${name}.${method}`]?.access !== "read") {
					delete (value as Record<string, unknown>)[method];
				}
			}
			Object.freeze(value);
		}
		return value;
	}

	const sdk: ClientSDK = {
		get agents() { return namespace("agents", buildAgentsNamespace(requireWorkspaceContext(ctx), env)); },
		get entities() { return namespace("entities", buildEntitiesNamespace(requireWorkspaceContext(ctx), env)); },
		get entitySchema() { return namespace("entitySchema", buildEntitySchemaNamespace(requireWorkspaceContext(ctx), env)); },
		get catalog() { return namespace("catalog", buildCatalogNamespace(requireWorkspaceContext(ctx), env)); },
		get connections() { return namespace("connections", buildConnectionsNamespace(requireWorkspaceContext(ctx), env)); },
		get feeds() { return namespace("feeds", buildFeedsNamespace(requireWorkspaceContext(ctx), env)); },
		get authProfiles() { return namespace("authProfiles", buildAuthProfilesNamespace(requireWorkspaceContext(ctx), env)); },
		get operations() { return namespace("operations", buildOperationsNamespace(requireWorkspaceContext(ctx), env)); },
		get automations() { return namespace("automations", buildAutomationsNamespace(requireWorkspaceContext(ctx), env)); },
		get classifiers() { return namespace("classifiers", buildClassifiersNamespace(requireWorkspaceContext(ctx), env)); },
		get views() { return namespace("views", buildViewsNamespace(requireWorkspaceContext(ctx), env)); },
		get knowledge() { return namespace("knowledge", buildKnowledgeNamespace(requireWorkspaceContext(ctx), env)); },
		get metrics() { return namespace("metrics", buildMetricsNamespace(requireWorkspaceContext(ctx), env)); },
		get notifications() { return namespace("notifications", buildNotificationsNamespace(requireWorkspaceContext(ctx), env)); },
		get devices() { return namespace("devices", buildDevicesNamespace(requireWorkspaceContext(ctx))); },
		get schedules() { return namespace("schedules", buildSchedulesNamespace(requireWorkspaceContext(ctx), env)); },
		get organizations() { return namespace("organizations", buildOrganizationsNamespace(ctx)); },
		get conversations() {
			return namespace("conversations", {
				setTitle: buildMcpConversationTitle(ctx),
				get manage() { return buildConversationsNamespace(requireWorkspaceContext(ctx), env).manage; },
				get list() { return buildConversationsNamespace(requireWorkspaceContext(ctx), env).list; },
				get get() { return buildConversationsNamespace(requireWorkspaceContext(ctx), env).get; },
				get send() { return buildConversationsNamespace(requireWorkspaceContext(ctx), env).send; },
			});
		},

		async org(slugOrId) {
			const targetCtx = await resolveCrossOrgToolContext(
				slugOrId,
				ctx,
				allowCrossOrg,
			);
			return buildClientSDK(targetCtx, env, {
				mode,
				allowCrossOrg,
				abortSignal: ctx.abortSignal,
			});
		},

		async query(querySql, options) {
			const workspaceCtx = requireWorkspaceContext(ctx);
			// Read-tier parity with `query_sql` / `metric_series`: members may query
			// operational tables; auth/identity tables stay admin-only per-query.
			const isAdmin = isAdminOrOwnerRole(workspaceCtx.memberRole);
			if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options) ||
				Object.keys(options).some((key) => key !== "window_token") ||
				(options.window_token !== undefined && (typeof options.window_token !== "string" || !options.window_token)))) {
				throw new ToolUserError("client.query options must contain a non-empty window_token string.", 400, "VALIDATION");
			}
			const window = options?.window_token
				? await resolveWindowQueryContext(options.window_token, env, workspaceCtx, getDb())
				: undefined;
			const scoped = validateAndScopeQuery(querySql, workspaceCtx.organizationId, {
				window,
				userId: authzScopeFromToolContext(workspaceCtx).principal,
				safeColumns: isSystemContext(workspaceCtx) ? undefined : SAFE_COLUMN_DEFS,
				restrictedTables:
					isSystemContext(workspaceCtx) || isAdmin
						? undefined
						: ADMIN_ONLY_QUERYABLE_TABLES,
				// Workspace-identity audit rows are owner/admin-only; ordinary
				// members running client.query must not surface them.
				excludeWorkspaceAudit: !isInProcessSystemCall(workspaceCtx) && !isAdmin,
				// $member entity rows carry PII reserved by the manage_entity
				// read policy; ordinary members must not bypass it via raw SQL.
				excludeMemberEntities: !isInProcessSystemCall(workspaceCtx) && !isAdmin,
			});
			// Outer LIMIT caps rows at the source so a broad SELECT can't
			// materialize an unbounded result set host-side.
			const boundedSql = `SELECT * FROM (${scoped.sql.replace(/;\s*$/, "")}) AS __q LIMIT ${CLIENT_QUERY_MAX_ROWS}`;
			let rows: Record<string, unknown>[];
			try {
				rows = await boundedQuery(getDb(), boundedSql, scoped.params as unknown[], {
					signal: workspaceCtx.abortSignal,
					statementTimeoutMs: QUERY_SQL_STATEMENT_TIMEOUT_MS,
				});
			} catch (error) {
				// A caller that left keeps the abort reason `boundedQuery` threw.
				if (workspaceCtx.abortSignal?.aborted) throw error;
				// Same SQLSTATE mapping and message as `query_sql`.
				const failure = classifyReadQueryFailure(error);
				throw new ToolUserError(failure.message, toolErrorHttpStatus(failure.code), failure.code);
			}
			return rows.map((r) => ({ ...r }));
		},

		log(message, data) {
			// biome-ignore lint/suspicious/noConsole: structured-log fallback; routes through Sentry breadcrumbs in prod.
			console.log(`[client-sdk] ${message}`, data ?? {});
		},
	};

	bindClientContext(sdk, ctx);
	if (mode === "read") Object.freeze(sdk);
	return sdk;
}
