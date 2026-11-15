/** Broker inbox provenance is independent of receiver-owned Automation links. */
import { createHash } from 'node:crypto';
import type { DbClient } from '../db/client';
import { stableJson } from '../utils/insert-event';

export function inboxSubmissionDigest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

/**
 * Normalize only original, durable inbox notifications into foreign producers.
 * The broker binds a server-reserved metadata stamp to the original event
 * origin. knowledge.save strips the _lobu_ namespace, so copying a notification
 * or superseding it cannot copy this authority. Dismissible notification targets
 * and normalized report content are not provenance. Read no foreign contents.
 */
export async function loadInboxNotificationProducer(
  organizationId: string,
  eventId: number,
  db: DbClient,
): Promise<number | null> {
  const [event] = await db<{
    semantic_type: string;
    origin_id: string;
    metadata: Record<string, unknown> | null;
  }>`SELECT e.semantic_type, e.origin_id, e.metadata
    FROM events e
    WHERE e.id = ${eventId} AND e.organization_id = ${organizationId}
      AND e.automation_id IS NULL AND e.run_id IS NULL
      AND e.connection_id IS NULL
      AND e.metadata->>'_lobu_inbox_origin_id' = e.origin_id
    LIMIT 1`;
  if (!event) return null;
  const metadata = event.metadata ?? {};
  const submission = metadata.inbox_submission;
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)) return null;
  const source = submission as Record<string, unknown>;
  if (metadata.notification_type !== 'agent_message' ||
    typeof metadata._lobu_idempotency_key !== 'string' ||
    !/^inbox:[a-f0-9]{64}$/.test(metadata._lobu_idempotency_key) ||
    typeof source.organization_id !== 'string' || !source.organization_id ||
    source.organization_id === organizationId || source.inbox !== event.semantic_type ||
    !Number.isSafeInteger(source.automation_id) || Number(source.automation_id) <= 0 ||
    !(source.run_id === null || Number.isSafeInteger(source.run_id) && Number(source.run_id) > 0) ||
    !(source.user_id === null || typeof source.user_id === 'string') ||
    !(source.agent_id === null || typeof source.agent_id === 'string')) {
    return null;
  }
  return Number(source.automation_id);
}
