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
import { enforceBashCommandPolicy } from '@lobu/core/tool-policy';
import { isRetrievalTool, summarizeToolTrace } from '@lobu/core/tool-trace-summary';
import { createNativeSession, nativeSessionJsonl, promptNativeSession } from './native-session.js';
import { MAX_TOOL_CALLS_PER_TURN } from './types.js';
import type { AgentTurnEvent, AgentTurnInput, AgentTurnOutput, AgentTurnTool, AgentTurnSteer, RuntimeExecRequest, RuntimeExecResult } from './types.js';
import {
  createWorkspace, INPUT_DIR, SKILLS_DIR,
  type AgentWorkspace, type WorkspaceSeedFile,
} from './workspace.js';

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
 * result, so a blocked or approval-gated call reaches the model as text and the
 * turn goes on.
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
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
        // A retrieval result is summarised into the tool trace from its
        // structured body; the gateway renders markdown unless asked.
        ...(isRetrievalTool(tool.name) ? { 'x-mcp-format': 'json' } : {}),
      },
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
): { tools: AgentTool[]; workspace: AgentWorkspace | null; canReadFiles: boolean } {
  const tools = input.tools;
  if (!tools) return { tools: [], workspace: null, canReadFiles: false };
  // ONE workspace for the whole turn: the file tools act on it and
  // `upload_file` reads it, so the file the model just wrote is the file it can
  // show. Built even when no file tool was admitted but a media tool was, since
  // `bash` alone is enough to produce something worth uploading.
  // On a sandbox-pinned conversation `bash` runs in the remote runtime through
  // the host; file tools stay on the in-memory workspace.
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
          // The isolate has one channel out — its event stream — so the upload
          // notification rides that and the host decides what to do with it.
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
  // `read` opens a seeded file directly. `bash` counts only when its command
  // policy admits `cat`; a strict bash allowlist can expose the tool while
  // still making every seeded file unreachable.
  let bashCanRead = false;
  if ((tools.builtin ?? []).includes('bash') && !tools.remoteRuntime) {
    try {
      if (tools.bashPolicy) enforceBashCommandPolicy('cat input/attachment', tools.bashPolicy);
      bashCanRead = true;
    } catch {
      // The prompt must not advertise a path this turn cannot open.
    }
  }
  const canReadFiles =
    workspace !== null && ((tools.builtin ?? []).includes('read') || bashCanRead);
  return {
    tools: [...mcp, ...gateway, ...media, ...(workspace?.tools ?? [])],
    workspace,
    canReadFiles,
  };
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
 * A file name as a single path segment.
 *
 * The host caps the length and the workspace `resolve` refuses a traversing
 * path, but an attachment name is user-controlled and arrives with whatever
 * separators the uploader had, so a `/` is flattened here rather than being
 * allowed to create surprise subdirectories under `input/`. The isolate uses
 * POSIX paths, where a backslash is an ordinary filename character.
 */
function baseName(name: string): string {
  const segment = name.split('/').filter(Boolean).pop() ?? 'attachment';
  return segment === '.' || segment === '..' ? 'attachment' : segment;
}

/**
 * A skill's directory name, or null when the name is not one.
 *
 * `.` and `..` are refused explicitly so a skill cannot collapse onto
 * `.skills/` itself or its parent.
 */
function skillDirName(name: string): string | null {
  const segment = (name || '').trim().split('/').filter(Boolean).pop() ?? '';
  if (segment === '.' || segment === '..') return null;
  return /^[a-zA-Z0-9._-]+$/.test(segment) ? segment : null;
}

/**
 * Put the turn's attachments and skills in the filesystem before the model runs.
 *
 * The host already resolved every byte, so seeding is only a write into the
 * in-memory tree at the paths named in the agent prompt.
 */
async function seedWorkspace(workspace: AgentWorkspace, input: AgentTurnInput): Promise<void> {
  const seeds: WorkspaceSeedFile[] = [];
  for (const file of input.files ?? []) {
    if (file.data === undefined) continue;
    seeds.push({ path: `${INPUT_DIR}/${baseName(file.name)}`, data: file.data });
  }
  for (const skill of input.skills ?? []) {
    const dir = skillDirName(skill.name);
    if (!dir) {
      console.warn(`Skipping skill with invalid name: ${skill.name}`);
      continue;
    }
    seeds.push({ path: `${SKILLS_DIR}/${dir}/SKILL.md`, text: skill.content });
  }
  if (seeds.length === 0) return;
  await workspace.seed(seeds);
}

/**
 * One line per non-image attachment, appended to the user turn.
 *
 * Named even when readable, because the model has to learn the file exists
 * before it can decide to open it. A file the gateway could not resolve is
 * listed as unopenable rather than dropped, so the model never answers about an
 * attachment it was told nothing about.
 */
function describeFiles(files: AgentTurnInput['files'], canRead: boolean): string {
  if (!files || files.length === 0) return '';
  const describe = (file: NonNullable<AgentTurnInput['files']>[number]) =>
    `- ${INPUT_DIR}/${baseName(file.name)} (${file.mimeType}${file.size !== undefined ? `, ${file.size} bytes` : ''})`;
  // A seeded file is only READABLE if this turn actually carries a tool that
  // opens one. Without `read` or `bash`, the bytes are on the filesystem and
  // unreachable, so naming a path would send the model after a tool it was
  // never given — worse than telling it plainly that it cannot open the file.
  const readable = canRead ? files.filter((file) => file.data !== undefined) : [];
  const unopenable = canRead
    ? files.filter((file) => file.data === undefined)
    : files;
  const parts: string[] = [];
  if (readable.length > 0) {
    parts.push(
      `The user attached ${readable.length} non-image file(s), saved in your workspace. `
        + `Read them with your file tools:\n${readable.map(describe).join('\n')}`
    );
  }
  if (unopenable.length > 0) {
    parts.push(
      `The user also attached ${unopenable.length} file(s) whose contents could not be `
        + `retrieved, so this turn cannot open them:\n`
        + `${unopenable.map((file) => `- ${file.name} (${file.mimeType})`).join('\n')}`
    );
  }
  return parts.join('\n\n');
}

/** Where the turn's skills were seeded, so the model knows to read them. */
function describeSkills(skills: AgentTurnInput['skills'], canRead: boolean): string {
  if (!skills || skills.length === 0 || !canRead) return '';
  const named = skills
    .map((skill) => ({ dir: skillDirName(skill.name), name: skill.name }))
    .filter((entry): entry is { dir: string; name: string } => entry.dir !== null);
  if (named.length === 0) return '';
  const listing = named
    .map((entry) => `- ${SKILLS_DIR}/${entry.dir}/SKILL.md (${entry.name})`)
    .join('\n');
  return `You have ${named.length} skill(s) available as files in your workspace. `
    + `Read the relevant one before acting on a task it covers:\n${listing}`;
}

/**
 * Run one turn and resolve with its native Pi session checkpoint.
 *
 * `emit` is the host bridge: every call crosses into the worker while the
 * stream is still open, so deltas arrive while the turn is running.
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
  /** Insertion-ordered, so the ledger reads in first-call order. */
  const toolsUsed = new Set<string>();

  // `ask_user` hands the conversation back to the human: the question is posted
  // as buttons and the click returns as a NEW inbound message, which is a new
  // turn. Stop the session at that point, or the model keeps calling tools
  // and answering a question nobody has read yet.
  let askedUser = false;
  /** The guard stopped this turn deliberately; the abort is not a failure. */
  let guardStopped = false;
  // `send_message`/`present_event` posted into the conversation this turn is
  // already answering, so the user has READ the answer and the terminal reply
  // would be the same message twice. Report that signal so the
  // completion route can stamp the flag the renderers already act on.
  let repliedInBand = false;
  let transientContext: string | undefined;
  const built = buildTools(
    input,
    credential,
    () => { askedUser = true; },
    () => { repliedInBand = true; },
    emit,
    runtimeExec
  );
  const tools = built.tools;
  const session = createNativeSession(input, tools, () => transientContext);
  session.subscribe((event) => {
    if (event.type === 'compaction_end' && event.errorMessage) console.warn(event.errorMessage);
  });
  const agent = session.agent;
  const nativeBeforeToolCall = agent.beforeToolCall;
  // Blocking a tool is not stopping a turn: Pi returns `{block:true}` to the
  // model as a tool ERROR and asks it again, so a spent budget produced
  // another request every time and an answer could still follow `ask_user`.
  //
  // `block` keeps its job — a sibling scheduled in the same batch must not
  // RUN, since `suggest_actions`/`send_message` post to the user — and
  // `agent.abort()` is what ends generation. Pi's own `terminate` hint cannot
  // do it here: `shouldTerminateToolBatch` needs every result in the batch to
  // set it, and a blocked call is short-circuited as `kind:'immediate'`, which
  // skips `afterToolCall` and so can never carry the flag. `shouldStopAfterTurn`
  // would be the clean seam, but `Agent` never wires it into the loop config.
  agent.beforeToolCall = async (context) => {
    if (askedUser) {
      guardStopped = true;
      agent.abort();
      return {
        block: true,
        reason: 'You have already asked the user a question; this turn is over. Stop and wait for their reply.',
      };
    }
    toolCalls += 1;
    if (toolCalls <= MAX_TOOL_CALLS_PER_TURN) return nativeBeforeToolCall?.(context);
    guardStopped = true;
    agent.abort();
    return {
      block: true,
      reason: `This turn's tool-call budget (${MAX_TOOL_CALLS_PER_TURN}) is spent; answer with what you have.`,
    };
  };

  try {
    // Seed BEFORE the model runs, so the first thing it can do is read an
    // attachment. Awaited rather than fired: a turn that starts before its
    // files exist would report them missing.
    if (built.workspace && built.canReadFiles) await seedWorkspace(built.workspace, input);
    const recalled = memory ? await memory.recall(input.userMessage, agent.state.messages) : '';
    transientContext = [
      recalled,
      input.ephemeralContext?.trim()
        ? `Context for this message:\n${input.ephemeralContext.trim()}`
        : '',
      describeFiles(input.files, built.canReadFiles),
      describeSkills(input.skills, built.canReadFiles),
    ]
      .filter(Boolean)
      .join('\n\n');

    // The STREAM, not the answer: every delta of every assistant message this
    // turn, in order. It drives the live typing indicator and is the fallback
    // answer for a turn that never settles a message.
    let text = '';
    let stopReason: string | null = null;
    let usage: AgentTurnOutput['usage'] = null;
    // While the pre-compaction memory flush runs, nothing it produces is the
    // turn's answer: no deltas leave the isolate and no text is kept.
    let flushing = false;

    // pi drains its steering queue between model calls. Ask the host for what
    // arrived at exactly those points — after an assistant message, after a tool
    // result — and queue it as the user message it is.
    const steeredMessages = new Map<AgentMessage, number>();
    // The turn's answer(s), one per user message the model replied to. Tracked
    // from events rather than read back out of `agent.state.messages` at the
    // end: compaction replaces that array mid-turn, and the newest message is
    // the wrong one to read anyway — see the `text` field of the result.
    const answers: string[] = [];
    let answer: string | null = null;
    const steer = () => {
      if (flushing) return;
      for (const message of takeSteering()) {
        const nativeMessage: AgentMessage = {
          role: 'user', content: [{ type: 'text', text: message.text }], timestamp: Date.now(),
        };
        steeredMessages.set(nativeMessage, message.runId);
        agent.steer(nativeMessage);
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
          content?: unknown;
          stopReason?: string;
          errorMessage?: string;
          usage?: { input?: number; output?: number };
        };
        // A user message — the prompt, or a steered follow-up Pi injected —
        // closes the answer to the message before it.
        if (message.role === 'user') {
          if (answer) answers.push(answer);
          answer = null;
          return;
        }
        // Tool results end a message too; only the assistant's own carry the
        // turn's outcome.
        if (message.role !== 'assistant') return;
        // The LAST assistant message with text answers its user message: a
        // narration before a tool call is superseded by the message that
        // follows the result. An EMPTY one (an aborted or errored request)
        // supersedes nothing — the answer already settled stands.
        const settled = assistantText(message.content);
        if (settled.trim()) answer = settled;
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
        // Recorded on END, not start, and without filtering `isError` —
        // matching what the retired lane stamped (`recordToolUsed`, from its
        // own `tool_use` event). A failed call still counts as attempted; the
        // guardrail asks whether the tool was reached, not whether it worked.
        toolsUsed.add(event.toolName);
        const result = event.result as { content?: Array<{ type?: string; text?: string }> };
        // Summarised BEFORE the clip, from the result as the tool returned it:
        // a retrieval body over the display cap would otherwise parse to
        // nothing and the turn would carry no evidence for its own answer.
        const resultSummary = event.isError ? null : summarizeToolTrace(event.toolName, event.result);
        emit({
          type: 'tool_call_end',
          toolCallId: event.toolCallId,
          name: event.toolName,
          isError: event.isError,
          output: clip(joinText(result?.content)),
          ...(resultSummary ? { resultSummary } : {}),
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
    //
    // Our own guard abort is the exception. Pi records EVERY abort as a run
    // failure (`handleRunFailure` pushes a message and sets `errorMessage`),
    // but a spent budget or an asked question is a deliberate stop, and the
    // text streamed before it is a real answer worth delivering — throwing
    // here would turn it into a failed turn with nothing shown.
    const ended = guardStopped ? null : agent.state.errorMessage;

    // Capture BEFORE returning, and await it. `agentEnd` itself only starts the
    // write; this isolate is disposed the moment this function resolves, so an
    // unawaited capture would be cancelled every time
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
    if (answer) answers.push(answer);

    return {
      // The answer is the last assistant message WITH TEXT after each user
      // message, not the accumulated stream: a model that narrates before a
      // tool call ("Let me check...") would otherwise deliver that narration
      // glued to its answer, and deltas replayed by a retry or compaction
      // would appear twice. The retired lane shipped the summing version and
      // had to fix it the same way (`finalText` authoritative, PR #1087) —
      // this is the text a possibly-different replica delivers to the user
      // and writes to history, so a garbled value corrupts the durable
      // record, not just one render.
      //
      // One answer PER user message, because a steered follow-up makes Pi
      // answer twice in one turn and the host delivers this field once: taking
      // only the newest message dropped the first answer from Slack (which
      // posts at completion) and from history. And the newest message is
      // ignored when it is EMPTY — a guard abort or a failed request ends the
      // turn on one — so the answer that did settle is still delivered.
      //
      // Falls back to the stream when no assistant message settled: a turn
      // aborted mid-answer still owes the user what it managed to say.
      text: answers.length > 0 ? answers.join('\n\n') : text,
      stopReason,
      usage,
      sessionJsonl: nativeSessionJsonl(session),
      toolsUsed: [...toolsUsed],
      // Pi emits message events before persistence. Receipt identity comes from
      // the finished native branch after retries/compaction have drained.
      consumedInputs: session.sessionManager.getBranch().flatMap((entry) => {
        const runId = entry.type === 'message' ? steeredMessages.get(entry.message) : undefined;
        return runId === undefined ? [] : [{ runId, sessionEntryId: entry.id }];
      }),
      ...(repliedInBand ? { repliedInBand: true } : {}),
    };
  } finally {
    session.dispose();
  }
}

/** The text blocks of one assistant message, joined. */
function assistantText(content: unknown): string {
  const blocks = Array.isArray(content) ? (content as Array<{ type?: string; text?: string }>) : [];
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

/** The text of the newest assistant message, or null when there is none. */
function latestAssistantText(messages: readonly AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    return assistantText(message.content);
  }
  return null;
}
