/**
 * Integration tests for the workspace-identity audit trail emitted by
 * personal-org provisioning: an `organization` created event and an `owner`
 * member created event, both `semantic_type='change'` /
 * `metadata.category='workspace'` with a redacted post-change state snapshot.
 * These rows are what make "org created" / "member joined" visible in the
 * All activity feed (the Events page's Configuration filter excludes them by category).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { generateSecureToken } from "../../../auth/oauth/utils";
import { ensurePersonalOrganization } from "../../../auth/personal-org-provisioning";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";

async function seedUser(): Promise<{ id: string; email: string }> {
	const id = `user_${generateSecureToken(6)}`;
	const email = `${id}@test.local`;
	const sql = getTestDb();
	await sql`
    INSERT INTO "user" (id, name, email, username, "emailVerified", "createdAt", "updatedAt")
    VALUES (${id}, 'Audit Me', ${email}, null, true, NOW(), NOW())
  `;
	return { id, email };
}

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
		const { id, email } = await seedUser();

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
		const { id, email } = await seedUser();
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
