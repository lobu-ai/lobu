import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { WHATSAPP_ADAPTER_VERSION } from "../whatsapp-web-helpers.js";
import { whatsAppWebAdapterProgram } from "../whatsapp-web-adapter.js";

/**
 * The connector ships this adapter by serialising the function with
 * Function.prototype.toString() and evaluating `(<source>)()` in the page.
 * That works only while every binding the function needs lives INSIDE it —
 * a constant hoisted to module scope would disappear from the serialised
 * source and the page would throw a ReferenceError at runtime, with nothing
 * failing at build or type-check time.
 *
 * These tests make that failure loud and local.
 */
describe("whatsAppWebAdapterProgram serialisation", () => {
  const source = whatsAppWebAdapterProgram.toString();

  it("carries no helper the program never calls", () => {
    // Everything here lives INSIDE one function, so knip and the bundler both
    // see a single used export and cannot flag an unused inner helper. Three
    // consecutive reviews found dead helpers in this file for exactly that
    // reason; this closes the gap. Every serialised byte is shipped to the
    // page on every injection, so an uncalled helper is pure payload.
    const declared = [...source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(
      (match) => match[1],
    );
    expect(declared.length).toBeGreaterThan(20);

    // The outer program function is referenced by the connector, not by itself.
    const inner = [...new Set(declared)].filter(
      (name) => name !== "whatsAppWebAdapterProgram",
    );
    const unreferenced = inner.filter((name) => {
      const uses = source.match(new RegExp(`\\b${name}\\b`, "g")) ?? [];
      const declarations =
        source.match(new RegExp(`function\\s+${name}\\s*\\(`, "g")) ?? [];
      return uses.length === declarations.length;
    });
    expect(unreferenced).toEqual([]);
  });

  it("serialises to a self-contained program that installs the adapter", () => {
    // Evaluate the serialised source the way the connector does, against a
    // stub page. If any binding escaped to module scope this throws
    // ReferenceError instead of installing the global.
    const globals: Record<string, unknown> = {};
    const page = {
      globalThis: globals,
      document: {
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {
          /* inert page-global stub */
        },
      },
      window: {
        require: () => null,
        addEventListener: () => {
          /* inert page-global stub */
        },
      },
      location: { origin: "https://web.whatsapp.com" },
      setTimeout: () => 0,
      clearTimeout: () => {
        /* inert page-global stub */
      },
    };

    const run = new Function(
      ...Object.keys(page),
      `"use strict";(${source})();`
    );
    expect(() => run(...Object.values(page))).not.toThrow();

    const installed = globals.__owlettoWhatsAppAdapterV1 as
      | { version: number; invoke: unknown }
      | undefined;
    expect(installed).toBeDefined();
    expect(typeof installed?.invoke).toBe("function");
  });

  it("references no identifier from its module scope", () => {
    // Belt and braces: the only free identifiers the serialised source may
    // carry are page globals. A module-scope import or constant leaking in
    // would show up here even if the stub above happened to tolerate it.
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(\s*["']/);
  });

  it("still exposes the operations the connector dispatches", () => {
    // Every op here must be reachable from whatsapp_web.ts — `execute()`
    // admits only `search_messages` and WRITE_ACTIONS, readiness uses `probe`,
    // the feed reader uses `read_messages`, and observation uses
    // `observe_messages`/`listen`/`publish_changes`.
    for (const op of [
      "probe",
      "observe_messages",
      "listen",
      "publish_changes",
      "read_messages",
      "search_messages",
      "draft_message",
      "send_message",
      "edit_message",
      "react_message",
      "revoke_message",
    ]) {
      expect(source).toContain(`"${op}"`);
    }
  });

  it("has no history-import or media-download operation", () => {
    // WhatsApp is live-only: nothing collects history or downloads media to
    // store, so the page must not offer either.
    for (const op of ["collect", "download_media"]) {
      expect(source).not.toContain(`"${op}"`);
    }
  });

  it("attaches only through a feed listener and has no page polling loop", () => {
    expect(source).toContain('request.op === "listen"');
    expect(source).toContain('collection.on("add", state.onAdd)');
    expect(source).toContain('collection.off("add", state.onAdd)');
    expect(source).not.toContain("setInterval");
  });

  it("keeps every binding inside the function — no module-scope declarations", () => {
    // The runtime test above only exercises the INSTALL path, so a helper
    // hoisted out of the function and used only by an op would survive it and
    // fail later in the page. This checks the invariant at its source instead:
    // the module may contain NOTHING at top level but the exported function.
    // Verified by mutation — both a hoisted `const` and a hoisted `function`
    // fail this test.
    //
    // (A hoisted simple `const` is in fact constant-folded into the body by the
    // bundler and would still work, but it is not worth distinguishing: the rule
    // "nothing at module scope" is easy to honour and leaves no judgement call.)
    const file = readFileSync(
      new URL("../whatsapp-web-adapter.js", import.meta.url),
      "utf8"
    );
    const withoutBlockComments = file.replace(/\/\*[\s\S]*?\*\//g, "");
    const topLevel = withoutBlockComments
      .split("\n")
      .filter((line) => line.length > 0 && !/^[\s\t]/.test(line))
      .filter((line) => !line.startsWith("//"))
      .filter((line) => line !== "}");

    const allowed = /^export function whatsAppWebAdapterProgram\(\) \{$/;
    const offenders = topLevel.filter((line) => !allowed.test(line));
    expect(offenders).toEqual([]);
  });
});

/**
 * The send path, against the module shapes the LIVE WhatsApp Web build
 * actually exposes (captured 2026-09-02 on a paired Chrome).
 *
 * `sendTextMsgToChat` resolves to `{ messageSendResult, t, count }`. It has
 * no `id` in any form, so deriving the message id from that acknowledgment
 * reported every successful send as a failure — the message went out, the op
 * returned an error, and a caller that retries on error sent it twice.
 */
describe("whatsAppWebAdapterProgram send_message", () => {
  const wid = (serialized: string) => ({
    _serialized: serialized,
    toString: () => serialized,
  });
  /**
   * A WhatsApp message id, in the shape the page really produces: the raw id
   * lives on `.id`, and `_serialized` is the fully qualified form. `rawId`
   * reads the raw half, so a fixture carrying only `_serialized` would fail
   * for a reason the production object never hits.
   */
  const msgId = (raw: string) => ({
    fromMe: true,
    remote: wid("447000000000@c.us"),
    id: raw,
    _serialized: `true_447000000000@c.us_${raw}`,
  });

  function installAdapter(sendModule: Record<string, unknown>) {
    const chat = { id: wid("447000000000@c.us") };
    const modules: Record<string, unknown> = {
      WAWebCollections: { Chat: { _models: [chat] }, Msg: { _models: [] } },
      WAWebUserPrefsMeUser: {
        getMaybeMePnUser: () => wid("447000000000@c.us"),
      },
      WAWebSendTextMsgChatAction: sendModule,
    };
    const globals: Record<string, any> = {};
    const page = {
      globalThis: globals,
      document: { querySelector: () => null, querySelectorAll: () => [] },
      window: { require: (name: string) => modules[name] ?? null },
      location: { origin: "https://web.whatsapp.com" },
      setTimeout: (fn: () => void) => {
        fn();
        return 0;
      },
      clearTimeout: () => {},
    };
    const run = new Function(
      ...Object.keys(page),
      `"use strict";(${whatsAppWebAdapterProgram.toString()})();`,
    );
    run(...Object.values(page));
    return globals.__owlettoWhatsAppAdapterV1;
  }

  it("returns the id WhatsApp assigned, not one read off the ack", async () => {
    const sent: string[] = [];
    const adapter = installAdapter({
      createTextMsgData: (_chat: unknown, text: string) => ({
        id: msgId("3EB0PLANNEDID"),
        body: text,
      }),
      addAndSendTextMsg: (_chat: unknown, data: { id: { id: string } }) => {
        sent.push(data.id.id);
        return { messageSendResult: "OK", t: 1, count: 1 };
      },
      // Present, and shaped exactly as the live build shapes it.
      sendTextMsgToChat: () => ({ messageSendResult: "OK", t: 1, count: 1 }),
    });

    const result = await adapter.invoke({
      op: "send_message",
      adapter_version: WHATSAPP_ADAPTER_VERSION,
      input: { self_chat: true, text: "hello" },
    });

    expect(result.ok).toBe(true);
    expect(result.message_id).toBe("3EB0PLANNEDID");
    // The message must actually have been dispatched under that same id.
    expect(sent).toEqual(["3EB0PLANNEDID"]);
  });

  it("still sends on a build that only offers the one-shot call", async () => {
    const adapter = installAdapter({
      sendTextMsgToChat: (_chat: unknown, text: string) => ({
        id: msgId("3EB0LEGACYID"),
        body: text,
      }),
    });
    const result = await adapter.invoke({
      op: "send_message",
      adapter_version: WHATSAPP_ADAPTER_VERSION,
      input: { self_chat: true, text: "hello" },
    });
    expect(result.ok).toBe(true);
    expect(result.message_id).toBe("3EB0LEGACYID");
  });
});

describe("whatsAppWebAdapterProgram connection readiness", () => {
  function install(socketModules: Record<string, unknown>) {
    let now = 1_000;
    const modules: Record<string, unknown> = {
      WAWebCollections: { Chat: { _models: [{}] }, Msg: { _models: [] } },
      WAWebUserPrefsMeUser: {
        getMaybeMePnUser: () => ({ _serialized: "self@c.us" }),
      },
      ...socketModules,
    };
    const globals: Record<string, any> = {};
    new Function(
      "globalThis",
      "window",
      "document",
      "Date",
      `(${whatsAppWebAdapterProgram.toString()})();`,
    )(
      globals,
      { require: (name: string) => modules[name] ?? null },
      { querySelector: () => null },
      { now: () => now },
    );
    const invoke = (op = "probe") =>
      globals.__owlettoWhatsAppAdapterV1.invoke({
        op,
        adapter_version: WHATSAPP_ADAPTER_VERSION,
      });
    return {
      invoke,
      settle: async () => {
        await invoke();
        now += 501;
        return invoke();
      },
    };
  }

  it("rejects a disconnected live stream even when the account is connected", async () => {
    const page = install({
      WAWebSocketModel: {
        Socket: {
          state: "CONNECTED",
          stream: "DISCONNECTED",
          hasSynced: true,
        },
      },
    });
    expect(await page.settle()).toMatchObject({
      ok: false,
      error: { state: "not_ready", reason: "stream_disconnected" },
    });
  });

  it("accepts a connected current socket after the stores settle", async () => {
    const page = install({
      WAWebSocketModel: {
        Socket: {
          state: "CONNECTED",
          stream: "CONNECTED",
          hasSynced: true,
        },
      },
    });
    expect(await page.settle()).toMatchObject({ ok: true });
  });

  it("does not claim readiness when connection modules disappear", async () => {
    expect(await install({}).settle()).toMatchObject({
      ok: false,
      error: {
        state: "capability_unavailable",
        reason: "connection_state_unavailable",
      },
    });
  });

  it("retains readable legacy connection state", async () => {
    expect(
      await install({
        WAWebSocketState: { getSocketState: () => "CONNECTED" },
      }).settle(),
    ).toMatchObject({ ok: true });
  });

  it("rejects unsynced or unpaired current sockets", async () => {
    expect(
      await install({
        WAWebSocketModel: {
          Socket: {
            state: "CONNECTED",
            stream: "CONNECTED",
            hasSynced: false,
          },
        },
      }).settle(),
    ).toMatchObject({
      ok: false,
      error: { reason: "initial_sync_incomplete" },
    });
    expect(
      await install({
        WAWebSocketModel: {
          Socket: {
            state: "UNPAIRED",
            stream: "DISCONNECTED",
          },
        },
      }).settle(),
    ).toMatchObject({
      ok: false,
      error: { state: "not_ready", reason: "connection_unpaired" },
    });
  });
});

/**
 * Edit / revoke / react, against the LIVE build's shapes (2026-09-02).
 *
 * A theme runs through all three: the
 * adapter asked the page for something the page no longer has — a boolean
 * that became a function, a field that moved to another collection, an
 * argument in the wrong position — and then reported the resulting miss as
 * WhatsApp refusing. Every one of them turned a working operation into a
 * reported failure.
 */
describe("whatsAppWebAdapterProgram message actions", () => {
  function install(opts: {
    capability?: Record<string, unknown>;
    row?: Record<string, unknown>;
    onEdit?: (...args: unknown[]) => unknown;
    onReact?: (...args: unknown[]) => unknown;
  }) {
    const message: any = {
      attributes: {
        id: { fromMe: true, id: "3EB0ACT", _serialized: "true_x@c.us_3EB0ACT" },
        body: "before",
        type: "chat",
        ...(opts.row ?? {}),
      },
    };
    const modules: Record<string, unknown> = {
      WAWebCollections: { Msg: { _models: [message] }, Chat: { _models: [] } },
      WAWebMsgActionCapability: opts.capability ?? {},
      WAWebSendMessageEditAction: {
        sendMessageEdit: (...args: unknown[]) => {
          message.attributes.body = args[1];
          message.attributes.isEdited = true;
          return opts.onEdit?.(...args);
        },
      },
      WAWebSendReactionMsgAction: {
        sendReactionToMsg: (...args: unknown[]) => {
          message.attributes.hasReaction = String(args[1] ?? "") !== "";
          return opts.onReact?.(...args);
        },
      },
      // Mirrors the live build: `WAWebChatSendMessages` resolves first and is
      // the one carrying `sendRevokeMsgs`.
      WAWebChatSendMessages: {
        sendRevokeMsgs: () => {
          message.attributes.isRevoked = true;
        },
      },
    };
    const globals: Record<string, any> = {};
    const page = {
      globalThis: globals,
      document: { querySelector: () => null, querySelectorAll: () => [] },
      window: { require: (n: string) => modules[n] ?? null },
      location: { origin: "https://web.whatsapp.com" },
      setTimeout: (fn: () => void) => {
        fn();
        return 0;
      },
      clearTimeout: () => {},
    };
    const run = new Function(
      ...Object.keys(page),
      `"use strict";(${whatsAppWebAdapterProgram.toString()})();`,
    );
    run(...Object.values(page));
    return { adapter: globals.__owlettoWhatsAppAdapterV1, message };
  }

  const V = WHATSAPP_ADAPTER_VERSION;

  it("edits when the capability is a PREDICATE, not a boolean field", async () => {
    // The model carries no `canEdit`/`isEditable` on this build — the
    // predicates moved into WAWebMsgActionCapability as functions. Reading
    // the absent booleans refused every message.
    const { adapter } = install({
      capability: { canEditText: () => true },
    });
    const result = await adapter.invoke({
      op: "edit_message",
      adapter_version: V,
      input: { message_id: "3EB0ACT", text: "after" },
    });
    expect(result.ok).toBe(true);
    expect(result.edited).toBe(true);
  });

  it("passes the MESSAGE first to sendMessageEdit, not the chat", async () => {
    // `sendMessageEdit(msg, text, options)`. Handing it the chat made its own
    // internal canEditText(chat) fail and reject with "Cannot edit message",
    // which reads like the message was ineligible.
    const seen: unknown[] = [];
    const { adapter, message } = install({
      capability: { canEditText: () => true },
      onEdit: (...args: unknown[]) => {
        seen.push(...args);
      },
    });
    await adapter.invoke({
      op: "edit_message",
      adapter_version: V,
      input: { message_id: "3EB0ACT", text: "after" },
    });
    expect(seen[0]).toBe(message);
    expect(seen[1]).toBe("after");
  });

  it("still honours a legacy boolean build", async () => {
    const { adapter } = install({ row: { canEdit: true } });
    const result = await adapter.invoke({
      op: "edit_message",
      adapter_version: V,
      input: { message_id: "3EB0ACT", text: "after" },
    });
    expect(result.ok).toBe(true);
  });

  it("refuses an edit no predicate affirms", async () => {
    const { adapter } = install({ capability: { canEditText: () => false } });
    const result = await adapter.invoke({
      op: "edit_message",
      adapter_version: V,
      input: { message_id: "3EB0ACT", text: "after" },
    });
    expect(result.ok).toBe(false);
    expect(result.error.reason).toContain("editable");
  });

  it("never treats delete-for-me as permission to revoke", async () => {
    // `canDeleteMsg` is true for messages that cannot be revoked. Accepting
    // it would let revoke claim success having only removed the message
    // locally.
    const { adapter } = install({
      capability: { canDeleteMsg: () => true, canSenderRevokeMsg: () => false },
    });
    const result = await adapter.invoke({
      op: "revoke_message",
      adapter_version: V,
      input: { message_id: "3EB0ACT" },
    });
    expect(result.ok).toBe(false);
    expect(result.error.reason).toContain("revokable");
  });

  it("confirms a reaction through hasReaction when no list exists", async () => {
    // `row.reactions` is undefined on this build and the ReactionsCollection
    // stays empty, so waiting on a reaction LIST never became true and a
    // delivered reaction reported failure.
    const { adapter } = install({ capability: {} });
    const result = await adapter.invoke({
      op: "react_message",
      adapter_version: V,
      input: { message_id: "3EB0ACT", emoji: "🎉" },
    });
    expect(result.ok).toBe(true);
    expect(result.confirmed).toBe(true);
  });

  it("reports an unconfirmable removal honestly rather than failing it", async () => {
    // `hasReaction` does not clear on removal, so there is nothing to observe.
    // Succeed — but say the end state was not confirmed.
    const { adapter } = install({ capability: {}, row: { hasReaction: true } });
    const result = await adapter.invoke({
      op: "react_message",
      adapter_version: V,
      input: { message_id: "3EB0ACT", remove: true },
    });
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);
    expect(result.confirmed).toBe(false);
  });
});

describe("whatsAppWebAdapterProgram version", () => {
  // The connector reuses a resident adapter whenever its version matches, so a
  // fix shipped without bumping this number leaves every open
  // WhatsApp tab running the old program. The two constants live in different
  // files (one is page source, one is connector source); nothing but this test
  // keeps them in step.
  it("declares the same version the connector negotiates", () => {
    // Read the file rather than `toString()`: the bundler inlines this const,
    // so the serialised program no longer contains the identifier.
    const source = readFileSync(
      new URL("../whatsapp-web-adapter.js", import.meta.url),
      "utf8"
    );
    const declared = source.match(/ADAPTER_VERSION = (\d+);/)?.[1];
    expect(declared).toBeDefined();
    expect(Number(declared)).toBe(WHATSAPP_ADAPTER_VERSION);
  });
});

describe("WhatsApp source observation", () => {
  function install(toPn?: (value: unknown) => unknown) {
    const handlers = new Map<string, Set<(model: unknown) => void>>();
    const replies = new Set<(event: unknown) => void>();
    const posts: any[] = [];
    const collection = {
      _models: [],
      on: (kind: string, fn: (model: unknown) => void) => {
        if (!handlers.has(kind)) handlers.set(kind, new Set());
        handlers.get(kind)!.add(fn);
      },
      off: (kind: string, fn: (model: unknown) => void) => handlers.get(kind)?.delete(fn),
    };
    const globals: Record<string, any> = {};
    const window = {
      require: (name: string) => name === "WAWebCollections"
        ? { Msg: collection, Chat: { _models: [] }, Contact: { _models: [] } }
        : name === "WAWebLidMigrationUtils" ? { toPn } : null,
      addEventListener: (_kind: string, fn: (event: unknown) => void) => replies.add(fn),
      removeEventListener: (_kind: string, fn: (event: unknown) => void) => replies.delete(fn),
      postMessage: (data: unknown) => posts.push(data),
    };
    new Function("globalThis", "window", "location", `(${whatsAppWebAdapterProgram.toString()})();`)(globals, window, { origin: "https://web.whatsapp.com" });
    const adapter = globals.__owlettoWhatsAppAdapterV1;
    return {
      posts, handlers,
      publish: (batch: unknown) => adapter.invoke({ op: "publish_changes", adapter_version: WHATSAPP_ADAPTER_VERSION,
        bridge_id: "synthetic-feed", token: "synthetic-token", batch }),
      listen: (token = "synthetic-token", extra = {}) => adapter.invoke({ op: "listen", adapter_version: WHATSAPP_ADAPTER_VERSION, bridge_id: "synthetic-feed", token, recent_since: 1000, ...extra }),
      emit: (kind: string, body: string, t = 1100, remote = "15550000000@c.us") => {
        for (const fn of handlers.get(kind) ?? []) fn({ attributes: { id: { id: "synthetic-message", remote }, from: "15550000000@c.us", body, type: "chat", t } });
      },
      emitModel: (kind: string, model: unknown) => {
        for (const fn of handlers.get(kind) ?? []) fn(model);
      },
      reply: (data: unknown) => { for (const fn of replies) fn({ source: window, origin: "https://web.whatsapp.com", data }); },
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("waits for durable browser acceptance before finishing a replay page", async () => {
    const source = install();
    await source.listen("synthetic-token");
    const batch = { id: "replay-1", events: [], checkpoint: { previous: null, next: { after: 1 } } };
    let completed = false;
    const published = source.publish(batch).then((result: unknown) => { completed = true; return result; });
    await settle();
    expect(completed).toBe(false);
    expect(source.posts[0].record).toEqual(batch);
    source.reply({ type: "lobu-feed-record:ack", token: "wrong-token", sequence: source.posts[0].sequence, ok: true });
    await settle();
    expect(completed).toBe(false);
    source.reply({ type: "lobu-feed-record:ack", token: "synthetic-token", sequence: source.posts[0].sequence, ok: true });
    expect(await published).toEqual({ ok: true });
    await source.listen();
    expect(source.posts).toHaveLength(1);
  });

  it("surfaces a browser rejection so replay retries from the server cursor", async () => {
    const source = install();
    await source.listen("synthetic-token");
    const published = source.publish({ id: "rejected-page", events: [] });
    await settle();
    source.reply({ type: "lobu-feed-record:ack", token: "synthetic-token", sequence: source.posts[0].sequence, ok: false });
    expect(await published).toMatchObject({ ok: false });
  });

  it.each([
    { chat_filter: "individual", minimum_timestamp: 1000 },
    { chat_filter: "group", minimum_timestamp: 1200 },
  ])("discards unaccepted references when the listener scope changes: %j", async (scope) => {
    const source = install();
    await source.listen("old-token", { chat_filter: "group", minimum_timestamp: 1000 });
    source.emit("add", "private group message", 1100, "synthetic-group@g.us");
    await settle();
    expect(source.posts).toHaveLength(1);

    await source.listen("new-token", { ...scope });
    expect(source.posts).toHaveLength(1);
  });

  it("retries unaccepted references when reconnecting within the same scope", async () => {
    const source = install();
    const scope = { chat_filter: "group", minimum_timestamp: 1000 };
    await source.listen("old-token", scope);
    source.emit("add", "private group message", 1100, "synthetic-group@g.us");
    await settle();
    await source.listen("new-token", scope);
    expect(source.posts).toHaveLength(2);
    expect(source.posts[1]).toEqual({ ...source.posts[0], token: "new-token" });
  });

  it("observes new-message references without reading or exporting the body", async () => {
    const source = install();
    await source.listen("reference-token");
    const attributes = { id: { id: "synthetic-message", remote: "15550000000@c.us" }, type: "chat", t: 1100,
      get body(): string { throw new Error("The observer must not read content"); } };
    source.emitModel("add", { attributes });
    await settle();
    expect(source.posts.map(post => post.record)).toEqual([{ id: "synthetic-message", events: [{ id: "synthetic-message", event_type: "message.created", resource_ref: "synthetic-message", resource_type: "message", occurred_at: new Date(1100 * 1000).toISOString() }] }]);
    source.emitModel("change", { attributes });
    await settle();
    expect(source.posts).toHaveLength(1);
  });

  it("observes placeholder hydration while excluding changes to pre-subscription history", async () => {
    const source = install();
    await source.listen("reference-token", { minimum_timestamp: 1000 });
    source.emit("add", "placeholder", 0);
    source.emit("change", "old edit", 900);
    await settle();
    expect(source.posts).toHaveLength(0);
    source.emit("change", "hydrated private body", 1100);
    await settle();
    expect(source.posts.map(post => post.record)).toEqual([{ id: "synthetic-message", events: [{ id: "synthetic-message", event_type: "message.created", resource_ref: "synthetic-message", resource_type: "message", occurred_at: new Date(1100 * 1000).toISOString() }] }]);
  });

  it("ignores historical hydration while retaining changes to old messages", async () => {
    const source = install();
    await source.listen();
    source.emit("add", "historical", 900);
    await settle();
    expect(source.posts).toHaveLength(0);
    source.emit("change", "edited history", 900);
    await settle();
    expect(source.posts[0].record.id).toBe("synthetic-message");
    source.emit("change", "edited again", 900);
    await settle();
    expect(source.posts).toHaveLength(1);
  });

  it("reattaches once, retries unaccepted records, and stops on revocation", async () => {
    const source = install();
    await source.listen();
    source.emit("add", "new message");
    await settle();
    await source.listen("replacement-token");
    expect(source.handlers.get("add")?.size).toBe(1);
    expect(source.posts).toHaveLength(2);
    expect(source.posts[1].token).toBe("replacement-token");
    source.reply({ type: "lobu-feed-record:ack", token: "replacement-token", sequence: source.posts[1].sequence, ok: true });
    await source.listen("third-token");
    expect(source.posts).toHaveLength(2);
    source.reply({ type: "lobu-feed-record:stop", token: "third-token" });
    source.emit("change", "after stop");
    await settle();
    expect(source.posts).toHaveLength(2);
  });

  it("emits a source-error record when reading a reference or its bounded buffer fails", async () => {
    const reference = install();
    await reference.listen();
    reference.emitModel("change", {
      get attributes() { throw new Error("synthetic reference failure"); },
    });
    await settle();
    expect(reference.posts[0]?.record).toEqual({
      id: "whatsapp-web:source-observation-error",
      source_error: "WhatsApp source observation failed; recovery is required",
    });
    expect(await reference.listen("replacement-token")).toEqual({ ok: true, listening: true });
    expect(reference.posts[1]?.token).toBe("replacement-token");
    expect(reference.posts[1]?.record).toEqual(reference.posts[0]?.record);
    expect(reference.handlers.get("add")?.size).toBe(1);
    expect(reference.handlers.get("change")?.size).toBe(1);
    reference.emit("add", "healthy after rebind");
    await settle();
    expect(reference.posts.at(-1)?.record.id).toBe("synthetic-message");

    // Unacknowledged references are bounded by count; one past the limit
    // fails the listener rather than growing the page buffer without end.
    const overflow = install();
    await overflow.listen();
    for (let index = 0; index <= 10_000; index++) {
      overflow.emitModel("add", { attributes: {
        id: { id: `synthetic-${index}`, remote: "15550000000@c.us" }, type: "chat", t: 1100,
      } });
    }
    await settle();
    expect(overflow.posts.at(-1)?.record).toEqual({
      id: "whatsapp-web:source-observation-error",
      source_error: "WhatsApp page observation buffer overflowed; recovery is required",
    });
  });

});
