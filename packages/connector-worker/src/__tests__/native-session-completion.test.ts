import { afterEach, expect, test } from 'bun:test';
import { createNativeSession, nativeSessionJsonl, promptNativeSession } from '../agent-turn/native-session.js';
import type { AgentTurnInput } from '../agent-turn/types.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function response(used: number) {
  const chunk = { id: 'synthetic-completion', object: 'chat.completion.chunk', created: 1,
    model: 'synthetic-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Finished.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: used, completion_tokens: 10, total_tokens: used + 10 } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

test('persists a finished turn without waiting for threshold compaction, then compacts before resuming', async () => {
  let release!: () => void;
  // Every request after the answer hangs until released, so a turn that waits
  // for its own threshold compaction never settles and this test fails.
  const maintenance = new Promise<void>(resolve => { release = resolve; });
  const requests: Record<string, any>[] = [];
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length > 1) await maintenance;
    return response(requests.length === 1 ? 950 : 10);
  }) as typeof fetch;
  const input: AgentTurnInput = {
    provider: { api: 'openai-completions', provider: 'openai', modelId: 'synthetic-model',
      baseUrl: 'https://gateway.example.test/proxy', apiKey: 'synthetic-credential' },
    systemPrompt: 'Be brief.', sessionJsonl: '', userMessage: 'Synthetic context data. '.repeat(100),
    compaction: { enabled: true, contextWindow: 1000, reserveTokens: 100, keepRecentTokens: 1 },
  };
  const session = createNativeSession(input, [], () => undefined);
  let settled = false;
  const turn = promptNativeSession(session, input.userMessage).then(() => { settled = true; });
  try {
    await Promise.race([turn, new Promise(resolve => setTimeout(resolve, 5_000))]);
    expect(settled).toBe(true);
    expect(requests).toHaveLength(1);
    const checkpoint = nativeSessionJsonl(session);
    expect(checkpoint).toContain('Finished.');
    expect(checkpoint).not.toContain('"type":"compaction"');
    // Restored for the next prompt: the deferred compaction still has to run,
    // just on the turn that actually needs the room.
    expect(session.autoCompactionEnabled).toBe(true);
    release();
    await promptNativeSession(session, 'Continue.');
    // Summarize, then the resumed prompt.
    expect(requests).toHaveLength(3);
    expect(nativeSessionJsonl(session)).toContain('"type":"compaction"');
    expect(requests.at(-1)?.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'Continue.' }]);
  } finally {
    release();
    await turn;
    session.dispose();
  }
});
