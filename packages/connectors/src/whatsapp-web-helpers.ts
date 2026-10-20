/**
 * Transport-neutral helpers for the WhatsApp Web connector.
 *
 * They are deliberately free of WhatsApp private APIs — the unstable
 * MAIN-world surface lives in `whatsapp-web-adapter.js` and is injected into
 * the page. Everything here runs in the connector-worker and shapes the rows
 * that live reads and searches return. These helpers do not ingest events.
 */

import {
  normalizeWhatsAppUserJid,
  WHATSAPP_GROUP_SUFFIX,
  WHATSAPP_LEGACY_PHONE_SERVER,
  WHATSAPP_PHONE_SERVER,
} from "./whatsapp-web-identity.js";

export const WHATSAPP_ADAPTER_VERSION = 26;
export const WHATSAPP_ORIGIN = "https://web.whatsapp.com";

export type ChatFilter = "all" | "individual" | "group";

/** A message after `normalizeRelayedMessage` — every field the port relies on. */
export interface WhatsAppMessage {
  id: string;
  chat_jid: string;
  chat_name?: string | null;
  sender_jid: string | null;
  sender_phone: string | null;
  push_name?: string | null;
  is_group: boolean;
  from_me: boolean;
  timestamp: number;
  occurred_at: string;
  body?: string | null;
  caption?: string | null;
  message_type?: string | null;
  media_kind?: string | null;
  media_type?: string | null;
  quoted_id?: string | null;
  /** The message @mentions the account or quotes one of its messages. */
  mentions_me?: boolean;
  edited?: boolean;
  edit_timestamp?: number | null;
  revoked?: boolean;
  is_forwarded?: boolean;
  is_starred?: boolean;
  is_system_event?: boolean;
  [key: string]: unknown;
}

/** Reference-only observation position in WhatsApp's own local message store. */
export interface ObservationCheckpoint {
  observation?: { after: number; started_at: number; chat_filter: ChatFilter };
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
  // A strict person JID normalizes through the identity module (legacy
  // `@c.us` spelling, multi-device suffixes); chats, groups, broadcasts and
  // newsletters are not user keys and pass through in canonical case.
  const user = normalizeWhatsAppUserJid(value);
  if (user) return user;
  const jid = value.trim().toLowerCase();
  if (!jid?.includes("@")) return null;
  if (jid.endsWith(`@${WHATSAPP_LEGACY_PHONE_SERVER}`))
    return `${jid.slice(0, -WHATSAPP_LEGACY_PHONE_SERVER.length - 1)}@${WHATSAPP_PHONE_SERVER}`;
  return jid;
}

function jidPhone(jid: unknown): string | null {
  if (typeof jid !== "string") return null;
  const user = normalizeWhatsAppUserJid(jid);
  if (!user || !user.endsWith(`@${WHATSAPP_PHONE_SERVER}`)) return null;
  return user.slice(0, -WHATSAPP_PHONE_SERVER.length - 1);
}

function finiteSeconds(value: unknown): number | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function timestampOf(message: Record<string, any> | null | undefined): number {
  const direct = finiteSeconds(message?.timestamp);
  if (direct != null && direct > 0) return direct;
  const parsed = Date.parse(message?.occurred_at ?? "");
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
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
  const fromMe = Boolean(raw.from_me);
  // Retired history-sync fields must not survive through the raw-field spread.
  const { participant: _droppedParticipant, reactions: _droppedReactions, ...rest } = raw;
  return {
    ...rest,
    id,
    chat_jid: chatJid,
    sender_jid: fromMe ? null : senderJid,
    sender_phone: fromMe ? null : (raw.sender_phone ?? jidPhone(senderJid)),
    push_name: fromMe ? null : raw.push_name,
    is_group: chatJid.endsWith(WHATSAPP_GROUP_SUFFIX),
    from_me: fromMe,
    timestamp,
    occurred_at: new Date(timestamp * 1000).toISOString(),
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

const MEDIA_PLACEHOLDERS: Record<string, string> = {
  ptt: "[voice note]",
  audio: "[voice note]",
  image: "[image]",
  video: "[video]",
  document: "[document]",
  sticker: "[sticker]",
};

function messageBodyText(message: WhatsAppMessage): string {
  const body =
    typeof message.body === "string" &&
    message.body.length > 0 &&
    !isInlineThumbnail(message.body)
      ? message.body
      : "";
  return (
    body ||
    (typeof message.caption === "string" && message.caption.length > 0
      ? message.caption
      : "")
  );
}

function mediaKind(message: WhatsAppMessage): string {
  return String(message.media_kind ?? message.media_type ?? message.message_type ?? "");
}

/**
 * What a message carries, decided from its fields rather than from the
 * placeholder text `messagePayloadText` renders for it: readers that must
 * not answer a revocation or a bare image key on this.
 */
export type MessageContentKind = "text" | "media" | "revoked" | "system";

export function messageContentKind(message: WhatsAppMessage): MessageContentKind {
  if (message.revoked) return "revoked";
  if (message.is_system_event) return "system";
  if (messageBodyText(message)) return "text";
  return Object.hasOwn(MEDIA_PLACEHOLDERS, mediaKind(message)) ? "media" : "system";
}

export function messagePayloadText(message: WhatsAppMessage): string {
  switch (messageContentKind(message)) {
    case "revoked":
      return "[revoked message]";
    case "text":
      return messageBodyText(message);
    case "media":
      return MEDIA_PLACEHOLDERS[mediaKind(message)];
    default:
      return messageBodyText(message) || "[system event]";
  }
}

export function messageTitle(message: WhatsAppMessage): string {
  const chatLabel = message.chat_name || message.chat_jid || "WhatsApp";
  if (message.from_me) return `→ ${chatLabel}`;
  if (message.is_group && message.push_name)
    return `${chatLabel}: ${message.push_name}`;
  return chatLabel;
}
