import { type Static, Type } from "@sinclair/typebox";
import type { GuardrailStage } from "../guardrails/types";
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
        "Who the guardrail applies to: agent subjects, or app subjects on a pre-tool-only guardrail (a pre-tool judge or forbidden-tools). Defaults to every agent.",
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

const GUARDRAIL_STAGES: readonly GuardrailStage[] = [
  "input",
  "output",
  "pre-tool",
  "egress",
];
const CUSTOM_CONFIG_KEYS = new Set([
  "kind",
  "stage",
  "policy",
  "model",
  "tools",
  "domains",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class GuardrailConfigError extends Error {}

function stringList(
  value: unknown,
  field: string,
  nonEmpty: boolean
): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw new GuardrailConfigError(
      `config.${field} must be an array of non-blank strings.`
    );
  }
  const items = [...new Set((value as string[]).map((item) => item.trim()))];
  if (nonEmpty && items.length === 0) {
    throw new GuardrailConfigError(`config.${field} must not be empty.`);
  }
  return items;
}

function canonicalGuardrailConfig(raw: unknown): WorkspaceGuardrailConfig {
  if (!isPlainObject(raw)) {
    throw new GuardrailConfigError("config must be an object.");
  }
  if ("builtin" in raw) {
    const extra = Object.keys(raw).filter((key) => key !== "builtin");
    if (extra.length > 0) {
      throw new GuardrailConfigError(
        `A built-in guardrail's config takes only "builtin"; remove ${extra.join(", ")}.`
      );
    }
    if (
      !(BUILTIN_GUARDRAIL_NAMES as readonly unknown[]).includes(raw.builtin)
    ) {
      throw new GuardrailConfigError(
        `config.builtin must be one of: ${BUILTIN_GUARDRAIL_NAMES.join(", ")}.`
      );
    }
    return { builtin: raw.builtin as BuiltinGuardrailName };
  }
  const unknown = Object.keys(raw).filter(
    (key) => !CUSTOM_CONFIG_KEYS.has(key)
  );
  if (unknown.length > 0) {
    throw new GuardrailConfigError(
      `config has unknown field(s): ${unknown.join(", ")}.`
    );
  }
  if (raw.kind !== "judge" && raw.kind !== "require-tool") {
    throw new GuardrailConfigError(
      'config.kind must be "judge" or "require-tool" (or pass config.builtin).'
    );
  }
  if (!GUARDRAIL_STAGES.includes(raw.stage as GuardrailStage)) {
    throw new GuardrailConfigError(
      `config.stage must be one of: ${GUARDRAIL_STAGES.join(", ")}.`
    );
  }
  const stage = raw.stage as GuardrailStage;
  if (raw.policy !== undefined && typeof raw.policy !== "string") {
    throw new GuardrailConfigError("config.policy must be a string.");
  }
  if (raw.model !== undefined && typeof raw.model !== "string") {
    throw new GuardrailConfigError("config.model must be a string.");
  }
  const model =
    typeof raw.model === "string" && raw.model.trim() !== ""
      ? raw.model.trim()
      : undefined;
  if (raw.kind === "require-tool") {
    if (stage !== "output") {
      throw new GuardrailConfigError(
        'A require-tool guardrail runs only at stage "output".'
      );
    }
    if (raw.domains !== undefined) {
      throw new GuardrailConfigError(
        "config.domains applies only to an egress judge."
      );
    }
    return {
      kind: "require-tool",
      stage,
      tools: stringList(raw.tools, "tools", true),
    };
  }
  if (typeof raw.policy !== "string" || raw.policy.trim() === "") {
    throw new GuardrailConfigError(
      "A judge guardrail needs a non-blank config.policy."
    );
  }
  if (raw.domains !== undefined && stage !== "egress") {
    throw new GuardrailConfigError(
      "config.domains applies only to an egress judge."
    );
  }
  if (raw.tools !== undefined && stage !== "pre-tool") {
    throw new GuardrailConfigError(
      "config.tools applies to a judge only at stage pre-tool."
    );
  }
  const domains =
    stage === "egress"
      ? stringList(raw.domains ?? [], "domains", true)
      : undefined;
  const tools =
    raw.tools === undefined ? undefined : stringList(raw.tools, "tools", true);
  return {
    kind: "judge",
    stage,
    policy: raw.policy,
    ...(model ? { model } : {}),
    ...(tools ? { tools } : {}),
    ...(domains ? { domains } : {}),
  };
}

/**
 * The config a guardrail stores, in one canonical key order, or the reason it
 * is invalid. These are the rules the runtime relies on and the schema cannot
 * express: a `judge` needs a policy, `require-tool` runs only at `output` and
 * needs tools, and an `egress` judge needs the domains it governs (one without
 * any never runs). The server validates every write with it; `lobu apply`
 * uses it to compare a declaration with the stored row.
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
