/**
 * A custom-SQL event source owns its projection and is only required to select
 * `id` — `validateAutomationConfig` asks for nothing else. The window reader
 * nonetheless spliced `_automation_page.occurred_at` into both the WHERE and the
 * ORDER BY of every event source, so a projection that did not select the column
 * failed the whole read with `column _automation_page.occurred_at does not
 * exist`.
 *
 * That read is what mints the window token, so the outage did not look like a
 * query fault: the Automation ran, did all of its real work, then could not
 * complete its window and died as "Device CLI exited without calling
 * completeWindow" — a message pointing at the agent. Seen in prod on a weekly
 * research Automation whose source was `SELECT id FROM events WHERE FALSE`.
 *
 * The guards cover the class, not that one query: a projection without
 * `occurred_at` must return its rows, a custom projection that does carry the
 * cursor columns must keep exact keyset paging, and a NULL `occurred_at` must
 * still be paged out rather than silently admitted.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestConnection,
	createTestEntity,
	createTestEvent,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";
import { TestApiClient } from "../../setup/test-mcp-client";

/** Events seeded into the window. Must exceed PAGE_LIMIT so paging is observable. */
const SEEDED_EVENTS = 3;
const PAGE_LIMIT = 2;

type ReadResult = {
	sources: Record<string, Array<Record<string, unknown>>>;
	sources_page?: Record<
		string,
		{ returned: number; limit: number; has_more: boolean }
	>;
	page: { has_more: boolean; next_cursor?: { occurred_at: string; id: number } };
};

describe("a custom event source may omit the keyset cursor columns", () => {
	let owner: TestApiClient;
	let orgId: string;
	let agentId: string;
	let entityId: number;
	let connectionId: number;
	let feedId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Source Projection Org" });
		orgId = org.id;
		const user = await createTestUser({ email: "source-projection@test.com" });
		await addUserToOrganization(user.id, org.id, "owner");
		owner = await TestApiClient.for({
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
		});
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		agentId = agent.agentId;

		const entity = await createTestEntity({
			name: "Source Projection Target",
			entity_type: "company",
			organization_id: orgId,
			created_by: user.id,
		});
		entityId = Number(entity.id);

		const connection = await createTestConnection({
			organization_id: orgId,
			connector_key: "test.connector",
			display_name: "Source Projection",
			slug: "source-projection",
		});
		connectionId = connection.id;
		const sql = getTestDb();
		const [feed] = await sql<{ id: number | string }[]>`
      SELECT id FROM feeds WHERE connection_id = ${connection.id} AND feed_key = 'default'
    `;
		feedId = Number(feed.id);
		for (let i = 0; i < SEEDED_EVENTS; i++) {
			await createTestEvent({
				entity_id: entityId,
				organization_id: orgId,
				connection_id: connectionId,
				feed_id: feedId,
				content: `projection row ${i}`,
				// Distinct timestamps so keyset ordering is deterministic, all within
				// seconds of now so `since: 'today'` cannot lose one to midnight.
				occurred_at: new Date(Date.now() - i * 1000),
			});
		}
	});

	/** An Automation with one custom-SQL event source named `content`. */
	async function automationWithSource(
		slug: string,
		query: string
	): Promise<string> {
		const created = (await owner.automations.create({
			entity_id: entityId,
			slug,
			name: slug,
			prompt: "Summarize {{content}}.",
			managed_agent_id: agentId,
			sources: [{ name: "content", query }],
		})) as { automation_id: string };
		return created.automation_id;
	}

	it("returns rows from a projection that selects id without occurred_at", async () => {
		const automationId = await automationWithSource(
			"id-only-projection",
			"SELECT id FROM events"
		);

		const result = (await owner.knowledge.read({
			automation_id: automationId,
			since: "today",
			until: "today",
			limit: PAGE_LIMIT,
		})) as ReadResult;

		// THE regression: before the fix this read failed with `column
		// _automation_page.occurred_at does not exist`, so the source came back
		// empty here — and on a claimed run, where the same read throws
		// (`throwOnSourceError`), no window token could be minted at all.
		expect(result.sources.content).toHaveLength(PAGE_LIMIT);
		expect(result.sources_page?.content).toEqual({
			returned: PAGE_LIMIT,
			limit: PAGE_LIMIT,
			has_more: true,
		});
		// The projection is honored as authored — it selected only `id`.
		expect(Object.keys(result.sources.content[0])).toEqual(["id"]);
	});

	it("keeps exact keyset paging for a custom projection that does carry the cursor", async () => {
		const automationId = await automationWithSource(
			"cursor-projection",
			"SELECT id, occurred_at, payload_text FROM events"
		);

		const first = (await owner.knowledge.read({
			automation_id: automationId,
			since: "today",
			until: "today",
			limit: PAGE_LIMIT,
		})) as ReadResult;

		expect(first.sources.content).toHaveLength(PAGE_LIMIT);
		expect(first.page.next_cursor).toBeDefined();

		const second = (await owner.knowledge.read({
			automation_id: automationId,
			since: "today",
			until: "today",
			limit: PAGE_LIMIT,
			before_occurred_at: first.page.next_cursor?.occurred_at,
			before_id: first.page.next_cursor?.id,
		})) as ReadResult;

		// The cursor must advance rather than repeat: reading the cursor through
		// to_jsonb has to compare and order identically to the stored columns.
		expect(second.sources.content).toHaveLength(SEEDED_EVENTS - PAGE_LIMIT);
		const firstIds = first.sources.content.map((row) => String(row.id));
		const secondIds = second.sources.content.map((row) => String(row.id));
		expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
	});

	it("still pages out a row whose selected occurred_at is NULL", async () => {
		// The window is scoped on created_at, so a NULL occurred_at genuinely
		// reaches the pager. It cannot be cursored, so it must stay out.
		const sql = getTestDb();
		await createTestEvent({
			entity_id: entityId,
			organization_id: orgId,
			connection_id: connectionId,
			feed_id: feedId,
			content: "undateable row",
			occurred_at: new Date(),
		});
		await sql`
      UPDATE events SET occurred_at = NULL
      WHERE organization_id = ${orgId} AND payload_text = 'undateable row'
    `;

		const automationId = await automationWithSource(
			"null-occurred-at",
			"SELECT id, occurred_at, payload_text FROM events"
		);

		const result = (await owner.knowledge.read({
			automation_id: automationId,
			since: "today",
			until: "today",
			limit: SEEDED_EVENTS + 5,
		})) as ReadResult;

		expect(
			result.sources.content.map((row) => row.payload_text)
		).not.toContain("undateable row");
		expect(result.sources.content).toHaveLength(SEEDED_EVENTS);
	});
});
