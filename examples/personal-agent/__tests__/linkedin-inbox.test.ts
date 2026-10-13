import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { webcrypto } from "node:crypto";
import { linkedInInboxProgram } from "../linkedin-inbox-adapter.js";

function adapter(fetcher: (url: string, init?: any) => Promise<any>) {
  const dom = new JSDOM("", {
    url: "https://www.linkedin.com/feed/",
    runScripts: "outside-only",
  });
  Object.assign(dom.window, {
    fetch: fetcher,
    TextEncoder,
    TextDecoder,
    AbortSignal,
  });
  dom.window.document.cookie = 'JSESSIONID="synthetic-csrf"';
  dom.window.eval(`(${linkedInInboxProgram.toString()})()`);
  return { dom, api: (dom.window as any).__lobuLinkedInInboxV1 };
}

function flight(text = "Alex reacted to your post", age = "12h") {
  const card = [
    "$",
    "div",
    null,
    {
      selectedStateKey: {
        key: {
          value: {
            id: "NotificationReadState_FeNotificationV2Urn(groupBy=urn:li:activity:1000, notificationType=REACTED_TO_YOUR_UPDATE)",
          },
        },
      },
      children: [
        [
          "$",
          "p",
          null,
          { componentkey: "notification-card-headline_random", children: "$2" },
        ],
        ["$", "p", null, { textProps: { children: [age] } }],
      ],
      triggers: [
        {
          url: "https://www.linkedin.com/feed/?highlightedUpdateUrn=urn%3Ali%3Aactivity%3A1000",
        },
      ],
    },
  ];
  return `1:${JSON.stringify([
    ["Original", card],
    ["Deleted", "Deleted noise"],
  ])}\n2:T${new TextEncoder().encode(text).length.toString(16)},${text}3:${JSON.stringify(["$", "div", null, { nextPageRequest: null }])}\n`;
}

describe("LinkedIn source adapter", () => {
  test("decodes Flight byte-length text and stable notification identities, without executing HTML", async () => {
    const { dom, api } = adapter(async () => {
      throw new Error("unexpected fetch");
    });
    try {
      const rows = api.parseNotifications(
        flight("Alex 👋\nreacted to your post")
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].text).toBe("Alex 👋 reacted to your post");
      expect(rows.rows[0].id).toContain("groupBy=urn:li:activity:1000");
      expect(rows.rows[0].occurred_at).toBeNull();
      expect(
        api.parseNotifications(flight("Alex reacted to your post", "13h"))
          .rows[0].revision
      ).toEqual(api.parseNotifications(flight()).rows[0].revision);
      expect(
        api.parseNotifications(flight("Alex and Sam reacted to your post"))
          .rows[0].revision
      ).not.toEqual(api.parseNotifications(flight()).rows[0].revision);
    } finally {
      dom.window.close();
    }
  });

  test("fails closed on changed notification markup and untrusted paging actions", async () => {
    const calls: string[] = [];
    const { dom, api } = adapter(async (url) => {
      calls.push(url);
      if (url !== "/voyager/api/me") throw new Error("must not call an action");
      return {
        ok: true,
        json: async () => ({
          miniProfile: { entityUrn: "urn:li:fs_miniProfile:synthetic-self" },
        }),
      };
    });
    try {
      expect(() => api.parseNotifications('0:{"unknown":"shape"}\n')).toThrow();
      await expect(
        api.read({
          feed: "notifications",
          cursor: JSON.stringify({
            v: 1,
            feed: "notifications",
            account: "urn:li:fsd_profile:synthetic-self",
            page: { pagerId: "deleteNotification" },
          }),
        })
      ).rejects.toThrow();
      expect(calls).toEqual(["/voyager/api/me"]);
    } finally {
      dom.window.close();
    }
  });

  test("message reads use source ids, keep csrf inside the browser, and never mark seen", async () => {
    const calls: string[] = [];
    const profile = "urn:li:fsd_profile:synthetic-self";
    const conversation = `urn:li:msg_conversation:(${profile},synthetic-thread==)`;
    const message = {
      entityUrn: `urn:li:msg_message:(${profile},synthetic-thread==,synthetic-message)`,
      deliveredAt: 1700000000000,
      body: { text: "Hello" },
      sender: {
        hostIdentityUrn: "urn:li:fsd_profile:synthetic-peer",
        participantType: {
          member: {
            firstName: { text: "Alex" },
            lastName: { text: "Example" },
          },
        },
      },
    };
    const { dom, api } = adapter(async (url, init) => {
      calls.push(url);
      expect(init?.method ?? "GET").toBe("GET");
      const data =
        url === "/voyager/api/me"
          ? {
              miniProfile: {
                entityUrn: profile.replace("fsd_profile", "fs_miniProfile"),
              },
            }
          : url.includes("messengerConversations.")
            ? {
                data: {
                  messengerConversationsByCategoryQuery: {
                    elements: [
                      {
                        entityUrn: conversation,
                        conversationUrl:
                          "https://www.linkedin.com/messaging/thread/synthetic-thread/",
                        lastActivityAt: 1700000000000,
                      },
                    ],
                    metadata: {},
                  },
                },
              }
            : {
                data: {
                  messengerMessagesBySyncToken: {
                    elements: [message],
                    metadata: {},
                  },
                },
              };
      return { ok: true, status: 200, json: async () => data };
    });
    try {
      const result = await api.read({ feed: "live_messages", limit: 20 });
      expect(result.rows[0]).toMatchObject({
        id: message.entityUrn,
        text: "Hello",
        from_me: false,
        sender_name: "Alex Example",
      });
      expect(JSON.stringify(result)).not.toContain("synthetic-csrf");
      expect(result.rows[0].conversation_url).toBe(
        "https://www.linkedin.com/messaging/thread/synthetic-thread==/"
      );
      expect(calls.some((url) => url.includes("%28"))).toBe(true);
      expect(calls.every((url) => !/mark|Seen|Read/.test(url))).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  test("observes references only, advances after matching receipt, and retries an unaccepted batch", async () => {
    let headline = "Alex reacted to your post";
    const { dom, api } = adapter(async (url) =>
      url === "/voyager/api/me"
        ? {
            ok: true,
            json: async () => ({
              miniProfile: {
                entityUrn: "urn:li:fs_miniProfile:synthetic-self",
              },
            }),
          }
        : {
            ok: true,
            text: async () =>
              `<script>window.__como_rehydration__ = ${JSON.stringify([flight(headline)])};</script>`,
          }
    );
    Object.defineProperty(dom.window, "crypto", { value: webcrypto });
    const timers: Array<() => Promise<void>> = [];
    dom.window.setTimeout = ((callback: () => Promise<void>) => {
      timers.push(callback);
      return timers.length;
    }) as any;
    dom.window.clearTimeout = () => {
      /* The harness drains its own timer queue. */
    };
    const sent: any[] = [];
    dom.window.postMessage = (message: unknown) => {
      sent.push(message);
    };
    const ack = (message: any, token = "synthetic-token") =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window,
          origin: "https://www.linkedin.com",
          data: {
            type: "lobu-feed-record:ack",
            token,
            sequence: message.sequence,
            ok: true,
          },
        })
      );
    try {
      await api.listen({
        feed: "notifications",
        bridge_id: "synthetic-bridge",
        token: "synthetic-token",
      });
      expect(sent[0].record.events).toEqual([]);
      expect(sent[0].record.checkpoint.previous).toBeNull();
      expect(JSON.stringify(sent[0])).not.toContain(headline);
      ack(sent[0], "wrong-token");
      await timers.shift()!();
      expect(sent[1].record).toEqual(sent[0].record);
      ack(sent[1]);
      headline = "Alex and Sam reacted to your post";
      await timers.shift()!();
      expect(sent[2].record.events).toHaveLength(1);
      expect(sent[2].record.events[0]).toMatchObject({
        event_type: "notification.changed",
        resource_type: "notification",
      });
      expect(sent[2].record.checkpoint.previous).toEqual(
        sent[0].record.checkpoint.next
      );
      expect(JSON.stringify(sent[2])).not.toContain(headline);
      ack(sent[2]);
      await timers.shift()!();
      expect(sent[3].record.events).toEqual([]);
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window,
          origin: "https://www.linkedin.com",
          data: { type: "lobu-feed-record:stop", token: "synthetic-token" },
        })
      );
      await timers.shift()!();
      expect(sent).toHaveLength(4);
    } finally {
      api.detach();
      dom.window.close();
    }
  });

  test("recognizes the continuation encoded as a Flight text record", () => {
    const { dom, api } = adapter(async () => {
      throw new Error("unexpected fetch");
    });
    try {
      const payload = {
        startIndex: 20,
        filterPillType: "All",
        trackingIdsToDrop: ["EntityUrn(groupBy=synthetic)"],
      };
      const request = JSON.stringify({
        $type: "proto.sdui.actions.requests.PaginationRequest",
        pagerId: "com.linkedin.sdui.pagers.notificationsList",
        requestedArguments: { payload },
      });
      const stream = `${flight()}4:T${new TextEncoder().encode(request).length.toString(16)},${request}`;
      expect(api.parseNotifications(stream).next).toEqual(payload);
    } finally {
      dom.window.close();
    }
  });
});
