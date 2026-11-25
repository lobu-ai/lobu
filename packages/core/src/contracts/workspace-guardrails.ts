import { type Static, Type } from "@sinclair/typebox";
import { GuardrailStageSchema } from "./agent-settings";
import { SkillSubjectSchema } from "./tools/manage-skills";

/** Page size bounds for the guardrail library `list`. */
export const GUARDRAILS_LIST_DEFAULT_LIMIT = 50;
export const GUARDRAILS_LIST_MAX_LIMIT = 100;

/** The built-in guardrails the gateway registers. */
export const BUILTIN_GUARDRAIL_NAMES = [
  "secret-scan",
  "pii-scan",
  "forbidden-tools",
] as const;
export type BuiltinGuardrailName = (typeof BUILTIN_GUARDRAIL_NAMES)[number];

/**
 * Who a workspace guardrail applies to: everyone (`principal_kind: null`),
 * every principal of a kind (`principal_id: null`), or one principal. The same
 * subject shape as the skill library.
 */
export const GuardrailSubjectSchema = SkillSubjectSchema;
export type GuardrailSubject = Static<typeof GuardrailSubjectSchema>;

/** A built-in check, enforced at every stage the built-in implements. */
export const BuiltinGuardrailConfigSchema = Type.Object({
  builtin: Type.Union(
    BUILTIN_GUARDRAIL_NAMES.map((name) => Type.Literal(name))
  ),
});

/**
 * A custom check: an LLM `judge` with its own policy, or `require-tool`
 * (output stage only), which fails a turn that never called one of `tools`.
 */
export const CustomGuardrailConfigSchema = Type.Object({
  kind: Type.Union([Type.Literal("judge"), Type.Literal("require-tool")]),
  stage: GuardrailStageSchema,
  /** The judge's policy. Required for `judge`. */
  policy: Type.Optional(Type.String()),
  /** The judge model; the organization's default model when omitted. */
  model: Type.Optional(Type.String()),
  /**
   * For a `pre-tool` judge: run only for these tools. For `require-tool`: the
   * tool names one of which the turn must call.
   */
  tools: Type.Optional(Type.Array(Type.String())),
  /** For an `egress` judge: the domain patterns it governs. */
  domains: Type.Optional(Type.Array(Type.String())),
});

export const WorkspaceGuardrailConfigSchema = Type.Union([
  BuiltinGuardrailConfigSchema,
  CustomGuardrailConfigSchema,
]);
export type BuiltinGuardrailConfig = Static<
  typeof BuiltinGuardrailConfigSchema
>;
export type CustomGuardrailConfig = Static<typeof CustomGuardrailConfigSchema>;
export type WorkspaceGuardrailConfig = Static<
  typeof WorkspaceGuardrailConfigSchema
>;

export const WorkspaceGuardrailSchema = Type.Object({
  id: Type.String({ description: "Stable guardrail id" }),
  name: Type.String({
    description:
      "Unique among the workspace's unarchived guardrails: lowercase letters, digits and single inner hyphens, at most 64 characters",
  }),
  config: WorkspaceGuardrailConfigSchema,
  applies_to: Type.Array(GuardrailSubjectSchema),
  enabled: Type.Boolean(),
  revision: Type.Integer(),
  archived: Type.Boolean(),
});
export type WorkspaceGuardrail = Static<typeof WorkspaceGuardrailSchema>;

export const ListGuardrailsParamsSchema = Type.Object({
  include_archived: Type.Optional(
    Type.Boolean({ description: "Include archived guardrails (default false)" })
  ),
  cursor: Type.Optional(
    Type.String({ description: "next_cursor from the previous page" })
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: GUARDRAILS_LIST_MAX_LIMIT,
      default: GUARDRAILS_LIST_DEFAULT_LIMIT,
      description: `Page size (default: ${GUARDRAILS_LIST_DEFAULT_LIMIT}, max: ${GUARDRAILS_LIST_MAX_LIMIT})`,
    })
  ),
});
export type ListGuardrailsParams = Static<typeof ListGuardrailsParamsSchema>;

export interface ListGuardrailsResult {
  items: WorkspaceGuardrail[];
  next_cursor: string | null;
}

export interface GetGuardrailResult {
  guardrail: WorkspaceGuardrail;
}

/**
 * A guardrail's writable fields. `applies_to` defaults to every agent;
 * `enabled` defaults to true. Subjects name agents only: every agent
 * (`principal_id: null`) or one agent.
 */
export const GuardrailInputSchema = Type.Object({
  name: Type.String({
    description:
      "Lowercase letters, digits and single inner hyphens, at most 64 characters. Fixed once created: a rename is archive plus create.",
  }),
  config: WorkspaceGuardrailConfigSchema,
  applies_to: Type.Optional(
    Type.Array(GuardrailSubjectSchema, {
      description:
        "Who the guardrail applies to: agent subjects only. Defaults to every agent.",
    })
  ),
  enabled: Type.Optional(Type.Boolean({ description: "Default true" })),
});
export type GuardrailInput = Static<typeof GuardrailInputSchema>;

/**
 * `PUT /api/:org/guardrails` (create, `expected_revision: 0`) and
 * `PUT /api/:org/guardrails/:id` (full replace at the current revision).
 */
export const PutGuardrailBodySchema = Type.Object({
  guardrail: GuardrailInputSchema,
  expected_revision: Type.Integer({
    minimum: 0,
    description:
      "0 to create; otherwise the revision being replaced (409 when stale)",
  }),
});
export type PutGuardrailBody = Static<typeof PutGuardrailBodySchema>;

export interface PutGuardrailResult {
  guardrail: WorkspaceGuardrail;
}

/** True when `config` is a built-in toggle rather than a custom check. */
export function isBuiltinGuardrailConfig(
  config: WorkspaceGuardrailConfig
): config is BuiltinGuardrailConfig {
  return "builtin" in config;
}
