/**
 * manage_feeds create_feed / update_feed — cross-org entity_ids validation.
 *
 * Regression (found in prod lobu-crm): feeds were created with `entity_ids`
 * pointing at an entity owned by a DIFFERENT org. The create/update path did
 * not validate entity ownership, so synced events linked to a non-existent
 * in-org entity — a silent data-correctness bug. The fix rejects any entity_id
 * that does not belong to the requesting org.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { ClientSdkActionError } from "../../sandbox/namespaces/action-call";
import { getTool } from "../../tools/registry";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	createTestEntity,
	createTestOrganization,
	createTestUser,
	ownerToolContext,
} from "../setup/test-fixtures";
import { TestApiClient } from "../setup/test-mcp-client";

describe("manage_feeds cross-org entity_ids", () => {
	let owner: TestApiClient;
	let ownerOrgId: string;
	let ownerUserId: string;
	let foreignConnectionId: number;
	let connectionId: number;
	let inOrgEntityId: number;
	let foreignEntityId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();

		const org = await createTestOrganization({ name: "Feed Owner Org" });
		ownerOrgId = org.id;
		const user = await createTestUser({ email: "feed-owner@test.com" });
		ownerUserId = user.id;
		owner = await TestApiClient.for({
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
		});
		await createTestConnectorDefinition({
			key: "github",
			name: "GitHub",
			organization_id: org.id,
			feeds_schema: { default: {} },
		});

		const conn = await createTestConnection({
			organization_id: ownerOrgId,
			connector_key: "github",
			created_by: user.id,
			createDefaultFeed: false,
		});
		connectionId = Number(conn.id);

		const inOrg = await createTestEntity({
			name: "In-Org Entity",
			entity_type: "company",
			organization_id: ownerOrgId,
			created_by: user.id,
		});
		inOrgEntityId = Number(inOrg.id);

		// A separate org owns the "foreign" entity.
		const foreignOrg = await createTestOrganization({ name: "Foreign Org" });
		const foreignEntity = await createTestEntity({
			name: "Foreign Entity",
			entity_type: "company",
			organization_id: foreignOrg.id,
		});
		foreignEntityId = Number(foreignEntity.id);
		const foreignUser = await createTestUser({ email: "feed-foreign@test.com" });
		await createTestConnectorDefinition({
			key: "github",
			name: "GitHub",
			organization_id: foreignOrg.id,
			feeds_schema: { default: {} },
		});
		const foreignConnection = await createTestConnection({
			organization_id: foreignOrg.id,
			connector_key: "github",
			created_by: foreignUser.id,
			createDefaultFeed: false,
		});
		foreignConnectionId = Number(foreignConnection.id);
	});

	it("fails create_feed on another org's connection as a typed NOT_FOUND", async () => {
		const result = await getTool("run_sdk")!.handler(
			{
				script: `export default async (_ctx, client) => client.feeds.create({ connection_id: ${foreignConnectionId}, feed_key: "default" });`,
			},
			{} as Env,
			ownerToolContext(ownerOrgId, ownerUserId),
		);

		expect(result).toMatchObject({
			success: false,
			error: {
				name: "ClientSdkActionError",
				code: "NOT_FOUND",
				retryable: false,
			},
		});
		const sql = getTestDb();
		const rows = await sql`
      SELECT id FROM feeds WHERE connection_id = ${foreignConnectionId}
    `;
		expect(rows.length).toBe(0);
	});

	it.each([
		["get", "{ feed_id: FEED }"],
		["update", '{ feed_id: FEED, display_name: "Renamed" }'],
		["delete", "{ feed_id: FEED }"],
		["trigger", "{ feed_id: FEED }"],
		["recollect", "{ feed_id: FEED }"],
	])("fails feeds.%s on a missing feed as a typed NOT_FOUND", async (method, input) => {
		const result = await getTool("run_sdk")!.handler(
			{
				script: `const FEED = 2147480000;\nexport default async (_ctx, client) => client.feeds.${method}(${input});`,
			},
			{} as Env,
			ownerToolContext(ownerOrgId, ownerUserId),
		);

		expect(result).toMatchObject({
			success: false,
			error: { name: "ClientSdkActionError", code: "NOT_FOUND", retryable: false },
		});
	});

	it("rejects create_feed when an entity_id belongs to another org", async () => {
		const error = await owner.feeds
			.create({
				connection_id: connectionId,
				feed_key: "default",
				entity_ids: [foreignEntityId],
			})
			.catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(ClientSdkActionError);
		expect((error as ClientSdkActionError).message).toContain(
			String(foreignEntityId),
		);

		// No feed row leaked into the DB.
		const sql = getTestDb();
		const rows = await sql<{ id: number }[]>`
      SELECT id FROM feeds
      WHERE organization_id = ${ownerOrgId} AND ${foreignEntityId} = ANY(entity_ids)
    `;
		expect(rows.length).toBe(0);
	});

	it("accepts create_feed with an in-org entity_id", async () => {
		const result = (await owner.feeds.create({
			connection_id: connectionId,
			feed_key: "default",
			entity_ids: [inOrgEntityId],
		})) as { error?: string; feed?: { id: number } };

		expect(result.error).toBeUndefined();
		expect(result.feed?.id).toBeDefined();
	});

	it("rejects update_feed that repoints to another org's entity", async () => {
		// Create a clean feed with no entity_ids first.
		const created = (await owner.feeds.create({
			connection_id: connectionId,
			feed_key: "default",
			display_name: "update-target",
		})) as { feed?: { id: number } };
		const feedId = Number(created.feed?.id);
		expect(feedId).toBeGreaterThan(0);

		const error = await owner.feeds
			.update({
				feed_id: feedId,
				entity_ids: [foreignEntityId],
			})
			.catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(ClientSdkActionError);
		expect((error as ClientSdkActionError).message).toContain(
			String(foreignEntityId),
		);

		// The feed's entity_ids were NOT changed.
		const sql = getTestDb();
		const [row] = await sql<{ entity_ids: number[] | null }[]>`
      SELECT entity_ids FROM feeds WHERE id = ${feedId}
    `;
		const ids = Array.isArray(row?.entity_ids)
			? row.entity_ids.map(Number)
			: [];
		expect(ids).not.toContain(foreignEntityId);
	});
});
