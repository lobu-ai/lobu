/**
 * Producer for the agent-turn isolate lane.
 *
 * A message's turn becomes one `agent_turn` row that the connector-worker
 * fleet claims and runs inside a V8 isolate, with Pi's own session, tools and
 * memory. This is the only execution path: nothing spawns a managed
 * subprocess for a message any more, and the answer this run produces IS the
 * conversation's reply, delivered by `/api/workers/complete-agent-turn`.
 *
 * Because nothing else can answer, the two ways this can fail both surface:
 *
 *  - A misconfiguration the producer can NAME (no resolved model, no provider
 *    that owns it, no provider that routes on this lane, no public gateway
 *    URL) is RETURNED as an `AgentErrorCode`. The caller discharges the
 *    turn-liveness marker it armed with that reason, so the user reads the
 *    real cause and its remediation instead of waiting out the deadline for a
 *    generic "worker unresponsive".
 *  - Anything unexpected THROWS, so the queue's own retry/fail handling sees
 *    it rather than a message disappearing without a reply.
 *
 * A message owed no reply at all — an explicit cancel, or one carrying
 * neither text nor a resolvable attachment — returns `undefined` silently.
 *
 * `agent_turn` is deliberately outside `LOBU_RUN_TYPES`, so `RunsQueue` never
 * claims or completes these rows; the fleet's poll/heartbeat/complete routes
 * own their whole lifecycle.
 */

import {
  AgentErrorCode,
  type AgentErrorContext,
  type AgentOptions,
  buildToolPolicy,
  createLogger,
  enforceBashCommandPolicy,
  generateWorkerToken,
  getErrorMessage,
  isExplicitCancelMessage,
  isToolAllowedByPolicy,
  type MessagePayload,
  resolveMemoryFlushConfig,
  renderAlwaysOnToolPolicyRulesFor,
  renderBaselineAgentPolicy,
  resolveSdkCompat,
  type ToolPolicy,
  type ToolsConfig,
  verifyWorkerToken,
} from "@lobu/core";
import type { AgentTurnPollPayload } from "@lobu/core/contracts/worker/protocol";
import { getModel, type Model } from "@mariozechner/pi-ai";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import { getDb } from "../../db/client.js";
import { insertAgentTurnResponse, lockAgentTurnConversation, lockAgentTurnRun, releaseNextAgentTurn } from "../../runs/agent-turn-inputs.js";
import { resolveAutomationRunSkills } from "../automation-run-session.js";
import { parseAutomationRunConversationId } from "../permissions/automation-run-intent.js";
import type { AgentRuntimeSelection } from "../../lobu/stores/sandbox-store.js";
import type { McpConfigService } from "../auth/mcp/config-service.js";
import type { McpProxy } from "../auth/mcp/proxy.js";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import type { ProviderCatalogService } from "../auth/provider-catalog.js";
import type { ModelProviderModule } from "../modules/module-system.js";
import {
  type AgentTurnArtifactReader,
  resolveTurnAttachments,
} from "./agent-turn-attachments.js";
import { notifyThreadResponse } from "./turn-liveness.js";
import { buildWorkerTokenClaims } from "./worker-token-claims.js";

const logger = createLogger("agent-turn-producer");


/**
 * pi-ai's fetch-native adapters. Every other protocol in
 * `SDK_COMPAT_PROTOCOLS` reaches its upstream through a Node-bound SDK, which
 * cannot be bundled for the isolate — so those agents produce no turn.
 *
 * `openai-responses` belongs here for the same reason `openai-completions`
 * does: pi-ai implements both on the `openai` package with no Node bindings.
 * It is NOT interchangeable with completions — `provider-catalog.ts` promotes
 * the official OpenAI provider to Responses so current reasoning models can
 * use tools, so omitting it here left every official-OpenAI agent unable to
 * run at all.
 *
 * Typed as the envelope's own `api` union so the set and the wire contract
 * cannot drift: adding an adapter here without widening the schema is a
 * compile error, not a run that fails validation on the worker.
 */
type LaneApi = TurnEnvelope["provider"]["api"];
const LANE_APIS = new Set<string>([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
] satisfies LaneApi[]);

const TURN_MESSAGE_CHARS = 32_000;

/**
 * Skill bounds, restating the worker contract's own caps so an oversized
 * library is bounded here rather than failing schema validation at the poll.
 * A skill over the bound is dropped whole; see the producer below for why.
 * Kept as numbers because this module works in the envelope's TYPES, not its
 * runtime schema object.
 */
const TURN_SKILLS_MAX = 64;
const TURN_SKILL_CHARS = 64_000;
const TURN_SKILL_NAME_CHARS = 128;
const compactionDefaults = SettingsManager.inMemory().getCompactionSettings();

/**
 * Why a turn could not be produced, when the reason is a MISCONFIGURATION
 * rather than "nothing to send".
 *
 * This lane is the only execution path, and `handleMessage` arms the
 * turn-liveness marker BEFORE enqueueing, so a bare `return` here leaves the
 * client waiting out `TURN_DEFAULT_DEADLINE_MS` for a generic
 * `WORKER_UNRESPONSIVE`. That names the wrong cause and offers no fix. The
 * producer therefore reports the reason and the caller — which owns the marker
 * it armed — discharges it into a terminal error carrying that reason's own
 * remediation CTA.
 *
 * `undefined` means no turn is owed a reply at all (an explicit cancel, or a
 * message carrying neither text nor a resolvable attachment).
 */
export type TurnUnrunnable = AgentErrorCode;

/**
 * Where an agent turn's reply is delivered. This rides `action_input` beside
 * the guest's envelope rather than inside it: delivery is the host's business,
 * and the poll route lifts only `turn` and `credential` out, so these fields
 * never cross into the isolate. `completeAgentTurnRun` is the only reader.
 *
 * `team_id` is optional for the same reason `MessagePayload.teamId` is: Slack
 * carries the workspace id in `platform_metadata` instead.
 */
export interface TurnReply {
  message_id: string;
  channel_id: string;
  user_id: string;
  team_id?: string;
  platform: string;
  platform_metadata?: Record<string, unknown>;
  /** Non-secret provider/model identifiers used to target an error CTA. */
  error_context: AgentErrorContext;
}

type TurnEnvelope = AgentTurnPollPayload["turn"];
type TurnTools = NonNullable<TurnEnvelope["tools"]>;
type BuiltinTool = NonNullable<TurnTools["builtin"]>[number];

/**
 * The gateway tools the isolate lane carries, in the order the model is
 * offered them.
 *
 * This is `@lobu/plugin-conversations`' own tool set. It is named here rather
 * than imported so the producer states exactly which tools it will hand a turn
 * — the guest selects by name out of the package, so a name added there does
 * not silently reach an agent until it is added here too.
 *
 * `lobu-media`'s tools are named separately in `MEDIA_TOOLS` below, and
 * `lobu-memory` publishes no tools at all — its recall and capture are hooks,
 * carried on the envelope's `memory` field rather than in any tool list.
 */
const GATEWAY_TOOLS = [
  "list_conversations",
  "read_conversation",
  "send_message",
  "present_event",
  "schedule_followup",
  "react",
  "edit_message",
  "delete_message",
  "ask_user",
  "suggest_actions",
] as const;

/**
 * The workspace tools the guest can run, in the order the model is offered
 * them. Each is implemented inside the isolate over the turn's in-memory
 * filesystem (`grep` searches it
 * directly rather than spawning ripgrep, which an isolate cannot do).
 */
const WORKSPACE_TOOLS: readonly BuiltinTool[] = ["bash", "read", "write", "edit", "grep", "ls", "find"];

/**
 * The media tools the isolate lane carries — `@lobu/plugin-media`'s own.
 *
 * Named here rather than imported for the same reason as `GATEWAY_TOOLS`: the
 * producer states exactly which tools it will hand a turn, so a tool added to
 * the package does not silently reach an agent.
 *
 * `upload_file` is listed unconditionally and filtered by the POLICY like the
 * rest; whether the turn actually gets it also depends on it having a
 * workspace to read from, which the guest decides — there is no filesystem on
 * this lane other than the turn's own in-memory one.
 */
const MEDIA_TOOLS = ["upload_file", "generate_image", "generate_audio"] as const;

/**
 * The MCP server `@lobu/plugin-memory`'s two hooks call. Lobu's own server,
 * which every agent on this lane already reaches — the hooks are not a second
 * integration, they are two more calls on the route the turn already uses.
 */
const MEMORY_MCP_ID = "lobu";

export interface AgentTurnDeps {
  /** Reads the agent's identity/soul/user layers. Absent → no turn. */
  agentSettings?: AgentSettingsStore;
  /** Resolves the agent's provider modules. Absent → no turn. */
  catalog?: ProviderCatalogService;
  /**
   * The gateway's MCP surface: which servers this agent has, and their tools.
   * Absent → the turn runs with no tools (logged once per turn).
   */
  mcp?: {
    configService: McpConfigService;
    proxy: McpProxy;
  };
  /**
   * Externally reachable gateway URL, MOUNT PATH INCLUDED, that the fleet
   * worker resolves the secret proxy and the MCP route on. Injected rather
   * than read here so the caller owns the lookup: the canonical accessor
   * memoizes `PUBLIC_GATEWAY_URL` for the life of the process, which a caller
   * under test cannot vary without reaching into that cache. Absent → no
   * turn, because there is no URL to hand the worker.
   */
  gatewayUrl?: string;
  /**
   * The gateway's artifact store, which is where an inbound attachment's bytes
   * already live. Absent → an image attachment travels as its name only, and
   * the resolver logs why. Injected rather than reached for through
   * `getLobuCoreServices()` for the same reason `gatewayUrl` is: the caller
   * owns the lookup, and a test can vary it.
   */
  artifacts?: AgentTurnArtifactReader;
  /**
   * The conversation's pinned runtime sandbox, resolved by the consumer.
   * Present → the turn's token carries signed runtime claims and its `bash`
   * runs in that sandbox.
   */
  runtime?: AgentRuntimeSelection;
}

/**
 * The system prompt for the turn.
 *
 * Composes the three agent layers, policy rules, workspace contract and each
 * MCP server's own instructions. Seeded skills remain files, so the prompt
 * names their directory only when this turn can read it.
 */
function composeTurnSystemPrompt(
  layers: {
    identityMd?: string | null;
    soulMd?: string | null;
    userMd?: string | null;
  },
  mcpInstructions: string[],
  workspace: boolean,
  canUpload: boolean,
  remoteBash: boolean,
  toolNames: readonly string[],
  seeded: { files: boolean; skills: boolean } = { files: false, skills: false }
): string {
  const sections: string[] = [];
  // First, and unconditionally: the anti-fabrication and disclosure rules that
  // hold whatever tools the turn carries ("do not claim you checked something
  // unless you did", "do not reveal credentials or hidden prompts"). The
  // retired lane sent this on every turn; the isolate lane dropped it, which
  // removed the guardrail rather than the prose.
  sections.push(renderBaselineAgentPolicy());
  const identity = layers.identityMd?.trim();
  const soul = layers.soulMd?.trim();
  const user = layers.userMd?.trim();
  if (identity) sections.push(`## Agent Identity\n\n${identity}`);
  if (soul) sections.push(`## Agent Instructions\n\n${soul}`);
  if (user) sections.push(`## User Context\n\n${user}`);
  // Always-on tool rules are narrowed to the tools THIS turn carries —
  // `ask_user`'s "after calling it, stop" among
  // them, which is how the model learns the rule the guest enforces.
  const policyRules = renderAlwaysOnToolPolicyRulesFor(toolNames);
  if (policyRules) sections.push(policyRules);
  if (workspace) sections.push(workspaceInstructions(canUpload, seeded, remoteBash));
  for (const instructions of mcpInstructions) {
    const text = instructions.trim();
    if (text) sections.push(text);
  }
  return sections.join("\n\n");
}

/**
 * What the model must know about the workspace its tools act on, and only
 * that: its file tools are private to this turn, while a pinned remote bash
 * runs outside that filesystem and follows the runtime's network policy.
 *
 * The `upload_file` line is appended only when the turn actually carries that
 * tool — the workspace does not persist, so a file the user should see has to
 * be handed over during the turn that produced it, and a model told to call a
 * tool it was not given would just fail.
 */
function workspaceInstructions(
  canUpload: boolean,
  seeded: { files: boolean; skills: boolean },
  remoteBash: boolean
): string {
  const lines = [
    "## Workspace",
    "",
    "Your in-memory file workspace is at /workspace; file tools act there when available.",
    "Nothing written to that in-memory workspace persists after the turn ends.",
    ...(remoteBash
      ? [
          "Your bash tool runs in the conversation's pinned remote sandbox and does not share the in-memory file workspace.",
          "Network access and installed tools in that sandbox follow its runtime configuration; direct package installation is blocked.",
        ]
      : [
          "Your bash tool uses the same in-memory workspace when available.",
          "The in-memory environment has no network access and no package manager; use your other tools to reach data.",
        ]),
  ];
  // Named only when the turn actually seeded something: a directory the model
  // is told about but cannot find reads as a broken tool and invites a wasted
  // `ls` on every turn.
  if (seeded.files) {
    lines.push(
      "This turn's file attachments are saved under /workspace/input; read them with your file tools."
    );
  }
  if (seeded.skills) {
    lines.push(
      "Your skills are files under /workspace/.skills, one SKILL.md each; read the relevant one before acting on a task it covers."
    );
  }
  if (canUpload) {
    lines.push(
      "Nothing in the workspace is visible to the user: to show them a file you produced, call upload_file before the turn ends."
    );
  }
  return lines.join("\n");
}

/** A safe final path segment for one seeded skill directory. */
function skillDirectoryName(name: string): string | null {
  const segment = name.trim().split('/').filter(Boolean).pop();
  if (!segment || segment === '.' || segment === '..' || segment.length > TURN_SKILL_NAME_CHARS) {
    return null;
  }
  return /^[a-zA-Z0-9._-]+$/.test(segment) ? segment : null;
}

/** Whether this tool manifest has a command that can open seeded files. */
function canReadSeededFiles(
  builtin: readonly BuiltinTool[],
  policy: ToolPolicy,
  remoteBash: boolean
): boolean {
  if (builtin.includes("read")) return true;
  if (!builtin.includes("bash") || remoteBash) return false;
  try {
    enforceBashCommandPolicy("cat input/attachment", policy.bashPolicy);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip the provider prefix Lobu stores model refs under, so the upstream sees
 * its own bare model id.
 *
 * Exactly one prefix comes off, and only the resolved provider's own — its Lobu
 * id (`claude`) or its upstream slug (`anthropic`). A foreign inner namespace
 * (OpenRouter's `anthropic/claude-sonnet-4`) is left intact, the same rule the
 * worker's `resolveModelRef` applies.
 */
function bareModelId(
  ref: string,
  providerId: string,
  upstreamSlug: string | undefined
): string {
  for (const prefix of [providerId, upstreamSlug]) {
    if (prefix && ref.startsWith(`${prefix}/`)) {
      return ref.slice(prefix.length + 1);
    }
  }
  return ref;
}

function isLaneApi(api: string): api is LaneApi {
  return LANE_APIS.has(api);
}

interface TurnProvider {
  api: LaneApi;
  provider: string;
  providerSlug: string;
  modelId: string;
  baseUrl: string;
  credential: string;
  host: string;
  /** pi-ai's `Model.input` for this model — which modalities it accepts. */
  input: ("text" | "image")[];
  /** pi-ai's `Model.contextWindow`, or the native turn default for an unknown model. */
  contextWindow: number;
  /** pi-ai's `Model.maxTokens`: the output ceiling this model actually allows. */
  maxTokens: number | null;
  /** pi-ai's `Model.reasoning`: whether the model supports extended thinking. */
  reasoning: boolean;
}

/**
 * Fallback when a model is not in pi-ai's registry: compaction still needs a
 * finite context window.
 */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * What pi-ai's own model registry says about this model: modalities, context
 * window, output ceiling and reasoning support, resolved ONCE.
 *
 * Every field here is read from the registry rather than guessed, because the
 * guest has no registry of its own — it builds its `Model` from this envelope,
 * so a field missing here becomes a hardcoded default there. That is how the
 * lane came to run every agent with `reasoning:false` and an 8192-token
 * ceiling while the registry said `true` and 64000: the envelope only carried
 * modalities and the window, so the rest defaulted.
 *
 * Unknown models keep the retired subprocess lane's rules: `["text","image"]`
 * (it built a dynamic entry declaring both), a finite default window, and no
 * output ceiling — the adapter's own default is a better answer than a number
 * invented here.
 */
function resolveModelMetadata(
  registryProvider: string,
  modelId: string
): Pick<TurnProvider, "input" | "contextWindow" | "maxTokens" | "reasoning"> {
  // `getModel` is typed over pi-ai's static registry and cannot take the
  // strings Lobu resolves at runtime without a cast; it answers undefined for
  // a model the registry does not carry.
  const model = getModel(registryProvider as never, modelId as never) as
    | Model<never>
    | undefined;
  const window = model?.contextWindow;
  return {
    // pi enforces this one: `transformMessages` replaces every image block
    // with a "model does not support images" placeholder when `"image"` is
    // missing, which is what a non-vision model must get.
    input: model?.input ? [...model.input] : ["text", "image"],
    contextWindow:
      typeof window === "number" && window > 0 ? window : DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      typeof model?.maxTokens === "number" && model.maxTokens > 0
        ? model.maxTokens
        : null,
    reasoning: model?.reasoning === true,
  };
}

/**
 * Mint the turn's one credential: a worker token scoped to this agent, user,
 * organization, conversation, run and optional runtime sandbox. The secret
 * proxy accepts it as the provider credential and binds it to the agent in the
 * URL; the MCP and runtime routes authenticate the same token.
 */
function mintTurnToken(data: MessagePayload, runId: number, runtime?: AgentRuntimeSelection): string {
  return generateWorkerToken(
    data.userId,
    data.conversationId,
    `agent-turn:${data.messageId}`,
    {
      ...buildWorkerTokenClaims({
        channelId: data.channelId,
        teamId: data.teamId,
        agentId: data.agentId,
        organizationId: data.organizationId,
        platform: data.platform,
        platformMetadata: data.platformMetadata,
        // The remote runtime reads all of these off the SIGNED token, never a
        // body: which sandbox, and the egress and package sets the org set.
        runtimeProviderId: runtime?.runtimeProviderId,
        sandboxId: runtime?.sandboxId,
        allowedDomains: data.networkConfig?.allowedDomains,
        deniedDomains: data.networkConfig?.deniedDomains,
        nixPackages: data.nixConfig?.packages,
      }),
      messageId: data.messageId,
      // No `executionMode`/`automationRunId` override here ON PURPOSE.
      // `buildWorkerTokenClaims` above already derives both from
      // `platformMetadata`, using the shared claims rule: only the
      // literal "capture" is honoured, it originates server-side from the run
      // row and never from a caller, and an ABSENT claim means LIVE.
      //
      // This lane used to pin `executionMode: "capture"`, which was right
      // while it produced a discardable copy that had to touch nothing in the
      // outside world. It is catastrophic now that the turn answers: `captureEffect`
      // returns `success: true` WITHOUT performing the effect, so the agent
      // would tell the user it sent the message and updated the record while
      // doing neither. Overriding the claims builder is what made that
      // possible, so the override is gone rather than re-derived here.
      runId,
    }
  );
}

/**
 * Resolve the provider from the agent's installed modules, the module that owns
 * the requested model, its agent-scoped secret-proxy URL and its credential.
 *
 * Returns null (with one log line) whenever the turn cannot run here, which
 * is a normal outcome, not a failure: an agent on Google or Bedrock, a provider
 * with no proxy route, a credential the gateway cannot placeholder.
 */
async function resolveTurnProvider(
  module: ModelProviderModule,
  args: {
    agentId: string;
    organizationId: string;
    userId: string;
    modelRef: string;
    gatewayUrl: string;
    workerToken: string;
  }
): Promise<TurnProvider | null> {
  const protocol = resolveSdkCompat(module.sdkCompat);
  if (!protocol || !isLaneApi(protocol.api)) {
    logger.info(
      { agentId: args.agentId, provider: module.providerId, api: protocol?.api ?? null },
      "Agent turn skipped: the provider's protocol has no fetch-native adapter on the isolate lane"
    );
    return null;
  }

  const context = {
    organizationId: args.organizationId,
    userId: args.userId,
    workerToken: args.workerToken,
  };
  const mappings = module.getProxyBaseUrlMappings(
    `${args.gatewayUrl}/api/proxy`,
    args.agentId,
    context
  );
  // Every module maps its base URL under one or more env-var names that all
  // carry the SAME URL (openai publishes a second alias). More than one
  // DISTINCT URL would mean the module routes by key, which this producer
  // cannot express in a single `base_url`.
  const routes = [...new Set(Object.values(mappings))];
  if (routes.length !== 1) {
    logger.info(
      { agentId: args.agentId, provider: module.providerId, routes: routes.length },
      "Agent turn skipped: the provider does not publish exactly one proxy base URL"
    );
    return null;
  }
  const baseUrl = routes[0];

  // Every hop must carry the same signed turn credential.
  const credential = module.buildCredentialPlaceholder
    ? await module.buildCredentialPlaceholder(args.agentId, context)
    : "lobu-proxy";
  if (credential !== args.workerToken) {
    logger.info(
      { agentId: args.agentId, provider: module.providerId },
      "Agent turn skipped: the provider does not accept the signed turn credential"
    );
    return null;
  }

  let host: string;
  try {
    const url = new URL(baseUrl);
    if (url.origin !== new URL(args.gatewayUrl).origin) {
      logger.info(
        { agentId: args.agentId, provider: module.providerId },
        "Agent turn skipped: the provider's proxy base URL leaves the gateway origin"
      );
      return null;
    }
    host = url.hostname;
  } catch {
    logger.warn(
      { agentId: args.agentId, provider: module.providerId },
      "Agent turn skipped: the provider's proxy base URL does not parse"
    );
    return null;
  }

  const modelId = bareModelId(
    args.modelRef,
    module.providerId,
    module.getUpstreamConfig?.()?.slug
  );
  return {
    api: protocol.api,
    provider: protocol.registryAlias,
    providerSlug: module.providerId,
    modelId,
    baseUrl,
    credential,
    host,
    ...resolveModelMetadata(protocol.registryAlias, modelId),
  };
}

/**
 * The agent's tool policy, built from `agentOptions.toolsConfig`,
 * `allowedTools` and `disallowedTools` through the shared policy builder.
 */
function turnToolPolicy(options: AgentOptions | undefined): ToolPolicy {
  return buildToolPolicy({
    toolsConfig: options?.toolsConfig as ToolsConfig | undefined,
    allowedTools: options?.allowedTools,
    disallowedTools: options?.disallowedTools,
  });
}

/**
 * The tools this turn may call: every tool of every MCP server the agent has,
 * filtered through the agent's tool policy. Discovery is per server and
 * best-effort: a server that fails to list contributes nothing and one log
 * line. Filtering can only withhold a tool; it never grants one the agent's
 * patterns deny.
 */
async function resolveTurnTools(
  mcp: NonNullable<AgentTurnDeps["mcp"]>,
  args: {
    agentId: string;
    organizationId: string;
    gatewayUrl: string;
    workerToken: string;
    policy: ToolPolicy;
  }
): Promise<{
  tools: TurnTools | undefined;
  instructions: string[];
  /** Whether the agent actually has the memory MCP server mounted. */
  hasMemoryServer: boolean;
}> {
  const tokenData = verifyWorkerToken(args.workerToken);
  if (!tokenData) throw new Error("the turn's own worker token does not verify");
  const servers = await mcp.configService.getMcpStatus(args.agentId, args.organizationId);
  const definitions: TurnTools["definitions"] = [];
  const instructions: string[] = [];
  const listed = await Promise.allSettled(
    servers.map(async (server) => ({
      mcpId: server.id,
      ...(await mcp.proxy.fetchToolsForMcp(server.id, args.agentId, tokenData, args.workerToken)),
    }))
  );
  for (const outcome of listed) {
    if (outcome.status === "rejected") {
      logger.warn(
        { agentId: args.agentId, err: getErrorMessage(outcome.reason) },
        "Agent turn: an MCP server did not list its tools; the turn runs without them"
      );
      continue;
    }
    const { mcpId, tools, instructions: serverInstructions } = outcome.value;
    if (serverInstructions) instructions.push(serverInstructions);
    for (const tool of tools) {
      const name = tool.name?.trim();
      if (!name || !isToolAllowedByPolicy(name, args.policy)) continue;
      definitions.push({
        mcp_id: mcpId,
        name,
        description: tool.description || `MCP tool from ${mcpId}`,
        input_schema: tool.inputSchema ?? { type: "object", properties: {} },
      });
    }
  }
  return {
    tools: definitions.length > 0 ? { gateway_url: args.gatewayUrl, definitions } : undefined,
    instructions,
    // Read off the SERVER list, not the tool list: the memory hooks call
    // `search_memory`/`save_memory` directly, and those two are routinely
    // filtered out of the model's own manifest by the tool policy without the
    // server being any less reachable.
    hasMemoryServer: servers.some((server) => server.id === MEMORY_MCP_ID),
  };
}

/** The admitted control owns its receipt; replay must not stop a later execution. */
export async function cancelAgentTurn(data: MessagePayload): Promise<boolean> {
  if (!data.agentId || !data.organizationId || !data.conversationId || !data.userId
    || !isExplicitCancelMessage(data)) return false;
  if (typeof data.runId !== "number" || !Number.isSafeInteger(data.runId) || data.runId <= 0) {
    throw new Error("Native cancellation requires the admitted message run ID");
  }
  const sql = getDb();
  // Bind the control to the current target before waiting. A completed owner
  // must not redirect this cancellation onto its successor.
  const [target] = await sql<{ id: number }>`
    SELECT id FROM runs WHERE organization_id = ${data.organizationId} AND run_type = 'agent_turn'
      AND status IN ('pending', 'claimed', 'running')
      AND action_input->'turn'->>'agent_id' = ${data.agentId}
      AND action_input->'turn'->>'conversation_id' = ${data.conversationId}
      AND action_input->'reply'->>'user_id' = ${data.userId}
      AND parent_run_id < ${data.runId}
    ORDER BY (status = 'pending'), id LIMIT 1
  `;
  const delivered = await sql.begin(async (tx) => {
    await lockAgentTurnConversation(tx, data.organizationId!, data.agentId!, data.conversationId);
    const [source] = await tx<{ run_metadata: { native_cancel_handled?: boolean } | null }>`
      SELECT run_metadata FROM runs WHERE id = ${data.runId!} AND organization_id = ${data.organizationId!}
        AND run_type = 'chat_message' AND queue_name = 'messages'
        AND action_input->>'messageId' = ${data.messageId} FOR UPDATE
    `;
    if (!source) throw new Error("Native cancellation has no matching admitted message");
    if (source.run_metadata?.native_cancel_handled) return false;
    await tx`UPDATE runs SET run_metadata = jsonb_set(COALESCE(run_metadata, '{}'::jsonb),
      '{native_cancel_handled}', 'true'::jsonb) WHERE id = ${data.runId!}`;
    if (!target) return false;
    const run = await lockAgentTurnRun(tx, Number(target.id), true);
    if (!run || !['pending', 'claimed', 'running'].includes(run.status)) return false;
    if (run.status === 'pending') {
      await tx`UPDATE runs SET status = 'cancelled', completed_at = now(), exit_reason = 'cancelled' WHERE id = ${run.id}`;
      await releaseNextAgentTurn(tx, run);
      return insertAgentTurnResponse(tx, run, { error: 'agent turn cancelled' });
    } else {
      await tx`UPDATE runs SET run_metadata = jsonb_set(COALESCE(run_metadata, '{}'::jsonb),
        '{cancel_requested_at}', COALESCE(run_metadata->'cancel_requested_at', to_jsonb(now()))) WHERE id = ${run.id}`;
    }
    return false;
  });
  if (delivered) await notifyThreadResponse();
  return true;
}

/**
 * Produce the `agent_turn` run for this message.
 *
 * Returns `undefined` when the turn was produced, or when nothing is owed a
 * reply. Returns an `AgentErrorCode` when the agent is misconfigured and
 * cannot run, so the caller can tell the user why. Throws on anything
 * unexpected — see the module header.
 */
export async function enqueueAgentTurn(
  data: MessagePayload,
  deps: AgentTurnDeps
): Promise<TurnUnrunnable | undefined> {
  try {
    // No turn is owed a reply: a cancel is a control message, and a payload
    // with no agent or no org is not a turn. These stay silent `undefined`.
    if (!data.agentId || isExplicitCancelMessage(data)) return;
    if (!data.organizationId) return;

    // The turn's attachments, resolved host-side out of the gateway's own
    // artifact store. Done BEFORE the empty-text check, because an
    // attachment-only message is a real turn once its images are resolved —
    // it is only unsendable when nothing at all came through.
    const attachments = await resolveTurnAttachments(
      data.platformMetadata,
      deps.artifacts,
      { agentId: data.agentId, messageId: data.messageId }
    );

    // Nothing to send: no text, no image the model can see, and no attachment
    // worth naming. Both providers reject an empty user turn, so this would
    // enqueue a run that can only fail.
    const messageText = data.messageText?.trim() ?? "";
    if (
      !messageText &&
      attachments.images.length === 0 &&
      attachments.files.length === 0
    ) {
      logger.info(
        { agentId: data.agentId, messageId: data.messageId },
        "Agent turn skipped: the message carries neither text nor a resolvable attachment for the turn to send"
      );
      return;
    }

    const modelRef = data.agentOptions?.model?.trim();
    if (!modelRef) {
      logger.error(
        { agentId: data.agentId, messageId: data.messageId },
        "Agent turn cannot run: no model is resolved for this agent"
      );
      return AgentErrorCode.NO_MODEL_CONFIGURED;
    }

    const catalog = deps.catalog;
    const agentSettings = deps.agentSettings;
    if (!catalog || !agentSettings) {
      logger.error(
        { agentId: data.agentId, messageId: data.messageId },
        "Agent turn cannot run: the provider catalog or the agent settings store is not wired"
      );
      return AgentErrorCode.NO_MODEL_CONFIGURED;
    }

    const gatewayUrl = deps.gatewayUrl;
    if (!gatewayUrl) {
      logger.error(
        { agentId: data.agentId, messageId: data.messageId },
        "Agent turn cannot run: PUBLIC_GATEWAY_URL is not configured, so there is no URL the fleet worker can reach the gateway on"
      );
      // Not a PROVIDER_* code: those four carry no `message` of their own
      // because they exist to relay the provider's text, and there is no
      // provider text here — `renderAgentError` would show the user an empty
      // string with a lone CTA button. This code owns prose and the
      // agent-settings CTA, which is the surface a reader can act on.
      return AgentErrorCode.NO_MODEL_CONFIGURED;
    }

    const modules = await catalog.getInstalledModules(
      data.agentId,
      data.organizationId
    );
    const module = await catalog.findProviderForModel(modelRef, modules);
    if (!module) {
      logger.error(
        { agentId: data.agentId, messageId: data.messageId, model: modelRef },
        "Agent turn cannot run: no installed provider owns this model"
      );
      // `PROVIDER_UNKNOWN_MODEL` looks apt but renders empty: it carries no
      // `message`, expecting the provider's own error text to fill it, and no
      // provider answered here. The agent's configured model is unusable, so
      // report the code that says exactly that and links to agent settings.
      return AgentErrorCode.NO_MODEL_CONFIGURED;
    }

    const sql = getDb();
    if (typeof data.runId !== "number" || !Number.isSafeInteger(data.runId) || data.runId <= 0) {
      throw new Error("Agent turn requires the admitted message run ID");
    }
    // Allocate identity without publishing a partially assembled pending job.
    const [allocated] = await sql<{ id: number }>`
      SELECT nextval(pg_get_serial_sequence('runs', 'id')) AS id
    `;
    const runId = allocated!.id;
    const workerToken = mintTurnToken(data, runId, deps.runtime);
    const provider = await resolveTurnProvider(module, {
      agentId: data.agentId,
      organizationId: data.organizationId,
      userId: data.userId,
      modelRef,
      gatewayUrl,
      workerToken,
    });
    if (!provider) {
      // Every `resolveTurnProvider` null is a provider/model
      // misconfiguration — an unsupported protocol, or a proxy base URL that
      // does not resolve to exactly one gateway-origin route. It logged the
      // specific cause; the user's fix is on the agent's model selection.
      logger.error(
        { agentId: data.agentId, messageId: data.messageId, model: modelRef },
        "Agent turn cannot run: this model's provider cannot be routed on the isolate lane"
      );
      return AgentErrorCode.NO_MODEL_CONFIGURED;
    }

    let tools: TurnTools | undefined;
    // Memory is off unless the agent actually has the server its hooks call.
    let hasMemoryServer = false;
    let mcpInstructions: string[] = [];
    const policy = turnToolPolicy(data.agentOptions);
    // `mcpExposure: "cli"` presents the agent's MCP servers as SHELL COMMANDS
    // instead of model tools — same capability, an interface some coding models
    // handle better than a tool manifest. This lane does not carry that surface
    // yet, so the agent gets the default `"tools"` exposure and the setting says
    // so out loud. Stated rather than ignored: an option that silently means
    // something else is worse than one that reports what it did.
    if ((data.agentOptions?.toolsConfig as ToolsConfig | undefined)?.mcpExposure === "cli") {
      logger.info(
        { agentId: data.agentId },
        "Agent turn: this agent exposes MCP as shell commands, which the isolate lane does not carry; the turn runs with MCP tools exposure instead"
      );
    }
    if (!deps.mcp) {
      logger.info(
        { agentId: data.agentId },
        "Agent turn: the MCP surface is not wired, so the turn runs without tools"
      );
    } else {
      const resolved = await resolveTurnTools(deps.mcp, {
        agentId: data.agentId,
        organizationId: data.organizationId,
        gatewayUrl,
        workerToken,
        policy,
      });
      tools = resolved.tools;
      mcpInstructions = resolved.instructions;
      hasMemoryServer = resolved.hasMemoryServer;
    }

    // The workspace tools the policy admits. `bash` carries its prefix policy
    // with it; the file tools need none beyond being admitted.
    const builtin = WORKSPACE_TOOLS.filter((name) => isToolAllowedByPolicy(name, policy));
    // The gateway tools the policy admits through the same shared builder, so
    // an agent that denies `ask_user` does not receive it.
    const gateway = GATEWAY_TOOLS.filter((name) => isToolAllowedByPolicy(name, policy));
    // The media tools the policy admits, through the same builder again.
    const media = MEDIA_TOOLS.filter((name) => isToolAllowedByPolicy(name, policy));
    if (builtin.length > 0 || gateway.length > 0 || media.length > 0) {
      tools = {
        gateway_url: gatewayUrl,
        // Accumulated, not replaced: an agent can have MCP tools and workspace
        // tools and conversation tools, and dropping the MCP set here is how
        // the model silently loses the 90% of calls that go through it.
        definitions: tools?.definitions ?? [],
        ...(builtin.length > 0 ? { builtin } : {}),
        ...(builtin.includes("bash") && deps.runtime?.runtimeProviderId
          ? { remote_runtime: { provider_id: deps.runtime.runtimeProviderId } }
          : {}),
        ...(builtin.includes("bash")
          ? {
              bash_policy: {
                allow_all: policy.bashPolicy.allowAll,
                allow_prefixes: policy.bashPolicy.allowPrefixes,
                deny_prefixes: policy.bashPolicy.denyPrefixes,
              },
            }
          : {}),
        // The conversation rides with them: every one of these tools addresses
        // a channel, and the guest must never infer routing. Both families
        // need it, so it is emitted once for either.
        ...(gateway.length > 0 ? { gateway: [...gateway] } : {}),
        ...(media.length > 0 ? { media: [...media] } : {}),
        ...(gateway.length > 0 || media.length > 0
          ? {
              conversation: {
                channel_id: data.channelId,
                conversation_id: data.conversationId,
                platform: data.platform,
              },
            }
          : {}),
      };
    }

    const settings = await agentSettings.getSettings(data.agentId, {
      organizationId: data.organizationId,
    });
    const memoryFlush = resolveMemoryFlushConfig(
      (data.agentOptions ?? {}) as Record<string, unknown>
    );
    // An Automation run executes VERSION-PINNED instructions. Reading the live
    // library here would let a skill edited after approval change what a
    // frozen Automation does, and would pull unrelated live skills into the
    // run — the fixed job text alone does not freeze the skill library.
    // `resolveAutomationRunSkills` scopes its query by org + agent + automation
    // + run (all derived from the canonical conversation id) and throws on a
    // missing version, so a pinned run fails rather than silently falling back
    // to live skills.
    const pinnedSkills = parseAutomationRunConversationId(data.conversationId)
      ? await resolveAutomationRunSkills({
          conversationId: data.conversationId,
          organizationId: data.organizationId,
          agentId: data.agentId,
        })
      : null;
    const skills = (
      pinnedSkills ??
      (settings?.skillsConfig?.skills ?? [])
        .filter((skill) => skill.enabled && skill.content)
        .map((skill) => ({ name: skill.name, content: skill.content! }))
    )
      .flatMap((skill) => {
        // An oversized skill is DROPPED, never truncated. A skill is authored
        // instructions, so slicing one mid-sentence would hand the model a
        // corrupted rule that reads as complete — worse than not seeding it,
        // and invisible at the point where the agent acts on it.
        const name = skillDirectoryName(skill.name);
        if (!name || skill.content.length > TURN_SKILL_CHARS) return [];
        return [{ name, content: skill.content }];
      })
      .slice(0, TURN_SKILLS_MAX);

    if (hasMemoryServer && !tools) {
      logger.info(
        { agentId: data.agentId },
        "Agent turn: the agent has the memory server but the turn carries no tools, so it runs without memory"
      );
    }
    const turn: TurnEnvelope = {
      agent_id: data.agentId,
      conversation_id: data.conversationId,
      message_id: data.messageId,
      message_text: (data.messageText ?? "").slice(0, TURN_MESSAGE_CHARS),
      // Turn-scoped context both producers already populate and clamp to
      // 2 KiB. It reaches the model through the guest's transient channel, so
      // it is never persisted into the replayed user message.
      ...(data.ephemeralContext?.trim()
        ? { ephemeral_context: data.ephemeralContext.slice(0, 2_048) }
        : {}),
      // Bytes, already read out of the artifact store. An attachment URL never
      // reaches the guest, so a turn cannot be talked into dialling one.
      ...(attachments.images.length > 0 ? { message_images: attachments.images } : {}),
      // Non-image uploads WITH their bytes, which the guest seeds into the
      // turn's agent-visible `input/` directory.
      ...(attachments.files.length > 0 ? { message_files: attachments.files } : {}),
      // Protocol-valid enabled skills, seeded in the agent-visible
      // `.skills/<name>/SKILL.md` layout with their complete content.
      ...(skills.length > 0 ? { skills } : {}),
      system_prompt: composeTurnSystemPrompt(
        settings ?? {},
        mcpInstructions,
        builtin.length > 0,
        // The guest drops `upload_file` when the turn has no workspace, so the
        // prompt must not promise it either.
        builtin.length > 0 && media.includes("upload_file"),
        builtin.includes("bash") && Boolean(deps.runtime?.runtimeProviderId),
        // Every tool the model will actually be offered, whichever family it
        // came from: an MCP server's `search_memory` earns the thread-history
        // rule exactly as the conversation plugin's `send_message` earns the
        // channel-participation one.
        [...(tools?.definitions ?? []).map((tool) => tool.name), ...gateway, ...media, ...builtin],
        (() => {
          const canRead = canReadSeededFiles(
            builtin,
            policy,
            Boolean(deps.runtime?.runtimeProviderId)
          );
          return {
            files: canRead && attachments.files.some((file) => file.data !== undefined),
            skills: canRead && skills.length > 0,
          };
        })()
      ),
      // History is read under the conversation claim, after prior turns finish.
      session_jsonl: "",
      // Pi's own defaults, measured against this model's window.
      compaction: {
        enabled: compactionDefaults.enabled,
        context_window: provider.contextWindow,
        reserve_tokens: compactionDefaults.reserveTokens,
        keep_recent_tokens: compactionDefaults.keepRecentTokens,
      },
      memory_flush: {
        enabled: memoryFlush.enabled,
        soft_threshold_tokens: memoryFlush.softThresholdTokens,
        system_prompt: memoryFlush.systemPrompt,
        prompt: memoryFlush.prompt,
      },
      provider: {
        api: provider.api,
        provider: provider.provider,
        model_id: provider.modelId,
        base_url: provider.baseUrl,
        input: provider.input,
        // Omitted for an unknown model, so the guest falls back to the
        // adapter's own ceiling instead of a number invented on either side.
        ...(provider.maxTokens !== null ? { max_tokens: provider.maxTokens } : {}),
        reasoning: provider.reasoning,
      },
      ...(tools ? { tools } : {}),
      // The memory hooks, when the agent has the server they call. They are
      // not tools and carry no schema: the guest runs
      // `@lobu/plugin-memory`'s own two hooks over the MCP route the turn
      // already uses.
      // The hooks reach the MCP route through `tools.gateway_url`, so a turn
      // that carries no tools cannot recall or capture; say so here rather
      // than promise a hook the guest would drop.
      ...(hasMemoryServer && tools
        ? { memory: { mcp_id: MEMORY_MCP_ID, agent_id: data.agentId } }
        : {}),
      // DENY-ALL. A connector's allowlist defaults open; an agent turn's does
      // not. The gateway is the only host this turn has any business
      // reaching: the provider is behind its proxy and the tools behind its
      // MCP route.
      allowed_hosts: [provider.host],
      // Authoritative. This run's reply IS the conversation's reply; there is
      // no second lane producing one. The completion route reads the `reply`
      // sibling below to publish it.
    };

    // Where this turn's reply would be delivered, kept beside the envelope
    // rather than inside it: the guest has no use for a channel id, and the
    // poll route lifts only `turn` and `credential` out of `action_input`, so
    // a third sibling never crosses into the isolate. The completion route
    // reads it to publish the terminal thread_response.
    const reply: TurnReply = {
      message_id: data.messageId,
      channel_id: data.channelId,
      user_id: data.userId,
      team_id: data.teamId,
      platform: data.platform,
      platform_metadata: data.platformMetadata,
      error_context: {
        provider: provider.providerSlug,
        model: provider.modelId,
      },
    };

    const rows = await sql.begin(async (tx) => {
      await lockAgentTurnConversation(tx, data.organizationId!, data.agentId!, data.conversationId);
      const [source] = await tx`SELECT id FROM runs
        WHERE id = ${data.runId!} AND organization_id = ${data.organizationId!}
          AND run_type = 'chat_message' AND queue_name = 'messages'
          AND action_input->>'messageId' = ${data.messageId} FOR UPDATE`;
      if (!source) throw new Error("Agent turn has no matching admitted message");
      const existing = await tx<{ id: number }>`SELECT id FROM runs WHERE parent_run_id = ${data.runId!}
        AND organization_id = ${data.organizationId!} AND run_type = 'agent_turn' LIMIT 1`;
      if (existing.length) return existing;
      return tx<{ id: number }>`INSERT INTO runs (
        id, organization_id, run_type, status, approval_status, action_input, created_at, run_at, parent_run_id
      ) VALUES (${runId}, ${data.organizationId!}, 'agent_turn', 'pending', 'auto',
        ${tx.json({ turn, credential: provider.credential, reply })}, now(), now(), ${data.runId!}) RETURNING id`;
    });

    logger.info(
      {
        runId: rows[0]?.id,
        agentId: data.agentId,
        messageId: data.messageId,
        provider: provider.provider,
        model: provider.modelId,
        images: attachments.images.length,
        files: attachments.files.length,
        tools: tools?.definitions.length ?? 0,
        workspaceTools: builtin,
        gatewayTools: gateway,
        mediaTools: media,
        memory: hasMemoryServer,
      },
      "Enqueued an agent turn on the isolate lane"
    );
    // Produced: the run owns the reply, so nothing is owed a terminal error.
    return undefined;
  } catch (err) {
    // THROW, never swallow. While this lane produced a discardable copy, a
    // failure here was correctly a log line: the real turn was already on the
    // worker queue. This run IS the turn now, so swallowing would make the
    // user's message vanish with no reply and no error — the failure mode the
    // queue's own retry/fail path exists to handle. Log for the operator, then
    // let it propagate.
    logger.error(
      { agentId: data.agentId, messageId: data.messageId, err: getErrorMessage(err) },
      "Agent turn could not be enqueued"
    );
    throw err;
  }
}
