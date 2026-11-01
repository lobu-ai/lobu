/**
 * Caller surfaces refuse authorization-bearing relationship types.
 *
 * Classifying `member_of` makes the ACL gates depend on those rows. That is only
 * a trust boundary if the rows stop being generically writable — otherwise
 * anyone holding the entity-link surface could mint access by creating an edge,
 * or revoke it by soft-deleting one. These tests drive the real tool, not the
 * validation helpers, because the tool is the surface a caller reaches.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { ensureMemberOfType } from "../../../authz/access-graph";
import { manageEntity } from "../../../tools/admin/manage_entity";
import { manageEntitySchema } from "../../../tools/admin/manage_entity_schema";
import type { ToolContext } from "../../../tools/registry";
import { deleteEntity } from "../../../utils/entity-management";
import { withAclEdgeWrite } from "../../../utils/relationship-validation";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const env = {} as Env;

function ctx(orgId: string, userId: string): ToolContext {
	return {
		organizationId: orgId,
		userId,
		memberRole: "owner",
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
	} as ToolContext;
}

describe("authorization-bearing relationship types are not caller-writable", () => {
	let orgId: string;
	let userId: string;
	let typeId: number;
	let person: number;
	let channel: number;

	beforeEach(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const org = await createTestOrganization({ name: "Guard Org" });
		orgId = org.id;
		const user = await createTestUser();
		userId = user.id;
		await addUserToOrganization(userId, orgId, "owner");

		typeId = await ensureMemberOfType(orgId);
		person = (
			await createTestEntity({
				organization_id: orgId,
				entity_type: "person",
				name: "Ada",
			})
		).id;
		channel = (
			await createTestEntity({
				organization_id: orgId,
				entity_type: "channel",
				name: "#secrets",
			})
		).id;
	});

	async function revision(slug: string): Promise<string> {
		const result = await manageEntitySchema({ schema_type: "relationship_type", action: "get", slug }, env, ctx(orgId, userId));
		return result.relationship_type!.revision;
	}

	/**
	 * Seeds the edge the way the ACL sync does — under the write flag. A raw
	 * INSERT is now rejected by the database trigger, which is the point: the
	 * fixture has to impersonate a sync because nothing else may write these.
	 */
	async function seedAclEdge(): Promise<number> {
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

	it("refuses to LINK on an authorization type — creating one would mint access", async () => {
		await expect(
			manageEntity(
				{
					action: "link",
					from_entity_id: person,
					to_entity_id: channel,
					relationship_type_slug: "member_of",
				},
				env,
				ctx(orgId, userId),
			),
		).rejects.toThrow(/authorization-bearing/);

		const sql = getTestDb();
		const rows = await sql`
      SELECT id FROM entity_relationships
      WHERE relationship_type_id = ${typeId} AND deleted_at IS NULL
    `;
		expect(rows).toHaveLength(0);
	});

	it("refuses to UNLINK an authorization edge — removing one revokes access", async () => {
		const edgeId = await seedAclEdge();

		await expect(
			manageEntity(
				{ action: "unlink", relationship_id: edgeId },
				env,
				ctx(orgId, userId),
			),
		).rejects.toThrow(/authorization-bearing/);

		const sql = getTestDb();
		const rows = await sql`
      SELECT id FROM entity_relationships
      WHERE id = ${edgeId} AND deleted_at IS NULL
    `;
		expect(rows).toHaveLength(1);
	});

	it("refuses to UPDATE_LINK an authorization edge", async () => {
		const edgeId = await seedAclEdge();

		await expect(
			manageEntity(
				{ action: "update_link", relationship_id: edgeId, confidence: 0.1 },
				env,
				ctx(orgId, userId),
			),
		).rejects.toThrow(/authorization-bearing/);
	});

	it("allows a config to declare member_of while it is unclassified", async () => {
		// Legacy and direct config paths can declare member_of before the first ACL
		// sync creates it. Declaring a type grants nobody access; only an edge on it
		// does, and that surface stays closed.
		const sql = getTestDb();
		await sql`
      UPDATE entity_relationship_types
      SET purpose = NULL, status = 'archived', deleted_at = current_timestamp
      WHERE id = ${typeId}
    `;

		await manageEntitySchema(
			{
				schema_type: "relationship_type",
				action: "create",
				slug: "member_of",
				name: "Member of",
			},
			env,
			ctx(orgId, userId),
		);
		await manageEntitySchema(
			{
				schema_type: "relationship_type",
				action: "update",
				slug: "member_of", expected_revision: await revision("member_of"),
				description: "declared by config",
			} as never,
			env,
			ctx(orgId, userId),
		);

		// …but an EDGE on it is still refused in that same window.
		await expect(
			manageEntity(
				{
					action: "link",
					from_entity_id: person,
					to_entity_id: channel,
					relationship_type_slug: "member_of",
				} as never,
				env,
				ctx(orgId, userId),
			),
		).rejects.toThrow(/authorization-bearing/);
	});

	it("refuses to ARCHIVE an authorization type — that revokes an org wholesale", async () => {
		await expect(
			manageEntitySchema(
				{ schema_type: "relationship_type", action: "delete", slug: "member_of", expected_revision: await revision("member_of"), },
				env,
				ctx(orgId, userId),
			),
		).rejects.toThrow(/authorization-bearing/);

		const sql = getTestDb();
		const rows = await sql`
      SELECT id FROM entity_relationship_types
      WHERE id = ${typeId} AND status = 'active' AND deleted_at IS NULL
    `;
		expect(rows).toHaveLength(1);
	});

	it("refuses to archive member_of before classification", async () => {
		const edgeId = await seedAclEdge();
		const sql = getTestDb();
		await sql`
      UPDATE entity_relationship_types SET purpose = NULL WHERE id = ${typeId}
    `;

		await expect(
			manageEntitySchema(
				{
					schema_type: "relationship_type",
					action: "update",
					slug: "member_of", expected_revision: await revision("member_of"),
					status: "archived",
				},
				env,
				ctx(orgId, userId),
			),
		).rejects.toThrow(/ACL-managed.*cannot be archived/);

		const types = await sql`
      SELECT id FROM entity_relationship_types
      WHERE id = ${typeId} AND status = 'active'
    `;
		const edges = await sql`
      SELECT id FROM entity_relationships
      WHERE id = ${edgeId} AND deleted_at IS NULL
    `;
		expect(types).toHaveLength(1);
		expect(edges).toHaveLength(1);
	});

	it("still allows ordinary domain vocabulary through every surface", async () => {
		// The guard must key on the CLASSIFICATION, not on being a relationship
		// type. Ordinary domain vocabulary — an ERP invoice's `billed_to` — is
		// exactly what this whole programme exists to keep writable.
		await manageEntitySchema(
			{
				schema_type: "relationship_type",
				action: "create",
				slug: "billed_to",
				name: "Billed to",
			},
			env,
			ctx(orgId, userId),
		);

		const linked = (await manageEntity(
			{
				action: "link",
				from_entity_id: person,
				to_entity_id: channel,
				relationship_type_slug: "billed_to",
			},
			env,
			ctx(orgId, userId),
		)) as { action: string; relationship: { id: number } };

		expect(linked.action).toBe("link");
		expect(linked.relationship.id).toBeGreaterThan(0);
	});

	it("refuses remove_rule on an authorization type", async () => {
		// remove_rule resolves by rule_id, so it never passes through the
		// slug-based guard add_rule uses.
		const sql = getTestDb();
		const rule = await sql<{ id: number }[]>`
      INSERT INTO entity_relationship_type_rules
        (relationship_type_id, source_entity_type_slug, target_entity_type_slug,
         created_at, updated_at)
      VALUES (${typeId}, 'person', 'channel', current_timestamp, current_timestamp)
      RETURNING id
    `;
		await expect(
			manageEntitySchema({
				schema_type: "relationship_type",
				action: "remove_rule",
				expected_revision: await revision("member_of"),
				rule_id: Number(rule[0].id),
			} as never, env, ctx(orgId, userId)),
		).rejects.toThrow(/authorization-bearing/);
	});

	it("refuses to pair a caller's own type with an authorization type as its inverse", async () => {
		await expect(
			manageEntitySchema({
				schema_type: "relationship_type",
				action: "create",
				slug: "owns_membership",
				name: "Owns membership",
				inverse_type_slug: "member_of",
			} as never, env, ctx(orgId, userId)),
		).rejects.toThrow(/authorization-bearing/);
	});

	it("lets force-delete remove an entity holding a grant", async () => {
		// Force-delete deliberately claims the ACL privilege, so exercise that path
		// as well as the unprivileged DELETE refusal.
		const sql = getTestDb();
		await seedAclEdge();
		const before = await sql`
      SELECT id FROM entity_relationships
      WHERE relationship_type_id = ${typeId} AND deleted_at IS NULL
    `;
		expect(before).toHaveLength(1);

		const [{ acl_generation: generationBefore }] = await sql<{
			acl_generation: string;
		}>`SELECT acl_generation::text AS acl_generation FROM organization WHERE id = ${orgId}`;
		await sql`
      INSERT INTO authz_source_acl_state
        (organization_id, connection_id, acl_support, freshness_state)
      VALUES (${orgId}, 'force-delete-generation', 'full', 'fresh')
    `;

		await deleteEntity(person, true, env, ctx(orgId, userId));

		const live = await sql`
      SELECT id FROM entity_relationships
      WHERE relationship_type_id = ${typeId} AND deleted_at IS NULL
    `;
		expect(live).toHaveLength(0);

		// Dropping the grant must also invalidate any sync already in flight, or it
		// can stamp the connection fresh over a projection it never saw.
		const [{ acl_generation: generationAfter }] = await sql<{
			acl_generation: string;
		}>`SELECT acl_generation::text AS acl_generation FROM organization WHERE id = ${orgId}`;
		expect(Number(generationAfter)).toBeGreaterThan(Number(generationBefore));
		const [{ freshness_state: freshnessAfter }] = await sql<{ freshness_state: string }>`
      SELECT freshness_state
      FROM authz_source_acl_state
      WHERE organization_id = ${orgId} AND connection_id = 'force-delete-generation'
    `;
		expect(freshnessAfter).toBe("stale");
	});

	it("reports purpose on LIST so callers can predict the refusal", async () => {
		// A refusal a caller cannot anticipate becomes a dead button: `member_of`
		// is org-owned, so ownership alone cannot separate it from an ordinary
		// type, and the UI renders edit affordances that are guaranteed to 403.
		const ordinary = await manageEntitySchema(
			{
				schema_type: "relationship_type",
				action: "create",
				slug: "mentions",
				name: "Mentions",
			},
			env,
			ctx(orgId, userId),
		);
		// `toHaveProperty` and not `?? null`: an absent key reads as null too, so
		// the loose form still passes once a handler stops selecting the column —
		// and on a missing row, `bySlug.get(…)?.purpose ?? null` would as well.
		expect(ordinary.relationship_type).toHaveProperty("purpose", null);

		const listed = await manageEntitySchema(
			{ schema_type: "relationship_type", action: "list" },
			env,
			ctx(orgId, userId),
		);
		const bySlug = new Map(
			(listed.relationship_types ?? []).map((rt) => [rt.slug, rt]),
		);
		expect(bySlug.get("member_of")).toHaveProperty("purpose", "authorization");
		expect(bySlug.get("mentions")).toHaveProperty("purpose", null);
	});

	it("reports purpose on UPDATE too — the row shape does not vary by action", async () => {
		// update refuses a classified type, so this path can only ever report
		// null. It still carries the key: a client switching on `purpose` must
		// not see the field appear and disappear across actions.
		await manageEntitySchema(
			{
				schema_type: "relationship_type",
				action: "create",
				slug: "mentions",
				name: "Mentions",
			},
			env,
			ctx(orgId, userId),
		);
		const updated = await manageEntitySchema(
			{
				schema_type: "relationship_type",
				action: "update",
				slug: "mentions", expected_revision: await revision("mentions"),
				name: "Mentioned in",
			},
			env,
			ctx(orgId, userId),
		);
		expect(updated.relationship_type).toHaveProperty("purpose", null);
	});

	it("reports purpose on GET too", async () => {
		const got = await manageEntitySchema(
			{ schema_type: "relationship_type", action: "get", slug: "member_of" },
			env,
			ctx(orgId, userId),
		);
		expect(got.relationship_type?.purpose).toBe("authorization");
	});

	it("refuses member_of by slug before it is classified", async () => {
		// ACL reads still trust the slug during the staged cutover. The slug guard
		// keeps a newly declared row fail-closed before its first sync classifies it.
		const sql = getTestDb();
		await sql`
      UPDATE entity_relationship_types SET purpose = NULL WHERE id = ${typeId}
    `;

		await expect(
			manageEntity(
				{
					action: "link",
					from_entity_id: person,
					to_entity_id: channel,
					relationship_type_slug: "member_of",
				},
				env,
				ctx(orgId, userId),
			),
		).rejects.toThrow(/authorization-bearing/);
	});

	it("reports acl_managed on LIST_LINKS so a client can predict the unlink refusal", async () => {
		await seedAclEdge();

		const listed = (await manageEntity(
			{ action: "list_links", entity_id: person },
			env,
			ctx(orgId, userId),
		)) as { relationships: Array<Record<string, unknown>> };

		const edge = listed.relationships.find(
			(r) => r.relationship_type_slug === "member_of",
		);
		// toHaveProperty, not a truthiness check: an absent key is falsy too, so
		// the loose form would keep passing if a handler stopped projecting the
		// column — which is exactly the regression that revives the dead button.
		expect(edge).toHaveProperty("acl_managed", true);
	});

	it("reports acl_managed BEFORE classification — purpose alone would say writable", async () => {
		const edgeId = await seedAclEdge();
		const sql = getTestDb();
		await sql`
      UPDATE entity_relationship_types SET purpose = NULL WHERE id = ${typeId}
    `;

		const listed = (await manageEntity(
			{ action: "list_links", entity_id: person },
			env,
			ctx(orgId, userId),
		)) as { relationships: Array<Record<string, unknown>> };

		const edge = listed.relationships.find((r) => Number(r.id) === edgeId);
		// The slug half of the guard: assertNotAclManagedEdge refuses on slug OR
		// purpose, so unlink still 403s here (the test above covers the same
		// window on the link side). The read path has to agree, or the client is
		// told it may remove an edge the server will refuse.
		expect(edge).toHaveProperty("acl_managed", true);
	});

	it("reports acl_managed false for ordinary domain vocabulary", async () => {
		await manageEntitySchema(
			{
				schema_type: "relationship_type",
				action: "create",
				slug: "billed_to",
				name: "Billed to",
			},
			env,
			ctx(orgId, userId),
		);
		const linked = (await manageEntity(
			{
				action: "link",
				from_entity_id: person,
				to_entity_id: channel,
				relationship_type_slug: "billed_to",
			},
			env,
			ctx(orgId, userId),
		)) as { relationship: Record<string, unknown> };
		// `link` returns the same row shape, so cover that producer here too: a
		// client switching on the flag must not see it appear and disappear
		// across actions.
		expect(linked.relationship).toHaveProperty("acl_managed", false);

		const listed = (await manageEntity(
			{ action: "list_links", entity_id: person },
			env,
			ctx(orgId, userId),
		)) as { relationships: Array<Record<string, unknown>> };

		const edge = listed.relationships.find(
			(r) => r.relationship_type_slug === "billed_to",
		);
		// The other direction: a predicate that swept everything in would hide the
		// unlink control on every ordinary edge in the product.
		expect(edge).toHaveProperty("acl_managed", false);
	});
});
