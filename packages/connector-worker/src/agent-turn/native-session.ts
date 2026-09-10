import { Agent, type AgentTool, type ThinkingLevel } from '@mariozechner/pi-agent-core';
import { registerApiProvider, streamSimple, type Api, type Model } from '@mariozechner/pi-ai';
import { streamAnthropic, streamSimpleAnthropic } from '@mariozechner/pi-ai/anthropic';
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from '@mariozechner/pi-ai/openai-completions';
import { streamOpenAICodexResponses, streamSimpleOpenAICodexResponses } from '@mariozechner/pi-ai/openai-codex-responses';
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from '@mariozechner/pi-ai/openai-responses';
import { AgentSession, SessionManager, SettingsManager, convertToLlm, CURRENT_SESSION_VERSION, type ModelRegistry } from '@mariozechner/pi-coding-agent';
import { createLobuResourceLoader, type TransientTurnContextLookup } from '@lobu/plugin-toolkit/pi-resources';
import { SESSION_PATH, withSessionSnapshot } from './pi-session-fs.js';
import type { AgentTurnInput } from './types.js';

/** Pi owns session state and lifecycle; Lobu supplies only admitted host capabilities. */
export function createNativeSession(
  input: AgentTurnInput,
  tools: AgentTool[],
  getTransientContext: TransientTurnContextLookup
): AgentSession {
  // Exhaustive over Pi's `ThinkingLevel`, so a level added or renamed upstream
  // fails the build here instead of silently 400ing at the provider.
  const levels: Record<ThinkingLevel, true> = {
    off: true, minimal: true, low: true, medium: true, high: true, xhigh: true,
  };
  const effort = input.effort?.trim() || 'off';
  if (!Object.hasOwn(levels, effort)) {
    throw new Error(`Unsupported cloud reasoning effort: ${effort}. Supported values: ${Object.keys(levels).join(', ')}.`);
  }
  // Rejecting is the honest answer: silently downgrading to 'off' would bill a
  // configured reasoning turn as a plain one with no signal that it happened.
  if (effort !== 'off' && input.provider.reasoning === false) {
    throw new Error(`Model ${input.provider.modelId} does not support reasoning effort.`);
  }
  const thinkingLevel = effort as ThinkingLevel;
  const manager = SessionManager.inMemory('/workspace');
  if (input.sessionJsonl) {
    // Pi's file reader tolerates malformed lines for crash recovery. A gateway
    // checkpoint must be intact: never silently start over with partial history.
    // An older session version is fine: Pi migrates it in memory on load.
    const entries = input.sessionJsonl.trim().split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    if (entries[0]?.type !== 'session' || !Number.isInteger(entries[0].version) || entries[0].version < 1 || entries[0].version > CURRENT_SESSION_VERSION) {
      throw new Error('Invalid native Pi session snapshot');
    }
    withSessionSnapshot(input.sessionJsonl, () => manager.setSessionFile(SESSION_PATH));
  }
  const settings = SettingsManager.inMemory({ compaction: input.compaction ?? { enabled: false } });
  const model: Model<Api> = {
    id: input.provider.modelId,
    name: input.provider.modelId,
    api: input.provider.api,
    provider: input.provider.provider,
    baseUrl: input.provider.baseUrl,
    // Upstream capabilities the gateway resolved for us. pi-ai would otherwise
    // auto-detect them from `baseUrl`, which on this lane is always the secret
    // proxy, so it can never see which provider it is really talking to. Set
    // on the one model object both `Agent` and `AgentSession.compact` use.
    ...(input.provider.compat ? { compat: input.provider.compat } : {}),
    // Registry facts, carried on the envelope because the guest has no
    // registry to ask. Hardcoding them here made the model lie about itself:
    // `claude-sonnet-4` reports `reasoning:true, maxTokens:64000` upstream and
    // was described to the adapter as `false`/8192, capping every long answer
    // on this lane at an eighth of what the model allows.
    // For a model absent from the registry, an explicit effort is the user's
    // request to try reasoning; known non-reasoning models are rejected above.
    reasoning: input.provider.reasoning ?? (thinkingLevel !== 'off'),
    input: input.provider.input ?? ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.compaction?.contextWindow ?? 200_000,
    // Required by `Model`, and the adapter divides it: it asks the provider for
    // `options.maxTokens || (model.maxTokens / 3)`, so a zero or missing value
    // becomes a `max_tokens: 0` request rather than a sensible default. The
    // registry's own number when there is one; otherwise the legacy 8192,
    // which is the value this lane has always shipped for unknown models.
    maxTokens: input.provider.maxTokens ?? 8192,
  };
  // One registration per wire protocol. `openai-responses` is NOT a fallback
  // for completions: official OpenAI is promoted to Responses so reasoning
  // models can use tools, and the two speak different request shapes.
  //
  // `streamSimple` is the variant that reads `options.reasoning`, so it — not
  // the plain `stream` fn, which takes the narrower `StreamOptions` — is what
  // turns `thinkingLevel` into the provider's own effort field. Registering
  // `stream` for both slots typechecks (a wider parameter is assignable) and
  // silently drops every configured effort, so each slot takes its own fn.
  if (input.provider.api === 'anthropic-messages') {
    registerApiProvider({ api: 'anthropic-messages', stream: streamAnthropic, streamSimple: streamSimpleAnthropic });
  } else if (input.provider.api === 'openai-codex-responses') {
    // pi-ai extracts an account id before invoking fetch. This inert JWT is
    // only adapter input: the isolate host replaces Authorization with the
    // signed turn token, and the gateway derives the real account from OAuth.
    // `transport` is pinned, not preferred: the adapter's default ("auto")
    // dials the upstream over a WebSocket, which the guest has no constructor
    // for, and each failed dial appends a `provider_transport_failure`
    // diagnostic to the assistant message before it falls back to SSE.
    const placeholder = `e30.${btoa(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'lobu-proxy' } }))}.placeholder`;
    const stream: typeof streamOpenAICodexResponses = (model, context, options) =>
      streamOpenAICodexResponses(model, context, { ...options, apiKey: placeholder, transport: 'sse' });
    const simple: typeof streamSimpleOpenAICodexResponses = (model, context, options) =>
      streamSimpleOpenAICodexResponses(model, context, { ...options, apiKey: placeholder, transport: 'sse' });
    registerApiProvider({ api: 'openai-codex-responses', stream, streamSimple: simple });
  } else if (input.provider.api === 'openai-responses') {
    registerApiProvider({ api: 'openai-responses', stream: streamOpenAIResponses, streamSimple: streamSimpleOpenAIResponses });
  } else {
    registerApiProvider({ api: 'openai-completions', stream: streamOpenAICompletions, streamSimple: streamSimpleOpenAICompletions });
  }
  const context = manager.buildSessionContext();
  if (context.model?.provider !== model.provider || context.model?.modelId !== model.id) {
    manager.appendModelChange(model.provider, model.id);
  }
  const matches = (candidate: Model<Api>) => candidate.provider === model.provider && candidate.id === model.id;
  // The gateway has already resolved the catalog and auth. This registry port
  // authorizes exactly that model, with the per-turn placeholder; it never
  // opens Pi's disk-backed model/auth registry or discovers ambient credentials.
  const registry = {
    hasConfiguredAuth: matches,
    getApiKeyAndHeaders: async (candidate: Model<Api>) => matches(candidate)
      ? { ok: true as const, apiKey: input.provider.apiKey }
      : { ok: false as const, error: 'Model was not admitted for this turn' },
    isUsingOAuth: () => false,
    find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
  } as unknown as ModelRegistry;
  let session: AgentSession;
  const agent = new Agent({
    initialState: { model, messages: context.messages, thinkingLevel },
    // Keep native custom/summary conversion. Pi stores an empty text block for
    // image-only prompts; omit it only on the wire, where OpenAI rejects it.
    convertToLlm: (messages) => convertToLlm(messages).map((message) =>
      message.role === 'user' && Array.isArray(message.content)
        ? { ...message, content: message.content.filter((part) => part.type !== 'text' || part.text.trim().length > 0) }
        : message
    ),
    transformContext: (messages) => session.extensionRunner.emitContext(messages),
    streamFn: (selected, context, options) => streamSimple(selected, context, {
      ...settings.getProviderRetrySettings(), ...options, apiKey: input.provider.apiKey,
    }),
    sessionId: manager.getSessionId(),
    steeringMode: settings.getSteeringMode(),
    followUpMode: settings.getFollowUpMode(),
    transport: settings.getTransport(),
    maxRetryDelayMs: settings.getProviderRetrySettings().maxRetryDelayMs,
  });
  session = new AgentSession({
    agent, sessionManager: manager, settingsManager: settings, cwd: '/workspace',
    modelRegistry: registry,
    resourceLoader: createLobuResourceLoader(() => input.systemPrompt, getTransientContext),
    baseToolsOverride: Object.fromEntries(tools.map((tool) => [tool.name, tool])),
    initialActiveToolNames: tools.map((tool) => tool.name),
  });
  return session;
}

/**
 * AgentSession processes Agent events asynchronously and can schedule a new
 * run after compaction. Observe its public lifecycle before disposing the
 * isolate; Agent.prompt()/waitForIdle() alone end before that work is done.
 * Retry and compaction decisions remain entirely inside the original Pi code.
 */
export async function promptNativeSession(
  session: AgentSession,
  text: string,
  images?: AgentTurnInput['images']
): Promise<void> {
  let started = 0;
  let ended = 0;
  let promptSettled = false;
  let continuationPending = false;
  let checking = false;
  let finished = false;
  const autoCompactionEnabled = session.autoCompactionEnabled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const schedule = () => {
    if (finished || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; void check().catch(reject); }, 0);
  };
  const check = async () => {
    if (checking || !promptSettled) return;
    checking = true;
    try {
      await session.agent.waitForIdle();
      if (started !== ended || session.isCompacting || session.isRetrying || continuationPending) return;
      if (session.agent.hasQueuedMessages()) {
        await session.agent.continue();
        schedule();
        return;
      }
      finished = true;
      resolve();
    } finally { checking = false; }
  };
  const unsubscribeAgent = session.agent.subscribe((event) => {
    if (event.type === 'agent_start') { started++; continuationPending = false; }
  });
  const unsubscribeSession = session.subscribe((event) => {
    if (event.type === 'agent_end') {
      ended++;
      const lastAssistant = event.messages.slice().reverse().find(message => message.role === 'assistant');
      if (lastAssistant?.stopReason === 'stop' && !session.agent.hasQueuedMessages()) {
        // Pi checks the same threshold before the next prompt. Persist this
        // completed answer now instead of spending the isolate's remaining
        // execution budget summarizing a conversation that may never resume.
        // Errors keep compaction enabled so native overflow recovery can
        // retry, and so does a queued round: `check` below still continues it
        // in THIS turn, and it has to fit the window like any other.
        session.setAutoCompactionEnabled(false);
      }
    }
    if (event.type === 'compaction_end') {
      continuationPending = event.willRetry || (!!event.result && session.agent.hasQueuedMessages());
    }
    if (event.type === 'agent_end' || event.type === 'compaction_end' || event.type === 'auto_retry_end') schedule();
  });
  try {
    await session.prompt(text, { images: images?.map((image) => ({ type: 'image' as const, ...image })) });
    promptSettled = true;
    schedule();
    await done;
  } finally {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    unsubscribeAgent();
    unsubscribeSession();
    // A session takes more than one prompt — the memory flush runs its own —
    // so hand the compaction setting back exactly as it was found.
    session.setAutoCompactionEnabled(autoCompactionEnabled);
  }
}

export function nativeSessionJsonl(session: AgentSession): string {
  return [session.sessionManager.getHeader(), ...session.sessionManager.getEntries()]
    .map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}
