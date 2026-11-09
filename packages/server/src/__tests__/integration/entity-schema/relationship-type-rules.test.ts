/**
 * `list_rules` reads, both forms.
 *
 * The per-type form (`slug`) is the original API. The no-slug form returns
 * every rule the caller can see in one read, because the Data hub's schema map
 * needs them all at once: one request per relationship type made a cold load of
 * a large public workspace cost ~16 metered public reads, and a visitor has 60
 * a minute. This drives the real tool so the visibility rule (own org plus
 * public orgs, same as the single-slug form) is exercised, not just the SQL.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { manageEntitySchema } from "../../../tools/admin/manage_entity_schema";
import type { ToolContext } from "../../../tools/registry";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

function ctx(orgId: string, userId: string): ToolContext {
	return {
		organizationId: orgId,
		userId,
		memberRole: "owner",
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
	} as ToolContext;
}

async function createRelationshipType(
	organizationId: string,
	userId: string,
	slug: string
): Promise<number> {
	const result = await manageEntitySchema(
		{
			schema_type: "relationship_type",
			action: "create",
			slug,
			name: slug.replaceAll("_", " "),
		} as never,
		{} as never,
		{ ...ctx(organizationId, userId), organizationId } as ToolContext
	);
	return Number(
		(result as { relationship_type: { id: number } }).relationship_type.id
	);
}

async function addRule(
	relationshipTypeId: number,
	source: string,
	target: string
): Promise<number> {
	const sql = getTestDb();
	const [row] = await sql<{ id: number }[]>`
    INSERT INTO entity_relationship_type_rules
      (relationship_type_id, source_entity_type_slug, target_entity_type_slug,
       created_at, updated_at)
    VALUES (${relationshipTypeId}, ${source}, ${target}, current_timestamp, current_timestamp)
    RETURNING id
  `;
	return Number(row.id);
}

describe("list_rules", () => {
	let orgId: string;
	let userId: string;
	let worksAt: number;
	let advises: number;
	let worksAtRule: number;
	let advisesRule: number;

	beforeEach(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const org = await createTestOrganization({ name: "Rules Org" });
		orgId = org.id;
		const user = await createTestUser();
		userId = user.id;
		await addUserToOrganization(userId, orgId, "owner");

		worksAt = await createRelationshipType(orgId, userId, "works_at");
		advises = await createRelationshipType(orgId, userId, "advises");
		worksAtRule = await addRule(worksAt, "person", "company");
		advisesRule = await addRule(advises, "person", "company");
	});

	it("reads one type's rules when a slug is given", async () => {
		const result = (await manageEntitySchema(
			{
				schema_type: "relationship_type",
				action: "list_rules",
				slug: "works_at",
			} as never,
			{} as never,
			ctx(orgId, userId)
		)) as { rules: Array<{ id: number }> };

		expect(result.rules.map((rule) => Number(rule.id))).toEqual([worksAtRule]);
	});

	it("reads every visible rule in one call when no slug is given", async () => {
		const result = (await manageEntitySchema(
			{ schema_type: "relationship_type", action: "list_rules" } as never,
			{} as never,
			ctx(orgId, userId)
		)) as { rules: Array<{ id: number }> };

		expect(result.rules.map((rule) => Number(rule.id))).toEqual([
			worksAtRule,
			advisesRule,
		]);
	});

	it("never mixes in another private org's rules", async () => {
		const other = await createTestOrganization({ name: "Other Org" });
		const otherUser = await createTestUser();
		await addUserToOrganization(otherUser.id, other.id, "owner");
		const otherType = await createRelationshipType(
			other.id,
			otherUser.id,
			"owns"
		);
		const foreignRule = await addRule(otherType, "person", "company");

		const result = (await manageEntitySchema(
			{ schema_type: "relationship_type", action: "list_rules" } as never,
			{} as never,
			ctx(orgId, userId)
		)) as { rules: Array<{ id: number }> };

		const ids = result.rules.map((rule) => Number(rule.id));
		expect(ids).not.toContain(foreignRule);
		expect(ids).toEqual([worksAtRule, advisesRule]);
	});

	it("includes a public org's rules, as the single-slug form does", async () => {
		const publicOrg = await createTestOrganization({
			name: "Public Org",
			visibility: "public",
		});
		const publicUser = await createTestUser();
		await addUserToOrganization(publicUser.id, publicOrg.id, "owner");
		const publicType = await createRelationshipType(
			publicOrg.id,
			publicUser.id,
			"backed_by"
		);
		const publicRule = await addRule(publicType, "person", "company");

		const result = (await manageEntitySchema(
			{ schema_type: "relationship_type", action: "list_rules" } as never,
			{} as never,
			ctx(orgId, userId)
		)) as { rules: Array<{ id: number }> };

		expect(result.rules.map((rule) => Number(rule.id))).toContain(publicRule);
	});
});
