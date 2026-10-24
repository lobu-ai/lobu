/**
 * Suite for the live-only WhatsApp Web connector: source reads, reference
 * observation, readiness over the generic `evaluate` bridge, and actions.
 * Nothing here stores a message; there is no history-import feed.
 */

import {
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import { readFileSync } from "node:fs";
import { constrainBrowserInput } from "../../../connector-sdk/src/browser-requirement.js";
import WhatsAppWebConnector from "../whatsapp_web.js";
import {
  canonicalizeJid,
  messagePayloadText,
  normalizeRelayedMessage,
  type ObservationCheckpoint,
  rawMessageId,
} from "../whatsapp-web-helpers.js";

/** The extension suite's fixture, unchanged. */
function message(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    chat_jid: "15551234567@s.whatsapp.net",
    chat_name: "Alice",
    sender_jid: "15551234567@s.whatsapp.net",
    push_name: "Alice",
    from_me: false,
    is_group: false,
    timestamp: 1_787_358_200,
    occurred_at: "2026-08-22T00:23:20.000Z",
    body: "hello",
    message_type: "chat",
    ...overrides,
  };
}

interface DispatchCall {
  action: string;
  input: Record<string, unknown>;
}

/**
 * Stands in for the paired extension. Every adapter RPC arrives as an
 * `evaluate` whose expression embeds a JSON request, so the fake parses the op
 * back out and answers from `responses` — the same table shape the extension
 * suite drove `chrome.scripting.executeScript` with.
 */
function makeDispatcher(
  responses: Record<string, unknown | ((input: unknown) => unknown)> = {},
  { adapterInstalled = true }: { adapterInstalled?: boolean } = {},
) {
  const calls: DispatchCall[] = [];
  const adapterOps: string[] = [];
  const injections: string[] = [];
  let installed = adapterInstalled;
  const dispatch = mock(
    async (action: string, input: Record<string, unknown>) => {
      // Exercise the production host grant before simulating the paired extension.
      input = constrainBrowserInput(connector.definition.browser, action, input);
      calls.push({ action, input });
      if (action === "navigate") return { tab_id: 42, current_url: input.url };
      if (action === "feed_listen") return typeof responses.feed_listen === "function" ? responses.feed_listen(input) : (responses.feed_listen ?? { bridge_id: "synthetic-feed", binding_id: "synthetic-feed", epoch: "synthetic-epoch", token: "synthetic-token", records: [],
            });
      if (action !== "evaluate") return {};
      const expression = String(input.expression ?? "");
      if (expression.includes("location.reload()")) {
        installed = false;
        return { value: true };
      }
      // Installation probe.
      if (expression.includes("a.version ===")) return { value: installed };
      const match = expression.match(/a\.invoke\((\{[\s\S]*\})\);/);
      // Anything that is neither the probe nor an RPC is the serialised
      // program being injected.
      if (!match?.[1]) {
        injections.push(expression);
        installed = true;
        return { value: undefined };
      }
      const request = JSON.parse(match[1]) as { op: string };
      adapterOps.push(request.op);
      if (!installed) {
        return {
          value: {
            ok: false,
            error: { state: "adapter_unavailable", reason: "not installed" },
          },
        };
      }
      const entry = responses[request.op] ?? (request.op === "listen" ? { ok: true } : undefined);
      // Await a function entry: a response may be a promise the test resolves
      // later, which is how a slow device answer is modelled.
      const value =
        typeof entry === "function"
          ? await (entry as (r: unknown) => unknown)(request)
          : entry;
      return {
        value: value ?? {
          ok: false,
          error: { state: "unsupported_operation", reason: request.op },
        },
      };
    },
  );
  return {
    dispatcher: { dispatch } as never,
    calls,
    adapterOps,
    injections,
    uninstallAdapter: () => {
      installed = false;
    },
  };
}

const READY = { ok: true, status: { state: "ready" }, capabilities: {} };

let connector: WhatsAppWebConnector;
beforeEach(() => {
  connector = new WhatsAppWebConnector();
});

/** A live source read: the one path every readiness case goes through now. */
function liveRead(dispatcher: unknown) {
  return connector.read({
    feedKey: "live_messages", config: {}, credentials: null,
    sessionState: { account_id: "15550000001@c.us" }, browser: dispatcher as never,
  });
}

function readResponse(rows: Record<string, unknown>[]) {
  return { ok: true, results: rows, hasMore: false };
}

describe("WhatsApp live source reads", () => {
  it("declares a source-only feed without sync or event ingestion", () => {
    expect(Object.keys(connector.definition.feeds)).toEqual(["live_messages"]);
    const feed = connector.definition.feeds.live_messages;
    expect(typeof feed.read).toBe("function");
    expect("sync" in feed).toBe(false);
    expect(feed.webhook).toEqual({ mode: "trigger", events: ["message.created", "source.gap"],
    });
    expect("eventKinds" in feed).toBe(false);
  });

  it("reads through the browser without syncing or downloading media", async () => {
    const page = makeDispatcher({
      probe: READY,
      read_messages: { ok: true, results: [message("live-message")], nextCursor: "next-page", hasMore: true },
    });
    const result = await connector.read({
      feedKey: "live_messages", config: { chat_filter: "individual" }, credentials: null,
      sessionState: { account_id: "15550000001@c.us" },
      query: "hello", limit: 10, browser: page.dispatcher,
    });
    expect(result.rows).toMatchObject([{ id: "live-message", text: "hello" }]);
    expect(result.nextCursor).toBe("next-page");
    expect(result.hasMore).toBe(true);
    expect(page.adapterOps).toEqual(["probe", "read_messages"]);
    expect(page.calls.some((call) => call.action === "feed_listen")).toBe(false);
  });

  it("returns sender identity on live rows so subscribers need no synced copy", async () => {
    const page = makeDispatcher({
      probe: READY,
      read_messages: { ok: true, results: [
        message("inbound"),
        message("group", { chat_jid: "120363000000000000@g.us", sender_jid: "15557654321@s.whatsapp.net", push_name: "Bob" }),
        message("outbound", { from_me: true }),
      ], hasMore: false },
    });
    const result = await connector.read({ feedKey: "live_messages", config: {}, credentials: null,
      sessionState: { account_id: "15550000001@c.us" },
      browser: page.dispatcher,
    });
    expect(result.rows).toMatchObject([
      { id: "inbound", push_name: "Alice", sender_phone: "15551234567", is_group: false },
      { id: "group", push_name: "Bob", sender_phone: "15557654321", is_group: true },
      { id: "outbound", push_name: null, sender_phone: null, is_group: false },
    ]);
    const columns = result.columns?.map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["push_name", "sender_phone", "is_group"]));
  });

  it("carries whether a live row addresses the account", async () => {
    const page = makeDispatcher({
      probe: READY,
      read_messages: { ok: true, results: [
        message("mention", { chat_jid: "120363000000000000@g.us", mentions_me: true }),
        message("chatter", { chat_jid: "120363000000000000@g.us", mentions_me: false }),
        message("legacy"),
      ], hasMore: false },
    });
    const result = await connector.read({ feedKey: "live_messages", config: {}, credentials: null,
      sessionState: { account_id: "15550000001@c.us" },
      browser: page.dispatcher,
    });
    expect(result.rows.map((row) => [row.id, row.mentions_me])).toEqual([
      ["mention", true],
      ["chatter", false],
      ["legacy", false],
    ]);
    expect(result.columns).toContainEqual({ name: "mentions_me", type: "boolean" });
  });

  it("classifies each live row's content structurally", async () => {
    const page = makeDispatcher({
      probe: READY,
      read_messages: { ok: true, results: [
        message("text"),
        message("captioned", { body: "", caption: "look", media_kind: "image" }),
        message("image", { body: "", media_kind: "image" }),
        message("revoked", { revoked: true }),
        message("system", { body: "", is_system_event: true }),
        message("system-body", { body: "Group subject changed", is_system_event: true }),
        message("system-caption", { body: "", caption: "Group updated", is_system_event: true }),
      ], hasMore: false },
    });
    const result = await connector.read({ feedKey: "live_messages", config: {}, credentials: null,
      sessionState: { account_id: "15550000001@c.us" },
      browser: page.dispatcher,
    });
    expect(result.rows.map((row) => [row.id, row.content_kind, row.text])).toEqual([
      ["text", "text", "hello"],
      ["captioned", "text", "look"],
      ["image", "media", "[image]"],
      ["revoked", "revoked", "[revoked message]"],
      ["system", "system", "[system event]"],
      ["system-body", "system", "Group subject changed"],
      ["system-caption", "system", "Group updated"],
    ]);
    expect(result.columns?.map((column) => column.name)).toContain("content_kind");
  });

  it("declares that a new message can be answered where it came from", () => {
    expect(connector.definition.automationEvents).toEqual(
      expect.arrayContaining([
      expect.objectContaining({ key: "message.created", capabilities: { replyToSource: true },
        }),
    ]),
    );
  });

  it("preserves the continuation of an empty filtered page", async () => {
    const page = makeDispatcher({ probe: READY,
      read_messages: { ok: true, results: [], nextCursor: "next-page", hasMore: true },
    });
    const result = await connector.read({ feedKey: "live_messages", config: {}, credentials: null,
      sessionState: { account_id: "15550000001@c.us" },
      cursor: "previous-page", browser: page.dispatcher,
    });
    expect(result).toMatchObject({ rows: [], nextCursor: "next-page", hasMore: true });
  });

  it("fails a source read instead of reporting unavailable history as empty", async () => {
    const page = makeDispatcher({ probe: READY,
      read_messages: { ok: false, error: { state: "operation_failed", reason: "Source message could not be loaded" } },
    });
    await expect(connector.read({ feedKey: "live_messages", config: {}, credentials: null,
        sessionState: { account_id: "15550000001@c.us" },
        browser: page.dispatcher,
    }),
    ).rejects.toThrow("Source message could not be loaded");
  });

  it("rejects unsupported sorting and offset pagination before dispatch", async () => {
    const page = makeDispatcher();
    const ctx = { feedKey: "live_messages", config: {}, credentials: null,
      sessionState: { account_id: "15550000001@c.us" },
      browser: page.dispatcher,
    };
    await expect(connector.read({ ...ctx, offset: 10 })).rejects.toThrow("cursor");
    await expect(connector.read({ ...ctx, sort: { column: "occurred_at", order: "desc" } })).rejects.toThrow("sorting");
    await expect(connector.read({ ...ctx, window: { start: "2026-08-22T00:00:00Z", end: "2026-08-23T00:00:00Z" } })).rejects.toThrow("window");
    expect(page.calls).toHaveLength(0);
  });
});

describe("WhatsApp source listener setup", () => {
  const binding = { bridge_id: "synthetic-feed", token: "synthetic-token", subscription: { scope_key: "synthetic-scope" } };

  it.each([
    {},
    {
      schema: "owletto.whatsapp.browser.v1", adapter_version: 22,
      head: {}, backfill: { complete: true, cursor_chat_jid: null, inventory: [], chats: {},
      },
    },
  ])("publishes atomic replay batches from current and pre-upgrade checkpoints: %j", async (legacyFields) => {
    const batches: Array<any> = [];
    let pages = 0;
    const page = makeDispatcher({ probe: READY, feed_listen: binding,
      observe_messages: () => ({ ok: true, after: 101 + pages, references: [{ id: "message-" + ++pages, timestamp: 2001 }], hasMore: pages < 2,
      }),
      publish_changes: (request: any) => { batches.push(request.batch); return { ok: true }; },
    });
    const checkpoint: ObservationCheckpoint = { ...legacyFields, observation: { after: 100, started_at: 2000, chat_filter: "all" } };
    expect(await connector.observe({ feedKey: "live_messages", config: { chat_filter: "all" },
      checkpoint, credentials: null,
        sessionState: { account_id: "15550000001@c.us" },
        browser: page.dispatcher,
      }),
    ).toBeUndefined();
    expect(batches).toHaveLength(2);
    expect(batches[0].checkpoint.previous).toEqual(checkpoint);
    expect(batches[1].checkpoint.previous).toEqual(batches[0].checkpoint.next);
    expect(batches[1].checkpoint.next).toEqual({ observation: { after: 102, started_at: 2000, chat_filter: "all",
        account: "15550000001@c.us",
        anchor: null,
        unresolved: [],
      },
    });
    expect(batches[0].events).toEqual([{ id: "message-1", event_type: "message.created", resource_type: "message",
      resource_ref: "message-1", occurred_at: new Date(2001 * 1000).toISOString() }]);
    expect(batches.every((batch) => batch.more === false)).toBe(true);
  });

  it("declares source gaps without granting reply-to-source capability", () => {
    const gap = connector.definition.automationEvents?.find(
      (event) => event.key === "source.gap",
    );
    expect(gap).toBeDefined();
    expect(gap?.capabilities?.replyToSource).not.toBe(true);
  });

  it.each([
    "read",
    "observe",
    "send",
  ])("requires a saved session account before %s browser access", async (method) => {
    const page = makeDispatcher({ probe: READY });
    const ctx = { feedKey: "live_messages", config: {}, credentials: null,
      browser: page.dispatcher,
    };
    if (method === "send")
      expect(
        await connector.execute({
          ...ctx,
          actionKey: "send_message",
          input: {},
        } as never),
      ).toMatchObject({
        success: false,
        error: expect.stringMatching(/saved account/i),
      });
    else
      await expect(
        method === "read" ? connector.read(ctx) : connector.observe(ctx),
      ).rejects.toThrow(/saved account/i);
    expect(page.calls).toEqual([]);
  });

  it("rejects a replay checkpoint from a different saved session account before browser access", async () => {
    const page = makeDispatcher({ probe: READY, feed_listen: binding });
    await expect(
      connector.observe({
        feedKey: "live_messages",
        config: {},
        checkpoint: {
          observation: {
            after: 100,
            started_at: 2000,
            chat_filter: "all",
            account: "15550000002@c.us",
          },
        },
        credentials: null,
        sessionState: { account_id: "15550000001@c.us" },
        browser: page.dispatcher,
      } as never),
    ).rejects.toThrow(/account/i);
    expect(page.calls).toHaveLength(0);
  });

  it("starts a fresh baseline when the chat filter changes", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const batches: Array<any> = [];
    const page = makeDispatcher({ probe: READY, feed_listen: binding,
      observe_messages: (request: any) => {
        requests.push(request.input);
        return { ok: true, after: 900, references: [], hasMore: false };
      },
      publish_changes: (request: any) => { batches.push(request.batch); return { ok: true }; },
    });
    const checkpoint: ObservationCheckpoint = { observation: { after: 100, started_at: 1, chat_filter: "individual" } };
    await connector.observe({ feedKey: "live_messages", config: { chat_filter: "group" },
      checkpoint, credentials: null,
      sessionState: { account_id: "15550000001@c.us" },
      browser: page.dispatcher,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({});
    expect(requests[1]).toMatchObject({ after: 900, chat_filter: "group" });
    expect(batches[0].checkpoint.previous).toEqual(checkpoint);
    expect(batches[0].checkpoint.next.observation).toMatchObject({ after: 900, chat_filter: "group" });
    expect(batches[0].events).toEqual([]);
  });

  it.each([
    [500, "界".repeat(60)],
    [143, "x".repeat(381)],
  ] as const)("splits %i references by final encoded bytes and advances the cursor only after the final chunk", async (count, suffix) => {
    const references = Array.from({ length: count }, (_, index) => ({
      id: `synthetic-${index}-${suffix}`, timestamp: 2001,
    }));
    const batches: Array<any> = [];
    const page = makeDispatcher({ probe: READY, feed_listen: binding,
      observe_messages: { ok: true, after: 600, references, hasMore: false },
      publish_changes: (request: any) => {
        const record = { ...request.batch, id: `replay:${"0".repeat(64)}` };
        expect(new TextEncoder().encode(JSON.stringify(record)).length,
        ).toBeLessThanOrEqual(128 * 1024);
        batches.push(request.batch);
        return { ok: true };
      },
    });
    const checkpoint: ObservationCheckpoint = { observation: { after: 100, started_at: 2000, chat_filter: "group" } };
    await connector.observe({ feedKey: "live_messages", config: { chat_filter: "group" },
      checkpoint, credentials: null,
      sessionState: { account_id: "15550000001@c.us" },
      browser: page.dispatcher,
    });
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((batch) => batch.events.map((event: any) => event.resource_ref),
      ),
    ).toEqual(references.map((ref) => ref.id));
    expect(batches.slice(0, -1).every((batch) => !batch.checkpoint)).toBe(true);
    expect(batches.at(-1).checkpoint).toMatchObject({ previous: checkpoint, next: { observation: { after: 600 } } });
  });

  it("retries interrupted chunks without advancing past unaccepted references", async () => {
    const references = Array.from({ length: 500 }, (_, index) => ({
      id: `synthetic-${index}-${"界".repeat(60)}`, timestamp: 2001,
    }));
    const checkpoint = {
      observation: {
        after: 100,
        started_at: 2000,
        chat_filter: "all" as const,
        account: "15550000001@c.us",
      },
    };
    let chunkCount = 0;
    const successful: any[] = [];
    for (let boundary = 0; boundary < 5; boundary++) {
    let calls = 0;
      const accepted: any[] = [];
      const page = makeDispatcher({
        probe: READY,
        feed_listen: binding,
        observe_messages: {
          ok: true,
          after: 600,
          references,
          unresolved: [],
          hasMore: false,
        },
        publish_changes: (request: any) => {
          if (calls++ === boundary) throw new Error("synthetic interruption");
          accepted.push(request.batch);
        return { ok: true };
        },
      });
      const attempt = connector.observe({
        feedKey: "live_messages",
        config: {},
        checkpoint,
        sessionState: { account_id: "15550000001@c.us" },
        credentials: null,
        browser: page.dispatcher,
      });
      if (boundary < chunkCount || boundary === 0)
        await expect(attempt).rejects.toThrow("synthetic interruption");
      else {
        try {
          await attempt;
        } catch (error) {
          expect(String(error)).toContain("synthetic interruption");
        }
      }
      if (calls <= boundary) {
        successful.push(...accepted);
        break;
      }
      expect(accepted.every((batch) => !batch.checkpoint)).toBe(true);
      chunkCount = calls;
    }
    expect(
      successful.flatMap((batch) =>
        batch.events.map((event: any) => event.resource_ref),
      ),
    ).toEqual(references.map((row) => row.id));
    expect(successful.at(-1).checkpoint.previous).toEqual(checkpoint);
  });

  it("rejects a browser without reference-delivery support", async () => {
    const page = makeDispatcher({ probe: READY, observe_messages: { ok: true, after: 1 } });
    await expect(connector.observe({ feedKey: "live_messages", config: {}, checkpoint: null,
      credentials: null,
        sessionState: { account_id: "15550000001@c.us" },
        browser: page.dispatcher,
      }),
    ).rejects.toThrow("source subscriptions");
  });
});

// ── canonical identity (verbatim from the extension suite) ──

describe("canonical WhatsApp identity", () => {
  it("uses raw key.id and never the serialized compound key", () => {
    expect(
      rawMessageId({ id: "3EB0ABC", _serialized: "false_123@c.us_3EB0ABC_in" })
    ).toBe("3EB0ABC");
    expect(
      rawMessageId({ _serialized: "false_123@c.us_3EB0ABC_in" })
    ).toBeNull();
    expect(rawMessageId("true_123@c.us_3EB0ABC_out")).toBeNull();
  });

  it("canonicalizes phone JIDs while retaining group and LID forms", () => {
    expect(canonicalizeJid("15551234567@c.us")).toBe(
      "15551234567@s.whatsapp.net"
    );
    expect(canonicalizeJid("123-456@g.us")).toBe("123-456@g.us");
    expect(canonicalizeJid("999@lid")).toBe("999@lid");
  });

  /**
   * Measured against the live prod tab on 2026-09-06: a cold WhatsApp Web load
   * traces 0:0 -> 5:0 -> 947:0 -> 947:23 -> ... -> 947:547 and is STILL
   * climbing at t=24s. Readiness needs the `me:chatCount:msgCount` signature to
   * hold for 500ms, so a 25s budget expired mid-stream on every run -- the feed
   * failed `stores_settling` 9 times out of 10 and ingested nothing for days.
   *
   * The run itself is not the constraint: the executor allows 600s and each
   * probe is its own fenced dispatch, so 25s was arbitrarily tight rather than
   * a real bound. A warm tab still answers in ~1s, so raising this only changes
   * how long a COLD tab is allowed to finish.
   */
  it("budgets readiness for a cold hydration, not just a warm tab", () => {
    const source = readFileSync(
      new URL("../whatsapp_web.ts", import.meta.url),
      "utf8"
    );
    const match = source.match(/const READY_TIMEOUT_MS = ([\d_]+);/);
    if (!match?.[1]) {
      throw new Error("whatsapp_web.ts no longer declares READY_TIMEOUT_MS");
    }
    const readyTimeoutMs = Number(match[1].replaceAll("_", ""));
    // A cold tab was still streaming at 24s; anything at or under that cannot
    // outlast one measured hydration.
    expect(readyTimeoutMs).toBeGreaterThanOrEqual(90_000);
  });

});

// ── live row text ──────────────────────────────────────────────────────

function payloadText(raw: Record<string, unknown>): string {
  const normalized = normalizeRelayedMessage(raw);
  if (!normalized) throw new Error("fixture did not normalize");
  return messagePayloadText(normalized);
}

describe("live row text", () => {
  it("never returns a media row's base64 thumbnail as its text", () => {
    // WhatsApp's `Msg.body` is the message text for a `chat` row and the
    // base64 JPEG THUMBNAIL for a media row — the user's text lives in
    // `caption`. Measured on a live tab (937 loaded messages): 656/656 `chat`
    // rows carry text in `body`, while `body` held a base64 JPEG on 1/22
    // images, 1/7 videos and 2/2 `interactive` cards.
    const thumbnail = `/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEABsbGxscGx4h${"A".repeat(800)}`;
    expect(payloadText(message("img", {
      message_type: "image", media_kind: "image", media_type: "image/jpeg",
      body: thumbnail, caption: "",
    }))).toBe("[image]");
    // A caption is the real text and must still win — including on the
    // `interactive` cards, whose `media_kind` is null but whose `body` is a
    // thumbnail all the same.
    expect(payloadText(message("card", {
      message_type: "interactive", media_kind: null, body: thumbnail, caption: "Book a table",
    }))).toBe("Book a table");
    // Text rows are untouched, and a short body that merely starts with the
    // prefix is text a person typed, not a thumbnail.
    expect(payloadText(message("txt"))).toBe("hello");
    expect(payloadText(message("short", { body: "/9j/ is a JPEG magic prefix" })))
      .toBe("/9j/ is a JPEG magic prefix");
  });

  it("rejects a PNG or WebP thumbnail body too, not just JPEG", () => {
    for (const [prefix, kind] of [
      ["iVBORw0KGgo", "image"],
      ["UklGR", "sticker"],
    ] as const) {
      expect(payloadText(message(`thumb-${prefix}`, {
        message_type: kind, media_kind: kind, body: `${prefix}${"A".repeat(200)}`, caption: "",
      }))).toBe(`[${kind}]`);
    }
  });
});

// ── readiness over the generic bridge ──────────────────────────────────

describe("readiness over the generic chrome bridge", () => {
  it("navigates into the persistent agent window and probes before reading", async () => {
    const { dispatcher, calls, adapterOps } = makeDispatcher({
      probe: READY,
      read_messages: readResponse([message("plain")]),
    });
    const result = await liveRead(dispatcher);
    const nav = calls.find((call) => call.action === "navigate");
    expect(nav?.input).toMatchObject({
      url: "https://web.whatsapp.com/",
      persistent: true,
    });
    expect(adapterOps).toEqual(["probe", "read_messages"]);
    expect(result.rows.map((row) => row.id)).toEqual(["plain"]);
  });

  it("re-injects the adapter when the page lost it, then retries the call", async () => {
    const { dispatcher, injections, uninstallAdapter } = makeDispatcher(
      {
        probe: READY,
        read_messages: readResponse([message("after-reload")]),
      },
      { adapterInstalled: false }
    );
    uninstallAdapter();
    const result = await liveRead(dispatcher);
    expect(injections).toHaveLength(1);
    // The injected expression really is the serialised adapter program, not a
    // stub: it carries the adapter's own global key and its op table.
    expect(injections[0]).toContain("__owlettoWhatsAppAdapterV1");
    expect(injections[0]).toContain("revoke_message");
    expect(injections[0]!.length).toBeGreaterThan(20_000);
    expect(result.rows.map((row) => row.id)).toEqual(["after-reload"]);
  });

  it("reloads a disconnected persistent source once before reading", async () => {
    const { dispatcher, calls, adapterOps } = makeDispatcher({
      probe: () =>
        calls.some((call) =>
          String(call.input.expression).includes("location.reload()"),
        )
          ? READY
          : {
              ok: false,
              error: { state: "not_ready", reason: "stream_disconnected" },
            },
      read_messages: readResponse([message("reconnected")]),
    });
    const realNow = Date.now;
    let ticks = 0;
    Date.now = () => realNow() + ticks++ * 40_000;
    try {
      const result = await liveRead(dispatcher);
      expect(result.rows.map((row) => row.id)).toEqual(["reconnected"]);
      expect(
        calls.filter((call) =>
          String(call.input.expression).includes("location.reload()"),
        ),
      ).toHaveLength(1);
      expect(adapterOps.at(-1)).toBe("read_messages");
    } finally {
      Date.now = realNow;
    }
  });

  it("does not repeatedly reload or read if reconnection fails", async () => {
    const { dispatcher, calls, adapterOps } = makeDispatcher({
      probe: {
        ok: false,
        error: { state: "not_ready", reason: "stream_disconnected" },
      },
    });
    const realNow = Date.now;
    let ticks = 0;
    Date.now = () => realNow() + ticks++ * 40_000;
    try {
      await expect(
        liveRead(dispatcher),
      ).rejects.toThrow("stream_disconnected");
      expect(
        calls.filter((call) =>
          String(call.input.expression).includes("location.reload()"),
        ),
      ).toHaveLength(1);
      expect(adapterOps).not.toContain("read_messages");
    } finally {
      Date.now = realNow;
    }
  });

  it("reports the readiness failure, not a failed reload dispatch", async () => {
    // The reload is a recovery attempt, not a verdict. A bridge that refuses
    // it (tab already navigating, ownership guard) must not replace the
    // readiness error the run is actually retrying on, or a transient stall
    // surfaces as an unclassifiable bridge failure.
    const { dispatcher } = makeDispatcher({
      probe: {
        ok: false,
        error: { state: "not_ready", reason: "stream_disconnected" },
      },
    });
    const bridge = dispatcher as unknown as {
      dispatch: (
        action: string,
        input: Record<string, unknown>,
      ) => Promise<unknown>;
    };
    const inner = bridge.dispatch;
    bridge.dispatch = async (action, input) => {
      if (String(input.expression ?? "").includes("location.reload()")) {
        throw new Error("chrome refused the reload");
      }
      return inner(action, input);
    };
    const realNow = Date.now;
    let ticks = 0;
    Date.now = () => realNow() + ticks++ * 40_000;
    try {
      await expect(
        liveRead(dispatcher),
      ).rejects.toThrow("stream_disconnected");
    } finally {
      Date.now = realNow;
    }
  });

  it("marks persistent store hydration as a transient dependency failure", async () => {
    const realNow = Date.now;
    let calls = 0;
    const { dispatcher } = makeDispatcher({
      probe: () => {
        calls += 1;
        // Jump past READY_TIMEOUT_MS so the readiness loop gives up on the
        // first retry instead of polling for the whole (now cold-hydration
        // sized) budget.
        if (calls === 1) Date.now = () => realNow() + 10 * 60_000;
        return {
          ok: false,
          error: { state: "hydrating", reason: "stores_settling" },
        };
      },
    });
    try {
      await expect(
        liveRead(dispatcher)
      ).rejects.toThrow(
        /^\[lobu:dependency_unavailable:browser_source_hydrating\] WhatsApp Web hydrating: stores_settling/
      );
    } finally {
      Date.now = realNow;
    }
  });

  /**
   * The production boundary: the extension does not RETURN an adapter-shaped error when CDP abandons an
   * evaluation, it REJECTS the dispatch with a bare timeout. That message
   * never carries the connector's own "WhatsApp Web " prefix, so classifying
   * on the prefix first drops it before the transient pattern is ever tried
   * and a hydration stall is still booked as a hard feed failure.
   */
  it("treats a bare dispatch timeout as transient, not a real failure", async () => {
    const realNow = Date.now;
    let calls = 0;
    const dispatch = mock(async (action: string, input: Record<string, unknown>) => {
      if (action === "navigate") return { tab_id: 42, current_url: input.url };
      if (action !== "evaluate") return {};
      const expression = String(input.expression ?? "");
      if (expression.includes("a.version ===")) return { value: true };
      calls += 1;
      if (calls === 1) Date.now = () => realNow() + 10 * 60_000;
      // Exactly what the Chrome bridge rejects with: no adapter state, no
      // connector prefix.
      throw new Error("evaluation timed out");
    });
    const dispatcher = { dispatch };
    try {
      await expect(
        liveRead(dispatcher)
      ).rejects.toThrow(
        /^\[lobu:dependency_unavailable:browser_source_hydrating\]/
      );
    } finally {
      Date.now = realNow;
    }
  });

  /**
   * WhatsApp's `require()` BLOCKS rather than throwing while its module graph is
   * still registering, so a readiness probe can hang with the adapter never
   * naming a state. Measured in prod: nine consecutive probes answered in
   * 3-7s, then one ran 95.2s and was killed. Bounded by the
   * extension's CDP evaluate timeout the page reports a plain timeout, which
   * carries none of the adapter's hydration vocabulary.
   */
  it("treats a probe that never answered as transient, not a real failure", async () => {
    const realNow = Date.now;
    let calls = 0;
    const { dispatcher } = makeDispatcher({
      probe: () => {
        calls += 1;
        if (calls === 1) Date.now = () => realNow() + 10 * 60_000;
        // What the extension reports once CDP abandons the evaluation: a bare
        // timeout, with no adapter state to read.
        return {
          ok: false,
          error: { state: "adapter_failed", reason: "evaluation timed out" },
        };
      },
    });
    try {
      await expect(
        liveRead(dispatcher)
      ).rejects.toThrow(
        /^\[lobu:dependency_unavailable:browser_source_hydrating\]/
      );
    } finally {
      Date.now = realNow;
    }
  });

  it("bumps the WhatsApp connector version for account-bound source recovery", () => {
    expect(connector.definition.version).toBe("2.3.0");
  });

  it("names the remedy when WhatsApp Web is signed out", async () => {
    const { dispatcher } = makeDispatcher({
      probe: {
        ok: false,
        error: { state: "logged_out", reason: "qr_code_visible" },
      },
    });
    await expect(
      liveRead(dispatcher)
    ).rejects.toThrow(/not signed in.*web\.whatsapp\.com.*Linked Devices/is);
  });

  it("refuses to run without a paired extension", async () => {
    await expect(liveRead(undefined)).rejects.toThrow(
      /Browser setup is required/i
    );
  });
});

// ── the action table ───────────────────────────────────────────────────

describe("actions", () => {
  it("declares action categories and destructive metadata", () => {
    const actions = connector.definition.actions ?? {};
    expect(Object.keys(actions).sort()).toEqual([
      "draft_message",
      "edit_message",
      "react_message",
      "revoke_message",
      "search_messages",
      "send_message",
    ]);
    expect(actions.search_messages?.kind).toBe("read");
    // A draft only fills the composer; the human still presses send.
    expect(actions.draft_message?.kind).toBe("write");
    for (const key of [
      "send_message",
      "edit_message",
      "react_message",
      "revoke_message",
    ]) {
      expect(actions[key]?.kind).toBe("write");
    }
    expect(actions.revoke_message?.annotations?.destructiveHint).toBe(true);
  });

  it("normalizes bounded search results", async () => {
    const { dispatcher } = makeDispatcher({
      probe: READY,
      search_messages: {
        ok: true,
        source: "whatsapp_fts",
        results: [
          message("hit-1"),
          { id: "no-timestamp", chat_jid: "1@c.us" },
          message("hit-2", { chat_jid: "status@broadcast" }),
        ],
      },
    });
    const result = await connector.execute({
      actionKey: "search_messages",
      input: { query: "hello" },
      credentials: null,
      sessionState: { account_id: "15550000001@c.us" },
      config: {},
      browser: dispatcher,
    } as never);
    expect(result.success).toBe(true);
    expect(result.output?.source).toBe("whatsapp_fts");
    // The undatable row and the status broadcast are both dropped.
    expect(
      (result.output?.results as Array<{ id: string }>).map((row) => row.id)
    ).toEqual(["hit-1"]);
  });

  it("treats a send with no raw message ID as a failure", async () => {
    const { dispatcher } = makeDispatcher({
      probe: READY,
      send_message: { ok: true, sent: true, chat_jid: "1@s.whatsapp.net" },
    });
    const result = await connector.execute({
      actionKey: "send_message",
      input: { chat_jid: "1@s.whatsapp.net", text: "hi" },
      credentials: null,
      sessionState: { account_id: "15550000001@c.us" },
      config: {},
      browser: dispatcher,
    } as never);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no raw WhatsApp message ID/);
  });

  it("returns the adapter output verbatim for a successful send", async () => {
    const { dispatcher } = makeDispatcher({
      probe: READY,
      send_message: {
        ok: true,
        sent: true,
        chat_jid: "1@s.whatsapp.net",
        message_id: "3EB0NEW",
      },
    });
    const result = await connector.execute({
      actionKey: "send_message",
      input: { chat_jid: "1@s.whatsapp.net", text: "hi" },
      credentials: null,
      sessionState: { account_id: "15550000001@c.us" },
      config: {},
      browser: dispatcher,
    } as never);
    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      sent: true,
      chat_jid: "1@s.whatsapp.net",
      message_id: "3EB0NEW",
    });
  });

  it("surfaces an adapter failure as an action error, not a throw", async () => {
    const { dispatcher } = makeDispatcher({
      probe: READY,
      revoke_message: {
        ok: false,
        error: {
          state: "capability_unavailable",
          reason: "revoke unavailable",
        },
      },
    });
    const result = await connector.execute({
      actionKey: "revoke_message",
      input: { message_id: "3EB0" },
      credentials: null,
      sessionState: { account_id: "15550000001@c.us" },
      config: {},
      browser: dispatcher,
    } as never);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/capability_unavailable/);
  });

  it("rejects an action the connector does not declare", async () => {
    const result = await connector.execute({
      actionKey: "delete_account",
      input: {},
      credentials: null,
      config: {},
      sessionState: {},
    } as never);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown action/);
  });
});

// ── placement ──────────────────────────────────────────────────────────

describe("placement", () => {
  it("stays out of the reserved chrome.* namespace", () => {
    // A `chrome.*` key declares "the extension implements this natively", and
    // the gateway then withholds the bundle — a connector that ships its own
    // code can never live there. This is the whole point of the move.
    expect(connector.definition.key).toBe("whatsapp.web");
    expect(connector.definition.key.startsWith("chrome")).toBe(false);
  });

  it("declares a live browser account without a separate interactive handshake", () => {
    // The QR is rendered by web.whatsapp.com in the user's own browser, and an
    // auth run carries no chrome dispatcher, so there is nothing to relay.
    expect(connector.definition.authSchema?.methods).toEqual([
      { type: "browser", mode: "live" },
    ]);
  });
});
