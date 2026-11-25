/**
 * The guardrail library writers: `PUT /api/:org/guardrails[/:id]` and
 * `DELETE /api/:org/guardrails/:id`, driven over real HTTP. Only an
 * owner/admin web session or a human-minted `guardrails:write` PAT writes;
 * every write is compare-and-swap on `revision` and leaves a config event
 * whose judge policy is digested.
 */
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GrantStore } from "../../../gateway/permissions/grant-store";
import { lockEgressJudgeDecisions } from "../../../gateway/permissions/policy-store";
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
// A judge model this deployment can run: the repo's provider registry plus a
// synthetic system key for its OpenAI entry.
const RUNNABLE_MODEL = "openai/gpt-4o-mini";
const REGISTRY_PATH = new URL("../../../../../../config/providers.json", import.meta.url).pathname;

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

const judge = (policy = "Never promise refunds.") => ({
	name: "no-refunds",
	config: { kind: "judge", stage: "output", policy, model: RUNNABLE_MODEL },
});

async function created(guardrail: unknown) {
	const response = await create(guardrail);
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json()).guardrail as { id: string; revision: number; [key: string]: unknown };
}

async function lastChange(id: string) {
	const [row] = await getTestDb()`
		SELECT row_to_json(e)::text AS raw, metadata FROM current_event_records e
		WHERE organization_id = ${org.id} AND metadata->>'resource_kind' = 'guardrail' AND metadata->>'resource_id' = ${id}
		ORDER BY id DESC LIMIT 1
	`;
	return row as { raw: string; metadata: Record<string, unknown> } | undefined;
}

beforeAll(async () => {
	vi.stubEnv("LOBU_PROVIDER_REGISTRY_PATH", REGISTRY_PATH);
	vi.stubEnv("OPENAI_API_KEY", "sk-synthetic-deployment-key");
	await initWorkspaceProvider();
	await new Promise<void>((resolve) => {
		server = serve({ fetch: (req) => app.fetch(req, env), port: 0, hostname: "127.0.0.1" }, (address) => {
			baseUrl = `http://127.0.0.1:${address.port}`;
			resolve();
		}) as Server;
	});
});
afterAll(async () => {
	vi.unstubAllEnvs();
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
			{ name: "x", config: { kind: "judge", stage: "output", policy: "  ", model: RUNNABLE_MODEL } },
			{ name: "x", config: { kind: "judge", stage: "egress", policy: "p", model: RUNNABLE_MODEL } },
			{ name: "x", config: { kind: "judge", stage: "output", policy: "p", model: RUNNABLE_MODEL, domains: ["a.com"] } },
			{ name: "x", config: { kind: "require-tool", stage: "input", tools: ["t"] } },
			{ name: "x", config: { kind: "require-tool", stage: "output", tools: [] } },
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

	it("needs a judge model this deployment can run, but keeps saving a stored one", async () => {
		const noModel = { name: "tone", config: { kind: "judge", stage: "output", policy: "Be polite." } };
		const missing = await create(noModel);
		expect(missing.status).toBe(422);
		expect((await missing.json()).error).toContain("no default provider model");
		const unresolvable = await create({ ...noModel, config: { ...noModel.config, model: "unknown-provider/m" } });
		expect(unresolvable.status).toBe(422);
		expect((await unresolvable.json()).error).toContain("cannot run");

		const stored = await createTestWorkspaceGuardrail({
			organizationId: org.id,
			name: "legacy",
			config: { kind: "judge", stage: "output", policy: "Be polite.", model: "unknown-provider/m" },
		});
		const legacy = { name: "legacy", config: { kind: "judge", stage: "output", policy: "Be kind.", model: "unknown-provider/m" } };
		expect((await replace(stored.id, legacy, 1)).status).toBe(200);
		expect((await replace(stored.id, { ...legacy, config: { ...legacy.config, model: "other-provider/m" } }, 2)).status).toBe(422);
		expect((await replace(stored.id, { ...legacy, config: { ...legacy.config, model: RUNNABLE_MODEL } }, 2)).status).toBe(200);
	});

	it("refuses an egress judge an agent's allowedDomains would shadow and revokes shadowing grants", async () => {
		const shadowed = await createTestAgent({ organizationId: org.id, ownerUserId: owner.id });
		const granted = await createTestAgent({ organizationId: org.id, ownerUserId: owner.id });
		await getTestDb()`UPDATE agents SET network_config = ${getTestDb().json({ allowedDomains: [".payments.test"] })} WHERE id = ${shadowed.agentId}`;
		const egress = (agentId: string) => ({
			name: "payments",
			config: { kind: "judge", stage: "egress", policy: "Only read invoices.", model: RUNNABLE_MODEL, domains: ["api.payments.test"] },
			applies_to: [{ principal_kind: "agent", principal_id: agentId }],
		});
		const refused = await create(egress(shadowed.agentId));
		expect(refused.status).toBe(422);
		expect((await refused.json()).error).toContain(`agent "${shadowed.agentId}" allows ".payments.test"`);
		// Every agent includes the shadowed one.
		expect((await create({ ...egress(shadowed.agentId), applies_to: undefined })).status).toBe(422);

		const sql = getTestDb();
		for (const [pattern, denied] of [["api.payments.test", false], ["*.payments.test", true], ["unrelated.test", false]] as const) {
			await sql`INSERT INTO grants (agent_id, kind, pattern, denied, organization_id) VALUES (${granted.agentId}, 'domain', ${pattern}, ${denied}, ${org.id})`;
		}
		expect((await create(egress(granted.agentId))).status).toBe(200);
		const left = await sql`SELECT pattern, denied FROM grants WHERE agent_id = ${granted.agentId} ORDER BY pattern, denied`;
		expect(left.map((row) => [row.pattern, row.denied])).toEqual([["*.payments.test", true], ["unrelated.test", false]]);
	});

	it("serializes an egress judge write with allow-grant writes, so no grant outlives its judge", async () => {
		const sql = getTestDb();
		const agent = await createTestAgent({ organizationId: org.id, ownerUserId: owner.id });
		const egress = {
			name: "payments",
			config: { kind: "judge", stage: "egress", policy: "Only read invoices.", model: RUNNABLE_MODEL, domains: ["api.payments.test"] },
			applies_to: [{ principal_kind: "agent", principal_id: agent.agentId }],
		};
		const allowGrants = async () =>
			(await sql`SELECT pattern FROM grants WHERE agent_id = ${agent.agentId} AND NOT denied`).map((row) => row.pattern);
		/** Run `body` in a transaction holding the org's egress-judge lock until `release`. */
		const holdLock = (body: (tx: typeof sql) => Promise<void>) => {
			let release!: () => void;
			let locked!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			const isLocked = new Promise<void>((resolve) => (locked = resolve));
			const done = sql.begin(async (tx) => {
				await lockEgressJudgeDecisions(tx as unknown as typeof sql, org.id);
				locked();
				await held;
				await body(tx as unknown as typeof sql);
			});
			return { isLocked, release, done };
		};
		const stateAfter = (pending: Promise<unknown>) =>
			Promise.race([pending.then(() => "finished"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 300))]);

		// An allow grant mid-write: the judge write waits for it, then revokes it.
		const grantWrite = holdLock(async (tx) => {
			await tx`INSERT INTO grants (agent_id, kind, pattern, denied, organization_id) VALUES (${agent.agentId}, 'domain', 'api.payments.test', false, ${org.id})`;
		});
		await grantWrite.isLocked;
		const judgeWrite = create(egress);
		const judgeWriteState = await stateAfter(judgeWrite);
		grantWrite.release();
		await grantWrite.done;
		expect((await judgeWrite).status).toBe(200);
		expect(await allowGrants()).toEqual([]);
		expect(judgeWriteState).toBe("waiting");

		// A judge write mid-commit: GrantStore.grant waits, sees the judge, and skips.
		const other = await createTestAgent({ organizationId: org.id, ownerUserId: owner.id });
		const otherJudge = holdLock(async (tx) => {
			await tx`INSERT INTO workspace_guardrails (id, organization_id, name, config, enabled)
				VALUES ('guardrail-race', ${org.id}, 'payments-other', ${tx.json(egress.config)}, true)`;
			await tx`INSERT INTO workspace_guardrail_subjects (guardrail_id, organization_id, principal_kind, principal_id)
				VALUES ('guardrail-race', ${org.id}, 'agent', ${other.agentId})`;
		});
		await otherJudge.isLocked;
		const grant = new GrantStore().grant(other.agentId, "api.payments.test", null, false, org.id);
		const grantState = await stateAfter(grant);
		otherJudge.release();
		await otherJudge.done;
		await grant;
		expect((await sql`SELECT pattern FROM grants WHERE agent_id = ${other.agentId}`).map((row) => row.pattern)).toEqual([]);
		expect(grantState).toBe("waiting");

		// An agent created (with an allow grant) after an every-agent judge
		// write read the workspace's agents but before it took the lock: the
		// cleanup covers the agents present under the lock, so it goes too.
		const lateAgentId = `agent-late-${org.id.slice(-6)}`;
		const lateAgent = holdLock(async (tx) => {
			await tx`INSERT INTO agents (id, organization_id, name, owner_platform, owner_user_id, created_at, updated_at)
				VALUES (${lateAgentId}, ${org.id}, 'Late', 'lobu', ${owner.id}, NOW(), NOW())`;
			await tx`INSERT INTO grants (agent_id, kind, pattern, denied, organization_id)
				VALUES (${lateAgentId}, 'domain', 'api.ledger.test', false, ${org.id})`;
		});
		await lateAgent.isLocked;
		const everyAgentJudge = create({
			name: "ledger",
			config: { ...egress.config, domains: ["api.ledger.test"] },
			applies_to: [{ principal_kind: "agent", principal_id: null }],
		});
		const everyAgentState = await stateAfter(everyAgentJudge);
		lateAgent.release();
		await lateAgent.done;
		expect((await everyAgentJudge).status).toBe(200);
		expect((await sql`SELECT pattern FROM grants WHERE agent_id = ${lateAgentId} AND NOT denied`).map((row) => row.pattern)).toEqual([]);
		expect(everyAgentState).toBe("waiting");
	});

	it("records a config event that digests the judge policy", async () => {
		const policy = "Never mention the synthetic codeword ZEPHYR-41.";
		const made = await created(judge(policy));
		const createdEvent = await lastChange(made.id);
		expect(createdEvent?.metadata).toMatchObject({ resource_kind: "guardrail", resource_id: made.id });
		expect(createdEvent?.raw).toContain("policy_sha256");
		expect(createdEvent?.raw).not.toContain("ZEPHYR-41");

		expect((await replace(made.id, judge("Never mention ORCHID-7."), 1)).status).toBe(200);
		const updatedEvent = await lastChange(made.id);
		expect(updatedEvent?.raw).not.toContain("ZEPHYR-41");
		expect(updatedEvent?.raw).not.toContain("ORCHID-7");
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
