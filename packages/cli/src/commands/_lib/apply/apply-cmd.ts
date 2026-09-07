import { readFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { resolveContext } from "../../../internal/context.js";
import { parseEnvContent } from "../../../internal/env-file.js";
import { printError, printText } from "../../../internal/output.js";
import { loadProjectLink } from "../../../internal/project-link.js";
import { ApiError, ValidationError } from "../../memory/_lib/errors.js";
import {
  type ApplyClient,
  type RemoteAgent,
  type RemoteConnectorDefinition,
  type RemoteFeed,
  resolveApplyClient,
} from "./client.js";
import {
  type BaselineRecord,
  buildAttributionAndOwned,
  buildCountsByKind,
  buildDeploymentManifest,
  collectGitInfo,
  computeManifestHash,
  type DeploymentSummary,
  loadBaselineFromManifest,
  mintApplyId,
  toBaseline,
} from "./deployment.js";
import {
  type DesiredConnectorDefinition,
  type DesiredState,
  type DesiredAutomation,
  loadDesiredStateFromConfig,
  normalizeConnectionConfigScope,
  resolveConnectorSchemas,
  validateAuthProfileAgainstConnector,
  validateConnectionAgainstConnector,
} from "./desired-state.js";
import {
  buildUpdatePayload,
  computeDiff,
  type DiffPlan,
  type DiffRow,
  type RemoteSnapshot,
  UPDATE_FIELD_TABLES,
} from "./diff.js";
import {
  confirmCustomConnectors,
  confirmDeletions,
  confirmPlan,
} from "./prompt.js";
import {
  hydrateManagedConnectorCatalog,
  isManagedCloudTarget,
  loadManagedCloudConnectorCatalog,
} from "./managed-connector-catalog.js";
import {
  renderBlockedReport,
  renderMissingSecrets,
  renderPlan,
  renderPostApplyPunchList,
  renderProgress,
} from "./render.js";
import {
  automationExecutionConfig,
  declaredConnectorKeys,
  referencedConnectorKeys,
} from "./shared.js";

interface ApplyOptions {
  cwd?: string;
  dryRun?: boolean;
  yes?: boolean;
  only?: "agents" | "memory";
  org?: string;
  url?: string;
  /** Bypass the project-link guard. */
  force?: boolean;
  /**
   * Clear the promotions pause a `lobu rollback` set and proceed. Without it,
   * apply refuses while the org is paused — CI must never silently re-promote
   * over a deliberate rollback.
   */
  resume?: boolean;
  /** CLI version stamped into the deployment summary. */
  cliVersion?: string;
  /** Test seam — inject a stubbed fetch. */
  fetchImpl?: typeof fetch;
}

export interface PendingAuthEntry {
  slug: string;
  kind: string;
  connectUrl?: string;
}

/** Resolve declarative connection slugs to the integer API contract. */
export function resolveAutomationConnectionRefs(
  automations: DesiredAutomation[],
  connectionIdBySlug: ReadonlyMap<string, number>,
  requireResolved: boolean
): void {
  for (const automation of automations) {
    if (!automation.triggers) continue;
    automation.triggers = automation.triggers.map((trigger) => {
      if (
        trigger.kind !== "event" ||
        trigger.source === "workspace" ||
        !trigger.connectionSlug
      ) {
        return trigger;
      }
      const connectionId = connectionIdBySlug.get(trigger.connectionSlug);
      if (connectionId === undefined) {
        if (requireResolved) {
          throw new ApiError(
            `automation "${automation.slug}" references connection "${trigger.connectionSlug}" which has no remote ID — create the connection first, or omit --only so apply can create it`
          );
        }
        return trigger;
      }
      const resolved = { ...trigger, connection_id: connectionId };
      delete resolved.connectionSlug;
      return resolved;
    });
  }
}

/** Deletes beyond this in one pruning apply trigger a second confirm. */
const BLAST_RADIUS_DELETE_THRESHOLD = 3;

// ── Required-secrets check ─────────────────────────────────────────────────

function checkRequiredSecrets(state: DesiredState): { missing: string[] } {
  const missing = state.requiredSecrets.filter(
    (name) => process.env[name] === undefined || process.env[name] === ""
  );
  return { missing };
}

/**
 * Merge `.env` values from the project dir into `process.env` (without
 * overriding values already set in the shell). Quietly noop if the file
 * doesn't exist or can't be parsed — `checkRequiredSecrets` will surface a
 * clear "Missing required secret" error downstream.
 */
async function loadProjectEnvFile(cwd: string): Promise<void> {
  const envPath = join(cwd, ".env");
  let raw: string;
  try {
    raw = await readFile(envPath, "utf-8");
  } catch {
    return;
  }
  const vars = parseEnvContent(raw);
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// ── source_url: confirmed-before-fetch, https-only, bounded fetch ──────────

const CONNECTOR_SOURCE_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
const CONNECTOR_SOURCE_FETCH_TIMEOUT_MS = 15_000;

/**
 * Read a response body as a stream, counting *bytes* and aborting as soon as
 * the running total exceeds `maxBytes` — before buffering the rest. Decodes to
 * UTF-8 text only after the (bounded) body is in hand. Exported for testing.
 */
export async function readBoundedBody(
  res: Response,
  maxBytes: number,
  onOverflow: () => never
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming body (rare; e.g. a mock). Fall back to text() + a byte check.
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) onOverflow();
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          onOverflow();
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // already released by cancel() — ignore
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

async function materializeConnectorSource(
  defs: DesiredConnectorDefinition[],
  fetchImpl: typeof fetch
): Promise<void> {
  for (const def of defs) {
    if (def.sourceCode !== undefined || !def.sourceUrl) continue;
    let url: URL;
    try {
      url = new URL(def.sourceUrl);
    } catch {
      throw new ValidationError(
        `${def.sourceFile}: connector source_url is not a valid URL: ${def.sourceUrl}`
      );
    }
    if (url.protocol !== "https:") {
      throw new ValidationError(
        `${def.sourceFile}: connector source_url must use https (got ${url.protocol}//): ${def.sourceUrl}`
      );
    }
    const controller = new AbortController();
    // Single timer covering the whole exchange — connect AND body consumption.
    const timer = setTimeout(
      () => controller.abort(),
      CONNECTOR_SOURCE_FETCH_TIMEOUT_MS
    );
    let body: string;
    try {
      let res: Response;
      try {
        res = await fetchImpl(def.sourceUrl, { signal: controller.signal });
      } catch (err) {
        throw new ValidationError(
          `${def.sourceFile}: failed to fetch connector source_url ${def.sourceUrl} — ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (!res.ok) {
        throw new ValidationError(
          `${def.sourceFile}: connector source_url ${def.sourceUrl} returned HTTP ${res.status} ${res.statusText}`
        );
      }
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (
        contentType &&
        !/(text\/|application\/(typescript|javascript|x-typescript|octet-stream))/.test(
          contentType
        )
      ) {
        throw new ValidationError(
          `${def.sourceFile}: connector source_url ${def.sourceUrl} returned unexpected content-type "${contentType}" — expected text/*, application/typescript, or application/javascript`
        );
      }
      try {
        body = await readBoundedBody(res, CONNECTOR_SOURCE_MAX_BYTES, () => {
          throw new ValidationError(
            `${def.sourceFile}: connector source_url ${def.sourceUrl} body exceeds the ${CONNECTOR_SOURCE_MAX_BYTES}-byte cap`
          );
        });
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        throw new ValidationError(
          `${def.sourceFile}: failed to read connector source_url ${def.sourceUrl} — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } finally {
      clearTimeout(timer);
    }
    if (!body.trim()) {
      throw new ValidationError(
        `${def.sourceFile}: connector source_url ${def.sourceUrl} returned an empty body`
      );
    }
    def.sourceCode = body;
  }
}

/**
 * Warn + require confirmation BEFORE the CLI fetches any `source_url` or
 * uploads any custom connector source for compilation on the gateway.
 *
 * SECURITY: `install_connector` compiles + imports + instantiates the connector
 * runtime class on the gateway. The server-side compiler currently runs with
 * full gateway env/fs/network and only blocks relative imports — this consent
 * gate is the operator's last line of defence. (TODO(security): sandbox the
 * server-side connector compiler — tracked separately, out of scope here.)
 */
async function confirmCustomConnectorSource(
  defs: DesiredConnectorDefinition[],
  yes: boolean
): Promise<void> {
  if (defs.length === 0) return;
  printText(
    chalk.yellow(
      `\n  ⚠ This project ships ${defs.length} custom connector source ${defs.length === 1 ? "definition" : "definitions"}:`
    )
  );
  for (const def of defs) {
    printText(
      chalk.yellow(
        def.sourceUrl
          ? `    - ${def.sourceFile} → fetches ${def.sourceUrl}`
          : `    - ${def.sourceFile}`
      )
    );
  }
  printText(
    chalk.yellow(
      "  `lobu apply` will fetch (https) and UPLOAD this source; the gateway will COMPILE and EXECUTE it.\n  Only proceed if you trust this code."
    )
  );
  const ok = await confirmCustomConnectors(yes);
  if (!ok) {
    throw new ValidationError("Cancelled — custom connectors not confirmed.");
  }
}

// ── Snapshot ───────────────────────────────────────────────────────────────

/** True when the config declares any connector definition / auth profile / connection. */
function hasDesiredConnectors(state: DesiredState): boolean {
  return (
    state.connectors.definitions.length > 0 ||
    state.connectors.authProfiles.length > 0 ||
    state.connectors.connections.length > 0
  );
}

export async function fetchRemoteSnapshot(
  client: ApplyClient,
  state: DesiredState,
  only?: "agents" | "memory",
  prune = false,
  orgId?: string
): Promise<RemoteSnapshot> {
  const agents: RemoteAgent[] =
    only === "memory" ? [] : await client.listAgents();
  const agentSettings = new Map<
    string,
    Awaited<ReturnType<ApplyClient["getAgentSettings"]>>
  >();

  if (only !== "memory") {
    const desiredAgentIds = state.agents.map((a) => a.metadata.agentId);
    const remoteAgentIds = new Set(agents.map((a) => a.agentId));
    const targetAgentIds = desiredAgentIds.filter((id) =>
      remoteAgentIds.has(id)
    );
    for (const agentId of targetAgentIds) {
      agentSettings.set(agentId, await client.getAgentSettings(agentId));
    }
  }

  const entityTypes = only === "agents" ? [] : await client.listEntityTypes();
  // View templates are fetched per-type, NOT streamed in the entity-type list
  // (the UI/bootstrap calls that endpoint). Fetch for config-declared types
  // (a declared template, or under prune so an omitted one is a removal) AND,
  // under prune, for remote-only candidates whose owned/unchanged delete
  // classification must see the real template — otherwise an unhydrated
  // `undefined` compares equal to a stale baseline and a UI-authored template
  // edit is misclassified as unchanged and auto-deleted. Bounded to the org's
  // own entity-type set.
  if (entityTypes.length > 0) {
    const desiredBySlug = new Map(
      state.memorySchema.entityTypes.map((e) => [e.slug, e])
    );
    for (const remote of entityTypes) {
      const desired = desiredBySlug.get(remote.slug);
      // The list also surfaces public types owned by OTHER orgs. Fetch a
      // template only for types this org owns: the fetch resolves by slug in
      // THIS org, so a foreign public type whose local slug is absent (or
      // soft-deleted) would 404 and abort the whole apply.
      if (
        orgId !== undefined &&
        remote.organization_id !== undefined &&
        remote.organization_id !== orgId
      ) {
        continue;
      }
      // Declared template → always. Otherwise only under prune, where an
      // omitted template is a removal (declared types) and an unhydrated
      // `undefined` would make a UI-authored template look unchanged since the
      // baseline (remote-only delete candidates).
      if (desired?.viewTemplate === undefined && !prune) continue;
      const tpl = await client.getEntityTypeViewTemplate(remote.slug);
      if (tpl) remote.viewTemplate = tpl;
    }
  }
  const relationshipTypes =
    only === "agents" ? [] : await client.listRelationshipTypes();
  // The relationship-type `list` action omits rules, so the diff would compare
  // desired rules against an always-empty remote and churn a perpetual "rules
  // changed" update. Hydrate rules for every type the config also declares —
  // including those the config declares with NO rules, so dropping all rules is
  // detected as a change (and reconciled away) rather than a silent noop.
  if (relationshipTypes.length > 0) {
    const desiredRelSlugs = new Set(
      state.memorySchema.relationshipTypes.map((r) => r.slug)
    );
    for (const remote of relationshipTypes) {
      // Hydrate rules for config-declared types AND (under prune) remote-only
      // candidates, so the owned/unchanged delete classification sees the real
      // rule set instead of an unhydrated undefined.
      if (!desiredRelSlugs.has(remote.slug) && !prune) continue;
      const rules = await client.listRelationshipTypeRules(remote.slug);
      remote.rules = rules.map((r) => ({ source: r.source, target: r.target }));
    }
  }
  const automations = only === "agents" ? [] : await client.listAutomations();

  // Connectors run only on a full apply (`--only` skips them). A pruning config
  // also fetches them even when it declares none, so prune can delete a
  // connector definition whose last config reference was removed (otherwise an
  // empty desired-connectors set would skip the fetch entirely).
  const hasConnectors = hasDesiredConnectors(state);
  const fetchConnectors = !only && (hasConnectors || prune);
  const fetchAutomationConnections =
    only === "memory" &&
    state.automations.some((automation) =>
      automation.triggers?.some(
        (trigger) =>
          trigger.kind === "event" &&
          trigger.source !== "workspace" &&
          trigger.connectionSlug !== undefined
      )
    );
  const connectorDefinitions = fetchConnectors
    ? await client.listConnectors(true)
    : [];
  const authProfiles = fetchConnectors ? await client.listAuthProfiles() : [];
  const connections =
    fetchConnectors || fetchAutomationConnections
      ? await client.listConnections()
      : [];
  const feedsByConnectionId = new Map<number, RemoteFeed[]>();
  if (!only && hasConnectors) {
    const desiredConnSlugs = new Set(
      state.connectors.connections.map((c) => c.slug)
    );
    for (const conn of connections) {
      if (!desiredConnSlugs.has(conn.slug)) continue;
      feedsByConnectionId.set(conn.id, await client.listFeeds(conn.id));
    }
  }

  // Org-owned inference providers are org-scoped (neither agents nor memory), so
  // only a full apply reconciles them. The list drives create/update/drift.
  const inferenceProviders =
    only === undefined ? await client.listInferenceProviders() : [];

  return {
    agents,
    agentSettings,
    entityTypes,
    relationshipTypes,
    automations,
    connectorDefinitions,
    authProfiles,
    connections,
    feedsByConnectionId,
    inferenceProviders,
  };
}

// ── Connector definition install (runs INSIDE executePlan, after confirm) ──

/**
 * Install/update the project's custom connector definitions, then any bundled
 * or managed connectors referenced by an auth-profile / connection (the server
 * resolves only installed defs in create_auth_profile/create_feed, not raw
 * catalog entries). Returns the fresh connector-definition catalog.
 */
async function installConnectorDefinitions(
  client: ApplyClient,
  state: DesiredState,
  catalog: RemoteConnectorDefinition[],
  plan: DiffPlan
): Promise<{
  catalog: RemoteConnectorDefinition[];
  /**
   * Active version per config-relevant connector key AFTER this apply — the
   * deployment manifest's retained-version pins (`lobu rollback` repoints to
   * these via `rollback_connector_version`, no source re-push).
   */
  connectorVersions: Record<string, string>;
}> {
  const installedKeys = new Set(
    catalog.filter((d) => d.installed).map((d) => d.key)
  );
  // Connector keys this project supplies its own source for — these must NEVER
  // be replaced by a bundled `source_uri` install, even if a bundled connector
  // shares the key. (`null` keys — auto-discovered `*.connector.ts` whose key
  // the server resolves at compile time — are added to this set below as soon
  // as `install_connector` returns the resolved key, so the bundled loop can't
  // race them either.)
  const locallySuppliedKeys = locallyDeclaredConnectorKeys(state);
  let mutated = false;

  // Iterate the plan's connector-definition rows so progress mirrors the plan.
  for (const row of plan.rows) {
    if (row.kind !== "connector-definition") continue;
    if (row.verb === "noop" || row.verb === "drift") continue;
    const def = row.desired;
    if (!def) continue;
    let result: Awaited<ReturnType<typeof client.installConnector>>;
    if (def.sourcePath) {
      // Local `*.connector.ts`: compile on the CLI, where the project's
      // node_modules is available, so esbuild can bundle the connector's
      // declared npm deps (the server only receives the artifact). Native deps
      // ride `runtime.nix.packages` and are provisioned at run time. Compile
      // `sourcePath` (the actual `.ts`), not `sourceFile` (an error-message
      // label that may point at a `type: connector` YAML doc).
      //
      // Lazy-imported (cached by the loader) so the heavy connector-compile
      // graph (esbuild + connector-worker + SDK) stays out of apply-cmd's
      // module-load path — see the dynamic-import allow-list in AGENTS.md.
      const { ensureProjectDepsInstalled } = await import(
        "../ensure-deps-installed.js"
      );
      const { compileConnectorForIsolateFromFile } = await import(
        "../connector-loader.js"
      );
      ensureProjectDepsInstalled(def.sourcePath, printText);
      const compiledCode = await compileConnectorForIsolateFromFile(
        def.sourcePath
      );
      result = await client.installConnector({
        sourceCode: compiledCode,
        compiled: true,
      });
    } else if (def.sourceCode !== undefined) {
      // `source_url` connector: source was fetched into `sourceCode` and has no
      // local project/node_modules to bundle against — upload it raw and let
      // the gateway compile it (the pre-existing path).
      result = await client.installConnector({ sourceCode: def.sourceCode });
    } else {
      result = await client.installConnector({ sourceUrl: def.sourceUrl });
    }
    if (result.connectorKey) {
      locallySuppliedKeys.add(result.connectorKey);
      installedKeys.add(result.connectorKey);
    }
    mutated = true;
    printText(
      renderProgress(
        row.verb,
        "connector-definition",
        result.connectorKey || def.key || def.sourceFile,
        result.updated ? "(installed)" : "(unchanged)"
      )
    );
  }

  // Bundled connectors referenced by an auth-profile / connection — installed
  // ONLY if the org doesn't already have that key (installed in a prior apply
  // or just installed from local source above). A locally-supplied key is never
  // overwritten by the bundled `source_uri`.
  const catalogByKey = new Map(
    catalog
      .filter((d) => d.installable && (d.source_uri || d.managed_mcp_source))
      .map((d) => [d.key, d])
  );
  const referenced = referencedConnectorKeys(state.connectors);
  for (const key of [...referenced].sort()) {
    if (locallySuppliedKeys.has(key)) continue;
    const entry = catalogByKey.get(key);
    if (installedKeys.has(key) && !entry?.managed_mcp_source) continue;
    if (!entry?.source_uri && !entry?.managed_mcp_source) continue;
    const wasInstalled = installedKeys.has(key);
    const installPayload = entry.managed_mcp_source
      ? { sourceCode: entry.managed_mcp_source }
      : entry.source_uri
        ? { sourceUri: entry.source_uri }
        : null;
    if (!installPayload) continue;
    const result = await client.installConnector(installPayload);
    mutated = true;
    const origin = entry.managed_mcp_source ? "managed" : "bundled";
    printText(
      renderProgress(
        wasInstalled ? "update" : "create",
        "connector-definition",
        result.connectorKey || key,
        `(${wasInstalled ? "synced" : "installed"} ${origin})`
      )
    );
  }

  const finalCatalog = mutated ? await client.listConnectors(true) : catalog;

  // Pin the versions that are active NOW for every key this config declares
  // or references — the self-contained part of the deployment snapshot.
  const pinKeys = new Set([...locallySuppliedKeys, ...referenced]);
  const connectorVersions: Record<string, string> = {};
  for (const def of finalCatalog) {
    if (def.installed && def.version && pinKeys.has(def.key)) {
      connectorVersions[def.key] = def.version;
    }
  }
  return { catalog: finalCatalog, connectorVersions };
}

// ── Connector config validation (against a given catalog) ──────────────────

/**
 * Validate connection / auth-profile config against the connector definitions
 * the server knows about. When `skipSchemaForConnectorKeys` is given, those
 * connector keys (the locally-declared `*.connector.ts` / `type: connector`
 * ones) get only the structural checks here — full JSON-schema validation runs
 * later, after install + catalog refetch, against the *fresh* schemas. This
 * avoids rejecting a connection's config against a stale installed schema when
 * the same apply updates that connector.
 */
interface ValidateConnectorStateOptions {
  /**
   * Connector keys whose JSON-schema validation should be skipped in this pass
   * (the locally-declared ones in the *pre*-install pass — they're schema-
   * validated post-install against the fresh catalog).
   */
  skipSchemaForConnectorKeys?: ReadonlySet<string>;
  /**
   * When true (the *post*-install pass), every connector key referenced by a
   * desired auth profile or connection must be present in the catalog with
   * `installed === true` — otherwise a hard `ValidationError` before any
   * `executePlan` mutation. Catches a typo'd `connector:` ref, or a local
   * `*.connector.ts` whose compiled `definition.key` differs from what the
   * manifest assumed (so it never got installed under the expected key).
   */
  requireInstalled?: boolean;
}

export function validateConnectorState(
  state: DesiredState,
  connectorDefinitions: RemoteConnectorDefinition[],
  opts: ValidateConnectorStateOptions = {}
): string[] {
  const defByKey = new Map<string, RemoteConnectorDefinition>(
    connectorDefinitions.map((d) => [d.key, d])
  );
  const authProfilesBySlug = new Map(
    state.connectors.authProfiles.map((p) => [p.slug, p])
  );

  if (opts.requireInstalled) {
    const refs: Array<{ connector: string; ref: string }> = [
      ...state.connectors.authProfiles.map((p) => ({
        connector: p.connector,
        ref: `auth profile "${p.slug}"`,
      })),
      ...state.connectors.connections.map((c) => ({
        connector: c.connector,
        ref: `connection "${c.slug}"`,
      })),
    ];
    for (const { connector, ref } of refs) {
      const def = defByKey.get(connector);
      if (!def || def.installed !== true) {
        throw new ValidationError(
          `connector "${connector}" referenced by ${ref} is not installed in the org — check the \`connector\` key (and, for a local \`*.connector.ts\`, that its \`definition.key\` matches)`
        );
      }
    }
  }

  const schemasFor = (connectorKey: string) => {
    if (opts.skipSchemaForConnectorKeys?.has(connectorKey)) return null;
    const def = defByKey.get(connectorKey);
    return def ? resolveConnectorSchemas(def) : null;
  };
  for (const profile of state.connectors.authProfiles) {
    validateAuthProfileAgainstConnector(profile, schemasFor(profile.connector));
  }
  const warnings: string[] = [];
  for (const connection of state.connectors.connections) {
    const schemas = schemasFor(connection.connector);
    // Mirror the server's connection/feed scope split: demote any feed-scoped
    // key authored on the connection to a per-feed default so the server
    // accepts the connection, instead of failing the create with a generic
    // "Feed-scoped config belongs on feeds" rejection.
    //
    // Only in the pre-diff pass. The post-install pass (requireInstalled) runs
    // AFTER computeDiff has built the create/update rows from `row.desired`, so
    // mutating state here would not reach the plan — it would silently drop the
    // demoted key from the applied feed rows. Locally-declared connectors
    // (schema-skipped pre-diff, validated only post-install) therefore aren't
    // demoted; a feed-scoped key left on such a connection still fails loudly
    // at the server, exactly as before this feature.
    if (!opts.requireInstalled) {
      const demoted = normalizeConnectionConfigScope(connection, schemas);
      if (demoted.length > 0) {
        warnings.push(
          `connection "${connection.slug}": feed-scoped key(s) [${demoted.join(", ")}] were set on the connection — moved to its feed config(s). Declare connector sync settings on the feed, not the connection.`
        );
      }
    }
    validateConnectionAgainstConnector(connection, authProfilesBySlug, schemas);
  }
  return warnings;
}

// Connector keys declared locally (`*.connector.ts` / `type: connector`).
// A `type: connector` doc carries a resolved `key`; a `connectorFromFile()`
// source has `key === null` (the server compiles it) but a best-effort
// `declaredKeyHint` parsed statically from the source. Both belong in the
// schema-skip set: a connection referencing a locally-supplied connector must
// be validated against the FRESHLY-uploaded definition (post-install), not the
// stale server schema — otherwise re-applying a connector whose feed set
// changed rejects the new feeds. The hint only widens this skip set; the
// authoritative key still comes from the server at install time.
export function locallyDeclaredConnectorKeys(state: DesiredState): Set<string> {
  const keys = declaredConnectorKeys(state.connectors.definitions);
  for (const def of state.connectors.definitions) {
    if (def.declaredKeyHint) keys.add(def.declaredKeyHint);
  }
  return keys;
}

/**
 * Active-version pins for every config-relevant connector key, read from a
 * catalog snapshot. Used when the apply didn't (re)install connectors (all-noop
 * plans) and as the fallback layer under a partial failure's install results.
 */
export function connectorVersionPins(
  state: DesiredState,
  catalog: RemoteConnectorDefinition[]
): Record<string, string> {
  const pinKeys = new Set([
    ...locallyDeclaredConnectorKeys(state),
    ...referencedConnectorKeys(state.connectors),
  ]);
  const pins: Record<string, string> = {};
  for (const def of catalog) {
    if (def.installed && def.version && pinKeys.has(def.key)) {
      pins[def.key] = def.version;
    }
  }
  return pins;
}

// ── Apply executor ─────────────────────────────────────────────────────────

interface ApplyContext {
  client: ApplyClient;
  state: DesiredState;
  plan: DiffPlan;
  remote: RemoteSnapshot;
}

/**
 * Push provider API keys into the org's `inference_providers` store — the
 * single org-key store the worker credential resolution reads (post
 * resolver-cutover; the legacy `/agents/<id>/providers/<id>/api-key` route is
 * gone). A key declared per agent in config is an ORG-scoped secret, so keys
 * are deduped by provider — last declaration wins, matching the previous
 * PUT-overwrite semantics — and pushed once each: rotate when the org
 * provider row exists, create the row otherwise (slug doubles as kind;
 * per-agent provider ids are catalog kinds). Idempotent either way. Walks all
 * desired agents (not just those with a settings diff) — the secret value
 * isn't part of the settings JSON, so a key can need pushing even when every
 * resource is noop (e.g. a key-only `.env` change/rotation).
 */
export async function pushProviderApiKeys(
  client: ApplyClient,
  agents: DesiredState["agents"]
): Promise<void> {
  const keys = new Map<string, string>();
  for (const desired of agents) {
    for (const { providerId, value } of desired.providerKeys) {
      keys.set(providerId, value);
    }
  }
  for (const [providerId, value] of keys) {
    try {
      await client.rotateInferenceProviderKey(providerId, value);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
      await client.createInferenceProvider({
        slug: providerId,
        kind: providerId,
        apiKey: value,
      });
    }
    printText(chalk.dim(`  ↻ provider-key ${providerId}`));
  }
}

export async function executePlan(
  ctx: ApplyContext,
  pendingAuth: PendingAuthEntry[]
): Promise<{ connectorVersions: Record<string, string> }> {
  const rowsByKind = <K extends DiffRow["kind"]>(kind: K) =>
    ctx.plan.rows.filter(
      (
        row
      ): row is Extract<DiffRow, { kind: K }> & {
        verb: "create" | "update" | "delete";
      } => row.kind === kind && row.verb !== "noop" && row.verb !== "drift"
    );

  let connectorVersions: Record<string, string> = {};

  // 0) Entity types first: relationship-type rules may reference types created
  //    by this same desired apply.
  for (const row of rowsByKind("entity-type")) {
    if (row.kind !== "entity-type") continue;
    if (!row.desired) continue;
    // The upsert rebuilds `metadata_schema` from the config's flat properties/
    // required, so hand it the live type's out-of-band top-level keys (e.g.
    // `x-lobu-resolution`) to carry forward — otherwise every apply erases them
    // silently, with no diff row and no warning. `row.remote` is the match
    // computeDiff already made against the ORG-OWNED types only; re-deriving it
    // from the raw snapshot would let a foreign public type of the same slug
    // shadow the owned one (see the ownership filter in computeDiff).
    // Three-way attribution reports per-key property clears as
    // `properties.<key>`. upsertEntityType only honors a whole-facet
    // `properties` clearFacet (when the config omits the object entirely under
    // prune). When the config still declares a properties object, the declared
    // keys win via full schema rebuild and no clearFacet is needed.
    const clearFacets = new Set(row.changedFields ?? []);
    if (
      row.desired.properties === undefined &&
      [...clearFacets].some((f) => f.startsWith("properties."))
    ) {
      clearFacets.add("properties");
    }
    await ctx.client.upsertEntityType(
      row.desired,
      row.remote?.schemaExtras,
      {
        properties: row.remote?.properties,
        required: row.remote?.required,
      },
      clearFacets,
      // Outside prune, keep UI-added property keys when rebuilding the schema.
      !(ctx.state.prune ?? false)
    );
    // View template is a separate, version-appending tool. Reconcile it only on
    // create (when declared) or a flagged change — never every run, so the
    // version history doesn't churn. Declared ⇒ set; omitted-under-prune ⇒ clear.
    const tpl = row.desired.viewTemplate;
    const templateChanged =
      row.verb === "create"
        ? tpl !== undefined
        : (row.changedFields?.includes("viewTemplate") ?? false);
    if (templateChanged) {
      if (tpl !== undefined) {
        await ctx.client.setEntityTypeViewTemplate(row.desired.slug, tpl);
      } else {
        await ctx.client.clearEntityTypeViewTemplate(row.desired.slug);
      }
    }
    printText(renderProgress(row.verb, "entity-type", row.id));
  }

  // 1) Relationship types before connector definitions: server preflight
  //    resolves connector-declared relationship slugs against the active org
  //    schema, so a type created by this same apply must already exist.
  for (const row of rowsByKind("relationship-type")) {
    if (row.kind !== "relationship-type") continue;
    if (!row.desired) continue;
    await ctx.client.upsertRelationshipType(row.desired);
    printText(renderProgress(row.verb, "relationship-type", row.id));
  }

  // 2) Connector definitions — install/update them, refetch the catalog, then
  //    re-validate connection/feed config against the now-current schemas.
  if (hasDesiredConnectors(ctx.state)) {
    const installed = await installConnectorDefinitions(
      ctx.client,
      ctx.state,
      ctx.remote.connectorDefinitions,
      ctx.plan
    );
    const freshCatalog = installed.catalog;
    connectorVersions = installed.connectorVersions;
    for (const warning of validateConnectorState(ctx.state, freshCatalog, {
      requireInstalled: true,
    })) {
      printText(chalk.yellow(`Warning: ${warning}`));
    }
  }

  // 3) Agents
  for (const row of rowsByKind("agent")) {
    if (row.kind !== "agent") continue;
    if (!row.desired) continue;
    const desired = ctx.state.agents.find((a) => a.metadata.agentId === row.id);
    if (!desired) continue;
    if (row.verb === "create") {
      await ctx.client.upsertAgent(desired.metadata);
    } else {
      await ctx.client.patchAgentMetadata(row.id, {
        name: desired.metadata.name,
        description: desired.metadata.description,
      });
    }
    printText(renderProgress(row.verb, "agent", row.id));
  }

  // 4) Settings
  for (const row of rowsByKind("settings")) {
    if (row.kind !== "settings") continue;
    const desired = ctx.state.agents.find((a) => a.metadata.agentId === row.id);
    if (!desired) continue;
    await ctx.client.patchAgentSettings(row.id, desired.settings);
    printText(
      renderProgress(
        row.verb,
        "settings",
        row.id,
        row.changedFields ? `(${row.changedFields.join(", ")})` : undefined
      )
    );
  }

  // Automations are applied after connections so declarative connection slugs
  // can resolve to the integer ids required by the API.
  const applyAutomations = async (
    connectionIdBySlug: ReadonlyMap<string, number>
  ): Promise<void> => {
    if (rowsByKind("automation").length === 0) return;
    resolveAutomationConnectionRefs(
      ctx.state.automations,
      connectionIdBySlug,
      true
    );

    // 6) Automations — create (full payload + reaction script) or update (scalar
    //    row fields via `update`, version-bound fields via `create_version`,
    //    reaction script via `set_reaction_script`). Drift detection lives in
    //    `diffAutomation`; this loop just routes to the right admin action.
    const remoteAutomationBySlug = new Map(
      ctx.remote.automations.map((w) => [w.slug, w])
    );
    for (const row of rowsByKind("automation")) {
      if (row.kind !== "automation") continue;
      if (!row.desired) continue;
      const w = row.desired;
      let automationId: string | undefined;
      if (row.verb === "create") {
        const created = await ctx.client.createAutomation({
          slug: w.slug,
          agentId: w.agent,
          name: w.name,
          description: w.description,
          prompt: w.prompt,
          ...(w.skillSnapshots?.length ? { skills: w.skillSnapshots } : {}),
          ...(w.reactionScript
            ? { reaction_script: w.reactionScript.sourceCode }
            : {}),
          triggers: w.triggers,
          sources: w.sources,
          reactions_guidance: w.reactionsGuidance,
          device_worker_id: w.deviceWorkerId,
          min_cooldown_seconds: w.minCooldownSeconds,
          tags: w.tags,
          agent_kind: w.agentKind,
          execution_config:
            w.model !== undefined
              ? automationExecutionConfig(w.model)
              : undefined,
          outputs: w.outputs,
          classifiers: w.classifiers,
        });
        automationId = created.automation_id;
      } else if (row.verb === "update") {
        const remote = remoteAutomationBySlug.get(w.slug);
        automationId = remote?.automation_id;
        if (!automationId) {
          throw new ApiError(
            `update automation "${w.slug}" failed: remote row is missing automation_id (refetch may be stale)`
          );
        }
        const versionBound = new Set(row.versionBoundFields ?? []);
        const changed = new Set(row.changedFields ?? []);
        const scalarChanges = [...changed].filter(
          (f) => !versionBound.has(f) && f !== "reaction_script"
        );
        // When triggers and any version-bound field change, send them together
        // through create_version so the server validates the final state
        // atomically. Splitting the writes can reject a valid transition, such
        // as clearing outputs while changing window execution to turn.
        const triggersWithVersionChange =
          scalarChanges.includes("triggers") && versionBound.size > 0;
        const scalarForUpdate = triggersWithVersionChange
          ? scalarChanges.filter((f) => f !== "triggers")
          : scalarChanges;
        // a) Reaction script — attach BEFORE scalar updates and version writes.
        //    The server's instruction rule validates trigger/prompt/skills
        //    against the group's CURRENT reaction, so a reaction-only transition
        //    (no prompt/skills) must install the reaction before the trigger
        //    update reaches the server. Push first (idempotent, no drift signal
        //    because it's not returned by Automation lists) so the rule sees it.
        //    Reaction removal is never pushed — apply only ever sets scripts.
        if (w.reactionScript) {
          await ctx.client.setReactionScript(
            automationId,
            w.reactionScript.sourceCode
          );
        }
        // b) Scalar fields → manage_automations update
        if (scalarForUpdate.length > 0) {
          await ctx.client.updateAutomation({
            automation_id: automationId,
            ...(scalarForUpdate.includes("triggers")
              ? { triggers: w.triggers ?? [] }
              : {}),
            ...(scalarForUpdate.includes("managed_agent_id")
              ? { managed_agent_id: w.agent }
              : {}),
            ...(scalarForUpdate.includes("device_worker_id")
              ? { device_worker_id: w.deviceWorkerId ?? null }
              : {}),
            ...(scalarForUpdate.includes("min_cooldown_seconds") &&
            w.minCooldownSeconds !== undefined
              ? { min_cooldown_seconds: w.minCooldownSeconds }
              : {}),
            ...(scalarForUpdate.includes("tags") && w.tags
              ? { tags: w.tags }
              : {}),
            ...(scalarForUpdate.includes("agent_kind")
              ? { agent_kind: w.agentKind ?? null }
              : {}),
            ...(scalarForUpdate.includes("execution_config")
              ? {
                  execution_config: automationExecutionConfig(
                    w.model,
                    remote?.execution_config
                  ),
                }
              : {}),
          });
        }
        // c) Version-bound fields → manage_automations create_version (server
        //    inherits unset fields from the previous version row, but we always
        //    send the desired-side values for the changed keys). name/description
        //    are version-owned (update rejects them).
        if (row.versionBoundFields && row.versionBoundFields.length > 0) {
          await ctx.client.createAutomationVersion({
            automation_id: automationId,
            ...(versionBound.has("name") && w.name !== undefined
              ? { name: w.name }
              : {}),
            ...(versionBound.has("description")
              ? { description: w.description ?? null }
              : {}),
            ...(versionBound.has("prompt") ? { prompt: w.prompt } : {}),
            ...(versionBound.has("skills")
              ? { skills: w.skillSnapshots ?? [] }
              : {}),
            ...(versionBound.has("sources") && w.sources !== undefined
              ? { sources: w.sources }
              : {}),
            ...(versionBound.has("reactions_guidance") &&
            w.reactionsGuidance !== undefined
              ? { reactions_guidance: w.reactionsGuidance }
              : {}),
            ...(versionBound.has("outputs")
              ? { outputs: w.outputs ?? null }
              : {}),
            ...(versionBound.has("classifiers") && w.classifiers !== undefined
              ? { classifiers: w.classifiers }
              : {}),
            ...(triggersWithVersionChange
              ? { triggers: w.triggers ?? [] }
              : {}),
          });
        }
      }
      printText(
        renderProgress(
          row.verb,
          "automation",
          row.id,
          row.changedFields ? `(${row.changedFields.join(", ")})` : undefined
        )
      );
    }
  };

  // Auth profiles (create / update; interactive kinds → punch-list)
  for (const row of rowsByKind("auth-profile")) {
    if (row.kind !== "auth-profile") continue;
    const desired = ctx.state.connectors.authProfiles.find(
      (p) => p.slug === row.id
    );
    if (!desired) continue;
    const result =
      row.verb === "create"
        ? await ctx.client.createAuthProfile({
            slug: desired.slug,
            connector: desired.connector,
            kind: desired.kind,
            name: desired.name,
            credentials: desired.credentials,
          })
        : await ctx.client.updateAuthProfile({
            slug: desired.slug,
            name: desired.name,
            credentials: desired.credentials,
          });
    if (
      (desired.kind === "oauth_account" ||
        desired.kind === "browser_session") &&
      result.status !== "active"
    ) {
      pendingAuth.push({
        slug: desired.slug,
        kind: desired.kind,
        ...(result.connectUrl ? { connectUrl: result.connectUrl } : {}),
      });
    }
    printText(renderProgress(row.verb, "auth-profile", row.id));
  }

  // 9) Connections, keyed by slug.
  const remoteConnBySlug = new Map(
    ctx.remote.connections.map((c) => [c.slug, c])
  );
  const connectionIdBySlug = new Map<string, number>(
    ctx.remote.connections.map((c) => [c.slug, c.id])
  );
  for (const row of rowsByKind("connection")) {
    if (row.kind !== "connection") continue;
    const desired = ctx.state.connectors.connections.find(
      (c) => c.slug === row.id
    );
    if (!desired) continue;
    const existing = remoteConnBySlug.get(desired.slug);
    if (desired.credentialMode === "byo") {
      // BYO chat connection: apply through the secret-aware chat-upsert path so
      // the server persists a non-null `credential_mode` (the gateway needs it
      // to treat the row as chat) and resolves the token. Idempotent — an
      // unchanged declaration is a server-side no-op. No feeds/device pinning.
      // Capture the returned id so Automations referencing this connection in the
      // same apply resolve it (on a first create, `existing` is unset).
      const result = await ctx.client.applyChatConnection({
        slug: desired.slug,
        connector: desired.connector,
        name: desired.name,
        config: desired.config ?? {},
      });
      connectionIdBySlug.set(desired.slug, result.id);
    } else if (existing && row.verb === "update") {
      // Send only what the diff actually flagged, exactly as the Automation
      // update above does. The diff is then the single source of truth for what
      // an apply writes: a field this config does not declare produces no
      // changed-field, so it is never in the payload and the server leaves it
      // alone. Re-listing every field here was the second place to get
      // "undeclared" wrong, and it got it wrong for `config` (replaced UI-set
      // connection settings with `{}`) and, on feeds below, for `schedule`.
      const updated = await ctx.client.updateConnection(
        existing.id,
        buildUpdatePayload(
          UPDATE_FIELD_TABLES.connection,
          row.changedFields,
          desired
        )
      );
      connectionIdBySlug.set(desired.slug, updated.id);
    } else {
      const created = await ctx.client.createConnection({
        slug: desired.slug,
        connector: desired.connector,
        name: desired.name,
        authProfileSlug: desired.authProfileSlug,
        appAuthProfileSlug: desired.appAuthProfileSlug,
        config: desired.config,
        ...(desired.deviceWorkerId
          ? { deviceWorkerId: desired.deviceWorkerId }
          : {}),
      });
      connectionIdBySlug.set(desired.slug, created.id);
    }
    printText(renderProgress(row.verb, "connection", row.id));
  }

  await applyAutomations(connectionIdBySlug);

  // 10) Feeds (per connection — covers feeds whose connection itself was a noop)
  for (const row of rowsByKind("feed")) {
    if (row.kind !== "feed") continue;
    if (!row.desired) continue;
    const feed = row.desired;
    const connectionId = connectionIdBySlug.get(row.connectionSlug);
    if (connectionId === undefined) {
      throw new ApiError(
        `feed "${feed.feedKey}" references connection "${row.connectionSlug}" which has no remote ID — connection create may have failed`
      );
    }
    const existingConn = remoteConnBySlug.get(row.connectionSlug);
    const remoteFeed = existingConn
      ? (ctx.remote.feedsByConnectionId.get(existingConn.id) ?? []).find(
          (f) => f.feed_key === feed.feedKey
        )
      : undefined;
    if (remoteFeed && row.verb === "update") {
      // Same rule as connections and Automations: the diff decides what gets
      // written. An undeclared cadence or config produces no changed-field, so
      // it never reaches the wire and the server keeps what the feed has. An
      // explicit `schedule: null` IS a declared change and still clears it.
      await ctx.client.updateFeed(
        remoteFeed.id,
        buildUpdatePayload(UPDATE_FIELD_TABLES.feed, row.changedFields, feed)
      );
    } else {
      await ctx.client.createFeed({
        connectionId,
        feedKey: feed.feedKey,
        name: feed.name,
        // A brand-new feed has no cadence to preserve, so undeclared and
        // explicit-null both mean manual-only here. The platform still never
        // invents a default cron.
        schedule: feed.schedule ?? null,
        config: feed.config,
      });
    }
    printText(renderProgress(row.verb, "feed", row.id));
  }

  // 10b) Org-owned inference providers. Create the row if new, then reconcile
  //      each declared capability modality (idempotent PUT) and — because the
  //      API key is write-only and can't be diffed — re-push a declared key on
  //      every apply (a matching value is a server-side no-op). Drift rows
  //      (remote providers absent from the config) are never auto-deleted:
  //      dropping an org credential is destructive, so it's UI/API-only.
  for (const row of rowsByKind("inference-provider")) {
    if (row.kind !== "inference-provider") continue;
    const provider = row.desired;
    if (!provider) continue;

    if (row.verb === "create") {
      await ctx.client.createInferenceProvider({
        slug: provider.slug,
        kind: provider.kind,
        ...(provider.displayName ? { displayName: provider.displayName } : {}),
        apiKey: provider.apiKey,
        capabilities: provider.capabilities,
      });
      // Create already persisted the key + capabilities; nothing else to push.
      printText(renderProgress(row.verb, "inference-provider", row.id));
      continue;
    }

    // Update: push only the modalities that changed, then rotate the key.
    for (const modality of row.capabilityModalities ?? []) {
      await ctx.client.updateInferenceProviderCapabilities(
        provider.slug,
        modality,
        provider.capabilities[modality] ?? {}
      );
    }
    if (row.keyDeclared) {
      await ctx.client.rotateInferenceProviderKey(
        provider.slug,
        provider.apiKey
      );
    }
    printText(renderProgress(row.verb, "inference-provider", row.id));
  }

  // 11) Prune — delete definitions absent from a pruning config. Runs
  //     LAST and in reverse-dependency order so a rel-type that references an
  //     entity type is gone before the entity type. Connections + data
  //     instances are never in the delete set (computeDiff only emits delete
  //     rows for definitions). The server refuses an entity-type delete while
  //     instances exist, so the data stays safe.
  await deleteRemovedDefinitions(ctx);

  return { connectorVersions };
}

/**
 * Execute the plan's `delete` rows (prune). Steps run in
 * reverse-dependency order — a rel-type rule references entity types, so
 * rel-types delete before entity types; connectors uninstall last. Halts apply
 * on first failure (idempotent re-run).
 */
async function deleteRemovedDefinitions(ctx: ApplyContext): Promise<void> {
  const deletes = ctx.plan.rows.filter((r) => r.verb === "delete");
  if (deletes.length === 0) return;
  const automationIdBySlug = new Map(
    ctx.remote.automations.map((w) => [w.slug, w.automation_id])
  );
  const steps: Array<[DiffRow["kind"], (id: string) => Promise<void>]> = [
    [
      "automation",
      async (id) => {
        const wid = automationIdBySlug.get(id);
        if (!wid) {
          throw new ApiError(
            `delete automation "${id}": remote automation_id missing`
          );
        }
        await ctx.client.deleteAutomation(wid);
      },
    ],
    ["relationship-type", (id) => ctx.client.deleteRelationshipType(id)],
    ["entity-type", (id) => ctx.client.deleteEntityType(id)],
    ["connector-definition", (id) => ctx.client.uninstallConnector(id)],
  ];
  for (const [kind, run] of steps) {
    for (const row of deletes) {
      if (row.kind !== kind) continue;
      await run(row.id);
      printText(renderProgress("delete", kind, row.id));
    }
  }
}

// Collect pending interactive-auth profiles from a (no-op) plan and re-issue a
// fresh connect URL — used both when "nothing to apply" and on partial failure.
async function collectPendingAuthFromPlan(
  client: ApplyClient,
  plan: DiffPlan,
  already: PendingAuthEntry[]
): Promise<PendingAuthEntry[]> {
  const out = [...already];
  for (const row of plan.rows) {
    if (row.kind !== "auth-profile" || !("needsAuth" in row) || !row.needsAuth)
      continue;
    if (!row.desired) continue;
    const desired = row.desired;
    if (out.some((p) => p.slug === desired.slug)) continue;
    if (desired.kind === "oauth_account") {
      // A successful reconnect implies the profile exists remotely (and yields
      // a fresh connect URL). If it fails, the profile may not exist (a failed
      // create in a partial apply) — don't tell the operator to go finish auth
      // for something that isn't there; just skip it.
      const connectUrl = await client
        .reconnectAuthProfile(desired.slug)
        .catch(() => undefined);
      if (!connectUrl) continue;
      out.push({ slug: desired.slug, kind: desired.kind, connectUrl });
      continue;
    }
    // browser_session (no reconnect endpoint): include only if the profile row
    // actually exists remotely.
    const exists = await client
      .getAuthProfileBySlug(desired.slug)
      .catch(() => null);
    if (!exists) continue;
    out.push({ slug: desired.slug, kind: desired.kind });
  }
  return out;
}

// ── Top-level command ──────────────────────────────────────────────────────

/** "office-bot" → "Office Bot" — default display name for a bootstrapped org. */
function slugToTitle(slug: string): string {
  return (
    slug
      .split(/[-_]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") || slug
  );
}

/**
 * Best-effort deployment record. The apply's outcome is already decided when
 * this runs, so a failed post (older server, network blip) is a warning —
 * never a second failure. The server dedupes on apply_id.
 */
async function postDeploymentSummarySafe(
  client: ApplyClient,
  summary: DeploymentSummary
): Promise<void> {
  try {
    await client.postDeploymentSummary(summary);
  } catch (err) {
    printText(
      chalk.yellow(
        `Warning: could not record the deployment (${err instanceof Error ? err.message : String(err)}). The apply itself was unaffected.`
      )
    );
  }
}

export async function applyCommand(opts: ApplyOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Auto-load `.env` from the project dir so secret()/$VAR refs in
  // lobu.config.ts resolve without the user having to `set -a; source .env`.
  // Mirrors `lobu dev`. Existing process.env values win (don't clobber shell).
  await loadProjectEnvFile(cwd);

  // Load desired state from the TypeScript entrypoint (lobu.config.ts).
  const loadArgs = { cwd, ...(opts.only ? { only: opts.only } : {}) };
  const { state, configPath, warnings } =
    await loadDesiredStateFromConfig(loadArgs);

  printText(chalk.dim(`Config: ${configPath}`));
  for (const warning of warnings) {
    printText(chalk.yellow(`Warning: ${warning}`));
  }

  // Required secrets gate: fail before any network mutation.
  const { missing } = checkRequiredSecrets(state);
  if (missing.length > 0) {
    printError(renderMissingSecrets(missing));
    throw new ValidationError(
      `${missing.length} required secret${missing.length === 1 ? "" : "s"} missing — see above.`
    );
  }

  // Org slug resolution: explicit --org ▸ active-session org ▸ `org` from
  // defineConfig. The config slug is the declarative default — if no org with
  // that slug exists yet, `lobu apply` offers to provision it (below).
  // One deployment identity per run: sent as `x-lobu-apply-id` on every
  // mutation so the server groups this run's config-audit events; the summary
  // posted at the end closes the deployment record.
  const applyId = mintApplyId();
  const { client, orgSlug, apiBaseUrl } = await resolveApplyClient({
    url: opts.url,
    org: opts.org ?? state.memory?.org,
    applyId,
    fetchImpl: opts.fetchImpl,
  });
  printText(chalk.dim(`Org: ${orgSlug}`));

  // Promotions-pause gate: a `lobu rollback` pauses applies for the org so a
  // CI run can't silently re-promote the config that was just rolled back.
  // `--resume` is the explicit acknowledgment that the config repo has been
  // reconciled (or the newer state is wanted after all). Tolerate a failing
  // pause endpoint (older server) — the gate is a workflow guard.
  const pause = await client.getDeploymentPause().catch(() => null);
  if (pause?.paused && !opts.dryRun) {
    if (!opts.resume) {
      printError(
        [
          "",
          `Deployments are paused for "${orgSlug}" — a rollback restored deployment ${pause.rollbackOf ?? "?"}${pause.pausedAt ? ` on ${pause.pausedAt}` : ""}.`,
          "Applying now would re-promote the config that was just rolled back.",
          "",
          "  Reconcile your config repo (e.g. `git revert` the bad change), then:",
          "    lobu apply --resume",
        ].join("\n")
      );
      throw new ValidationError(
        "deployments paused by rollback — pass --resume to proceed"
      );
    }
    await client.clearDeploymentPause();
    printText(chalk.yellow("Resumed deployments (pause cleared)."));
  }

  // Refuse if .lobu/project.json points at a different (context, org).
  const link = await loadProjectLink(cwd);
  if (link && !opts.force) {
    const activeContext = await resolveContext().catch(() => null);
    const contextMismatch =
      activeContext !== null && activeContext.name !== link.context;
    const orgMismatch = orgSlug !== link.org;
    if (contextMismatch || orgMismatch) {
      const detail: string[] = [];
      if (contextMismatch) {
        detail.push(
          `  context: linked=${link.context}, active=${activeContext.name}`
        );
      }
      if (orgMismatch) {
        detail.push(`  org:     linked=${link.org}, applying=${orgSlug}`);
      }
      printError(
        [
          "",
          "Project link mismatch — refusing to apply.",
          ...detail,
          "",
          "Run `lobu link --org <slug>` to update the link, or pass `--force` to override.",
        ].join("\n")
      );
      throw new ValidationError("project-link mismatch");
    }
  }

  // Check the resolved org exists / the operator is a member. `lobu apply`
  // can't create an org headlessly — that needs a logged-in browser session —
  // so a missing org stops here with a link to create it. `listOrgs()` failing
  // (old server, or a token the userinfo endpoint rejects) → null → skip the
  // check and let the normal flow surface any org error.
  const myOrgs = await client.listOrgs().catch(() => null);
  // Resolve strictly by the slug we will actually mutate (the client targets
  // `orgSlug` in every URL). Do NOT fall back to organizationId as an alternate
  // org — that could prune a different org than the one being applied.
  const resolvedOrg = myOrgs?.find((o) => o.slug === orgSlug);
  // If the config pins `organizationId`, the slug must resolve to that exact
  // org — otherwise it's a stale/copied config pointed at someone else's org,
  // and (with prune on) could prune the wrong org. Hard-stop.
  if (
    resolvedOrg &&
    state.memory?.organizationId &&
    resolvedOrg.id !== state.memory.organizationId
  ) {
    printError(
      [
        "",
        `Org slug "${orgSlug}" resolves to org id ${resolvedOrg.id}, but lobu.config.ts pins organizationId ${state.memory.organizationId}.`,
        "This usually means the config was copied from another project or the slug was reused.",
        "Fix `org`/`organizationId` in defineConfig (or pass the right --org) before applying.",
      ].join("\n")
    );
    throw new ValidationError(
      `org "${orgSlug}" (id ${resolvedOrg.id}) does not match pinned organizationId ${state.memory.organizationId}`
    );
  }
  if (myOrgs !== null && !resolvedOrg) {
    const orgName = state.memory?.name ?? slugToTitle(orgSlug);
    const createUrl = `${apiBaseUrl}/orgs/new?slug=${encodeURIComponent(orgSlug)}&name=${encodeURIComponent(orgName)}`;
    printError(
      [
        "",
        `Organization "${orgSlug}" not found, or you're not a member.`,
        "",
        `  Create it:  ${createUrl}`,
        `  (or:        \`lobu org create ${orgSlug}\`)`,
        "",
        "then re-run `lobu apply`. (Or target an existing org with `--org <slug>`.)",
      ].join("\n")
    );
    throw new ValidationError(`organization "${orgSlug}" not found`);
  }

  // Prune is config-declared (`defineConfig({ prune: true })`): when on, apply
  // deletes previously-applied definitions that this config removed AND that
  // are unchanged since the last succeeded apply. UI-created / unowned
  // definitions never auto-delete — they block as drift. Data, connections,
  // auth profiles, and agents are never pruned. The blast-radius confirm
  // below is the safety net for large owned-delete sets.
  const prune = state.prune;
  if (prune) {
    printText(
      chalk.yellow(
        "Prune is on: apply will DELETE previously-applied definitions removed from this config (and unchanged since last apply). UI-created definitions block instead of deleting."
      )
    );
  }

  // Team org consistency comes from `defineConfig({ org, organizationId })` in
  // lobu.config.ts (committed) plus the `.lobu/project.json` link — apply does
  // not rewrite the config file.

  // SECURITY (#4): confirm BEFORE fetching any `source_url` or uploading custom
  // connector source — `lobu apply --dry-run` should never hit a manifest URL.
  if (!opts.dryRun) {
    await confirmCustomConnectorSource(
      state.connectors.definitions,
      opts.yes ?? false
    );
    await materializeConnectorSource(state.connectors.definitions, fetchImpl);
  }

  // Snapshot remote state. Connector-def rows in the plan are computed against
  // this (current/stale) catalog — "create" when the key isn't installed,
  // "update" when it is. Connector defs are NOT installed here; that happens in
  // `executePlan`, AFTER plan confirmation.
  const remote = await fetchRemoteSnapshot(
    client,
    state,
    opts.only,
    prune,
    resolvedOrg?.id
  );
  if (!opts.only && !(await isManagedCloudTarget(apiBaseUrl))) {
    remote.connectorDefinitions = await hydrateManagedConnectorCatalog(
      state,
      remote.connectorDefinitions,
      (managedOrg) => loadManagedCloudConnectorCatalog(managedOrg, fetchImpl)
    );
  }
  resolveAutomationConnectionRefs(
    state.automations,
    new Map(
      remote.connections.map((connection) => [connection.slug, connection.id])
    ),
    false
  );

  // Validate connection/auth-profile config against the catalog we have now,
  // but SKIP schema validation for connector keys declared locally — those
  // might update an already-installed schema in this same apply, so they're
  // schema-validated later (post-install, against the fresh catalog) inside
  // `executePlan`. Structural checks (auth-slug existence, connector match)
  // still run here for every connection.
  for (const warning of validateConnectorState(
    state,
    remote.connectorDefinitions,
    {
      skipSchemaForConnectorKeys: locallyDeclaredConnectorKeys(state),
    }
  )) {
    printText(chalk.yellow(`Warning: ${warning}`));
  }

  // Attribution baseline — the latest succeeded deployment's effective-remote
  // snapshot + owned identities. A legacy/missing manifest remains explicitly
  // unrecorded: declared definitions use two-way convergence, while prune
  // candidates that need ownership proof block instead of being deleted.
  // Fail closed on transport/server errors: /deployments/latest returns
  // deployment:null when none exists, so a thrown error is a real failure —
  // never treat it as "no baseline" and discard known ownership.
  const latestDeployment = await client.getLatestDeployment();
  const baselineRecord =
    latestDeployment?.manifest === null ||
    latestDeployment?.manifest === undefined
      ? null
      : loadBaselineFromManifest(latestDeployment.manifest);
  /**
   * The baseline this run should RECORD, from a given remote snapshot. A
   * `--only` run executes one family, so the families it never touched must be
   * carried forward, never rebuilt from an unexecuted snapshot:
   *   - `--only agents` touches neither memory nor connectors → carry the prior
   *     baseline verbatim, leaving it absent when none was recorded;
   *   - `--only memory` rebuilds memory but carries prior connector ownership.
   */
  const recordableBaseline = (
    snapshot: RemoteSnapshot
  ): BaselineRecord | undefined => {
    if (opts.only === "agents") {
      return baselineRecord ?? undefined;
    }
    const built = buildAttributionAndOwned(
      state,
      snapshot,
      resolvedOrg?.id,
      prune
    );
    if (opts.only === "memory" && baselineRecord) {
      built.owned = [
        ...built.owned,
        ...baselineRecord.owned.filter((k) =>
          k.startsWith("connector-definition:")
        ),
      ];
    }
    return built;
  };
  // Pre-apply snapshot first (noop path / partial failure). A fully-succeeded
  // run that created resources re-records from a post-apply snapshot below, so
  // newly allocated incarnation ids enter `owned` (otherwise the next prune
  // cannot config-expressed-delete them).
  let baselineRecordForRecording = recordableBaseline(remote);
  const baseline = toBaseline(baselineRecord);

  const plan = computeDiff(state, remote, {
    only: opts.only,
    prune,
    baseline,
    ...(resolvedOrg?.id ? { orgId: resolvedOrg.id } : {}),
  });
  printText(renderPlan(plan));

  // Drift gate: any blocking drift (remote-moved field or remote-only
  // definition the config doesn't own) halts the whole apply — `--yes` never
  // destroys un-declared state. The report names each item; resolution is
  // adopt (fold into config) or a manual delete.
  const blockingDrift = plan.rows.filter(
    (r): r is Extract<DiffRow, { blocking: true }> =>
      r.verb === "drift" && "blocking" in r && r.blocking === true
  );
  if (blockingDrift.length > 0) {
    printText(renderBlockedReport(blockingDrift));
    if (opts.dryRun) {
      printText(
        chalk.dim("\nDry run — apply would exit 1 here. Nothing was changed.")
      );
      return;
    }
    const gitInfo = collectGitInfo(cwd);
    await postDeploymentSummarySafe(client, {
      apply_id: applyId,
      status: "blocked",
      counts: plan.counts,
      counts_by_kind: buildCountsByKind(plan.rows),
      manifest_hash: computeManifestHash(state),
      git_sha: gitInfo.sha,
      git_dirty: gitInfo.dirty,
      cli_version: opts.cliVersion ?? null,
      manifest: buildDeploymentManifest(
        state,
        connectorVersionPins(state, remote.connectorDefinitions)
      ),
      candidates: {
        items: blockingDrift.map((b) => {
          // Field-level Automation drift is a revert of the remote edit; a
          // whole remote-only definition is a named delete (UI-created /
          // unowned).
          const action = b.field ? ("revert" as const) : ("delete" as const);
          return {
            kind: b.kind,
            slug: b.id,
            ...(b.field ? { field: b.field } : {}),
            action,
          };
        }),
      },
    });
    throw new ValidationError(
      `blocked by ${blockingDrift.length} drift item${blockingDrift.length === 1 ? "" : "s"} — adopt them into lobu.config.ts or delete them manually, then re-run`
    );
  }

  if (opts.dryRun) {
    printText(
      chalk.dim(
        "\nDry run — no changes applied. (Connector-definition install + post-install schema validation are skipped in dry-run.)"
      )
    );
    return;
  }

  const hasPendingAuth = plan.rows.some(
    (r) => r.kind === "auth-profile" && "needsAuth" in r && r.needsAuth
  );

  // Provider API keys live outside the resource diff (the secret value isn't
  // serialized into any plan row), so a key-only `.env` change produces an
  // all-noop plan. Detect declared keys so the apply isn't short-circuited and
  // the keys aren't silently dropped.
  const hasProviderKeys = state.agents.some((a) => a.providerKeys.length > 0);

  if (
    plan.counts.create === 0 &&
    plan.counts.update === 0 &&
    plan.counts.delete === 0 &&
    !hasPendingAuth
  ) {
    // Provider keys live outside the resource diff (idempotent PUT) — push
    // them on a key-only `.env` change.
    if (hasProviderKeys) {
      printText(chalk.bold("\nApplying provider keys:"));
      await pushProviderApiKeys(client, state.agents);
    }
    // Record every executed family even on an all-noop run. A first
    // `--only agents` run leaves the unexecuted memory baseline absent.
    const gitInfo = collectGitInfo(cwd);
    await postDeploymentSummarySafe(client, {
      apply_id: applyId,
      status: "succeeded",
      counts: plan.counts,
      counts_by_kind: {
        ...buildCountsByKind(plan.rows),
        ...(hasProviderKeys
          ? {
              "provider-key": {
                update: state.agents.reduce(
                  (n, a) => n + a.providerKeys.length,
                  0
                ),
              },
            }
          : {}),
      },
      manifest_hash: computeManifestHash(state),
      git_sha: gitInfo.sha,
      git_dirty: gitInfo.dirty,
      cli_version: opts.cliVersion ?? null,
      manifest: buildDeploymentManifest(
        state,
        // Scoped applies never touch connectors — carry prior pins so a later
        // prune still sees the version fingerprint for post-baseline edits.
        opts.only
          ? (baselineRecord?.connectorVersions ?? {})
          : connectorVersionPins(state, remote.connectorDefinitions),
        baselineRecordForRecording
      ),
    });
    printText(chalk.green("\nNothing to apply."));
    return;
  }

  const { create, update, noop, drift, delete: del } = plan.counts;
  const deletePart = del > 0 ? `, ${del} delete` : "";
  const summaryLine = `${create} create, ${update} update, ${noop} noop, ${drift} drift${deletePart}${hasPendingAuth ? " + pending auth" : ""}`;
  const approved = await confirmPlan({
    yes: opts.yes ?? false,
    summaryLine,
  });
  if (!approved) {
    printText(chalk.dim("\nCancelled."));
    return;
  }

  // Blast-radius gate: a large prune gets a second explicit confirm beyond the
  // plan approval above.
  if (del > BLAST_RADIUS_DELETE_THRESHOLD) {
    const okToDelete = await confirmDeletions(del, opts.yes ?? false);
    if (!okToDelete) {
      printText(chalk.dim("\nCancelled."));
      return;
    }
  }

  const hasResourceWork =
    plan.counts.create > 0 || plan.counts.update > 0 || plan.counts.delete > 0;

  const pendingAuth: PendingAuthEntry[] = [];
  let applyErr: unknown;
  let connectorVersions: Record<string, string> = {};
  try {
    // Resources first, then provider keys. Keys are org-scoped
    // (inference_providers rows), so there is no agent-existence ordering
    // constraint anymore — the order is kept for stable output only.
    if (hasResourceWork) {
      printText(chalk.bold("\nApplying:"));
      const executed = await executePlan(
        { client, state, plan, remote },
        pendingAuth
      );
      connectorVersions = executed.connectorVersions;
    }
    // Provider keys live outside the resource diff (idempotent PUT), so push
    // them on any confirmed apply (including a pending-auth-only plan). Done
    // here, not inside executePlan, so the all-noop short-circuit above can push
    // them too without double-pushing.
    if (hasProviderKeys) {
      printText(chalk.bold("\nApplying provider keys:"));
      await pushProviderApiKeys(client, state.agents);
    }
    if (hasResourceWork) {
      printText(chalk.green("\nApply complete."));
    }
  } catch (err) {
    applyErr = err;
    printError(`\n${err instanceof Error ? err.message : String(err)}`);
    printError(
      "Apply halted on first failure. Re-run `lobu apply` once the underlying issue is resolved — every endpoint is idempotent."
    );
  }

  // Record the deployment (success or partial failure — a cancelled or
  // dry-run apply never reaches here). Mutations already carried the
  // x-lobu-apply-id header; this summary row is what groups them in the UI.
  {
    const gitInfo = collectGitInfo(cwd);
    // Start from the CURRENT remote pins so a partial failure never records a
    // phantom pin for a connector that did not install, then overlay what this
    // run actually installed (empty unless executePlan ran). Scoped applies
    // never reconcile connectors: carry the prior pins instead.
    let pins = opts.only
      ? (baselineRecord?.connectorVersions ?? {})
      : {
          ...connectorVersionPins(state, remote.connectorDefinitions),
          ...connectorVersions,
        };
    // Post-apply ownership: if this run created definitions, re-fetch remote
    // so owned gets real incarnation ids (pre-apply remote has none for creates).
    if (!applyErr && hasResourceWork && plan.counts.create > 0) {
      try {
        const postRemote = await fetchRemoteSnapshot(
          client,
          state,
          opts.only,
          prune,
          resolvedOrg?.id
        );
        baselineRecordForRecording = recordableBaseline(postRemote);
        if (!opts.only) {
          pins = {
            ...connectorVersionPins(state, postRemote.connectorDefinitions),
            ...connectorVersions,
          };
        }
      } catch {
        // Fall back to pre-apply baseline — over-blocks next prune, never
        // under-blocks (fail-closed residual).
      }
    }
    await postDeploymentSummarySafe(client, {
      apply_id: applyId,
      status: applyErr ? "partial_failure" : "succeeded",
      counts: plan.counts,
      counts_by_kind: buildCountsByKind(plan.rows),
      manifest_hash: computeManifestHash(state),
      git_sha: gitInfo.sha,
      git_dirty: gitInfo.dirty,
      cli_version: opts.cliVersion ?? null,
      manifest: buildDeploymentManifest(
        state,
        pins,
        applyErr ? undefined : baselineRecordForRecording
      ),
      ...(applyErr
        ? {
            error:
              applyErr instanceof Error ? applyErr.message : String(applyErr),
          }
        : {}),
    });
  }

  // Always render the punch-list — even on partial failure, so the operator
  // keeps the connect URLs and the informational notes.
  const finalPending = await collectPendingAuthFromPlan(
    client,
    plan,
    pendingAuth
  );
  const punchList = renderPostApplyPunchList({
    pendingAuth: finalPending,
    notes: plan.notes,
  });
  if (punchList) printText(punchList);

  if (applyErr) throw applyErr;
}
