import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { webcrypto } from "node:crypto";
import { linkedInInboxProgram } from "../linkedin-inbox-adapter.js";
import { observeLinkedInInbox, readLinkedInInbox } from "../linkedin-inbox";
import LinkedInConnector from "../linkedin.connector";

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
  Object.defineProperty(dom.window, "crypto", {
    value: webcrypto,
    configurable: true,
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
  test("a structured empty notification continuation exhausts the source", async () => {
    const empty = `1:"synthetic-module"\n2:I["$1",[],"default"]\n0:${JSON.stringify(
      [
        [
          ["$", "$L2", null, { modelStates: [], isPartialPage: true }],
          "$undefined",
        ],
        "$undefined",
        [],
        "$undefined",
        "$undefined",
        "$0:0:0:props:modelStates",
        null,
        "synthetic-version",
        "$undefined",
        { version: "synthetic-version" },
      ]
    )}\n`;
    const payload = {
      startIndex: 20,
      filterPillType: "All",
      trackingIdsToDrop: [],
    };
    const firstPage = `${flight()}4:${JSON.stringify([
      "$",
      "div",
      null,
      {
        nextPageRequest: {
          pagerId: "com.linkedin.sdui.pagers.notificationsList",
          requestedArguments: { payload },
        },
      },
    ])}\n`;
    let initialStream = firstPage;
    let stream = empty;
    const { dom, api } = adapter(async (url, init) =>
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
              init?.body
                ? stream
                : `<script>window.__como_rehydration__ = ${JSON.stringify([initialStream])};</script>`,
          }
    );
    let cursor: string;
    const readNext = () =>
      api.read({
        feed: "notifications",
        cursor,
      });
    const sent: any[] = [];
    dom.window.postMessage = (message: unknown) => {
      sent.push(message);
    };
    try {
      const first = await api.read({ feed: "notifications" });
      expect(first.hasMore).toBe(true);
      expect(first.rows).toHaveLength(1);
      cursor = first.nextCursor;
      expect(JSON.parse(cursor).page).toEqual(payload);
      await expect(readNext()).resolves.toEqual({ rows: [], hasMore: false });
      await api.listen({
        feed: "notifications",
        bridge_id: "synthetic-bridge",
        token: "synthetic-token",
        checkpoint: {
          linkedin_inbox: {
            feed: "notifications",
            account: "urn:li:fsd_profile:synthetic-self",
            seen: {},
          },
        },
      });
      expect(sent).toHaveLength(1);
      expect(sent[0].record.events).toEqual([
        expect.objectContaining({
          event_type: "notification.changed",
          resource_ref: first.rows[0].id,
        }),
      ]);
      expect(sent[0].record.more).toBe(false);
      expect(sent[0].record.source_error).toBeUndefined();
      expect(
        Object.keys(sent[0].record.checkpoint.next.linkedin_inbox.seen)
      ).toHaveLength(1);
      const checkpoint = sent[0].record.checkpoint.next;
      sent.length = 0;
      await api.listen({
        feed: "notifications",
        bridge_id: "synthetic-bridge",
        token: "synthetic-token",
        checkpoint,
      });
      expect(sent[0].record.events).toEqual([]);
      initialStream = empty;
      await expect(api.read({ feed: "notifications" })).rejects.toThrow(
        "Notification source format changed"
      );
      for (const changed of [
        empty.replace(
          '"modelStates":[]',
          '"modelStates":[{"unrecognized":"content"}]'
        ),
        empty.replace(
          '"isPartialPage":true',
          '"isPartialPage":true,"children":["new card format"]'
        ),
        empty.replace('"isPartialPage":true', '"isPartialPage":false'),
        '0:{"unrecognized":"notification response"}\n',
      ]) {
        stream = changed;
        await expect(readNext()).rejects.toThrow(
          "Notification source format changed"
        );
      }
    } finally {
      api.detach();
      dom.window.close();
    }
  });

  test("read and observe preserve a warm page's existing subscription", async () => {
    const settledUrl = "https://www.linkedin.com/feed/foryou/";
    expect(new LinkedInConnector().definition.browser?.accountProbe?.url).toBe(
      settledUrl
    );
    let documentLoads = 0;
    const browser = {
      dispatch: async (operation: string, input: any) => {
        if (operation === "navigate") {
          expect(input.persistent).toBe(true);
          // The extension retains a warm document only for the same route.
          // LinkedIn redirects /feed/ to /feed/foryou/ on every navigation.
          if (input.url !== settledUrl) documentLoads++;
          return { tab_id: 42 };
        }
        if (operation === "feed_listen")
          return {
            bridge_id: "synthetic-bridge",
            token: "synthetic-token",
            listening: true,
            subscription: { scope_key: "synthetic-scope" },
          };
        return { value: { rows: [], listening: true } };
      },
    };
    await observeLinkedInInbox({ browser, feedKey: "notifications" } as any);
    await observeLinkedInInbox({ browser, feedKey: "live_messages" } as any);
    await readLinkedInInbox({ browser, feedKey: "notifications" } as any);
    expect(documentLoads).toBe(0);
  });

  test("a full recent message page reports a gap and advances instead of wedging on rebind", async () => {
    const now = Date.now();
    const mailbox = "urn:li:fsd_profile:synthetic-self";
    const thread = `urn:li:msg_conversation:(${mailbox},synthetic-thread)`;
    const { dom, api } = adapter(async (url) => ({
      ok: true,
      json: async () =>
        url === "/voyager/api/me"
          ? {
              miniProfile: {
                entityUrn: mailbox.replace("fsd_profile", "fs_miniProfile"),
              },
            }
          : url.includes("messengerConversations.")
            ? {
                data: {
                  messengerConversationsByCategoryQuery: {
                    elements: [
                      { entityUrn: thread, lastActivityAt: now - 90000 },
                    ],
                    metadata: {},
                  },
                },
              }
            : {
                data: {
                  messengerMessagesBySyncToken: {
                    elements: Array.from({ length: 20 }, (_, i) => ({
                      entityUrn: `urn:li:msg_message:synthetic-${i}`,
                      deliveredAt: now - 90000 + i,
                      body: { text: "Private message body" },
                    })),
                    metadata: {},
                  },
                },
              },
    }));
    Object.defineProperty(dom.window, "crypto", { value: webcrypto });
    const sent: any[] = [];
    dom.window.postMessage = (message: unknown) => {
      sent.push(message);
    };
    const checkpoint = {
      linkedin_inbox: {
        feed: "live_messages",
        account: mailbox,
        started_at: now - 120000,
        after: now - 120000,
        seen: {},
      },
    };
    try {
      await api.listen({
        feed: "live_messages",
        bridge_id: "synthetic-bridge",
        token: "synthetic-token",
        checkpoint,
      });
      const batch = sent.at(-1).record;
      expect(
        batch.events.filter((e: any) => e.event_type === "message.created")
      ).toHaveLength(20);
      expect(
        batch.events.filter((e: any) => e.event_type === "source.gap")
      ).toEqual([
        expect.objectContaining({
          resource_type: "conversation",
          resource_ref: thread,
        }),
      ]);
      expect(batch.more).toBe(false);
      expect(batch.checkpoint.next.linkedin_inbox.after).toBeGreaterThan(
        checkpoint.linkedin_inbox.after
      );
      expect(JSON.stringify(batch)).not.toContain("Private message body");
      await api.listen({
        feed: "live_messages",
        bridge_id: "synthetic-bridge",
        token: "synthetic-token",
        checkpoint: batch.checkpoint.next,
      });
      expect(sent.at(-1).record.events).toEqual([]);
      expect(sent.some((m) => m.record.source_error)).toBe(false);
    } finally {
      api.detach();
      dom.window.close();
    }
  });

  test("message catch-up resumes in bounded passes through ordered, size-limited batches", async () => {
    const now = Date.now();
    const mailbox = "urn:li:fsd_profile:synthetic-self";
    const threadUrn = (n: number) =>
      `urn:li:msg_conversation:(${mailbox},synthetic-thread-${n})`;
    // Three conversation pages, every thread active and holding a full recent page.
    const pages: Record<string, { threads: number[]; next?: string }> = {
      first: { threads: Array.from({ length: 20 }, (_, i) => i), next: "c2" },
      c2: { threads: Array.from({ length: 20 }, (_, i) => 20 + i), next: "c3" },
      c3: { threads: [40] },
    };
    const calls: string[] = [];
    const { dom, api } = adapter(async (raw) => {
      const url = decodeURIComponent(raw);
      calls.push(url);
      if (url === "/voyager/api/me")
        return {
          ok: true,
          json: async () => ({
            miniProfile: {
              entityUrn: mailbox.replace("fsd_profile", "fs_miniProfile"),
            },
          }),
        };
      if (url.includes("messengerConversations.")) {
        const page = pages[/nextCursor:(\w+)/.exec(url)?.[1] ?? "first"];
        return {
          ok: true,
          json: async () => ({
            data: {
              messengerConversationsByCategoryQuery: {
                elements: page.threads.map((n) => ({
                  entityUrn: threadUrn(n),
                  lastActivityAt: now - 1000,
                })),
                metadata: page.next ? { nextCursor: page.next } : {},
              },
            },
          }),
        };
      }
      const thread = /synthetic-thread-(\d+)/.exec(url)![1];
      return {
        ok: true,
        json: async () => ({
          data: {
            messengerMessagesBySyncToken: {
              elements: Array.from({ length: 20 }, (_, i) => ({
                entityUrn: `urn:li:msg_message:(${mailbox},synthetic-thread-${thread}-message-${i})`,
                deliveredAt: now - 30000 + i,
                body: { text: "Private message body" },
              })),
              metadata: {},
            },
          },
        }),
      };
    });
    Object.defineProperty(dom.window, "crypto", { value: webcrypto });
    const timers: Array<() => Promise<void>> = [];
    dom.window.setTimeout = ((callback: () => Promise<void>) =>
      timers.push(callback)) as any;
    dom.window.clearTimeout = () => {
      /* The harness drains its own timer queue. */
    };
    const sent: any[] = [];
    dom.window.postMessage = (message: unknown) => {
      sent.push(message);
    };
    const reply = (message: any, ok: boolean) =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window,
          origin: "https://www.linkedin.com",
          data: {
            type: "lobu-feed-record:ack",
            token: "synthetic-token",
            sequence: message.sequence,
            ok,
          },
        })
      );
    const start = {
      linkedin_inbox: {
        feed: "live_messages",
        account: mailbox,
        started_at: now - 120000,
        after: now - 90000,
        seen: {},
      },
    };
    const bind = (checkpoint: unknown) =>
      api.listen({
        feed: "live_messages",
        bridge_id: "synthetic-bridge",
        token: "synthetic-token",
        checkpoint,
      });
    // Posts one batch at a time; each matching receipt releases the next.
    const drain = () => {
      const batches = [sent.at(-1).record];
      while (!batches.at(-1).checkpoint) {
        reply(sent.at(-1), true);
        batches.push(sent.at(-1).record);
      }
      return batches;
    };
    try {
      await bind(start);
      // One pass reads two conversation pages: 2 + 40 message pages, plus account checks.
      expect(
        calls.filter((url) => url.includes("messengerConversations."))
      ).toHaveLength(2);
      expect(
        calls.filter((url) => url.includes("messengerMessages."))
      ).toHaveLength(40);
      expect(sent).toHaveLength(1);
      // An unacknowledged batch is replayed unchanged.
      reply({ sequence: 0 }, true);
      await timers.shift()!();
      expect(sent[1].record).toEqual(sent[0].record);
      const first = drain();
      expect(first.length).toBeGreaterThan(2);
      for (const batch of first) {
        expect(batch.events.length).toBeLessThanOrEqual(500);
        expect(
          new TextEncoder().encode(JSON.stringify(batch)).length
        ).toBeLessThanOrEqual(128 * 1024);
        expect(JSON.stringify(batch)).not.toContain("Private message body");
      }
      expect(
        first
          .slice(0, -1)
          .every((batch) => !batch.checkpoint && batch.more === undefined)
      ).toBe(true);
      expect(new Set(first.map((batch) => batch.id)).size).toBe(first.length);
      const events = first.flatMap((batch) => batch.events);
      expect(
        events.filter((e: any) => e.event_type === "message.created")
      ).toHaveLength(800);
      expect(
        events.filter((e: any) => e.event_type === "source.gap")
      ).toHaveLength(40);
      const last = first.at(-1);
      expect(last.more).toBe(true);
      expect(last.checkpoint.previous).toEqual(start);
      const resumed = last.checkpoint.next.linkedin_inbox;
      expect(resumed.after).toBe(start.linkedin_inbox.after);
      expect(resumed.round.cursor).toBe("c3");
      expect(Object.keys(resumed.seen)).toHaveLength(256);

      // A rebind from the same server checkpoint replays the same references in order.
      sent.length = 0;
      await bind(start);
      expect(
        drain().flatMap((batch) => batch.events.map((e: any) => e.id))
      ).toEqual(events.map((e: any) => e.id));

      // The rebind requested by more:true resumes at the stored cursor and completes.
      sent.length = 0;
      calls.length = 0;
      await bind(last.checkpoint.next);
      expect(
        calls.filter((url) => url.includes("messengerConversations."))
      ).toEqual([expect.stringContaining("nextCursor:c3")]);
      const [done] = drain();
      // A resumed round is fixed, so its replay has the same batch identity.
      sent.length = 0;
      await bind(last.checkpoint.next);
      expect(sent.at(-1).record).toEqual(done);
      expect(done.more).toBe(false);
      expect(
        done.events.filter((e: any) => e.event_type === "message.created")
      ).toHaveLength(20);
      expect(done.checkpoint.next.linkedin_inbox.round).toBeUndefined();
      expect(done.checkpoint.next.linkedin_inbox.after).toBe(
        resumed.round.until
      );
      reply(sent.at(-1), true);

      // A rejected batch stops the listener with a source error instead of skipping it.
      sent.length = 0;
      timers.length = 0;
      await bind(start);
      reply(sent[0], false);
      expect(sent.at(-1).record.source_error).toContain("rejected");
      const posted = sent.length;
      await Promise.all(timers.splice(0).map((timer) => timer()));
      expect(sent).toHaveLength(posted);
    } finally {
      api.detach();
      dom.window.close();
    }
  });

  test("a thread that moved above the resume cursor is read again from the round floor", async () => {
    const now = Date.now();
    const mailbox = "urn:li:fsd_profile:synthetic-self";
    const thread = `urn:li:msg_conversation:(${mailbox},synthetic-moved)`;
    let top: any[] = [];
    const { dom, api } = adapter(async (raw) => {
      const url = decodeURIComponent(raw);
      const body =
        url === "/voyager/api/me"
          ? {
              miniProfile: {
                entityUrn: mailbox.replace("fsd_profile", "fs_miniProfile"),
              },
            }
          : url.includes("messengerConversations.")
            ? {
                data: {
                  messengerConversationsByCategoryQuery: {
                    elements: url.includes("nextCursor:") ? [] : top,
                    metadata: {},
                  },
                },
              }
            : {
                data: {
                  messengerMessagesBySyncToken: {
                    elements: [
                      {
                        entityUrn: "urn:li:msg_message:synthetic-before-move",
                        deliveredAt: now - 500000,
                        body: { text: "Private message body" },
                      },
                    ],
                    metadata: {},
                  },
                },
              };
      return { ok: true, json: async () => body };
    });
    Object.defineProperty(dom.window, "crypto", { value: webcrypto });
    const sent: any[] = [];
    dom.window.postMessage = (message: unknown) => {
      sent.push(message);
    };
    const bind = (checkpoint: unknown) =>
      api.listen({
        feed: "live_messages",
        bridge_id: "synthetic-bridge",
        token: "synthetic-token",
        checkpoint,
      });
    try {
      // The deep thread moved to the top while this round paged below it.
      await bind({
        linkedin_inbox: {
          feed: "live_messages",
          account: mailbox,
          started_at: now - 900000,
          after: now - 360000,
          floor: now - 600000,
          seen: {},
          round: {
            since: now - 300000,
            until: now - 200000,
            floor: now - 600000,
            cursor: "deep",
          },
        },
      });
      const finished = sent.at(-1).record;
      expect(finished.events).toEqual([]);
      expect(finished.checkpoint.next.linkedin_inbox).toMatchObject({
        after: now - 200000,
        floor: now - 600000,
      });
      top = [{ entityUrn: thread, lastActivityAt: now - 1000 }];
      await bind(finished.checkpoint.next);
      expect(sent.at(-1).record.events).toEqual([
        expect.objectContaining({
          event_type: "message.created",
          resource_ref: "urn:li:msg_message:synthetic-before-move",
        }),
      ]);
    } finally {
      api.detach();
      dom.window.close();
    }
  });

  test("notification catch-up beyond its page budget reports a gap and advances", async () => {
    const pagesRead: number[] = [];
    const page = (index: number) => {
      const request = JSON.stringify({
        $type: "proto.sdui.actions.requests.PaginationRequest",
        pagerId: "com.linkedin.sdui.pagers.notificationsList",
        requestedArguments: {
          payload: {
            startIndex: index + 1,
            filterPillType: "All",
            trackingIdsToDrop: [],
          },
        },
      });
      pagesRead.push(index);
      return `${flight(`Synthetic notification ${index}`).replace("activity:1000,", `activity:${2000 + index},`)}4:T${new TextEncoder().encode(request).length.toString(16)},${request}`;
    };
    const { dom, api } = adapter(async (url, init) =>
      url === "/voyager/api/me"
        ? {
            ok: true,
            json: async () => ({
              miniProfile: {
                entityUrn: "urn:li:fs_miniProfile:synthetic-self",
              },
            }),
          }
        : init?.body
          ? {
              ok: true,
              text: async () =>
                page(
                  JSON.parse(init.body).paginationRequest.requestedArguments
                    .payload.startIndex
                ),
            }
          : {
              ok: true,
              text: async () =>
                `<script>window.__como_rehydration__ = ${JSON.stringify([page(0)])};</script>`,
            }
    );
    Object.defineProperty(dom.window, "crypto", { value: webcrypto });
    const sent: any[] = [];
    dom.window.postMessage = (message: unknown) => {
      sent.push(message);
    };
    const checkpoint = {
      linkedin_inbox: {
        feed: "notifications",
        account: "urn:li:fsd_profile:synthetic-self",
        // Resume checkpoints persisted before notification timestamps were removed.
        started_at: Date.now() - 120000,
        after: Date.now() - 60000,
        seen: {},
      },
    };
    try {
      await api.listen({
        feed: "notifications",
        bridge_id: "synthetic-bridge",
        token: "synthetic-token",
        checkpoint,
      });
      expect(pagesRead).toHaveLength(10);
      const batch = sent.at(-1).record;
      expect(
        batch.events.filter((e: any) => e.event_type === "notification.changed")
      ).toHaveLength(10);
      expect(
        batch.events.filter((e: any) => e.event_type === "source.gap")
      ).toEqual([expect.objectContaining({ resource_type: "notification" })]);
      expect(batch.more).toBe(false);
      expect(
        Object.keys(batch.checkpoint.next.linkedin_inbox.seen)
      ).toHaveLength(10);
    } finally {
      api.detach();
      dom.window.close();
    }
  });

  test("a changed program replaces the warm tab program without a manual version bump", () => {
    const { dom, api } = adapter(async () => {
      throw new Error("unexpected fetch");
    });
    try {
      const program = linkedInInboxProgram.toString();
      dom.window.eval(`(${program})()`);
      expect((dom.window as any).__lobuLinkedInInboxV1).toBe(api);
      dom.window.eval(
        `(${program.replace("Source request failed", "Source request unavailable")})()`
      );
      expect((dom.window as any).__lobuLinkedInInboxV1).not.toBe(api);
    } finally {
      dom.window.close();
    }
  });

  test("a replaced program asks every warm listener to reattach from its durable checkpoint", async () => {
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
        : url.includes("messengerConversations.")
          ? {
              ok: true,
              json: async () => ({
                data: {
                  messengerConversationsByCategoryQuery: {
                    elements: [],
                    metadata: {},
                  },
                },
              }),
            }
          : {
              ok: true,
              text: async () =>
                `<script>window.__como_rehydration__ = ${JSON.stringify([flight()])};</script>`,
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
    const ack = (message: any) =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window,
          origin: "https://www.linkedin.com",
          data: {
            type: "lobu-feed-record:ack",
            token: message.token,
            sequence: message.sequence,
            ok: true,
          },
        })
      );
    const replaced = linkedInInboxProgram
      .toString()
      .replace("Source request failed", "Source request unavailable");
    let next: any;
    try {
      for (const feed of ["notifications", "live_messages"]) {
        await api.listen({
          feed,
          bridge_id: `synthetic-${feed}`,
          token: `token-${feed}`,
        });
      }
      const [notifications, messages] = sent.splice(0);
      // Only the messages batch is acknowledged; the notifications checkpoint
      // was never persisted when the program changes.
      ack(messages);
      dom.window.eval(`(${replaced})()`);
      next = (dom.window as any).__lobuLinkedInInboxV1;
      expect(next).not.toBe(api);
      expect(sent.map((m) => [m.token, typeof m.record.source_error])).toEqual([
        ["token-notifications", "string"],
        ["token-live_messages", "string"],
      ]);
      // The retired listeners neither poll nor accept late receipts.
      sent.length = 0;
      ack(notifications);
      await Promise.all(timers.splice(0).map((timer) => timer()));
      expect(sent).toEqual([]);
      // Reattachment starts from the server's durable checkpoint only.
      await next.listen({
        feed: "notifications",
        bridge_id: "synthetic-notifications",
        token: "token-rebound",
      });
      expect(sent[0].record.checkpoint.previous).toBeNull();
      await next.listen({
        feed: "live_messages",
        bridge_id: "synthetic-live_messages",
        token: "token-rebound-messages",
        checkpoint: messages.record.checkpoint.next,
      });
      expect(sent[1].record.checkpoint.previous).toEqual(
        messages.record.checkpoint.next
      );
      expect(sent.some((m) => m.record.source_error)).toBe(false);
    } finally {
      next?.detach();
      dom.window.close();
    }
  });

  test("an empty inbox still checks that the signed-in account did not change", async () => {
    let accountReads = 0;
    const { dom, api } = adapter(async (url) => ({
      ok: true,
      json: async () =>
        url === "/voyager/api/me"
          ? {
              miniProfile: {
                entityUrn: `urn:li:fs_miniProfile:synthetic-${++accountReads}`,
              },
            }
          : {
              data: {
                messengerConversationsByCategoryQuery: {
                  elements: [],
                  metadata: {},
                },
              },
            },
    }));
    try {
      await expect(
        api.read({ feed: "live_messages", limit: 20 })
      ).rejects.toThrow("account changed");
    } finally {
      dom.window.close();
    }
  });

  test.each([
    "</script >",
    "</script\n>",
    "</script data-ignored>",
  ])("reads inert notification data with a valid HTML closing tag %s", async (closingTag) => {
    const { dom, api } = adapter(async () => ({
      ok: true,
      json: async () => ({
        miniProfile: { entityUrn: "urn:li:fs_miniProfile:synthetic-self" },
      }),
      text: async () =>
        `<script>globalThis.unexpectedExecution = true;</script><script data-note="a>b">\n window.__como_rehydration__ = ${JSON.stringify([flight()])};${closingTag}`,
    }));
    try {
      const result = await api.read({ feed: "notifications", limit: 10 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].text).toBe("Alex reacted to your post");
      expect((dom.window as any).unexpectedExecution).toBeUndefined();
    } finally {
      dom.window.close();
    }
  });

  test("decodes Flight byte-length text and stable notification identities, without executing HTML", async () => {
    let stream = flight("Alex 👋\nreacted to your post");
    const { dom, api } = adapter(async () => ({
      ok: true,
      json: async () => ({
        miniProfile: { entityUrn: "urn:li:fs_miniProfile:synthetic-self" },
      }),
      text: async () =>
        `<script>window.__como_rehydration__ = ${JSON.stringify([stream])};</script>`,
    }));
    try {
      const rows = await api.read({ feed: "notifications" });
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].text).toBe("Alex 👋 reacted to your post");
      expect(rows.rows[0].id).toContain("groupBy=urn:li:activity:1000");
      expect(rows.rows[0].occurred_at).toBeNull();
      stream = flight();
      const initial = await api.read({ feed: "notifications" });
      stream = flight("Alex reacted to your post", "13h");
      const aged = await api.read({ feed: "notifications" });
      expect(aged.rows[0].revision).toEqual(initial.rows[0].revision);
      expect(aged.rows[0].source_revision).toEqual(
        initial.rows[0].source_revision
      );
      stream = flight("Alex and Sam reacted to your post");
      const changed = await api.read({ feed: "notifications" });
      expect(changed.rows[0].revision).not.toEqual(initial.rows[0].revision);
      expect(changed.rows[0].source_revision).not.toEqual(
        initial.rows[0].source_revision
      );
    } finally {
      dom.window.close();
    }
  });

  test("fails closed on changed notification markup and untrusted paging actions", async () => {
    const calls: string[] = [];
    const { dom, api } = adapter(async (url) => {
      calls.push(url);
      return {
        ok: true,
        json: async () => ({
          miniProfile: { entityUrn: "urn:li:fs_miniProfile:synthetic-self" },
        }),
        text: async () =>
          `<script>window.__como_rehydration__ = ${JSON.stringify(['0:{"unknown":"shape"}\n'])};</script>`,
      };
    });
    try {
      await expect(api.read({ feed: "notifications" })).rejects.toThrow();
      calls.length = 0;
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
      Object.assign(message, { messageBodyRenderFormat: "RECALLED" });
      const recalled = await api.read({ feed: "live_messages", limit: 20 });
      expect(recalled.rows[0]).toMatchObject({ recalled: true, text: "" });
      Object.assign(message, { messageBodyRenderFormat: "TEXT" });
      expect(result.rows[0].source_revision).toMatch(/^[a-f0-9]{64}$/);
      const originalRevision = result.rows[0].source_revision;
      message.body.text = "Hello. Actually, wait until Friday.";
      const edited = await api.read({ feed: "live_messages", limit: 20 });
      expect(edited.rows[0].source_revision).not.toBe(originalRevision);
      expect(calls.some((url) => url.includes("%28"))).toBe(true);
      expect(calls.every((url) => !/mark|Seen|Read/.test(url))).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  test("observes references only, advances after matching receipt, and retries an unaccepted batch", async () => {
    let headline = "Alex reacted to your post";
    let age = "12h";
    let now = 1700000000000;
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
              `<script>window.__como_rehydration__ = ${JSON.stringify([flight(headline, age)])};</script>`,
          }
    );
    Object.defineProperty(dom.window, "crypto", { value: webcrypto });
    dom.window.Date.now = () => now;
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
      age = "13h";
      now += 3600000;
      await timers.shift()!();
      expect(sent[3].record.events).toEqual([]);
      expect(sent[3].record.checkpoint.next).toEqual(
        sent[2].record.checkpoint.next
      );
      ack(sent[3]);
      await timers.shift()!();
      expect(sent[4].record).toEqual(sent[3].record);
      expect(sent[4].sequence).toBeGreaterThan(sent[3].sequence);
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window,
          origin: "https://www.linkedin.com",
          data: { type: "lobu-feed-record:stop", token: "synthetic-token" },
        })
      );
      await timers.shift()!();
      expect(sent).toHaveLength(5);
    } finally {
      api.detach();
      dom.window.close();
    }
  });

  test("recognizes the continuation encoded as a Flight text record", async () => {
    let stream: string;
    const { dom, api } = adapter(async () => ({
      ok: true,
      json: async () => ({
        miniProfile: { entityUrn: "urn:li:fs_miniProfile:synthetic-self" },
      }),
      text: async () =>
        `<script>window.__como_rehydration__ = ${JSON.stringify([stream])};</script>`,
    }));
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
      stream = `${flight()}4:T${new TextEncoder().encode(request).length.toString(16)},${request}`;
      const result = await api.read({ feed: "notifications" });
      expect(JSON.parse(result.nextCursor).page).toEqual(payload);
    } finally {
      dom.window.close();
    }
  });
});
