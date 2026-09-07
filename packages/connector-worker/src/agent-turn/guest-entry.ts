/**
 * The agent-session GUEST. This module is bundled by `bundle.ts` with the
 * lane's own esbuild options and executed inside the isolate, so it must stay
 * portable: no `node:` import, no host module, nothing the guest prelude does
 * not provide.
 *
 * It runs Pi's original AgentSession with an in-memory SessionManager. The
 * provider call is pi-ai's fetch-native Anthropic or OpenAI path, which
 * reaches the network through the prelude's streaming `fetch` and therefore
 * through the host's one egress module. A tool call is
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

import type { AgentTool, AgentMessage } from '@mariozechner/pi-agent-core';
import { createGatewayTools } from './gateway-tools.js';
import { createTurnMediaTools } from './media-tools.js';
import { createTurnMemoryHooks, type TurnMemory } from './memory.js';
import { estimatePromptTokenCost, memoryFlushDue, MEMORY_FLUSH_STATE_CUSTOM_TYPE } from '@lobu/core/memory-flush';
import { createNativeSession, nativeSessionJsonl, promptNativeSession } from './native-session.js';
import type { AgentTurnEvent, AgentTurnInput, AgentTurnOutput, AgentTurnTool, AgentTurnSteer, RuntimeExecRequest, RuntimeExecResult } from './types.js';
import { createWorkspace, type AgentWorkspace } from './workspace.js';

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
  args: unknown,
  timeoutMs = TOOL_CALL_TIMEOUT_MS
): Promise<string> {
  const url = `${gatewayUrl}/mcp/${encodeURIComponent(tool.mcpId)}/tools/${encodeURIComponent(tool.name)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
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
  onAskUserPosted: () => void,
  onInBandReplyDelivered: () => void,
  emit: (event: AgentTurnEvent) => void,
  runtimeExec?: (request: RuntimeExecRequest) => Promise<RuntimeExecResult>
): AgentTool[] {
  const tools = input.tools;
  if (!tools) return [];
  // ONE workspace for the whole turn: the file tools act on it and
  // `upload_file` reads it, so the file the model just wrote is the file it can
  // show. Built even when no file tool was admitted but a media tool was, since
  // `bash` alone is enough to produce something worth uploading.
  // On a sandbox-pinned conversation `bash` runs in the remote runtime through
  // the host; the file tools stay on the in-memory workspace, as on the
  // subprocess lane where they read the local directory beside a remote shell.
  const remote = tools.remoteRuntime && runtimeExec ? { exec: runtimeExec } : undefined;
  const workspace: AgentWorkspace | null =
    tools.builtin && tools.builtin.length > 0 ? createWorkspace(tools.builtin, tools.bashPolicy, remote) : null;
  const gateway =
    tools.gateway && tools.gateway.length > 0 && tools.conversation
      ? createGatewayTools(tools.gateway, {
          gatewayUrl: tools.gatewayUrl,
          credential,
          conversation: tools.conversation,
          onAskUserPosted,
          onInBandReplyDelivered,
        })
      : [];
  const media =
    tools.media && tools.media.length > 0 && tools.conversation
      ? createTurnMediaTools(tools.media, {
          gatewayUrl: tools.gatewayUrl,
          credential,
          conversation: tools.conversation,
          workspace,
          // The subprocess lane turns this into a `file-uploaded` custom event.
          // This lane has one channel out of the isolate — the event stream —
          // so it rides that, and the host decides what to do with it.
          onFileUploaded: (data) => emit({ type: 'file_uploaded', data }),
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
  return [...mcp, ...gateway, ...media, ...(workspace?.tools ?? [])];
}

/**
 * Where a plugin hook's own diagnostics go.
 *
 * The prelude routes `console` to the host `log` capability, which redacts the
 * line and charges it to the run's log budget — the same channel every other
 * guest line takes. `PluginLogger` takes a message plus optional structured
 * data, so the data rides as a second argument rather than being folded into
 * the message.
 */
const guestLogger = {
  debug: (message: string, data?: Record<string, unknown>) => console.debug(message, data ?? {}),
  info: (message: string, data?: Record<string, unknown>) => console.info(message, data ?? {}),
  warn: (message: string, data?: Record<string, unknown>) => console.warn(message, data ?? {}),
  error: (message: string, data?: Record<string, unknown>) => console.error(message, data ?? {}),
};

function clip(text: string): string {
  return text.length > TOOL_EVENT_OUTPUT_CHARS ? `${text.slice(0, TOOL_EVENT_OUTPUT_CHARS)}…` : text;
}

/**
 * One line per non-image attachment, appended to the user turn.
 *
 * The subprocess lane names the user's uploads in the prompt and leaves the
 * bytes on the worker's disk for `cat`; this lane has no disk, so it names them
 * the same way and says plainly that it cannot open them. Silently dropping
 * them would let the model answer a question about a file it was never told
 * existed.
 */
function describeFiles(files: AgentTurnInput['files']): string {
  if (!files || files.length === 0) return '';
  const listing = files
    .map((file) => `- ${file.name} (${file.mimeType}${file.size !== undefined ? `, ${file.size} bytes` : ''})`)
    .join('\n');
  return `The user attached ${files.length} non-image file(s) that this turn cannot open:\n${listing}`;
}

/**
 * Run one turn and resolve with its native Pi session checkpoint.
 *
 * `emit` is the host bridge: every call crosses into the worker while the
 * stream is still open, which is what makes a delta on this lane arrive at the
 * same point in the turn as a delta on the subprocess lane.
 */
export async function runAgentTurn(
  input: AgentTurnInput,
  emit: (event: AgentTurnEvent) => void,
  takeSteering: () => AgentTurnSteer[] = () => [],
  runtimeExec?: (request: RuntimeExecRequest) => Promise<RuntimeExecResult>
): Promise<AgentTurnOutput> {
  const credential = input.provider.apiKey;
  if (!credential) throw new Error('the agent turn reached the guest with no credential');

  // Long-term memory, if this turn has any. `@lobu/plugin-memory`'s own hooks,
  // dispatched through the real `PluginHost`, over the MCP route this turn
  // already calls.
  const memory: TurnMemory | null =
    input.memory && input.tools
      ? createTurnMemoryHooks({
          gatewayUrl: input.tools.gatewayUrl,
          credential,
          agentId: input.memory.agentId,
          conversationId: input.tools.conversation?.conversationId ?? '',
          mcpId: input.memory.mcpId,
          callTool: (mcpId, toolName, args, options) =>
            callMcpTool(
              (input.tools as { gatewayUrl: string }).gatewayUrl,
              credential,
              { mcpId, name: toolName, description: '', inputSchema: {} },
              args,
              options?.timeoutMs
            ),
          logger: guestLogger,
        })
      : null;

  let toolCalls = 0;
  // `ask_user` hands the conversation back to the human: the question is posted
  // as buttons and the click returns as a NEW inbound message, which is a new
  // turn. The subprocess lane stops its session at that point
  // (`onAskUserPosted`); this lane must too, or the model keeps calling tools
  // and answering a question nobody has read yet.
  let askedUser = false;
  // `send_message`/`present_event` posted into the conversation this turn is
  // already answering, so the user has READ the answer and the terminal reply
  // would be the same message twice. The subprocess lane suppresses the
  // terminal delivery on exactly this signal; this lane reports it out so the
  // completion route can stamp the flag the renderers already act on.
  let repliedInBand = false;
  let transientContext: string | undefined;
  const tools = buildTools(
    input,
    credential,
    () => { askedUser = true; },
    () => { repliedInBand = true; },
    emit,
    runtimeExec
  );
  const session = createNativeSession(input, tools, () => transientContext);
  session.subscribe((event) => {
    if (event.type === 'compaction_end' && event.errorMessage) console.warn(event.errorMessage);
  });
  const agent = session.agent;
  const nativeBeforeToolCall = agent.beforeToolCall;
  agent.beforeToolCall = async (context) => {
    if (askedUser) {
      return {
        block: true,
        reason: 'You have already asked the user a question; this turn is over. Stop and wait for their reply.',
      };
    }
    toolCalls += 1;
    if (toolCalls <= MAX_TOOL_CALLS_PER_TURN) return nativeBeforeToolCall?.(context);
    return {
      block: true,
      reason: `This turn's tool-call budget (${MAX_TOOL_CALLS_PER_TURN}) is spent; answer with what you have.`,
    };
  };

  try {
    const recalled = memory ? await memory.recall(input.userMessage, agent.state.messages) : '';
    transientContext = [recalled, describeFiles(input.files)].filter(Boolean).join('\n\n');

    let text = '';
    let stopReason: string | null = null;
    let usage: AgentTurnOutput['usage'] = null;
    // While the pre-compaction memory flush runs, nothing it produces is the
    // turn's answer: no deltas leave the isolate and no text is kept.
    let flushing = false;

    // pi drains its steering queue between model calls. Ask the host for what
    // arrived at exactly those points — after an assistant message, after a tool
    // result — and queue it as the user message it is, so the model sees the
    // follow-up on this lane where the subprocess lane's session would.
    const steer = () => {
      if (flushing) return;
      for (const message of takeSteering()) {
        agent.steer({
          role: 'user',
          content: [{ type: 'text', text: message.text }],
          timestamp: Date.now(),
        } as never);
      }
    };

    agent.subscribe((event) => {
      if (event.type === 'tool_execution_end' || (event.type === 'message_end' && (event.message as { role?: string }).role === 'assistant')) {
        steer();
      }
      if (flushing) return;
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

    if (!input.userMessage.trim() && !input.images?.length && !input.files?.length) {
      throw new Error('the agent turn reached the guest with neither text nor a readable attachment');
    }

    const flush = input.memoryFlush;
    const compaction = input.compaction;
    const flushState = memoryFlushDue(session.sessionManager.getBranch());
    if (flush?.enabled && flushState.due && compaction?.enabled && memory) {
      const projected = (session.getContextUsage()?.tokens ?? 0) +
        estimatePromptTokenCost([transientContext, input.userMessage].filter(Boolean).join('\n\n'), input.images?.length ?? 0);
      const threshold = compaction.contextWindow - compaction.reserveTokens - flush.softThresholdTokens;
      if (projected >= threshold) {
        flushing = true;
        const mainContext = transientContext;
        transientContext = undefined;
        session.setAutoCompactionEnabled(false);
        try {
          await promptNativeSession(session, `${flush.systemPrompt}\n\n${flush.prompt}`);
          if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
          const reply = latestAssistantText(agent.state.messages);
          session.sessionManager.appendCustomEntry(MEMORY_FLUSH_STATE_CUSTOM_TYPE, {
            compactionCount: flushState.compactionCount,
            outcome: reply !== null && /^\W*NO_REPLY\W*$/i.test(reply.trim()) ? 'no_reply' : 'stored',
            timestamp: Date.now(),
          });
        } catch (error) {
          console.warn('pre-compaction memory flush failed; continuing with the turn', {
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          session.setAutoCompactionEnabled(compaction.enabled);
          transientContext = mainContext;
          flushing = false;
        }
      }
    }

    await promptNativeSession(session, input.userMessage, input.images);
    // A recovered native retry may have emitted an earlier error. Only the
    // final Agent state decides whether this run failed.
    const ended = agent.state.errorMessage;

    // Capture BEFORE returning, and await it. `agentEnd` itself only starts the
    // write; on the subprocess lane the worker process outlives the turn and the
    // write lands on its own, but this isolate is disposed the moment this
    // function resolves, so an unawaited capture would be cancelled every time
    // and memory would silently stop accumulating for every agent on this lane.
    // A failed turn still fires the hook — with its error, which is how the
    // plugin knows not to save a broken exchange.
    if (memory) {
      // Compaction may remove the current user from model context. The native
      // branch still owns the completed exchange the memory hook must capture.
      const messages = session.sessionManager.getBranch().flatMap((entry) => entry.type === 'message' ? [entry.message] : []);
      await memory.capture(messages, ended ?? undefined);
    }

    if (ended) throw new Error(ended);

    return {
      text,
      stopReason,
      usage,
      sessionJsonl: nativeSessionJsonl(session),
      ...(repliedInBand ? { repliedInBand: true } : {}),
    };
  } finally {
    session.dispose();
  }
}

/** The text of the newest assistant message, or null when there is none. */
function latestAssistantText(messages: readonly AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    const content = Array.isArray(message.content) ? (message.content as Array<{ type?: string; text?: string }>) : [];
    return content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
  }
  return null;
}
