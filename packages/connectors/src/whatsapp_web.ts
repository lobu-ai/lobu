/**
 * WhatsApp's feed reads live without importing message history into events.
 * The page adapter answers source reads and observes new messages; observation
 * publishes references only, through the paired browser's generic evaluate
 * and feed_listen operations. An Automation reads content live when it runs. The only
 * checkpoint is the observation position used to replay missed references.
 *
 * Auth stays in the user's signed-in WhatsApp Web tab. Org policy governs
 * message writes; there is no connector-side action ledger.
 */

import {
  requireBrowser,
  type ActionContext,
  type ActionResult,
  type ChromeActionDispatcher,
  ConnectorRuntime,
  type FeedReadContext,
  type FeedReadResult,
  type FeedObserveContext,
  type RuntimeConnectorDefinition,
} from "@lobu/connector-sdk";
import {
  type ChatFilter,
  messageContentKind,
  messagePayloadText,
  messageTitle,
  normalizeRelayedMessage,
  type ObservationCheckpoint,
  WHATSAPP_ADAPTER_VERSION,
  WHATSAPP_ORIGIN,
} from "./whatsapp-web-helpers.js";
import { whatsAppWebAdapterProgram } from "./whatsapp-web-adapter.js";

// Each durable browser record is limited to 128 KiB, including its checkpoint.
const SOURCE_RECORD_MAX_BYTES = 128 * 1024;

/**
 * How long a run waits for WhatsApp Web to finish hydrating before giving up.
 *
 * Measured on the live prod tab (2026-09-06): a cold load traces
 * 0:0 -> 5:0 -> 947:0 -> 947:23 -> ... -> 947:547 and is still climbing at
 * t=24s, converging near 947:941. Readiness needs the `me:chatCount:msgCount`
 * signature to hold still for 500ms, so the old 25s budget expired mid-stream
 * every time: the feed failed `stores_settling` on 9 of its last 10 runs and
 * ingested nothing for three days.
 *
 * 25s was never a real bound -- the executor allows a 600s run and each probe
 * is its own fenced dispatch. A warm tab answers in ~1s, so this ceiling only
 * governs how long a COLD tab may take, and it must outlast one full hydration
 * with margin.
 *
 * The extension's persistent navigate now reuses an already-loaded page. This
 * ceiling remains the recovery bound for a genuinely cold or reloaded tab.
 */
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_INTERVAL_MS = 500;

interface WhatsAppWebConfig {
  chat_filter?: ChatFilter;
}

/** Adapter failures the bridge can recover from by re-injecting the program. */
const REINJECTABLE_STATES = new Set([
  "adapter_unavailable",
  "adapter_mismatch",
]);

class WhatsAppAdapterError extends Error {
  readonly state: string;
  constructor(state: string, reason: string) {
    super(`WhatsApp Web ${state}: ${reason}`);
    this.name = "WhatsAppAdapterError";
    this.state = state;
  }
}

/**
 * A hydrated WhatsApp Web tab in the extension's persistent agent window.
 *
 * The window is persistent on purpose: a cold tab costs a 20s load plus up to
 * 25s of WhatsApp hydration, and every one of those seconds is spent inside a
 * run's budget. Reusing the window keeps the message model hot for reads and
 * keeps the page observer attached between runs.
 */
async function openWhatsAppTab(
  dispatcher: ChromeActionDispatcher
): Promise<number> {
  const nav = await dispatcher.dispatch<{
    tab_id?: number;
    current_url?: string;
  }>("navigate", {
    url: `${WHATSAPP_ORIGIN}/`,
    persistent: true,
    wait_for_load: true,
  });
  if (typeof nav.tab_id !== "number") {
    throw new Error("Chrome did not return a WhatsApp Web tab id");
  }
  return nav.tab_id;
}

/** Is the MAIN-world adapter already installed at the expected version? */
async function adapterInstalled(
  dispatcher: ChromeActionDispatcher,
  tabId: number
): Promise<boolean> {
  const probe = await dispatcher.dispatch<{ value?: unknown }>("evaluate", {
    tab_id: tabId,
    expression: `(() => {
      const a = globalThis.__owlettoWhatsAppAdapterV1;
      return !!a && typeof a.invoke === 'function' && a.version === ${WHATSAPP_ADAPTER_VERSION};
    })()`,
    await_promise: false,
  });
  return probe.value === true;
}

/**
 * Inject the MAIN-world adapter by serialising the program function.
 *
 * `whatsAppWebAdapterProgram` is self-contained by construction — a companion
 * test fails the build if any binding it needs escapes to module scope, since
 * `toString()` would silently drop it and the page would throw a
 * ReferenceError with nothing red at build time. Re-injection is safe: the
 * program short-circuits when its own version is already installed.
 */
async function injectAdapter(
  dispatcher: ChromeActionDispatcher,
  tabId: number
): Promise<void> {
  const result = await dispatcher.dispatch<{
    value?: unknown;
    exception?: unknown;
  }>("evaluate", {
    tab_id: tabId,
    expression: `(${whatsAppWebAdapterProgram.toString()})()`,
    await_promise: false,
  });
  if (result.exception) {
    throw new Error(
      `WhatsApp adapter injection failed: ${JSON.stringify(result.exception).slice(0, 300)}`
    );
  }
}

async function ensureAdapter(
  dispatcher: ChromeActionDispatcher,
  tabId: number
): Promise<void> {
  if (await adapterInstalled(dispatcher, tabId)) return;
  await injectAdapter(dispatcher, tabId);
}

/**
 * One adapter RPC. The request rides a generic `evaluate` into the MAIN world,
 * where the installed program answers it. A missing or stale adapter is
 * re-injected once and the call retried — a tab reload between two ops in the
 * same run is the ordinary case, not an error.
 */
async function invokeAdapter<T extends object>(
  dispatcher: ChromeActionDispatcher,
  tabId: number,
  request: Record<string, unknown>,
  { allowReinject = true }: { allowReinject?: boolean } = {}
): Promise<T & { ok: true }> {
  const payload = JSON.stringify({
    ...request,
    adapter_version: WHATSAPP_ADAPTER_VERSION,
  });
  const result = await dispatcher.dispatch<{
    value?: unknown;
    exception?: unknown;
  }>("evaluate", {
    tab_id: tabId,
    expression: `(() => {
      const a = globalThis.__owlettoWhatsAppAdapterV1;
      if (!a || typeof a.invoke !== 'function') {
        return { ok: false, error: { state: 'adapter_unavailable', reason: 'MAIN-world adapter was not installed' } };
      }
      return a.invoke(${payload});
    })()`,
    await_promise: true,
  });
  if (result.exception) {
    throw new WhatsAppAdapterError(
      "adapter_failed",
      JSON.stringify(result.exception).slice(0, 300)
    );
  }
  const response = result.value as
    | { ok?: boolean; error?: { state?: string; reason?: string } }
    | undefined;
  if (!response || response.ok !== true) {
    const state = response?.error?.state ?? "adapter_failed";
    const reason =
      response?.error?.reason ?? "WhatsApp adapter returned no result";
    if (allowReinject && REINJECTABLE_STATES.has(state)) {
      await injectAdapter(dispatcher, tabId);
      return invokeAdapter<T>(dispatcher, tabId, request, {
        allowReinject: false,
      });
    }
    throw new WhatsAppAdapterError(state, reason);
  }
  return response as T & { ok: true };
}

const LOGGED_OUT_PATTERN = /logged_out|qr_code_visible/;
/**
 * The one readiness verdict a reload can fix: the account is authenticated and
 * its stores are hydrated, but the live stream is gone, so the page serves
 * cached state indefinitely. Matched on the message rather than the error
 * prototype -- see classifyWhatsAppReadinessFailure for why that is the
 * reliable half of an adapter failure.
 */
const STALLED_STREAM_PATTERN = /WhatsApp Web not_ready: stream_disconnected/;
/**
 * `hydrating`/`stores_settling` are the adapter's own words for "the page is
 * still coming up", so they arrive prefixed as a WhatsAppAdapterError.
 */
const TRANSIENT_READINESS_PATTERN = /hydrating|stores_settling/i;
/**
 * The page never answered at all. WhatsApp's `require()` blocks rather than
 * throwing while its module graph registers, so the evaluation is abandoned by
 * its CDP timeout and the adapter never gets to name a state -- the bridge
 * REJECTS the dispatch instead of returning an adapter-shaped error, so this
 * message carries no connector prefix to classify on.
 */
const BARE_EVALUATE_TIMEOUT_PATTERN = /\btimed out\b/i;
const DEPENDENCY_UNAVAILABLE_PREFIX =
  "[lobu:dependency_unavailable:browser_source_hydrating]";

/**
 * Only readiness-phase WhatsApp failures are transient. Authentication, adapter
 * corruption, and unsupported operations remain ordinary connector failures
 * and still count toward source health.
 */
function classifyWhatsAppReadinessFailure(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  // A dispatch the bridge abandoned never reaches the adapter, so it has no
  // connector prefix to match. Classify it before the prefix gate below, or a
  // hydration stall that timed out is booked as a hard failure.
  if (BARE_EVALUATE_TIMEOUT_PATTERN.test(error.message)) {
    return `${DEPENDENCY_UNAVAILABLE_PREFIX} ${error.message}`;
  }
  // MAIN-world adapter failures may cross the extension/worker boundary without
  // preserving their prototype, so classify on the connector-owned message.
  if (!error.message.startsWith("WhatsApp Web ")) return null;
  if (!TRANSIENT_READINESS_PATTERN.test(error.message)) return null;
  return `${DEPENDENCY_UNAVAILABLE_PREFIX} ${error.message}`;
}

/**
 * Open the persistent tab, install the adapter, and poll `probe` until
 * WhatsApp's module graph has hydrated. A logged-out page is terminal — no
 * amount of waiting fixes it, and the message names the fix the user has to
 * perform in their own browser.
 */
async function readyWhatsAppTab(
  dispatcher: ChromeActionDispatcher,
  timeoutMs = READY_TIMEOUT_MS
): Promise<number> {
  const tabId = await openWhatsAppTab(dispatcher);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  let reloaded = false;
  do {
    try {
      await ensureAdapter(dispatcher, tabId);
      await invokeAdapter(dispatcher, tabId, { op: "probe" });
      return tabId;
    } catch (error) {
      lastError = error;
      // A persistent scrape-owned tab can keep its cached stores after its
      // stream stalls, so nothing recovers on its own. Reload it once, inside
      // the existing readiness deadline, and defer the reload inside the page
      // so the expression returns before navigation tears the world down.
      // A dispatch that fails here is not a readiness verdict of its own:
      // swallow it and keep polling on the error that triggered the reload.
      if (!reloaded && STALLED_STREAM_PATTERN.test(String(error))) {
        reloaded = true;
        await dispatcher
          .dispatch("evaluate", {
            tab_id: tabId,
            expression:
              "(() => { setTimeout(() => location.reload(), 100); return true; })()",
            await_promise: false,
          })
          .catch(() => undefined);
      }
      if (LOGGED_OUT_PATTERN.test(String(error))) {
        throw new Error(
          "WhatsApp Web is not signed in on the paired Chrome. Open https://web.whatsapp.com and scan the QR from WhatsApp → Settings → Linked Devices, then retry."
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  } while (Date.now() < deadline);
  const transient = classifyWhatsAppReadinessFailure(lastError);
  if (transient) throw new Error(transient);
  throw (
    lastError ??
    new Error("WhatsApp Web did not become ready within the run budget")
  );
}

/** Normalise adapter search/read hits into the row shape the tools return. */
function normalizedSearchResults(
  results: unknown[] | null | undefined
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const raw of results ?? []) {
    const message = normalizeRelayedMessage(raw);
    if (!message) continue;
    rows.push({
      id: message.id,
      chat_jid: message.chat_jid,
      chat_name: message.chat_name ?? null,
      title: messageTitle(message),
      text: messagePayloadText(message),
      content_kind: messageContentKind(message),
      occurred_at: message.occurred_at,
      from_me: message.from_me,
      sender_jid: message.sender_jid ?? null,
      sender_phone: message.sender_phone ?? null,
      push_name: message.push_name ?? null,
      is_group: message.is_group,
      quoted_id: message.quoted_id ?? null,
    });
  }
  return rows;
}

const WRITE_ACTIONS = new Set([
  "draft_message",
  "send_message",
  "edit_message",
  "react_message",
  "revoke_message",
]);

export default class WhatsAppWebConnector extends ConnectorRuntime<
  ObservationCheckpoint,
  WhatsAppWebConfig
> {
  readonly definition: RuntimeConnectorDefinition<
    ObservationCheckpoint,
    WhatsAppWebConfig
  > = {
    key: "whatsapp.web",
    name: "WhatsApp",
    description:
      "Personal WhatsApp messages read live from WhatsApp Web in the paired Owletto Chrome without importing message history. Automations react to new-message references and read content on demand. Search, draft, send, edit, react to, and revoke messages.",
    version: "2.0.0",
    faviconDomain: "whatsapp.com",
    authSchema: { methods: [{ type: "browser", mode: "live" }] },
    browser: {
      origins: [WHATSAPP_ORIGIN],
      accountProbe: {
        url: `${WHATSAPP_ORIGIN}/`,
        expression: `(async () => {
          (${whatsAppWebAdapterProgram.toString()})();
          for (let i = 0; i < 40; i++) {
            const identity = await globalThis.__owlettoWhatsAppAdapterV1.invoke({ op: "account_identity", adapter_version: ${WHATSAPP_ADAPTER_VERSION} });
            if (identity?.accountId) return identity;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          return null;
        })()`,
      },
    },
    automationEvents: [{
      key: "message.created", label: "New message", resourceType: "message",
      description: "A new message reference from WhatsApp Web. The Automation can read its content from the live messages feed, or reply in the chat it came from.",
      filterSchema: {
        type: "object",
        properties: {
          channel_id: {
            type: "string",
            title: "Chat",
            description: "WhatsApp chat ID. Replies into a group need this set to that group.",
          },
        },
      },
      capabilities: { replyToSource: true },
    }],
    feeds: {
      live_messages: {
        key: "live_messages",
        name: "Live messages",
        description:
          "Read messages directly from WhatsApp Web without importing history, using literal text search or id:<message ID>. Active Automations can subscribe to new-message references. Requires the paired browser to be online and signed in; reconnects replay messages still available in WhatsApp's local history.",
        read: (ctx) => this.readMessages(ctx),
        observe: (ctx) => this.observeMessages(ctx),
        webhook: { mode: "trigger", events: ["message.created"] },
        configSchema: {
          type: "object",
          properties: {
            chat_filter: {
              type: "string",
              enum: ["all", "individual", "group"],
              default: "all",
              description: "Which chats to include.",
            },
          },
        },
      },
    },
    actions: {
      search_messages: {
        key: "search_messages",
        name: "Search messages",
        description:
          "Search WhatsApp's local full-text index globally or within one exact chat. Results are bounded; loaded-model matching is used only when the private search capability is unavailable.",
        kind: "read",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", minLength: 1, maxLength: 500 },
            chat_jid: {
              type: "string",
              description: "Optional exact canonical WhatsApp chat JID.",
            },
            chat_name: {
              type: "string",
              description: "Optional exact chat name; rejected when ambiguous.",
            },
            self_chat: {
              type: "boolean",
              description:
                "Search only the authenticated account's explicit self chat.",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              default: 50,
            },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              enum: ["whatsapp_fts", "loaded_model_fallback"],
            },
            results: { type: "array", items: { type: "object" } },
            hasMore: { type: "boolean" },
          },
        },
      },
      draft_message: {
        key: "draft_message",
        name: "Draft message",
        description:
          "Persist a WhatsApp draft in an exact chat without sending it.",
        kind: "write",
        // A draft is the handoff surface, not the send: it fills the chat's
        // composer and stops. The human presses send.
        annotations: { destructiveHint: false, idempotentHint: true },
        inputSchema: {
          type: "object",
          required: ["text"],
          properties: {
            chat_jid: { type: "string" },
            chat_name: { type: "string" },
            self_chat: { type: "boolean", const: true },
            text: { type: "string", minLength: 1, maxLength: 65536 },
          },
          anyOf: [
            { required: ["chat_jid"] },
            { required: ["chat_name"] },
            { required: ["self_chat"] },
          ],
        },
        outputSchema: {
          type: "object",
          properties: {
            drafted: { type: "boolean" },
            sent: { type: "boolean", const: false },
            chat_jid: { type: "string" },
            draft: { type: "object" },
          },
        },
      },
      send_message: {
        key: "send_message",
        name: "Send message",
        description: "Send a text message to an exact WhatsApp chat.",
        kind: "write",
        annotations: { destructiveHint: false, idempotentHint: false },
        inputSchema: {
          type: "object",
          required: ["text"],
          properties: {
            chat_jid: { type: "string" },
            chat_name: { type: "string" },
            self_chat: { type: "boolean", const: true },
            text: { type: "string", minLength: 1, maxLength: 65536 },
          },
          anyOf: [
            { required: ["chat_jid"] },
            { required: ["chat_name"] },
            { required: ["self_chat"] },
          ],
        },
        outputSchema: {
          type: "object",
          properties: {
            sent: { type: "boolean" },
            chat_jid: { type: "string" },
            message_id: { type: "string" },
          },
        },
      },
      edit_message: {
        key: "edit_message",
        name: "Edit message",
        description: "Edit a loaded outgoing WhatsApp message.",
        kind: "write",
        annotations: { destructiveHint: false, idempotentHint: false },
        inputSchema: {
          type: "object",
          required: ["message_id", "text"],
          properties: {
            message_id: {
              type: "string",
              description: "Raw WhatsApp message key.id.",
            },
            text: { type: "string", minLength: 1, maxLength: 65536 },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            edited: { type: "boolean" },
            message_id: { type: "string" },
          },
        },
      },
      react_message: {
        key: "react_message",
        name: "React to message",
        description: "Add or remove a reaction on a loaded WhatsApp message.",
        kind: "write",
        annotations: { destructiveHint: false, idempotentHint: true },
        inputSchema: {
          type: "object",
          required: ["message_id"],
          properties: {
            message_id: { type: "string" },
            emoji: { type: "string", maxLength: 32 },
            remove: { type: "boolean", default: false },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            reacted: { type: "boolean" },
            removed: { type: "boolean" },
            emoji: { type: ["string", "null"] },
            message_id: { type: "string" },
          },
        },
      },
      revoke_message: {
        key: "revoke_message",
        name: "Revoke message",
        description:
          "Delete a loaded outgoing WhatsApp message for everyone where WhatsApp permits it.",
        kind: "write",
        annotations: { destructiveHint: true, idempotentHint: true },
        inputSchema: {
          type: "object",
          required: ["message_id"],
          properties: { message_id: { type: "string" } },
        },
        outputSchema: {
          type: "object",
          properties: {
            revoked: { type: "boolean" },
            message_id: { type: "string" },
          },
        },
      },
    },
  };

  private async observeMessages(ctx: FeedObserveContext<ObservationCheckpoint, WhatsAppWebConfig>): Promise<void> {
    const dispatcher = requireBrowser(ctx);
    const tabId = await readyWhatsAppTab(dispatcher);
    const chatFilter = ctx.config.chat_filter ?? "all";
    const previous = ctx.checkpoint?.observation?.chat_filter === chatFilter ? ctx.checkpoint.observation : undefined;
    const startedAt = previous?.started_at ?? Math.floor(Date.now() / 1000);
    // Snapshot before attaching so replay covers messages arriving during setup.
    let after = previous?.after ?? (await invokeAdapter<{ after: number }>(
      dispatcher, tabId, { op: "observe_messages", input: {} })).after;
    const binding = await dispatcher.dispatch<{
      bridge_id: string; token: string; listening?: boolean; subscription?: { scope_key: string };
    }>("feed_listen", { tab_id: tabId });
    if (!binding.bridge_id || !binding.token || !binding.subscription || binding.listening === false) {
      throw new Error("A browser supporting source subscriptions is required for WhatsApp");
    }
    await invokeAdapter(dispatcher, tabId, {
      op: "listen", bridge_id: binding.bridge_id, token: binding.token,
      chat_filter: chatFilter, minimum_timestamp: startedAt,
    });
    let cursor = ctx.checkpoint ?? null;
    for (let page = 0; page < 10; page++) {
      const replay = await invokeAdapter<{
        after: number; references: Array<{ id: string; timestamp: number }>; hasMore: boolean;
      }>(dispatcher, tabId, { op: "observe_messages", input: { after, started_at: startedAt, chat_filter: chatFilter } });
      const next: ObservationCheckpoint = {
        observation: { after: replay.after, started_at: startedAt, chat_filter: chatFilter },
      };
      const events = replay.references.map(reference => ({
        id: reference.id, event_type: "message.created", resource_type: "message",
        resource_ref: reference.id, occurred_at: new Date(reference.timestamp * 1000).toISOString(),
      }));
      for (let offset = 0; ;) {
        const batchThrough = (end: number) => ({
          id: `replay:${chatFilter}:${startedAt}:${after}:${replay.after}:${offset}`,
          events: events.slice(offset, end),
          // Earlier chunks may be replayed after interruption; existing signal
          // dedupe handles them. Advance only after the entire page is accepted.
          ...(end === events.length ? { checkpoint: { previous: cursor, next } } : {}),
          more: end === events.length && replay.hasMore && page === 9,
        });
        let end = Math.min(offset + 500, events.length);
        let batch = batchThrough(end);
        const size = () => new TextEncoder().encode(JSON.stringify(batch)).length;
        while (size() > SOURCE_RECORD_MAX_BYTES && end - offset > 1) {
          end = offset + Math.floor((end - offset) / 2);
          batch = batchThrough(end);
        }
        if (size() > SOURCE_RECORD_MAX_BYTES) throw new Error("Source reference or checkpoint exceeds the browser record limit");
        await invokeAdapter(dispatcher, tabId, {
          op: "publish_changes", bridge_id: binding.bridge_id, token: binding.token, batch,
        });
        if (end === events.length) break;
        offset = end;
      }
      if (!replay.hasMore) return;
      cursor = next;
      after = replay.after;
    }
  }

  private async readMessages(ctx: FeedReadContext<WhatsAppWebConfig>): Promise<FeedReadResult> {
    if (ctx.offset) throw new Error("WhatsApp live reads paginate with the returned cursor, not an offset.");
    if (ctx.sort) throw new Error("WhatsApp live reads use source storage order; explicit sorting is not supported.");
    // Source message time cannot represent edits, revokes, or delayed arrivals.
    // Automations subscribe to new-message references and read content by ID.
    if (ctx.window) throw new Error("WhatsApp live reads do not support change-time windows; subscribe to message.created and read references by id:<message ID>.");
    const dispatcher = requireBrowser(ctx);
    const tabId = await readyWhatsAppTab(dispatcher);
    const response = await invokeAdapter<{
      results: unknown[];
      nextCursor?: string;
      hasMore: boolean;
    }>(dispatcher, tabId, {
      op: "read_messages",
      input: {
        query: ctx.query,
        cursor: ctx.cursor,
        limit: ctx.limit,
        chat_filter: ctx.config.chat_filter ?? "all",
      },
    });
    return {
      rows: normalizedSearchResults(response.results),
      columns: [
        { name: "id", type: "string" },
        { name: "chat_jid", type: "string" },
        { name: "chat_name", type: "string" },
        { name: "title", type: "string" },
        { name: "text", type: "string" },
        { name: "content_kind", type: "string" },
        { name: "occurred_at", type: "string" },
        { name: "from_me", type: "boolean" },
        { name: "sender_jid", type: "string" },
        { name: "sender_phone", type: "string" },
        { name: "push_name", type: "string" },
        { name: "is_group", type: "boolean" },
        { name: "quoted_id", type: "string" },
      ],
      nextCursor: response.nextCursor,
      hasMore: response.hasMore,
    };
  }

  async execute(ctx: ActionContext): Promise<ActionResult> {
    const action = ctx.actionKey;
    if (action !== "search_messages" && !WRITE_ACTIONS.has(action)) {
      return { success: false, error: `Unknown action: ${action}` };
    }
    try {
      const dispatcher = requireBrowser(ctx);
      const tabId = await readyWhatsAppTab(dispatcher);
      const response = await invokeAdapter<Record<string, unknown>>(
        dispatcher,
        tabId,
        { op: action, input: ctx.input ?? {} }
      );
      if (action === "search_messages") {
        return {
          success: true,
          output: {
            source: response.source,
            results: normalizedSearchResults(
              response.results as unknown[] | undefined
            ),
            ...(typeof response.hasMore === "boolean"
              ? { hasMore: response.hasMore }
              : {}),
          },
        };
      }
      // A send that reports no raw WhatsApp key.id did not demonstrably land;
      // fail loudly rather than record a success no message reference will
      // corroborate.
      if (action === "send_message" && !response.message_id) {
        return {
          success: false,
          error: "send_message returned no raw WhatsApp message ID",
        };
      }
      return {
        success: true,
        output: Object.fromEntries(
          Object.entries(response).filter(([key]) => key !== "ok")
        ),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
