import { type Static, Type } from "@sinclair/typebox";

const AutomationTriggerMatchValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

/**
 * Connector event activation for an Automation. Triggers and context sources are
 * deliberately separate: a trigger decides when to run, while a source only
 * decides which durable data is available to that run.
 */
export const AutomationEventTriggerSchema = Type.Object(
  {
    kind: Type.Literal("event"),
    source: Type.Optional(
      Type.Literal("connector", {
        description:
          'Event provenance. Omitted legacy triggers normalize to "connector".',
      })
    ),
    connector_key: Type.String({ minLength: 1, maxLength: 100 }),
    connection_id: Type.Optional(Type.Integer({ minimum: 1 })),
    event_types: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
    match: Type.Optional(
      Type.Record(Type.String(), AutomationTriggerMatchValueSchema, {
        description:
          "Connector-normalized exact-match fields such as resource_ref or channel_id.",
      })
    ),
    execution: Type.Optional(
      Type.Union([Type.Literal("turn"), Type.Literal("window")], {
        description:
          '"turn" renders the incoming event as the agent input (chat/listen); "window" runs the Automation analysis flow.',
        default: "turn",
      })
    ),
    active_run: Type.Optional(
      Type.Union(
        [
          Type.Literal("queue"),
          Type.Literal("coalesce"),
          Type.Literal("steer"),
        ],
        {
          description:
            "What to do when this Automation is busy: queue every event, combine waiting events, or steer the current trusted chat turn.",
          default: "queue",
        }
      )
    ),
    output: Type.Optional(
      Type.Union([Type.Literal("silent"), Type.Literal("reply_to_source")], {
        description:
          "Keep the result in Lobu or send it back through the source connector when supported.",
        default: "silent",
      })
    ),
    skip_if_unchanged: Type.Optional(
      Type.Boolean({
        description:
          "For window execution, do not enqueue an agent run when connector polling produced no durable source change.",
        default: true,
      })
    ),
  },
  { additionalProperties: false }
);
export type AutomationEventTrigger = Static<
  typeof AutomationEventTriggerSchema
>;

/**
 * Activation from an event already written to the Lobu workspace by another
 * Automation. Workspace and connector activations share the public `event`
 * primitive; `source` preserves their provenance and selects the appropriate
 * delivery and authorization path.
 *
 * In v1 only declared Automation event outputs emit this activation. Ordinary
 * knowledge saves and connector ingestion remain durable data, not implicit
 * workflow commands.
 */
export const AutomationWorkspaceEventTriggerSchema = Type.Object(
  {
    kind: Type.Literal("event"),
    source: Type.Literal("workspace"),
    entity_type: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100,
        description:
          "Optional entity-type slug. When set, the event must be linked to an entity of this type.",
      })
    ),
    event_types: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
      description:
        "Exact durable event semantic types that activate this Automation.",
    }),
    match: Type.Optional(
      Type.Record(Type.String(), AutomationTriggerMatchValueSchema, {
        description: "Exact-match fields from the durable event metadata.",
      })
    ),
    execution: Type.Optional(
      Type.Union([Type.Literal("turn"), Type.Literal("window")], {
        description:
          '"turn" handles the exact event pointer once; "window" runs the Automation analysis flow.',
        default: "window",
      })
    ),
    active_run: Type.Optional(
      Type.Union([Type.Literal("queue"), Type.Literal("coalesce")], {
        description:
          "What to do when this Automation is busy: queue every event or combine waiting events.",
        default: "coalesce",
      })
    ),
  },
  { additionalProperties: false }
);
export type AutomationWorkspaceEventTrigger = Static<
  typeof AutomationWorkspaceEventTriggerSchema
>;

/**
 * Apply the event execution default once for every consumer of the shared
 * trigger primitive. Connector events default to conversational turns;
 * workspace events default to analysis windows.
 */
export function resolvedEventExecution(
  trigger: AutomationEventTrigger | AutomationWorkspaceEventTrigger
): "turn" | "window" {
  return (
    trigger.execution ?? (trigger.source === "workspace" ? "window" : "turn")
  );
}

export function normalizeWorkspaceEventTrigger(
  trigger: AutomationWorkspaceEventTrigger
): AutomationWorkspaceEventTrigger {
  return {
    ...trigger,
    entity_type: trigger.entity_type?.trim() || undefined,
    event_types: Array.from(new Set(trigger.event_types)),
    match:
      trigger.match && Object.keys(trigger.match).length > 0
        ? trigger.match
        : undefined,
    execution: resolvedEventExecution(trigger),
    active_run: trigger.active_run ?? "coalesce",
  };
}

export const AutomationScheduleTriggerSchema = Type.Object(
  {
    kind: Type.Literal("schedule"),
    cron: Type.String({ minLength: 1, maxLength: 120 }),
    timezone: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])
    ),
    execution: Type.Optional(Type.Literal("window", { default: "window" })),
    active_run: Type.Optional(
      Type.Literal("coalesce", {
        default: "coalesce",
      })
    ),
    skip_if_unchanged: Type.Optional(Type.Boolean({ default: true })),
  },
  { additionalProperties: false }
);
export type AutomationScheduleTrigger = Static<
  typeof AutomationScheduleTriggerSchema
>;

export const AutomationTriggerSchema = Type.Union([
  AutomationEventTriggerSchema,
  AutomationWorkspaceEventTriggerSchema,
  AutomationScheduleTriggerSchema,
]);
export type AutomationTrigger = Static<typeof AutomationTriggerSchema>;

export const AutomationSourceSchema = Type.Object({
  name: Type.String(),
  query: Type.String(),
  // When true, this SQL source is CONTEXT (like an @entity ref), not event
  // content: its rows are handed to the agent for reasoning but are NOT linked
  // into the window's event set. Use it to feed a filtered set of entities the
  // agent should look at (e.g. duplicate-merge candidates) — the raw `id` it
  // projects is an entity id, not an `events.id`, so it must NOT go through the
  // automation_run_events FK. A plain (non-context) SQL source stays event
  // content and its `id` must be an `events.id`.
  context: Type.Optional(Type.Boolean()),
});
export type AutomationSource = Static<typeof AutomationSourceSchema>;

/**
 * Persist extracted rows as entities of one declared type. `key` is scoped to
 * the producing Automation, so retries and later windows update the same entity
 * without claiming that two independent producers necessarily mean the same
 * real-world identity. The stable key is server-internal and never appears in
 * the model's output contract.
 */
export const AutomationEntityOutputSchema = Type.Object(
  {
    entity: Type.String({
      minLength: 1,
      pattern: "^\\S(?:[\\s\\S]*\\S)?$",
      description:
        "Stored entity-type slug for every row in this output array.",
    }),
    key: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      description:
        "One to four fields whose exact non-blank string (up to 256 UTF-8 bytes), safe-integer, or boolean values compose each row's stable identity across Automation runs. Every key field is required in every row; changing the fields, their order, the output name, or the entity type changes identity. Use durable source IDs rather than editable labels.",
    }),
    name: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description:
          "Fields used for the human-readable entity name. Defaults to key.",
      })
    ),
  },
  { additionalProperties: false }
);
export type AutomationEntityOutput = Static<
  typeof AutomationEntityOutputSchema
>;

/**
 * Persist each row as an append-only event. The semantic type is fixed by the
 * Automation version; the row supplies the standard event draft fields.
 *
 * With `key`, the draft's key fields (read from its `metadata`) compose a
 * stable identity: each run supersedes the current head event carrying the
 * same key values instead of appending a sibling, so the type keeps exactly
 * one current event per key while history stays append-only. This is the event
 * analogue of the entity output's keyed upsert — use it for refined-over-time
 * state (voice profiles, digests, statuses) rather than per-source-item logs.
 *
 * The identity is derived server-side and stored on the row (`events.identity_*`),
 * so it is scoped to the semantic type rather than to the Automation: an event that
 * predates the Automation now maintaining it can be adopted into the chain, and
 * "exactly one current per key" is a unique-index guarantee rather than a
 * convention two concurrent runs can silently break. Rows carrying no identity
 * are inert — never a supersede target — so a keyed output cannot capture an
 * unrelated event that happens to share metadata.
 */
export const AutomationEventOutputSchema = Type.Object(
  {
    event: Type.String({
      minLength: 1,
      pattern: "^\\S(?:[\\s\\S]*\\S)?$",
      description:
        "Semantic type assigned to every event in this output array.",
    }),
    key: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
        minItems: 1,
        maxItems: 4,
        uniqueItems: true,
        description:
          "One to four metadata fields whose exact values compose each draft's stable identity across Automation runs (e.g. channel + mode for per-channel voice profiles). Every key field must be present in every draft's `metadata` and be a non-blank string, safe integer, or boolean — the type is part of the identity, so 3 and \"3\" are different keys. Changing the fields, their order, or the semantic type changes identity and starts a new chain. When set, each run supersedes the current event carrying the same key values.",
      })
    ),
  },
  { additionalProperties: false }
);
export type AutomationEventOutput = Static<typeof AutomationEventOutputSchema>;

export const AutomationOutputSchema = Type.Union([
  AutomationEntityOutputSchema,
  AutomationEventOutputSchema,
]);
export type AutomationOutput = Static<typeof AutomationOutputSchema>;

export const AutomationOutputsSchema = Type.Object(
  {},
  {
    additionalProperties: AutomationOutputSchema,
    minProperties: 1,
    maxProperties: 20,
    description:
      "Named top-level arrays persisted after a completed window. Entity outputs are validated against their entity type; event rows require content and may include title, metadata, author, source_url, occurred_at, parent_event_id, payload_type, and idempotency_key.",
  }
);
// TypeBox deliberately types an open `Type.Object` as unknown-valued. Keep the
// runtime schema open for user-chosen output names while exposing the actual
// value contract to TypeScript consumers.
export type AutomationOutputs = Record<string, AutomationOutput>;

export const AutomationScriptExecutorSchema = Type.Object(
  {
    kind: Type.Literal("script"),
    source: Type.String({ minLength: 1, maxLength: 131072 }),
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  {
    additionalProperties: false,
    description:
      "Run this TypeScript module directly in the Automation sandbox. Export default async (ctx, client). The runtime pins the script and window at activation and completes the run only after success. SDK writes retain the owning agent's permissions. Use ctx.window.run_id for retry idempotency.",
  }
);
export type AutomationScriptExecutor = Static<
  typeof AutomationScriptExecutorSchema
>;

export const AutomationExecutionConfigSchema = Type.Object(
  {
    executor: Type.Optional(AutomationScriptExecutorSchema),
    timeout_seconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 86_400,
        description:
          "Wall-clock cap in seconds for the device-worker CLI run (default 600).",
      })
    ),
    max_budget_usd: Type.Optional(
      Type.Number({
        minimum: 0,
        description:
          "Per-run dollar ceiling (claude only: --max-budget-usd). No-op on other CLIs.",
      })
    ),
    model: Type.Optional(
      Type.String({
        description:
          "Model override for this Automation. ONE field, two namespaces, resolved by where the Automation runs: a device-pinned Automation (device_worker_id set) passes this verbatim to the local CLI as --model, so it must name a provider that CLI has registered (e.g. 'opencode-go/deepseek-v4-flash'); a server-dispatched Automation resolves it against the org's model providers -- the built-in providers plus any you have registered under Providers (e.g. 'openai/gpt-4.1', 'deepseek/deepseek-v4-flash') -- or 'auto'. The two are NOT interchangeable — a CLI ref on the server lane fails at the provider, and a server ref on a device lane fails at the CLI.",
      })
    ),
    permission_mode: Type.Optional(
      Type.Union(
        [
          Type.Literal("acceptEdits"),
          Type.Literal("auto"),
          Type.Literal("bypassPermissions"),
          Type.Literal("default"),
          Type.Literal("dontAsk"),
          Type.Literal("plan"),
        ],
        {
          description: "Tool permission mode (claude only: --permission-mode).",
        }
      )
    ),
    effort: Type.Optional(
      Type.String({
        description: "Reasoning effort accepted by the selected CLI and model.",
      })
    ),
    finalize_nudges: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 5,
        description:
          "How many extra times to re-dispatch a server-side Automation run that finished WITHOUT calling complete_window before failing it. 0 disables; omitted = global default.",
      })
    ),
  },
  {
    additionalProperties: false,
    description:
      "[create/update] Per-Automation execution settings: device-worker CLI flags plus the server-side finalize-nudge budget. Omitted fields fall back to dispatcher/CLI/global defaults; pass null to clear.",
  }
);
export type AutomationExecutionConfig = Static<
  typeof AutomationExecutionConfigSchema
>;

export const AutomationDeliveryTargetSchema = Type.Object(
  {
    connection_id: Type.Integer({
      minimum: 1,
      description:
        "Numeric ID of the active chat connection that owns the bound channel.",
    }),
    channel_id: Type.String({
      minLength: 1,
      description:
        'Bound channel key, preferably platform-prefixed (for example "slack:C0123ABCD").',
    }),
  },
  {
    additionalProperties: false,
    description:
      "Strict destination for notifications emitted by this Automation. The channel must already be bound to the Automation's agent. Null clears the destination.",
  }
);
export type AutomationDeliveryTarget = Static<
  typeof AutomationDeliveryTargetSchema
>;

/**
 * Local CLI runtimes a device-pinned Automation can name in `agent_kind`.
 *
 * This is the write-side half of a contract whose other half is the device
 * `AgentSpec` table (`@lobu/core/contracts/worker/device-automation`, shared by
 * the connector-worker daemon and the Mac app): the device resolves the
 * Automation's kind against that table at dispatch. A kind with no spec there
 * produces a run that fails on the device with "no local agent executor
 * configured", so accepting an arbitrary string here only defers the failure
 * to a place nobody is watching (#2504).
 *
 * Adding a CLI means adding an `AgentSpec` there AND a literal here. The gateway
 * persists what a device advertises on poll (`device_workers.agent_kinds`) and
 * uses it to withhold runs from devices that can't execute them, but that is a
 * per-device set, not the product-wide vocabulary this list defines.
 */
const DEVICE_AGENT_KIND_LITERALS = [
  Type.Literal("claude-code"),
  Type.Literal("codex"),
  Type.Literal("opencode"),
  Type.Literal("pi"),
  Type.Literal("agy"),
];

// ============================================
// Typebox Schema (Flattened for MCP)
// ============================================

// Source definition — named SQL query
export const SourceSchema = Type.Object({
  name: Type.String({ description: 'Source name (e.g., "content", "volume")' }),
  query: Type.String({
    description:
      "SQL SELECT query. If it references the events table, time window bounds are auto-applied.",
  }),
  context: Type.Optional(
    Type.Boolean({
      description:
        "When true, the source is CONTEXT (like an @entity ref), not event content: its rows reach the agent but are NOT linked into the window's event set, so the `id` it projects may be an entity id rather than an events.id. Use for feeding a filtered entity set (e.g. duplicate-merge candidates) the agent should reason over.",
    })
  ),
});

/**
 * One agent skill pinned into an Automation version.
 *
 * The `content` is a SNAPSHOT taken when the version was saved, not a live
 * reference. Editing the agent's skill library afterwards does not reach an
 * existing version; a caller must publish a new version, and `lobu apply`
 * re-resolves every reference on each run. Storing the body (rather than the
 * name alone) also lets a device-pinned Automation dispatch the frozen text to a
 * CLI with no channel back to the skill library.
 */
export const AutomationSkillSchema = Type.Object({
  name: Type.String({
    minLength: 1,
    pattern: "^[a-zA-Z0-9._-]+$",
    description:
      "Skill name, matching an entry in the owning agent's skill library. Identifies the skill for diffing a pinned snapshot against the library's current body.",
  }),
  content: Type.String({
    minLength: 1,
    description:
      "The skill body, frozen as of this version. Server-side agents receive it as `.skills/<name>/SKILL.md`; device executors receive the same frozen text in their per-run task.",
  }),
});

export type AutomationSkill = Static<typeof AutomationSkillSchema>;

/**
 * A single classifier definition embedded in an Automation version. The key
 * invariant for #2033 item 4 is `attribute_values`: it MUST be an object-MAP
 * keyed by value string, never an array. An array read back through
 * `Object.entries` becomes numeric keys `{"0":…}` and, after embedding
 * stripping, the corrupted `{"0":{},"1":{}}` — so we forbid the array shape at
 * the contract boundary. Other fields are extraction config and stay open
 * (`additionalProperties` allowed) to avoid breaking authored connectors.
 */
const AutomationClassifierDefinitionSchema = Type.Object(
  {
    slug: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    source_path: Type.Optional(Type.String()),
    value_field: Type.Optional(Type.String()),
    description_field: Type.Optional(Type.String()),
    examples_field: Type.Optional(Type.String()),
    attribute_key: Type.Optional(Type.String()),
    attribute_values: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), Type.Unknown(), {
        description:
          "Object MAP keyed by value string. An array here corrupts on read (#2033).",
      })
    ),
  },
  {
    additionalProperties: true,
    description:
      "Classifier definition. attribute_values MUST be an object map, not an array.",
  }
);

// Flattened schema for MCP compatibility (MCP doesn't support top-level unions)
export const ManageAutomationsSchema = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal("create", {
          description:
            "Create an Automation. Put the task statement in `prompt` and reusable know-how in `skills`; either satisfies the instruction requirement, and an event trigger with execution 'turn' may omit both.",
        }),
        Type.Literal("list", { description: "List Automations." }),
        Type.Literal("update", { description: "Patch Automation config." }),
        Type.Literal("create_version", {
          description: "Create a new versioned Automation config.",
        }),
        Type.Literal("complete_window", {
          description:
            "Submit an Automation window result and advance the Automation arrival mark. Required after every claim_next_window, including when the window held nothing actionable: the mark moves only inside this call, so an unfinished claim lets the lease expire, times the run out, and serves the same content again on the next claim.",
        }),
        Type.Literal("claim_next_window", {
          description:
            "Atomically claim the Automation unclaimed arrival window and return bounded source context plus a fenced window token. The window is [arrival mark, now - settle) over events.created_at, not a calendar period. The caller MUST finish the claim with complete_window, even for an empty or non-actionable window.",
        }),
        Type.Literal("trigger", {
          description:
            "Create or reuse an immediate Automation run. The result identifies whether Lobu, a device worker, this caller, or another external caller owns execution. Follow the returned next_action: a pending external run uses knowledge.read then automations.completeWindow, while the owner of an existing external lease resumes it with automations.claimNextWindow.",
        }),
        Type.Literal("delete", {
          description:
            "Archive one or more Automations (soft delete: status='archived', scheduling stops). Rows and versions are retained; no hard delete.",
        }),
        Type.Literal("set_reaction_script", {
          description: "Attach/remove a TypeScript reaction script.",
        }),
        Type.Literal("get_versions", {
          description: "List an Automation\u2019s version history.",
        }),
        Type.Literal("get_version_details", {
          description: "Fetch full version config.",
        }),
        Type.Literal("get_component_reference", {
          description: "Static component/data-type documentation.",
        }),
        Type.Literal("submit_feedback", {
          description: "Submit per-field corrections on a window.",
        }),
        Type.Literal("get_feedback", {
          description: "Retrieve feedback for an Automation.",
        }),
        Type.Literal("list_promoted", {
          description: "List entities promoted by an Automation.",
        }),
        Type.Literal("create_from_version", {
          description: "Create Automations per entity from a template version.",
        }),
      ],
      { description: "Action to perform" }
    ),
    lease_seconds: Type.Optional(
      Type.Integer({
        minimum: 30,
        maximum: 3600,
        description:
          "[claim_next_window] Lease duration in seconds (default 900).",
      })
    ),
    source_name: Type.Optional(
      Type.String({
        description:
          "Automation source name to continue; pair with source_cursor and the same run_id.",
      })
    ),
    source_cursor: Type.Optional(
      Type.String({
        description:
          "Signed window_token from the preceding page of this source. Retain every returned window_token for completeWindow.",
      })
    ),
    before_occurred_at: Type.Optional(
      Type.String({
        description:
          "[claim_next_window continuation] Cursor timestamp from context.page.next_cursor.",
      })
    ),
    before_id: Type.Optional(
      Type.Integer({
        description:
          "[claim_next_window continuation] Cursor id from context.page.next_cursor.",
      })
    ),

    // Automation identity (the persisted DB column is automation_id)
    automation_id: Type.Optional(
      Type.String({
        description:
          "[list/update/upgrade/get_versions/get_version_details/set_reaction_script/trigger] Automation ID (numeric string)",
      })
    ),
    automation_ids: Type.Optional(
      Type.Array(Type.String(), {
        description: "[delete] Array of Automation IDs (numeric strings)",
      })
    ),

    // Fields for action="create"
    slug: Type.Optional(
      Type.String({ description: "[create] Unique Automation identifier" })
    ),
    name: Type.Optional(
      Type.String({ description: "[create/create_version] Display name" })
    ),
    description: Type.Optional(
      Type.String({
        description: "[create/create_version] Automation description",
      })
    ),
    entity_id: Type.Optional(
      Type.Number({
        description:
          "Entity ID. Optional for create — provide it to attach the Automation to an entity; omit it for an org-scoped/global Automation. Optional for list.",
      })
    ),
    entity_ids: Type.Optional(
      Type.Array(Type.Number(), {
        description:
          "[create_from_version] Array of entity IDs to create individual Automations for.",
      })
    ),
    version_id: Type.Optional(
      Type.Number({
        description:
          "[create_from_version] Source version ID to use as template for new Automations.",
      })
    ),
    name_pattern: Type.Optional(
      Type.String({
        description:
          '[create_from_version] Name pattern for created Automations. Use {{entity_name}} for substitution. Default: "{version_name}: {entity_name}".',
      })
    ),

    // Automation config fields (create/create_version/update)
    prompt: Type.Optional(
      Type.String({
        description:
          "[create/create_version] Literal LLM instruction text for the Automation — the task statement, frozen into the version. No template expansion happens: the text is delivered to the agent verbatim, and the window's data (content, sources, entities, extraction_schema) arrives alongside it in the knowledge-read payload. Reusable know-how belongs in `skills` instead, which is delivered as readable files rather than pasted in here. A schedule trigger, an event trigger with execution 'window', and an Automation with no triggers each need an instruction source — supply `prompt`, `skills`, or both; an event trigger with execution 'turn' may omit both and use the built-in default.",
      })
    ),
    skills: Type.Optional(
      Type.Array(AutomationSkillSchema, {
        maxItems: 5,
        description:
          "[create/create_version] Up to 5 ordered agent skills pinned into this version as {name, content} snapshots. Server-side agents receive `.skills/<name>/SKILL.md` files; device executors receive the same frozen text in their per-run task. Snapshots, not live references: editing the agent's library later does not change an existing version until a caller publishes a new one (`lobu apply` re-resolves on every run). FULL REPLACEMENT on create_version — passing it (even []) makes it the complete set, and OMITTING it keeps the stored snapshots unchanged. Every name must exist and be enabled in the owning agent's library, or the call is rejected rather than silently running under-instructed.",
      })
    ),
    sources: Type.Optional(
      Type.Array(SourceSchema, {
        description:
          "[create/create_version] Array of SQL data sources. Each source is { name, query }. To change them on an existing Automation, publish a new version with action: 'create_version'. On create_version this array is the ONLY way to change them and is a FULL REPLACEMENT: passing it (even []) makes it the complete source set, [] clears everything, and OMITTING it keeps the stored sources unchanged. Instruction text is never an input: @-mention chips in an inherited prompt neither add nor remove sources. (On create only, chips in the prompt still seed the initial list, which is how the web composer authors them.) The response returns source_count and removed_sources so you can see what a replacement dropped.",
      })
    ),
    outputs: Type.Optional(
      Type.Union(
        [
          // Callers may pass a pre-serialized JSON string (parsed and
          // shape-checked by the server) or the object directly.
          Type.String(),
          AutomationOutputsSchema,
          Type.Null(),
        ],
        {
          description:
            '[create/create_version] Named durable outputs for window execution. `{ entity, key, name? }` validates and upserts entities; `{ event }` appends standard event drafts. The object key is the top-level extracted_data array name. Event rows require content and may include title, metadata, author, source_url, occurred_at, parent_event_id, payload_type, and idempotency_key. Event triggers on an Automation with outputs must use execution="window". Pass null on create_version to remove all declared outputs.',
        }
      )
    ),
    classifiers: Type.Optional(
      Type.Union(
        [
          // Callers may pass a pre-serialized JSON string (coerced by
          // parseJsonInput) or the array directly. Either way, the array shape
          // enforces `attribute_values` is a map, not an array (#2033 item 4).
          Type.String(),
          Type.Array(AutomationClassifierDefinitionSchema),
        ],
        {
          description:
            "[create/create_version] Classifier definitions for extraction. Each attribute_values MUST be an object map keyed by value, never an array.",
        }
      )
    ),
    triggers: Type.Optional(
      Type.Array(AutomationTriggerSchema, {
        minItems: 0,
        maxItems: 16,
        description:
          "[create/update/create_version] Canonical Automation activations. Use a schedule trigger for cadence and timezone.",
      })
    ),
    managed_agent_id: Type.Optional(
      Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
        description:
          "[create/update] Optional managed agent that executes this Automation's runs (server dispatch lane). Null clears the assignment; an Automation with neither managed_agent_id nor device_worker_id is manual-only and may be completed by an external MCP client. [list] Optional owner filter.",
      })
    ),
    status: Type.Optional(
      Type.Union([Type.Literal("active"), Type.Literal("archived")], {
        description:
          "[list] Optional status filter. Omit to include active Automations only.",
      })
    ),
    include_details: Type.Optional(
      Type.Boolean({
        description:
          "[list] Include prompt, schema, and sources in the response (default: false).",
      })
    ),
    order_by: Type.Optional(
      Type.Union([Type.Literal("last_fired_at"), Type.Literal("created_at")], {
        description: "[list] Sort field (default: created_at).",
      })
    ),
    order_dir: Type.Optional(
      Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
        description: "[list] Sort direction (default: desc).",
      })
    ),
    run_status: Type.Optional(
      Type.Union(
        [
          Type.Literal("pending"),
          Type.Literal("claimed"),
          Type.Literal("running"),
          Type.Literal("completed"),
          Type.Literal("failed"),
        ],
        {
          description:
            "[list] Filter by each Automation's latest run status (active runs take precedence). External processors should use claim_next_window to atomically lease expected work.",
        }
      )
    ),
    device_worker_id: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "[create/update] Optional device worker UUID to pin this Automation to (when its inputs live on that device). Null clears the pin.",
      })
    ),
    agent_kind: Type.Optional(
      Type.Union([...DEVICE_AGENT_KIND_LITERALS, Type.Null()], {
        description:
          "[create/update] Which local CLI a device-pinned Automation runs on. Only meaningful alongside device_worker_id. Null (the default) uses whatever agent the device itself is set to. A kind the device has no executor for fails at dispatch, so this is validated here rather than accepted and discovered later.",
      })
    ),
    delivery_target: Type.Optional(
      Type.Union([Type.Null(), AutomationDeliveryTargetSchema], {
        description:
          "[create/update] Strict bound chat channel for this Automation's notifications. Null clears it; omitted keeps the current destination on update.",
      })
    ),
    min_cooldown_seconds: Type.Optional(
      Type.Number({
        description:
          "[create/update] Minimum seconds between two firings of this Automation (0 = no cooldown).",
        minimum: 0,
      })
    ),
    model_config: Type.Optional(
      Type.Any({ description: "[create/update] AI model configuration" })
    ),
    // Union with Null so `update` can clear a previously-saved config back to
    // NULL/defaults — omitted = unchanged, null = clear, object = replace. The
    // object shape lives in AutomationExecutionConfigSchema; the role-policy gate
    // (assertValidExecutionConfig) stays in the CRUD handlers.
    execution_config: Type.Optional(
      Type.Union([Type.Null(), AutomationExecutionConfigSchema])
    ),
    tags: Type.Optional(
      Type.Array(Type.String(), {
        description: "[create/update] Tags for filtering",
      })
    ),

    // Version management
    version: Type.Optional(
      Type.Number({
        description: "[upgrade/get_version_details] Version number",
      })
    ),
    target_version: Type.Optional(
      Type.Number({ description: "[upgrade] Version number to upgrade to" })
    ),
    change_notes: Type.Optional(
      Type.String({
        description: "[create_version] Change notes for the new version",
      })
    ),
    set_as_current: Type.Optional(
      Type.Boolean({
        description: "[create_version] Set as current version (default: true)",
      })
    ),
    reactions_guidance: Type.Optional(
      Type.String({
        description:
          "[create/create_version] Guidance text for LLM agents on what reactions to take.",
      })
    ),

    // Fields for action="complete_window"
    extracted_data: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          description:
            "[complete_window] Required. LLM analysis results. Must match the Automation's extraction contract (derived from its entity type).",
        }
      )
    ),
    window_token: Type.Optional(
      Type.String({
        description:
          "[complete_window] Signed JWT from claim_next_window or an internal Automation knowledge read. Pass this or window_tokens.",
      })
    ),
    window_tokens: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "[complete_window] Every signed page token for the same Automation window. Content IDs are unioned and linked atomically; incomplete page chains are rejected.",
      })
    ),
    client_id: Type.Optional(
      Type.String({
        description:
          "[complete_window] Optional client identifier for execution provenance. Defaults to authenticated MCP client when available.",
      })
    ),
    model: Type.Optional(
      Type.String({
        description:
          "[complete_window] Optional model name used to produce the window result.",
      })
    ),
    run_metadata: Type.Optional(
      Type.Any({
        description:
          "[complete_window] Optional structured execution metadata for provenance (provider, session id, parameters, etc.).",
      })
    ),
    template_version_id: Type.Optional(
      Type.Number({
        description:
          "[complete_window] Pin to a specific persisted Automation version. Workers receive this from the run dispatch payload and pass it back so validation uses the same version that produced the extraction. Defaults to the run row's snapshot if available, else the Automation's current version.",
      })
    ),

    // Fields for action="create" / "set_reaction_script"
    reaction_script: Type.Optional(
      Type.String({
        description:
          "[create/set_reaction_script] TypeScript source for an automated reaction. On create, it is compiled before the Automation and its reaction fields are stored in one transaction. Pass an empty string to set_reaction_script to remove an existing script.",
      })
    ),

    // Fields for action="submit_feedback" / "get_feedback"
    run_id: Type.Optional(
      Type.Number({
        description:
          "[complete_window/submit_feedback] Required Automation run ID. [get_feedback] Optional filter.",
      })
    ),
    corrections: Type.Optional(
      Type.Array(
        Type.Object({
          field_path: Type.String({
            description:
              'Dot/bracket path into extracted_data, e.g. "problems[1].severity" or "problems[2]" for an array item.',
          }),
          mutation: Type.Optional(
            Type.Union(
              [
                Type.Literal("set"),
                Type.Literal("remove"),
                Type.Literal("add"),
              ],
              {
                description:
                  'Default "set". Use "remove" to drop an array item; "add" to append one.',
              }
            )
          ),
          value: Type.Optional(
            Type.Any({
              description:
                "New value for set/add. Omitted for remove. Any JSON type (string/number/object/array).",
            })
          ),
          note: Type.Optional(
            Type.String({ description: "Optional per-field explanation." })
          ),
        }),
        {
          description:
            "[submit_feedback] One entry per corrected field. Each row is stored independently so future corrections can supersede earlier ones per field.",
        }
      )
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 500,
        description:
          "[list/get_feedback] Maximum records to return (max: 500). get_feedback defaults to 50; list defaults to all matching Automations.",
      })
    ),
  },
  { additionalProperties: false }
);

// ============================================
// Type Definitions
// ============================================

export type ManageAutomationsArgs = Static<typeof ManageAutomationsSchema>;

/**
 * The automation columns a `manage_automations` UPDATE persists — a type-only `Pick`
 * of {@link ManageAutomationsArgs} so the field TYPES are reused from the single
 * source (no re-typing); the STORED shape is these fields after the
 * write-normalization {@link normalizeAutomationUpdatePatch} applies.
 *
 * EXCLUDES: name/description/prompt/sources (version-owned — an update can't
 * change them, changing them needs create_version) and routing keys
 * (action/automation_id/entity_id/version_id). `next_run_at` is omitted too — a
 * DERIVED column, not a proposable field.
 */
export type AutomationUpdatePatch = Pick<
  ManageAutomationsArgs,
  | "model_config"
  | "execution_config"
  | "triggers"
  | "managed_agent_id"
  | "tags"
  | "device_worker_id"
  | "agent_kind"
  | "delivery_target"
  | "min_cooldown_seconds"
>;

/**
 * Canonical tag normalization for an automation write — trim, drop empties, dedupe,
 * preserving first-seen order. The SINGLE source for how tags are STORED: the
 * server's `toTextArrayParam` (SQL array param) and `normalizeAutomationUpdatePatch`
 * (review `proposedAfter`) both go through this, so the displayed tags equal the
 * stored tags exactly (e.g. `["  a  ", "a", ""]` → `["a"]`).
 */
export function normalizeAutomationTags(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s.length === 0 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * The SINGLE SOURCE OF TRUTH for a `manage_automations` UPDATE's write-normalization
 * — the exact value each applied field STORES. Shared by the apply handler
 * (feeds the UPDATE SET clause) and the config-approval review's `proposedAfter`
 * (the pending-proposal endpoint), so "displayed == applied" can't drift: the
 * review shows precisely what this same function tells the handler to write.
 *
 * A `manage_automations` update is a PATCH — only keys PRESENT in `args` are
 * returned (absent keys keep their current values). Coercions mirror the stored
 * shape EXACTLY, incl. the ones that used to live only in the SQL params:
 *   - model_config ?? {}
 *   - tags → normalizeAutomationTags (trim/drop-empty/dedupe)
 *   - min_cooldown_seconds ?? 0
 *   - null-clearable fields (managed_agent_id/device_worker_id/agent_kind,
 *     delivery_target, and execution_config) keep null (a real clear the write
 *     applies) — NOT coerced to undefined, which would hide the clear.
 */
export function normalizeAutomationUpdatePatch(
  args: ManageAutomationsArgs
): AutomationUpdatePatch {
  const patch: AutomationUpdatePatch = {};
  if (args.model_config !== undefined)
    patch.model_config = args.model_config ?? {};
  // null is a REAL clear the write stores (toJsonParam(null) → SQL null); keep it
  // so the review shows the clear rather than hiding it (serializing away).
  if (args.execution_config !== undefined)
    patch.execution_config = args.execution_config ?? null;
  if (args.triggers !== undefined) patch.triggers = args.triggers;
  if (args.managed_agent_id !== undefined)
    patch.managed_agent_id = args.managed_agent_id ?? null;
  if (args.tags !== undefined) patch.tags = normalizeAutomationTags(args.tags);
  if (args.device_worker_id !== undefined)
    patch.device_worker_id = args.device_worker_id ?? null;
  if (args.agent_kind !== undefined) patch.agent_kind = args.agent_kind ?? null;
  if (args.delivery_target !== undefined)
    patch.delivery_target = args.delivery_target ?? null;
  if (args.min_cooldown_seconds !== undefined)
    patch.min_cooldown_seconds = args.min_cooldown_seconds ?? 0;
  return patch;
}

/**
 * Result of `manage_automations` — a discriminated union keyed on `action`.
 * TypeBox-first: the TS type is `Static<>`-derived, and the same schema is the
 * tool's `outputSchema`. Well-structured variants are precise; the genuinely
 * dynamic variants (`get_version_details` carries an open index signature,
 * `get_versions` returns arbitrary version rows, `get_component_reference`
 * embeds a large doc tree) use permissive object shapes so the schema is
 * honest rather than a brittle mirror of shapes that are intentionally open.
 */
export const ManageAutomationsDeleteResultSchema = Type.Object({
  automation_id: Type.String(),
  success: Type.Boolean(),
  message: Type.String(),
  version: Type.Optional(Type.Integer()),
});

export const ManageAutomationsFeedbackItemSchema = Type.Object({
  id: Type.Integer(),
  run_id: Type.Integer(),
  field_path: Type.String(),
  mutation: Type.Union([
    Type.Literal("set"),
    Type.Literal("remove"),
    Type.Literal("add"),
  ]),
  corrected_value: Type.Unknown(),
  note: Type.Union([Type.String(), Type.Null()]),
  created_by: Type.String(),
  created_at: Type.String(),
  window_start: Type.Optional(Type.String()),
  window_end: Type.Optional(Type.String()),
});

export const ManageAutomationsPromotedEntitySchema = Type.Object({
  id: Type.Integer(),
  name: Type.String(),
  entity_type: Type.String(),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  field_controls: Type.Record(Type.String(), Type.Unknown()),
  run_id: Type.Union([Type.Integer(), Type.Null()]),
  stable_key: Type.Union([Type.String(), Type.Null()]),
});

export const AutomationClaimNextWindowContextSchema = Type.Object({
  content: Type.Array(Type.Unknown()),
  page: Type.Object({
    limit: Type.Integer(),
    offset: Type.Integer(),
    has_more: Type.Boolean(),
    next_cursor: Type.Optional(
      Type.Object({ occurred_at: Type.String(), id: Type.Integer() })
    ),
  }),
  window_token: Type.String(),
  window_start: Type.String(),
  window_end: Type.String(),
  sources: Type.Optional(
    Type.Record(Type.String(), Type.Array(Type.Unknown()))
  ),
  sources_page: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Object({
        returned: Type.Integer(),
        limit: Type.Integer(),
        has_more: Type.Boolean(),
        next_cursor: Type.Optional(Type.String()),
        window_axis: Type.Optional(Type.String()),
        feed_id: Type.Optional(Type.Integer()),
      })
    )
  ),
  extraction_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type AutomationClaimNextWindowContext = Static<
  typeof AutomationClaimNextWindowContextSchema
>;

export const AutomationClaimNextWindowResultSchema = Type.Object({
  action: Type.Literal("claim_next_window"),
  automation_id: Type.String(),
  run_id: Type.Integer(),
  lease_expires_at: Type.String(),
  context: AutomationClaimNextWindowContextSchema,
});
export type AutomationClaimNextWindowResult = Static<
  typeof AutomationClaimNextWindowResultSchema
>;

export const AutomationTriggerExecutionSchema = Type.Union([
  Type.Object({
    lane: Type.Literal("managed_agent"),
    owner: Type.Literal("lobu"),
    managed_agent_id: Type.String(),
    next_action: Type.Object({ kind: Type.Literal("handled_elsewhere") }),
  }),
  Type.Object({
    lane: Type.Literal("device_worker"),
    owner: Type.Literal("device"),
    device_worker_id: Type.String(),
    agent_kind: Type.Union([Type.String(), Type.Null()]),
    next_action: Type.Object({ kind: Type.Literal("handled_elsewhere") }),
  }),
  Type.Object({
    lane: Type.Literal("external_client"),
    owner: Type.Literal("caller"),
    next_action: Type.Object({
      kind: Type.Literal("complete_window"),
      read: Type.Object({
        method: Type.Literal("knowledge.read"),
        input: Type.Object({
          automation_id: Type.Integer(),
          run_id: Type.Integer(),
        }),
      }),
      // biome-ignore lint/suspicious/noThenProperty: Public protocol field required by the trigger handoff contract.
      then: Type.Literal("automations.completeWindow"),
    }),
  }),
  Type.Object({
    lane: Type.Literal("external_client"),
    owner: Type.Literal("caller"),
    next_action: Type.Object({
      kind: Type.Literal("resume_claim"),
      method: Type.Literal("automations.claimNextWindow"),
      input: Type.Object({
        automation_id: Type.String(),
        run_id: Type.Integer(),
      }),
    }),
  }),
  Type.Object({
    lane: Type.Literal("external_client"),
    owner: Type.Literal("another_caller"),
    next_action: Type.Object({ kind: Type.Literal("handled_elsewhere") }),
  }),
]);
export type AutomationTriggerExecution = Static<
  typeof AutomationTriggerExecutionSchema
>;

export const AutomationTriggerResultSchema = Type.Object({
  action: Type.Literal("trigger"),
  automation_id: Type.String(),
  run_id: Type.Integer(),
  status: Type.String(),
  created: Type.Boolean(),
  execution: AutomationTriggerExecutionSchema,
});
export type AutomationTriggerResult = Static<
  typeof AutomationTriggerResultSchema
>;

export const ManageAutomationsResultSchema = Type.Union([
  Type.Object({
    action: Type.Literal("list"),
    automations: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  }),
  Type.Object({
    action: Type.Literal("create"),
    automation_id: Type.String(),
    version: Type.Integer(),
    status: Type.String(),
    sources: Type.Optional(Type.Array(AutomationSourceSchema)),
    view_url: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("update"),
    automation_id: Type.String(),
    updated_fields: Type.Array(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("create_version"),
    automation_id: Type.String(),
    version_id: Type.String(),
    version: Type.Integer(),
    previous_version: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal("complete_window"),
    automation_id: Type.String(),
    run_id: Type.Integer(),
    window_start: Type.String(),
    window_end: Type.String(),
    content_linked: Type.Integer(),
  }),
  AutomationClaimNextWindowResultSchema,
  AutomationTriggerResultSchema,
  Type.Object({
    action: Type.Literal("delete"),
    results: Type.Array(ManageAutomationsDeleteResultSchema),
    summary: Type.Object({
      total: Type.Integer(),
      successful: Type.Integer(),
      failed: Type.Integer(),
    }),
  }),
  Type.Object({
    action: Type.Literal("set_reaction_script"),
    automation_id: Type.String(),
    has_script: Type.Boolean(),
    message: Type.String(),
  }),
  // Intentionally permissive: version rows are arbitrary config snapshots.
  Type.Object({
    action: Type.Literal("get_versions"),
    automation_id: Type.String(),
    versions: Type.Array(Type.Unknown()),
  }),
  // Intentionally permissive: carries an open `[key: string]: any` index sig
  // (the full version config snapshot). Intersecting a string→unknown record
  // gives the derived TS type an index signature AND emits
  // `additionalProperties: true` in the JSON Schema.
  Type.Intersect([
    Type.Object({
      action: Type.Literal("get_version_details"),
      automation_id: Type.String(),
    }),
    Type.Record(Type.String(), Type.Unknown()),
  ]),
  // Intentionally permissive: embeds a large documentation tree
  // (ComponentReferenceDocumentation); the action literal + presence of
  // `documentation` is what clients key on.
  Type.Object({
    action: Type.Literal("get_component_reference"),
    documentation: Type.Unknown(),
  }),
  Type.Object({
    action: Type.Literal("submit_feedback"),
    automation_id: Type.String(),
    run_id: Type.Integer(),
    feedback_ids: Type.Array(Type.Integer()),
  }),
  Type.Object({
    action: Type.Literal("get_feedback"),
    automation_id: Type.String(),
    feedback: Type.Array(ManageAutomationsFeedbackItemSchema),
  }),
  Type.Object({
    action: Type.Literal("list_promoted"),
    automation_id: Type.String(),
    entities: Type.Array(ManageAutomationsPromotedEntitySchema),
  }),
  Type.Object({
    action: Type.Literal("create_from_version"),
    created: Type.Array(
      Type.Object({
        automation_id: Type.String(),
        entity_id: Type.Integer(),
        name: Type.String(),
      })
    ),
  }),
  // Builder-gate: non-human principal queued an Automation definition write.
  // Mirrors manage_agents' pending_approval shape so the worker can forward a
  // chat approval card from the same result fields (run_id + proposal).
  Type.Object({
    action: Type.Union([
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("create_version"),
      Type.Literal("create_from_version"),
      Type.Literal("set_reaction_script"),
      Type.Literal("delete"),
    ]),
    run_id: Type.Integer(),
    event_id: Type.Optional(Type.Integer()),
    status: Type.Literal("pending_approval"),
    message: Type.String(),
    proposal: Type.Unknown(),
    current: Type.Union([
      Type.Record(Type.String(), Type.Unknown()),
      Type.Null(),
    ]),
  }),
]);

export type ManageAutomationsResult = Static<
  typeof ManageAutomationsResultSchema
>;

/**
 * Proposed Automation-definition mutation held in `runs.action_input` for a
 * builder-gate run. Captures the original manage_automations args so approve can
 * re-run the same write handler.
 *
 * Also persists the acting principal resolved at queue time so apply can
 * re-validate the foreign-owner guard against the ORIGINAL actor (not the
 * human approver). Without this, a group reassigned between queue and approve
 * would let A's pending mutation land on B-owned automation.
 *
 * Automation definition writes have no per-field pre-image (unlike manage_agents
 * update `base`); a straight re-run is the launch path — a stale approval may
 * clobber a newer edit (ownership re-check still rejects foreign owners).
 */
export interface ManageAutomationsProposal {
  args: ManageAutomationsArgs;
  /** Resolved `actor.ownerAgentId ?? actor.id` at queue time; null for humans. */
  actingAgentId: string | null;
  /** Session `actingAutomationId` at queue time, if any. */
  actingAutomationId: string | null;
}
// The REST/list helper is a projection of the canonical flattened tool schema,
// not a second hand-maintained contract that can drift from manage_automations.
export const ListAutomationsSchema = Type.Pick(ManageAutomationsSchema, [
  "automation_id",
  "entity_id",
  "managed_agent_id",
  "status",
  "include_details",
  "order_by",
  "order_dir",
  "run_status",
  "limit",
]);

export type ListAutomationsArgs = Static<typeof ListAutomationsSchema>;

export const ListAutomationsResultSchema = Type.Object({
  action: Type.Literal("list"),
  automations: Type.Array(Type.Record(Type.String(), Type.Unknown())),
});
export type ListAutomationsResult = Static<typeof ListAutomationsResultSchema>;
