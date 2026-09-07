import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ConnectorAuthSchema,
  ConnectorDefinition,
  EntityMetrics,
  FeedDefinition,
} from "@lobu/connector-sdk";
import type { AgentSettings } from "@lobu/core";
import { createAjv } from "@lobu/core/ajv";
import type {
  AutomationEventTrigger,
  AutomationScheduleTrigger,
  AutomationWorkspaceEventTrigger,
} from "@lobu/core/contracts/tools/manage-automations";
import type Ajv from "ajv";
import type {
  ConnectorSource,
  InferenceCapabilityBlock,
  InferenceModality,
  Project,
  Skill,
} from "../../../config/index.js";
import { ValidationError } from "../../memory/_lib/errors.js";
import {
  type AgentMarkdown,
  mapProjectToDesiredState,
  mergeAgentDirArtifacts,
} from "./map-config.js";
import {
  type AutomationSource,
  type EntityBacking,
  isRecord,
  type RelationshipRule,
} from "./shared.js";

// ── Desired state types ────────────────────────────────────────────────────

export interface DesiredAgentMetadata {
  agentId: string;
  name: string;
  description?: string;
}

export interface DesiredEntityType {
  slug: string;
  name?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  /**
   * Event kinds (semantic types) for events linked to this type, keyed by
   * semantic_type — `{ description?, metadataSchema?, jsonTemplate? }`. Present
   * only when the type declares them; absent ⇒ never churns the diff. Persisted
   * to `entity_types.event_kinds` via manage_entity_schema.
   */
  eventKinds?: Record<string, unknown>;
  /**
   * The `x-lobu-resolution` metadata_schema key, lowered from the config's
   * `resolutionPolicy`. Present only when declared; folded into the upserted
   * metadata_schema (config wins over any out-of-band value) and diffed against
   * the remote `schemaExtras`.
   */
  resolutionPolicy?: Record<string, unknown>;
  /**
   * Write rules as raw source, read from the `rulesFromFile(path)` marker.
   * Present only when declared, so a type without rules never churns the diff.
   * The server compiles it; the CLI never ships a compiled artifact.
   */
  rulesSource?: { sourcePath: string; sourceCode: string };
  /**
   * Default view template (render-DSL root node) for this type's detail page.
   * Present only when declared. Applied via manage_view_templates set/clear and
   * diffed against the remote current default (which apply-cmd fetches per
   * relevant type — NOT streamed in the entity-type list). Prune-aware: under
   * prune an absent template clears the remote one; otherwise it is left alone.
   */
  viewTemplate?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /**
   * Present only for derived (SQL-view-backed) entity types; absent ⇒ stored
   * (the default). Normalized so a stored type compares equal on both sides
   * (desired + remote both omit it) and never churns the diff — see
   * {@link EntityBacking}.
   */
  backing?: EntityBacking;
  /**
   * Declared metric contract (eventSets/measures/dimensions/segments). Present
   * only when the type declares metrics; absent ⇒ not in the metric catalog.
   * Normalized so a type with no metrics compares equal on both sides and never
   * churns the diff (mirrors `backing`).
   */
  metrics?: EntityMetrics;
}

export interface DesiredRelationshipType {
  slug: string;
  name?: string;
  description?: string;
  rules?: RelationshipRule[];
  metadata?: Record<string, unknown>;
}

export interface DesiredAutomation {
  slug: string;
  /** Owning agent id. Every automation belongs to exactly one agent. */
  agent: string;
  name?: string;
  description?: string;
  triggers?: DesiredAutomationTrigger[];
  /**
   * The Automation's task statement, authored via `defineAutomation({ prompt })`.
   * Stored as the version's frozen instruction text (the internal `prompt`
   * column). Empty when the Automation's whole job is its skills, or when an
   * event-turn Automation relies on the server-side default at run time.
   */
  prompt: string;
  /**
   * Ordered skill names as written in config — the authoring input, resolved
   * into {@link DesiredAutomation.skillSnapshots} at load time.
   */
  skills?: string[];
  /**
   * The resolved `{name, content}` pairs actually sent to the server and pinned
   * onto the version. Separate from `skills` because the diff must compare
   * BODIES, not names: editing a skill's text changes nothing about the name
   * list, and a name-only diff would let a re-apply silently skip the update.
   */
  skillSnapshots?: Array<{ name: string; content: string }>;
  /** Optional SQL data sources; server applies a default when omitted. */
  sources?: AutomationSource[];
  /**
   * Reaction script — TypeScript source compiled + executed in an isolate at
   * automation-firing time. Authored as a sibling `.ts` file referenced by
   * `defineAutomation({ reaction: reactionFromFile("./reactions/foo.reaction.ts") })`;
   * the CLI reads it and pushes raw source via `set_reaction_script`.
   */
  reactionScript?: { sourcePath: string; sourceCode: string };
  /** LLM guidance for the automation's downstream reaction agent. */
  reactionsGuidance?: string;
  /** UUID of a device worker to pin this automation's runs to (see `device_workers.id`). */
  deviceWorkerId?: string;
  /** Execution model override; omitted preserves remote, null clears it. */
  model?: string | null;
  /** Minimum seconds between two firings of this automation (0 = no cooldown). */
  minCooldownSeconds?: number;
  /** Free-form tags for filtering. */
  tags?: string[];
  /** Optional agent-kind override (e.g. "background", "notifier"). */
  agentKind?: string;
  /** Named durable outputs; explicit null clears existing declarations. */
  outputs?: Record<string, unknown> | null;
  /** Classifier definitions for extraction (server-side feature). */
  classifiers?: unknown[];
}

/** Apply-internal trigger form; `connectionSlug` is resolved before mutation. */
export type DesiredAutomationEventTrigger = AutomationEventTrigger & {
  connectionSlug?: string;
};
export type DesiredAutomationTrigger =
  | DesiredAutomationEventTrigger
  | AutomationWorkspaceEventTrigger
  | AutomationScheduleTrigger;

export interface DesiredFeed {
  /** Feed key from the connector definition (`FeedDefinition.key`). */
  feedKey: string;
  name?: string;
  /**
   * Cron for automatic sync, tri-state after map-config: a string sets the
   * cadence, `null` clears it (manual-only), and omitted means the config does
   * not manage it — an update leaves the feed's remote cadence alone, and a
   * create gets no cron (the platform never invents a default).
   */
  schedule?: string | null;
  config?: Record<string, unknown>;
}

export interface DesiredConnection {
  /** Stable public identifier — diff key. */
  slug: string;
  /** Connector key (e.g. `github`, `hackernews`). */
  connector: string;
  name?: string;
  /** Slug of the runtime/account auth profile (`auth:` in the manifest). */
  authProfileSlug?: string;
  /** Slug of the OAuth-app auth profile (`app_auth:` in the manifest). */
  appAuthProfileSlug?: string;
  config?: Record<string, unknown>;
  /**
   * Set only for an explicitly declared BYO chat connection. Chat connections
   * apply through the secret-aware `apply_chat_connection` path so the server
   * persists a non-null `credential_mode` (the gateway only treats non-null
   * rows as chat) and resolves the token. Absent for data connectors and hosted
   * chat (which is filtered out of apply entirely).
   */
  credentialMode?: "byo";
  /**
   * Optional UUID pinning the connection's syncs/actions to a specific device
   * worker (`device_workers.id`). Required for connectors that declare a
   * `required_capability`; omit it for serverless-on-Lobu runs.
   */
  deviceWorkerId?: string;
  feeds: DesiredFeed[];
  /** Source label for error messages (the config the connection came from). */
  sourceFile: string;
}

export type DesiredAuthProfileKind =
  | "env"
  | "oauth_app"
  | "oauth_account"
  | "browser_session";

export interface DesiredAuthProfile {
  /** Stable slug — diff key. */
  slug: string;
  connector: string;
  kind: DesiredAuthProfileKind;
  name?: string;
  /**
   * key→value credentials. Values may be `$ENV` references (collected into
   * `requiredSecrets`). Only meaningful for `kind: env | oauth_app`; must be
   * absent/empty for `oauth_account | browser_session`.
   */
  credentials?: Record<string, string>;
  sourceFile: string;
}

export interface DesiredConnectorDefinition {
  /** Connector key — diff key (`null` until the server compiles a `.ts`). */
  key: string | null;
  /**
   * Best-effort static `definition.key` parsed from `sourceCode` WITHOUT a
   * compile. Used only to widen the pre-diff schema-skip set so re-applying a
   * local connector whose feed set changed doesn't validate the connection
   * against the stale server schema. NOT used for diffing/pruning — `key`
   * stays the authoritative (server-compiled) value there.
   */
  declaredKeyHint?: string;
  /** Local `.ts` path (absolute) — mutually exclusive with `sourceUrl`. */
  sourcePath?: string;
  /** Remote URL — mutually exclusive with `sourcePath`. */
  sourceUrl?: string;
  /**
   * Raw TypeScript source read from `sourcePath`, pushed verbatim to the
   * server (which compiles, extracts metadata, and returns the real `key`).
   * Absent when `sourceUrl` is used.
   */
  sourceCode?: string;
  /** For error messages — the `.connector.ts` file or `type: connector` doc. */
  sourceFile: string;
}

export interface DesiredAgent {
  metadata: DesiredAgentMetadata;
  /**
   * Settings payload destined for `PATCH /:agentId/config`. Built by the mapper
   * + agent-dir loader: networkConfig, skillsConfig,
   * preApprovedTools, guardrails, toolsConfig, nixConfig,
   * models (ordered `<provider>/<model>` refs),
   * identityMd/soulMd/userMd.
   */
  settings: Partial<AgentSettings>;
  /**
   * Provider API keys resolved from `secret()` / `$VAR` provider keys, pushed
   * into `agent_secrets` after the settings PATCH. Empty when no provider
   * declared a `key` (or all are unset). The value lives only in process
   * memory; never serialized.
   */
  providerKeys: { providerId: string; value: string }[];
}

/**
 * An org-owned inference provider resolved from `defineConfig({ providers })`.
 * The `apiKey` is resolved from its `secret()` / `$VAR` ref at map time (lives
 * only in process memory, never serialized into a plan row) — like an agent
 * provider key. Reconciled by apply against the `/inference-providers` API.
 */
export interface DesiredOrgProvider {
  slug: string;
  kind: string;
  displayName?: string;
  /** Resolved API key value (never the `$VAR` placeholder). */
  apiKey: string;
  /** Per-modality upstream overrides; empty ⇒ static semantics. */
  capabilities: Partial<Record<InferenceModality, InferenceCapabilityBlock>>;
}

export interface DesiredState {
  agents: DesiredAgent[];
  /**
   * When true (`defineConfig({ prune: true })`), `lobu apply` deletes org-owned
   * definitions (entity/relationship types, automations, connector definitions)
   * absent from this config — including ones created in the UI. Data,
   * connections, auth profiles, and agents are never pruned. Default false.
   */
  prune: boolean;
  /**
   * Org metadata from `defineConfig` — the org slug `lobu apply` defaults to,
   * the `organizationId` it matches against, and the name/description shown
   * when telling the operator to create the org.
   */
  memory?: {
    org?: string;
    organizationId?: string;
    name?: string;
    description?: string;
  };
  memorySchema: {
    entityTypes: DesiredEntityType[];
    relationshipTypes: DesiredRelationshipType[];
  };
  /** Automations declared via `defineAutomation`. */
  automations: DesiredAutomation[];
  /**
   * Connectors: local `*.connector.ts` definitions (declared via
   * `connectorFromFile`), `defineConnection`s, and `defineAuthProfile`s.
   */
  connectors: {
    definitions: DesiredConnectorDefinition[];
    authProfiles: DesiredAuthProfile[];
    connections: DesiredConnection[];
  };
  /**
   * Names of env vars referenced via `secret()` / `$VAR` (provider keys,
   * auth-profile + mcp credentials). The CLI surfaces these before mutating
   * remote state so missing secrets fail loud instead of expanding to empty.
   */
  requiredSecrets: string[];
  /**
   * Org-owned inference providers declared via `defineConfig({ providers })`.
   * Reconciled against the `/inference-providers` API — created if missing,
   * capability blocks updated per-modality, key rotated on every apply
   * (idempotent; the key can't be read back). Absent providers are reported as
   * drift, never auto-deleted.
   */
  providers: DesiredOrgProvider[];
}

// ── Load + transform ───────────────────────────────────────────────────────

interface SkillFrontmatter {
  name?: string;
  description?: string;
}

async function parseSkillFrontmatter(raw: string): Promise<{
  frontmatter: SkillFrontmatter | null;
  body: string;
}> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match?.[1]) return { frontmatter: null, body: raw.trim() };
  const { parse: parseYaml } = await import("yaml");
  const parsed = parseYaml(match[1]) as SkillFrontmatter | null;
  return {
    frontmatter: parsed && typeof parsed === "object" ? parsed : null,
    body: (match[2] || "").trim(),
  };
}

type SkillConfigEntry = NonNullable<
  AgentSettings["skillsConfig"]
>["skills"][number];

/**
 * Map a resolved skill (inline `defineSkill` or file-loaded `skillFromFile`)
 * into a `SkillConfig` entry — the shape stored on agent settings and synced to
 * the worker's `.skills/`. Skills are instruction text only — they declare no
 * nix, network, or MCP config.
 */
function skillToConfig(args: {
  name: string;
  content: string;
  source: "inline" | "file";
  description?: string;
}): SkillConfigEntry {
  const skill: SkillConfigEntry = {
    repo: `${args.source}/${args.name}`,
    name: args.name,
    content: args.content,
    enabled: true,
  };
  if (args.description) skill.description = args.description;
  return skill;
}

/** Read a `SKILL.md` (a dir holding one, or a `.md` path) for `skillFromFile`. */
async function readSkillFile(
  cwd: string,
  relPath: string,
  nameOverride?: string
): Promise<{ name: string; content: string; fm?: SkillFrontmatter }> {
  const abs = resolve(cwd, relPath);
  const filePath = abs.endsWith(".md") ? abs : join(abs, "SKILL.md");
  let raw: string;
  try {
    raw = (await readFile(filePath, "utf-8")).trim();
  } catch {
    throw new ValidationError(
      `skillFromFile("${relPath}"): no SKILL.md found at ${filePath}`
    );
  }
  if (!raw) {
    throw new ValidationError(
      `skillFromFile("${relPath}"): ${filePath} is empty`
    );
  }
  const { frontmatter, body } = await parseSkillFrontmatter(raw);
  const name =
    nameOverride ?? frontmatter?.name ?? basename(abs.replace(/\.md$/, ""));
  return { name, content: body, ...(frontmatter ? { fm: frontmatter } : {}) };
}

/** Resolve one declared skill (inline `defineSkill` or `skillFromFile`). */
async function resolveSkill(
  skill: Skill,
  cwd: string
): Promise<SkillConfigEntry> {
  if (skill.path !== undefined) {
    const { name, content, fm } = await readSkillFile(
      cwd,
      skill.path,
      skill.name
    );
    return skillToConfig({
      name,
      content,
      source: "file",
      description: fm?.description,
    });
  }
  if (!skill.name) {
    throw new ValidationError("defineSkill requires a `name`.");
  }
  return skillToConfig({
    name: skill.name,
    content: skill.content ?? "",
    source: "inline",
    description: skill.description,
  });
}

/** Byte cap on the skill snapshots pinned to one Automation version (issue #2320). */
const MAX_COMPILED_INSTRUCTIONS_BYTES = 32 * 1024;

/**
 * Resolve an Automation's ordered `skills[]` into frozen `{name, content}`
 * snapshots. Fails loud on a name the owning agent's library does not declare,
 * a name the worker cannot materialize safely, an empty body, or a total payload
 * over {@link MAX_COMPILED_INSTRUCTIONS_BYTES}.
 */
function resolveAutomationSkills(
  automation: DesiredAutomation,
  agentSkills: SkillConfigEntry[]
): Array<{ name: string; content: string }> {
  const names = automation.skills ?? [];
  if (names.length === 0) return [];
  const byName = new Map(agentSkills.map((skill) => [skill.name, skill]));
  const resolved = names.map((name) => {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new ValidationError(
        `Automation "${automation.slug}" cannot pin skill "${name}" — names may contain only letters, numbers, ".", "_", and "-"`
      );
    }
    const skill = byName.get(name);
    if (!skill) {
      throw new ValidationError(
        `Automation "${automation.slug}" references skill "${name}", but agent "${automation.agent}" declares no skill with that name in its skills library`
      );
    }
    const body = skill.content?.trim();
    if (!body) {
      throw new ValidationError(
        `Automation "${automation.slug}" references skill "${name}", but its body is empty — a pinned skill needs text`
      );
    }
    return { name, content: body };
  });
  // The cap is on total pinned text, not on any one skill: the whole set is
  // written into the worker's `.skills/` tree and, for a device-pinned Automation,
  // shipped in the dispatch payload.
  const bytes = resolved.reduce(
    (total, skill) => total + Buffer.byteLength(skill.content, "utf8"),
    0
  );
  if (bytes > MAX_COMPILED_INSTRUCTIONS_BYTES) {
    throw new ValidationError(
      `Automation "${automation.slug}" pins ${bytes} bytes of skill text — the maximum is ${MAX_COMPILED_INSTRUCTIONS_BYTES} (${MAX_COMPILED_INSTRUCTIONS_BYTES / 1024}KB)`
    );
  }
  return resolved;
}

/**
 * Resolve an agent's declared `skills` into `SkillConfig` entries, deduped by
 * name (a duplicate is an authoring error — explicit lists shouldn't collide).
 */
async function resolveAgentSkills(
  skills: Skill[],
  cwd: string
): Promise<SkillConfigEntry[]> {
  const resolved = await Promise.all(skills.map((s) => resolveSkill(s, cwd)));
  const byName = new Map<string, SkillConfigEntry>();
  for (const skill of resolved) {
    if (byName.has(skill.name)) {
      throw new ValidationError(
        `duplicate skill "${skill.name}" — skill names must be unique within an agent.`
      );
    }
    byName.set(skill.name, skill);
  }
  return [...byName.values()];
}

async function readMarkdown(agentDir: string): Promise<AgentMarkdown> {
  const result: AgentMarkdown = {};
  const files: Array<["identityMd" | "soulMd" | "userMd", string]> = [
    ["identityMd", "IDENTITY.md"],
    ["soulMd", "SOUL.md"],
    ["userMd", "USER.md"],
  ];
  for (const [key, filename] of files) {
    try {
      const content = await readFile(join(agentDir, filename), "utf-8");
      if (content.trim()) result[key] = content.trim();
    } catch {
      // missing file is fine
    }
  }
  return result;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ── Connector-config validation (used by apply-cmd with remote catalog) ────

export interface ResolvedConnectorSchemas {
  /** Connector key → `optionsSchema` (JSON Schema), if declared. */
  optionsSchema?: Record<string, unknown>;
  /** Every feed key declared by the connector (`connector.feeds` keys). */
  feedKeys: Set<string>;
  /** Feed key → `configSchema` (JSON Schema), for keys that declare one. */
  feedConfigSchemas: Map<string, Record<string, unknown>>;
  /** Allowed auth-profile kinds for the connector (from `authSchema.methods`). */
  authKinds: Set<string>;
}

function schemaFromAuthMethods(
  authSchema: ConnectorAuthSchema | Record<string, unknown> | null | undefined
): Set<string> {
  const kinds = new Set<string>();
  if (!authSchema || typeof authSchema !== "object") return kinds;
  const methods = (authSchema as { methods?: unknown }).methods;
  if (!Array.isArray(methods)) return kinds;
  for (const method of methods) {
    if (!isRecord(method)) continue;
    const t = asString(method.type);
    // ConnectorAuthMethod `type` ∈ env_keys | oauth | browser | interactive | none
    if (t === "env_keys") kinds.add("env");
    else if (t === "oauth") {
      kinds.add("oauth_app");
      kinds.add("oauth_account");
    } else if (t === "browser" || t === "interactive") {
      kinds.add("browser_session");
    }
  }
  return kinds;
}

/**
 * Build per-connector validation schemas from a connector definition. Accepts
 * either a typed `ConnectorDefinition` (from `@lobu/connector-sdk`) or the
 * snake_cased shape from `manage_catalog` connector entries
 * (`options_schema`, `feeds_schema`, `auth_schema`).
 */
export function resolveConnectorSchemas(
  def:
    | ConnectorDefinition
    | {
        options_schema?: Record<string, unknown> | null;
        feeds_schema?: Record<string, unknown> | null;
        auth_schema?: Record<string, unknown> | null;
      }
): ResolvedConnectorSchemas {
  const optionsSchema =
    ("optionsSchema" in def ? def.optionsSchema : undefined) ??
    ("options_schema" in def ? (def.options_schema ?? undefined) : undefined) ??
    undefined;
  const feedsRaw =
    ("feeds" in def ? def.feeds : undefined) ??
    ("feeds_schema" in def ? (def.feeds_schema ?? undefined) : undefined) ??
    undefined;
  const authSchema =
    ("authSchema" in def ? def.authSchema : undefined) ??
    ("auth_schema" in def ? (def.auth_schema ?? undefined) : undefined) ??
    undefined;

  const feedKeys = new Set<string>();
  const feedConfigSchemas = new Map<string, Record<string, unknown>>();
  if (feedsRaw && typeof feedsRaw === "object") {
    for (const [feedKey, feedDef] of Object.entries(
      feedsRaw as Record<string, FeedDefinition | Record<string, unknown>>
    )) {
      if (!feedDef || typeof feedDef !== "object") continue;
      feedKeys.add(feedKey);
      const cfg = (feedDef as { configSchema?: unknown }).configSchema;
      if (cfg && typeof cfg === "object") {
        feedConfigSchemas.set(feedKey, cfg as Record<string, unknown>);
      }
    }
  }

  return {
    ...(optionsSchema ? { optionsSchema } : {}),
    feedKeys,
    feedConfigSchemas,
    authKinds: schemaFromAuthMethods(authSchema),
  };
}

let sharedAjv: Ajv | null = null;
function getAjv(): Ajv {
  if (!sharedAjv) {
    // `allErrors: true` here (unlike the server's fail-fast singleton): this
    // validates the operator's OWN local `lobu apply` config, not untrusted
    // remote input, so the CWE-400 error-amplification concern doesn't apply
    // and reporting every mismatch at once is the friendlier apply UX.
    sharedAjv = createAjv({ allErrors: true, strict: false });
  }
  return sharedAjv;
}

function validateAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
  context: string
): void {
  const ajv = getAjv();
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    // A malformed connector schema is the connector author's problem, not the
    // operator's — surface it but don't block the whole apply on it.
    throw new ValidationError(
      `${context}: connector declares an invalid JSON schema — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!validate(value ?? {})) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "(root)"} ${e.message ?? ""}`.trim())
      .join("; ");
    throw new ValidationError(
      `${context}: ${detail || "does not match the connector schema"}`
    );
  }
}

/**
 * Validate a single connection (+ its feeds) and its referenced auth-profile
 * kinds against a resolved connector schema. Pass `null` to skip schema
 * checks (e.g. a connector that only exists as a local `.ts` not yet
 * compiled by the server) — structural checks have already run at load time.
 */
export function validateConnectionAgainstConnector(
  connection: DesiredConnection,
  authProfiles: ReadonlyMap<string, DesiredAuthProfile>,
  schemas: ResolvedConnectorSchemas | null
): void {
  const declaredConnectionPlatform =
    schemas?.optionsSchema?.["x-lobu-chat-platform"] ??
    schemas?.optionsSchema?.["x-lobu-adapterless-platform"];
  const isByoConnection =
    typeof declaredConnectionPlatform === "string" &&
    declaredConnectionPlatform === connection.connector;
  if (schemas && connection.credentialMode === "byo" && !isByoConnection) {
    throw new ValidationError(
      `${connection.sourceFile}: connection "${connection.slug}" uses credentialMode "byo", but connector "${connection.connector}" does not declare the chat capability or an adapterless connection platform`
    );
  }
  if (schemas && isByoConnection && connection.credentialMode !== "byo") {
    if (connection.config?.managedBy) {
      throw new ValidationError(
        `${connection.sourceFile}: managed connection "${connection.slug}" is owned by the OAuth/install flow and cannot be declared in config`
      );
    }
    throw new ValidationError(
      `${connection.sourceFile}: connection "${connection.slug}" must declare credentialMode "byo" (hosted connections use "hosted" and are not persisted)`
    );
  }
  // Validate against `{}` when config is omitted too — that surfaces missing
  // required keys instead of letting an empty config slip through.
  if (schemas?.optionsSchema) {
    // `managedBy` is Lobu metadata (cloud-grant delegation), not a connector
    // option — strip it before validating against the connector's option schema
    // so a strict (additionalProperties:false) schema doesn't reject it.
    const optionConfig = { ...(connection.config ?? {}) };
    delete optionConfig.managedBy;
    validateAgainstSchema(
      schemas.optionsSchema,
      optionConfig,
      `${connection.sourceFile}: connection "${connection.slug}" config`
    );
  }
  for (const feed of connection.feeds) {
    if (!schemas) continue;
    if (schemas.feedKeys.size > 0 && !schemas.feedKeys.has(feed.feedKey)) {
      throw new ValidationError(
        `${connection.sourceFile}: connection "${connection.slug}" references unknown feed "${feed.feedKey}" for connector "${connection.connector}" (known feeds: ${[...schemas.feedKeys].sort().join(", ") || "(none)"})`
      );
    }
    const feedSchema = schemas.feedConfigSchemas.get(feed.feedKey);
    if (feedSchema) {
      validateAgainstSchema(
        feedSchema,
        feed.config ?? {},
        `${connection.sourceFile}: connection "${connection.slug}" feed "${feed.feedKey}" config`
      );
    }
  }
  // `auth:` must reference a runtime/account profile (never `oauth_app`);
  // `app_auth:` must reference an `oauth_app` profile.
  if (connection.authProfileSlug) {
    const profile = requireAuthProfile(
      connection,
      authProfiles,
      connection.authProfileSlug
    );
    if (profile.kind === "oauth_app") {
      throw new ValidationError(
        `${connection.sourceFile}: connection "${connection.slug}" \`auth\` references auth profile "${connection.authProfileSlug}" of kind \`oauth_app\` — use \`app_auth\` for OAuth-app credentials and \`auth\` for the account/runtime profile`
      );
    }
  }
  if (connection.appAuthProfileSlug) {
    const profile = requireAuthProfile(
      connection,
      authProfiles,
      connection.appAuthProfileSlug
    );
    if (profile.kind !== "oauth_app") {
      throw new ValidationError(
        `${connection.sourceFile}: connection "${connection.slug}" \`app_auth\` must reference an \`oauth_app\` auth profile (got \`${profile.kind}\`)`
      );
    }
  }
}

/** Keys the connector treats as feed-scoped (declared in any feed's `configSchema`). */
export function feedScopedKeys(schemas: ResolvedConnectorSchemas): Set<string> {
  const keys = new Set<string>();
  for (const feedSchema of schemas.feedConfigSchemas.values()) {
    const props = (feedSchema as { properties?: Record<string, unknown> })
      .properties;
    if (props) for (const k of Object.keys(props)) keys.add(k);
  }
  return keys;
}

/**
 * The server stores feed-scoped settings on feeds, not the connection, and
 * REJECTS a connection whose config carries any feed-scoped key (see
 * `splitConfigByFeedScope` in packages/server). `lobu apply` mirrors that split
 * here: any feed-scoped key found in a connection's `config` is demoted to a
 * per-feed default (an explicit feed value wins) and removed from the
 * connection config. `managedBy` is Lobu metadata, never a connector option, so
 * it stays on the connection. Returns the demoted key names so the caller can
 * warn. Mutates `connection` in place so the normalized shape flows into the
 * diff + create/update payloads.
 */
export function normalizeConnectionConfigScope(
  connection: DesiredConnection,
  schemas: ResolvedConnectorSchemas | null
): string[] {
  if (!schemas || !connection.config) return [];
  const scoped = feedScopedKeys(schemas);
  if (scoped.size === 0) return [];
  const demoted: Record<string, unknown> = {};
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(connection.config)) {
    if (k !== "managedBy" && scoped.has(k)) demoted[k] = v;
    else kept[k] = v;
  }
  const demotedKeys = Object.keys(demoted);
  if (demotedKeys.length === 0) return [];
  connection.feeds = connection.feeds.map((feed) => ({
    ...feed,
    config: { ...demoted, ...(feed.config ?? {}) },
  }));
  connection.config = Object.keys(kept).length > 0 ? kept : undefined;
  return demotedKeys;
}

function requireAuthProfile(
  connection: DesiredConnection,
  authProfiles: ReadonlyMap<string, DesiredAuthProfile>,
  slugRef: string
): DesiredAuthProfile {
  const profile = authProfiles.get(slugRef);
  if (!profile) {
    throw new ValidationError(
      `${connection.sourceFile}: connection "${connection.slug}" references auth profile "${slugRef}" which is not declared in any \`type: auth_profile\` doc`
    );
  }
  if (profile.connector !== connection.connector) {
    throw new ValidationError(
      `${connection.sourceFile}: connection "${connection.slug}" references auth profile "${slugRef}" for connector "${profile.connector}", but the connection uses connector "${connection.connector}"`
    );
  }
  return profile;
}

export function validateAuthProfileAgainstConnector(
  profile: DesiredAuthProfile,
  schemas: ResolvedConnectorSchemas | null
): void {
  if (!schemas) return;
  if (schemas.authKinds.size > 0 && !schemas.authKinds.has(profile.kind)) {
    throw new ValidationError(
      `${profile.sourceFile}: auth_profile "${profile.slug}" uses \`kind: ${profile.kind}\`, but connector "${profile.connector}" supports: ${[...schemas.authKinds].sort().join(", ") || "(none)"}`
    );
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

interface LoadDesiredStateOptions {
  /** Project root (directory containing `lobu.config.ts`). */
  cwd: string;
  /** Env to resolve `$VAR` refs against; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * When set, only the named resource family is loaded — `"agents"` and
   * `"memory"` both skip the `connectors/` dir (and its `$VAR` credential
   * expansion), so `--only agents` doesn't require connector secrets.
   */
  only?: "agents" | "memory";
}

/**
 * Resolve the project's explicit `connectors: [connectorFromFile(...)]` list
 * into connector definitions to compile + ship. Replaces directory
 * auto-discovery: only listed connectors are uploaded. Paths are relative to
 * the config dir and guarded (no absolute, `..`, or backslash escapes),
 * mirroring `resolveReactionScript`.
 *
 * Each source ships with `key: null`; `apply-cmd` compiles each `sourcePath` on
 * the CLI (where the project's node_modules is available) and the server
 * resolves the real key. We intentionally do NOT compile/instantiate here to
 * resolve the key eagerly — that would force a full esbuild + module load on
 * every load (including `--dry-run`) for no benefit, since the server is the
 * source of truth for the compiled key. A connection that references a
 * connector by a bare *string* key relies on that string matching the file's
 * compiled `definition.key`; reference it by its `defineConnector` class
 * (`connector: myConnector`) to make that match exact.
 */
/**
 * Best-effort extraction of a connector's static `definition.key` from its
 * source WITHOUT compiling it. Connector keys are always plain string literals
 * (the platform indexes on them statically), declared as the first `key:` in
 * the `definition` object — e.g. `readonly definition: ConnectorDefinition = {
 * key: "linkedin", ...`. Returns `null` when the shape can't be matched with
 * confidence, preserving the prior null-key semantics (the server remains the
 * authoritative source of the compiled key; this hint only affects which
 * connectors the pre-diff pass treats as locally-declared).
 */
export function extractDeclaredConnectorKey(sourceCode: string): string | null {
  // Anchor on the `definition` assignment so we don't pick up an unrelated
  // earlier `key:` (feed keys are nested and come later, after this match).
  const defIdx = sourceCode.search(/\bdefinition\b\s*(?::[^=]*)?=\s*\{/);
  if (defIdx === -1) return null;
  const after = sourceCode.slice(defIdx);
  const keyMatch = after.match(/\bkey\s*:\s*(["'`])([^"'`]+)\1/);
  return keyMatch?.[2] ?? null;
}

function resolveConnectorSources(
  sources: ConnectorSource[],
  cwd: string
): DesiredConnectorDefinition[] {
  const baseDir = resolve(cwd);
  const defs: DesiredConnectorDefinition[] = [];
  for (const src of sources) {
    const rel = src.path.trim();
    if (!rel) {
      throw new ValidationError(
        "connectorFromFile() requires a path to a `*.connector.ts` file"
      );
    }
    if (rel.startsWith("/") || rel.includes("\\")) {
      throw new ValidationError(
        `connectorFromFile(${JSON.stringify(rel)}) must be a relative POSIX path (./foo.connector.ts) — absolute paths and backslashes are not allowed`
      );
    }
    if (rel.split("/").some((seg) => seg === "..")) {
      throw new ValidationError(
        `connectorFromFile(${JSON.stringify(rel)}) must not contain \`..\` segments — keep the connector under the config directory`
      );
    }
    if (!rel.endsWith(".ts")) {
      throw new ValidationError(
        `connectorFromFile(${JSON.stringify(rel)}) must point at a \`.ts\` file`
      );
    }
    const abs = resolve(baseDir, rel);
    const relPath = relative(baseDir, abs);
    if (
      relPath === ".." ||
      relPath.startsWith(`..${sep}`) ||
      isAbsolute(relPath)
    ) {
      throw new ValidationError(
        `connectorFromFile(${JSON.stringify(rel)}) resolves outside the config directory (${abs})`
      );
    }
    let sourceCode: string;
    try {
      sourceCode = readFileSync(abs, "utf-8");
    } catch {
      throw new ValidationError(
        `connectorFromFile(${JSON.stringify(rel)}) does not exist (resolved to ${abs})`
      );
    }
    defs.push({
      // `key` stays null: the server compiles the source and is the
      // authoritative source of the real key, and null-ness gates the diff /
      // prune logic (see diff.ts `hasUnnamedLocalDefs`). We keep a separate
      // best-effort static hint (no compile) purely to widen the pre-diff
      // schema-skip set — see `localConnectorKeyHints` in apply-cmd. Without it,
      // re-applying a connector whose feed set changed (e.g. folding takeout
      // feeds into `linkedin`) validates the connection against the STALE
      // server schema and rejects the new feeds.
      key: null,
      declaredKeyHint: extractDeclaredConnectorKey(sourceCode) ?? undefined,
      sourcePath: abs,
      sourceCode,
      sourceFile: rel.replace(/^\.\//, ""),
    });
  }
  return defs.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
}

const REACTION_SCRIPT_MAX_BYTES = 256 * 1024;
const ENTITY_RULES_MAX_BYTES = 32 * 1024;

/**
 * Resolve + read a local source file referenced from the config: relative POSIX
 * path under the config directory, ends in `.ts`, no `..` / absolute / backslash
 * segments, under a byte cap. Ships RAW source — the server compiles it.
 *
 * Shared by Automation reaction scripts and entity-type write rules. Both ship
 * source the same way and both need the same containment checks, so they get one
 * implementation rather than two that drift; only the wording differs.
 */
function resolveLocalSourceFile(args: {
  cwd: string;
  /** e.g. `Automation "daily-digest"` — names the owner in every error. */
  owner: string;
  /** The config field, e.g. `reaction` or `rules`. */
  field: string;
  /** A correct call to show when the path is missing or malformed. */
  example: string;
  rel: string;
  maxBytes: number;
  /** Appended to the size error to say what a sane file looks like. */
  sizeHint: string;
}): { sourcePath: string; sourceCode: string } {
  const { cwd, owner, field, example, rel, maxBytes, sizeHint } = args;
  const trimmed = rel.trim();
  if (!trimmed) {
    throw new ValidationError(
      `${owner} \`${field}\` must be a path to a sibling .ts file (e.g. \`${example}\`)`
    );
  }
  if (trimmed.startsWith("/") || trimmed.includes("\\")) {
    throw new ValidationError(
      `${owner} \`${field}\` must be a relative POSIX path (./foo.ts) — absolute paths and backslashes are not allowed`
    );
  }
  if (trimmed.split("/").some((seg) => seg === "..")) {
    throw new ValidationError(
      `${owner} \`${field}\` must not contain \`..\` segments — keep the file under the config directory`
    );
  }
  if (!trimmed.endsWith(".ts")) {
    throw new ValidationError(
      `${owner} \`${field}\` must end in \`.ts\` (got ${JSON.stringify(trimmed)})`
    );
  }
  const baseDir = resolve(cwd);
  const abs = resolve(baseDir, trimmed);
  // Containment check via `relative` (cross-platform): a hard-coded `${baseDir}/`
  // prefix uses POSIX `/` and wrongly rejects every path on Windows (backslash
  // separators). `rel` is "" when abs === baseDir, starts with ".." when abs
  // escapes baseDir, and is absolute when on a different drive.
  const relPath = relative(baseDir, abs);
  if (
    relPath === ".." ||
    relPath.startsWith(`..${sep}`) ||
    isAbsolute(relPath)
  ) {
    throw new ValidationError(
      `${owner} \`${field}\` resolves outside the config directory (${abs})`
    );
  }
  let sourceCode: string;
  try {
    sourceCode = readFileSync(abs, "utf-8");
  } catch {
    throw new ValidationError(
      `${owner} \`${field}\` ${trimmed} does not exist (resolved to ${abs})`
    );
  }
  if (Buffer.byteLength(sourceCode, "utf8") > maxBytes) {
    throw new ValidationError(
      `${owner} \`${field}\` exceeds the ${maxBytes}-byte cap — ${sizeHint}`
    );
  }
  return { sourcePath: abs, sourceCode };
}

/** Ships RAW source; the server compiles it on receipt via `set_reaction_script`. */
function resolveReactionScript(
  cwd: string,
  automationSlug: string,
  rel: string
): { sourcePath: string; sourceCode: string } {
  return resolveLocalSourceFile({
    cwd,
    owner: `Automation ${JSON.stringify(automationSlug)}`,
    field: "reaction",
    example: 'reactionFromFile("./reactions/foo.reaction.ts")',
    rel,
    maxBytes: REACTION_SCRIPT_MAX_BYTES,
    sizeHint:
      "reaction scripts should be a few hundred lines, not a vendored library",
  });
}

/**
 * Entity-type write rules (`rulesFromFile(path)`). Ships RAW source; the server
 * compiles it into `entity_types.rules_compiled` on receipt.
 *
 * Capped far below a reaction script on purpose: a rule runs inside the write
 * transaction on every write to its type, so it is meant to be a page of
 * invariants, not a program.
 */
function resolveEntityRules(
  cwd: string,
  entityTypeKey: string,
  rel: string
): { sourcePath: string; sourceCode: string } {
  return resolveLocalSourceFile({
    cwd,
    owner: `Entity type ${JSON.stringify(entityTypeKey)}`,
    field: "rules",
    example: 'rulesFromFile("./rules/invoice.ts")',
    rel,
    maxBytes: ENTITY_RULES_MAX_BYTES,
    sizeHint:
      "write rules run inside the write transaction and should be a page of invariants, not a program",
  });
}

/**
 * Import a `lobu.config.ts` and return its `defineConfig` default export (the
 * SDK {@link Project}). Shared by {@link loadDesiredStateFromConfig} (apply) and
 * the commands that read the authored config directly (`lobu run` preview
 * registration, `lobu doctor`, `lobu chat`, `lobu validate`, `lobu memory seed`).
 *
 * Uses jiti — the same runtime TypeScript loader Next.js/Nuxt use for their
 * `*.config.ts` — which transpiles on import and resolves the config's imports
 * (`@lobu/cli/config`, `@lobu/connector-sdk`, relative reaction/connector files)
 * from the project. No bundling, no temp file. The dynamic `import("jiti")` is
 * lazy + allow-listed (AGENTS.md).
 */
export async function loadProjectConfig(
  cwd: string
): Promise<{ project: Project; configPath: string }> {
  const configPath = resolve(cwd, "lobu.config.ts");
  if (!existsSync(configPath)) {
    throw new ValidationError(`No lobu.config.ts found in ${cwd}`);
  }
  const { createJiti } = await import("jiti");
  // Resolve the SDK imports the config will reference (`@lobu/cli/config`,
  // `@lobu/connector-sdk`) against the running CLI's own copies — not the
  // project's `node_modules`. This lets a freshly-scaffolded project
  // `validate`/`run` with zero install: the user has the CLI, that's enough.
  // Falls through silently if a symbol can't be resolved from here (the
  // catch-all error below still surfaces real problems).
  const alias: Record<string, string> = {};
  for (const spec of ["@lobu/cli/config", "@lobu/connector-sdk"]) {
    try {
      alias[spec] = fileURLToPath(import.meta.resolve(spec));
    } catch {
      // CLI dist may not expose this symbol in some packaging layouts; skip.
    }
  }
  const jiti = createJiti(
    pathToFileURL(configPath).href,
    Object.keys(alias).length > 0 ? { alias } : undefined
  );
  let project: unknown;
  try {
    project = await jiti.import(configPath, { default: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Failed to load lobu.config.ts — ${message}`);
  }
  if (
    !project ||
    typeof project !== "object" ||
    (project as { kind?: unknown }).kind !== "project"
  ) {
    throw new ValidationError(
      "lobu.config.ts must `export default defineConfig({ ... })`"
    );
  }
  return { project: project as Project, configPath };
}

/**
 * Load desired state from a TypeScript entrypoint (`lobu.config.ts`): import the
 * `defineConfig()` project, map it to `DesiredState`, then attach the
 * file-based artifacts (agent-dir markdown + skills, automation reaction scripts,
 * local connector source).
 */
export async function loadDesiredStateFromConfig(
  opts: LoadDesiredStateOptions
): Promise<{ state: DesiredState; configPath: string; warnings: string[] }> {
  const env = opts.env ?? process.env;
  const { project: typedProject, configPath } = await loadProjectConfig(
    opts.cwd
  );
  const state = mapProjectToDesiredState(typedProject, env, opts.only);

  // Agent artifacts: SOUL/IDENTITY/USER.md (convention, from the agent dir) +
  // skills (explicit `defineAgent({ skills })`, inline or `skillFromFile`). The
  // mapper stays pure (no file IO); we read the files here and merge them in.
  const skillsByAgentId = new Map<string, SkillConfigEntry[]>();
  await Promise.all(
    typedProject.agents.map(async (agent, i) => {
      const settings = state.agents[i]?.settings;
      if (!settings) return;
      const agentDir = resolve(opts.cwd, agent.dir ?? join("agents", agent.id));
      const markdown = await readMarkdown(agentDir);
      const localSkills = await resolveAgentSkills(
        agent.skills ?? [],
        opts.cwd
      );
      mergeAgentDirArtifacts(settings, markdown, localSkills);
      skillsByAgentId.set(agent.id, localSkills);
    })
  );

  // Resolve each Automation's `skills[]` to {name, content} snapshots against the
  // owning agent's library. This happens BEFORE the diff reads them, so a change
  // to a referenced skill's BODY still drives version churn — re-applying is how
  // a config project takes a skill update, and the diff is what notices.
  //
  // The bodies are no longer folded into `prompt`: the prompt is the author's
  // task statement (or empty), and skills ride alongside as pinned files.
  for (const automation of state.automations) {
    automation.skillSnapshots = resolveAutomationSkills(
      automation,
      skillsByAgentId.get(automation.agent) ?? []
    );
  }

  // Automation reaction scripts: a sibling `.ts` file referenced by path. The
  // mapper stays pure; resolve + read the source here (raw, server compiles
  // it) and attach it. state.automations[i] aligns with typedProject.automations[i]
  // (the mapper maps them in order).
  (typedProject.automations ?? []).forEach((automation, i) => {
    // Gate on absence, not truthiness — a present-but-empty
    // `reactionFromFile("")` must reach the validator (which rejects it),
    // matching parseAutomation.
    if (automation.reaction === undefined) return;
    const dw = state.automations[i];
    if (!dw) return;
    // `reaction` is typed ReactionSource, but jiti evaluates the config without
    // typechecking, so a stale `reaction: "./x.reaction.ts"` string slips
    // through and would read `.path` as undefined. Reject it with a clear
    // message instead of a downstream TypeError. (An empty `reactionFromFile("")`
    // keeps a string path and still reaches the validator, which rejects it.)
    const reactionPath = (automation.reaction as { path?: unknown }).path;
    if (typeof reactionPath !== "string") {
      throw new Error(
        `Automation "${automation.slug}": set reaction with reactionFromFile("./x.reaction.ts"), not a bare string path.`
      );
    }
    dw.reactionScript = resolveReactionScript(
      opts.cwd,
      automation.slug,
      reactionPath
    );
  });

  // Entity-type write rules: same shape as reaction scripts — a sibling `.ts`
  // referenced by path, read here (raw) rather than in the pure mapper.
  // state.memorySchema.entityTypes[i] aligns with typedProject.entities[i].
  (typedProject.entities ?? []).forEach((entity, i) => {
    if (entity.rules === undefined) return;
    const desired = state.memorySchema?.entityTypes?.[i];
    if (!desired) return;
    // Typed as EntityRulesSource, but jiti evaluates the config without
    // typechecking, so a bare string path slips through and would read `.path`
    // as undefined. Reject it with a clear message, matching the reaction path.
    const rulesPath = (entity.rules as { path?: unknown }).path;
    if (typeof rulesPath !== "string") {
      throw new Error(
        `Entity type "${entity.key}": set rules with rulesFromFile("./rules/x.ts"), not a bare string path.`
      );
    }
    desired.rulesSource = resolveEntityRules(opts.cwd, entity.key, rulesPath);
  });

  // `--only agents|memory` skips connectors (matching the mapper), so don't
  // ship local connector source for those runs either.
  if (!opts.only) {
    state.connectors.definitions = resolveConnectorSources(
      typedProject.connectors ?? [],
      opts.cwd
    );
  }
  // Surface load-time warnings to `lobu apply` (which prints them). #1010's
  // "ignored connectors because [memory] is disabled" case is obsolete here —
  // lobu.config.ts has no `[memory].enabled` gate, so connectors always load —
  // but the channel is kept so future TS-loader warnings flow to the operator.
  const warnings: string[] = [];
  return { state, configPath, warnings };
}
