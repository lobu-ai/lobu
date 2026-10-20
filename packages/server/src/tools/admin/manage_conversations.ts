/**
 * Tool: manage_conversations
 *
 * Read an agent's conversations and drive a turn against one.
 *
 * Actions:
 * - list: List an agent's conversations, newest-first (the materialized
 *   `conversations` entity — the same source the sidebar reads).
 * - get:  Fetch one conversation by id, optionally scoped to a platform.
 * - send: Enqueue a message to an agent conversation and, by default, block
 *   until the turn completes and return its reply. `wait:false` returns
 *   immediately with the message id (fire-and-forget).
 *
 * `send` targets the app-owned `web` realm: it builds the API conversation id
 * (`{agent}_{user}_{org}[_{thread}]`) and enqueues a `platform: "api"` payload,
 * exactly like the web panel's `POST /messages` and the scheduled-job wake. The
 * per-conversation sandbox pin (message-consumer → resolvePinnedSelection) then
 * freezes/reuses this conversation's runtime realm — the SDK caller never picks
 * a sandbox; the pin does. The reply is read from the durable `runs`
 * thread-response rows (cross-replica-safe), never a pod-local SSE buffer.
 */

import { randomUUID } from "node:crypto";
import {
  GetConversationAction,
  ListConversationsAction,
  ManageConversationsSchema,
  SendConversationMessageAction,
} from "@lobu/core/contracts/tools/manage-conversations";
import type { Static } from "@sinclair/typebox";
import { createDbClientFromEnv } from "../../db/client";
import { buildApiConversationId } from "../../gateway/services/api-conversation-id";
import {
  type ConversationListRow,
  getConversation,
  listConversations,
  readConversationReply,
} from "../../gateway/services/conversations-store";
import {
  buildMessagePayload,
  resolveAgentOptions,
} from "../../gateway/services/platform-helpers";
import { runOutputGuardrailScan } from "../../gateway/guardrails/output-scan";
import type { Env } from "../../index";
import { getLobuCoreServices } from "../../lobu/gateway";
import { ToolUserError } from "../../utils/errors";
import { isAdminOrOwnerRole } from "../access-control";
import type { ToolContext } from "../registry";
import { action, defineActionTool } from "./action-tool";

export { ManageConversationsSchema };

// run_sdk's DEFAULT wall-clock budget is 60000ms and it starts BEFORE this
// script compiles + dispatches — so a send default equal to it would trip
// run_sdk's own TimeoutError before send could return a graceful
// status:"timeout". Default strictly inside that budget (leaving ~15s of
// headroom for compile/dispatch/return). A caller who wants a longer wait must
// raise BOTH send's timeout_ms AND run_sdk's timeout_ms (max 180000); the cap
// here (170000) stays inside run_sdk's max so a maxed send can still return.
const DEFAULT_WAIT_TIMEOUT_MS = 45_000;
const MAX_WAIT_TIMEOUT_MS = 170_000;
const POLL_INTERVAL_MS = 1_000;

function serializeRow(r: ConversationListRow) {
  return {
    platform: r.platform,
    conversation_id: r.conversationId,
    kind: r.kind,
    user_id: r.userId,
    title: r.title,
    last_activity_at: r.lastActivityAt.toISOString(),
    created_at: r.createdAt.toISOString(),
  };
}

/** Assert the agent exists in this org before listing/sending against it. */
async function assertAgentInOrg(
  agentId: string,
  ctx: ToolContext,
  env: Env,
): Promise<void> {
  const sql = createDbClientFromEnv(env);
  const rows = await sql`
    SELECT 1 FROM agents
    WHERE organization_id = ${ctx.organizationId} AND id = ${agentId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    throw new ToolUserError(`Agent "${agentId}" not found`, 404);
  }
}

async function handleList(
  args: Static<typeof ListConversationsAction>,
  ctx: ToolContext,
  env: Env,
) {
  // A conversation listing exposes titles (message content). Require an
  // authenticated caller — an anonymous public read must not enumerate them.
  if (!ctx.userId) {
    throw new ToolUserError(
      "list requires an authenticated caller",
      401,
    );
  }
  await assertAgentInOrg(args.agent_id, ctx, env);
  // Scope from ROLE, not merely "has a userId": an admin/owner sees every
  // conversation; a plain member sees only their own owned threads. (Deriving
  // scope from `ctx.userId` alone inverted this — an admin was limited to their
  // own rows while a null-userId caller saw all.)
  const scope = isAdminOrOwnerRole(ctx.memberRole) ? "admin" : "user";
  const conversations = await listConversations({
    organizationId: ctx.organizationId,
    agentId: args.agent_id,
    scope,
    userId: ctx.userId,
  });
  return {
    action: "list" as const,
    conversations: conversations.map(serializeRow),
  };
}

async function handleGet(
  args: Static<typeof GetConversationAction>,
  ctx: ToolContext,
  env: Env,
) {
  if (!ctx.userId) {
    throw new ToolUserError("get requires an authenticated caller", 401);
  }
  await assertAgentInOrg(args.agent_id, ctx, env);
  const platform = args.platform?.toLowerCase();
  const row = await getConversation({
    organizationId: ctx.organizationId,
    agentId: args.agent_id,
    platform,
    conversationId: args.conversation_id,
  });
  // A non-admin may read only their OWN owned (web) conversation. A platform
  // conversation, or another user's web thread, is not theirs to fetch — 404
  // (not 403) so the response can't be used to probe which ids exist.
  const isAdmin = isAdminOrOwnerRole(ctx.memberRole);
  const ownedByCaller = row?.kind === "owned" && row.userId === ctx.userId;
  if (!row || (!isAdmin && !ownedByCaller)) {
    throw new ToolUserError(
      `Conversation "${args.conversation_id}" not found for agent "${args.agent_id}"`,
      404,
    );
  }
  return { action: "get" as const, conversation: serializeRow(row) };
}

/** Abort-aware sleep so a wait-loop unblocks the instant the script times out. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function handleSend(
  args: Static<typeof SendConversationMessageAction>,
  ctx: ToolContext,
  env: Env,
) {
  const text = args.text;
  if (!text.trim()) {
    throw new ToolUserError("text must not be blank for send action");
  }
  if (!ctx.userId) {
    throw new ToolUserError(
      "send requires an authenticated caller (the conversation is bound to the caller's user id)",
    );
  }
  await assertAgentInOrg(args.agent_id, ctx, env);

  const coreServices = getLobuCoreServices();
  const queueProducer = coreServices?.getQueueProducer?.();
  if (!queueProducer) {
    throw new ToolUserError(
      "Message dispatch is unavailable in this runtime (no queue producer).",
      503,
    );
  }
  const agentSettingsStore = coreServices?.getAgentSettingsStore?.();

  const userId = ctx.userId;
  // A named thread targets/opens a distinct web conversation (own history + own
  // pinned sandbox); omitting `thread` uses the caller's default thread. When an
  // explicit conversation_id is given it resumes an exact conversation — but it
  // must be verified to belong to the caller, else a member could enqueue a turn
  // into another user's (or a platform) conversation. Without conversation_id the
  // id is DERIVED from the caller's own userId, so it is inherently theirs.
  let conversationId: string;
  if (args.conversation_id) {
    const target = await getConversation({
      organizationId: ctx.organizationId,
      agentId: args.agent_id,
      platform: "web",
      conversationId: args.conversation_id,
    });
    // send is caller-attributed: the enqueued payload stamps userId=ctx.userId
    // and channelId=api_<caller>. So the target MUST be the caller's OWN owned
    // web conversation — NO admin bypass (unlike `get`, an admin has no reason to
    // WRITE a self-attributed turn into another user's conversation, which would
    // contaminate that user's history). A non-owned/foreign id is 404 (not 403)
    // so the id space can't be probed.
    const ownedByCaller =
      target?.kind === "owned" && target.userId === ctx.userId;
    if (!ownedByCaller) {
      throw new ToolUserError(
        `Conversation "${args.conversation_id}" not found for agent "${args.agent_id}"`,
        404,
      );
    }
    conversationId = args.conversation_id;
  } else {
    conversationId = buildApiConversationId({
      agentId: args.agent_id,
      userId,
      organizationId: ctx.organizationId,
      threadId: args.thread || undefined,
    });
  }
  const channelId = `api_${userId}`;
  const messageId = randomUUID();

  const automationModel =
    typeof args.model === "string" && args.model.trim()
      ? args.model.trim()
      : undefined;
  const agentOptions = await resolveAgentOptions(
    args.agent_id,
    {
      provider: "claude",
      model: automationModel,
    },
    agentSettingsStore,
    ctx.organizationId,
  );

  await queueProducer.enqueueMessage(
    buildMessagePayload({
      platform: "api",
      userId,
      botId: "lobu-api",
      conversationId,
      teamId: "api",
      agentId: args.agent_id,
      organizationId: ctx.organizationId,
      messageId,
      messageText: text,
      channelId,
      platformMetadata: {
        agentId: args.agent_id,
        organizationId: ctx.organizationId,
        // MUST be a HEADLESS_SOURCES value (automation-run-session.ts): an SDK
        // send opens no SSE stream, so a non-headless source makes the terminal
        // reply requeue-until-fail waiting for an SSE owner that never connects.
        // `internal` is the headless programmatic-turn source (the same default
        // agent-threads.ts uses); the reply is read back via the durable runs
        // rows (readConversationReply), not SSE.
        source: "internal",
      },
      agentOptions,
    }),
  );

  const wait = args.wait !== false;
  if (!wait) {
    return {
      action: "send" as const,
      conversation_id: conversationId,
      message_id: messageId,
      status: "queued" as const,
    };
  }

  const timeoutMs = Math.min(
    args.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS,
    MAX_WAIT_TIMEOUT_MS,
  );
  const deadline = Date.now() + timeoutMs;
  // Poll the durable runs rows for the terminal outcome. Deliberately NOT SSE:
  // the completion row is visible from any replica, so a wait-loop works even
  // when a different pod drained the deltas. Aborts at the script budget. Read
  // FIRST, then sleep only the time left to the deadline — so a reply landing
  // during the final window is still caught by the post-loop read, and a short
  // timeout (e.g. 1000ms) doesn't overshoot into a full extra POLL_INTERVAL.
  // readConversationReply reads the RAW worker-written finalText/error from the
  // runs row — the UnifiedThreadResponseConsumer's output guardrail only rewrote
  // an in-memory copy for the SSE/history path, never that persisted row. So this
  // SDK read must run the SAME output-stage scan itself, or a secret/PII the
  // agent's output guardrail blocks would leak through conversations.send. The
  // consumer scans BOTH finalText AND error (a provider/runtime error can carry
  // secrets), so scan both terminal texts here too. Fails open (returns the
  // text) on infra error, matching the renderer path.
  const guardrailRegistry = coreServices?.getGuardrailRegistry?.() ?? undefined;
  const scanTerminalText = async (text: string): Promise<string> => {
    const trip = await runOutputGuardrailScan(
      guardrailRegistry,
      agentSettingsStore,
      text,
      {
        agentId: args.agent_id,
        organizationId: ctx.organizationId,
        userId,
        conversationId,
        platform: "api",
      },
    );
    return trip
      ? `Message blocked by guardrail: ${trip.reason ?? trip.guardrail}`
      : text;
  };

  const terminal = async (
    reply: Awaited<ReturnType<typeof readConversationReply>>,
  ) => {
    if (reply?.status === "complete") {
      return {
        action: "send" as const,
        conversation_id: conversationId,
        message_id: messageId,
        status: "complete" as const,
        reply: await scanTerminalText(reply.text),
      };
    }
    if (reply?.status === "error") {
      return {
        action: "send" as const,
        conversation_id: conversationId,
        message_id: messageId,
        status: "error" as const,
        error: await scanTerminalText(reply.error),
      };
    }
    return null;
  };

  while (!ctx.abortSignal?.aborted) {
    const done = await terminal(
      await readConversationReply({
        organizationId: ctx.organizationId,
        conversationId,
        messageId,
      }),
    );
    if (done) return done;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining), ctx.abortSignal);
  }

  // Timed out (or the script's budget ran out). The turn keeps running; the
  // caller reads the reply out of band from the transcript. There is no
  // enqueue-free retrieval on this tool — calling `send` again starts a NEW
  // turn (fresh message_id), and `get` returns only conversation metadata.
  return {
    action: "send" as const,
    conversation_id: conversationId,
    message_id: messageId,
    status: "timeout" as const,
  };
}

const manageConversationsTool = defineActionTool("manage_conversations", {
  list: action(ListConversationsAction, handleList),
  get: action(GetConversationAction, handleGet),
  send: action(SendConversationMessageAction, handleSend),
});

// Access is enforced per-action by routeAction (inside the tool runner) against
// tool-access.ts: send → MEMBER_WRITE_ACTIONS (any member); list/get carry no
// write/admin entry, so they fall through to the READ tier — they are NOT
// public-readable, and the handler requires an authenticated caller because a
// listing exposes conversation titles. Do NOT re-gate here with
// requireOrg{Read,Write}Access — canWriteOrg requires owner/admin, which would
// contradict the member-tier `send` grant and reject a plain member the policy
// explicitly allows. Ownership is fenced per-handler (agent-in-org +
// user-owned conversation).
export const manageConversations = manageConversationsTool.run;
