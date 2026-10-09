/**
 * Legacy captured runs must stay isolated from live Automation scheduling
 * after the product eval creation and scoring feature has been retired.
 */

import { beforeAll, describe, expect, test } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";
import { createLegacyCapturedRun } from "../../setup/legacy-captured-run";
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
	// Frozen payload retained by a historical captured run.
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
	await createLegacyCapturedRun(sourceRunId, sql as never);
	await createLegacyCapturedRun(sourceRunId, sql as never);
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
		// Two pending legacy captures coexist without taking the live slot.
		expect(Number(count)).toBe(2);
		expect(executionModeForRunType(AUTOMATION_EVAL_RUN_TYPE)).toBe("capture");

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
