/**
 * Owner-routed approvals — the resolution halves:
 *
 *  1. Propose-time owner resolution: proposeEntityFieldChange records
 *     action_input.owner_user_id ONLY when the gated fields have exactly one
 *     distinct field_controls.set_by. Mixed owners or $-attribute-only
 *     proposals record nothing (admin-only automation).
 *  2. Delivery-tier selection: resolveOwnerDmTarget picks the owner's chat
 *     identity on a platform one of the org's bot connections is bound to;
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
		await linkChatIdentityInGraph({
			organizationId: orgId,
			platform: "slack",
			userId: owner.id,
			teamId: TEAM_ID,
			platformUserId: "U-DMOWNER",
		});
		const target = await resolveOwnerDmTarget(orgId, owner.id);
		expect(target).toEqual({
			connectionId,
			platform: "slack",
			platformUserId: "U-DMOWNER",
		});
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
		await linkChatIdentityInGraph({
			organizationId: orgId,
			platform: "slack",
			userId: twin.id,
			teamId: "TDUPTEAM",
			platformUserId: "U-FIRST",
		});
		await linkChatIdentityInGraph({
			organizationId: otherOrg.id,
			platform: "slack",
			userId: twin.id,
			teamId: "TDUPTEAM",
			platformUserId: "U-SECOND",
		});

		expect(
			await resolveChatUserIdForUser(twin.id, "slack", "TDUPTEAM"),
		).toBeNull();
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
			// Delegation configured, so the connection can actually originate the
			// DM and is a legitimate owner-DM candidate. Without it the candidate
			// is correctly skipped — the sibling test above pins that half.
			config: { impersonateUser: "chat-bot@example.com" },
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

		// The ADDRESSABLE form, not the bare stored key: the chat SDK routes a DM
		// by inferring the adapter from the `users/` prefix, so a bare account id
		// would not reach Google Chat at all.
		expect(await resolveOwnerDmTarget(gOrg.id, gOwner.id)).toEqual({
			connectionId: gConnectionId,
			platform: "gchat",
			platformUserId: "users/110000000000000000003",
		});
	});

	it("does NOT pin an owner DM to a gchat connection that cannot open one", async () => {
		// `google_user_id` is stamped by ANY Google sign-in, in every org the
		// user belongs to — nobody has to intend a chat link. So a gchat-bound
		// org acquires owner-DM candidates involuntarily, and Chat can only
		// REUSE an existing DM space unless the connection carries
		// `impersonateUser`. Pinning here would suppress the channel fallback and
		// strand the notification in neither place, so the candidate is skipped
		// and delivery stays on the channel.
		const noDmOrg = await createTestOrganization({ name: "No Delegation Org" });
		const noDmOwner = await createTestUser({ name: "Undeliverable Owner" });
		await addUserToOrganization(noDmOwner.id, noDmOrg.id, "member");
		const noDmAgent = await createTestAgent({
			organizationId: noDmOrg.id,
			ownerUserId: noDmOwner.id,
			agentId: "agent-no-delegation",
			name: "No Delegation Agent",
		});
		await insertChatConnectionRow({
			id: "conn-gchat-nodeleg",
			organizationId: noDmOrg.id,
			platform: "gchat",
			metadata: {},
		});
		await createTestAutomationSubscription({
			organizationId: noDmOrg.id,
			agentId: noDmAgent.agentId,
			connectionSlug: "agentconn-conn-gchat-nodeleg",
			platform: "gchat",
			channelId: "gchat:spaces/AAQNoDeleg",
		});
		await linkChatIdentityInGraph({
			organizationId: noDmOrg.id,
			userId: noDmOwner.id,
			platform: "gchat",
			platformUserId: "users/110000000000000000005",
		});

		// The identity resolves — this is NOT a linkage failure.
		expect(
			await resolveChatUserIdForUser(noDmOwner.id, "gchat", null),
		).toBe("users/110000000000000000005");
		// but the connection cannot originate the DM, so no owner DM is pinned.
		expect(await resolveOwnerDmTarget(noDmOrg.id, noDmOwner.id)).toBeNull();
	});

	it("treats a blank impersonateUser as no delegation at all", async () => {
		// The adapter gates on `if (this.impersonateUser)`, so an empty or
		// whitespace-only subject is no subject and `spaces.setup` still cannot
		// create the DM. A presence-only check here would read that as
		// "delegation configured", pin the DM, and lose the notification.
		const blankOrg = await createTestOrganization({ name: "Blank Deleg Org" });
		const blankOwner = await createTestUser({ name: "Blank Deleg Owner" });
		await addUserToOrganization(blankOwner.id, blankOrg.id, "member");
		const blankAgent = await createTestAgent({
			organizationId: blankOrg.id,
			ownerUserId: blankOwner.id,
			agentId: "agent-blank-deleg",
			name: "Blank Deleg Agent",
		});
		await insertChatConnectionRow({
			id: "conn-gchat-blank",
			organizationId: blankOrg.id,
			platform: "gchat",
			metadata: {},
			config: { impersonateUser: "   " },
		});
		await createTestAutomationSubscription({
			organizationId: blankOrg.id,
			agentId: blankAgent.agentId,
			connectionSlug: "agentconn-conn-gchat-blank",
			platform: "gchat",
			channelId: "gchat:spaces/AAQBlank",
		});
		await linkChatIdentityInGraph({
			organizationId: blankOrg.id,
			userId: blankOwner.id,
			platform: "gchat",
			platformUserId: "users/110000000000000000007",
		});

		expect(await resolveOwnerDmTarget(blankOrg.id, blankOwner.id)).toBeNull();
	});

	it("reads the LIVE connection's config, not a soft-deleted twin's", async () => {
		// `connections_chat_slug_unique` is UNIQUE (slug) WHERE credential_mode IS
		// NOT NULL AND deleted_at IS NULL, so slug is unique only among LIVE chat
		// rows and a soft-deleted row may hold the same slug. Prod has plenty of
		// repeated slugs for exactly this reason. An unfiltered `LIMIT 1` could
		// read the dead row — here that would see its delegation and wrongly pin a
		// DM the live, undelegated connection can never open.
		const sql = getTestDb();
		const twinOrg = await createTestOrganization({ name: "Deleted Twin Org" });
		const twinOwner = await createTestUser({ name: "Twin Owner" });
		await addUserToOrganization(twinOwner.id, twinOrg.id, "member");
		const twinAgent = await createTestAgent({
			organizationId: twinOrg.id,
			ownerUserId: twinOwner.id,
			agentId: "agent-deleted-twin",
			name: "Deleted Twin Agent",
		});
		// Decoy FIRST, live row second, and the order is the whole test: with no
		// ORDER BY, an unfiltered `LIMIT 1` takes whatever the scan reaches first,
		// so a decoy inserted second would be shadowed by the live row and the
		// test would pass with or without the filter — vacuous. Inserted first,
		// the dead row is what an unfiltered query actually returns.
		await sql`
      INSERT INTO connections (
        organization_id, connector_key, display_name, status, config,
        credential_mode, slug, visibility, deleted_at, created_at, updated_at
      ) VALUES (
        ${twinOrg.id}, 'gchat', 'Dead Twin', 'active',
        ${sql.json({
					impersonateUser: "ghost@example.com",
					settings: {},
					chatMetadata: {},
				})},
        'byo', 'agentconn-conn-gchat-twin', 'org', NOW(), NOW(), NOW()
      )
    `;
		// LIVE row, same slug, NO delegation — so it cannot originate a DM.
		await insertChatConnectionRow({
			id: "conn-gchat-twin",
			organizationId: twinOrg.id,
			platform: "gchat",
			metadata: {},
		});
		await createTestAutomationSubscription({
			organizationId: twinOrg.id,
			agentId: twinAgent.agentId,
			connectionSlug: "agentconn-conn-gchat-twin",
			platform: "gchat",
			channelId: "gchat:spaces/AAQTwin",
		});
		await linkChatIdentityInGraph({
			organizationId: twinOrg.id,
			userId: twinOwner.id,
			platform: "gchat",
			platformUserId: "users/110000000000000000008",
		});

		expect(await resolveOwnerDmTarget(twinOrg.id, twinOwner.id)).toBeNull();
	});

	it("an org on BOTH platforms DMs on the one it bound first", async () => {
		// Now that every platform is a candidate, `resolveBotDeliveryTargets`
		// order decides the PLATFORM, not just the connection. It orders by
		// `created_at ASC` — the org's primary channel — so the owner keeps
		// getting DMs where they already got them instead of the destination
		// hopping the day a second platform is connected. Both identities resolve
		// here, so only the order can pick the winner.
		const mixOrg = await createTestOrganization({ name: "Both Platforms Org" });
		const mixOwner = await createTestUser({ name: "Dual Linked Owner" });
		await addUserToOrganization(mixOwner.id, mixOrg.id, "member");
		const mixAgent = await createTestAgent({
			organizationId: mixOrg.id,
			ownerUserId: mixOwner.id,
			agentId: "agent-mixed-dm",
			name: "Mixed DM Agent",
		});
		await insertChatConnectionRow({
			id: "conn-mixed-slack",
			organizationId: mixOrg.id,
			platform: "slack",
			metadata: { teamId: "TMIXED" },
		});
		await insertChatConnectionRow({
			id: "conn-mixed-gchat",
			organizationId: mixOrg.id,
			platform: "gchat",
			metadata: {},
		});
		// Slack binding FIRST, so it holds the earlier `created_at`.
		await createTestAutomationSubscription({
			organizationId: mixOrg.id,
			agentId: mixAgent.agentId,
			connectionSlug: "agentconn-conn-mixed-slack",
			platform: "slack",
			channelId: "slack:C-MIXED",
			teamId: "TMIXED",
		});
		await createTestAutomationSubscription({
			organizationId: mixOrg.id,
			agentId: mixAgent.agentId,
			connectionSlug: "agentconn-conn-mixed-gchat",
			platform: "gchat",
			channelId: "gchat:spaces/AAQMixed",
		});
		await linkChatIdentityInGraph({
			organizationId: mixOrg.id,
			platform: "slack",
			userId: mixOwner.id,
			teamId: "TMIXED",
			platformUserId: "U-MIXED",
		});
		await linkChatIdentityInGraph({
			organizationId: mixOrg.id,
			userId: mixOwner.id,
			platform: "gchat",
			platformUserId: "users/110000000000000000004",
		});

		expect(await resolveOwnerDmTarget(mixOrg.id, mixOwner.id)).toEqual({
			connectionId: "conn-mixed-slack",
			platform: "slack",
			platformUserId: "U-MIXED",
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
		expect(await resolveChatUserIdForUser(gOwner.id, "gchat", null)).toBe(
			"users/110000000000000000002",
		);
	});

	it("REFUSES a team-scoped platform with no team rather than widening", async () => {
		// The security half of the scope contract. Slack ids repeat across
		// workspaces, so "no team" must mean refuse, never "scan the namespace" —
		// otherwise this returns an id from whichever workspace happens to match.
		const scoped = await createTestUser({ name: "Scoped Only" });
		await addUserToOrganization(scoped.id, orgId, "member");
		await linkChatIdentityInGraph({
			organizationId: orgId,
			platform: "slack",
			userId: scoped.id,
			teamId: "TNOWIDEN",
			platformUserId: "U-SCOPED",
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
		await linkChatIdentityInGraph({
			organizationId: orgId,
			platform: "slack",
			userId: roamer.id,
			teamId: "TXDMOWNER",
			platformUserId: "U-ROAMER",
		});
		expect(
			await resolveChatUserIdForUser(roamer.id, "slack", "TXDMOWNER"),
		).toBe("U-ROAMER");
		expect(
			await resolveChatUserIdForUser(roamer.id, "slack", "T_DMOWNER"),
		).toBeNull();
	});
});
