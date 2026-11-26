import { type Static, Type } from "@sinclair/typebox";
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

/**
 * A guardrail's config: the built-in check it runs, enforced at every stage
 * the built-in implements.
 */
export const WorkspaceGuardrailConfigSchema = Type.Object({
  builtin: Type.Union(
    BUILTIN_GUARDRAIL_NAMES.map((name) => Type.Literal(name))
  ),
});
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
 * `enabled` defaults to true. Subjects name agents (every agent with
 * `principal_id: null`, or one agent) or, on a guardrail that runs at the
 * pre-tool stage only, apps (every app, or one app key): an app's calls to
 * Lobu's MCP server are checked before they run.
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
        "Who the guardrail applies to: agent subjects, or app subjects on a pre-tool-only guardrail (forbidden-tools). Defaults to every agent.",
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class GuardrailConfigError extends Error {}

function canonicalGuardrailConfig(raw: unknown): WorkspaceGuardrailConfig {
  if (!isPlainObject(raw)) {
    throw new GuardrailConfigError("config must be an object.");
  }
  const extra = Object.keys(raw).filter((key) => key !== "builtin");
  if (extra.length > 0) {
    throw new GuardrailConfigError(
      `A guardrail's config takes only "builtin"; remove ${extra.join(", ")}.`
    );
  }
  if (!(BUILTIN_GUARDRAIL_NAMES as readonly unknown[]).includes(raw.builtin)) {
    throw new GuardrailConfigError(
      `config.builtin must be one of: ${BUILTIN_GUARDRAIL_NAMES.join(", ")}.`
    );
  }
  return { builtin: raw.builtin as BuiltinGuardrailName };
}

/**
 * The config a guardrail stores, in canonical form, or the reason it is
 * invalid. The server validates every write with it; `lobu apply` uses it to
 * compare a declaration with the stored row.
 */
export function parseGuardrailConfig(
  raw: unknown
):
  | { ok: true; config: WorkspaceGuardrailConfig }
  | { ok: false; error: string } {
  try {
    return { ok: true, config: canonicalGuardrailConfig(raw) };
  } catch (error) {
    if (error instanceof GuardrailConfigError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
