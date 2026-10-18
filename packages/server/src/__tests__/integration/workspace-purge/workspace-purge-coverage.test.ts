/**
 * Guard against orphaned rows after a workspace delete.
 *
 * Every table with an `organization_id` / `organizationId` column, read from
 * the live schema, must either be reached by `DELETE FROM organization` (an FK
 * on that column with ON DELETE CASCADE or SET NULL) or be in the purge task's
 * explicit list. A new org-scoped table with neither fails here instead of
 * leaking rows after every workspace delete.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { WORKSPACE_PURGE_TASK } from "../../../scheduled/task-definitions";
import {
  runWorkspacePurgeTask,
  WORKSPACE_PURGE_UNLINKED_TABLES,
} from "../../../workspace/purge";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestOrganization } from "../../setup/test-fixtures";

describe("workspace purge coverage", () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

	it("covers every org-scoped table", async () => {
		const sql = getTestDb();
		const rows = await sql<{ table_name: string; reached: boolean }[]>`
			SELECT c.table_name,
			       EXISTS (
			         SELECT 1
			         FROM pg_constraint con
			         JOIN pg_attribute a
			           ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
			         WHERE con.contype = 'f'
			           AND con.conrelid = format('public.%I', c.table_name)::regclass
			           AND con.confrelid = 'public.organization'::regclass
			           AND a.attname = c.column_name
			           AND con.confdeltype IN ('c', 'n')
			       ) AS reached
			FROM information_schema.columns c
			JOIN information_schema.tables t
			  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
			WHERE c.table_schema = 'public'
			  AND t.table_type = 'BASE TABLE'
			  AND c.column_name IN ('organization_id', 'organizationId')
			ORDER BY c.table_name
		`;
		// The schema has dozens of org-scoped tables; an empty read would make
		// this guard pass vacuously.
		expect(rows.length).toBeGreaterThan(20);

		const listed = new Set<string>(WORKSPACE_PURGE_UNLINKED_TABLES);
		const uncovered = rows
			.filter((row) => !row.reached && !listed.has(row.table_name))
			.map((row) => row.table_name);
		expect(uncovered).toEqual([]);

		// The explicit list must not drift either: every entry is a real
		// org-scoped table the organization delete does not already reach.
		const unreached = new Set(rows.filter((row) => !row.reached).map((row) => row.table_name));
		expect([...listed].filter((table) => !unreached.has(table))).toEqual([]);
	});

	it("purge removes the organization's namespace entry", async () => {
		// `namespace` carries no `organization_id` (it keys on `ref_id`), so
		// the schema guard above cannot see it. The purge deletes it
		// explicitly; this test proves the row goes with the workspace.
		const sql = getTestDb();
		const target = await createTestOrganization({ slug: "purge-ns-target" });
		const bystander = await createTestOrganization({ slug: "purge-ns-bystander" });
		await sql`
			INSERT INTO namespace (slug, type, ref_id)
			VALUES (${target.slug}, 'organization', ${target.id})
		`;
		await sql`
			INSERT INTO namespace (slug, type, ref_id)
			VALUES (${bystander.slug}, 'organization', ${bystander.id})
		`;
		await sql`
			UPDATE organization
			SET metadata = '{"deletion_requested_at": "2026-10-01T00:00:00.000Z"}'
			WHERE id = ${target.id}
		`;
		const [task] = await sql<{ id: number }[]>`
			INSERT INTO runs (run_type, queue_name, action_key, status, claimed_by, claimed_at)
			VALUES ('task', 'task:workspace-purge', ${WORKSPACE_PURGE_TASK}, 'claimed', 'holder', now())
			RETURNING id
		`;
		const counts = await runWorkspacePurgeTask(
			{ organizationId: target.id },
			{ taskRunId: task.id, claimedBy: "holder" },
		);
		expect(counts?.namespace).toBe(1);
		const remaining = await sql`
			SELECT slug FROM namespace WHERE type = 'organization' AND ref_id = ${target.id}
		`;
		expect(remaining).toHaveLength(0);
		const kept = await sql`
			SELECT slug FROM namespace WHERE type = 'organization' AND ref_id = ${bystander.id}
		`;
		expect(kept).toHaveLength(1);
	});
});
