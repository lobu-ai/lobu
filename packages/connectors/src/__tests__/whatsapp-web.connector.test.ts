/**
 * Parity suite for the WhatsApp Web connector.
 *
 * The assertions here are ported from the Owletto extension's
 * `whatsapp-web.test.js` — the same fixtures and the same expected values —
 * because the bar for deleting the extension-native connector is that this one
 * produces the same events from the same inputs. Where a test named a mechanism
 * that did not survive the move (the IndexedDB outbox, the activation gate, the
 * `chrome.scripting` injection path), the equivalent is asserted against what
 * replaced it: the feed checkpoint and the generic `evaluate` op.
 *
 * The tests the extension owned that have NO equivalent here — the live
 * observer relay and the per-run action ledger — are called out in the
 * connector's header. They are not silently dropped assertions; there is no
 * generic op to carry them.
 */

import { readFileSync } from "node:fs";
import {
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from "bun:test";
import WhatsAppWebConnector from "../whatsapp_web.js";
import { whatsAppWebAdapterProgram } from "../whatsapp-web-adapter.js";
import {
  buildCollectionPlan,
  canonicalizeJid,
  initializeBrowserCheckpoint,
  mergeBrowserCheckpoint,
  mergeCollectedMessages,
  rawMessageId,
  toEventEnvelope,
  type BrowserCheckpoint,
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
  { adapterInstalled = true }: { adapterInstalled?: boolean } = {}
) {
  const calls: DispatchCall[] = [];
  const adapterOps: string[] = [];
  const injections: string[] = [];
  let installed = adapterInstalled;
  const dispatch = mock(
    async (action: string, input: Record<string, unknown>) => {
      calls.push({ action, input });
      if (action === "navigate") return { tab_id: 42, current_url: input.url };
      if (action !== "evaluate") return {};
      const expression = String(input.expression ?? "");
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
      const entry = responses[request.op];
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
    }
  );
  return {
    dispatcher: { dispatch } as never,
    calls,
    adapterOps,
    injections,
    mediaCalls: () => adapterOps.filter((op) => op === "download_media"),
    uninstallAdapter: () => {
      installed = false;
    },
  };
}

const READY = { ok: true, status: { state: "ready" }, capabilities: {} };

function syncCtx(
  checkpoint: BrowserCheckpoint | null,
  dispatcher: unknown,
  config: Record<string, unknown> = {}
) {
  return {
    feedKey: "messages",
    config,
    checkpoint,
    credentials: null,
    entityIds: [],
    sessionState: { chrome_dispatcher: dispatcher },
  } as never;
}

let connector: WhatsAppWebConnector;
beforeEach(() => {
  connector = new WhatsAppWebConnector();
});

function messagesFeed() {
  const feed = connector.definition.feeds?.messages;
  if (!feed?.sync) throw new Error("messages feed is not declared");
  return { ...feed, sync: feed.sync };
}

// ── canonical identity and cutover (verbatim from the extension suite) ──

describe("canonical WhatsApp identity and cutover", () => {
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

  it("sends the history budget as a relative span the page can resolve", () => {
    const { request } = buildCollectionPlan({});
    // Absolute instants cannot cross the connector/page boundary: they run on
    // different machines, so a shared epoch is off by the clock skew.
    expect(request).not.toHaveProperty("deadline");
    expect(request.budget_ms).toBeGreaterThan(0);
    const source = whatsAppWebAdapterProgram.toString();
    expect(source).toContain("request.budget_ms");
    expect(source).not.toContain("request.deadline");
  });

  /**
   * The extension fences EVERY claimed run at RUN_TIMEOUT_MS (90s) from the
   * moment it is claimed, and each `dispatcher.dispatch("evaluate", ...)` is
   * its own such run. The in-page history budget therefore cannot equal the
   * fence: the adapter would be entitled to spend the entire run paging
   * history and still owe a serialize-and-return, which it can never afford.
   * That is the exact shape that stalled a prod feed -- every run died
   * as `run timed out after 90000ms`, so the checkpoint never advanced and
   * the next run repeated the identical oversized work.
   */
  it("leaves the collect budget headroom under the extension run fence", () => {
    // Read the fence from the extension rather than hardcoding it: the two
    // constants live in different repos with nothing linking them, so a
    // hardcoded copy would keep passing while prod broke again.
    const background = readFileSync(
      new URL("../../../owletto/apps/chrome/background.js", import.meta.url),
      "utf8"
    );
    const fenceMatch = background.match(
      /const RUN_TIMEOUT_MS = ([\d_]+);/
    );
    if (!fenceMatch?.[1]) {
      throw new Error(
        "background.js no longer declares RUN_TIMEOUT_MS; the collect budget's headroom is now unverified"
      );
    }
    const runFenceMs = Number(fenceMatch[1].replaceAll("_", ""));
    const { request } = buildCollectionPlan({});
    expect(Number(request.budget_ms)).toBeLessThan(runFenceMs);
    // Enough headroom for the round trip the answer still has to make.
    expect(runFenceMs - Number(request.budget_ms)).toBeGreaterThanOrEqual(
      20_000
    );
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

  it("collects strictly after the cutover so ingested rows never replay", () => {
    const { request } = buildCollectionPlan({
      checkpoint: {
        schema: "owletto.whatsapp.browser.v1",
        cutover_unix_seconds: 1_787_358_184,
      },
    });
    // An inclusive floor would re-read the cutover second on every run. That
    // overlap is what used to justify a second event shape and a media skip.
    expect(request.minimum_timestamp).toBe(1_787_358_185);
    expect(request.backfill_disabled).toBe(true);
    const merged = mergeCollectedMessages(
      [
        message("old", { timestamp: 1_787_358_183 }),
        message("at-cutover", { timestamp: 1_787_358_184 }),
        message("new", { timestamp: 1_787_358_200 }),
      ],
      [],
      request.minimum_timestamp
    );
    expect(merged.map((row) => row.id)).toEqual(["new"]);
  });
});

// ── event shape ────────────────────────────────────────────────────────

describe("event shape", () => {
  it("preserves the title, text, and canonical id the extension emitted", () => {
    const normalized = mergeCollectedMessages([message("3EB0")], [])[0];
    if (!normalized) throw new Error("fixture did not normalize");
    const event = toEventEnvelope(normalized, undefined);
    expect(event.origin_id).toBe("3EB0");
    expect(event.title).toBe("Alice");
    expect(event.payload_text).toBe("hello");
    // Exact fixture for an ordinary inbound 1:1 text message. The only
    // deliberate change from the extension's expectation is `source`, which
    // names the connector producing the row.
    expect(event.metadata).toEqual({
      source: "whatsapp_web",
      origin_id: "3EB0",
      chat_jid: "15551234567@s.whatsapp.net",
      is_group: false,
      from_me: false,
      sender_jid: "15551234567@s.whatsapp.net",
      sender_phone: "15551234567",
      push_name: "Alice",
      is_direct_inbound: true,
    });
    expect(event.occurred_at.toISOString()).toBe("2026-08-22T00:23:20.000Z");
    expect(event.semantic_type).toBe("message");
    expect(event.attachments).toBeUndefined();
  });

  it("never puts a media row's base64 thumbnail in payload_text", () => {
    // WhatsApp's `Msg.body` is the message text for a `chat` row and the
    // base64 JPEG THUMBNAIL for a media row — the user's text lives in
    // `caption`. Measured on a live tab (937 loaded messages): 656/656 `chat`
    // rows carry text in `body`, while `body` held a base64 JPEG on 1/22
    // images, 1/7 videos and 2/2 `interactive` cards. Preferring `body` shipped
    // that base64 into `payload_text` — hence `search_tsv` and the event
    // embedding — and, worse, overwrote the `[image]` placeholder, so every
    // metric keyed on `payload_text` reads a working image as missing.
    const thumbnail = `/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEABsbGxscGx4h${"A".repeat(800)}`;
    const [image] = mergeCollectedMessages(
      [
        message("img", {
          message_type: "image",
          media_kind: "image",
          media_type: "image/jpeg",
          body: thumbnail,
          caption: "",
        }),
      ],
      []
    );
    if (!image) throw new Error("fixture did not normalize");
    expect(toEventEnvelope(image, undefined).payload_text).toBe("[image]");

    // A caption is the real text and must still win — including on the
    // `interactive` cards, whose `media_kind` is null but whose `body` is a
    // thumbnail all the same.
    const [captioned] = mergeCollectedMessages(
      [
        message("card", {
          message_type: "interactive",
          media_kind: null,
          body: thumbnail,
          caption: "Book a table",
        }),
      ],
      []
    );
    if (!captioned) throw new Error("fixture did not normalize");
    expect(toEventEnvelope(captioned, undefined).payload_text).toBe(
      "Book a table"
    );

    // The 656 text rows must be untouched, and a short body that merely starts
    // with the prefix is text a person typed, not a thumbnail.
    const [chat] = mergeCollectedMessages([message("txt")], []);
    if (!chat) throw new Error("fixture did not normalize");
    expect(toEventEnvelope(chat, undefined).payload_text).toBe("hello");
    const [shortBody] = mergeCollectedMessages(
      [message("short", { body: "/9j/ is a JPEG magic prefix" })],
      []
    );
    if (!shortBody) throw new Error("fixture did not normalize");
    expect(toEventEnvelope(shortBody, undefined).payload_text).toBe(
      "/9j/ is a JPEG magic prefix"
    );
  });

  it("rejects a PNG or WebP thumbnail body too, not just JPEG", () => {
    // Only JPEG bodies were observed live, but the guard's contract is "base64
    // image data is not message text". Assert every prefix it claims to match,
    // so none of them is untested code.
    for (const [prefix, kind] of [
      ["iVBORw0KGgo", "image"],
      ["UklGR", "sticker"],
    ] as const) {
      const [row] = mergeCollectedMessages(
        [
          message(`thumb-${prefix}`, {
            message_type: kind,
            media_kind: kind,
            body: `${prefix}${"A".repeat(200)}`,
            caption: "",
          }),
        ],
        []
      );
      if (!row) throw new Error("fixture did not normalize");
      expect(toEventEnvelope(row, undefined).payload_text).toBe(`[${kind}]`);
    }
  });

  it("adds direct-inbound attribution only to inbound 1:1 messages", () => {
    const inbound = mergeCollectedMessages([message("new-direct")], [])[0];
    if (!inbound) throw new Error("fixture did not normalize");
    // This flag gates person auto-creation, so it must not appear on a message
    // the user sent or on a group message.
    expect(
      toEventEnvelope(inbound, undefined).metadata?.is_direct_inbound
    ).toBe(true);
    expect(
      toEventEnvelope({ ...inbound, from_me: true }, undefined).metadata
    ).not.toHaveProperty("is_direct_inbound");
    expect(
      toEventEnvelope({ ...inbound, is_group: true }, undefined).metadata
    ).not.toHaveProperty("is_direct_inbound");
  });

  it("prefers the current snapshot's edits and revokes over stale state", () => {
    const current = mergeCollectedMessages(
      [
        message("same", {
          body: "edited",
          edited: true,
          revoked: true,
          reactions: [{ emoji: "👍", sender_jid: "2@s.whatsapp.net" }],
        }),
      ],
      [{ message: message("same", { body: "stale original" }) }]
    );
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      id: "same",
      edited: true,
      revoked: true,
    });
    expect(current[0]?.reactions).toHaveLength(1);
  });
});

// ── checkpoint ─────────────────────────────────────────────────────────

describe("browser checkpoint", () => {
  it("merges per-chat state without losing prior chats", () => {
    const base = initializeBrowserCheckpoint(null);
    base.backfill.chats.a = { has_more: true };
    const next = mergeBrowserCheckpoint(
      base as unknown as Record<string, unknown>,
      {
        backfill: {
          complete: false,
          cursor_chat_jid: "b",
          inventory: [],
          chats: { b: { has_more: false } },
        },
      },
      mergeCollectedMessages([message("head")], [])
    );
    expect(next.backfill.chats).toEqual({
      a: { has_more: true },
      b: { has_more: false },
    });
  });

  it("preserves recoverable known-chat inventory and round-trips into the next plan", () => {
    const next = mergeBrowserCheckpoint(
      initializeBrowserCheckpoint(null) as unknown as Record<string, unknown>,
      {
        backfill: {
          complete: false,
          cursor_chat_jid: null,
          inventory: ["a@s.whatsapp.net", "b@g.us"],
          chats: {},
        },
      },
      mergeCollectedMessages([message("older-1")], [])
    );
    expect(next.backfill).toMatchObject({
      complete: false,
      inventory: ["a@s.whatsapp.net", "b@g.us"],
    });
    expect(
      buildCollectionPlan({
        checkpoint: next as unknown as Record<string, unknown>,
      }).request.backfill
    ).toEqual(next.backfill);
  });
});

// ── the sync loop over the generic bridge ──────────────────────────────

describe("sync over the generic chrome bridge", () => {
  it("navigates into the persistent agent window and probes before collecting", async () => {
    const image = message("plain");
    const { dispatcher, calls, adapterOps } = makeDispatcher({
      probe: READY,
      collect: {
        ok: true,
        status: {},
        messages: [image],
        backfill: {
          complete: true,
          cursor_chat_jid: null,
          inventory: [],
          chats: {},
        },
      },
    });
    const result = await messagesFeed().sync(syncCtx(null, dispatcher));
    const nav = calls.find((call) => call.action === "navigate");
    expect(nav?.input).toMatchObject({
      url: "https://web.whatsapp.com/",
      persistent: true,
    });
    expect(adapterOps.slice(0, 2)).toEqual(["probe", "collect"]);
    expect(result.events.map((event) => event.origin_id)).toEqual(["plain"]);
  });

  it("re-injects the adapter when the page lost it, then retries the call", async () => {
    const { dispatcher, injections, uninstallAdapter } = makeDispatcher(
      {
        probe: READY,
        collect: {
          ok: true,
          status: {},
          messages: [message("after-reload")],
          backfill: {
            complete: true,
            cursor_chat_jid: null,
            inventory: [],
            chats: {},
          },
        },
      },
      { adapterInstalled: false }
    );
    uninstallAdapter();
    const result = await messagesFeed().sync(syncCtx(null, dispatcher));
    expect(injections).toHaveLength(1);
    // The injected expression really is the serialised adapter program, not a
    // stub: it carries the adapter's own global key and its op table.
    expect(injections[0]).toContain("__owlettoWhatsAppAdapterV1");
    expect(injections[0]).toContain("revoke_message");
    expect(injections[0]!.length).toBeGreaterThan(20_000);
    expect(result.events.map((event) => event.origin_id)).toEqual([
      "after-reload",
    ]);
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
        messagesFeed().sync(syncCtx(null, dispatcher))
      ).rejects.toThrow(
        /^\[lobu:dependency_unavailable:browser_source_hydrating\] WhatsApp Web hydrating: stores_settling/
      );
    } finally {
      Date.now = realNow;
    }
  });

  /**
   * WhatsApp's `require()` BLOCKS rather than throwing while its module graph is
   * still registering, so a readiness probe can hang with the adapter never
   * naming a state. Measured in prod (chrome action runs 1365803-1365817): nine
   * probes answered in 3-7s, then one ran 95.2s and was killed. Bounded by the
   * extension's CDP evaluate timeout the page now reports a plain timeout --
   * which carries none of the adapter's hydration vocabulary, so unclassified it
   * counts as a HARD failure and walks a recoverable feed toward its hard pause.
   * The media path already treats `timed out` as retryable; readiness must too.
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
        messagesFeed().sync(syncCtx(null, dispatcher))
      ).rejects.toThrow(
        /^\[lobu:dependency_unavailable:browser_source_hydrating\]/
      );
    } finally {
      Date.now = realNow;
    }
  });

  /**
   * `collect` re-checks readiness inside the page, so a message arriving between
   * the passing probe and the collect dispatch surfaces `stores_settling` from
   * the COLLECT path rather than the readiness loop. That is an ordinary race,
   * not a broken feed: unclassified it counts against the consecutive-failure
   * budget and walks an otherwise healthy feed toward a hard pause.
   */
  it("treats collect-phase hydration as transient, not a real failure", async () => {
    const { dispatcher } = makeDispatcher({
      probe: () => ({ ok: true, state: "ready", message_count: 1, chat_count: 1 }),
      collect: () => ({
        ok: false,
        error: { state: "hydrating", reason: "stores_settling" },
      }),
    });
    await expect(
      messagesFeed().sync(syncCtx(null, dispatcher))
    ).rejects.toThrow(
      /^\[lobu:dependency_unavailable:browser_source_hydrating\] WhatsApp Web hydrating: stores_settling/
    );
  });

  it("bumps the WhatsApp connector version for readiness semantics", () => {
    expect(connector.definition.version).toBe("1.0.1");
  });

  it("names the remedy when WhatsApp Web is signed out", async () => {
    const { dispatcher } = makeDispatcher({
      probe: {
        ok: false,
        error: { state: "logged_out", reason: "qr_code_visible" },
      },
    });
    await expect(
      messagesFeed().sync(syncCtx(null, dispatcher))
    ).rejects.toThrow(/not signed in.*web\.whatsapp\.com.*Linked Devices/is);
  });

  it("refuses to run without a paired extension", async () => {
    await expect(messagesFeed().sync(syncCtx(null, undefined))).rejects.toThrow(
      /paired Owletto Chrome extension/i
    );
  });
});

// ── media (ported bounds) ──────────────────────────────────────────────

function imageMessages(
  count: number,
  prefix = "image"
): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) =>
    message(`${prefix}-${index}`, {
      body: "",
      message_type: "image",
      media_kind: "image",
      media_type: "image/jpeg",
    })
  );
}

function collectResponse(messages: Record<string, unknown>[]) {
  return {
    ok: true,
    status: {},
    messages,
    backfill: {
      complete: true,
      cursor_chat_jid: null,
      inventory: [],
      chats: {},
    },
  };
}

describe("media", () => {
  it("keeps media attempts bounded and marks overflow metadata-only", async () => {
    const { dispatcher, mediaCalls } = makeDispatcher({
      probe: READY,
      collect: collectResponse(imageMessages(13)),
      download_media: { ok: true, status: "unavailable" },
    });
    const result = await messagesFeed().sync(syncCtx(null, dispatcher));
    expect(mediaCalls()).toHaveLength(12);
    expect(
      result.events.filter(
        (event) => event.metadata?.media_status === "metadata_only"
      )
    ).toHaveLength(1);
  });

  it("enforces a total raw attachment budget and defers excess bytes", async () => {
    const { dispatcher } = makeDispatcher({
      probe: READY,
      collect: collectResponse(imageMessages(3, "large")),
      download_media: {
        ok: true,
        status: "downloaded",
        attachment: {
          kind: "image",
          filename: "image.jpg",
          mime_type: "image/jpeg",
          data: "AA==",
          size_bytes: 2 * 1024 * 1024,
        },
      },
    });
    const result = await messagesFeed().sync(syncCtx(null, dispatcher));
    expect(result.events.filter((event) => event.attachments)).toHaveLength(2);
    expect(
      result.events.filter(
        (event) => event.metadata?.media_status === "metadata_only"
      )
    ).toHaveLength(1);
  });

  /**
   * A chrome dispatch cannot be cancelled, so a per-dispatch local timeout does
   * not stop it — it only stops US waiting. The request stays in flight in the
   * parent worker; the child then finishes and exits, and the device's answer
   * arrives with nobody to receive it. In prod that failed a sync run which had
   * already written its events, and once killed the worker daemon outright,
   * taking every other connector's runs with it. Measured `download_media`
   * evaluates ran 3.9-5.2s against the old 4s cap, so it orphaned a dispatch on
   * nearly every media item.
   *
   * A runtime test cannot pin this: the cap was a real timer, so proving it
   * fires means burning that many seconds of wall clock, and it would only
   * catch a cap shorter than the delay chosen. Guard the shape instead — no
   * timer may race a dispatch, whatever its constant.
   */
  it("still matches the executor timeout message it depends on", () => {
    // `whatsapp_web.ts` decides "retryable" vs "this media is gone" by matching
    // the dispatch backstop's free-text message, which is produced in another
    // package. Nothing links the two, so a reword there would silently
    // downgrade every timed-out media item to `unavailable` — permanently
    // gone, never retried — with all tests still green. Pin the substrings the
    // connector actually greps for; if this fails, fix the matcher, not this.
    const producer = readFileSync(
      new URL(
        "../../../connector-worker/src/executor/isolate.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const consumer = readFileSync(
      new URL("../whatsapp_web.ts", import.meta.url),
      "utf8",
    );
    const matched = [...consumer.matchAll(/text\.includes\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(matched).toContain("IPC may be wedged");
    // Every marker the connector greps for must exist in the producer, except
    // "timed out", which is the generic phrasing several sources emit.
    for (const marker of matched.filter((m) => m !== "timed out")) {
      expect(
        producer.includes(marker),
        `isolate.ts no longer emits "${marker}"; whatsapp_web.ts would downgrade a retryable timeout to unavailable`,
      ).toBe(true);
    }
  });

  it("never races an uncancellable dispatch against a local timer", () => {
    const source = readFileSync(
      new URL("../whatsapp_web.ts", import.meta.url),
      "utf8"
    );
    const races = [...source.matchAll(/Promise\.race/g)];
    expect(
      races,
      "a dispatch abandoned by Promise.race stays in flight and orphans its reply"
    ).toHaveLength(0);
  });

  it("uses a media answer that arrives after many turns", async () => {
    let release: ((value: unknown) => void) | null = null;
    const { dispatcher, mediaCalls } = makeDispatcher({
      probe: READY,
      collect: collectResponse(imageMessages(1, "slow")),
      download_media: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });

    const pending = messagesFeed().sync(syncCtx(null, dispatcher));
    // Let the run reach the media phase and block there.
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    expect(mediaCalls()).toHaveLength(1);
    expect(release).not.toBeNull();

    // Answer far later than any per-dispatch cap would have allowed. The run
    // must still be waiting for THIS answer and must use it.
    (release as unknown as (value: unknown) => void)({
      ok: true,
      status: "downloaded",
      attachment: {
        kind: "image",
        filename: "slow.jpg",
        mime_type: "image/jpeg",
        data: "AA==",
        size_bytes: 12,
      },
    });
    const result = await pending;
    expect(result.events.filter((event) => event.attachments)).toHaveLength(1);
    expect(result.events[0]?.metadata?.media_status).toBe("downloaded");
  });

  it("stops starting dispatches once the media phase budget is spent", async () => {
    const { dispatcher, mediaCalls } = makeDispatcher({
      probe: READY,
      collect: collectResponse(imageMessages(3, "budget")),
      // The first answer burns the whole phase budget. Nothing after it may
      // start a dispatch this run cannot afford to wait for.
      download_media: () => {
        setSystemTime(new Date(Date.now() + 90_000));
        return { ok: true, status: "unavailable" };
      },
    });
    try {
      const result = await messagesFeed().sync(syncCtx(null, dispatcher));
      expect(mediaCalls().length).toBeLessThan(3);
      // The skipped items stay retryable rather than being reported as gone.
      expect(
        result.events.filter(
          (event) => event.metadata?.media_status === "metadata_only"
        ).length
      ).toBeGreaterThan(0);
    } finally {
      setSystemTime();
    }
  });

  it("respects media backoff carried in the checkpoint instead of redownloading", async () => {
    // The extension read this backoff out of IndexedDB; the connector's only
    // durable store is the checkpoint, so the second run is fed the first
    // run's checkpoint — the equivalent continuity.
    const images = imageMessages(1, "retry");
    const first = makeDispatcher({
      probe: READY,
      collect: collectResponse(images),
      download_media: { ok: true, status: "unavailable" },
    });
    const firstRun = await messagesFeed().sync(syncCtx(null, first.dispatcher));
    expect(first.mediaCalls()).toHaveLength(1);

    const second = makeDispatcher({
      probe: READY,
      collect: collectResponse(images),
      download_media: { ok: true, status: "unavailable" },
    });
    await messagesFeed().sync(
      syncCtx(firstRun.checkpoint as BrowserCheckpoint, second.dispatcher)
    );
    expect(second.mediaCalls()).toHaveLength(0);
  });

  it("never collects an already-ingested row, so its media is never fetched", async () => {
    // The cutover floor is the chokepoint: a row at or before it never reaches
    // collection, so nothing downstream needs an overlap special case.
    const migrated = initializeBrowserCheckpoint({
      schema: "owletto.whatsapp.browser.v1",
      cutover_unix_seconds: 1_787_358_184,
    });
    const overlap = message("overlap-media", {
      timestamp: 1_787_358_184,
      occurred_at: new Date(1_787_358_184 * 1000).toISOString(),
      message_type: "image",
      media_kind: "image",
      media_type: "image/jpeg",
    });
    const { dispatcher, mediaCalls } = makeDispatcher({
      probe: READY,
      collect: collectResponse([overlap]),
      download_media: { ok: true, status: "downloaded" },
    });
    const result = await messagesFeed().sync(syncCtx(migrated, dispatcher));
    expect(mediaCalls()).toHaveLength(0);
    expect(result.events).toHaveLength(0);
  });
});

// ── checkpoint clearing ────────────────────────────────────────────────

describe("checkpoint fields clear when their cause is gone", () => {
  // mergeBrowserCheckpoint spreads the PRIOR checkpoint forward, so a field
  // that is only ever conditionally assigned can never leave the checkpoint.
  // A stale `dirty` list would pin backfill.complete to false forever and make
  // every run re-request markers the adapter already reconciled.
  it("drops dirty markers the adapter reconciled", async () => {
    const priorDirty = {
      key: "chat-1:100",
      chat_jid: "15551234567@s.whatsapp.net",
      message_id: "3EB0",
      minimum_timestamp: null,
      reason: "missing_stable_timestamp_or_identity",
    };
    const prior = initializeBrowserCheckpoint(null);
    prior.dirty = [priorDirty];

    const { dispatcher } = makeDispatcher({
      probe: READY,
      collect: {
        ...collectResponse([message("3EB0")]),
        dirty_reconciled: [{ key: priorDirty.key, message_id: "3EB0" }],
      },
    });
    const result = await messagesFeed().sync(syncCtx(prior, dispatcher));
    const next = result.checkpoint as BrowserCheckpoint;
    expect(next.dirty ?? []).toEqual([]);
    expect(next.backfill.complete).toBe(true);
    expect(next.diagnostics?.dirty_reconciliation).toBeUndefined();
  });

  it("drops media retry rows once nothing is pending", async () => {
    const prior = initializeBrowserCheckpoint(null);
    prior.media = {
      "stale-retry": {
        id: "stale-retry",
        revision: "0-00000000",
        status: "unavailable",
        retryable: true,
        attempts: 3,
        next_attempt_at: Date.now() - 1,
        updated_at: Date.now() - 1,
      },
    };
    const { dispatcher } = makeDispatcher({
      probe: READY,
      // A plain text message: nothing media-eligible, so no retry row survives.
      collect: collectResponse([message("plain-text")]),
    });
    const result = await messagesFeed().sync(syncCtx(prior, dispatcher));
    expect((result.checkpoint as BrowserCheckpoint).media ?? {}).toEqual({});
  });
});

// ── the action table ───────────────────────────────────────────────────

describe("actions", () => {
  it("declares the exact action table with the same approval posture", () => {
    const actions = connector.definition.actions ?? {};
    expect(Object.keys(actions).sort()).toEqual([
      "draft_message",
      "edit_message",
      "react_message",
      "revoke_message",
      "search_messages",
      "send_message",
    ]);
    expect(actions.search_messages?.requiresApproval).toBe(false);
    expect(actions.search_messages?.kind).toBe("read");
    // A draft only fills the composer; the human still presses send.
    expect(actions.draft_message?.requiresApproval).toBe(false);
    for (const key of [
      "send_message",
      "edit_message",
      "react_message",
      "revoke_message",
    ]) {
      expect(actions[key]?.requiresApproval).toBe(true);
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
      config: {},
      sessionState: { chrome_dispatcher: dispatcher },
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
      config: {},
      sessionState: { chrome_dispatcher: dispatcher },
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
      config: {},
      sessionState: { chrome_dispatcher: dispatcher },
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
      config: {},
      sessionState: { chrome_dispatcher: dispatcher },
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

  it("declares no interactive auth handshake", () => {
    // The QR is rendered by web.whatsapp.com in the user's own browser, and an
    // auth run carries no chrome dispatcher, so there is nothing to relay.
    expect(connector.definition.authSchema?.methods).toEqual([
      { type: "none" },
    ]);
  });
});

describe("quarantined messages", () => {
  /**
   * The adapter and the connector meet on the DirtyMarker shape. A message with
   * no stable timestamp is quarantined by the adapter and carried in the
   * checkpoint's `dirty` list until a later run reconciles it.
   *
   * Two fields do that work, and both have to arrive: `key` is what
   * `reconciledKeys` matches to DROP a marker, and `message_id` is what the
   * adapter filters `dirty_ranges` on to look one up. A marker missing either
   * is not "slightly wrong" — it is permanently stuck, and because `dirty`
   * being non-empty pins `backfill.complete = false`, the backfill never
   * finishes either.
   */
  it("carries a quarantined message forward with a reconcilable identity", async () => {
    const dispatcher = makeDispatcher({
      probe: READY,
      collect: {
        ok: true,
        messages: [],
        quarantined: [
          {
            key: "111@s.whatsapp.net:QUARANTINED-1",
            message_id: "QUARANTINED-1",
            chat_jid: "111@s.whatsapp.net",
            reason: "missing_stable_timestamp",
          },
        ],
        chats_seen: 1,
        backfill: { complete: true },
      },
    });
    const { checkpoint } = await messagesFeed().sync(
      syncCtx(initializeBrowserCheckpoint({}), dispatcher.dispatcher)
    );

    const dirty = (checkpoint as { dirty?: unknown[] }).dirty ?? [];
    expect(dirty).toHaveLength(1);
    const marker = dirty[0] as Record<string, unknown>;
    expect(marker.message_id).toBe("QUARANTINED-1");
    expect(marker.key).toBe("111@s.whatsapp.net:QUARANTINED-1");
  });

  it("does not accumulate a duplicate when the same message is re-quarantined", async () => {
    const quarantined = [
      {
        key: "111@s.whatsapp.net:QUARANTINED-1",
        message_id: "QUARANTINED-1",
        chat_jid: "111@s.whatsapp.net",
        reason: "missing_stable_timestamp",
      },
    ];
    const run = (checkpoint: BrowserCheckpoint) =>
      messagesFeed().sync(
        syncCtx(
          checkpoint,
          makeDispatcher({
            probe: READY,
            collect: {
              ok: true,
              messages: [],
              quarantined,
              chats_seen: 1,
              backfill: { complete: true },
            },
          }).dispatcher
        )
      );
    const first = await run(initializeBrowserCheckpoint({}));
    const second = await run(first.checkpoint as BrowserCheckpoint);
    expect((second.checkpoint as { dirty?: unknown[] }).dirty).toHaveLength(1);
  });
});
