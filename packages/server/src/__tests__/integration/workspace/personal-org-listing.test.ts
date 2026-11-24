import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getWorkspaceProvider,
	initWorkspaceProvider,
} from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";
import { get } from "../../setup/test-helpers";

describe("workspace personal marker listing", () => {
	beforeEach(async () => {
		await initWorkspaceProvider();
		await cleanupTestDatabase();
	});

	it("marks only the authenticated user personal workspace and never marks anonymous public rows", async () => {
		const sql = getTestDb();
		const personal = await createTestOrganization({ name: "Listing Personal" });
		const team = await createTestOrganization({ name: "Listing Team" });
		const publicOrg = await createTestOrganization({
			name: "Listing Public",
			visibility: "public",
		});
		const user = await createTestUser({ name: "Listing User" });
		await addUserToOrganization(user.id, personal.id, "owner");
		await addUserToOrganization(user.id, team.id, "member");
		await sql`
      UPDATE organization
      SET metadata = ${JSON.stringify({ personal_org_for_user_id: user.id })}
      WHERE id = ${personal.id}
    `;

		const provider = getWorkspaceProvider();
		const authenticated = await provider.listOrganizations(undefined, user.id);
		expect(
			authenticated.find((organization) => organization.id === personal.id)
				?.is_personal,
		).toBe(true);
		expect(
			authenticated.find((organization) => organization.id === team.id)
				?.is_personal,
		).toBe(false);
		expect(
			authenticated.find((organization) => organization.id === publicOrg.id)
				?.is_personal,
		).toBe(false);

		const anonymous = await provider.listOrganizations();
		expect(
			anonymous.every((organization) => organization.is_personal === false),
		).toBe(true);
	});

	describe("LOBU_DISCOVERABLE_ORGS", () => {
		afterEach(() => {
			delete process.env.LOBU_DISCOVERABLE_ORGS;
			delete process.env.LOBU_MANAGED_AUTH_ORGS;
		});

		async function seed() {
			const listed = await createTestOrganization({
				slug: "listed-sample",
				visibility: "public",
			});
			const unlisted = await createTestOrganization({
				slug: "unlisted-public",
				visibility: "public",
			});
			const managed = await createTestOrganization({
				slug: "managed-provider",
				visibility: "public",
			});
			const owner = await createTestUser({ name: "Unlisted Owner" });
			await addUserToOrganization(owner.id, unlisted.id, "owner");
			const visitor = await createTestUser({ name: "Visitor" });
			return { listed, unlisted, managed, owner, visitor };
		}

		const slugs = (response: { organizations: Array<{ slug: string }> }) =>
			response.organizations.map((organization) => organization.slug).sort();

		it("lists every public workspace when unset", async () => {
			await seed();
			const response = await get("/api/organizations");
			expect(response.status).toBe(200);
			expect(slugs(await response.json())).toEqual([
				"listed-sample",
				"managed-provider",
				"unlisted-public",
			]);
		});

		it("lists only the named public workspaces to non-members, keeps unlisted ones reachable by URL", async () => {
			const { unlisted, owner, visitor } = await seed();
			process.env.LOBU_DISCOVERABLE_ORGS = " Listed-Sample ,";
			process.env.LOBU_MANAGED_AUTH_ORGS = "managed-provider";

			const anonymous = await get("/api/organizations");
			expect(slugs(await anonymous.json())).toEqual([
				"listed-sample",
				"managed-provider",
			]);

			const provider = getWorkspaceProvider();
			const visitorList = await provider.listOrganizations(undefined, visitor.id);
			expect(visitorList.map((organization) => organization.slug).sort()).toEqual(
				["listed-sample", "managed-provider"],
			);

			// Members still see their own unlisted public workspace.
			const ownerList = await provider.listOrganizations(undefined, owner.id);
			expect(ownerList.map((organization) => organization.id)).toContain(
				unlisted.id,
			);

			// Unlisted is not private: its URL still opens for anyone.
			const direct = await get("/api/unlisted-public/public/organization");
			expect(direct.status).toBe(200);
		});
	});
});
