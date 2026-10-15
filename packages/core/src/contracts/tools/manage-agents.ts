import { type Static, Type } from "@sinclair/typebox";
import type { ActionInput } from "./action-input";

// ============================================
// Typebox Schema (union of per-action variants)
// ============================================
//
// The wire schema flattens this union into ONE MCP object and merges duplicate
// properties first-occurrence-wins, so a property carried by more than one
// variant must read true for every one of them.

const AgentId = Type.String({
  description: 'Agent ID (lowercase slug, e.g. "support").',
});

// Editable fields carry an `x-lobu-field` annotation — the single source of
// truth the field engine loops over to drive create/update/proposal/pre-image
// (so adding a field is one annotated entry, not edits in seven places). The
// `store` routes the write: `column` = an `agents` table column; `model` =
// the settings row's `models[0]`. `create` and `update` share this set; the
// annotation survives `Type.Optional`.
const AgentFields = {
  name: Type.String({
    description: "[create/update] Display name for the agent.",
    "x-lobu-field": { store: "column" },
  }),
  description: Type.String({
    description: "[create/update] Agent description.",
    "x-lobu-field": { store: "column" },
  }),
  identity_md: Type.String({
    description: "[create/update] Agent identity / system prompt (Markdown).",
    "x-lobu-field": { store: "column" },
  }),
  default_model: Type.String({
    description:
      '[create/update] Default model as an explicit "<provider>/<model>" ref (e.g. "anthropic/claude-sonnet-5"). Validated against the org\'s connected providers. Without it the agent inherits the org default model; if the org has none the agent is not runnable. Pass an empty string to clear it and fall back to the org default.',
    "x-lobu-field": { store: "model", emptyClears: true },
  }),
};

export const ListAgentsAction = Type.Object({
  action: Type.Literal("list", { description: "List org agents." }),
});

export const GetAgentAction = Type.Object({
  action: Type.Literal("get", { description: "Fetch one agent." }),
  agent_id: AgentId,
});

export const CreateAgentAction = Type.Object({
  action: Type.Literal("create", {
    description: "Create an agent owned by the caller (queued for approval).",
  }),
  agent_id: AgentId,
  name: AgentFields.name,
  description: Type.Optional(AgentFields.description),
  identity_md: Type.Optional(AgentFields.identity_md),
  default_model: Type.Optional(AgentFields.default_model),
});

export const UpdateAgentAction = Type.Object({
  action: Type.Literal("update", {
    description: "Patch agent fields (queued for approval).",
  }),
  agent_id: AgentId,
  name: Type.Optional(AgentFields.name),
  description: Type.Optional(AgentFields.description),
  identity_md: Type.Optional(AgentFields.identity_md),
  default_model: Type.Optional(AgentFields.default_model),
});

export const DeleteAgentAction = Type.Object({
  action: Type.Literal("delete", {
    description: "Delete an agent (queued for approval).",
  }),
  agent_id: AgentId,
});

export const ManageAgentsSchema = Type.Union([
  ListAgentsAction,
  GetAgentAction,
  CreateAgentAction,
  UpdateAgentAction,
  DeleteAgentAction,
]);

// ============================================
// Type Definitions
// ============================================

export type ManageAgentsArgs = Static<typeof ManageAgentsSchema>;

export type AgentCreateInput = ActionInput<ManageAgentsArgs, "create">;
export type AgentUpdateInput = ActionInput<ManageAgentsArgs, "update">;

export interface AgentRecord {
  id: string;
  name: string;
  description: string | null;
  owner_platform: string | null;
  owner_user_id: string | null;
  created_at: string;
  last_used_at: string | null;
}

/**
 * Where an agent's effective model came from, so a caller can tell a runnable
 * agent from one that only works because the org happens to have a default
 * (and would break if that default changed). Returned by `get`.
 *
 *   - `agent`: the agent pins its own `default_model` (`models[0]`).
 *   - `org_default`: the agent pins nothing; it inherits the org default model.
 *   - `none`: the agent pins nothing AND the org has no default — NOT runnable.
 */
export type ModelSource = "agent" | "org_default" | "none";

export interface AgentModelInfo {
  /** The configured model ref before provider fallback, or null when none resolves. */
  effective_model: string | null;
  /** Which layer supplied `effective_model`. */
  source: ModelSource;
  /**
   * True when no model resolves or the cloud provider preflight rejects every
   * listed candidate using the agent owner's credentials. Provider checks run
   * when the gateway catalog is available; false does not guarantee a
   * successful run or describe device-local execution.
   */
  not_runnable: boolean;
}

export type ManageAgentsResult =
  | { action: "list"; agents: AgentRecord[] }
  | { action: "get"; agent: AgentRecord; model: AgentModelInfo }
  | {
      action: "create";
      agent_id: string;
      created: boolean;
      /**
       * The agent's model after create. `not_runnable: true` is the actionable
       * signal that no runnable model resolved (no `default_model` given and
       * no org default, or the model's provider is not connected) — set a
       * routable `default_model` on create/update or connect its provider.
       */
      model: AgentModelInfo;
    }
  | {
      action: "update";
      agent_id: string;
      updated_fields: string[];
      /** Fields a stale approval skipped because another writer changed them first. */
      skipped_fields?: string[];
      /** The agent's model after update (present when the effective model is known). */
      model?: AgentModelInfo;
    }
  | { action: "delete"; agent_id: string; deleted: boolean }
  | {
      action: "create" | "update" | "delete";
      run_id: number;
      event_id?: number;
      status: "pending_approval";
      message: string;
      // The proposed change + current agent row, so the worker can forward an
      // approval card (run_id + diff) into the chat without a second fetch.
      proposal: ManageAgentsProposal;
      current: Record<string, unknown> | null;
    };

/** Proposed mutation held in `runs.action_input` for a builder-gate run. */
export interface ManageAgentsProposal {
  action: "create" | "update" | "delete";
  agent_id: string;
  name?: string;
  description?: string;
  identity_md?: string;
  /**
   * Default model ref for the agent (`models[0]`). Empty string clears it back
   * to the org default. Validated at request time against the org's providers,
   * so an unapprovable proposal is rejected before the card is shown.
   */
  default_model?: string;
  /**
   * Pre-image of the fields this update proposes to change, captured when the
   * update was queued. On approve, applyUpdate only overwrites a field whose
   * live value still equals its pre-image — so a stale approval never clobbers a
   * newer human edit to that field. Present only for queued `update` proposals.
   */
  base?: {
    name?: string | null;
    description?: string | null;
    identity_md?: string | null;
    /** Pre-image of `models[0]` (the default model ref), or null when unset. */
    default_model?: string | null;
  };
}
