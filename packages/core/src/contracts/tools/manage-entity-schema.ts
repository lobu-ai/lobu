import { type Static, Type } from "@sinclair/typebox";

// ============================================
// Typebox Schema
// ============================================

/** Derived-entity backing: a read-only SQL view. */
export const BackingInputSchema = Type.Object(
  {
    sql: Type.String({
      minLength: 1,
      description: "ANSI SELECT defining the view",
    }),
    connection: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Optional connection slug. When set, the view runs LIVE against that connection’s external database (read-only, no copy) instead of internal tables. Stored verbatim; resolved to the connection at read time.",
      })
    ),
  },
  { additionalProperties: false }
);

export const ManageEntitySchemaSchema = Type.Object({
  schema_type: Type.Union(
    [Type.Literal("entity_type"), Type.Literal("relationship_type")],
    {
      description: "Whether to manage entity types or relationship types",
    }
  ),

  action: Type.Union(
    [
      // Shared actions
      Type.Literal("list", {
        description: "List entity types or relationship types.",
      }),
      Type.Literal("get", { description: "Fetch one type by slug." }),
      Type.Literal("create", {
        description:
          "Create an entity or relationship type through entity_schema write governance. Without a matching policy, owner/admin calls apply immediately.",
      }),
      Type.Literal("update", {
        description: "Patch a type through entity_schema write governance.",
      }),
      Type.Literal("delete", {
        description:
          "Soft-delete a type through entity_schema write governance; refuses if rows still reference it.",
      }),
      // Entity type only
      Type.Literal("audit", {
        description: "Fetch entity_type_audit rows (entity_type only).",
      }),
      // Relationship type only
      Type.Literal("add_rule", {
        description:
          "Add an allowed source→target type rule (relationship_type only), governed as update_relationship_type.",
      }),
      Type.Literal("remove_rule", {
        description:
          "Soft-delete a rule (relationship_type only), governed as update_relationship_type.",
      }),
      Type.Literal("list_rules", {
        description: "List allowed type rules (relationship_type only).",
      }),
    ],
    { description: "Action to perform" }
  ),

  // Identification
  slug: Type.Optional(
    Type.String({
      description:
        "[get/create/update/delete/audit/add_rule/remove_rule/list_rules] Type slug",
      minLength: 1,
    })
  ),

  // Shared create/update fields
  name: Type.Optional(
    Type.String({ description: "[create/update] Display name", minLength: 1 })
  ),
  description: Type.Optional(
    Type.String({ description: "[create/update] Description" })
  ),
  metadata_schema: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "[create/update] JSON Schema for metadata validation",
    })
  ),
  list_scope: Type.Optional(
    Type.Union([Type.Literal("accessible"), Type.Literal("organization")], {
      description:
        "[list] accessible (default) includes the current org plus public schemas; organization returns only the bound org.",
    })
  ),

  // Entity type fields
  icon: Type.Optional(
    Type.String({ description: "[entity_type: create/update] Emoji or icon" })
  ),
  color: Type.Optional(
    Type.String({
      description: "[entity_type: create/update] Color for UI display",
    })
  ),
  event_kinds: Type.Optional(
    Type.Union(
      [
        Type.Null(),
        Type.Record(
          Type.String(),
          Type.Object({
            description: Type.Optional(Type.String()),
            metadataSchema: Type.Optional(
              Type.Record(Type.String(), Type.Unknown())
            ),
            jsonTemplate: Type.Optional(
              Type.Record(Type.String(), Type.Unknown())
            ),
            interactions: Type.Optional(
              Type.Record(Type.String(), Type.Object({ emits: Type.String() }))
            ),
          })
        ),
      ],
      {
        description:
          "[entity_type: create/update] Event semantic types this type produces, keyed by semantic_type slug. Each entry can have a description, optional metadataSchema (JSON Schema), optional jsonTemplate (render template), and optional interactions registry mapping template action names to emitted event kinds. Supplying an object replaces the entire registry: read the current value and merge before updating. `null` clears all kinds; omit to leave unchanged.",
      }
    )
  ),
  backing: Type.Optional(
    Type.Union([Type.Null(), BackingInputSchema], {
      description:
        "[entity_type: create/update] Makes the type DERIVED — a read-only SQL view. `{ sql }` runs over your org's internal tables; `{ sql, connection: <slug> }` runs LIVE against that connection's external database (read-only, no copy). `null` clears it (revert to a stored type); omit to leave unchanged. Read a derived type's rows by running its `backing_sql` (returned by `get`) through `query_sql` — and when `get` also returns a `backing_source`, pass it as `query_sql`'s `connection` so the view runs against the external DB instead of your internal tables. `get` also returns `measure_columns` (the view's aggregate columns, classified on read).",
    })
  ),
  metrics_config: Type.Optional(
    Type.Union([Type.Null(), Type.Record(Type.String(), Type.Unknown())], {
      description:
        "[entity_type: create/update] Declared metric contract (eventSets/measures/dimensions/segments — see @lobu/connector-sdk) stored verbatim. The metric compiler lowers it into backing SQL. `null` clears it; omit to leave unchanged.",
    })
  ),
  rules_source: Type.Optional(
    Type.Union([Type.Null(), Type.String()], {
      description:
        "[entity_type: create/update] TypeScript write rules for this type, as source. The default export receives one row per write — `{ committed, patch, next, op, changed(field), deny(reason), escalate(fields, reason) }` — and may only NARROW what is allowed: there is no `allow`. Compiled server-side on save and executed at the entity write seam, so an illegal state is rejected no matter which caller proposed it. Note `patch` is the fully MERGED value set, not a delta, so compare against `committed` rather than testing for a key's presence. `null` clears the rules; omit to leave unchanged.",
    })
  ),

  // Relationship type fields
  is_symmetric: Type.Optional(
    Type.Boolean({
      description:
        "[relationship_type: create] Whether the relationship is symmetric (A↔B = B↔A). Default false. Create-only: affects relationship canonicalization/dedup for existing rows, so an update carrying is_symmetric is rejected (not silently dropped). To change it, create a new type and migrate.",
    })
  ),
  inverse_type_slug: Type.Optional(
    Type.String({
      description:
        '[relationship_type: create/update] Slug of the inverse relationship type (e.g., "depends_on" ↔ "dependency_of")',
    })
  ),
  status: Type.Optional(
    Type.Union([Type.Literal("active"), Type.Literal("archived")], {
      description: "[relationship_type: create/update] Status. Default active.",
    })
  ),
  // Rule fields (relationship_type only)
  source_entity_type_slug: Type.Optional(
    Type.String({
      description: "[relationship_type: add_rule] Source entity type slug",
    })
  ),
  target_entity_type_slug: Type.Optional(
    Type.String({
      description: "[relationship_type: add_rule] Target entity type slug",
    })
  ),
  rule_id: Type.Optional(
    Type.Number({
      description: "[relationship_type: remove_rule] Rule ID to remove",
    })
  ),

  // List filters
  include_deleted: Type.Optional(
    Type.Boolean({
      description: "[relationship_type: list] Include soft-deleted types",
    })
  ),
});

export type ManageEntitySchemaArgs = Static<typeof ManageEntitySchemaSchema>;

// ============================================
// Result Types
// ============================================

// An authored view template + its live data. Same shape resolve_path returns for
// entity-detail tabs; duplicated (not imported) to avoid coupling this admin tool
// to resolve_path's module-private schema.
export const ViewTemplateTabSchema = Type.Object({
  tab_name: Type.String(),
  tab_order: Type.Integer(),
  json_template: Type.Record(Type.String(), Type.Unknown()),
  version: Type.Integer(),
  version_id: Type.Integer(),
  template_data: Type.Union([
    Type.Record(Type.String(), Type.Array(Type.Unknown())),
    Type.Null(),
  ]),
});
export type ViewTemplateTab = Static<typeof ViewTemplateTabSchema>;

export const EntityTypeRowSchema = Type.Object({
  id: Type.Integer(),
  slug: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  icon: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  color: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  metadata_schema: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  event_kinds: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  backing_sql: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** Connection slug an external-backed derived view runs against; null ⇒ internal. */
  backing_source: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** Declared metric contract (eventSets/measures/dimensions/segments), stored verbatim; null ⇒ none. */
  metrics_config: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  /**
   * Write rules as authored. The compiled artifact is deliberately NOT returned:
   * it is a build output, it is large, and a caller that diffs against it would
   * churn on every compiler change rather than on an actual rule change.
   */
  rules_source: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /**
   * Platform-owned type when true (slug starts with `$`: $member, $resource).
   * Derived from slug — not a DB column, not created_by. true → hidden from
   * rail, never pruned. Users cannot create `$…` types.
   */
  is_system: Type.Boolean(),
  created_by: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  organization_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  organization_slug: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  // `Date` in the row; serialized to ISO over the wire. Accept either.
  created_at: Type.Union([Type.String(), Type.Unknown()]),
  updated_at: Type.Union([Type.String(), Type.Unknown()]),
  entity_count: Type.Optional(Type.Integer()),
  /** Derived types only — the view's aggregate columns, classified on read. */
  measure_columns: Type.Optional(Type.Array(Type.String())),
  /**
   * Retired with view templates: always empty. Type views resolve client-side
   * from `manage_views`; the field stays so older clients keep rendering the
   * built-in Table/Board/Gallery switcher. Removed in the owletto follow-up.
   */
  view_templates: Type.Optional(Type.Array(ViewTemplateTabSchema)),
});
export type EntityTypeRow = Static<typeof EntityTypeRowSchema>;

export const AuditEntrySchema = Type.Object({
  id: Type.Integer(),
  entity_type_id: Type.Integer(),
  action: Type.String(),
  actor: Type.Union([Type.String(), Type.Null()]),
  before_payload: Type.Union([
    Type.Record(Type.String(), Type.Unknown()),
    Type.Null(),
  ]),
  after_payload: Type.Union([
    Type.Record(Type.String(), Type.Unknown()),
    Type.Null(),
  ]),
  created_at: Type.String(),
});
export type AuditEntry = Static<typeof AuditEntrySchema>;

export const RelationshipTypeRowSchema = Type.Object({
  id: Type.Integer(),
  slug: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  organization_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  organization_slug: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  created_by: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  metadata_schema: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  metadata: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  is_symmetric: Type.Boolean(),
  inverse_type_id: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  inverse_type_slug: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  status: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String(),
  deleted_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  relationship_count: Type.Optional(Type.Integer()),
  /**
   * System-controlled classification; `authorization` marks the vocabulary the
   * ACL gates read. On the read paths because it is exactly what makes every
   * write action on the TYPE 403 (`assertNotAuthorizationType`): `member_of` is
   * org-owned, so without it a client cannot separate one from ordinary
   * vocabulary and renders edit affordances guaranteed to fail. It does not
   * cover the EDGE surfaces, which also refuse the ACL-managed slug while a
   * freshly declared row is still unclassified. An open string, not a literal
   * union, so a server that learns a new purpose still satisfies the result
   * schema an older client validates against.
   */
  purpose: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type RelationshipTypeRow = Static<typeof RelationshipTypeRowSchema>;

export const RelationshipTypeRuleRowSchema = Type.Object({
  id: Type.Integer(),
  relationship_type_id: Type.Integer(),
  source_entity_type_slug: Type.String(),
  target_entity_type_slug: Type.String(),
  created_at: Type.String(),
});
export type RelationshipTypeRuleRow = Static<
  typeof RelationshipTypeRuleRowSchema
>;

export const EntitySchemaPolicyActionSchema = Type.Union([
  Type.Literal("create_type"),
  Type.Literal("update_type"),
  Type.Literal("delete_type"),
  Type.Literal("create_relationship_type"),
  Type.Literal("update_relationship_type"),
  Type.Literal("delete_relationship_type"),
]);

/** Prepared, durable schema command persisted until a human decides it. */
export const ManageEntitySchemaProposalSchema = Type.Object({
  version: Type.Literal(1),
  resource_class: Type.Literal("entity_schema"),
  policy_action: EntitySchemaPolicyActionSchema,
  schema_type: Type.Union([
    Type.Literal("entity_type"),
    Type.Literal("relationship_type"),
  ]),
  action: Type.Union([
    Type.Literal("create"),
    Type.Literal("update"),
    Type.Literal("delete"),
    Type.Literal("add_rule"),
    Type.Literal("remove_rule"),
  ]),
  args: Type.Record(Type.String(), Type.Unknown()),
  current: Type.Union([
    Type.Record(Type.String(), Type.Unknown()),
    Type.Null(),
  ]),
  precondition: Type.Object({
    target_kind: Type.Union([
      Type.Literal("entity_type"),
      Type.Literal("relationship_type"),
      Type.Literal("relationship_rule"),
    ]),
    target_id: Type.Union([Type.Integer(), Type.Null()]),
    updated_at: Type.Union([Type.String(), Type.Null()]),
    related_id: Type.Optional(Type.Integer()),
    related_updated_at: Type.Optional(Type.String()),
  }),
  policy_principal_kind: Type.Union([
    Type.Literal("agent"),
    Type.Literal("automation"),
  ]),
  policy_principal_id: Type.Union([Type.String(), Type.Null()]),
  owner_agent_id: Type.Union([Type.String(), Type.Null()]),
  owner_resolved: Type.Boolean(),
});
export type ManageEntitySchemaProposal = Static<
  typeof ManageEntitySchemaProposalSchema
>;

/**
 * Result of `manage_entity_schema` — discriminated union keyed on
 * `schema_type` + `action`. TypeBox-first: `Static<>` derives the TS type from
 * the same schema exposed as the tool's `outputSchema`.
 */
export const ManageEntitySchemaResultSchema = Type.Union([
  // Entity type results
  Type.Object({
    schema_type: Type.Literal("entity_type"),
    action: Type.Literal("list"),
    entity_types: Type.Array(EntityTypeRowSchema),
    /**
     * Event types the PLATFORM emits, which no entity type declares.
     *
     * A dedicated field rather than a synthetic `$platform` entity type: the
     * events tab builds its content-kind dropdown from the same entity-type
     * list, and a pseudo type would offer platform events as savable content
     * kinds. Trigger pickers union this with the declared `event_kinds`;
     * content surfaces ignore it.
     */
    platform_event_kinds: Type.Record(
      Type.String(),
      Type.Object({ description: Type.String() })
    ),
    list_scope: Type.Union([
      Type.Literal("accessible"),
      Type.Literal("organization"),
    ]),
    organization_id: Type.String(),
  }),
  Type.Object({
    schema_type: Type.Literal("entity_type"),
    action: Type.Literal("get"),
    entity_type: Type.Union([EntityTypeRowSchema, Type.Null()]),
  }),
  Type.Object({
    schema_type: Type.Literal("entity_type"),
    action: Type.Literal("create"),
    status: Type.Literal("applied"),
    entity_type: EntityTypeRowSchema,
  }),
  Type.Object({
    schema_type: Type.Union([
      Type.Literal("entity_type"),
      Type.Literal("relationship_type"),
    ]),
    action: Type.Union([
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("delete"),
      Type.Literal("add_rule"),
      Type.Literal("remove_rule"),
    ]),
    status: Type.Literal("pending_approval"),
    run_id: Type.Integer(),
    event_id: Type.Integer(),
    approval_url: Type.Optional(Type.String()),
    message: Type.String(),
    proposal: ManageEntitySchemaProposalSchema,
    current: Type.Union([
      Type.Record(Type.String(), Type.Unknown()),
      Type.Null(),
    ]),
  }),
  Type.Object({
    schema_type: Type.Union([
      Type.Literal("entity_type"),
      Type.Literal("relationship_type"),
    ]),
    action: Type.Union([
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("delete"),
      Type.Literal("add_rule"),
      Type.Literal("remove_rule"),
    ]),
    status: Type.Literal("denied"),
    message: Type.String(),
  }),
  Type.Object({
    schema_type: Type.Union([
      Type.Literal("entity_type"),
      Type.Literal("relationship_type"),
    ]),
    action: Type.Union([
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("delete"),
      Type.Literal("add_rule"),
      Type.Literal("remove_rule"),
    ]),
    status: Type.Literal("failed"),
    message: Type.String(),
  }),
  Type.Object({
    schema_type: Type.Literal("entity_type"),
    action: Type.Literal("update"),
    status: Type.Literal("applied"),
    entity_type: EntityTypeRowSchema,
  }),
  Type.Object({
    schema_type: Type.Literal("entity_type"),
    action: Type.Literal("delete"),
    status: Type.Literal("applied"),
    success: Type.Boolean(),
    message: Type.String(),
  }),
  Type.Object({
    schema_type: Type.Literal("entity_type"),
    action: Type.Literal("audit"),
    audit_entries: Type.Array(AuditEntrySchema),
  }),
  // Relationship type results
  Type.Object({
    schema_type: Type.Literal("relationship_type"),
    action: Type.Literal("list"),
    relationship_types: Type.Array(RelationshipTypeRowSchema),
    list_scope: Type.Union([
      Type.Literal("accessible"),
      Type.Literal("organization"),
    ]),
    organization_id: Type.String(),
  }),
  Type.Object({
    schema_type: Type.Literal("relationship_type"),
    action: Type.Literal("get"),
    relationship_type: Type.Union([RelationshipTypeRowSchema, Type.Null()]),
  }),
  Type.Object({
    schema_type: Type.Literal("relationship_type"),
    action: Type.Literal("create"),
    status: Type.Literal("applied"),
    relationship_type: RelationshipTypeRowSchema,
  }),
  Type.Object({
    schema_type: Type.Literal("relationship_type"),
    action: Type.Literal("update"),
    status: Type.Literal("applied"),
    relationship_type: RelationshipTypeRowSchema,
  }),
  Type.Object({
    schema_type: Type.Literal("relationship_type"),
    action: Type.Literal("delete"),
    status: Type.Literal("applied"),
    success: Type.Boolean(),
    message: Type.String(),
  }),
  Type.Object({
    schema_type: Type.Literal("relationship_type"),
    action: Type.Literal("add_rule"),
    status: Type.Literal("applied"),
    rule: RelationshipTypeRuleRowSchema,
  }),
  Type.Object({
    schema_type: Type.Literal("relationship_type"),
    action: Type.Literal("remove_rule"),
    status: Type.Literal("applied"),
    success: Type.Boolean(),
    message: Type.String(),
  }),
  Type.Object({
    schema_type: Type.Literal("relationship_type"),
    action: Type.Literal("list_rules"),
    rules: Type.Array(RelationshipTypeRuleRowSchema),
  }),
]);
export type ManageEntitySchemaResult = Static<
  typeof ManageEntitySchemaResultSchema
>;
