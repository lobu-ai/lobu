import { CommandRegistry } from "@lobu/core";
import {
  SLACK_IDENTITY,
  normalizeSlackUserId,
} from "@lobu/connectors/slack-identity";
import type { Context } from "hono";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { cleanupTestDatabase } from "../../__tests__/setup/test-db.js";
import { listTestAutomationSubscriptions } from "../../__tests__/setup/automation-subscriptions.js";
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
  insertChatConnectionRow,
  linkSlackIdentityInGraph,
} from "../../__tests__/setup/test-fixtures.js";
import { getDb } from "../../db/client.js";
import { registerBuiltInCommands } from "../../gateway/commands/built-in-commands.js";
import type { Env } from "../../index";
import { resolveChatUserIdentity } from "../../lobu/stores/chat-identity.js";
import {
  bindChatToAgentForOwner,
  canonicalSlackChannelId,
  consumePreviewClaim,
  createPreviewClaim,
} from "../slack";

/** Inlined from preview/slack.ts — DM channels start with `D`. */
function slackSurfaceType(channelId: string): "dm" | "channel" {
  const id = channelId.replace(/^[a-z]+:/i, "").split(":")[0]!;
  return id.startsWith("D") ? "dm" : "channel";
}

const AGENT_ID = "demo-agent";
const OTHER_AGENT_ID = "other-agent";
const TEAM_ID = "T_DEVELOPER";
const CLAIM_SLACK_CONNECTION = "claim-slack";
const CLAIM_TELEGRAM_CONNECTION = "claim-telegram";
const FOREIGN_SLACK_CONNECTION = "foreign-slack";
const FOREIGN_PREVIEW_CONNECTION = "foreign-preview-slack";
const FOREIGN_STRING_PREVIEW_CONNECTION = "foreign-string-preview-slack";
const FOREIGN_TELEGRAM_CONNECTION = "foreign-telegram";
const FOREIGN_TELEGRAM_PREVIEW_CONNECTION = "foreign-telegram-preview";
const FOREIGN_GCHAT_PREVIEW_CONNECTION = "foreign-gchat-preview";

let ORG_ID = "";
let FOREIGN_ORG_ID = "";
// A real `user` row — the binding attributes the chat Automation's `created_by`
// from the claim's `createdBy`, resolved against `"user"`, so it must be an
// actual user.
let USER_ID = "";

async function clearChatAutomations(): Promise<void> {
  await getDb()`
    UPDATE automations
    SET status = 'archived', updated_at = current_timestamp
    WHERE status = 'active'
      AND tags @> ARRAY['system:chat-link']::text[]
  `;
}

// The `link` command computes platform/surface/canonical-channel from the
// command context before calling `consumePreviewClaim`; mirror that here so the
// direct-call tests exercise the same shape a real Slack `/lobu link` produces.
function consumeSlack(args: { code: string; teamId: string; channelId: string }) {
  return consumePreviewClaim({
    code: args.code,
    platform: "slack",
    teamId: args.teamId,
    channelId: canonicalSlackChannelId(args.channelId),
    surfaceType: slackSurfaceType(args.channelId),
    connectionId: CLAIM_SLACK_CONNECTION,
    connectionOrganizationId: ORG_ID,
  });
}

interface FakeResponse {
  status: number;
  body: Record<string, unknown>;
}

function isFakeResponse(value: unknown): value is FakeResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "body" in value
  );
}

function orgUserContext(jsonBody: unknown): Context<{ Bindings: Env }> {
  return {
    var: { organizationId: ORG_ID, session: { userId: USER_ID } },
    req: { json: async () => jsonBody, header: () => undefined },
    json: (body: Record<string, unknown>, status = 200): FakeResponse => ({
      status,
      body,
    }),
  } as unknown as Context<{ Bindings: Env }>;
}

async function createClaim(
  agentId: string,
  surfaces: string[] = ["dm", "channel"],
  platform = "slack"
): Promise<string> {
  const res = await createPreviewClaim(
    orgUserContext({ agent_id: agentId, platform, surfaces })
  );
  if (!isFakeResponse(res)) throw new Error("not a json response");
  expect(res.status).toBe(200);
  return res.body.code as string;
}

describe("Slack Preview claims + channel Automations", () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({
      name: "Slack Preview Org",
      slug: "slack-preview-org",
    });
    ORG_ID = org.id;
    const user = await createTestUser({ email: "slack-preview@test.example.com" });
    USER_ID = user.id;
    await addUserToOrganization(USER_ID, ORG_ID);
    await createTestAgent({ organizationId: ORG_ID, agentId: AGENT_ID, name: "Demo" });
    await createTestAgent({
      organizationId: ORG_ID,
      agentId: OTHER_AGENT_ID,
      name: "Other",
    });
	await insertChatConnectionRow({
		id: CLAIM_SLACK_CONNECTION,
		organizationId: ORG_ID,
		platform: "slack",
		agentId: AGENT_ID,
		credentialMode: "managed",
		status: "active",
		metadata: { teamId: TEAM_ID },
	});
	await insertChatConnectionRow({
		id: CLAIM_TELEGRAM_CONNECTION,
		organizationId: ORG_ID,
		platform: "telegram",
		agentId: AGENT_ID,
		credentialMode: "managed",
		status: "active",
	});
	const foreignOrg = await createTestOrganization({
		name: "Foreign Slack Org",
		slug: "foreign-slack-org",
	});
	FOREIGN_ORG_ID = foreignOrg.id;
	await insertChatConnectionRow({
		id: FOREIGN_SLACK_CONNECTION,
		organizationId: FOREIGN_ORG_ID,
		platform: "slack",
		credentialMode: "managed",
		status: "active",
		metadata: { teamId: "T_FOREIGN" },
	});
	await insertChatConnectionRow({
		id: FOREIGN_PREVIEW_CONNECTION,
		organizationId: FOREIGN_ORG_ID,
		platform: "slack",
		credentialMode: "managed",
		settings: { previewMode: true },
		status: "active",
		metadata: { teamId: "T_HOSTED" },
	});
	await insertChatConnectionRow({
		id: FOREIGN_STRING_PREVIEW_CONNECTION,
		organizationId: FOREIGN_ORG_ID,
		platform: "slack",
		credentialMode: "managed",
		settings: { previewMode: "true" },
		status: "active",
		metadata: { teamId: "T_STRING_PREVIEW" },
	});
	await insertChatConnectionRow({
		id: FOREIGN_TELEGRAM_CONNECTION,
		organizationId: FOREIGN_ORG_ID,
		platform: "telegram",
		credentialMode: "managed",
		status: "active",
	});
	// The hosted bots an UNBOUND claim (`lobu run`, no connection_id) is redeemed
	// through. Minting one is gated on such a connection EXISTING for the
	// platform, so a suite that mints telegram/gchat codes must seed them.
	await insertChatConnectionRow({
		id: FOREIGN_TELEGRAM_PREVIEW_CONNECTION,
		organizationId: FOREIGN_ORG_ID,
		platform: "telegram",
		credentialMode: "managed",
		settings: { previewMode: true },
		status: "active",
	});
	await insertChatConnectionRow({
		id: FOREIGN_GCHAT_PREVIEW_CONNECTION,
		organizationId: FOREIGN_ORG_ID,
		platform: "gchat",
		credentialMode: "byo",
		settings: { previewMode: true },
		status: "active",
	});
  });

  beforeEach(async () => {
    const sql = getDb();
    await clearChatAutomations();
    await sql`DELETE FROM oauth_states WHERE scope = 'slack-preview-claim'`;
  });

  test("claim mints a /lobu link code in oauth_states under the dedicated scope", async () => {
    const res = await createPreviewClaim(
      orgUserContext({ agent_id: AGENT_ID, platform: "slack", surfaces: ["dm", "channel"] })
    );
    if (!isFakeResponse(res)) throw new Error("not a json response");
    expect(res.status).toBe(200);
    const code = res.body.code as string;
    expect(code).toMatch(/^demo-agent-[A-Z0-9]{6}$/);
    expect(res.body.provider).toBe("lobu-public-slack");
    expect(res.body.command).toBe(`/lobu link ${code}`);
    expect(res.body.allowed_surfaces).toEqual(["dm", "channel"]);

    const sql = getDb();
    const rows =
      await sql`SELECT payload FROM oauth_states WHERE scope = 'slack-preview-claim'`;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { payload: { agentId: string } }).payload.agentId).toBe(
      AGENT_ID
    );
  });

  test("claim for an agent outside the caller's org → 404", async () => {
    const res = await createPreviewClaim(
      orgUserContext({ agent_id: "nope", platform: "slack" })
    );
    if (!isFakeResponse(res)) throw new Error("not a json response");
    expect(res.status).toBe(404);
  });

  test("an unbound claim for a platform with NO hosted bot → 400", async () => {
    // discord has no previewMode connection anywhere, so a code minted for it
    // could never be redeemed. This used to be an allowlist check; it is now the
    // actual precondition, which is why it also covers platforms nobody thought
    // to list.
    const res = await createPreviewClaim(
      orgUserContext({ agent_id: AGENT_ID, platform: "discord" })
    );
    if (!isFakeResponse(res)) throw new Error("not a json response");
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("No hosted bot");
  });

  test("an unbound GOOGLE CHAT claim mints, because a hosted gchat bot exists", async () => {
    // The old allowlist was ["slack", "telegram"], so this 400'd even though the
    // deployment ran a hosted Google Chat bot. Nothing about gchat is special —
    // it qualifies for the same reason slack does.
    const res = await createPreviewClaim(
      orgUserContext({ agent_id: AGENT_ID, platform: "gchat", surfaces: ["dm"] })
    );
    if (!isFakeResponse(res)) throw new Error("not a json response");
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("lobu-public-gchat");
    expect(res.body.command).toBe(`/lobu link ${res.body.code as string}`);
  });

  test("a hosted bot that is not active does not qualify a platform", async () => {
    // `whatsapp` gets a previewMode connection that is PAUSED. The gate reads
    // live, redeemable connections only — a stopped bot cannot serve a code.
    await insertChatConnectionRow({
      id: "paused-whatsapp-preview",
      organizationId: FOREIGN_ORG_ID,
      platform: "whatsapp",
      credentialMode: "managed",
      settings: { previewMode: true },
      status: "paused",
    });
    const res = await createPreviewClaim(
      orgUserContext({ agent_id: AGENT_ID, platform: "whatsapp" })
    );
    if (!isFakeResponse(res)) throw new Error("not a json response");
    expect(res.status).toBe(400);
  });

  test("a telegram claim mints a /link code and is consumable without a teamId", async () => {
    const res = await createPreviewClaim(
      orgUserContext({ agent_id: AGENT_ID, platform: "telegram", surfaces: ["dm"] })
    );
    if (!isFakeResponse(res)) throw new Error("not a json response");
    expect(res.status).toBe(200);
    const code = res.body.code as string;
    expect(res.body.provider).toBe("lobu-public-telegram");
    expect(res.body.command).toBe(`/link ${code}`);

    const bound = await consumePreviewClaim({
      code,
      platform: "telegram",
      channelId: "12345",
      surfaceType: "dm",
      connectionId: CLAIM_TELEGRAM_CONNECTION,
      connectionOrganizationId: ORG_ID,
    });
    expect(bound).toMatchObject({ status: "bound", agentId: AGENT_ID });

    const rows = await listTestAutomationSubscriptions({ platform: "telegram" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel_id: "telegram:12345", team_id: null });
  });

  test("consume binds the Slack channel to the agent and is one-time-use", async () => {
    const code = await createClaim(AGENT_ID);
    const bound = await consumeSlack({
      code,
      teamId: TEAM_ID,
      channelId: "D123",
    });
    expect(bound).toEqual({
      status: "bound",
      agentId: AGENT_ID,
      organizationId: ORG_ID,
    });

    // Stored under the canonical `slack:<id>` key the message-handler bridge
    // looks up via getBinding — the bare slash-command channel id is prefixed.
    const rows = await listTestAutomationSubscriptions({ platform: "slack" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_id: AGENT_ID,
      platform: "slack",
      channel_id: "slack:D123",
      team_id: TEAM_ID,
    });

    // Claim consumed; replay fails.
    expect(
      await consumeSlack({ code, teamId: TEAM_ID, channelId: "D123" })
    ).toEqual({ status: "not_found" });
  });

  test("a hosted code crosses orgs only through a boolean-marked preview connection", async () => {
    const code = await createClaim(AGENT_ID);
    for (const { connectionId, teamId } of [
      { connectionId: FOREIGN_SLACK_CONNECTION, teamId: "T_FOREIGN" },
      {
        connectionId: FOREIGN_STRING_PREVIEW_CONNECTION,
        teamId: "T_STRING_PREVIEW",
      },
    ]) {
      const refused = await consumePreviewClaim({
        code,
        platform: "slack",
        teamId,
        channelId: canonicalSlackChannelId("CFOREIGN"),
        surfaceType: "channel",
        connectionId,
        connectionOrganizationId: FOREIGN_ORG_ID,
      });
      expect(refused).toEqual({ status: "connection_mismatch" });
    }
    expect(
      await listTestAutomationSubscriptions({ platform: "slack" })
    ).toHaveLength(0);

    // A real preview marker is still scoped to its persisted Slack workspace.
    const wrongHostedWorkspace = await consumePreviewClaim({
      code,
      platform: "slack",
      teamId: "T_OTHER_HOSTED",
      channelId: canonicalSlackChannelId("COTHERHOSTED"),
      surfaceType: "channel",
      connectionId: FOREIGN_PREVIEW_CONNECTION,
      connectionOrganizationId: FOREIGN_ORG_ID,
    });
    expect(wrongHostedWorkspace).toEqual({ status: "connection_mismatch" });

    // Refusals do not consume the code. The same cross-org claim is valid on
    // the deliberately shared preview connection in its actual workspace.
    const hosted = await consumePreviewClaim({
      code,
      platform: "slack",
      teamId: "T_HOSTED",
      channelId: canonicalSlackChannelId("CHOSTED"),
      surfaceType: "channel",
      connectionId: FOREIGN_PREVIEW_CONNECTION,
      connectionOrganizationId: FOREIGN_ORG_ID,
    });
    expect(hosted).toMatchObject({ status: "bound", agentId: AGENT_ID });
    const subscriptions = await listTestAutomationSubscriptions({
      platform: "slack",
    });
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({
      organization_id: ORG_ID,
      agent_id: AGENT_ID,
      channel_id: "slack:CHOSTED",
      team_id: "T_HOSTED",
    });
  });

  test("the demo commands are no longer registered", async () => {
    // The self-serve `try` / `agents` surface is gone. `tryHandle` returns false
    // for a name nothing registered, so this is the direct proof the removal
    // took — the early-dispatch allowlist only covers whether they'd reach here.
    const registry = new CommandRegistry();
    registerBuiltInCommands(registry, { agentSettingsStore: {} as never, automationSubscriptionService: {} as never });
    const ctx = {
      userId: "U1",
      channelId: "slack:D1",
      teamId: "T1",
      isGroup: false,
      platform: "slack",
      connectionId: FOREIGN_PREVIEW_CONNECTION,
      organizationId: ORG_ID,
      args: "",
      reply: async () => {},
    };
    expect(await registry.tryHandle("try", ctx)).toBe(false);
    expect(await registry.tryHandle("agents", ctx)).toBe(false);
    // Control: a command that IS registered still resolves, so a broken harness
    // cannot make the assertions above pass vacuously.
    expect(await registry.tryHandle("link", ctx)).toBe(true);
  });

  test("the link command explains the authorized connection boundary per platform", async () => {
    const registry = new CommandRegistry();
    registerBuiltInCommands(registry, { agentSettingsStore: {} as never, automationSubscriptionService: {} as never });
    for (const scenario of [
      {
        platform: "slack",
        connectionId: FOREIGN_SLACK_CONNECTION,
      },
      {
        platform: "telegram",
        connectionId: FOREIGN_TELEGRAM_CONNECTION,
      },
    ] as const) {
      const replies: string[] = [];
      await registry.tryHandle("link", {
        userId: "U1",
        channelId: "CFOREIGN-COMMAND",
        teamId: scenario.platform === "slack" ? "T_FOREIGN" : undefined,
        isGroup: true,
        platform: scenario.platform,
        connectionId: scenario.connectionId,
        organizationId: FOREIGN_ORG_ID,
        args: await createClaim(AGENT_ID, ["dm", "channel"], scenario.platform),
        reply: async (text: string) => {
          replies.push(text);
        },
      });
      const reply = replies.join("\n");
      expect(reply).toContain("isn't authorized for this chat connection");
      expect(reply).toContain("selected installation or hosted preview bot");
    }
  });

  test("re-linking a channel rebinds it to the new agent (last link wins)", async () => {
    await consumeSlack({
      code: await createClaim(AGENT_ID),
      teamId: TEAM_ID,
      channelId: "Csame",
    });
    const rebound = await consumeSlack({
      code: await createClaim(OTHER_AGENT_ID),
      teamId: TEAM_ID,
      channelId: "Csame",
    });
    expect(rebound).toMatchObject({ status: "bound", agentId: OTHER_AGENT_ID });

    const rows = await listTestAutomationSubscriptions({
      platform: "slack",
      channelId: "slack:Csame",
      teamId: TEAM_ID,
    });
    expect(rows).toHaveLength(1);
    expect((rows[0] as { agent_id: string }).agent_id).toBe(OTHER_AGENT_ID);
  });

  test("expired or unknown code → not_found, nothing bound", async () => {
    expect(
      await consumeSlack({
        code: "demo-agent-NOPE00",
        teamId: TEAM_ID,
        channelId: "D1",
      })
    ).toEqual({ status: "not_found" });

    const code = await createClaim(AGENT_ID);
    const sql = getDb();
    await sql`UPDATE oauth_states SET expires_at = now() - interval '1 minute' WHERE scope = 'slack-preview-claim'`;
    expect(
      await consumeSlack({ code, teamId: TEAM_ID, channelId: "D1" })
    ).toEqual({ status: "not_found" });
    const bindings = await listTestAutomationSubscriptions({ platform: "slack" });
    expect(bindings).toHaveLength(0);
  });

  test("using a dm-only code in a channel → surface_not_allowed", async () => {
    const code = await createClaim(AGENT_ID, ["dm"]);
    expect(
      await consumeSlack({ code, teamId: TEAM_ID, channelId: "C9" })
    ).toEqual({ status: "surface_not_allowed", surfaceType: "channel" });
  });

  test("an already-`slack:`-prefixed DM channelId counts as a dm and is stored as-is", async () => {
    // Callers that already pass the canonical thread id (`slack:D…`) shouldn't
    // get it double-prefixed.
    const code = await createClaim(AGENT_ID, ["dm"]);
    expect(
      await consumeSlack({
        code,
        teamId: TEAM_ID,
        channelId: "slack:D999",
      })
    ).toMatchObject({ status: "bound", agentId: AGENT_ID });
    const rows = await listTestAutomationSubscriptions({
      platform: "slack",
      teamId: TEAM_ID,
    });
    expect((rows[0] as { channel_id: string }).channel_id).toBe("slack:D999");
  });

  test("the /lobu link chat command redeems a code end to end", async () => {
    const code = await createClaim(AGENT_ID);
    const registry = new CommandRegistry();
    // registerBuiltInCommands wires `status` against an agent settings store and
    // a subscription service we don't need here; only `link` is exercised.
    registerBuiltInCommands(registry, {
      agentSettingsStore: {} as never,
      automationSubscriptionService: {} as never,
    });

    const replies: string[] = [];
    const handled = await registry.tryHandle("link", {
      userId: "U1",
      channelId: "D777",
      teamId: TEAM_ID,
      isGroup: false,
      platform: "slack",
      connectionId: CLAIM_SLACK_CONNECTION,
      organizationId: ORG_ID,
      args: code,
      reply: async (text: string) => {
        replies.push(text);
      },
    });
    expect(handled).toBe(true);
    expect(replies.join("\n")).toContain(`agent \`${AGENT_ID}\``);

    const rows = await listTestAutomationSubscriptions({
      platform: "slack",
      channelId: "slack:D777",
      teamId: TEAM_ID,
    });
    expect((rows[0] as { agent_id: string }).agent_id).toBe(AGENT_ID);

    // Redeeming a code does NOT record who this Slack user is — a code is not
    // identity proof. So the codeless `<agentId>` shortcut stays unavailable
    // and the arg is reported as a bad code rather than resolved as an agent.
    const replies2: string[] = [];
    await registry.tryHandle("link", {
      userId: "U1",
      channelId: "D777",
      teamId: TEAM_ID,
      isGroup: false,
      platform: "slack",
      connectionId: CLAIM_SLACK_CONNECTION,
      organizationId: ORG_ID,
      args: "demo-agent-BADBAD",
      reply: async (text: string) => {
        replies2.push(text);
      },
    });
    expect(replies2.join("\n")).not.toMatch(/no agent `demo-agent-BADBAD`/i);
    expect(replies2.join("\n")).toMatch(/invalid or expired/i);
  });
});

describe("chat-user identity + codeless re-link by agent id", () => {
  const ID_TEAM = "T_IDENTITY";
  const ID_AGENT = "owned-agent";
  const ID_CONNECTION = "identity-slack";
  let idOrgId = "";
  let lobuUserId = "";
  const SLACK_USER = "U_IDENTITY";

  function ownerContext(jsonBody: unknown): Context<{ Bindings: Env }> {
    return {
      var: { organizationId: idOrgId, session: { userId: lobuUserId } },
      req: { json: async () => jsonBody, header: () => undefined },
      json: (body: Record<string, unknown>, status = 200): FakeResponse => ({
        status,
        body,
      }),
    } as unknown as Context<{ Bindings: Env }>;
  }

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: "Identity Org", slug: "identity-org" });
    idOrgId = org.id;
    const user = await createTestUser({ email: "identity@test.example.com" });
    lobuUserId = user.id;
    await addUserToOrganization(lobuUserId, idOrgId);
    await createTestAgent({ organizationId: idOrgId, agentId: ID_AGENT, name: "Owned" });
    await createTestAgent({ organizationId: idOrgId, agentId: "second-agent", name: "Second" });
	await insertChatConnectionRow({
		id: ID_CONNECTION,
		organizationId: idOrgId,
		platform: "slack",
		agentId: ID_AGENT,
		credentialMode: "byo",
		status: "active",
		metadata: { teamId: ID_TEAM },
	});
	// This block mints unbound claims, which requires a hosted slack bot to exist.
	await insertChatConnectionRow({
		id: "identity-slack-preview",
		organizationId: idOrgId,
		platform: "slack",
		credentialMode: "managed",
		settings: { previewMode: true },
		status: "active",
		metadata: { teamId: "T_ID_HOSTED" },
	});
  });

  beforeEach(async () => {
    const sql = getDb();
    await clearChatAutomations();
    await sql`DELETE FROM oauth_states WHERE scope = 'slack-preview-claim'`;
  });

  async function mintAndConsume(agentId: string, channelId: string) {
    const res = await createPreviewClaim(
      ownerContext({ agent_id: agentId, platform: "slack", surfaces: ["dm"] })
    );
    if (!isFakeResponse(res)) throw new Error("not a json response");
    expect(res.status).toBe(200);
    const code = res.body.code as string;
    return consumePreviewClaim({
      code,
      platform: "slack",
      teamId: ID_TEAM,
      channelId: canonicalSlackChannelId(channelId),
      surfaceType: "dm",
      connectionId: ID_CONNECTION,
      connectionOrganizationId: idOrgId,
    });
  }

  test("consuming a code binds the chat but records NO chat-user identity", async () => {
    const bound = await mintAndConsume(ID_AGENT, "D900");
    expect(bound).toMatchObject({ status: "bound", agentId: ID_AGENT });

    // A pasted code does not prove the redeemer is the minter, and chat
    // identity authorizes Slack approval clicks and the in-chat builder-admin
    // grant — so redemption must establish none. Identity comes only from
    // Slack sign-in / the install claim, neither of which ran here.
    //
    // Assert on the ROW, not just the resolver: `resolveChatUserIdentity` also
    // returns null for an identity with no live `auth_user_id` link, so it
    // would stay green even if redemption wrote an orphan `slack_user_id`.
    const stamped = await getDb()<{ n: number }>`
      SELECT count(*)::int AS n
      FROM entity_identities
      WHERE organization_id = ${idOrgId}
        AND namespace = ${SLACK_IDENTITY.USER_ID}
        AND identifier = ${normalizeSlackUserId(ID_TEAM, SLACK_USER)}
        AND deleted_at IS NULL
    `;
    expect(stamped[0].n).toBe(0);
    expect(
      await resolveChatUserIdentity("slack", ID_TEAM, SLACK_USER),
    ).toBeNull();
  });

  test("bindChatToAgentForOwner re-binds to an agent in the user's org, refuses others", async () => {
    expect(
      await bindChatToAgentForOwner({
        platform: "slack",
        teamId: ID_TEAM,
        channelId: canonicalSlackChannelId("D901"),
        agentId: "second-agent",
        lobuUserId,
        connectionId: ID_CONNECTION,
        connectionOrganizationId: idOrgId,
      })
    ).toEqual({ status: "bound" });
    const rows = await listTestAutomationSubscriptions({
      channelId: "slack:D901",
      teamId: ID_TEAM,
    });
    expect((rows[0] as { agent_id: string }).agent_id).toBe("second-agent");

    expect(
      await bindChatToAgentForOwner({
        platform: "slack",
        teamId: ID_TEAM,
        channelId: canonicalSlackChannelId("D902"),
        agentId: "agent-in-another-org",
        lobuUserId,
        connectionId: ID_CONNECTION,
        connectionOrganizationId: idOrgId,
      })
    ).toEqual({ status: "forbidden" });
  });

  test("/lobu link <agentId> re-binds without a code once the user has linked here", async () => {
    // The identity must come from a real Slack sign-in / install claim, NOT
    // from redeeming a preview code — redemption deliberately records none.
    // Seed the graph the way those paths do so the shortcut stays covered.
    await mintAndConsume(ID_AGENT, "D903");
    await linkSlackIdentityInGraph({
      organizationId: idOrgId,
      userId: lobuUserId,
      teamId: ID_TEAM,
      slackUserId: SLACK_USER,
    });

    const registry = new CommandRegistry();
    registerBuiltInCommands(registry, { agentSettingsStore: {} as never, automationSubscriptionService: {} as never });

    const replies: string[] = [];
    await registry.tryHandle("link", {
      userId: SLACK_USER,
      channelId: "D903",
      teamId: ID_TEAM,
      isGroup: false,
      platform: "slack",
      connectionId: ID_CONNECTION,
      organizationId: idOrgId,
      args: "second-agent",
      reply: async (text: string) => {
        replies.push(text);
      },
    });
    expect(replies.join("\n")).toContain("`second-agent`");
    const rows = await listTestAutomationSubscriptions({
      channelId: "slack:D903",
      teamId: ID_TEAM,
    });
    expect((rows[0] as { agent_id: string }).agent_id).toBe("second-agent");

    // An unknown agent id surfaces the friendly error, no throw.
    const replies2: string[] = [];
    await registry.tryHandle("link", {
      userId: SLACK_USER,
      channelId: "D903",
      teamId: ID_TEAM,
      isGroup: false,
      platform: "slack",
      connectionId: ID_CONNECTION,
      organizationId: idOrgId,
      args: "agent-in-another-org",
      reply: async (text: string) => {
        replies2.push(text);
      },
    });
    expect(replies2.join("\n")).toMatch(/no agent `agent-in-another-org`/i);

    // A user who has never linked here just gets the "invalid code" message.
    const replies3: string[] = [];
    await registry.tryHandle("link", {
      userId: "U_STRANGER",
      channelId: "D999",
      teamId: ID_TEAM,
      isGroup: false,
      platform: "slack",
      args: "second-agent",
      reply: async (text: string) => {
        replies3.push(text);
      },
    });
    expect(replies3.join("\n")).toMatch(/invalid or expired/i);
  });
});
