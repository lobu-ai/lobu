import { describe, expect, it } from 'bun:test';
import { ConnectorRuntime } from '../connector-runtime.js';
import { assertFeedObservation } from '../feed-observation.js';
import type { FeedObserveResult } from '../connector-types.js';
import { defineConnector } from '../define-connector.js';

describe('source feed observation', () => {
  it('rejects raw content, malformed references, and oversized batches before acknowledgement', () => {
    const change = { event_type: 'message.created', resource_ref: 'source-42', delivery_id: 'change-42' };
    for (const result of [
      { changes: [{ ...change, body: 'must remain at source' }], checkpoint: {} },
      { changes: [{ ...change, delivery_id: '' }], checkpoint: {} },
      { changes: Array.from({ length: 1001 }, () => change), checkpoint: {} },
      { changes: [change], checkpoint: [] },
      { changes: [change], checkpoint: { oversized: 'x'.repeat(262145) } },
    ]) expect(() => assertFeedObservation(result as FeedObserveResult)).toThrow();
  });

  it('lowers observation independently of read and sync through defineConnector', async () => {
    const Connector = defineConnector({ key: 'synthetic.source', name: 'Source', version: '1.0.0', feeds: {
      items: { name: 'Items', read: async () => ({ rows: [] }),
        observe: async () => ({ changes: [], checkpoint: { cursor: 'head' } }) },
    } });
    expect(await new Connector().observe({ feedKey: 'items', config: {}, checkpoint: null, credentials: null }))
      .toEqual({ changes: [], checkpoint: { cursor: 'head' } });
  });

  it('delivers references and a replay checkpoint without a sync or content commit', async () => {
    const received: unknown[] = [];
    class Source extends ConnectorRuntime {
      definition = {
        key: 'synthetic.source', name: 'Synthetic source', version: '1.0.0',
        feeds: {
          messages: {
            key: 'messages', name: 'Messages',
            read: async () => ({ rows: [], hasMore: false }),
            observe: async (ctx: unknown) => {
              received.push(ctx);
              return {
                changes: [{ event_type: 'message', resource_ref: 'source-42', delivery_id: 'change-42' }],
                checkpoint: { cursor: 'next' },
              };
            },
          },
        },
      };
    }
    const connector = new Source();
    const context = { feedKey: 'messages', feedId: 7, config: {}, checkpoint: { cursor: 'previous' }, credentials: null };
    const result = await connector.observe(context);
    expect(result).toEqual({
      changes: [{ event_type: 'message', resource_ref: 'source-42', delivery_id: 'change-42' }],
      checkpoint: { cursor: 'next' },
    });
    expect(received).toEqual([context]);
  });

  it('rejects observation on a feed that only provides reads', async () => {
    class Source extends ConnectorRuntime {
      definition = {
        key: 'synthetic.source', name: 'Synthetic source', version: '1.0.0',
        feeds: { items: { key: 'items', name: 'Items', read: async () => ({ rows: [] }) } },
      };
    }
    await expect(new Source().observe({ feedKey: 'items', config: {}, checkpoint: null, credentials: null }))
      .rejects.toThrow("feed 'items' does not support observation");
  });
});
