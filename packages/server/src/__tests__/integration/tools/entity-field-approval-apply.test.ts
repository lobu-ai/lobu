/**
 * Applying an approved proposal writes metadata, field ownership, and the
 * reserved $-attributes through the entity write funnel instead of raw SQL.
 *
 * The attribute write patches only name/parent_id/content, so `slug` is
 * asserted unchanged: the funnel kernel can also write slug, and an approved
 * rename must not start re-slugging the row as a side effect.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyEntityFieldChangeProposal } from "../../../tools/admin/entity-field-approval";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

describe("approved entity field application", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("applies approved metadata and attributes through one transaction", async () => {
		const sql = getTestDb();
		const organization = await createTestOrganization({
			name: "Approved entity write",
		});
		const approver = await createTestUser();
		const parent = await createTestEntity({
			name: "Approved parent",
			organization_id: organization.id,
			created_by: approver.id,
		});
		const entity = await createTestEntity({
			name: "Original name",
			organization_id: organization.id,
			created_by: approver.id,
		});
		await sql`
			UPDATE entities
			SET metadata = ${sql.json({ status: "pending" })}, content = 'draft'
			WHERE id = ${entity.id}
		`;

		const result = await applyEntityFieldChangeProposal(
			{
				entity_id: entity.id,
				fields: {
					status: "approved",
					$name: "Approved name",
					$parent_id: parent.id,
					$content: null,
				},
				current: {
					status: "pending",
					$name: "Original name",
					$parent_id: null,
					$content: "draft",
				},
				reason: "Human approved the proposed entity changes",
			},
			{ userId: approver.id },
		);

		expect(Object.keys(result.applied).sort()).toEqual([
			"$content",
			"$name",
			"$parent_id",
			"status",
		]);
		const [row] = await sql<{
			name: string;
			slug: string;
			parent_id: number;
			content: string | null;
			metadata: Record<string, unknown>;
			field_controls: Record<string, { set_by?: string | null }>;
		}>`
			SELECT name, slug, parent_id, content, metadata, field_controls
			FROM entities
			WHERE id = ${entity.id}
		`;
		expect(row).toMatchObject({
			name: "Approved name",
			slug: "original-name",
			parent_id: parent.id,
			content: null,
			metadata: { status: "approved" },
		});
		expect(row.field_controls.status?.set_by).toBe(approver.id);
	});
});
