/**
 * Guard against orphaned rows after a workspace delete.
 *
 * Every table with an `organization_id` / `organizationId` column, read from
 * the live schema, must either be reached by `DELETE FROM organization` (an FK
 * on that column with ON DELETE CASCADE or SET NULL) or be in the purge task's
 * explicit list. A new org-scoped table with neither fails here instead of
 * leaking rows after every workspace delete.
 */

import { describe, expect, it } from "vitest";
import { WORKSPACE_PURGE_UNLINKED_TABLES } from "../../../workspace/purge";
import { getTestDb } from "../../setup/test-db";

describe("workspace purge coverage", () => {
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
});
