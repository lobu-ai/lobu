/**
 * Authorization for the native conversation tools (list/read/send).
 *
 * The governing principle (pi review): **an agent never addresses a platform
 * resource directly — it addresses a Lobu binding.** Tools hand the model
 * opaque `handle`s from `list_conversations`; `read`/`send` only accept those
 * handles, and the server re-resolves each handle against the agent's CURRENT
 * authorized set on every call. So a worker cannot pass a raw channel id to
 * reach another tenant's channel, and a revoked binding stops working
 * immediately (no cached grant).
 *
 * Authorization boundary (v1): an agent may read+post to any channel it is
 * subscribed to through an Automation, including the hosted-preview cross-org
 * case where the binding lives under the agent's org but is served by a shared
 * preview connection in another org. Proactive DMs are intentionally NOT in v1
 * (highest-abuse surface; needs per-user opt-out) — the `kind` union leaves the
 * seam.
 */
import type { DbClient } from "../../db/client.js";
import { getDb } from "../../db/client.js";
import {
  resolveBoundChannelRows,
  stripPlatformPrefix,
} from "../channels/bound-channels.js";

export type ConversationKind = "channel" | "dm";

export interface AddressableTarget {
  /** Opaque, re-validated every call. Never a raw platform id. */
  handle: string;
  kind: ConversationKind;
  platform: string;
  /** Chat SDK connection that owns the post (preview conn for cross-org). */
  connectionId: string;
  /** Stored `connections.id` of that connection. */
  connectionDbId: number;
  /**
   * Served by another org's hosted-preview connection. Such a binding may carry
   * a reply, never a post elsewhere: the operation run that gates one belongs
   * to the connection's org, not the agent's.
   */
  crossOrg: boolean;
  /** Platform-native (unprefixed) channel id. */
  channelId: string;
  /** `${platform}:${channelId}` for postMessageToChannel. */
  channelKey: string;
  teamId?: string;
  /** Human label (channel id today; channel name once we resolve it). */
  label?: string;
}

const CHANNEL_PREFIX = "c_";
const THREAD_PREFIX = "t_";

function encodeChannelHandle(platform: string, channelId: string): string {
  return (
    CHANNEL_PREFIX +
    Buffer.from(`${platform}:${channelId}`, "utf8").toString("base64url")
  );
}

/**
 * A thread handle returned by `send_message` so a later run can reply into the
 * same thread. It encodes the channel coordinates + the root message id; the
 * CHANNEL is the authorization fence (re-validated every call), so the root id
 * within an already-authorized channel is harmless to forge.
 */
function encodeThreadHandle(
  platform: string,
  channelId: string,
  rootMessageId: string
): string {
  return (
    THREAD_PREFIX +
    Buffer.from(`${platform}:${channelId}:${rootMessageId}`, "utf8").toString(
      "base64url"
    )
  );
}

interface DecodedHandle {
  kind: ConversationKind;
  platform: string;
  id: string;
}

/** Decode an opaque handle into its coordinates. Returns null if malformed. */
function decodeHandle(handle: string): DecodedHandle | null {
  if (!handle.startsWith(CHANNEL_PREFIX)) return null;
  try {
    const decoded = Buffer.from(
      handle.slice(CHANNEL_PREFIX.length),
      "base64url"
    ).toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx <= 0) return null;
    return {
      kind: "channel",
      platform: decoded.slice(0, idx),
      id: decoded.slice(idx + 1),
    };
  } catch {
    return null;
  }
}

/**
 * Every channel this agent may read+post to, in binding-creation order.
 * Resolution (incl. the hosted-preview cross-org case) lives in the shared
 * `resolveBoundChannelRows`; this layer only adds the opaque handles.
 */
export async function resolveAddressableTargets(
  agentId: string,
  organizationId: string,
  sql: DbClient = getDb()
): Promise<AddressableTarget[]> {
  const rows = await resolveBoundChannelRows(sql, { organizationId, agentId });

  return rows.map((row) => {
    const channelId = stripPlatformPrefix(row.platform, row.channel_id);
    return {
      handle: encodeChannelHandle(row.platform, channelId),
      kind: "channel" as const,
      platform: row.platform,
      connectionId: row.id,
      connectionDbId: Number(row.connection_db_id),
      crossOrg: row.cross_org === true,
      channelId,
      channelKey: `${row.platform}:${channelId}`,
      ...(row.team_id ? { teamId: row.team_id } : {}),
      label: channelId,
    };
  });
}

/**
 * Resolve ONE handle to a target the agent is currently authorized for, or null
 * if the handle is malformed, forged, or its binding has been revoked. Always
 * re-derives the live set — no cached grant survives an unlink.
 */
export async function resolveAuthorizedTarget(
  agentId: string,
  organizationId: string,
  handle: string,
  sql: DbClient = getDb()
): Promise<AddressableTarget | null> {
  if (!decodeHandle(handle)) return null;
  const targets = await resolveAddressableTargets(agentId, organizationId, sql);
  return targets.find((t) => t.handle === handle) ?? null;
}

interface AuthorizedThread {
  target: AddressableTarget;
  /** Platform-native thread id, e.g. `slack:{channel}:{root_ts}`. */
  threadId: string;
}

/**
 * Resolve a thread handle to the authorized channel it belongs to + the
 * platform thread id to post into. Re-checks channel membership (a revoked
 * binding kills the thread handle too). Returns null if malformed/forged.
 */
export async function resolveAuthorizedThread(
  agentId: string,
  organizationId: string,
  threadHandle: string,
  sql: DbClient = getDb()
): Promise<AuthorizedThread | null> {
  if (!threadHandle.startsWith(THREAD_PREFIX)) return null;
  let platform: string;
  let channelId: string;
  let rootMessageId: string;
  try {
    const decoded = Buffer.from(
      threadHandle.slice(THREAD_PREFIX.length),
      "base64url"
    ).toString("utf8");
    const parts = decoded.split(":");
    if (parts.length !== 3 || parts.some((p) => !p)) return null;
    [platform, channelId, rootMessageId] = parts;
  } catch {
    return null;
  }

  const channelHandle = encodeChannelHandle(platform, channelId);
  const target = await resolveAuthorizedTarget(
    agentId,
    organizationId,
    channelHandle,
    sql
  );
  if (!target) return null;

  return {
    target,
    threadId: `${platform}:${channelId}:${rootMessageId}`,
  };
}

/** Build the thread handle for a just-posted message (consumed by `send`). */
export function threadHandleForMessage(
  target: AddressableTarget,
  messageId: string
): string {
  return encodeThreadHandle(target.platform, target.channelId, messageId);
}
