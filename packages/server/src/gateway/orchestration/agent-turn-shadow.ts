/**
 * Shadow producer for the agent-turn isolate lane.
 *
 * A selected agent's turn is enqueued TWICE: once the ordinary way, to the
 * subprocess worker that answers the conversation, and once as an `agent_turn`
 * row the connector-worker fleet claims and runs inside an isolate. The shadow
 * copy is observational — its reply is written to its own run row by
 * `/api/workers/complete-agent-turn` and never reaches the client — so the two
 * lanes can be compared on live traffic before the isolate lane becomes
 * authoritative.
 *
 * Three things this producer must NOT do, each of which would corrupt the real
 * turn rather than merely observe it:
 *
 *  - Arm a turn-timeout marker. The marker is keyed
 *    `(deploymentName, messageId)` and discharged first-writer-wins, so a
 *    second marker for the same turn would let the shadow's outcome terminate
 *    the client's stream.
 *  - Write an `agent_run_input` journal row. Same key, same collision: a
 *    replay would resume the wrong lane.
 *  - Use a run type inside `LOBU_RUN_TYPES`. `agent_turn` is deliberately
 *    outside it, so `RunsQueue` never claims or completes these rows.
 *
 * Everything here is best-effort. `enqueueAgentTurnShadow` never throws into
 * the enqueue path, and the caller runs it AFTER the real message is on the
 * worker queue, so a shadow that cannot be produced costs the turn nothing.
 *
 * Selection is the operator env var `LOBU_ISOLATE_TURN_SHADOW_AGENTS`
 * (comma-separated agent ids, or `*`). It is an operator switch for a
 * short-lived overlap, not a product surface, so it is deliberately not an
 * agent column.
 */

import {
  type AgentOptions,
  buildToolPolicy,
  createLogger,
  generateWorkerToken,
  getErrorMessage,
  isToolAllowedByPolicy,
  type MessagePayload,
  parseSessionEntries,
  renderAlwaysOnToolPolicyRulesFor,
  resolveSdkCompat,
  type ToolPolicy,
  type ToolsConfig,
  verifyWorkerToken,
} from "@lobu/core";
import type { AgentTurnPollPayload } from "@lobu/core/contracts/worker/protocol";
import { getModel, type Model } from "@mariozechner/pi-ai";
import { getDb } from "../../db/client.js";
import type { McpConfigService } from "../auth/mcp/config-service.js";
import type { McpProxy } from "../auth/mcp/proxy.js";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import type { ProviderCatalogService } from "../auth/provider-catalog.js";
import type { ModelProviderModule } from "../modules/module-system.js";
import { readSnapshotJsonl } from "../services/transcript-snapshot.js";
import {
  type AgentTurnArtifactReader,
  resolveTurnAttachments,
} from "./agent-turn-attachments.js";
import { buildWorkerTokenClaims } from "./worker-token-claims.js";

const logger = createLogger("agent-turn-shadow");

const SHADOW_AGENTS_ENV = "LOBU_ISOLATE_TURN_SHADOW_AGENTS";

/**
 * pi-ai's two fetch-native adapters. Every other protocol in
 * `SDK_COMPAT_PROTOCOLS` reaches its upstream through a Node-bound SDK, which
 * cannot be bundled for the isolate — so those agents simply produce no shadow.
 *
 * Typed as the envelope's own `api` union so the set and the wire contract
 * cannot drift: adding an adapter here without widening the schema is a
 * compile error, not a run that fails validation on the worker.
 */
type LaneApi = TurnEnvelope["provider"]["api"];
const LANE_APIS = new Set<string>([
  "anthropic-messages",
  "openai-completions",
] satisfies LaneApi[]);

/** Snapshot suffix read for history. Twelve 16 KB messages fit comfortably. */
const HISTORY_TAIL_CHARS = 256 * 1024;
const HISTORY_MESSAGE_LIMIT = 12;
const HISTORY_MESSAGE_CHARS = 16_000;
const TURN_MESSAGE_CHARS = 32_000;

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
 * them. `grep` and `edit` are absent on purpose: pi's `grep` spawns ripgrep as
 * a child process, which an isolate cannot do, and neither tool is needed to
 * reach the workspace — just-bash's own `rg`, `grep` and `sed` run inside
 * `bash`. Adding either means writing an in-isolate implementation first.
 */
const WORKSPACE_TOOLS: readonly BuiltinTool[] = ["bash", "read", "write", "ls", "find"];

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

export interface AgentTurnShadowDeps {
  /** Reads the agent's identity/soul/user layers. Absent → no shadow. */
  agentSettings?: AgentSettingsStore;
  /** Resolves the agent's provider modules. Absent → no shadow. */
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
   * shadow, because there is no URL to hand the worker.
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
}

function shadowSelects(agentId: string): boolean {
  const raw = process.env[SHADOW_AGENTS_ENV]?.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(agentId);
}

/**
 * The system prompt for the shadow turn.
 *
 * DELIBERATELY REDUCED: the subprocess lane's prompt also carries platform,
 * network and skills instruction blocks, none of which the isolate lane can
 * act on yet. Composing the three agent layers plus each MCP server's own
 * instructions keeps the comparison honest about what the lane can currently
 * do, and matches the worker's own section headings
 * (`composeAgentInstructions`) so the identity text itself is byte-identical.
 */
function composeShadowSystemPrompt(
  layers: {
    identityMd?: string | null;
    soulMd?: string | null;
    userMd?: string | null;
  },
  mcpInstructions: string[],
  workspace: boolean,
  canUpload: boolean,
  toolNames: readonly string[]
): string {
  const sections: string[] = [];
  const identity = layers.identityMd?.trim();
  const soul = layers.soulMd?.trim();
  const user = layers.userMd?.trim();
  if (identity) sections.push(`## Agent Identity\n\n${identity}`);
  if (soul) sections.push(`## Agent Instructions\n\n${soul}`);
  if (user) sections.push(`## User Context\n\n${user}`);
  // The same always-on tool rules the subprocess lane composes, narrowed to
  // the tools THIS turn carries — `ask_user`'s "after calling it, stop" among
  // them, which is how the model learns the rule the guest enforces.
  const policyRules = renderAlwaysOnToolPolicyRulesFor(toolNames);
  if (policyRules) sections.push(policyRules);
  if (workspace) sections.push(workspaceInstructions(canUpload));
  for (const instructions of mcpInstructions) {
    const text = instructions.trim();
    if (text) sections.push(text);
  }
  return sections.join("\n\n");
}

/**
 * What the model must know about the workspace its tools act on, and only
 * that: it is private to this turn, starts empty, and has no network.
 *
 * The `upload_file` line is appended only when the turn actually carries that
 * tool — the workspace does not persist, so a file the user should see has to
 * be handed over during the turn that produced it, and a model told to call a
 * tool it was not given would just fail.
 */
function workspaceInstructions(canUpload: boolean): string {
  const lines = [
    "## Workspace",
    "",
    "Your bash, read, write, ls and find tools act on a private in-memory workspace at /workspace.",
    "It starts empty on every turn and nothing written there persists after the turn ends.",
    "It has no network access and no package manager; use your other tools to reach data.",
  ];
  if (canUpload) {
    lines.push(
      "Nothing in the workspace is visible to the user: to show them a file you produced, call upload_file before the turn ends."
    );
  }
  return lines.join("\n");
}

type HistoryMessage = Record<string, unknown> & { role: string };

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    !!block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

/** A content array with its text capped and its thinking blocks dropped. */
function trimContent(content: unknown): unknown[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content.slice(0, HISTORY_MESSAGE_CHARS) }];
  }
  if (!Array.isArray(content)) return [];
  const out: unknown[] = [];
  for (const block of content) {
    if (isTextBlock(block)) {
      out.push({ type: "text", text: block.text.slice(0, HISTORY_MESSAGE_CHARS) });
      continue;
    }
    // A thinking block carries a provider signature the next provider may not
    // accept; the text and the tool calls are what the turn resumes from.
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "thinking") continue;
    out.push(block);
  }
  return out;
}

function hasToolCall(message: HistoryMessage): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some(
      (block) => !!block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall"
    )
  );
}

/**
 * Rebuild the conversation so far as pi messages.
 *
 * The snapshot stores pi's own entries, and the lane now runs the same tool
 * loop pi ran to produce them, so user, assistant and tool-result entries
 * replay as they are — text capped, thinking dropped, everything else (tool
 * calls, tool results, usage, stop reason) kept, because a provider refuses a
 * tool call without its result and vice versa. The window is then squared off
 * so it opens on a user message and never ends on a tool call still waiting
 * for its result.
 */
function historyMessages(snapshot: string): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  for (const entry of parseSessionEntries(snapshot).entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message as unknown as HistoryMessage;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") continue;
    const content = trimContent(message.content);
    if (content.length === 0) continue;
    messages.push({ ...message, content });
  }
  const window = messages.slice(-HISTORY_MESSAGE_LIMIT);
  const firstUser = window.findIndex((message) => message.role === "user");
  if (firstUser < 0) return [];
  const squared = window.slice(firstUser);
  while (squared.length > 0) {
    const last = squared[squared.length - 1]!;
    if (last.role === "assistant" && hasToolCall(last)) {
      squared.pop();
      continue;
    }
    break;
  }
  return squared;
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

interface ShadowProvider {
  api: LaneApi;
  provider: string;
  modelId: string;
  baseUrl: string;
  credential: string;
  host: string;
  /** pi-ai's `Model.input` for this model — which modalities it accepts. */
  input: ("text" | "image")[];
}

/**
 * Which modalities this model accepts, from pi-ai's own model registry.
 *
 * SAME source of truth the subprocess lane uses: it resolves a registry model
 * through `getModelDynamic` when there is one and otherwise builds a dynamic
 * entry that declares `["text", "image"]` (`agent-worker`'s
 * `buildDynamicOpenAIModel`). Both rules are reproduced rather than
 * re-decided, so an agent's vision support does not depend on which lane ran
 * its turn — and neither lane hardcodes a per-model guess. pi is what enforces
 * the answer: `transformMessages` replaces every image block with a
 * "model does not support images" placeholder when `"image"` is missing.
 */
function modelInputModalities(
  registryProvider: string,
  modelId: string
): ("text" | "image")[] {
  // `getModel` is typed over pi-ai's static registry and cannot take the
  // strings Lobu resolves at runtime without a cast; it answers undefined for
  // a model the registry does not carry.
  const model = getModel(registryProvider as never, modelId as never) as
    | Model<never>
    | undefined;
  return model?.input ? [...model.input] : ["text", "image"];
}

/**
 * Mint the turn's one credential: a worker token scoped to this agent, user,
 * organization and conversation, exactly as the subprocess lane's per-run
 * token is (`buildRunJobToken`) minus the runtime-sandbox claims the isolate
 * has no use for. The secret proxy accepts it as the provider credential and
 * binds it to the agent in the URL; the MCP route authenticates it. The
 * `deploymentName` names this lane so a token can never be mistaken for a
 * subprocess deployment's.
 */
function mintTurnToken(data: MessagePayload): string {
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
      }),
      messageId: data.messageId,
    }
  );
}

/**
 * Resolve the provider exactly the way the subprocess lane's session context
 * does: the agent's installed modules, the module that owns the requested
 * model, its agent-scoped secret-proxy URL and its credential.
 *
 * Returns null (with one log line) whenever the turn is not shadowable, which
 * is a normal outcome, not a failure: an agent on Google or Bedrock, a provider
 * with no proxy route, a credential the gateway cannot placeholder.
 */
async function resolveShadowProvider(
  module: ModelProviderModule,
  args: {
    agentId: string;
    organizationId: string;
    userId: string;
    modelRef: string;
    gatewayUrl: string;
    workerToken: string;
  }
): Promise<ShadowProvider | null> {
  const protocol = resolveSdkCompat(module.sdkCompat);
  if (!protocol || !isLaneApi(protocol.api)) {
    logger.info(
      { agentId: args.agentId, provider: module.providerId, api: protocol?.api ?? null },
      "Agent turn shadow skipped: the provider's protocol has no fetch-native adapter on the isolate lane"
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
      "Agent turn shadow skipped: the provider does not publish exactly one proxy base URL"
    );
    return null;
  }
  const baseUrl = routes[0];

  // With the worker token in its context the base module answers the token
  // itself, which is what makes one credential serve both hops. A module that
  // answers something else (its own placeholder scheme) still shadows, but
  // the turn then has no credential the MCP route would accept.
  const credential = module.buildCredentialPlaceholder
    ? await module.buildCredentialPlaceholder(args.agentId, context)
    : "lobu-proxy";
  if (!credential) {
    logger.info(
      { agentId: args.agentId, provider: module.providerId },
      "Agent turn shadow skipped: the provider produced no credential placeholder"
    );
    return null;
  }

  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    logger.warn(
      { agentId: args.agentId, provider: module.providerId },
      "Agent turn shadow skipped: the provider's proxy base URL does not parse"
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
    modelId,
    baseUrl,
    credential,
    host,
    input: modelInputModalities(protocol.registryAlias, modelId),
  };
}

/**
 * The agent's tool policy, built from the same options the subprocess lane
 * reads (`agentOptions.toolsConfig`, `allowedTools`, `disallowedTools`) and
 * through the same shared builder, so one agent's patterns mean the same thing
 * whichever lane runs the turn.
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
 * best-effort, as it is for the subprocess lane's session context — a server
 * that fails to list contributes nothing and one log line.
 *
 * The policy filter is applied here and NOT by the subprocess lane, which
 * registers its MCP tools through `createMcpPlugin` unfiltered and only
 * policy-filters its built-in tools. Erring strict is the safe direction for a
 * shadow turn: it can only withhold a tool, never grant one the agent's
 * patterns deny. Aligning the two lanes is a separate change to the
 * subprocess lane, not to this producer.
 */
async function resolveTurnTools(
  mcp: NonNullable<AgentTurnShadowDeps["mcp"]>,
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
        "Agent turn shadow: an MCP server did not list its tools; the turn runs without them"
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

/**
 * Produce the shadow `agent_turn` run for this message, when one is selected
 * and resolvable. Never throws: the caller has already delivered the real turn.
 */
export async function enqueueAgentTurnShadow(
  data: MessagePayload,
  deps: AgentTurnShadowDeps
): Promise<void> {
  try {
    if (!data.agentId || !shadowSelects(data.agentId)) return;
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
        "Agent turn shadow skipped: the message carries neither text nor a resolvable attachment for the turn to send"
      );
      return;
    }

    const modelRef = data.agentOptions?.model?.trim();
    if (!modelRef) {
      logger.info(
        { agentId: data.agentId },
        "Agent turn shadow skipped: this turn carries no resolved model, and the shadow does not re-run the worker's default resolution"
      );
      return;
    }

    const catalog = deps.catalog;
    const agentSettings = deps.agentSettings;
    if (!catalog || !agentSettings) {
      logger.info(
        { agentId: data.agentId },
        "Agent turn shadow skipped: the provider catalog or the agent settings store is not wired yet"
      );
      return;
    }

    const gatewayUrl = deps.gatewayUrl;
    if (!gatewayUrl) {
      logger.info(
        { agentId: data.agentId },
        "Agent turn shadow skipped: PUBLIC_GATEWAY_URL is not configured, so there is no URL the fleet worker can reach the gateway on"
      );
      return;
    }

    const modules = await catalog.getInstalledModules(
      data.agentId,
      data.organizationId
    );
    const module = await catalog.findProviderForModel(modelRef, modules);
    if (!module) {
      logger.info(
        { agentId: data.agentId, model: modelRef },
        "Agent turn shadow skipped: no installed provider owns this model"
      );
      return;
    }

    const workerToken = mintTurnToken(data);
    const provider = await resolveShadowProvider(module, {
      agentId: data.agentId,
      organizationId: data.organizationId,
      userId: data.userId,
      modelRef,
      gatewayUrl,
      workerToken,
    });
    if (!provider) return;

    let tools: TurnTools | undefined;
    // Memory is off unless the agent actually has the server its hooks call.
    let hasMemoryServer = false;
    let mcpInstructions: string[] = [];
    const policy = turnToolPolicy(data.agentOptions);
    const toolsConfig = data.agentOptions?.toolsConfig as ToolsConfig | undefined;
    if (!deps.mcp) {
      logger.info(
        { agentId: data.agentId },
        "Agent turn shadow: the MCP surface is not wired, so the turn runs without tools"
      );
    } else if (toolsConfig?.mcpExposure === "cli") {
      logger.info(
        { agentId: data.agentId },
        "Agent turn shadow: the agent exposes MCP as shell commands, which this lane does not carry yet, so the turn runs without tools"
      );
    } else if (provider.credential !== workerToken) {
      logger.info(
        { agentId: data.agentId, provider: module.providerId },
        "Agent turn shadow: the provider answers its own credential placeholder, which the MCP route cannot authenticate, so the turn runs without tools"
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
    // The gateway tools the policy admits, through the SAME builder and the
    // same patterns that decide them on the subprocess lane — so an agent that
    // denies `ask_user` denies it on both lanes.
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
    const snapshot = await readSnapshotJsonl({
      organizationId: data.organizationId,
      agentId: data.agentId,
      conversationId: data.conversationId,
      suffixChars: HISTORY_TAIL_CHARS,
    });

    const turn: TurnEnvelope = {
      agent_id: data.agentId,
      conversation_id: data.conversationId,
      message_id: data.messageId,
      message_text: (data.messageText ?? "").slice(0, TURN_MESSAGE_CHARS),
      // Bytes, already read out of the artifact store. An attachment URL never
      // reaches the guest, so a turn cannot be talked into dialling one.
      ...(attachments.images.length > 0 ? { message_images: attachments.images } : {}),
      // Names and types only, which is also all the subprocess lane sends the
      // model for a non-image upload. This is NOT a file capability.
      ...(attachments.files.length > 0 ? { message_files: attachments.files } : {}),
      system_prompt: composeShadowSystemPrompt(
        settings ?? {},
        mcpInstructions,
        builtin.length > 0,
        // The guest drops `upload_file` when the turn has no workspace, so the
        // prompt must not promise it either.
        builtin.length > 0 && media.includes("upload_file"),
        // Every tool the model will actually be offered, whichever family it
        // came from: an MCP server's `search_memory` earns the thread-history
        // rule exactly as the conversation plugin's `send_message` earns the
        // channel-participation one.
        [...(tools?.definitions ?? []).map((tool) => tool.name), ...gateway, ...media, ...builtin]
      ),
      messages: snapshot ? historyMessages(snapshot) : [],
      provider: {
        api: provider.api,
        provider: provider.provider,
        model_id: provider.modelId,
        base_url: provider.baseUrl,
        input: provider.input,
      },
      ...(tools ? { tools } : {}),
      // The memory hooks, when the agent has the server they call. They are
      // not tools and carry no schema: the guest runs
      // `@lobu/plugin-memory`'s own two hooks over the MCP route the turn
      // already uses.
      ...(hasMemoryServer
        ? { memory: { mcp_id: MEMORY_MCP_ID, agent_id: data.agentId } }
        : {}),
      // DENY-ALL. A connector's allowlist defaults open; an agent turn's does
      // not. The gateway is the only host this turn has any business
      // reaching: the provider is behind its proxy and the tools behind its
      // MCP route.
      allowed_hosts: [provider.host],
      shadow: true,
    };

    // Where this turn's reply would be delivered, kept beside the envelope
    // rather than inside it: the guest has no use for a channel id, and the
    // poll route lifts only `turn` and `credential` out of `action_input`, so
    // a third sibling never crosses into the isolate. The completion route
    // reads it to publish the same thread_response the subprocess lane does.
    const reply: TurnReply = {
      message_id: data.messageId,
      channel_id: data.channelId,
      user_id: data.userId,
      team_id: data.teamId,
      platform: data.platform,
      platform_metadata: data.platformMetadata,
    };

    const sql = getDb();
    const rows = await sql<{ id: number }>`
      INSERT INTO runs (
        organization_id, run_type, status,
        approval_status, action_input, created_at
      ) VALUES (
        ${data.organizationId}, 'agent_turn', 'pending',
        'auto', ${sql.json({ turn, credential: provider.credential, reply })},
        current_timestamp
      )
      RETURNING id
    `;

    logger.info(
      {
        runId: rows[0]?.id,
        agentId: data.agentId,
        messageId: data.messageId,
        provider: provider.provider,
        model: provider.modelId,
        history: turn.messages.length,
        images: attachments.images.length,
        files: attachments.files.length,
        tools: tools?.definitions.length ?? 0,
        workspaceTools: builtin,
        gatewayTools: gateway,
        mediaTools: media,
        memory: hasMemoryServer,
      },
      "Enqueued a shadow agent turn on the isolate lane"
    );
  } catch (err) {
    // A shadow is never worth a real turn. The message is already on the
    // worker queue by the time this runs, so the only correct response to any
    // failure here is a log line.
    logger.warn(
      { agentId: data.agentId, messageId: data.messageId, err: getErrorMessage(err) },
      "Agent turn shadow could not be produced"
    );
  }
}
