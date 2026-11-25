import { Hono } from "hono";
import type { Context } from "hono";
import { deriveAppPrincipalId, isHostedRedirectUri } from "../auth/app-principal";
import { mcpAuth } from "../auth/middleware";
import { OAuthClientsStore, type OAuthMcpLevel } from "../auth/oauth/clients";
import { isTokenDerivedSession } from "../auth/oauth/scopes";
import {
	findUngrantedMemberWorkspace,
	isMultiWorkspaceGrantIssuanceEnabled,
	listLiveGrantedMemberWorkspaces,
	MAX_GRANTED_ORGANIZATIONS,
} from "../auth/oauth/workspace-grants";
import { getDb } from "../db/client";
import type { Env } from "../index";
import { isAdminOrOwnerRole } from "../tools/access-control";

/**
 * A person's own connected-app logins, read and widened from Lobu's web app.
 * A login is one `(user, client_id)` pair: every DCR registration and every
 * `lobu login` is its own client. Widening edits the live token rows in place
 * (`OAuthClientsStore.widenLogin`), so the app's next call carries the new
 * workspace or level without reconnecting.
 *
 * Only a person's own browser sign-in may use these routes. A bearer, an MCP
 * session, or a token-derived web session is refused, so an agent can never
 * widen the login it is calling with.
 */
const routes = new Hono<{ Bindings: Env }>();
const LEVELS: readonly OAuthMcpLevel[] = ["read", "write", "admin"];

function interactiveUserId(c: Context<{ Bindings: Env }>): string | null {
	if (c.get("authSource") !== "session" || c.get("mcpAuthInfo")) return null;
	if (isTokenDerivedSession(c.get("session"))) return null;
	return c.get("user")?.id ?? null;
}

function forbidden(c: Context<{ Bindings: Env }>) {
	return c.json(
		{
			error: "forbidden",
			message: "Only you can change your logins, from the Lobu web app. Connected apps and tokens cannot.",
		},
		403,
	);
}

function notFound(c: Context<{ Bindings: Env }>) {
	return c.json({ error: "not_found", message: "You have no live login for this app." }, 404);
}

function redirectHost(redirectUris: readonly string[]): string | null {
	const hosted = redirectUris.find(isHostedRedirectUri);
	return hosted ? new URL(hosted).hostname : null;
}

routes.get("/:clientId", mcpAuth, async (c) => {
	const userId = interactiveUserId(c);
	if (!userId) return c.get("user") ? forbidden(c) : c.json({ error: "unauthorized" }, 401);
	const clientId = c.req.param("clientId");
	if (!clientId) return notFound(c);
	const store = new OAuthClientsStore(getDb());
	const login = await store.getLiveLogin(clientId, userId);
	if (!login) return notFound(c);
	const workspaces = await listLiveGrantedMemberWorkspaces({
		userId,
		grantedOrganizationIds: login.grantedOrganizationIds,
	});
	return c.json({
		client_id: login.clientId,
		client_name: login.clientName,
		redirect_host: redirectHost(login.redirectUris),
		app_key: deriveAppPrincipalId({
			kind: "oauth",
			clientId: login.clientId,
			clientName: login.clientName,
			authorizationGrantType: login.authorizationGrantType,
			redirectUris: login.redirectUris,
		}),
		created_at: login.createdAt,
		last_used_at: login.lastUsedAt,
		level: login.level,
		workspaces: workspaces.map(({ id, slug, name }) => ({ id, slug, name })),
		multiple_workspaces_allowed: isMultiWorkspaceGrantIssuanceEnabled(c.env ?? {}),
	});
});

routes.post("/:clientId/grant", mcpAuth, async (c) => {
	const userId = interactiveUserId(c);
	if (!userId) return c.get("user") ? forbidden(c) : c.json({ error: "unauthorized" }, 401);

	const body = (await c.req.json().catch(() => null)) as { workspace?: unknown; level?: unknown } | null;
	const workspaceInput = typeof body?.workspace === "string" ? body.workspace.trim() : "";
	if (!workspaceInput) {
		return c.json({ error: "invalid_request", message: "workspace is required (slug or id)." }, 400);
	}
	const levelInput = body?.level;
	if (levelInput !== undefined && levelInput !== null && !LEVELS.includes(levelInput as OAuthMcpLevel)) {
		return c.json({ error: "invalid_request", message: "level must be read, write, or admin." }, 400);
	}
	const level = (levelInput ?? null) as OAuthMcpLevel | null;

	const clientId = c.req.param("clientId");
	if (!clientId) return notFound(c);
	const store = new OAuthClientsStore(getDb());
	// Check the login first so a stranger's client id is a plain 404.
	if (!(await store.getLiveLogin(clientId, userId))) return notFound(c);

	const workspace = await findUngrantedMemberWorkspace({ userId, slugOrId: workspaceInput });
	if (!workspace) {
		return c.json({ error: "not_a_member", message: "You are not a member of that workspace." }, 403);
	}
	if (level === "admin" && !isAdminOrOwnerRole(workspace.role)) {
		return c.json(
			{
				error: "admin_role_required",
				message: `Admin access needs the admin or owner role in ${workspace.slug}; yours is ${workspace.role}.`,
			},
			403,
		);
	}

	const multiple = isMultiWorkspaceGrantIssuanceEnabled(c.env ?? {});
	const result = await store.widenLogin({
		clientId,
		userId,
		organizationId: workspace.id,
		level,
		maxWorkspaces: multiple ? MAX_GRANTED_ORGANIZATIONS : 1,
	});
	if (result.status === "not_found") return notFound(c);
	if (result.status === "too_many_workspaces") {
		return multiple
			? c.json(
					{
						error: "too_many_workspaces",
						message: `A login can reach at most ${result.limit} workspaces. Remove one from this app first.`,
					},
					409,
				)
			: c.json(
					{
						error: "single_workspace_login",
						message:
							"This Lobu server allows one workspace per login. Reconnect the app and choose this workspace instead.",
					},
					409,
				);
	}
	return c.json({
		client_id: clientId,
		workspace: workspace.slug,
		level: result.level,
		updated_tokens: result.updatedTokens,
	});
});

export const loginRoutes = routes;
