import { beforeEach, describe, expect, it } from "vitest";
import {
	createTestOrganization,
	createTestUser,
} from "../../__tests__/setup/test-fixtures";
import {
	cleanupTestDatabase,
	getTestDb,
} from "../../__tests__/setup/test-db";
import {
	hardDeleteEntityRows,
	insertEntityRow,
	patchEntityRows,
	tryInsertEntityRow,
	withEntityWriteTransaction,
} from "../entity-management";

async function seedEntityType(organizationId: string): Promise<number> {
	const sql = getTestDb();
	const rows = await sql<{ id: number }>`
		INSERT INTO entity_types (
			organization_id, slug, name, created_at, updated_at
		) VALUES (
			${organizationId}, 'kernel-test', 'Kernel test',
			current_timestamp, current_timestamp
		)
		RETURNING id
	`;
	return Number(rows[0].id);
}

describe("entity row write kernel", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("participates in the caller transaction for insert, patch, and delete", async () => {
		const sql = getTestDb();
		const organization = await createTestOrganization({
			name: "Entity kernel rollback",
		});
		const user = await createTestUser();
		const entityTypeId = await seedEntityType(organization.id);
		const existing = await insertEntityRow({
			tx: sql,
			row: {
				organizationId: organization.id,
				entityTypeId,
				name: "Existing",
				slug: "existing",
				createdBy: user.id,
			},
		});

		await expect(
			sql.begin(async (tx) => {
				await insertEntityRow({
					tx,
					row: {
						organizationId: organization.id,
						entityTypeId,
						name: "Rolled back",
						slug: "rolled-back",
						createdBy: user.id,
					},
				});
				await patchEntityRows({
					tx,
					ids: [existing.id],
					patch: { name: "Also rolled back" },
				});
				await hardDeleteEntityRows({ tx, ids: [existing.id] });
				throw new Error("rollback sentinel");
			}),
		).rejects.toThrow("rollback sentinel");

		const rows = await sql<{ name: string }>`
			SELECT name FROM entities
			WHERE organization_id = ${organization.id}
			ORDER BY id
		`;
		expect(rows).toEqual([{ name: "Existing" }]);
	});

	it("opens a transaction for a pool and joins an existing transaction", async () => {
		const sql = getTestDb();
		const organization = await createTestOrganization({
			name: "Entity kernel transaction boundary",
		});
		const user = await createTestUser();
		const entityTypeId = await seedEntityType(organization.id);

		// Captured rather than asserted inside the callback: an assertion that
		// throws in there is swallowed by the rejects matcher below and reports
		// as the wrong failure.
		let pooledSavepoint: unknown;
		await expect(
			withEntityWriteTransaction(sql, async (tx) => {
				pooledSavepoint = tx.savepoint;
				await insertEntityRow({
					tx,
					row: {
						organizationId: organization.id,
						entityTypeId,
						name: "Rolled back by wrapper",
						slug: "rolled-back-by-wrapper",
						createdBy: user.id,
					},
				});
				throw new Error("wrapper rollback sentinel");
			}),
		).rejects.toThrow("wrapper rollback sentinel");
		expect(typeof pooledSavepoint).toBe("function");

		const afterRollback = await sql<{ count: number }>`
			SELECT count(*)::int AS count
			FROM entities
			WHERE organization_id = ${organization.id}
		`;
		expect(afterRollback[0].count).toBe(0);

		await sql.begin(async (outerTx) => {
			const value = await withEntityWriteTransaction(outerTx, async (innerTx) => {
				expect(innerTx).toBe(outerTx);
				return 42;
			});
			expect(value).toBe(42);
		});
	});

	it("distinguishes omitted fields from explicit nulls", async () => {
		const sql = getTestDb();
		const organization = await createTestOrganization({
			name: "Entity kernel patch",
		});
		const user = await createTestUser();
		const entityTypeId = await seedEntityType(organization.id);
		const entity = await insertEntityRow({
			tx: sql,
			row: {
				organizationId: organization.id,
				entityTypeId,
				name: "Keep me",
				slug: "keep-me",
				content: "clear me",
				metadata: { old: true },
				createdBy: user.id,
			},
		});

		const changed = await patchEntityRows({
			tx: sql,
			ids: [entity.id],
			patch: {
				content: null,
				metadata: { current: true },
			},
		});

		expect(changed).toEqual([entity.id]);
		const rows = await sql<{
			name: string;
			content: string | null;
			metadata: Record<string, unknown>;
		}>`
			SELECT name, content, metadata
			FROM entities
			WHERE id = ${entity.id}
		`;
		expect(rows[0]).toEqual({
			name: "Keep me",
			content: null,
			metadata: { current: true },
		});
	});

	it("returns null without changing the existing row on an insert conflict", async () => {
		const sql = getTestDb();
		const organization = await createTestOrganization({
			name: "Entity kernel conflict",
		});
		const user = await createTestUser();
		const entityTypeId = await seedEntityType(organization.id);
		const existing = await insertEntityRow({
			tx: sql,
			row: {
				organizationId: organization.id,
				entityTypeId,
				name: "Existing",
				slug: "same-slug",
				createdBy: user.id,
			},
		});

		const conflicted = await tryInsertEntityRow({
			tx: sql,
			row: {
				organizationId: organization.id,
				entityTypeId,
				name: "Conflicting",
				slug: "same-slug",
				createdBy: user.id,
			},
		});

		expect(conflicted).toBeNull();
		const rows = await sql<{ id: number; name: string }>`
			SELECT id, name
			FROM entities
			WHERE organization_id = ${organization.id}
		`;
		expect(rows).toEqual([{ id: existing.id, name: "Existing" }]);
	});

	it("stamps a tombstone once and then skips the row", async () => {
		const sql = getTestDb();
		const organization = await createTestOrganization({
			name: "Entity kernel tombstone",
		});
		const user = await createTestUser();
		const entityTypeId = await seedEntityType(organization.id);
		const entity = await insertEntityRow({
			tx: sql,
			row: {
				organizationId: organization.id,
				entityTypeId,
				name: "Delete me",
				slug: "delete-me",
				createdBy: user.id,
			},
		});

		expect(
			await patchEntityRows({
				tx: sql,
				ids: [entity.id],
				patch: { softDelete: true },
			}),
		).toEqual([entity.id]);
		const deletedAt = (
			await sql<{ deleted_at: Date | null }>`
				SELECT deleted_at FROM entities WHERE id = ${entity.id}
			`
		)[0].deleted_at;
		expect(deletedAt).not.toBeNull();

		// A tombstoned row is invisible to `patchEntityRows`: no further patch
		// lands on it, so an ordinary write can neither edit nor resurrect a
		// deleted entity.
		expect(
			await patchEntityRows({
				tx: sql,
				ids: [entity.id],
				patch: { name: "Edited after delete" },
			}),
		).toEqual([]);

		const rows = await sql<{ name: string; deleted_at: Date | null }>`
			SELECT name, deleted_at FROM entities WHERE id = ${entity.id}
		`;
		expect(rows[0].name).toBe("Delete me");
		expect(rows[0].deleted_at).toEqual(deletedAt);
	});

});
