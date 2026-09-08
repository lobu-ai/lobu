import { Agent, type AgentTool } from '@mariozechner/pi-agent-core';
import { registerApiProvider, streamSimple, type Api, type Model } from '@mariozechner/pi-ai';
import { streamAnthropic } from '@mariozechner/pi-ai/anthropic';
import { streamOpenAICompletions } from '@mariozechner/pi-ai/openai-completions';
import { streamOpenAIResponses } from '@mariozechner/pi-ai/openai-responses';
import { AgentSession, SessionManager, SettingsManager, convertToLlm, CURRENT_SESSION_VERSION, type ModelRegistry } from '@mariozechner/pi-coding-agent';
import { createLobuResourceLoader } from '@lobu/plugin-toolkit/pi-resources';
import { SESSION_PATH, withSessionSnapshot } from './pi-session-fs.js';
import type { AgentTurnInput } from './types.js';

/** Pi owns session state and lifecycle; Lobu supplies only admitted host capabilities. */
export function createNativeSession(
  input: AgentTurnInput,
  tools: AgentTool[],
  getTransientContext: () => string | undefined
): AgentSession {
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
    reasoning: false,
    input: input.provider.input ?? ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.compaction?.contextWindow ?? 200_000,
    maxTokens: input.provider.maxTokens ?? 8192,
  };
  // One registration per wire protocol. `openai-responses` is NOT a fallback
  // for completions: official OpenAI is promoted to Responses so reasoning
  // models can use tools, and the two speak different request shapes.
  if (input.provider.api === 'anthropic-messages') {
    registerApiProvider({ api: 'anthropic-messages', stream: streamAnthropic, streamSimple: streamAnthropic });
  } else if (input.provider.api === 'openai-responses') {
    registerApiProvider({ api: 'openai-responses', stream: streamOpenAIResponses, streamSimple: streamOpenAIResponses });
  } else {
    registerApiProvider({ api: 'openai-completions', stream: streamOpenAICompletions, streamSimple: streamOpenAICompletions });
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
    initialState: { model, messages: context.messages, thinkingLevel: 'off' },
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
    if (event.type === 'agent_end') ended++;
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
  }
}

export function nativeSessionJsonl(session: AgentSession): string {
  return [session.sessionManager.getHeader(), ...session.sessionManager.getEntries()]
    .map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}
