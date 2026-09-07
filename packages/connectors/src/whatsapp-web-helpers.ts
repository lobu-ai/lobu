/**
 * Transport-neutral helpers for the WhatsApp Web connector.
 *
 * Ported from the Owletto extension's `whatsapp-web-adapter-v1.js`, which ran
 * these same functions in the extension service worker. They are deliberately
 * free of WhatsApp private APIs — the unstable MAIN-world surface lives in
 * `whatsapp-web-adapter.js` and is injected into the page. Everything here runs
 * in the connector-worker.
 *
 * Semantics are preserved verbatim so the new connector's event stream is
 * byte-comparable with the extension-native feed it replaces. The one shape
 * change is the tail: the extension produced a device "feed item"; this
 * produces a `EventEnvelope` for the connector SDK.
 */

import type { EventEnvelope } from "@lobu/connector-sdk";

export const WHATSAPP_ADAPTER_VERSION = 10;
export const WHATSAPP_ORIGIN = "https://web.whatsapp.com";
const WHATSAPP_SOURCE = "whatsapp_web";
const RECENT_OVERLAP_SECONDS = 15 * 60;
const MAX_MESSAGES_PER_RUN = 1_000;
const MAX_CHATS_PER_RUN = 6;
const MAX_LOADS_PER_CHAT = 2;
export const MAX_MEDIA_BYTES = 2 * 1024 * 1024;
export const MAX_MEDIA_PER_RUN = 12;
/**
 * Ceiling on the time the page may spend paging history in one run. The real
 * bound is MAX_CHATS_PER_RUN * MAX_LOADS_PER_CHAT, so this only catches a
 * `loadEarlierMsgs` that hangs: without it a stuck load burns the whole device
 * action and the run returns nothing instead of the messages already collected.
 *
 * It MUST stay strictly under the extension's run fence. Every
 * `dispatch("evaluate", ...)` is claimed as its own chrome action run, and
 * `background.js` fences each one at RUN_TIMEOUT_MS (90s) from the moment it
 * is claimed. At 90s this budget equalled that fence, so the adapter was
 * entitled to spend the entire run paging history and still owed a
 * serialize-and-return it could never afford. The run died as `run timed out
 * after 90000ms`, and because a failed run discards its collected messages the
 * checkpoint never advanced -- the next run repeated the same oversized work.
 * That stalled a prod feed for three days at 17 consecutive failures.
 *
 * 60s leaves 30s of headroom for the dispatch round trip and the answer's
 * serialization, matching the media phase's own budget.
 */
const COLLECT_BUDGET_MS = 60_000;

export type ChatFilter = "all" | "individual" | "group";

export type WhatsAppReaction = Record<string, unknown>;

/** A message after `normalizeRelayedMessage` — every field the port relies on. */
export interface WhatsAppMessage {
  id: string;
  chat_jid: string;
  chat_name?: string | null;
  sender_jid: string | null;
  participant: string | null;
  sender_phone: string | null;
  push_name?: string | null;
  is_group: boolean;
  from_me: boolean;
  timestamp: number;
  occurred_at: string;
  reactions: WhatsAppReaction[];
  body?: string | null;
  caption?: string | null;
  message_type?: string | null;
  media_kind?: string | null;
  media_type?: string | null;
  quoted_id?: string | null;
  edited?: boolean;
  edit_timestamp?: number | null;
  revoked?: boolean;
  is_forwarded?: boolean;
  is_starred?: boolean;
  is_system_event?: boolean;
  [key: string]: unknown;
}

export interface BackfillChatState {
  oldest_timestamp?: number | null;
  oldest_id?: string | null;
  has_more?: boolean;
}

export interface BrowserCheckpoint {
  schema: "owletto.whatsapp.browser.v1";
  adapter_version: number;
  /**
   * Collect nothing at or before this instant, because another source already
   * ingested it. Nothing in this repo assigns it: an operator writes it into an
   * existing feed checkpoint when a connection changes source. Absent on a
   * fresh connection, which backfills from scratch.
   */
  cutover_unix_seconds?: number | null;
  head: { timestamp?: number; id?: string | null };
  backfill: {
    complete: boolean;
    cursor_chat_jid: string | null;
    inventory: string[];
    chats: Record<string, BackfillChatState>;
  };
  /** Media retries and dirty markers the extension kept in IndexedDB. */
  media?: Record<string, MediaRecord>;
  dirty?: DirtyMarker[];
  diagnostics?: Record<string, unknown>;
  last_run_at?: string;
}

export interface DirtyMarker {
  key: string;
  chat_jid?: string | null;
  message_id?: string | null;
  minimum_timestamp?: number | null;
  reason?: string;
}

export type MediaStatus =
  | "downloaded"
  | "awaiting_primary_device"
  | "view_once"
  | "expired"
  | "too_large"
  | "timeout_retryable"
  | "metadata_only"
  | "unavailable";

export interface MediaAttachment {
  kind: string;
  filename: string;
  mime_type: string;
  data: string;
  size_bytes: number;
}

export interface MediaRecord {
  id: string;
  revision: string;
  status: MediaStatus;
  raw_status?: string;
  retryable: boolean;
  attachment?: MediaAttachment;
  mime_type?: string | null;
  attempts: number;
  next_attempt_at: number | null;
  updated_at: number;
}

export interface CollectRequest {
  op: "collect";
  adapter_version: number;
  max_messages: number;
  max_chats: number;
  max_loads_per_chat: number;
  chat_filter: ChatFilter;
  recent_since: number | null;
  minimum_timestamp: number | null;
  backfill_disabled: boolean;
  backfill: BrowserCheckpoint["backfill"];
  dirty_ranges?: Array<Omit<DirtyMarker, "reason">>;
  /**
   * How long the page may spend paging history, in milliseconds. Relative, not
   * an absolute instant: the connector and the page run on different machines,
   * so the page resolves this against its own clock.
   */
  budget_ms?: number | null;
}

export interface CollectResponse {
  ok: true;
  status: Record<string, unknown>;
  messages: unknown[];
  history_pages?: Array<
    {
      chat_jid: string;
      messages: unknown[];
    } & BackfillChatState
  >;
  quarantined?: DirtyMarker[];
  dirty_reconciled?: Array<{ key: string; message_id: string }>;
  backfill: {
    complete: boolean;
    cursor_chat_jid: string | null;
    inventory: string[];
    chats: Record<string, BackfillChatState>;
  };
}

export function rawMessageId(value: unknown): string | null {
  if (typeof value === "string") {
    const id = value.trim();
    return id && !/^(?:true|false)_/i.test(id) ? id : null;
  }
  if (!value || typeof value !== "object") return null;
  const candidate = (value as { id?: unknown }).id;
  if (typeof candidate === "string") {
    const id = candidate.trim();
    return id && !/^(?:true|false)_/i.test(id) ? id : null;
  }
  return null;
}

export function canonicalizeJid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const jid = value.trim().toLowerCase();
  if (!jid?.includes("@")) return null;
  if (jid.endsWith("@c.us")) return `${jid.slice(0, -5)}@s.whatsapp.net`;
  return jid;
}

function jidPhone(jid: unknown): string | null {
  const canonical = canonicalizeJid(jid);
  if (!canonical?.endsWith("@s.whatsapp.net")) return null;
  const digits = canonical.slice(0, -"@s.whatsapp.net".length);
  return /^\d+$/.test(digits) ? digits : null;
}

function finiteSeconds(value: unknown): number | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function initializeBrowserCheckpoint(
  checkpoint: Record<string, unknown> | null | undefined
): BrowserCheckpoint {
  const raw = (checkpoint ?? {}) as Record<string, any>;
  if (raw.schema === "owletto.whatsapp.browser.v1") {
    return {
      ...(raw as BrowserCheckpoint),
      adapter_version: WHATSAPP_ADAPTER_VERSION,
      head: raw.head && typeof raw.head === "object" ? raw.head : {},
      backfill:
        raw.backfill && typeof raw.backfill === "object"
          ? {
              complete: Boolean(raw.backfill.complete),
              cursor_chat_jid: raw.backfill.cursor_chat_jid ?? null,
              inventory: Array.isArray(raw.backfill.inventory)
                ? raw.backfill.inventory
                : [],
              chats:
                raw.backfill.chats && typeof raw.backfill.chats === "object"
                  ? raw.backfill.chats
                  : {},
            }
          : {
              complete: false,
              cursor_chat_jid: null,
              inventory: [],
              chats: {},
            },
    };
  }

  return {
    schema: "owletto.whatsapp.browser.v1",
    adapter_version: WHATSAPP_ADAPTER_VERSION,
    cutover_unix_seconds: null,
    head: {},
    backfill: {
      complete: false,
      cursor_chat_jid: null,
      inventory: [],
      chats: {},
    },
  };
}

export function buildCollectionPlan(run: {
  checkpoint?: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
}): { checkpoint: BrowserCheckpoint; request: CollectRequest } {
  const checkpoint = initializeBrowserCheckpoint(run?.checkpoint);
  const headTimestamp = finiteSeconds(checkpoint.head?.timestamp);
  const cutover = finiteSeconds(checkpoint.cutover_unix_seconds);
  const configuredMax = Number(run?.config?.max_messages_per_sync);
  const maxMessages = Number.isFinite(configuredMax)
    ? Math.max(1, Math.min(Math.trunc(configuredMax), MAX_MESSAGES_PER_RUN))
    : MAX_MESSAGES_PER_RUN;
  const configuredFilter = run?.config?.chat_filter;
  const chatFilter: ChatFilter = (
    ["all", "individual", "group"] as const
  ).includes(configuredFilter as ChatFilter)
    ? (configuredFilter as ChatFilter)
    : "all";
  return {
    checkpoint,
    request: {
      op: "collect",
      adapter_version: WHATSAPP_ADAPTER_VERSION,
      max_messages: maxMessages,
      max_chats: MAX_CHATS_PER_RUN,
      max_loads_per_chat: MAX_LOADS_PER_CHAT,
      chat_filter: chatFilter,
      recent_since:
        headTimestamp == null
          ? null
          : Math.max(0, headTimestamp - RECENT_OVERLAP_SECONDS),
      // The cutover is the last second already ingested by the connection's
      // previous source, so collect strictly after it. An inclusive floor would
      // re-read that second on every run, which is what used to justify a
      // second event shape and a media-download skip for the overlap.
      minimum_timestamp: cutover == null ? null : cutover + 1,
      backfill_disabled: cutover != null,
      backfill: checkpoint.backfill,
      budget_ms: COLLECT_BUDGET_MS,
    },
  };
}

function timestampOf(message: Record<string, any> | null | undefined): number {
  const direct = finiteSeconds(message?.timestamp);
  if (direct != null && direct > 0) return direct;
  const parsed = Date.parse(message?.occurred_at ?? "");
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

export function messageRevision(
  message: Record<string, any> | null | undefined
): string {
  const state = JSON.stringify({
    id: message?.id ?? null,
    body: message?.body ?? null,
    caption: message?.caption ?? null,
    timestamp: timestampOf(message),
    message_type: message?.message_type ?? null,
    media_kind: message?.media_kind ?? null,
    media_type: message?.media_type ?? null,
    chat_jid: message?.chat_jid ?? null,
    sender_jid: message?.sender_jid ?? null,
    participant: message?.participant ?? null,
    push_name: message?.push_name ?? null,
    from_me: Boolean(message?.from_me),
    is_group: Boolean(message?.is_group),
    edited: Boolean(message?.edited),
    edit_timestamp: message?.edit_timestamp ?? null,
    revoked: Boolean(message?.revoked),
    reactions: [...(message?.reactions ?? [])].sort((a: unknown, b: unknown) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b))
    ),
    quoted_id: message?.quoted_id ?? null,
    is_forwarded: Boolean(message?.is_forwarded),
    is_starred: Boolean(message?.is_starred),
    is_system_event: Boolean(message?.is_system_event),
  });
  let hash = 2166136261;
  for (let i = 0; i < state.length; i += 1) {
    hash ^= state.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${timestampOf(message)}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function normalizeRelayedMessage(
  message: unknown
): WhatsAppMessage | null {
  if (!message || typeof message !== "object") return null;
  const raw = message as Record<string, any>;
  const id = rawMessageId(raw.id);
  if (!id) return null;
  const timestamp = timestampOf(raw);
  if (timestamp <= 0) return null;
  const chatJid = canonicalizeJid(raw.chat_jid);
  if (
    !chatJid ||
    chatJid === "status@broadcast" ||
    chatJid.endsWith("@newsletter")
  ) {
    return null;
  }
  const senderJid = canonicalizeJid(raw.sender_jid);
  const participant = canonicalizeJid(raw.participant);
  const fromMe = Boolean(raw.from_me);
  return {
    ...raw,
    id,
    chat_jid: chatJid,
    sender_jid: fromMe ? null : senderJid,
    participant: fromMe ? participant : null,
    sender_phone: fromMe ? null : (raw.sender_phone ?? jidPhone(senderJid)),
    push_name: fromMe ? null : raw.push_name,
    is_group: chatJid.endsWith("@g.us"),
    from_me: fromMe,
    timestamp,
    occurred_at: new Date(timestamp * 1000).toISOString(),
    reactions: Array.isArray(raw.reactions)
      ? [...raw.reactions].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b))
        )
      : [],
  };
}

/**
 * Merge the freshly collected model with any durable rows. The extension fed
 * its IndexedDB outbox in here; the connector has no background observer, so
 * `durable` is empty in the live path and non-empty only in tests. The ordering
 * contract is unchanged: the freshly reconciled WhatsApp model is authoritative
 * and a durable row may never replace current state.
 */
export function mergeCollectedMessages(
  messages: unknown[] | null | undefined,
  durable: Array<{ message?: unknown } | unknown> | null | undefined,
  minimumTimestamp: number | null = null
): WhatsAppMessage[] {
  const byId = new Map<string, WhatsAppMessage>();
  const accept = (raw: unknown) => {
    const message = normalizeRelayedMessage(raw);
    if (!message) return;
    if (minimumTimestamp != null && message.timestamp < minimumTimestamp)
      return;
    byId.set(message.id, message);
  };
  for (const entry of durable ?? [])
    accept((entry as { message?: unknown })?.message ?? entry);
  for (const message of messages ?? []) accept(message);
  return [...byId.values()].sort(
    (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)
  );
}

export function mergeBrowserCheckpoint(
  base: Record<string, unknown> | null | undefined,
  result: Partial<CollectResponse> | null | undefined,
  messages: WhatsAppMessage[]
): BrowserCheckpoint {
  const checkpoint = initializeBrowserCheckpoint(base);
  let headTimestamp = finiteSeconds(checkpoint.head?.timestamp) ?? 0;
  let headId = checkpoint.head?.id ?? null;
  for (const message of messages) {
    if (
      message.timestamp > headTimestamp ||
      (message.timestamp === headTimestamp && message.id > (headId ?? ""))
    ) {
      headTimestamp = message.timestamp;
      headId = message.id;
    }
  }
  const updates = result?.backfill?.chats ?? {};
  return {
    ...checkpoint,
    head: { timestamp: headTimestamp, id: headId },
    backfill: {
      complete: Boolean(
        result?.backfill?.complete ?? checkpoint.backfill.complete
      ),
      cursor_chat_jid:
        result?.backfill?.cursor_chat_jid ??
        checkpoint.backfill.cursor_chat_jid ??
        null,
      inventory: Array.isArray(result?.backfill?.inventory)
        ? result.backfill.inventory
        : checkpoint.backfill.inventory,
      chats: { ...checkpoint.backfill.chats, ...updates },
    },
    last_run_at: new Date().toISOString(),
  };
}

/**
 * A `body` that is really a base64 image, not text.
 *
 * WhatsApp's `Msg.body` carries the message text for a text row and the base64
 * JPEG **thumbnail** for a row that carries media — the user's own words live
 * in `caption`. Nothing on the row distinguishes the two: measured on a live
 * tab (937 loaded messages) `body` held a base64 JPEG on 1/22 images, 1/7
 * videos and 2/2 `interactive` cards, all with `media_kind` telling us nothing
 * about it (`null` on the cards). So match what we are rejecting — the base64
 * prefixes of the three formats WhatsApp thumbnails use — rather than guess
 * from the message type and risk dropping a text row's real text.
 */
function isInlineThumbnail(body: string): boolean {
  return (
    body.length > 64 && /^(\/9j\/|iVBORw0KGgo|UklGR)/.test(body)
  );
}

export function messagePayloadText(message: WhatsAppMessage): string {
  const body =
    typeof message.body === "string" &&
    message.body.length > 0 &&
    !isInlineThumbnail(message.body)
      ? message.body
      : "";
  const text =
    body ||
    (typeof message.caption === "string" && message.caption.length > 0
      ? message.caption
      : "");
  if (message.revoked) return "[revoked message]";
  if (text) return text;
  if (message.is_system_event) return "[system event]";
  const kind = message.media_kind ?? message.media_type ?? message.message_type;
  if (kind === "ptt" || kind === "audio") return "[voice note]";
  if (kind === "image") return "[image]";
  if (kind === "video") return "[video]";
  if (kind === "document") return "[document]";
  if (kind === "sticker") return "[sticker]";
  return "[system event]";
}

export function messageTitle(message: WhatsAppMessage): string {
  const chatLabel = message.chat_name || message.chat_jid || "WhatsApp";
  if (message.from_me) return `→ ${chatLabel}`;
  if (message.is_group && message.push_name)
    return `${chatLabel}: ${message.push_name}`;
  return chatLabel;
}

/**
 * The extension's `toFeedItem`, retargeted onto `EventEnvelope`. Field mapping:
 * `id` → `origin_id`, `payload_text`/`title`/`semantic_type`/`metadata`/
 * `attachments` carry over unchanged, and `occurred_at` becomes a `Date`.
 */
export function toEventEnvelope(
  message: WhatsAppMessage,
  mediaResult:
    | MediaRecord
    | { status: MediaStatus; retryable?: boolean }
    | undefined
): EventEnvelope {
  const metadata: Record<string, unknown> = {
    source: WHATSAPP_SOURCE,
    origin_id: message.id,
    chat_jid: message.chat_jid,
    is_group: Boolean(message.is_group),
    from_me: Boolean(message.from_me),
  };
  for (const [key, value] of Object.entries({
    participant: message.participant,
    sender_jid: message.sender_jid,
    sender_phone: message.sender_phone,
    push_name: message.push_name,
    media_type: message.media_kind ?? message.media_type,
    quoted_id: message.quoted_id,
    edit_timestamp: message.edit_timestamp,
    reactions:
      Array.isArray(message.reactions) && message.reactions.length > 0
        ? message.reactions
        : undefined,
  })) {
    if (value !== undefined && value !== null && value !== "")
      metadata[key] = value;
  }
  if (message.is_forwarded) metadata.is_forwarded = true;
  if (message.is_starred) metadata.is_starred = true;
  if (message.is_system_event) metadata.is_system_event = true;
  if (message.edited) metadata.edited = true;
  if (message.revoked) metadata.revoked = true;
  if (!message.from_me && !message.is_group) {
    metadata.is_direct_inbound = true;
  }
  if (mediaResult?.status) metadata.media_status = mediaResult.status;
  const mediaKind = message.media_kind ?? message.message_type;
  if (
    (mediaKind === "audio" || mediaKind === "ptt") &&
    mediaResult?.status &&
    mediaResult.status !== "downloaded"
  ) {
    metadata.voice_note_skipped =
      mediaResult.status === "too_large" ? "too_large" : "not_downloaded";
  }

  const attachment = (mediaResult as MediaRecord | undefined)?.attachment;
  return {
    origin_id: message.id,
    origin_type: "message",
    title: messageTitle(message),
    payload_text: messagePayloadText(message),
    occurred_at: new Date(message.occurred_at),
    semantic_type: "message",
    metadata,
    ...(attachment ? { attachments: [attachment] } : {}),
  };
}

export function isMediaEligible(
  message: Record<string, any> | null | undefined
): boolean {
  const kind = message?.media_kind ?? message?.message_type;
  const mime: string = message?.media_type ?? "";
  return (
    kind === "image" ||
    kind === "video" ||
    kind === "document" ||
    kind === "sticker" ||
    kind === "ptt" ||
    kind === "audio" ||
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    mime === "application/pdf"
  );
}
