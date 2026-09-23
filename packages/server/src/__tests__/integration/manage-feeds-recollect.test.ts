/**
 * manage_feeds recollect_feed — the explicit operator lever for re-collecting
 * one feed from scratch. It clears the connector cursor but keeps
 * `source_ack` (what was already acknowledged back to the source), refuses
 * while a sync run could still write its cursor back, and never reaches a feed
 * in another org.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ClientSdkActionError } from "../../sandbox/namespaces/action-call";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestOrganization,
	createTestUser,
} from "../setup/test-fixtures";
import { TestApiClient } from "../setup/test-mcp-client";

const SOURCE_ACK = { acked_through: "synthetic-ack-42" };

describe("manage_feeds recollect_feed", () => {
	let owner: TestApiClient;
	let foreignOwner: TestApiClient;
	let orgId: string;
	let connectionId: number;
	let feedId: number;

	async function feedRow() {
		const [row] = await getTestDb()<
			{
				checkpoint: Record<string, unknown> | null;
				status: string;
				schedule: string | null;
				consecutive_failures: number;
			}[]
		>`SELECT checkpoint, status, schedule, consecutive_failures FROM feeds WHERE id = ${feedId}`;
		return row;
	}

	async function recollectError(client: TestApiClient) {
		const error = await client.feeds
			.recollect({ feed_id: feedId })
			.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(ClientSdkActionError);
		return (error as ClientSdkActionError).result.error;
	}

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Recollect Org" });
		orgId = org.id;
		const user = await createTestUser({ email: "recollect-owner@test.com" });
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: "github",
			created_by: user.id,
		});
		connectionId = Number(conn.id);
		const [feed] = await getTestDb()<{ id: number }[]>`
      SELECT id FROM feeds WHERE connection_id = ${conn.id} AND organization_id = ${orgId}
      LIMIT 1
    `;
		feedId = Number(feed?.id);
		owner = await TestApiClient.for({
			organizationId: orgId,
			userId: user.id,
			memberRole: "owner",
		});

		const foreignOrg = await createTestOrganization({ name: "Foreign Org" });
		const foreignUser = await createTestUser({ email: "foreign-owner@test.com" });
		foreignOwner = await TestApiClient.for({
			organizationId: foreignOrg.id,
			userId: foreignUser.id,
			memberRole: "owner",
		});
	});

	beforeEach(async () => {
		const sql = getTestDb();
		await sql`DELETE FROM runs WHERE feed_id = ${feedId}`;
		await sql`
      UPDATE feeds
      SET checkpoint = ${sql.json({ cursor: "page-9", source_ack: SOURCE_ACK })},
          status = 'active', schedule = '*/15 * * * *', consecutive_failures = 2
      WHERE id = ${feedId}
    `;
	});

	it("clears the cursor, keeps source_ack, and leaves the rest of the feed alone", async () => {
		const result = (await owner.feeds.recollect({ feed_id: feedId })) as {
			action?: string;
			feed_id?: number;
		};
		expect(result).toMatchObject({ action: "recollect_feed", feed_id: feedId });

		expect(await feedRow()).toEqual({
			checkpoint: { source_ack: SOURCE_ACK },
			status: "active",
			schedule: "*/15 * * * *",
			consecutive_failures: 2,
		});
	});

	it("clears a cursor-only checkpoint to NULL", async () => {
		const sql = getTestDb();
		await sql`UPDATE feeds SET checkpoint = ${sql.json({ cursor: "page-9" })} WHERE id = ${feedId}`;
		await owner.feeds.recollect({ feed_id: feedId });
		expect((await feedRow())?.checkpoint).toBeNull();
	});

	it("is a no-op success on an ack-only or NULL checkpoint", async () => {
		const sql = getTestDb();
		await sql`UPDATE feeds SET checkpoint = ${sql.json({ source_ack: SOURCE_ACK })} WHERE id = ${feedId}`;
		await owner.feeds.recollect({ feed_id: feedId });
		expect((await feedRow())?.checkpoint).toEqual({ source_ack: SOURCE_ACK });

		await sql`UPDATE feeds SET checkpoint = NULL WHERE id = ${feedId}`;
		await owner.feeds.recollect({ feed_id: feedId });
		expect((await feedRow())?.checkpoint).toBeNull();
	});

	it.each(["pending", "claimed", "running"])(
		"refuses while a %s sync run could write its cursor back",
		async (status) => {
			await getTestDb()`
        INSERT INTO runs (
          organization_id, run_type, feed_id, connection_id,
          connector_key, status, approval_status, created_at
        ) VALUES (
          ${orgId}, 'sync', ${feedId}, ${connectionId},
          'github', ${status}, 'auto', NOW()
        )
      `;
			expect(await recollectError(owner)).toMatch(/active sync run/);
			expect((await feedRow())?.checkpoint).toEqual({
				cursor: "page-9",
				source_ack: SOURCE_ACK,
			});
		},
	);

	it("proceeds once the sync run has finished", async () => {
		await getTestDb()`
      INSERT INTO runs (
        organization_id, run_type, feed_id, connection_id,
        connector_key, status, approval_status, created_at, completed_at
      ) VALUES (
        ${orgId}, 'sync', ${feedId}, ${connectionId},
        'github', 'completed', 'auto', NOW(), NOW()
      )
    `;
		await owner.feeds.recollect({ feed_id: feedId });
		expect((await feedRow())?.checkpoint).toEqual({ source_ack: SOURCE_ACK });
	});

	it("cannot touch a feed in another org", async () => {
		expect(await recollectError(foreignOwner)).toBe("Feed not found");
		expect((await feedRow())?.checkpoint).toEqual({
			cursor: "page-9",
			source_ack: SOURCE_ACK,
		});
	});

	it("is admin-only", async () => {
		const member = owner.withAuth({ memberRole: "member" });
		const error = await member.feeds
			.recollect({ feed_id: feedId })
			.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(Error);
		expect((await feedRow())?.checkpoint).toEqual({
			cursor: "page-9",
			source_ack: SOURCE_ACK,
		});
	});
});
