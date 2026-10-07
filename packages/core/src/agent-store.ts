/**
 * AgentStore — unified interface for agent configuration storage.
 *
 * Implementations:
 *   - InMemoryAgentStore (SDK-embedded mode, populated from `GatewayConfig.agents`)
 *   - Host-provided store (embedded backend, e.g. PostgresAgentStore in Lobu)
 */

import type { AgentSettingsStored } from "./contracts/agent-settings";
import type { AuthProfile } from "./types";

// ── Agent Settings ──────────────────────────────────────────────────────────

/**
 * Agent settings — configurable per agentId.
 *
 * Canonical shape, derived from {@link AgentSettingsStoredSchema} (TypeBox) in
 * `./contracts/agent-settings.ts` — the single source shared by every surface
 * (declarative `lobu.config.ts`, CLI apply, admin tools, REST/MCP, Owletto UI,
 * persistence, worker wire). Drift between surfaces is now a compile error,
 * not a shipped-three-quarters-complete feature.
 *
 * `authProfiles` is the one field NOT in the stored schema: Postgres keeps it
 * in a separate table and the GET route merges it dynamically
 * (`agent-routes.ts:1315,1686`), so it's layered on here as a runtime-only
 * superset field. `updatedAt` is store-owned (set by the DB on every write).
 */
export type AgentSettings = AgentSettingsStored & {
  /**
   * Reusable auth profiles persisted by host stores (e.g. Lobu's Postgres
   * store). Lobu's gateway runtime uses UserAuthProfileStore instead, but the
   * host's settings JSON column still round-trips this list. NOT in the stored
   * schema — separate-store, merged on GET.
   */
  authProfiles?: AuthProfile[];
};

// ── Agent Metadata ──────────────────────────────────────────────────────────

export interface AgentMetadata {
  agentId: string;
  name: string;
  description?: string;
  owner: { platform: string; userId: string };
  /**
   * Owning organization id. Optional in the type for back-compat with
   * in-memory stores that predate per-tenant scoping; populated by the
   * postgres-backed store. The public Agent API route reads this to stamp
   * worker tokens with the agent's org so the egress proxy can scope
   * per-tenant gates (grants, judge cache, judge policy).
   */
  organizationId?: string;
  createdAt: number;
  lastUsedAt?: number;
}

// ── Connections ─────────────────────────────────────────────────────────────

export interface ConnectionSettings {
  allowFrom?: string[];
  allowGroups?: boolean;
  userConfigScopes?: string[];
}

export interface StoredConnection {
  id: string;
  platform: string;
  /** Verified Lobu creator, recorded on first insert and preserved on updates. */
  createdBy?: string;
  agentId?: string;
  /**
   * Organization id this connection belongs to. Optional in the type for
   * back-compat with in-memory tests, but required at the storage layer
   * (`connections.organization_id` is NOT NULL post-unify).
   */
  organizationId?: string;
  config: Record<string, any>;
  settings: ConnectionSettings;
  metadata: Record<string, any>;
  status: "active" | "stopped" | "error";
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

// ── Grants ──────────────────────────────────────────────────────────────────

/** Grant kind. Domain grants and MCP-tool grants share the same store but
 *  callers (UI, audit) often want to filter to one. The MCP path is detected
 *  by the leading slash in the pattern. */
export type GrantKind = "domain" | "mcp_tool";

export interface Grant {
  pattern: string;
  kind: GrantKind;
  expiresAt: number | null;
  grantedAt: number;
  denied?: boolean;
}

export function inferGrantKind(pattern: string): GrantKind {
  return pattern.startsWith("/") ? "mcp_tool" : "domain";
}

// ── Sub-Store Interfaces ──────────────────────────────────────────────────

/**
 * Agent identity & configuration storage.
 * Settings (model, skills, providers, etc.) + metadata (name, owner, etc.)
 */
export interface AgentConfigStore {
  getSettings(agentId: string): Promise<AgentSettings | null>;
  saveSettings(agentId: string, settings: AgentSettings): Promise<void>;
  updateSettings(
    agentId: string,
    updates: Partial<AgentSettings>
  ): Promise<void>;
  deleteSettings(agentId: string): Promise<void>;
  hasSettings(agentId: string): Promise<boolean>;

  getMetadata(agentId: string): Promise<AgentMetadata | null>;
  saveMetadata(agentId: string, metadata: AgentMetadata): Promise<void>;
  updateMetadata(
    agentId: string,
    updates: Partial<AgentMetadata>
  ): Promise<void>;
  deleteMetadata(agentId: string): Promise<void>;
  hasAgent(agentId: string): Promise<boolean>;
  listAgents(): Promise<AgentMetadata[]>;
}

/**
 * Platform wiring storage.
 * Runtime connections (Telegram, Slack, etc.). Channel subscriptions are
 * canonical Automations and are resolved by the server's Automation store.
 */
export interface AgentConnectionStore {
  getConnection(connectionId: string): Promise<StoredConnection | null>;
  listConnections(filter?: {
    agentId?: string;
    platform?: string;
  }): Promise<StoredConnection[]>;
  saveConnection(connection: StoredConnection): Promise<void>;
  updateConnection(
    connectionId: string,
    updates: Partial<StoredConnection>
  ): Promise<void>;
  deleteConnection(connectionId: string): Promise<void>;
}

/**
 * User-agent ownership storage. Domain/MCP grants live in GrantStore
 * (`public.grants`), not here.
 */
export interface AgentAccessStore {
  addUserAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<void>;
  removeUserAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<void>;
  listUserAgents(platform: string, userId: string): Promise<string[]>;
  ownsAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<boolean>;
}

// ── AgentStore (full intersection) ────────────────────────────────────────

/**
 * Full storage interface — intersection of all sub-stores.
 * Implementations (InMemoryAgentStore, etc.) satisfy all 3.
 * Hosts can provide individual sub-stores via GatewayOptions instead.
 */
export type AgentStore = AgentConfigStore &
  AgentConnectionStore &
  AgentAccessStore;
