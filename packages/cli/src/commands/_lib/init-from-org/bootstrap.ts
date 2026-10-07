/**
 * `lobu init --from-org <slug>` — bootstrap a complete, re-appliable project
 * from an existing Lobu Cloud org. The inverse of `lobu apply`: it reads the
 * org's full declared state through the apply client and writes a runnable
 * `lobu.config.ts` (plus the file-convention artifacts it references) that
 * round-trips back through `loadDesiredStateFromConfig`.
 *
 * Contract: `load(initFromOrg(org)) ≈ org`, modulo write-only secrets — provider
 * keys, auth-profile credentials, and MCP client secrets become `secret("ENV")`
 * placeholders (listed in `.env.example`), never real values.
 *
 * This is the inverse of `map-config.ts`'s `mapAgent` / `mapEntityType` / etc:
 * server → SDK authoring objects → emitted TypeScript source.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { AgentSettings } from "@lobu/core";
import { resolvedEventExecution } from "@lobu/core/contracts/tools/manage-automations";
import chalk from "chalk";
import { UNRESOLVED_MODEL_SUFFIX } from "../../../config/index.js";
import { printText } from "../../../internal/output.js";
import { renderTemplate } from "../../../utils/template.js";
import type {
  ApplyClient,
  RemoteAgent,
  RemoteAuthProfile,
  RemoteAutomation,
  RemoteConnection,
  RemoteConnectorDefinition,
  RemoteEntityType,
  RemoteFeed,
  RemoteRelationshipType,
} from "../apply/client.js";
import { resolveApplyClient } from "../apply/client.js";

interface InitFromOrgOptions {
  /** Target directory to scaffold into (must be empty / not a Lobu project). */
  targetDir: string;
  /** Validated project slug used in generated guidance. */
  projectName?: string;
  /** Validated local gateway port. */
  gatewayPort?: string;
  /** Non-conflicting local worker proxy port. */
  workerProxyPort?: string;
  /** Org slug to bootstrap from (defaults to active session). */
  org?: string;
  /** Server URL override. */
  url?: string;
  /** Test seam — inject fetch. */
  fetchImpl?: typeof fetch;
}

// ── TS literal emission ──────────────────────────────────────────────────────

/** A `const <name> = <expr>;` handle plus the identifier to reference it by. */
interface Handle {
  name: string;
  decl: string;
}

interface TsExpression {
  readonly __tsExpression: string;
}

function tsExpression(source: string): TsExpression {
  return { __tsExpression: source };
}

/** Quote a string as a TS string literal (double quotes, JSON-escaped). */
function str(value: string): string {
  return JSON.stringify(value);
}

/**
 * Emit a JS value as pretty TS source. Handles JSON-Schema objects in entity
 * `properties` and arbitrary connection `config` blobs as real object/array
 * literals (not `JSON.stringify` blobs), with object keys unquoted where they're
 * valid identifiers.
 */
function emitValue(value: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  const padInner = "  ".repeat(indent + 1);
  if (value === null) return "null";
  if (typeof value === "string") return str(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    // Inline short arrays of primitives (mirrors Prettier output) so e.g.
    // `required: ["stage"]` and `tags: ["a", "b"]` don't sprawl over many lines.
    const allPrimitive = value.every(
      (v) =>
        v === null ||
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
    );
    if (allPrimitive) {
      const inline = `[${value.map((v) => emitValue(v, 0)).join(", ")}]`;
      if (inline.length <= 72) return inline;
    }
    const items = value.map((v) => `${padInner}${emitValue(v, indent + 1)}`);
    return `[\n${items.join(",\n")},\n${pad}]`;
  }
  if (typeof value === "object") {
    if (
      "__tsExpression" in value &&
      typeof (value as TsExpression).__tsExpression === "string"
    ) {
      return (value as TsExpression).__tsExpression;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const lines = entries.map(
      ([k, v]) => `${padInner}${emitKey(k)}: ${emitValue(v, indent + 1)}`
    );
    return `{\n${lines.join(",\n")},\n${pad}}`;
  }
  // undefined / function — should never reach here for declared state.
  return "undefined";
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function emitKey(key: string): string {
  return IDENT.test(key) ? key : str(key);
}

/**
 * Render an object's fields as the body of an object literal (one field per
 * line at `indent`+1). `fields` are pre-rendered `key: value` strings; empty
 * entries are dropped so omitted/default fields never appear.
 */
function objectLiteral(fields: string[], indent = 0): string {
  const pad = "  ".repeat(indent);
  const padInner = "  ".repeat(indent + 1);
  const present = fields.filter((f) => f.length > 0);
  if (present.length === 0) return "{}";
  return `{\n${present.map((f) => `${padInner}${f}`).join(",\n")},\n${pad}}`;
}

// ── Identifier minting ───────────────────────────────────────────────────────

/** Turn a slug/id into a safe, unique camelCase const identifier. */
class IdentMinter {
  private readonly used = new Set<string>();

  mint(base: string, suffix = ""): string {
    let camel = base
      .replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) =>
        c ? c.toUpperCase() : ""
      )
      .replace(/^[0-9]+/, "");
    if (!camel) camel = "item";
    if (!/^[A-Za-z_$]/.test(camel)) camel = `_${camel}`;
    let candidate = `${camel}${suffix}`;
    let n = 2;
    while (this.used.has(candidate)) {
      candidate = `${camel}${suffix}${n++}`;
    }
    this.used.add(candidate);
    return candidate;
  }
}

// ── Secret placeholders ──────────────────────────────────────────────────────

/**
 * Collects env-var names emitted as `secret("NAME")` placeholders so we can
 * write a `.env.example`. Credentials are write-only on the server; we never
 * read or emit real values.
 */
class SecretCollector {
  readonly names = new Set<string>();

  // Coupled to the ImportTracker so every `secret("…")` we emit also registers
  // the `secret` import. Decoupling them (caller calls `imports.use("secret")`
  // separately) silently dropped the import on the MCP-oauth `clientSecret`
  // path, producing a config that referenced `secret` without importing it.
  constructor(private readonly imports: ImportTracker) {}

  /** Register a var name and return the `secret("NAME")` TS expression. */
  ref(name: string): string {
    this.names.add(name);
    this.imports.use("secret");
    return `secret(${str(name)})`;
  }
}

/** Uppercase env-var name from a slug/key (e.g. `gh-token` → `GH_TOKEN_API_KEY`). */
function envVarFor(slug: string, suffix: string): string {
  // Normalize BOTH parts to a valid POSIX env-var name. The suffix can carry a
  // non-identifier platform config key (e.g. `bot-token` → `..._BOT_TOKEN`); an
  // un-normalized hyphen would make the `.env` key invalid and fail apply's
  // required-secret check.
  const norm = (s: string) =>
    s
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .toUpperCase();
  return `${norm(slug)}_${norm(suffix)}`;
}

/**
 * The credential field names a connector's auth schema expects. `lobu apply`
 * sends `credentials: { <field>: <value> }` and the server validates `<field>`
 * against the connector's `auth_schema.methods` (see the server's
 * connection-helpers `getOAuthCredentialKeys` / env-key extraction), so the
 * emitted credential KEY must be a real auth-schema field — not an
 * env-var-derived name.
 *
 * `auth_schema` is the connector's `ConnectorAuthSchema` (`{ methods: [...] }`),
 * NOT a JSON Schema. We pick the keys for the profile kind being emitted:
 *   - `env`       → the `env_keys` method's `fields[].key`
 *   - `oauth_app` → the `oauth` method's `clientIdKey`/`clientSecretKey`
 *     (defaulting to `${PROVIDER}_CLIENT_ID` / `_CLIENT_SECRET`, mirroring the
 *     server default)
 * Returns `null` when the schema has no matching method (caller falls back to a
 * TODO placeholder).
 */
function authSchemaFields(
  schema: Record<string, unknown> | null | undefined,
  profileKind: "env" | "oauth_app"
): string[] | null {
  if (!schema || typeof schema !== "object") return null;
  const methods = Array.isArray(schema.methods)
    ? (schema.methods as Array<Record<string, unknown>>)
    : [];

  if (profileKind === "oauth_app") {
    const oauth = methods.find((m) => m.type === "oauth");
    if (!oauth || typeof oauth.provider !== "string") return null;
    const providerUpper = oauth.provider.toUpperCase();
    const clientIdKey =
      typeof oauth.clientIdKey === "string" && oauth.clientIdKey.trim()
        ? oauth.clientIdKey
        : `${providerUpper}_CLIENT_ID`;
    const clientSecretKey =
      typeof oauth.clientSecretKey === "string" && oauth.clientSecretKey.trim()
        ? oauth.clientSecretKey
        : `${providerUpper}_CLIENT_SECRET`;
    return [clientIdKey, clientSecretKey];
  }

  const envMethod = methods.find((m) => m.type === "env_keys");
  const fields = Array.isArray(envMethod?.fields) ? envMethod.fields : [];
  const keys = (fields as Array<Record<string, unknown>>)
    .map((f) => f.key)
    .filter((k): k is string => typeof k === "string" && k.length > 0);
  return keys.length > 0 ? keys : null;
}

// ── Imports tracking ─────────────────────────────────────────────────────────

const IMPORTABLE = [
  "defineAgent",
  "defineConfig",
  "defineEntityType",
  "defineRelationshipType",
  "defineAutomation",
  "defineConnection",
  "defineAuthProfile",
  "reactionFromFile",
  "secret",
  "skillFromFile",
] as const;
type Importable = (typeof IMPORTABLE)[number];

class ImportTracker {
  private readonly used = new Set<Importable>();
  use(name: Importable): void {
    this.used.add(name);
  }
  render(): string {
    const names = IMPORTABLE.filter((n) => this.used.has(n)).sort();
    return `import {\n${names.map((n) => `  ${n}`).join(",\n")},\n} from "@lobu/cli/config";`;
  }
}

// ── Agent settings → SDK agent (inverse of mapAgent) ────────────────────────

interface EmittedAgent {
  handle: Handle;
  /** Markdown + skill files to write under the agent dir. */
  files: Array<{ relPath: string; body: string }>;
}

function emitAgent(
  agent: RemoteAgent,
  settings: AgentSettings | null,
  imports: ImportTracker,
  secrets: SecretCollector,
  minter: IdentMinter
): EmittedAgent {
  imports.use("defineAgent");
  const fields: string[] = [`id: ${str(agent.agentId)}`];
  fields.push(`name: ${str(agent.name || agent.agentId)}`);
  if (agent.description) fields.push(`description: ${str(agent.description)}`);
  fields.push(`dir: ${str(`./agents/${agent.agentId}`)}`);

  const files: Array<{ relPath: string; body: string }> = [];
  const dir = `agents/${agent.agentId}`;

  // providers ← models[] (+ secret key). Each `<slug>/<model>` ref becomes one
  // provider `{ id, model }`, in list order (index 0 = the primary/default).
  // An `<slug>/__unresolved__` restriction sentinel carries no real model, so
  // it re-emits as a provider with no `model` (the operator picks one). The
  // ref's model may itself contain slashes (provider-native ids), so only the
  // FIRST segment is the slug; the remainder is the model.
  const models = settings?.models ?? [];
  if (models.length > 0) {
    const items = models
      .map((ref) => {
        const slash = ref.indexOf("/");
        if (slash <= 0) return null;
        const id = ref.slice(0, slash);
        const model = ref.slice(slash + 1);
        const isSentinel = model === UNRESOLVED_MODEL_SUFFIX;
        const envVar = envVarFor(id, "API_KEY");
        const provFields = [
          `id: ${str(id)}`,
          ...(isSentinel ? [] : [`model: ${str(model)}`]),
          `key: ${secrets.ref(envVar)}`,
        ];
        return objectLiteral(provFields, 2);
      })
      .filter((item): item is string => item !== null);
    if (items.length > 0) {
      fields.push(`providers: [\n    ${items.join(",\n    ")},\n  ]`);
    }
  }

  // network ← networkConfig (allowed/denied).
  const net = settings?.networkConfig;
  if (net) {
    const netFields: string[] = [];
    if (net.allowedDomains?.length) {
      netFields.push(`allowed: ${emitValue(net.allowedDomains, 2)}`);
    }
    if (net.deniedDomains?.length) {
      netFields.push(`denied: ${emitValue(net.deniedDomains, 2)}`);
    }
    if (netFields.length > 0) {
      fields.push(`network: ${objectLiteral(netFields, 1)}`);
    }
  }

  // guardrails ← guardrails[].
  if (settings?.guardrails?.length) {
    fields.push(`guardrails: ${emitValue(settings.guardrails, 1)}`);
  }

  // nixPackages ← nixConfig.packages.
  if (settings?.nixConfig?.packages?.length) {
    fields.push(`nixPackages: ${emitValue(settings.nixConfig.packages, 1)}`);
  }

  // Agent-dir markdown.
  if (settings?.soulMd) {
    files.push({
      relPath: `${dir}/SOUL.md`,
      body: ensureTrailingNewline(settings.soulMd),
    });
  }
  if (settings?.identityMd) {
    files.push({
      relPath: `${dir}/IDENTITY.md`,
      body: ensureTrailingNewline(settings.identityMd),
    });
  }
  if (settings?.userMd) {
    files.push({
      relPath: `${dir}/USER.md`,
      body: ensureTrailingNewline(settings.userMd),
    });
  }

  // Local skills → skills/<name>/SKILL.md (frontmatter is name/description
  // only — skills are instruction text), referenced explicitly via
  // `skillFromFile` so the apply loader picks them up (there is no directory
  // auto-discovery). System/runtime skills are skipped.
  const skillRefs: string[] = [];
  for (const skill of settings?.skillsConfig?.skills ?? []) {
    if (skill.system) continue;
    files.push({
      relPath: `${dir}/skills/${skill.name}/SKILL.md`,
      body: emitSkillFile(skill),
    });
    skillRefs.push(`skillFromFile(${str(`./${dir}/skills/${skill.name}`)})`);
  }
  if (skillRefs.length > 0) {
    imports.use("skillFromFile");
    fields.push(`skills: [\n    ${skillRefs.join(",\n    ")},\n  ]`);
  }

  const handleName = minter.mint(agent.agentId, "Agent");
  const decl = `const ${handleName} = defineAgent(${objectLiteral(fields, 0)});`;
  return { handle: { name: handleName, decl }, files };
}

function emitSkillFile(
  skill: NonNullable<AgentSettings["skillsConfig"]>["skills"][number]
): string {
  const fm: string[] = [`name: ${skill.name}`];
  if (skill.description) fm.push(`description: ${skill.description}`);
  const body = skill.content ?? "";
  return `---\n${fm.join("\n")}\n---\n${body}\n`;
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

// ── Entity / relationship / automation / connection / auth (inverse maps) ──────

function emitEntityType(
  e: RemoteEntityType,
  imports: ImportTracker,
  minter: IdentMinter
): Handle {
  imports.use("defineEntityType");
  const fields: string[] = [`key: ${str(e.slug)}`];
  if (e.name) fields.push(`name: ${str(e.name)}`);
  if (e.description) fields.push(`description: ${str(e.description)}`);
  if (e.required?.length) fields.push(`required: ${emitValue(e.required, 1)}`);
  if (e.properties && Object.keys(e.properties).length > 0) {
    fields.push(`properties: ${emitValue(e.properties, 1)}`);
  }
  // Declared metrics round-trip as the four top-level fields on defineEntityType
  // (not nested under `metrics`). Without this, `init --from-org` → `apply` would
  // diff metrics as a change and wipe them. (NOTE: `backing` has the same
  // pre-existing round-trip gap — tracked separately, not fixed here.)
  if (e.metrics?.eventSets) {
    fields.push(`eventSets: ${emitValue(e.metrics.eventSets, 1)}`);
  }
  if (e.metrics?.measures) {
    fields.push(`measures: ${emitValue(e.metrics.measures, 1)}`);
  }
  if (e.metrics?.dimensions) {
    fields.push(`dimensions: ${emitValue(e.metrics.dimensions, 1)}`);
  }
  if (e.metrics?.segments) {
    fields.push(`segments: ${emitValue(e.metrics.segments, 1)}`);
  }
  const name = minter.mint(e.slug, "Entity");
  return {
    name,
    decl: `const ${name} = defineEntityType(${objectLiteral(fields, 0)});`,
  };
}

function emitRelationshipType(
  r: RemoteRelationshipType,
  entityHandles: Map<string, string>,
  imports: ImportTracker,
  minter: IdentMinter
): Handle {
  imports.use("defineRelationshipType");
  const fields: string[] = [`key: ${str(r.slug)}`];
  if (r.purpose === "identity") fields.push(`purpose: "identity"`);
  if (r.name) fields.push(`name: ${str(r.name)}`);
  if (r.description) fields.push(`description: ${str(r.description)}`);
  if (r.rules?.length) {
    const rules = r.rules.map((rule) => {
      const source = entityHandles.get(rule.source) ?? str(rule.source);
      const target = entityHandles.get(rule.target) ?? str(rule.target);
      return `{ source: ${source}, target: ${target} }`;
    });
    fields.push(`rules: [\n    ${rules.join(",\n    ")},\n  ]`);
  }
  const name = minter.mint(r.slug, "Rel");
  return {
    name,
    decl: `const ${name} = defineRelationshipType(${objectLiteral(fields, 0)});`,
  };
}

/**
 * Instruction-presence rule, mirrored from `lobu apply` validation: only an
 * event-turn-only Automation may omit all instruction sources (the built-in
 * default applies). Schedule/window/manual shapes need a prompt, a skill, or a
 * reaction script.
 */
function automationRequiresInstructions(
  triggers: RemoteAutomation["triggers"]
): boolean {
  const list = triggers ?? [];
  if (list.length === 0) return true;
  return list.some(
    (trigger) =>
      trigger.kind === "schedule" ||
      (trigger.kind === "event" && resolvedEventExecution(trigger) === "window")
  );
}

function emitAutomation(
  w: RemoteAutomation,
  reactionScript: string | null,
  agentHandles: Map<string, string>,
  connectionHandlesById: ReadonlyMap<number, string>,
  imports: ImportTracker,
  minter: IdentMinter
): { handle: Handle; reactionFile?: { relPath: string; body: string } } {
  imports.use("defineAutomation");
  const agentRef = w.managed_agent_id
    ? agentHandles.get(w.managed_agent_id)
    : undefined;
  const fields: string[] = [
    `agent: ${agentRef ?? str(w.managed_agent_id ?? "")}`,
    `slug: ${str(w.slug)}`,
  ];
  if (w.name) fields.push(`name: ${str(w.name)}`);
  if (w.description) fields.push(`description: ${str(w.description)}`);
  if (w.triggers?.length) {
    const triggers = w.triggers.map((trigger) => {
      if (
        trigger.kind !== "event" ||
        trigger.source === "workspace" ||
        trigger.connection_id == null
      ) {
        return trigger;
      }
      const connectionHandle = connectionHandlesById.get(trigger.connection_id);
      if (!connectionHandle) return trigger;
      const rest = { ...trigger };
      delete rest.connection_id;
      return { ...rest, connection: tsExpression(connectionHandle) };
    });
    fields.push(`triggers: ${emitValue(triggers, 1)}`);
  }
  // Emit the author-facing prompt verbatim and preserve the pinned skill names.
  // The generated agent library carries its CURRENT bodies; generateProject
  // warns when those differ from this version's snapshots because the next
  // apply will then publish an explicit skill upgrade.
  if (w.prompt?.trim()) fields.push(`prompt: ${str(w.prompt)}`);
  if (w.skills?.length) {
    fields.push(`skills: [${w.skills.map((s) => str(s.name)).join(", ")}]`);
  }
  if (w.outputs) {
    fields.push(`outputs: ${emitValue(w.outputs, 1)}`);
  }
  if (w.sources?.length) {
    const sourceObj = Object.fromEntries(
      w.sources.map((s) => [s.name, s.query])
    );
    fields.push(`sources: ${emitValue(sourceObj, 1)}`);
  }
  if (
    w.min_cooldown_seconds !== undefined &&
    w.min_cooldown_seconds !== null &&
    w.min_cooldown_seconds !== 0
  ) {
    fields.push(`minCooldownSeconds: ${w.min_cooldown_seconds}`);
  }
  if (w.tags?.length) fields.push(`tags: ${emitValue(w.tags, 1)}`);
  if (w.reactions_guidance) {
    fields.push(`reactionsGuidance: ${str(w.reactions_guidance)}`);
  }
  if (w.agent_kind) fields.push(`agentKind: ${str(w.agent_kind)}`);

  let reactionFile: { relPath: string; body: string } | undefined;
  if (reactionScript) {
    const rel = `reactions/${w.slug}.reaction.ts`;
    imports.use("reactionFromFile");
    fields.push(`reaction: reactionFromFile(${str(`./${rel}`)})`);
    reactionFile = {
      relPath: rel,
      body: ensureTrailingNewline(reactionScript),
    };
  }

  const name = minter.mint(w.slug, "Automation");
  const handle: Handle = {
    name,
    decl: `const ${name} = defineAutomation(${objectLiteral(fields, 0)});`,
  };
  return reactionFile ? { handle, reactionFile } : { handle };
}

function emitAuthProfile(
  p: RemoteAuthProfile,
  secrets: SecretCollector,
  connectorHandles: Map<string, string>,
  authSchemas: Map<string, Record<string, unknown> | null | undefined>,
  imports: ImportTracker,
  minter: IdentMinter,
  warnings: string[]
): Handle | null {
  // An auth profile with no connector can't be expressed as defineAuthProfile
  // (connector is required), and emitting `connector: null` would crash on the
  // next `lobu apply` (connectorKey(null)). Skip it — the caller warns.
  if (!p.connector_key) return null;
  imports.use("defineAuthProfile");
  const interactive =
    p.profile_kind === "oauth_account" || p.profile_kind === "browser_session";
  const connectorRef =
    connectorHandles.get(p.connector_key) ?? str(p.connector_key);
  const fields: string[] = [
    `slug: ${str(p.slug)}`,
    `connector: ${connectorRef}`,
    `authKind: ${str(p.profile_kind)}`,
  ];
  if (p.display_name) fields.push(`name: ${str(p.display_name)}`);
  // Credentials are write-only on the server, so we can't recover the real
  // values. Emit secret placeholders the operator wires in via .env, keyed by
  // the connector's real auth-schema fields — `lobu apply` validates each
  // credential KEY against the connector's auth_schema, so an env-var-derived
  // key would be rejected. Interactive kinds (oauth_account / browser_session)
  // take no credentials.
  if (
    !interactive &&
    (p.profile_kind === "env" || p.profile_kind === "oauth_app")
  ) {
    const fieldKeys = authSchemas.has(p.connector_key)
      ? authSchemaFields(authSchemas.get(p.connector_key), p.profile_kind)
      : null;
    if (fieldKeys && fieldKeys.length > 0) {
      // Emit `credentials: { <field>: secret("<SLUG>_<FIELD>") }` for each real
      // auth-schema field, with a deterministic env-var name per field.
      const credLines = fieldKeys.map(
        (field) =>
          `${emitKey(field)}: ${secrets.ref(
            envVarFor(
              p.slug,
              field.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()
            )
          )}`
      );
      fields.push(`credentials: {\n    ${credLines.join(",\n    ")},\n  }`);
    } else {
      // No connector def / auth_schema found — fall back to a single
      // placeholder and warn the operator (scaffold output, not TODO in
      // generated code): the credential KEY must be renamed to a real
      // auth-schema field before `lobu apply`.
      const credKey =
        p.profile_kind === "oauth_app" ? "CLIENT_SECRET" : "VALUE";
      fields.push(
        `credentials: {\n    ${envVarFor(p.slug, credKey)}: ${secrets.ref(envVarFor(p.slug, credKey))},\n  }`
      );
      warnings.push(
        `auth profile "${p.slug}" (connector "${p.connector_key}"): no connector definition found, emitted placeholder credential key "${envVarFor(p.slug, credKey)}" — rename it to the connector's real auth-schema field in lobu.config.ts before \`lobu apply\`.`
      );
    }
  }
  const name = minter.mint(p.slug, "Auth");
  return {
    name,
    decl: `const ${name} = defineAuthProfile(${objectLiteral(fields, 0)});`,
  };
}

function emitConnection(
  c: RemoteConnection,
  feeds: RemoteFeed[],
  authHandles: Map<string, string>,
  connectorHandles: Map<string, string>,
  imports: ImportTracker,
  secrets: SecretCollector,
  minter: IdentMinter,
  managedBy?: { org: string; connectionSlug: string }
): Handle {
  imports.use("defineConnection");
  // A BYO chat connection (credential_mode 'byo') keeps its token in `config`,
  // stored server-side as a write-only `secret://` ref. Round-trip it as a
  // `secret("<CONN>_<KEY>")` placeholder so the generated config is applicable
  // (the real value goes in .env), mirroring the auth-profile credential path.
  const isByoChat = c.credential_mode === "byo";
  const connectorRef =
    connectorHandles.get(c.connector_key) ?? str(c.connector_key);
  const fields: string[] = [
    `slug: ${str(c.slug)}`,
    `connector: ${connectorRef}`,
  ];
  if (isByoChat) fields.push(`credentialMode: "byo"`);
  if (c.display_name) fields.push(`name: ${str(c.display_name)}`);
  if (managedBy) {
    fields.push(
      `managedBy: { org: ${str(managedBy.org)}, connectionSlug: ${str(managedBy.connectionSlug)} }`
    );
  } else if (c.auth_profile_slug) {
    const ref =
      authHandles.get(c.auth_profile_slug) ?? str(c.auth_profile_slug);
    fields.push(`authProfile: ${ref}`);
  }
  if (!managedBy && c.app_auth_profile_slug) {
    const ref =
      authHandles.get(c.app_auth_profile_slug) ?? str(c.app_auth_profile_slug);
    fields.push(`appAuthProfile: ${ref}`);
  }
  const config = managedBy ? stripManagedGrantConfig(c.config) : c.config;
  if (config && Object.keys(config).length > 0) {
    if (isByoChat) {
      // Replace each stored `secret://` config value with a secret() placeholder
      // keyed by <CONN>_<KEY>; pass literals through unchanged.
      const parts = Object.entries(config).map(([k, v]) =>
        typeof v === "string" && v.startsWith("secret://")
          ? `${emitKey(k)}: ${secrets.ref(envVarFor(c.slug, k))}`
          : `${emitKey(k)}: ${emitValue(v, 1)}`
      );
      fields.push(`config: ${objectLiteral(parts, 1)}`);
    } else {
      fields.push(`config: ${emitValue(config, 1)}`);
    }
  }
  if (c.device_worker_id) {
    fields.push(`deviceWorkerId: ${str(c.device_worker_id)}`);
  }
  if (feeds.length > 0) {
    const items = feeds
      .slice()
      .sort((a, b) => a.feed_key.localeCompare(b.feed_key))
      .map((f) => {
        const fFields: string[] = [`feed: ${str(f.feed_key)}`];
        if (f.display_name) fFields.push(`name: ${str(f.display_name)}`);
        if (f.schedule) fFields.push(`schedule: ${str(f.schedule)}`);
        if (f.config && Object.keys(f.config).length > 0) {
          fFields.push(`config: ${emitValue(f.config, 3)}`);
        }
        return objectLiteral(fFields, 2);
      });
    fields.push(`feeds: [\n    ${items.join(",\n    ")},\n  ]`);
  }
  const name = minter.mint(c.slug, "Conn");
  return {
    name,
    decl: `const ${name} = defineConnection(${objectLiteral(fields, 0)});`,
  };
}

function isManagedGrantHolderConnection(c: RemoteConnection): boolean {
  const credentialMode = c.effective_credential_mode ?? c.credential_mode;
  return (
    !!c.app_auth_profile_slug &&
    (c.config?.consent_only === true ||
      c.config?.managedBy !== undefined ||
      credentialMode === "managed")
  );
}

function stripManagedGrantConfig(
  config: RemoteConnection["config"]
): RemoteConnection["config"] {
  if (!config) return config;
  const next = { ...config };
  delete next.consent_only;
  delete next.managedBy;
  return Object.keys(next).length > 0 ? next : null;
}

function managedOnlyAuthProfileSlugs(
  connections: Array<{ connection: RemoteConnection; feeds: RemoteFeed[] }>
): Set<string> {
  const managedRefs = new Set<string>();
  const nonManagedRefs = new Set<string>();
  for (const { connection } of connections) {
    const target = isManagedGrantHolderConnection(connection)
      ? managedRefs
      : nonManagedRefs;
    if (connection.auth_profile_slug) target.add(connection.auth_profile_slug);
    if (connection.app_auth_profile_slug) {
      target.add(connection.app_auth_profile_slug);
    }
  }
  for (const ref of nonManagedRefs) managedRefs.delete(ref);
  return managedRefs;
}

// ── Fetch the org's full declared state ─────────────────────────────────────

interface FetchedState {
  agents: Array<{
    agent: RemoteAgent;
    settings: AgentSettings | null;
  }>;
  entityTypes: RemoteEntityType[];
  relationshipTypes: RemoteRelationshipType[];
  automations: Array<{
    automation: RemoteAutomation;
    reactionScript: string | null;
  }>;
  authProfiles: RemoteAuthProfile[];
  connections: Array<{ connection: RemoteConnection; feeds: RemoteFeed[] }>;
  /** connector_key → auth_schema (for emitting real credential field keys). */
  connectorDefinitions: RemoteConnectorDefinition[];
}

async function fetchOrgState(
  client: ApplyClient,
  orgId: string | undefined
): Promise<FetchedState> {
  const [
    agentList,
    entityTypes,
    relationshipTypes,
    automationList,
    authProfiles,
    connectionList,
    connectorDefinitions,
  ] = await Promise.all([
    client.listAgents(),
    client.listEntityTypes(),
    client.listRelationshipTypes(),
    client.listAutomations(),
    client.listAuthProfiles(),
    client.listConnections(),
    // Connector defs carry each connector's auth_schema, so init-from-org can
    // emit auth-profile credentials keyed by the real schema fields. Best-effort
    // — a fetch failure falls back to placeholder credential keys.
    client.listConnectors(true).catch(() => []),
  ]);

  // The relationship-type `list` action omits rules, so hydrate each type's
  // rules (list_rules) before emitting — otherwise the generated config drops
  // every `rules: [...]` binding and the round-trip is lossy. Best-effort per
  // type so one failure doesn't abort the whole bootstrap.
  for (const rt of relationshipTypes) {
    try {
      const rules = await client.listRelationshipTypeRules(rt.slug);
      if (rules.length > 0) {
        rt.rules = rules.map((r) => ({ source: r.source, target: r.target }));
      }
    } catch {
      // leave rules undefined — emitRelationshipType simply omits the block
    }
  }

  const agents = await Promise.all(
    agentList
      .slice()
      .sort((a, b) => a.agentId.localeCompare(b.agentId))
      .map(async (agent) => ({
        agent,
        settings: await client.getAgentSettings(agent.agentId),
      }))
  );

  // reaction_script isn't on the list response — fetch each automation's detail.
  const automations = await Promise.all(
    automationList
      .slice()
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map(async (automation) => {
        let reactionScript: string | null = null;
        if (automation.automation_id) {
          const detail = await client.getAutomationDetail(
            automation.automation_id
          );
          reactionScript = detail?.reaction_script ?? null;
          if (detail?.description && !automation.description) {
            automation.description = detail.description;
          }
        }
        return { automation, reactionScript };
      })
  );

  const connections = await Promise.all(
    connectionList
      .slice()
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map(async (connection) => ({
        connection,
        feeds: await client.listFeeds(connection.id),
      }))
  );

  // The entity/relationship-type `list` endpoints also return *public* types
  // from OTHER orgs (`o.visibility = 'public'`) so the UI can reference them —
  // but a generated config must only DECLARE the types this org owns, or it
  // emits dozens of foreign `defineEntityType()` blocks with colliding keys
  // (e.g. `product` from several public orgs) that won't apply. Mirror apply's
  // `ownsDefinition` guard. `$`-prefixed types (e.g. `$member`) are server-
  // provisioned system types that reject create — never declare them either.
  // Rules that reference a non-owned type still render as a string ref
  // (see `emitRelationshipType`), so cross-org bindings survive.
  const ownsDefinition = (definitionOrgId: string | undefined): boolean =>
    orgId === undefined ||
    definitionOrgId === undefined ||
    definitionOrgId === orgId;
  const isOwnDeclarable = (d: {
    slug: string;
    organization_id?: string;
  }): boolean => ownsDefinition(d.organization_id) && !d.slug.startsWith("$");

  return {
    agents,
    entityTypes: entityTypes
      .filter(isOwnDeclarable)
      .sort((a, b) => a.slug.localeCompare(b.slug)),
    relationshipTypes: relationshipTypes
      .filter(isOwnDeclarable)
      .sort((a, b) => a.slug.localeCompare(b.slug)),
    automations,
    authProfiles: authProfiles
      .slice()
      .sort((a, b) => a.slug.localeCompare(b.slug)),
    connections,
    connectorDefinitions,
  };
}

// ── Assemble lobu.config.ts ─────────────────────────────────────────────────

interface GeneratedProject {
  configSource: string;
  files: Array<{ relPath: string; body: string }>;
  envVars: string[];
  /** Non-fatal issues (e.g. a skipped malformed auth profile) to surface. */
  warnings: string[];
}

function generateProject(
  orgSlug: string,
  orgName: string | undefined,
  state: FetchedState
): GeneratedProject {
  const imports = new ImportTracker();
  imports.use("defineConfig");
  const secrets = new SecretCollector(imports);
  const minter = new IdentMinter();
  const files: Array<{ relPath: string; body: string }> = [];
  const warnings: string[] = [];

  // Prompt text round-trips directly. Skill references resolve through the
  // generated agent library, whose bodies are the library's current state, not
  // necessarily the older snapshots pinned on each Automation version. Surface
  // that drift honestly: the generated config is an upgrade when bodies differ.
  const agentsById = new Map(
    state.agents.map(({ agent, settings }) => [agent.agentId, settings])
  );
  for (const { automation, reactionScript } of state.automations) {
    if (
      !automation.prompt?.trim() &&
      !automation.skills?.length &&
      !reactionScript?.trim() &&
      automationRequiresInstructions(automation.triggers)
    ) {
      warnings.push(
        `Automation "${automation.slug}" has no stored instructions but is not event-turn-only — give it a prompt, attach at least one skill, or set a reaction script before the next \`lobu apply\`.`
      );
    }
    const library =
      agentsById.get(automation.managed_agent_id ?? "")?.skillsConfig?.skills ??
      [];
    for (const snapshot of automation.skills ?? []) {
      const current = library.find(
        (skill) => !skill.system && skill.name === snapshot.name
      );
      if (!current) {
        warnings.push(
          `Automation "${automation.slug}" pins skill "${snapshot.name}", but that skill is absent from agent "${automation.managed_agent_id ?? ""}"'s current library — restore it or remove the Automation reference before \`lobu apply\`.`
        );
        continue;
      }
      if (!current.content?.trim()) {
        warnings.push(
          `Automation "${automation.slug}" pins skill "${snapshot.name}", but its current agent-library body is empty — restore the body or remove the Automation reference before \`lobu apply\`.`
        );
        continue;
      }
      if (current.enabled === false) {
        warnings.push(
          `Automation "${automation.slug}" pins disabled skill "${snapshot.name}" — the generated config declares it as enabled, so the next \`lobu apply\` will re-enable it and publish the current body.`
        );
      }
      if (current.content.trim() !== snapshot.content.trim()) {
        warnings.push(
          `Automation "${automation.slug}" pins an older body of skill "${snapshot.name}" — the generated config uses the agent library's current body, so the next \`lobu apply\` will publish that upgrade.`
        );
      }
    }
  }

  // Agents first (automations reference their handles).
  const agentHandles = new Map<string, string>();
  const agentDecls: string[] = [];
  for (const { agent, settings } of state.agents) {
    const emitted = emitAgent(agent, settings, imports, secrets, minter);
    agentHandles.set(agent.agentId, emitted.handle.name);
    agentDecls.push(emitted.handle.decl);
    files.push(...emitted.files);
  }

  // Entities (relationships reference their handles).
  const entityHandles = new Map<string, string>();
  const entityDecls: string[] = [];
  for (const e of state.entityTypes) {
    const h = emitEntityType(e, imports, minter);
    entityHandles.set(e.slug, h.name);
    entityDecls.push(h.decl);
  }

  const relDecls: string[] = [];
  const relHandles: string[] = [];
  for (const r of state.relationshipTypes) {
    const h = emitRelationshipType(r, entityHandles, imports, minter);
    relDecls.push(h.decl);
    relHandles.push(h.name);
  }

  // Auth profiles + connections (connector key referenced by string — no local
  // connector source is exported, so connectors stay bare string refs).
  const connectorHandles = new Map<string, string>();
  // connector_key → auth_schema, so auth profiles emit credentials keyed by the
  // connector's real schema fields (validated by `lobu apply`).
  const authSchemas = new Map<
    string,
    Record<string, unknown> | null | undefined
  >();
  for (const def of state.connectorDefinitions) {
    if (def.key) authSchemas.set(def.key, def.auth_schema);
  }
  const authHandles = new Map<string, string>();
  const authDecls: string[] = [];
  const authProfilesToSkip = managedOnlyAuthProfileSlugs(state.connections);
  for (const p of state.authProfiles) {
    if (authProfilesToSkip.has(p.slug)) continue;
    const h = emitAuthProfile(
      p,
      secrets,
      connectorHandles,
      authSchemas,
      imports,
      minter,
      warnings
    );
    if (!h) {
      warnings.push(
        `auth profile "${p.slug}" has no connector — skipped (set its connector and re-add it to lobu.config.ts).`
      );
      continue;
    }
    authHandles.set(p.slug, h.name);
    authDecls.push(h.decl);
  }

  const connDecls: string[] = [];
  const connHandles: string[] = [];
  for (const { connection, feeds } of state.connections) {
    const managedBy = isManagedGrantHolderConnection(connection)
      ? { org: orgSlug, connectionSlug: connection.slug }
      : undefined;
    const h = emitConnection(
      connection,
      feeds,
      authHandles,
      connectorHandles,
      imports,
      secrets,
      minter,
      managedBy
    );
    connDecls.push(h.decl);
    connHandles.push(h.name);
  }

  // Automations last.
  const automationDecls: string[] = [];
  const automationHandles: string[] = [];
  const connectionHandlesById = new Map<number, string>();
  for (let index = 0; index < state.connections.length; index++) {
    const connection = state.connections[index]?.connection;
    const handle = connHandles[index];
    if (connection && handle) connectionHandlesById.set(connection.id, handle);
  }
  for (const { automation, reactionScript } of state.automations) {
    const { handle, reactionFile } = emitAutomation(
      automation,
      reactionScript,
      agentHandles,
      connectionHandlesById,
      imports,
      minter
    );
    automationDecls.push(handle.decl);
    automationHandles.push(handle.name);
    if (reactionFile) files.push(reactionFile);
  }

  // defineConfig({ ... }).
  const configFields: string[] = [`org: ${str(orgSlug)}`];
  if (orgName) configFields.push(`orgName: ${str(orgName)}`);
  configFields.push(`agents: [${[...agentHandles.values()].join(", ")}]`);
  if (entityHandles.size > 0) {
    configFields.push(`entities: [${[...entityHandles.values()].join(", ")}]`);
  }
  if (relHandles.length > 0) {
    configFields.push(`relationships: [${relHandles.join(", ")}]`);
  }
  if (connHandles.length > 0) {
    configFields.push(`connections: [${connHandles.join(", ")}]`);
  }
  if (authHandles.size > 0) {
    configFields.push(
      `authProfiles: [${[...authHandles.values()].join(", ")}]`
    );
  }
  if (automationHandles.length > 0) {
    configFields.push(`automations: [${automationHandles.join(", ")}]`);
  }

  const blocks: string[] = [];
  const pushBlock = (decls: string[]) => {
    if (decls.length > 0) blocks.push(decls.join("\n\n"));
  };
  pushBlock(agentDecls);
  pushBlock(entityDecls);
  pushBlock(relDecls);
  pushBlock(authDecls);
  pushBlock(connDecls);
  pushBlock(automationDecls);

  const header = [
    "// lobu.config.ts — bootstrapped by `lobu init --from-org`",
    "// Docs: https://lobu.ai/getting-started/",
    "//",
    "// Secrets are write-only on the server, so provider keys, auth-profile",
    '// credentials, and MCP client secrets are emitted as secret("ENV_VAR")',
    "// placeholders. Fill them into .env before `lobu run` or `lobu apply`.",
  ].join("\n");

  const configSource = `${[
    header,
    "",
    imports.render(),
    "",
    blocks.join("\n\n"),
    "",
    `export default defineConfig(${objectLiteral(configFields, 0)});`,
    "",
  ].join("\n")}`;

  return {
    configSource,
    files,
    envVars: [...secrets.names].sort(),
    warnings,
  };
}

// ── Top-level ────────────────────────────────────────────────────────────────

export async function initFromOrg(opts: InitFromOrgOptions): Promise<void> {
  const targetDir = resolve(opts.targetDir);
  const projectName = opts.projectName ?? basename(targetDir);
  const gatewayPort = opts.gatewayPort ?? "8787";
  const workerProxyPort = opts.workerProxyPort ?? "8118";

  const { client, orgSlug } = await resolveApplyClient({
    url: opts.url,
    org: opts.org,
    fetchImpl: opts.fetchImpl,
  });
  printText(chalk.dim(`Bootstrapping from org: ${orgSlug}`));
  printText(chalk.dim(`Destination: ${targetDir}`));

  // Org id + display name from the userinfo orgs list (no description endpoint).
  // The id scopes type declarations to what this org owns (see fetchOrgState).
  const orgs = await client.listOrgs().catch(() => []);
  const targetOrg = orgs.find((o) => o.slug === orgSlug);
  const orgName = targetOrg?.name;

  const state = await fetchOrgState(client, targetOrg?.id);
  const project = generateProject(orgSlug, orgName, state);

  // Write lobu.config.ts.
  await writeFile(
    join(targetDir, "lobu.config.ts"),
    project.configSource,
    "utf-8"
  );

  // Write file-convention artifacts (agent dirs, skills, reactions).
  for (const file of project.files) {
    const abs = join(targetDir, file.relPath);
    await mkdir(resolve(abs, ".."), { recursive: true });
    await writeFile(abs, file.body, "utf-8");
  }

  // The managed-auth onboarding path points users at `lobu init --from-org`.
  // Give coding agents the same config and verification contract as a blank
  // scaffold; otherwise this path produces a runnable project with no guidance
  // and the agent has to guess the public authoring surface.
  const templateVariables = {
    PROJECT_NAME: projectName,
    GATEWAY_PORT: gatewayPort,
  };
  await renderTemplate(
    "AGENTS.md.tmpl",
    templateVariables,
    join(targetDir, "AGENTS.md")
  );
  await renderTemplate(
    "TESTING.md.tmpl",
    templateVariables,
    join(targetDir, "TESTING.md")
  );
  await renderTemplate(".gitignore.tmpl", {}, join(targetDir, ".gitignore"));

  // Unlike cloud, the embedded runtime needs a stable local encryption key.
  // Make the inverse-apply scaffold bootable without asking the user to invent
  // infrastructure settings, while keeping every cloud secret as an empty
  // placeholder for them to fill explicitly.
  const localEnv = `${[
    "# Local runtime generated by `lobu init --from-org`.",
    `GATEWAY_PORT=${gatewayPort}`,
    `WORKER_PROXY_PORT=${workerProxyPort}`,
    "DATABASE_URL=file://.",
    `ENCRYPTION_KEY=${randomBytes(32).toString("hex")}`,
    "",
    "# Write-only secrets referenced by lobu.config.ts.",
    ...project.envVars.map((name) => `${name}=`),
    "",
  ].join("\n")}`;
  const envPath = join(targetDir, ".env");
  await writeFile(envPath, localEnv, { encoding: "utf-8", mode: 0o600 });
  await chmod(envPath, 0o600).catch(() => undefined);

  // .env.example listing the write-only secret var names.
  if (project.envVars.length > 0) {
    const body = `${[
      "# Secrets referenced by lobu.config.ts (write-only on the server, not exported).",
      "# Fill these in before running `lobu run` or `lobu apply`.",
      "",
      ...project.envVars.map((v) => `${v}=`),
      "",
    ].join("\n")}`;
    await writeFile(join(targetDir, ".env.example"), body, "utf-8");
  }

  // ── Report ──────────────────────────────────────────────────────────────
  printText(chalk.bold("\nWrote:"));
  printText(`  ${chalk.green("+")} lobu.config.ts`);
  printText(`  ${chalk.green("+")} AGENTS.md`);
  printText(`  ${chalk.green("+")} TESTING.md`);
  printText(`  ${chalk.green("+")} .env`);
  printText(`  ${chalk.green("+")} .gitignore`);
  for (const file of project.files) {
    printText(`  ${chalk.green("+")} ${file.relPath}`);
  }
  if (project.envVars.length > 0) {
    printText(`  ${chalk.green("+")} .env.example`);
    printText(
      chalk.bold(
        "\nWrite-only secrets to fill into .env before running or applying:"
      )
    );
    for (const v of project.envVars) {
      printText(`  ${chalk.yellow("·")} ${v}`);
    }
  }
  if (project.warnings.length > 0) {
    printText(chalk.bold("\nWarnings:"));
    for (const w of project.warnings) {
      printText(`  ${chalk.yellow("⚠")} ${w}`);
    }
  }
  printText(
    chalk.dim(
      "\nReview lobu.config.ts, fill .env, then `lobu run` to boot it locally.\n"
    )
  );
}
