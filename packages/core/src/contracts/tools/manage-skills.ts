import { type Static, Type } from "@sinclair/typebox";
import {
  LIBRARY_SKILL_NAME_MAX_CHARS,
  SKILL_APPLIES_TO_MAX,
  SKILL_CONTENT_MAX_CHARS,
  SKILL_DESCRIPTION_MAX_CHARS,
} from "../../agent-tooling";
import type { ActionInput } from "./action-input";

/** Page size bounds for `manage_skills` `list`. */
export const SKILLS_LIST_DEFAULT_LIMIT = 50;
export const SKILLS_LIST_MAX_LIMIT = 100;

// ============================================
// Schema
// ============================================

/**
 * Who a workspace skill applies to: everyone (`principal_kind: null`), every
 * principal of a kind (`principal_id: null`), or one principal.
 */
export const SkillSubjectSchema = Type.Union([
  Type.Object({ principal_kind: Type.Null() }, { additionalProperties: false }),
  Type.Object(
    {
      principal_kind: Type.Union([Type.Literal("agent"), Type.Literal("app")]),
      principal_id: Type.Union([Type.String(), Type.Null()]),
    },
    { additionalProperties: false }
  ),
]);
export type SkillSubject = Static<typeof SkillSubjectSchema>;

export const WorkspaceSkillSchema = Type.Object({
  id: Type.String({ description: "Stable skill id" }),
  name: Type.String({
    description:
      "Unique among the workspace's unarchived skills: lowercase letters, digits and single inner hyphens, at most 64 characters",
  }),
  description: Type.String(),
  content: Type.String({ description: "The SKILL.md body" }),
  provenance: Type.Optional(Type.String()),
  applies_to: Type.Array(SkillSubjectSchema),
  enabled: Type.Boolean(),
  sort_order: Type.Integer({
    description: "Delivery order; ties order by name",
  }),
  revision: Type.Integer(),
  archived: Type.Boolean(),
});
export type WorkspaceSkill = Static<typeof WorkspaceSkillSchema>;

export const ListSkillsAction = Type.Object({
  action: Type.Literal("list", {
    description:
      "List the workspace skill library, ordered by (sort_order, name).",
  }),
  include_archived: Type.Optional(
    Type.Boolean({ description: "Include archived skills (default false)" })
  ),
  cursor: Type.Optional(
    Type.String({ description: "next_cursor from the previous page" })
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: SKILLS_LIST_MAX_LIMIT,
      default: SKILLS_LIST_DEFAULT_LIMIT,
      description: `Page size (default: ${SKILLS_LIST_DEFAULT_LIMIT}, max: ${SKILLS_LIST_MAX_LIMIT})`,
    })
  ),
});

export const GetSkillAction = Type.Object({
  action: Type.Literal("get", {
    description:
      "Fetch one skill by id, or an unarchived skill by name. Pass exactly one.",
  }),
  id: Type.Optional(Type.String({ description: "Skill id" })),
  name: Type.Optional(
    Type.String({ description: "Name of an unarchived skill" })
  ),
});

const SkillAppliesToSchema = Type.Array(SkillSubjectSchema, {
  maxItems: SKILL_APPLIES_TO_MAX,
  description: `Who the skill applies to (default: everyone). At most ${SKILL_APPLIES_TO_MAX} subjects.`,
});

/** The writable fields of a skill: everything but `id`, `revision` and `archived`. */
export const SkillInputSchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: LIBRARY_SKILL_NAME_MAX_CHARS,
      description:
        "Lowercase letters, digits and single inner hyphens. Fixed once created: a rename is archive plus create.",
    }),
    description: Type.String({
      minLength: 1,
      maxLength: SKILL_DESCRIPTION_MAX_CHARS,
    }),
    content: Type.String({
      minLength: 1,
      maxLength: SKILL_CONTENT_MAX_CHARS,
      description: "The SKILL.md body",
    }),
    provenance: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    applies_to: Type.Optional(SkillAppliesToSchema),
    enabled: Type.Optional(Type.Boolean({ default: true })),
    sort_order: Type.Optional(
      Type.Integer({
        default: 0,
        minimum: -2147483648,
        maximum: 2147483647,
        description: "Delivery order; ties order by name",
      })
    ),
  },
  { additionalProperties: false }
);
export type SkillInput = Static<typeof SkillInputSchema>;

const ExpectedRevision = Type.Integer({
  minimum: 0,
  description:
    "The revision the write is based on: 0 with no id creates; otherwise the skill's current revision, or the write fails with 409.",
});

export const PutSkillAction = Type.Object({
  action: Type.Literal("put", {
    description:
      "Create a skill (no id, expected_revision 0) or replace one (its id and current revision). Omitted optional fields take their defaults.",
  }),
  skill: SkillInputSchema,
  id: Type.Optional(Type.String({ description: "Skill id to replace" })),
  expected_revision: ExpectedRevision,
});

export const ArchiveSkillAction = Type.Object({
  action: Type.Literal("archive", {
    description:
      "Archive a skill. Its name becomes free for a new skill; the archived row keeps its id.",
  }),
  id: Type.String({ description: "Skill id" }),
  expected_revision: Type.Integer({
    minimum: 1,
    description: "The skill's current revision, or the archive fails with 409",
  }),
});

export const InstallSkillFromCatalogAction = Type.Object({
  action: Type.Literal("install_from_catalog", {
    description:
      "Add a catalog skill (manage_catalog list_catalog, kind skills) to the library, with provenance set to its catalog id.",
  }),
  catalog_id: Type.String({
    minLength: 1,
    description: "Catalog entry id, e.g. bundled/<name>",
  }),
  applies_to: Type.Optional(SkillAppliesToSchema),
});

export const ManageSkillsSchema = Type.Union([
  ListSkillsAction,
  GetSkillAction,
  PutSkillAction,
  ArchiveSkillAction,
  InstallSkillFromCatalogAction,
]);
export type ManageSkillsArgs = Static<typeof ManageSkillsSchema>;

/**
 * A skill write held for human approval: the `skill_config` policy asks for
 * approval for this principal and action. `run_id` is the pending approval.
 */
export const PendingSkillWriteSchema = Type.Object({
  status: Type.Literal("pending_approval"),
  run_id: Type.Number(),
  event_id: Type.Number(),
  message: Type.String(),
  proposal: Type.Record(Type.String(), Type.Unknown()),
});

export const ManageSkillsResultSchema = Type.Union([
  Type.Object({
    items: Type.Array(WorkspaceSkillSchema),
    next_cursor: Type.Union([Type.String(), Type.Null()]),
  }),
  Type.Object({ skill: WorkspaceSkillSchema }),
  PendingSkillWriteSchema,
]);
export type ManageSkillsResult = Static<typeof ManageSkillsResultSchema>;

export type SkillListInput = ActionInput<ManageSkillsArgs, "list">;
export type SkillGetInput = ActionInput<ManageSkillsArgs, "get">;
export type SkillPutInput = ActionInput<ManageSkillsArgs, "put">;
export type SkillArchiveInput = ActionInput<ManageSkillsArgs, "archive">;
export type SkillInstallFromCatalogInput = ActionInput<
  ManageSkillsArgs,
  "install_from_catalog"
>;
