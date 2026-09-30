/**
 * Cross-tenant regression test for the org-less `AgentConfigStore` read path.
 *
 * `agents` is keyed `(organization_id, id)` with no global unique index on
 * `id`, so a per-org agent has one row per tenant. `getSettings`/`getMetadata` used to fall back to a bare
 * `WHERE id = $agentId` — no `LIMIT`, no `ORDER BY` — and return `rows[0]`,
 * leaking an arbitrary tenant's config and letting its `owner_*` columns decide
 * authorization. The org-less HTTP path is real: the settings-cookie routes
 * authenticate without a Better Auth user, so no `orgContext` is opened.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../../__tests__/setup/test-db";
import { createTestOrganization } from "../../../__tests__/setup/test-fixtures";
import { orgContext } from "../org-context";
import { createPostgresAgentConfigStore } from "../postgres-stores";

const SHARED_AGENT_ID = "lobu-builder";

describe("org-less agent config reads must not cross tenants", () => {
	let orgA: string;
	let orgB: string;

	beforeEach(async () => {
		await cleanupTestDatabase();
		const a = await createTestOrganization({ name: "Tenant A" });
		const b = await createTestOrganization({ name: "Tenant B" });
		orgA = a.id;
		orgB = b.id;

		const config = createPostgresAgentConfigStore();
		for (const [orgId, label] of [
			[orgA, "A"],
			[orgB, "B"],
		] as const) {
			await orgContext.run({ organizationId: orgId }, async () => {
				await config.saveMetadata(SHARED_AGENT_ID, {
					agentId: SHARED_AGENT_ID,
					name: `Builder ${label}`,
					owner: { platform: "lobu", userId: `owner-${label}` },
					createdAt: Date.now(),
				});
				await config.saveSettings(SHARED_AGENT_ID, {
					models: [`provider-${label}/model-${label}`],
					soulMd: `secret soul for ${label}`,
				});
			});
		}
	});

	afterEach(cleanupTestDatabase);

	it("proves the shared id really has one row per tenant (no global unique on agents.id)", async () => {
		const db = getTestDb();
		const rows = await db`
			SELECT organization_id FROM agents WHERE id = ${SHARED_AGENT_ID}
		`;
		expect(rows.length).toBe(2);
		expect(
			new Set(rows.map((r: { organization_id: string }) => r.organization_id)),
		).toEqual(new Set([orgA, orgB]));
	});

	it("getSettings with no ambient org returns null instead of an arbitrary tenant's config", async () => {
		const config = createPostgresAgentConfigStore();

		const settings = await config.getSettings(SHARED_AGENT_ID);

		expect(settings).toBeNull();
	});

	it("getMetadata with no ambient org returns null instead of an arbitrary tenant's row", async () => {
		const config = createPostgresAgentConfigStore();

		const metadata = await config.getMetadata(SHARED_AGENT_ID);

		expect(metadata).toBeNull();
	});

	it("still resolves each tenant's own row when the org context is set", async () => {
		const config = createPostgresAgentConfigStore();

		const settingsA = await orgContext.run({ organizationId: orgA }, () =>
			config.getSettings(SHARED_AGENT_ID),
		);
		const settingsB = await orgContext.run({ organizationId: orgB }, () =>
			config.getSettings(SHARED_AGENT_ID),
		);
		const metaA = await orgContext.run({ organizationId: orgA }, () =>
			config.getMetadata(SHARED_AGENT_ID),
		);
		const metaB = await orgContext.run({ organizationId: orgB }, () =>
			config.getMetadata(SHARED_AGENT_ID),
		);

		expect(settingsA?.soulMd).toBe("secret soul for A");
		expect(settingsB?.soulMd).toBe("secret soul for B");
		expect(settingsA?.models).toEqual(["provider-A/model-A"]);
		expect(settingsB?.models).toEqual(["provider-B/model-B"]);
		expect(metaA?.name).toBe("Builder A");
		expect(metaB?.name).toBe("Builder B");
		expect(metaA?.organizationId).toBe(orgA);
		expect(metaB?.organizationId).toBe(orgB);
	});
});
