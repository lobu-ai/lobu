/**
 * Per-input attribution for a steered agent turn (#3662).
 *
 * A follow-up that steers a running turn makes Pi answer twice in one
 * execution. Each answer — and each tool result — belongs to the message that
 * initiated it: the owner prompt keeps its own text, tools, and verbatim
 * first error, and the steered input gets its own rather than borrowing a
 * sibling's. A delayed tool result that lands after the follow-up arrived
 * stays with its initiating message, and the completion receipts validate
 * against the turn contract.
 */
import { afterEach, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { CompleteAgentTurnRequestSchema } from '@lobu/core/contracts/worker/protocol';
import { runAgentTurn } from '../agent-turn/guest-entry.js';
import type { AgentTurnEvent } from '../agent-turn/types.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const CONNECTOR_ERROR = 'Error: Not authorized for this conversation';

function sse(choices: unknown[]) {
  return new Response(
    choices.map((choice) => `data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [choice] })}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

/**
 * One steered follow-up, one failing connector call on the owner input.
 *
 * The model answers the owner prompt with text plus a `send_message` call
 * that fails; the failure steers in a follow-up, which the model answers on
 * the next request. The receipts must keep every side separate.
 */
test('a steered turn attributes each answer, tool, and error to its initiating input', async () => {
  const events: AgentTurnEvent[] = [];
  let steeringTaken = 0;
  const takeSteering = () => {
    steeringTaken += 1;
    return steeringTaken === 1
      ? [{ runId: 701, messageId: 'input-0', text: 'Did the draft go out?' }]
      : [];
  };
  let requests = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes('/mcp/')) {
      return Response.json({ content: [{ type: 'text', text: CONNECTOR_ERROR }], isError: true });
    }
    requests += 1;
    const body = JSON.parse(String(init?.body));
    if (requests === 1) {
      expect(JSON.stringify(body.messages)).toContain('Original question');
      return sse([{
        index: 0,
        delta: {
          role: 'assistant',
          content: 'Owner answer.',
          tool_calls: [{ index: 0, id: 'call_send', type: 'function', function: { name: 'send_message', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      }]);
    }
    return sse([{
      index: 0, delta: { role: 'assistant', content: 'Steered answer.' }, finish_reason: 'stop',
    }]);
  }) as typeof fetch;

  const result = await runAgentTurn({
    provider: { api: 'openai-completions', provider: 'openai', modelId: 'synthetic-model', baseUrl: 'https://provider.example.test/v1', apiKey: 'synthetic-key' },
    systemPrompt: 'Answer each message from its own results.',
    userMessage: 'Original question',
    sessionJsonl: '',
    tools: { gatewayUrl: 'https://gateway.example.test', definitions: [{ mcpId: 'synthetic', name: 'send_message', description: 'Send', inputSchema: { type: 'object', properties: {} } }] },
  }, (event) => events.push(event), takeSteering);

  // The owner's answer is its own text — never joined with the steered one.
  expect(result.text).toBe('Owner answer.');
  // The steered input's receipt carries its own answer, and only its own.
  expect(result.consumedInputs).toHaveLength(1);
  expect(result.consumedInputs[0]).toMatchObject({ runId: 701, responseText: 'Steered answer.' });
  expect(result.consumedInputs[0]!.responseText).not.toContain('Owner answer.');
  // The failing call ran for the owner input: the owner's ledger names it,
  // the steered receipt names nothing, and the verbatim error rides the
  // owner — not paraphrased, not borrowed.
  expect(result.toolsUsed).toEqual(['send_message']);
  expect(result.consumedInputs[0]!.toolsUsed).toEqual([]);
  expect(result.firstError).toBe(CONNECTOR_ERROR);
  expect(result.consumedInputs[0]!.firstError).toBeUndefined();
  const trace = events.find((event) => event.type === 'tool_call_end');
  expect(trace?.type).toBe('tool_call_end');
  if (trace?.type !== 'tool_call_end') throw new Error('missing tool trace');
  expect(trace.isError).toBe(true);
  expect(trace.output).toBe(CONNECTOR_ERROR);
  expect(trace.inputRunId).toBeUndefined();

  // The receipts validate as a per-input completion body.
  expect(Value.Check(CompleteAgentTurnRequestSchema, {
    run_id: 11, worker_id: 'synthetic-worker', status: 'completed',
    text: result.text, session_jsonl: result.sessionJsonl,
    tools_used: result.toolsUsed, first_error: result.firstError,
    consumed_inputs: result.consumedInputs.map((input) => ({
      run_id: input.runId, session_entry_id: input.sessionEntryId,
      response_text: input.responseText,
      ...(input.toolsUsed.length ? { tools_used: input.toolsUsed } : {}),
      ...(input.firstError ? { first_error: input.firstError } : {}),
    })),
  })).toBe(true);
});

/**
 * Identical steered prompts get separate answers, not one shared text.
 *
 * Two follow-ups with the same words still complete as two inputs, each with
 * the answer that followed its own message.
 */
test('identical steered prompts complete with separate answers', async () => {
  let steeringTaken = 0;
  const takeSteering = () => {
    steeringTaken += 1;
    return steeringTaken === 1
      ? [
        { runId: 801, messageId: 'input-0', text: 'same text' },
        { runId: 802, messageId: 'input-1', text: 'same text' },
      ]
      : [];
  };
  let requests = 0;
  const answers = ['Owner answer.', 'First follow-up answer.', 'Second follow-up answer.'];
  globalThis.fetch = (async (_url, init) => {
    requests += 1;
    const answer = answers[Math.min(requests, answers.length) - 1];
    return sse([{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: 'stop' }]);
  }) as typeof fetch;

  const result = await runAgentTurn({
    provider: { api: 'openai-completions', provider: 'openai', modelId: 'synthetic-model', baseUrl: 'https://provider.example.test/v1', apiKey: 'synthetic-key' },
    systemPrompt: 'Answer briefly.', userMessage: 'Original question', sessionJsonl: '',
  }, () => undefined, takeSteering);

  expect(result.text).toBe('Owner answer.');
  expect(result.consumedInputs.map((input) => [input.runId, input.responseText])).toEqual([
    [801, 'First follow-up answer.'],
    [802, 'Second follow-up answer.'],
  ]);
});

/**
 * A steered input the turn never answers fails the turn instead of borrowing
 * a sibling's text.
 *
 * Two follow-ups arrive; the model answers after the first but the turn ends
 * on an empty message after the second. The orphaned input has a branch entry
 * but no settled answer, so completing it would have to invent text.
 */
test('a steered input without its own answer fails the turn', async () => {
  let steeringTaken = 0;
  const takeSteering = () => {
    steeringTaken += 1;
    if (steeringTaken === 1) return [{ runId: 901, messageId: 'input-0', text: 'first follow-up' }];
    if (steeringTaken === 2) return [{ runId: 902, messageId: 'input-1', text: 'second follow-up' }];
    return [];
  };
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    if (requests === 1) {
      return sse([{ index: 0, delta: { role: 'assistant', content: 'Owner answer.' }, finish_reason: 'stop' }]);
    }
    if (requests === 2) {
      return sse([{ index: 0, delta: { role: 'assistant', content: 'Middle answer.' }, finish_reason: 'stop' }]);
    }
    // The turn ends without addressing the second follow-up.
    return sse([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'stop' }]);
  }) as typeof fetch;

  const error = await runAgentTurn({
    provider: { api: 'openai-completions', provider: 'openai', modelId: 'synthetic-model', baseUrl: 'https://provider.example.test/v1', apiKey: 'synthetic-key' },
    systemPrompt: 'Answer briefly.', userMessage: 'Original question', sessionJsonl: '',
  }, () => undefined, takeSteering).then(() => null, (err: unknown) => err);
  expect(error).toBeInstanceOf(Error);
  expect(String((error as Error).message)).toContain('completed without its own answer');
});
