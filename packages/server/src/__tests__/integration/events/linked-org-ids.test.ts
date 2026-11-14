/**
 * Denormalized org-scope bridge: `events.linked_org_ids` + the flag-gated
 * predicate in buildOrgScopeWhere.
 *
 * Pins:
 *  1. Write-time computation: cross-org entity links and cross-org
 *     connections land in the column, the event's own org is excluded, and
 *     unlinked events get '{}'.
 *  2. Predicate parity: with LOBU_LINKED_ORG_SCOPE=1 an org-scoped feed shows
 *     exactly the bridge-visible events the legacy OR/EXISTS predicate shows —
 *     including them when linked, excluding them when not.
 *  3. Member SQL, which reads through row-level security keyed on the
 *     column, sees the same bridged events in both modes.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { querySql } from "../../../tools/admin/query_sql";
import { getContent } from "../../../tools/get_content";
import type { ToolContext } from "../../../tools/registry";
import { insertEvent } from "../../../utils/insert-event";
import { getDb } from "../../../db/client";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestConnection,
	createTestConnectorDefinition,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

describe("events.linked_org_ids + LOBU_LINKED_ORG_SCOPE parity", () => {
	let orgA: Awaited<ReturnType<typeof createTestOrganization>>;
	let orgB: Awaited<ReturnType<typeof createTestOrganization>>;
	let userB: Awaited<ReturnType<typeof createTestUser>>;
	let entityB: Awaited<ReturnType<typeof createTestEntity>>;
	let connBId: number;

	let linkedEventId: number; // org A event linked to org B's entity
	let connLinkedEventId: number; // org A event via org B's connection
	let plainEventId: number; // org A event, no bridge to B
	let selfLinkedEventId: number; // org A event linked to org A entity only

	function orgBCtx(): ToolContext {
		return {
			organizationId: orgB.id,
			userId: userB.id,
			memberRole: "owner",
			isAuthenticated: true,
			tokenType: "oauth",
			scopedToOrg: false,
			allowCrossOrg: true,
			scopes: ["mcp:read"],
		};
	}

	const visibleIds = async (): Promise<Set<number>> => {
		const res = await getContent(
			{ limit: 50, sort_by: "date", sort_order: "desc" } as never,
			{} as never,
			orgBCtx(),
		);
		return new Set(res.content.map((c) => c.id as number));
	};

	beforeAll(async () => {
		await initWorkspaceProvider();
		await cleanupTestDatabase();

		orgA = await createTestOrganization({ name: "Bridge Org A" });
		orgB = await createTestOrganization({ name: "Bridge Org B" });
		userB = await createTestUser({ email: "bridge-b@test.com" });
		await addUserToOrganization(userB.id, orgB.id, "owner");

		entityB = await createTestEntity({
			name: "Org B Entity",
			organization_id: orgB.id,
		});

		await createTestConnectorDefinition({
			key: "bridge-connector",
			name: "Bridge Connector",
			organization_id: orgB.id,
		});
		const connB = await createTestConnection({
			organization_id: orgB.id,
			connector_key: "bridge-connector",
			entity_ids: [entityB.id],
			visibility: "org",
			created_by: userB.id,
			display_name: "Org B conn",
		});
		connBId = connB.id;

		linkedEventId = (
			await insertEvent({
				organizationId: orgA.id,
				entityIds: [entityB.id],
				originId: "bridge-linked-event",
				semanticType: "note",
				content: "org A event linked to org B entity",
			})
		).id;

		connLinkedEventId = (
			await insertEvent({
				organizationId: orgA.id,
				entityIds: [],
				connectionId: connBId,
				connectorKey: "bridge-connector",
				originId: "bridge-conn-event",
				semanticType: "note",
				content: "org A event via org B connection",
			})
		).id;

		plainEventId = (
			await insertEvent({
				organizationId: orgA.id,
				entityIds: [],
				originId: "bridge-plain-event",
				semanticType: "note",
				content: "org A event with no bridge",
			})
		).id;

		const entityA = await createTestEntity({
			name: "Org A Entity",
			organization_id: orgA.id,
		});
		selfLinkedEventId = (
			await insertEvent({
				organizationId: orgA.id,
				entityIds: [entityA.id],
				originId: "bridge-self-event",
				semanticType: "note",
				content: "org A event linked to org A entity only",
			})
		).id;
	}, 60_000);

	afterEach(() => {
		delete process.env.LOBU_LINKED_ORG_SCOPE;
	});

	afterAll(async () => {
		delete process.env.LOBU_LINKED_ORG_SCOPE;
		await cleanupTestDatabase();
	});

	it("computes linked_org_ids at insert: cross-org links in, own org out", async () => {
		const sql = getDb();
		// SQL-side containment/cardinality assertions — robust to how the driver
		// surfaces text[] (JS array vs literal).
		const rows = await sql`
      SELECT
        id,
        linked_org_ids @> ARRAY[${orgB.id}]::text[] AS has_b,
        cardinality(linked_org_ids) AS n
      FROM events
      WHERE id IN (${linkedEventId}, ${connLinkedEventId}, ${plainEventId}, ${selfLinkedEventId})
    `;
		const byId = new Map(rows.map((r) => [Number(r.id), r]));

		expect(byId.get(linkedEventId)?.has_b).toBe(true);
		expect(byId.get(linkedEventId)?.n).toBe(1);
		expect(byId.get(connLinkedEventId)?.has_b).toBe(true);
		expect(byId.get(connLinkedEventId)?.n).toBe(1);
		expect(byId.get(plainEventId)?.n).toBe(0);
		// Own-org entity link is excluded — no bridge to self.
		expect(byId.get(selfLinkedEventId)?.n).toBe(0);
	});

	it("legacy predicate (flag off): org B sees exactly the bridged events", async () => {
		const ids = await visibleIds();
		expect(ids.has(linkedEventId)).toBe(true);
		expect(ids.has(connLinkedEventId)).toBe(true);
		expect(ids.has(plainEventId)).toBe(false);
		expect(ids.has(selfLinkedEventId)).toBe(false);
	});

	it.each([
		["off", undefined],
		["on", "1"],
	])("member SQL (flag %s) sees exactly the bridged events", async (_mode, flag) => {
		if (flag) process.env.LOBU_LINKED_ORG_SCOPE = flag;
		const result = (await querySql({ sql: "SELECT id FROM events" }, {} as never, orgBCtx())) as {
			rows?: Array<{ id: number | string }>;
			error?: string;
		};
		expect(result.error).toBeUndefined();
		expect(new Set(result.rows?.map((row) => Number(row.id)))).toEqual(
			new Set([linkedEventId, connLinkedEventId]),
		);
	});

	it("denormalized predicate (flag on) is parity with the legacy bridge", async () => {
		process.env.LOBU_LINKED_ORG_SCOPE = "1";
		const ids = await visibleIds();
		expect(ids.has(linkedEventId)).toBe(true);
		expect(ids.has(connLinkedEventId)).toBe(true);
		expect(ids.has(plainEventId)).toBe(false);
		expect(ids.has(selfLinkedEventId)).toBe(false);
	});
});
