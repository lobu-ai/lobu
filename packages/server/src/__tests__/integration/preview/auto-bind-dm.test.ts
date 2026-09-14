/**
 * Auto-binding an unlinked DM, against a real database.
 *
 * Two halves, both of which need Postgres and neither of which the bridge's
 * in-memory harness can reach: what `resolveSoleOrgAgent` decides from real
 * `agents` rows, and whether the Automation it triggers actually persists and
 * then routes — which is the thing that makes the bind survive the org gaining
 * a second agent.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AutomationSubscriptionService } from "../../../gateway/channels/automation-subscription-service";
import {
	resolveSoleOrgAgent,
	senderMayAutoBind,
} from "../../../gateway/connections/auto-bind-agent";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
	insertChatConnectionRow,
	linkSlackIdentityInGraph,
} from "../../setup/test-fixtures";

const CONNECTION_SLUG = "workspace-gchat";
const DM_CHANNEL = "gchat:spaces/DM-AUTOBIND";

describe("auto-binding an unlinked DM", () => {
	let orgId = "";
	let ownerUserId = "";

	beforeAll(async () => {
		await cleanupTestDatabase();
	});

	beforeEach(async () => {
		const org = await createTestOrganization({
			name: "Auto Bind Org",
			slug: `auto-bind-${Math.random().toString(36).slice(2, 10)}`,
		});
		orgId = org.id;
		// A real agent has an owner who belongs to the org: `createChatAutomation`
		// refuses to write one it cannot attribute a `created_by` to.
		const owner = await createTestUser();
		await addUserToOrganization(owner.id, orgId, "owner");
		ownerUserId = owner.id;
	});

	describe("resolveSoleOrgAgent", () => {
		it("returns null for an org with no agents — there is nothing to bind to", async () => {
			expect(await resolveSoleOrgAgent(orgId)).toBeNull();
		});

		it("returns the agent when the org has exactly one", async () => {
			await createTestAgent({ organizationId: orgId, ownerUserId, agentId: "support" });
			expect(await resolveSoleOrgAgent(orgId)).toBe("support");
		});

		it("returns null once the org has two — a guess is worse than asking", async () => {
			await createTestAgent({ organizationId: orgId, ownerUserId, agentId: "support" });
			await createTestAgent({ organizationId: orgId, ownerUserId, agentId: "billing" });
			expect(await resolveSoleOrgAgent(orgId)).toBeNull();
		});

		it("does not see another org's agents", async () => {
			// The scoping that keeps one tenant's roster out of another's decision:
			// an org with none stays null however many agents exist elsewhere.
			const other = await createTestOrganization({
				name: "Someone Else",
				slug: `other-${Math.random().toString(36).slice(2, 10)}`,
			});
			await createTestAgent({
				organizationId: other.id,
				agentId: "their-agent",
			});
			expect(await resolveSoleOrgAgent(orgId)).toBeNull();
		});
	});

	describe("senderMayAutoBind", () => {
		const TEAM = "T_AUTOBIND";

		it("refuses a platform with no sender-identity model at all", async () => {
			// Telegram and WhatsApp have no entry in the chat-identity registry, so a
			// tenant's bot there is reachable by any stranger on the platform. The
			// registry's null is the fail-closed verdict this gate wants.
			expect(
				await senderMayAutoBind({
					platform: "telegram",
					teamId: undefined,
					platformUserId: "12345",
					organizationId: orgId,
				}),
			).toBe(false);
		});

		it("refuses an unrecognized sender on a platform that HAS one", async () => {
			expect(
				await senderMayAutoBind({
					platform: "slack",
					teamId: TEAM,
					platformUserId: "U_STRANGER",
					organizationId: orgId,
				}),
			).toBe(false);
		});

		it("admits a linked sender who belongs to the organization", async () => {
			await linkSlackIdentityInGraph({
				organizationId: orgId,
				userId: ownerUserId,
				teamId: TEAM,
				slackUserId: "U_MEMBER",
			});
			expect(
				await senderMayAutoBind({
					platform: "slack",
					teamId: TEAM,
					platformUserId: "U_MEMBER",
					organizationId: orgId,
				}),
			).toBe(true);
		});

		it("refuses a linked sender who belongs to a DIFFERENT organization", async () => {
			// An identity resolves across every org the person belongs to, so the
			// membership read must scope the verdict to THIS connection's org —
			// otherwise anyone with a Lobu account could bind any tenant's bot.
			const other = await createTestOrganization({
				name: "Elsewhere",
				slug: `elsewhere-${Math.random().toString(36).slice(2, 10)}`,
			});
			const outsider = await createTestUser();
			await addUserToOrganization(outsider.id, other.id, "owner");
			await linkSlackIdentityInGraph({
				organizationId: other.id,
				userId: outsider.id,
				teamId: TEAM,
				slackUserId: "U_OUTSIDER",
			});
			expect(
				await senderMayAutoBind({
					platform: "slack",
					teamId: TEAM,
					platformUserId: "U_OUTSIDER",
					organizationId: orgId,
				}),
			).toBe(false);
		});
	});

	describe("the bind that follows", () => {
		it("persists an Automation that still resolves after a second agent appears", async () => {
			// The whole reason the bind is WRITTEN rather than re-resolved per
			// message: re-resolution would go ambiguous — and the DM would silently
			// stop working — the moment the org grew a second agent.
			await createTestAgent({ organizationId: orgId, ownerUserId, agentId: "support" });
			await insertChatConnectionRow({
				id: CONNECTION_SLUG,
				organizationId: orgId,
				// No owning agent: this is the OAuth-install shape.
				agentId: null,
				platform: "gchat",
				config: { platform: "gchat" },
				settings: {},
				status: "active",
			});

			const service = new AutomationSubscriptionService();
			const agentId = await resolveSoleOrgAgent(orgId);
			expect(agentId).toBe("support");

			const bound = await service.materializeConnectionFallbackLink(
				CONNECTION_SLUG,
				orgId,
				agentId as string,
				"gchat",
				DM_CHANNEL,
				undefined,
			);
			expect(bound).toBe(true);

			// Now ambiguous by the sole-agent rule...
			await createTestAgent({ organizationId: orgId, ownerUserId, agentId: "billing" });
			expect(await resolveSoleOrgAgent(orgId)).toBeNull();

			// ...but the chat still routes, because the decision was persisted.
			const subscription = await service.resolveForConnection(
				CONNECTION_SLUG,
				DM_CHANNEL,
				orgId,
				{ crossOrganization: false },
			);
			expect(subscription?.agentId).toBe("support");
		});
	});
});
