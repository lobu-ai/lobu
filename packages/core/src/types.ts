import type { SecretRef } from "./secret-refs";

/**
 * CLI backend configuration for pi-agent integration.
 * Providers can ship CLI tools that pi-agent invokes as backends.
 */
export interface CliBackendConfig {
  name: string; // "claude-code", "codex"
  command: string; // "/usr/local/bin/claude"
  args?: string[];
  env?: Record<string, string>;
  modelArg?: string; // "--model"
  sessionArg?: string; // "--session"
}

/**
 * Unified authentication profile for any model provider.
 * Persisted per-(userId, agentId) by the gateway's UserAuthProfileStore;
 * also synthesized at read time from declared credentials and SDK-supplied
 * ephemeral credentials.
 *
 * **Invariant:** at any point in time, a profile has **exactly one** credential
 * source set — either `credentialRef` (persisted profiles resolved through the
 * secret store) or `credential` (in-memory runtime profiles for SDK-embedded
 * use). The same rule applies to `metadata.refreshToken` / `refreshTokenRef`.
 * The persistence layer is responsible for never writing plaintext credentials
 * into the stored JSON.
 */
export interface AuthProfile {
  id: string; // UUID
  provider: string; // "anthropic", "openai-codex", "gemini", "nvidia"
  model: string; // Full model ref: "openai-codex/gpt-5.2-codex"
  /** Runtime-only resolved credential value. Never persisted. */
  credential?: string;
  /** Durable secret reference for the credential. */
  credentialRef?: SecretRef;
  label: string; // "user@gmail.com", "sk-ant-...1234"
  authType: "oauth" | "device-code" | "api-key";
  metadata?: {
    email?: string;
    expiresAt?: number;
    /** Runtime-only resolved refresh token value. Never persisted. */
    refreshToken?: string;
    /** Durable secret reference for the refresh token. */
    refreshTokenRef?: SecretRef;
    accountId?: string;
  };
  createdAt: number;
}

/** True if the profile has any credential source (resolved or ref). */
export function hasCredentialSource(profile: AuthProfile): boolean {
  return Boolean(profile.credential || profile.credentialRef);
}

/**
 * Declared provider credential — a credential that ships with the agent's
 * declared configuration (`lobu.config.ts` or SDK `GatewayConfig.agents`).
 *
 * Declared credentials are read-only at runtime. They are merged into the
 * effective auth profile list when no user-scoped profile exists for the
 * `(agentId, provider)` pair.
 */
export interface DeclaredCredential {
  provider: string;
  /** Plaintext key — present when the file/SDK supplies a value directly. */
  key?: string;
  /** Persisted secret reference — present when the file/SDK supplies a ref. */
  secretRef?: SecretRef;
}

export interface SessionContext {
  // Core identifiers
  platform: string; // Platform identifier (e.g., "slack", "discord", "teams")
  channelId: string;
  userId: string;
  messageId: string; // Required - always needed for tracking

  // Optional context
  conversationId?: string;
  teamId?: string; // Platform workspace/team identifier
  userDisplayName?: string; // For logging/display purposes
  workingDirectory?: string;
  customInstructions?: string;
  conversationHistory?: ConversationMessage[];
}

export interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: number;
}

// Agent-settings nested types (NetworkConfig, NixConfig, ToolsConfig,
// SkillConfig, SkillsConfig, AgentInlineGuardrail, ThinkingLevel) now live in
// ./contracts/agent-settings.ts as the single TypeBox-schema source (Static<typeof ...>). They are re-exported
// from there at the bottom of this file so the @lobu/core public surface and
// core-internal imports keep resolving. The hand-written duplicates that
// lived here were structurally identical but a separate drift surface.

export interface McpOAuthConfig {
  /** Authorization endpoint (user verification page for device-code flow). */
  authUrl?: string;
  /** Token endpoint. Falls back to `{origin}/oauth/token`. */
  tokenUrl?: string;
  /** Pre-registered client ID. When provided, dynamic client registration is skipped. */
  clientId?: string;
  /** Client secret for confidential clients. */
  clientSecret?: string;
  /** OAuth scopes. Falls back to `mcp:read mcp:write profile:read`. */
  scopes?: string[];
  /** Device authorization endpoint. Falls back to `{origin}/oauth/device_authorization`. */
  deviceAuthorizationUrl?: string;
  /** Dynamic client registration endpoint. Falls back to `{origin}/oauth/register`. */
  registrationUrl?: string;
  /** RFC 8707 resource indicator included in token requests. */
  resource?: string;
}

// SkillConfig now comes from ./contracts/agent-settings (re-exported at the
// bottom). The hand-written duplicates that lived here were structurally
// identical but a separate drift
// surface; removed when the schema became the single source.

/**
 * An operator-authored custom guardrail stored on an agent (`AgentSettings.
 * guardrailsInline`). The operator owns the agent, so a custom guardrail may
 * run at any stage. Each one is an inline LLM judge: the `policy` is evaluated by `model` (defaulting to
 * the judge default) and trips when the judge denies.
 *
 * `name` is operator-given and must be unique across the agent's guardrails
 * (built-ins included) — it's the catalog id, the detail route key, and the
 * name recorded on every `guardrail-trip` event, so it has to be stable and
 * collision-free or the aggregator's name-keyed dedup would silently drop it.
 */
// AgentInlineGuardrail now comes from ./contracts/agent-settings
// (re-exported at the bottom). Removed the hand-written duplicate.

//
// SkillsConfig now comes from ./contracts/agent-settings (re-exported at the
// bottom). Removed the hand-written duplicate.
//

/**
 * Platform-agnostic history message format.
 * Used to pass conversation history to workers.
 */
export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** Display name of the message sender */
  userName?: string;
  /** Platform-specific message ID for deduplication */
  messageId?: string;
}

// NetworkConfig / NixConfig / ToolsConfig now come from
// ./contracts/agent-settings (re-exported at the bottom).

interface MemoryFlushOptions {
  enabled?: boolean;
  softThresholdTokens?: number;
  systemPrompt?: string;
  prompt?: string;
}

export interface AgentCompactionOptions {
  memoryFlush?: MemoryFlushOptions;
}

/**
 * Platform-agnostic execution hints passed through gateway → worker.
 * Flexible types (string | string[]) and index signature allow forward
 * compatibility for different agent implementations.
 */
export interface AgentOptions {
  runtime?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  allowedTools?: string | string[];
  disallowedTools?: string | string[];
  timeoutMinutes?: number | string;
  compaction?: AgentCompactionOptions;
  // Additional settings passed through from gateway (can be nested objects)
  networkConfig?: Record<string, unknown>;
  envVars?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Platform-agnostic log level type
 * Maps to common logging levels used across different platforms
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Context information passed to instruction providers
 */
export interface InstructionContext {
  userId: string;
  agentId: string;
  /** Signed chat connection id for connection-scoped instruction lookups. */
  connectionId?: string;
  /**
   * Owning org of the agent. An agent id can exist in multiple orgs (PK is
   * `(organization_id, id)`), so instruction providers must scope their
   * settings reads by org — the worker-dispatch path has no ambient orgContext,
   * so an unscoped read returns an arbitrary org's row.
   */
  organizationId?: string;
  /**
   * Whether agent-scoped settings reads are org-safe for this turn. False for an
   * orgless DB-backed agent (a shared id like "lobu-builder" exists in every
   * org, so an id-only read would leak another tenant's identity/soul/skills).
   * When false, instruction providers MUST skip the by-id settings read and use
   * their generic (no-agent) branch. True (or absent) for a normal org-scoped
   * agent and for declared/SDK-embedded agents (whose settings are org-agnostic).
   */
  orgScoped?: boolean;
  sessionKey: string;
  workingDirectory: string;
  availableProjects?: string[];
  userPrompt?: string;
}

/**
 * Interface for components that contribute custom instructions
 */
export interface InstructionProvider {
  /** Unique identifier for this provider */
  name: string;

  /** Priority for ordering (lower = earlier in output) */
  priority: number;

  /**
   * Generate instruction text for this provider
   * @param context - Context information for instruction generation
   * @returns Instruction text or empty string if none
   */
  getInstructions(context: InstructionContext): Promise<string> | string;
}

/**
 * Shared payload contract for worker → platform thread responses.
 * Ensures gateway consumers and workers stay type-aligned.
 */
export interface AgentErrorContext {
  /** Lobu provider slug safe to expose to the settings UI. */
  provider?: string;
  /** Provider model id safe to expose to the settings UI. */
  model?: string;
}

export interface ThreadResponsePayload {
  messageId: string;
  channelId: string;
  conversationId: string;
  userId: string;
  teamId: string;
  /**
   * Owning organization for this turn, stamped by the authenticated worker
   * gateway. This can differ from the chat connection's organization for a
   * hosted-preview turn, so tenant-scoped renderers must prefer this value.
   */
  organizationId?: string;
  platform?: string; // Platform identifier (slack, whatsapp, api, etc.) for routing
  content?: string; // Used only for ephemeral messages (OAuth/auth flows)
  delta?: string;
  isFullReplacement?: boolean;
  processedMessageIds?: string[];
  /**
   * Full final assistant text, set on the TERMINAL completion row by the
   * worker. Lets a renderer deliver the reply without the per-pod streaming
   * buffer (which only exists on the pod that consumed the delta rows) — so a
   * post-once platform (Slack) renders correctly even when the completion is
   * drained by a different replica than the one that buffered the deltas.
   */
  finalText?: string;
  /**
   * Distinct tool names invoked this turn (`tool_execution_end`), stamped by
   * the worker on the terminal completion row so output guardrails (e.g.
   * require-tool) can enforce "must call X this turn" without a second ledger.
   */
  toolsUsed?: string[];
  /**
   * The agent already posted its answer into THIS conversation during the turn
   * (via the `send_message` conversation tool), so `finalText` is a report
   * about a message the user has already read. Renderers must not deliver the
   * terminal reply when this is set — doing so is the double-message.
   *
   * Set only on the COMPLETION row, never on an error row: an error is not a
   * duplicate of the reply and must always surface.
   */
  repliedInBand?: boolean;
  /**
   * Raw error message. When provider context is available, the gateway labels
   * the source and unwraps the common JSON message envelope without rewording
   * the provider's sentence; `errorCode` selects the CTA link.
   */
  error?: string;
  /**
   * Original terminal error used only for durable run bookkeeping when an
   * output guardrail replaces the user-visible error text. Gateway-owned;
   * renderers must never expose this field to clients.
   */
  bookkeepingError?: string;
  errorCode?: string;
  /** Non-secret provider/model targeting for the error CTA. */
  errorContext?: AgentErrorContext;
  timestamp: number;
  originalMessageId?: string;
  botResponseId?: string;
  ephemeral?: boolean; // If true, message should be sent as ephemeral (only visible to user)
  platformMetadata?: Record<string, unknown>;
  statusUpdate?: {
    elapsedSeconds: number;
    state: string; // e.g., "is running" or "is scheduling"
  };
  customEvent?: {
    name: string;
    data: Record<string, unknown>;
    /**
     * When true, this customEvent is an interaction card (ask_user question,
     * tool-approval, link-button) that must reach the browser's SSE socket,
     * which lives on exactly one pod. The thread_response consumer treats such
     * rows like terminal API rows: a pod that does not hold the SSE connection
     * re-queues so the owning pod (pinned by ClientIP affinity) delivers it.
     * Without this the card is broadcast into a pod-local SseManager the
     * browser is not connected to and the user never sees it, hanging the turn.
     */
    requireSseOwner?: boolean;
  };

  // Exec-specific response fields (for jobType === "exec")
  execId?: string; // Exec job ID for response routing
  execStream?: "stdout" | "stderr"; // Which stream this delta is from
  execExitCode?: number; // Process exit code (sent on completion)
}

/**
 * Suggested prompts live in their own PURE module so the isolate guest can
 * reach them through `@lobu/core/agent-tooling` without dragging the rest of
 * core (and winston) in. Re-exported here so every existing importer of
 * `@lobu/core` keeps resolving the same one implementation.
 */
export {
  sanitizeSuggestionPrompts,
  SUGGESTION_LIMITS,
  type SuggestedPrompt,
} from "./suggestions";

/**
 * Skill registry entry (global or per-agent).
 */
export interface RegistryEntry {
  id: string;
  type: string;
  apiUrl: string;
}

// Re-export the agent-settings nested types from the single TypeBox-schema
// source so the @lobu/core public surface (index.ts re-exports these via
// `./types`) and any core-internal `from "./types"` import resolve to the
// schema's Static<> definitions. This is what makes the schema the real single
// source: the hand-written interfaces that used to live above were removed and
// these names now point at one definition in ./contracts/agent-settings.
export type {
  AgentInlineGuardrail,
  NetworkConfig,
  NixConfig,
  SkillConfig,
  SkillsConfig,
  ThinkingLevel,
  ToolsConfig,
} from "./contracts/agent-settings";
