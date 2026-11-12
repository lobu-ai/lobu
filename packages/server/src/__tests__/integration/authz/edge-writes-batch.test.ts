/** Contract for the shared batch edge writer. */

import { beforeEach, describe, expect, it } from "vitest";
import {
	ensureRelationshipType,
	upsertEdges,
} from "../../../utils/edge-writes";
import { RELATIONSHIP_CLAIMS_METADATA_KEY } from "../../../utils/relationship-claims";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestEntity,
	createTestOrganization,
} from "../../setup/test-fixtures";

const TYPE_SLUG = "batch_writer_probe";

async function liveEdges(orgId: string, typeId: number) {
	const sql = getTestDb();
	return sql<
		{
			id: number;
			source: string | null;
			metadata: Record<string, unknown> | null;
		}[]
	>`
    SELECT id, source, metadata
    FROM entity_relationships
    WHERE organization_id = ${orgId}
      AND relationship_type_id = ${typeId}
      AND deleted_at IS NULL
    ORDER BY from_entity_id, to_entity_id
  `;
}

describe("upsertEdges", () => {
	let orgId: string;
	let typeId: number;
	let a: number;
	let b: number;
	let c: number;

	beforeEach(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Edge Writer Org" });
		orgId = org.id;
		const entity = (name: string) =>
			createTestEntity({ organization_id: orgId, entity_type: "thing", name });
		a = (await entity("A")).id;
		b = (await entity("B")).id;
		c = (await entity("C")).id;
		typeId = await ensureRelationshipType({
			organizationId: orgId,
			slug: TYPE_SLUG,
			name: "Batch writer probe",
			description: "Fixture type",
		});
	});

	it("survives two concurrent writers claiming the same pair", async () => {
		const call = () =>
			upsertEdges({
				db: getTestDb(),
				organizationId: orgId,
				relationshipTypeId: typeId,
				pairs: [{ fromEntityId: a, toEntityId: b }],
				source: "feed",
				confidence: 0.4,
				claimKey: "config:concurrent-writer",
				onConflict: "ignore",
			});

		// Both run against the same live-triple index at once. Without a conflict
		// clause one of these raises 23505.
		const [first, second] = await Promise.all([call(), call()]);

		expect(first.length + second.length).toBe(1);
		expect(await liveEdges(orgId, typeId)).toHaveLength(1);
	});

	it("locks overlapping batches in one global pair order", async () => {
		const sql = getTestDb();
		const pairs = [
			{ fromEntityId: a, toEntityId: b },
			{ fromEntityId: a, toEntityId: c },
		];
		await upsertEdges({
			db: sql,
			organizationId: orgId,
			relationshipTypeId: typeId,
			pairs,
			source: "feed",
			claimKey: "config:seed-writer",
			onConflict: "ignore",
		});
		await sql.unsafe(`
			CREATE OR REPLACE FUNCTION test_pause_edge_batch_update()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				PERFORM pg_sleep(0.5);
				RETURN NEW;
			END
			$$
		`);
		await sql.unsafe(`
			CREATE TRIGGER test_pause_edge_batch_update
			BEFORE UPDATE ON entity_relationships
			FOR EACH ROW
			EXECUTE FUNCTION test_pause_edge_batch_update()
		`);

		try {
			await Promise.all([
				upsertEdges({
					db: sql,
					organizationId: orgId,
					relationshipTypeId: typeId,
					pairs,
					source: "feed",
					claimKey: "config:ordered-writer-a",
					onConflict: "ignore",
				}),
				upsertEdges({
					db: sql,
					organizationId: orgId,
					relationshipTypeId: typeId,
					pairs: [...pairs].reverse(),
					source: "feed",
					claimKey: "config:ordered-writer-b",
					onConflict: "ignore",
				}),
			]);
		} finally {
			await sql.unsafe(`
				DROP TRIGGER IF EXISTS test_pause_edge_batch_update
				ON entity_relationships
			`);
			await sql.unsafe(`DROP FUNCTION IF EXISTS test_pause_edge_batch_update()`);
		}

		const rows = await liveEdges(orgId, typeId);
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.metadata?.[RELATIONSHIP_CLAIMS_METADATA_KEY]).toEqual({
				"config:seed-writer": {},
				"config:ordered-writer-a": {},
				"config:ordered-writer-b": {},
			});
		}
	});

	it("writes a batch and reports what it created", async () => {
		const result = await upsertEdges({
			db: getTestDb(),
			organizationId: orgId,
			relationshipTypeId: typeId,
			pairs: [
				{ fromEntityId: a, toEntityId: b },
				{ fromEntityId: a, toEntityId: c },
			],
			source: "feed",
			confidence: 1.0,
			claimKey: "config:batch-writer",
			onConflict: "ignore",
		});

		expect(result).toHaveLength(2);
		expect(await liveEdges(orgId, typeId)).toHaveLength(2);
	});

	it("reports no new rows on a re-run", async () => {
		const params = {
			db: getTestDb(),
			organizationId: orgId,
			relationshipTypeId: typeId,
			pairs: [{ fromEntityId: a, toEntityId: b }],
			source: "feed",
			confidence: 1.0,
			claimKey: "config:rerun-writer",
			onConflict: "ignore" as const,
		};
		await upsertEdges(params);
		const again = await upsertEdges(params);

		expect(again).toHaveLength(0);
		expect(await liveEdges(orgId, typeId)).toHaveLength(1);
	});

	it("dedupes within one batch so DO UPDATE cannot hit a row twice", async () => {
		// `ON CONFLICT DO UPDATE` refuses to affect the same row twice in one
		// statement, so an un-deduped batch would raise 21000 here.
		const result = await upsertEdges({
			db: getTestDb(),
			organizationId: orgId,
			relationshipTypeId: typeId,
			pairs: [
				{ fromEntityId: a, toEntityId: b },
				{ fromEntityId: a, toEntityId: b },
			],
			source: "config",
			confidence: 1.0,
			metadata: { connection_id: "conn-1" },
			claimKey: "config:dedupe-writer",
			onConflict: "update",
		});

		expect(result).toHaveLength(1);
		expect(await liveEdges(orgId, typeId)).toHaveLength(1);
	});

	it("refreshes metadata and source on update, and leaves them alone on ignore", async () => {
		const base = {
			db: getTestDb(),
			organizationId: orgId,
			relationshipTypeId: typeId,
			pairs: [{ fromEntityId: a, toEntityId: b }],
			confidence: 1.0,
		};
		await upsertEdges({
			...base,
			source: "config",
			metadata: { connection_id: "conn-1" },
			claimKey: "config:first-writer",
			onConflict: "update",
		});

		await upsertEdges({
			...base,
			source: "manual",
			metadata: { connection_id: "conn-2" },
			claimKey: "config:second-writer",
			onConflict: "update",
		});
		let rows = await liveEdges(orgId, typeId);
		expect(rows[0].source).toBe("manual");
		expect(rows[0].metadata).toMatchObject({ connection_id: "conn-2" });
		expect(rows[0].metadata[RELATIONSHIP_CLAIMS_METADATA_KEY]).toEqual({
			"config:first-writer": {},
			"config:second-writer": {},
		});

		await upsertEdges({
			...base,
			source: "feed",
			metadata: { connection_id: "conn-3" },
			claimKey: "config:ignored-writer",
			onConflict: "ignore",
		});
		rows = await liveEdges(orgId, typeId);
		expect(rows[0].source).toBe("manual");
		expect(rows[0].metadata).toMatchObject({ connection_id: "conn-2" });
		expect(rows[0].metadata[RELATIONSHIP_CLAIMS_METADATA_KEY]).toEqual({
			"config:first-writer": {},
			"config:second-writer": {},
			"config:ignored-writer": {},
		});
	});

	it("drops a self-edge without failing the rest of the batch", async () => {
		const created = await upsertEdges({
			db: getTestDb(),
			organizationId: orgId,
			relationshipTypeId: typeId,
			pairs: [
				{ fromEntityId: a, toEntityId: a },
				{ fromEntityId: a, toEntityId: b },
			],
			source: "feed",
			confidence: 1.0,
			claimKey: "config:self-edge-writer",
			onConflict: "ignore",
		});

		expect(created).toHaveLength(1);
		expect(await liveEdges(orgId, typeId)).toHaveLength(1);
	});

	it("writes a fresh live row beside a tombstone rather than reviving it", async () => {
		const sql = getTestDb();
		const params = {
			db: sql,
			organizationId: orgId,
			relationshipTypeId: typeId,
			pairs: [{ fromEntityId: a, toEntityId: b }],
			source: "config",
			confidence: 1.0,
			metadata: { connection_id: "conn-1" },
			claimKey: "config:tombstone-writer",
			onConflict: "update" as const,
		};
		const first = await upsertEdges(params);
		await sql`
      UPDATE entity_relationships
      SET deleted_at = current_timestamp
      WHERE id = ${first[0]}
    `;

		// The conflict target is the PARTIAL live-triple index, so a tombstoned
		// row is not a conflict at all and cannot be revived by the update branch.
		const second = await upsertEdges(params);
		expect(second).toHaveLength(1);
		expect(second[0]).not.toBe(first[0]);
		expect(await liveEdges(orgId, typeId)).toHaveLength(1);
	});
});
