/**
 * The agent-turn wire shapes, shared by the host executor, the guest bundle and
 * the daemon lane. Kept in one module with no imports so the guest entry can
 * pull the types without dragging any host code into the isolate bundle.
 */

/** Which provider the turn talks to, and how it authenticates. */
export interface AgentTurnProvider {
  /** pi-ai's api id. Only the two fetch-native families run on this lane. */
  api: 'anthropic-messages' | 'openai-completions';
  /** Provider slug pi-ai reports on the model (`anthropic`, `openai`, ...). */
  provider: string;
  modelId: string;
  /**
   * The gateway's agent-scoped secret-proxy URL. The guest never learns a real
   * provider key: the proxy swaps the credential it sends for the real key.
   */
  baseUrl: string;
  /**
   * HOST-INJECTED, never set by the producer. The turn's ONE credential
   * travels on `job.credentials.accessToken` so it goes through the lane's one
   * credential path: the host mints a per-run vault placeholder over it, the
   * guest only ever sees the vault's, and the host swaps it back into the
   * outbound header. The value behind it is the gateway's own per-turn worker
   * token, which the secret proxy accepts as the provider credential and the
   * MCP route accepts as the bearer — so the same placeholder authenticates
   * both the model call and every tool call. A producer that set this itself
   * would hand the guest a credential the vault never minted, and the vault
   * refuses those.
   */
  apiKey?: string;
  maxTokens?: number;
  /**
   * The modalities the model accepts, in pi-ai's `Model.input` vocabulary. The
   * gateway resolves it from pi-ai's registry; the guest only passes it
   * through, because pi is what enforces it — `transformMessages` replaces
   * every image block with a "model does not support images" placeholder when
   * `"image"` is absent. Undefined → text only, which is the safe default: a
   * turn never sends an image to a model nobody said could read one.
   */
  input?: Array<'text' | 'image'>;
}

/** One image attachment of the turn's message, resolved to bytes by the host. */
export interface AgentTurnImage {
  mimeType: string;
  /** Base64 of the artifact's bytes. The guest never fetches an attachment itself. */
  data: string;
}

/**
 * A NON-IMAGE attachment of the turn's message, by name and type only.
 *
 * The subprocess lane does not send these bytes to the model either; it names
 * the files in the prompt and leaves them on the worker's disk. This lane has
 * no disk, so it carries the same names and says so. Do not read this as a
 * file capability.
 */
export interface AgentTurnFile {
  name: string;
  mimeType: string;
  size?: number;
}

/** One tool the turn may call, as the gateway's MCP proxy published it. */
export interface AgentTurnTool {
  mcpId: string;
  name: string;
  description: string;
  /** JSON schema for the arguments; pi validates calls against it as-is. */
  inputSchema: Record<string, unknown>;
}

/** The guest's own workspace tools, by name. */
export type AgentTurnBuiltinTool = 'bash' | 'read' | 'write' | 'ls' | 'find';

/**
 * A gateway tool the turn may call — `ask_user`, `send_message`,
 * `suggest_actions` and the rest of `@lobu/plugin-conversations`.
 *
 * The producer names them; the guest runs the plugin package's OWN
 * implementation, bundled in. They are not reimplemented here and not proxied
 * through a second route: each one is already a plain `fetch` to an
 * `/internal/...` gateway endpoint under the same bearer the MCP route takes,
 * so the turn still carries exactly one credential and reaches exactly one
 * host.
 */
export type AgentTurnGatewayTool =
  | 'list_conversations'
  | 'read_conversation'
  | 'send_message'
  | 'present_event'
  | 'schedule_followup'
  | 'react'
  | 'edit_message'
  | 'delete_message'
  | 'ask_user'
  | 'suggest_actions';

/**
 * A media tool the turn may call — `@lobu/plugin-media`'s own.
 *
 * As with the gateway tools, the producer names them and the guest runs the
 * plugin package's OWN implementation. `upload_file` differs from the other two
 * in one respect only: it reads a file, and the two lanes hold the agent's
 * workspace in different places, so the guest injects a read port over the
 * turn's in-memory filesystem. The tool, its schema and its prose are the
 * plugin's on both lanes.
 */
export type AgentTurnMediaTool = 'upload_file' | 'generate_image' | 'generate_audio';

/**
 * The agent's bash prefix policy, in the shape `@lobu/core/tool-policy`
 * enforces. Restated rather than imported on purpose: this file is the
 * host-side contract, and a type import here would be the first step toward a
 * value import from the same module, which the guest bundle cannot take.
 */
export interface AgentTurnBashPolicy {
  allowAll: boolean;
  allowPrefixes: string[];
  denyPrefixes: string[];
}

/** The tools of a turn and where they are called. */
export interface AgentTurnTools {
  /** Gateway base URL, mount path included; the MCP route hangs off it. */
  gatewayUrl: string;
  definitions: AgentTurnTool[];
  /**
   * Workspace tools the agent's policy admits. They run inside the isolate
   * against a filesystem that lives for this turn only.
   */
  builtin?: AgentTurnBuiltinTool[];
  bashPolicy?: AgentTurnBashPolicy;
  /**
   * Gateway tools the agent's policy admits, by name. Their routing lives in
   * the plugin package, so the wire carries only the names.
   */
  gateway?: AgentTurnGatewayTool[];
  /**
   * Media tools the agent's policy admits, by name. Same contract as
   * `gateway`: names only, because the routing lives in the plugin package.
   * `upload_file` additionally needs `builtin` to include a workspace tool —
   * with no filesystem there is no file to show — and the guest drops it if
   * the turn has none.
   */
  media?: AgentTurnMediaTool[];
  /**
   * Conversation routing the gateway and media tools post into. Required
   * whenever `gateway` or `media` is non-empty.
   */
  conversation?: AgentTurnConversation;
}

/**
 * What `@lobu/plugin-conversations` calls `GatewayParams` minus the two the
 * guest already holds (the URL and the credential): who this turn is talking
 * to. The plugin's tools read these off their params to address the
 * conversation they post into.
 */
export interface AgentTurnConversation {
  channelId: string;
  conversationId: string;
  platform: string;
}

/**
 * One transcript entry, in pi's own `AgentMessage` shape. The host does not
 * interpret it; it round-trips whatever the guest returns back into the run row
 * so the next turn resumes from it.
 */
export type AgentTurnMessage = Record<string, unknown>;

/** Everything a single turn needs. */
export interface AgentTurnInput {
  provider: AgentTurnProvider;
  systemPrompt: string;
  /** The transcript this turn continues, oldest first. */
  messages: AgentTurnMessage[];
  /** What the human just said. Empty when the turn carries only attachments. */
  userMessage: string;
  /**
   * The message's image attachments, already resolved to base64 by the host.
   * The guest puts them in the user turn beside the text; pi drops them for a
   * model whose `provider.input` does not include `'image'`.
   */
  images?: AgentTurnImage[];
  /** The message's non-image attachments, named for the model but not sent to it. */
  files?: AgentTurnFile[];
  /** Absent → the turn runs with no tools. */
  tools?: AgentTurnTools;
  /**
   * Long-term memory for this turn: recall before the model runs, capture
   * after it answers. Absent → the turn runs with no memory, which is what a
   * turn whose agent has no `lobu` MCP server gets.
   *
   * Both hooks are `@lobu/plugin-memory`'s own and reach `search_memory` /
   * `save_memory` over the MCP route this turn already calls, so no extra
   * credential and no extra host is involved.
   */
  memory?: AgentTurnMemory;
}

/** Whether this turn recalls and captures long-term memory, and as whom. */
export interface AgentTurnMemory {
  /**
   * The MCP server id the memory tools live on. Carried rather than assumed so
   * a turn whose Lobu server is mounted elsewhere still recalls.
   */
  mcpId: string;
  /** The agent the capture is attributed to. */
  agentId: string;
}

/** What the guest streams out while the turn runs. */
export type AgentTurnEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'message_end' }
  | { type: 'tool_call_start'; toolCallId: string; name: string; args: unknown }
  | { type: 'tool_call_end'; toolCallId: string; name: string; isError: boolean; output: string }
  /**
   * A file `upload_file` delivered, with the gateway's own reply for it. The
   * subprocess lane raises the same payload as its `file-uploaded` custom
   * event; on this lane it rides the turn's one event stream, so the guest
   * still needs no second channel out of the isolate.
   */
  | { type: 'file_uploaded'; data: Record<string, unknown> };

/** What the turn produced. */
export interface AgentTurnOutput {
  text: string;
  stopReason: string | null;
  usage: { input: number; output: number } | null;
  /** The transcript after the turn, to persist and resume from. */
  messages: AgentTurnMessage[];
  /**
   * The turn posted its answer INTO the conversation it is replying to, with
   * `send_message`/`present_event`. `text` is then a report about a message the
   * user has already read, so the terminal reply must not be delivered as well
   * — the completion route stamps `repliedInBand` and the renderers' existing
   * suppression does the rest.
   */
  repliedInBand?: boolean;
}
