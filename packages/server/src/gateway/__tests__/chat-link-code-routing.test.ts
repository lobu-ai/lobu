/** Link codes bind a chat without inventing a platform-user identity. */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { CommandRegistry } from "@lobu/core";
import type { Context } from "hono";
import { addUserToOrganization, createTestUser, linkSlackIdentityInGraph } from "../../__tests__/setup/test-fixtures.js";
import { getDb } from "../../db/client.js";
import type { Env } from "../../index.js";
import { createPreviewClaim } from "../../preview/slack.js";
import { resolveChatUserIdentity } from "../../lobu/stores/chat-identity.js";
import { AutomationSubscriptionService } from "../channels/automation-subscription-service.js";
import { registerBuiltInCommands } from "../commands/built-in-commands.js";
import { CommandDispatcher } from "../commands/command-dispatcher.js";
import { ConversationStateStore } from "../connections/conversation-state-store.js";
import { MessageHandlerBridge } from "../connections/message-handler-bridge.js";
import { createConnectedGatewayStateAdapter } from "../connections/state-adapter.js";
import type { PlatformConnection } from "../connections/types.js";
import { QueueProducer } from "../infrastructure/queue/queue-producer.js";
import { RunsQueue } from "../infrastructure/queue/runs-queue.js";
import { ensureDbForGatewayTests, resetTestDatabase, seedAgentRow } from "./helpers/db-setup.js";

const SOURCE_ORG = "org-chat-installation";
const TARGET_ORG = "org-chat-agent";
const AGENT_ID = "agent-chat-code";
const PLATFORMS = ["slack", "telegram", "whatsapp"] as const;

function claimContext(body: Record<string, unknown>, userId: string, authVariables: Record<string, unknown> = {}) {
  return {
    var: { organizationId: TARGET_ORG, session: { userId }, authSource: "session", ...authVariables },
    req: { json: async () => body },
    json: (value: unknown, status = 200) => new Response(JSON.stringify(value), { status }),
  } as unknown as Context<{ Bindings: Env }>;
}

async function waitFor(check: () => Promise<void>) {
  const deadline = Date.now() + 3_000;
  let error: unknown;
  while (Date.now() < deadline) {
    try { await check(); return; } catch (caught) { error = caught; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw error;
}

describe("platform-neutral chat link-code routing", () => {
  let queue: RunsQueue;
  let producer: QueueProducer;
  let ownerId: string;

  beforeAll(ensureDbForGatewayTests);
  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow(AGENT_ID, { organizationId: TARGET_ORG });
    await seedAgentRow("installation-agent", { organizationId: SOURCE_ORG });
    ownerId = (await createTestUser()).id;
    await addUserToOrganization(ownerId, SOURCE_ORG, "owner");
    await addUserToOrganization(ownerId, TARGET_ORG, "admin");
    queue = new RunsQueue();
    await queue.start();
    producer = new QueueProducer(queue);
    await producer.start();
  });
  afterEach(async () => { await queue?.stop(); });

  async function install(platform: typeof PLATFORMS[number], organizationId: string, suffix = "") {
    const slug = `chat-code-${platform}${suffix}`;
    const [row] = await getDb()`
      INSERT INTO connections (organization_id, connector_key, slug, display_name, status, credential_mode, config)
      VALUES (${organizationId}, ${platform}, ${`agentconn-${slug}`}, 'Chat code fixture', 'active', 'managed', '{}')
      RETURNING id
    `;
    const connection: PlatformConnection = {
      id: slug, organizationId, platform, config: { platform } as never,
      settings: { allowGroups: true }, status: "active", createdAt: 1, updatedAt: 1,
    };
    const subscriptions = new AutomationSubscriptionService();
    const registry = new CommandRegistry();
    const getSettings = mock(async () => undefined);
    registerBuiltInCommands(registry, { agentSettingsStore: { getSettings } as never });
    const dispatcher = new CommandDispatcher({ registry, automationSubscriptionService: subscriptions });
    const conversationState = new ConversationStateStore(await createConnectedGatewayStateAdapter());
    const bridge = new MessageHandlerBridge(connection, {
      getArtifactStore: () => null,
      getPublicGatewayUrl: () => "https://gateway.example.test",
      getAutomationSubscriptionService: () => subscriptions,
      getAgentMetadataStore: () => undefined,
      getUserAgentsStore: () => undefined,
      getTranscriptionService: () => undefined,
      getAgentSettingsStore: () => undefined,
      getDeclaredAgentRegistry: () => undefined,
      getProviderCatalogService: () => undefined,
      getQueueProducer: () => producer,
    } as never, {
      has: (id: string) => id === slug,
      getInstance: () => ({ connection, conversationState }),
    } as never, dispatcher);
    const channelId = `${platform}:123456`;
    const thread = { channelId, id: channelId, subscribe: mock(async () => {}), post: mock(async () => ({})) };
    let sequence = 0;
    const send = (text: string, source: "dm" | "mention" = "dm") => bridge.handleMessage(thread, {
      id: `message-${++sequence}`, text,
      author: { userId: "provider-code-redeemer", isBot: false, isMe: false },
      raw: platform === "slack" ? { team_id: "T_CODE_WORKSPACE" } : {},
    }, source);
    return { id: Number(row.id), slug, connection, thread, send, getSettings };
  }

  for (const platform of PLATFORMS) {
    for (const sourceOrg of [TARGET_ORG, SOURCE_ORG]) {
      test(`${platform}: code links and dispatches from ${sourceOrg === TARGET_ORG ? "same" : "another administered"} workspace`, async () => {
        const installed = await install(platform, sourceOrg);
        const minted = await createPreviewClaim(claimContext({
          platform, agent_id: AGENT_ID, connection_id: installed.id, surfaces: ["dm"],
        }, ownerId));
        expect(minted.status).toBe(200);
        const { code } = await minted.json();
        await installed.send(`/lobu link ${code}`);
        expect(String(installed.thread.post.mock.calls[0]?.[0])).toContain("Linked this chat");
        await installed.send("Handle this request");
        await waitFor(async () => {
          const rows = await getDb()`SELECT action_input FROM runs WHERE run_type = 'chat_message'`;
          expect(rows).toHaveLength(1);
          expect(rows[0].action_input).toMatchObject({ agentId: AGENT_ID, organizationId: TARGET_ORG });
        });
        expect(await resolveChatUserIdentity(platform, platform === "slack" ? "T_CODE_WORKSPACE" : undefined, "provider-code-redeemer")).toBeNull();
      });
    }

    test(`${platform}: a channel code routes a mention and status to the linked workspace`, async () => {
      const installed = await install(platform, SOURCE_ORG);
      const response = await createPreviewClaim(claimContext({
        platform, agent_id: AGENT_ID, connection_id: installed.id, surfaces: ["channel"],
      }, ownerId));
      expect(response.status).toBe(200);
      await installed.send(`/link ${(await response.json()).code}`, "mention");
      expect(String(installed.thread.post.mock.calls[0]?.[0])).toContain("Linked this chat");
      await installed.send("Handle this channel request", "mention");
      await waitFor(async () => {
        const rows = await getDb()`SELECT action_input FROM runs WHERE run_type = 'chat_message'`;
        expect(rows).toHaveLength(1);
        expect(rows[0].action_input.organizationId).toBe(TARGET_ORG);
      });
      await installed.send("/status", "mention");
      expect(installed.getSettings.mock.calls).toEqual([[AGENT_ID, { organizationId: TARGET_ORG }]]);
    });

    if (platform !== "whatsapp") {
      test(`${platform}: hosted preview codes still dispatch without installation-admin membership`, async () => {
        const installed = await install(platform, SOURCE_ORG);
        installed.connection.settings = { allowGroups: true, previewMode: true };
        const sql = getDb();
        await sql`UPDATE connections SET config = ${sql.json({ settings: { previewMode: true } })} WHERE id = ${installed.id}`;
        await sql`DELETE FROM member WHERE "userId" = ${ownerId} AND "organizationId" = ${SOURCE_ORG}`;
        const response = await createPreviewClaim(claimContext({ platform, agent_id: AGENT_ID }, ownerId));
        expect(response.status).toBe(200);
        await installed.send(`/link ${(await response.json()).code}`);
        expect(String(installed.thread.post.mock.calls[0]?.[0])).toContain("Linked this chat");
        await installed.send("Handle this hosted preview request");
        await waitFor(async () => {
          const rows = await sql`SELECT action_input FROM runs WHERE run_type = 'chat_message'`;
          expect(rows).toHaveLength(1);
          expect(rows[0].action_input.organizationId).toBe(TARGET_ORG);
        });
      });
    }

    if (platform === "slack") {
      test("slack: hosted preview retains verified codeless linking for a target-workspace member", async () => {
        const installed = await install(platform, SOURCE_ORG);
        installed.connection.settings = { allowGroups: true, previewMode: true };
        const sql = getDb();
        await sql`UPDATE connections SET config = ${sql.json({ settings: { previewMode: true } })} WHERE id = ${installed.id}`;
        await sql`DELETE FROM member WHERE "userId" = ${ownerId} AND "organizationId" = ${SOURCE_ORG}`;
        await linkSlackIdentityInGraph({
          organizationId: TARGET_ORG, userId: ownerId,
          teamId: "T_CODE_WORKSPACE", slackUserId: "provider-code-redeemer",
        });
        await installed.send(`/lobu link ${AGENT_ID}`);
        expect(String(installed.thread.post.mock.calls[0]?.[0])).toContain("Linked this chat");
        await installed.send("Handle the verified preview request");
        await waitFor(async () => {
          const rows = await sql`SELECT action_input FROM runs WHERE run_type = 'chat_message'`;
          expect(rows).toHaveLength(1);
          expect(rows[0].action_input.organizationId).toBe(TARGET_ORG);
        });
      });
    }

    test.each(["source member", "target member", "target-only OAuth", "source-only OAuth", "scoped PAT"])(`${platform}: rejects a code grant without both workspace permissions: %s`, async (boundary) => {
      const installed = await install(platform, SOURCE_ORG);
      const sql = getDb();
      let authVariables: Record<string, unknown> = {};
      if (boundary.endsWith("member")) {
        const organizationId = boundary.startsWith("source") ? SOURCE_ORG : TARGET_ORG;
        await sql`UPDATE member SET role = 'member' WHERE "userId" = ${ownerId} AND "organizationId" = ${organizationId}`;
      } else {
        const pat = boundary === "scoped PAT";
        authVariables = {
          authSource: pat ? "pat" : "oauth", session: null, user: { id: ownerId },
          mcpAuthInfo: {
            userId: ownerId, tokenType: pat ? "pat" : "access_token",
            organizationId: pat ? TARGET_ORG : null,
            grantedOrganizationIds: boundary === "source-only OAuth" ? [SOURCE_ORG] : [TARGET_ORG],
          },
        };
      }
      const response = await createPreviewClaim(claimContext({
        platform, agent_id: AGENT_ID, connection_id: installed.id,
      }, ownerId, authVariables));
      expect(response.status).toBe(404);
      expect(await sql`SELECT id FROM oauth_states`).toHaveLength(0);
      expect(await sql`SELECT id FROM automations`).toHaveLength(0);
    });

    test.each(["both-workspace OAuth", "unscoped PAT"])(`${platform}: a credential with both workspace permissions can authorize a code: %s`, async (credential) => {
      const installed = await install(platform, SOURCE_ORG);
      const pat = credential === "unscoped PAT";
      const response = await createPreviewClaim(claimContext({
        platform, agent_id: AGENT_ID, connection_id: installed.id,
      }, ownerId, {
        authSource: pat ? "pat" : "oauth", session: null, user: { id: ownerId },
        mcpAuthInfo: {
          userId: ownerId, tokenType: pat ? "pat" : "access_token", organizationId: null,
          grantedOrganizationIds: pat ? null : [SOURCE_ORG, TARGET_ORG],
        },
      }));
      expect(response.status).toBe(200);
      const { code } = await response.json();
      await installed.send(`/link ${code}`);
      expect(String(installed.thread.post.mock.calls[0]?.[0])).toContain("Linked this chat");
      await installed.send("Handle the credential-authorized request");
      await waitFor(async () => {
        expect(await getDb()`SELECT id FROM runs WHERE run_type = 'chat_message'`).toHaveLength(1);
      });
    });

    test.each(["source access revoked", "target access revoked", "wrong connection", "wrong platform", "installation moved", "expired code", "wrong surface"])(`${platform}: rejected redemption never links or dispatches: %s`, async (boundary) => {
      const installed = await install(platform, SOURCE_ORG);
      const response = await createPreviewClaim(claimContext({
        platform, agent_id: AGENT_ID, connection_id: installed.id, surfaces: ["dm"],
      }, ownerId));
      expect(response.status).toBe(200);
      const { code } = await response.json();
      const sql = getDb();
      const [claim] = await sql`SELECT payload FROM oauth_states`;
      expect(claim.payload.connectionOrganizationId).toBe(SOURCE_ORG);
      let destination = installed;
      if (boundary.endsWith("access revoked")) {
        const organizationId = boundary.startsWith("source") ? SOURCE_ORG : TARGET_ORG;
        await sql`DELETE FROM member WHERE "userId" = ${ownerId} AND "organizationId" = ${organizationId}`;
      } else if (boundary === "wrong connection") {
        destination = await install(platform, SOURCE_ORG, "-other");
      } else if (boundary === "wrong platform") {
        destination = await install(platform === "slack" ? "telegram" : "slack", SOURCE_ORG);
      } else if (boundary === "installation moved") {
        await sql`UPDATE connections SET organization_id = ${TARGET_ORG} WHERE id = ${installed.id}`;
      } else if (boundary === "expired code") {
        await sql`UPDATE oauth_states SET expires_at = now() - interval '1 second'`;
      }
      await destination.send(`/lobu link ${code}`, boundary === "wrong surface" ? "mention" : "dm");
      expect(String(destination.thread.post.mock.calls[0]?.[0])).not.toContain("Linked this chat");
      expect(await sql`SELECT id FROM automations`).toHaveLength(0);
      await destination.send("This must not create a turn");
      expect(await sql`SELECT id FROM runs WHERE run_type = 'chat_message'`).toHaveLength(0);
    });

    test(`${platform}: re-link rejects a revoked author until the old link is retired`, async () => {
      const installed = await install(platform, SOURCE_ORG);
      const mint = async (userId: string) => {
        const response = await createPreviewClaim(claimContext({
          platform, agent_id: AGENT_ID, connection_id: installed.id,
        }, userId));
        expect(response.status).toBe(200);
        return (await response.json()).code as string;
      };
      await installed.send(`/link ${await mint(ownerId)}`);
      const sql = getDb();
      const replacement = (await createTestUser()).id;
      await addUserToOrganization(replacement, SOURCE_ORG, "admin");
      await addUserToOrganization(replacement, TARGET_ORG, "admin");
      await sql`DELETE FROM member WHERE "userId" = ${ownerId} AND "organizationId" = ${SOURCE_ORG}`;
      const replacementCode = await mint(replacement);
      await installed.send(`/link ${replacementCode}`);
      expect(String(installed.thread.post.mock.calls[1]?.[0])).toContain("Retire its Automation");
      const [existing] = await sql`SELECT id, created_by FROM automations`;
      expect(existing.created_by).toBe(ownerId);
      expect(await sql`SELECT id FROM oauth_states`).toHaveLength(1);
      await installed.send("The old authorization must remain revoked");
      expect(await sql`SELECT id FROM runs WHERE run_type = 'chat_message'`).toHaveLength(0);
      await sql`UPDATE automations SET status = 'archived' WHERE id = ${existing.id}`;
      await installed.send(`/link ${replacementCode}`);
      expect(String(installed.thread.post.mock.calls.at(-1)?.[0])).toContain("Linked this chat");
      await installed.send("A fresh link has a current authorized author");
      await waitFor(async () => {
        expect(await sql`SELECT id FROM runs WHERE run_type = 'chat_message'`).toHaveLength(1);
      });
    });

    test(`${platform}: a code is single use and revoked admin access stops an existing link`, async () => {
      const installed = await install(platform, SOURCE_ORG);
      const response = await createPreviewClaim(claimContext({
        platform, agent_id: AGENT_ID, connection_id: installed.id,
      }, ownerId));
      const { code } = await response.json();
      await installed.send(`/link ${code}`);
      const sql = getDb();
      expect(await sql`SELECT id FROM oauth_states`).toHaveLength(0);
      await installed.send(`/link ${code}`);
      expect(String(installed.thread.post.mock.calls[1]?.[0])).toContain("invalid or expired");
      expect(await sql`SELECT id FROM automations`).toHaveLength(1);
      await sql`DELETE FROM member WHERE "userId" = ${ownerId} AND "organizationId" = ${SOURCE_ORG}`;
      await installed.send("This must not run after access was revoked");
      expect(await sql`SELECT id FROM runs WHERE run_type = 'chat_message'`).toHaveLength(0);
      expect(await resolveChatUserIdentity(platform, platform === "slack" ? "T_CODE_WORKSPACE" : undefined, "provider-code-redeemer")).toBeNull();
    });
  }
});
