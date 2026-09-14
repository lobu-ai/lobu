/**
 * Full-chain local e2e against a real Postgres: a bare preview-code **message**
 * in a previewMode DM goes through MessageHandlerBridge.handleMessage →
 * parsePreviewLinkCode → the real built-in `link` command → consumePreviewClaim,
 * and the binding row is actually written + the claim consumed. No mocks on the
 * consume/bind path. This is the exact flow the live Slack DM exercises.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { CommandRegistry } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { listTestAutomationSubscriptions } from "../../__tests__/setup/automation-subscriptions.js";
import { registerBuiltInCommands } from "../commands/built-in-commands.js";
import { CommandDispatcher } from "../commands/command-dispatcher.js";
import { ConversationStateStore } from "../connections/conversation-state-store.js";
import { MessageHandlerBridge } from "../connections/message-handler-bridge.js";
import type { PlatformConnection } from "../connections/types.js";
import { __resetPublicOriginCachesForTests } from "../../utils/public-origin.js";
import { InMemoryStateAdapter } from "./fixtures/in-memory-state-adapter.js";
import { ensureDbForGatewayTests, seedAgentRow } from "./helpers/db-setup.js";

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

function codeHash(code: string): string {
	return createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
}

describe("DM bare-code message → real consume→bind (previewMode)", () => {
  test("a bare preview code DM binds the chat to the claim's agent", async () => {
    const sql = getDb();
		const suffix = Date.now()
			.toString(36)
			.toUpperCase()
			.slice(-6)
			.padStart(6, "0");
    const code = `crm-${suffix}`;
    const agentId = `agent-msg-e2e-${Date.now()}`;
    const organizationId = `org-msg-e2e-${Date.now()}`;
    const createdBy = `user-msg-e2e-${Date.now()}`;
    const memberId = `member-msg-e2e-${Date.now()}`;
    const channelId = `D${Date.now().toString(36)}`;
    const canonical = `slack:${channelId}`;

    await seedAgentRow(agentId, { organizationId });
		await sql`
			INSERT INTO "user" (
				id, email, name, username, "emailVerified", "createdAt", "updatedAt"
			) VALUES (
				${createdBy}, ${`${createdBy}@example.test`}, 'Message E2E',
				${createdBy}, true, now(), now()
			)
		`;
		await sql`
			INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
			VALUES (${memberId}, ${organizationId}, ${createdBy}, 'owner', now())
		`;
		const [connectionRow] = await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        credential_mode, config
      ) VALUES (
        ${organizationId}, 'slack', 'agentconn-conn-msg-e2e', 'Slack',
        'active', 'byo', '{}'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO oauth_states (id, scope, payload, expires_at)
      VALUES (
        ${codeHash(code)}, 'slack-preview-claim',
        ${sql.json({
          organizationId,
          agentId,
          createdBy,
          allowedSurfaces: ["dm", "channel"],
          createdAt: Date.now(),
        })},
        now() + interval '1 hour'
      )
    `;

    try {
      // Real registry + real built-in `link` command + real dispatcher.
      const registry = new CommandRegistry();
      registerBuiltInCommands(registry, { agentSettingsStore: {} as never, automationSubscriptionService: {} as never });
      const dispatcher = new CommandDispatcher({
        registry,
				automationSubscriptionService: {
					resolveForConnection: mock(async () => null),
				} as never,
      });

      const conversationState = new ConversationStateStore(
				new InMemoryStateAdapter(),
      );
      const connection: PlatformConnection = {
        id: "conn-msg-e2e",
        platform: "slack",
        agentId: "owner-agent",
        config: { platform: "slack" } as never,
        settings: { allowGroups: true, previewMode: true },
        metadata: { botUsername: "bot", botUserId: "U_BOT" },
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      };
      const enqueueMessage = mock(async () => undefined);
      const services = {
        getArtifactStore: () => null,
        getPublicGatewayUrl: () => "https://gateway.example.com",
				getAutomationSubscriptionService: () => ({
					resolveForConnection: mock(async () => null),
				}),
        getAgentMetadataStore: () => undefined,
        getUserAgentsStore: () => undefined,
        getTranscriptionService: () => undefined,
        getAgentSettingsStore: () => undefined,
        getDeclaredAgentRegistry: () => undefined,
        getQueueProducer: () => ({ enqueueMessage }),
      } as never;
      const manager = {
        has: () => true,
        getInstance: () => ({ connection, conversationState }),
      } as never;
      const bridge = new MessageHandlerBridge(
        connection,
        services,
        manager,
				dispatcher,
      );

      const posts: string[] = [];
      const thread = {
        id: channelId,
        channelId,
        adapter: undefined,
        subscribe: mock(async () => undefined),
        startTyping: mock(async () => undefined),
        post: mock(async (c: unknown) =>
					posts.push(typeof c === "string" ? c : JSON.stringify(c)),
        ),
      };
      const message = {
        id: "M_E2E",
        text: code,
				author: {
					userId: "U_E2E",
					userName: "alice",
					isBot: false,
					isMe: false,
				},
        raw: { team_id: "T_E2E" },
        attachments: [],
        metadata: { dateSent: new Date(), edited: false },
      };

      await bridge.handleMessage(thread as never, message as never, "dm");

      // The link reply was posted, the worker was NOT invoked.
      expect(posts.join("\n")).toContain("Linked this chat to agent");
      expect(posts.join("\n")).toContain(agentId);
      expect(enqueueMessage).not.toHaveBeenCalled();

      // Claim consumed + binding written under the canonical slack:<id> key.
      const remaining = await sql`
        SELECT 1 FROM oauth_states WHERE id = ${codeHash(code)}
      `;
      expect(remaining.length).toBe(0);
      const binding = await listTestAutomationSubscriptions({
        platform: "slack",
        channelId: canonical,
        teamId: "T_E2E",
      });
      expect(binding.length).toBe(1);
      expect(binding[0]?.agent_id).toBe(agentId);
      expect(binding[0]?.organization_id).toBe(organizationId);
    } finally {
			await sql`
				DELETE FROM automations
				WHERE EXISTS (
					SELECT 1
					FROM jsonb_array_elements(COALESCE(triggers, '[]'::jsonb)) trigger
					WHERE COALESCE(
						NULLIF(trigger->'match'->>'channel_key', ''),
						(trigger->>'connector_key') || ':' || (trigger->'match'->>'channel_id')
					) = ${canonical}
				)
			`;
			await sql`DELETE FROM connections WHERE id = ${connectionRow.id}`;
      await sql`DELETE FROM oauth_states WHERE id = ${codeHash(code)}`;
      await sql`DELETE FROM agents WHERE id = ${agentId} AND organization_id = ${organizationId}`;
			await sql`DELETE FROM member WHERE id = ${memberId}`;
      await sql`DELETE FROM organization WHERE id = ${organizationId}`;
			await sql`DELETE FROM "user" WHERE id = ${createdBy}`;
    }
  });
});

/**
 * The unlinked-chat notice deep-links into the Automation editor, and the
 * editor resolves its `connection` param by EXACT match against
 * `connections.slug`. The bridge holds the gateway RUNTIME id instead: for a
 * BYO connection that is the slug minus its `agentconn-` namespace, so it
 * matched no connection AND suppressed the editor's connector+team fallback,
 * leaving the Automation listening across every connection on the platform.
 *
 * This is the seam the bug lived on, so the guard belongs here — asserting
 * against the slug actually stored on the row the editor would list — rather
 * than on `workspaceUnlinkedNotice`, which is handed the converted value.
 */
describe("unlinked DM notice → deep link identifies the connection", () => {
  test("the notice carries connections.slug, never the runtime id", async () => {
    const sql = getDb();
    const stamp = Date.now();
    const agentId = `agent-notice-e2e-${stamp}`;
    const organizationId = `org-notice-e2e-${stamp}`;
    const runtimeConnectionId = `conn-notice-e2e-${stamp}`;
    const connectionSlug = `agentconn-${runtimeConnectionId}`;
    const channelId = `D${stamp.toString(36)}`;

    await seedAgentRow(agentId, { organizationId, name: "Planner" });
    const [connectionRow] = await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        credential_mode, config
      ) VALUES (
        ${organizationId}, 'slack', ${connectionSlug}, 'Slack',
        'active', 'byo', '{}'
      )
      RETURNING id
    `;

    const savedOrigin = process.env.PUBLIC_GATEWAY_URL;
    process.env.PUBLIC_GATEWAY_URL = "https://app.lobu.ai";
    __resetPublicOriginCachesForTests();

    try {
      const conversationState = new ConversationStateStore(
        new InMemoryStateAdapter(),
      );
      const connection: PlatformConnection = {
        id: runtimeConnectionId,
        platform: "slack",
        // No owning agent + no channel Automation = the routing dead end that
        // posts the notice.
        agentId: undefined,
        organizationId,
        config: { platform: "slack" } as never,
        settings: { allowGroups: true, previewMode: false },
        metadata: { botUsername: "bot", botUserId: "U_BOT", teamId: "T_NOTICE" },
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      };
      const enqueueMessage = mock(async () => undefined);
      const services = {
        getArtifactStore: () => null,
        getPublicGatewayUrl: () => "https://app.lobu.ai",
        getAutomationSubscriptionService: () => ({
          resolveForConnection: mock(async () => null),
          // No Automation covers this channel — the dead end under test.
          channelHasMessageSubscription: mock(async () => false),
        }),
        getAgentMetadataStore: () => undefined,
        getUserAgentsStore: () => undefined,
        getTranscriptionService: () => undefined,
        getAgentSettingsStore: () => undefined,
        getDeclaredAgentRegistry: () => undefined,
        getQueueProducer: () => ({ enqueueMessage }),
      } as never;
      const manager = {
        has: () => true,
        getInstance: () => ({ connection, conversationState }),
      } as never;
      const bridge = new MessageHandlerBridge(
        connection,
        services,
        manager,
        undefined as never,
      );

      const posts: string[] = [];
      const thread = {
        id: channelId,
        channelId,
        adapter: undefined,
        subscribe: mock(async () => undefined),
        startTyping: mock(async () => undefined),
        post: mock(async (c: unknown) =>
          posts.push(typeof c === "string" ? c : JSON.stringify(c)),
        ),
      };

      await bridge.handleMessage(
        thread as never,
        {
          id: "M_NOTICE",
          text: "hello, anyone there?",
          author: {
            userId: "U_NOTICE",
            userName: "alice",
            isBot: false,
            isMe: false,
          },
          raw: { team_id: "T_NOTICE" },
          attachments: [],
          metadata: { dateSent: new Date(), edited: false },
        } as never,
        "dm",
      );

      const posted = posts.join("\n");
      expect(posted).toContain("isn't linked");
      // Read the slug back off the row: the assertion has to be that the link
      // names a connection the editor can find, not that it is slug-shaped.
      const [stored] = await sql<{ slug: string }>`
        SELECT slug FROM connections WHERE id = ${connectionRow.id}
      `;
      expect(stored.slug).toBe(connectionSlug);
      expect(posted).toContain(`connection=${stored.slug}`);
      // The runtime id must never reach the URL on its own. `connectionSlug`
      // CONTAINS it, so assert on the param rather than the bare substring.
      expect(posted).not.toContain(`connection=${runtimeConnectionId}`);
      expect(enqueueMessage).not.toHaveBeenCalled();
    } finally {
      if (savedOrigin === undefined) delete process.env.PUBLIC_GATEWAY_URL;
      else process.env.PUBLIC_GATEWAY_URL = savedOrigin;
      __resetPublicOriginCachesForTests();
      await sql`DELETE FROM connections WHERE id = ${connectionRow.id}`;
      await sql`DELETE FROM agents WHERE id = ${agentId} AND organization_id = ${organizationId}`;
      await sql`DELETE FROM organization WHERE id = ${organizationId}`;
    }
  });
});
