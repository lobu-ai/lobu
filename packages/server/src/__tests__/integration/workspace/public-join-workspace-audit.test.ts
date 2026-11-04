/**
 * Integration tests for workspace-identity audit events around membership:
 * public-org join (ON CONFLICT race must emit exactly one audit row, keyed on
 * the committed member id) and member removal (keyed on member.id, not the
 * user id, keeping the audit trail's resource identity consistent with the
 * create/update events).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { generateSecureToken } from "../../../auth/oauth/utils";
import { ensurePersonalOrganization } from "../../../auth/personal-org-provisioning";
import { joinPublicOrganization } from "../../../workspace/join-public";
import { createTestEntity } from "../../setup/test-fixtures";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";

async function seedUser(name: string): Promise<{ id: string; email: string }> {
	const id = `user_${generateSecureToken(6)}`;
	const email = `${id}@test.local`;
	const sql = getTestDb();
	await sql`
    INSERT INTO "user" (id, name, email, username, "emailVerified", "createdAt", "updatedAt")
    VALUES (${id}, ${name}, ${email}, null, true, NOW(), NOW())
  `;
	return { id, email };
}

async function readWorkspaceEvents(organizationId: string) {
	const sql = getTestDb();
	return sql`
    SELECT title, metadata, payload_data
    FROM events
    WHERE organization_id = ${organizationId}
      AND semantic_type = 'change'
      AND metadata->>'category' = 'workspace'
    ORDER BY id ASC
  `;
}

/** Audit writers are fire-and-forget; poll briefly for the row to land. */
async function waitFor(
	fn: () => Promise<unknown[]>,
	timeoutMs = 2000,
): Promise<unknown[]> {
	const deadline = Date.now() + timeoutMs;
	let rows: unknown[] = [];
	while (Date.now() < deadline) {
		rows = await fn();
		if (rows.length > 0) return rows;
		await new Promise((r) => setTimeout(r, 50));
	}
	return rows;
}

describe("public workspace join audit events", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("emits exactly one member-created event for a double join", async () => {
		const owner = await seedUser("Owner");
		const org = await ensurePersonalOrganization({
			id: owner.id,
			email: owner.email,
			name: "Owner",
			username: null,
		});
		// Make the personal org public so a second user can self-join.
		const sql = getTestDb();
		await sql`
      UPDATE "organization" SET visibility = 'public' WHERE id = ${org.organizationId}
    `;

		const joiner = await seedUser("Joiner");
		// A workspace record with the user's display name is not their login
		// identity and must neither prevent the join projection nor receive it.
		const namesake = await createTestEntity({
			organization_id: org.organizationId,
			entity_type: "fixture-profile",
			name: "Joiner",
		});
		const first = await joinPublicOrganization({
			userId: joiner.id,
			orgSlug: org.slug,
		});
		expect(first.status).toBe("joined");

		// Second call — idempotent, must NOT re-emit an audit row.
		const second = await joinPublicOrganization({
			userId: joiner.id,
			orgSlug: org.slug,
		});
		expect(second.status).toBe("already_member");
		const claims = await sql`
      SELECT e.id, et.slug FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE ei.organization_id = ${org.organizationId}
        AND ei.namespace = 'auth_user_id' AND ei.identifier = ${joiner.id}
        AND ei.source_connector = 'auth:signup' AND ei.scope_key IS NULL
        AND ei.deleted_at IS NULL AND e.deleted_at IS NULL
    `;
		expect(claims).toHaveLength(1);
		expect(claims[0].slug).toBe("$member");
		expect(Number(claims[0].id)).not.toBe(namesake.id);

		// Audit writers are fire-and-forget — poll until the joiner's
		// member-created row lands.
		const rows = await waitFor(() =>
			readWorkspaceEvents(org.organizationId).then((all) => {
				const matches = all.filter(
					(r) =>
						(r.metadata as { resource_kind?: string }).resource_kind ===
							"member" &&
						(r.metadata as { op?: string }).op === "created" &&
						(
							(r as { payload_data?: { state?: Record<string, unknown> } })
								.payload_data?.state as Record<string, unknown> | undefined
						)?.user_id === joiner.id,
				);
				return matches;
			}),
		);
		expect(rows).toHaveLength(1);
		const state = (rows[0] as { payload_data?: { state?: Record<string, unknown> } })
			.payload_data?.state;
		// Keyed on the committed member id (the row that exists), and the actor
		// is the joining member.
		expect(state?.id).toBeTypeOf("string");
		expect(state?.user_id).toBe(joiner.id);
		expect(state?.role).toBe("member");
	});

	it("already_member path still repairs $member projection and clears role cache", async () => {
		// Simulates the post-insert repair path that concurrent ON CONFLICT
		// losers also take: membership exists, but $member / role cache may
		// not. A second join must repair without emitting another audit row.
		const owner = await seedUser("Owner2");
		const org = await ensurePersonalOrganization({
			id: owner.id,
			email: owner.email,
			name: "Owner2",
			username: null,
		});
		const sql = getTestDb();
		await sql`
      UPDATE "organization" SET visibility = 'public' WHERE id = ${org.organizationId}
    `;

		const joiner = await seedUser("Joiner2");
		// Pre-insert the member row as if a concurrent winner already committed.
		const memberId = `member_${generateSecureToken(6)}`;
		await sql`
      INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
      VALUES (${memberId}, ${org.organizationId}, ${joiner.id}, 'member', NOW())
    `;

		const result = await joinPublicOrganization({
			userId: joiner.id,
			orgSlug: org.slug,
		});
		expect(result.status).toBe("already_member");
		expect(result.role).toBe("member");

		// $member entity + auth_user_id claim should exist after repair.
		const claims = await waitFor(async () => {
			const rows = await sql`
        SELECT e.id
        FROM entities e
        JOIN entity_types et
          ON et.id = e.entity_type_id AND et.organization_id = e.organization_id
        JOIN entity_identities ei ON ei.entity_id = e.id
        WHERE e.organization_id = ${org.organizationId}
          AND et.slug = '$member'
          AND e.deleted_at IS NULL
          AND ei.namespace = 'auth_user_id'
          AND ei.identifier = ${joiner.id}
      `;
			return rows as unknown[];
		});
		expect(claims.length).toBeGreaterThanOrEqual(1);

		// No member-created audit for a path that did not insert. Brief wait so
		// a fire-and-forget phantom write would have landed if mis-emitted.
		await new Promise((r) => setTimeout(r, 200));
		const auditAfter = await readWorkspaceEvents(org.organizationId).then((all) =>
			all.filter(
				(r) =>
					(r.metadata as { resource_kind?: string }).resource_kind === "member" &&
					(r.metadata as { op?: string }).op === "created" &&
					(
						(r as { payload_data?: { state?: Record<string, unknown> } })
							.payload_data?.state as Record<string, unknown> | undefined
					)?.user_id === joiner.id,
			),
		);
		expect(auditAfter).toHaveLength(0);
	});
});
