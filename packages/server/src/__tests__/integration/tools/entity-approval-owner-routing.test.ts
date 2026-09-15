/**
 * Owner-routed approvals — the resolution halves:
 *
 *  1. Propose-time owner resolution: proposeEntityFieldChange records
 *     action_input.owner_user_id ONLY when the gated fields have exactly one
 *     distinct field_controls.set_by. Mixed owners or $-attribute-only
 *     proposals record nothing (admin-only automation).
 *  2. Delivery-tier selection: resolveOwnerDmTarget picks the owner's Slack
 *     identity in a workspace one of the org's bot connections is bound to;
 *     no identity → null (caller falls back to channel delivery).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { resolveChatUserIdForUser } from "../../../lobu/stores/chat-identity";
import { resolveOwnerDmTarget } from "../../../notifications/service";
import { proposeEntityFieldChange } from "../../../tools/admin/entity-field-approval";
import type { ToolContext } from "../../../tools/registry";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAutomationSubscription } from "../../setup/automation-subscriptions";
import {
	addUserToOrganization,
	createTestAgent,
	createTestEntity,
	createTestOrganization,
	createTestUser,
	insertChatConnectionRow,
	linkChatIdentityInGraph,
	linkSlackIdentityInGraph,
} from "../../setup/test-fixtures";

const TEAM_ID = "T-OWNERROUTE";

function agentCtx(organizationId: string): ToolContext {
	return {
		organizationId,
		userId: null,
		agentId: "agent-owner-routing",
		memberRole: null,
		isAuthenticated: true,
		tokenType: "oauth",
		scopedToOrg: true,
	} as unknown as ToolContext;
}

async function seedOwnedEntity(
	orgId: string,
	createdBy: string,
	name: string,
	controls: Record<string, { set_by: string }>,
): Promise<number> {
	const sql = getTestDb();
	const entity = await createTestEntity({
		name,
		organization_id: orgId,
		created_by: createdBy,
	});
	await sql`
    UPDATE entities SET
      metadata = ${sql.json({ severity: "high", status: "open" })},
      field_controls = ${sql.json(controls)}
    WHERE id = ${entity.id}
  `;
	return entity.id;
}

async function proposedOwner(runId: number): Promise<string | null> {
	const rows = await getDb()<{ owner: string | null }>`
    SELECT action_input->>'owner_user_id' AS owner FROM runs WHERE id = ${runId}
  `;
	return rows[0]?.owner ?? null;
}

describe("owner-routed approvals — resolution", () => {
	let orgId: string;
	let alice: { id: string };
	let bob: { id: string };

	beforeAll(async () => {
		await initWorkspaceProvider();
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Owner Routing Org" });
		orgId = org.id;
		alice = await createTestUser({ name: "Alice" });
		bob = await createTestUser({ name: "Bob" });
		await addUserToOrganization(alice.id, orgId, "member");
		await addUserToOrganization(bob.id, orgId, "member");
	});

	it("records the owner when ONE user owns all gated fields (unowned fields don't break it)", async () => {
		const entityId = await seedOwnedEntity(orgId, alice.id, "Single Owner", {
			severity: { set_by: alice.id },
		});
		// `status` is gated but unowned; `severity` is Alice's → exactly one owner.
		const res = await proposeEntityFieldChange(agentCtx(orgId), {
			entity_id: entityId,
			fields: { severity: "critical", status: "closed" },
			current: { severity: "high", status: "open" },
			attribution: "agent",
		});
		expect(await proposedOwner(res.runId)).toBe(alice.id);
	});

	it("records NO owner when two users own different gated fields", async () => {
		const entityId = await seedOwnedEntity(orgId, alice.id, "Mixed Owners", {
			severity: { set_by: alice.id },
			status: { set_by: bob.id },
		});
		const res = await proposeEntityFieldChange(agentCtx(orgId), {
			entity_id: entityId,
			fields: { severity: "critical", status: "closed" },
			current: { severity: "high", status: "open" },
			attribution: "agent",
		});
		expect(await proposedOwner(res.runId)).toBeNull();
	});

	it("records NO owner when only reserved $-attributes are gated", async () => {
		const entityId = await seedOwnedEntity(orgId, alice.id, "Attr Only", {
			severity: { set_by: alice.id },
		});
		const res = await proposeEntityFieldChange(agentCtx(orgId), {
			entity_id: entityId,
			fields: { $name: "Renamed" },
			current: { $name: "Attr Only" },
			attribution: "agent",
		});
		expect(await proposedOwner(res.runId)).toBeNull();
	});
});

describe("owner-routed approvals — DM delivery tier selection", () => {
	let orgId: string;
	let owner: { id: string };
	let connectionId: string;

	beforeAll(async () => {
		const sql = getTestDb();
		const org = await createTestOrganization({ name: "Owner DM Org" });
		orgId = org.id;
		owner = await createTestUser({ name: "DM Owner" });
		await addUserToOrganization(owner.id, orgId, "member");

		const agent = await createTestAgent({
			organizationId: orgId,
			ownerUserId: owner.id,
			agentId: "agent-dm-tier",
			name: "DM Tier Agent",
		});
		connectionId = "conn-dm-tier";
		await insertChatConnectionRow({
			id: connectionId,
			organizationId: orgId,
			platform: "slack",
			metadata: { teamId: TEAM_ID },
		});
		await createTestAutomationSubscription({
			organizationId: orgId,
			agentId: agent.agentId,
			connectionSlug: `agentconn-${connectionId}`,
			platform: "slack",
			channelId: "slack:C-BOUND",
			teamId: TEAM_ID,
		});
	});

	it("picks the owner's Slack identity in the connected workspace", async () => {
		await linkSlackIdentityInGraph({
			organizationId: orgId,
			userId: owner.id,
			teamId: TEAM_ID,
			slackUserId: "U-DMOWNER",
		});
		const target = await resolveOwnerDmTarget(orgId, owner.id);
		expect(target).toEqual({ connectionId, platformUserId: "U-DMOWNER" });
	});

	it("returns null when the owner has no Slack identity (caller falls back)", async () => {
		const stranger = await createTestUser({ name: "No Identity" });
		await addUserToOrganization(stranger.id, orgId, "member");
		expect(await resolveOwnerDmTarget(orgId, stranger.id)).toBeNull();
	});

	it("FAILS CLOSED when one user holds two Slack ids under the same team", async () => {
		// The stamps are org-scoped rows and are never deleted when superseded, so
		// a user in two orgs — or whose Slack account id changed inside one
		// workspace — can hold two DISTINCT ids under the same `TEAM:` prefix.
		// The caller uses this as a DM RECIPIENT, so picking arbitrarily would
		// send the owner DM to a stale Slack account and lose it silently.
		const twin = await createTestUser({ name: "Two Workspaces One Team" });
		await addUserToOrganization(twin.id, orgId, "member");
		const otherOrg = await createTestOrganization({ name: "Second Org" });
		await addUserToOrganization(twin.id, otherOrg.id, "member");
		await linkSlackIdentityInGraph({
			organizationId: orgId,
			userId: twin.id,
			teamId: "TDUPTEAM",
			slackUserId: "U-FIRST",
		});
		await linkSlackIdentityInGraph({
			organizationId: otherOrg.id,
			userId: twin.id,
			teamId: "TDUPTEAM",
			slackUserId: "U-SECOND",
		});

		expect(await resolveChatUserIdForUser(twin.id, "slack", "TDUPTEAM")).toBeNull();
	});

	it("resolveOwnerDmTarget routes to a Google Chat connection end to end", async () => {
		// Whole path, not just the resolver: a gchat connection + binding, an owner
		// with a Google identity, and no team id anywhere. The removed
		// `target.platform !== "slack" || target.teamId == null` branch skipped
		// exactly this target, so owner DMs silently fell back to the channel.
		const gOrg = await createTestOrganization({ name: "Chat DM Org" });
		const gOwner = await createTestUser({ name: "Chat DM Owner" });
		await addUserToOrganization(gOwner.id, gOrg.id, "member");
		const gAgent = await createTestAgent({
			organizationId: gOrg.id,
			ownerUserId: gOwner.id,
			agentId: "agent-gchat-dm",
			name: "GChat DM Agent",
		});
		const gConnectionId = "conn-gchat-dm";
		await insertChatConnectionRow({
			id: gConnectionId,
			organizationId: gOrg.id,
			platform: "gchat",
			metadata: {},
		});
		await createTestAutomationSubscription({
			organizationId: gOrg.id,
			agentId: gAgent.agentId,
			connectionSlug: `agentconn-${gConnectionId}`,
			platform: "gchat",
			channelId: "gchat:spaces/AAQProof",
		});
		await linkChatIdentityInGraph({
			organizationId: gOrg.id,
			userId: gOwner.id,
			platform: "gchat",
			platformUserId: "users/110000000000000000003",
		});

		expect(await resolveOwnerDmTarget(gOrg.id, gOwner.id)).toEqual({
			connectionId: gConnectionId,
			platformUserId: "110000000000000000003",
		});
	});

	it("resolves a Google Chat owner, which carries NO team id at all", async () => {
		// The case the old `target.platform !== "slack" || target.teamId == null`
		// branch made unreachable. Google Chat events carry no workspace id and
		// its descriptor declares `userKeyScope` global, so a null team is normal
		// here rather than a refusal.
		const gOwner = await createTestUser({ name: "Chat Owner" });
		await addUserToOrganization(gOwner.id, orgId, "member");
		await linkChatIdentityInGraph({
			organizationId: orgId,
			userId: gOwner.id,
			platform: "gchat",
			platformUserId: "users/110000000000000000002",
		});
		expect(
			await resolveChatUserIdForUser(gOwner.id, "gchat", null),
		).toBe("110000000000000000002");
	});

	it("REFUSES a team-scoped platform with no team rather than widening", async () => {
		// The security half of the scope contract. Slack ids repeat across
		// workspaces, so "no team" must mean refuse, never "scan the namespace" —
		// otherwise this returns an id from whichever workspace happens to match.
		const scoped = await createTestUser({ name: "Scoped Only" });
		await addUserToOrganization(scoped.id, orgId, "member");
		await linkSlackIdentityInGraph({
			organizationId: orgId,
			userId: scoped.id,
			teamId: "TNOWIDEN",
			slackUserId: "U-SCOPED",
		});
		expect(await resolveChatUserIdForUser(scoped.id, "slack", "TNOWIDEN")).toBe(
			"U-SCOPED",
		);
		expect(await resolveChatUserIdForUser(scoped.id, "slack", null)).toBeNull();
		expect(await resolveChatUserIdForUser(scoped.id, "slack", "  ")).toBeNull();
	});

	it("matches the team prefix literally — `_` in a team id is not a LIKE wildcard", async () => {
		// `_` is legal in a team id AND a single-char LIKE wildcard, so an
		// unescaped prefix `T_DMOWNER:%` would also match `TXDMOWNER:…` and hand
		// back a user id from the wrong workspace.
		const roamer = await createTestUser({ name: "Wildcard Roamer" });
		await addUserToOrganization(roamer.id, orgId, "member");
		await linkSlackIdentityInGraph({
			organizationId: orgId,
			userId: roamer.id,
			teamId: "TXDMOWNER",
			slackUserId: "U-ROAMER",
		});
		expect(await resolveChatUserIdForUser(roamer.id, "slack", "TXDMOWNER")).toBe(
			"U-ROAMER",
		);
		expect(await resolveChatUserIdForUser(roamer.id, "slack", "T_DMOWNER")).toBeNull();
	});
});
