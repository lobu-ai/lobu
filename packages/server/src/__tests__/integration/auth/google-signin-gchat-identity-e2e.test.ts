/**
 * Google sign-in and account linking through the real Better Auth handler and
 * a mock OIDC server. The OAuth callback must persist the Google identity used
 * to resolve a Chat sender, preserve the linking user's session, and refuse an
 * account already owned by another user.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearLoginProviderCachesForTests } from "../../../auth/config";
import { clearAuthCacheForTests, createAuth } from "../../../auth/index";
import { provisionMemberAndCoreIdentities } from "../../../auth/subject-identities";
import { resolveChatUserIdentity } from "../../../lobu/stores/chat-identity";
import { clearEntityLinkRulesCache } from "../../../utils/entity-link-upsert";
import { getEnvFromProcess } from "../../../utils/env";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
	createTestSession,
} from "../../setup/test-fixtures";

/**
 * A synthetic Google account id. Google delivers this as the OIDC `sub`, and
 * Google Chat delivers the SAME value inside `message.sender.name` as
 * `users/<sub>` — which is why one namespace serves both.
 */
const GOOGLE_SUB = "100000000000000000001";
const ORG_SLUG = "acme";
const ALICE_EMAIL = "alice@acme.test";
const ORIGIN = "http://localhost";

/** Hand-build an HS256-shaped (unsigned-but-well-formed) JWT for the claims. */
function makeJwt(claims: Record<string, unknown>): string {
	const b64 = (o: unknown) =>
		Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;
}

/** A mock Google OIDC provider: /authorize → /token → /userinfo. */
function startMockGoogleOAuth(): Promise<{ server: Server; baseUrl: string }> {
	const claims = {
		sub: GOOGLE_SUB,
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
					access_token: "ya29-mock-access-token",
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

/** The write is fire-and-forget off the auth hook, so poll briefly. */
async function pollGoogleIdentity(
	orgId: string,
): Promise<{ entity_id: number; identifier: string } | null> {
	const sql = getTestDb();
	for (let i = 0; i < 60; i++) {
		const rows = await sql<{ entity_id: number; identifier: string }>`
			SELECT entity_id, identifier FROM entity_identities
			WHERE organization_id = ${orgId}
				AND namespace = 'google_user_id'
				AND source_connector = 'auth:signup'
				AND deleted_at IS NULL
			LIMIT 1
		`;
		if (rows.length > 0) return rows[0];
		await new Promise((r) => setTimeout(r, 50));
	}
	return null;
}

describe("google sign-in → gchat sender identity e2e (real BetterAuth handler)", () => {
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
		mock = await startMockGoogleOAuth();

		for (const key of [
			"BETTER_AUTH_SECRET",
			"GOOGLE_CLIENT_ID",
			"GOOGLE_CLIENT_SECRET",
		]) {
			envBackup[key] = process.env[key];
		}
		// Deterministic secret so the signed `state` cookie verifies on callback.
		process.env.BETTER_AUTH_SECRET = "a".repeat(64);
		process.env.GOOGLE_CLIENT_ID = "mock-google-client-id";
		process.env.GOOGLE_CLIENT_SECRET = "mock-google-client-secret";
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

	it.each(["signin", "link", "owned-elsewhere"] as const)("Google identity proof: %s through the real OAuth callback", async (scenario) => {
		const sql = getTestDb();

		const org = await createTestOrganization({
			name: "Acme",
			slug: ORG_SLUG,
			visibility: "private",
		});
		const alice = await createTestUser({ name: "Alice", email: scenario === "signin" ? ALICE_EMAIL : "alice@personal.test" });
		await addUserToOrganization(alice.id, org.id, "owner");

		// Pre-sign-in state: $member with auth_user_id + email, NO google_user_id.
		const { memberEntityId } = await provisionMemberAndCoreIdentities(org.id, {
			userId: alice.id,
			email: alice.email,
			name: "Alice",
		});
		const before = await sql<{ n: number }>`
			SELECT COUNT(*)::int AS n FROM entity_identities
			WHERE organization_id = ${org.id} AND namespace = 'google_user_id' AND deleted_at IS NULL
		`;
		expect(Number(before[0].n)).toBe(0);
		// And the gchat sender is a stranger.
		expect(
			await resolveChatUserIdentity("gchat", undefined, `users/${GOOGLE_SUB}`),
		).toBeNull();

		// Seed the org's "google" login provider, endpoints pointed at the mock.
		// Declaring the OIDC endpoints is what routes it through genericOAuth —
		// the same provider-agnostic path Slack takes (auth/index.tsx).
		const authSchema = {
			methods: [
				{
					type: "oauth",
					provider: "google",
					loginScopes: ["openid", "email", "profile"],
					clientIdKey: "GOOGLE_CLIENT_ID",
					clientSecretKey: "GOOGLE_CLIENT_SECRET",
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
				${org.id}, 'google-login-test', 'Google', '1.0.0', ${sql.json(authSchema)}, true, 'active', NOW(), NOW()
			)
		`;

		let sessionCookie = "";
		if (scenario !== "signin") {
			const session = await createTestSession(alice.id);
			sessionCookie = (await serializeSigned("better-auth.session_token", session.token, process.env.BETTER_AUTH_SECRET!)).split(";")[0];
		}
		let foreignUserId: string | undefined;
		if (scenario === "owned-elsewhere") {
			foreignUserId = (await createTestUser()).id;
			await sql`INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES ('test-foreign-google-account', ${GOOGLE_SUB}, 'google', ${foreignUserId}, now(), now())`;
		}
		const callbackURL = scenario === "signin" ? `${ORIGIN}/${ORG_SLUG}` : `${ORIGIN}/connector/gchat/connection?ref=test-setup-ref`;
		const signInRequest = new Request(`${ORIGIN}/api/auth/${scenario === "signin" ? "sign-in/social" : "link-social"}`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: ORIGIN, referer: `${ORIGIN}/${ORG_SLUG}`, ...(sessionCookie ? { cookie: sessionCookie } : {}) },
			body: JSON.stringify({ provider: "google", callbackURL }),
		});
		const auth = await createAuth(getEnvFromProcess(), signInRequest.clone());
		if (scenario !== "signin") {
			const anonymous = new Request(signInRequest.url, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ provider: "google", callbackURL }) });
			expect((await auth.handler(anonymous)).status).toBe(401);
		}

		// 1) Start sign-in or account linking → { url } + signed state cookie.
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
		).toContain("/api/auth/oauth2/callback/google");

		// 3) Real token exchange → id_token decode → account link →
		//    account.create.after hook → persistLoginChatIdentity.
		const callbackRes = await auth.handler(
			new Request(callbackLocation as string, {
				method: "GET",
				headers: { cookie: [stateCookie, sessionCookie].filter(Boolean).join("; "), referer: callbackURL },
			}),
		);
		expect(callbackRes.status).toBe(302);
		if (scenario === "owned-elsewhere") {
			expect(callbackRes.headers.get("location")).toContain("account_already_linked_to_different_user");
			const [account] = await sql`SELECT "userId" FROM account WHERE "providerId" = 'google' AND "accountId" = ${GOOGLE_SUB}`;
			expect(account.userId).toBe(foreignUserId);
			return;
		}
		expect(callbackRes.headers.get("location")).toBe(callbackURL);
		if (scenario === "link") {
			const session = await auth.api.getSession({ headers: new Headers({ cookie: sessionCookie }) });
			expect(session?.user.id).toBe(alice.id);
		}
		expect(
			callbackRes.headers.get("location") ?? "",
			"callback must not land on the auth error page",
		).not.toContain("/error");

		// The google account must be linked to Alice (not a new user), and its
		// accountId must BE the sub — the assumption the whole design rests on.
		const accounts = await sql<{ userId: string }>`
			SELECT "userId" FROM "account"
			WHERE "providerId" = 'google' AND "accountId" = ${GOOGLE_SUB}
		`;
		expect(accounts).toHaveLength(1);
		expect(accounts[0].userId).toBe(alice.id);

		// 4) The hook wrote the identity onto Alice's $member — BARE, no prefix.
		const identity = await pollGoogleIdentity(org.id);
		expect(
			identity,
			"account.create.after hook must write google_user_id onto the $member",
		).not.toBeNull();
		expect(identity?.entity_id).toBe(memberEntityId);
		expect(identity?.identifier).toBe(GOOGLE_SUB);

		// 5) THE LOOP CLOSES. This is verbatim what the gchat adapter hands over:
		//    `message.sender.name`, and no team id.
		expect(
			await resolveChatUserIdentity("gchat", undefined, `users/${GOOGLE_SUB}`),
		).toBe(alice.id);
	});
});
