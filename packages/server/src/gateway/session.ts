import type {
  DeviceExecutionTarget,
  NetworkConfig,
  NixConfig,
} from "@lobu/core";
import type { ExecutionMode } from "../runs/run-types.js";

/**
 * Platform-agnostic session types and utilities
 * These types are used by all chat platforms for session tracking
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Thread session data structure
 * Tracks the state of a conversation thread across any platform
 */
export interface ThreadSession {
  conversationId: string; // Primary identifier (agentId for API platform)
  channelId: string;
  userId: string;
  threadCreator?: string; // Track the original thread creator
  jobName?: string;
  lastActivity: number;
  createdAt: number;
  botResponseId?: string; // Bot's response message ID for updates
  status?: string; // Session status (created, active, completed, error)
  // API session parameters
  workingDirectory?: string;
  provider?: string;
  /** Model to use for the agent (e.g., claude-sonnet-4-20250514) */
  model?: string;
  /** Immutable execution placement for app chat; absence means managed Lobu. */
  executionTarget?: DeviceExecutionTarget;
  /** Per-agent network configuration for sandbox isolation */
  networkConfig?: NetworkConfig;
  /** Nix environment configuration for agent workspace */
  nixConfig?: NixConfig;
  /** Original agent ID (before composite session key generation) */
  agentId?: string;
  /**
   * Owning organization of the agent. Cached at session-create time so the
   * message-send path can stamp it on the queue payload without re-reading
   * `agent_metadata` for every message. DeploymentManager refuses
   * `grantStore.grant()` calls without an org id, so without this the very
   * first message after `lobu chat` would fail at worker spawn even though
   * the session itself was created cleanly.
   */
  organizationId?: string;
  /**
   * The authenticated HUMAN who created this session, when one did (web
   * settings session). Distinct from `userId`, which is only a routing key for
   * `buildApiConversationId` and may be supplied by the caller — so it proves
   * nothing about identity. Org members may USE an agent they do not own
   * (see `authorizeAgentAccess`), and this field is what keeps one member out
   * of another member's conversation.
   */
  createdByUserId?: string;
  /** Process without persisting history */
  dryRun?: boolean;
  /** Internal automation intent for one-shot system sessions. */
  intent?: { kind: "automation_run"; runId: number; automationId: number };
  /**
   * Server-derived side-effect mode for a verified Automation session. Set once
   * from the run row at session creation (automation-run-intent.ts) and never
   * from the caller; `capture` marks an eval replay whose writes must be
   * recorded instead of performed. Carried onto the queue payload and then
   * into the signed worker token, so enforcement never re-derives it.
   */
  executionMode?: ExecutionMode;
}

/**
 * Compute session key for the session store.
 * For API platform: just conversationId (which equals agentId)
 * For Slack/WhatsApp: channelId:conversationId
 */
export function computeSessionKey(session: {
  channelId: string;
  conversationId: string;
}): string {
  // For API platform, channelId starts with "api-" or "api_" and we just use conversationId
  if (
    session.channelId.startsWith("api-") ||
    session.channelId.startsWith("api_") ||
    session.channelId === session.conversationId
  ) {
    return session.conversationId;
  }
  // For other platforms, use channelId:conversationId
  return `${session.channelId}:${session.conversationId}`;
}

/**
 * Session store interface
 * Platform adapters use this to store and retrieve session data
 */
export interface SessionStore {
  get(sessionKey: string): Promise<ThreadSession | null>;
  set(sessionKey: string, session: ThreadSession): Promise<void>;
  delete(sessionKey: string): Promise<void>;
  getByThread(
    channelId: string,
    threadTs: string
  ): Promise<ThreadSession | null>;
  /** Optional cleanup; only needed for stores without intrinsic TTL. */
  cleanup?(ttl: number): Promise<number>;
}

/**
 * Session manager interface
 * Provides high-level session management operations
 */
export interface ISessionManager {
  createSession(
    channelId: string,
    userId: string,
    conversationId?: string,
    threadCreator?: string
  ): Promise<ThreadSession>;
  getSession(sessionKey: string): Promise<ThreadSession | null>;
  findSessionByThread(
    channelId: string,
    threadTs: string
  ): Promise<ThreadSession | null>;
  updateSession(
    sessionKey: string,
    updates: Partial<ThreadSession>
  ): Promise<void>;
  setSession(session: ThreadSession): Promise<void>;
  deleteSession(sessionKey: string): Promise<void>;
  validateThreadOwnership(
    channelId: string,
    threadTs: string,
    userId: string
  ): Promise<{ allowed: boolean; owner?: string }>;
  touchSession(sessionKey: string): Promise<void>;
  cleanupExpired(ttl: number): Promise<number>;
}
