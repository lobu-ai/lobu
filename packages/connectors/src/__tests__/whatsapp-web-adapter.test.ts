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
    // admits only `search_messages` and WRITE_ACTIONS, and `sync` uses
    // `probe`/`collect`/`download_media`. An op the connector cannot reach is
    // dead surface, not coverage; `read_messages` was exactly that.
    for (const op of [
      "probe",
      "collect",
      "search_messages",
      "draft_message",
      "send_message",
      "edit_message",
      "react_message",
      "revoke_message",
      "download_media",
    ]) {
      expect(source).toContain(`"${op}"`);
    }
  });

  it("quarantines a message in the DirtyMarker shape the connector reconciles on", () => {
    // Producer side of the contract the connector suite's fixture assumes.
    // A quarantine marker needs BOTH fields: `key` is what the connector
    // matches to DROP a reconciled marker, `message_id` is what a later
    // `dirty_ranges` request looks the message up by. Emitting `{id, ...}`
    // instead — as this did — leaves `key` undefined, so the marker can never
    // be reconciled, and because a non-empty `dirty` list pins
    // `backfill.complete = false`, the backfill never finishes either.
    const quarantine = source.slice(
      source.indexOf("quarantined.push({"),
      source.indexOf("});", source.indexOf("quarantined.push({"))
    );
    expect(quarantine).toContain("key:");
    expect(quarantine).toContain("message_id:");
    expect(quarantine).not.toMatch(/^\s*id:/m);
  });

  it("never reports a finished backfill from an empty chat list", () => {
    // `chatRows` is empty when the tab answered `probe` but its Chat collection
    // has not populated. A bare `.every()` is vacuously true on an empty array,
    // which would persist backfill.complete for a backfill that never ran.
    const source = whatsAppWebAdapterProgram.toString();
    const every = source.indexOf("chatRows.every(");
    expect(every).toBeGreaterThan(-1);
    // The emptiness guard must sit in the same expression as the `.every()`.
    const clause = source.slice(every - 200, every);
    expect(clause).toContain("chatRows.length > 0");
  });

  it("carries no live relay — the connector pulls via `collect`", () => {
    // The MAIN-world adapter used to postMessage every add/change to the
    // extension's content script. On the connector path nothing listens, so
    // leaving it in bound handlers over WAWebCollections.Msg and normalized
    // every message in the user's live tab for no consumer, plus a 500ms
    // readiness retry timer that never stopped.
    expect(source).not.toContain("postMessage");
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

/**
 * Media download, against the module shapes the LIVE build exposes
 * (captured 2026-09-02 on a paired Chrome).
 *
 * Three things were wrong at once, and every one of them turned a perfectly
 * good download into `unavailable`, which the connector treats as retryable —
 * so it retried forever and never succeeded. Prod bore this out: 10,969
 * media messages on the connection against 20 stored attachments.
 */
describe("whatsAppWebAdapterProgram download_media", () => {
  const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);

  function installWithMedia(
    overrides: {
      nest?: boolean;
      result?: unknown;
      row?: Record<string, unknown>;
    } = {},
  ) {
    const seen: { options?: Record<string, any> } = {};
    const row = {
      id: { fromMe: false, id: "3EB0MEDIA", _serialized: "false_x@c.us_3EB0MEDIA" },
      type: "ptt",
      mimetype: "audio/ogg; codecs=opus",
      size: OGG.byteLength,
      directPath: "/v/t62.7117-24/x",
      mediaKey: "k",
      mediaKeyTimestamp: 1,
      filehash: "f",
      encFilehash: "e",
    };
    const message = { attributes: { ...row, ...(overrides.row ?? {}) } };
    const downloadManager = {
      downloadAndMaybeDecrypt: (options: Record<string, any>) => {
        seen.options = options;
        // The live build calls BOTH of these before fetching a byte.
        options.downloadQpl.addAnnotations({});
        options.downloadQpl.addPoint("x");
        return overrides.result === undefined
          ? OGG.buffer.slice(0)
          : overrides.result;
      },
    };
    const modules: Record<string, unknown> = {
      WAWebCollections: { Msg: { _models: [message] }, Chat: { _models: [] } },
      // The real module exports the manager one level down.
      WAWebDownloadManager:
        overrides.nest === false ? downloadManager : { downloadManager },
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
    return { adapter: globals.__owlettoWhatsAppAdapterV1, seen };
  }

  const download = (adapter: any) =>
    adapter.invoke({
      op: "download_media",
      adapter_version: WHATSAPP_ADAPTER_VERSION,
      message_id: "3EB0MEDIA",
      max_bytes: 10_000_000,
    });

  it("bounds a slow download page-side and reports it retryable", async () => {
    // The caller cannot bound a dispatch — it cannot cancel one, so a local
    // timer only stops it waiting while the request stays in flight, and the
    // answer then arrives with no child left to receive it. The budget travels
    // WITH the request instead, and the page turns "too slow" into an ordinary
    // retryable answer, so the dispatch always resolves.
    const { adapter } = installWithMedia({
      result: new Promise(() => {
        /* a download that never settles */
      }),
    });
    const result = await adapter.invoke({
      op: "download_media",
      adapter_version: WHATSAPP_ADAPTER_VERSION,
      message_id: "3EB0MEDIA",
      max_bytes: 10_000_000,
      timeout_ms: 20_000,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("timeout_retryable");
    expect(result.retryable).toBe(true);
  });

  it("turns the ArrayBuffer the manager returns into a downloaded attachment", async () => {
    // `downloadAndMaybeDecrypt` resolves RAW BYTES, not a Blob. Only the Blob
    // branches existed, so a real download fell through to `unavailable`.
    const { adapter } = installWithMedia();
    const result = await download(adapter);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("downloaded");
    expect(result.attachment.kind).toBe("audio");
    expect(result.attachment.mime_type).toBe("audio/ogg; codecs=opus");
    expect(result.attachment.size_bytes).toBe(OGG.byteLength);
    expect(Buffer.from(result.attachment.data, "base64")).toEqual(
      Buffer.from(OGG),
    );
  });

  it("reaches the manager nested under .downloadManager", async () => {
    // The module root only exports { enforceKaleidoscopeScore,
    // downloadManager }, so probing the root found nothing and the whole
    // fallback was unreachable.
    const { adapter, seen } = installWithMedia();
    await download(adapter);
    expect(seen.options).toBeDefined();
    expect(seen.options?.directPath).toBe("/v/t62.7117-24/x");
  });

  it("passes a downloadQpl the build can call freely", async () => {
    // Omitting it threw "Cannot read properties of undefined (reading
    // 'addAnnotations')" before any fetch. A permissive stub also survives a
    // build that starts calling a method we have never seen.
    const { adapter, seen } = installWithMedia();
    await download(adapter);
    const qpl = seen.options?.downloadQpl;
    expect(qpl).toBeDefined();
    expect(() => qpl.someMethodAddedByAFutureBuild(1, 2, 3)).not.toThrow();
  });

  it("still accepts a Blob from builds that return one", async () => {
    const { adapter } = installWithMedia({
      result: new Blob([OGG], { type: "audio/ogg" }),
    });
    const result = await download(adapter);
    expect(result.status).toBe("downloaded");
    expect(result.attachment.size_bytes).toBe(OGG.byteLength);
  });

  it("refuses an oversized item without fetching it", async () => {
    const { adapter, seen } = installWithMedia({ row: { size: 5_000_000 } });
    const result = await adapter.invoke({
      op: "download_media",
      adapter_version: WHATSAPP_ADAPTER_VERSION,
      message_id: "3EB0MEDIA",
      max_bytes: 2_097_152,
    });
    expect(result.status).toBe("too_large");
    expect(result.size_bytes).toBe(5_000_000);
    // The size gate must short-circuit BEFORE the download.
    expect(seen.options).toBeUndefined();
  });
});

/**
 * Edit / revoke / react, against the LIVE build's shapes (2026-09-02).
 *
 * A theme runs through all three, and through send and download above: the
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

/**
 * `collect` normalises every message in the store, and `normalizeMessage` used
 * to rescan a whole collection per message: the chat name over every chat, the
 * sender name over every contact, and a reaction's target over every message.
 * That is O(messages x collection) of SYNCHRONOUS work on the page's main
 * thread.
 *
 * Measured on the live prod tab (947 chats, 5323 contacts, 1872 messages): the
 * contact scan alone projected to ~6.8s, the message scan to ~2.1s, and a real
 * `collect` blew past a 70s in-page timer -- which could not even fire, because
 * the main thread never yielded. The extension's 90s per-dispatch run fence
 * then killed the run, so the feed ingested nothing, and every run was slower
 * than the last as backfill grew the store.
 *
 * This asserts the shape of the cost, not a wall-clock number: with a fixed
 * message count, growing the CONTACT collection tenfold must not multiply the
 * comparisons the adapter performs. A linear rescan fails this; an index built
 * once per collection passes it.
 */
describe("whatsAppWebAdapterProgram collect scaling", () => {
  function installWithStore(contactCount: number) {
    // Count property reads on each contact id: the linear scan touches every
    // contact once per message, the index touches each exactly once.
    let idReads = 0;
    const contact = (index: number) => ({
      attributes: {
        get id() {
          idReads += 1;
          return { _serialized: `contact-${index}@c.us` };
        },
        name: `Contact ${index}`,
      },
    });
    const contacts = Array.from({ length: contactCount }, (_, i) => contact(i));
    const chatModel = {
      attributes: {
        id: { _serialized: `contact-${contactCount - 1}@c.us` },
        name: "Chat 0",
        msgs: { _models: [], msgLoadState: { noEarlierMsgs: true } },
      },
    };
    // Point every message at the LAST contact. A linear scan then walks the
    // whole collection per message -- the real prod shape, where senders are
    // spread across 5323 contacts rather than sitting at index 0.
    const senderIndex = contactCount - 1;
    const messages = Array.from({ length: 25 }, (_, i) => ({
      attributes: {
        id: {
          fromMe: false,
          id: `M${i}`,
          _serialized: `false_contact-${senderIndex}@c.us_M${i}`,
        },
        from: { _serialized: `contact-${senderIndex}@c.us` },
        to: { _serialized: "me@c.us" },
        type: "chat",
        body: `hello ${i}`,
        t: 1_700_000_000 + i,
      },
    }));
    const modules: Record<string, unknown> = {
      WAWebCollections: {
        Msg: { _models: messages },
        Chat: { _models: [chatModel] },
        Contact: { _models: contacts },
      },
      // `collect` is capability-gated on the history loader, and readiness
      // needs an authenticated self identity.
      WAWebChatLoadMessages: { loadEarlierMsgs: async () => undefined },
      WAWebUserPrefsMeUser: {
        getMaybeMePnUser: () => ({ _serialized: "me@c.us" }),
      },
    };
    const globals: Record<string, any> = {};
    const page = {
      globalThis: globals,
      document: { querySelector: () => null, querySelectorAll: () => [] },
      window: { require: (n: string) => modules[n] ?? null },
      location: { origin: "https://web.whatsapp.com" },
      setTimeout: (fn: () => void, ms?: number) =>
        globalThis.setTimeout(fn, ms),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
    };
    const run = new Function(
      ...Object.keys(page),
      `"use strict";(${whatsAppWebAdapterProgram.toString()})();`,
    );
    run(...Object.values(page));
    return { adapter: globals.__owlettoWhatsAppAdapterV1, reads: () => idReads };
  }

  it("does not rescan a collection once per message", async () => {
    const ready = async (adapter: any) => {
      // Readiness requires the store signature to hold for 500ms across two
      // probes, exactly as it does in the page.
      await adapter.invoke({ op: "probe", adapter_version: WHATSAPP_ADAPTER_VERSION });
      await new Promise((resolve) => globalThis.setTimeout(resolve, 550));
      await adapter.invoke({ op: "probe", adapter_version: WHATSAPP_ADAPTER_VERSION });
    };
    const small = installWithStore(50);
    await ready(small.adapter);
    await small.adapter.invoke({
      op: "collect",
      adapter_version: WHATSAPP_ADAPTER_VERSION,
      max_messages: 100,
      max_chats: 1,
      max_loads_per_chat: 1,
      chat_filter: "all",
      backfill_disabled: true,
      budget_ms: 1_000,
    });
    const large = installWithStore(500);
    await ready(large.adapter);
    await large.adapter.invoke({
      op: "collect",
      adapter_version: WHATSAPP_ADAPTER_VERSION,
      max_messages: 100,
      max_chats: 1,
      max_loads_per_chat: 1,
      chat_filter: "all",
      backfill_disabled: true,
      budget_ms: 1_000,
    });
    // The cost must scale with the COLLECTION, not with messages x collection.
    // Indexed, 500 contacts cost ~500 id reads however many messages are
    // normalised. Rescanning, it is 500 per message: 25 messages -> 12500, the
    // shape that made a real collect exceed the extension's 90s run fence.
    const messagesNormalised = 25;
    expect(large.reads()).toBeLessThan(500 * messagesNormalised);
    // One pass over the collection, plus a small constant.
    expect(large.reads()).toBeLessThanOrEqual(500 * 2);
    // And the same must hold at the smaller size, so this cannot pass by luck.
    expect(small.reads()).toBeLessThanOrEqual(50 * 2);
  });
});
