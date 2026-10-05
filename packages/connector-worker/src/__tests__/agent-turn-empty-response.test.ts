import { afterEach, expect, test } from 'bun:test';
import { runAgentTurn } from '../agent-turn/guest-entry.js';
import type { AgentTurnInput } from '../agent-turn/types.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const input: AgentTurnInput = {
  provider: { api: 'openai-completions', provider: 'openai', modelId: 'synthetic-model',
    baseUrl: 'https://provider.example.test/v1', apiKey: 'synthetic-key' },
  systemPrompt: 'Answer briefly.', userMessage: 'Say hello.', sessionJsonl: '',
};

function response(delta: Record<string, unknown> | null, finishReason: string | null = 'stop') {
  const data = delta === null ? '' : `data: ${JSON.stringify({
    id: 'synthetic-response', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
  return new Response(`${data}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

test.each([
  ['role-only', { role: 'assistant' }, null],
  ['empty stream', null, null],
  ['empty stop', { role: 'assistant', content: '' }, 'stop'],
  ['whitespace', { role: 'assistant', content: ' \n\t' }, 'stop'],
  ['reasoning-only', { role: 'assistant', reasoning_content: 'Thinking without an answer.' }, 'stop'],
] as const)('rejects a provider-only %s response through the real adapter', async (_name, delta, finishReason) => {
  globalThis.fetch = (async () => response(delta, finishReason)) as typeof fetch;
  await expect(runAgentTurn(input, () => undefined)).rejects.toThrow('The model returned no response. Please try again.');
});

test('preserves an explicit provider error instead of replacing it with the empty-response error', async () => {
  globalThis.fetch = (async () => response({ role: 'assistant' }, 'UNEXPECTED_TOOL_CALL')) as typeof fetch;
  await expect(runAgentTurn(input, () => undefined)).rejects.toThrow('Provider finish_reason: UNEXPECTED_TOOL_CALL');
});

test('preserves a normal text response', async () => {
  globalThis.fetch = (async () => response({ role: 'assistant', content: 'Hello.' })) as typeof fetch;
  expect((await runAgentTurn(input, () => undefined)).text).toBe('Hello.');
});

// Tool activity is deliberately outside this guard: a tool can deliver the
// answer itself, and neither its name nor its result prose proves delivery.
test.each([false, true])('preserves an empty turn after a tool result with isError=%s', async (isError) => {
  let requests = 0;
  globalThis.fetch = (async (url) => {
    if (String(url).includes('/mcp/')) {
      return Response.json({ content: [{ type: 'text', text: isError ? 'Synthetic tool failure' : 'Tool completed' }], isError });
    }
    return ++requests === 1
      ? response({ role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function',
          function: { name: 'synthetic_tool', arguments: '{}' } }] }, 'tool_calls')
      : response({ role: 'assistant' });
  }) as typeof fetch;
  const output = await runAgentTurn({ ...input, tools: {
    gatewayUrl: 'https://gateway.example.test', definitions: [{ mcpId: 'synthetic', name: 'synthetic_tool',
      description: 'A synthetic tool', inputSchema: { type: 'object', properties: {} } }],
  } }, () => undefined);
  expect(output.text).toBe('');
  expect(output.toolsUsed).toEqual(['synthetic_tool']);
  expect(output.firstError).toBe(isError ? 'Synthetic tool failure' : undefined);
});

test.each(['send_message', 'ask_user'] as const)('preserves a tool-only %s delivery', async (name) => {
  let requests = 0;
  globalThis.fetch = (async (url) => {
    if (String(url).includes('/internal/')) return Response.json({ id: 'synthetic-question', messageId: 'synthetic-message', deliveredInBand: true });
    const args = name === 'send_message' ? { target: 'synthetic-conversation', text: 'Hello.' } : { question: 'Which one?', options: ['A', 'B'] };
    return ++requests === 1
      ? response({ role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function',
          function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
      : response({ role: 'assistant' });
  }) as typeof fetch;
  const output = await runAgentTurn({ ...input, tools: {
    gatewayUrl: 'https://gateway.example.test', definitions: [], gateway: [name],
    conversation: { platform: 'slack', channelId: 'synthetic-channel', conversationId: 'synthetic-conversation' },
  } }, () => undefined);
  expect(output.text).toBe('');
  expect(output.toolsUsed).toEqual([name]);
  expect(output.repliedInBand).toBe(name === 'send_message' ? true : undefined);
});
