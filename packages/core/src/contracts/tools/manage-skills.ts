import { type Static, Type } from "@sinclair/typebox";
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

export const ManageSkillsSchema = Type.Union([
  ListSkillsAction,
  GetSkillAction,
]);
export type ManageSkillsArgs = Static<typeof ManageSkillsSchema>;

export const ManageSkillsResultSchema = Type.Union([
  Type.Object({
    items: Type.Array(WorkspaceSkillSchema),
    next_cursor: Type.Union([Type.String(), Type.Null()]),
  }),
  Type.Object({ skill: WorkspaceSkillSchema }),
]);
export type ManageSkillsResult = Static<typeof ManageSkillsResultSchema>;

export type SkillListInput = ActionInput<ManageSkillsArgs, "list">;
export type SkillGetInput = ActionInput<ManageSkillsArgs, "get">;
