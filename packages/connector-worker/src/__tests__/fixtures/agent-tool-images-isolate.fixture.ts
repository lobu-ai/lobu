import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { AGENT_TURN_BRIDGE_BYTES } from '@lobu/core/contracts/worker/protocol';
import imageFixture from '../../../../../scripts/__tests__/fixtures/synthetic-image.js';
import { buildAgentGuest } from '../../agent-turn/bundle.js';
import type { AgentTurnEvent, AgentTurnInput } from '../../agent-turn/types.js';
import { IsolateExecutor } from '../../executor/isolate.js';

for (const exhaustBudget of [false, true]) test(`real guest restores pixels and their bridge budget (exhaust: ${exhaustBudget})`, async () => {
  const bytes = exhaustBudget ? Buffer.alloc(5 * 1024 * 1024) : imageFixture.syntheticImage().bytes;
  if (exhaustBudget) imageFixture.syntheticImage().bytes.copy(bytes);
  const data = bytes.toString('base64');
  const requests: string[] = [];
  const unexpected: string[] = [];
  const traces: AgentTurnEvent[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.url === '/mcp/synthetic/tools/observe') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'image', mimeType: 'image/png', data }] }));
      return;
    }
    if (req.url !== '/v1/chat/completions') {
      unexpected.push(req.url ?? '');
      res.writeHead(404).end();
      return;
    }
    requests.push(Buffer.concat(chunks).toString());
    const choice = requests.length === 1 || (exhaustBudget && (requests.length === 3 || requests.length === 4))
      ? { index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `observe-call-${requests.length}`, type: 'function', function: { name: 'observe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }
      : { index: 0, delta: { role: 'assistant', content: 'Transport recorded.' }, finish_reason: 'stop' };
    res.setHeader('content-type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [choice] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const gatewayUrl = `http://127.0.0.1:${address.port}`;
    const input: AgentTurnInput = {
      provider: { api: 'openai-completions', provider: 'openai', modelId: 'synthetic', baseUrl: `${gatewayUrl}/v1`, apiKey: 'synthetic-key', input: ['text', 'image'] },
      systemPrompt: 'Observe once.', userMessage: 'Inspect the square.', sessionJsonl: '',
      tools: { gatewayUrl, definitions: [{ mcpId: 'synthetic', name: 'observe', description: 'Observe', inputSchema: { type: 'object', properties: {} } }] },
    };
    const bundle = await buildAgentGuest();
    const executor = new IsolateExecutor({ timeoutMs: 10_000, allowedDomains: ['127.0.0.1'], messageBytes: AGENT_TURN_BRIDGE_BYTES });
    const run = (turn: AgentTurnInput) => executor.execute(bundle, {
      mode: 'agent_turn', turn, credentials: { accessToken: 'synthetic-host-token' }, config: {}, sessionState: null, env: {},
    }, { onTurnEvent: event => { traces.push(event); } });
    const first = await run(input);
    assert.equal(first.mode, 'agent_turn');
    if (first.mode !== 'agent_turn') throw new Error('Wrong executor mode');
    assert.equal(first.turn.text, 'Transport recorded.');
    assert.equal(requests.length, 2);
    assert.ok(!requests[0]!.includes(data));
    assert.ok(requests[1]!.includes(`data:image/png;base64,${data}`));
    assert.ok(first.turn.sessionJsonl.includes(data));
    const second = await run({ ...input, sessionJsonl: first.turn.sessionJsonl, userMessage: 'Recall the observation.' });
    assert.equal(second.mode, 'agent_turn');
    assert.equal(requests.length, exhaustBudget ? 5 : 3);
    if (exhaustBudget) {
      assert.ok(requests[4]!.includes('image budget exhausted'));
      assert.equal(requests[4]!.split(`data:image/png;base64,${data}`).length - 1, 2);
      assert.ok(Buffer.byteLength(second.turn.sessionJsonl) < AGENT_TURN_BRIDGE_BYTES);
    }
    assert.ok(requests[2]!.includes(`data:image/png;base64,${data}`));
    assert.ok(!JSON.stringify(traces).includes(data));
    assert.deepEqual(unexpected, []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
