/**
 * A pi resource loader that reads nothing from disk.
 *
 * pi's `DefaultResourceLoader` auto-discovers extensions, prompt templates,
 * skills, themes, context files and SYSTEM.md from `cwd` and `agentDir`, all
 * enabled by default. Those are the right defaults for a developer running pi
 * in their own repo. They are the wrong defaults for us: our `cwd` is the
 * agent's workspace — written to by the agent's own `write`/`bash` tools, and
 * kept across runs for the pod's lifetime (nothing removes it; the workspaces
 * volume is pod-local, not a PVC) — so each of those paths is agent-controlled
 * input to the NEXT run:
 *
 * - `<cwd>/.pi/extensions/*.{ts,js}` are `jiti.import`ed and EXECUTED inside the
 *   worker process, bypassing the bash command policy and the `buildAgentEnv`
 *   environment allowlist entirely.
 * - `<cwd>/.pi/prompts/*.md` replace a user message beginning with `/<name>`.
 * - `<cwd>/.pi/SYSTEM.md` replaces the whole system prompt; `APPEND_SYSTEM.md`
 *   appends to it.
 * - `<cwd>/.pi/skills`, the ancestor `.agents/skills` walk (shared by every
 *   conversation under one workspace root), and `AGENTS.md`/`CLAUDE.md` all
 *   feed the prompt.
 *
 * `DefaultResourceLoader`'s suppression options would leave the property
 * resting on several flags and overrides, and they only discard results AFTER
 * `reload()` has already walked the tree via the package manager. That walk
 * recurses into subdirectories and follows symlinks (`collectSkillEntries`
 * stats the link target and recurses when it is a directory), so the agent
 * still gets to decide how much work every later boot of the conversation does.
 * (A symlink cycle does not hang: the recursion overflows the stack and
 * `collectSkillEntries`'s own catch-all swallows it. Measured, not assumed.)
 *
 * So this implements pi's `ResourceLoader` interface with no filesystem access
 * at all. Everything Lobu wants the agent to have — skills, platform/network
 * instructions, MCP servers — arrives from the gateway as session context, so
 * there is nothing legitimate to discover here.
 *
 * The coupling to pi is the exported `ResourceLoader` interface: if a future pi
 * adds a method, this fails at compile time rather than silently reopening a
 * discovery path.
 *
 * Being the only thing pi loads makes this also the place Lobu's own system
 * prompt is installed — as the loader's system prompt and as a synthetic
 * `before_agent_start` extension. See `createSystemPromptExtension` for why the
 * extension, not the loader, is the seam that actually survives.
 */
import {
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
  type ContextEvent,
  createExtensionRuntime,
  createSyntheticSourceInfo,
  type Extension,
  type ExtensionHandler,
  type LoadExtensionsResult,
  type ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import type { BuildSystemPromptOptions } from "@mariozechner/pi-coding-agent";

type LobuSystemPromptRenderer = (context?: BuildSystemPromptOptions) => string;

/** Identifies our synthetic extension in pi's diagnostics and error reports. */
const SYSTEM_PROMPT_EXTENSION_PATH = "<lobu:system-prompt>";
const TRANSIENT_TURN_CONTEXT_EXTENSION_PATH = "<lobu:transient-turn-context>";

/**
 * The extension that installs Lobu's system prompt on every turn.
 *
 * This is not decoration over the loader's `getSystemPrompt()` — it is the only
 * seam that survives. `AgentSession.prompt()` reassigns
 * `agent.state.systemPrompt` on EVERY call: to whatever a `before_agent_start`
 * handler returns, or, when no handler returns one, back to the base prompt.
 * A system prompt assigned once after session construction is therefore
 * discarded before the first request ever reaches the model.
 *
 * Constructed by hand rather than loaded from disk: pi's loader `jiti.import`s
 * extension files, and the only directory it would read is the agent's own
 * writable workspace.
 */
function createSystemPromptExtension(
  renderSystemPrompt: LobuSystemPromptRenderer
): Extension {
  const handler: ExtensionHandler<
    BeforeAgentStartEvent,
    BeforeAgentStartEventResult
  > = (event) => ({
    // `systemPromptOptions` carries pi's live tool snippets and per-tool
    // guidelines, so the rendered document describes the tools this agent
    // actually has without reading pi's assembled string back out.
    systemPrompt: renderSystemPrompt(event.systemPromptOptions),
  });

  return {
    path: SYSTEM_PROMPT_EXTENSION_PATH,
    resolvedPath: SYSTEM_PROMPT_EXTENSION_PATH,
    sourceInfo: createSyntheticSourceInfo(SYSTEM_PROMPT_EXTENSION_PATH, {
      source: "lobu",
    }),
    handlers: new Map([["before_agent_start", [handler as never]]]),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

/**
 * Inject Lobu's per-run context into the provider view without changing the
 * AgentSession messages that Pi persists.
 *
 * Pi emits `context` before every LLM request (including later tool-loop
 * iterations) with a deep copy of the session messages. Prefixing the latest
 * user message in that copy gives the model the same ordering it had when the
 * worker concatenated the strings, while leaving persisted user entries in
 * session.jsonl and transcript snapshots equal to what the user authored.
 */
function createTransientTurnContextExtension(
  getTransientTurnContext: () => string | undefined
): Extension {
  const handler: ExtensionHandler<
    ContextEvent,
    { messages?: ContextEvent["messages"] }
  > = (event) => {
    const transientContext = getTransientTurnContext()?.trim();
    if (!transientContext) return;

    let latestUserIndex = -1;
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      if (event.messages[index]?.role === "user") {
        latestUserIndex = index;
        break;
      }
    }
    if (latestUserIndex < 0) return;

    const userMessage = event.messages[latestUserIndex];
    if (!userMessage || userMessage.role !== "user") return;

    const content =
      typeof userMessage.content === "string"
        ? `${transientContext}\n\n${userMessage.content}`
        : [
            { type: "text" as const, text: `${transientContext}\n\n` },
            ...userMessage.content,
          ];
    const messages = [...event.messages];
    messages[latestUserIndex] = { ...userMessage, content };
    return { messages };
  };

  return {
    path: TRANSIENT_TURN_CONTEXT_EXTENSION_PATH,
    resolvedPath: TRANSIENT_TURN_CONTEXT_EXTENSION_PATH,
    sourceInfo: createSyntheticSourceInfo(
      TRANSIENT_TURN_CONTEXT_EXTENSION_PATH,
      { source: "lobu" }
    ),
    handlers: new Map([["context", [handler as never]]]),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

export function createLobuResourceLoader(
  renderSystemPrompt?: LobuSystemPromptRenderer,
  getTransientTurnContext?: () => string | undefined
): ResourceLoader {
  // Built once, not per call: `AgentSession._buildRuntime` reads this result and
  // writes extension flag values onto `runtime`, which a fresh object per call
  // would silently discard.
  const loadedExtensions: Extension[] = [];
  if (renderSystemPrompt) {
    loadedExtensions.push(createSystemPromptExtension(renderSystemPrompt));
  }
  if (getTransientTurnContext) {
    loadedExtensions.push(
      createTransientTurnContextExtension(getTransientTurnContext)
    );
  }
  const extensions: LoadExtensionsResult = {
    extensions: loadedExtensions,
    errors: [],
    runtime: createExtensionRuntime(),
  };

  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    // Pi treats this as `customPrompt`: supplying it replaces the whole default
    // prompt — harness opener, pi documentation paths and all — instead of
    // leaving Lobu text to compete with them. This is also the fallback the
    // per-turn reset lands on if the handler above ever throws, so a broken
    // extension degrades to a Lobu prompt without the tools section rather than
    // to pi's coding-harness prompt.
    getSystemPrompt: () => renderSystemPrompt?.(),
    getAppendSystemPrompt: () => [],
    extendResources: () => {
      // pi calls this when an extension's `resources_discover` hook returns
      // paths. With no extensions loaded it never fires; ignoring the paths
      // keeps the "nothing is read from disk" property even if one is added.
    },
    reload: async () => {
      // Nothing to re-read: every getter above is a constant.
    },
  };
}
