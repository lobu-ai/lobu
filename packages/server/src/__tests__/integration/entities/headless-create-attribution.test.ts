/**
 * The real `manage_entity` create call site under a headless automation session.
 *
 * `resolveWriteCreatorUserId` is unit- and helper-integration-tested, but the
 * wiring at manage_entity.ts — `ctx.actingAutomationId` → `sessionAutomationId`
 * → `entities.created_by` — was unproven, and the test DB seeds a literal
 * `system` user row (setup/test-db.ts) so the ORIGINAL FK violation
 * (`entities_created_by_fkey` on the `"system"` sentinel) is invisible to the
 * suite. This drives a create with `userId: null` + `actingAutomationId` set,
 * exactly as the script executor does, and asserts the row is attributed to the
 * automation's human owner — a real user id and a valid FK target — the
 * regression guard that keeps manage_entity from sliding back to the sentinel.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { manageEntity } from "../../../tools/admin/manage_entity";
import type { ToolContext } from "../../../tools/registry";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
	seedSystemEntityTypes,
} from "../../setup/test-fixtures";

const env = {} as Env;
const AUTOMATION_ID = 7101;

// An "auto" entity-write policy for the owner agent, so the create clears the
// mutation gate and actually reaches the insert (where created_by is stamped).
async function autoCreatePolicy(organizationId: string, agentId: string) {
	const sql = getTestDb();
	const [policy] = await sql<{ id: number }[]>`
		INSERT INTO write_approval_policies (
			organization_id, resource_class, principal_kind, principal_id
		) VALUES (${organizationId}, 'entity', 'agent', ${agentId})
		RETURNING id
	`;
	await sql`
		INSERT INTO write_policy_action_effects (policy_id, action, effect)
		VALUES (${policy.id}, 'create', 'auto')
	`;
}

describe("manage_entity create — headless automation attribution", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		await seedSystemEntityTypes();
	});

	it("stamps entities.created_by with the automation owner, never the 'system' sentinel", async () => {
		const org = await createTestOrganization({ name: "Headless Create Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		await autoCreatePolicy(org.id, agent.agentId);

		const sql = getTestDb();
		await sql`
      INSERT INTO entity_types (
        organization_id, slug, name, metadata_schema, created_at, updated_at
      ) VALUES (
        ${org.id}, 'brand', 'Brand', ${sql.json({ type: "object" })},
        current_timestamp, current_timestamp
      )
    `;
		// A headless script-executor session acts as this automation; its create
		// must attribute to the automation's creator, not ctx.userId (null here).
		await sql`
      INSERT INTO automations
        (id, organization_id, managed_agent_id, created_by, automation_group_id, name,
         status, min_cooldown_seconds, created_at, updated_at)
      VALUES
        (${AUTOMATION_ID}, ${org.id}, ${agent.agentId}, ${user.id}, ${AUTOMATION_ID},
         'Precall scan', 'active', 0, now(), now())
    `;

		const headlessCtx = {
			organizationId: org.id,
			userId: null,
			agentId: agent.agentId,
			actingAutomationId: AUTOMATION_ID,
			memberRole: "owner",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
			mcpSessionId: "session-headless-create",
		} as ToolContext;

		const res = (await manageEntity(
			{
				action: "create",
				entity_type: "brand",
				name: "Acme Corp",
				slug: "acme-headless-create",
			},
			env,
			headlessCtx,
		)) as { action: string; entity?: { id: number } };

		expect(res.action).toBe("create");
		const entityId = res.entity?.id;
		expect(entityId).toBeTruthy();

		const [row] = (await sql`
      SELECT created_by FROM entities WHERE id = ${entityId}
    `) as Array<{ created_by: string }>;
		expect(row.created_by).toBe(user.id);
		expect(row.created_by).not.toBe("system");
	});
});
