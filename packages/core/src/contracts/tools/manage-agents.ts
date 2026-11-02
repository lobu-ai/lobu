import { type Static, Type } from "@sinclair/typebox";
import {
  AgentSettingsStoredSchema,
  AgentSettingsPatchSchema,
} from "../agent-settings";
import type { ActionInput } from "./action-input";

// Identity keeps its existing identity_md write spelling. updatedAt is store-owned.
const AgentSettingsUpdateSchema = Type.Omit(
  AgentSettingsPatchSchema,
  ["identityMd"],
  {
    additionalProperties: false,
    description:
      "Canonical agent settings patch. Omitted keys preserve stored values; supplied settings replace that top-level value. Empty strings/arrays/objects clear where allowed. Identity is written through identity_md.",
  }
);

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
      '[create/update] Default model (updates preserve the existing fallback entries) as an explicit "<provider>/<model>" ref (e.g. "anthropic/claude-sonnet-5"). Validated against the org\'s connected providers. Without it the agent inherits the org default model; if the org has none the agent is not runnable. Pass an empty string to clear it and fall back to the org default.',
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

export const AgentConfigRevisionSchema = Type.String({
  pattern: "^[a-f0-9]{64}$",
  description:
    "Opaque agent configuration revision returned by agents.get. A stale expected_revision rejects the entire update with 409 before any write or approval is queued. Omit for an unconditional update.",
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
  settings: Type.Optional(AgentSettingsUpdateSchema),
  expected_revision: Type.Optional(AgentConfigRevisionSchema),
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

export const AgentRecordSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  owner_platform: Type.Union([Type.String(), Type.Null()]),
  owner_user_id: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  last_used_at: Type.Union([Type.String(), Type.Null()]),
});
export type AgentRecord = Static<typeof AgentRecordSchema>;

export const AgentModelInfoSchema = Type.Object({
  effective_model: Type.Union([Type.String(), Type.Null()], {
    description:
      "Configured model ref before provider fallback, or null when none resolves.",
  }),
  source: Type.Union([
    Type.Literal("agent"),
    Type.Literal("org_default"),
    Type.Literal("none"),
  ]),
  not_runnable: Type.Boolean({
    description:
      "No model resolves or provider preflight rejects every candidate. False does not guarantee a successful run or describe device-local execution.",
  }),
});
export type AgentModelInfo = Static<typeof AgentModelInfoSchema>;
export type ModelSource = AgentModelInfo["source"];

const SettingsPreimageSchema = Type.Mapped(
  Type.KeyOf(AgentSettingsUpdateSchema),
  (key) =>
    Type.Optional(
      Type.Union([Type.Index(AgentSettingsUpdateSchema, key), Type.Null()])
    )
);
const AgentPreimageSchema = Type.Partial(
  Type.Object({
    name: Type.Union([AgentFields.name, Type.Null()]),
    description: Type.Union([AgentFields.description, Type.Null()]),
    identity_md: Type.Union([AgentFields.identity_md, Type.Null()]),
    default_model: Type.Union([AgentFields.default_model, Type.Null()]),
    settings: SettingsPreimageSchema,
  })
);

/** Proposed mutation held on an approval run. Only touched keys have pre-images. */
export const ManageAgentsProposalSchema = Type.Composite([
  Type.Omit(UpdateAgentAction, ["action", "expected_revision"]),
  Type.Object({
    action: Type.Union([
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("delete"),
    ]),
    base: Type.Optional(AgentPreimageSchema),
  }),
]);
export type ManageAgentsProposal = Static<typeof ManageAgentsProposalSchema>;

export const ManageAgentsResultSchema = Type.Union([
  Type.Object({
    action: Type.Literal("list"),
    agents: Type.Array(AgentRecordSchema),
  }),
  Type.Object({
    action: Type.Literal("get"),
    agent: AgentRecordSchema,
    model: AgentModelInfoSchema,
    settings: AgentSettingsStoredSchema,
    revision: AgentConfigRevisionSchema,
  }),
  Type.Object({
    action: Type.Literal("create"),
    agent_id: AgentId,
    created: Type.Boolean(),
    model: AgentModelInfoSchema,
  }),
  Type.Object({
    action: Type.Literal("update"),
    agent_id: AgentId,
    updated_fields: Type.Array(Type.String()),
    skipped_fields: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Fields skipped because they changed since approval was requested.",
      })
    ),
    model: Type.Optional(AgentModelInfoSchema),
  }),
  Type.Object({
    action: Type.Literal("delete"),
    agent_id: AgentId,
    deleted: Type.Boolean(),
  }),
  Type.Object({
    action: Type.Union([
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("delete"),
    ]),
    run_id: Type.Number(),
    event_id: Type.Optional(Type.Number()),
    status: Type.Literal("pending_approval"),
    message: Type.String(),
    proposal: ManageAgentsProposalSchema,
    current: Type.Union([
      Type.Partial(
        Type.Composite([
          AgentRecordSchema,
          Type.Object({
            identity_md: Type.Union([Type.String(), Type.Null()]),
            settings: SettingsPreimageSchema,
          }),
        ])
      ),
      Type.Null(),
    ]),
  }),
]);
export type ManageAgentsResult = Static<typeof ManageAgentsResultSchema>;
