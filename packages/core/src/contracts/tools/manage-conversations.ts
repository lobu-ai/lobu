import { type Static, Type } from "@sinclair/typebox";
import type { ActionInput } from "./action-input";

// ============================================
// Schema
// ============================================

const AgentId = Type.String({
  description: 'Target agent id (lowercase slug, e.g. "researcher").',
});

// The wire schema flattens this union into ONE MCP object and merges duplicate
// properties first-occurrence-wins, so a property carried by more than one
// variant must read true for every one of them.
const ConversationId = Type.String({
  description:
    "The stored conversation id. Required for `get`; optional for `send`, " +
    "where it resumes that exact web conversation and wins over `thread` " +
    "(omit it to target the caller's default web thread).",
});

export const ListConversationsAction = Type.Object({
  action: Type.Literal("list", {
    description: "List an agent's conversations, newest-first.",
  }),
  agent_id: AgentId,
});

export const GetConversationAction = Type.Object({
  action: Type.Literal("get", {
    description:
      "Fetch one conversation by id, optionally scoped to a platform.",
  }),
  agent_id: AgentId,
  platform: Type.Optional(
    Type.String({
      description:
        'Conversation platform ("web" for app-owned conversations, or a channel platform like "slack"). When omitted, resolves a unique active match for this agent across platforms; ambiguous ids return not found.',
    })
  ),
  conversation_id: ConversationId,
});

export const SendConversationMessageAction = Type.Object({
  action: Type.Literal("send", {
    description:
      "Send a message to an agent conversation and (by default) return its reply. " +
      "Runs the turn against the conversation's pinned sandbox realm.",
  }),
  agent_id: AgentId,
  conversation_id: Type.Optional(ConversationId),
  thread: Type.Optional(
    Type.String({
      description:
        "Optional web thread name. Distinct threads keep separate history + separate pinned sandbox. Omit for the default thread.",
    })
  ),
  text: Type.String({ description: "Message text to deliver to the agent." }),
  model: Type.Optional(
    Type.String({
      description:
        "Optional per-message model override as a `provider/model` ref. Wins over the agent/org default.",
    })
  ),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "When true (default), block until the agent's turn completes and return its reply. " +
        "When false, enqueue and return immediately with the message id.",
    })
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description:
        "[wait=true] Max time to wait for the reply. Default 45000, capped at 170000 — " +
        "kept inside run_sdk's own wall-clock budget so a no-reply call returns a graceful " +
        'status:"timeout" instead of aborting the whole script. For a longer wait, raise BOTH ' +
        "this and the run_sdk/query_sdk timeout_ms. On timeout the turn keeps running (the answer " +
        "is not lost); the reply is not retrievable through `get`.",
      minimum: 1000,
      maximum: 170_000,
    })
  ),
});

export const ManageConversationsSchema = Type.Union([
  ListConversationsAction,
  GetConversationAction,
  SendConversationMessageAction,
]);

// ============================================
// Type Definitions
// ============================================

export type ManageConversationsArgs = Static<typeof ManageConversationsSchema>;

export type ConversationListInput = ActionInput<
  ManageConversationsArgs,
  "list"
>;
export type ConversationGetInput = ActionInput<ManageConversationsArgs, "get">;
export type ConversationSendInput = ActionInput<
  ManageConversationsArgs,
  "send"
>;

/** One conversation as surfaced by list/get. */
export interface ConversationRecord {
  platform: string;
  conversation_id: string;
  /** "owned" (an app/web thread) or "platform" (an external channel). */
  kind: "owned" | "platform";
  user_id: string | null;
  title: string | null;
  last_activity_at: string;
  created_at: string;
}

export type ManageConversationsResult =
  | { action: "list"; conversations: ConversationRecord[] }
  | { action: "get"; conversation: ConversationRecord }
  | {
      // wait=false, or wait=true that timed out before completion.
      action: "send";
      conversation_id: string;
      message_id: string;
      status: "queued" | "timeout";
    }
  | {
      // wait=true and the turn reached a terminal state.
      action: "send";
      conversation_id: string;
      message_id: string;
      status: "complete" | "error";
      /** The agent's final reply text (status="complete"). */
      reply?: string;
      /** The terminal error message (status="error"). */
      error?: string;
    };
