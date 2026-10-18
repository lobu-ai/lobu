/**
 * Automation-mode `unprocessed_ranges` is a bounded arrival-axis histogram.
 *
 * The monthly buckets scan `created_at` (the axis windows claim on) and are
 * bounded to the recent-arrival horizon instead of walking the entity's full
 * history. These guards pin both halves:
 * - events that arrived more than 90 days ago contribute no month at all;
 * - a backfilled event (old `occurred_at`, recent `created_at`) counts in its
 *   arrival month, not its source month.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { cleanupTestDatabase } from "../../setup/test-db";
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

const DAY_MS = 24 * 60 * 60 * 1000;

describe("automation-mode unprocessed_ranges arrival bound", () => {
	let owner: TestApiClient;
	let automationId: string;
	let entityId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Ranges Bound Org" });
		const user = await createTestUser({ email: "ranges-bound@test.example.com" });
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
		const entity = await createTestEntity({
			name: "Ranges Bound Target",
			entity_type: "company",
			organization_id: org.id,
			created_by: user.id,
		});
		entityId = Number(entity.id);
		await createTestConnection({
			organization_id: org.id,
			connector_key: "test.connector",
		});

		const now = Date.now();
		// Old arrival: outside the 90-day horizon on BOTH axes.
		await createTestEvent({
			entity_id: entityId,
			organization_id: org.id,
			content: "old arrival row",
			occurred_at: new Date(now - 100 * DAY_MS),
			created_at: new Date(now - 100 * DAY_MS),
		});
		// Backfill: source timestamp is ancient, but Lobu stored it this week.
		await createTestEvent({
			entity_id: entityId,
			organization_id: org.id,
			content: "backfilled row",
			occurred_at: new Date(now - 200 * DAY_MS),
			created_at: new Date(now - 5 * DAY_MS),
		});
		// Fresh on both axes.
		await createTestEvent({
			entity_id: entityId,
			organization_id: org.id,
			content: "fresh row",
			occurred_at: new Date(now - DAY_MS),
			created_at: new Date(now - DAY_MS),
		});

		const created = (await owner.automations.create({
			entity_id: entityId,
			slug: "ranges-bound",
			name: "Ranges Bound",
			prompt: "Summarize {{content}}.",
			managed_agent_id: agent.agentId,
			sources: [{ name: "content", query: "@feed:default" }],
		})) as { automation_id: string };
		automationId = created.automation_id;
	});

	it("excludes arrivals older than the horizon and buckets by created_at", async () => {
		const result = (await owner.knowledge.read({
			automation_id: automationId,
		})) as {
			unprocessed_ranges?: Array<{
				month: string;
				total_content: number;
				unprocessed_content: number;
			}>;
		};
		const ranges = result.unprocessed_ranges ?? [];
		const total = ranges.reduce((sum, r) => sum + r.total_content, 0);
		// Three events seeded, but only two arrived inside the horizon: the
		// 100-day-old arrival is excluded, while the backfill (occurred 200
		// days ago, stored 5 days ago) counts via its created_at arrival.
		// Bucketing by occurred_at would have dropped the backfill instead.
		expect(total).toBe(2);
		expect(ranges.length).toBeGreaterThan(0);
		expect(ranges.every((r) => r.unprocessed_content === r.total_content)).toBe(true);
		const horizon = new Date(Date.now() - 90 * DAY_MS).toISOString();
		expect(ranges.every((r) => r.window_start >= horizon)).toBe(true);
	});
});
