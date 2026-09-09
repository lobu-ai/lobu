/**
 * AgentSettings TypeBox contract family — the single source for the agent
 * settings shape across every surface (declarative, CLI apply, admin tools,
 * REST/MCP, Owletto UI, persistence, worker wire).
 *
 * Why this exists: `AgentSettings` was a hand-written `interface` duplicated
 * across `core/agent-store.ts` and `owletto/lib/api/agents.ts`, which drifted
 * in opposite directions (core had `mcpInstallNotified`; owletto had
 * `mcpServers`; `models` optional vs required). A TypeBox schema is
 * runtime-validatable AND derives the TS type via `Static<typeof>`, so every
 * surface imports one definition — drift becomes a compile error, not a
 * shipped-three-quarters-complete feature.
 *
 * Split (per reviewer Q1):
 *  - `AgentSettingsStoredSchema` — what the DB persists. EXCLUDES
 *    `authProfiles` (Postgres stores it in a separate table; the GET route
 *    merges it dynamically — `agent-routes.ts:1315,1686`). Includes
 *    `updatedAt` (set by the DB on every write).
 *  - `AgentSettings` (the runtime type) = `Static<Stored> & { authProfiles? }`
 *    — a superset of stored, matching the existing interface every consumer
 *    already uses, so this is a drop-in replacement.
 *
 * `Patch` (PATCH body, null=clear vs undefined=unchanged) and `Response`
 * (sanitized GET, redacted secrets + merged authProfiles) are follow-on
 * schemas built on top of Stored; they belong with the route that owns them.
 */
import { type Static, Type } from "@sinclair/typebox";
import type { GuardrailStage } from "../guardrails/types";

// ── Nested schemas ──────────────────────────────────────────────────────────

export const NetworkConfigSchema = Type.Object({
  allowedDomains: Type.Optional(Type.Array(Type.String())),
  deniedDomains: Type.Optional(Type.Array(Type.String())),
});
export type NetworkConfig = Static<typeof NetworkConfigSchema>;

export const NixConfigSchema = Type.Object({
  flakeUrl: Type.Optional(Type.String()),
  packages: Type.Optional(Type.Array(Type.String())),
});
export type NixConfig = Static<typeof NixConfigSchema>;

export const ToolsConfigSchema = Type.Object({
  allowedTools: Type.Optional(Type.Array(Type.String())),
  deniedTools: Type.Optional(Type.Array(Type.String())),
  strictMode: Type.Optional(Type.Boolean()),
});
export type ToolsConfig = Static<typeof ToolsConfigSchema>;

// GuardrailStage lives in guardrails/types.ts as the canonical union. The
// schema mirrors it exactly; if the union grows, the _StageCheck assertion
// below fails at compile time. (TypeBox can't derive from a TS type at
// runtime, so this is the minimal, guarded duplication — not a parallel
// definition that can silently drift.)
const GUARDRAIL_STAGES = ["input", "output", "pre-tool", "egress"] as const;
export const GuardrailStageSchema = Type.Union(
  GUARDRAIL_STAGES.map((s) => Type.Literal(s))
);
// Compile-time bidirectional check: GUARDRAIL_STAGES must match GuardrailStage.
type _StageCheck = GuardrailStage extends (typeof GUARDRAIL_STAGES)[number]
  ? (typeof GUARDRAIL_STAGES)[number] extends GuardrailStage
    ? true
    : never
  : never;
const _stageCheck: _StageCheck = true;
void _stageCheck;

/**
 * Operator-authored guardrail on an agent.
 *
 * - `kind: "judge"` (default when omitted) — LLM text judge; needs `policy`.
 * - `kind: "require-tool"` — pure lookup against this turn's `toolsUsed`;
 *   needs `tools` (manual tool names). Fixed policy: missing tool trips;
 *   an unreported toolsUsed value passes. No model call.
 */
/**
 * NOTE: this is a permissive object, not a discriminated union — `policy` and
 * `tools` are optional here even though each variant requires one of them.
 * Narrowing the shape would force every one of the ~37 read sites to discriminate
 * before touching a field, for no safety gain: `guardrailsInline` is only ever
 * written through `validateGuardrailsInline` (server/src/lobu/agent-routes.ts),
 * which rejects a judge with no policy AND a require-tool with no tools before
 * anything is persisted. Keep that validator as the enforcement point; if a
 * second write path is ever added, it must call the same validator.
 */
export const AgentInlineGuardrailSchema = Type.Object({
  name: Type.String(),
  enabled: Type.Boolean(),
  stage: GuardrailStageSchema,
  /** Defaults to `"judge"` when omitted (backward compatible). */
  kind: Type.Optional(
    Type.Union([Type.Literal("judge"), Type.Literal("require-tool")])
  ),
  /** Required for `kind: "judge"` (enforced by validateGuardrailsInline). */
  policy: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  /**
   * For `judge` pre-tool: optional tool-name filter (run only for these tools).
   * For `require-tool`: the tool name(s) that must appear in this turn's
   * `toolsUsed` (manual, e.g. `["suggest_actions"]`).
   */
  tools: Type.Optional(Type.Array(Type.String())),
  domains: Type.Optional(Type.Array(Type.String())),
});
export type AgentInlineGuardrail = Static<typeof AgentInlineGuardrailSchema>;

const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

export const SkillConfigSchema = Type.Object({
  repo: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  instructions: Type.Optional(Type.String()),
  enabled: Type.Boolean(),
  system: Type.Optional(Type.Boolean()),
  content: Type.Optional(Type.String()),
  // No `nixPackages`: a skill is instruction text, and generic tooling lives on
  // the agent's `nixConfig` (issue #2320). Stored rows written before the field
  // was dropped still validate — `Type.Object` admits unknown keys — and every
  // reader has ignored the value since #2324, so a legacy entry simply stops
  // round-tripping through the editor the first time an agent's skills are saved.
  modelPreference: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
});
export type SkillConfig = Static<typeof SkillConfigSchema>;

export const SkillsConfigSchema = Type.Object({
  skills: Type.Array(SkillConfigSchema),
});
export type SkillsConfig = Static<typeof SkillsConfigSchema>;

// ── AgentSettingsStored ─────────────────────────────────────────────────────

/**
 * What the DB persists (the `agents` row's settings jsonb columns). EXCLUDES
 * `authProfiles` — that's stored in a separate table and merged on GET.
 * `updatedAt` is included (set by the DB on every write, returned on read).
 *
 * Mirrors the field set of the legacy `AgentSettings` interface in
 * `agent-store.ts` exactly, so `AgentSettings = Static<Stored> & { authProfiles? }`
 * is a structural drop-in. The dead `mcpInstallNotified` field is NOT carried
 * over (removed in `fix/delete-mcp-install-notified`).
 */
export const AgentSettingsStoredSchema = Type.Object({
  models: Type.Optional(Type.Array(Type.String())),
  networkConfig: Type.Optional(NetworkConfigSchema),
  nixConfig: Type.Optional(NixConfigSchema),
  soulMd: Type.Optional(Type.String()),
  userMd: Type.Optional(Type.String()),
  identityMd: Type.Optional(Type.String()),
  skillsConfig: Type.Optional(SkillsConfigSchema),
  toolsConfig: Type.Optional(ToolsConfigSchema),
  guardrails: Type.Optional(Type.Array(Type.String())),
  guardrailsInline: Type.Optional(Type.Array(AgentInlineGuardrailSchema)),
  sandboxId: Type.Optional(Type.String()),
  verboseLogging: Type.Optional(Type.Boolean()),
  showToolCalls: Type.Optional(Type.Boolean()),
  preApprovedTools: Type.Optional(Type.Array(Type.String())),
  updatedAt: Type.Number(),
});
export type AgentSettingsStored = Static<typeof AgentSettingsStoredSchema>;
