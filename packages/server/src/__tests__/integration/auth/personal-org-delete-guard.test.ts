/**
 * End-to-end coverage for the personal-org delete guard.
 *
 * The unit suite (`__tests__/unit/personal-org-delete-guard.test.ts`) covers the
 * marker predicate in isolation. This drives the REAL Better Auth endpoint —
 * `auth.api.deleteOrganization` with a live session against Postgres — so the
 * hook wiring itself is proven, not just the predicate it calls. That wiring is
 * the part a predicate test cannot reach: a `beforeDeleteOrganization` that was
 * never registered, or registered under a typo'd key, would still pass the unit
 * suite while leaving the org deletable.
 *
 * Why it matters: the personal org anchors device pairing (device-worker grant
 * force-binds to it), `workerOrgIds`, and auto-wire. Deleting it strands the
 * account rather than freeing a workspace.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../../auth";
import { generateSecureToken } from "../../../auth/oauth/utils";
import { ensurePersonalOrganization } from "../../../auth/personal-org-provisioning";
import type { Env } from "../../../types";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestSession } from "../../setup/test-fixtures";

async function seedUser(): Promise<{ id: string; email: string }> {
	const id = `user_${generateSecureToken(6)}`;
	const email = `${id}@test.local`;
	const sql = getTestDb();
	await sql`
    INSERT INTO "user" (id, name, email, username, "emailVerified", "createdAt", "updatedAt")
    VALUES (${id}, 'Guard Me', ${email}, null, true, NOW(), NOW())
  `;
	return { id, email };
}

async function orgExists(orgId: string): Promise<boolean> {
	const sql = getTestDb();
	const rows = await sql`SELECT 1 FROM "organization" WHERE id = ${orgId}`;
	return rows.length > 0;
}

/** Create a plain (non-personal) org owned by the user, via raw SQL. */
async function seedTeamOrg(userId: string): Promise<string> {
	const sql = getTestDb();
	const orgId = `org_${generateSecureToken(8)}`;
	const slug = `team-${generateSecureToken(6).toLowerCase()}`;
	await sql`
    INSERT INTO "organization" (id, name, slug, metadata, "createdAt")
    VALUES (${orgId}, 'Team Org', ${slug}, ${JSON.stringify({ theme: "dark" })}, NOW())
  `;
	await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`mem_${generateSecureToken(8)}`}, ${orgId}, ${userId}, 'owner', NOW())
  `;
	return orgId;
}

/**
 * `createTestSession` signs its cookie with this secret, so the auth instance
 * under test must be built with the same one or every call is UNAUTHORIZED
 * before it ever reaches the org hooks. Matches the other integration suites.
 */
const TEST_ENV = {
	...process.env,
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
} as unknown as Env;

async function deleteOrganization(
	orgId: string,
	cookieHeader: string,
): Promise<{ ok: boolean; message: string }> {
	const auth = await createAuth(TEST_ENV);
	try {
		await auth.api.deleteOrganization({
			body: { organizationId: orgId },
			headers: new Headers({ Cookie: cookieHeader }),
		});
		return { ok: true, message: "" };
	} catch (err) {
		return {
			ok: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

describe("personal org delete guard (e2e)", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("refuses to delete the caller's personal org, and the row survives", async () => {
		const { id, email } = await seedUser();
		const provisioned = await ensurePersonalOrganization({ id, email });
		const { cookieHeader } = await createTestSession(id);

		expect(await orgExists(provisioned.organizationId)).toBe(true);

		const result = await deleteOrganization(
			provisioned.organizationId,
			cookieHeader,
		);

		expect(result.ok).toBe(false);
		// The guard's own message, not a generic authz rejection — proves the
		// hook fired rather than some upstream permission check.
		expect(result.message).toMatch(/personal workspace can't be deleted/i);
		// The actual invariant: the anchor is still there.
		expect(await orgExists(provisioned.organizationId)).toBe(true);
	});

	it("still allows deleting a team org the user owns", async () => {
		const { id, email } = await seedUser();
		await ensurePersonalOrganization({ id, email });
		const { cookieHeader } = await createTestSession(id);
		const teamOrgId = await seedTeamOrg(id);

		expect(await orgExists(teamOrgId)).toBe(true);

		const result = await deleteOrganization(teamOrgId, cookieHeader);

		expect(result.ok).toBe(true);
		expect(await orgExists(teamOrgId)).toBe(false);
	});
});
