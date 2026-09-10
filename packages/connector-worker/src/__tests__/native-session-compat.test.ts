import { afterEach, describe, expect, test } from 'bun:test';
import { createNativeSession, promptNativeSession } from '../agent-turn/native-session.js';
import type { AgentTurnInput } from '../agent-turn/types.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('native session provider compatibility', () => {
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
