/**
 * Auto-provisioned personal orgs start with All actions: Auto; team orgs start
 * with Reads: Auto. Deleting either rule restores the built-in Ask default.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { generateSecureToken } from "../../../auth/oauth/utils";
import { ensurePersonalOrganization } from "../../../auth/personal-org-provisioning";
import {
	deleteEntityApprovalPolicy,
	listEntityApprovalPolicies,
	resolveConnectorPolicy,
} from "../../../authz/entity-policy";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";

async function seedUser(name: string) {
	const id = `user_${generateSecureToken(6)}`;
	const email = `${id}@test.local`;
	await getTestDb()`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${id}, ${name}, ${email}, true, NOW(), NOW())
  `;
	return { id, email, name };
}

describe("personal org default connector policy", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});
	afterAll(cleanupTestDatabase);

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
		const user = await seedUser("Auto Owner");
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
