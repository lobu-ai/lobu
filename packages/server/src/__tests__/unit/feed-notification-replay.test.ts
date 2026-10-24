import { afterEach, expect, spyOn, test } from 'bun:test';
import * as activation from '../../automations/activation';
import * as feedPage from '../../connectors/feed-page-commit';
import type { DbClient } from '../../db/client';
import { receiveFeedNotifications } from '../../runs/feed-notifications';
import * as listener from '../../runs/source-feed-listener';
import * as subscriptions from '../../runs/source-feed-subscriptions';
import { StaleSourceCheckpoint } from '../../runs/source-reference-events';
import * as events from '../../utils/insert-event';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

const notice = { feed_id: 1, connection_id: 2, feed_key: 'items',
  notification_id: 'synthetic-notification', changed: true };

test.each(['connector', 'connection', 'event'])('unrelated %s capture does not revoke legacy replay', async target => {
  const capture = { kind: 'event' as const, capture: 'references' as const,
    connector_key: target === 'connector' ? 'synthetic.other' : 'synthetic.source',
    connection_id: target === 'connection' ? 3 : notice.connection_id,
    event_types: [target === 'event' ? 'other.changed' : 'message.created'] };
  spies.push(
    spyOn(subscriptions, 'sourceFeedSubscriptions').mockResolvedValue([{
      automationId: 1, principal: 'synthetic-user', agentId: 'synthetic-agent', executorKind: 'agent',
      triggers: [{ kind: 'event', connector_key: 'synthetic.source', event_types: ['message.created'] }, capture],
    }]),
    spyOn(feedPage, 'lockFeedPage').mockResolvedValue(),
    spyOn(events, 'lockEventDedupIdentities').mockResolvedValue(),
    spyOn(activation, 'findMatchingAutomationActivations').mockResolvedValue([]),
    spyOn(activation, 'queueAutomationActivations').mockResolvedValue([]),
    spyOn(activation, 'dispatchAutomationRunsBestEffort').mockResolvedValue(),
    spyOn(listener, 'recordSourceFeedFailure').mockResolvedValue(),
  );
  const tx = Object.assign(async (parts: TemplateStringsArray) => {
    const query = parts.join('?');
    if (query.includes('SELECT f.organization_id')) return [{ organization_id: 'synthetic-org',
      connector_key: 'synthetic.source', version: '1.0.0', config: {}, source_only: true,
      automation_events: [{ key: 'message.created' }], event_types: ['message.created'] }];
    if (query.includes('SELECT checkpoint, config')) return [{ checkpoint: { cursor: { after: 2 } }, config: {} }];
    if (query.includes("SELECT checkpoint->'cursor'")) return [{ matches: false }];
    return [];
  }, { unsafe: () => [], json: (value: unknown) => value });
  const sql = { begin: (callback: (tx: unknown) => unknown) => callback(tx) } as unknown as DbClient;
  const receipts = await receiveFeedNotifications(sql, [{ ...notice, subscription: {
    scope_key: subscriptions.sourceFeedScopeKey({}, '1.0.0'), binding_id: 'synthetic-binding',
    epoch: 'synthetic-epoch', needs_rebind: false, records: [{ revision: 1, payload: {
      id: 'synthetic-batch', events: [{ id: 'synthetic-event', event_type: 'message.created', resource_ref: 'synthetic-resource' }],
      checkpoint: { previous: null, next: { after: 1 } },
    } }],
  } }], 'synthetic-device', ['synthetic-org']);
  expect(receipts).toHaveLength(1);
  expect(receipts[0].active).toBe(true);
  expect(receipts[0].ack).toBeDefined();
  expect(listener.recordSourceFeedFailure).not.toHaveBeenCalled();
});

test('a failed stale-binding recovery preserves retry and allows the next binding to progress', async () => {
  spies.push(
    spyOn(listener, 'recordSourceFeedFailure').mockRejectedValueOnce(new Error('Synthetic database failure')),
    spyOn(activation, 'dispatchAutomationRunsBestEffort').mockResolvedValue(),
  );
  let calls = 0;
  const sql = { begin: async () => {
    if (++calls === 1) throw new StaleSourceCheckpoint('synthetic-org', {});
    return { active: true };
  } } as unknown as DbClient;
  const receipts = await receiveFeedNotifications(sql, [notice, { ...notice, feed_id: 3 }],
    'synthetic-device', ['synthetic-org']);
  expect(receipts).toEqual([expect.objectContaining({ feed_id: 3, active: true })]);
});
