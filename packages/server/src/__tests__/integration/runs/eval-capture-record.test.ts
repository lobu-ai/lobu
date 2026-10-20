/**
 * The capture guard's RECORD, not just its suppression.
 *
 * PR 2 proved in prod that a capture run performs no side effects. What it did
 * not do was keep them: `captureSideEffect` logged and returned, so eight of
 * the nine capture points left nothing a score could ever be computed from.
 * These tests pin the durable half.
 */

import type { Context } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import {
	MAX_CAPTURED_DETAIL_CHARS,
	MAX_CAPTURED_SIDE_EFFECTS,
	captureSideEffect,
} from "../../../gateway/routes/internal/capture-mode";
import type { WorkerContext } from "../../../gateway/routes/internal/types";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const sql = getTestDb();

let organizationId: string;
let automationId: number;
let evalRunId: number;
let liveRunId: number;

/**
 * A worker context carrying only what the guard reads: the verified token and
 * `c.json`. Building the real Hono context would exercise the router, not the
 * guard — and the guard is the thing under test.
 */
function ctx(worker: {
	executionMode?: "live" | "capture";
	automationRunId?: number;
}): Context<WorkerContext> {
	return {
		get: (key: string) =>
			key === "worker"
				? { agentId: "a", organizationId, conversationId: "c", ...worker }
				: undefined,
		json: (body: unknown) =>
			new Response(JSON.stringify(body), {
				headers: { "content-type": "application/json" },
			}),
	} as unknown as Context<WorkerContext>;
}

async function sideEffectsOf(runId: number): Promise<{
	entries: Array<{ action: string; details: Record<string, unknown> }>;
	truncated: boolean | null;
	dryRun: boolean;
}> {
	const [row] = await sql<
		{
			side_effects: Array<{
				action: string;
				details: Record<string, unknown>;
			}> | null;
			truncated: boolean | null;
			dry_run: boolean;
		}[]
	>`
    SELECT dry_run_preview->'side_effects' AS side_effects,
           (dry_run_preview->>'side_effects_truncated')::boolean AS truncated,
           dry_run
    FROM runs WHERE id = ${runId}
  `;
	return {
		entries: row?.side_effects ?? [],
		truncated: row?.truncated ?? null,
		dryRun: row?.dry_run ?? false,
	};
}

async function seedRun(runType: string): Promise<number> {
	const [run] = await sql<{ id: number }[]>`
    INSERT INTO runs (
      organization_id, run_type, automation_id, approval_status, status, created_at
    ) VALUES (
      ${organizationId}, ${runType}, ${automationId}, 'auto', 'running', current_timestamp
    )
    RETURNING id
  `;
	return Number(run.id);
}

beforeAll(async () => {
	await cleanupTestDatabase();
	const org = await createTestOrganization();
	organizationId = org.id;
	const creator = await createTestUser();

	const [automation] = (await sql`
    WITH next_id AS (SELECT nextval('automations_id_seq')::integer AS id)
    INSERT INTO automations (
      id, automation_group_id, organization_id, created_by, name, slug, schedule, status
    )
    SELECT id, id, ${organizationId}, ${creator.id}, 'Capture Source', 'capture-src', '0 * * * *', 'active'
    FROM next_id
    RETURNING id
  `) as unknown as Array<{ id: number }>;
	automationId = Number(automation.id);

	evalRunId = await seedRun("automation_eval");
	liveRunId = await seedRun("automation");
});

describe("captureSideEffect — suppression", () => {
	test("a live run is not intercepted at all", async () => {
		const result = await captureSideEffect(
			ctx({ automationRunId: liveRunId }),
			"conversations.send",
			{ text: "this really sends" },
		);
		// null means "proceed for real" — the route goes on to do its work.
		expect(result).toBe(null);
		expect((await sideEffectsOf(liveRunId)).entries).toHaveLength(0);
	});

	test("a capture run is intercepted and answered success-shaped", async () => {
		const result = await captureSideEffect(
			ctx({ executionMode: "capture", automationRunId: evalRunId }),
			"conversations.send",
			{ text: "hello" },
		);
		expect(result).not.toBe(null);
		// A capture run that got an error back would measure its own retry logic.
		expect(result?.status).toBe(200);
		expect(await result?.json()).toMatchObject({ success: true, captured: true });
	});
});

describe("captureSideEffect — the record", () => {
	test("records the action and its payload on the eval run", async () => {
		const { entries, dryRun } = await sideEffectsOf(evalRunId);
		expect(dryRun).toBe(true);
		expect(entries).toHaveLength(1);
		expect(entries[0].action).toBe("conversations.send");
		expect(entries[0].details).toEqual({ text: "hello" });
	});

	test("appends rather than overwriting, preserving order", async () => {
		await captureSideEffect(
			ctx({ executionMode: "capture", automationRunId: evalRunId }),
			"images.generate",
			{ prompt: "a cat" },
		);
		const { entries } = await sideEffectsOf(evalRunId);
		expect(entries.map((e) => e.action)).toEqual([
			"conversations.send",
			"images.generate",
		]);
	});

	test("every capture point routes through the same record", async () => {
		// The internal-route call sites differ only by these labels. Together with
		// conversations.send and images.generate above, this covers all seven; if
		// the record only worked for one shape, this would catch it.
		const actions = [
			"interactions.create",
			"files.upload",
			"files.upload_batch",
			"audio.synthesize",
			"runtime.exec",
		];
		const run = await seedRun("automation_eval");
		for (const action of actions) {
			await captureSideEffect(
				ctx({ executionMode: "capture", automationRunId: run }),
				action,
				{ label: action },
			);
		}
		const { entries } = await sideEffectsOf(run);
		expect(entries.map((e) => e.action)).toEqual(actions);
	});

	test("a capture claim cannot stamp a live Automation run", async () => {
		// The token is signed, but defence is in the WHERE clause: even pointed at
		// a live run, the record must not land — while suppression still happens,
		// because performing the side effect is the one unacceptable outcome.
		const result = await captureSideEffect(
			ctx({ executionMode: "capture", automationRunId: liveRunId }),
			"conversations.send",
			{ text: "must not be recorded here" },
		);
		expect(result).not.toBe(null);
		const { entries, dryRun } = await sideEffectsOf(liveRunId);
		expect(entries).toHaveLength(0);
		expect(dryRun).toBe(false);
	});

	test("a token with no automationRunId still suppresses", async () => {
		// Losing the record degrades scoring; performing the side effect would
		// break the guarantee. The guard must not throw its way out of suppressing.
		const result = await captureSideEffect(
			ctx({ executionMode: "capture" }),
			"conversations.send",
			{ text: "unaddressed" },
		);
		expect(result).not.toBe(null);
		expect(await result?.json()).toMatchObject({ captured: true });
	});

	test("the record is capped and says so", async () => {
		const run = await seedRun("automation_eval");
		for (let i = 0; i < MAX_CAPTURED_SIDE_EFFECTS + 3; i++) {
			await captureSideEffect(
				ctx({ executionMode: "capture", automationRunId: run }),
				"conversations.send",
				{ i },
			);
		}
		const { entries, truncated } = await sideEffectsOf(run);
		expect(entries).toHaveLength(MAX_CAPTURED_SIDE_EFFECTS);
		expect(truncated).toBe(true);
		// The cap keeps the FIRST calls, which are the ones a score reads.
		expect(entries[0].details).toEqual({ i: 0 });
	});

	test("an uncapped record is not falsely marked truncated", async () => {
		const run = await seedRun("automation_eval");
		await captureSideEffect(
			ctx({ executionMode: "capture", automationRunId: run }),
			"files.upload",
			{ name: "x.txt" },
		);
		expect((await sideEffectsOf(run)).truncated).toBe(false);
	});

	test("an oversized payload is bounded, not stored whole", async () => {
		// The entry cap bounds how many effects are recorded, not how big each is.
		// A single agent-authored message body is what actually bloats the column.
		const run = await seedRun("automation_eval");
		const huge = "x".repeat(MAX_CAPTURED_DETAIL_CHARS * 3);
		await captureSideEffect(
			ctx({ executionMode: "capture", automationRunId: run }),
			"conversations.send",
			{ text: huge },
		);
		const [entry] = (await sideEffectsOf(run)).entries;
		expect(entry.details.details_truncated).toBe(true);
		expect(entry.details.text).toBeUndefined();
		expect(
			(entry.details.details_preview as string).length,
		).toBeLessThanOrEqual(MAX_CAPTURED_DETAIL_CHARS);
	});

	test("a payload under the size cap is stored verbatim", async () => {
		const run = await seedRun("automation_eval");
		await captureSideEffect(
			ctx({ executionMode: "capture", automationRunId: run }),
			"runtime.exec",
			{ command: "ls -la" },
		);
		const [entry] = (await sideEffectsOf(run)).entries;
		expect(entry.details).toEqual({ command: "ls -la" });
	});
});
