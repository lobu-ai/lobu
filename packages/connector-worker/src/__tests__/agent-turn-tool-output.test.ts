/**
 * A tool trace must fit the wire contract it rides on.
 *
 * The guest clips a tool result for display and appends `…`, but the marker
 * counts against `TURN_TOOL_OUTPUT_MAX_CHARS`, so a full-width slice plus the
 * marker was one character over. Nothing is lenient about that overshoot: the
 * heartbeat route drops the whole streamed payload (the turn's text delta
 * included), and the completion route answers 400, which the daemon arm turns
 * into a FAILED turn — the model's answer thrown away over a display field.
 *
 * Both boundary lengths run so the local cap in the guest and the contract's
 * `maxLength` cannot drift apart unnoticed: exactly the cap must survive
 * untouched, and one past it must come back within the cap. The real schemas
 * do the judging, and the model's own view of the result is asserted
 * unclipped — the bound is on the trace, never on the turn's context.
 */
import { afterEach, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { CompleteAgentTurnRequestSchema, HeartbeatRequestSchema, TURN_TOOL_OUTPUT_MAX_CHARS } from '@lobu/core/contracts/worker/protocol';
import { runAgentTurn } from '../agent-turn/guest-entry.js';
import type { AgentTurnEvent } from '../agent-turn/types.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test.each([TURN_TOOL_OUTPUT_MAX_CHARS, TURN_TOOL_OUTPUT_MAX_CHARS + 1])(
  'a %i-character tool result produces a valid streamed heartbeat without clipping model context',
  async (length) => {
    const fullOutput = 'x'.repeat(length);
    const events: AgentTurnEvent[] = [];
    let requests = 0;
    let modelToolResult: unknown;
    globalThis.fetch = (async (url, init) => {
      if (String(url).includes('/mcp/')) {
        return Response.json({ content: [{ type: 'text', text: fullOutput }] });
      }
      const body = JSON.parse(String(init?.body));
      requests += 1;
      const tool = body.messages.find((message: { role: string }) => message.role === 'tool');
      if (tool) modelToolResult = tool.content;
      const choice = requests === 1
        ? { index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function', function: { name: 'large_result', arguments: '{}' } }] }, finish_reason: 'tool_calls' }
        : { index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' };
      const chunk = { id: 'synthetic-response', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [choice] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    const result = await runAgentTurn({
      provider: { api: 'openai-completions', provider: 'openai', modelId: 'synthetic-model', baseUrl: 'https://provider.example.test/v1', apiKey: 'synthetic-key' },
      systemPrompt: 'Use the tool, then finish.', userMessage: 'Read it.', sessionJsonl: '',
      tools: { gatewayUrl: 'https://gateway.example.test', definitions: [{ mcpId: 'synthetic', name: 'large_result', description: 'Read a result', inputSchema: { type: 'object', properties: {} } }] },
    }, (event) => events.push(event));
    const trace = events.find((event) => event.type === 'tool_call_end');
    expect(trace?.type).toBe('tool_call_end');
    if (trace?.type !== 'tool_call_end') throw new Error('missing tool trace');
    expect(modelToolResult).toBe(fullOutput);
    expect(result.text).toBe('Done.');
    const toolEvents = [{ tool_call_id: trace.toolCallId, name: trace.name, is_error: trace.isError, output: trace.output }];
    expect(Value.Check(HeartbeatRequestSchema, {
      run_id: 4242, worker_id: 'synthetic-worker',
      turn_delta: { text: 'Done.', sequence: 1 },
      turn_tool_events: toolEvents,
    })).toBe(true);
    expect(Value.Check(CompleteAgentTurnRequestSchema, {
      run_id: 4242, worker_id: 'synthetic-worker', status: 'completed',
      text: result.text, session_jsonl: result.sessionJsonl, turn_tool_events: toolEvents,
    })).toBe(true);
    // Exactly the cap survives whole; one past it comes back AT the cap, with
    // the marker as the character the clip made room for.
    expect(trace.output.length).toBe(Math.min(length, TURN_TOOL_OUTPUT_MAX_CHARS));
    expect(trace.output.endsWith('…')).toBe(length > TURN_TOOL_OUTPUT_MAX_CHARS);
  },
);
