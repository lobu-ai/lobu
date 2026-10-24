import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { webcrypto } from "node:crypto";
import { linkedInInboxProgram } from "../linkedin-inbox-adapter.js";
import { observeLinkedInInbox, readLinkedInInbox, sendLinkedInMessage } from "../linkedin-inbox";
import LinkedInConnector from "../linkedin";

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
  test.each(["notifications", "live_messages"])("first %s subscription rejects a browser account different from the saved profile", async (feedKey) => {
    let sourceReads = 0;
    const { dom, api } = adapter(async (url) => {
      if (url !== "/voyager/api/me") sourceReads++;
      return { ok: true, json: async () => ({ miniProfile: { entityUrn: "urn:li:fs_miniProfile:synthetic-other" } }), text: async () => `<script>window.__como_rehydration__ = ${JSON.stringify([flight()])};</script>` };
    });
    const browser = {
      dispatch: async (op: string, input: any) => {
        if (op === "navigate") return { tab_id: 42 };
        if (op === "feed_listen") return { bridge_id: "synthetic-bridge", token: "synthetic-token", subscription: { scope_key: "synthetic-scope" } };
        return { value: await dom.window.eval(input.expression) };
      },
    };
    const sent: any[] = [];
    dom.window.postMessage = (message: unknown) => { sent.push(message); };
    try {
      await expect(observeLinkedInInbox({ browser, feedKey, sessionState: { account_id: "urn:li:fs_miniProfile:synthetic-self" } } as any)).rejects.toThrow("saved account");
      expect(sourceReads).toBe(0);
      expect(sent).toEqual([]);
    } finally { api.detach(); dom.window.close(); }
  });

  test("source reads and sends reject the wrong saved account before source access", async () => {
    let sourceReads = 0;
    const { dom } = adapter(async (url) => {
      if (url !== "/voyager/api/me") sourceReads++;
      return { ok: true, json: async () => ({ miniProfile: { entityUrn: "urn:li:fs_miniProfile:synthetic-other" } }) };
    });
    const browser = { dispatch: async (op: string, input: any) => op === "navigate" ? { tab_id: 42 } : { value: await dom.window.eval(input.expression) } };
    const context = { browser, sessionState: { account_id: "urn:li:fs_miniProfile:synthetic-self" } };
    try {
      for (const feedKey of ["notifications", "live_messages"])
        await expect(readLinkedInInbox({ ...context, feedKey } as any)).rejects.toThrow("saved account");
      expect(await sendLinkedInMessage({ ...context, input: { conversation_id: "synthetic-thread", text: "Synthetic reply", idempotency_key: "synthetic-key" } } as any)).toMatchObject({ success: false, error: expect.stringContaining("saved account") });
      expect(sourceReads).toBe(0);
    } finally { dom.window.close(); }
  });

  test("observation without a saved account fails before browser dispatch", async () => {
    let calls = 0;
    await expect(observeLinkedInInbox({ feedKey: "notifications", browser: { dispatch: async () => { calls++; throw new Error("unexpected browser dispatch"); } } } as any)).rejects.toThrow("saved account");
    expect(calls).toBe(0);
  });

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
      api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
        feed: "notifications",
        cursor,
      });
    const sent: any[] = [];
    dom.window.postMessage = (message: unknown) => {
      sent.push(message);
    };
    try {
      const first = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "notifications" });
      expect(first.hasMore).toBe(true);
      expect(first.rows).toHaveLength(1);
      cursor = first.nextCursor;
      expect(JSON.parse(cursor).page).toEqual(payload);
      await expect(readNext()).resolves.toEqual({ rows: [], hasMore: false });
      await api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
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
      await api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
        feed: "notifications",
        bridge_id: "synthetic-bridge",
        token: "synthetic-token",
        checkpoint,
      });
      expect(sent[0].record.events).toEqual([]);
      initialStream = empty;
      await expect(api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "notifications" })).rejects.toThrow(
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
    await observeLinkedInInbox({ browser, feedKey: "notifications", sessionState: { account_id: "urn:li:fs_miniProfile:synthetic-self" } } as any);
    await observeLinkedInInbox({ browser, feedKey: "live_messages", sessionState: { account_id: "urn:li:fs_miniProfile:synthetic-self" } } as any);
    await readLinkedInInbox({ browser, feedKey: "notifications", sessionState: { account_id: "urn:li:fs_miniProfile:synthetic-self" } } as any);
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
      await api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
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
      await api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
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

  test.each(["empty", "scalar", "tuple"])("message catch-up resumes in bounded batches with %s history anchors", async (anchorKind) => {
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
    const anchor = Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(
      `urn:li:msg_message:(${mailbox},synthetic-thread-0-message-0)`
    ))).toString("base64url");
    const start = {
      linkedin_inbox: {
        feed: "live_messages",
        account: mailbox,
        started_at: now - 120000,
        after: now - 90000,
        seen: anchorKind === "empty" ? {} : { [anchor]: anchorKind === "tuple" ? ["1", true] : "1" },
      },
    };
    const bind = (checkpoint: unknown) =>
      api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
        feed: "live_messages",
        bridge_id: "synthetic-bridge",
        token: "synthetic-token",
        checkpoint,
      });
    // Posts one batch at a time; each matching receipt releases the next.
    const drain = () => {
      const batches = [sent.at(-1).record];
      while (batches.at(-1).more === undefined) {
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
        expect(Object.keys(batch.checkpoint.next.linkedin_inbox.seen).length).toBeLessThanOrEqual(512);
        if (anchorKind !== "empty" && batch.more === undefined)
          expect(batch.checkpoint.next.linkedin_inbox.seen[anchor]).toBeDefined();
        expect(
          new TextEncoder().encode(JSON.stringify(batch)).length
        ).toBeLessThanOrEqual(128 * 1024);
        expect(JSON.stringify(batch)).not.toContain("Private message body");
      }
      expect(
        first
          .slice(0, -1)
          .every((batch) => batch.checkpoint && batch.more === undefined)
      ).toBe(true);
      expect(new Set(first.map((batch) => batch.id)).size).toBe(first.length);
      const events = first.flatMap((batch) => batch.events);
      expect(
        events.filter((e: any) => e.event_type === "message.created")
      ).toHaveLength(anchorKind === "empty" ? 800 : 799);
      expect(
        events.filter((e: any) => e.event_type === "source.gap")
      ).toHaveLength(anchorKind === "empty" ? 40 : 39);
      const last = first.at(-1);
      expect(last.more).toBe(true);
      expect(first[0].checkpoint.previous).toEqual(start);
      for (let index = 1; index < first.length; index++)
        expect(first[index].checkpoint.previous).toEqual(first[index - 1].checkpoint.next);
      const resumed = last.checkpoint.next.linkedin_inbox;
      expect(resumed.after).toBe(start.linkedin_inbox.after);
      expect(resumed.round.cursor).toBe("c3");
      expect(Object.keys(resumed.seen)).toHaveLength(256);

      // Accepted references from an unfinished pass are not its original
      // catch-up boundary. Reconnect at each chunk boundary, including one
      // between a conversation's messages and its unaccepted gap warning.
      const gapIds = (rows: any[]) => [...new Set(rows.filter((event) =>
        event.event_type === "source.gap").map((event) => event.id))].sort();
      const eventIds = (rows: any[]) => [...new Set(rows.map((event) => event.id))].sort();
      for (let accepted = 1; accepted < first.length; accepted++) {
        sent.length = 0;
        await bind(first[accepted - 1].checkpoint.next);
        const recovered = [
          ...first.slice(0, accepted).flatMap((batch) => batch.events),
          ...drain().flatMap((batch) => batch.events),
        ];
        expect(gapIds(recovered)).toEqual(gapIds(events));
        expect(eventIds(recovered)).toEqual(eventIds(events));
      }

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
      api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
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
      await api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
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
        await api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
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
      await next.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
        feed: "notifications",
        bridge_id: "synthetic-notifications",
        token: "token-rebound",
      });
      expect(sent[0].record.checkpoint.previous).toBeNull();
      await next.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
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
        api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-1", feed: "live_messages", limit: 20 })
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
      const result = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "notifications", limit: 10 });
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
      const rows = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "notifications" });
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].text).toBe("Alex 👋 reacted to your post");
      expect(rows.rows[0].id).toContain("groupBy=urn:li:activity:1000");
      expect(rows.rows[0].occurred_at).toBeNull();
      stream = flight();
      const initial = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "notifications" });
      stream = flight("Alex reacted to your post", "13h");
      const aged = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "notifications" });
      expect(aged.rows[0].revision).toEqual(initial.rows[0].revision);
      expect(aged.rows[0].source_revision).toEqual(
        initial.rows[0].source_revision
      );
      stream = flight("Alex and Sam reacted to your post");
      const changed = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "notifications" });
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
      await expect(api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "notifications" })).rejects.toThrow();
      calls.length = 0;
      await expect(
        api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
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
      const result = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", limit: 20 });
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
      const recalled = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", limit: 20 });
      expect(recalled.rows[0]).toMatchObject({ recalled: true, text: "" });
      Object.assign(message, { messageBodyRenderFormat: "TEXT" });
      expect(result.rows[0].source_revision).toMatch(/^[a-f0-9]{64}$/);
      const originalRevision = result.rows[0].source_revision;
      message.body.text = "Hello. Actually, wait until Friday.";
      const edited = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", limit: 20 });
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
      await api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
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

  test("notification generations preserve A to B to A to B and replay a checkpoint deterministically", async () => {
    let headline = 'state-A';
    const { dom, api } = adapter(async url => url === '/voyager/api/me'
      ? { ok: true, json: async () => ({ miniProfile: { entityUrn: 'urn:li:fs_miniProfile:synthetic-self' } }) }
      : { ok: true, text: async () => `<script>window.__como_rehydration__ = ${JSON.stringify([flight(headline)])};</script>` });
    dom.window.setTimeout = (() => 1) as any;
    const sent: any[] = [];
    dom.window.postMessage = message => { sent.push(message); };
    const bind = (checkpoint?: unknown) => api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: 'notifications', bridge_id: 'synthetic-bridge',
      token: 'synthetic-token', checkpoint });
    try {
      await bind();
      let checkpoint = sent.at(-1).record.checkpoint.next;
      const ids: string[] = [];
      for (headline of ['state-B', 'state-A', 'state-B']) {
        await bind(checkpoint);
        const batch = sent.at(-1).record;
        expect(batch.events).toHaveLength(1);
        ids.push(batch.events[0].id);
        // A lost receipt / restart from exactly the same durable position.
        await bind(checkpoint);
        expect(sent.at(-1).record.events[0].id).toBe(ids.at(-1));
        checkpoint = batch.checkpoint.next;
      }
      expect(new Set(ids).size).toBe(3);
      expect(JSON.stringify(sent)).not.toContain('state-');
    } finally { api.detach(); dom.window.close(); }
  });

  test("notification recovery retains accepted fingerprints beyond the final seen limit", async () => {
    let headline = 'before';
    const cards = JSON.parse(flight().slice(2, flight().indexOf('\n')))[0][1];
    const { dom, api } = adapter(async url => url === '/voyager/api/me'
      ? { ok: true, json: async () => ({ miniProfile: { entityUrn: 'urn:li:fs_miniProfile:synthetic-self' } }) }
      : { ok: true, text: async () => {
        const frames = Array.from({ length: 650 }, (_, i) => `${(i + 1).toString(16)}:${JSON.stringify([
          ['Original', JSON.parse(JSON.stringify(cards).replaceAll('1000', String(1000 + i)).replaceAll('$2', '$fff'))],
        ])}\n`).join('');
        const stream = `${frames}fff:T${new TextEncoder().encode(headline).length.toString(16)},${headline}`;
        return `<script>window.__como_rehydration__ = ${JSON.stringify([stream])};</script>`;
      } });
    dom.window.setTimeout = (() => 1) as any;
    const sent: any[] = [];
    dom.window.postMessage = message => { sent.push(message); };
    const bind = (checkpoint?: unknown) => api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: 'notifications', bridge_id: 'synthetic-bridge',
      token: 'synthetic-token', checkpoint });
    const ack = () => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window,
      origin: 'https://www.linkedin.com', data: { type: 'lobu-feed-record:ack', token: 'synthetic-token', sequence: sent.at(-1).sequence, ok: true } }));
    try {
      await bind();
      const baseline = sent.at(-1).record.checkpoint.next;
      headline = 'after';
      await bind(baseline);
      const accepted = new Set<string>();
      let checkpoint: any;
      while (accepted.size <= 256) {
        const batch = sent.at(-1).record;
        expect(batch.more).toBeUndefined();
        batch.events.forEach((event: any) => accepted.add(event.resource_ref));
        checkpoint = batch.checkpoint.next;
        ack();
      }
      expect(Object.keys(checkpoint.linkedin_inbox.seen).length).toBeGreaterThan(256);
      await bind(checkpoint);
      const remaining: any[] = [];
      for (;;) {
        const batch = sent.at(-1).record;
        remaining.push(...batch.events);
        if (batch.more !== undefined) break;
        ack();
      }
      expect(remaining.some(event => accepted.has(event.resource_ref))).toBe(false);
      expect(remaining.length + accepted.size).toBe(650);
      // The complete stopping page must remain remembered on idle polls.
      await bind(sent.at(-1).record.checkpoint.next);
      expect(sent.at(-1).record.events).toEqual([]);
    } finally { api.detach(); dom.window.close(); }
  });

  test("overlapping notification pages checkpoint the revision that was emitted", async () => {
    let expanded = false;
    const request = JSON.stringify({ $type: 'proto.sdui.actions.requests.PaginationRequest',
      pagerId: 'com.linkedin.sdui.pagers.notificationsList', requestedArguments: { payload: {
        startIndex: 1, filterPillType: 'All', trackingIdsToDrop: [],
      } } });
    const { dom, api } = adapter(async (url, init) => url === '/voyager/api/me'
      ? { ok: true, json: async () => ({ miniProfile: { entityUrn: 'urn:li:fs_miniProfile:synthetic-self' } }) }
      : { ok: true, text: async () => {
        if (init?.body) return flight('older revision');
        const stream = expanded
          ? `${flight('current revision')}4:T${new TextEncoder().encode(request).length.toString(16)},${request}`
          : flight('baseline').replaceAll('1000', '9000');
        return `<script>window.__como_rehydration__ = ${JSON.stringify([stream])};</script>`;
      } });
    dom.window.setTimeout = (() => 1) as any;
    const sent: any[] = [];
    dom.window.postMessage = message => { sent.push(message); };
    const bind = (checkpoint?: unknown) => api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: 'notifications', bridge_id: 'synthetic-bridge',
      token: 'synthetic-token', checkpoint });
    try {
      await bind();
      expanded = true;
      await bind(sent.at(-1).record.checkpoint.next);
      expect(sent.at(-1).record.events).toHaveLength(1);
      await bind(sent.at(-1).record.checkpoint.next);
      expect(sent.at(-1).record.events).toEqual([]);
    } finally { api.detach(); dom.window.close(); }
  });

  test("notification recovery crosses provider pages until the original anchor after an accepted chunk", async () => {
    let expanded = false;
    const pagesRead: number[] = [];
    const card = JSON.parse(flight().slice(2, flight().indexOf('\n')))[0][1];
    const page = (index: number) => {
      pagesRead.push(index);
      const ids = expanded ? Array.from({ length: index === 2 ? 100 : 200 }, (_, i) => 1000 + index * 200 + i) : [];
      if (!expanded || index === 2) ids.push(9000);
      const frames = ids.map((id, i) => `${(i + 1).toString(16)}:${JSON.stringify([
        ['Original', JSON.parse(JSON.stringify(card).replaceAll('1000', String(id)).replaceAll('$2', '$fff'))],
      ])}\n`).join('');
      const request = JSON.stringify({ $type: 'proto.sdui.actions.requests.PaginationRequest',
        pagerId: 'com.linkedin.sdui.pagers.notificationsList', requestedArguments: { payload: {
          startIndex: index + 1, filterPillType: 'All', trackingIdsToDrop: [],
        } } });
      return `${frames}fff:T5,hello${expanded && index < 2 ? `ffe:T${new TextEncoder().encode(request).length.toString(16)},${request}` : ''}`;
    };
    const { dom, api } = adapter(async (url, init) => url === '/voyager/api/me'
      ? { ok: true, json: async () => ({ miniProfile: { entityUrn: 'urn:li:fs_miniProfile:synthetic-self' } }) }
      : init?.body ? { ok: true, text: async () => page(JSON.parse(init.body).paginationRequest.requestedArguments.payload.startIndex) }
      : { ok: true, text: async () => `<script>window.__como_rehydration__ = ${JSON.stringify([page(0)])};</script>` });
    dom.window.setTimeout = (() => 1) as any;
    const sent: any[] = [];
    dom.window.postMessage = message => { sent.push(message); };
    const bind = (checkpoint?: unknown) => api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: 'notifications', bridge_id: 'synthetic-bridge',
      token: 'synthetic-token', checkpoint });
    const ack = () => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window,
      origin: 'https://www.linkedin.com', data: { type: 'lobu-feed-record:ack', token: 'synthetic-token', sequence: sent.at(-1).sequence, ok: true } }));
    try {
      await bind();
      expanded = true;
      await bind(sent.at(-1).record.checkpoint.next);
      const first = sent.at(-1).record;
      expect(first.more).toBeUndefined();
      expect(first.events.length).toBeGreaterThan(0);
      const accepted = new Set(first.events.map((event: any) => event.resource_ref));
      pagesRead.length = 0;
      await bind(first.checkpoint.next);
      expect(pagesRead).toEqual([0, 1, 2]);
      const remaining: any[] = [];
      for (;;) {
        const batch = sent.at(-1).record;
        remaining.push(...batch.events);
        if (batch.more !== undefined) break;
        ack();
      }
      expect(remaining.some(event => accepted.has(event.resource_ref))).toBe(false);
      expect(remaining.length + accepted.size).toBe(500);
    } finally { api.detach(); dom.window.close(); }
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
      const result = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "notifications" });
      expect(JSON.parse(result.nextCursor).page).toEqual(payload);
    } finally {
      dom.window.close();
    }
  });
});

/**
 * A synthetic LinkedIn messenger: conversations with their messages, and the
 * createMessage endpoint that appends the bot's own message.
 */
function messenger(options: {
  conversations: Array<Record<string, unknown>>;
  messages: Record<string, any[]>;
  echoOriginToken?: boolean;
  showSent?: boolean;
  /** Page mailboxes the signed-in member administers. */
  administers?: string[];
  member?: string;
  mailboxCountsResponse?: unknown;
}) {
  const profile = "urn:li:fsd_profile:synthetic-self";
  const posts: any[] = [];
  const calls: string[] = [];
  const accepted = new Map<string, any>();
  const fetcher = async (url: string, init?: any) => {
    calls.push(url);
    let data: unknown;
    if (url.includes("messengerMailboxCounts.")) {
      const mailbox = decodeURIComponent(
        url.slice(url.indexOf("mailboxUrn:") + "mailboxUrn:".length, -1)
      );
      if (!(options.administers ?? []).includes(mailbox)) {
        return { ok: false, status: 403, json: async () => ({}) };
      }
      data = options.mailboxCountsResponse ?? { data: { messengerMailboxCountsByMailbox: { elements: [] } } };
    } else if (url === "/voyager/api/me") {
      data = {
        miniProfile: {
          entityUrn: (options.member ?? profile).replace("fsd_profile", "fs_miniProfile"),
        },
      };
    } else if (url.includes("messengerConversations.")) {
      // Twenty per page, like LinkedIn, with an opaque `page-<n>` cursor.
      const cursor = url.match(/nextCursor:([^,)]+)/)?.[1];
      const page = cursor ? Number(decodeURIComponent(cursor).slice(5)) : 0;
      const elements = options.conversations.slice(page * 20, page * 20 + 20);
      const more = options.conversations.length > page * 20 + 20;
      data = {
        data: {
          messengerConversationsByCategoryQuery: {
            elements,
            metadata: more ? { nextCursor: `page-${page + 1}` } : {},
          },
        },
      };
    } else if (url.includes("messengerMessages.")) {
      const conversation = decodeURIComponent(
        url.slice(url.indexOf("conversationUrn:") + "conversationUrn:".length, -1)
      );
      data = {
        data: {
          messengerMessagesBySyncToken: {
            elements: options.messages[conversation] ?? [],
            metadata: {},
          },
        },
      };
    } else if (url.includes("action=createMessage")) {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init.body);
      posts.push(body);
      const created = (body.dedupeByClientGeneratedToken &&
        accepted.get(body.message.originToken)) || {
        entityUrn: `urn:li:msg_message:(${body.mailboxUrn},sent-${posts.length})`,
        deliveredAt: Date.now(),
        body: { text: body.message.body.text },
        sender: { hostIdentityUrn: body.mailboxUrn },
        ...(options.echoOriginToken === false
          ? {}
          : { originToken: body.message.originToken }),
      };
      accepted.set(body.message.originToken, created);
      if (options.showSent !== false) {
        const visible = (options.messages[body.message.conversationUrn] ??= []);
        if (!visible.some((message) => message.entityUrn === created.entityUrn)) {
          visible.unshift(created);
        }
      }
      data = { value: { entityUrn: created.entityUrn } };
    } else {
      throw new Error(`unexpected request ${url}`);
    }
    return { ok: true, status: 200, json: async () => data };
  };
  return { profile, posts, calls, ...adapter(fetcher) };
}

const SELF = "urn:li:fsd_profile:synthetic-self";
const DM = `urn:li:msg_conversation:(${SELF},2-synthetic-dm==)`;
const GROUP = `urn:li:msg_conversation:(${SELF},2-synthetic-group==)`;
const INBOUND = {
  entityUrn: `urn:li:msg_message:(${SELF},2-synthetic-inbound)`,
  deliveredAt: 1700000000000,
  body: { text: "Are you around?" },
  sender: {
    hostIdentityUrn: "urn:li:fsd_profile:ACoAASyntheticPeer",
    participantType: {
      member: {
        firstName: { text: "Alex" },
        lastName: { text: "Example" },
        profileUrl: "https://www.linkedin.com/in/alex-example-synthetic",
      },
    },
  },
};

describe("LinkedIn direct messages", () => {
  test("message rows carry the thread, group-ness, sender identity and content kind", async () => {
    const { api, dom } = messenger({
      conversations: [
        { entityUrn: DM, groupChat: false, lastActivityAt: 1700000000000 },
        {
          entityUrn: GROUP,
          conversationParticipants: [{}, {}, {}],
          lastActivityAt: 1690000000000,
        },
      ],
      messages: {
        [DM]: [INBOUND],
        [GROUP]: [
          {
            ...INBOUND,
            entityUrn: `urn:li:msg_message:(${SELF},2-synthetic-group-msg)`,
            renderContent: [{ file: {} }],
          },
        ],
      },
    });
    try {
      const first = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", limit: 20 });
      expect(first.rows[0]).toMatchObject({
        thread_id: "2-synthetic-dm==",
        is_group: false,
        sender_member_id: "ACoAASyntheticPeer",
        sender_slug: "alex-example-synthetic",
        sender_name: "Alex Example",
        from_me: false,
        content_kind: "text",
      });
      const second = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
        feed: "live_messages",
        limit: 20,
        cursor: first.nextCursor,
      });
      expect(second.rows[0]).toMatchObject({
        thread_id: "2-synthetic-group==",
        is_group: true,
        content_kind: "media",
      });
    } finally {
      dom.window.close();
    }
  });

  test("an id: lookup reads one recent message back by its URN", async () => {
    const { api, dom } = messenger({
      conversations: [
        { entityUrn: GROUP, groupChat: true, lastActivityAt: 1700000000001 },
        { entityUrn: DM, lastActivityAt: 1700000000000 },
      ],
      messages: { [DM]: [INBOUND], [GROUP]: [] },
    });
    try {
      const found = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
        feed: "live_messages",
        query: `id:${INBOUND.entityUrn}`,
      });
      expect(found.rows).toHaveLength(1);
      // No group flag and no participants: unknown, never assumed a DM.
      expect(found.rows[0]).toMatchObject({ id: INBOUND.entityUrn, is_group: null });
      expect(found.hasMore).toBe(false);
      const missing = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
        feed: "live_messages",
        query: `id:urn:li:msg_message:(${SELF},absent)`,
      });
      expect(missing.rows).toEqual([]);
      await expect(
        api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", query: "id:not-a-message" })
      ).rejects.toThrow("Message lookup");
    } finally {
      dom.window.close();
    }
  });

  test("a message and its conversation deep in the inbox are still found and answered", async () => {
    // 101 busier conversations put the target on LinkedIn's sixth page.
    const busier = Array.from({ length: 101 }, (_, index) => ({
      entityUrn: `urn:li:msg_conversation:(${SELF},2-synthetic-busy-${index}==)`,
      groupChat: false,
      lastActivityAt: 1700000000100 - index,
    }));
    const { api, dom, posts } = messenger({
      conversations: [...busier, { entityUrn: DM, groupChat: false, lastActivityAt: 1700000000000 }],
      messages: { [DM]: [INBOUND] },
    });
    try {
      const found = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
        feed: "live_messages",
        query: `id:${INBOUND.entityUrn}`,
      });
      expect(found.rows).toMatchObject([{ id: INBOUND.entityUrn, thread_id: "2-synthetic-dm==" }]);
      const sent = await api.send({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
        conversation_id: "2-synthetic-dm==",
        text: "Yes, here.",
        idempotency_key: "page-six",
      });
      expect(sent).toMatchObject({ sent: true, conversation_id: "2-synthetic-dm==" });
      expect(posts).toHaveLength(1);
    } finally {
      dom.window.close();
    }
  });

  test("send_message sends once per idempotency key and confirms the message appears", async () => {
    const messages: Record<string, any[]> = { [DM]: [INBOUND] };
    const { api, dom, posts } = messenger({
      conversations: [{ entityUrn: DM, groupChat: false }],
      messages,
    });
    try {
      const input = { expected_account: "urn:li:fs_miniProfile:synthetic-self",
        conversation_id: "2-synthetic-dm==",
        text: "Yes, around all afternoon.",
        idempotency_key: "chat-post:1:turn-1:abc",
      };
      const first = await api.send(input);
      expect(first).toMatchObject({
        sent: true,
        message_id: `urn:li:msg_message:(${SELF},sent-1)`,
        conversation_id: "2-synthetic-dm==",
      });
      expect(posts).toHaveLength(1);
      expect(posts[0].message.conversationUrn).toBe(DM);
      expect(posts[0].mailboxUrn).toBe(SELF);
      expect(JSON.stringify(posts[0])).not.toContain("synthetic-csrf");
      // A retry of the same key adopts the first send.
      const retry = await api.send(input);
      expect(retry).toMatchObject({ already_sent: true, message_id: first.message_id });
      expect(posts).toHaveLength(1);
      // A different key is a different reply.
      await api.send({ ...input, idempotency_key: "chat-post:1:turn-2:def" });
      expect(posts).toHaveLength(2);
    } finally {
      dom.window.close();
    }
  });

  test("without echoed tokens, provider deduplication retries a key but preserves distinct replies", async () => {
    const { api, dom, posts } = messenger({
      conversations: [{ entityUrn: DM, groupChat: false }],
      messages: { [DM]: [INBOUND] },
      echoOriginToken: false,
    });
    try {
      const input = { expected_account: "urn:li:fs_miniProfile:synthetic-self",
        conversation_id: "2-synthetic-dm==",
        text: "On my way.",
        idempotency_key: "k1",
      };
      const first = await api.send(input);
      expect(await api.send(input)).toMatchObject({ message_id: first.message_id });
      const second = await api.send({ ...input, idempotency_key: "k2" });
      expect(second.message_id).not.toBe(first.message_id);
      expect(posts.every((post) => post.dedupeByClientGeneratedToken === true)).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  test("concurrent attempts of one key confirm the same provider message", async () => {
    const messages: Record<string, any[]> = { [DM]: [INBOUND] };
    const { api, dom, posts } = messenger({
      conversations: [{ entityUrn: DM, groupChat: false }],
      messages,
    });
    try {
      const input = { expected_account: "urn:li:fs_miniProfile:synthetic-self",
        conversation_id: "2-synthetic-dm==",
        text: "hi",
        idempotency_key: "same-key",
      };
      const [first, second] = await Promise.all([api.send(input), api.send(input)]);
      expect(first.message_id).toBe(second.message_id);
      expect(messages[DM].filter((message) => message.sender.hostIdentityUrn === SELF)).toHaveLength(1);
      expect(posts.every((post) => post.dedupeByClientGeneratedToken === true)).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  test.each([
    ["a group", { entityUrn: GROUP, groupChat: true }, "2-synthetic-group==", "only answers direct messages"],
    ["unknown membership", { entityUrn: DM }, "2-synthetic-dm==", "only answers direct messages"],
    ["conflicting membership", { entityUrn: DM, groupChat: false, conversationParticipants: [{}, {}, {}] }, "2-synthetic-dm==", "only answers direct messages"],
    ["an absent conversation", { entityUrn: GROUP, groupChat: false }, "2-synthetic-dm==", "not in the inbox"],
  ])("send_message refuses %s without sending", async (_, conversation, threadId, error) => {
    const { api, dom, posts } = messenger({
      conversations: [conversation],
      messages: { [DM]: [INBOUND], [GROUP]: [] },
    });
    try {
      await expect(
        api.send({ expected_account: "urn:li:fs_miniProfile:synthetic-self", conversation_id: threadId, text: "hi", idempotency_key: "k" })
      ).rejects.toThrow(error);
      expect(posts).toHaveLength(0);
    } finally {
      dom.window.close();
    }
  });

  test("an accepted send that never appears fails instead of reporting success", async () => {
    const { api, dom, posts } = messenger({
      conversations: [{ entityUrn: DM, groupChat: false }],
      messages: { [DM]: [INBOUND] },
      showSent: false,
    });
    try {
      await expect(
        api.send({ expected_account: "urn:li:fs_miniProfile:synthetic-self", conversation_id: "2-synthetic-dm==", text: "hi", idempotency_key: "k" })
      ).rejects.toThrow("did not appear");
      expect(posts).toHaveLength(1);
    } finally {
      dom.window.close();
    }
  }, 15_000);
});

const PAGE = "urn:li:fsd_pageMailbox:900001";
const PAGE_DM = `urn:li:msg_conversation:(${PAGE},2-synthetic-page-dm==)`;
const PAGE_INBOUND = {
  ...INBOUND,
  entityUrn: `urn:li:msg_message:(${PAGE},2-synthetic-page-inbound)`,
  deliveredAt: 1700000000000,
};
/** How a page's own reply is attributed: the mailbox or the page, with the sending admin only as actor. */
const PAGE_REPLIES = [
  { entityUrn: `urn:li:msg_message:(${PAGE},2-synthetic-page-reply-1)`, deliveredAt: 1700000000004, body: { text: "Thanks!" }, sender: { hostIdentityUrn: PAGE }, actor: { hostIdentityUrn: SELF } },
  { entityUrn: `urn:li:msg_message:(${PAGE},2-synthetic-page-reply-2)`, deliveredAt: 1700000000003, body: { text: "Following up" }, sender: { hostIdentityUrn: "urn:li:fsd_company:900002", participantType: { organization: { name: { text: "Synthetic Co" } } } } },
];
/** The signed-in admin messaging the page as themselves: a visitor, not the page. */
const PAGE_ADMIN_AS_MEMBER = {
  entityUrn: `urn:li:msg_message:(${PAGE},2-synthetic-admin-as-member)`,
  deliveredAt: 1700000000002,
  body: { text: "Admin here" },
  sender: { hostIdentityUrn: SELF, participantType: { member: { firstName: { text: "Self" }, lastName: { text: "Admin" } } } },
  actor: { hostIdentityUrn: SELF },
};

describe("LinkedIn page inboxes", () => {
  test("a page cursor cannot resume after the signed-in member changes", async () => {
    const options = {
      member: SELF,
      administers: [PAGE],
      conversations: [{ entityUrn: PAGE_DM, groupChat: false }],
      messages: { [PAGE_DM]: [...PAGE_REPLIES, PAGE_INBOUND] },
    };
    const { api, dom } = messenger(options);
    try {
      const first = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", inbox: PAGE, limit: 1 });
      options.member = "urn:li:fsd_profile:synthetic-other-admin";
      await expect(api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", inbox: PAGE, cursor: first.nextCursor }))
        .rejects.toThrow("saved account");
    } finally {
      dom.window.close();
    }
  });

  test("a page checkpoint remains bound to its signed-in member across reattachment", async () => {
    const options = {
      member: SELF,
      administers: [PAGE],
      conversations: [],
      messages: {},
    };
    const { api, dom } = messenger(options);
    const sent: any[] = [];
    dom.window.postMessage = (message: unknown) => { sent.push(message); };
    try {
      await api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", inbox: PAGE, bridge_id: "page", token: "token" });
      const checkpoint = sent[0].record.checkpoint.next;
      options.member = "urn:li:fsd_profile:synthetic-other-admin";
      for (const inbox of [PAGE, "me"]) {
        await expect(api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", inbox, bridge_id: "reattach", token: "token", checkpoint }))
          .rejects.toThrow("saved account");
      }
      options.member = SELF;
      await expect(api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", inbox: "me", bridge_id: "member", token: "token", checkpoint }))
        .resolves.toEqual({ listening: true });
    } finally {
      api.detach();
      dom.window.close();
    }
  });

  test("an empty or null mailbox authorization result refuses reads and sends", async () => {
    for (const data of [{}, { messengerMailboxCountsByMailbox: null }]) {
      const { api, dom, calls, posts } = messenger({
        administers: [PAGE],
        mailboxCountsResponse: { data },
        conversations: [{ entityUrn: PAGE_DM, groupChat: false }],
        messages: { [PAGE_DM]: [PAGE_INBOUND] },
      });
      try {
        await expect(api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", inbox: PAGE })).rejects.toThrow();
        await expect(api.send({ expected_account: "urn:li:fs_miniProfile:synthetic-self", conversation_id: PAGE_DM, text: "hi", idempotency_key: "key" })).rejects.toThrow();
        expect(calls.some((url) => url.includes("messengerConversations."))).toBe(false);
        expect(posts).toHaveLength(0);
      } finally {
        dom.window.close();
      }
    }
  });

  test("a page send refuses a member change during conversation lookup", async () => {
    const options = {
      member: SELF,
      administers: [PAGE],
      conversations: [{ entityUrn: PAGE_DM, groupChat: false }],
      messages: {},
    };
    Object.defineProperty(options.messages, PAGE_DM, {
      get() {
        options.member = "urn:li:fsd_profile:synthetic-other-admin";
        return [];
      },
    });
    const { api, dom, posts } = messenger(options);
    try {
      await expect(api.send({ expected_account: "urn:li:fs_miniProfile:synthetic-self", conversation_id: PAGE_DM, text: "hi", idempotency_key: "key" }))
        .rejects.toThrow("account changed");
      expect(posts).toHaveLength(0);
    } finally {
      dom.window.close();
    }
  }, 15_000);

  test("a page feed reads the page's mailbox and treats the page's own messages as ours", async () => {
    const { api, dom, calls } = messenger({
      administers: [PAGE],
      conversations: [
        { entityUrn: PAGE_DM, groupChat: false, lastActivityAt: 1700000000003, topic: { text: "Other" } },
      ],
      messages: { [PAGE_DM]: [...PAGE_REPLIES, PAGE_ADMIN_AS_MEMBER, PAGE_INBOUND] },
    });
    try {
      const page = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", inbox: PAGE, limit: 20 });
      const conversationsUrl = calls.find((url) => url.includes("messengerConversations."));
      expect(conversationsUrl).toContain(`mailboxUrn:${encodeURIComponent(PAGE)}`);
      expect(page.rows.map((row: any) => [row.id, row.from_me])).toEqual([
        [PAGE_REPLIES[0].entityUrn, true],
        [PAGE_REPLIES[1].entityUrn, true],
        [PAGE_ADMIN_AS_MEMBER.entityUrn, false],
        [PAGE_INBOUND.entityUrn, false],
      ]);
      expect(page.rows[3]).toMatchObject({
        conversation_id: PAGE_DM,
        thread_id: "2-synthetic-page-dm==",
        is_group: false,
        sender_member_id: "ACoAASyntheticPeer",
        topic: "Other",
      });
      const first = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", inbox: PAGE, limit: 1 });
      expect(JSON.parse(first.nextCursor).account).toBe(PAGE);
      // A page cursor never resumes the member's inbox.
      await expect(
        api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", limit: 1, cursor: first.nextCursor })
      ).rejects.toThrow("different source or account");
      const found = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
        feed: "live_messages",
        inbox: PAGE,
        query: `id:${PAGE_INBOUND.entityUrn}`,
      });
      expect(found.rows).toMatchObject([{ id: PAGE_INBOUND.entityUrn, conversation_id: PAGE_DM }]);
    } finally {
      dom.window.close();
    }
  });

  test("member rows carry no page-only fields", async () => {
    const { api, dom } = messenger({
      conversations: [{ entityUrn: DM, groupChat: false, lastActivityAt: 1700000000000, topic: { text: "Other" } }],
      messages: { [DM]: [INBOUND] },
    });
    try {
      const { rows } = await api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", inbox: "me", limit: 20 });
      expect(rows).toHaveLength(1);
      expect("topic" in rows[0]).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  test("a page the signed-in member does not administer is refused before any read or send", async () => {
    const { api, dom, calls, posts } = messenger({
      conversations: [{ entityUrn: PAGE_DM, groupChat: false, lastActivityAt: 1700000000000 }],
      messages: { [PAGE_DM]: [PAGE_INBOUND] },
    });
    try {
      await expect(
        api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", inbox: PAGE, limit: 20 })
      ).rejects.toThrow("does not administer");
      await expect(
        api.send({ expected_account: "urn:li:fs_miniProfile:synthetic-self", conversation_id: PAGE_DM, text: "hi", idempotency_key: "k" })
      ).rejects.toThrow("does not administer");
      expect(calls.some((url) => url.includes("messengerConversations."))).toBe(false);
      expect(posts).toHaveLength(0);
      for (const inbox of ["900001", "urn:li:fsd_company:900002", "urn:li:fsd_profile:someone"]) {
        await expect(api.read({ expected_account: "urn:li:fs_miniProfile:synthetic-self", feed: "live_messages", inbox })).rejects.toThrow("inbox must be");
      }
    } finally {
      dom.window.close();
    }
  });

  test("send_message replies from the inbox its full conversation URN names", async () => {
    const { api, dom, posts } = messenger({
      administers: [PAGE],
      conversations: [
        { entityUrn: PAGE_DM, groupChat: false, lastActivityAt: 1700000000001 },
        { entityUrn: DM, groupChat: false, lastActivityAt: 1700000000000 },
      ],
      messages: { [PAGE_DM]: [PAGE_INBOUND], [DM]: [INBOUND] },
    });
    try {
      const input = { expected_account: "urn:li:fs_miniProfile:synthetic-self", conversation_id: PAGE_DM, text: "Happy to help.", idempotency_key: "page-key" };
      const first = await api.send(input);
      expect(first).toMatchObject({ sent: true, conversation_id: PAGE_DM });
      expect(posts[0]).toMatchObject({
        mailboxUrn: PAGE,
        message: { conversationUrn: PAGE_DM },
      });
      expect(await api.send(input)).toMatchObject({ already_sent: true, message_id: first.message_id });
      expect(posts).toHaveLength(1);
      // The member's own conversation URN is the member inbox.
      await api.send({ expected_account: "urn:li:fs_miniProfile:synthetic-self", conversation_id: DM, text: "Hi", idempotency_key: "member-key" });
      expect(posts[1]).toMatchObject({ mailboxUrn: SELF, message: { conversationUrn: DM } });
      await expect(
        api.send({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
          conversation_id: "urn:li:msg_conversation:(urn:li:fsd_profile:someone-else,2-synthetic-dm==)",
          text: "Hi",
          idempotency_key: "k",
        })
      ).rejects.toThrow("another LinkedIn account");
      expect(posts).toHaveLength(2);
    } finally {
      dom.window.close();
    }
  });

  test("switching a feed's inbox restarts its checkpoint; a changed member account still fails", async () => {
    const { api, dom } = messenger({
      administers: [PAGE],
      conversations: [{ entityUrn: PAGE_DM, groupChat: false, lastActivityAt: Date.now() }],
      messages: { [PAGE_DM]: [{ ...PAGE_INBOUND, deliveredAt: Date.now() }] },
    });
    const sent: any[] = [];
    dom.window.postMessage = (message: unknown) => {
      sent.push(message);
    };
    const memberCheckpoint = {
      linkedin_inbox: { feed: "live_messages", account: SELF, started_at: 1, after: 1, floor: 1, seen: {} },
    };
    try {
      await api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
        feed: "live_messages",
        inbox: PAGE,
        bridge_id: "synthetic-bridge",
        token: "synthetic-token",
        checkpoint: memberCheckpoint,
      });
      expect(sent).toHaveLength(1);
      expect(sent[0].record.source_error).toBeUndefined();
      // A fresh baseline: nothing from the page's history is replayed.
      expect(sent[0].record.events).toEqual([]);
      expect(sent[0].record.checkpoint.previous).toEqual(memberCheckpoint);
      expect(sent[0].record.checkpoint.next.linkedin_inbox.account).toBe(PAGE);
      await expect(
        api.listen({ expected_account: "urn:li:fs_miniProfile:synthetic-self",
          feed: "live_messages",
          bridge_id: "synthetic-bridge-2",
          token: "synthetic-token-2",
          checkpoint: {
            linkedin_inbox: { ...memberCheckpoint.linkedin_inbox, account: "urn:li:fsd_profile:someone-else" },
          },
        })
      ).rejects.toThrow("belongs to another account");
    } finally {
      api.detach();
      dom.window.close();
    }
  });
});

describe("LinkedIn chat declarations", () => {
  test("message.created can answer its source and send_message is a keyed direct send", () => {
    const definition = new LinkedInConnector().definition;
    expect(
      definition.automationEvents?.find((event) => event.key === "message.created")
    ).toMatchObject({ capabilities: { replyToSource: true } });
    const send = definition.actions?.send_message;
    expect(send?.inputSchema).toMatchObject({
      required: ["conversation_id", "text", "idempotency_key"],
    });
    expect(send?.description).toContain("approved only for answering direct messages");
    expect(send?.description).toContain("draft-only");
    const pattern = new RegExp(
      (send?.inputSchema as any).properties.conversation_id.pattern
    );
    for (const accepted of ["2-synthetic-dm==", DM, PAGE_DM]) {
      expect(pattern.test(accepted)).toBe(true);
    }
    for (const refused of [
      "urn:li:msg_conversation:(urn:li:fsd_company:1,2-x==)",
      `${PAGE_DM} `,
      "a:b",
    ]) {
      expect(pattern.test(refused)).toBe(false);
    }
    const inbox = (definition.feeds?.live_messages?.configSchema as any)
      ?.properties?.inbox;
    expect(new RegExp(inbox.pattern).test(PAGE)).toBe(true);
    expect(new RegExp(inbox.pattern).test("me")).toBe(true);
    expect(new RegExp(inbox.pattern).test("900001")).toBe(false);
  });

  test("only a live messages read carries its feed's inbox to the page", async () => {
    const expressions: string[] = [];
    const browser = {
      dispatch: async (action: string, input: any) => {
        if (action === "navigate") return { tab_id: 7 };
        expressions.push(input.expression);
        return { value: { rows: [], hasMore: false } };
      },
    };
    for (const feedKey of ["live_messages", "notifications"]) {
      await readLinkedInInbox({
        feedKey,
        config: { inbox: PAGE },
        sessionState: { account_id: "urn:li:fs_miniProfile:synthetic-self" },
        credentials: null,
        browser,
      } as any);
    }
    expect(expressions[0]).toContain(PAGE);
    expect(expressions[1]).not.toContain(PAGE);
  });

  test("an id: read reaches the page with its query, and other queries are refused", async () => {
    const calls: string[] = [];
    const browser = {
      dispatch: async (action: string, input: any) => {
        calls.push(action);
        if (action === "navigate") return { tab_id: 7 };
        expect(input.expression).toContain("id:urn:li:msg_message:x");
        return { value: { rows: [], hasMore: false } };
      },
    };
    await readLinkedInInbox({
      feedKey: "live_messages",
      query: "id:urn:li:msg_message:x",
      config: {},
      sessionState: { account_id: "urn:li:fs_miniProfile:synthetic-self" },
      credentials: null,
      browser,
    } as any);
    expect(calls).toEqual(["navigate", "evaluate"]);
    await expect(
      readLinkedInInbox({
        feedKey: "live_messages",
        query: "hello",
        config: {},
        sessionState: { account_id: "urn:li:fs_miniProfile:synthetic-self" },
        credentials: null,
        browser,
      } as any)
    ).rejects.toThrow("unsupported");
  });
});
