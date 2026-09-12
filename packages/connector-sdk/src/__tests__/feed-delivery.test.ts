import { describe, expect, test } from 'bun:test';
import { ConnectorRuntime } from '../connector-runtime.js';
import { defineConnector } from '../define-connector.js';
import type { FeedDeliveryContext, RuntimeConnectorDefinition } from '../connector-types.js';

const context = {
  feedKey: 'items', feedId: 123, config: {}, checkpoint: { cursor: 'before' },
  credentials: null, entityIds: [],
  delivery: { id: 'synthetic-delivery', event: 'changed', payload: { text: 'hello' } },
};

function accept(ctx: FeedDeliveryContext) {
  return Promise.resolve({ events: [], checkpoint: ctx.checkpoint, metadata: { delivery: ctx.delivery } });
}

describe('connector feed delivery', () => {
  test('functional push-only feeds receive source input and retain the shared checkpoint', async () => {
    const Source = defineConnector({
      key: 'synthetic.delivery', name: 'Delivery', version: '1.0.0',
      feeds: { items: { name: 'Items', onDelivery: accept } },
    });
    const source = new Source();
    expect(await source.onDelivery(context)).toEqual({
      events: [], checkpoint: context.checkpoint, metadata: { delivery: context.delivery },
    });
    await expect(source.sync(context)).rejects.toThrow('does not support sync');
  });

  test('class feeds share helpers between pull and delivery without calling pull implicitly', async () => {
    let pulls = 0;
    class Source extends ConnectorRuntime {
      definition: RuntimeConnectorDefinition = {
        key: 'synthetic.delivery', name: 'Delivery', version: '1.0.0',
        feeds: { items: { key: 'items', name: 'Items', onDelivery: accept,
          sync: async (ctx) => { pulls++; return { events: [], checkpoint: ctx.checkpoint }; },
        } },
      };
    }
    const source = new Source();
    await source.onDelivery(context);
    expect(pulls).toBe(0);
    await source.sync(context);
    expect(pulls).toBe(1);
    await expect(source.onDelivery({ ...context, feedKey: 'missing' })).rejects.toThrow('does not support delivery');
  });

  test('a pull-only feed rejects delivery instead of silently fetching', async () => {
    const Source = defineConnector({
      key: 'synthetic.pull', name: 'Pull', version: '1.0.0',
      feeds: { items: { name: 'Items', sync: async () => { throw new Error('unexpected pull'); } } },
    });
    await expect(new Source().onDelivery(context)).rejects.toThrow('does not support delivery');
  });
});
