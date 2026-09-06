/**
 * The agent-session GUEST. This module is bundled by `bundle.ts` with the
 * lane's own esbuild options and executed inside the isolate, so it must stay
 * portable: no `node:` import, no host module, nothing the guest prelude does
 * not provide.
 *
 * It runs one turn of pi's agent loop. The loop itself (`pi-agent-core`) has no
 * Node dependency; the provider call is pi-ai's fetch-native Anthropic or
 * OpenAI path, which reaches the network through the prelude's streaming
 * `fetch` and therefore through the host's one egress module. A tool call is
 * the same kind of request to the same host: the gateway's MCP route, over the
 * same `fetch`, under the same allowlist. A workspace tool never leaves the
 * isolate at all: `bash` is just-bash over an in-memory filesystem that lives
 * for this turn.
 *
 * The turn holds ONE credential and never a real one. `provider.apiKey` is the
 * host's vault placeholder over the gateway's per-turn worker token; the host
 * swaps it into the outbound header, the secret proxy accepts it as the
 * provider credential and the MCP route accepts it as the bearer.
 */

import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { streamAnthropic } from '@mariozechner/pi-ai/anthropic';
import { streamOpenAICompletions } from '@mariozechner/pi-ai/openai-completions';
import { createGatewayTools } from './gateway-tools.js';
import type { AgentTurnEvent, AgentTurnInput, AgentTurnOutput, AgentTurnTool } from './types.js';
import { createWorkspaceTools } from './workspace.js';

/**
 * A turn's tool-call budget. pi would otherwise loop for as long as the model
 * keeps calling tools and the wall clock allows; past this many calls the loop
 * refuses the next one with a reason the model can act on, so the turn ends
 * with an answer instead of a timeout.
 */
const MAX_TOOL_CALLS_PER_TURN = 50;

/** Third-party MCP server on the other side of the gateway: generous, never forever. */
const TOOL_CALL_TIMEOUT_MS = 120_000;

/** What of a tool's output the host sees in the event stream. */
const TOOL_EVENT_OUTPUT_CHARS = 2_000;

/**
 * The model object pi-ai reads. The gateway resolves which model a turn runs,
 * not its price list or its window, so the fields pi only uses for bookkeeping
 * are zeroed rather than guessed. `cost` carries all FOUR keys: pi divides by
 * each one to price a turn, so a missing `cacheRead`/`cacheWrite` puts NaN in
 * the transcript entry the next turn resumes from.
 */
function buildModel(input: AgentTurnInput): Record<string, unknown> {
  return {
    id: input.provider.modelId,
    name: input.provider.modelId,
    api: input.provider.api,
    provider: input.provider.provider,
    baseUrl: input.provider.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Only read to decide when to compact, which this lane never does: one
    // turn, one request, and the gateway owns the history it sends.
    contextWindow: 200_000,
    maxTokens: input.provider.maxTokens ?? 8192,
  };
}

/** The MCP proxy's REST reply for a tool call. */
interface McpToolReply {
  content?: Array<{ type?: string; text?: string }>;
  error?: string;
  isError?: boolean;
}

function joinText(content: McpToolReply['content']): string {
  return (content ?? [])
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

/**
 * One tool call: `POST {gateway}/mcp/{mcpId}/tools/{name}` with the turn's
 * credential as bearer. The gateway runs the agent's guardrails and approval
 * policy before the upstream sees the call, and answers a refusal as an error
 * result — so a blocked or approval-gated call reaches the model as the same
 * text the subprocess lane showed it, and the turn goes on.
 */
async function callMcpTool(
  gatewayUrl: string,
  credential: string,
  tool: AgentTurnTool,
  args: unknown
): Promise<string> {
  const url = `${gatewayUrl}/mcp/${encodeURIComponent(tool.mcpId)}/tools/${encodeURIComponent(tool.name)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`MCP tool ${tool.mcpId}/${tool.name} timed out`);
    }
    throw error;
  }
  let reply: McpToolReply;
  try {
    reply = (await response.json()) as McpToolReply;
  } catch (error) {
    throw new Error(
      `${tool.name} returned a non-JSON response (status ${response.status}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const text = joinText(reply.content);
  if (!response.ok || reply.isError) {
    throw new Error(reply.error || text || `${tool.name} failed (${response.status})`);
  }
  return text || `${tool.name} completed.`;
}

/**
 * pi's tool objects for the turn's manifest: the gateway's MCP tools, then its
 * conversation tools, then the workspace's own.
 *
 * `onAskUserPosted` is threaded through because `ask_user` ends the turn — see
 * `createGatewayTools`.
 */
function buildTools(
  input: AgentTurnInput,
  credential: string,
  onAskUserPosted: () => void
): AgentTool[] {
  const tools = input.tools;
  if (!tools) return [];
  const workspace = tools.builtin ? createWorkspaceTools(tools.builtin, tools.bashPolicy) : [];
  const gateway =
    tools.gateway && tools.gateway.length > 0 && tools.conversation
      ? createGatewayTools(tools.gateway, {
          gatewayUrl: tools.gatewayUrl,
          credential,
          conversation: tools.conversation,
          onAskUserPosted,
        })
      : [];
  const mcp: AgentTool[] = tools.definitions.map((tool) => ({
    name: tool.name,
    label: `${tool.mcpId}/${tool.name}`,
    description: tool.description,
    // A plain JSON schema: pi-ai validates arguments against it as-is.
    parameters: tool.inputSchema as never,
    execute: async (_toolCallId: string, args: unknown) => ({
      content: [{ type: 'text' as const, text: await callMcpTool(tools.gatewayUrl, credential, tool, args) }],
      details: {},
    }),
  }));
  return [...mcp, ...gateway, ...workspace];
}

function clip(text: string): string {
  return text.length > TOOL_EVENT_OUTPUT_CHARS ? `${text.slice(0, TOOL_EVENT_OUTPUT_CHARS)}…` : text;
}

/**
 * Run one turn and resolve with the transcript it produced.
 *
 * `emit` is the host bridge: every call crosses into the worker while the
 * stream is still open, which is what makes a delta on this lane arrive at the
 * same point in the turn as a delta on the subprocess lane.
 */
export async function runAgentTurn(
  input: AgentTurnInput,
  emit: (event: AgentTurnEvent) => void
): Promise<AgentTurnOutput> {
  const credential = input.provider.apiKey;
  if (!credential) throw new Error('the agent turn reached the guest with no credential');
  const model = buildModel(input);
  const stream = input.provider.api === 'anthropic-messages' ? streamAnthropic : streamOpenAICompletions;

  let toolCalls = 0;
  // `ask_user` hands the conversation back to the human: the question is posted
  // as buttons and the click returns as a NEW inbound message, which is a new
  // turn. The subprocess lane stops its session at that point
  // (`onAskUserPosted`); this lane must too, or the model keeps calling tools
  // and answering a question nobody has read yet.
  let askedUser = false;
  const agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
      model: model as never,
      messages: input.messages as never,
      tools: buildTools(input, credential, () => {
        askedUser = true;
      }),
    },
    // pi hands the loop's own options through; the key rides here rather than
    // in the model so it never lands in a transcript entry.
    streamFn: ((m: unknown, context: unknown, options: Record<string, unknown> | undefined) =>
      (stream as (a: unknown, b: unknown, c: unknown) => unknown)(m, context, {
        ...(options ?? {}),
        apiKey: credential,
      })) as never,
    beforeToolCall: async () => {
      if (askedUser) {
        return {
          block: true,
          reason: 'You have already asked the user a question; this turn is over. Stop and wait for their reply.',
        };
      }
      toolCalls += 1;
      if (toolCalls <= MAX_TOOL_CALLS_PER_TURN) return undefined;
      return {
        block: true,
        reason: `This turn's tool-call budget (${MAX_TOOL_CALLS_PER_TURN}) is spent; answer with what you have.`,
      };
    },
  });

  let text = '';
  let stopReason: string | null = null;
  let usage: AgentTurnOutput['usage'] = null;
  // pi does not throw a failed provider call: it ends the turn with an
  // assistant message whose stopReason is 'error'. On this lane a failed turn
  // must be a failed RUN, or the job completes 'successfully' with no text.
  let failure: string | null = null;

  agent.subscribe((event) => {
    if (event.type === 'message_update') {
      const partial = event.assistantMessageEvent as { type?: string; delta?: string };
      if (partial.type === 'text_delta' && typeof partial.delta === 'string') {
        text += partial.delta;
        emit({ type: 'text_delta', delta: partial.delta });
      } else if (partial.type === 'thinking_delta' && typeof partial.delta === 'string') {
        emit({ type: 'thinking_delta', delta: partial.delta });
      }
      return;
    }
    if (event.type === 'message_end') {
      const message = event.message as unknown as {
        role?: string;
        stopReason?: string;
        errorMessage?: string;
        usage?: { input?: number; output?: number };
      };
      // Tool results end a message too; only the assistant's own carry the
      // turn's outcome.
      if (message.role !== 'assistant') return;
      if (typeof message.stopReason === 'string') stopReason = message.stopReason;
      if (typeof message.errorMessage === 'string' && message.errorMessage) failure = message.errorMessage;
      if (message.usage) {
        usage = {
          input: (usage?.input ?? 0) + (message.usage.input ?? 0),
          output: (usage?.output ?? 0) + (message.usage.output ?? 0),
        };
      }
      emit({ type: 'message_end' });
      return;
    }
    if (event.type === 'tool_execution_start') {
      emit({ type: 'tool_call_start', toolCallId: event.toolCallId, name: event.toolName, args: event.args });
      return;
    }
    if (event.type === 'tool_execution_end') {
      const result = event.result as { content?: Array<{ type?: string; text?: string }> };
      emit({
        type: 'tool_call_end',
        toolCallId: event.toolCallId,
        name: event.toolName,
        isError: event.isError,
        output: clip(joinText(result?.content)),
      });
    }
  });

  await agent.prompt(input.userMessage);
  await agent.waitForIdle();

  const stateError = (agent.state as { errorMessage?: string }).errorMessage;
  const ended = failure ?? (typeof stateError === 'string' && stateError ? stateError : null);
  if (ended) throw new Error(ended);

  return {
    text,
    stopReason,
    usage,
    messages: agent.state.messages as unknown as AgentTurnOutput['messages'],
  };
}
