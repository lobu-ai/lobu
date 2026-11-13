import { beforeEach, describe, expect, test } from "vitest";
import { provisionMemberAndCoreIdentities } from "../../../auth/subject-identities";
import { getDb } from "../../../db/client";
import { runMemberClaimDriftCheck } from "../../../scheduled/member-claim-drift";
import { requestWorkspaceDeletion } from "../../../workspace/deletion";
import { cleanupTestDatabase } from "../../setup/test-db";

const ORG_ID = "member-drift-org";

async function seedUserAndMember(userId: string, email: string): Promise<void> {
	const sql = getDb();
	await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, ${email}, ${email}, true, now(), now())
  `;
	await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`m_${userId}`}, ${ORG_ID}, ${userId}, 'member', now())
  `;
}

describe("member claim drift detection", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
		const sql = getDb();
		await sql`
      INSERT INTO organization (id, name, slug, visibility)
      VALUES (${ORG_ID}, ${ORG_ID}, ${ORG_ID}, 'private')
    `;
	});

	test("counts missing claims and every live claim that blocks repair", async () => {
		const sql = getDb();

		await seedUserAndMember("u_healthy", "healthy@acme.test");
		await provisionMemberAndCoreIdentities(ORG_ID, {
			userId: "u_healthy",
			email: "healthy@acme.test",
			name: "Healthy",
		});

		await seedUserAndMember("u_drifted", "drifted@acme.test");

		await seedUserAndMember("u_person", "person@acme.test");
		await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${ORG_ID}, 'person', 'Person', now(), now())
      ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
      DO NOTHING
    `;
		const person = await sql<{ id: number }>`
      INSERT INTO entities (organization_id, entity_type_id, name, slug, created_by, created_at, updated_at)
      VALUES (
        ${ORG_ID},
        (SELECT id FROM entity_types WHERE organization_id = ${ORG_ID} AND slug = 'person' AND deleted_at IS NULL LIMIT 1),
        'Poison Person', 'poison-person', 'u_person', now(), now()
      )
      RETURNING id
    `;
		await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES (${ORG_ID}, ${person[0].id}, 'auth_user_id', 'u_person', 'auth:signup')
    `;

		await seedUserAndMember("u_deleted", "deleted@acme.test");
		const deleted = await provisionMemberAndCoreIdentities(ORG_ID, {
			userId: "u_deleted",
			email: "deleted@acme.test",
			name: "Deleted",
		});
		await sql`
      UPDATE entities SET deleted_at = now() WHERE id = ${deleted.memberEntityId}
    `;

		await seedUserAndMember("u_wrong_source", "wrong-source@acme.test");
		const wrongSource = await provisionMemberAndCoreIdentities(ORG_ID, {
			userId: "u_wrong_source",
			email: "wrong-source@acme.test",
			name: "Wrong Source",
		});
		await sql`
      UPDATE entity_identities
      SET source_connector = 'connector:test'
      WHERE entity_id = ${wrongSource.memberEntityId}
        AND namespace = 'auth_user_id'
        AND deleted_at IS NULL
    `;

		await expect(runMemberClaimDriftCheck()).resolves.toEqual({
			missingClaim: 4,
			poisonClaim: 3,
		});
	});

	test("ignores members of a workspace whose deletion was requested", async () => {
		const sql = getDb();
		// A live workspace's drift still counts.
		await seedUserAndMember("u_live_drifted", "live-drifted@acme.test");

		// The purge hard-deletes a deleting workspace's entities, so its $member
		// claims vanish while its `member` rows wait for the organization delete.
		const DELETING_ORG = "member-drift-deleting-org";
		await sql`
      INSERT INTO organization (id, name, slug, visibility)
      VALUES (${DELETING_ORG}, ${DELETING_ORG}, ${DELETING_ORG}, 'private')
    `;
		await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES
        ('u_purged', 'purged@acme.test', 'purged@acme.test', true, now(), now()),
        ('u_purging', 'purging@acme.test', 'purging@acme.test', true, now(), now())
    `;
		await sql`
      INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
      VALUES
        ('m_u_purged', ${DELETING_ORG}, 'u_purged', 'member', now()),
        ('m_u_purging', ${DELETING_ORG}, 'u_purging', 'member', now())
    `;
		const purging = await provisionMemberAndCoreIdentities(DELETING_ORG, {
			userId: "u_purging",
			email: "purging@acme.test",
			name: "Purging",
		});
		await sql`
      UPDATE entities SET deleted_at = now() WHERE id = ${purging.memberEntityId}
    `;
		await requestWorkspaceDeletion(sql, {
			organizationId: DELETING_ORG,
			requestedBy: null,
			actorSource: "ui",
		});

		await expect(runMemberClaimDriftCheck()).resolves.toEqual({
			missingClaim: 1,
			poisonClaim: 0,
		});
	});

	test("reports zero when every member has a resolvable claim", async () => {
		await seedUserAndMember("u_ok", "ok@acme.test");
		await provisionMemberAndCoreIdentities(ORG_ID, {
			userId: "u_ok",
			email: "ok@acme.test",
			name: "Ok",
		});

		await expect(runMemberClaimDriftCheck()).resolves.toEqual({
			missingClaim: 0,
			poisonClaim: 0,
		});
	});
});
