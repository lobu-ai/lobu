/**
 * Slack sign-in → slack_user_id write path — END TO END through the REAL
 * BetterAuth handler.
 *
 * This is the e2e the unit tests can't be: it does NOT call
 * `persistLoginChatIdentity` directly. It drives a full genericOAuth sign-in
 * through `auth.handler(...)` — POST /sign-in/oauth2, the provider authorize
 * redirect, and the /oauth2/callback/slack exchange — against a mock Slack
 * OAuth server. The only thing under test is the wiring in `auth/index.tsx`:
 * does the configured `databaseHooks.account.create.after` hook actually fire,
 * thread `account.idToken`/`accountId` into `persistLoginChatIdentity`, decode
 * the id_token, and write the team-scoped `slack_user_id` onto the user's
 * `$member`?
 *
 * Proof chain:
 *   1. Pre-provision Alice's `$member` with ONLY auth_user_id + email (the
 *      pre-fix state — NO slack_user_id), exactly as
 *      `provisionMemberAndCoreIdentities` does on first signup.
 *   2. Real OAuth sign-in: the mock /token returns a hand-built id_token whose
 *      payload carries `https://slack.com/team_id` + `https://slack.com/user_id`.
 *      BetterAuth links the slack account to Alice (account-linking by verified
 *      email), which fires the account.create.after hook.
 *   3. Assert `entity_identities` now has
 *      (slack_user_id, T01ACME:U01ALICE, auth:signup) on Alice's `$member`.
 *   4. Assert `buildSlackChannelGraph` collapses the channel member onto that
 *      same `$member` — no forked `person`.
 *
 * Red→green: with the two `void persistLoginChatIdentity(accountSummary)`
 * lines removed from `auth/index.tsx`, step 3 finds no row and the test fails
 * (verified manually — see the PR body).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearLoginProviderCachesForTests } from "../../../auth/config";
import { clearAuthCacheForTests, createAuth } from "../../../auth/index";
import { provisionMemberAndCoreIdentities } from "../../../auth/subject-identities";
import {
	slackAclSource,
	slackChannelsToResources,
} from "@lobu/connectors/slack-identity";
import { buildAccessGraph } from "../../../authz/access-graph";
import { clearEntityLinkRulesCache } from "../../../utils/entity-link-upsert";
import { getEnvFromProcess } from "../../../utils/env";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
	insertChatConnectionRow,
} from "../../setup/test-fixtures";

const TEAM = "T01ACME";
const SLACK_USER = "U01ALICE";
const COMBINED = `${TEAM}:${SLACK_USER}`;
const CONN = "conn-acme";
const ORG_SLUG = "acme";
const ALICE_EMAIL = "alice@acme.test";
const ORIGIN = "http://localhost";

/** Hand-build an HS256-shaped (unsigned-but-well-formed) JWT for the claims. */
function makeJwt(claims: Record<string, unknown>): string {
	const b64 = (o: unknown) =>
		Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;
}

/**
 * A mock Slack OIDC provider. BetterAuth genericOAuth hits:
 *   • GET  /authorize → 302 back to the callback with ?code=&state=<echoed>.
 *   • POST /token     → { access_token, token_type, id_token } (id_token decoded
 *                       by getUserInfo; no signature check — see routes.mjs).
 *   • GET  /userinfo  → same claims (the fallback path; the id_token primary
 *                       path means this isn't hit in this flow, kept for parity).
 */
function startMockSlackOAuth(): Promise<{ server: Server; baseUrl: string }> {
	const claims = {
		sub: SLACK_USER,
		"https://slack.com/team_id": TEAM,
		"https://slack.com/user_id": SLACK_USER,
		email: ALICE_EMAIL,
		email_verified: true,
		name: "Alice",
	};
	const idToken = makeJwt(claims);

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method === "GET" && url.pathname === "/authorize") {
			const redirectUri = url.searchParams.get("redirect_uri") ?? "";
			const state = url.searchParams.get("state") ?? "";
			const back = new URL(redirectUri);
			back.searchParams.set("code", "mock-auth-code");
			back.searchParams.set("state", state);
			res.statusCode = 302;
			res.setHeader("location", back.toString());
			res.end();
			return;
		}
		if (req.method === "POST" && url.pathname === "/token") {
			res.statusCode = 200;
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					access_token: "xoxp-mock-access-token",
					token_type: "Bearer",
					id_token: idToken,
				}),
			);
			return;
		}
		if (req.method === "GET" && url.pathname === "/userinfo") {
			res.statusCode = 200;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(claims));
			return;
		}
		res.statusCode = 404;
		res.end();
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
		});
	});
}

/** First `name=value` pair of every Set-Cookie, joined into a Cookie header. */
function cookieHeaderFrom(res: Response): string {
	const set =
		typeof res.headers.getSetCookie === "function"
			? res.headers.getSetCookie()
			: [];
	return set
		.map((c) => c.split(";", 1)[0])
		.filter(Boolean)
		.join("; ");
}

async function pollSlackIdentity(
	orgId: string,
): Promise<{ entity_id: number } | null> {
	const sql = getTestDb();
	for (let i = 0; i < 60; i++) {
		const rows = await sql<{ entity_id: number }>`
			SELECT entity_id FROM entity_identities
			WHERE organization_id = ${orgId}
				AND namespace = 'slack_user_id'
				AND identifier = ${COMBINED}
				AND source_connector = 'auth:signup'
				AND deleted_at IS NULL
			LIMIT 1
		`;
		if (rows.length > 0) return { entity_id: Number(rows[0].entity_id) };
		await new Promise((r) => setTimeout(r, 50));
	}
	return null;
}

describe("slack sign-in slack_user_id e2e (real BetterAuth handler)", () => {
	let mock: { server: Server; baseUrl: string };
	const envBackup: Record<string, string | undefined> = {};

	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
		clearEntityLinkRulesCache();
		clearAuthCacheForTests();
		clearLoginProviderCachesForTests();
		mock = await startMockSlackOAuth();

		for (const key of [
			"BETTER_AUTH_SECRET",
			"SLACK_CLIENT_ID",
			"SLACK_CLIENT_SECRET",
		]) {
			envBackup[key] = process.env[key];
		}
		// Deterministic secret so the signed `state` cookie verifies on callback.
		process.env.BETTER_AUTH_SECRET = "a".repeat(64);
		process.env.SLACK_CLIENT_ID = "mock-slack-client-id";
		process.env.SLACK_CLIENT_SECRET = "mock-slack-client-secret";
	});

	afterEach(async () => {
		for (const [key, value] of Object.entries(envBackup)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		clearAuthCacheForTests();
		clearLoginProviderCachesForTests();
		await new Promise<void>((resolve) => mock.server.close(() => resolve()));
	});

	it("fires the account.create.after hook → decodes id_token → writes slack_user_id, and the ACL graph collapses onto the $member", async () => {
		const sql = getTestDb();

		// Acme org doubles as (a) the org whose seeded slack login provider the
		// request resolves to and (b) Alice's private tenant org that
		// resolveTenantMember finds. One org keeps the flow honest end-to-end.
		const org = await createTestOrganization({
			name: "Acme",
			slug: ORG_SLUG,
			visibility: "private",
		});
		const alice = await createTestUser({ name: "Alice", email: ALICE_EMAIL });
		await addUserToOrganization(alice.id, org.id, "owner");
		const agent = await createTestAgent({ organizationId: org.id });

		// Builder auto-creates `person` for unmatched members; the type must exist.
		await sql`
			INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
			VALUES (${org.id}, 'person', 'Person', current_timestamp, current_timestamp)
			ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
			DO NOTHING
		`;

		// Pre-fix sign-in state: $member with auth_user_id + email, NO slack_user_id.
		const { memberEntityId } = await provisionMemberAndCoreIdentities(org.id, {
			userId: alice.id,
			email: ALICE_EMAIL,
			name: "Alice",
		});
		const before = await sql<{ n: number }>`
			SELECT COUNT(*)::int AS n FROM entity_identities
			WHERE organization_id = ${org.id} AND namespace = 'slack_user_id' AND deleted_at IS NULL
		`;
		expect(Number(before[0].n)).toBe(0);

		// Seed the org's "slack" login provider, endpoints pointed at the mock.
		const authSchema = {
			methods: [
				{
					type: "oauth",
					provider: "slack",
					loginScopes: ["openid", "email", "profile"],
					clientIdKey: "SLACK_CLIENT_ID",
					clientSecretKey: "SLACK_CLIENT_SECRET",
					authorizationUrl: `${mock.baseUrl}/authorize`,
					tokenUrl: `${mock.baseUrl}/token`,
					userinfoUrl: `${mock.baseUrl}/userinfo`,
					tokenEndpointAuthMethod: "client_secret_post",
				},
			],
		};
		await sql`
			INSERT INTO connector_definitions (
				organization_id, key, name, version, auth_schema, login_enabled, status, created_at, updated_at
			) VALUES (
				${org.id}, 'slack-login-test', 'Slack', '1.0.0', ${sql.json(authSchema)}, true, 'active', NOW(), NOW()
			)
		`;

		// The bot connection used by the channel-graph assertion.
		await insertChatConnectionRow({
			id: CONN,
			agentId: agent.agentId,
			platform: "slack",
			organizationId: org.id,
			status: "active",
		});

		// Build the auth instance bound to Acme (callbackURL carries the org slug,
		// which resolveRequestOrganizationId reads). The same instance serves both
		// the sign-in start and the callback exchange (mock token URL baked in).
		const callbackURL = `${ORIGIN}/${ORG_SLUG}`;
		const signInRequest = new Request(`${ORIGIN}/api/auth/sign-in/oauth2`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ providerId: "slack", callbackURL }),
		});
		const auth = await createAuth(getEnvFromProcess(), signInRequest.clone());

		// 1) POST /sign-in/oauth2 → { url } (mock authorize URL) + signed state cookie.
		const startRes = await auth.handler(signInRequest);
		expect(startRes.status).toBe(200);
		const startBody = (await startRes.json()) as { url?: string };
		expect(startBody.url, "sign-in must return an authorize url").toContain(
			`${mock.baseUrl}/authorize`,
		);
		const stateCookie = cookieHeaderFrom(startRes);
		expect(stateCookie, "sign-in must set the state cookie").toBeTruthy();

		// 2) Follow the provider authorize redirect (real fetch to the mock).
		const authorizeRes = await fetch(startBody.url as string, {
			redirect: "manual",
		});
		expect(authorizeRes.status).toBe(302);
		const callbackLocation = authorizeRes.headers.get("location");
		expect(
			callbackLocation,
			"mock /authorize must redirect to the callback",
		).toContain("/api/auth/oauth2/callback/slack");

		// 3) Hit the BetterAuth callback with the code+state and the state cookie.
		//    This triggers the real token exchange (mock /token) → id_token decode
		//    → account link → account.create.after hook → persistLoginChatIdentity.
		const callbackRes = await auth.handler(
			new Request(callbackLocation as string, {
				method: "GET",
				headers: { cookie: stateCookie, referer: callbackURL },
			}),
		);
		// A successful callback redirects (302) to the callbackURL; an error path
		// redirects to /api/auth/error?error=... — assert we did NOT error.
		expect(callbackRes.status).toBe(302);
		expect(
			callbackRes.headers.get("location") ?? "",
			"callback must not land on the auth error page",
		).not.toContain("/error");

		// The slack account must actually be linked to Alice (not a new user).
		const accounts = await sql<{ userId: string; idToken: string | null }>`
			SELECT "userId", "idToken" FROM "account"
			WHERE "providerId" = 'slack' AND "accountId" = ${SLACK_USER}
		`;
		expect(accounts).toHaveLength(1);
		expect(accounts[0].userId).toBe(alice.id);

		// 4) THE PROOF: the hook wrote the team-scoped slack_user_id onto Alice's
		//    $member, source auth:signup (fire-and-forget → poll briefly).
		const identity = await pollSlackIdentity(org.id);
		expect(
			identity,
			"account.create.after hook must write slack_user_id onto the $member",
		).not.toBeNull();
		expect(identity?.entity_id).toBe(memberEntityId);

		// 5) The ACL channel-graph collapses the workspace member onto the SAME
		//    $member — no forked person.
		const graph = await buildAccessGraph({
			organizationId: org.id,
			connectionId: CONN,
			connectorKey: slackAclSource.key,
			resourceNamespace: slackAclSource.resourceNamespace,
			memberIdentities: slackAclSource.memberIdentities,
			resources: slackChannelsToResources(TEAM, [
				{ channelId: "C01ENG", name: "eng", memberSlackUserIds: [SLACK_USER] },
			]),
		});
		expect(graph.memberEntityIds).toContain(memberEntityId);

		const carriers = await sql<{ id: number; slug: string }>`
			SELECT e.id, et.slug
			FROM entity_identities ei
			JOIN entities e ON e.id = ei.entity_id
			JOIN entity_types et ON et.id = e.entity_type_id
			WHERE ei.organization_id = ${org.id}
				AND ei.namespace = 'slack_user_id'
				AND ei.identifier = ${COMBINED}
				AND ei.deleted_at IS NULL
				AND e.deleted_at IS NULL
		`;
		expect(carriers).toHaveLength(1);
		expect(carriers[0].slug).toBe("$member");
		expect(Number(carriers[0].id)).toBe(memberEntityId);
	});
});
