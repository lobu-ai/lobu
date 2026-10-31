/**
 * Channels as feeds (the feeds-channel consolidation).
 *
 * Pins the productionized contract:
 *   1. ensureChannelFeed materializes a channel with the
 *      `channel_messages` store and null sync lifecycle, is idempotent, and
 *      soft-deletes cleanly.
 *   2. the sync scheduler never queues a channel feed, even with next_run_at
 *      in the past, because its definition declares no `sync` operation.
 *   3. A chat-link Automation materializes the channel's feed under its
 *      connection; archiving it soft-deletes the feed.
 *   4. manage_feeds read_feed is metadata-only for every storage plane.
 *   5. facet derivation: a chat-only connection whose channels are
 *      feeds is NOT mislabeled a data connection.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { AutomationSubscriptionService } from "../../../gateway/channels/automation-subscription-service";
import {
  ensureChannelFeed,
  softDeleteChannelFeed,
} from "../../../gateway/channels/channel-feed";
import type { Env } from "../../../index";
import { materializeDueFeeds } from "../../../scheduled/check-due-feeds";
import { withAclEdgeWrite } from "../../../utils/relationship-validation";
import { getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestConnection } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

let chatConnectionSeq = 0;

/** Stamp the Stage-2a chat marker + provider tenant on a connection so it reads
 *  as a live bot adapter and createChatAutomation can resolve it as the serving conn. */
async function makeChatConnection(opts: {
  orgId: string;
  teamId: string | null;
}): Promise<{ id: number; slug: string }> {
  chatConnectionSeq += 1;
  const sql = getTestDb();
  // The chat facet is declared by the CONNECTOR — via the `x-lobu-chat-platform`
  // marker in its options_schema — not implied by having a credential. Seed a
  // matching slack connector_definition so the facet derivation sees the marker.
  await sql`
    INSERT INTO connector_definitions
      (organization_id, key, name, version, auth_schema, feeds_schema,
       actions_schema, options_schema, status)
    VALUES (${opts.orgId}, 'slack', 'Slack', '1.0.0',
      '{"methods":[{"type":"app_installation"}]}'::jsonb, '{}'::jsonb, NULL,
      '{"x-lobu-chat-platform":"slack"}'::jsonb, 'active')
    ON CONFLICT DO NOTHING
  `;
  const conn = await createTestConnection({
    organization_id: opts.orgId,
    connector_key: "slack",
    display_name: `Org Slack ${opts.orgId} ${opts.teamId ?? "none"} ${chatConnectionSeq}`,
    createDefaultFeed: false,
  });
  const [row] = await sql`
    UPDATE connections
    SET credential_mode = 'managed', external_tenant_id = ${opts.teamId}
    WHERE id = ${conn.id}
    RETURNING slug
  `;
  return { id: conn.id, slug: String(row.slug) };
}

describe("channel feeds", () => {
  let workspace: TestWorkspace;
  let orgId: string;

  beforeAll(async () => {
    // Public workspace so the visibility-gate test can exercise an anonymous
    // reader (who can reach a public org but not its private connections).
    workspace = await TestWorkspace.create({
      name: "Channel Feeds Org",
      visibility: "public",
    });
    orgId = workspace.org.id;
  });

  beforeEach(async () => {
    const sql = getTestDb();
    // Clear only the feed/binding/transcript state between cases; keep the org +
    // role fixtures (TestWorkspace) so the typed clients stay valid.
    await sql`DELETE FROM channel_messages WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM automations WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM feeds WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM connections WHERE organization_id = ${orgId}`;
    // ACL/graph state the membership-gate test materializes.
    await sql`DELETE FROM authz_source_acl_state WHERE organization_id = ${orgId}`;
    // `member_of` is authorization-bearing, so the edge trigger refuses this
    // teardown from outside a sync — a DELETE is guarded exactly like an INSERT.
    await withAclEdgeWrite(sql, async (tx) => {
      await tx`DELETE FROM entity_relationships WHERE organization_id = ${orgId}`;
    });
    await sql`DELETE FROM entity_identities WHERE organization_id = ${orgId}`;
    await sql`
      DELETE FROM entities
      WHERE organization_id = ${orgId}
        AND entity_type_id IN (
          SELECT id FROM entity_types WHERE organization_id = ${orgId} AND slug IN ('$resource', '$member')
        )
    `;
  });

  it("materializes a channel feed with scheduler guards + idempotency", async () => {
    const conn = await makeChatConnection({ orgId, teamId: "TACME" });
    const feedId = await ensureChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: "slack:C100",
    });
    expect(typeof feedId).toBe("number");

    const sql = getDb();
    const rows = await sql`
      SELECT id, schedule, next_run_at, checkpoint, status, feed_key, config
      FROM feeds WHERE connection_id = ${conn.id} AND deleted_at IS NULL
    `;
    expect(rows.length).toBe(1);
    // No sync lifecycle: the scheduler never queues it.
    expect(rows[0]?.next_run_at).toBeNull();
    expect(rows[0]?.schedule).toBeNull();
    expect(rows[0]?.checkpoint).toBeNull();
    expect(rows[0]?.feed_key).toBe("slack:C100");
    expect((rows[0]?.config as { store?: string })?.store).toBe("channel_messages");

    // Idempotent: a second ensure returns the same id, no duplicate row.
    const again = await ensureChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: "slack:C100",
    });
    expect(again).toBe(feedId);
    const count = await sql`
      SELECT COUNT(*)::int AS n FROM feeds
      WHERE connection_id = ${conn.id} AND deleted_at IS NULL
    `;
    expect(Number(count[0]?.n)).toBe(1);

    // Soft-delete retires it.
    await softDeleteChannelFeed({
      connectionId: conn.id,
      channelKey: "slack:C100",
    });
    const live = await sql`
      SELECT COUNT(*)::int AS n FROM feeds
      WHERE connection_id = ${conn.id} AND deleted_at IS NULL
    `;
    expect(Number(live[0]?.n)).toBe(0);
  });

  it("the sync scheduler never queues a channel feed without sync capability", async () => {
    const conn = await makeChatConnection({ orgId, teamId: "TACME" });
    await ensureChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: "slack:C200",
    });
    const sql = getDb();
    // Force a past next_run_at to prove capability selection excludes it, not
    // merely the NULL next_run_at the materializer leaves.
    await sql`
      UPDATE feeds SET next_run_at = now() - interval '1 hour'
      WHERE connection_id = ${conn.id}
        AND config @> '{"store":"channel_messages"}'::jsonb
    `;
    const result = await materializeDueFeeds({} as Env, sql);
    expect(result.dueFeeds).toBe(0);
    expect(result.runsCreated).toBe(0);
  });

  it("createChatAutomation materializes the channel feed; archiveChatAutomation soft-deletes it", async () => {
    const conn = await makeChatConnection({ orgId, teamId: "TACME" });
    const svc = new AutomationSubscriptionService();
    const { agentId } = await createTestAgent({ organizationId: orgId });

    await svc.createChatAutomation(agentId, "slack", "slack:C300", "TACME", {
      organizationId: orgId,
      connectionId: Number(conn.id),
    });

    const sql = getDb();
    const bound = await sql`
      SELECT feed_key, connection_id, config FROM feeds
      WHERE organization_id = ${orgId} AND deleted_at IS NULL
    `;
    expect(bound.length).toBe(1);
    expect((bound[0]?.config as { store?: string })?.store).toBe("channel_messages");
    expect(bound[0]?.feed_key).toBe("slack:C300");
    expect(Number(bound[0]?.connection_id)).toBe(conn.id);

    const deleted = await svc.archiveChatAutomation(
      agentId,
      "slack:C300",
      Number(conn.id),
      orgId
    );
    expect(deleted).toBe(true);
    const after = await sql`
      SELECT COUNT(*)::int AS n FROM feeds
      WHERE organization_id = ${orgId} AND deleted_at IS NULL
    `;
    expect(Number(after[0]?.n)).toBe(0);
  });

  it("create_version reconciles channel feeds when message triggers change", async () => {
    const conn = await makeChatConnection({ orgId, teamId: "TACME" });
    const { agentId } = await createTestAgent({ organizationId: orgId });
    const created = (await workspace.owner.automations.create({
      slug: "versioned-channel-feed",
      prompt: "Respond to channel messages.",
      managed_agent_id: agentId,
      triggers: [],
    })) as { automation_id: string; revision: string };
    const messageTrigger = {
      kind: "event" as const,
      connector_key: "slack",
      connection_id: conn.id,
      event_types: ["message.created"],
      match: { channel_id: "C350" },
      execution: "turn" as const,
      active_run: "steer" as const,
      output: "reply_to_source" as const,
      skip_if_unchanged: false,
    };

    const changed = await workspace.owner.automations.createVersion({
      automation_id: created.automation_id,
      expected_revision: created.revision,
      triggers: [messageTrigger],
    }) as { revision: string };

    const sql = getDb();
    const active = await sql`
      SELECT feed_key, deleted_at FROM feeds
      WHERE organization_id = ${orgId} AND connection_id = ${conn.id}
    `;
    expect(active).toHaveLength(1);
    expect(active[0]?.feed_key).toBe("slack:C350");
    expect(active[0]?.deleted_at).toBeNull();

    await workspace.owner.automations.createVersion({
      automation_id: created.automation_id,
      expected_revision: changed.revision,
      triggers: [],
    });

    const [removed] = await sql`
      SELECT deleted_at FROM feeds
      WHERE organization_id = ${orgId} AND connection_id = ${conn.id}
        AND feed_key = 'slack:C350'
    `;
    expect(removed.deleted_at).not.toBeNull();
  });

  it("read_feed returns channel-feed metadata without its transcript", async () => {
    const conn = await makeChatConnection({ orgId, teamId: "TACME" });
    const feedId = await ensureChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: "slack:C400",
    });

    // channel_messages is keyed by the runtime connection id (the slug with the
    // BYO namespace stripped) + the native channel id — mirror what the read
    // path resolves from the feed.
    const runtimeConnId = conn.slug.startsWith("agentconn-")
      ? conn.slug.slice(10)
      : conn.slug;
    const sql = getTestDb();
    for (const [i, [author, isBot, text]] of (
      [
        ["Alice", false, "hello team"],
        ["assistant", true, "hi Alice"],
      ] as Array<[string, boolean, string]>
    ).entries()) {
      await sql`
        INSERT INTO channel_messages (
          organization_id, connection_id, platform, channel_id,
          platform_message_id, author_name, is_bot, text, occurred_at
        ) VALUES (
          ${orgId}, ${runtimeConnId}, 'slack', 'C400',
          ${`m${i}`}, ${author}, ${isBot}, ${text},
          ${new Date(Date.now() + i * 1000)}
        )
      `;
    }

    const result = (await workspace.owner.feeds.manage({
      action: "read_feed",
      feed_id: feedId,
    })) as {
      action: string;
      feed?: { id: number; store: string };
      recent_runs?: unknown[];
      messages?: unknown[];
    };

    expect(result.action).toBe("read_feed");
    expect(result.feed?.id).toBe(feedId);
    expect(result.feed?.store).toBe("channel_messages");
    expect(result.recent_runs).toEqual([]);
    expect(result.messages).toBeUndefined();
  });

  it("trigger_feed rejects a channel feed without sync capability", async () => {
    const conn = await makeChatConnection({ orgId, teamId: "TACME" });
    const feedId = await ensureChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: "slack:C600",
    });

    const res = (await workspace.owner.feeds.manage({
      action: "trigger_feed",
      feed_id: feedId,
    })) as { triggered?: boolean; run_id?: string; error?: string };

    // A channel feed has no connector fetch for its feed_key; triggering a
    // sync would spawn a run against nothing. Reject before createSyncRun.
    expect(res.triggered).toBeUndefined();
    expect(res.run_id).toBeUndefined();
    expect(res.error).toContain("does not support sync");
  });

  it("read_feed on an event-store feed returns runs, not a transcript", async () => {
    // A plain connection with the default event-store feed.
    const conn = await createTestConnection({
      organization_id: orgId,
      connector_key: "slack",
      display_name: "Event-store Slack",
    });
    const sql = getTestDb();
    const feedRow = (await sql`
      SELECT id FROM feeds WHERE connection_id = ${conn.id} AND deleted_at IS NULL
    `) as Array<{ id: number }>;

    // Metadata includes recent sync runs, never a channel_messages transcript.
    const res = (await workspace.owner.feeds.manage({
      action: "read_feed",
      feed_id: feedRow[0].id,
    })) as {
      feed?: { id: number; store: string };
      recent_runs?: unknown[];
      messages?: unknown[];
      error?: string;
    };
    expect(res.error).toBeUndefined();
    expect(res.feed?.store).toBe("events");
    expect(res.messages).toBeUndefined();
    expect(Array.isArray(res.recent_runs)).toBe(true);
    expect(res.feed?.id).toBe(feedRow[0].id);
  });

  it("archiveAllChatAutomations soft-deletes each unbound channel feed", async () => {
    const conn = await makeChatConnection({ orgId, teamId: "TACME" });
    const svc = new AutomationSubscriptionService();
    const { agentId } = await createTestAgent({ organizationId: orgId });

    await svc.createChatAutomation(agentId, "slack", "slack:C700", "TACME", {
      organizationId: orgId,
			connectionId: Number(conn.id),
    });
    await svc.createChatAutomation(agentId, "slack", "slack:C701", "TACME", {
      organizationId: orgId,
			connectionId: Number(conn.id),
    });

    const sql = getDb();
    const before = await sql`
      SELECT COUNT(*)::int AS n FROM feeds
      WHERE organization_id = ${orgId}
        AND config @> '{"store":"channel_messages"}'::jsonb
        AND deleted_at IS NULL
    `;
    expect(Number(before[0]?.n)).toBe(2);

    const removed = await svc.archiveAllChatAutomations(agentId, orgId);
    expect(removed).toBe(2);

    // Both channel feeds are retired: no live orphan feed remains.
    const after = await sql`
      SELECT COUNT(*)::int AS n FROM feeds
      WHERE organization_id = ${orgId}
        AND config @> '{"store":"channel_messages"}'::jsonb
        AND deleted_at IS NULL
    `;
    expect(Number(after[0]?.n)).toBe(0);
  });

  it("a chat-only connection with channel feeds is not labeled a data connection", async () => {
    const conn = await makeChatConnection({ orgId, teamId: "TACME" });
    await ensureChannelFeed({
      connectionId: conn.id,
      organizationId: orgId,
      channelKey: "slack:C500",
    });

    const result = (await workspace.owner.connections.get(conn.id)) as {
      connection: {
        facets: { data: boolean; chat: boolean };
        feed_count: number;
      };
    };
    // The channel feed shows in the rail (feed_count > 0)…
    expect(result.connection.feed_count).toBeGreaterThan(0);
    // …but it does NOT make the connection claim the data facet.
    expect(result.connection.facets.data).toBe(false);
    expect(result.connection.facets.chat).toBe(true);
  });

  it("does not expose a private connection's feed metadata to an anonymous caller", async () => {
    // A private chat connection: visible only to its creator / org admins.
    chatConnectionSeq += 1;
    const priv = await createTestConnection({
      organization_id: orgId,
      connector_key: "slack",
      display_name: `Private Slack ${orgId} TPRIV ${chatConnectionSeq}`,
      visibility: "private",
      created_by: workspace.users.owner.id,
      createDefaultFeed: false,
    });
    const sql = getTestDb();
    await sql`
      UPDATE connections SET credential_mode = 'managed', external_tenant_id = 'TPRIV'
      WHERE id = ${priv.id}
    `;
    const slugRow = (await sql`SELECT slug FROM connections WHERE id = ${priv.id}`) as Array<{
      slug: string;
    }>;
    const runtimeConnId = slugRow[0].slug.startsWith("agentconn-")
      ? slugRow[0].slug.slice(10)
      : slugRow[0].slug;
    const feedId = await ensureChannelFeed({
      connectionId: priv.id,
      organizationId: orgId,
      channelKey: "slack:CPRIV",
    });
    await sql`
      INSERT INTO channel_messages (
        organization_id, connection_id, platform, channel_id,
        platform_message_id, author_name, is_bot, text, occurred_at
      ) VALUES (
        ${orgId}, ${runtimeConnId}, 'slack', 'CPRIV',
        'mp', 'Secret', false, 'private secret message', NOW()
      )
    `;

    // Owner (creator) can inspect metadata, but even the owner gets no content.
    const ownerRes = (await workspace.owner.feeds.manage({
      action: "read_feed",
      feed_id: feedId,
    })) as { feed?: { id: number }; messages?: unknown[]; error?: string };
    expect(ownerRes.feed?.id).toBe(feedId);
    expect(ownerRes.messages).toBeUndefined();

    // Anonymous reader of the public org cannot see the private connection's
    // feed metadata.
    const anonRes = (await workspace.asAnonymous().feeds.manage({
      action: "read_feed",
      feed_id: feedId,
    })) as { messages?: unknown[]; error?: string };
    expect(anonRes.messages).toBeUndefined();
    expect(anonRes.error).toBe("Feed not found");
  });
});
