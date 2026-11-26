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
 * `AgentSettingsPatchSchema` omits store-owned updatedAt for declarative writes;
 * `manage_agents` update further omits identityMd (written as identity_md).
 * REST PATCH bodies and sanitized GET responses stay with the route that owns them.
 */
import { type Static, Type } from "@sinclair/typebox";

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

/**
 * A skill as `lobu.config.ts` declares it. Agent settings no longer carry
 * skills: they live in the workspace skill library (`manage_skills`). A skill
 * is its `content` body only; there is no `instructions` alternate and no
 * per-skill model or thinking override.
 */
export const SkillConfigSchema = Type.Object({
  repo: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  enabled: Type.Boolean(),
  system: Type.Optional(Type.Boolean()),
  content: Type.Optional(Type.String()),
});
export type SkillConfig = Static<typeof SkillConfigSchema>;

export const SkillsConfigSchema = Type.Object({
  skills: Type.Array(SkillConfigSchema),
});
export type SkillsConfig = Static<typeof SkillsConfigSchema>;

/**
 * Conversation starters an agent offers on an empty chat (web) and as Slack
 * assistant thread-start prompts. Same `{title,message}` shape as follow-up
 * chips; three at most so the empty state stays a short, tappable row.
 */
const AGENT_STARTERS_MAX = 3;
const AgentStarterSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 72 }),
  message: Type.String({ minLength: 1, maxLength: 2000 }),
});

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
  sandboxId: Type.Optional(Type.String()),
  verboseLogging: Type.Optional(Type.Boolean()),
  showToolCalls: Type.Optional(Type.Boolean()),
  starters: Type.Optional(
    Type.Array(AgentStarterSchema, { maxItems: AGENT_STARTERS_MAX })
  ),
  updatedAt: Type.Number(),
});
export type AgentSettingsStored = Static<typeof AgentSettingsStoredSchema>;

/** Writable stored settings; timestamps are always assigned by the store. */
export const AgentSettingsPatchSchema = Type.Omit(
  AgentSettingsStoredSchema,
  ["updatedAt"],
  { additionalProperties: false }
);
export type AgentSettingsPatch = Static<typeof AgentSettingsPatchSchema>;
