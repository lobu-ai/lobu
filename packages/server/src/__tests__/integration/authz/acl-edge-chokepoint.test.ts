/**
 * The database-level chokepoint for authorization-bearing edges.
 *
 * Call-site checks are not enough because a new or overlooked SQL writer could
 * route around them. These cases cover every mutation shape plus the privileged
 * materializer.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemberOfType } from "../../../authz/access-graph";
import {
	withAclEdgeWrite,
	withAclPrivilege,
} from "../../../utils/relationship-validation";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestEntity,
	createTestOrganization,
} from "../../setup/test-fixtures";

describe("authorization edges have one enforcement point", () => {
	let orgId: string;
	let typeId: number;
	let alice: number;
	let bob: number;
	let channel: number;

	beforeEach(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Chokepoint Org" });
		orgId = org.id;
		typeId = await ensureMemberOfType(orgId);
		const mk = (type: string, name: string) =>
			createTestEntity({ organization_id: orgId, entity_type: type, name });
		alice = (await mk("person", "Alice")).id;
		bob = (await mk("person", "Bob")).id;
		channel = (await mk("channel", "#secrets")).id;
	});

	async function seedGrant(person: number): Promise<number> {
		return withAclEdgeWrite(getTestDb(), async (tx) => {
			const rows = await tx<{ id: number }[]>`
        INSERT INTO entity_relationships
          (organization_id, from_entity_id, to_entity_id, relationship_type_id,
           source, created_at, updated_at)
        VALUES (${orgId}, ${person}, ${channel}, ${typeId}, 'feed',
                current_timestamp, current_timestamp)
        RETURNING id
      `;
			return Number(rows[0].id);
		});
	}

	it("the ACL sync itself still works", async () => {
		const id = await seedGrant(alice);
		expect(id).toBeGreaterThan(0);
	});

	it("blocks a raw INSERT that impersonates the sync's own source value", async () => {
		// `source='feed'` is what the ACL syncs write AND is caller-settable, so
		// source can never carry this boundary. The flag can.
		const sql = getTestDb();
		await expect(
			sql`
        INSERT INTO entity_relationships
          (organization_id, from_entity_id, to_entity_id, relationship_type_id,
           source, created_at, updated_at)
        VALUES (${orgId}, ${bob}, ${channel}, ${typeId}, 'feed',
                current_timestamp, current_timestamp)
      `
		).rejects.toThrow(/authorization-bearing/);
	});

	it("blocks an unauthorized repoint", async () => {
		await seedGrant(alice);
		const sql = getTestDb();
		await expect(
			sql`
        UPDATE entity_relationships
        SET from_entity_id = ${bob}, updated_at = current_timestamp
        WHERE relationship_type_id = ${typeId} AND from_entity_id = ${alice}
      `
		).rejects.toThrow(/authorization-bearing/);
	});

	it("blocks an unauthorized tombstone", async () => {
		const id = await seedGrant(alice);
		const sql = getTestDb();
		await expect(
			sql`
        UPDATE entity_relationships
        SET deleted_at = current_timestamp
        WHERE id = ${id}
      `
		).rejects.toThrow(/authorization-bearing/);
	});

	it("blocks a hard DELETE that is not the ACL sync's own", async () => {
		const id = await seedGrant(alice);
		const sql = getTestDb();
		await expect(
			sql`DELETE FROM entity_relationships WHERE id = ${id}`
		).rejects.toThrow(/authorization-bearing/);
	});

	it("lets the sync tombstone its own edge when a member leaves", async () => {
		const id = await seedGrant(alice);
		await withAclEdgeWrite(getTestDb(), async (tx) => {
			await tx`
        UPDATE entity_relationships
        SET deleted_at = current_timestamp
        WHERE id = ${id}
      `;
		});
		const sql = getTestDb();
		const live = await sql`
      SELECT id FROM entity_relationships WHERE id = ${id} AND deleted_at IS NULL
    `;
		expect(live).toHaveLength(0);
	});

	it("does not touch ordinary domain edges", async () => {
		const sql = getTestDb();
		const t = await sql<{ id: number }[]>`
      INSERT INTO entity_relationship_types
        (slug, name, organization_id, created_at, updated_at)
      VALUES ('billed_to', 'Billed to', ${orgId}, current_timestamp, current_timestamp)
      RETURNING id
    `;
		const billedTo = Number(t[0].id);

		const edge = await sql<{ id: number }[]>`
      INSERT INTO entity_relationships
        (organization_id, from_entity_id, to_entity_id, relationship_type_id,
         source, created_at, updated_at)
      VALUES (${orgId}, ${alice}, ${channel}, ${billedTo}, 'feed',
              current_timestamp, current_timestamp)
      RETURNING id
    `;
		expect(edge).toHaveLength(1);

		// …and every mutation shape stays open on it.
		await sql`
      UPDATE entity_relationships SET confidence = 0.5 WHERE id = ${edge[0].id}
    `;
		await sql`DELETE FROM entity_relationships WHERE id = ${edge[0].id}`;
	});

	it("blocks moving an edge either onto or off an authorization type", async () => {
		const protectedEdgeId = await seedGrant(alice);
		const sql = getTestDb();
		const types = await sql<{ id: number }[]>`
      INSERT INTO entity_relationship_types
        (slug, name, organization_id, created_at, updated_at)
      VALUES ('ordinary', 'Ordinary', ${orgId}, current_timestamp, current_timestamp)
      RETURNING id
    `;
		const ordinaryTypeId = Number(types[0].id);
		const ordinaryEdges = await sql<{ id: number }[]>`
      INSERT INTO entity_relationships
        (organization_id, from_entity_id, to_entity_id, relationship_type_id,
         source, created_at, updated_at)
      VALUES (${orgId}, ${bob}, ${channel}, ${ordinaryTypeId}, 'api',
              current_timestamp, current_timestamp)
      RETURNING id
    `;

		await expect(
			sql`
        UPDATE entity_relationships
        SET relationship_type_id = ${ordinaryTypeId}
        WHERE id = ${protectedEdgeId}
      `,
		).rejects.toThrow(/authorization-bearing/);
		await expect(
			sql`
        UPDATE entity_relationships
        SET relationship_type_id = ${typeId}
        WHERE id = ${ordinaryEdges[0].id}
      `,
		).rejects.toThrow(/authorization-bearing/);
	});

	it("does not leave the ACL privilege set for the rest of the transaction", async () => {
		// Regression: a bare `set_config(...)` with no reset made every later
		// statement in the transaction privileged, so the trigger could no
		// longer refuse a repoint of an authorization edge the first statement
		// had not matched.
		const sql = getTestDb();

		await expect(
			sql.begin(async (tx) => {
				await withAclPrivilege(tx as never, async () => {
					await tx`
            INSERT INTO entity_relationships
              (organization_id, from_entity_id, to_entity_id, relationship_type_id,
               source, created_at, updated_at)
            VALUES (${orgId}, ${alice}, ${channel}, ${typeId}, 'feed',
                    current_timestamp, current_timestamp)
          `;
				});
				// Same transaction, privilege dropped — must now be refused.
				await tx`
          INSERT INTO entity_relationships
            (organization_id, from_entity_id, to_entity_id, relationship_type_id,
             source, created_at, updated_at)
          VALUES (${orgId}, ${bob}, ${channel}, ${typeId}, 'feed',
                  current_timestamp, current_timestamp)
        `;
			}),
		).rejects.toThrow(/authorization-bearing/);
	});

	it("does not leak the flag to the next transaction on a pooled connection", async () => {
		// SET LOCAL is transaction-scoped. If it leaked, a later caller write on the
		// same pooled connection would silently pass.
		await seedGrant(alice);
		const sql = getTestDb();
		await expect(
			sql`
        INSERT INTO entity_relationships
          (organization_id, from_entity_id, to_entity_id, relationship_type_id,
           source, created_at, updated_at)
        VALUES (${orgId}, ${bob}, ${channel}, ${typeId}, 'feed',
                current_timestamp, current_timestamp)
      `
		).rejects.toThrow(/authorization-bearing/);
	});
});
