import { describe, expect, test } from 'bun:test';
import type { ConnectorTriggerSignal } from '@lobu/connector-sdk';
import {
  deriveAutomationEventCatalogFromFeeds,
  deriveConnectorActivationSignals,
  resolveAutomationEventCatalog,
  type ConnectorDeriveEventInput,
  type ConnectorDeriveFeedContext,
} from '../../automations/connector-derived';

const context: ConnectorDeriveFeedContext = {
  connectorKey: 'x',
  feedPreviouslySynced: true,
  eventKinds: { tweet: { description: 'A tweet' }, dm_message: {} },
};

const baseEvent: ConnectorDeriveEventInput = {
  connectionId: 7,
  originId: '2083959735481716957',
  kind: 'tweet',
  title: 'someone: hello',
  payloadText: 'hello from the home timeline',
  sourceUrl: 'https://x.com/someone/status/2083959735481716957',
  occurredAt: '2026-08-11T10:00:00.000Z',
  metadata: {
    author_handle: 'someone',
    reply_count: 3,
    nested: { deep: true },
  },
};

describe('deriveConnectorActivationSignals', () => {
  test('a thread reply supersede emits the opted-in thread.updated activation', () => {
    const reply = {
      ...baseEvent,
      kind: 'thread',
      originId: 'test-thread-1',
      payloadText: 'Original message\nNew reply',
      previousOccurredAt: '2026-08-11T09:00:00.000Z',
      metadata: { message_count: 2 },
    };
    const signals = deriveConnectorActivationSignals(
      { ...context, eventKinds: { thread: { updatedEvent: true } } },
      reply,
      'superseded', 124,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      event_type: 'thread.updated',
      resource_type: 'thread',
      resource_ref: 'test-thread-1',
      input_text: 'Original message\nNew reply',
      delivery_id: 'derived:x:7:event:124',
      attributes: { change: 'superseded', message_count: 2 },
    });
  });

  test('fires on an inserted event for a declared kind with a prior sync', () => {
    const signals = deriveConnectorActivationSignals(
      context,
      baseEvent,
      'inserted', 123,
    );
    expect(signals).toHaveLength(1);
    const signal = signals[0] as ConnectorTriggerSignal;
    expect(signal.connector_key).toBe('x');
    expect(signal.connection_id).toBe(7);
    expect(signal.event_type).toBe('tweet');
    expect(signal.resource_type).toBe('tweet');
    expect(signal.resource_ref).toBe(baseEvent.originId);
    expect(signal.delivery_id).toBe('derived:x:7:event:123');
    expect(signal.label).toBe(baseEvent.title);
    expect(signal.input_text).toBe(baseEvent.payloadText);
    expect(signal.url).toBe(baseEvent.sourceUrl);
    expect(signal.occurred_at).toBe('2026-08-11T10:00:00.000Z');
    expect(signal.attributes).toEqual({
      change: 'inserted',
      author_handle: 'someone',
      reply_count: 3,
    });
  });

  test('suppresses a poll-driven cold-start batch before any successful sync', () => {
    const coldStart = { ...context, feedPreviouslySynced: false };
    expect(
      deriveConnectorActivationSignals(coldStart, baseEvent, 'inserted', 123),
    ).toEqual([]);
  });

  test('does not fire on superseded or unchanged rows', () => {
    expect(
      deriveConnectorActivationSignals(context, baseEvent, 'superseded', 123),
    ).toEqual([]);
    expect(
      deriveConnectorActivationSignals(context, baseEvent, 'unchanged', 123),
    ).toEqual([]);
  });

  test('does not fire for a kind the feed does not declare', () => {
    const undeclared = { ...baseEvent, kind: 'like' };
    expect(
      deriveConnectorActivationSignals(context, undeclared, 'inserted', 123),
    ).toEqual([]);
  });

  test('does not fire when the feed declares no eventKinds at all', () => {
    const noKinds = { ...context, eventKinds: null };
    expect(
      deriveConnectorActivationSignals(noKinds, baseEvent, 'inserted', 123),
    ).toEqual([]);
  });

  test('does not fire when the event is not from a sync-capable feed', () => {
    const unconnected = { ...baseEvent, connectionId: null };
    expect(
      deriveConnectorActivationSignals(context, unconnected, 'inserted', 123),
    ).toEqual([]);
  });
});

describe('deriveAutomationEventCatalogFromFeeds', () => {
  test('advertises the separate opted-in updated trigger', () => {
    expect(deriveAutomationEventCatalogFromFeeds({
      threads: { eventKinds: { thread: { updatedEvent: true } } },
    })).toEqual([
      { key: 'thread', label: 'Thread' },
      { key: 'thread.updated', label: 'Thread Updated' },
    ]);
  });

  test('derives one subscribable type per declared kind', () => {
    const feeds = {
      home_feed: { eventKinds: { tweet: {}, dm_message: {} } },
      search: { eventKinds: { tweet: {}, thread: {} } },
    };
    const catalog = deriveAutomationEventCatalogFromFeeds(feeds);
    expect(catalog.map((entry) => entry.key).sort()).toEqual([
      'dm_message',
      'thread',
      'tweet',
    ]);
  });

  test('returns [] for no feeds or no eventKinds', () => {
    expect(deriveAutomationEventCatalogFromFeeds(null)).toEqual([]);
    expect(deriveAutomationEventCatalogFromFeeds({ home_feed: {} })).toEqual([]);
    expect(deriveAutomationEventCatalogFromFeeds({})).toEqual([]);
  });
});

describe('opted-in updated events', () => {
  const ctx = { ...context, eventKinds: { thread: { updatedEvent: true } } };
  const event = { ...baseEvent, kind: 'thread', previousOccurredAt: '2026-08-11T09:00:00Z' };

  test('inserts retain their original kind', () => {
    expect(deriveConnectorActivationSignals(ctx, event, 'inserted', 125)[0]?.event_type).toBe('thread');
  });

  test.each(['unchanged', 'state_updated'] as const)('%s stays quiet even with newer activity', (change) => {
    expect(deriveConnectorActivationSignals(ctx, event, change, 125)).toEqual([]);
  });

  test('cold-start supersedes stay quiet', () => {
    expect(deriveConnectorActivationSignals({ ...ctx, feedPreviouslySynced: false }, event, 'superseded', 125)).toEqual([]);
  });

  test.each([undefined, null, 'invalid', event.occurredAt, '2026-08-11T11:00:00Z'])(
    'requires activity strictly newer than predecessor %s', (previousOccurredAt) => {
      expect(deriveConnectorActivationSignals(ctx, { ...event, previousOccurredAt }, 'superseded', 125)).toEqual([]);
    },
  );

  test.each([null, 'invalid', '2026-08-11T08:00:00Z'])(
    'does not infer newer activity from occurredAt %s', (occurredAt) => {
      expect(deriveConnectorActivationSignals(ctx, { ...event, occurredAt }, 'superseded', 125)).toEqual([]);
    },
  );

  test.each([false, 'true', 1, null])('requires a literal true opt-in, not %s', (updatedEvent) => {
    expect(deriveConnectorActivationSignals({ ...ctx, eventKinds: { thread: { updatedEvent } } }, event, 'superseded', 125)).toEqual([]);
    expect(deriveAutomationEventCatalogFromFeeds({ threads: { eventKinds: { thread: { updatedEvent } } } })).toEqual([{ key: 'thread', label: 'Thread' }]);
  });

  test.each([92, 93, 95])('applies the 100-character limit to the composite for a %s-character kind', (length) => {
    const kind = 'a'.repeat(length);
    const eventKinds = { [kind]: { updatedEvent: true } };
    const signals = deriveConnectorActivationSignals({ ...ctx, eventKinds }, { ...event, kind }, 'superseded', 125);
    const catalog = deriveAutomationEventCatalogFromFeeds({ threads: { eventKinds } });
    expect(signals.map((s) => s.event_type)).toEqual(length <= 92 ? [`${kind}.updated`] : []);
    expect(catalog.map((s) => s.key)).toEqual(length <= 92 ? [kind, `${kind}.updated`] : [kind]);
  });

  test('a literal updated kind wins a collision in catalog and activation', () => {
    const eventKinds = { thread: { updatedEvent: true }, 'thread.updated': {} };
    expect(deriveConnectorActivationSignals({ ...ctx, eventKinds }, event, 'superseded', 125)).toEqual([]);
    expect(deriveConnectorActivationSignals({ ...ctx, eventKinds }, { ...event, kind: 'thread.updated' }, 'inserted', 125)[0]?.event_type).toBe('thread.updated');
    expect(deriveAutomationEventCatalogFromFeeds({ threads: { eventKinds } }).map((e) => e.key)).toEqual(['thread', 'thread.updated']);
  });

  test('a literal kind on another feed also reserves the updated slug', () => {
    const declaredEventKinds = new Set(['thread', 'thread.updated']);
    expect(deriveConnectorActivationSignals({ ...ctx, declaredEventKinds }, event, 'superseded', 125)).toEqual([]);
    const catalog = deriveAutomationEventCatalogFromFeeds({
      threads: { eventKinds: ctx.eventKinds },
      literal: { eventKinds: { 'thread.updated': {} } },
    });
    expect(catalog.map((entry) => entry.key)).toEqual(['thread', 'thread.updated']);
  });

  test('an explicit catalog keeps precedence over opted-in derived kinds', () => {
    const declared = [{ key: 'custom', label: 'Custom' }];
    expect(resolveAutomationEventCatalog({ persistedEvents: declared, feedsSchema: { threads: { eventKinds: ctx.eventKinds } }, useBundledFallback: false })).toEqual(declared);
  });
});

describe('resolveAutomationEventCatalog', () => {
  test('preserves every declared event field the UI editor reads', () => {
    const declared = [
      {
        key: 'message.created',
        label: 'A message is sent',
        description: 'Runs for messages in the selected scope.',
        resourceType: 'channel',
        filterSchema: { type: 'object', properties: { channel_id: { type: 'string' } } },
        defaults: { execution: 'turn', activeRun: 'steer', output: 'reply_to_source' },
        capabilities: { steering: true, replyToSource: true },
      },
    ];
    const resolved = resolveAutomationEventCatalog({
      persistedEvents: declared,
      feedsSchema: {},
      bundled: null,
      useBundledFallback: false,
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      key: 'message.created',
      label: 'A message is sent',
      description: 'Runs for messages in the selected scope.',
      resourceType: 'channel',
      filterSchema: { type: 'object' },
      defaults: { execution: 'turn', activeRun: 'steer', output: 'reply_to_source' },
      capabilities: { steering: true, replyToSource: true },
    });
  });

  test('preserves null metadata as a matchable attribute value', () => {
    const signals = deriveConnectorActivationSignals(
      context,
      { ...baseEvent, metadata: { assignee: null, nested: { deep: true } } },
      'inserted', 123,
    );
    expect(signals[0]?.attributes).toEqual({
      change: 'inserted',
      assignee: null,
    });
  });

  test('falls back to the title for a blank payload_text', () => {
    const signals = deriveConnectorActivationSignals(
      context,
      { ...baseEvent, payloadText: '', title: 'Ask HN: Show your tools' },
      'inserted', 123,
    );
    expect(signals[0]?.input_text).toBe('Ask HN: Show your tools');
  });

  test('label never goes blank even for a blank title', () => {
    const signals = deriveConnectorActivationSignals(
      context,
      { ...baseEvent, title: '', payloadText: 'body only' },
      'inserted', 123,
    );
    expect(signals[0]?.label).toBe('x tweet');
  });

  test('overlong kinds are skipped, never truncated, in catalog and signal', () => {
    const longKindA = 'a'.repeat(150);
    const longKindB = 'a'.repeat(130) + 'b';
    // Distinct long kinds sharing a prefix must NOT collapse into one type.
    const catalog = deriveAutomationEventCatalogFromFeeds({
      home_feed: { eventKinds: { [longKindA]: {}, [longKindB]: {} } },
    });
    expect(catalog).toEqual([]);
    const signals = deriveConnectorActivationSignals(
      { ...context, eventKinds: { [longKindA]: {}, [longKindB]: {} } },
      { ...baseEvent, kind: longKindA },
      'inserted', 123,
    );
    expect(signals).toEqual([]);
  });

  test('caps derived fields to the connector-signal schema limits', () => {
    const signals = deriveConnectorActivationSignals(
      context,
      {
        ...baseEvent,
        payloadText: 'x'.repeat(33_000),
        title: 't'.repeat(400),
        sourceUrl: 'u'.repeat(2_500),
        originId: 'o'.repeat(600),
        metadata: {
          [String('k').repeat(120)]: 'v',
          long_value: String('v').repeat(1_200),
        },
      },
      'inserted', 123,
    );
    const signal = signals[0] as ConnectorTriggerSignal;
    expect(signal.input_text.length).toBe(32_000);
    expect(signal.label.length).toBe(300);
    expect(signal.url?.length).toBe(2_000);
    // Overlong origin_id is omitted (not truncated) so identities cannot collide.
    expect(signal.resource_ref).toBeUndefined();
    expect(signal.resource_type?.length).toBeLessThanOrEqual(100);
    expect(signal.attributes?.long_value).toBe('v'.repeat(1_000));
    expect(signal.attributes?.[String('k').repeat(120)]).toBeUndefined();
  });

  test('an org override with a null feedsSchema never borrows the bundled feeds', () => {
    const resolved = resolveAutomationEventCatalog({
      persistedEvents: null,
      feedsSchema: null,
      bundled: {
        feeds_schema: {
          pulls: { eventKinds: { pull_request: {} } },
        },
        automation_events: null,
      },
      useBundledFallback: false,
    });
    expect(resolved).toEqual([]);
  });
});
