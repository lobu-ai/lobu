import { afterEach, describe, expect, test } from 'bun:test';
import { createNativeSession, promptNativeSession } from '../agent-turn/native-session.js';
import type { AgentTurnInput } from '../agent-turn/types.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** Minimal terminal SSE bodies — enough for each adapter to finish a turn. */
const sse = (events: unknown[], named = false) =>
  events.map((event) => `${named ? `event: ${(event as { type: string }).type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('');
const anthropicStream = () => sse([
  { type: 'message_start', message: { id: 'synthetic', type: 'message', role: 'assistant', model: 'reasoning-model', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
], true);
const responsesStream = () => sse([
  { type: 'response.completed', response: { id: 'synthetic', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
]);
const completionsStream = () => `${sse([
  { id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'reasoning-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }] },
])}data: [DONE]\n\n`;

describe('native session provider compatibility', () => {
  test.each(['medium', 'high'])('sends %s effort for a new Codex model absent from the registry', async (effort) => {
    const requests: Record<string, any>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const response = { id: 'synthetic-codex-response', status: 'completed', output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const input: AgentTurnInput = {
      provider: { api: 'openai-codex-responses', provider: 'openai-codex', modelId: 'synthetic-new-model',
        baseUrl: 'https://gateway.example.test/proxy/chatgpt', apiKey: 'synthetic-credential' },
      effort, systemPrompt: 'Be brief.', sessionJsonl: '', userMessage: 'Say done.',
    };
    const session = createNativeSession(input, [], () => undefined);
    try {
      await promptNativeSession(session, input.userMessage);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.reasoning?.effort).toBe(effort);
    } finally { session.dispose(); }
  });

  test('rejects unsupported effort instead of silently turning reasoning off', () => {
    const input = { provider: { modelId: 'synthetic-model' }, effort: 'unsupported' } as AgentTurnInput;
    expect(() => createNativeSession(input, [], () => undefined)).toThrow('Unsupported cloud reasoning effort');
    expect(() => createNativeSession({ ...input, effort: 'medium', provider: { ...input.provider, reasoning: false } }, [], () => undefined))
      .toThrow('does not support reasoning effort');
  });

  // Every wire protocol, because only `streamSimple` reads the thinking level
  // and each lane registers its own: a lane wired to the plain `stream` fn
  // still typechecks and still drops the effort. Each provider names it
  // differently, so assert the shape that provider actually sends.
  const EFFORT_LANES = [
    { api: 'anthropic-messages', provider: 'anthropic', body: anthropicStream(),
      assert: (request: Record<string, any>) => expect(request.thinking).toMatchObject({ type: 'enabled' }) },
    { api: 'openai-responses', provider: 'openai', body: responsesStream(),
      assert: (request: Record<string, any>) => expect(request.reasoning?.effort).toBe('medium') },
    { api: 'openai-completions', provider: 'openai', body: completionsStream(),
      assert: (request: Record<string, any>) => expect(request.reasoning_effort).toBe('medium') },
  ] as const;

  test.each(EFFORT_LANES)('sends configured medium effort over $api', async (lane) => {
    const requests: Record<string, any>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(lane.body, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const input = {
      provider: { api: lane.api, provider: lane.provider, modelId: 'reasoning-model',
        baseUrl: 'https://gateway.example.test/proxy/reasoning', apiKey: 'synthetic-credential', reasoning: true },
      effort: 'medium', systemPrompt: 'Be brief.', sessionJsonl: '', userMessage: 'Say done.',
    } as AgentTurnInput;
    const session = createNativeSession(input, [], () => undefined);
    try {
      await promptNativeSession(session, input.userMessage);
      expect(requests).toHaveLength(1);
      lane.assert(requests[0] ?? {});
    } finally { session.dispose(); }
  });

  test.each([false, true])('uses supportsStore=%s for prompts and compaction', async (supportsStore) => {
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const chunk = { id: 'synthetic-completion', object: 'chat.completion.chunk', created: 1,
        model: 'compatible-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'A concise answer and summary.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const input = {
      provider: { api: 'openai-completions', provider: 'openai', modelId: 'compatible-model',
        baseUrl: 'https://gateway.example.test/proxy/compatible', apiKey: 'synthetic-credential',
        compat: { supportsStore } },
      systemPrompt: 'Be brief.', sessionJsonl: '', userMessage: 'Summarize this text.',
      compaction: { enabled: false, contextWindow: 128000, reserveTokens: 100, keepRecentTokens: 1 },
    } as AgentTurnInput;
    const session = createNativeSession(input, [], () => undefined);
    try {
      await promptNativeSession(session, 'Summarize this text. '.repeat(30));
      await session.compact();
      expect(requests.length).toBeGreaterThanOrEqual(2);
      for (const request of requests) {
        expect(Object.hasOwn(request, 'store')).toBe(supportsStore);
        if (supportsStore) expect(request.store).toBe(false);
      }
    } finally { session.dispose(); }
  });
});
