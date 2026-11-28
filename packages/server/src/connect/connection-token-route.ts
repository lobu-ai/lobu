/**
 * Managed-connector connection-token endpoint.
 *
 * A lender workspace (named in `LOBU_MANAGED_AUTH_ORGS`) holds managed
 * `oauth_app` profiles. When a user consents against one of those apps, the
 * resulting consent-only connection (`config.consent_only = true`) is OWNED by
 * that user (`connections.created_by`). The managed client secret and the
 * refresh token stay in the cloud.
 *
 * At RUNTIME the user's LOCAL Lobu instance fetches a fresh ACCESS token for
 * its own grant via this endpoint, authenticating with any valid bearer that
 * carries the `connections:token` scope: in practice the user's own
 * `lobu login` OAuth access token, or an explicitly-scoped PAT. The token is
 * resolved/refreshed server-side through `resolveExecutionAuth`, and ONLY the
 * access token + expiry are returned.
 *
 * Membership of the lender workspace is NOT required: owning the grant is the
 * authorization. A lender workspace can therefore stay private and memberless.
 *
 * Endpoint (bearer with `connections:token` scope):
 *   - POST /oauth/connection-token  { org, connector_key, connection_slug? }
 *
 * `connection_slug` selects the exact caller-owned grant. It is optional only
 * for compatibility with older generated configs; an unpinned request fails
 * with 409 when more than one matching grant exists.
 */

import type { Env } from "@lobu/connector-sdk";
import { Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Hono } from "hono";
import { OAuthProvider } from "../auth/oauth/provider";
import { CONNECTIONS_TOKEN_SCOPE } from "../auth/oauth/scopes";
import { getDb, pgTextArray } from "../db/client";
import { resolveExecutionAuth } from "../utils/execution-context";
import logger from "../utils/logger";
import { managedAuthProviderSlugs } from "../workspace/managed-auth-discovery";

type ConnectionTokenEnv = {
	Bindings: Env;
	Variables: { authedUserId: string };
};

const connectionTokenRoutes = new Hono<ConnectionTokenEnv>();

// The least-privilege scope a credential must carry to mint a managed-connection
// access token via this endpoint is `CONNECTIONS_TOKEN_SCOPE`, imported from the
// auth/oauth/scopes single source of truth. Deliberately separate from the
// default `mcp:*` scopes so a broad org-member credential cannot mint connection
// tokens. Two credential shapes carry it:
//   - a USER's device-login access token (`lobu login`) — which requests the
//     scope EXPLICITLY (auth/oauth/scopes.ts); the default path for the local
//     instance's managed-connector resolver.
//   - a PAT minted EXPLICITLY with `--scope connections:token` (the headless /
//     CI fallback, `LOBU_CLOUD_PAT`).
// A default `mcp:read mcp:write` member PAT is NOT enough — the gate stays
// meaningful against a broad CI PAT.

/**
 * Auth for the connection-token endpoint. Accepts ANY valid bearer
 * (`verifyAccessToken` handles both OAuth 2.1 login tokens and `owl_pat_*`
 * PATs), then requires:
 *   - the token to be bound to an organization (null-org → 401), and
 *   - the `connections:token` scope (403 otherwise), before any org/connection
 *     lookup.
 * The resolved user is stashed on the context for the handler's owner-scoped
 * lookup.
 */
connectionTokenRoutes.use("/oauth/connection-token", async (c, next) => {
	const authHeader = c.req.header("Authorization");
	const bearerMatch = authHeader ? /^bearer\s+(.*)$/i.exec(authHeader) : null;
	const bearerValue = bearerMatch ? (bearerMatch[1] ?? "").trim() : "";
	if (!bearerValue) {
		return c.json(
			{ error: "unauthorized", error_description: "Bearer token required" },
			401,
		);
	}

	const sql = getDb();
	const provider = new OAuthProvider(sql, "");
	let authInfo: Awaited<ReturnType<OAuthProvider["verifyAccessToken"]>>;
	try {
		authInfo = await provider.verifyAccessToken(bearerValue);
	} catch {
		authInfo = null;
	}
	if (!authInfo?.userId) {
		return c.json(
			{ error: "invalid_token", error_description: "Invalid, expired, or revoked token" },
			401,
		);
	}
	// A token with no org binding cannot be a managed-connector login credential.
	if (!authInfo.organizationId) {
		return c.json(
			{
				error: "invalid_token",
				error_description: "Token is not scoped to an organization",
			},
			401,
		);
	}

	// Least-privilege: a valid, org-scoped credential is necessary but not
	// sufficient — it must also carry `connections:token`. A default
	// `mcp:read mcp:write` PAT is rejected here (403) before any lookup.
	if (!authInfo.scopes.includes(CONNECTIONS_TOKEN_SCOPE)) {
		return c.json(
			{
				error: "insufficient_scope",
				error_description: `Token is missing the '${CONNECTIONS_TOKEN_SCOPE}' scope`,
			},
			403,
		);
	}

	c.set("authedUserId", authInfo.userId);
	return next();
});

const TokenBody = Type.Object({
	org: Type.String({ minLength: 1 }),
	connector_key: Type.String({ minLength: 1 }),
	connection_slug: Type.Optional(Type.String({ minLength: 1 })),
});
const tokenValidator = TypeCompiler.Compile(TokenBody);

/**
 * POST /oauth/connection-token
 * Return a fresh access token for the authed user's OWN active connection to
 * `connector_key` in `org`, selected exactly by `connection_slug` when sent.
 *
 * The cloud owns the managed grant: it resolves the connection's
 * `oauth_account` (token store) + managed `oauth_app` (client_id/secret) and
 * runs the EXISTING `resolveExecutionAuth` path, which refreshes via the
 * managed secret when the token is expiring. Secrets + the refresh token are
 * held server-side and never returned.
 *
 * Authorization (narrow by design — this delegates ONLY managed grant-holders,
 * never a user's ordinary connection tokens):
 *   - 403 `insufficient_scope` if the PAT lacks `connections:token` (enforced in
 *     the auth middleware, before any lookup).
 *   - 404 unless `org` (an organization id OR slug) is a lender workspace named
 *     in `LOBU_MANAGED_AUTH_ORGS`, and the connection is the user's OWN
 *     (`created_by`) consent-only managed grant (`config.consent_only = true`).
 *     The not-found shape is the same whichever condition failed (no leak).
 */
connectionTokenRoutes.post("/oauth/connection-token", async (c) => {
	const raw = await c.req.json().catch(() => null);
	if (!tokenValidator.Check(raw)) {
		const detail = [...tokenValidator.Errors(raw)]
			.map((e) => `${e.path || "/"} ${e.message}`)
			.join("; ");
		return c.json(
			{
				error: "bad_request",
				error_description: detail || "Invalid request body",
			},
			400,
		);
	}

	const authedUserId = c.get("authedUserId");
	const sql = getDb();

	const notFound = () =>
		c.json(
			{
				error: "not_found",
				error_description: "No active managed connection found for this connector",
			},
			404,
		);

	const lenderSlugs = managedAuthProviderSlugs();
	if (lenderSlugs.length === 0) return notFound();

	// Scoped connection lookup. This endpoint exists ONLY to delegate a managed
	// grant's token, so the lookup is deliberately narrow and must NOT be usable
	// to export a user's ordinary connection tokens:
	//   - `org` (id or slug) must be a lender workspace named in
	//     `LOBU_MANAGED_AUTH_ORGS`, never an arbitrary workspace;
	//   - owner-scoped: the user must OWN the connection (`created_by`);
	//   - the connection must be a consent-only managed grant
	//     (`config.consent_only = true`).
	// Anything else is the same 404, so which condition failed does not leak.
	// LIMIT 2 exists only to detect ambiguity on an unpinned request; a pinned
	// slug matches at most one row (slug is unique per org).
	const rows = (await sql`
		SELECT c.id, c.organization_id, c.auth_profile_id, c.app_auth_profile_id
		FROM connections c
		JOIN "organization" o ON o.id = c.organization_id
		WHERE (o.id = ${raw.org} OR o.slug = ${raw.org})
			AND lower(o.slug) = ANY(${pgTextArray(lenderSlugs)}::text[])
			AND c.connector_key = ${raw.connector_key}
			${raw.connection_slug ? sql`AND c.slug = ${raw.connection_slug}` : sql``}
			AND c.created_by = ${authedUserId}
			AND c.deleted_at IS NULL
			AND c.status = 'active'
			AND c.config->>'consent_only' = 'true'
		ORDER BY c.id
		LIMIT 2
	`) as unknown as Array<{
		id: number;
		organization_id: string;
		auth_profile_id: number | null;
		app_auth_profile_id: number | null;
	}>;
	if (rows.length === 0) return notFound();
	if (!raw.connection_slug && rows.length > 1) {
		return c.json(
			{
				error: "ambiguous_connection",
				error_description:
					"Multiple active managed connections found; regenerate the local config or select a connection_slug",
			},
			409,
		);
	}

	const connection = rows[0];
	const organizationId = connection.organization_id;

	const { credentials } = await resolveExecutionAuth({
		organizationId,
		connectionId: Number(connection.id),
		authProfileId: connection.auth_profile_id,
		appAuthProfileId: connection.app_auth_profile_id,
		credentialDb: sql,
		logContext: { org: organizationId, connector_key: raw.connector_key },
		logMessage: "Failed to resolve managed connection token",
	});

	if (!credentials?.accessToken) {
		return c.json(
			{
				error: "no_token",
				error_description: "No access token available for this connection",
			},
			502,
		);
	}

	logger.info(
		{ org: organizationId, connector_key: raw.connector_key, connection_id: Number(connection.id) },
		"Resolved managed connection token",
	);

	// Return ONLY the access token + expiry. Never the refresh token or secret.
	return c.json({
		access_token: credentials.accessToken,
		expires_at: credentials.expiresAt ?? null,
	});
});

export { connectionTokenRoutes };
