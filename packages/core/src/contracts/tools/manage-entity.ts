import { type Static, Type } from "@sinclair/typebox";
import { ApprovalAttributionSchema } from "../interaction-envelope";
import type { ActionInput } from "./action-input";
import { paginationFields } from "./pagination";

function SortOrderField(description: string) {
  return Type.Optional(
    Type.Union([Type.Literal("asc"), Type.Literal("desc")], { description })
  );
}

// ============================================
// Typebox Schema (union of per-action variants)
// ============================================
//
// The wire schema flattens this union into ONE MCP object and merges duplicate
// properties first-occurrence-wins, so a property carried by more than one
// variant must read true for every one of them.

const EntityType = Type.String({
  description: "Entity type as defined in your workspace",
});

const EntityId = Type.Number({
  description:
    "[get/update/delete/list_links/merge/unmerge] Entity ID to operate on",
});

// Attributes an entity carries. `create` and `update` share the set; `list`
// filters on `parent_id`, `category`, `main_market` and `market`.
const EntityFields = {
  name: Type.String({
    description: "[create/update] Entity name",
    minLength: 1,
  }),
  content: Type.String({
    description:
      "[create/update] Free-text content body. Used by memory entities and any entity that carries rich text.",
  }),
  slug: Type.String({
    description:
      "[create/update] URL-friendly slug (auto-generated from name if not provided)",
    pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
  }),
  parent_id: Type.Number({
    description:
      "[create/update/list] Parent entity ID (for hierarchical entities). On list, only that parent's children.",
  }),
  enabled_classifiers: Type.Array(Type.String(), {
    description: "[create/update] Enabled classifier slugs",
  }),
  domain: Type.String({
    description: "[create/update] Primary domain (e.g., spotify.com)",
  }),
  category: Type.String({
    description: "[create/update/list] Industry category",
  }),
  platform_type: Type.String({
    description: "[create/update] Platform type (b2b, b2c, b2b2c)",
  }),
  main_market: Type.String({
    description: "[create/update/list] Primary market (ISO 3166-1 alpha-2)",
  }),
  market: Type.String({
    description: "[create/update/list] Market/region (ISO 3166-1 alpha-2)",
  }),
  link: Type.String({ description: "[create/update] Entity URL" }),
};

// Custom metadata (validated against entity type's JSON schema)
const Metadata = Type.Record(Type.String(), Type.Unknown(), {
  description:
    "[create/update/link/update_link] Custom metadata object. For entities: validated against the entity type's JSON schema. For links: relationship metadata. On update, fields a human owns are NOT overwritten — they are queued for the human's approval and reported in the result's `blocked_fields`/`approval_queued`; tell the user you PROPOSED those changes rather than claiming you set them. Unowned fields in the same call apply directly (`applied_fields`).",
});

// Carried by exactly the variants whose handler reads it: the principal seam
// (`create`, `update`, `list`, `delete`, `merge`), the read gate that consults
// it (`list_links`), and reaction tracking (`link`). `get` resolves its read
// gate without one, and `unlink`/`update_link`/`resolve_duplicates`/`unmerge`
// never consult it — declaring it there would advertise an inert field.
const AutomationSource = Type.Object(
  {
    automation_id: Type.Number({
      description: "Automation that triggered this mutation",
    }),
    run_id: Type.Number({
      description: "Automation run that triggered this mutation",
    }),
  },
  {
    description:
      "Attribution source when mutation is triggered by an Automation reaction",
  }
);

const DryRun = Type.Boolean({
  description:
    "[delete, merge] Preflight only. For delete: report what it would remove/detach. For merge: report whether the type's write rules would refuse it. Mutates nothing and never queues an approval.",
});

const IncludeDeleted = Type.Boolean({
  description:
    "[get] Return the entity even if it is soft-deleted (deleted_at set). [list_links] Include soft-deleted relationships.",
});

// ---- Relationship (link) fields ----
// `link` needs the endpoint triple; `unlink`/`update_link` address an edge by
// `relationship_id` OR by the triple (the handler resolves whichever is given).
const EdgeEndpoints = {
  from_entity_id: Type.Number({
    description:
      "[link/unlink/update_link] Source entity ID. For unlink/update_link, supply this triple instead of relationship_id to address the edge by its endpoints.",
  }),
  to_entity_id: Type.Number({
    description: "[link/unlink/update_link] Target entity ID",
  }),
  relationship_type_slug: Type.String({
    description: "[link/unlink/update_link/list_links] Relationship type slug",
    minLength: 1,
  }),
};

const RelationshipId = Type.Number({
  description:
    "[update_link/unlink] Relationship ID. Optional when from_entity_id + to_entity_id + relationship_type_slug identify the edge.",
});

const Confidence = Type.Number({
  description:
    "[link/update_link] Confidence score 0-1. Defaults to 1.0 for ui/api source.",
  minimum: 0,
  maximum: 1,
});

const RelationshipSource = Type.Union(
  [
    Type.Literal("ui"),
    Type.Literal("llm"),
    Type.Literal("feed"),
    Type.Literal("api"),
  ],
  {
    description:
      "[link/update_link] Source of the relationship. [list_links] Only relationships from this source.",
  }
);

export const CreateEntityAction = Type.Object({
  action: Type.Literal("create", {
    description: "Create an entity of a given type.",
  }),
  entity_type: EntityType,
  name: EntityFields.name,
  content: Type.Optional(EntityFields.content),
  slug: Type.Optional(EntityFields.slug),
  parent_id: Type.Optional(EntityFields.parent_id),
  enabled_classifiers: Type.Optional(EntityFields.enabled_classifiers),
  domain: Type.Optional(EntityFields.domain),
  category: Type.Optional(EntityFields.category),
  platform_type: Type.Optional(EntityFields.platform_type),
  main_market: Type.Optional(EntityFields.main_market),
  market: Type.Optional(EntityFields.market),
  link: Type.Optional(EntityFields.link),
  metadata: Type.Optional(Metadata),
  automation_source: Type.Optional(AutomationSource),
});

export const UpdateEntityAction = Type.Object({
  action: Type.Literal("update", {
    description:
      "Patch entity fields (human-owned fields queued for approval).",
  }),
  entity_id: EntityId,
  name: Type.Optional(EntityFields.name),
  content: Type.Optional(EntityFields.content),
  slug: Type.Optional(EntityFields.slug),
  parent_id: Type.Optional(EntityFields.parent_id),
  enabled_classifiers: Type.Optional(EntityFields.enabled_classifiers),
  domain: Type.Optional(EntityFields.domain),
  category: Type.Optional(EntityFields.category),
  platform_type: Type.Optional(EntityFields.platform_type),
  main_market: Type.Optional(EntityFields.main_market),
  market: Type.Optional(EntityFields.market),
  link: Type.Optional(EntityFields.link),
  metadata: Type.Optional(Metadata),
  // Human-correction annotation
  field_note: Type.Optional(
    Type.String({
      description:
        "[update] Optional note explaining a human correction. Stored on the per-field ownership marker for every metadata field this update sets, so an Automation (and the UI) can see why the value was set.",
    })
  ),
  // Approve/affirm: claim ownership of a field's current value without changing it
  affirm_fields: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "[update] Metadata field names whose CURRENT value the human approves as-is. No value change, but each is marked human-owned so an Automation can't later overwrite it without an approval. The 'approve' half of the recap feedback loop.",
    })
  ),
  automation_source: Type.Optional(AutomationSource),
});

export const ListEntitiesAction = Type.Object({
  action: Type.Literal("list", {
    description: "Paginated entity list with filters.",
  }),
  entity_type: Type.Optional(EntityType),
  parent_id: Type.Optional(EntityFields.parent_id),
  search: Type.Optional(Type.String({ description: "[list] Search by name" })),
  category: Type.Optional(EntityFields.category),
  main_market: Type.Optional(EntityFields.main_market),
  market: Type.Optional(EntityFields.market),
  ...paginationFields(100),
  sort_by: Type.Optional(
    Type.String({
      description:
        "[list] Sort by column (name, created_at, domain, total_content, active_connections, automations_count, children_count)",
    })
  ),
  sort_order: SortOrderField("[list] Sort order (asc or desc)"),
  automation_source: Type.Optional(AutomationSource),
});

export const GetEntityAction = Type.Object({
  action: Type.Literal("get", { description: "Fetch one entity." }),
  entity_id: EntityId,
  include_deleted: Type.Optional(IncludeDeleted),
});

export const DeleteEntityAction = Type.Object({
  action: Type.Literal("delete", {
    description: "Delete an entity (force_delete_tree for cascading).",
  }),
  entity_id: EntityId,
  force_delete_tree: Type.Optional(
    Type.Boolean({
      description:
        "[delete] Hard delete entity and all descendants. Event history is never deleted (append-only) — event rows referencing the tree are detached instead.",
    })
  ),
  dry_run: Type.Optional(DryRun),
  automation_source: Type.Optional(AutomationSource),
});

export const LinkEntitiesAction = Type.Object({
  action: Type.Literal("link", {
    description: "Create a relationship edge between two entities.",
  }),
  from_entity_id: EdgeEndpoints.from_entity_id,
  to_entity_id: EdgeEndpoints.to_entity_id,
  relationship_type_slug: EdgeEndpoints.relationship_type_slug,
  confidence: Type.Optional(Confidence),
  source: Type.Optional(RelationshipSource),
  metadata: Type.Optional(Metadata),
  automation_source: Type.Optional(AutomationSource),
});

export const UnlinkEntitiesAction = Type.Object({
  action: Type.Literal("unlink", {
    description: "Soft-delete a relationship.",
  }),
  relationship_id: Type.Optional(RelationshipId),
  from_entity_id: Type.Optional(EdgeEndpoints.from_entity_id),
  to_entity_id: Type.Optional(EdgeEndpoints.to_entity_id),
  relationship_type_slug: Type.Optional(EdgeEndpoints.relationship_type_slug),
});

export const UpdateLinkAction = Type.Object({
  action: Type.Literal("update_link", {
    description: "Patch relationship metadata/confidence/source.",
  }),
  relationship_id: Type.Optional(RelationshipId),
  from_entity_id: Type.Optional(EdgeEndpoints.from_entity_id),
  to_entity_id: Type.Optional(EdgeEndpoints.to_entity_id),
  relationship_type_slug: Type.Optional(EdgeEndpoints.relationship_type_slug),
  confidence: Type.Optional(Confidence),
  source: Type.Optional(RelationshipSource),
  metadata: Type.Optional(Metadata),
});

export const ListLinksAction = Type.Object({
  action: Type.Literal("list_links", {
    description: "List relationships for an entity with filters + counts.",
  }),
  entity_id: EntityId,
  direction: Type.Optional(
    Type.Union(
      [Type.Literal("outbound"), Type.Literal("inbound"), Type.Literal("both")],
      { description: "[list_links] Direction filter. Default both." }
    )
  ),
  relationship_type_slug: Type.Optional(EdgeEndpoints.relationship_type_slug),
  confidence_min: Type.Optional(
    Type.Number({
      description: "[list_links] Minimum confidence threshold",
      minimum: 0,
      maximum: 1,
    })
  ),
  source: Type.Optional(RelationshipSource),
  include_deleted: Type.Optional(IncludeDeleted),
  ...paginationFields(100),
  automation_source: Type.Optional(AutomationSource),
});

export const MergeEntitiesAction = Type.Object({
  action: Type.Literal("merge", {
    description:
      "Fold a duplicate entity (entity_id) into the one it really is (winner_entity_id). The loser is tombstoned + forwarded; its identities, aliases, edges, and events recall against the winner. Events are never rewritten. Use when two entities are confirmed the same real-world thing.",
  }),
  // Merge target (the survivor) — the loser is passed as `entity_id`.
  winner_entity_id: Type.Number({
    description:
      "[merge] The surviving entity that absorbs `entity_id` (the duplicate).",
  }),
  entity_id: Type.Optional(EntityId),
  duplicate_entity_ids: Type.Optional(
    Type.Array(Type.Number(), {
      minItems: 1,
      maxItems: 25,
      uniqueItems: true,
      description:
        "[merge] All duplicate entities to fold into winner_entity_id. Use this for a duplicate group; entity_id remains supported for a single duplicate.",
    })
  ),
  merge_evidence: Type.Optional(
    Type.Array(
      Type.Object({
        kind: Type.String({ maxLength: 64 }),
        identifier: Type.String({ maxLength: 512 }),
        identity_ids: Type.Optional(
          Type.Array(Type.Number(), { maxItems: 50 })
        ),
      }),
      {
        maxItems: 25,
        description:
          "[merge] Optional structured evidence for human-initiated merge provenance. Agent and Automation evidence is always recomputed from the entity type's resolution policy.",
      }
    )
  ),
  merge_rationale: Type.Optional(
    Type.String({
      maxLength: 500,
      description:
        "[merge] Why you believe these are the same thing, in one sentence, for the human reviewing the approval card (e.g. 'Same phone digits; the shell is a WhatsApp handle for this contact.'). Shown as your claim, clearly separated from the workspace's own policy verdict — it never counts as proof and never affects whether the merge auto-applies.",
    })
  ),
  dry_run: Type.Optional(DryRun),
  automation_source: Type.Optional(AutomationSource),
});

export const ResolveDuplicatesAction = Type.Object({
  action: Type.Literal("resolve_duplicates", {
    description:
      "Discover duplicate components among candidate_entity_ids using the entity type's x-lobu-resolution policy, then auto-merge deterministic matches or queue review.",
  }),
  candidate_entity_ids: Type.Array(Type.Integer({ minimum: 1 }), {
    minItems: 2,
    maxItems: 5000,
    uniqueItems: true,
    description:
      "[resolve_duplicates] Candidate entity IDs. The server re-reads their values and applies the entity type's resolution policy.",
  }),
});

export const UnmergeEntityAction = Type.Object({
  action: Type.Literal("unmerge", {
    description:
      "Reverse a merge from its durable ledger: restore the loser's identities, canonical attributes, and relationships, then un-tombstone it. Fails closed if later edits made exact reversal unsafe.",
  }),
  entity_id: EntityId,
});

export const ManageEntitySchema = Type.Union([
  CreateEntityAction,
  UpdateEntityAction,
  ListEntitiesAction,
  GetEntityAction,
  DeleteEntityAction,
  LinkEntitiesAction,
  UnlinkEntitiesAction,
  UpdateLinkAction,
  ListLinksAction,
  MergeEntitiesAction,
  ResolveDuplicatesAction,
  UnmergeEntityAction,
]);

export type ManageEntityArgs = Static<typeof ManageEntitySchema>;

export type EntityCreateInput = ActionInput<ManageEntityArgs, "create">;
export type EntityUpdateInput = ActionInput<ManageEntityArgs, "update">;
export type EntityListInput = ActionInput<ManageEntityArgs, "list">;
export type EntityGetInput = ActionInput<ManageEntityArgs, "get">;
export type EntityDeleteInput = ActionInput<ManageEntityArgs, "delete">;
export type EntityLinkInput = ActionInput<ManageEntityArgs, "link">;
export type EntityUnlinkInput = ActionInput<ManageEntityArgs, "unlink">;
export type EntityUpdateLinkInput = ActionInput<
  ManageEntityArgs,
  "update_link"
>;
export type EntityListLinksInput = ActionInput<ManageEntityArgs, "list_links">;

// ============================================
// Result Types
// ============================================

// Relationship row shape (used by link actions)
export const RelationshipRowSchema = Type.Object({
  id: Type.Integer(),
  organization_id: Type.String(),
  from_entity_id: Type.Integer(),
  to_entity_id: Type.Integer(),
  relationship_type_id: Type.Integer(),
  relationship_type_slug: Type.String(),
  relationship_type_name: Type.String(),
  is_symmetric: Type.Boolean(),
  // Server-derived: this edge cannot be created or removed through this
  // surface — `unlink`/`update_link`/`link` all refuse it via
  // assertNotAclManagedEdge, because ACL edges are what the access gates read.
  // A client without this renders an unlink control that is guaranteed to 403.
  //
  // A derived flag rather than the raw `purpose`: the edge guard tests
  // purpose OR slug, so an unclassified `member_of` (declared by a config
  // before its first ACL sync) reads `purpose: null` and is still refused.
  // Only the server can evaluate that pair, so it ships the answer.
  //
  // Required, not optional: an absent flag reads as writable, which is the
  // dead affordance this exists to remove. Every producer projects it from
  // the one shared RELATIONSHIP_SELECT, so no path needs to omit it.
  acl_managed: Type.Boolean(),
  from_entity_name: Type.Optional(Type.String()),
  from_entity_type: Type.Optional(Type.String()),
  to_entity_name: Type.Optional(Type.String()),
  to_entity_type: Type.Optional(Type.String()),
  metadata: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  confidence: Type.Number(),
  source: Type.String(),
  created_by: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  updated_by: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  created_at: Type.String(),
  updated_at: Type.String(),
  deleted_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type RelationshipRow = Static<typeof RelationshipRowSchema>;

export const RelationshipCountByTypeSchema = Type.Object({
  relationship_type_slug: Type.String(),
  relationship_type_name: Type.String(),
  count: Type.Integer(),
});
export type RelationshipCountByType = Static<
  typeof RelationshipCountByTypeSchema
>;

/**
 * Shared entity shape across the create/update/get/list variants (the superset
 * of fields; each variant marks its extras optional). `metadata` and the
 * classifier/parent fields are loose on purpose — entities carry arbitrary
 * user/workspace metadata.
 */
export const ManageEntityItemSchema = Type.Object({
  id: Type.Integer(),
  entity_type: Type.String(),
  name: Type.String(),
  slug: Type.String(),
  parent_id: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  parent_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  parent_slug: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  parent_entity_type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  enabled_classifiers: Type.Optional(
    Type.Union([Type.Array(Type.String()), Type.Null()])
  ),
  // `created_at` arrives from the row as a `Date`; the structuredContent
  // validation layer coerces it to an ISO string before the check (Value.Convert
  // on Type.String() converts Date → ISO), so the schema declares the honest
  // on-the-wire shape — a string. (The former `Type.Unknown()` union arm made
  // this field accept ANY value, silently voiding its type.)
  created_at: Type.Optional(Type.String()),
  total_content: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  active_connections: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  automations_count: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  children_count: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  space_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  view_url: Type.Optional(Type.String()),
});

/**
 * Result of `manage_entity` — discriminated union keyed on `action`.
 * TypeBox-first: `Static<>` derives the TS type from the same schema exposed as
 * the tool's `outputSchema`.
 */
export const ManageEntityResultSchema = Type.Union([
  Type.Object({
    action: Type.Literal("create"),
    entity: Type.Optional(ManageEntityItemSchema),
    warnings: Type.Optional(Type.Array(Type.String())),
    next_steps: Type.Optional(Type.Array(Type.String())),
    approval_queued: Type.Optional(Type.Boolean()),
    approval_url: Type.Optional(Type.String()),
    approval_run_id: Type.Optional(Type.Integer()),
    approval_action: Type.Optional(Type.Literal("create")),
    approval_proposal: Type.Optional(
      Type.Record(Type.String(), Type.Unknown())
    ),
    approval_current: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    approval_attribution: Type.Optional(ApprovalAttributionSchema),
  }),
  Type.Object({
    action: Type.Literal("update"),
    entity: ManageEntityItemSchema,
    /** Fields the ownership-aware merge wrote (unowned for an automation-source edit). */
    applied_fields: Type.Optional(Type.Array(Type.String())),
    /** Human-owned fields the edit was blocked from writing — queued for approval. */
    blocked_fields: Type.Optional(Type.Array(Type.String())),
    /** True when a blocked-field approval was queued this call. */
    approval_queued: Type.Optional(Type.Boolean()),
    /** Permalink to the approval card, when one was queued. */
    approval_url: Type.Optional(Type.String()),
    /** Pending approval run id — the worker bridges this into a live chat
     *  approval card (parity with manage_agents' `pending_approval`). */
    approval_run_id: Type.Optional(Type.Integer()),
    /** Blocked field_path -> proposed value, for the live card diff. */
    approval_fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    /** Blocked field_path -> current human-owned value, for the diff. */
    approval_current: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    /** Who proposed the blocked change: 'agent' | 'automation'. */
    approval_attribution: Type.Optional(ApprovalAttributionSchema),
  }),
  Type.Object({
    action: Type.Literal("list"),
    entities: Type.Array(ManageEntityItemSchema),
    // Server-side resolution of every `x-link-entity-type` column referenced
    // by the page. Keyed by `${entityType}:${lookupField}`, then by the
    // lookup value from the row's metadata. Previously each entity-list page
    // fanned out one `manage_entity.list` per linked column (4× ~2.5 s on
    // the Company page); the FE now reads from this map instead.
    linked_entities: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Record(
          Type.String(),
          Type.Object({
            slug: Type.String(),
            entity_type: Type.String(),
            name: Type.String(),
          })
        )
      )
    ),
    metadata: Type.Object({
      page_size: Type.Integer(),
      has_more: Type.Boolean(),
      filtered_by_type: Type.Optional(Type.String()),
      total_count: Type.Optional(Type.Integer()),
      limit: Type.Optional(Type.Integer()),
      offset: Type.Optional(Type.Integer()),
      sort_by: Type.Optional(Type.String()),
      sort_order: Type.Optional(
        Type.Union([Type.Literal("asc"), Type.Literal("desc")])
      ),
    }),
  }),
  Type.Object({
    action: Type.Literal("get"),
    entity: ManageEntityItemSchema,
  }),
  Type.Object({
    action: Type.Literal("delete"),
    success: Type.Boolean(),
    message: Type.String(),
    deleted_count: Type.Integer(),
    dry_run: Type.Optional(Type.Boolean()),
    // Force-delete dependency report: what the delete removed/detached (or,
    // with dry_run, would). Events are never deleted — only detached.
    tree: Type.Optional(
      Type.Object({
        entities: Type.Integer(),
        relationships: Type.Integer(),
        automations_deleted: Type.Integer(),
        automations_detached: Type.Integer(),
        feeds_deleted: Type.Integer(),
        feeds_detached: Type.Integer(),
        events_detached: Type.Integer(),
      })
    ),
    approval_queued: Type.Optional(Type.Boolean()),
    approval_url: Type.Optional(Type.String()),
    approval_run_id: Type.Optional(Type.Integer()),
    approval_action: Type.Optional(Type.Literal("delete")),
    approval_proposal: Type.Optional(
      Type.Record(Type.String(), Type.Unknown())
    ),
    approval_current: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    approval_attribution: Type.Optional(ApprovalAttributionSchema),
  }),
  Type.Object({
    action: Type.Literal("link"),
    relationship: RelationshipRowSchema,
  }),
  Type.Object({
    action: Type.Literal("update_link"),
    relationship: RelationshipRowSchema,
  }),
  Type.Object({
    action: Type.Literal("unlink"),
    success: Type.Boolean(),
    message: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("list_links"),
    relationships: Type.Array(RelationshipRowSchema),
    counts_by_type: Type.Array(RelationshipCountByTypeSchema),
    metadata: Type.Object({
      total: Type.Integer(),
      limit: Type.Integer(),
      offset: Type.Integer(),
      has_more: Type.Boolean(),
    }),
  }),
  Type.Union([
    Type.Object({
      action: Type.Literal("merge"),
      success: Type.Boolean(),
      message: Type.String(),
      winner_entity_id: Type.Integer(),
      loser_entity_id: Type.Integer(),
      loser_entity_ids: Type.Optional(Type.Array(Type.Integer())),
      moved_identities: Type.Integer(),
      repointed_edges: Type.Integer(),
      // Preflight only. A dry run reports the rule verdict and writes nothing,
      // so moved_identities/repointed_edges are 0 and mean "not attempted".
      dry_run: Type.Optional(Type.Boolean()),
      resolution: Type.Optional(
        Type.Object({
          decision: Type.Union([
            Type.Literal("auto_merge"),
            Type.Literal("human"),
          ]),
          reason: Type.String(),
          evidence: Type.Array(
            Type.Object({ kind: Type.String(), identifier: Type.String() })
          ),
        })
      ),
    }),
    Type.Object({
      action: Type.Literal("merge"),
      approval_queued: Type.Literal(true),
      approval_url: Type.Optional(Type.String()),
      approval_run_id: Type.Integer(),
      approval_action: Type.Literal("merge"),
      approval_proposal: Type.Object({
        entity_id: Type.Integer(),
        entity_ids: Type.Optional(Type.Array(Type.Integer())),
        winner_entity_id: Type.Integer(),
      }),
      approval_attribution: ApprovalAttributionSchema,
      next_steps: Type.Array(Type.String()),
      resolution: Type.Optional(
        Type.Object({
          decision: Type.Literal("review"),
          reason: Type.String(),
          evidence: Type.Array(
            Type.Object({ kind: Type.String(), identifier: Type.String() })
          ),
        })
      ),
    }),
    Type.Object({
      action: Type.Literal("merge"),
      approval_suppressed: Type.Literal(true),
      message: Type.String(),
      resolution: Type.Object({
        decision: Type.Literal("review"),
        reason: Type.String(),
        evidence: Type.Array(
          Type.Object({ kind: Type.String(), identifier: Type.String() })
        ),
      }),
    }),
  ]),
  Type.Object({
    action: Type.Literal("resolve_duplicates"),
    candidates_scanned: Type.Integer(),
    groups_found: Type.Integer(),
    auto_merged: Type.Integer(),
    approvals_queued: Type.Integer(),
    approvals_suppressed: Type.Integer(),
    oversized_groups: Type.Integer(),
    deferred_candidates: Type.Integer({
      description:
        "Candidates connected only through another record; reconsidered after direct merges apply.",
    }),
  }),
  Type.Object({
    action: Type.Literal("unmerge"),
    success: Type.Boolean(),
    message: Type.String(),
    winner_entity_id: Type.Integer(),
    loser_entity_id: Type.Integer(),
    /** Identities restored to the loser with their prior provenance markers. */
    restored_identities: Type.Integer(),
  }),
]);
export type ManageEntityResult = Static<typeof ManageEntityResultSchema>;
