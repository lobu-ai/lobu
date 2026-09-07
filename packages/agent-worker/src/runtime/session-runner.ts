/**
 * session-runner.ts — extracted runAISession orchestration.
 *
 * This module contains the core AI session run logic, extracted from
 * LobuAgentWorker to keep worker.ts focused on lifecycle (execute/cleanup/
 * transport). All semantics, event handling, heartbeat, memory-flush, and
 * plugin-hook ordering is identical to the original implementation.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  buildToolPolicy,
  createLogger,
  getOptionalEnv,
  isToolAllowedByPolicy,
  type ToolsConfig,
  MEMORY_FLUSH_STATE_CUSTOM_TYPE,
  resolveMemoryFlushConfig,
} from "@lobu/core";
import type { PluginRuntimeContext } from "@lobu/plugin-api";
import type { GatewayParams } from "@lobu/plugin-toolkit";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { ProgressUpdate, SessionExecutionResult } from "../core/types";
import { createEmbeddedBashOps } from "../embedded/just-bash-bootstrap";
import { consumePendingConfigNotifications } from "../gateway/pending-config-notifications";
import { getWorkerTokenManager } from "../gateway/worker-token-manager";
import { getApiKeyEnvVarForProvider } from "../shared/provider-auth-hints";
import { isRecord } from "../shared/type-guards";
import { activeToolNames } from "./active-tool-names";
import {
  buildDynamicOpenAIModel,
  DEFAULT_PROVIDER_BASE_URL_ENV,
  getModelDynamic,
  openOrCreateSessionManager,
  PROVIDER_REGISTRY_ALIASES,
  registerDynamicProvider,
  resolveDynamicModelApi,
  resolveModelRef,
} from "./model-resolver";
import { createLobuResourceLoader } from "./pi-resources";
import {
  createLobuSystemPromptRenderer,
  type LobuSystemPromptRenderer,
} from "./system-prompt";
import {
  createPluginLogger,
  createRuntimePluginHost,
} from "./plugin-composition";
import type { AgentProgressProcessor } from "./processor";
import { resetSessionForProviderChange } from "./provider-session";
import { buildRuntimeShellInstructions } from "./runtime-shell-instructions";
import { checkSandboxLeak } from "./sandbox-leak";
import {
  type AgentInstructionLayers,
  getAgentSessionContext,
  invalidateSessionContextCache,
} from "./session-context";
import { buildToolUseEventPayload } from "./tool-use-events";
import { createLobuTools, enforceBashPreflight } from "./tools";
import { clearSnapshots, hydrateFromSnapshot } from "./transcript-snapshot";
import { TurnController, wrapToolsWithTurnGuard } from "./turn-controller";

const logger = createLogger("worker");

// ---------------------------------------------------------------------------
// Agent session construction
// ---------------------------------------------------------------------------

/**
 * Built-in tool names that Lobu rebuilds itself (via createLobuTools).
 * These carry the security-sensitive semantics — most importantly the bash
 * spawnHook that builds the env from the worker allowlist and the embedded
 * BashOperations that route MCP/just-bash through the gateway. They must be
 * the instances the agent actually runs.
 */
const OVERRIDABLE_BUILTIN_NAMES = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
]);

/**
 * Build an agent session and ensure the Lobu-built built-in tools are the ones
 * the agent actually executes.
 *
 * Background: pi's `createAgentSession({ tools })` uses the `tools` option only
 * to derive the active tool NAMES — it rebuilds the underlying built-in tools
 * internally via `createAllTools(cwd, { bash: { commandPrefix } })`, whose bash
 * uses `getShellEnv()` = `{ ...process.env }` with no env filter and no custom
 * BashOperations. That silently discards the worker's hardened bash (the
 * spawnHook that builds an allowlisted agent environment and the embedded
 * BashOperations), so the agent's general bash would inherit the worker's real
 * gateway credentials.
 *
 * The session keeps the active tool array on `agent.state.tools`, and tool
 * calls are resolved from that array by name at execution time. We swap the
 * rebuilt built-ins for the caller-provided Lobu instances after construction,
 * preserving every other aspect of `createAgentSession` (model resolution,
 * session restore, image blocking, extension/custom-tool wiring).
 */
type BuildAgentSessionOptions = Omit<
  CreateAgentSessionOptions,
  "resourceLoader"
> & {
  /** Resource isolation is a Lobu invariant, not a caller override. */
  resourceLoader?: never;
  /**
   * Lobu's hardened built-in tool instances (read/bash/edit/write/…). pi's
   * `createAgentSession` only takes built-in NAMES via `options.tools` and
   * rebuilds the instances internally (unhardened bash via getShellEnv()), so
   * we swap those rebuilt instances for these by name after construction. Pass
   * the same names in `options.tools` so they're active in the first place.
   */
  builtinOverrides?: AgentTool<any>[];
  /**
   * Renders the Lobu system prompt. Installed through the resource loader
   * (which owns both the base prompt and the `before_agent_start` handler that
   * reinstalls it each turn), because pi offers no system-prompt option on
   * `createAgentSession` and resets `agent.state.systemPrompt` on every
   * `prompt()` call.
   *
   * Optional for low-level session tests that exercise isolated pi mechanics.
   * Production must always pass it.
   */
  renderSystemPrompt?: LobuSystemPromptRenderer;
  /**
   * Returns Lobu-owned context for the active turn. The resource loader injects
   * it into Pi's provider-only context copy, never the persisted user message.
   */
  getTransientTurnContext?: () => string | undefined;
  /**
   * Durable provider-isolation note for a session Pi is about to initialize.
   * It must be appended only after Pi records the new session's model_change.
   */
  providerChangeSummary?: string;
};

export async function buildAgentSession({
  builtinOverrides,
  renderSystemPrompt,
  getTransientTurnContext,
  providerChangeSummary,
  ...options
}: BuildAgentSessionOptions): Promise<CreateAgentSessionResult> {
  // Pi's defaults persist under ~/.pi and discover resources/config from cwd.
  // Lobu supplies explicit production state; keep every fallback in memory so
  // a worker session never depends on host or agent-writable workspace files.
  const cwd = options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd();
  const settingsManager = options.settingsManager ?? SettingsManager.inMemory();
  const sessionManager = options.sessionManager ?? SessionManager.inMemory(cwd);
  const authStorage =
    options.authStorage ??
    options.modelRegistry?.authStorage ??
    AuthStorage.inMemory();
  const modelRegistry =
    options.modelRegistry ?? ModelRegistry.inMemory(authStorage);
  const resourceLoader = createLobuResourceLoader(
    renderSystemPrompt,
    getTransientTurnContext
  );

  const result = await createAgentSession({
    ...options,
    cwd,
    settingsManager,
    sessionManager,
    authStorage,
    modelRegistry,
    resourceLoader,
  });
  const { session } = result;

  if (providerChangeSummary) {
    await session.sendCustomMessage(
      {
        customType: "lobu.provider_change",
        content: providerChangeSummary,
        display: false,
      },
      { triggerTurn: false }
    );
  }

  const lobuBuiltins = new Map<string, AgentTool<any>>();
  for (const tool of builtinOverrides ?? []) {
    if (OVERRIDABLE_BUILTIN_NAMES.has(tool.name)) {
      lobuBuiltins.set(tool.name, tool);
    }
  }
  if (lobuBuiltins.size === 0) {
    return result;
  }

  const activeTools = session.agent.state.tools;
  const patched = activeTools.map(
    (tool) => lobuBuiltins.get(tool.name) ?? tool
  );
  session.agent.state.tools = patched;

  return result;
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Memory-flush / compaction utilities
// (also used by LobuAgentWorker.maybeRunPreCompactionMemoryFlush in worker.ts)
// The config, the prompt-cost estimate and the state entry type live in
// @lobu/core (`compaction`), shared with the isolate lane.
// ---------------------------------------------------------------------------

export function countCompactionsOnCurrentBranch(
  sessionManager: Awaited<ReturnType<typeof openOrCreateSessionManager>>
): number {
  const branch = sessionManager.getBranch();
  return branch.reduce((count, entry) => {
    if (entry.type === "compaction") {
      return count + 1;
    }
    return count;
  }, 0);
}

export function readLastFlushedCompactionCount(
  sessionManager: Awaited<ReturnType<typeof openOrCreateSessionManager>>
): number | null {
  const branch = sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry) continue;
    if (entry.type !== "custom") continue;
    if (entry.customType !== MEMORY_FLUSH_STATE_CUSTOM_TYPE) continue;
    if (!isRecord(entry.data)) continue;
    const compactionCount = entry.data.compactionCount;
    if (
      typeof compactionCount === "number" &&
      Number.isFinite(compactionCount) &&
      compactionCount >= 0
    ) {
      return compactionCount;
    }
  }
  return null;
}

export function getLatestAssistantText(
  messages: unknown[]
): { text: string; normalizedNoReply: boolean } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "assistant") continue;
    const content = message.content;

    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .flatMap((block) => {
          if (!isRecord(block)) return [];
          if (block.type !== "text") return [];
          return typeof block.text === "string" ? [block.text] : [];
        })
        .join("");
    }

    const normalized = text.trim().toUpperCase();
    return {
      text,
      normalizedNoReply: normalized === "NO_REPLY",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Agent identity
// ---------------------------------------------------------------------------

/**
 * Fallback identity used when every configured instruction layer is empty.
 * Without this the document would open with nothing describing the agent at
 * all, and the model falls back on describing the runtime it can see.
 *
 * Any configured identity, soul, or user layer overrides this fallback.
 *
 * The capabilities section is grounded in what every Lobu agent has by
 * construction (shared memory, connectors, actions, channel presence) rather
 * than a raw tool dump — so self-descriptions are accurate and useful, not
 * generic.
 *
 * IMPORTANT: keep this describing capabilities in GENERAL terms only. Which
 * connectors are actually wired up, the current channel, and the conversation
 * that triggered this run are per-run facts injected live via
 * platformInstructions / mcpServerInstructions / mcpContext (see
 * session-context.ts) and any run-context block — never hardcode specifics
 * here, or the prompt will lie on every other run.
 */
export const LOBU_DEFAULT_IDENTITY = `You are a Lobu agent — a persistent, memory-backed teammate that lives in your organization's channels. You are not a generic coding assistant, and you do not describe yourself in terms of the runtime or harness you run on.

## What you can do
- **Remember across conversations.** You have durable shared memory of the people, facts, decisions, and history of the organization you serve — not just the current thread. Recall it before asking for something you should already know, and save what's worth keeping.
- **Reach connected tools and data.** Your organization wires up connectors, connections, and live feeds — its apps, data sources, and MCP servers. You can query them to answer questions and pull in what you need. The specific connectors available to you are listed in your runtime context, not memorized here.
- **Take action, not just answer.** You can act on the team's behalf through the tools you're given — sending messages, updating records, running the operations your connectors and skills expose — within the limits set for you.
- **Work where the team works.** You operate inside the team's channels, DMs, and tasks. Details of the current conversation — platform, channel, what triggered this run — come from your runtime context.
- **Stay within permissions and guardrails.** Your tools, network access, and permissions are set by operator configuration. Work within them rather than around them; if something is out of scope, say so instead of trying to route around it.

Introduce yourself in terms of who you help and what you can do for them — concretely and specifically to this organization — not in terms of the software you are running on.`;

/**
 * Compose configured layers in their existing prompt order. The worker owns
 * this step because prompt placement is a worker concern.
 *
 * `unconfiguredNotice` replaces the whole block rather than appending to it:
 * the gateway only sets it when all three sources are blank.
 */
function composeAgentInstructions(layers: AgentInstructionLayers): string {
  const sections: string[] = [];
  if (layers.identityMd.trim()) {
    sections.push(`## Agent Identity\n\n${layers.identityMd.trim()}`);
  }
  if (layers.soulMd.trim()) {
    sections.push(`## Agent Instructions\n\n${layers.soulMd.trim()}`);
  }
  if (layers.userMd.trim()) {
    sections.push(`## User Context\n\n${layers.userMd.trim()}`);
  }
  const composed = sections.join("\n\n");
  return composed || layers.unconfiguredNotice;
}

/**
 * Resolve the identity the system prompt opens with: the agent's own configured
 * instructions when present, otherwise the Lobu default persona. Always returns
 * a non-empty string, so the document never opens with a blank role.
 */
export function resolveAgentIdentity(
  layers: AgentInstructionLayers | undefined
): string {
  const composed = layers ? composeAgentInstructions(layers).trim() : "";
  return composed.length > 0 ? composed : LOBU_DEFAULT_IDENTITY;
}

/**
 * Per-run conversation context: where this turn is happening, who triggered it,
 * and (when available) a link back to the conversation.
 *
 * This is DELIBERATELY injected into Pi's provider-only view of the current
 * user turn, never the system prompt or durable transcript. It varies every
 * turn/channel, so putting it in the cached system prefix would bust the prompt
 * cache on every message. It stays in the uncached current turn and costs
 * nothing in cache terms.
 *
 * Only fields actually present are rendered — an empty/unknown field is omitted
 * rather than shown as "unknown". Returns "" when nothing is known, so the
 * caller can conditionally prepend it.
 */
export function buildRunContextBlock(input: {
  platform: string | undefined;
  channelId: string | undefined;
  platformMetadata: unknown;
  agentId?: string | undefined;
  conversationId?: string | undefined;
  /** Public HTTP(S) origin for user-openable Lobu links. */
  webOrigin?: string | undefined;
}): string {
  // The web chat gets no block. This context exists to disambiguate WHICH
  // conversation a run came from when several are possible (a Slack channel, a
  // Telegram thread); on `api` there is only ever the chat the user is looking
  // at, so "Platform: api" / "Channel: api_<userId>" is pure noise. The
  // provider-only context boundary below now protects every surface from
  // transcript leakage; this suppression remains solely a relevance choice.
  if (input.platform === "api") return "";

  const md =
    input.platformMetadata && typeof input.platformMetadata === "object"
      ? (input.platformMetadata as Record<string, unknown>)
      : {};
  // Platform metadata (display names, channel names, URLs) is UNTRUSTED user
  // input that ends up in the prompt. Neutralize prompt injection: strip all
  // control characters (newlines especially — a newline lets a value forge a
  // new `## Section` or `- ` line), collapse whitespace, and cap length so an
  // overlong value can't dominate the turn. Empty-after-sanitize -> omitted.
  const MAX_FIELD_LEN = 200;
  const str = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    // Replace any C0/C1 control char (code point < 0x20, or 0x7F-0x9F) with a
    // space — done by code point rather than a literal control-char regex so no
    // raw control bytes live in this source file. Then collapse whitespace and
    // cap length. A newline/tab can't survive to forge a new prompt line.
    let cleaned = "";
    for (const ch of v) {
      const code = ch.codePointAt(0) ?? 0;
      cleaned += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
    }
    cleaned = cleaned.replace(/\s+/g, " ").trim().slice(0, MAX_FIELD_LEN);
    return cleaned.length > 0 ? cleaned : undefined;
  };

  const platform = str(input.platform);
  const channel =
    str(md.responseChannel) ?? str(md.chatId) ?? str(input.channelId);
  const sender = str(md.senderDisplayName) ?? str(md.senderUsername);
  const thread = str(md.responseThreadId);
  // Opportunistic: rendered only if the gateway ever plumbs a link through.
  const url = str(md.conversationUrl) ?? str(md.permalink);
  // Identity of this run. These are the worker's own trusted values, not
  // platform metadata — but they still go through `str`, because the block's
  // contract is that no field can forge a line.
  const agent = str(input.agentId);
  const conversation = str(input.conversationId);
  const origin = str(input.webOrigin);

  const lines: string[] = [];
  if (platform) lines.push(`- Platform: ${platform}`);
  if (channel) lines.push(`- Channel: ${channel}`);
  // On a platform with no real threading (Telegram, most DMs) the thread id is
  // the channel id, and rendering both spends a line of every turn restating
  // the previous one. Only a thread that actually narrows the channel earns it.
  if (thread && thread !== channel) lines.push(`- Thread: ${thread}`);
  if (sender) lines.push(`- Triggered by: ${sender}`);
  if (agent) lines.push(`- Agent: ${agent}`);
  if (conversation) lines.push(`- Conversation: ${conversation}`);
  if (origin) lines.push(`- Lobu: ${origin}`);
  if (url) lines.push(`- Link: ${url}`);

  if (lines.length === 0) return "";
  return `## This conversation\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// URL helper (only needed inside runAISession)
// ---------------------------------------------------------------------------

/**
 * Returns true iff the given URL points at OpenAI's real API host.
 * Uses URL parsing + exact host match so spoofed hosts like
 * `https://api.openai.com.evil.example/v1` are not mistaken for real OpenAI.
 */
function isRealOpenAIBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).host.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Params interface
// ---------------------------------------------------------------------------

interface RunAISessionParams {
  // Inputs from the caller
  userPrompt: string;
  customInstructions: string;
  onProgress: (update: ProgressUpdate) => Promise<void>;
  /**
   * `send_message` posted into the conversation that triggered this run. The
   * caller stamps the terminal completion so the gateway skips delivering the
   * reply a second time.
   */
  onInBandReplyDelivered?: () => void;

  // Worker config fields needed by the session
  agentOptions: string;
  sessionKey: string;
  channelId: string;
  conversationId: string;
  platform: string;
  /** Arbitrary platform-level metadata (e.g. { sessionReset: true, files: [...] }). */
  platformMetadata: unknown;
  organizationId: string;
  actorId: string;
  credentialSubject: string;
  agentId: string;
  runId: number;
  messageId: string;
  connectionId?: string;
  /**
   * This conversation's pinned bash-backend provider (from WorkerConfig).
   * Selects the bash backend per-turn: a provider id → that remote runtime;
   * undefined → local just-bash.
   */
  runtimeProviderId?: string;

  // Resolved workspace directory (from WorkspaceManager)
  workspaceDir: string;

  // Progress processor (class-owned state; passed by reference)
  progressProcessor: AgentProgressProcessor;

  // Callbacks back into LobuAgentWorker for class-level state mutations
  /**
   * Called once the session file path has been determined so the worker can
   * capture it for cleanup()/snapshot writing.
   */
  onSessionFilePathResolved: (sessionFilePath: string) => void;
  onSteerReady: (steer: ((prompt: string) => void) | null) => void;
  onCancelReady: (cancel: (() => void) | null) => void;
  /**
   * Called as soon as the model ref is resolved to a
   * (provider, modelId, providerSlug) triple so the worker can tag Sentry
   * captures with which provider/model a later failure belongs to. Fires before
   * any provider call can fail.
   */
  onModelResolved: (
    provider: string,
    modelId: string,
    providerSlug: string
  ) => void;

  // Methods delegated from LobuAgentWorker (kept on the class; passed here as
  // plain function references so the class can share them with tests without
  // also exposing the full worker instance to this module).
  loadImageAttachments: () => Promise<ImageContent[]>;
  maybeRunPreCompactionMemoryFlush: (params: {
    session: Awaited<ReturnType<typeof buildAgentSession>>["session"];
    sessionManager: Awaited<ReturnType<typeof openOrCreateSessionManager>>;
    settingsManager: SettingsManager;
    memoryFlushConfig: ReturnType<typeof resolveMemoryFlushConfig>;
    incomingPromptText: string;
    incomingImageCount: number;
    runSilentPrompt: (prompt: string) => Promise<void>;
  }) => Promise<void>;
}

/**
 * Defensively read a `!`-bash control action off the untyped `platformMetadata`
 * bag (the gateway sets `bangBash = { command, excludeFromContext }` at ingress
 * — see core `parseBangBashCommand`). Returns null unless a non-empty string
 * command and a boolean flag are present, so a malformed value can never trigger
 * an execution.
 */
function readBangBashCommand(
  platformMetadata: unknown
): { command: string; excludeFromContext: boolean } | null {
  if (!platformMetadata || typeof platformMetadata !== "object") return null;
  const bang = (platformMetadata as Record<string, unknown>).bangBash;
  if (!bang || typeof bang !== "object") return null;
  const command = (bang as Record<string, unknown>).command;
  if (typeof command !== "string" || command.trim() === "") return null;
  return {
    command,
    excludeFromContext:
      (bang as Record<string, unknown>).excludeFromContext === true,
  };
}

/**
 * Reconcile a just-hydrated session file with how pi's SessionManager will
 * persist the NEXT turn — needed only for an ASSISTANT-LESS transcript, which in
 * practice means a history whose only turns were `!`-bash (each records a
 * `bashExecution`, never an assistant). pi's `_persist` treats an assistant-less
 * session as an unflushed draft: on the next turn's first assistant message it
 * re-appends the ENTIRE in-memory branch (including the `session` header) to the
 * file — but the file is NOT empty, it holds the hydrated bytes, so the branch
 * lands twice, producing a second `session` header mid-file that corrupts the
 * transcript (the history parser then drops everything). pi's re-append assumes
 * the file is empty in that state; make it so. We've already loaded the entries
 * into memory via `open()`, so truncating the file loses nothing — the pending
 * re-flush rewrites the whole branch exactly once. A normal session (has an
 * assistant) is left untouched: pi appends incrementally and never re-flushes.
 */
export async function normalizeHydratedSessionFile(
  sessionManager: SessionManager,
  sessionFile: string
): Promise<void> {
  const hasAssistant = sessionManager
    .getBranch()
    .some(
      (entry) => entry.type === "message" && entry.message.role === "assistant"
    );
  if (hasAssistant) return;
  try {
    await fs.truncate(sessionFile, 0);
  } catch {
    // No file yet (fresh conversation) — nothing to reconcile.
  }
}

/**
 * Write the pinned session's current branch to disk so an assistant-less `!`-bash
 * turn survives the worker's mandatory transcript checkpoint (pi defers its own
 * flush until an assistant message exists — see the `!` intercept).
 *
 * Deliberately NOT `AgentSession.exportToJsonl()`: that regenerates the `session`
 * header with a fresh `new Date()` timestamp on every call, so a retry of the
 * SAME run would emit bytes that are not a prefix-extension of the first
 * snapshot and the gateway's monotonic-prefix guard would 409, wedging the run.
 * We reuse the EXISTING header (stable id + timestamp) and the branch entries
 * verbatim (stable ids/parentIds — the session is linear here), so re-running the
 * same turn yields byte-identical output and the snapshot upsert is idempotent.
 */
export async function persistBangBashSession(
  sessionManager: SessionManager,
  sessionFile: string
): Promise<void> {
  const header = sessionManager.getHeader();
  if (!header) return;
  const lines = [header, ...sessionManager.getBranch()].map((entry) =>
    JSON.stringify(entry)
  );
  await fs.writeFile(sessionFile, `${lines.join("\n")}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function runAISession(
  params: RunAISessionParams
): Promise<SessionExecutionResult> {
  const {
    userPrompt,
    customInstructions,
    onProgress,
    agentOptions,
    sessionKey,
    channelId,
    conversationId,
    platform,
    platformMetadata,
    organizationId,
    actorId,
    credentialSubject,
    agentId,
    runId,
    messageId,
    connectionId,
    runtimeProviderId,
    workspaceDir,
    progressProcessor,
    onSessionFilePathResolved,
    onSteerReady,
    onCancelReady,
    onModelResolved,
    loadImageAttachments,
    maybeRunPreCompactionMemoryFlush,
  } = params;

  let rawOptions: Record<string, unknown>;
  try {
    rawOptions = JSON.parse(agentOptions) as Record<string, unknown>;
  } catch (error) {
    logger.error(
      `Failed to parse agentOptions: ${error instanceof Error ? error.message : String(error)}`
    );
    rawOptions = {};
  }
  const verboseLogging = rawOptions.verboseLogging === true;
  const memoryFlushConfig = resolveMemoryFlushConfig(rawOptions);

  progressProcessor.setVerboseLogging(verboseLogging);

  // Resolve how MCP tools should be exposed to the agent. In embedded mode,
  // operators can swap the many first-class MCP tools for a small set of
  // per-server just-bash CLIs (keeps the tool list lean).
  const configuredMcpExposure = (
    rawOptions.toolsConfig as ToolsConfig | undefined
  )?.mcpExposure;
  const mcpExposure: "tools" | "cli" =
    configuredMcpExposure === "cli" ? "cli" : "tools";

  // Fetch session context BEFORE model resolution. Pass `mcpExposure` so
  // MCP setup instructions use the right call syntax.
  const context = await getAgentSessionContext({ mcpExposure });

  // Sync enabled skills to workspace filesystem so the agent can `cat` them.
  // Remove stale skill directories to avoid serving removed/disabled skills.
  const skillsRoot = path.join(workspaceDir, ".skills");
  await fs.mkdir(skillsRoot, { recursive: true });

  const nextSkillNames = new Set(
    context.skillsConfig
      .map((skill) => path.basename((skill.name || "").trim()))
      .filter(Boolean)
  );

  const existingSkillEntries = await fs
    .readdir(skillsRoot, { withFileTypes: true })
    .catch(() => []);

  for (const entry of existingSkillEntries) {
    if (!entry.isDirectory()) continue;
    if (!nextSkillNames.has(entry.name)) {
      await fs.rm(path.join(skillsRoot, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }

  for (const skill of context.skillsConfig) {
    const skillName = path.basename((skill.name || "").trim());
    if (!skillName) continue;
    if (!/^[a-zA-Z0-9._-]+$/.test(skillName)) {
      logger.warn(`Skipping skill with invalid name: ${skillName}`);
      continue;
    }
    const skillDir = path.join(skillsRoot, skillName);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skill.content, "utf-8");
  }

  logger.info(
    `Synced ${context.skillsConfig.length} skill(s) to .skills/ directory`
  );

  // Store credentials in a local map instead of mutating process.env
  // to prevent leaking secrets between sessions via persistent env vars.
  const credentialStore = new Map<string, string>();

  const pc = context.providerConfig;
  if (pc.credentialEnvVarName) {
    credentialStore.set("CREDENTIAL_ENV_VAR_NAME", pc.credentialEnvVarName);
  }
  if (pc.providerBaseUrlMappings) {
    for (const [envVar, url] of Object.entries(pc.providerBaseUrlMappings)) {
      credentialStore.set(envVar, url);
    }
  }
  if (pc.credentialPlaceholders) {
    for (const [envVar, placeholder] of Object.entries(
      pc.credentialPlaceholders
    )) {
      credentialStore.set(envVar, placeholder);
    }
  }

  // Register config-driven providers so resolveModelRef() can handle them
  if (pc.configProviders) {
    for (const [id, meta] of Object.entries(pc.configProviders)) {
      registerDynamicProvider(id, meta);
    }
  }

  const modelRef = typeof rawOptions.model === "string" ? rawOptions.model : "";

  const {
    provider: rawProvider,
    providerSlug,
    modelId,
  } = resolveModelRef(modelRef, {
    defaultModel: pc.defaultModel,
    defaultProvider: pc.defaultProvider,
    defaultProviderSlug: pc.defaultProviderSlug,
    installedProviderRoutes: pc.installedProviderRoutes,
  });
  // Map gateway slug to model-registry provider name (PROVIDER_REGISTRY_ALIASES)
  const provider = PROVIDER_REGISTRY_ALIASES[rawProvider] || rawProvider;
  onModelResolved(provider, modelId, providerSlug);

  // Dynamic provider base URL from agentOptions.providerBaseUrlMappings
  let providerBaseUrl: string | undefined;
  const dynamicMappings = rawOptions.providerBaseUrlMappings as
    | Record<string, string>
    | undefined;
  if (dynamicMappings && typeof dynamicMappings === "object") {
    const fallbackEnvVar = DEFAULT_PROVIDER_BASE_URL_ENV[rawProvider];
    if (fallbackEnvVar && dynamicMappings[fallbackEnvVar]) {
      providerBaseUrl = dynamicMappings[fallbackEnvVar];
    }
    for (const [envVar, url] of Object.entries(dynamicMappings)) {
      if (!credentialStore.has(envVar)) {
        credentialStore.set(envVar, url);
      }
    }
  }
  if (!providerBaseUrl) {
    providerBaseUrl =
      typeof rawOptions.providerBaseUrl === "string"
        ? rawOptions.providerBaseUrl.trim() || undefined
        : undefined;
  }
  if (!providerBaseUrl) {
    const baseUrlEnvVar = DEFAULT_PROVIDER_BASE_URL_ENV[rawProvider];
    if (baseUrlEnvVar) {
      const baseUrlValue = credentialStore.get(baseUrlEnvVar);
      if (baseUrlValue) {
        providerBaseUrl = baseUrlValue;
      }
    }
  }

  // Fail before pi-ai/model construction with an operator-facing explanation.
  // A non-OpenAI provider must route through the Lobu gateway proxy; otherwise
  // the SDK would hit a public endpoint with a tenant/org model id and return a
  // confusing low-level error. The common real-world cause is a model selected
  // from a provider that is not installed/connected on the agent.
  if (!providerBaseUrl && rawProvider !== "openai") {
    const baseUrlEnvVar = DEFAULT_PROVIDER_BASE_URL_ENV[rawProvider];
    if (baseUrlEnvVar) {
      const installedRoutes = pc.installedProviderRoutes ?? {};
      const installedProviderIds = Object.keys(installedRoutes);
      const providerIsInstalled =
        installedRoutes[rawProvider] != null ||
        Object.values(installedRoutes).includes(rawProvider);
      const selectedModel = `${rawProvider}/${modelId}`;
      const dispatcherUrl = process.env.DISPATCHER_URL?.replace(/\/$/, "");
      const encodedAgentId = encodeURIComponent(agentId || "unknown-agent");
      const expectedProxyUrl = dispatcherUrl
        ? `${dispatcherUrl}/api/proxy/${rawProvider}/a/${encodedAgentId}`
        : `/api/proxy/${rawProvider}/a/${encodedAgentId}`;

      if (installedProviderIds.length === 0 || !providerIsInstalled) {
        throw new Error(
          `The selected model (${selectedModel}) uses provider "${rawProvider}", ` +
            `but that provider is not connected to this agent. Connect "${rawProvider}" ` +
            `in the agent's Providers settings, or choose a model from a connected provider, then try again. ` +
            `Expected gateway proxy URL after setup: ${expectedProxyUrl}`
        );
      }

      throw new Error(
        `The selected model (${selectedModel}) uses provider "${rawProvider}", ` +
          `but Lobu did not receive the gateway routing URL it needs (${baseUrlEnvVar}). ` +
          `Expected gateway proxy URL: ${expectedProxyUrl}. ` +
          `Restart the agent worker or redeploy the gateway; if this keeps happening, contact support.`
      );
    }
  }

  let baseModel: Model<any> | undefined = getModelDynamic(provider, modelId);
  if (!baseModel) {
    // The model isn't in pi-ai's static registry — build a dynamic entry. Which
    // path depends on the provider's wire protocol (the registry alias, set from
    // sdkCompat by registerDynamicProvider): anthropic clones a known Claude
    // shape (pi-ai's static Anthropic registry lags newest models); every other
    // protocol builds a generic dynamic model with the matching pi-ai adapter.
    const registryProvider =
      PROVIDER_REGISTRY_ALIASES[rawProvider] || rawProvider;
    if (provider === "anthropic") {
      // The newest Claude models (resolved live from the provider for auto-mode
      // agents) lag pi-ai's static registry. Clone a known Claude model's shape
      // and override the id so the agent still runs — Anthropic / the
      // claude-code CLI validates the id upstream. Without this, an auto-mode
      // agent on the newest model crashes with "not found in the model registry".
      const template = [
        "claude-sonnet-4-5",
        "claude-sonnet-4-20250514",
        "claude-haiku-4-5-20251001",
        "claude-3-5-sonnet-20241022",
      ]
        .map((id) => getModelDynamic("anthropic", id))
        .find(Boolean);
      if (template) {
        logger.info(
          `Creating dynamic Claude model entry for ${modelId} (not in static registry)`
        );
        baseModel = { ...template, id: modelId, name: modelId };
      } else {
        throw new Error(
          `Model "${modelId}" not found for provider "${provider}". Check that the model ID is valid and registered in the model registry.`
        );
      }
    } else if (registryProvider === "openai" || rawProvider !== provider) {
      // OpenAI-compatible (openai, nvidia, together-ai, …) or any org BYO
      // provider whose slug differs from its registry alias. Resolve the pi-ai
      // adapter from the provider's protocol; default to openai-completions.
      const api = resolveDynamicModelApi(rawProvider, registryProvider);
      logger.info(
        `Creating dynamic model entry for ${rawProvider}/${modelId} (${api ?? "openai-completions"})`
      );
      // Throws if a non-OpenAI provider's base URL is unresolved, rather
      // than silently routing to a public endpoint.
      baseModel = buildDynamicOpenAIModel({
        rawProvider,
        registryProvider,
        modelId,
        providerBaseUrl,
        api,
      });
    } else {
      throw new Error(
        `Model "${modelId}" not found for provider "${provider}". Check that the model ID is valid and registered in the model registry.`
      );
    }
  }
  // Every path above either assigns `baseModel` or throws, so it's defined here;
  // this guard makes that invariant explicit for the type checker (and is a
  // defensive backstop).
  if (!baseModel) {
    throw new Error(`Could not resolve a model for "${provider}/${modelId}".`);
  }
  const resolvedModel = providerBaseUrl
    ? { ...baseModel, baseUrl: providerBaseUrl }
    : baseModel;

  // Defensive: any `openai-completions` model whose baseUrl is not real
  // OpenAI is a third-party compat endpoint (Gemini, Nvidia, Together,
  // etc.). These reject unknown fields and 400 with "Unknown name 'store'"
  // if pi-ai sends `store: false`. Force it off regardless of whether the
  // model came from the static registry or the dynamic fallback above.
  //
  // Host comparison uses URL parsing (not `.startsWith`) so that a baseUrl
  // like `https://api.openai.com.evil.example/v1` doesn't get mistaken for
  // real OpenAI. Malformed URLs are treated as third-party (safer default).
  const isThirdPartyOpenAICompat =
    resolvedModel.api === "openai-completions" &&
    typeof resolvedModel.baseUrl === "string" &&
    !isRealOpenAIBaseUrl(resolvedModel.baseUrl);
  const model = isThirdPartyOpenAICompat
    ? {
        ...resolvedModel,
        compat: { ...(resolvedModel.compat ?? {}), supportsStore: false },
      }
    : resolvedModel;

  await fs.mkdir(path.join(workspaceDir, ".lobu"), { recursive: true });

  const sessionFile = path.join(workspaceDir, ".lobu", "session.jsonl");
  // Notify the worker so cleanup() can capture it for snapshot writing at
  // terminal time.
  onSessionFilePathResolved(sessionFile);
  // Hydrate from the latest completed Postgres snapshot BEFORE inspecting
  // the transcript's provider metadata or opening the live session.
  //
  // Order matters: hydrate → open/inspect → optional unlink/reopen. Provider
  // identity comes from Pi's model_change/assistant entries inside the
  // durable transcript, not a pod-local sidecar. A provider-change unlink
  // drops the just-hydrated file and the reopened manager starts fresh. The
  // next completed snapshot then becomes the latest durable conversation.
  {
    const gatewayUrl = process.env.DISPATCHER_URL;
    const workerToken = process.env.WORKER_TOKEN;
    if (gatewayUrl && workerToken) {
      try {
        await hydrateFromSnapshot({
          sessionFile,
          gatewayUrl,
          workerToken,
        });
      } catch (err) {
        // Hydrate failure is non-fatal — fall back to whatever's on disk.
        // Worst case the worker boots without history and the user re-
        // grounds the conversation. Better than refusing to start.
        logger.warn(
          `Snapshot hydrate failed; continuing with local session file: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else {
      logger.warn(
        "Snapshot hydrate skipped: DISPATCHER_URL or WORKER_TOKEN missing"
      );
    }
  }

  let sessionManager = await openOrCreateSessionManager(
    sessionFile,
    workspaceDir
  );
  const sessionSummary = await resetSessionForProviderChange({
    sessionFile,
    sessionManager,
    provider,
  });
  if (sessionSummary) {
    logger.info("Provider changed or was unknown; resetting session");
    sessionManager = await openOrCreateSessionManager(
      sessionFile,
      workspaceDir
    );
  }
  // Reconcile an assistant-less hydrated transcript (a `!`-bash-only history) so
  // this turn's first assistant message doesn't make pi re-append the whole
  // branch onto the already-hydrated file and double the session header. No-op
  // for a normal session (has an assistant). Must run on the FINAL manager,
  // after any provider-change reopen above.
  await normalizeHydratedSessionFile(sessionManager, sessionFile);
  const settingsManager = SettingsManager.inMemory();

  const toolsPolicy = buildToolPolicy({
    toolsConfig: rawOptions.toolsConfig as ToolsConfig | undefined,
    allowedTools: rawOptions.allowedTools as string | string[] | undefined,
    disallowedTools: rawOptions.disallowedTools as
      | string
      | string[]
      | undefined,
  });

  // Build a mutable snapshot of MCP runtime state. The embedded CLI handlers
  // read through `mcpRuntimeRef.current` so that `auth check` / `logout` can
  // swap in refreshed tools/state without rebuilding Bash. `refresh()` re-
  // fetches session context — `checkMcpLogin`/`logoutMcp` already invalidate
  // the gateway cache, so the next fetch reaches the gateway.
  const mcpRuntimeRef = {
    current: {
      mcpTools: context.mcpTools,
      mcpStatus: context.mcpStatus,
      mcpContext: context.mcpContext,
    },
    ...(mcpExposure === "cli" && {
      refresh: async () => {
        try {
          const fresh = await getAgentSessionContext({ mcpExposure });
          return {
            mcpTools: fresh.mcpTools,
            mcpStatus: fresh.mcpStatus,
            mcpContext: fresh.mcpContext,
          };
        } catch (err) {
          logger.warn(
            `Failed to refresh MCP session context after auth: ${err instanceof Error ? err.message : String(err)}`
          );
          return null;
        }
      },
    }),
  };

  const gwParams: GatewayParams = {
    gatewayUrl: getOptionalEnv("DISPATCHER_URL", ""),
    // `workerToken` is a GETTER, not a captured string: every gateway/MCP/
    // interaction call reads it fresh, so a mid-turn token refresh (the
    // WorkerTokenManager swaps the live token when a >2h turn renews) is
    // immediately picked up — a captured string would keep sending the now-
    // expired original bearer and 401 the rest of the turn.
    //
    // The manager is the single source of truth: it was seeded at turn start
    // with the per-run runJobToken (adoptWorkerToken in LobuAgentWorker.execute),
    // which carries the headless `source` so cards from headless turns are
    // stamped headless and skip the SSE-owner gate. For legacy direct-enqueue
    // runs with no per-run token it falls back to the env WORKER_TOKEN the
    // manager was constructed from.
    get workerToken() {
      return getWorkerTokenManager().getToken();
    },
    channelId,
    conversationId,
    platform,
    workspaceDir,
  };

  const embeddedBashOps: import("@mariozechner/pi-coding-agent").BashOperations =
    await createEmbeddedBashOps({
      workspaceDir,
      mcpRuntimeRef,
      gw: gwParams,
      mcpExposure,
      // Per-turn pinned provider from the sandbox pin; selects the bash backend.
      runtimeProviderId,
    });
  // The bash tool returned here carries the FULL hardened policy by construction
  // (prefix allow/deny + gateway-access + package-install blocks, plus
  // environment allowlist), and the `!`-bash intercept reuses the same guards (via
  // enforceBashPreflight) rather than a second raw path. The filter then removes
  // bash entirely when the agent policy disallows it (strict / disallowedTools).
  const tools = createLobuTools(workspaceDir, {
    bashOperations: embeddedBashOps,
    bashPolicy: toolsPolicy.bashPolicy,
  }).filter((tool) => isToolAllowedByPolicy(tool.name, toolsPolicy));

  // Credential injection — resolve API key from the in-memory credential store,
  // falling back to process.env only for values that were present at startup.
  // In-memory only — the worker injects runtime API keys below and never reads
  // or writes an on-disk auth.json (pi-ai 0.73 made the AuthStorage ctor private
  // in favour of these factories).
  const authStorage = AuthStorage.inMemory();
  const credEnvVar = credentialStore.get("CREDENTIAL_ENV_VAR_NAME") || null;
  const credValue = credEnvVar
    ? credentialStore.get(credEnvVar) || process.env[credEnvVar]
    : null;
  if (credEnvVar && credValue) {
    authStorage.setRuntimeApiKey(provider, credValue);
    logger.info(`Set runtime API key for ${provider}`);
  } else {
    // Look up the env var by the canonical gateway slug (e.g. "gemini" → GEMINI_API_KEY),
    // not the model-registry alias.
    const fallbackEnvVar = getApiKeyEnvVarForProvider(rawProvider);
    const fallbackValue =
      credentialStore.get(fallbackEnvVar) || process.env[fallbackEnvVar];
    if (fallbackValue) {
      authStorage.setRuntimeApiKey(provider, fallbackValue);
      logger.info(`Set runtime API key for ${provider}`);
    }
  }

  // Re-resolve provider base URL after session context may have updated mappings
  if (!providerBaseUrl) {
    const baseUrlEnvVar = DEFAULT_PROVIDER_BASE_URL_ENV[rawProvider];
    if (baseUrlEnvVar) {
      const baseUrlValue = credentialStore.get(baseUrlEnvVar);
      if (baseUrlValue) {
        providerBaseUrl = baseUrlValue;
      }
    }
  }

  // Merge gateway instructions into custom instructions
  const instructionParts = [context.gatewayInstructions, customInstructions];

  instructionParts.push(
    buildRuntimeShellInstructions(
      runtimeProviderId,
      tools.some((tool) => tool.name === "bash")
    )
  );

  // CLI backends are delivered via session context from the gateway.
  const cliBackends = pc.cliBackends;
  if (cliBackends?.length) {
    const agentList = cliBackends
      .map((b) => {
        const cmd = `${b.command} ${(b.args || []).join(" ")}`;
        const aliases = [b.name, b.providerId].filter(
          (v, i, a) => v && a.indexOf(v) === i
        );
        return `### ${aliases.join(" / ")}
Run via Bash exactly as shown (do NOT modify the command):
\`\`\`bash
${cmd} "YOUR_PROMPT_HERE"
\`\`\``;
      })
      .join("\n\n");
    instructionParts.push(
      `## Available Coding Agents

You have access to the following AI coding agents. When the user mentions any of these by name (e.g. "use claude", "ask chatgpt"), you MUST run the exact command shown below via the Bash tool. Do NOT attempt to install or locate the CLI yourself — the command handles everything.

${agentList}

Replace "YOUR_PROMPT_HERE" with the user's request. These agents can read/write files, install packages, and run commands in the working directory.`
    );
  }

  instructionParts.push(`## Conversation History

Use search_memory to look up past discussion — it returns matching messages from
your channels (conversation_messages) alongside saved knowledge. Use it when the
user references earlier discussion or you need prior context.`);

  // Owns the decision to force-end a turn so it never depends on the model
  // voluntarily stopping. AskUser calls `terminate("ask-user")` after posting
  // (via onAskUserPosted); the runaway guards (identical-tool loop + total
  // tool-call cap) trip inside the synchronous tool-execute wrapper applied
  // below. The abort function is attached once the session exists.
  const turnController = new TurnController({
    onTerminate: ({ message }) => {
      logger.warn(`Turn force-terminated: ${message}`);
    },
  });

  const runtimePluginHost = createRuntimePluginHost({
    gatewayUrl: gwParams.gatewayUrl,
    get workerToken() {
      return gwParams.workerToken;
    },
    channelId: gwParams.channelId,
    conversationId: gwParams.conversationId,
    platform: gwParams.platform,
    workspaceDir,
    onCustomEvent: async (name, data) => {
      await onProgress({
        type: "custom_event",
        data: { name, payload: data },
        timestamp: Date.now(),
      });
    },
    onAskUserPosted: () =>
      turnController.terminate(
        "ask-user",
        "ask_user posted — ending the turn so the model can't re-post."
      ),
    onInBandReplyDelivered: params.onInBandReplyDelivered,
    includeMcpTools: mcpExposure !== "cli",
    mcpTools: context.mcpTools,
    mcpStatus: context.mcpStatus,
    mcpContext: context.mcpContext,
    onMcpAuthChanged: invalidateSessionContextCache,
  });
  const pluginRuntimeContext: PluginRuntimeContext = {
    organizationId,
    actorId,
    credentialSubject,
    destination: channelId,
    agentId,
    conversationId,
    runId,
    messageId,
    ...(connectionId ? { connectionId } : {}),
    workspaceDir,
    platform,
    logger: createPluginLogger(logger),
  };
  const customTools = await runtimePluginHost.tools(pluginRuntimeContext);

  if (mcpExposure === "cli") {
    logger.info(
      "mcpExposure='cli' — skipping first-class MCP tool registration (tools reachable via <server> <tool> in Bash)."
    );
  }

  const modelRegistry = ModelRegistry.create(authStorage);

  // Rebuild final instructions after possible login link injection
  const finalInstructionsUpdated = instructionParts
    .filter(Boolean)
    .join("\n\n");

  logger.info(
    `Starting Lobu session: provider=${provider}, model=${modelId}, tools=${tools.length}, customTools=${customTools.length}`
  );

  // Heartbeat timer to keep connection alive during long API calls
  const HEARTBEAT_INTERVAL_MS = 20000;
  let heartbeatTimer: Timer | null = null;
  let deltaTimer: Timer | null = null;
  let session: Awaited<ReturnType<typeof buildAgentSession>>["session"] | null =
    null;
  let activeTransientTurnContext = "";
  // Fire the plugin `agent_end` hook with the live session messages. No-op
  // when the session never came up (the catch path before construction). An
  // `error` makes it a failure; its absence makes it a success.
  const emitAgentEnd = async (error?: string): Promise<void> => {
    if (!session) return;
    await runtimePluginHost.agentEnd(
      {
        ...(error !== undefined ? { error } : {}),
        messages: session.messages,
      },
      pluginRuntimeContext
    );
  };

  // The single `SessionExecutionResult` shape every exit path returns. An
  // `error` flips success off and sets exitCode 1.
  const buildResult = (error?: string): SessionExecutionResult => ({
    success: error === undefined,
    exitCode: error === undefined ? 0 : 1,
    output: "",
    ...(error !== undefined ? { error } : {}),
    sessionKey,
  });

  // The Lobu system prompt for this run. Handed to the session so pi installs
  // it as the base prompt AND reinstalls it before every turn; nothing here
  // reads or rewrites pi's own prompt text.
  const renderSystemPrompt = createLobuSystemPromptRenderer({
    identity: resolveAgentIdentity(context.agentLayers),
    gatewayInstructions: finalInstructionsUpdated,
    cwd: workspaceDir,
  });

  try {
    const createdSession = await buildAgentSession({
      cwd: workspaceDir,
      model,
      renderSystemPrompt,
      getTransientTurnContext: () => activeTransientTurnContext,
      // pi's createAgentSession() uses `tools` only to derive active tool
      // names and rebuilds the base tools internally (bash via getShellEnv()
      // = {...process.env}, no env strip, no embedded BashOperations).
      // buildAgentSession() swaps those rebuilt built-ins back to these
      // Lobu instances (via `builtinOverrides`) after construction so the
      // agent's bash actually runs with the spawnHook that replaces the
      // inherited environment with the `buildAgentEnv` allowlist and with the
      // embedded BashOperations + tool policy wired in above. `tools` (names)
      // activates exactly this set; `builtinOverrides` supplies the instances
      // the swap installs.
      // Wrap built-ins with the synchronous runaway guard so the per-turn
      // tool-call cap and identical-call guard bound bash/read/edit/write
      // too. The guard runs inside execute (before the tool body), so the
      // bound is tight — unlike the agent's async tool_execution_start event,
      // which lags several turns behind real execution.
      // pi 0.73.x treats `tools` as BOTH the initial active set AND a hard
      // allowlist (sdk.js: `allowedToolNames = options.tools`; agent-session
      // filters every registered/custom tool whose name isn't in it). Passing
      // only the base built-in names therefore silently dropped EVERY customTool
      // (ask_user, MCP tools, memory, plugins, image/audio) before the model
      // saw it — agents were left with just read/write/edit/bash/grep/find/ls.
      // activeToolNames() unions the customTool names in so they survive the
      // allowlist and stay active. (`builtinOverrides` still supplies the
      // base-tool instances; the customTool instances come from the
      // `customTools` option below.)
      tools: activeToolNames(tools, customTools),
      builtinOverrides: wrapToolsWithTurnGuard(tools, turnController),
      // Layer the runaway guard over every custom tool so AskUser/MCP/capability
      // tools are bounded identically to the built-ins.
      customTools: wrapToolsWithTurnGuard(customTools, turnController),
      sessionManager,
      // Provider isolation is a durable conversation event, unlike per-run
      // attention/recall/channel context. buildAgentSession adds the hidden Pi
      // custom message only AFTER Pi records this new session's model_change.
      providerChangeSummary: sessionSummary,
      settingsManager,
      authStorage,
      modelRegistry,
    });
    session = createdSession.session;
    // Wire the turn controller's abort to the live agent. `agent.abort()`
    // fires the shared AbortController: the in-flight/next LLM stream sees the
    // aborted signal and the loop emits `agent_end` with NO further model
    // iteration. Tool results recorded before the abort are already persisted
    // to the session, so the resume path (next inbound message → new turn) is
    // unaffected.
    turnController.attachAbort(() => {
      createdSession.session.agent.abort();
    });

    let resolveTurnDone: (() => void) | null = null;
    let turnNonce = 0;
    let suppressProgressOutput = false;

    // Wire events through progress processor with delta batching
    let pendingDelta = "";
    const DELTA_BATCH_INTERVAL_MS = 150;

    const flushDelta = async () => {
      if (pendingDelta) {
        const toSend = pendingDelta;
        pendingDelta = "";
        await onProgress({
          type: "output",
          data: toSend,
          timestamp: Date.now(),
        });
      }
      if (deltaTimer) {
        clearTimeout(deltaTimer);
        deltaTimer = null;
      }
    };

    const scheduleDeltaFlush = () => {
      if (!deltaTimer) {
        deltaTimer = setTimeout(() => {
          flushDelta().catch((err) => {
            logger.error("Failed to flush delta:", err);
          });
        }, DELTA_BATCH_INTERVAL_MS);
      }
    };

    const runPromptTurn = async (
      promptText: string,
      options?: {
        images?: ImageContent[];
        silent?: boolean;
        transientContext?: string;
      }
    ): Promise<void> => {
      const currentSession = session;
      if (!currentSession) {
        throw new Error("Lobu session is not initialized");
      }

      turnNonce += 1;
      const currentTurnNonce = turnNonce;

      // Reset per-turn runaway guards so cap/identical-call tracking is scoped
      // to this turn only.
      turnController.startTurn();

      const turnDone = new Promise<void>((resolve) => {
        resolveTurnDone = () => {
          if (currentTurnNonce !== turnNonce) {
            return;
          }
          resolveTurnDone = null;
          resolve();
        };
      });

      suppressProgressOutput = options?.silent === true;
      activeTransientTurnContext = options?.transientContext?.trim() ?? "";

      try {
        onSteerReady((prompt) => {
          currentSession.agent.steer({
            role: "user",
            content: prompt,
            timestamp: Date.now(),
          });
        });
        onCancelReady(() => currentSession.agent.abort());
        try {
          if (options?.images) {
            await currentSession.prompt(promptText, {
              images: options.images,
            });
          } else {
            await currentSession.prompt(promptText);
          }
        } finally {
          // Pi only consumes steering while prompt() is active. Clear these
          // before the final progress flush so input arriving after agent_end
          // falls through to MessageBatcher as a follow-up turn instead of
          // being acknowledged into a settled agent that cannot process it.
          onSteerReady(null);
          onCancelReady(null);
        }
        await turnDone;
      } finally {
        activeTransientTurnContext = "";
        suppressProgressOutput = false;
        if (resolveTurnDone && currentTurnNonce === turnNonce) {
          resolveTurnDone = null;
        }
      }
    };

    // Track tool-call input args across tool_execution_start → _end. pi-agent
    // only includes `args` on the start event; the end event carries
    // `toolCallId`, `toolName`, `result`, `isError`. The worker emits one
    // SSE `tool_use` per finished call, so it needs to remember the input.
    const pendingToolArgs = new Map<string, unknown>();
    // Tool-use SSE emits are awaited at agent_end so the `complete` event
    // can't race ahead of late tool_use events on slow networks.
    const inFlightToolUse: Set<Promise<void>> = new Set();

    session.subscribe((event) => {
      if (suppressProgressOutput) {
        if (event.type === "agent_end") {
          resolveTurnDone?.();
        }
        return;
      }

      const hasUpdate = progressProcessor.processEvent(event);
      if (hasUpdate) {
        const delta = progressProcessor.getDelta();
        if (delta) {
          pendingDelta += delta;
          scheduleDeltaFlush();
        }
      }

      // Capture the input args at tool start so we can attach them when the
      // matching end event fires. (The runaway guard runs synchronously in
      // the tool-execute wrapper, not here — this event stream lags several
      // turns behind real execution.)
      if (event.type === "tool_execution_start") {
        pendingToolArgs.set(event.toolCallId, event.args);
      }

      // Surface tool-use traces to SSE clients (promptfoo provider, CLI eval,
      // any client subscribed via `event: tool_use`). Worker emits one record
      // per tool call at `tool_execution_end` so the result is included.
      if (event.type === "tool_execution_end") {
        const args = pendingToolArgs.get(event.toolCallId);
        pendingToolArgs.delete(event.toolCallId);
        const payload = buildToolUseEventPayload({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args,
          result: event.result,
          isError: event.isError,
        });
        const promise = onProgress({
          type: "custom_event",
          data: {
            name: "tool_use",
            payload: payload as unknown as Record<string, unknown>,
          },
          timestamp: Date.now(),
        }).catch((err) => {
          logger.warn(
            `Failed to emit tool_use custom event for ${event.toolName}:`,
            err
          );
        });
        inFlightToolUse.add(promise);
        promise.finally(() => inFlightToolUse.delete(promise));
      }

      if (event.type === "agent_end") {
        flushDelta()
          .then(async () => {
            // Wait for any pending tool_use emits so clients don't see
            // `complete` arrive before all tool_use records (the provider
            // returns on `complete`, and a slow tool_use POST mid-flight
            // would otherwise be lost).
            if (inFlightToolUse.size > 0) {
              await Promise.allSettled(Array.from(inFlightToolUse));
            }
            resolveTurnDone?.();
          })
          .catch((err) => {
            logger.error("Failed to flush final delta:", err);
            resolveTurnDone?.();
          });
      }
    });

    let elapsedTime = 0;
    let lastHeartbeatTime = Date.now();
    const MAX_CONSECUTIVE_HEARTBEAT_FAILURES = 5;
    let consecutiveHeartbeatFailures = 0;

    const sendHeartbeat = async () => {
      const now = Date.now();
      elapsedTime += now - lastHeartbeatTime;
      lastHeartbeatTime = now;
      const seconds = Math.floor(elapsedTime / 1000);

      logger.warn(
        `⏳ Still running after ${seconds}s - no response from API yet`
      );

      await onProgress({
        type: "status_update",
        data: {
          elapsedSeconds: seconds,
          state: "is running..",
        },
        timestamp: Date.now(),
      });
    };

    heartbeatTimer = setInterval(() => {
      sendHeartbeat()
        .then(() => {
          consecutiveHeartbeatFailures = 0;
        })
        .catch((err) => {
          consecutiveHeartbeatFailures += 1;
          logger.error(
            `Failed to send heartbeat (${consecutiveHeartbeatFailures}/${MAX_CONSECUTIVE_HEARTBEAT_FAILURES}):`,
            err
          );
          if (
            consecutiveHeartbeatFailures >= MAX_CONSECUTIVE_HEARTBEAT_FAILURES
          ) {
            logger.error(
              "Gateway unresponsive after consecutive heartbeat failures, aborting session"
            );
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer);
              heartbeatTimer = null;
            }
            // Unblock any in-flight prompt turn FIRST — disposing the session
            // without resolving `turnDone` leaves `runPromptTurn` (and the
            // outer `runAISession`) wedged on `await turnDone` until the
            // deployment manager force-kills the worker.
            resolveTurnDone?.();
            if (session) {
              session.dispose();
              // Null it so the outer `finally` (which also disposes when
              // `session` is set) doesn't dispose a second time — a
              // non-idempotent dispose would throw during cleanup.
              session = null;
            }
          }
        });
    }, HEARTBEAT_INTERVAL_MS);

    // Session reset: run unconditional memory flush, delete session file, and return early
    if ((platformMetadata as any)?.sessionReset === true) {
      logger.info(
        "Session reset requested — running unconditional memory flush"
      );

      const flushPrompt = `${memoryFlushConfig.systemPrompt}\n\n${memoryFlushConfig.prompt}`;
      try {
        await runPromptTurn(flushPrompt, { silent: true });
        logger.info("Memory flush completed for session reset");
      } catch (error) {
        logger.warn(
          `Memory flush failed during session reset: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Delete session file so next run starts with a clean history
      try {
        await fs.unlink(sessionFile);
        logger.info("Deleted session file for session reset");
      } catch {
        // File may not exist
      }

      // Also purge the Postgres snapshots for this (org, agent, conv)
      // — the next worker boot would otherwise rehydrate from the
      // now-flushed conversation and the user-visible "Starting fresh"
      // would be a lie. Best-effort: a failure here is logged but
      // doesn't block the reset since the local unlink already
      // happened.
      {
        const gatewayUrl = process.env.DISPATCHER_URL;
        const workerToken = process.env.WORKER_TOKEN;
        if (gatewayUrl && workerToken) {
          await clearSnapshots({ gatewayUrl, workerToken });
        }
      }

      // Send visible confirmation to user
      await onProgress({
        type: "output",
        data: "Context saved. Starting fresh.",
        timestamp: Date.now(),
      });

      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (deltaTimer) clearTimeout(deltaTimer);

      return buildResult();
    }

    // `!`-bash: run the command as shell in this conversation's pinned sandbox
    // and return the output as the reply — the LLM is skipped entirely. The
    // command runs through the SAME hardened path the agent's own bash tool uses
    // (enforceBashPreflight → the pinned embeddedBashOps), so it inherits the
    // prefix policy, gateway-access block, package-install block, and
    // environment allowlist; it crosses no boundary the agent couldn't already. pi's
    // `executeBash` records a `bashExecution` transcript entry synchronously and
    // honors `excludeFromContext` (the `!!` form).
    const bangBash = readBangBashCommand(platformMetadata);
    if (bangBash && session) {
      const bashSession = session;
      // Bash was removed from the tool list by policy (strict / disallowedTools)
      // → `!` is disabled, exactly as the agent's own bash would be.
      const bashEnabled = tools.some((tool) => tool.name === "bash");
      let replyText: string;
      if (!bashEnabled) {
        replyText = "Bash is disabled for this agent.";
      } else {
        try {
          enforceBashPreflight(bangBash.command, toolsPolicy.bashPolicy);
          // Make the running command cancellable: an explicit `/cancel` (or the
          // steer/cancel path) aborts the in-flight bash, and `executeBash`
          // returns with `cancelled: true`. Cleared in `finally` so a stale
          // callback can't abort the next turn's bash.
          onCancelReady(() => bashSession.abortBash());
          let result: Awaited<ReturnType<typeof bashSession.executeBash>>;
          try {
            result = await bashSession.executeBash(
              bangBash.command,
              undefined,
              {
                operations: embeddedBashOps,
                excludeFromContext: bangBash.excludeFromContext,
              }
            );
          } finally {
            onCancelReady(null);
          }
          // Cancelled FIRST: on cancel `exitCode` may be undefined, so a
          // "exit N" branch would misreport. `result.output` is the full
          // buffered output (no streaming of raw shell output).
          if (result.cancelled) {
            replyText = `\`${bangBash.command}\` cancelled.\n\n\`\`\`\n${result.output}\n\`\`\``;
          } else {
            const exit = result.exitCode ?? 0;
            const status = exit === 0 ? "" : ` (exit ${exit})`;
            replyText = `\`\`\`\n${result.output}\n\`\`\`${status}`;
          }
        } catch (err) {
          // A preflight/backend rejection is the reply — never an agent turn.
          replyText = `\`${bangBash.command}\` blocked: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Persist the session before the worker's mandatory transcript checkpoint.
      // pi's SessionManager defers its on-disk flush until an ASSISTANT message
      // exists (it treats an assistant-less session as an incomplete draft). A
      // `!` turn never produces an assistant message, so without this the session
      // file stays empty and `checkpointSuccessfulRun` fails ("Transcript
      // checkpoint failed"), REJECTING the run — the record is lost and, on a
      // fresh conversation, the whole `!` turn 500s. `persistBangBashSession`
      // writes the full branch under the EXISTING (stable) header — the exact
      // format `SessionManager.open()` expects on the next hydrate, and
      // byte-idempotent across a same-run retry. This covers ALL `!` outcomes:
      // executed (pi recorded a `bashExecution`), bash-disabled, and
      // preflight/backend-blocked (no pi record, but the header alone is a valid
      // non-empty checkpoint). Guard on the absence of an assistant message: with
      // one, pi already flushed incrementally and rewriting would diverge from
      // the bytes a later turn extends, tripping the snapshot's monotonic-prefix
      // guard. (The complementary "a later normal turn re-appends this
      // assistant-less branch and doubles the header" hazard is handled once, at
      // the hydrate/open boundary — see `normalizeHydratedSessionFile`.)
      const hasAssistant = bashSession.messages.some(
        (message) => message.role === "assistant"
      );
      if (!hasAssistant) {
        await persistBangBashSession(bashSession.sessionManager, sessionFile);
      }

      // Same file-link neutralization the agent's own replies get, applied to
      // the COMPLETE output before the single emit (no raw pre-redaction bytes
      // ever leave the worker for a `!` turn).
      const redacted = checkSandboxLeak(replyText, false).redactedText;
      await onProgress({
        type: "output",
        data: redacted,
        timestamp: Date.now(),
      });

      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (deltaTimer) clearTimeout(deltaTimer);

      // No `emitAgentEnd`: this was not an agent turn (the model never ran).
      return buildResult();
    }

    // Consume any pending config change notifications from SSE events.
    const configNotifications = consumePendingConfigNotifications();

    let configNotice = "";
    if (configNotifications.length > 0) {
      const lines = configNotifications.map((n) => {
        let line = `- ${n.summary}`;
        if (n.details?.length) {
          line += `: ${n.details.join("; ")}`;
        }
        return line;
      });
      configNotice = `[System notice: Your configuration was updated since the last message]\n${lines.join("\n")}\n\n`;
    }

    const prependContexts = (
      await runtimePluginHost.beforeAgentStart(
        { prompt: userPrompt, messages: session.messages },
        pluginRuntimeContext
      )
    ).join("\n\n");

    const ephemeralContext =
      typeof (platformMetadata as Record<string, unknown> | null)
        ?.ephemeralContext === "string"
        ? String(
            (platformMetadata as Record<string, unknown>).ephemeralContext
          ).trim()
        : "";

    // Inline LobuRef tokens (@[kind:id:label](path)) the composer serialized
    // stay in the user prompt verbatim: the agent sees exactly what was
    // referenced and resolves any it needs on demand with its own tools
    // (resolve_path etc.). We deliberately do NOT prepend a "these objects were
    // referenced, go resolve them" hint — as an instruction-shaped preamble in
    // the user turn the model tended to echo it back into its reply. (Full
    // pre-resolution of refs into injected data is a possible future follow-up.)
    // Per-run conversation context (channel, trigger, link). Injected into the
    // provider's user-turn view — NOT the cached system prompt or persisted
    // user message — because it varies per turn.
    const runContext = buildRunContextBlock({
      platform,
      channelId,
      platformMetadata,
      agentId,
      conversationId,
      // The gateway's configured PUBLIC origin, not DISPATCHER_URL: the worker
      // reaches the gateway over an internal cluster address, so deriving the
      // link origin from it would hand the agent a host no user can open.
      webOrigin: context.webOrigin,
    });

    const transientTurnContext = [
      configNotice,
      ephemeralContext,
      prependContexts,
      runContext,
    ]
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n\n");
    // Token forecasting must account for the provider's complete view even
    // though only userPrompt is durable in the transcript.
    const modelPromptText = transientTurnContext
      ? `${transientTurnContext}\n\n${userPrompt}`
      : userPrompt;

    // Load image attachments for vision-capable models
    const images = await loadImageAttachments();
    if (images.length > 0) {
      logger.info(`Including ${images.length} image(s) in prompt for vision`);
    }

    await maybeRunPreCompactionMemoryFlush({
      session,
      sessionManager,
      settingsManager,
      memoryFlushConfig,
      incomingPromptText: modelPromptText,
      incomingImageCount: images.length,
      runSilentPrompt: async (prompt) => {
        await runPromptTurn(prompt, { silent: true });
      },
    });

    await runPromptTurn(userPrompt, {
      images,
      transientContext: transientTurnContext,
    });

    const sessionError = progressProcessor.consumeFatalErrorMessage();
    if (sessionError) {
      await emitAgentEnd(sessionError);
      // Return the RAW provider error. It's the user-facing body verbatim; the
      // only downstream work is `classifyError` → a code that selects the CTA
      // link (via AGENT_ERRORS). No sentence is rewritten here.
      return buildResult(sessionError);
    }

    await emitAgentEnd();

    // Hand the fully-streamed assistant output to the progress processor so
    // the success path's checkSandboxLeak() (worker.execute) actually runs
    // against user-facing text. Without this, getFinalResult() is always
    // null in production and the sandbox-leak redaction never fires.
    progressProcessor.setFinalResult({
      text: progressProcessor.getOutputSnapshot(),
      isFinal: true,
    });

    return buildResult();
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await emitAgentEnd(errorMsg);
    // Raw error out; downstream `classifyError` picks the code (→ CTA) and the
    // raw message is the body verbatim (see the sessionError branch above).
    return buildResult(errorMsg);
  } finally {
    onSteerReady(null);
    onCancelReady(null);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      logger.debug("Heartbeat timer cleared");
    }
    if (deltaTimer) {
      clearTimeout(deltaTimer);
      deltaTimer = null;
      logger.debug("Delta batch timer cleared");
    }
    if (session) {
      session.dispose();
      session = null;
    }
  }
}
