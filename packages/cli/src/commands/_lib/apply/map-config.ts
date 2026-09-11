/**
 * Map an authoring project (the default export of `lobu.config.ts`, built by
 * `defineConfig` from `@lobu/cli/config`) to the apply `DesiredState`.
 *
 * `DesiredState` is an apply-internal IR and stays CLI-private; this is the one
 * place that translates the public authoring objects into it. The mapping is
 * pure (modulo `installedAt` timestamps, matching the TOML loader) so it can be
 * unit-tested without importing `lobu.config.ts`.
 */

import { validateEntityMetrics } from "@lobu/connector-sdk/metrics";
import {
  type AgentSettings,
  isHostedChatPlatform,
  normalizeEntityTypeSlug,
} from "@lobu/core";
import type { AgentSettingsStored } from "@lobu/core/contracts/agent-settings";
import {
  normalizeWorkspaceEventTrigger,
  resolvedEventExecution,
} from "@lobu/core/contracts/tools/manage-automations";

/**
 * Exhaustiveness projection over the stored AgentSettings shape. Every key is
 * REQUIRED (the `-?` removes optionality) so a new field added to the schema
 * that this mapper doesn't handle is a compile error, not a silent drop.
 *
 * `authProfiles` is excluded (separate-store, merged on GET).
 * `updatedAt` is excluded (store-owned, set by the DB).
 *
 * This is the compile-time drift guarantee: the declarative mapper cannot
 * forget a field.
 */
type AgentSettingsProjection = {
  [K in Exclude<keyof AgentSettingsStored, "updatedAt" | "authProfiles">]-?:
    | AgentSettingsStored[K]
    | undefined;
};

/**
 * Marker for each stored field's declarative status. Also exhaustive over the
 * same key set, so a new field with no policy entry also fails to compile.
 * - "mapped": produced by this converter
 * - "unsupported": not declarable in lobu.config.ts (intentional)
 * - "post-load": filled later by mergeAgentDirArtifacts
 */
const AGENT_SETTINGS_FIELD_POLICY = {
  models: "mapped",
  networkConfig: "mapped",
  nixConfig: "mapped",
  soulMd: "post-load",
  userMd: "post-load",
  identityMd: "post-load",
  skillsConfig: "post-load",
  toolsConfig: "mapped",
  guardrails: "mapped",
  guardrailsInline: "unsupported",
  sandboxId: "unsupported",
  verboseLogging: "unsupported",
  showToolCalls: "unsupported",
  preApprovedTools: "mapped",
} as const satisfies Record<
  Exclude<keyof AgentSettingsStored, "updatedAt" | "authProfiles">,
  "mapped" | "post-load" | "unsupported"
>;
void AGENT_SETTINGS_FIELD_POLICY;

import { CronExpressionParser } from "cron-parser";
import type {
  Agent,
  AuthProfile,
  Automation,
  Connection,
  ConnectorRef,
  EntityType,
  InferenceCapabilityBlock,
  OrgProvider,
  Project,
  ProviderConfig,
  RelationshipType,
} from "../../../config/index.js";
import { isSecretRef, UNRESOLVED_MODEL_SUFFIX } from "../../../config/index.js";
import { ValidationError } from "../../memory/_lib/errors.js";
import type {
  DesiredAgent,
  DesiredAgentMetadata,
  DesiredAuthProfile,
  DesiredConnection,
  DesiredEntityType,
  DesiredFeed,
  DesiredOrgProvider,
  DesiredRelationshipType,
  DesiredState,
  DesiredAutomation,
} from "./desired-state.js";

/** Source label recorded on connector docs (mirrors the YAML manifest path). */
const CONFIG_SOURCE = "lobu.config.ts";

// Mirror the TOML loader's structural validators so a malformed TS config fails
// loud in the CLI before any remote mutation, not with a confusing server 4xx.
const CONNECTION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const AUTH_PROFILE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MIN_CRON_INTERVAL_MS = 60_000;

/** Throw on the first duplicate identifier in a collection (config parity). */
function assertUniqueBy<T>(
  items: readonly T[],
  key: (item: T) => string,
  label: string
): void {
  const seen = new Set<string>();
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) {
      throw new ValidationError(
        `duplicate ${label} "${k}" in lobu.config.ts — each must be unique`
      );
    }
    seen.add(k);
  }
}

/** Error message if the cron is invalid or fires more than once a minute, else null. */
function cronError(schedule: string): string | null {
  try {
    const it = CronExpressionParser.parse(schedule);
    const first = it.next().toDate();
    const second = it.next().toDate();
    if (second.getTime() - first.getTime() < MIN_CRON_INTERVAL_MS) {
      return `schedule "${schedule}" is too frequent (minimum interval is 1 minute)`;
    }
    return null;
  } catch (err) {
    return `invalid cron expression "${schedule}" — ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** `"$NAME"` → `"NAME"`, else null. Mirrors the TOML loader's env-ref detection. */
function envRefName(value: string): string | null {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
  return match ? (match[1] ?? null) : null;
}

/** Provider slug used as the storage key. `id` is required on a provider. */
function providerId(provider: ProviderConfig): string {
  return (provider.id ?? "").trim();
}

/**
 * Org-provider slug rules — MUST match the DB CHECK in the inference_providers
 * migration exactly (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`): lowercase
 * alphanumeric + hyphen, 1-63 chars, no leading/trailing hyphen. Kept in lockstep
 * so `lobu apply` rejects a bad slug up front instead of the server 500ing on the
 * CHECK. Single-char slugs are allowed; a trailing hyphen (`myvllm-`) is not.
 */
const ORG_PROVIDER_SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Modalities the server accepts for an inference-provider capability block. */
const INFERENCE_MODALITIES = new Set([
  "text",
  "image",
  "stt",
  "tts",
  "embedding",
]);

/**
 * Map an org-owned inference provider (`defineConfig({ providers })`) to its
 * `DesiredOrgProvider`. Resolves the API key from its `secret()` / `$VAR` ref
 * to the REAL value at apply time (mirroring {@link resolveCredentialValue} and
 * the agent-provider key path — apply pushes the resolved value to the server,
 * never the `$VAR` placeholder) and collects the ref into `required` so the
 * secrets gate fails loud when unset. Validates the slug + declared modalities
 * so a malformed config fails in the CLI, not with a confusing server 4xx.
 */
function mapOrgProvider(
  provider: OrgProvider,
  required: Set<string>,
  env: NodeJS.ProcessEnv
): DesiredOrgProvider {
  if (!ORG_PROVIDER_SLUG_PATTERN.test(provider.slug)) {
    throw new ValidationError(
      `provider slug "${provider.slug}" must match /^[a-z0-9][a-z0-9-]{0,62}$/ (lowercase letters/digits/hyphens, no leading hyphen, ≤63 chars)`
    );
  }
  if (!provider.kind) {
    throw new ValidationError(
      `provider "${provider.slug}" must declare a non-empty \`kind\``
    );
  }

  const capabilities: Record<string, InferenceCapabilityBlock> = {};
  for (const [modality, block] of Object.entries(provider.capabilities ?? {})) {
    if (!INFERENCE_MODALITIES.has(modality)) {
      throw new ValidationError(
        `provider "${provider.slug}" declares unknown modality "${modality}" (expected text|image|stt|tts|embedding)`
      );
    }
    if (block) capabilities[modality] = block;
  }

  return {
    slug: provider.slug,
    kind: provider.kind,
    ...(provider.displayName ? { displayName: provider.displayName } : {}),
    apiKey: resolveCredentialValue(provider.key, required, env),
    capabilities,
  };
}

/** Resolve a connector reference (key string, or the class from `defineConnector`) to its key. */
function connectorKey(ref: ConnectorRef): string {
  if (typeof ref === "string") return ref;
  return new ref().definition.key;
}

function entitySlug(ref: EntityType | string): string {
  return normalizeEntityTypeSlug(typeof ref === "string" ? ref : ref.key);
}

function agentId(ref: Agent | string): string {
  return typeof ref === "string" ? ref : ref.id;
}

function authProfileSlug(
  ref: AuthProfile | string | undefined
): string | undefined {
  if (ref === undefined) return undefined;
  return typeof ref === "string" ? ref : ref.slug;
}

/**
 * Resolve a credential to its actual secret value, mirroring the TOML loader's
 * connector-credential handling (`loadConnectors` in desired-state.ts): a
 * `secret()` / `$VAR` ref resolves to its env value — apply pushes the REAL
 * value to the DB, never the `$VAR` placeholder — and a literal passes through.
 * The ref is collected so the apply secrets gate fails loud when it is unset
 * (the placeholder is only returned as a safe fallback the gate then rejects).
 */
function resolveCredentialValue(
  value: string | { readonly $secret: string },
  required: Set<string>,
  env: NodeJS.ProcessEnv
): string {
  if (isSecretRef(value)) {
    required.add(value.$secret);
    return env[value.$secret] ?? `$${value.$secret}`;
  }
  const ref = envRefName(value);
  if (ref) {
    required.add(ref);
    return env[ref] ?? value;
  }
  return value;
}

/** Resolve top-level secret/env refs in connection config; preserve typed options. */
function resolveConnectionConfigValue(
  value: unknown,
  required: Set<string>,
  env: NodeJS.ProcessEnv
): unknown {
  return typeof value === "string" || isSecretRef(value)
    ? resolveCredentialValue(value, required, env)
    : value;
}

/** Skill entries resolved from `defineAgent({ skills })` (inline + file). */
type LocalSkills = NonNullable<AgentSettings["skillsConfig"]>["skills"];

/** Agent-dir prompt markdown (read by the loader from SOUL/IDENTITY/USER.md). */
export interface AgentMarkdown {
  soulMd?: string;
  identityMd?: string;
  userMd?: string;
}

/**
 * Merge an agent's file-resolved artifacts (prompt markdown from its dir +
 * skills declared via `defineAgent({ skills })`) into the already-mapped agent
 * settings. Pure (no file IO — the loader reads the files and passes the
 * results in) so it can be unit-tested directly.
 *
 * Skills are instruction text only — they contribute no nix, network, or MCP
 * config. Packages come from the agent (`nixConfig`, already in `settings`) or
 * connector `agentTooling`, never from skills.
 */
export function mergeAgentDirArtifacts(
  settings: Partial<AgentSettings>,
  markdown: AgentMarkdown,
  localSkills: LocalSkills
): void {
  if (markdown.soulMd) settings.soulMd = markdown.soulMd;
  if (markdown.identityMd) settings.identityMd = markdown.identityMd;
  if (markdown.userMd) settings.userMd = markdown.userMd;

  if (localSkills.length > 0) {
    settings.skillsConfig = { skills: localSkills };
  }
}

function mapAgent(
  agent: Agent,
  env: NodeJS.ProcessEnv,
  required: Set<string>
): DesiredAgent {
  const settings: Partial<AgentSettings> = {};

  if (agent.providers?.length) {
    // Each declared provider becomes one explicit ref in the ordered `models`
    // list (index 0 = the primary/default). A provider WITH a concrete model
    // emits `<providerId>/<model>` (never `<providerId>/auto` — auto is gone);
    // a model already `<slug>/`-qualified (provider-native ids can contain
    // slashes) is used verbatim, never double-prefixed. A provider with NO
    // model (e.g. ChatGPT, which has no catalog default) emits the
    // `<providerId>/__unresolved__` restriction sentinel — the same way the
    // server represents "provider intended, no model resolved" — so the agent
    // stays gated (never allow-all) and the config still applies without a
    // crash.
    settings.models = agent.providers.map((p) => {
      const id = providerId(p);
      // A provider with no id is a config error — it would emit a bogus
      // "/__unresolved__" ref the server rejects. Fail loudly at map time.
      if (!id) {
        throw new Error(
          `Agent "${agent.id}" has a provider with no "id". Every provider must declare an "id" (e.g. { id: "openai", model: "gpt-5" }).`
        );
      }
      const model = p.model?.trim();
      if (!model) return `${id}/${UNRESOLVED_MODEL_SUFFIX}`;
      return model.startsWith(`${id}/`) ? model : `${id}/${model}`;
    });
  }

  const allowed = agent.network?.allowed ?? [];
  const denied = agent.network?.denied ?? [];
  if (allowed.length > 0 || denied.length > 0) {
    settings.networkConfig = {
      ...(allowed.length > 0 ? { allowedDomains: [...new Set(allowed)] } : {}),
      ...(denied.length > 0 ? { deniedDomains: [...new Set(denied)] } : {}),
    };
  }

  if (agent.tools) {
    if (agent.tools.preApproved?.length) {
      settings.preApprovedTools = [...new Set(agent.tools.preApproved)];
    }
    const toolsConfig: NonNullable<AgentSettings["toolsConfig"]> = {};
    if (agent.tools.allowed?.length) {
      toolsConfig.allowedTools = [...new Set(agent.tools.allowed)];
    }
    if (agent.tools.denied?.length) {
      toolsConfig.deniedTools = [...new Set(agent.tools.denied)];
    }
    if (agent.tools.strict !== undefined)
      toolsConfig.strictMode = agent.tools.strict;
    if (Object.keys(toolsConfig).length > 0) settings.toolsConfig = toolsConfig;
  }

  if (agent.guardrails?.length) {
    settings.guardrails = [...new Set(agent.guardrails)];
  }

  if (agent.nixPackages?.length) {
    settings.nixConfig = { packages: [...new Set(agent.nixPackages)] };
  }

  const providerKeys: { providerId: string; value: string }[] = [];
  for (const provider of agent.providers ?? []) {
    if (provider.key === undefined) continue;
    if (isSecretRef(provider.key)) {
      required.add(provider.key.$secret);
      const value = env[provider.key.$secret];
      if (value) providerKeys.push({ providerId: providerId(provider), value });
      continue;
    }
    const ref = envRefName(provider.key);
    if (ref) {
      required.add(ref);
      const value = env[ref];
      if (value) providerKeys.push({ providerId: providerId(provider), value });
      continue;
    }
    providerKeys.push({
      providerId: providerId(provider),
      value: provider.key,
    });
  }

  const metadata: DesiredAgentMetadata = {
    agentId: agent.id,
    name: agent.name ?? agent.id,
  };
  if (agent.description) metadata.description = agent.description;

  // Exhaustiveness guard (compile-time): construct a projection object that
  // includes EVERY stored key (mapped → the computed value, unsupported/post-
  // load → undefined) and assert it satisfies AgentSettingsProjection. If a
  // field is added to AgentSettingsStoredSchema without an entry here, tsc
  // fails with "Property X is missing". This makes "declarative layer forgot
  // to wire a field" a compile error — the whole point of the schema. The
  // projection object is discarded; the real `settings` (Partial, only the
  // non-undefined fields) is what flows to apply.
  const _exhaustive: AgentSettingsProjection = {
    models: settings.models,
    networkConfig: settings.networkConfig,
    nixConfig: settings.nixConfig,
    soulMd: settings.soulMd,
    userMd: settings.userMd,
    identityMd: settings.identityMd,
    skillsConfig: settings.skillsConfig,
    toolsConfig: settings.toolsConfig,
    guardrails: settings.guardrails,
    guardrailsInline: settings.guardrailsInline,
    sandboxId: settings.sandboxId,
    verboseLogging: settings.verboseLogging,
    showToolCalls: settings.showToolCalls,
    preApprovedTools: settings.preApprovedTools,
  };
  void _exhaustive;

  return { metadata, settings, providerKeys };
}

function mapEntityType(entity: EntityType): DesiredEntityType {
  // Fail loud in the CLI before any remote mutation: the server's
  // assertValidBacking would otherwise reject an empty backing mid-apply with a
  // confusing 4xx, possibly after other mutations have already landed.
  if (entity.backing && entity.backing.sql.trim() === "") {
    throw new ValidationError(
      `entity type "${entity.key}" has an empty backing.sql`
    );
  }
  // Declared metrics, included only when present so a non-metric type never
  // churns the diff (mirrors `backing`). The four fields round-trip verbatim.
  const metrics =
    entity.eventSets || entity.measures || entity.dimensions || entity.segments
      ? {
          ...(entity.eventSets ? { eventSets: entity.eventSets } : {}),
          ...(entity.measures ? { measures: entity.measures } : {}),
          ...(entity.dimensions ? { dimensions: entity.dimensions } : {}),
          ...(entity.segments ? { segments: entity.segments } : {}),
        }
      : undefined;
  // Fail loud in the CLI (before any remote mutation) on referential/shape
  // errors the types can't catch — a measure naming a missing eventSet/segment,
  // or a non-`count` measure without `expr`. The server re-validates.
  if (metrics) {
    const errors = validateEntityMetrics(metrics);
    if (errors.length > 0) {
      throw new ValidationError(
        `entity type "${entity.key}" has invalid metrics: ${errors.join("; ")}`
      );
    }
  }
  // Fail loud on malformed resolution rules: the server drops invalid rules,
  // which can silently disable the intended matching policy.
  if (entity.resolutionPolicy) {
    if (!Array.isArray(entity.resolutionPolicy.rules)) {
      throw new ValidationError(
        `entity type "${entity.key}" has invalid resolutionPolicy: expected rules to be an array`
      );
    }
    const ruleErrors = entity.resolutionPolicy.rules.flatMap((rule, index) => {
      const fields =
        Array.isArray(rule.fields) &&
        rule.fields.every((f) => typeof f === "string" && f.trim())
          ? rule.fields
          : null;
      const normalizerOk =
        rule.normalizer === "email" ||
        rule.normalizer === "phone" ||
        rule.normalizer === "exact";
      const onMatchOk =
        rule.onMatch === "auto_merge" || rule.onMatch === "review";
      if (fields && fields.length > 0 && normalizerOk && onMatchOk) return [];
      return [
        `rule ${index}: expected { fields: string[], normalizer: "email"|"phone"|"exact", onMatch: "auto_merge"|"review" }`,
      ];
    });
    if (ruleErrors.length > 0) {
      throw new ValidationError(
        `entity type "${entity.key}" has invalid resolutionPolicy: ${ruleErrors.join("; ")}`
      );
    }
  }
  return {
    slug: normalizeEntityTypeSlug(entity.key),
    ...(entity.name ? { name: entity.name } : {}),
    ...(entity.description ? { description: entity.description } : {}),
    ...(entity.required ? { required: entity.required } : {}),
    ...(entity.properties ? { properties: entity.properties } : {}),
    // Event kinds included only when declared so a type with none compares equal
    // on both sides and never churns the diff (mirrors `backing`/`metrics`).
    ...(entity.eventKinds && Object.keys(entity.eventKinds).length > 0
      ? { eventKinds: entity.eventKinds }
      : {}),
    // Resolution policy lowered to the raw metadata_schema key the server reads.
    // Declared only when present so a type without one never churns the diff.
    ...(entity.resolutionPolicy
      ? {
          resolutionPolicy: {
            "x-lobu-resolution": {
              rules: entity.resolutionPolicy.rules,
            },
          },
        }
      : {}),
    // View template included only when declared so absence never churns the diff
    // (a no-prune apply leaves any UI-authored template untouched).
    ...(entity.viewTemplate ? { viewTemplate: entity.viewTemplate } : {}),
    // metadata is carried for config-API compat (defineEntityType consumers may
    // attach it) but is neither diffed nor sent to the server.
    ...(entity.metadata ? { metadata: entity.metadata } : {}),
    // `backing` is present only for derived types; a stored entity (the default)
    // carries no backing so it never churns the diff. `connection` (a slug) is
    // included only when set, so an internal-backed view never churns either.
    ...(entity.backing
      ? {
          backing: {
            sql: entity.backing.sql,
            ...(entity.backing.connection
              ? { connection: entity.backing.connection }
              : {}),
          },
        }
      : {}),
    ...(metrics ? { metrics } : {}),
  };
}

function mapRelationshipType(rel: RelationshipType): DesiredRelationshipType {
  return {
    slug: rel.key,
    ...(rel.name ? { name: rel.name } : {}),
    ...(rel.description ? { description: rel.description } : {}),
    ...(rel.rules
      ? {
          rules: rel.rules.map((rule) => ({
            source: entitySlug(rule.source),
            target: entitySlug(rule.target),
          })),
        }
      : {}),
    // metadata is carried for config-API compat (defineRelationshipType
    // consumers may attach it) but is neither diffed nor sent to the server.
    ...(rel.metadata ? { metadata: rel.metadata } : {}),
  };
}

function mapAutomationOutputs(
  outputs: NonNullable<Automation["outputs"]>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(outputs).map(([name, output]) => [
      name,
      "entity" in output
        ? {
            entity: entitySlug(output.entity),
            key: output.key,
            ...(output.name ? { name: output.name } : {}),
          }
        : { event: output.event },
    ])
  );
}

/** Max skills an Automation may pin on one version (issue #2320 cap). */
const MAX_AUTOMATION_SKILLS = 5;

/**
 * Instruction-presence rule. An event trigger executing as "turn" carries its own
 * content (the incoming message/event), so it may run with zero instructions on
 * the built-in default. Everything else — schedule triggers, event triggers with
 * execution "window", and Automations with no triggers at all (manual runs) —
 * needs a prompt, at least one skill, a reaction script, or a script executor.
 *
 * This CLI preflight mirrors the server rule, catching the error against the
 * config file (naming the slug) rather than as a 422 mid-apply. When both
 * triggers and instructions change, apply sends them together through
 * create_version so the final pair is validated atomically.
 */
function assertAutomationSkills(
  automation: DesiredAutomation,
  instructionSourceDeclared: boolean
): void {
  const skills = automation.skills ?? [];
  const duplicates = skills.filter((name, i) => skills.indexOf(name) !== i);
  if (duplicates.length > 0) {
    throw new ValidationError(
      `Automation "${automation.slug}" lists duplicate skill(s): ${[...new Set(duplicates)].join(", ")} — each skill may appear once (the compile is ordered, not repeated)`
    );
  }
  if (skills.length > MAX_AUTOMATION_SKILLS) {
    throw new ValidationError(
      `Automation "${automation.slug}" references ${skills.length} skills — the maximum is ${MAX_AUTOMATION_SKILLS}`
    );
  }
  const triggers = automation.triggers ?? [];
  if (
    automation.outputs &&
    Object.keys(automation.outputs).length > 0 &&
    triggers.some(
      (trigger) =>
        trigger.kind === "event" && resolvedEventExecution(trigger) === "turn"
    )
  ) {
    throw new ValidationError(
      `Automation "${automation.slug}" declares outputs but has a turn trigger — outputs require execution "window". Change the trigger or split the turn into a separate Automation.`
    );
  }
  const requiresSkills =
    triggers.length === 0 ||
    triggers.some(
      (trigger) =>
        trigger.kind === "schedule" ||
        (trigger.kind === "event" &&
          resolvedEventExecution(trigger) === "window")
    );
  // Any instruction source satisfies the rule. An Automation
  // whose whole job is "run this skill" has no task statement to write, one
  // that spells its task out inline needs no skill, and one that runs entirely
  // as a reaction or executor script needs neither — demanding two would be
  // stricter than the server and would reject configs the API accepts. The
  // mapper runs BEFORE the loader reads either file, so this boolean is the
  // config marker; the loader validates the file and the server enforces the
  // final rule on its source.
  if (
    requiresSkills &&
    skills.length === 0 &&
    !automation.prompt.trim() &&
    !instructionSourceDeclared
  ) {
    throw new ValidationError(
      `Automation "${automation.slug}" needs instructions: schedule triggers, event triggers with execution "window", and Automations with no triggers run on stored instructions alone, so give it a "prompt", at least one skill, a reaction script, or a script executor. Only event triggers with execution "turn" may omit all instruction sources.`
    );
  }
}

function mapAutomation(automation: Automation): DesiredAutomation {
  const sources = automation.sources
    ? Object.entries(automation.sources).map(([name, value]) => {
        if (typeof value === "string") return { name, query: value };
        return {
          name,
          query: value.query,
          ...(value.context ? { context: true as const } : {}),
        };
      })
    : undefined;
  let hasSchedule = false;
  const triggers = automation.triggers?.map((trigger) => {
    if (trigger.kind === "schedule") {
      if (hasSchedule) {
        throw new ValidationError(
          `Automation "${automation.slug}" has more than one schedule trigger`
        );
      }
      const err = cronError(trigger.cron);
      if (err) {
        throw new ValidationError(
          `Automation "${automation.slug}" has an invalid schedule trigger "${trigger.cron}": ${err}`
        );
      }
      hasSchedule = true;
      return {
        kind: "schedule" as const,
        cron: trigger.cron.trim(),
        timezone: trigger.timezone ?? null,
        execution: "window" as const,
        active_run: "coalesce" as const,
        skip_if_unchanged: trigger.skip_if_unchanged ?? true,
      };
    }
    if (trigger.kind === "event" && trigger.source === "workspace") {
      const normalizedTrigger = normalizeWorkspaceEventTrigger(trigger);
      return normalizedTrigger.entity_type
        ? {
            ...normalizedTrigger,
            entity_type: normalizeEntityTypeSlug(normalizedTrigger.entity_type),
          }
        : normalizedTrigger;
    }
    const { connection, ...eventTrigger } = trigger;
    const normalizedEventTrigger = {
      ...eventTrigger,
      source: "connector" as const,
      event_types: Array.from(new Set(eventTrigger.event_types)),
      match:
        eventTrigger.match && Object.keys(eventTrigger.match).length > 0
          ? eventTrigger.match
          : undefined,
      execution: resolvedEventExecution(eventTrigger),
      active_run: eventTrigger.active_run ?? "queue",
      output: eventTrigger.output ?? "silent",
      skip_if_unchanged: eventTrigger.skip_if_unchanged ?? true,
    } as const;
    if (connection !== undefined && trigger.connection_id !== undefined) {
      throw new ValidationError(
        `Automation "${automation.slug}" trigger must use either connection or connection_id, not both`
      );
    }
    if (connection === undefined) return normalizedEventTrigger;
    if (
      typeof connection !== "string" &&
      connectorKey(connection.connector) !== trigger.connector_key
    ) {
      throw new ValidationError(
        `Automation "${automation.slug}" trigger is ${trigger.connector_key}, but connection "${connection.slug}" uses ${connectorKey(connection.connector)}`
      );
    }
    const connectionSlug =
      typeof connection === "string" ? connection : connection.slug;
    return { ...normalizedEventTrigger, connectionSlug };
  });
  return {
    slug: automation.slug,
    agent: agentId(automation.agent),
    ...(automation.executor === "agent" ? { executor: null } : {}),
    // The author's task statement, carried straight through. Skill BODIES are
    // no longer folded in here — the loader resolves them into `skillSnapshots`
    // (see `resolveAutomationSkills` in desired-state.ts), because the mapper is
    // pure and cannot read skill files. "" is legitimate for an Automation whose
    // whole job is its skills, and for event-turn Automations with neither.
    prompt: automation.prompt ?? "",
    ...(automation.skills?.length ? { skills: automation.skills } : {}),
    ...(automation.outputs !== undefined
      ? {
          outputs:
            automation.outputs === null
              ? null
              : mapAutomationOutputs(automation.outputs),
        }
      : {}),
    ...(automation.name ? { name: automation.name } : {}),
    ...(automation.description ? { description: automation.description } : {}),
    triggers: triggers ?? [],
    ...(sources ? { sources } : {}),
    ...(automation.minCooldownSeconds !== undefined
      ? { minCooldownSeconds: automation.minCooldownSeconds }
      : {}),
    ...(automation.tags ? { tags: automation.tags } : {}),
    ...(automation.reactionsGuidance
      ? { reactionsGuidance: automation.reactionsGuidance }
      : {}),
    ...(automation.agentKind ? { agentKind: automation.agentKind } : {}),
    ...(automation.deviceWorkerId !== undefined
      ? { deviceWorkerId: automation.deviceWorkerId }
      : {}),
    ...(automation.model !== undefined ? { model: automation.model } : {}),
  };
}

function mapAuthProfile(
  profile: AuthProfile,
  required: Set<string>,
  env: NodeJS.ProcessEnv
): DesiredAuthProfile {
  if (!AUTH_PROFILE_SLUG_PATTERN.test(profile.slug)) {
    throw new ValidationError(
      `auth profile slug "${profile.slug}" must match /^[a-z0-9][a-z0-9-]{0,79}$/ (lowercase letters/digits/hyphens, no leading hyphen, ≤80 chars)`
    );
  }
  const interactive =
    profile.authKind === "oauth_account" ||
    profile.authKind === "browser_session";
  if (
    interactive &&
    profile.credentials &&
    Object.keys(profile.credentials).length > 0
  ) {
    throw new ValidationError(
      `auth profile "${profile.slug}" has kind "${profile.authKind}" — credentials must not be set; lobu apply never writes interactive-auth tokens (complete auth via the connect URL)`
    );
  }
  const credentials =
    profile.credentials && !interactive
      ? Object.fromEntries(
          Object.entries(profile.credentials).map(([key, value]) => [
            key,
            resolveCredentialValue(value, required, env),
          ])
        )
      : undefined;
  return {
    slug: profile.slug,
    connector: connectorKey(profile.connector),
    kind: profile.authKind,
    sourceFile: CONFIG_SOURCE,
    ...(profile.name ? { name: profile.name } : {}),
    ...(credentials ? { credentials } : {}),
  };
}

function unsupportedChatConnectionFields(connection: Connection): string[] {
  return [
    connection.authProfile !== undefined ? "authProfile" : null,
    connection.appAuthProfile !== undefined ? "appAuthProfile" : null,
    connection.deviceWorkerId !== undefined ? "deviceWorkerId" : null,
    connection.feeds?.length ? "feeds" : null,
  ].filter((field): field is string => field !== null);
}

function mapConnection(
  connection: Connection,
  required: Set<string>,
  env: NodeJS.ProcessEnv
): DesiredConnection {
  if (!CONNECTION_SLUG_PATTERN.test(connection.slug)) {
    throw new ValidationError(
      `connection slug "${connection.slug}" must match /^[a-z0-9][a-z0-9-]{0,62}$/ (lowercase letters/digits/hyphens, no leading hyphen, ≤63 chars)`
    );
  }
  if (connection.credentialMode === "byo") {
    const unsupported = unsupportedChatConnectionFields(connection);
    if (unsupported.length > 0) {
      throw new ValidationError(
        `BYO chat connection "${connection.slug}" cannot declare ${unsupported.join(", ")} — chat credentials come from config and the chat upsert does not apply auth profiles, device pinning, or declarative feeds`
      );
    }
  }
  const seenFeeds = new Set<string>();
  const feeds: DesiredFeed[] = (connection.feeds ?? []).map((feed) => {
    if (seenFeeds.has(feed.feed)) {
      throw new ValidationError(
        `connection "${connection.slug}" declares feed "${feed.feed}" more than once`
      );
    }
    seenFeeds.add(feed.feed);
    if (feed.schedule) {
      const err = cronError(feed.schedule);
      if (err) {
        throw new ValidationError(
          `connection "${connection.slug}" feed "${feed.feed}" has an invalid schedule "${feed.schedule}": ${err}`
        );
      }
    }
    return {
      feedKey: feed.feed,
      ...(feed.name ? { name: feed.name } : {}),
      // Undeclared — omitted, or `undefined` from something like
      // `schedule: process.env.FEED_CRON` — carries through unset, exactly like
      // `name` and `config`, and apply then leaves the remote cadence alone.
      // Only an explicit `null` is a deliberate clear. Still never invents a
      // default cron: an undeclared schedule on a NEW feed creates it
      // manual-only.
      ...(feed.schedule !== undefined ? { schedule: feed.schedule } : {}),
      ...(feed.config ? { config: feed.config } : {}),
    };
  });
  const authSlug = authProfileSlug(connection.authProfile);
  const appAuthSlug = authProfileSlug(connection.appAuthProfile);
  if (connection.credentialMode === "managed" && !connection.managedBy) {
    throw new ValidationError(
      `connection "${connection.slug}" uses credentialMode "managed" but does not declare managedBy`
    );
  }
  if (connection.credentialMode === "byo" && connection.managedBy) {
    throw new ValidationError(
      `connection "${connection.slug}" cannot combine credentialMode "byo" with managedBy`
    );
  }
  // A BYO connection (chat or adapterless, with its credential supplied in
  // `config`; hosted chat is filtered out before this) applies
  // through the secret-aware `apply_chat_connection` path. Resolve `secret()` /
  // `$VAR` refs in its config to the REAL value: the chat-write path stores the
  // incoming plaintext as the secret (server-side `normalizeConfigForStorage`
  // swaps it for a `secret://` ref + encrypts it), so sending the `$VAR`
  // placeholder would persist a broken token. Mirrors provider keys +
  // auth-profile credentials; the config row never holds cleartext at rest, and
  // the secret name is collected so the apply secrets gate fails loud if unset.
  // `credentialMode` is explicit so connector definitions remain the only
  // registry of connection capability (`x-lobu-chat-platform` or
  // `x-lobu-adapterless-platform`). Validation against that marker happens
  // after connector definitions are installed/refetched.
  const isByoConnection = connection.credentialMode === "byo";
  const resolvedConfig = isByoConnection
    ? Object.fromEntries(
        Object.entries(connection.config ?? {}).map(([k, v]) => [
          k,
          resolveConnectionConfigValue(v, required, env),
        ])
      )
    : connection.config;
  // A managed connection's grant lives in a cloud (public) org. Fold the
  // `managedBy` descriptor into the persisted connection `config` so the server
  // resolver (execution-context.ts) can detect it and fetch the user's token
  // from the cloud at runtime — no new column or CRUD field needed. It lives in
  // the trusted connection `config` (never in `auth_data`).
  const config = connection.managedBy
    ? { ...(resolvedConfig ?? {}), managedBy: { ...connection.managedBy } }
    : resolvedConfig;
  return {
    slug: connection.slug,
    connector: connectorKey(connection.connector),
    feeds,
    sourceFile: CONFIG_SOURCE,
    ...(connection.name ? { name: connection.name } : {}),
    ...(authSlug ? { authProfileSlug: authSlug } : {}),
    ...(appAuthSlug ? { appAuthProfileSlug: appAuthSlug } : {}),
    ...(config ? { config } : {}),
    // Mark BYO chat/adapterless connections so apply routes them through the
    // secret-aware connection path. Feed/data connectors leave it undefined.
    ...(isByoConnection ? { credentialMode: "byo" as const } : {}),
    ...(connection.deviceWorkerId
      ? { deviceWorkerId: connection.deviceWorkerId }
      : {}),
  };
}

/**
 * A hosted chat connection (`credentialMode: "hosted"`) is reached via the
 * hosted Lobu bot + a `/lobu link` claim, NOT a persisted connection row. It
 * must never become a credential-less connection: `lobu run` reads it straight
 * from the authored config to mint the link code. So it is filtered out of the
 * applied connection set (mirrors the old hosted-platform carve-out).
 */
function isHostedConnection(connection: Connection): boolean {
  if (connection.credentialMode !== "hosted") return false;
  const connector = connectorKey(connection.connector);
  if (!isHostedChatPlatform(connector)) {
    throw new ValidationError(
      `connection "${connection.slug}" uses credentialMode "hosted", but connector "${connector}" does not support the hosted Lobu bot (expected slack or telegram)`
    );
  }
  if (connection.config && Object.keys(connection.config).length > 0) {
    throw new ValidationError(
      `connection "${connection.slug}" uses credentialMode "hosted" and must not declare config credentials`
    );
  }
  if (connection.managedBy) {
    throw new ValidationError(
      `connection "${connection.slug}" cannot combine credentialMode "hosted" with managedBy`
    );
  }
  const unsupported = unsupportedChatConnectionFields(connection);
  if (unsupported.length > 0) {
    throw new ValidationError(
      `hosted chat connection "${connection.slug}" cannot declare ${unsupported.join(", ")} — hosted connections are link-code declarations, not persisted connection rows`
    );
  }
  return true;
}

/**
 * Translate an authoring project into the apply `DesiredState`. When `only` is
 * set, connector definitions/connections/auth-profiles are skipped (and their
 * secrets not collected), matching the TOML loader's `--only` automation so
 * `lobu apply --only agents` doesn't demand connector secrets.
 */
export function mapProjectToDesiredState(
  project: Project,
  env: NodeJS.ProcessEnv = process.env,
  only?: "agents" | "memory"
): DesiredState {
  const required = new Set<string>();

  const agents = project.agents.map((agent) => mapAgent(agent, env, required));
  const entityTypes = (project.entities ?? []).map(mapEntityType);
  const relationshipTypes = (project.relationships ?? []).map(
    mapRelationshipType
  );
  const automations =
    only === "agents" ? [] : (project.automations ?? []).map(mapAutomation);
  const authProfiles = only
    ? []
    : (project.authProfiles ?? []).map((profile) =>
        mapAuthProfile(profile, required, env)
      );
  const connections = only
    ? []
    : (project.connections ?? [])
        .filter((c) => !isHostedConnection(c))
        .map((c) => mapConnection(c, required, env));
  // Org providers are skipped under `--only` (they're neither agents nor
  // memory), matching the connector-skip posture — so their secrets aren't
  // demanded on a targeted apply.
  const providers = only
    ? []
    : (project.providers ?? []).map((provider) =>
        mapOrgProvider(provider, required, env)
      );

  // Reject duplicate identifiers per collection (the TOML/YAML loader did this;
  // the TS path must keep parity). Duplicates otherwise generate duplicate plan
  // rows that fail mid-apply or make the desired state ambiguous.
  assertUniqueBy(agents, (a) => a.metadata.agentId, "agent id");
  assertUniqueBy(entityTypes, (e) => e.slug, "entity type key");
  assertUniqueBy(relationshipTypes, (r) => r.slug, "relationship type key");
  assertUniqueBy(automations, (w) => w.slug, "Automation slug");
  assertUniqueBy(authProfiles, (p) => p.slug, "auth profile slug");
  assertUniqueBy(connections, (c) => c.slug, "connection slug");
  assertUniqueBy(providers, (p) => p.slug, "provider slug");

  const agentIds = new Set(project.agents.map((agent) => agent.id));
  for (let i = 0; i < automations.length; i++) {
    const automation = automations[i];
    if (!automation) continue;
    if (!agentIds.has(automation.agent)) {
      throw new ValidationError(
        `Automation "${automation.slug}" names agent "${automation.agent}", but no agent with that id is declared in lobu.config.ts`
      );
    }
    // The config's `reaction` marker (from `reactionFromFile(path)`) drives the
    // instruction-presence preflight — the reaction SOURCE is only resolved
    // later by the loader. `automations` is index-aligned with
    // `project.automations` (the mapper maps in order).
    assertAutomationSkills(
      automation,
      project.automations?.[i]?.reaction !== undefined ||
        (project.automations?.[i]?.executor !== undefined &&
          project.automations?.[i]?.executor !== "agent")
    );
    for (const trigger of automation.triggers ?? []) {
      if (
        trigger.kind !== "event" ||
        trigger.source === "workspace" ||
        !trigger.connectionSlug
      ) {
        continue;
      }
      const connection = (project.connections ?? []).find(
        (candidate) => candidate.slug === trigger.connectionSlug
      );
      if (!connection) {
        throw new ValidationError(
          `Automation "${automation.slug}" references connection "${trigger.connectionSlug}", but it is not declared in lobu.config.ts`
        );
      }
      const declaredConnector = connectorKey(connection.connector);
      if (declaredConnector !== trigger.connector_key) {
        throw new ValidationError(
          `Automation "${automation.slug}" trigger is ${trigger.connector_key}, but connection "${trigger.connectionSlug}" uses ${declaredConnector}`
        );
      }
    }
  }

  const memory: NonNullable<DesiredState["memory"]> = {};
  if (project.org) memory.org = project.org;
  if (project.orgName) memory.name = project.orgName;
  if (project.orgDescription) memory.description = project.orgDescription;
  if (project.organizationId) memory.organizationId = project.organizationId;

  return {
    agents,
    prune: project.prune ?? false,
    ...(Object.keys(memory).length > 0 ? { memory } : {}),
    memorySchema: { entityTypes, relationshipTypes },
    automations,
    connectors: { definitions: [], authProfiles, connections },
    providers,
    requiredSecrets: [...required].sort(),
  };
}
