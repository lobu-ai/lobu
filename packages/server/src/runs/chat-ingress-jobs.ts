import type { ConnectorTriggerSignal } from '@lobu/connector-sdk';
import type { DbClient } from '../db/client';
import { insertQueueJob } from '../gateway/infrastructure/queue/runs-queue';

/**
 * One job per source message reference that a reply Automation may answer.
 * Consumed by `gateway/connections/chat-source-ingress.ts`.
 */
export const CHAT_SOURCE_INGRESS_QUEUE = 'internal:chat-inbound';

export interface ChatSourceIngressJob {
  organizationId: string;
  connectionId: number;
  feedId: number;
  /** The source signal as delivered; background Automations already ran on it. */
  signal: ConnectorTriggerSignal;
  /** Subscribed Automations with a reply trigger this reference may satisfy. */
  automationIds: number[];
}

/**
 * Commit the job inside the caller's source-delivery transaction, together
 * with its receipt and checkpoint. A replayed reference (a lost receipt) must
 * not answer twice even after the first job finished, so a delivery id this
 * connection has seen in any state is skipped. Deliveries of one feed
 * serialize on its row lock; concurrent feeds of one connection meet on the
 * queue's in-flight unique key.
 */
export async function enqueueChatSourceIngress(tx: DbClient, job: ChatSourceIngressJob): Promise<void> {
  const key = `${CHAT_SOURCE_INGRESS_QUEUE}:${job.signal.delivery_id}`;
  const [seen] = await tx`
    SELECT 1 FROM runs
    WHERE connection_id = ${job.connectionId} AND run_type = 'internal'
      AND queue_name = ${CHAT_SOURCE_INGRESS_QUEUE} AND idempotency_key = ${key}
    LIMIT 1
  `;
  if (seen) return;
  await insertQueueJob(tx, CHAT_SOURCE_INGRESS_QUEUE, job, {
    singletonKey: key,
    connectionId: job.connectionId,
    // Covers a device read that briefly lags its own reference; a message
    // still unreadable after that is dead-lettered rather than blocking the
    // connection's later messages.
    retryLimit: 5,
  });
}
