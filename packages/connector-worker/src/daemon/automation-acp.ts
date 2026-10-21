import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type {
  NewSessionResponse,
  PromptResponse,
  SessionUpdate,
  ToolCall,
  Usage,
} from '@agentclientprotocol/sdk';
import type { AgentKind } from '@lobu/core/contracts/worker/device-automation';
import {
  releaseSupervisor,
  spawnSupervisedCli,
  terminateChild,
  waitForTargetExit,
} from './automation-process.js';
import type { ExecutorResult } from './automation.js';

const STDERR_CAP = 1024 * 1024;
const CANCEL_GRACE_MS = 2_000;
const ADAPTER_EXIT_GRACE_MS = 3_000;
const TRANSCRIPT_VALUE_CAP = 64 * 1024;

export type AcpAgentKind = Extract<AgentKind, 'claude-code' | 'codex' | 'opencode'>;

/** Configuration for one installed or packaged ACP agent entrypoint. */
export interface AutomationAcpAdapter {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Mode applied before each prompt (Codex uses `agent`). */
  defaultMode?: string;
  /** ACP config-option id for effort; providers do not use one common id. */
  effortConfigId?: string;
  /** Preserve OpenCode's existing unattended `--auto` permission semantics. */
  autoApprovePermissions?: boolean;
  /** Hide ambient global/project configuration while keeping provider auth data. */
  isolateXdgConfig?: boolean;
  /** Provider extension metadata forwarded on both session/new and session/resume. */
  sessionMeta?: Record<string, unknown>;
  /** ACP MCP server name; controls provider-visible tool prefixes. */
  mcpServerName?: string;
}

export type AutomationAcpAdapters = Partial<Record<AcpAgentKind, AutomationAcpAdapter>>;

export interface AcpTurnOptions {
  agentKind: AcpAgentKind;
  adapter: AutomationAcpAdapter;
  cwd: string;
  prompt: string;
  mcp: { url: string; bearer: string };
  resumeSessionId?: string;
  mode?: string;
  model?: string;
  effort?: string;
  sessionMeta?: Record<string, unknown>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  onSessionReady: (sessionId: string) => Promise<void>;
  transcript?: AcpTranscript;
}

export interface AcpTurnResult extends ExecutorResult {
  sessionId: string;
  transcriptJsonl: string;
}

type TranscriptEvent =
  | { kind: 'assistant'; messageId: string; text: string }
  | { kind: 'tool'; tool: ToolCall }
  | {
      kind: 'tool-result';
      toolCallId: string;
      failed: boolean;
      output: unknown;
    };

function cappedJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return '[unserializable ACP value]';
  }
  if (json.length <= TRANSCRIPT_VALUE_CAP) return value;
  return `${json.slice(0, TRANSCRIPT_VALUE_CAP)}…[truncated]`;
}

function contentText(update: SessionUpdate): string | null {
  if (
    (update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'agent_thought_chunk' ||
      update.sessionUpdate === 'user_message_chunk') &&
    update.content.type === 'text'
  ) {
    return update.content.text;
  }
  return null;
}

/** Builds the existing Lobu session JSONL shape from public ACP updates. */
export class AcpTranscript {
  private sessionId: string | null = null;
  private startedAt: string | null = null;
  private readonly entries: Array<Record<string, unknown>> = [];
  private parentId: string | null = null;
  private sequence = 0;

  constructor(private readonly cwd: string) {}

  setSession(sessionId: string): void {
    if (this.sessionId && this.sessionId !== sessionId) {
      throw new Error(`ACP transcript session changed from ${this.sessionId} to ${sessionId}`);
    }
    this.sessionId = sessionId;
    this.startedAt ??= new Date().toISOString();
  }

  appendTurn(prompt: string, events: TranscriptEvent[], usage?: Usage | null): void {
    this.appendMessage('user', [{ type: 'text', text: prompt }]);
    let lastAssistantIndex = -1;
    for (const event of events) {
      if (event.kind === 'assistant') {
        this.appendMessage('assistant', [{ type: 'text', text: event.text }]);
        lastAssistantIndex = this.entries.length - 1;
        continue;
      }
      if (event.kind === 'tool') {
        this.appendMessage('assistant', [
          {
            type: 'tool_use',
            id: event.tool.toolCallId,
            name: event.tool.name ?? event.tool.title,
            input: cappedJsonValue(event.tool.rawInput ?? {}),
          },
        ]);
        continue;
      }
      this.appendMessage('toolResult', [
        {
          type: 'tool_result',
          tool_use_id: event.toolCallId,
          is_error: event.failed,
          content: [{ type: 'text', text: JSON.stringify(cappedJsonValue(event.output)) }],
        },
      ]);
    }
    if (usage && lastAssistantIndex >= 0) {
      const entry = this.entries[lastAssistantIndex] as {
        message?: { usage?: { inputTokens: number; outputTokens: number } };
      };
      if (entry.message) {
        entry.message.usage = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        };
      }
    }
  }

  /** True once a session id is bound, i.e. `toJsonl` can serialize. */
  get hasSession(): boolean {
    return this.sessionId != null;
  }

  /**
   * Append-only by construction: the header is frozen at session setup so each
   * finalize round's upload is a byte-exact prefix extension of the previous
   * one. The server's snapshot upsert rejects any divergent continuation.
   */
  toJsonl(): string {
    if (!this.sessionId) throw new Error('cannot serialize an ACP transcript before session setup');
    const session = {
      type: 'session',
      version: 3,
      id: this.sessionId,
      timestamp: this.startedAt,
      cwd: this.cwd,
    };
    return [session, ...this.entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  }

  private appendMessage(role: string, content: unknown): void {
    const id = `acp-${++this.sequence}`;
    this.entries.push({
      type: 'message',
      id,
      parentId: this.parentId,
      timestamp: new Date().toISOString(),
      message: { role, content },
    });
    this.parentId = id;
  }
}

function collectStderr(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (size >= STDERR_CAP) return;
      const kept = buffer.subarray(0, STDERR_CAP - size);
      chunks.push(kept);
      size += kept.length;
    });
    const finish = () => resolve(Buffer.concat(chunks).toString('utf8'));
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', finish);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Run one Automation prompt through a provider's stable ACP v1 entrypoint. */
export async function runAcpTurn(
  options: AcpTurnOptions
): Promise<AcpTurnResult> {
  const started = Date.now();
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.adapter.env };
  delete env.WORKER_API_TOKEN;
  delete env.LOBU_API_TOKEN;
  delete env.LOBU_MEMORY_URL;
  let isolatedConfigDir: string | undefined;
  if (options.adapter.isolateXdgConfig) {
    isolatedConfigDir = mkdtempSync(path.join(tmpdir(), 'lobu-acp-config-'));
    env.XDG_CONFIG_HOME = isolatedConfigDir;
  }

  let supervised: ReturnType<typeof spawnSupervisedCli>;
  try {
    supervised = spawnSupervisedCli(
      options.adapter.command,
      options.adapter.args ?? [],
      env,
      { stdin: 'pipe' }
    );
  } catch (error) {
    if (isolatedConfigDir) rmSync(isolatedConfigDir, { recursive: true, force: true });
    throw error;
  }
  const proc = supervised.supervisor;
  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    await terminateChild(proc);
    if (isolatedConfigDir) rmSync(isolatedConfigDir, { recursive: true, force: true });
    throw new Error(`${options.agentKind} ACP supervisor spawned without bidirectional stdio`);
  }
  const stderrPromise = collectStderr(proc.stderr);
  const transcript = options.transcript ?? new AcpTranscript(options.cwd);
  const events: TranscriptEvent[] = [];
  const tools = new Map<string, ToolCall>();
  let assistantOutput = '';
  let connection: acp.ClientConnection | undefined;
  let sessionId = options.resumeSessionId ?? '';
  let promptResponse: PromptResponse | undefined;
  let timedOut = false;
  let cancelled = false;
  let workflowError: unknown;

  const app = acp
    .client({ name: 'lobu-device-daemon' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      const selected = options.adapter.autoApprovePermissions
        ? params.options.find((option) => option.kind === 'allow_always') ??
          params.options.find((option) => option.kind === 'allow_once')
        : params.options.find((option) => option.kind === 'reject_once') ??
          params.options.find((option) => option.kind === 'reject_always');
      return selected
        ? { outcome: { outcome: 'selected' as const, optionId: selected.optionId } }
        : { outcome: { outcome: 'cancelled' as const } };
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      const update = params.update;
      if (update.sessionUpdate === 'agent_message_chunk') {
        const text = contentText(update);
        if (text == null) return;
        assistantOutput += text;
        const messageId = update.messageId ?? `message-${events.length}`;
        const prior = events.at(-1);
        if (prior?.kind === 'assistant' && prior.messageId === messageId) prior.text += text;
        else events.push({ kind: 'assistant', messageId, text });
      } else if (update.sessionUpdate === 'tool_call') {
        const tool = { ...update };
        tools.set(update.toolCallId, tool);
        events.push({ kind: 'tool', tool });
      } else if (update.sessionUpdate === 'tool_call_update') {
        // A call opens before its input has streamed; later updates carry the
        // arguments and a final title, so fold them into the recorded call.
        const tool = tools.get(update.toolCallId);
        if (tool) {
          if (update.name != null) tool.name = update.name;
          if (update.title != null) tool.title = update.title;
          if (update.content != null) tool.content = update.content;
          if (update.rawInput !== undefined) tool.rawInput = update.rawInput;
          if (update.rawOutput !== undefined) tool.rawOutput = update.rawOutput;
        }
        if (update.status !== 'completed' && update.status !== 'failed') return;
        events.push({
          kind: 'tool-result',
          toolCallId: update.toolCallId,
          failed: update.status === 'failed',
          output: update.rawOutput ?? update.content ?? tool?.rawOutput ?? tool?.content ?? null,
        });
      }
      // Deliberately do not persist agent_thought_chunk: ACP exposes public
      // progress and final messages separately from private model reasoning.
    });

  try {
    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
    );
    connection = app.connect(stream);
    const ctx = connection.agent;
    const initialized = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { session: { configOptions: {} } },
      clientInfo: { name: 'lobu-device-daemon', version: '1' },
    });
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(
        `${options.agentKind} ACP negotiated unsupported protocol ${initialized.protocolVersion}`
      );
    }
    if (initialized.agentCapabilities?.mcpCapabilities?.http !== true) {
      throw new Error(`${options.agentKind} ACP adapter does not support HTTP MCP servers`);
    }

    const sessionMeta = options.sessionMeta ?? options.adapter.sessionMeta;
    const mcpServers = [
      {
        type: 'http' as const,
        name: options.adapter.mcpServerName ?? 'lobu-memory',
        url: options.mcp.url,
        headers: [{ name: 'Authorization', value: `Bearer ${options.mcp.bearer}` }],
      },
    ];
    if (options.resumeSessionId) {
      if (initialized.agentCapabilities?.sessionCapabilities?.resume == null) {
        throw new Error(`${options.agentKind} ACP adapter does not support session/resume`);
      }
      await ctx.request(acp.methods.agent.session.resume, {
        sessionId: options.resumeSessionId,
        cwd: options.cwd,
        mcpServers,
        ...(sessionMeta ? { _meta: sessionMeta } : {}),
      });
      sessionId = options.resumeSessionId;
    } else {
      const created = (await ctx.request(acp.methods.agent.session.new, {
        cwd: options.cwd,
        mcpServers,
        ...(sessionMeta ? { _meta: sessionMeta } : {}),
      })) as NewSessionResponse;
      sessionId = created.sessionId;
    }
    transcript.setSession(sessionId);

    // Persist the exact id before the prompt can mutate the workspace. A failed
    // checkpoint aborts the turn instead of creating an unresumable session.
    await options.onSessionReady(sessionId);
    if (options.model) {
      await ctx.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'model',
        value: options.model,
      });
    }
    const mode = options.mode ?? options.adapter.defaultMode;
    if (mode) {
      await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: mode });
    }
    if (options.effort && options.adapter.effortConfigId) {
      await ctx.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: options.adapter.effortConfigId,
        value: options.effort,
      });
    }

    const prompt = ctx.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: options.prompt }],
    });
    const control = new Promise<'timeout' | 'cancel'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), options.timeoutMs);
      timer.unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        resolve('cancel');
      };
      if (options.abortSignal?.aborted) onAbort();
      else options.abortSignal?.addEventListener('abort', onAbort, { once: true });
      const clearControl = () => {
        clearTimeout(timer);
        options.abortSignal?.removeEventListener('abort', onAbort);
      };
      prompt.then(clearControl, clearControl);
    });
    const outcome = await Promise.race([
      prompt.then((response) => ({ kind: 'response' as const, response })),
      control.then((reason) => ({ kind: 'control' as const, reason })),
      supervised.targetExit.then((target) => ({ kind: 'exit' as const, target })),
    ]);
    if (outcome.kind === 'response') {
      promptResponse = outcome.response;
      cancelled = outcome.response.stopReason === 'cancelled';
    } else if (outcome.kind === 'control') {
      timedOut = outcome.reason === 'timeout';
      cancelled = outcome.reason === 'cancel';
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {});
      const cancelledResponse = await Promise.race([
        prompt.catch(() => undefined),
        delay(CANCEL_GRACE_MS).then(() => undefined),
      ]);
      promptResponse = cancelledResponse;
    } else {
      throw new Error(
        outcome.target.error ?? `${options.agentKind} ACP adapter exited before the prompt completed ` +
          `(status=${outcome.target.exitCode}, signal=${outcome.target.signalCode ?? 'none'})`
      );
    }

    if (initialized.agentCapabilities?.sessionCapabilities?.close != null) {
      await ctx.request(acp.methods.agent.session.close, { sessionId }).catch(() => {});
    }
  } catch (error) {
    workflowError = error;
  } finally {
    connection?.close();
    proc.stdin.end();
    const graceful = await waitForTargetExit(supervised.targetExit, ADAPTER_EXIT_GRACE_MS);
    if (graceful.target) await releaseSupervisor(proc);
    else await terminateChild(proc);
    if (isolatedConfigDir) rmSync(isolatedConfigDir, { recursive: true, force: true });
  }

  const stderr = await Promise.race([
    stderrPromise,
    delay(1_000).then(() => ''),
  ]);
  const durationMs = Date.now() - started;
  if (workflowError) {
    const detail = workflowError instanceof Error ? workflowError.message : String(workflowError);
    return {
      output: assistantOutput,
      error: stderr.trim() ? `${detail}: ${stderr.trim().slice(-500)}` : detail,
      exitCode: null,
      exitSignal: null,
      exitReason: 'crash',
      durationMs,
      sessionId,
      // A rejected resume leaves `sessionId` set but no session bound, and
      // serializing then would mask the real failure with a second throw.
      transcriptJsonl: transcript.hasSession ? transcript.toJsonl() : '',
    };
  }

  transcript.appendTurn(options.prompt, events, promptResponse?.usage);
  const exitReason = cancelled
    ? 'cancelled'
    : timedOut
      ? 'timeout'
      : promptResponse?.stopReason === 'end_turn'
        ? 'ok'
        : 'error_message';
  const error =
    exitReason === 'timeout'
      ? `${options.agentKind} ACP prompt timed out after ${Math.trunc(options.timeoutMs / 1000)}s`
      : exitReason === 'error_message'
        ? `${options.agentKind} ACP stopped with reason ${promptResponse?.stopReason ?? 'unknown'}`
        : null;
  return {
    output: assistantOutput,
    error,
    exitCode: exitReason === 'ok' ? 0 : null,
    exitSignal: cancelled || timedOut ? 'SIGTERM' : null,
    exitReason,
    durationMs,
    sessionId,
    transcriptJsonl: transcript.toJsonl(),
  };
}
