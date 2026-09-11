/**
 * Tool access policy helpers.
 *
 * Centralizes role/scoped MCP access checks and what anonymous/public
 * callers are allowed to read.
 *
 * Note on `run_sdk`: the MCP entry point requires write-tier access, and
 * admin-only SDK methods still re-check role + MCP scope at the delegated
 * handler boundary before any mutation runs. `query_sdk` runs over the read-only
 * SDK so it falls through to the default read-tier check.
 */

export type ToolAccessLevel = "read" | "write" | "admin";

export const MEMBER_WRITE_ACTIONS: Record<string, Set<string> | null> = {
	save_memory: null,
	// App-only approval decisions are already restricted to one encrypted,
	// short-lived capability bound to the OAuth user, client, MCP session, org,
	// run, and current approval event. The resolver then reuses the canonical
	// human + admin-or-run-owner checks. Requiring mcp:admin at this outer tool
	// boundary would make the card unusable for normal Apps clients, whose
	// approval grant is intentionally mcp:write.
	resolve_approval: null,
	// App-only JSON-template interactions append the event kind declared by the
	// source template. The handler derives the actor from OAuth/session context
	// and accepts no caller-supplied identity.
	invoke_event_action: null,
	// `run_sdk` reaches admin handlers inside the script; per-call gates fire
	// on each SDK method, so the entry-point check is just write-tier.
	run_sdk: null,
	// `manage_*` per-action policy. The same tables gate every surface: direct
	// tool calls (MCP / REST proxy) via `checkToolAccess`, and the SDK namespace
	// wrappers inside `run_sdk` via `routeAction`.
	manage_entity: new Set(["create", "update", "link", "unlink", "update_link"]),
	// Members can install connections that bind to their own OAuth account
	// grant. `update` is here so members can rebind their own connection's
	// auth profile / display name / device pin; the handler enforces
	// `created_by === ctx.userId` plus the same per-field role gates as
	// create (app_auth_profile pinned-default, target-profile ownership).
	manage_connections: new Set([
		"create",
		"connect",
		"connect_managed",
		"update",
		"reauthenticate",
	]),
	// Members create / reconnect their own oauth_account profile. The handler
	// gates `profile_kind` against role so env / oauth_app / browser_session
	// stay admin-only. `get_auth_profile` is public-read because it returns the
	// same sanitized metadata as list; `test_auth_profile` stays owner-admin.
	manage_auth_profiles: new Set(["create_auth_profile", "update_auth_profile"]),
	// `complete_window` is how automation AGENTS report results — server-side
	// agent workers and device CLI runs (the Owletto Mac dispatcher wires the
	// gateway MCP into the spawned CLI; device tokens carry mcp:write, not
	// admin). The handler still enforces org/entity write access via
	// requireAutomationAccess; automation ADMINISTRATION (create/update/delete/…)
	// stays admin-tier below. `trigger` is write-tier: manual activation is the
	// open lane — any member (or their MCP client) may fire an Automation and
	// complete the resulting run.
	manage_automations: new Set(["claim_next_window", "complete_window", "trigger"]),
	// `approve`/`reject` (and their `*_batch` forms) are write-tier so the
	// recorded FIELD OWNER of an entity-change proposal (a plain member) can
	// decide their own run. The handler enforces admin-or-run-owner per run — a
	// member who is not that run's owner is rejected there with the same
	// admin-access message. `execute` is write-tier too: a member runs connector
	// operations only on connections VISIBLE to them (the handler re-runs the
	// per-principal visibility query), and every existing gate (active status,
	// input validation, per-connection action_modes, per-principal
	// connector_action policy) still applies. This is the "ready means the
	// TARGET is ready" contract made caller-aware: an action advertised as
	// ready/executable must be invocable by the caller who sees it.
	manage_operations: new Set([
		"approve",
		"reject",
		"approve_batch",
		"reject_batch",
		"execute",
	]),
	// A member sends a message to their own agent's conversation. `send` runs the
	// turn in the conversation's pinned sandbox; the handler binds the
	// conversation to ctx.userId and fences on agent-in-org. list/get carry no
	// write/admin entry, so they fall through to the READ tier — they are NOT
	// public-readable (a listing exposes conversation titles).
	manage_conversations: new Set(["send"]),
};

export const OWNER_ADMIN_ACTIONS: Record<string, Set<string>> = {
	// manage_catalog is READ-ONLY (both actions list — no writes exist). An empty
	// admin set gives it an explicit policy entry so its actions fall through to
	// READ tier; without it, `requiresOwnerAdmin`'s no-policy fallback classified
	// list_catalog/list_installed as admin, so a default `mcp:read`+`mcp:write`
	// token (what `lobu token create` mints) couldn't discover connectors at all.
	manage_catalog: new Set([]),
	manage_entity: new Set(["delete", "merge", "resolve_duplicates", "unmerge"]),
	manage_entity_schema: new Set([
		"create",
		"update",
		"delete",
		"add_rule",
		"remove_rule",
	]),
	manage_connections: new Set([
		// `create`, `connect`, `connect_managed`, `update`, and `reauthenticate` are in
		// MEMBER_WRITE_ACTIONS —
		// members install / edit their own connections (handler enforces
		// created_by === ctx.userId + app_auth_profile slug override + role
		// gates).
		"delete",
		"test",
		"install_connector",
		"uninstall_connector",
		// Connector source lifecycle (#2045): reading installed source, compiling
		// arbitrary source server-side, replacing a definition, and reverting it
		// are all connector administration.
		"get_connector_source",
		"validate_connector_source",
		"update_connector_source",
		"rollback_connector_version",
		"toggle_connector_login",
		"update_connector_auth",
		"update_connector_default_config",

		"apply_chat_connection",
		"set_channel_about",
	]),
	manage_feeds: new Set([
		"create_feed",
		"update_feed",
		"delete_feed",
		"trigger_feed",
	]),
	manage_auth_profiles: new Set([
		// `create_auth_profile` and `update_auth_profile` are in
		// MEMBER_WRITE_ACTIONS — the handler enforces oauth_account-only access
		// for non-admins so members can't create org-shared credentials.
		// `get_auth_profile` is in PUBLIC_READ_ACTIONS because it uses the same
		// credential-free `serializeAuthProfile` payload as `list_auth_profiles`.
		"test_auth_profile",
		"delete_auth_profile",
		"set_default_auth_profile",
	]),
	// `approve`/`reject`/`execute` all live in MEMBER_WRITE_ACTIONS; the handler
	// enforces admin-or-run-owner for approvals and per-principal connection
	// visibility for execution, so nothing in manage_operations is
	// unconditionally admin.
	manage_operations: new Set([]),
	// `manage_schedules` is admin throughout (schedule rows carry agent prompts
	// and delivery context). Declared explicitly so the access-model cross-check
	// can cover the schedules namespace — the previous no-policy fallback made
	// every action admin but was invisible to the drift guard, letting
	// METHOD_METADATA advertise `schedules.list` as read (drift #2607-adjacent).
	manage_schedules: new Set(["list", "create", "update", "pause", "cancel"]),
	manage_automations: new Set([
		// `complete_window` and `trigger` are in MEMBER_WRITE_ACTIONS — the
		// execution path (server workers + device CLI + manual MCP clients),
		// not administration.
		"create",
		"update",
		"create_version",
		"delete",
		"set_reaction_script",
		"submit_feedback",
		"create_from_version",
	]),
	manage_agents: new Set([
		// `list`/`get` are org-read (the handler gates them with
		// requireOrgReadAccess) and live in PUBLIC_READ_ACTIONS — agent
		// ADMINISTRATION (create/update/delete) stays owner-admin.
		"create",
		"update",
		"delete",
	]),
	manage_classifiers: new Set([
		"create",
		"generate_embeddings",
		"delete",
		"classify",
		// `apply` persists rows into event_classifications for arbitrary
		// caller-supplied content ids — a mutation, same tier as `classify`.
		"apply",
	]),
	manage_view_templates: new Set(["set", "rollback", "remove_tab", "clear"]),
};

export const PUBLIC_READ_ACTIONS: Record<string, Set<string> | null> = {
	resolve_path: null,
	search_memory: null,
	// SDK method discovery — safe to expose; surfaces no data.
	search_sdk: null,
	// Internal read-paths — kept for tests that exercise public-readability
	// semantics; legitimate external access is via `query_sdk` / `run_sdk`.
	read_knowledge: null,
	get_automation: null,
	manage_entity: new Set(["list", "get", "list_links"]),
	manage_entity_schema: new Set(["list", "get", "audit", "list_rules"]),
	manage_connections: new Set(["list", "list_connector_groups", "get", "setup_options"]),
	manage_catalog: new Set(["list_catalog", "list_installed"]),
	manage_feeds: new Set(["list_feeds", "read_feed", "read_feeds"]),
	manage_auth_profiles: new Set(["list_auth_profiles", "get_auth_profile"]),
	manage_operations: new Set([
		"list_available",
		"list_runs",
		"get_run",
		"list_activity",
	]),
	manage_automations: new Set([
		"list",
		"get_versions",
		"get_version_details",
		"get_component_reference",
		"get_feedback",
	]),
	manage_classifiers: new Set(["list"]),
	manage_view_templates: new Set(["get"]),
	// `list`/`get` are org-read-gated in the handler (requireOrgReadAccess);
	// their METHOD_METADATA tier is `read` so query_sdk read mode surfaces them.
	// The mutating siblings stay owner-admin (OWNER_ADMIN_ACTIONS).
	manage_agents: new Set(["list", "get"]),
};

function getAction(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const value = (args as { action?: unknown }).action;
	return typeof value === "string" ? value : null;
}

function actionMatches(
	policy: Record<string, Set<string> | null>,
	toolName: string,
	args: unknown
): boolean {
	if (!(toolName in policy)) return false;
	const allowedActions = policy[toolName];
	if (allowedActions === null) return true;
	const action = getAction(args);
	return !!action && allowedActions.has(action);
}

export function requiresMemberWrite(
	toolName: string,
	args: unknown,
	readOnlyHint: boolean
): boolean {
	if (requiresOwnerAdmin(toolName, args, readOnlyHint)) return false;
	return actionMatches(MEMBER_WRITE_ACTIONS, toolName, args);
}

export function requiresOwnerAdmin(
	toolName: string,
	args: unknown,
	readOnlyHint: boolean
): boolean {
	// query_sql / metric_series are read-tier (members may query their org's
	// operational data). The auth/identity tables (oauth_tokens, oauth_clients,
	// user) stay admin-only via ADMIN_ONLY_QUERYABLE_TABLES, enforced per-query in
	// those handlers — not by gating the whole tool to admins.
	if (actionMatches(OWNER_ADMIN_ACTIONS, toolName, args)) return true;

	const hasExplicitPolicy =
		toolName in OWNER_ADMIN_ACTIONS || toolName in MEMBER_WRITE_ACTIONS;

	// For tools without explicit policy, fall back to readOnly hint.
	return !readOnlyHint && !hasExplicitPolicy;
}

export function getRequiredAccessLevel(
	toolName: string,
	args: unknown,
	readOnlyHint: boolean
): ToolAccessLevel {
	if (toolName === "list_organizations") return "read";
	if (requiresOwnerAdmin(toolName, args, readOnlyHint)) return "admin";
	if (requiresMemberWrite(toolName, args, readOnlyHint)) return "write";
	return "read";
}

/**
 * Sentinel scope that means "MCP scope check is not applicable to this
 * caller" — used for session-cookie and anonymous auth, where authorization
 * is gated by member role and public-readability instead of token scopes
 * (those auth types never carry MCP scopes). It is NOT a scope an OAuth/PAT
 * token can ever present (`parseScopes` only emits `mcp:*`), so it cannot be
 * forged by a token-based caller.
 *
 * INVARIANT: `hasRequiredMcpScope` must FAIL CLOSED on `null`/`undefined`.
 * A missing scope set is an unauthenticated/under-specified caller, never a
 * grant of full access. Callers that legitimately have no scope dimension
 * (session/anonymous) pass this sentinel explicitly; token callers pass their
 * real scopes (or `[]` for a token minted without any, which then denies).
 */
export const SCOPE_CHECK_NOT_APPLICABLE: readonly string[] = ["*"];

export function hasRequiredMcpScope(
	requiredAccess: ToolAccessLevel,
	scopes: readonly string[] | null | undefined
): boolean {
	// Fail closed: a null/undefined scope set means the caller presented no
	// MCP scope claim. It must NOT be treated as full access.
	if (scopes == null) return false;
	if (scopes.length === 0) return false;
	// Session/anonymous bypass sentinel: scope dimension does not apply (these
	// callers are gated by role + public-readability upstream).
	if (scopes.includes("*")) return true;
	const scopeSet = new Set(scopes);
	if (requiredAccess === "read") {
		return (
			scopeSet.has("mcp:read") ||
			scopeSet.has("mcp:write") ||
			scopeSet.has("mcp:admin")
		);
	}
	if (requiredAccess === "write") {
		return scopeSet.has("mcp:write") || scopeSet.has("mcp:admin");
	}
	return scopeSet.has("mcp:admin");
}

/**
 * Highest access tier a caller can exercise, from member role x `mcp:*`
 * scopes. `null`/sentinel scopes don't limit (session/anonymous callers are
 * gated by role + public-readability instead). Shared by MCP `tools/list` and
 * `GET /api/:orgSlug/tools` so both surfaces filter identically. Account discovery
 * has only a scope ceiling; selected workspace handlers still enforce real roles.
 */
export function resolveMaxAccessLevel(
	memberRole: string | null | undefined,
	scopes: readonly string[] | null | undefined,
	accountScope = false,
): ToolAccessLevel {
	const roleLevel: ToolAccessLevel = accountScope ? "admin" : !memberRole
		? "read"
		: memberRole === "owner" || memberRole === "admin"
			? "admin"
			: "write";
	const scopeLevel: ToolAccessLevel =
		scopes == null || scopes.includes("*") || scopes.includes("mcp:admin")
			? "admin"
			: scopes.includes("mcp:write")
				? "write"
				: "read";
	if (roleLevel === "read" || scopeLevel === "read") return "read";
	if (roleLevel === "write" || scopeLevel === "write") return "write";
	return "admin";
}

/**
 * SDK discovery/manifest ceiling for a caller that can already invoke
 * `run_sdk`. Owners/admins at write scope may see admin methods so an attempted
 * call can return the standard progressive-auth challenge for `mcp:admin`.
 * Ordinary members remain capped at write even if their token somehow carries
 * `mcp:admin`; the role check is deliberately not authorizable.
 */
export function resolveSdkMaxAccessLevel(
	memberRole: string | null | undefined,
	scopes: readonly string[] | null | undefined,
	accountScope = false,
): ToolAccessLevel {
	const current = resolveMaxAccessLevel(memberRole, scopes, accountScope);
	if (
		current === "write" &&
		(accountScope || memberRole === "owner" || memberRole === "admin") &&
		hasRequiredMcpScope("write", scopes)
	) {
		return "admin";
	}
	return current;
}

export function isPublicReadable(toolName: string, args: unknown): boolean {
	return actionMatches(PUBLIC_READ_ACTIONS, toolName, args);
}

export function getPublicReadableActions(
	toolName: string
): Set<string> | null | undefined {
	return PUBLIC_READ_ACTIONS[toolName];
}
