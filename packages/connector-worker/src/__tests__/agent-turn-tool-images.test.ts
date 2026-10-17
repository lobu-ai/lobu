import { afterEach, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { AGENT_TURN_BRIDGE_BYTES } from '@lobu/core/contracts/worker/protocol';
import { syntheticImage } from '../../../../scripts/__tests__/fixtures/synthetic-image';
import { runAgentTurn } from '../agent-turn/guest-entry.js';
import type { AgentTurnEvent } from '../agent-turn/types.js';
import type { AgentTurnInput } from '../agent-turn/types.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test.each([false, true])('rejects a corrupt checkpoint before any provider call (tools: %s)', async (withTools) => {
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error('unexpected network call'); }) as typeof fetch;
  await expect(runAgentTurn({
    provider: { api: 'openai-completions', provider: 'openai', modelId: 'synthetic', baseUrl: 'https://provider.example.test/v1', apiKey: 'synthetic-key', input: ['text', 'image'] },
    systemPrompt: 'Observe.', userMessage: 'Continue.', sessionJsonl: '{malformed checkpoint}\n',
    ...(withTools ? { tools: { gatewayUrl: 'https://gateway.example.test', definitions: [{ mcpId: 'synthetic', name: 'observe', description: 'Observe', inputSchema: { type: 'object', properties: {} } }] } } : {}),
  }, () => {})).rejects.toThrow();
  expect(requests).toBe(0);
});

// Uses the real session and provider serializer; only the network is synthetic.
// The canned model response proves transport, NOT visual understanding.
test.each(['image', 'resource', 'text-only-model', 'failed-tool', 'failed-content', 'empty'])('%s delivers pixels or an explicit failure to the next provider request', async (kind) => {
  const data = syntheticImage().bytes.toString('base64');
  const events: AgentTurnEvent[] = [];
  const modelRequests: unknown[] = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url) === 'https://gateway.example.test/mcp/synthetic/tools/observe') {
      if (kind === 'empty') return Response.json({ content: [{ type: 'text', text: '' }] });
      const image = kind === 'resource'
        ? { type: 'resource', resource: { uri: 'lobu://run/42/attachment/0', mimeType: 'image/png', blob: data } }
        : { type: 'image', mimeType: 'image/png', data };
      return Response.json({ content: [{ type: 'text', text: kind === 'failed-content' ? 'Synthetic observation failed.' : 'Synthetic observation.' }, image],
        ...(kind === 'failed-tool' ? { isError: true, error: 'Synthetic observation failed.' } : kind === 'failed-content' ? { isError: true } : {}) });
    }
    expect(String(url)).toBe('https://provider.example.test/v1/chat/completions');
    modelRequests.push(JSON.parse(String(init?.body)));
    const choice = modelRequests.length === 1
      ? { index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'observe-call', type: 'function', function: { name: 'observe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }
      : { index: 0, delta: { role: 'assistant', content: 'Transport recorded.' }, finish_reason: 'stop' };
    return new Response(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [choice] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const result = await runAgentTurn({
    provider: { api: 'openai-completions', provider: 'openai', modelId: 'synthetic', baseUrl: 'https://provider.example.test/v1', apiKey: 'synthetic-key', input: kind === 'text-only-model' ? ['text'] : ['text', 'image'] },
    systemPrompt: 'Observe once.', userMessage: 'Where is the square?', sessionJsonl: '',
    tools: { gatewayUrl: 'https://gateway.example.test', definitions: [{ mcpId: 'synthetic', name: 'observe', description: 'Observe a synthetic image', inputSchema: { type: 'object', properties: {} } }] },
  }, event => events.push(event));
  expect(result.text).toBe('Transport recorded.');
  expect(modelRequests).toHaveLength(2);
  expect(JSON.stringify(modelRequests[0])).not.toContain(data);
  if (kind === 'empty') {
    expect(JSON.stringify(modelRequests[1])).not.toContain(data);
    expect(JSON.stringify(modelRequests[1])).toContain('observe completed.');
  } else if (kind === 'text-only-model' || kind === 'failed-tool' || kind === 'failed-content') {
    expect(JSON.stringify(modelRequests[1])).not.toContain(data);
    expect(JSON.stringify(modelRequests[1])).toContain(kind === 'text-only-model' ? 'does not declare image input support' : 'Synthetic observation failed');
    if (kind !== 'text-only-model') expect(JSON.stringify(modelRequests[1])).not.toContain('does not declare image input support');
  } else {
    expect(JSON.stringify(modelRequests[1])).toContain(`data:image/png;base64,${data}`);
  }
  expect(JSON.stringify(events)).not.toContain(data);
});

test.each(['anthropic-messages', 'openai-responses', 'openai-codex-responses'] as const)('preserves tool images through the %s provider serializer', async api => {
  const data = syntheticImage().bytes.toString('base64');
  const requests: unknown[] = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes('/mcp/')) return Response.json({ content: [{ type: 'image', mimeType: 'image/png', data }] });
    requests.push(JSON.parse(String(init?.body)));
    const first = requests.length === 1;
    const call = { type: 'function_call', id: 'fc_observe', call_id: 'observe-call', name: 'observe', arguments: '{}' };
    const events = api === 'anthropic-messages' ? [
      { type: 'message_start', message: { id: 'synthetic', type: 'message', role: 'assistant', model: 'synthetic', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: first ? { type: 'tool_use', id: 'observe-call', name: 'observe', input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: first ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text: 'Recorded.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ] : [
      ...(first ? [
        { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 0, delta: '{}' },
        { type: 'response.output_item.done', output_index: 0, item: call },
      ] : []),
      { type: 'response.completed', response: { id: 'synthetic', status: 'completed', output: first ? [call] : [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const input: AgentTurnInput = {
    provider: { api, provider: api === 'anthropic-messages' ? 'anthropic' : api === 'openai-codex-responses' ? 'openai-codex' : 'openai', modelId: 'synthetic', baseUrl: 'https://provider.example.test/v1', apiKey: 'synthetic-key', input: ['text', 'image'] },
    systemPrompt: 'Observe once.', userMessage: 'Inspect the square.', sessionJsonl: '',
    tools: { gatewayUrl: 'https://gateway.example.test', definitions: [{ mcpId: 'synthetic', name: 'observe', description: 'Observe', inputSchema: { type: 'object', properties: {} } }] },
  };
  await runAgentTurn(input, () => {});
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[0])).not.toContain(data);
  expect(JSON.stringify(requests[1])).toContain(api === 'anthropic-messages' ? `"data":"${data}"` : `data:image/png;base64,${data}`);
});

test.each([0, 1])('repeated screenshots account for %i input images and the retained session budget', async (inputImages) => {
  const bytes = Buffer.alloc(5 * 1024 * 1024);
  syntheticImage().bytes.copy(bytes);
  const data = bytes.toString('base64');
  let requests = 0;
  let lastRequest = '';
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes('/mcp/')) return Response.json({ content: [{ type: 'image', mimeType: 'image/png', data }] });
    requests++;
    lastRequest = String(init?.body);
    const choice = requests <= 5
      ? { index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `observe-${requests}`, type: 'function', function: { name: 'observe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }
      : { index: 0, delta: { role: 'assistant', content: 'Recorded.' }, finish_reason: 'stop' };
    return new Response(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [choice] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const input: AgentTurnInput = {
    provider: { api: 'openai-completions', provider: 'openai', modelId: 'synthetic', baseUrl: 'https://provider.example.test/v1', apiKey: 'synthetic-key', input: ['text', 'image'] },
    systemPrompt: 'Observe five times.', userMessage: 'Observe.', sessionJsonl: '',
    images: inputImages ? [{ mimeType: 'image/png', data }] : undefined,
    tools: { gatewayUrl: 'https://gateway.example.test', definitions: [{ mcpId: 'synthetic', name: 'observe', description: 'Observe', inputSchema: { type: 'object', properties: {} } }] },
  };
  const result = await runAgentTurn(input, () => {});
  expect(requests).toBe(6);
  expect(Buffer.byteLength(result.sessionJsonl)).toBeLessThan(AGENT_TURN_BRIDGE_BYTES);
  expect(lastRequest).toContain('image budget exhausted');
  expect(result.text).toBe('Recorded.');
  // A subsequent turn must account for the image blocks already checkpointed.
  requests = 0;
  const replayed = await runAgentTurn({ ...input, images: undefined, sessionJsonl: result.sessionJsonl }, () => {});
  expect(requests).toBe(6);
  // This source-level harness does not use the isolate's session-file shim.
  // Inspect the new tool messages to prove the supplied checkpoint is charged.
  const replayedTools = replayed.sessionJsonl.trim().split('\n').map(line => JSON.parse(line))
    .filter(entry => entry.type === 'message' && entry.message.role === 'toolResult');
  expect(replayedTools.flatMap(entry => entry.message.content).filter(part => part.type === 'image')).toHaveLength(0);
  expect(lastRequest).toContain('image budget exhausted');
  expect(Buffer.byteLength(replayed.sessionJsonl)).toBeLessThan(AGENT_TURN_BRIDGE_BYTES);
});

test('native isolate preserves tool pixels across checkpoint restoration', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/agent-tool-images-isolate.fixture.ts', import.meta.url));
  const child = Bun.spawn(['node', '--import', 'tsx', '--test', fixture], {
    env: { PATH: process.env.PATH, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)) },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ exitCode, stderr, stdout: exitCode ? stdout : '' }).toEqual({ exitCode: 0, stderr: '', stdout: '' });
  expect(stdout).toContain('tests 1');
}, 30_000);
