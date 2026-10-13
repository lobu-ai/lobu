import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { runAgentTurn } from '../agent-turn/guest-entry.js';
import type { AgentTurnInput } from '../agent-turn/types.js';

const originalFetch = globalThis.fetch;
const info = spyOn(console, 'info').mockImplementation(() => undefined);
const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
afterEach(() => { globalThis.fetch = originalFetch; info.mockClear(); warn.mockClear(); });
afterAll(() => { info.mockRestore(); warn.mockRestore(); });

const input: AgentTurnInput = {
  provider: { api: 'openai-completions', provider: 'openai', modelId: 'synthetic-model',
    baseUrl: 'https://provider.example.test/v1', apiKey: 'synthetic-placeholder' },
  systemPrompt: 'SYSTEM_NOT_MEMORY', userMessage: 'My Atlas deadline is Tuesday.', sessionJsonl: '',
  memory: { mcpId: 'synthetic-memory', agentId: 'synthetic-agent' },
  tools: { gatewayUrl: 'https://gateway.example.test', definitions: [], conversation: {
    channelId: 'synthetic-channel', conversationId: 'synthetic-conversation', platform: 'api',
  } },
};
const receipt = { id: 42, durable_at: '2026-01-01T00:00:00Z' };
const textResult = (text: string) => ({ content: [{ type: 'text', text }] });
function answer(text = 'I think Friday might work, but that is speculation.') {
  return new Response(`data: ${JSON.stringify({ id: 'synthetic-response', object: 'chat.completion.chunk',
    created: 1, model: 'synthetic-model', choices: [{ index: 0, delta: {role: 'assistant', content: text}, finish_reason: 'stop' }],
  })}\n\ndata: [DONE]\n\n`, {headers: {'content-type': 'text/event-stream'}});
}

test.each(['thrown', 'legacy-text', 'structured', 'http', 'invalid'] as const)('memory %s failures stay nonfatal and never log captured success', async (kind) => {
  globalThis.fetch = (async (url) => {
    if (!String(url).includes('/mcp/')) return answer();
    if (kind === 'thrown') throw new Error('synthetic offline');
    if (kind === 'http') return Response.json({error: 'synthetic unavailable'}, {status: 503});
    return Response.json(kind === 'legacy-text' ? textResult('Error: synthetic failure') :
      kind === 'structured' ? {...textResult('MISLEADING_SUCCESS'), isError: true, structuredContent: receipt} : {});
  }) as typeof fetch;
  expect((await runAgentTurn(input, () => undefined)).text).toContain('speculation');
  expect(info.mock.calls.some(([message]) => String(message).includes('Captured conversation'))).toBe(false);
  expect(warn).toHaveBeenCalled();
});

test.each(['structuredContent', 'json-text'] as const)('preserves structured success and the %s save receipt across the real HTTP adapter', async (format) => {
  let providerBody = ''; let saveFormat = '';
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/search_memory')) return Response.json({...textResult('Error: is the title of a saved note'), isError: false});
    if (String(url).endsWith('/save_memory')) {
      saveFormat = new Headers(init?.headers).get('x-mcp-format') ?? '';
      return Response.json(format === 'structuredContent'
        ? {...textResult('Rendered receipt'), isError: false, structuredContent: receipt}
        : {...textResult(JSON.stringify(receipt)), isError: false});
    }
    providerBody = String(init?.body); return answer();
  }) as typeof fetch;
  await runAgentTurn(input, () => undefined);
  expect(providerBody).toContain('Error: is the title of a saved note');
  expect(saveFormat).toBe('json');
  expect(info.mock.calls.some(([message]) => String(message).includes('Captured conversation'))).toBe(true);
});

test('captures then recalls in a genuinely fresh native session with scripted memory/provider boundaries', async () => {
  // Each run creates its own PluginHost and native AgentSession. No session JSONL
  // crosses into the second run: only the mocked durable tool store survives.
  let saved = ''; const requests: string[] = []; const saves: Record<string, unknown>[] = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/search_memory')) return Response.json({...textResult(saved), isError: false});
    if (String(url).endsWith('/save_memory')) {
      const args = JSON.parse(String(init?.body)); saves.push(args); saved = args.content;
      return Response.json({...textResult('receipt'), isError: false, structuredContent: receipt});
    }
    requests.push(String(init?.body)); return answer();
  }) as typeof fetch;
  const first = await runAgentTurn({...input, userMessage: `Atlas heartbeat plan: ${'detail '.repeat(600)}Correction: Tuesday, not Monday.`}, () => undefined);
  expect(first.sessionJsonl).toContain('Correction: Tuesday, not Monday.');
  expect(saved).toContain('Correction: Tuesday, not Monday.'); expect(saved).toContain('not user assertions');
  expect(saved).not.toContain('SYSTEM_NOT_MEMORY'); expect(saved.length).toBeLessThanOrEqual(2000);
  const second = await runAgentTurn({...input, sessionJsonl: '', userMessage: 'What is my Atlas heartbeat deadline?'}, () => undefined);
  const sent = JSON.parse(requests[1]!);
  expect(sent.messages.filter((m: {role: string}) => m.role === 'user')).toHaveLength(1);
  expect(requests[1]).toContain('<lobu-memory>'); expect(requests[1]).toContain('Correction: Tuesday, not Monday.');
  expect(second.sessionJsonl).not.toContain('<lobu-memory>'); expect(second.sessionJsonl).not.toContain('Correction: Tuesday, not Monday.');
  expect(saves[1]!.content).not.toContain('Correction: Tuesday, not Monday.');
  expect(info.mock.calls.filter(([message]) => String(message).includes('Captured conversation'))).toHaveLength(2);
});
