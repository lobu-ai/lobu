/**
 * Per-org agent-id PK regression test.
 *
 * Pre-Phase-C, the `agents` table had a single-column PK on `id`, so two orgs
 * could not share an agent id (a stale `food-ordering` in one org silently
 * blocked another org from using the same name). Phase C swapped the PK to
 * `(organization_id, id)` and widened every per-(agent, …) UNIQUE on the FK
 * children with `organization_id`.
 *
 * This test pins that contract end-to-end through the storage interfaces:
 * two agents with the same id but different orgs coexist; their grants and
 * user-agent associations are independent; and writes scope by org.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTestDatabase,
	getTestDb,
} from "../../../__tests__/setup/test-db";
import { createTestOrganization } from "../../../__tests__/setup/test-fixtures";
import { UserAgentsStore } from "../../../gateway/auth/user-agents-store";
import { GrantStore } from "../../../gateway/permissions/grant-store";
import { orgContext } from "../org-context";
import { createPostgresAgentConfigStore } from "../postgres-stores";

describe("agents per-org PK — same agent id in two orgs", () => {
	let orgA: string;
	let orgB: string;
	const sharedAgentId = "shared-id";

	beforeEach(async () => {
		await cleanupTestDatabase();
		const a = await createTestOrganization({ name: "Org A" });
		const b = await createTestOrganization({ name: "Org B" });
		orgA = a.id;
		orgB = b.id;
	});

	afterEach(async () => {
		const db = getTestDb();
		await db`TRUNCATE agents CASCADE`;
	});

	it('lets two orgs each own an agent named "shared-id" without colliding', async () => {
		const config = createPostgresAgentConfigStore();

		await orgContext.run({ organizationId: orgA }, async () => {
			await config.saveMetadata(sharedAgentId, {
				agentId: sharedAgentId,
				name: "Agent in A",
				owner: { platform: "lobu", userId: "u-a" },
				createdAt: Date.now(),
			});
		});

		// Same agent id in a different org must succeed (pre-fix: throws
		// "already exists in another organization").
		await orgContext.run({ organizationId: orgB }, async () => {
			await config.saveMetadata(sharedAgentId, {
				agentId: sharedAgentId,
				name: "Agent in B",
				owner: { platform: "lobu", userId: "u-b" },
				createdAt: Date.now(),
			});
		});

		// Each org sees only its own row.
		const fromA = await orgContext.run({ organizationId: orgA }, () =>
			config.getMetadata(sharedAgentId),
		);
		const fromB = await orgContext.run({ organizationId: orgB }, () =>
			config.getMetadata(sharedAgentId),
		);

		expect(fromA?.name).toBe("Agent in A");
		expect(fromB?.name).toBe("Agent in B");

		// listAgents is org-scoped — neither org sees the other's row.
		const listA = await orgContext.run({ organizationId: orgA }, () =>
			config.listAgents(),
		);
		const listB = await orgContext.run({ organizationId: orgB }, () =>
			config.listAgents(),
		);
		expect(listA.map((a) => a.agentId)).toEqual([sharedAgentId]);
		expect(listB.map((a) => a.agentId)).toEqual([sharedAgentId]);

		// Deleting in A leaves B's row intact.
		await orgContext.run({ organizationId: orgA }, () =>
			config.deleteMetadata(sharedAgentId),
		);
		const stillInB = await orgContext.run({ organizationId: orgB }, () =>
			config.getMetadata(sharedAgentId),
		);
		const goneFromA = await orgContext.run({ organizationId: orgA }, () =>
			config.getMetadata(sharedAgentId),
		);
		expect(stillInB?.name).toBe("Agent in B");
		expect(goneFromA).toBeNull();
	});

	it("org-less settings/metadata reads return null instead of an arbitrary tenant's row", async () => {
		// The settings-cookie routes authenticate without a Better Auth user, so
		// no orgContext is open. A bare `WHERE id = $agentId` read returned
		// rows[0] from whichever tenant came first, leaking its config and
		// letting its owner_* columns decide authorization.
		const config = createPostgresAgentConfigStore();
		for (const [orgId, label] of [
			[orgA, "A"],
			[orgB, "B"],
		] as const) {
			await orgContext.run({ organizationId: orgId }, async () => {
				await config.saveMetadata(sharedAgentId, {
					agentId: sharedAgentId,
					name: `Builder ${label}`,
					owner: { platform: "lobu", userId: `owner-${label}` },
					createdAt: Date.now(),
				});
				await config.saveSettings(sharedAgentId, {
					models: [`provider-${label}/model-${label}`],
					soulMd: `secret soul for ${label}`,
				});
			});
		}

		expect(await config.getSettings(sharedAgentId)).toBeNull();
		expect(await config.getMetadata(sharedAgentId)).toBeNull();

		const settingsA = await orgContext.run({ organizationId: orgA }, () =>
			config.getSettings(sharedAgentId),
		);
		const settingsB = await orgContext.run({ organizationId: orgB }, () =>
			config.getSettings(sharedAgentId),
		);
		expect(settingsA).toMatchObject({ soulMd: "secret soul for A", models: ["provider-A/model-A"] });
		expect(settingsB).toMatchObject({ soulMd: "secret soul for B", models: ["provider-B/model-B"] });
		const metaB = await orgContext.run({ organizationId: orgB }, () =>
			config.getMetadata(sharedAgentId),
		);
		expect(metaB).toMatchObject({ name: "Builder B", organizationId: orgB });
	});

	it("keeps grants and agent_users isolated per org for the same agent id", async () => {
		const config = createPostgresAgentConfigStore();
		const grantStore = new GrantStore();
		const userAgentsStore = new UserAgentsStore();

		// Seed both orgs with the same agent id.
		for (const orgId of [orgA, orgB]) {
			await orgContext.run({ organizationId: orgId }, async () => {
				await config.saveMetadata(sharedAgentId, {
					agentId: sharedAgentId,
					name: `Agent in ${orgId}`,
					owner: { platform: "lobu", userId: "u" },
					createdAt: Date.now(),
				});
			});
		}

		// Org A grants `*.example.com`; Org B grants `*.other.com`.
		await orgContext.run({ organizationId: orgA }, () =>
			grantStore.grant(sharedAgentId, "*.example.com", null, undefined, orgA),
		);
		await orgContext.run({ organizationId: orgB }, () =>
			grantStore.grant(sharedAgentId, "*.other.com", null, undefined, orgB),
		);

		const grantsA = await orgContext.run({ organizationId: orgA }, () =>
			grantStore.listGrants(sharedAgentId),
		);
		const grantsB = await orgContext.run({ organizationId: orgB }, () =>
			grantStore.listGrants(sharedAgentId),
		);
		// GrantStore normalizes *.domain → .domain on write.
		expect(grantsA.map((g) => g.pattern)).toEqual([".example.com"]);
		expect(grantsB.map((g) => g.pattern)).toEqual([".other.com"]);

		// hasGrant scopes by the active org context.
		const aSeesExampleGrant = await orgContext.run(
			{ organizationId: orgA },
			() => grantStore.hasGrant(sharedAgentId, "*.example.com"),
		);
		const bSeesExampleGrant = await orgContext.run(
			{ organizationId: orgB },
			() => grantStore.hasGrant(sharedAgentId, "*.example.com"),
		);
		expect(aSeesExampleGrant).toBe(true);
		expect(bSeesExampleGrant).toBe(false);

		// user-agent associations: same (platform, user, agent) triple in two
		// orgs is allowed because the PK is now (organization_id, agent_id,
		// platform, user_id).
		await userAgentsStore.addAgent("telegram", "tg-user", sharedAgentId, orgA);
		await userAgentsStore.addAgent("telegram", "tg-user", sharedAgentId, orgB);
		const ownsInA = await userAgentsStore.ownsAgent(
			"telegram",
			"tg-user",
			sharedAgentId,
			orgA,
		);
		const ownsInB = await userAgentsStore.ownsAgent(
			"telegram",
			"tg-user",
			sharedAgentId,
			orgB,
		);
		expect(ownsInA).toBe(true);
		expect(ownsInB).toBe(true);
	});
});
