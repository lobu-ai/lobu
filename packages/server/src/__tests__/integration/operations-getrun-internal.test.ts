/**
 * get_run must fetch ANY run_type that list_runs surfaces — action, internal,
 * automation, sync — not just action. list_runs shows every operational run
 * (everything except the chat_message transport lane), and approve/reject act
 * on them, but get_run filtered run_type IN ('action','internal') and returned
 * "Run not found" for an automation/sync run the same principal could list. It now
 * shares the list's excluded-types set, so any listed run is fetchable; only
 * chat_message (the list's default exclusion) stays unfetchable.
 */

import { AGENT_ERRORS, AgentErrorCode } from "@lobu/core";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveAutomationRunsByMessageIds } from "../../automations/run-completion";
import type { Env } from "../../index";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { createTestOrganization, createTestUser } from "../setup/test-fixtures";

const env = {} as Env;

function retiredVocabularyKeys(value: unknown, path = "$"): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item, index) =>
			retiredVocabularyKeys(item, `${path}[${index}]`),
		);
	}
	if (value === null || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, child]) => [
		...(/watch(?:er)|behav(?:ior)/i.test(key) ? [`${path}.${key}`] : []),
		...retiredVocabularyKeys(child, `${path}.${key}`),
	]);
}

describe("manage_operations get_run — internal runs", () => {
	let orgId: string;

	const ctx = (): ToolContext => ({
		organizationId: orgId,
		userId: "getrun-owner",
		memberRole: "owner",
		isAuthenticated: true,
		tokenType: "oauth",
		scopes: ["mcp:admin"],
		scopedToOrg: false,
		allowCrossOrg: false,
	});

	async function insertRun(
		runType: "action" | "internal" | "sync" | "automation" | "chat_message",
		actionKey: string | null,
	): Promise<number> {
		const db = getTestDb();
		const [row] = (await db`
      INSERT INTO runs (organization_id, run_type, action_key, status, created_at, run_at)
      VALUES (${orgId}, ${runType}, ${actionKey}, 'pending', now(), now())
      RETURNING id
    `) as unknown as Array<{ id: number }>;
		return Number(row.id);
	}

	async function getRun(runId: number): Promise<Record<string, unknown>> {
		return (await manageOperations(
			{ action: "get_run", run_id: runId },
			env,
			ctx(),
		)) as Record<string, unknown>;
	}

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "GetRun Internal Org" });
		orgId = org.id;
	});

	it("fetches an internal run instead of reporting 'Run not found'", async () => {
		const id = await insertRun("internal", "manage_agents");
		const result = await getRun(id);
		expect(result.error).toBeUndefined();
		expect(result.action).toBe("get_run");
		const run = result.run as Record<string, unknown>;
		expect(Number(run.id)).toBe(id);
		expect(run.run_type).toBe("internal");
	});

	it("still fetches an action run", async () => {
		const id = await insertRun("action", "test_action");
		const result = await getRun(id);
		const run = result.run as Record<string, unknown>;
		expect(Number(run.id)).toBe(id);
		expect(run.run_type).toBe("action");
	});

	it("fetches a sync run (listed operationally, so must be gettable)", async () => {
		const id = await insertRun("sync", null);
		const result = await getRun(id);
		const run = result.run as Record<string, unknown>;
		expect(Number(run.id)).toBe(id);
		expect(run.run_type).toBe("sync");
	});

	it("fetches an automation run (listed operationally, so must be gettable)", async () => {
		const id = await insertRun("automation", "propose_entity_change");
		const result = await getRun(id);
		const run = result.run as Record<string, unknown>;
		expect(Number(run.id)).toBe(id);
		expect(run.run_type).toBe("automation");
	});

	it("does NOT fetch a chat_message transport run (excluded from the operational list)", async () => {
		const id = await insertRun("chat_message", "thread_response");
		const result = await getRun(id);
		expect(result.error).toBe("Run not found");
	});

	it("surfaces the recorded initiator through get_run and list_runs", async () => {
		const db = getTestDb();
		const proposer = await createTestUser();
		const initiatorRef = {
			agent_id: "personal-agent",
			client_id: "claude-ai",
			user_id: proposer.id,
		};
		const [row] = (await db`
      INSERT INTO runs (organization_id, run_type, action_key, status,
        approval_status, created_by_user_id, initiator_kind, initiator_ref,
        created_at, run_at)
      VALUES (${orgId}, 'internal', 'entity_change', 'pending', 'pending',
        ${proposer.id}, 'agent_session',
        ${db.json(initiatorRef)},
        now(), now())
      RETURNING id
    `) as unknown as Array<{ id: number }>;
		const id = Number(row.id);

		const got = (await getRun(id)).run as Record<string, unknown>;
		expect(got.initiator_kind).toBe("agent_session");
		expect(got.created_by_user_id).toBe(proposer.id);
		expect(got.initiator_ref).toEqual(initiatorRef);

		const listed = (await manageOperations(
			{
				action: "list_runs",
				run_types: ["internal"],
				approval_status: "pending",
			},
			env,
			ctx(),
		)) as { runs: Array<Record<string, unknown>> };
		const found = listed.runs.find((r) => Number(r.id) === id);
		expect(found?.initiator_kind).toBe("agent_session");
		expect(found?.created_by_user_id).toBe(proposer.id);
		expect(found?.initiator_ref).toEqual(initiatorRef);
	});

	it("uses Automation vocabulary for every platform-owned public run field", async () => {
		const db = getTestDb();
		const creator = await createTestUser();
		const [automation] = (await db`
			WITH next_id AS (
				SELECT nextval('automations_id_seq')::integer AS id
			)
			INSERT INTO automations (
				id, automation_group_id, organization_id, managed_agent_id, created_by, name, slug
			)
			SELECT id, id, ${orgId}, 'personal-agent', ${creator.id}, 'Public vocabulary', 'public-vocabulary'
			FROM next_id
			RETURNING id
		`) as unknown as Array<{ id: number }>;
		const automationId = Number(automation.id);
		const [row] = (await db`
			INSERT INTO runs (
				organization_id, run_type, action_key, action_input, automation_id,
				status, approval_status,
				initiator_kind, initiator_ref, created_at, run_at
			)
			VALUES (
				${orgId}, 'internal', 'entity_field_change',
				${db.json({
					automation_id: automationId,
					entity_id: 42,
					fields: { status: "reviewed" },
				})},
				${automationId}, 'completed', 'auto',
				'automation',
				${db.json({ automation_id: automationId, run_id: 18 })},
				now(), now()
			)
			RETURNING id
		`) as unknown as Array<{ id: number }>;
		const runId = Number(row.id);

		const listed = (await manageOperations(
			{ action: "list_runs", run_types: ["internal"] },
			env,
			ctx(),
		)) as { runs: Array<Record<string, unknown>> };
		const listedRun = listed.runs.find((run) => Number(run.id) === runId);
		expect(listedRun?.automation_id).toBe(automationId);
		expect(listedRun?.initiator_ref).toEqual({
			automation_id: automationId,
			run_id: 18,
		});
		expect(listedRun?.input).toEqual({
			automation_id: automationId,
			entity_id: 42,
			fields: { status: "reviewed" },
		});
		expect(retiredVocabularyKeys(listedRun)).toEqual([]);

		const got = (await getRun(runId)).run as Record<string, unknown>;
		expect(got.automation_id).toBe(automationId);
		expect(got.initiator_ref).toEqual({
			automation_id: automationId,
			run_id: 18,
		});
		expect(got.input).toEqual({
			automation_id: automationId,
			entity_id: 42,
			fields: { status: "reviewed" },
		});
		expect(retiredVocabularyKeys(got)).toEqual([]);

		const activity = (await manageOperations(
			{
				action: "list_activity",
				include_notifications: false,
				aggregate: false,
			},
			env,
			ctx(),
		)) as { items: Array<Record<string, unknown>> };
		const card = activity.items.find((item) => Number(item.run_id) === runId);
		expect(card?.automation_id).toBe(automationId);
		expect(retiredVocabularyKeys(card)).toEqual([]);
	});
	/**
	 * A device-executed Automation reports how its local CLI exited
	 * (`exit_reason`/`exit_code`/`exit_signal`) plus the tail of what the CLI
	 * printed (`output_tail`). The worker writes all four, but no read surface
	 * selected them and `runs` is not in the query_sql allowlist — so the only
	 * forensic record of a timed-out device Automation was reachable only by
	 * querying the database directly. Prod #71 stalled 39 times undiagnosed.
	 */
	it("surfaces the device-CLI exit diagnostics through get_run", async () => {
		const db = getTestDb();
		const [row] = (await db`
      INSERT INTO runs (organization_id, run_type, action_key, status,
        error_message, exit_reason, exit_code, exit_signal, output_tail,
        created_at, run_at)
      VALUES (${orgId}, 'automation', null, 'failed',
        'opencode exited via SIGTERM after 600s timeout', 'timeout', 15, 'SIGTERM',
        'MCP server handshake failed: connection refused',
        now(), now())
      RETURNING id
    `) as unknown as Array<{ id: number }>;
		const id = Number(row.id);

		const got = (await getRun(id)).run as Record<string, unknown>;
		expect(got.exit_reason).toBe("timeout");
		expect(Number(got.exit_code)).toBe(15);
		expect(got.exit_signal).toBe("SIGTERM");
		expect(got.output_tail).toContain("MCP server handshake failed");
	});

	it("classifies an image-unsupported error_message into error_code for the peek pane", async () => {
		const db = getTestDb();
		const [row] = (await db`
      INSERT INTO runs (organization_id, run_type, action_key, status,
        error_message, created_at, run_at)
      VALUES (${orgId}, 'automation', null, 'failed',
        'Cannot read "image" (this model does not support image input). Inform the user.',
        now(), now())
      RETURNING id
    `) as unknown as Array<{ id: number }>;
		const id = Number(row.id);

		const got = (await getRun(id)).run as Record<string, unknown>;
		// The raw vendor string stays for logs; each run surface renders the
		// catalog message + CTA from this code instead.
		expect(got.error_code).toBe("MODEL_IMAGE_UNSUPPORTED");
		expect(got.error_message).toContain("does not support image input");

		const listed = (await manageOperations(
			{ action: "list_runs", run_types: ["automation"] },
			env,
			ctx(),
		)) as { runs: Array<Record<string, unknown>> };
		const listedRun = listed.runs.find((r) => Number(r.id) === id);
		expect(listedRun?.error_code).toBe("MODEL_IMAGE_UNSUPPORTED");

		const activity = (await manageOperations(
			{ action: "list_activity", include_notifications: false, aggregate: false },
			env,
			ctx(),
		)) as { items: Array<Record<string, unknown>> };
		const card = activity.items.find((item) => Number(item.run_id) === id);
		expect(card?.body).toContain("can't read images");
		expect(card?.body).not.toContain("does not support image input");
	});

	it("keeps the code of a hosted failure stored as its catalog text", async () => {
		const db = getTestDb();
		const messageId = "image-unsupported-hosted-turn";
		const [row] = (await db`
      INSERT INTO runs (organization_id, run_type, action_key, status,
        dispatched_message_id, created_at, run_at)
      VALUES (${orgId}, 'automation', null, 'running', ${messageId}, now(), now())
      RETURNING id
    `) as unknown as Array<{ id: number }>;
		const id = Number(row.id);
		// The API renderer's terminal write: the catalog text, plus the code.
		const catalogText = AGENT_ERRORS[AgentErrorCode.MODEL_IMAGE_UNSUPPORTED].message;
		const { resolved } = await resolveAutomationRunsByMessageIds(
			[messageId],
			{ ok: false, error: catalogText as string, errorCode: AgentErrorCode.MODEL_IMAGE_UNSUPPORTED },
			db,
		);
		expect(resolved).toBe(1);

		const got = (await getRun(id)).run as Record<string, unknown>;
		expect(got.error_message).toBe(catalogText);
		expect(got.error_code).toBe("MODEL_IMAGE_UNSUPPORTED");
	});

	it("leaves a non-agent run's error raw: the catalog is an agent vocabulary", async () => {
		const db = getTestDb();
		// The isolate executor's wording, which the catalog maps to the agent's
		// "didn't finish responding" for an agent turn — wrong for a connector run.
		const [row] = (await db`
      INSERT INTO runs (organization_id, run_type, action_key, status,
        error_message, created_at, run_at)
      VALUES (${orgId}, 'internal', 'entity_change', 'failed',
        'Execution timed out after 600000ms', now(), now())
      RETURNING id
    `) as unknown as Array<{ id: number }>;
		const id = Number(row.id);

		const got = (await getRun(id)).run as Record<string, unknown>;
		expect(got.error_code).toBeNull();
		expect(got.error_message).toBe("Execution timed out after 600000ms");

		const activity = (await manageOperations(
			{ action: "list_activity", include_notifications: false, aggregate: false },
			env,
			ctx(),
		)) as { items: Array<Record<string, unknown>> };
		const card = activity.items.find((item) => Number(item.run_id) === id);
		expect(card?.body).toBe("Execution timed out after 600000ms");
	});
});
