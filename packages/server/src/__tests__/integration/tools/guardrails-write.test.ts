/**
 * The guardrail library writers: `PUT /api/:org/guardrails[/:id]` and
 * `DELETE /api/:org/guardrails/:id`, driven over real HTTP. Only an
 * owner/admin web session or a human-minted `guardrails:write` PAT writes;
 * every write is compare-and-swap on `revision` and leaves a config event.
 */
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app, type Env } from "../../../index";
import { initWorkspaceProvider } from "../../../workspace";
import { postForm } from "../../setup/test-helpers";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAccessToken,
	createTestAgent,
	createTestOAuthClient,
	createTestOrganization,
	createTestPAT,
	createTestSession,
	createTestUser,
	createTestWorkspaceGuardrail,
} from "../../setup/test-fixtures";

const env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	RATE_LIMIT_ENABLED: "false",
} as Env;

let org: Awaited<ReturnType<typeof createTestOrganization>>;
let owner: Awaited<ReturnType<typeof createTestUser>>;
let cookie: string;
let server: Server;
let baseUrl: string;

function request(method: string, route: string, body?: unknown, auth?: { token?: string; cookie?: string }) {
	const credential = auth?.token ? { Authorization: `Bearer ${auth.token}` } : { Cookie: auth?.cookie ?? cookie };
	return fetch(`${baseUrl}${route}`, {
		method,
		headers: { "Content-Type": "application/json", Origin: baseUrl, ...credential },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
const base = () => `/api/${org.slug}/guardrails`;
const create = (guardrail: unknown, auth?: { token?: string; cookie?: string }) =>
	request("PUT", base(), { guardrail, expected_revision: 0 }, auth);
const replace = (id: string, guardrail: unknown, expected_revision: number, auth?: { token?: string }) =>
	request("PUT", `${base()}/${id}`, { guardrail, expected_revision }, auth);
const archive = (id: string, expected_revision: number | string, auth?: { token?: string }) =>
	request("DELETE", `${base()}/${id}?expected_revision=${expected_revision}`, undefined, auth);

async function created(guardrail: unknown) {
	const response = await create(guardrail);
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json()).guardrail as { id: string; revision: number; [key: string]: unknown };
}

beforeAll(async () => {
	await initWorkspaceProvider();
	await new Promise<void>((resolve) => {
		server = serve({ fetch: (req) => app.fetch(req, env), port: 0, hostname: "127.0.0.1" }, (address) => {
			baseUrl = `http://127.0.0.1:${address.port}`;
			resolve();
		}) as Server;
	});
});
afterAll(async () => {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	await cleanupTestDatabase();
});
beforeEach(async () => {
	org = await createTestOrganization();
	owner = await createTestUser();
	await addUserToOrganization(owner.id, org.id, "owner");
	cookie = (await createTestSession(owner.id)).cookieHeader;
});

describe("guardrail library writes", () => {
	it("creates, replaces, keeps the revision on a no-op and archives with compare-and-swap", async () => {
		const agent = await createTestAgent({ organizationId: org.id, ownerUserId: owner.id });
		const made = await created({ name: "secret-scan", config: { builtin: "secret-scan" } });
		expect(made).toMatchObject({
			name: "secret-scan",
			config: { builtin: "secret-scan" },
			applies_to: [{ principal_kind: "agent", principal_id: null }],
			enabled: true,
			revision: 1,
			archived: false,
		});
		expect(made.id).toMatch(/^guardrail_[0-9a-f]{32}$/);

		const scoped = { name: "secret-scan", config: { builtin: "secret-scan" }, applies_to: [{ principal_kind: "agent", principal_id: agent.agentId }], enabled: false };
		const updated = await replace(made.id, scoped, 1);
		expect(updated.status).toBe(200);
		expect((await updated.json()).guardrail).toMatchObject({ revision: 2, enabled: false, applies_to: [{ principal_kind: "agent", principal_id: agent.agentId }] });

		const same = await replace(made.id, scoped, 2);
		expect(same.status).toBe(200);
		expect((await same.json()).guardrail.revision).toBe(2);

		expect((await replace(made.id, scoped, 1)).status).toBe(409);
		expect((await archive(made.id, 1)).status).toBe(409);
		const archived = await archive(made.id, 2);
		expect(archived.status).toBe(200);
		expect((await archived.json()).guardrail).toMatchObject({ archived: true, revision: 3 });
		expect((await replace(made.id, scoped, 3)).status).toBe(409);
		expect((await archive(made.id, 3)).status).toBe(409);
		// Archiving frees the name.
		expect((await create({ name: "secret-scan", config: { builtin: "secret-scan" } })).status).toBe(200);
		expect((await create({ name: "secret-scan", config: { builtin: "pii-scan" } })).status).toBe(409);

		const [{ count }] = await getTestDb()`
			SELECT count(*)::int AS count FROM current_event_records
			WHERE organization_id = ${org.id} AND metadata->>'resource_kind' = 'guardrail' AND metadata->>'resource_id' = ${made.id}
		`;
		// created, updated, archived; the no-op PUT recorded nothing.
		expect(count).toBe(3);
	});

	it("answers 422 for a rename, a bad config, a non-agent subject, an unknown agent and a mismatched revision", async () => {
		const made = await created({ name: "pii", config: { builtin: "pii-scan" } });
		expect((await replace(made.id, { name: "pii-two", config: { builtin: "pii-scan" } }, 1)).status).toBe(422);
		for (const guardrail of [
			{ name: "Bad Name", config: { builtin: "pii-scan" } },
			{ name: "x", config: { builtin: "not-a-check" } },
			{ name: "x", config: { builtin: "pii-scan", stage: "output" } },
			// A custom check is no longer a guardrail config.
			{ name: "x", config: { kind: "judge", stage: "output", policy: "p" } },
			{ name: "x", config: { builtin: "pii-scan" }, applies_to: [] },
			{ name: "x", config: { builtin: "pii-scan" }, applies_to: [{ principal_kind: null, principal_id: null }] },
			{ name: "x", config: { builtin: "pii-scan" }, applies_to: [{ principal_kind: "app", principal_id: "local:app" }] },
			{ name: "x", config: { builtin: "pii-scan" }, applies_to: [{ principal_kind: "agent", principal_id: "agent-missing" }] },
			{ name: "x", config: { builtin: "pii-scan" }, extra: true },
		]) {
			const response = await create(guardrail);
			expect(response.status, JSON.stringify(guardrail)).toBe(422);
		}
		const body = { name: "x", config: { builtin: "pii-scan" } };
		expect((await request("PUT", base(), { guardrail: body, expected_revision: 1 })).status).toBe(422);
		expect((await request("PUT", `${base()}/${made.id}`, { guardrail: { ...body, name: "pii" }, expected_revision: 0 })).status).toBe(422);
		expect((await archive(made.id, "nope")).status).toBe(422);
	});

	it("accepts app subjects only on a guardrail that runs at pre-tool alone", async () => {
		const apps = [{ principal_kind: "app", principal_id: null }, { principal_kind: "app", principal_id: "web:example.com" }];
		const forbidden = await created({ name: "forbidden-tools", config: { builtin: "forbidden-tools" }, applies_to: [...apps, { principal_kind: "agent", principal_id: null }] });
		expect(forbidden.applies_to).toEqual(expect.arrayContaining([...apps, { principal_kind: "agent", principal_id: null }]));

		for (const config of [
			{ builtin: "secret-scan" },
			// pii-scan also runs at input and output.
			{ builtin: "pii-scan" },
		]) {
			const response = await create({ name: "app-elsewhere", config, applies_to: [apps[0]] });
			expect(response.status, JSON.stringify(config)).toBe(422);
			expect((await response.json()).error).toMatch(/App subjects apply only to pre-tool guardrails/);
		}
		// An app key must be one the server derives; a guardrail cannot move an
		// app subject off pre-tool.
		expect((await create({ name: "bad-app-key", config: { builtin: "forbidden-tools" }, applies_to: [{ principal_kind: "app", principal_id: "not an app key" }] })).status).toBe(422);
		expect((await replace(forbidden.id, { name: "forbidden-tools", config: { builtin: "pii-scan" }, applies_to: apps }, 1)).status).toBe(422);
	});

	it("answers 404 for a missing guardrail and another workspace's", async () => {
		const other = await createTestOrganization();
		const foreign = await createTestWorkspaceGuardrail({ organizationId: other.id, name: "pii", config: { builtin: "pii-scan" } });
		for (const id of ["guardrail_missing", foreign.id]) {
			expect((await replace(id, { name: "pii", config: { builtin: "pii-scan" } }, 1)).status).toBe(404);
			expect((await archive(id, 1)).status).toBe(404);
		}
		const [row] = await getTestDb()`SELECT revision, archived_at FROM workspace_guardrails WHERE id = ${foreign.id}`;
		expect(Number(row.revision)).toBe(1);
		expect(row.archived_at).toBeNull();
	});

	it("admits only an owner/admin web session or a human-minted guardrails:write PAT", async () => {
		const guardrail = { name: "secret-scan", config: { builtin: "secret-scan" } };
		const member = await createTestUser();
		await addUserToOrganization(member.id, org.id, "member");
		const memberCookie = (await createTestSession(member.id)).cookieHeader;
		const client = await createTestOAuthClient();
		const oauth = (await createTestAccessToken(owner.id, org.id, client.client_id, { scope: "mcp:admin" })).token;
		const ordinary = (await createTestPAT(owner.id, org.id, { scope: "mcp:admin" })).token;
		const exchange = await postForm("/api/extension-session", { token: ordinary });
		expect(exchange.status).toBe(200);
		const { session_token } = await exchange.json();

		expect((await create(guardrail, { cookie: memberCookie })).status).toBe(403);
		for (const token of [oauth, ordinary, session_token]) {
			expect((await create(guardrail, { token })).status).toBe(403);
		}
		expect((await request("POST", `/api/${org.slug}/tokens`, { name: "guardrail-deploy", scope: "guardrails:write" }, { token: oauth })).status).toBe(403);
		const minted = await request("POST", `/api/${org.slug}/tokens`, { name: "guardrail-deploy", scope: "guardrails:write" });
		expect(minted.status).toBe(201);
		const { token } = await minted.json();
		const made = await create(guardrail, { token: token.token });
		expect(made.status).toBe(200);
		const { guardrail: stored } = await made.json();

		const sql = getTestDb();
		await sql`UPDATE personal_access_tokens SET worker_id = 'synthetic-worker' WHERE id = ${token.id}`;
		expect((await archive(stored.id, 1, { token: token.token })).status).toBe(403);
		await sql`UPDATE personal_access_tokens SET worker_id = NULL WHERE id = ${token.id}`;
		await sql`UPDATE "member" SET role = 'member' WHERE "userId" = ${owner.id} AND "organizationId" = ${org.id}`;
		expect((await archive(stored.id, 1, { token: token.token })).status).toBe(403);
		await sql`UPDATE "member" SET role = 'owner' WHERE "userId" = ${owner.id} AND "organizationId" = ${org.id}`;
		expect((await archive(stored.id, 1, { token: token.token })).status).toBe(200);
		// The scope writes guardrails only.
		expect((await request("PUT", `/api/${org.slug}/write-permissions/connector-actions`, { revision: "x", rules: [] }, { token: token.token })).status).toBe(403);
	});
});
