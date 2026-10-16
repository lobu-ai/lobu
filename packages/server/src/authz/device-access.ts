/**
 * Who may use a device-pinned connection: the ONE rule for device actions
 * (`manage_operations.execute`) and live device feed reads
 * (`lib/connector-pushdown.ts`).
 *
 * A pinned connection runs on one member's own machine. Sharing it with the
 * workspace lets members use it under organization policy; it does not let a
 * chat audience the owner never chose drive their machine unattended.
 *
 * - The device owner runs it.
 * - A member acting as themselves runs it: an app or MCP session, an
 *   Automation, or the `member` chat tier (a linked member's own direct
 *   message, whose user is the sender).
 * - An `org_shared` chat turn (a vouched coworker, or a member writing in a
 *   group conversation) asks the owner first.
 * - A `public_visitor` or `reply_only` turn is refused.
 *
 * Operations also apply organization connector policy: Block wins, and Ask
 * queues a `run` decision for approval.
 */

import type { ChatTurnAccess } from "@lobu/core";

export type DeviceAccessDecision = "run" | "ask_owner" | "refuse";

export function decideDeviceAccess(args: {
  /** The verified chat tier of the turn, or null when the caller is not a chat turn. */
  chatAccess: ChatTurnAccess | null;
  /** The Lobu user the call acts as, or null for a userless call. */
  callerUserId: string | null;
  /** `device_workers.user_id` of the pinned device. */
  deviceOwnerUserId: string | null;
}): DeviceAccessDecision {
  if (args.chatAccess === "reply_only" || args.chatAccess === "public_visitor") return "refuse";
  if (args.callerUserId && args.callerUserId === args.deviceOwnerUserId) return "run";
  if (args.chatAccess === "org_shared") return "ask_owner";
  return "run";
}

/**
 * The chat tier a tool call runs with, or null when it is not a chat turn. The
 * MCP boundary (workspace/multi-tenant.ts) sets `sourceContext.chatAccess` from
 * the signed turn token through `chatTurnAccessOf`, which already turns a chat
 * token without a tier into `reply_only`. An admin-tools turn carries no tier:
 * it acts as its verified user.
 */
export function chatAccessOfToolContext(ctx: {
  sourceContext?: { chatAccess?: ChatTurnAccess } | null;
}): ChatTurnAccess | null {
  return ctx.sourceContext?.chatAccess ?? null;
}

/** Refusal for a chat turn with no workspace access (`reply_only`, `public_visitor`). */
export const DEVICE_ACCESS_REFUSED =
  "This chat cannot use a member's paired device. Ask a workspace member to run it.";

/**
 * Refusal for a live device read that would need the owner's approval. A read
 * answers synchronously, so there is no queued run for the owner to approve.
 */
export const DEVICE_READ_NEEDS_OWNER =
  "Reading this feed runs on another member's paired device, and this conversation cannot ask them " +
  "to approve a live read. Ask the device owner directly, or read it from their own direct message or the app.";
