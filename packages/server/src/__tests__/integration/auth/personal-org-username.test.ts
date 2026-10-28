/**
 * Integration tests for the side effects of `ensurePersonalOrganization`:
 *
 * - username: the frontend resolves a user's home org from
 *   `session.user.username` (personalOrgSlug); mirroring the personal org slug
 *   onto username lets the home route resolve synchronously instead of waiting
 *   on `/api/organizations`. Must be set-when-null, idempotent, and never
 *   collide with another user's username.
 * - connector policy: auto-provisioned personal orgs start with All actions:
 *   Auto; team orgs start with Reads: Auto. Deleting either rule restores the
 *   built-in Ask default.
 * - workspace audit: an `organization` created event and an `owner` member
 *   created event, both `semantic_type='change'` / `metadata.category='workspace'`
 *   with a redacted post-change state snapshot. These rows are what make
 *   "org created" / "member joined" visible in the All activity feed (the
 *   Events page's Configuration filter excludes them by category).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { generateSecureToken } from "../../../auth/oauth/utils";
import { ensurePersonalOrganization } from "../../../auth/personal-org-provisioning";
import {
	deleteEntityApprovalPolicy,
	listEntityApprovalPolicies,
	resolveConnectorPolicy,
} from "../../../authz/entity-policy";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";

async function seedUser(opts: {
	name: string;
	username?: string | null;
}): Promise<{ id: string; email: string }> {
	const id = `user_${generateSecureToken(6)}`;
	const email = `${id}@test.local`;
	const sql = getTestDb();
	await sql`
    INSERT INTO "user" (id, name, email, username, "emailVerified", "createdAt", "updatedAt")
    VALUES (${id}, ${opts.name}, ${email}, ${opts.username ?? null}, true, NOW(), NOW())
  `;
	return { id, email };
}

async function readUsername(userId: string): Promise<string | null> {
	const sql = getTestDb();
	const rows =
		await sql`SELECT username FROM "user" WHERE id = ${userId} LIMIT 1`;
	return (rows[0]?.username as string | null) ?? null;
}

describe("ensurePersonalOrganization username backfill", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("sets username to the personal org slug when unset, and creates an owner membership", async () => {
		const { id, email } = await seedUser({
			name: "Backfill Me",
			username: null,
		});

		const res = await ensurePersonalOrganization({
			id,
			email,
			name: "Backfill Me",
			username: null,
		});
		expect(res.created).toBe(true);
		expect(res.slug).toBe("backfill-me");

		expect(await readUsername(id)).toBe(res.slug);

		const sql = getTestDb();
		const members = await sql`
      SELECT role FROM "member" WHERE "userId" = ${id} AND "organizationId" = ${res.organizationId}
    `;
		expect(members).toHaveLength(1);
		expect(String(members[0].role)).toBe("owner");
	});

	it("does not overwrite an existing username (idempotent)", async () => {
		const { id, email } = await seedUser({
			name: "Has Handle",
			username: "custom-handle",
		});

		await ensurePersonalOrganization({
			id,
			email,
			name: "Has Handle",
			username: "custom-handle",
		});

		expect(await readUsername(id)).toBe("custom-handle");
	});

	it("leaves username null when the slug is already taken by another user", async () => {
		// User A squats the username 'clash' (no org).
		await seedUser({ name: "A", username: "clash" });
		// User B's personal org slug derives to 'clash'.
		const { id, email } = await seedUser({ name: "Clash", username: null });

		const res = await ensurePersonalOrganization({
			id,
			email,
			name: "Clash",
			username: null,
		});
		expect(res.slug).toBe("clash");

		// The NOT EXISTS guard prevents stealing A's username; B stays null.
		expect(await readUsername(id)).toBeNull();
	});
});

describe("personal org default connector policy", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});
	const decide = (organizationId: string, kind: "read" | "write") =>
		resolveConnectorPolicy({
			organizationId,
			connectionId: null,
			operation: { connector_key: "policy-fixture", operation_key: kind, kind },
			actor: {
				kind: "user",
				id: null,
				ownerAgentId: null,
				ownerResolved: true,
			},
		});

	it("seeds one org-wide Auto rule on creation and does not re-add it once deleted", async () => {
		const { id, email } = await seedUser({ name: "Auto Owner" });
		const user = { id, email, name: "Auto Owner" };
		const { organizationId } = await ensurePersonalOrganization(user);

		const rules = await listEntityApprovalPolicies(
			organizationId,
			"connector_action",
		);
		expect(rules).toHaveLength(1);
		expect(rules[0]).toMatchObject({
			principalKind: null,
			connectorKey: null,
			connectionId: null,
			operationKey: null,
			operationCategory: null,
			effects: { execute: "auto" },
		});
		for (const kind of ["read", "write"] as const) {
			expect(await decide(organizationId, kind)).toEqual({
				effect: "auto",
				ruleIds: [rules[0].id],
				reason: "matched_rule",
			});
		}

		expect(
			await deleteEntityApprovalPolicy({
				organizationId,
				resourceClass: "connector_action",
			}),
		).toBe(true);
		const again = await ensurePersonalOrganization(user);
		expect(again.created).toBe(false);
		expect(
			await listEntityApprovalPolicies(organizationId, "connector_action"),
		).toHaveLength(0);
		for (const kind of ["read", "write"] as const) {
			expect(await decide(organizationId, kind)).toEqual({
				effect: "approval",
				ruleIds: [],
				reason: "default_approval",
			});
		}
	});

	it.each([
		["absent metadata", null],
		["empty marker", JSON.stringify({ personal_org_for_user_id: "" })],
		["invalid JSON", "{not json"],
	])("keeps orgs with %s on the Reads-only Auto rule", async (_label, metadata) => {
		const orgId = `org_${generateSecureToken(8)}`;
		await getTestDb()`
      INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
      VALUES (${orgId}, 'Team', ${`team-${generateSecureToken(4).toLowerCase()}`}, 'private', ${metadata}, NOW())
    `;
		const rules = await listEntityApprovalPolicies(orgId, "connector_action");
		expect(rules).toHaveLength(1);
		expect(rules[0]).toMatchObject({
			operationCategory: "read",
			effects: { execute: "auto" },
		});
		expect((await decide(orgId, "read")).effect).toBe("auto");
		expect((await decide(orgId, "write")).effect).toBe("approval");
	});
});

async function readWorkspaceEvents(organizationId: string) {
	const sql = getTestDb();
	return sql`
    SELECT title, semantic_type, metadata, payload_data, created_by
    FROM events
    WHERE organization_id = ${organizationId}
      AND semantic_type = 'change'
      AND metadata->>'category' = 'workspace'
    ORDER BY id ASC
  `;
}

/** Audit writers are fire-and-forget; poll briefly for rows to land. */
async function waitForEvents(
	organizationId: string,
	expectedCount: number,
): Promise<unknown[]> {
	const deadline = Date.now() + 2000;
	let rows: unknown[] = [];
	while (Date.now() < deadline) {
		rows = await readWorkspaceEvents(organizationId);
		if (rows.length >= expectedCount) return rows;
		await new Promise((r) => setTimeout(r, 50));
	}
	return rows;
}

describe("personal org workspace audit events", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("writes organization-created + owner-member-created audit events", async () => {
		const { id, email } = await seedUser({ name: "Audit Me" });

		const res = await ensurePersonalOrganization({
			id,
			email,
			name: "Audit Me",
			username: null,
		});
		expect(res.created).toBe(true);

		const rows = await waitForEvents(res.organizationId, 2);
		expect(rows).toHaveLength(2);

		const all = rows as unknown as Array<{
			title: string;
			semantic_type: string;
			metadata: {
				resource_kind: string;
				op: string;
				category: string;
				_lobu_workspace_audit?: boolean;
			};
			payload_data: { state: Record<string, unknown> | null };
			created_by: string;
		}>;
		// Fire-and-forget writers, so no insertion-order guarantee — resolve
		// rows by kind instead of position.
		const orgRow = all.find((r) => r.metadata.resource_kind === "organization");
		const memberRow = all.find((r) => r.metadata.resource_kind === "member");
		expect(orgRow).toBeDefined();
		expect(memberRow).toBeDefined();

		expect(orgRow!.semantic_type).toBe("change");
		expect(orgRow!.metadata.category).toBe("workspace");
		// Server-owned discriminator — exclusion predicates gate on this, not
		// category alone. Emission must stamp it or visibility tests pass while
		// real rows stay readable to ordinary members.
		expect(orgRow!.metadata._lobu_workspace_audit).toBe(true);
		expect(orgRow!.metadata.resource_kind).toBe("organization");
		expect(orgRow!.metadata.op).toBe("created");
		expect(orgRow!.title).toContain("Organization");
		expect(orgRow!.payload_data.state).toEqual({
			id: res.organizationId,
			name: "Audit Me",
			slug: res.slug,
			visibility: "private",
		});
		expect(orgRow!.created_by).toBe(id);

		expect(memberRow!.metadata.resource_kind).toBe("member");
		expect(memberRow!.metadata._lobu_workspace_audit).toBe(true);
		expect(memberRow!.metadata.op).toBe("created");
		expect(memberRow!.title).toContain("joined as owner");
		expect(
			(memberRow!.payload_data.state as Record<string, unknown>).role,
		).toBe("owner");
		expect(memberRow!.created_by).toBe(id);
	});

	it("does not re-emit audit events for an existing personal org", async () => {
		const { id, email } = await seedUser({ name: "Audit Me" });
		const first = await ensurePersonalOrganization({
			id,
			email,
			name: "Audit Me",
			username: null,
		});
		expect(first.created).toBe(true);

		const second = await ensurePersonalOrganization({
			id,
			email,
			name: "Audit Me",
			username: null,
		});
		expect(second.created).toBe(false);

		const rows = await waitForEvents(first.organizationId, 2);
		expect(rows).toHaveLength(2);
	});
});
