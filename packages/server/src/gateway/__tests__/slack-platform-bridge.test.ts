import { describe, expect, mock, test } from "bun:test";

import {
  parseSlackMemberLeftEvent,
  parseSlackTeamJoinEvent,
  postSlackTeamJoinWelcome,
  registerSlackAppHome,
  registerSlackAssistantStarters,
  registerSlackPlatformHandlers,
} from "../connections/slack-platform-bridge.js";

function blocksText(view: { blocks?: Array<Record<string, unknown>> }): string {
  return JSON.stringify(view.blocks ?? []);
}

type HomeHandler = (event: {
  userId: string;
  adapter?: {
    publishHomeView?: (u: string, v: Record<string, unknown>) => Promise<void>;
  };
}) => Promise<void>;

function makeHomeChat() {
  let homeHandler: HomeHandler | undefined;
  const chat = {
    onAppHomeOpened: mock((h: HomeHandler) => {
      homeHandler = h;
    }),
  };
  return {
    chat,
    open: (userId: string, publishHomeView: ReturnType<typeof mock>) =>
      homeHandler?.({ userId, adapter: { publishHomeView } }),
  };
}

describe("Slack platform bridge", () => {
  test("routes /lobu slash commands through the command dispatcher", async () => {
    let slashHandler:
      | ((event: {
          text?: string;
          raw?: Record<string, unknown>;
          user?: { userId?: string };
          channel?: { post: (content: any) => Promise<unknown> };
        }) => Promise<void>)
      | undefined;
    const chat = {
      onSlashCommand: mock((command: string, handler: typeof slashHandler) => {
        expect(command).toBe("/lobu");
        slashHandler = handler;
      }),
    };
    const tryHandle = mock(async () => true);

    registerSlackPlatformHandlers(
      chat,
      { id: "conn-1", platform: "slack" } as any,
      { tryHandle } as any
    );

    const post = mock(async () => undefined);
    await slashHandler?.({
      text: "status now",
      raw: { channel_id: "C123", team_id: "T123", user_id: "U123" },
      user: { userId: "U123" },
      channel: { post },
    });

    expect(tryHandle).toHaveBeenCalledTimes(1);
    expect(tryHandle.mock.calls[0]?.[0]).toBe("status");
    expect(tryHandle.mock.calls[0]?.[1]).toBe("now");
    expect(tryHandle.mock.calls[0]?.[2]).toMatchObject({
      platform: "slack",
      userId: "U123",
      // Canonical `slack:<id>` form — matches the message-handler bridge's
      // thread channel id, so getBinding lookups agree across ingress paths.
      channelId: "slack:C123",
      teamId: "T123",
      isGroup: true,
      connectionId: "conn-1",
    });
  });

  test("replies when /lobu receives an unknown subcommand", async () => {
    let slashHandler:
      | ((event: {
          text?: string;
          raw?: Record<string, unknown>;
          user?: { userId?: string };
          channel?: { post: (content: any) => Promise<unknown> };
        }) => Promise<void>)
      | undefined;
    const chat = {
      onSlashCommand: mock((_: string, handler: typeof slashHandler) => {
        slashHandler = handler;
      }),
    };
    const post = mock(async () => undefined);

    registerSlackPlatformHandlers(
      chat,
      { id: "conn-1", platform: "slack" } as any,
      { tryHandle: mock(async () => false) } as any
    );

    await slashHandler?.({
      text: "unknown",
      raw: { channel_id: "D123", team_id: "T123", user_id: "U123" },
      user: { userId: "U123" },
      channel: { post },
    });

    expect(post).toHaveBeenCalledWith(
      "Unknown /lobu subcommand: unknown. Try `/lobu help`."
    );
  });

  const connection = (over: Record<string, unknown> = {}) =>
    ({
      id: "conn-1",
      platform: "slack",
      agentId: "agent-7",
      organizationId: "org-test",
      metadata: { botUsername: "Lobster" },
      settings: {},
      ...over,
    }) as any;

  test("home tab stays inside Slack's limits with a large inbox and history", async () => {
    // Slack rejects the whole views.publish past 100 blocks, or past 3000 chars
    // in any one section — so an unbounded inbox produced NO home tab, not a
    // truncated one. This pins the clamp rather than the helper that does it.
    const many = (n: number, make: (i: number) => unknown) =>
      Array.from({ length: n }, (_, i) => make(i));
    const h = makeHomeChat();
    registerSlackAppHome(h.chat, connection(), {
      publicGatewayUrl: "https://app.lobu.ai",
      resolveUserInbox: mock(async () => ({
        orgSlug: "acme",
        unreadCount: 400,
        items: many(400, (i) => ({
          title: `Notification ${i} ${"x".repeat(120)}`,
          url: `/acme/events/${i}`,
          isRead: false,
        })),
      })) as never,
      resolveHomeContext: mock(async () => ({
        orgSlug: "acme",
        entitiesTracked: 1,
        capturedToday: 1,
        recent: many(400, (i) => ({
          title: `Recent ${i} ${"y".repeat(120)}`,
          platform: "gmail",
          ts: 1_700_000_000 + i,
        })),
      })) as never,
    });
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    const view = publishHomeView.mock.calls[0]![1] as {
      blocks: Array<Record<string, unknown>>;
    };
    expect(view.blocks.length).toBeLessThanOrEqual(100);
    for (const block of view.blocks) {
      const text = (block.text as { text?: string } | undefined)?.text;
      if (typeof text === "string") expect(text.length).toBeLessThanOrEqual(3000);
    }
    // Still says how much it dropped rather than silently showing a prefix.
    expect(blocksText(view)).toContain("more_");
  });

  test("home tab renders the bot intro with only the default deps", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(h.chat, connection(), {});
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    const view = publishHomeView.mock.calls[0]![1] as {
      blocks: Array<Record<string, unknown>>;
    };
    expect(blocksText(view)).toContain("Lobster");
  });

  test("home tab renders the dashboard card with a slug deep link and org counts", async () => {
    const h = makeHomeChat();
    const resolveHomeContext = mock(async () => ({
      orgSlug: "acme",
      entitiesTracked: 976,
      capturedToday: 5,
      recent: [
        { title: "Acme raised a Series B", platform: "gmail", ts: 1_700_000_000 },
        { title: "Standup notes", platform: null, ts: 1_700_000_100 },
      ],
    }));
    registerSlackAppHome(h.chat, connection(), {
      publicGatewayUrl: "https://gw.example/",
      resolveHomeContext,
    });
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);

    expect(resolveHomeContext).toHaveBeenCalledWith("org-test");
    const text = blocksText(
      publishHomeView.mock.calls[0]![1] as {
        blocks?: Array<Record<string, unknown>>;
      }
    );
    // Deep link uses the org slug, trailing slash trimmed.
    expect(text).toContain("https://gw.example/acme");
    expect(text).toContain("Open dashboard");
    // Counts render as a context line.
    expect(text).toContain("976 tracked");
    expect(text).toContain("5 captured today");
    // Recent activity list renders with a source label and a Slack date token.
    expect(text).toContain("Recent activity");
    expect(text).toContain("Acme raised a Series B");
    expect(text).toContain("Gmail");
    expect(text).toContain("<!date^1700000000");
  });

  test("recent titles are escaped and the list is skipped when empty", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(h.chat, connection(), {
      publicGatewayUrl: "https://gw.example",
      resolveHomeContext: mock(async () => ({
        orgSlug: "acme",
        entitiesTracked: 1,
        capturedToday: 0,
        recent: [{ title: "<script>&", platform: null, ts: 1 }],
      })),
    });
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    const text = blocksText(publishHomeView.mock.calls[0]![1] as any);
    expect(text).toContain("Recent activity");
    // mrkdwn control chars escaped, JSON-encoded in the serialized blocks.
    expect(text).toContain("&lt;script&gt;&amp;");
    expect(text).not.toContain("<script>");
  });

  test("dashboard card links to the web root and omits counts when context is unavailable", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(h.chat, connection(), {
      publicGatewayUrl: "https://gw.example",
      resolveHomeContext: mock(async () => null),
    });
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);

    const view = publishHomeView.mock.calls[0]![1] as {
      blocks: Array<Record<string, unknown>>;
    };
    const text = blocksText(view);
    expect(text).toContain('"url":"https://gw.example"');
    expect(text).toContain("Open dashboard");
    // No counts line, and no crash on a null context.
    expect(view.blocks.some((b) => b.type === "context")).toBe(false);
  });

  test("dashboard card is skipped without a public gateway url", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(h.chat, connection(), {
      resolveHomeContext: mock(async () => ({
        orgSlug: "acme",
        entitiesTracked: 1,
        capturedToday: 1,
        recent: [],
      })),
    });
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    expect(blocksText(publishHomeView.mock.calls[0]![1] as any)).not.toContain(
      "Open dashboard"
    );
  });

  test("preview workspaces don't render the dashboard card", async () => {
    const h = makeHomeChat();
    const resolveHomeContext = mock(async () => ({
      orgSlug: "acme",
      entitiesTracked: 1,
      capturedToday: 1,
      recent: [],
    }));
    registerSlackAppHome(
      h.chat,
      connection({ settings: { previewMode: true } }),
      { publicGatewayUrl: "https://gw.example", resolveHomeContext }
    );
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    expect(resolveHomeContext).not.toHaveBeenCalled();
    expect(blocksText(publishHomeView.mock.calls[0]![1] as any)).not.toContain(
      "Open dashboard"
    );
  });

  test("renders personal notifications with absolute links and an unread count", async () => {
    const h = makeHomeChat();
    const resolveUserInbox = mock(async () => ({
      unreadCount: 2,
      orgSlug: "acme",
      items: [
        { title: "Series B closed", url: "/acme/companies/1", isRead: false },
        { title: "Synced", url: "https://x.test/full", isRead: true },
        { title: "No link", url: null, isRead: true },
      ],
    }));
    registerSlackAppHome(
      h.chat,
      connection({ metadata: { botUsername: "Lobster", teamId: "T_HOME" } }),
      {
        publicGatewayUrl: "https://gw.example/",
        resolveUserInbox,
      }
    );
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);

    // resolveUserInbox is called with (slackUserId, teamId) — always the
    // connection's real workspace, never an unscoped lookup.
    expect(resolveUserInbox).toHaveBeenCalledWith("U123", "T_HOME");
    const text = blocksText(publishHomeView.mock.calls[0]![1] as any);
    expect(text).toContain("Notifications");
    expect(text).toContain("2 unread");
    // relative resource_url made absolute against the web origin
    expect(text).toContain("<https://gw.example/acme/companies/1|Series B closed>");
    // already-absolute url left as-is
    expect(text).toContain("<https://x.test/full|Synced>");
    // unread vs read markers present
    expect(text).toContain(":large_blue_circle:");
    expect(text).toContain(":white_circle:");
  });

  test("passes the connection team_id to resolveUserInbox for workspace installs", async () => {
    const h = makeHomeChat();
    const resolveUserInbox = mock(async () => null);
    registerSlackAppHome(
      h.chat,
      connection({ metadata: { botUsername: "Lobster", teamId: "T_WORKSPACE" } }),
      { publicGatewayUrl: "https://gw.example/", resolveUserInbox },
    );
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    // Must be scoped to the connection's workspace — a different workspace's
    // identity row with the same platform_user_id must NOT be returned.
    expect(resolveUserInbox).toHaveBeenCalledWith("U123", "T_WORKSPACE");
  });

  test("skips the inbox lookup entirely when the connection has no team_id", async () => {
    const h = makeHomeChat();
    const resolveUserInbox = mock(async () => null);
    // A connection with no workspace cannot be scoped, and Slack `U…` ids are
    // unique per workspace — so resolve nothing rather than an unscoped inbox.
    registerSlackAppHome(h.chat, connection(), {
      publicGatewayUrl: "https://gw.example/",
      resolveUserInbox,
    });
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    expect(resolveUserInbox).not.toHaveBeenCalled();
  });

  test("omits the notifications section when the user has no linked inbox", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(h.chat, connection(), {
      publicGatewayUrl: "https://gw.example",
      resolveUserInbox: mock(async () => null),
    });
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    expect(blocksText(publishHomeView.mock.calls[0]![1] as any)).not.toContain(
      "Notifications"
    );
  });

  test("preview home shows a 'Set up your agent' button plus the link-code hint", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(
      h.chat,
      connection({ settings: { previewMode: true } }),
      { publicGatewayUrl: "https://gw.example/" }
    );
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    const text = blocksText(publishHomeView.mock.calls[0]![1] as any);
    expect(text).toContain("Set up your agent");
    // No resolved identity → no org → setup button points at the web root.
    expect(text).toContain('"url":"https://gw.example"');
    expect(text).toContain("/lobu link");
  });

  test("preview setup button deep-links to the user's org home when known", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(
      h.chat,
      connection({
        metadata: { botUsername: "Lobster", teamId: "T_PREVIEW" },
        settings: { previewMode: true },
      }),
      {
        publicGatewayUrl: "https://gw.example",
        resolveUserInbox: mock(async () => ({
          unreadCount: 0,
          orgSlug: "acme",
          items: [],
        })),
      }
    );
    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);
    const text = blocksText(publishHomeView.mock.calls[0]![1] as any);
    // /{org} (the Builder home), NOT /{org}/agents — the latter redirects.
    expect(text).toContain('"url":"https://gw.example/acme"');
  });

  test("falls back to a minimal home view if the rich view is rejected", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(h.chat, connection(), {});
    let calls = 0;
    const publishHomeView = mock(async () => {
      calls += 1;
      if (calls === 1) throw new Error("invalid_blocks");
    });
    await h.open("U123", publishHomeView);
    expect(publishHomeView).toHaveBeenCalledTimes(2);
    const fallback = publishHomeView.mock.calls[1]![1] as {
      type: string;
      blocks: Array<Record<string, unknown>>;
    };
    expect(fallback.type).toBe("home");
    expect(fallback.blocks.length).toBe(1);
    expect(blocksText(fallback)).toContain("/lobu help");
  });

  test("renders the preview-workspace home tab with the setup prompt", async () => {
    const h = makeHomeChat();
    registerSlackAppHome(
      h.chat,
      connection({ agentId: "placeholder", settings: { previewMode: true } }),
      {
        publicGatewayUrl: "https://gw.example",
      }
    );

    const publishHomeView = mock(async () => undefined);
    await h.open("U123", publishHomeView);

    const text = blocksText(
      publishHomeView.mock.calls[0]![1] as {
        blocks?: Array<Record<string, unknown>>;
      }
    );
    expect(text).toContain("Set up your agent");
    expect(text).toContain("/lobu link");
  });

  test("parses and welcomes Slack team_join users", async () => {
    const parsed = parseSlackTeamJoinEvent(
      JSON.stringify({
        type: "event_callback",
        team_id: "T123",
        event: {
          type: "team_join",
          user: {
            id: "U123",
            profile: { display_name: "Ada" },
          },
        },
      }),
      "application/json"
    );

    expect(parsed).toEqual({
      teamId: "T123",
      userId: "U123",
      displayName: "Ada",
    });

    const post = mock(async () => undefined);
    const chat = {
      openDM: mock(async (userId: string) => {
        expect(userId).toBe("U123");
        return { post };
      }),
    };

    await postSlackTeamJoinWelcome(chat, parsed!);

    expect(post).toHaveBeenCalledWith(
      "Welcome to Lobu, Ada. Mention me in a channel or send me a DM to start a thread. Use `/lobu help` to see the built-in commands."
    );
  });

  test("parses member_left_channel without treating joins as revocations", () => {
    const payload = {
      type: "event_callback",
      event: { team: "T123", user: "U123", channel: "C123" },
    };

    expect(
      parseSlackMemberLeftEvent(
        JSON.stringify({
          ...payload,
          event: { ...payload.event, type: "member_left_channel" },
        }),
        "application/json",
      ),
    ).toEqual({
      teamId: "T123",
      userId: "U123",
      channelId: "C123",
    });
    expect(
      parseSlackMemberLeftEvent(
        JSON.stringify({
          ...payload,
          event: { ...payload.event, type: "member_joined_channel" },
        }),
        "application/json",
      ),
    ).toBeNull();
  });
});

describe("Slack assistant starters", () => {
  const starters = [{ title: "Plan videos", message: "Plan this week's videos" }];
  const connection = (over: Record<string, unknown> = {}) =>
    ({ id: "conn-1", platform: "slack", agentId: "agent-7", ...over }) as any;

  function start(
    conn: any,
    loadStarters: (agentId: string) => Promise<typeof starters | undefined>,
  ) {
    let handler: ((event: any) => Promise<void>) | undefined;
    const chat = {
      onAssistantThreadStarted: mock((h: typeof handler) => {
        handler = h;
      }),
    };
    const setSuggestedPrompts = mock(async () => {});
    registerSlackAssistantStarters(chat, conn, {
      adapter: { setSuggestedPrompts },
      loadStarters,
    });
    return {
      chat,
      setSuggestedPrompts,
      fire: () => handler?.({ channelId: "D123", threadTs: "1700.1" }),
    };
  }

  test("offers the connection agent's starters on a new assistant thread", async () => {
    const loadStarters = mock(async () => starters);
    const h = start(connection(), loadStarters);
    await h.fire();
    expect(loadStarters).toHaveBeenCalledWith("agent-7");
    expect(h.setSuggestedPrompts).toHaveBeenCalledWith("D123", "1700.1", starters);
  });

  test("leaves the thread alone when the agent has no starters", async () => {
    const h = start(connection(), async () => undefined);
    await h.fire();
    expect(h.setSuggestedPrompts).not.toHaveBeenCalled();
  });

  test("uses the current agent after a warm connection is bound, reassigned, or unbound", async () => {
    const conn = connection({ agentId: undefined });
    const loadStarters = mock(async () => starters);
    const h = start(conn, loadStarters);
    await h.fire();
    expect(loadStarters).not.toHaveBeenCalled();

    conn.agentId = "agent-8";
    await h.fire();
    expect(loadStarters).toHaveBeenLastCalledWith("agent-8");
    conn.agentId = "agent-9";
    await h.fire();
    expect(loadStarters).toHaveBeenLastCalledWith("agent-9");
    delete conn.agentId;
    await h.fire();
    expect(loadStarters).toHaveBeenCalledTimes(2);
    expect(h.setSuggestedPrompts).toHaveBeenCalledTimes(2);
  });

  test("does not subscribe off Slack", () => {
    expect(
      start(connection({ platform: "telegram" }), async () => starters).chat
        .onAssistantThreadStarted,
    ).not.toHaveBeenCalled();
  });

  test("a failed starters lookup never throws into the Slack handler", async () => {
    const h = start(connection(), async () => {
      throw new Error("db down");
    });
    await expect(h.fire()).resolves.toBeUndefined();
    expect(h.setSuggestedPrompts).not.toHaveBeenCalled();
  });
});
