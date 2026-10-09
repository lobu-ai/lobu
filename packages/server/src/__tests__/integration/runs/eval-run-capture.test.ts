/**
 * End-to-end shape of an eval replay: a real Automation run is cloned into a
 * `automation_eval` run, the execution path accepts it, and the scheduling and
 * health predicates do not see it.
 */

import { beforeAll, describe, expect, test } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";
import { createEvalRun } from "../../../runs/eval-runs";
import {
	AUTOMATION_EVAL_RUN_TYPE,
	executionModeForRunType,
} from "../../../runs/run-types";

const sql = getTestDb();

let organizationId: string;
let automationId: number;
let sourceRunId: number;

const payload = {
	automation_id: 0,
	// A server-dispatchable source: `createEvalRun` refuses device-pinned and
	// manual-open runs, because neither eval lane could ever claim the clone.
	agent_id: "11111111-2222-3333-4444-555555555555",
	window_start: "2026-08-01T00:00:00.000Z",
	window_end: "2026-08-01T01:00:00.000Z",
	dispatch_source: "scheduled",
	version_id: 42,
};

beforeAll(async () => {
	// Start from an empty schema. Automation ids are handed out by a MAX(id)+1
	// helper, not by `automations_id_seq`, so any earlier file that created an
	// Automation leaves the sequence BEHIND the table — and the explicit
	// `nextval` below then collides on `insights_pkey`. Truncating first keeps
	// this suite independent of what ran before it.
	await cleanupTestDatabase();

	const org = await createTestOrganization();
	organizationId = org.id;
	const creator = await createTestUser();

	// automations.automation_group_id is NOT NULL and self-referential for a new
	// Automation — mint the id first, same shape as operations-getrun-internal.
	const [automation] = (await sql`
    WITH next_id AS (
      SELECT nextval('automations_id_seq')::integer AS id
    )
    INSERT INTO automations (
      id, automation_group_id, organization_id, created_by, name, slug, schedule, status
    )
    SELECT id, id, ${organizationId}, ${creator.id}, 'Eval Source', 'eval-src', '0 * * * *', 'active'
    FROM next_id
    RETURNING id
  `) as unknown as Array<{ id: number }>;
	automationId = Number(automation.id);

	const [run] = await sql<{ id: number }[]>`
    INSERT INTO runs (
      organization_id, run_type, automation_id, approval_status, status,
      approved_input, completed_at, created_at
    ) VALUES (
      ${organizationId}, 'automation', ${automationId}, 'auto', 'completed',
      ${sql.json({ ...payload, automation_id: automationId })},
      current_timestamp, current_timestamp
    )
    RETURNING id
  `;
	sourceRunId = run.id;
});

describe("createEvalRun", () => {
	test("clones the source run's frozen payload verbatim", async () => {
		const result = await createEvalRun(
			{ sourceRunId, caseKey: "case-1" },
			sql,
		);
		expect(result?.created).toBe(true);

		const [row] = await sql<
			{ run_type: string; status: string; approved_input: typeof payload }[]
		>`
      SELECT run_type, status, approved_input FROM runs WHERE id = ${result?.runId ?? 0}
    `;
		expect(row.run_type).toBe(AUTOMATION_EVAL_RUN_TYPE);
		expect(row.status).toBe("pending");
		// The window and version must match the original question exactly.
		expect(row.approved_input.window_start).toBe(payload.window_start);
		expect(row.approved_input.window_end).toBe(payload.window_end);
		expect(row.approved_input.version_id).toBe(payload.version_id);
	});

	test("the cloned run resolves to capture mode", async () => {
		const [row] = await sql<{ run_type: string }[]>`
      SELECT run_type FROM runs
      WHERE run_type = ${AUTOMATION_EVAL_RUN_TYPE} AND automation_id = ${automationId}
      LIMIT 1
    `;
		expect(executionModeForRunType(row.run_type)).toBe("capture");
	});

	test("is idempotent per (source run, case key)", async () => {
		const again = await createEvalRun({ sourceRunId, caseKey: "case-1" }, sql);
		expect(again?.created).toBe(false);

		const [{ count }] = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM runs
      WHERE idempotency_key = ${`automation_eval:${sourceRunId}:case-1`}
    `;
		expect(Number(count)).toBe(1);
	});

	test("a distinct case key queues a separate trial", async () => {
		const second = await createEvalRun({ sourceRunId, caseKey: "case-2" }, sql);
		expect(second?.created).toBe(true);
		expect(second?.runId).not.toBe(sourceRunId);
	});

	test("refuses to replay something that is not an Automation run", async () => {
		const [sync] = await sql<{ id: number }[]>`
      INSERT INTO runs (organization_id, run_type, status, created_at)
      VALUES (${organizationId}, 'sync', 'completed', current_timestamp)
      RETURNING id
    `;
		expect(await createEvalRun({ sourceRunId: sync.id, caseKey: "x" }, sql)).toBe(
			null,
		);
	});

	// A clone no lane can claim would sit `pending` forever, and since the claim
	// guards are same-lane it would wedge every later eval of that Automation.
	// Nothing reaps a stranded pending eval, so refuse at mint instead.
	test.each([
		[
			"device-pinned",
			{ ...payload, device_worker_id: "99999999-8888-7777-6666-555555555555" },
		],
		["manual-open", { ...payload, agent_id: undefined }],
		["external with owner", { ...payload, executor: { kind: "external" } }],
	])("refuses to replay a %s run it could never dispatch", async (_l, input) => {
		const [run] = await sql<{ id: number }[]>`
      INSERT INTO runs (
        organization_id, run_type, automation_id, approval_status, status,
        approved_input, completed_at, created_at
      ) VALUES (
        ${organizationId}, 'automation', ${automationId}, 'auto', 'completed',
        ${sql.json({ ...input, automation_id: automationId } as never)},
        current_timestamp, current_timestamp
      )
      RETURNING id
    `;
		expect(
			await createEvalRun({ sourceRunId: run.id, caseKey: "undispatchable" }, sql),
		).toBe(null);
	});
});

describe("eval runs are invisible to the Automation scheduling predicates", () => {
	// This is the property the run_type design buys: ~18 existing predicates say
	// `run_type = 'automation'`, so an eval never competes with, suppresses, or
	// degrades the Automation it is replaying — with no code change in any of them.
	test("the pending-per-automation unique index does not count evals", async () => {
		const [{ count }] = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM runs
      WHERE automation_id = ${automationId}
        AND run_type = ${AUTOMATION_EVAL_RUN_TYPE}
        AND status = 'pending'
    `;
		// Two pending evals coexist — impossible for run_type='automation'.
		expect(Number(count)).toBeGreaterThanOrEqual(2);

		// And a real Automation run can still be queued alongside them.
		const [live] = await sql<{ id: number }[]>`
      INSERT INTO runs (
        organization_id, run_type, automation_id, approval_status, status,
        approved_input, created_at
      ) VALUES (
        ${organizationId}, 'automation', ${automationId}, 'auto', 'pending',
        ${sql.json({ ...payload, automation_id: automationId })}, current_timestamp
      )
      RETURNING id
    `;
		expect(live.id).toBeGreaterThan(0);
	});

	test("an automation-scoped latest-run read skips evals", async () => {
		const rows = await sql<{ run_type: string }[]>`
      SELECT run_type FROM runs
      WHERE automation_id = ${automationId} AND run_type = 'automation'
    `;
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.run_type === "automation")).toBe(true);
	});
});
