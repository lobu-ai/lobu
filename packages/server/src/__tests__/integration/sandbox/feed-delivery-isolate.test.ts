import { beforeAll, describe, expect, it } from 'vitest';
import { executeCompiledConnector } from '@lobu/connector-worker/executor/runtime';
import type { ExecutorJob } from '@lobu/connector-worker/executor/interface';
import { compileConnectorSource, extractConnectorMetadata } from '../../../utils/connector-compiler';

// Compiled through the installed-connector entry point. There is no catalog or
// gateway registration for this source: its handlers and capabilities are SDK code.
const source = `
import { defineConnector } from '@lobu/connector-sdk';
function result(ctx, item) {
  return {
    events: [{ origin_id: item.id, origin_type: 'item', payload_text: item.text,
      occurred_at: new Date('2026-01-01T00:00:00Z') }],
    checkpoint: ctx.checkpoint,
  };
}
async function onDelivery(ctx) {
  let item = ctx.delivery.payload;
  if (ctx.delivery.event === 'hint') {
    item = await ctx.sessionState.chrome_dispatcher.dispatch('read_source', { id: item.id });
  }
  const output = result(ctx, item);
  await ctx.emitEvents(output.events);
  await ctx.updateCheckpoint(ctx.checkpoint);
  return { ...output, events: [], metadata: { delivered: ctx.delivery.id, credential: ctx.credentials?.accessToken } };
}
export default defineConnector({
  key: 'synthetic.external-delivery', name: 'External delivery', version: '1.0.0',
  authSchema: { methods: [{ type: 'none' }] },
  feeds: {
    items: { name: 'Items', sync: async (ctx) => result(ctx, { id: 'pull-item', text: 'pulled' }), onDelivery },
    pushed: { name: 'Push only', onDelivery },
    pulled: { name: 'Pull only', sync: async () => { throw new Error('unexpected pull'); } },
  },
});
`;

let compiledCode: string;
beforeAll(async () => { ({ compiledCode } = await compileConnectorSource(source)); });

function job(): ExecutorJob & { mode: 'sync' } {
  return {
    mode: 'sync', feedKey: 'items', feedId: 123, config: {},
    checkpoint: { cursor: 'existing-cursor' }, entityIds: [],
    credentials: { provider: 'synthetic', accessToken: 'synthetic-private-credential' },
    sessionState: {}, env: {},
    delivery: { id: 'synthetic-delivery-1', event: 'complete', payload: { id: 'item-1', text: 'delivered' } },
  };
}

describe('installed connector delivery in a real isolate', () => {
  it.each([undefined, null, { next_sync_after_seconds: null }, { next_sync_after_seconds: 1 }, { next_sync_after_seconds: 'invalid' }])('preserves the optional continuation boundary for sync result %j', async (syncResult) => {
    // Deliberately return raw plugin values to exercise the executor boundary,
    // independently of the SDK's handler-result normalization.
    const { compiledCode: rawCode } = await compileConnectorSource(`
      export default class {
        async sync(ctx) { return ctx.config.result; }
        async execute() { return { success: true }; }
      }
    `);
    const input = job();
    delete input.delivery;
    input.config = { result: syncResult };
    const result = await executeCompiledConnector({ compiledCode: rawCode, job: input });
    const expected = syncResult?.next_sync_after_seconds;
    expect((result as { next_sync_after_seconds?: unknown }).next_sync_after_seconds).toBe(expected);
    if (expected === undefined) expect(JSON.stringify(result)).not.toContain('next_sync_after_seconds');
  });

  it('publishes push-only and hybrid capabilities without serializing handlers', async () => {
    const metadata = await extractConnectorMetadata(compiledCode);
    expect(metadata.feeds?.items).toEqual({ key: 'items', name: 'Items', operations: ['sync', 'delivery'] });
    expect(metadata.feeds?.pushed).toEqual({ key: 'pushed', name: 'Push only', operations: ['delivery'] });
  });

  it('emits complete input with zero source reads through the ordinary event and checkpoint hooks', async () => {
    const events: unknown[] = [];
    const checkpoints: unknown[] = [];
    const result = await executeCompiledConnector({
      compiledCode, job: job(), allowedDomains: [],
      hooks: {
        onEventChunk: async (chunk) => { events.push(...chunk); },
        onCheckpointUpdate: async (checkpoint) => { checkpoints.push(checkpoint); },
        onChromeDispatch: async () => { throw new Error('Complete delivery must not read the browser'); },
      },
    });
    expect(events).toMatchObject([{ origin_id: 'item-1', payload_text: 'delivered' }]);
    expect(checkpoints).toEqual([{ cursor: 'existing-cursor' }]);
    expect(result).toMatchObject({ mode: 'sync', checkpoint: { cursor: 'existing-cursor' }, metadata: { delivered: 'synthetic-delivery-1' } });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-credential');
  });

  it('lets an incomplete delivery call the existing browser capability', async () => {
    const input = job();
    input.delivery!.event = 'hint';
    const calls: unknown[] = [];
    const events: unknown[] = [];
    await executeCompiledConnector({
      compiledCode, job: input, allowedDomains: [],
      hooks: {
        onChromeDispatch: async (action, args) => { calls.push({ action, args }); return { id: 'item-1', text: 'fetched detail' }; },
        onEventChunk: async (chunk) => { events.push(...chunk); },
      },
    });
    expect(calls).toEqual([{ action: 'read_source', args: { id: 'item-1' } }]);
    expect(events).toMatchObject([{ origin_id: 'item-1', payload_text: 'fetched detail' }]);
  });

  it('keeps pull executable and rejects unsupported delivery without a fallback fetch', async () => {
    const input = job();
    delete input.delivery;
    const events: unknown[] = [];
    await executeCompiledConnector({ compiledCode, job: input, hooks: {
      onEventChunk: async (chunk) => { events.push(...chunk); },
    } });
    expect(events).toMatchObject([{ origin_id: 'pull-item', payload_text: 'pulled' }]);
    await expect(executeCompiledConnector({ compiledCode, job: { ...job(), feedKey: 'pulled' } }))
      .rejects.toThrow('does not support delivery');
  });
});
