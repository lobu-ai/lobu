/**
 * Source ingress for connector-transport chat (WhatsApp Web).
 *
 * A paired device delivers message REFERENCES, never bodies. When a reference
 * may be answered by a reply Automation, the source delivery commits one job
 * (`runs/chat-ingress-jobs.ts`) with its receipt. This worker turns that job
 * into at most one admitted chat message:
 *
 *   1. jobs of one connection run in source order;
 *   2. the connection is hydrated from its CURRENT row (status, owner, and the
 *      connector still declaring a reply-capable event);
 *   3. the candidate Automations must still be authorized source subscribers;
 *   4. the message is read through the live feed read as one of them, so the
 *      source-read authorization, device dispatch and scrubbing all apply;
 *   5. the platform names the row's chat, and turns it into a chat message
 *      unless nothing should answer it (own, system, revoked, broadcast);
 *   6. the hydrated message is matched again per Automation (its first
 *      matching trigger wins); background targets are queued on the source
 *      signal, and a group reply needs an Automation scoped to that group;
 *   7. a message sent before a reply Automation's latest database update
 *      gets no reply from it (a device replays older references when a feed
 *      is subscribed again);
 *   8. the bridge runs its normal reply path for the one reply Automation
 *      that answers it (the oldest that matches),
 *      and every post it makes for the message (a command's confirmation, a
 *      notice) goes through the platform's keyed send, so a retried job
 *      adopts the first send instead of dispatching another.
 *
 * It never goes through `chat.processMessage`: the Chat SDK writes its dedupe
 * marker before handling, so a failed attempt's retry would be dropped.
 */

import { createLogger } from "@lobu/core";
import {
  dispatchAutomationRunsBestEffort,
  findMatchingAutomationActivations,
  planAutomationActivations,
  queueAutomationActivations,
} from "../../automations/activation.js";
import { getDb, pgBigintArray } from "../../db/client.js";
import { readSourceFeed } from "../../lib/connector-pushdown.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { CHAT_SOURCE_INGRESS_QUEUE, type ChatSourceIngressJob } from "../../runs/chat-ingress-jobs.js";
import { sourceFeedSubscriptions } from "../../runs/source-feed-subscriptions.js";
import type { QueueJob } from "../infrastructure/queue/types.js";
import type { ChatInstanceManager } from "./chat-instance-manager.js";
import { getResponseStrategy } from "./platform-strategies/index.js";
import { getPlatformDescriptor } from "./platforms/index.js";
import { resolveChatTarget } from "./platforms/shared.js";

const logger = createLogger("chat-source-ingress");
const SOURCE_READ_TIMEOUT_MS = 60_000;

export async function handleChatSourceIngress(
  manager: ChatInstanceManager,
  job: QueueJob<ChatSourceIngressJob>,
): Promise<void> {
  const { organizationId, connectionId, feedId, signal } = job.data;
  const sql = getDb();
  // Source order: a message waits until every older one on its connection has
  // been admitted or dead-lettered. The deferral spends no attempt.
  const [older] = await sql`
    SELECT 1 FROM runs
    WHERE connection_id = ${connectionId} AND run_type = 'internal'
      AND queue_name = ${CHAT_SOURCE_INGRESS_QUEUE} AND id < ${Number(job.id)}
      AND status IN ('pending', 'claimed', 'running')
    LIMIT 1
  `;
  if (older) {
    throw Object.assign(new Error("An older message on this connection is still being admitted"), { deferral: true });
  }

  await orgContext.run({ organizationId }, async () => {
    const runtimeId = String(connectionId);
    if (!(await manager.warmConnection(runtimeId))) {
      logger.info({ connectionId }, "Chat source ingress: connection is not an active chat transport; dropping");
      return;
    }
    const instance = manager.getInstance(runtimeId);
    const descriptor = instance && getPlatformDescriptor(instance.connection.platform);
    if (!instance || !descriptor?.parseSourceMessage) return;

    const subscribed = new Set(
      (await sourceFeedSubscriptions(sql, organizationId, feedId)).map((s) => s.automationId),
    );
    const candidates = job.data.automationIds.filter((id) => subscribed.has(id));
    if (candidates.length === 0) return;

    const read = await readSourceFeed({
      scope: { organizationId, principal: null },
      automationId: candidates[0],
      feedId,
      query: `id:${signal.resource_ref}`,
      limit: 1,
      deadlineAt: Date.now() + SOURCE_READ_TIMEOUT_MS,
    });
    const row = read.rows.find((candidate) => candidate.id === signal.resource_ref);
    // The reference can arrive before the device's history has the message;
    // the queue retries, and dead-letters a message that never appears.
    if (!row) throw new Error(`Source message ${signal.resource_ref} is not readable`);

    const adapter = instance.chat.getAdapter(instance.connection.platform);
    const parsed = descriptor.parseSourceMessage(adapter, row);
    const message = parsed?.message ?? null;
    // A message nothing answers still activates background triggers on its chat.
    const hydrated = parsed
      ? {
          ...signal,
          attributes: {
            channel_id: parsed.channelId,
            ...(message ? { user_id: message.author.userId } : {}),
          },
        }
      : signal;
    const plan = planAutomationActivations(
      hydrated,
      (await findMatchingAutomationActivations(organizationId, hydrated, sql))
        .filter((match) => candidates.includes(match.automationId)),
    );
    // Each activation commits in its own transaction (lock, cooldown, run),
    // and is queued once per delivery id, so a retried job does not queue again.
    await dispatchAutomationRunsBestEffort(
      await queueAutomationActivations({ signal, matches: plan.backgroundTargets }),
    );
    if (!parsed || !message) return;
    const thread = await resolveChatTarget(instance.chat, instance.connection.platform, {
      channelId: message.threadId,
      responseThreadId: message.threadId,
      currentMessage: message,
    });
    if (!thread) throw new Error(`Could not open chat thread ${message.threadId}`);

    const eligible = plan.replyTargets.filter((target) =>
      thread.isDM === true || target.trigger.match?.channel_id === parsed.channelId);
    if (eligible.length === 0 || !signal.occurred_at) return;
    const current = new Set(
      (await sql<{ id: number | string }>`
        SELECT id FROM automations
        WHERE id = ANY(${pgBigintArray(eligible.map((target) => target.automationId))}::bigint[])
          AND updated_at <= ${signal.occurred_at}::timestamptz
      `).map((row) => Number(row.id)),
    );
    // One reply Automation answers a message: the oldest that matches. A
    // retry then re-admits that one target and nothing else.
    const [replyTarget] = eligible
      .filter((target) => current.has(target.automationId))
      .sort((a, b) => a.automationId - b.automationId);
    if (!replyTarget) return;
    const post = getResponseStrategy(instance.connection.platform).post;
    const ctx = {
      connectionId: runtimeId,
      instance,
      channelId: thread.id,
      platform: instance.connection.platform,
    };
    const keyedThread = post
      ? new Proxy(thread, {
          get: (target, prop) => {
            if (prop === "post") {
              return (content: unknown) =>
                post({ ctx, threadId: target.id, messageId: message.id, content });
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : thread;
    await instance.messageBridge.handleAdmittedSourceMessage(keyedThread, message, {
      signal: hydrated,
      replyTargets: [replyTarget],
      backgroundTargets: [],
    });
  });
}
