/**
 * Slack channel visibility gate — END TO END through `search_memory`.
 *
 * Proves the authz program's core guarantee for chat recall: an agent bound to
 * BOTH a channel the user belongs to (#eng) and one they DON'T (#secret)
 * surfaces only #eng's transcript when that user asks — connection-sourced data
 * never reaches a user beyond their access in the source system. Also proves the
 * two fail-closed edges (unresolved requester sees nothing of an enforced
 * connection) and that a connection WITHOUT a materialized ACL graph requires
 * its recorded owner, not merely workspace or agent access.
 */

import { normalizeSlackUserId } from "@lobu/connectors/slack-identity";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	invalidateSlackConnectionAcl,
	resolveSlackBotIdentity,
	syncSlackConnectionAcl,
} from "../../../authz/slack-acl-sync";
import { createPostgresAppInstallationStore } from "../../../lobu/stores/app-installation-store";
import { createSlackWebApi } from "../../../gateway/connections/slack-web";
import {
	slackAclSource,
	slackChannelsToResources,
} from "@lobu/connectors/slack-identity";
import { buildAccessGraph } from "../../../authz/access-graph";
import { gatherLocalRecall, type RecallContext, search } from "../../../tools/search";
import { clearEntityLinkRulesCache } from "../../../utils/entity-link-upsert";
import { ensureMemberEntity } from "../../../utils/member-entity";
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
} from "../../setup/test-fixtures";

const TEAM = "T01ACME";
const CONN = "conn-acme";

type SearchCtx = Parameters<typeof search>[2];

async function seedSignedInMember(opts: {
  orgId: string;
  userId: string;
  name: string;
  slackUserId: string;
}): Promise<number> {
  const sql = getTestDb();
  const entity = await createTestEntity({
    name: opts.name,
		entity_type: "$member",
    organization_id: opts.orgId,
    created_by: opts.userId,
  });
  const combined = normalizeSlackUserId(TEAM, opts.slackUserId);
  await sql`
    INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
    VALUES
      (${opts.orgId}, ${entity.id}, 'auth_user_id', ${opts.userId}, 'auth:signup'),
      (${opts.orgId}, ${entity.id}, 'slack_user_id', ${combined}, 'connector:slack')
  `;
  return entity.id;
}

/** Bind a channel to the agent (with team id) and drop one matching message. */
async function bindChannel(opts: {
  orgId: string;
  agentId: string;
  channelId: string;
  text: string;
}): Promise<void> {
  const sql = getTestDb();
  await createTestAutomationSubscription({
    organizationId: opts.orgId,
    agentId: opts.agentId,
    connectionSlug: `agentconn-${CONN}`,
    platform: "slack",
    channelId: opts.channelId,
    teamId: TEAM,
  });
  await sql`
    INSERT INTO channel_messages (
      organization_id, connection_id, platform, channel_id,
      platform_message_id, author_name, is_bot, text, occurred_at
    ) VALUES (
      ${opts.orgId}, ${CONN}, 'slack', ${opts.channelId},
      ${`${opts.channelId}-0`}, 'Alice', false, ${opts.text}, NOW()
    )
  `;
}

function searchAs(orgId: string, userId: string | null, agentId: string) {
  return search(
		{ query: "quarterly revenue", include_content: true },
    {} as Parameters<typeof search>[1],
    { organizationId: orgId, userId, agentId } as SearchCtx,
  );
}

describe("slack channel visibility gate (e2e via search_memory)", () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  async function setupWorkspace() {
		const org = await createTestOrganization({ name: "Acme" });
		const alice = await createTestUser({ name: "Alice" });
		await addUserToOrganization(alice.id, org.id, "owner");
    const agent = await createTestAgent({ organizationId: org.id });

    // The builder auto-creates `person` entities for channel members; the type
    // must exist in the org (prod seeds default types at org creation).
    const sqlType = getTestDb();
    await sqlType`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${org.id}, 'person', 'Person', current_timestamp, current_timestamp)
      ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
      DO NOTHING
    `;

    // The bot connection + bindings to BOTH channels.
    await insertChatConnectionRow({
      id: CONN,
      agentId: agent.agentId,
			platform: "slack",
      organizationId: org.id,
			status: "active",
    });
    await bindChannel({
      orgId: org.id,
      agentId: agent.agentId,
			channelId: "C01ENG",
			text: "We discussed the quarterly revenue forecast",
    });
    await bindChannel({
      orgId: org.id,
      agentId: agent.agentId,
			channelId: "C01SEC",
			text: "Secret: the quarterly revenue numbers are confidential",
    });

    // Alice signed in + linked Slack.
    const aliceMemberId = await seedSignedInMember({
      orgId: org.id,
      userId: alice.id,
			name: "Alice",
			slackUserId: "U01ALICE",
    });
    return { org, alice, agent, aliceMemberId };
  }

	it("surfaces only the channel the user belongs to once the graph is enforced", async () => {
    const { org, alice, agent } = await setupWorkspace();

    // Alice is a member of #eng only. Bob is the lone member of #secret.
    await buildAccessGraph({
      organizationId: org.id,
      connectionId: CONN,
      connectorKey: slackAclSource.key,
      resourceNamespace: slackAclSource.resourceNamespace,
      memberIdentities: slackAclSource.memberIdentities,
      resources: slackChannelsToResources(TEAM, [
				{ channelId: "C01ENG", name: "eng", memberSlackUserIds: ["U01ALICE"] },
        {
					channelId: "C01SEC",
					name: "secret",
          isPrivate: true,
					memberSlackUserIds: ["U01BOB"],
        },
      ]),
    });

    const result = await searchAs(org.id, alice.id, agent.agentId);
		const channels = (result.conversation_messages ?? []).map(
			(m) => m.channel_id,
		);
		expect(channels).toContain("C01ENG");
		expect(channels).not.toContain("C01SEC");
  });

	it("does not authorize a channel through a tenant-scoped resource identity", async () => {
    const { org, alice, agent, aliceMemberId } = await setupWorkspace();
    await buildAccessGraph({
      organizationId: org.id,
      connectionId: CONN,
      connectorKey: slackAclSource.key,
      resourceNamespace: slackAclSource.resourceNamespace,
      memberIdentities: slackAclSource.memberIdentities,
      resources: slackChannelsToResources(TEAM, [
        { channelId: "C01ENG", name: "eng", memberSlackUserIds: ["U01ALICE"] },
      ]),
    });

    const sql = getTestDb();
    await sql`
      UPDATE entity_identities
      SET identifier = ${`${TEAM}:C01SEC`}, scope_key = 'forged-tenant'
      WHERE organization_id = ${org.id}
        AND entity_id IN (
          SELECT to_entity_id
          FROM entity_relationships relationship
          JOIN entity_relationship_types type ON type.id = relationship.relationship_type_id
          WHERE relationship.organization_id = ${org.id}
            AND relationship.from_entity_id = ${aliceMemberId}
            AND relationship.deleted_at IS NULL
            AND type.slug = 'member_of'
        )
        AND namespace = 'slack_channel_id'
        AND scope_key IS NULL
        AND deleted_at IS NULL
    `;

    const result = await searchAs(org.id, alice.id, agent.agentId);
    expect((result.conversation_messages ?? []).map((message) => message.channel_id)).not.toContain(
      "C01SEC"
    );
  });

	it("fails closed: an unresolved requester sees NONE of an enforced connection", async () => {
    const { org, agent } = await setupWorkspace();
    await buildAccessGraph({
      organizationId: org.id,
      connectionId: CONN,
      connectorKey: slackAclSource.key,
      resourceNamespace: slackAclSource.resourceNamespace,
      memberIdentities: slackAclSource.memberIdentities,
      resources: slackChannelsToResources(TEAM, [
				{ channelId: "C01ENG", name: "eng", memberSlackUserIds: ["U01ALICE"] },
        {
					channelId: "C01SEC",
					name: "secret",
          isPrivate: true,
					memberSlackUserIds: ["U01BOB"],
        },
      ]),
    });

    // A user with no $member in this org → resolves to nothing → fail closed.
		const result = await searchAs(org.id, "intruder-user-id", agent.agentId);
    expect(result.conversation_messages ?? []).toHaveLength(0);
  });

	it("revokes on departure: a member who leaves #eng loses recall on the next sync", async () => {
    const { org, alice, agent } = await setupWorkspace();
    // Alice is in #eng → can recall it.
    await buildAccessGraph({
      organizationId: org.id,
      connectionId: CONN,
      connectorKey: slackAclSource.key,
      resourceNamespace: slackAclSource.resourceNamespace,
      memberIdentities: slackAclSource.memberIdentities,
			resources: slackChannelsToResources(TEAM, [
				{ channelId: "C01ENG", name: "eng", memberSlackUserIds: ["U01ALICE"] },
			]),
    });
    const before = await searchAs(org.id, alice.id, agent.agentId);
		expect(
			(before.conversation_messages ?? []).map((m) => m.channel_id),
		).toContain("C01ENG");

    // Alice leaves #eng → re-sync with the new membership (just Bob).
    await buildAccessGraph({
      organizationId: org.id,
      connectionId: CONN,
      connectorKey: slackAclSource.key,
      resourceNamespace: slackAclSource.resourceNamespace,
      memberIdentities: slackAclSource.memberIdentities,
			resources: slackChannelsToResources(TEAM, [
				{ channelId: "C01ENG", name: "eng", memberSlackUserIds: ["U01BOB"] },
			]),
    });
    const after = await searchAs(org.id, alice.id, agent.agentId);
		expect(
			(after.conversation_messages ?? []).map((m) => m.channel_id),
		).not.toContain("C01ENG");
  });

	it("without a graph, only the recorded connection owner can recall bound channels", async () => {
    const { org, alice, agent } = await setupWorkspace();
    const sql = getTestDb();
    const colleague = await createTestUser({ name: "Colleague" });
    await addUserToOrganization(colleague.id, org.id, "admin");
    await sql`UPDATE connections SET created_by = ${alice.id}
      WHERE organization_id = ${org.id} AND slug = ${`agentconn-${CONN}`}`;
    expect((await searchAs(org.id, colleague.id, agent.agentId)).conversation_messages ?? []).toHaveLength(0);
    expect((await searchAs(org.id, null, agent.agentId)).conversation_messages ?? []).toHaveLength(0);
    const result = await searchAs(org.id, alice.id, agent.agentId);
		const channels = (result.conversation_messages ?? []).map(
			(m) => m.channel_id,
		);
		expect(channels).toContain("C01ENG");
		expect(channels).toContain("C01SEC");
    await sql`UPDATE connections SET created_by = NULL
      WHERE organization_id = ${org.id} AND slug = ${`agentconn-${CONN}`}`;
    expect((await searchAs(org.id, alice.id, agent.agentId)).conversation_messages ?? []).toHaveLength(0);
  });

	it("fails closed when the graph ages past the freshness window (no stale-membership re-exposure)", async () => {
    const { org, alice, agent } = await setupWorkspace();
    // Alice is a member of #eng → a FRESH graph lets her recall it.
    await buildAccessGraph({
      organizationId: org.id,
      connectionId: CONN,
      connectorKey: slackAclSource.key,
      resourceNamespace: slackAclSource.resourceNamespace,
      memberIdentities: slackAclSource.memberIdentities,
			resources: slackChannelsToResources(TEAM, [
				{ channelId: "C01ENG", name: "eng", memberSlackUserIds: ["U01ALICE"] },
			]),
    });
    const fresh = await searchAs(org.id, alice.id, agent.agentId);
		expect(
			(fresh.conversation_messages ?? []).map((m) => m.channel_id),
		).toContain("C01ENG");

    // The sync stops: age this connection's graph past the 60-min window. An
    // onboarded-but-stale connection must FAIL CLOSED (drop its channels), NOT
    // fall back to the ungraphed owner path — serving stale membership is the hole the
    // age-based gate closes. Alice loses recall even though she's still a member.
    const sql = getTestDb();
    await sql`
      UPDATE authz_source_acl_state
      SET last_synced_at = current_timestamp - interval '90 minutes'
      WHERE organization_id = ${org.id} AND connection_id = ${CONN}
    `;
    const stale = await searchAs(org.id, alice.id, agent.agentId);
    expect(stale.conversation_messages ?? []).toHaveLength(0);
  });

	it("enforces through the PRODUCTION sync path (syncSlackConnectionAcl), not just the test builder", async () => {
    const { org, alice, agent } = await setupWorkspace();

    // Drive the real production caller with a stubbed Slack API + token resolver,
    // exactly as runSlackAclSyncTick wires it in prod. THIS is what activates the
    // gate for a live connection — buildAccessGraph is never called by hand.
    const membersByChannel: Record<string, string[]> = {
			C01ENG: ["U01ALICE"],
			C01SEC: ["U01BOB"],
    };
    const result = await syncSlackConnectionAcl(
      {
        slackWeb: {
					conversationMembers: async (_token, channelId) =>
						membersByChannel[channelId] ?? [],
        },
				resolveBotIdentity: async () => ({
					token: "xoxb-test-token",
					botUserId: null,
				}),
      },
      { connectionId: CONN, organizationId: org.id },
    );
    expect(result.ok).toBe(true);
    expect(result.channelsSynced).toBe(2);

    // The gate now enforces off the materialized graph: Alice (member of #eng
    // only) recalls #eng, never #secret.
    const search1 = await searchAs(org.id, alice.id, agent.agentId);
		const channels = (search1.conversation_messages ?? []).map(
			(m) => m.channel_id,
		);
		expect(channels).toContain("C01ENG");
		expect(channels).not.toContain("C01SEC");
  });

	it("does not let an older in-flight sync clear a membership-removal invalidation", async () => {
		const { org } = await setupWorkspace();
		const sql = getTestDb();
		await sql`
			INSERT INTO authz_source_acl_state
				(organization_id, connection_id, acl_support, freshness_state, last_synced_at)
			VALUES (${org.id}, ${CONN}, 'full', 'fresh', current_timestamp)
		`;

		let releaseMembers!: (members: string[]) => void;
		const members = new Promise<string[]>((resolve) => {
			releaseMembers = resolve;
		});
		let fetchStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			fetchStarted = resolve;
		});
		const syncing = syncSlackConnectionAcl(
			{
				slackWeb: {
					conversationMembers: async () => {
						fetchStarted();
						return members;
					},
				},
				resolveBotIdentity: async () => ({
					token: "xoxb-test-token",
					botUserId: null,
				}),
			},
			{ connectionId: CONN, organizationId: org.id },
		);
		await started;
		await invalidateSlackConnectionAcl({
			organizationId: org.id,
			connectionId: CONN,
		});
		releaseMembers(["U01ALICE"]);
		expect((await syncing).ok).toBe(true);

		const [state] = await sql<{ freshness_state: string }>`
			SELECT freshness_state
			FROM authz_source_acl_state
			WHERE organization_id = ${org.id}
				AND connection_id = ${CONN}
		`;
		expect(state?.freshness_state).toBe("stale");
	});

	/**
	 * The same race on a connection that has NEVER been graphed, which is where a
	 * plain UPDATE silently lost: no row to flip, so the first sync's
	 * pre-departure snapshot would be blessed as `fresh` and the departed member
	 * would keep recall. The sentinel records onboarding without claiming a graph
	 * it does not have, so `acl_support` stays `'none'` — which, per
	 * `acl-state.ts`, means the connection is onboarded-but-stale and fails
	 * closed until the next sync actually builds the graph.
	 */
	it("does not let a FIRST sync bless a snapshot taken before the departure", async () => {
		const { org } = await setupWorkspace();
		const sql = getTestDb();
		await sql`
			DELETE FROM authz_source_acl_state
			WHERE organization_id = ${org.id} AND connection_id = ${CONN}
		`;

		let releaseMembers!: (members: string[]) => void;
		const members = new Promise<string[]>((resolve) => {
			releaseMembers = resolve;
		});
		let fetchStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			fetchStarted = resolve;
		});
		const syncing = syncSlackConnectionAcl(
			{
				slackWeb: {
					conversationMembers: async () => {
						fetchStarted();
						return members;
					},
				},
				resolveBotIdentity: async () => ({
					token: "xoxb-test-token",
					botUserId: null,
				}),
			},
			{ connectionId: CONN, organizationId: org.id },
		);
		await started;
		const { aclSupport } = await invalidateSlackConnectionAcl({
			organizationId: org.id,
			connectionId: CONN,
		});
		expect(aclSupport).toBe("none");
		releaseMembers(["U01ALICE"]);
		expect((await syncing).ok).toBe(true);

		const [state] = await sql<{
			freshness_state: string;
			acl_support: string;
		}>`
			SELECT freshness_state, acl_support
			FROM authz_source_acl_state
			WHERE organization_id = ${org.id}
				AND connection_id = ${CONN}
		`;
		expect(state?.freshness_state).toBe("stale");
		expect(state?.acl_support).toBe("none");
	});

	it("org-wide Grid install (conn tenant = E…, bindings carry T…) STILL graphs and stays ENFORCED", async () => {
    // Regression guard for the codex finding: once bindings carry the real
    // workspace `T…` instead of the enterprise `E…`, an org-wide install's ACL
    // sync must NOT drop every row (which would leave the connection ungraphed
    // and owner-only). connTeamId is the enterprise id here — the relaxed scope
    // filter accepts every T… binding on the connection and graphs it.
    const org = await createTestOrganization({ name: "GridCo" });
    const alice = await createTestUser({ name: "GridAlice" });
    await addUserToOrganization(alice.id, org.id, "owner");
    const agent = await createTestAgent({ organizationId: org.id });
    const sql = getTestDb();
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${org.id}, 'person', 'Person', current_timestamp, current_timestamp)
      ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
      DO NOTHING
    `;

    const ENTERPRISE = "E0BDSKL1KJL";
    const WORKSPACE = "T0BF8TKGW79";
    const GRID_CONN = "slackinst-gridco"; // managed org-wide install
    // Connection tenant id is the ENTERPRISE id (org-wide install).
    await insertChatConnectionRow({
      id: GRID_CONN,
      agentId: null,
      platform: "slack",
      organizationId: org.id,
      status: "active",
      metadata: { teamId: ENTERPRISE },
    });
    // Bindings carry the concrete WORKSPACE T… (post-invariant), NOT the E….
    for (const channel of ["C01ENG", "C01SEC"]) {
			await createTestAutomationSubscription({
				organizationId: org.id,
				agentId: agent.agentId,
				connectionSlug: GRID_CONN,
				platform: "slack",
				channelId: channel,
				teamId: WORKSPACE,
			});
      await sql`
        INSERT INTO channel_messages (
          organization_id, connection_id, platform, channel_id,
          platform_message_id, author_name, is_bot, text, occurred_at
        ) VALUES (
          ${org.id}, ${GRID_CONN}, 'slack', ${channel},
          ${`${channel}-0`}, 'Alice', false, 'quarterly revenue in this channel', NOW()
        )
      `;
    }
    // Alice signed in + linked Slack, scoped to the real WORKSPACE.
    const aliceEntity = await createTestEntity({
      name: "GridAlice",
      entity_type: "$member",
      organization_id: org.id,
      created_by: alice.id,
    });
    const aliceSlack = normalizeSlackUserId(WORKSPACE, "U01ALICE");
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES
        (${org.id}, ${aliceEntity.id}, 'auth_user_id', ${alice.id}, 'auth:signup'),
        (${org.id}, ${aliceEntity.id}, 'slack_user_id', ${aliceSlack}, 'connector:slack')
    `;

    // Drive the REAL production sync. resolveBotIdentity is stubbed (as in prod
    // wiring). The graph is keyed on the binding's WORKSPACE T… (slack-acl-sync
    // groups by binding team), and members resolve on that same T….
    const membersByChannel: Record<string, string[]> = {
      C01ENG: ["U01ALICE"],
      C01SEC: ["U01BOB"],
    };
    const result = await syncSlackConnectionAcl(
      {
        slackWeb: {
          conversationMembers: async (_t, channelId) =>
            membersByChannel[channelId] ?? [],
        },
        resolveBotIdentity: async () => ({
          token: "xoxb-grid-token",
          botUserId: null,
        }),
      },
      { connectionId: GRID_CONN, organizationId: org.id },
    );
    // Pre-fix: connTeamId=E… ≠ binding T… dropped BOTH rows → 0 synced →
    // connection never graphed → gate falls back to the owner-only path (NOT
    // enforced). Post-fix: both channels graph and the gate enforces.
    expect(result.ok).toBe(true);
    expect(result.channelsSynced).toBe(2);

    const asAlice = search(
      { query: "quarterly revenue", include_content: true },
      {} as Parameters<typeof search>[1],
      { organizationId: org.id, userId: alice.id, agentId: agent.agentId } as SearchCtx,
    );
    const channels = ((await asAlice).conversation_messages ?? []).map(
      (m) => m.channel_id,
    );
    // ENFORCED (not the owner-only path): Alice (member of #eng only) recalls
    // #eng, never #secret. Had the connection stayed ungraphed she'd see neither,
    // since she isn't its recorded owner — that is the downgrade this guards against.
    expect(channels).toContain("C01ENG");
    expect(channels).not.toContain("C01SEC");
  });

	it("org-wide Grid install: resolves the bot credential by the slackinst- install id via the REAL resolveSlackBotIdentity (NOT the team-keyed miss), then graphs + ENFORCES", async () => {
    // The load-bearing half of the ACL-sync fix, driven WITHOUT stubbing
    // resolveBotIdentity: a Grid org-wide install's app_installations row is
    // keyed on the ENTERPRISE id (E…), so getSlackInstallByTeamId(T…) MISSES for
    // the sibling workspace. resolveSlackBotIdentity must resolve the token by
    // the connection's slackinst- slug (= the install external_id) via
    // getSlackInstallById instead. If it can't, it returns null → sync throws →
    // connection marked ACL-failed → the gate drops ALL channels (fail-closed
    // OUTAGE). This proves the by-id branch, the graph build, and enforcement.
    const org = await createTestOrganization({ name: "GridById" });
    const alice = await createTestUser({ name: "GridByIdAlice" });
    await addUserToOrganization(alice.id, org.id, "owner");
    const agent = await createTestAgent({ organizationId: org.id });
    const sql = getTestDb();
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${org.id}, 'person', 'Person', current_timestamp, current_timestamp)
      ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
      DO NOTHING
    `;

    const ENTERPRISE = "E0GRIDENT99";
    const WORKSPACE = "T0GRIDWS123";
    const INSTALL_ID = "slackinst-grid-byid";
    const ENTERPRISE_TOKEN = "xoxb-enterprise-token"; // plaintext ⇒ no-op secret store
    const BOT_USER = "U0GRIDBOT";

    // The connection: slug IS the install external id (slackinst-…), tenant id is
    // the ENTERPRISE id (org-wide install). No BYO token on the connection — the
    // ONLY way to a token is the install, resolved by id.
    await insertChatConnectionRow({
      id: INSTALL_ID,
      agentId: null,
      platform: "slack",
      organizationId: org.id,
      status: "active",
      metadata: { teamId: ENTERPRISE },
    });
    // The REAL org-wide app_installations row: external_tenant_id = E…,
    // external_id = the slackinst- slug, is_enterprise_install=true, a bot token.
    // getSlackInstallByTeamId(T0GRIDWS123) will NOT match this (its tenant is E…);
    // getSlackInstallById(slackinst-grid-byid) WILL.
    await sql`
      INSERT INTO app_installations
        (organization_id, provider, provider_instance, provider_app_id,
         external_tenant_id, status, metadata)
      VALUES
        (${org.id}, 'slack', 'cloud', 'cloud', ${ENTERPRISE}, 'active',
         ${sql.json({
           external_id: INSTALL_ID,
           is_enterprise_install: true,
           enterprise_id: ENTERPRISE,
           bot_user_id: BOT_USER,
           config: { platform: "slack", botToken: ENTERPRISE_TOKEN },
         })})
    `;
    // Bindings carry the concrete sibling WORKSPACE T… (post-invariant).
    for (const channel of ["C01ENG", "C01SEC"]) {
			await createTestAutomationSubscription({
				organizationId: org.id,
				agentId: agent.agentId,
				connectionSlug: INSTALL_ID,
				platform: "slack",
				channelId: channel,
				teamId: WORKSPACE,
			});
      await sql`
        INSERT INTO channel_messages (
          organization_id, connection_id, platform, channel_id,
          platform_message_id, author_name, is_bot, text, occurred_at
        ) VALUES (
          ${org.id}, ${INSTALL_ID}, 'slack', ${channel},
          ${`${channel}-0`}, 'Alice', false, 'quarterly revenue in this channel', NOW()
        )
      `;
    }
    // Alice signed in + linked Slack, scoped to the real WORKSPACE.
    const aliceEntity = await createTestEntity({
      name: "GridByIdAlice",
      entity_type: "$member",
      organization_id: org.id,
      created_by: alice.id,
    });
    const aliceSlack = normalizeSlackUserId(WORKSPACE, "U01ALICE");
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES
        (${org.id}, ${aliceEntity.id}, 'auth_user_id', ${alice.id}, 'auth:signup'),
        (${org.id}, ${aliceEntity.id}, 'slack_user_id', ${aliceSlack}, 'connector:slack')
    `;

    // A no-op secret store: the install's botToken is plaintext, so
    // resolveSecretValue returns it verbatim without ever calling `.get`.
    const secretStore = {
      get: async () => undefined,
    } as unknown as Parameters<typeof resolveSlackBotIdentity>[0]["secretStore"];
    const installStore = createPostgresAppInstallationStore();
    const slackWeb = createSlackWebApi();

    // Capture the token each membership fetch is made with — it MUST be the
    // enterprise install token, which proves the by-id resolution hit.
    const fetchedWithTokens: string[] = [];
    const result = await syncSlackConnectionAcl(
      {
        slackWeb: {
          conversationMembers: async (token, channelId) => {
            fetchedWithTokens.push(token);
            return channelId === "C01ENG" ? ["U01ALICE"] : ["U01BOB"];
          },
          conversationInfo: async () => ({
            name: "eng",
            isPrivate: false,
            contextTeamId: WORKSPACE,
          }),
        },
        // The REAL production resolver — NOT stubbed. This is the whole point.
        resolveBotIdentity: (params) =>
          resolveSlackBotIdentity({ installStore, secretStore, slackWeb }, params),
      },
      { connectionId: INSTALL_ID, organizationId: org.id },
    );

    // Credential resolved by the install id: the enterprise token was used to
    // fetch every channel's members. A miss would have returned null → throw →
    // ok:false, channelsSynced:0 → ACL-failed.
    expect(result.ok).toBe(true);
    expect(result.channelsSynced).toBe(2);
    expect(fetchedWithTokens.length).toBe(2);
    expect(fetchedWithTokens.every((t) => t === ENTERPRISE_TOKEN)).toBe(true);

    // Directly assert the by-id resolution too (independent of the sync loop):
    // asked to graph the sibling WORKSPACE T…, it returns the enterprise token +
    // bot id — even though getSlackInstallByTeamId(T…) would miss.
    const identity = await resolveSlackBotIdentity(
      { installStore, secretStore, slackWeb },
      { organizationId: org.id, teamId: WORKSPACE, connectionId: INSTALL_ID },
    );
    expect(identity).toEqual({ token: ENTERPRISE_TOKEN, botUserId: BOT_USER });

    // The connection is now ENFORCED (authz_source_acl_state full+fresh), NOT
    // failed — so the gate enforces membership rather than dropping everything.
    const [state] = await sql<{ acl_support: string; freshness_state: string }>`
      SELECT acl_support, freshness_state FROM authz_source_acl_state
      WHERE organization_id = ${org.id} AND connection_id = ${INSTALL_ID}
    `;
    expect(state?.acl_support).toBe("full");
    expect(state?.freshness_state).toBe("fresh");

    // End-to-end through the gate: Alice (member of #eng only) recalls #eng,
    // never #secret. Legacy-fence fallback would show BOTH.
    const asAlice = search(
      { query: "quarterly revenue", include_content: true },
      {} as Parameters<typeof search>[1],
      { organizationId: org.id, userId: alice.id, agentId: agent.agentId } as SearchCtx,
    );
    const channels = ((await asAlice).conversation_messages ?? []).map(
      (m) => m.channel_id,
    );
    expect(channels).toContain("C01ENG");
    expect(channels).not.toContain("C01SEC");
  });

	it("scopes the production sync to the connection workspace — a second workspace never leaks in", async () => {
    const { org, agent } = await setupWorkspace();
    const sql = getTestDb();
    // CONN is the Acme (T01ACME) workspace bot.
    await sql`
      UPDATE connections
      SET external_tenant_id = ${TEAM},
          config = jsonb_set(config, '{chatMetadata,teamId}', to_jsonb(${TEAM}::text))
      WHERE slug = ${`agentconn-${CONN}`} AND organization_id = ${org.id}
    `;
    // A binding to a channel in a DIFFERENT workspace (the same agent's second
    // Slack connection) must NOT be synced under CONN — otherwise CONN would
    // fetch it with the wrong token and fail closed, or stamp it under itself.
		await createTestAutomationSubscription({
			organizationId: org.id,
			agentId: agent.agentId,
			connectionSlug: `agentconn-${CONN}`,
			platform: "slack",
			channelId: "C02FOREIGN",
			teamId: "T02OTHER",
		});

    const fetched: string[] = [];
    const result = await syncSlackConnectionAcl(
      {
        slackWeb: {
          conversationMembers: async (_t, channelId) => {
            fetched.push(channelId);
						return ["U01ALICE"];
          },
        },
        // Only the Acme workspace has a token — reaching T02OTHER would fail closed.
        resolveBotIdentity: async ({ teamId }) =>
					teamId === TEAM
						? { token: "xoxb-test-token", botUserId: null }
						: null,
      },
      { connectionId: CONN, organizationId: org.id },
    );

    // The foreign channel is excluded, so the sync stays green and only Acme's
    // channels are fetched. Pre-fix this threw (no token for T02OTHER) → ok=false.
    expect(result.ok).toBe(true);
    expect(result.channelsSynced).toBe(2);
		expect(fetched.sort()).toEqual(["C01ENG", "C01SEC"]);
  });

	it("resolves a member provisioned through the REAL path (ensureMemberEntity), not a hand-seeded identity", async () => {
    // setupWorkspace seeds Alice via seedSignedInMember, which writes the
    // auth_user_id identity by hand. THIS test instead provisions a second user
    // (Carol) the way production does — through ensureMemberEntity (the
    // shared-org join path) — and DOES NOT touch entity_identities for her
    // auth_user_id. If ensureMemberEntity stops writing that identity, Carol
    // resolves to nothing and the gate fails closed → this test goes red. That
    // is the production gap the hand-seeded tests masked.
    const { org, agent } = await setupWorkspace();
		// Carol's user row must own the email her $member is provisioned under —
		// exactly as the real path does, where ensureMemberEntity is always called
		// with the signed-in user's own email. ensureMemberEntity now enforces this
		// (a mismatched userId/email is refused), so a bare createTestUser (which
		// auto-generates an email) would make the guard fail closed here.
		const carol = await createTestUser({
			name: "Carol",
			email: "carol@acme.test",
		});
		await addUserToOrganization(carol.id, org.id, "member");

    // Real provisioning — writes the $member entity AND its auth_user_id identity.
    await ensureMemberEntity({
      organizationId: org.id,
      userId: carol.id,
			name: "Carol",
			email: "carol@acme.test",
			role: "member",
			status: "active",
    });
    // The Slack link is a separate real mechanism (Connect-my-DM / email claim);
    // attach it so the channel member collapses onto Carol's $member.
    const sql = getTestDb();
    const memberRows = await sql<{ entity_id: number }>`
      SELECT entity_id FROM entity_identities
      WHERE organization_id = ${org.id}
        AND namespace = 'email' AND identifier = 'carol@acme.test'
        AND deleted_at IS NULL
      LIMIT 1
    `;
    // The email identity is written by ensureMemberEntity-adjacent provisioning;
    // fall back to looking the member up by metadata if email identity is absent.
		let memberEntityId: number | null =
			memberRows.length > 0 ? Number(memberRows[0].entity_id) : null;
    if (memberEntityId === null) {
      const byMeta = await sql<{ id: number }>`
        SELECT e.id FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id AND et.slug = '$member'
        WHERE e.organization_id = ${org.id}
          AND e.metadata->>'email' = 'carol@acme.test'
          AND e.deleted_at IS NULL
        LIMIT 1
      `;
      memberEntityId = byMeta.length > 0 ? Number(byMeta[0].id) : null;
    }
    expect(memberEntityId).not.toBeNull();
		const combined = normalizeSlackUserId(TEAM, "U01CAROL");
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES (${org.id}, ${memberEntityId}, 'slack_user_id', ${combined}, 'connector:slack')
    `;

    // Carol is a member of #eng only.
    await buildAccessGraph({
      organizationId: org.id,
      connectionId: CONN,
      connectorKey: slackAclSource.key,
      resourceNamespace: slackAclSource.resourceNamespace,
      memberIdentities: slackAclSource.memberIdentities,
      resources: slackChannelsToResources(TEAM, [
				{ channelId: "C01ENG", name: "eng", memberSlackUserIds: ["U01CAROL"] },
				{
					channelId: "C01SEC",
					name: "secret",
					isPrivate: true,
					memberSlackUserIds: ["U01BOB"],
				},
      ]),
    });

    const result = await searchAs(org.id, carol.id, agent.agentId);
		const channels = (result.conversation_messages ?? []).map(
			(m) => m.channel_id,
		);
		expect(channels).toContain("C01ENG");
		expect(channels).not.toContain("C01SEC");
  });

	it("reconciles a STALE channel to no members (revokes recall) while still graphing the readable ones", async () => {
    const { org, alice, agent } = await setupWorkspace();

    // Round 1: BOTH channels readable, Alice is a member of BOTH. She can recall
    // #eng and #secret.
    const round1 = await syncSlackConnectionAcl(
      {
        slackWeb: {
					conversationMembers: async () => ["U01ALICE"],
        },
				resolveBotIdentity: async () => ({
					token: "xoxb-test-token",
					botUserId: null,
				}),
      },
      { connectionId: CONN, organizationId: org.id },
    );
    expect(round1.ok).toBe(true);
    const recalled1 = (
      await searchAs(org.id, alice.id, agent.agentId)
    ).conversation_messages?.map((m) => m.channel_id);
		expect(recalled1).toContain("C01ENG");
		expect(recalled1).toContain("C01SEC");

    // Round 2: the bot is kicked from #secret (channel_not_found). #eng stays
    // readable. The connection must NOT fail-close (pre-fix it did, 0 graphed),
    // AND #secret's stale member_of edges must be reconciled away — otherwise
    // Alice keeps recalling a channel the bot can no longer see (fail-OPEN).
    const round2 = await syncSlackConnectionAcl(
      {
        slackWeb: {
          conversationMembers: async (_t, channelId) => {
						if (channelId === "C01SEC") {
							throw new Error(
								"Slack conversations.members failed: channel_not_found",
							);
            }
						return ["U01ALICE"];
          },
        },
				resolveBotIdentity: async () => ({
					token: "xoxb-test-token",
					botUserId: null,
				}),
      },
      { connectionId: CONN, organizationId: org.id },
    );
    expect(round2.ok).toBe(true);

    const recalled2 = (
      await searchAs(org.id, alice.id, agent.agentId)
    ).conversation_messages?.map((m) => m.channel_id);
		expect(recalled2).toContain("C01ENG"); // still readable → still recalled
		expect(recalled2).not.toContain("C01SEC"); // kicked → recall revoked
  });

	it("still FAILS CLOSED on a systemic Slack error (not a stale-channel error)", async () => {
    const { org } = await setupWorkspace();
    const errorLines: string[] = [];
    const errorLog = vi.spyOn(console, "error").mockImplementation((line) => {
      errorLines.push(String(line));
    });
    // A rate-limit / auth error is systemic — it must propagate and fail the
    // connection closed, not be swallowed like a stale-channel error.
    try {
      const result = await syncSlackConnectionAcl(
        {
          slackWeb: {
            conversationMembers: async () => {
              throw new Error("Slack conversations.members failed: ratelimited");
            },
          },
          resolveBotIdentity: async () => ({
            token: "xoxb-test-token",
            botUserId: null,
          }),
        },
        { connectionId: CONN, organizationId: org.id },
      );
      expect(result.ok).toBe(false);
      expect(result.channelsSynced).toBe(0);
      expect(errorLines.join("\n")).toContain(`"organization_id":"${org.id}"`);
      expect(errorLines.join("\n")).toContain(`"connection_id":"${CONN}"`);
    } finally {
      errorLog.mockRestore();
    }
  });

	it("production sync FAILS CLOSED for an already-graphed connection when Slack fetch throws", async () => {
    const { org, alice, agent } = await setupWorkspace();
    // First a good sync so the connection has a materialized (enforced) graph.
    await syncSlackConnectionAcl(
      {
				slackWeb: { conversationMembers: async () => ["U01ALICE"] },
				resolveBotIdentity: async () => ({
					token: "xoxb-test-token",
					botUserId: null,
				}),
      },
      { connectionId: CONN, organizationId: org.id },
    );
		expect(
			(await searchAs(org.id, alice.id, agent.agentId)).conversation_messages ??
				[],
		).not.toHaveLength(0);

    // Slack outage on the next tick: ANY channel fetch throws → the sync must
    // mark the connection failed (not leave a half-synced graph), and the gate
    // then drops every channel until a later tick succeeds.
    const result = await syncSlackConnectionAcl(
      {
        slackWeb: {
          conversationMembers: async () => {
						throw new Error("slack outage");
          },
        },
				resolveBotIdentity: async () => ({
					token: "xoxb-test-token",
					botUserId: null,
				}),
      },
      { connectionId: CONN, organizationId: org.id },
    );
    expect(result.ok).toBe(false);
    const after = await searchAs(org.id, alice.id, agent.agentId);
    expect(after.conversation_messages ?? []).toHaveLength(0);
  });

	/**
	 * GRID regression: one connection, two workspaces, ONE connection-wide ACL
	 * state row. The stamp must not land until every workspace is reconciled.
	 *
	 * Pre-fix, `buildAccessGraph` stamped inside the per-team loop, so finishing
	 * workspace 1 flipped the connection to `fresh` while workspace 2 still held
	 * its pre-revocation edges — reopening the gate over a membership Slack had
	 * already contradicted. Asserted from INSIDE workspace 2's fetch, which is
	 * exactly the window that was open.
	 */
	it("does not mark a Grid connection fresh until every workspace is reconciled", async () => {
		const { org, alice, agent } = await setupWorkspace();
		const sql = getTestDb();
		const TEAM_B = "T02SIBLING";

		// A second workspace on the SAME connection, bound to its own channel.
		await createTestAutomationSubscription({
			organizationId: org.id,
			agentId: agent.agentId,
			connectionSlug: `agentconn-${CONN}`,
			platform: "slack",
			channelId: "C02OPS",
			teamId: TEAM_B,
		});

		// The connection starts invalidated, as a `member_left_channel` webhook
		// would leave it: onboarded but not enforcing, so recall fails closed.
		await invalidateSlackConnectionAcl({
			organizationId: org.id,
			connectionId: CONN,
		});

		// Observed at the moment workspace 2's membership is fetched — i.e. after
		// workspace 1's graph build has fully completed.
		const seen: { team: string; state: string | null }[] = [];
		const teamsFetched: string[] = [];

		const result = await syncSlackConnectionAcl(
			{
				slackWeb: {
					conversationMembers: async (token, channelId) => {
						const rows = await sql<{ freshness_state: string }[]>`
							SELECT freshness_state FROM authz_source_acl_state
							WHERE organization_id = ${org.id} AND connection_id = ${CONN}
						`;
						seen.push({
							team: token,
							state: rows[0]?.freshness_state ?? null,
						});
						return channelId === "C01SEC" ? ["U01BOB"] : ["U01ALICE"];
					},
				},
				resolveBotIdentity: async ({ teamId }) => {
					teamsFetched.push(teamId);
					return { token: teamId, botUserId: null };
				},
			},
			{ connectionId: CONN, organizationId: org.id },
		);

		expect(result.ok).toBe(true);
		// Both workspaces really were synced — otherwise the assertion below is
		// vacuous (a single-workspace sync can't exhibit the mid-loop stamp).
		expect(new Set(teamsFetched)).toEqual(new Set([TEAM, TEAM_B]));
		const secondWorkspaceReads = seen.filter((s) => s.team === TEAM_B);
		expect(secondWorkspaceReads.length).toBeGreaterThan(0);
		// THE REGRESSION: not one fetch, in either workspace, may observe the
		// connection already blessed fresh.
		expect(seen.every((s) => s.state !== "fresh")).toBe(true);

		// And the stamp does land once the loop completes, so this is proving
		// ordering — not that the stamp was lost.
		const finalState = await sql<{ freshness_state: string }[]>`
			SELECT freshness_state FROM authz_source_acl_state
			WHERE organization_id = ${org.id} AND connection_id = ${CONN}
		`;
		expect(finalState[0]?.freshness_state).toBe("fresh");
		const recalled = (
			await searchAs(org.id, alice.id, agent.agentId)
		).conversation_messages?.map((m) => m.channel_id);
		expect(recalled).toContain("C01ENG");
		expect(recalled).not.toContain("C01SEC");
	});

	it("resolves an in-Slack requester via slack_user_id when they have no auth identity", async () => {
    const { org, agent } = await setupWorkspace();
    // Dave is a Slack-only user (never signed in to the web app → no auth_user_id).
    // The graph auto-creates his person entity with a slack_user_id claim + a
    // member_of edge to #eng.
    await buildAccessGraph({
      organizationId: org.id,
      connectionId: CONN,
      connectorKey: slackAclSource.key,
      resourceNamespace: slackAclSource.resourceNamespace,
      memberIdentities: slackAclSource.memberIdentities,
      resources: slackChannelsToResources(TEAM, [
				{ channelId: "C01ENG", name: "eng", memberSlackUserIds: ["U01DAVE"] },
				{
					channelId: "C01SEC",
					name: "secret",
					isPrivate: true,
					memberSlackUserIds: ["U01BOB"],
				},
      ]),
    });

    // ctx.userId is Dave's bare Slack id (the in-Slack message author), NOT an
    // auth_user_id — the auth lookup misses, so this only passes via the
    // slack_user_id fallback. Without it, Dave fails closed and sees nothing.
		const result = await searchAs(org.id, "U01DAVE", agent.agentId);
		const channels = (result.conversation_messages ?? []).map(
			(m) => m.channel_id,
		);
		expect(channels).toContain("C01ENG");
		expect(channels).not.toContain("C01SEC");
  });

  // Local-recall seam regression: the explicit gate is the only ACL input.
	it("gatherLocalRecall denies a non-member principal but serves a member", async () => {
    const { org, alice, agent } = await setupWorkspace();
    await buildAccessGraph({
      organizationId: org.id,
      connectionId: CONN,
      connectorKey: slackAclSource.key,
      resourceNamespace: slackAclSource.resourceNamespace,
      memberIdentities: slackAclSource.memberIdentities,
      resources: slackChannelsToResources(TEAM, [
				{ channelId: "C01ENG", name: "eng", memberSlackUserIds: ["U01ALICE"] },
				{
					channelId: "C01SEC",
					name: "secret",
					isPrivate: true,
					memberSlackUserIds: ["U01BOB"],
				},
      ]),
    });

    const ctx = {
			query: "quarterly revenue",
      contentAgentId: undefined,
      contentLimit: 20,
      workspaceSlug: org.slug,
    } as unknown as RecallContext;

    // A member sees only her own channel (#eng), never #secret.
    const asMember = await gatherLocalRecall(
      { organizationId: org.id, principal: alice.id, agentId: agent.agentId },
      ctx,
    );
		const memberChannels = (asMember.conversation_messages ?? []).map(
			(m) => m.channel_id,
		);
		expect(memberChannels).toContain("C01ENG");
		expect(memberChannels).not.toContain("C01SEC");

    // A principal with no $member in this org resolves to nothing → fail closed.
    const asNonMember = await gatherLocalRecall(
			{
				organizationId: org.id,
				principal: "intruder-user-id",
				agentId: agent.agentId,
			},
			ctx,
    );
    expect(asNonMember.conversation_messages ?? []).toHaveLength(0);
  });
});
