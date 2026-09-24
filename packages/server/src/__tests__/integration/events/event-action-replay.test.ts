import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invokeTemplateEventAction, type InvokeTemplateEventActionParams } from "../../../interactions/template-event-actions";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestEntity } from "../../setup/test-fixtures";
import { TestApiClient, TestWorkspace } from "../../setup/test-mcp-client";

describe("accepted event action retries", () => {
	beforeAll(async () => { await initWorkspaceProvider(); });
	beforeEach(async () => { await cleanupTestDatabase(); });

	async function fixture(metadata: Record<string, unknown> = {}) {
		const workspace = await TestWorkspace.create({ name: "Action Replay Test" });
		const api = await TestApiClient.for({ organizationId: workspace.org.id, userId: workspace.users.owner.id, memberRole: "owner" });
		await api.entity_schema.createType({
			slug: "replay-item", name: "Replay item",
			event_kinds: {
				"replay.opened": {
					description: "An offered action",
					jsonTemplate: { type: "card", children: [
						{ type: "button", props: { label: "A", onClick: "@choose", value: "A" } },
						{ type: "button", props: { label: "B", onClick: "@choose", value: "B" } },
					] },
					interactions: { choose: { emits: "replay.chosen" } },
				},
				"replay.chosen": { description: "An accepted action" },
				"replay.closed": { description: "Actions no longer offered" },
			},
		});
		const entity = await createTestEntity({ name: "Replay item", entity_type: "replay-item", organization_id: workspace.org.id, created_by: workspace.users.owner.id });
		const source = await api.knowledge.save({ entity_ids: [entity.id], semantic_type: "replay.opened", content: "Choose", payload_type: "empty", metadata });
		const params: InvokeTemplateEventActionParams = {
			organizationId: workspace.org.id, sourceEventId: source.id, action: "choose", value: "A", interactionId: "accepted-click", surface: "web",
			actor: { platform: "lobu", platformUserId: workspace.users.owner.id, userId: workspace.users.owner.id },
		};
		return {
			params,
			invoke: (overrides: Partial<InvokeTemplateEventActionParams> = {}) => invokeTemplateEventAction({ ...params, ...overrides }),
			close: () => api.knowledge.save({ entity_ids: [entity.id], semantic_type: "replay.closed", content: "Closed", payload_type: "empty", supersedes_event_id: source.id }),
		};
	}

	it("replays an accepted result after its source is replaced, while rejecting new clicks", async () => {
		const f = await fixture();
		const accepted = await f.invoke();
		await f.close();
		await expect(f.invoke()).resolves.toEqual({ ...accepted, created: false });
		await expect(f.invoke({ interactionId: "fresh-click" })).rejects.toMatchObject({ httpStatus: 409 });
		const rows = await getTestDb()`SELECT id FROM events WHERE organization_id = ${f.params.organizationId} AND semantic_type = 'replay.chosen'`;
		expect(rows).toHaveLength(1);
	});

	it.each(["threadId", "connectionId", "messageId"])("replays an exact retry with an empty-string %s", async (field) => {
		const source = field === "threadId"
			? { connectionId: "synthetic-connection", messageId: "synthetic-message", threadId: "" }
			: { [field]: "" };
		const f = await fixture(field === "threadId" ? { delivery: [source] } : {});
		const invocation = {
			source, surface: field === "threadId" ? "slack" : "web",
			actor: field === "threadId" ? { platform: "slack", platformUserId: "synthetic-chat-actor" } : f.params.actor,
		};
		const accepted = await f.invoke(invocation);
		expect(accepted.created).toBe(true);
		await expect(f.invoke(invocation)).resolves.toEqual({ ...accepted, created: false });
		await f.close();
		await expect(f.invoke(invocation)).resolves.toEqual({ ...accepted, created: false });
		const rows = await getTestDb()`SELECT id FROM events WHERE organization_id = ${f.params.organizationId} AND semantic_type = 'replay.chosen'`;
		expect(rows).toHaveLength(1);
		expect(Number(rows[0].id)).toBe(accepted.eventId);
	});

	it.each(["value", "actor", "delivery"])("rejects reuse of an accepted id with a different %s", async (field) => {
		const f = await fixture();
		await f.invoke();
		const changed: Partial<InvokeTemplateEventActionParams> = field === "value" ? { value: "B" }
			: field === "actor" ? { actor: { platform: "lobu", platformUserId: "synthetic-other-actor" } }
			: { source: { connectionId: "synthetic-connection", messageId: "synthetic-message" } };
		await expect(f.invoke(changed)).rejects.toMatchObject({ httpStatus: 409 });
		await f.close();
		await expect(f.invoke(changed)).rejects.toMatchObject({ httpStatus: 409 });
	});

	it("converges concurrent exact retries to one durable event", async () => {
		const f = await fixture();
		const results = await Promise.all(Array.from({ length: 8 }, () => f.invoke()));
		expect(new Set(results.map((result) => result.eventId)).size).toBe(1);
		expect(results.filter((result) => result.created)).toHaveLength(1);
	});

	it("rejects the losing payload when conflicting clicks race for the same id", async () => {
		const f = await fixture();
		const results = await Promise.allSettled([f.invoke(), f.invoke({ value: "B" })]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected).toMatchObject({ status: "rejected", reason: { httpStatus: 409 } });
		const rows = await getTestDb()`SELECT id FROM events WHERE organization_id = ${f.params.organizationId} AND semantic_type = 'replay.chosen'`;
		expect(rows).toHaveLength(1);
	});

	it("reconciles retries from separate server processes using shared Postgres", async () => {
		const f = await fixture();
		const script = `
import { invokeTemplateEventAction } from './src/interactions/template-event-actions.ts';
import { closeDbSingleton } from './src/db/client.ts';
const result = await invokeTemplateEventAction(JSON.parse(process.env.REPLAY_TEST_INPUT));
console.log('REPLAY_RESULT=' + JSON.stringify(result));
await closeDbSingleton();
process.exit(0);`;
		const invokeProcess = async () => {
			const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
				cwd: process.cwd(), env: { ...process.env, REPLAY_TEST_INPUT: JSON.stringify(f.params) }, timeout: 20_000,
			});
			const line = stdout.split("\n").find((entry) => entry.startsWith("REPLAY_RESULT="));
			expect(line).toBeDefined();
			return JSON.parse(line!.slice("REPLAY_RESULT=".length));
		};
		const results = await Promise.all([invokeProcess(), invokeProcess()]);
		expect(new Set(results.map((result) => result.eventId)).size).toBe(1);
		expect(results.filter((result) => result.created)).toHaveLength(1);
		await f.close();
		await expect(invokeProcess()).resolves.toEqual({ ...results[0], created: false });
	}, 60_000);
});
