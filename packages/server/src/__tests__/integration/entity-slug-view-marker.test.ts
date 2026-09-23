/**
 * `-` marks where a page path ends and a view begins
 * (`/<org>/<type>/<slug>/-/views/<key>`), so a record stored under that slug
 * would have a page the web host parses as a view path. Derived slugs never
 * are one (slugify trims dashes); an explicit slug has to be refused.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import type { ToolContext } from "../../tools/registry";
import { createEntity, updateEntity } from "../../utils/entity-management";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../setup/test-fixtures";

const TEST_ENV = {} as Env;

function ownerCtx(organizationId: string, userId: string): ToolContext {
	return {
		organizationId,
		userId,
		memberRole: "owner",
		agentId: null,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		tokenType: "oauth",
		scopedToOrg: true,
		allowCrossOrg: false,
	} as unknown as ToolContext;
}

async function seedOrg() {
	const sql = getTestDb();
	const org = await createTestOrganization({ name: "Slug Marker" });
	const user = await createTestUser();
	await addUserToOrganization(user.id, org.id, "owner");
	await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${org.id}, 'project', 'project', current_timestamp, current_timestamp)
  `;
	return { org, user };
}

async function slugsIn(organizationId: string): Promise<string[]> {
	const sql = getTestDb();
	const rows = await sql<{ slug: string }[]>`
    SELECT slug FROM entities WHERE organization_id = ${organizationId} ORDER BY id`;
	return rows.map((r) => r.slug);
}

describe("a record slug can never be the view path marker", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("refuses '-' as an explicit slug on create and writes nothing", async () => {
		const { org, user } = await seedOrg();
		await expect(
			createEntity({
				entity_type: "project",
				name: "Dash",
				slug: "-",
				organization_id: org.id,
				created_by: user.id,
			} as Parameters<typeof createEntity>[0]),
		).rejects.toThrow(/Slug '-' is reserved/);
		expect(await slugsIn(org.id)).toEqual([]);
	}, 60_000);

	it("refuses renaming a record's slug to '-' and keeps the old slug", async () => {
		const { org, user } = await seedOrg();
		const record = await createEntity({
			entity_type: "project",
			name: "Launch",
			slug: "launch",
			organization_id: org.id,
			created_by: user.id,
		} as Parameters<typeof createEntity>[0]);
		await expect(
			updateEntity(record.id, { slug: "-" }, TEST_ENV, ownerCtx(org.id, user.id)),
		).rejects.toThrow(/Slug '-' is reserved/);
		expect(await slugsIn(org.id)).toEqual(["launch"]);
	}, 60_000);
});
