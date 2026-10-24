import { createHash } from 'node:crypto';
import type { PollRequest } from '@lobu/core/contracts/worker/protocol';
import type { DbClient } from '../db/client';
import { matchingAutomationTriggers, referenceCaptureTriggers } from '../automations/event-trigger';
import { insertEvent } from '../utils/insert-event';
import type { SourceFeedSubscription } from './source-feed-subscriptions';

type Notice = NonNullable<PollRequest['feed_notifications']>[number];
type Reference = NonNullable<Notice['subscription']>['records'][number]['payload']['events'][number];

export class StaleSourceCheckpoint extends Error {
  constructor(readonly organizationId: string, readonly config: unknown) {
    super('Stale source checkpoint contains an unaccepted observation; rebind from the current checkpoint.');
  }
}

/** Only explicitly consented, reference-matchable subscriptions retain observations. */
export function referenceCaptureSubscriptions(subscriptions: SourceFeedSubscription[], connectorKey: string,
  connectionId: number, event: Reference): SourceFeedSubscription[] {
  return subscriptions.filter(subscription => matchingAutomationTriggers(referenceCaptureTriggers(subscription.triggers), {
      connector_key: connectorKey, connection_id: connectionId, event_type: event.event_type,
      resource_ref: event.resource_ref, resource_type: event.resource_type,
      delivery_id: event.id,
      label: `Source ${event.event_type}`, input_text: '',
    }).length > 0);
}

export function sourceReferenceOriginId(event: Reference): string {
  return `source-reference:${createHash('sha256').update(JSON.stringify([
    event.event_type, event.id,
  ])).digest('hex')}`;
}

/** Called under the owning feed lock. Resource identity never keys a mutable event head. */
export async function persistSourceReference(tx: DbClient, params: {
  organizationId: string; connectorKey: string; notice: Notice; event: Reference; principal: string | null;
  requireExisting?: boolean;
  config?: unknown;
}): Promise<void> {
  const { notice, event } = params;
  const originId = sourceReferenceOriginId(event);
  const [existing] = await tx`SELECT origin_type, semantic_type, metadata FROM events
    WHERE connection_id = ${notice.connection_id} AND origin_id = ${originId}
      AND organization_id = ${params.organizationId} LIMIT 1`;
  if (existing) {
    // A connector must never reuse one observation identity for different facts.
    if (existing.origin_type !== 'source_reference' || existing.semantic_type !== event.event_type
      || existing.metadata?.resource_ref !== event.resource_ref
      || existing.metadata?.resource_type !== (event.resource_type ?? null)) {
      throw new Error('Source observation identity was reused for a different reference.');
    }
    return;
  }
  if (params.requireExisting) throw new StaleSourceCheckpoint(params.organizationId, params.config);
  await insertEvent({
    organizationId: params.organizationId, entityIds: [], originId,
    connectorKey: params.connectorKey, connectionId: notice.connection_id,
    feedId: notice.feed_id, feedKey: notice.feed_key,
    originType: 'source_reference', semanticType: event.event_type,
    title: `Source ${event.event_type}`, payloadType: 'empty', content: null,
    occurredAt: event.occurred_at ?? null, createdBy: params.principal,
    metadata: { observation_id: event.id, resource_ref: event.resource_ref,
      resource_type: event.resource_type ?? null, source_occurred_at: event.occurred_at ?? null,
      source_scope: notice.subscription!.scope_key },
  }, { sql: tx });
}
