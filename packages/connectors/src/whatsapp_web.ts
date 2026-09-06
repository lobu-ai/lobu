/**
 * WhatsApp Web connector.
 *
 * Replaces the extension-native `whatsapp.local` connector. What it does is
 * the same and the event stream is byte-comparable; what changes is WHERE the
 * code lives. Previously ~6,000 lines of WhatsApp-specific logic shipped inside
 * the Owletto Chrome extension and rode a bespoke `browser.whatsapp` capability
 * plus a `LEGACY_NATIVE_CHROME_EXTENSION_CONNECTORS` branch through seven
 * server files. Now the extension is a frozen generic substrate: this connector
 * ships its own code, pins to a `chrome-extension` device, and drives the page
 * through the generic `navigate` / `evaluate` ops every other browser connector
 * already uses (LinkedIn, Revolut, Midas, Hacker News).
 *
 * Three files make up the port:
 *   • `whatsapp-web-adapter.js`  — the MAIN-world adapter, injected verbatim
 *     into the page via `Function.prototype.toString()`. It alone touches
 *     WhatsApp's private module graph.
 *   • `whatsapp-web-helpers.ts`  — the transport-neutral normalise/checkpoint
 *     layer that used to run in the extension service worker.
 *   • this file                  — tab management, the RPC bridge, the sync
 *     loop, and the six actions.
 *
 * Auth is implicit, exactly as it was: the user is signed into WhatsApp Web in
 * the paired Chrome. The QR lives on web.whatsapp.com itself, so there is no
 * artifact to relay — and `AuthContext` carries no chrome dispatcher, so an
 * `authenticate()` run could not read the page even if we wanted to. A
 * logged-out page surfaces as a readiness failure naming the exact remedy.
 *
 * Two pieces of the extension implementation are deliberately NOT ported,
 * because the generic op catalog has no primitive for them:
 *   • the live observer + IndexedDB outbox. There is no push channel from a
 *     page to a connector run, so liveness is per-sync `collect` against the
 *     tab's hot in-memory model rather than a background relay. The persistent
 *     agent window keeps that model hydrated between runs.
 *   • the per-run action ledger. `ActionContext` exposes no durable store, so
 *     an interrupted write is not fenced by a connector-side ledger; the four
 *     irreversible actions stay `requiresApproval: true` as they were.
 * Everything else — backfill cursors, dirty-marker reconciliation, and media
 * retry state — moved from IndexedDB into the feed checkpoint.
 */

import {
  type ActionContext,
  type ActionResult,
  type ChromeActionDispatcher,
  ConnectorRuntime,
  type EventEnvelope,
  type RuntimeConnectorDefinition,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";
import {
  type BrowserCheckpoint,
  buildCollectionPlan,
  type ChatFilter,
  type CollectResponse,
  type DirtyMarker,
  isMediaEligible,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_PER_RUN,
  type MediaRecord,
  type MediaStatus,
  mergeBrowserCheckpoint,
  mergeCollectedMessages,
  messagePayloadText,
  messageRevision,
  messageTitle,
  normalizeRelayedMessage,
  toEventEnvelope,
  WHATSAPP_ADAPTER_VERSION,
  WHATSAPP_ORIGIN,
  type WhatsAppMessage,
} from "./whatsapp-web-helpers.js";
import { whatsAppWebAdapterProgram } from "./whatsapp-web-adapter.js";

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
 * This is the server-side half of the fix. The other half lives in the
 * extension: a `persistent: true` navigate re-issues CDP `Page.navigate` on the
 * plain-navigate path, reloading the very tab whose state it means to reuse, so
 * every run pays cold hydration. Until that ships, this budget is what lets a
 * cold run finish at all.
 */
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_INTERVAL_MS = 500;
/**
 * Per-item budget, enforced by the ADAPTER inside the page.
 *
 * A caller-side timer cannot bound a dispatch: it cannot cancel one, so racing
 * it only stops us waiting while the request stays in flight in the parent
 * worker. The child then finishes and exits, the device's answer arrives with
 * nobody to receive it, and the parent's reply-send finds a dead IPC channel —
 * which failed a prod sync run that had already written its events, and once
 * killed the worker daemon outright. Measured `download_media` evaluates take
 * 3.9-5.2s, so the old 4s caller-side cap orphaned nearly every media item.
 *
 * The extension's `evaluate` op takes no timeout and its schema is deliberately
 * frozen, but the adapter request shape is ours: send the budget with the
 * request and let the page enforce it, so a slow item comes back as an ordinary
 * `timeout_retryable` answer instead of an abandoned dispatch. This mirrors how
 * `x.ts` hands `timeout_ms` to `wait_for_selector` rather than racing it.
 */
const MEDIA_ITEM_TIMEOUT_MS = 20_000;

/**
 * Outer bound on the whole media phase, checked between items. The per-item
 * budget above caps any single download; this stops a long queue of merely
 * slow ones from consuming a run. Items past it stay retryable.
 */
const MEDIA_PHASE_BUDGET_MS = 60_000;
const MEDIA_CONCURRENCY = 3;
const MAX_TOTAL_MEDIA_BYTES = 4 * 1024 * 1024;
const MAX_DIRTY_MARKERS_PERSISTED = 250;
/**
 * Media retry rows the checkpoint carries between runs. Attachments are never
 * persisted — only the status/backoff bookkeeping the extension kept in
 * IndexedDB, which is what decides whether to re-attempt a download.
 */
const MAX_MEDIA_RECORDS_PERSISTED = 500;

interface WhatsAppWebConfig {
  chat_filter?: ChatFilter;
  max_messages_per_sync?: number;
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
 * Pull the chrome action dispatcher off sessionState. The connector-worker
 * host splices a live `chrome_dispatcher` onto every sync AND action context;
 * its `dispatch()` rides a host capability up to the daemon and out to the
 * gateway's chrome-action bridge.
 */
function requireExtensionDispatcher(ctx: {
  sessionState?: Record<string, unknown> | null;
}): ChromeActionDispatcher {
  const handle = ctx.sessionState?.chrome_dispatcher as
    | ChromeActionDispatcher
    | undefined;
  if (!handle || typeof handle.dispatch !== "function") {
    throw new Error(
      "WhatsApp Web connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState — pin this connection to a chrome-extension device."
    );
  }
  return handle;
}

/**
 * A hydrated WhatsApp Web tab in the extension's persistent agent window.
 *
 * The window is persistent on purpose: a cold tab costs a 20s load plus up to
 * 25s of WhatsApp hydration, and every one of those seconds is spent inside a
 * run's budget. Reusing the window keeps the message model hot, which is also
 * what makes per-sync `collect` an adequate substitute for the live observer
 * the extension used to run.
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
 * `hydrating`/`stores_settling` are the adapter's own words for "the page is
 * still coming up". `timed out` covers the case where the page never answered
 * at all: WhatsApp's `require()` blocks rather than throwing while its module
 * graph registers, so the evaluation is abandoned by its CDP timeout and the
 * adapter never gets to name a state. Both mean "try again", not "this feed is
 * broken" -- unclassified, they count toward the consecutive-failure budget and
 * walk a recoverable feed toward a hard pause.
 */
const TRANSIENT_READINESS_PATTERN = /hydrating|stores_settling|timed out/i;
const DEPENDENCY_UNAVAILABLE_PREFIX =
  "[lobu:dependency_unavailable:browser_source_hydrating]";

/**
 * Only readiness-phase WhatsApp failures are transient. Authentication, adapter
 * corruption, unsupported operations, and collection errors remain ordinary
 * connector failures and still count toward source health.
 */
function classifyWhatsAppReadinessFailure(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
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
  do {
    try {
      await ensureAdapter(dispatcher, tabId);
      await invokeAdapter(dispatcher, tabId, { op: "probe" });
      return tabId;
    } catch (error) {
      lastError = error;
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

const MEDIA_STATES: ReadonlySet<string> = new Set([
  "downloaded",
  "NEED_POKE",
  "awaiting_primary_device",
  "view_once",
  "expired",
  "too_large",
  "timeout_retryable",
  "metadata_only",
  "unavailable",
]);
const TERMINAL_MEDIA_STATES: ReadonlySet<string> = new Set([
  "downloaded",
  "view_once",
  "expired",
  "too_large",
]);
const RETRYABLE_MEDIA_STATES = [
  "awaiting_primary_device",
  "timeout_retryable",
  "unavailable",
  "metadata_only",
];

function mediaBackoff(attempts: number): number {
  return Date.now() + Math.min(60 * 60_000, 5_000 * 2 ** Math.min(attempts, 8));
}

/**
 * Download the media the run is allowed to spend on, and carry the retry
 * bookkeeping forward in the checkpoint.
 *
 * The extension cached blobs in IndexedDB; a checkpoint cannot hold megabytes
 * of base64, so only the status/backoff row survives a run. A message whose
 * media already downloaded is not re-attempted because the head cursor has
 * moved past it — the cache only ever mattered for re-emitted rows.
 */
async function downloadEligibleMedia(
  dispatcher: ChromeActionDispatcher,
  tabId: number,
  messages: WhatsAppMessage[],
  priorMedia: Record<string, MediaRecord>
): Promise<{
  results: Map<string, MediaRecord>;
  nextMedia: Record<string, MediaRecord>;
}> {
  const results = new Map<string, MediaRecord>();
  const nextMedia: Record<string, MediaRecord> = {};
  const queue: Array<{
    message: WhatsAppMessage;
    previous: MediaRecord | undefined;
    revision: string;
  }> = [];
  let totalBytes = 0;

  const remember = (record: MediaRecord) => {
    results.set(record.id, record);
    // Terminal rows need no further bookkeeping; only pending retries are
    // worth a checkpoint slot. So a prior record is ALWAYS retryable — there
    // is no terminal-prior case to short-circuit. Re-downloading inside the
    // recent-overlap window costs one fetch and dedupes on content hash;
    // persisting terminal rows to avoid it would grow the checkpoint without
    // bound.
    if (record.retryable)
      nextMedia[record.id] = { ...record, attachment: undefined };
  };

  const defer = (message: WhatsAppMessage, previous?: MediaRecord) => {
    remember({
      id: message.id,
      revision: messageRevision(message),
      status: "metadata_only",
      retryable: true,
      attempts: previous?.attempts ?? 0,
      next_attempt_at: Date.now() + 5_000,
      updated_at: Date.now(),
    });
  };

  for (const message of messages) {
    if (!isMediaEligible(message)) continue;
    const revision = messageRevision(message);
    const previous = priorMedia[message.id];
    if (
      previous?.revision === revision &&
      (previous.next_attempt_at ?? 0) > Date.now()
    ) {
      remember(previous);
      continue;
    }
    if (queue.length >= MAX_MEDIA_PER_RUN) {
      defer(message, previous);
      continue;
    }
    queue.push({ message, previous, revision });
  }

  const mediaDeadline = Date.now() + MEDIA_PHASE_BUDGET_MS;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      if (!item) return;
      const { message, previous, revision } = item;
      if (Date.now() > mediaDeadline) {
        // Out of phase budget: leave the rest retryable rather than starting a
        // dispatch this run cannot wait for.
        defer(message, previous);
        continue;
      }
      try {
        const response = await invokeAdapter<{
          status?: string;
          retryable?: boolean;
          attachment?: MediaRecord["attachment"];
        }>(dispatcher, tabId, {
          op: "download_media",
          message_id: message.id,
          max_bytes: MAX_MEDIA_BYTES,
          timeout_ms: MEDIA_ITEM_TIMEOUT_MS,
        });
        const rawStatus = MEDIA_STATES.has(response.status ?? "")
          ? (response.status as string)
          : "unavailable";
        const status = (
          rawStatus === "NEED_POKE" ? "awaiting_primary_device" : rawStatus
        ) as MediaStatus;
        const attempts = (previous?.attempts ?? 0) + 1;
        const retryable = Boolean(
          response.retryable ||
            rawStatus === "NEED_POKE" ||
            RETRYABLE_MEDIA_STATES.includes(status)
        );
        const record: MediaRecord = {
          id: message.id,
          revision,
          status,
          raw_status: rawStatus,
          retryable,
          attachment: response.attachment,
          mime_type:
            response.attachment?.mime_type ?? message.media_type ?? null,
          attempts,
          next_attempt_at: retryable ? mediaBackoff(attempts) : null,
          updated_at: Date.now(),
        };
        const size = Number(record.attachment?.size_bytes) || 0;
        if (size && totalBytes + size > MAX_TOTAL_MEDIA_BYTES) {
          // Over the per-run byte budget: emit the metadata placeholder and
          // leave the download to a later run.
          remember({
            ...record,
            attachment: undefined,
            status: "metadata_only",
            retryable: true,
          });
        } else {
          totalBytes += size;
          remember(record);
        }
      } catch (error) {
        const attempts = (previous?.attempts ?? 0) + 1;
        // Both the phase budget and the child-side dispatch backstop mean
        // "try again later", not "this media is gone".
        const text = String(error);
        const timedOut =
          text.includes("timed out") || text.includes("IPC may be wedged");
        const reported =
          error instanceof WhatsAppAdapterError ? error.state : null;
        const explicitState =
          reported && MEDIA_STATES.has(reported) ? reported : null;
        const status = (
          explicitState === "NEED_POKE"
            ? "awaiting_primary_device"
            : (explicitState ??
              (timedOut ? "timeout_retryable" : "unavailable"))
        ) as MediaStatus;
        const retryable = !TERMINAL_MEDIA_STATES.has(status);
        remember({
          id: message.id,
          revision,
          status,
          retryable,
          attempts,
          next_attempt_at: retryable ? mediaBackoff(attempts) : null,
          updated_at: Date.now(),
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MEDIA_CONCURRENCY, queue.length) }, () =>
      worker()
    )
  );
  return { results, nextMedia };
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
      occurred_at: message.occurred_at,
      from_me: message.from_me,
      sender_jid: message.sender_jid ?? null,
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
  BrowserCheckpoint,
  WhatsAppWebConfig
> {
  readonly definition: RuntimeConnectorDefinition<
    BrowserCheckpoint,
    WhatsAppWebConfig
  > = {
    key: "whatsapp.web",
    name: "WhatsApp",
    description:
      "Personal WhatsApp messages read from WhatsApp Web in the paired Owletto Chrome. Syncs one-to-one and group chats, progressively hydrates history, and can search, draft, send, edit, react to, and revoke messages.",
    version: "1.0.1",
    faviconDomain: "whatsapp.com",
    // Implicit auth: the user is already signed into WhatsApp Web in the
    // paired Chrome. There is no artifact to relay — the QR is rendered by
    // web.whatsapp.com itself — and an auth run carries no chrome dispatcher,
    // so a handshake here could not read the page. A logged-out page fails
    // the readiness probe with the exact remedy instead.
    authSchema: { methods: [{ type: "none" }] },
    feeds: {
      messages: {
        sync: (ctx) => this.syncMessages(ctx),
        key: "messages",
        name: "Messages",
        description:
          "Personal WhatsApp messages from one-to-one and group chats. Syncs live changes and progressively hydrates history available to WhatsApp Web.",
        configSchema: {
          type: "object",
          properties: {
            chat_filter: {
              type: "string",
              enum: ["all", "individual", "group"],
              default: "all",
              description: "Which chats to include.",
            },
            max_messages_per_sync: {
              type: "integer",
              minimum: 1,
              maximum: 1000,
              default: 1000,
              description:
                "Bounded maximum messages emitted per sync. Additional durable history resumes on later runs.",
            },
          },
        },
        eventKinds: {
          message: {
            description:
              "A WhatsApp message, caption, media placeholder, edit, revoke, or reaction-updated message.",
            metadataSchema: {
              type: "object",
              required: [
                "source",
                "origin_id",
                "chat_jid",
                "is_group",
                "from_me",
              ],
              properties: {
                source: { type: "string", const: "whatsapp_web" },
                origin_id: { type: "string" },
                chat_jid: { type: "string" },
                is_group: { type: "boolean" },
                from_me: { type: "boolean" },
                is_direct_inbound: { type: "boolean" },
                participant: { type: "string" },
                sender_jid: { type: "string" },
                sender_phone: { type: "string" },
                push_name: { type: "string" },
                media_type: { type: "string" },
                quoted_id: { type: "string" },
                is_forwarded: { type: "boolean" },
                is_starred: { type: "boolean" },
                is_system_event: { type: "boolean" },
                edited: { type: "boolean" },
                edit_timestamp: { type: "number" },
                revoked: { type: "boolean" },
                reactions: { type: "array", items: { type: "object" } },
                voice_note_skipped: {
                  type: "string",
                  enum: [
                    "not_downloaded",
                    "too_large",
                    "empty",
                    "read_error",
                    "invalid_path",
                  ],
                },
                media_status: {
                  type: "string",
                  enum: [
                    "downloaded",
                    "awaiting_primary_device",
                    "view_once",
                    "expired",
                    "too_large",
                    "timeout_retryable",
                    "metadata_only",
                    "unavailable",
                  ],
                },
              },
            },
            attributions: [
              {
                role: "authored_by",
                autoCreate: true,
                target: {
                  entityType: "person",
                  createWhen: {
                    path: "metadata.is_direct_inbound",
                    equals: true,
                  },
                  titlePath: "metadata.push_name",
                  identities: [
                    { namespace: "wa_jid", eventPath: "metadata.sender_jid" },
                    { namespace: "phone", eventPath: "metadata.sender_phone" },
                  ],
                },
                traits: {
                  push_name: {
                    eventPath: "metadata.push_name",
                    mergeStrategy: "prefer_non_empty",
                  },
                  last_seen_at: {
                    eventPath: "occurred_at",
                    mergeStrategy: "overwrite",
                  },
                },
              },
            ],
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
        requiresApproval: false,
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
        requiresApproval: false,
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
        requiresApproval: true,
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
        requiresApproval: true,
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
        requiresApproval: true,
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
        requiresApproval: true,
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

  private async syncMessages(
    ctx: SyncContext<BrowserCheckpoint, WhatsAppWebConfig>
  ): Promise<SyncResult<BrowserCheckpoint>> {
    const dispatcher = requireExtensionDispatcher(ctx);
    const tabId = await readyWhatsAppTab(dispatcher);
    return await this.collectMessages(ctx, dispatcher, tabId);
  }

  /**
   * The collect phase re-checks readiness inside the page, so a message landing
   * between the passing probe and this dispatch surfaces the same transient
   * `stores_settling` here. `readyWhatsAppTab` classifies that as a dependency
   * failure; without the same treatment on this path an ordinary race counts
   * against the feed's consecutive-failure budget and walks it toward a pause.
   */
  private async collectMessages(
    ctx: SyncContext<BrowserCheckpoint, WhatsAppWebConfig>,
    dispatcher: ChromeActionDispatcher,
    tabId: number
  ): Promise<SyncResult<BrowserCheckpoint>> {
    try {
      return await this.collectMessagesInner(ctx, dispatcher, tabId);
    } catch (error) {
      const transient = classifyWhatsAppReadinessFailure(error);
      if (transient) throw new Error(transient);
      throw error;
    }
  }

  private async collectMessagesInner(
    ctx: SyncContext<BrowserCheckpoint, WhatsAppWebConfig>,
    dispatcher: ChromeActionDispatcher,
    tabId: number
  ): Promise<SyncResult<BrowserCheckpoint>> {
    const { checkpoint, request } = buildCollectionPlan({
      checkpoint: ctx.checkpoint as Record<string, unknown> | null,
      config: ctx.config as Record<string, unknown>,
    });

    // Dirty markers and media retries used to live in the extension's
    // IndexedDB. They ride the feed checkpoint now — the only durable store a
    // connector run has.
    const dirtyBefore = checkpoint.dirty ?? [];
    const dirtyBatch = dirtyBefore.slice(0, MAX_DIRTY_MARKERS_PERSISTED);
    request.dirty_ranges = dirtyBatch.map((marker) => ({
      key: marker.key,
      chat_jid: marker.chat_jid ?? null,
      message_id: marker.message_id ?? null,
      minimum_timestamp: marker.minimum_timestamp ?? null,
    }));

    const result = await invokeAdapter<CollectResponse>(
      dispatcher,
      tabId,
      request as unknown as Record<string, unknown>
    );

    // History pages come back separately from the recent window so a backfill
    // page can advance its chat cursor without competing for the recent slot.
    const historyMessages = (result.history_pages ?? []).flatMap(
      (page) => page.messages ?? []
    );
    const messages = mergeCollectedMessages(
      [...(result.messages ?? []), ...historyMessages],
      [],
      request.minimum_timestamp
    ).slice(0, request.max_messages);

    const emittedIds = new Set(messages.map((message) => message.id));
    const reconciledKeys = new Set(
      (result.dirty_reconciled ?? [])
        .filter(
          (marker) => marker.message_id && emittedIds.has(marker.message_id)
        )
        .map((marker) => marker.key)
    );

    const { results: media, nextMedia } = await downloadEligibleMedia(
      dispatcher,
      tabId,
      messages,
      checkpoint.media ?? {}
    );

    const events: EventEnvelope[] = messages.map((message) =>
      toEventEnvelope(message, media.get(message.id))
    );

    const nextCheckpoint = mergeBrowserCheckpoint(
      checkpoint as unknown as Record<string, unknown>,
      result,
      messages
    );

    // Carry forward the markers this run did not reconcile, plus anything the
    // adapter newly quarantined.
    const dirtyByKey = new Map<string, DirtyMarker>();
    for (const marker of dirtyBefore) {
      if (!reconciledKeys.has(marker.key)) dirtyByKey.set(marker.key, marker);
    }
    for (const marker of result.quarantined ?? []) {
      dirtyByKey.set(marker.key, {
        ...marker,
        message_id: marker.message_id ?? null,
        minimum_timestamp: null,
      });
    }
    const dirty: DirtyMarker[] = [...dirtyByKey.values()].slice(
      0,
      MAX_DIRTY_MARKERS_PERSISTED
    );
    // `mergeBrowserCheckpoint` spreads the prior checkpoint forward, so every
    // one of these fields must be REPLACED, not conditionally set: a marker
    // the adapter just reconciled has to leave the checkpoint, or the next run
    // re-requests it and the list never empties.
    const diagnostics: Record<string, unknown> = {};
    if (dirty.length > 0) {
      nextCheckpoint.dirty = dirty;
      nextCheckpoint.backfill.complete = false;
      const reasons: Record<string, number> = {};
      for (const marker of dirty) {
        const reason = marker.reason ?? "unknown";
        reasons[reason] = (reasons[reason] ?? 0) + 1;
      }
      diagnostics.dirty_reconciliation = {
        pending_count: dirty.length,
        requested_count: dirtyBatch.length,
        reasons: Object.fromEntries(Object.entries(reasons).slice(0, 10)),
      };
    } else {
      nextCheckpoint.dirty = undefined;
    }

    const persistedMedia = Object.entries(nextMedia).slice(
      0,
      MAX_MEDIA_RECORDS_PERSISTED
    );
    nextCheckpoint.media =
      persistedMedia.length > 0
        ? Object.fromEntries(persistedMedia)
        : undefined;

    const mediaStatusCounts: Record<string, number> = {};
    for (const record of media.values()) {
      mediaStatusCounts[record.status] =
        (mediaStatusCounts[record.status] ?? 0) + 1;
    }
    if (Object.keys(mediaStatusCounts).length > 0) {
      diagnostics.media_status_counts = mediaStatusCounts;
    }
    nextCheckpoint.diagnostics =
      Object.keys(diagnostics).length > 0 ? diagnostics : undefined;

    return { events, checkpoint: nextCheckpoint };
  }

  async execute(ctx: ActionContext): Promise<ActionResult> {
    const action = ctx.actionKey;
    if (action !== "search_messages" && !WRITE_ACTIONS.has(action)) {
      return { success: false, error: `Unknown action: ${action}` };
    }
    try {
      const dispatcher = requireExtensionDispatcher(ctx);
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
            ...(typeof response.total === "number"
              ? { total: response.total }
              : {}),
            ...(typeof response.hasMore === "boolean"
              ? { hasMore: response.hasMore }
              : {}),
          },
        };
      }
      // A send that reports no raw WhatsApp key.id did not demonstrably land;
      // fail loudly rather than record a success the message stream will not
      // corroborate on the next sync.
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
