import type { EntityMetrics } from "@lobu/connector-sdk";
import type { AgentSettings } from "@lobu/core";
import type { InstallConnectorInput } from "@lobu/core/contracts/tools/manage-connections";
import type {
  InferenceCapabilityBlock,
  InferenceModality,
} from "../../../config/define.js";
import { ApiClient, type HttpMethod } from "../../../internal/api-client.js";
import { resolveApiClient } from "../../../internal/index.js";
import { ApiError } from "../../memory/_lib/errors.js";
import type { DeploymentSummary } from "./deployment.js";
import type {
  DesiredAgentMetadata,
  DesiredEntityType,
  DesiredRelationshipType,
} from "./desired-state.js";
import {
  type AutomationSource,
  type EntityBacking,
  isRecord,
  type RelationshipRule,
} from "./shared.js";

// ── Wire types ─────────────────────────────────────────────────────────────

export interface RemoteAgent {
  agentId: string;
  name: string;
  description?: string;
}

export interface RemoteDeployment {
  id: number;
  applyId: string;
  createdAt: string;
  title: string | null;
  status: string | null;
  gitSha: string | null;
  gitDirty: boolean | null;
  manifestHash: string | null;
  rollbackOf: string | null;
  /** Stored snapshot ({version, state, connector_versions}); null on legacy deployments. */
  manifest: {
    version: number;
    state: Record<string, unknown>;
    connector_versions: Record<string, string>;
    /** Attribution baseline (effective remote after apply); absent on legacy. */
    attribution?: {
      entityTypes: unknown[];
      relationshipTypes: unknown[];
      automations: unknown[];
    };
    /** Kind-qualified incarnation identities this config applied. */
    owned?: string[];
  } | null;
  /** Blocking-drift candidates + confirm token, present on `blocked` runs. */
  candidates?: {
    token?: string;
    items?: Array<Record<string, unknown>>;
  } | null;
}

export interface DeploymentPauseState {
  paused: boolean;
  pausedAt?: string;
  applyId?: string | null;
  rollbackOf?: string | null;
  pausedBy?: string | null;
}

export interface RemoteEntityType {
  /** Persistent incarnation id (`entity_types.id`) — the `owned` identity for deletes. */
  id?: number;
  slug: string;
  name?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  /** Event kinds keyed by semantic_type (mirrors {@link DesiredEntityType.eventKinds}); hoisted from the row's `event_kinds`. */
  eventKinds?: Record<string, unknown>;
  /** Present only for derived types (mirrors {@link DesiredEntityType.backing}). */
  backing?: EntityBacking;
  /** Declared metrics (mirrors {@link DesiredEntityType.metrics}); hoisted from the row's `metrics_config`. */
  metrics?: EntityMetrics;
  /**
   * Top-level `metadata_schema` extension keys not hoisted into dedicated remote
   * fields. This includes `x-lobu-resolution`: apply compares it when config
   * declares a policy and carries it forward untouched when config omits it.
   *
   * `upsertEntityType` REBUILDS `metadata_schema` from the config's flat
   * `properties`/`required` and the server stores what it is sent verbatim, so
   * without carrying these forward every apply would silently erase them. Set
   * only when the stored schema has at least one such key, so a plain type
   * stays `undefined`.
   */
  schemaExtras?: Record<string, unknown>;
  /**
   * Write rules as stored, hoisted from the row's `rules_source`. The compiled
   * artifact is never fetched — it is a build output, so diffing it would churn
   * on a compiler change rather than on a rule change.
   */
  rulesSource?: string | null;
  /**
   * Owning org id. The list endpoint also returns *public* types from OTHER
   * orgs (`o.visibility = 'public'`), so prune must compare this against the
   * target org and never delete a type this org doesn't own.
   */
  organization_id?: string;
}

export interface RemoteRelationshipType {
  /** Persistent incarnation id (`entity_relationship_types.id`) — the `owned` identity for deletes. */
  id?: number;
  slug: string;
  name?: string;
  description?: string;
  rules?: RelationshipRule[];
  /** Owning org id — see RemoteEntityType.organization_id (public-type guard). */
  organization_id?: string;
}

interface RemoteOrg {
  id: string;
  slug: string;
  name?: string;
}

/** One org-owned inference provider as returned by `GET /inference-providers`. */
export interface RemoteInferenceProvider {
  id: number;
  slug: string;
  kind: string;
  displayName: string | null;
  capabilities: Record<string, Record<string, string>>;
  hasCustomUpstream: boolean;
  status: string;
  createdAt: string;
}

/** An applied view as `manage_views list` reports it (metadata, never bundles). */
export interface RemoteView {
  key: string;
  name: string;
  content_hash: string;
  attach: Array<Record<string, unknown>>;
  last_writer: string;
  updated_at: string;
}

export interface SetViewPayload {
  key: string;
  name?: string;
  description?: string;
  source_code: string;
  compiled_code?: string;
  attach: Array<Record<string, unknown>>;
  params: Record<string, unknown>;
  actions: Record<string, { emits: string }>;
}

export interface RemoteAutomation {
  slug: string;
  name?: string;
  automation_id?: string;
  managed_agent_id?: string | null;
  triggers?: import("@lobu/core/contracts/tools/manage-automations").AutomationTrigger[];
  device_worker_id?: string | null;
  goal_id?: number | null;
  agent_kind?: string | null;
  execution_config?: Record<string, unknown> | null;
  min_cooldown_seconds?: number | null;
  tags?: string[] | null;
  sources?: AutomationSource[] | null;
  // include_details=true → version-bound fields
  description?: string | null;
  prompt?: string | null;
  /**
   * Pinned skill snapshots on the current version. NULL/absent on Automations
   * created before the column existed, which the diff treats as "no skills" —
   * so the first re-apply of a config that references skills pins them.
   */
  skills?: Array<{ name: string; content: string }> | null;
  classifiers?: unknown[] | null;
  outputs?: Record<string, unknown> | null;
  reactions_guidance?: string | null;
  // NB: reaction_script is not included in Automation lists — push always (idempotent).
}

interface UpsertEntityTypeResult {
  created?: boolean;
  updated?: boolean;
  noop?: boolean;
}

// ── Connectors / auth profiles / connections wire types ────────────────────

export interface RemoteConnectorDefinition {
  /** Persistent incarnation id (`connector_definitions.id`) — the `owned` identity for deletes. */
  id?: number;
  key: string;
  name?: string;
  version?: string;
  options_schema?: Record<string, unknown> | null;
  feeds_schema?: Record<string, unknown> | null;
  auth_schema?: Record<string, unknown> | null;
  installed?: boolean;
  installable?: boolean;
  catalog_origin?: string;
  /** `file://` URI of the bundled source on the server host (catalog entries). */
  source_uri?: string | null;
  /** Non-secret remote MCP transport metadata exposed by the connector catalog. */
  mcp_config?: Record<string, unknown> | null;
  /** Trusted in-memory connector artifact synthesized from a managed Cloud catalog. */
  managed_mcp_source?: string;
}

export interface RemoteAuthProfile {
  id?: number;
  slug: string;
  display_name?: string;
  connector_key: string;
  profile_kind: string;
  status: string;
}

export interface RemoteConnection {
  id: number;
  slug: string;
  connector_key: string;
  display_name?: string;
  status: string;
  auth_profile_slug?: string | null;
  app_auth_profile_slug?: string | null;
  config?: Record<string, unknown> | null;
  device_worker_id?: string | null;
  agent_id?: string | null;
  credential_mode?: "managed" | "byo" | null;
  effective_credential_mode?: "managed" | "byo" | null;
}

export interface RemoteFeed {
  id: number;
  connection_id: number;
  feed_key: string;
  display_name?: string;
  status: string;
  schedule?: string | null;
  config?: Record<string, unknown> | null;
}

/**
 * The mutable fields of a connection update. Every key is optional and a key
 * that is ABSENT is not written — the server leaves that column alone. This is
 * what makes "undeclared means unmanaged" expressible on the wire, so the
 * builders in `diff.ts` construct these payloads a key at a time from the
 * diff's changed-field list rather than listing every field unconditionally.
 */
export interface UpdateConnectionPayload {
  name?: string;
  authProfileSlug?: string | null;
  appAuthProfileSlug?: string | null;
  config?: Record<string, unknown>;
  deviceWorkerId?: string | null;
}

/** The mutable fields of a feed update — same absent-means-unwritten rule. */
export interface UpdateFeedPayload {
  name?: string;
  /** Cron string, or null to clear (manual-only). */
  schedule?: string | null;
  config?: Record<string, unknown>;
}

interface InstallConnectorResult {
  connectorKey: string;
  updated: boolean;
  version?: string;
}

type CliInstallConnectorPayload = {
  connectorId?: InstallConnectorInput["connector_id"];
  sourceCode?: InstallConnectorInput["source_code"];
  sourceUrl?: InstallConnectorInput["source_url"];
  sourceUri?: InstallConnectorInput["source_uri"];
  compiled?: InstallConnectorInput["compiled"];
};

/**
 * Result of ensuring an auth profile exists. For interactive kinds
 * (`oauth_account` / `browser_session`) `connectUrl` carries the URL the
 * operator must open to complete auth; `status` is the state the server
 * reports (`pending_auth` until auth completes).
 */
interface EnsureAuthProfileResult {
  created: boolean;
  updated: boolean;
  status?: string;
  connectUrl?: string;
}

// ── Shape predicates ───────────────────────────────────────────────────────

/**
 * Read the first array-valued key from a response body. Endpoints that may
 * return either a snake_case or camelCase collection key go through this so the
 * `body.snake ?? body.camel ?? []` triple isn't repeated at every call site.
 */
function pickArray<T>(body: Record<string, unknown>, ...keys: string[]): T[] {
  for (const key of keys) {
    const value = body[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

/**
 * Core JSON Schema keys hoisted to dedicated remote fields. Extension keys stay
 * in {@link RemoteEntityType.schemaExtras} so apply can diff a declared owner or
 * preserve an undeclared/out-of-band value.
 */
const HOISTED_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
]);

/**
 * The server stores entity-type per-field config as a single `metadata_schema`
 * JSON Schema. The diff compares the desired config's flat `properties`/
 * `required` against the remote snapshot, so hoist them out of the returned
 * `metadata_schema` to the row's top level. Mirrors `upsertEntityType`, which
 * folds the flat fields back into `metadata_schema` when writing.
 *
 * Every other top-level key is collected into `schemaExtras`. The diff may own
 * a declared extension such as `x-lobu-resolution`; otherwise upsert carries it
 * forward so rebuilding the core schema cannot erase it silently.
 */
function hoistEntityTypeSchema(
  row: RemoteEntityType & {
    metadata_schema?: unknown;
    event_kinds?: unknown;
    backing_sql?: string | null;
    backing_source?: string | null;
    metrics_config?: unknown;
    rules_source?: string | null;
  }
): RemoteEntityType {
  const schema = row.metadata_schema;
  const out: RemoteEntityType = {
    ...(row.id !== undefined ? { id: row.id } : {}),
    slug: row.slug,
    ...(row.name !== undefined ? { name: row.name } : {}),
    ...(row.description !== undefined ? { description: row.description } : {}),
    // Preserve owning org so prune can skip public types from other orgs.
    ...(row.organization_id !== undefined
      ? { organization_id: row.organization_id }
      : {}),
  };
  if (isRecord(schema)) {
    if (isRecord(schema.properties)) out.properties = schema.properties;
    if (Array.isArray(schema.required)) {
      out.required = schema.required.filter(
        (v): v is string => typeof v === "string"
      );
    }
    const extras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (HOISTED_SCHEMA_KEYS.has(key)) continue;
      extras[key] = value;
    }
    if (Object.keys(extras).length > 0) out.schemaExtras = extras;
  }
  // A type is derived iff it has view SQL; stored types carry no backing, so it
  // compares equal to the desired side without churn. `backing_source` (a
  // connection slug) is hoisted to `backing.connection` only when set, so an
  // internal-backed view stays `{ sql }` and never churns.
  if (typeof row.backing_sql === "string") {
    out.backing = {
      sql: row.backing_sql,
      ...(typeof row.backing_source === "string" && row.backing_source
        ? { connection: row.backing_source }
        : {}),
    };
  }
  // Hoist metrics_config → `metrics` only when the column holds a non-empty
  // object, so a type with no declared metrics stays `undefined` on both sides
  // and never churns the diff (mirrors `backing`).
  if (
    isRecord(row.metrics_config) &&
    Object.keys(row.metrics_config).length > 0
  ) {
    out.metrics = row.metrics_config as EntityMetrics;
  }
  // Hoist event_kinds only when non-empty, so a type with no declared kinds
  // stays `undefined` on both sides and never churns the diff (mirrors metrics).
  if (isRecord(row.event_kinds) && Object.keys(row.event_kinds).length > 0) {
    out.eventKinds = row.event_kinds as Record<string, unknown>;
  }
  // Hoist rules_source only when non-empty, so a type with no rules stays
  // `undefined` on both sides and never churns (mirrors metrics/eventKinds).
  if (typeof row.rules_source === "string" && row.rules_source.length > 0) {
    out.rulesSource = row.rules_source;
  }
  return out;
}

// ── Client ─────────────────────────────────────────────────────────────────

interface ApplyClientConfig {
  apiBaseUrl: string;
  orgSlug: string;
  token: string;
  /** Sent as `x-lobu-apply-id` on every request so the server can group this run's config-audit events into one deployment. */
  applyId?: string;
  /**
   * The deployment this run is restoring, sent as `x-lobu-rollback-of`. Set by
   * `lobu rollback` only. The server refuses mutating apply-run requests while
   * promotions are paused; rollbacks are exempt, because rolling back FURTHER is
   * the main thing an operator does while paused. A rollback sets the pause
   * BEFORE its first mutation, so without this it would be blocked by its own
   * pause. The server verifies the named deployment is a restorable snapshot in
   * the org rather than trusting the header.
   */
  rollbackOf?: string;
}

/**
 * Typed wrappers for the existing server endpoints `lobu apply` calls.
 *
 * The class is open over an injectable `fetchImpl` so tests can stub the
 * network without monkey-patching globals. Real callers leave `fetchImpl`
 * unset and pick up `globalThis.fetch`.
 */
export class ApplyClient {
  private readonly orgSlug: string;
  private readonly http: ApiClient;

  constructor(cfg: ApplyClientConfig, fetchImpl: typeof fetch = fetch) {
    this.orgSlug = cfg.orgSlug;
    this.http = new ApiClient(cfg.apiBaseUrl, cfg.token, fetchImpl, {
      ...(cfg.applyId ? { "x-lobu-apply-id": cfg.applyId } : {}),
      ...(cfg.rollbackOf ? { "x-lobu-rollback-of": cfg.rollbackOf } : {}),
    });
  }

  /**
   * Delegates the fetch/parse/non-ok-error pipeline to the shared
   * {@link ApiClient}, then layers on the apply-specific shape:
   *   - the body is coerced to a record (`undefined`→`{}`, non-record→`{value}`)
   *   - a body-level `error` string is treated as a failure even on a 2xx
   *
   * Apply endpoints only ever return the listed `okStatuses` (200/201/204) on
   * success or a 4xx/5xx on failure, so `ApiClient`'s status gate produces the
   * same outcome the local pipeline did. `Content-Type: application/json` is
   * sent on every request (no `Accept`) to mirror the previous wire shape.
   */
  private async request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    okStatuses: number[] = [200, 201, 204]
  ): Promise<{ status: number; body: T }> {
    const { status, body: raw } = await this.http.requestWithStatus<unknown>(
      method,
      path,
      body,
      { okStatuses, sendAccept: false, alwaysJsonContentType: true }
    );

    let parsed: Record<string, unknown>;
    if (raw === undefined) {
      parsed = {};
    } else if (isRecord(raw)) {
      parsed = raw;
    } else {
      parsed = { value: raw };
    }

    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      throw new ApiError(
        `${method} ${path} returned error: ${parsed.error}`,
        status
      );
    }

    return { status, body: parsed as T };
  }

  // ── Organization ──────────────────────────────────────────────────────────

  /**
   * Orgs the authenticated user belongs to, read from the OAuth userinfo
   * endpoint — the same source `lobu org list` uses. Used to check whether the
   * `[memory].org` slug already resolves to one of the operator's orgs. Does
   * not depend on `this.orgSlug`. (`lobu apply` can't create an org headlessly
   * — that needs a logged-in browser session — so there is no `createOrg`.)
   */
  async listOrgs(): Promise<RemoteOrg[]> {
    const { body } = await this.request<{ organizations?: unknown }>(
      "GET",
      `/oauth/userinfo`
    );
    const orgs = Array.isArray(body.organizations) ? body.organizations : [];
    const out: RemoteOrg[] = [];
    for (const entry of orgs) {
      if (!isRecord(entry)) continue;
      const id = typeof entry.id === "string" ? entry.id : "";
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      if (!id || !slug) continue;
      out.push({
        id,
        slug,
        ...(typeof entry.name === "string" ? { name: entry.name } : {}),
      });
    }
    return out;
  }

  // ── Agents ────────────────────────────────────────────────────────────────

  async listAgents(): Promise<RemoteAgent[]> {
    const { body } = await this.request<{ agents?: RemoteAgent[] }>(
      "GET",
      `/api/${this.orgSlug}/agents`
    );
    return body.agents ?? [];
  }

  /**
   * Idempotent create: PR-2 makes `POST /` return 200 with the existing
   * payload when an agent of the same ID already exists in the same org.
   * Cross-org collision still surfaces as 409 with a clear `error.code` —
   * we re-throw verbatim so `lobu apply` can show the operator the link
   * to the org-scoped IDs issue.
   */
  async upsertAgent(agent: DesiredAgentMetadata): Promise<RemoteAgent> {
    const { body } = await this.request<RemoteAgent>(
      "POST",
      // No trailing slash — Hono matches `routes.post('/', ...)` mounted at
      // `/api/:orgSlug/agents` against `/api/dev/agents`, not `/api/dev/agents/`.
      `/api/${this.orgSlug}/agents`,
      agent,
      [200, 201]
    );
    return body;
  }

  async patchAgentMetadata(
    agentId: string,
    agent: { name?: string; description?: string }
  ): Promise<void> {
    await this.request(
      "PATCH",
      `/api/${this.orgSlug}/agents/${encodeURIComponent(agentId)}`,
      agent
    );
  }

  async getAgentSettings(agentId: string): Promise<AgentSettings | null> {
    try {
      const { body } = await this.request<AgentSettings>(
        "GET",
        `/api/${this.orgSlug}/agents/${encodeURIComponent(agentId)}/config`
      );
      return body;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  async patchAgentSettings(
    agentId: string,
    settings: Partial<AgentSettings>
  ): Promise<void> {
    await this.request(
      "PATCH",
      `/api/${this.orgSlug}/agents/${encodeURIComponent(agentId)}/config`,
      settings
    );
  }

  /**
   * Record this apply run as a deployment (`POST /api/<org>/deployments`).
   * The server dedupes on apply_id, so a retried post is safe. Callers treat
   * failure as a warning — the apply itself already succeeded (or already
   * failed) independently of the audit record.
   */
  async postDeploymentSummary(summary: DeploymentSummary): Promise<void> {
    await this.request("POST", `/api/${this.orgSlug}/deployments`, summary);
  }

  /** Fetch one deployment's record, including its stored manifest snapshot. */
  async getDeployment(applyId: string): Promise<RemoteDeployment | null> {
    try {
      const { body } = await this.request<{ deployment?: RemoteDeployment }>(
        "GET",
        `/api/${this.orgSlug}/deployments/${encodeURIComponent(applyId)}`
      );
      return body.deployment ?? null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Latest `succeeded` deployment — the attribution baseline (null when none). */
  async getLatestDeployment(): Promise<RemoteDeployment | null> {
    try {
      const { body } = await this.request<{ deployment?: RemoteDeployment }>(
        "GET",
        `/api/${this.orgSlug}/deployments/latest`
      );
      return body.deployment ?? null;
    } catch (err) {
      // The route always answers 200 (`{deployment: null}` when there is none),
      // so a 404 means the server predates it — a self-hosted deployment older
      // than this CLI. That is the legacy-manifest case, not a transport
      // failure: resolve to "no baseline" so declared definitions can use the
      // two-way diff while provenance-dependent deletes remain blocked.
      // Every other error still propagates and fails the apply closed.
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Promotions-pause state (set by `lobu rollback`). */
  async getDeploymentPause(): Promise<DeploymentPauseState> {
    const { body } = await this.request<DeploymentPauseState>(
      "GET",
      `/api/${this.orgSlug}/deployments/pause`
    );
    return body;
  }

  async setDeploymentPause(params: {
    applyId: string;
    rollbackOf: string;
  }): Promise<void> {
    await this.request("PUT", `/api/${this.orgSlug}/deployments/pause`, {
      apply_id: params.applyId,
      rollback_of: params.rollbackOf,
    });
  }

  async clearDeploymentPause(): Promise<void> {
    await this.request("DELETE", `/api/${this.orgSlug}/deployments/pause`);
  }

  // ── Org inference providers ────────────────────────────────────────────────
  // Org-scoped, mounted UNDER the agents router (`/api/:orgSlug/agents`), so the
  // full path is `/api/<org>/agents/inference-providers…` — verified against
  // `app.route("/api/:orgSlug/agents", agentRoutes)` in packages/server/src/index.ts.

  /** List the org's inference providers (never returns the api key). */
  async listInferenceProviders(): Promise<RemoteInferenceProvider[]> {
    const { body } = await this.request<{
      providers?: RemoteInferenceProvider[];
    }>("GET", `/api/${this.orgSlug}/agents/inference-providers`);
    return body.providers ?? [];
  }

  /** Create an org inference provider. 409 (surfaced as ApiError) on slug conflict. */
  async createInferenceProvider(body: {
    slug: string;
    kind: string;
    displayName?: string;
    apiKey: string;
    capabilities?: Partial<Record<InferenceModality, InferenceCapabilityBlock>>;
  }): Promise<RemoteInferenceProvider> {
    const { body: res } = await this.request<{
      provider: RemoteInferenceProvider;
    }>("POST", `/api/${this.orgSlug}/agents/inference-providers`, body);
    return res.provider;
  }

  /** Upsert one modality's capability block (`{ base_url?, model?, models_endpoint? }`). */
  async updateInferenceProviderCapabilities(
    slug: string,
    modality: InferenceModality,
    block: InferenceCapabilityBlock
  ): Promise<void> {
    await this.request(
      "PUT",
      `/api/${this.orgSlug}/agents/inference-providers/${encodeURIComponent(slug)}/capabilities/${encodeURIComponent(modality)}`,
      { block }
    );
  }

  /**
   * Rotate an org provider's API key. Idempotent — the current key can't be read
   * back, so apply re-pushes the declared value on every run; a matching value
   * is a harmless no-op server-side, a changed one rotates.
   */
  async rotateInferenceProviderKey(slug: string, value: string): Promise<void> {
    await this.request(
      "PUT",
      `/api/${this.orgSlug}/agents/inference-providers/${encodeURIComponent(slug)}/key`,
      { value }
    );
  }

  /** Soft-delete an org inference provider. */
  async deleteInferenceProvider(slug: string): Promise<void> {
    await this.request(
      "DELETE",
      `/api/${this.orgSlug}/agents/inference-providers/${encodeURIComponent(slug)}`
    );
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  /** Applied views (metadata only — the list never returns bundles). */
  async listViews(): Promise<RemoteView[]> {
    const { body } = await this.request<{ views?: RemoteView[] }>(
      "POST",
      `/api/${this.orgSlug}/manage_views`,
      { action: "list" }
    );
    return body.views ?? [];
  }

  /**
   * Store a view: source + CLI-bundled browser bundle + metadata extracted
   * from the module itself. Returns whether a write happened (same
   * executable artifact is a server-side no-op).
   */
  async setView(
    payload: SetViewPayload
  ): Promise<{ written: boolean; content_hash: string }> {
    const { body } = await this.request<{
      written?: boolean;
      view?: { content_hash?: string };
    }>("POST", `/api/${this.orgSlug}/manage_views`, {
      action: "set",
      ...payload,
    });
    return {
      written: body.written ?? false,
      content_hash: body.view?.content_hash ?? "",
    };
  }

  /** Delete an applied view by key (prune-gated removal). */
  async removeView(key: string): Promise<void> {
    await this.request("POST", `/api/${this.orgSlug}/manage_views`, {
      action: "remove",
      key,
    });
  }

  // ── Memory schema ─────────────────────────────────────────────────────────

  async listEntityTypes(): Promise<RemoteEntityType[]> {
    type RawEntityTypeRow = RemoteEntityType & {
      metadata_schema?: unknown;
      event_kinds?: unknown;
      backing_sql?: string | null;
    };
    const { body } = await this.request<{
      entity_types?: RawEntityTypeRow[];
      entityTypes?: RawEntityTypeRow[];
    }>("POST", `/api/${this.orgSlug}/manage_entity_schema`, {
      schema_type: "entity_type",
      action: "list",
    });
    // The server returns the type's fields inside a single `metadata_schema`
    // JSON Schema (+ typed backing_* columns). Surface `properties`/`required`
    // and normalize `backing` at top level so the diff compares them against the
    // desired config (which carries them flat).
    return pickArray<RawEntityTypeRow>(body, "entity_types", "entityTypes").map(
      hoistEntityTypeSchema
    );
  }

  /**
   * The `manage_entity_schema` admin tool exposes separate `create` / `update`
   * actions and surfaces duplicates as a coded 409 (`[entity_type_exists]` /
   * `[relationship_type_exists]`). Probe with `create`; on that explicit
   * duplicate signal retry with `update`. Any other error (e.g. a 422
   * `[invalid_schema]` validation failure) propagates verbatim — retrying it
   * as an update used to mask the real message behind "Entity type not
   * found" (issue #1177).
   */
  private async upsertSchemaResource(
    schemaType: "entity_type" | "relationship_type",
    payload: Record<string, unknown>
  ): Promise<UpsertEntityTypeResult> {
    const url = `/api/${this.orgSlug}/manage_entity_schema`;
    try {
      await this.request("POST", url, {
        schema_type: schemaType,
        action: "create",
        ...payload,
      });
      return { created: true };
    } catch (err) {
      if (err instanceof ApiError && isDuplicateError(err)) {
        await this.request("POST", url, {
          schema_type: schemaType,
          action: "update",
          ...payload,
        });
        return { updated: true };
      }
      throw err;
    }
  }

  async upsertEntityType(
    // `metadata` is authoring-only — never sent to the server (see
    // DesiredEntityType); extra properties on the passed value are ignored.
    entity: Omit<DesiredEntityType, "metadata">,
    /**
     * The live type's `metadata_schema` extension keys
     * ({@link RemoteEntityType.schemaExtras}), from the remote snapshot this
     * apply already fetched. Hoisted core keys are stripped before merging; a
     * declared resolution policy overrides its live extension, while every
     * undeclared extension survives the rebuild.
     */
    schemaExtras?: Record<string, unknown>,
    /**
     * The live type's hoisted schema core (`properties`/`required`) when the
     * config does not declare them itself. Required so a type that declares
     * ONLY an extension (e.g. `resolutionPolicy`) does not wipe the server's
     * complete metadata_schema by sending `properties: {}` — the config's
     * declared value wins when present, the remote core round-trips otherwise.
     */
    remoteSchemaCore?: {
      properties?: Record<string, unknown>;
      required?: string[];
    },
    /**
     * Facet names the apply diff flagged for CLEARING (prune removal of
     * out-of-band eventKinds, derived→stored backing revert, metric removal).
     * Facets are declared-only otherwise: an update fired for an unrelated
     * field must never wipe live values the config does not own, and the server
     * clears a facet only when its key is present in the payload.
     */
    clearFacets?: ReadonlySet<string>,
    /**
     * When true (prune off), remote-only property keys the config never
     * declared are merged into the write so an unrelated config update cannot
     * silently erase a UI-added property. When false (prune on), declared
     * properties alone are the full schema.
     */
    preserveRemoteOnlyProperties = true
  ): Promise<UpsertEntityTypeResult> {
    // The server stores per-type fields as a single `metadata_schema` JSON
    // Schema (`{ type, properties, required }`) — it does NOT read top-level
    // `properties`/`required`. Fold them into `metadata_schema` so the schema
    // actually persists (otherwise every apply re-reports a `properties`
    // update because the stored schema stays empty).
    const {
      slug,
      name,
      description,
      required,
      properties,
      eventKinds,
      backing,
      metrics,
      resolutionPolicy,
      rulesSource,
    } = entity;
    const payload: Record<string, unknown> = { slug };
    if (name !== undefined) payload.name = name;
    if (description !== undefined) payload.description = description;
    if (
      properties !== undefined ||
      required !== undefined ||
      resolutionPolicy !== undefined ||
      clearFacets?.has("properties") ||
      clearFacets?.has("required") ||
      clearFacets?.has("resolutionPolicy")
    ) {
      // Strip config-owned keys from the extras bag so config always wins —
      // spread order alone would let a stale `required` survive, because the
      // config's `required` is only spread when non-empty. (When the config
      // declares neither properties nor required we send no metadata_schema at
      // all — the server then leaves the stored one alone, extras included.)
      const extras: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(schemaExtras ?? {})) {
        if (HOISTED_SCHEMA_KEYS.has(key)) continue;
        // The resolution policy is config-owned when declared, and removed under
        // prune — either way the declared/cleared value wins over out-of-band.
        if (
          (resolutionPolicy !== undefined ||
            clearFacets?.has("resolutionPolicy")) &&
          key === "x-lobu-resolution"
        )
          continue;
        extras[key] = value;
      }
      // Declared properties/required win. When the config omits them:
      //   - diff flagged a prune removal → send an empty core to clear them;
      //   - otherwise → fall back to the live core so a fired update for an
      //     unrelated field never silently clears the server's schema.
      // When the config declares a partial properties object and prune is off,
      // merge remote-only keys so UI-authored properties survive.
      const pruneClearProperties = clearFacets?.has("properties");
      const pruneClearRequired = clearFacets?.has("required");
      const effectiveProperties = (() => {
        if (pruneClearProperties) return {};
        if (!properties) return remoteSchemaCore?.properties;
        if (!preserveRemoteOnlyProperties) return properties;
        const remoteOnly = Object.fromEntries(
          Object.entries(remoteSchemaCore?.properties ?? {}).filter(
            ([key]) => !(key in properties)
          )
        );
        return { ...remoteOnly, ...properties };
      })();
      const effectiveRequired = required
        ? required
        : pruneClearRequired
          ? undefined
          : remoteSchemaCore?.required;
      payload.metadata_schema = {
        ...extras,
        ...(resolutionPolicy ?? {}),
        type: "object",
        properties: effectiveProperties ?? {},
        ...(effectiveRequired && effectiveRequired.length > 0
          ? { required: effectiveRequired }
          : {}),
      };
    }
    // Facets are declared-only, with an explicit clear when the diff flagged
    // them (prune removal / derived-revert / metric removal). Sending `null`
    // unconditionally — the old semantics — wiped out-of-band values whenever
    // ANY field changed; the server clears a facet only when its key is present.
    if (eventKinds !== undefined || clearFacets?.has("eventKinds")) {
      payload.event_kinds = eventKinds ?? null;
    }
    if (backing !== undefined || clearFacets?.has("backing")) {
      payload.backing = backing
        ? {
            sql: backing.sql,
            ...(backing.connection ? { connection: backing.connection } : {}),
          }
        : null;
    }
    if (metrics !== undefined || clearFacets?.has("metrics")) {
      payload.metrics_config = metrics ?? null;
    }
    // RAW source only — the server compiles it and owns `rules_compiled`. The
    // CLI shipping a compiled artifact would pin the sandbox's build settings to
    // whatever version of the CLI happened to run the apply.
    if (rulesSource !== undefined || clearFacets?.has("rules")) {
      payload.rules_source = rulesSource?.sourceCode ?? null;
    }
    return this.upsertSchemaResource("entity_type", payload);
  }

  async listRelationshipTypes(): Promise<RemoteRelationshipType[]> {
    const { body } = await this.request<{
      relationship_types?: RemoteRelationshipType[];
      relationshipTypes?: RemoteRelationshipType[];
    }>("POST", `/api/${this.orgSlug}/manage_entity_schema`, {
      schema_type: "relationship_type",
      action: "list",
    });
    return pickArray(body, "relationship_types", "relationshipTypes");
  }

  /**
   * Fetch a relationship type's rules (the `list` action omits them, so the
   * apply diff can't otherwise see remote rules and would churn a perpetual
   * "rules changed" update). Maps the server's `*_entity_type_slug` columns to
   * `{ source, target }`; `id` is carried for reconcile (remove_rule by id).
   */
  async listRelationshipTypeRules(
    slug: string
  ): Promise<Array<RelationshipRule & { id: number }>> {
    const { body } = await this.request<{
      rules?: Array<{
        id?: number;
        source_entity_type_slug?: string;
        target_entity_type_slug?: string;
      }>;
    }>("POST", `/api/${this.orgSlug}/manage_entity_schema`, {
      schema_type: "relationship_type",
      action: "list_rules",
      slug,
    });
    return (body.rules ?? [])
      .filter(
        (r) =>
          r.id != null && r.source_entity_type_slug && r.target_entity_type_slug
      )
      .map((r) => ({
        id: r.id as number,
        source: r.source_entity_type_slug as string,
        target: r.target_entity_type_slug as string,
      }));
  }

  async upsertRelationshipType(
    // `metadata` is authoring-only — never sent (see DesiredRelationshipType).
    rel: Omit<DesiredRelationshipType, "metadata">
  ): Promise<UpsertEntityTypeResult> {
    const { rules, ...payload } = rel;
    const result = await this.upsertSchemaResource(
      "relationship_type",
      payload
    );

    // Reconcile rules to exactly the desired set so config is the source of
    // truth (declarative). Without removing extras, dropping a rule from config
    // would never take effect AND would churn a perpetual "rules changed"
    // update on every apply. add_rule is idempotent; remove_rule takes a id.
    const desired = rules ?? [];
    const ruleKey = (r: RelationshipRule) => `${r.source}	${r.target}`;
    const desiredKeys = new Set(desired.map(ruleKey));
    const remote = await this.listRelationshipTypeRules(rel.slug);
    const remoteKeys = new Set(remote.map(ruleKey));

    for (const rule of desired) {
      if (remoteKeys.has(ruleKey(rule))) continue;
      try {
        await this.request(
          "POST",
          `/api/${this.orgSlug}/manage_entity_schema`,
          {
            schema_type: "relationship_type",
            action: "add_rule",
            slug: rel.slug,
            source_entity_type_slug: rule.source,
            target_entity_type_slug: rule.target,
          }
        );
      } catch (err) {
        if (err instanceof ApiError && isDuplicateError(err)) continue;
        throw err;
      }
    }
    for (const rule of remote) {
      if (desiredKeys.has(ruleKey(rule))) continue;
      await this.request("POST", `/api/${this.orgSlug}/manage_entity_schema`, {
        schema_type: "relationship_type",
        action: "remove_rule",
        slug: rel.slug,
        rule_id: rule.id,
      });
    }
    return result;
  }

  /**
   * Delete an entity type (code-managed prune). The server soft-deletes and
   * REFUSES if instances of the type still exist — the data is exempt from
   * prune, so that surfaces as a clear error rather than cascading.
   */
  async deleteEntityType(slug: string): Promise<void> {
    await this.request("POST", `/api/${this.orgSlug}/manage_entity_schema`, {
      schema_type: "entity_type",
      action: "delete",
      slug,
    });
  }

  /** Delete a relationship type (code-managed prune). */
  async deleteRelationshipType(slug: string): Promise<void> {
    await this.request("POST", `/api/${this.orgSlug}/manage_entity_schema`, {
      schema_type: "relationship_type",
      action: "delete",
      slug,
    });
  }

  // ── Automations ─────────────────────────────────────────────────────────────

  /**
   * Fetch a single Automation's full payload, including the reaction script
   * (not in the list response). Used by `lobu init --from-org` to round-trip
   * reaction scripts back to sibling `.ts` files.
   */
  async getAutomationDetail(automationId: string): Promise<{
    reaction_script?: string | null;
    description?: string | null;
  } | null> {
    try {
      const { body } = await this.request<{
        automation?: {
          reaction_script?: string | null;
          description?: string | null;
        };
      }>(
        "GET",
        `/api/${this.orgSlug}/automations?automation_id=${encodeURIComponent(automationId)}`
      );
      return body.automation ?? null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  async listAutomations(): Promise<RemoteAutomation[]> {
    // `include_details=true` pulls the version-bound fields (prompt,
    // classifiers, outputs, reactions_guidance) too.
    // Apply diffs against these to detect drift on prompt / sources / etc.
    const { body } = await this.request<{ automations?: RemoteAutomation[] }>(
      "GET",
      `/api/${this.orgSlug}/automations?include_details=true`
    );
    return body.automations ?? [];
  }

  /**
   * Create an Automation owned by `agentId`. Duplicate-slug surfaces as a
   * structured error the caller swallows for idempotency.
   */
  async createAutomation(payload: {
    slug: string;
    agentId: string;
    name?: string;
    description?: string;
    prompt: string;
    skills?: Array<{ name: string; content: string }>;
    reaction_script?: string;
    triggers?: import("@lobu/core/contracts/tools/manage-automations").AutomationTrigger[];
    sources?: AutomationSource[];
    reactions_guidance?: string;
    device_worker_id?: string;
    min_cooldown_seconds?: number;
    tags?: string[];
    agent_kind?: string;
    execution_config?: Record<string, unknown> | null;
    outputs?: Record<string, unknown> | null;
    classifiers?: unknown[];
  }): Promise<{ automation_id?: string }> {
    const { body } = await this.request<{ automation_id?: string }>(
      "POST",
      `/api/${this.orgSlug}/manage_automations`,
      {
        action: "create",
        slug: payload.slug,
        managed_agent_id: payload.agentId,
        ...(payload.name ? { name: payload.name } : {}),
        ...(payload.description ? { description: payload.description } : {}),
        prompt: payload.prompt,
        ...(payload.skills?.length ? { skills: payload.skills } : {}),
        ...(payload.reaction_script !== undefined
          ? { reaction_script: payload.reaction_script }
          : {}),
        ...(payload.triggers !== undefined
          ? { triggers: payload.triggers }
          : {}),
        ...(payload.sources?.length ? { sources: payload.sources } : {}),
        ...(payload.reactions_guidance !== undefined
          ? { reactions_guidance: payload.reactions_guidance }
          : {}),
        ...(payload.device_worker_id !== undefined
          ? { device_worker_id: payload.device_worker_id }
          : {}),
        ...(payload.min_cooldown_seconds !== undefined
          ? { min_cooldown_seconds: payload.min_cooldown_seconds }
          : {}),
        ...(payload.tags?.length ? { tags: payload.tags } : {}),
        ...(payload.agent_kind !== undefined
          ? { agent_kind: payload.agent_kind }
          : {}),
        ...(payload.execution_config !== undefined
          ? { execution_config: payload.execution_config }
          : {}),
        ...(payload.outputs !== undefined ? { outputs: payload.outputs } : {}),
        ...(payload.classifiers !== undefined
          ? { classifiers: payload.classifiers }
          : {}),
      }
    );
    return {
      ...(body.automation_id ? { automation_id: body.automation_id } : {}),
    };
  }

  /**
   * Update the **scalar** fields on the `automations` row — these don't require
   * a new version. Version-bound fields (prompt / sources / reactions_guidance /
   * outputs / classifiers) require `createAutomationVersion`
   * instead.
   *
   * `null` clears nullable fields (device_worker_id, agent_kind) per the
   * server contract.
   */
  async updateAutomation(payload: {
    automation_id: string;
    triggers?: import("@lobu/core/contracts/tools/manage-automations").AutomationTrigger[];
    managed_agent_id?: string;
    device_worker_id?: string | null;
    min_cooldown_seconds?: number;
    tags?: string[];
    agent_kind?: string | null;
    execution_config?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.request("POST", `/api/${this.orgSlug}/manage_automations`, {
      action: "update",
      automation_id: payload.automation_id,
      ...(payload.triggers !== undefined ? { triggers: payload.triggers } : {}),
      ...(payload.managed_agent_id !== undefined
        ? { managed_agent_id: payload.managed_agent_id }
        : {}),
      ...(payload.device_worker_id !== undefined
        ? { device_worker_id: payload.device_worker_id }
        : {}),
      ...(payload.min_cooldown_seconds !== undefined
        ? { min_cooldown_seconds: payload.min_cooldown_seconds }
        : {}),
      ...(payload.tags !== undefined ? { tags: payload.tags } : {}),
      ...(payload.agent_kind !== undefined
        ? { agent_kind: payload.agent_kind }
        : {}),
      ...(payload.execution_config !== undefined
        ? { execution_config: payload.execution_config }
        : {}),
    });
  }

  /**
   * Create a new automation_versions row carrying the version-bound fields, then
   * upgrade the automation's `current_version_id` to that new version. Server
   * inherits unset fields from the previous version row.
   * name/description/prompt/sources are version-owned (update rejects them).
   */
  async createAutomationVersion(payload: {
    automation_id: string;
    name?: string;
    description?: string | null;
    prompt?: string;
    skills?: Array<{ name: string; content: string }>;
    sources?: AutomationSource[];
    outputs?: Record<string, unknown> | null;
    classifiers?: unknown[];
    reactions_guidance?: string;
    change_notes?: string;
    /** When set, written atomically with the new version (set_as_current). */
    triggers?: import("@lobu/core/contracts/tools/manage-automations").AutomationTrigger[];
  }): Promise<{ version?: number }> {
    const { body } = await this.request<{ version?: number }>(
      "POST",
      `/api/${this.orgSlug}/manage_automations`,
      {
        action: "create_version",
        automation_id: payload.automation_id,
        set_as_current: true,
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.description !== undefined
          ? { description: payload.description }
          : {}),
        ...(payload.prompt !== undefined ? { prompt: payload.prompt } : {}),
        ...(payload.skills !== undefined ? { skills: payload.skills } : {}),
        ...(payload.sources !== undefined ? { sources: payload.sources } : {}),
        ...(payload.outputs !== undefined ? { outputs: payload.outputs } : {}),
        ...(payload.classifiers !== undefined
          ? { classifiers: payload.classifiers }
          : {}),
        ...(payload.reactions_guidance !== undefined
          ? { reactions_guidance: payload.reactions_guidance }
          : {}),
        ...(payload.triggers !== undefined
          ? { triggers: payload.triggers }
          : {}),
        ...(payload.change_notes
          ? { change_notes: payload.change_notes }
          : { change_notes: "lobu apply" }),
      }
    );
    return body.version !== undefined ? { version: body.version } : {};
  }

  /**
   * Attach (or clear) a reaction script. Pass an empty string to remove it —
   * matches the admin tool contract.
   */
  async setReactionScript(
    automationId: string,
    reactionScript: string
  ): Promise<void> {
    await this.request("POST", `/api/${this.orgSlug}/manage_automations`, {
      action: "set_reaction_script",
      automation_id: automationId,
      reaction_script: reactionScript,
    });
  }

  /**
   * Delete an Automation by its numeric `automation_id` (code-managed prune). The
   * admin tool takes an array; we delete one slug's Automation at a time so a
   * failure is attributable.
   */
  async deleteAutomation(automationId: string): Promise<void> {
    await this.request("POST", `/api/${this.orgSlug}/manage_automations`, {
      action: "delete",
      automation_ids: [automationId],
    });
  }

  // ── Connector definitions ─────────────────────────────────────────────────

  private async connectionsTool<T>(body: Record<string, unknown>): Promise<T> {
    const { body: parsed } = await this.request<T>(
      "POST",
      `/api/${this.orgSlug}/manage_connections`,
      body
    );
    return parsed;
  }

  private async feedsTool<T>(body: Record<string, unknown>): Promise<T> {
    const { body: parsed } = await this.request<T>(
      "POST",
      `/api/${this.orgSlug}/manage_feeds`,
      body
    );
    return parsed;
  }

  private async authProfilesTool<T>(body: Record<string, unknown>): Promise<T> {
    const { body: parsed } = await this.request<T>(
      "POST",
      `/api/${this.orgSlug}/manage_auth_profiles`,
      body
    );
    return parsed;
  }

  private async catalogTool<T>(body: Record<string, unknown>): Promise<T> {
    const { body: parsed } = await this.request<T>(
      "POST",
      `/api/${this.orgSlug}/manage_catalog`,
      body
    );
    return parsed;
  }

  /** Installed org connectors + (with `includeInstallable`) the bundled catalog. */
  async listConnectors(
    includeInstallable = true
  ): Promise<RemoteConnectorDefinition[]> {
    const body = await this.catalogTool<{
      installed?: {
        connectors?: {
          items?: Array<{
            id: string;
            name: string;
            detail?: Record<string, unknown>;
          }>;
        };
      };
    }>({
      action: "list_installed",
      kinds: ["connectors"],
      include_catalog: includeInstallable,
    });
    const items = body.installed?.connectors?.items ?? [];
    return items.map((item) => mapConnectorDefinitionItem(item));
  }

  /**
   * Idempotent connector install. The CLI can enable a reviewed catalog
   * connector by id or pass connector source; server returns the resolved
   * connectorKey plus updated.
   */
  async installConnector(
    payload: CliInstallConnectorPayload
  ): Promise<InstallConnectorResult> {
    const body = await this.connectionsTool<{
      installed?: boolean;
      connector_key?: string;
      version?: string;
      updated?: boolean;
    }>({
      action: "install_connector",
      ...(payload.connectorId ? { connector_id: payload.connectorId } : {}),
      ...(payload.sourceCode !== undefined
        ? {
            source_code: payload.sourceCode,
            compiled: payload.compiled ?? false,
          }
        : {}),
      ...(payload.sourceUrl ? { source_url: payload.sourceUrl } : {}),
      ...(payload.sourceUri ? { source_uri: payload.sourceUri } : {}),
    });
    return {
      connectorKey: body.connector_key ?? "",
      updated: body.updated ?? false,
      ...(body.version ? { version: body.version } : {}),
    };
  }

  async uninstallConnector(connectorKey: string): Promise<void> {
    await this.connectionsTool({
      action: "uninstall_connector",
      connector_key: connectorKey,
    });
  }

  /**
   * Re-activate a retained connector version (org-local pointer flip — the
   * bytes already live in the org's `connector_versions` rows). The engine
   * behind `lobu rollback`'s connector pins.
   */
  async rollbackConnectorVersion(
    connectorKey: string,
    version: string
  ): Promise<void> {
    await this.connectionsTool({
      action: "rollback_connector_version",
      connector_key: connectorKey,
      version,
    });
  }

  // ── Auth profiles ─────────────────────────────────────────────────────────

  async listAuthProfiles(): Promise<RemoteAuthProfile[]> {
    const body = await this.authProfilesTool<{
      auth_profiles?: RemoteAuthProfile[];
    }>({ action: "list_auth_profiles" });
    return body.auth_profiles ?? [];
  }

  async getAuthProfileBySlug(slug: string): Promise<RemoteAuthProfile | null> {
    try {
      const body = await this.authProfilesTool<{
        auth_profile?: RemoteAuthProfile;
      }>({ action: "get_auth_profile", auth_profile_slug: slug });
      return body.auth_profile ?? null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  async createAuthProfile(payload: {
    slug: string;
    connector: string;
    kind: string;
    name?: string;
    credentials?: Record<string, string>;
  }): Promise<EnsureAuthProfileResult> {
    const body = await this.authProfilesTool<{
      auth_profile?: { status?: string };
      connect_url?: string;
    }>({
      action: "create_auth_profile",
      connector_key: payload.connector,
      profile_kind: payload.kind,
      display_name: payload.name ?? payload.slug,
      slug: payload.slug,
      ...(payload.credentials && Object.keys(payload.credentials).length > 0
        ? { credentials: payload.credentials }
        : {}),
    });
    return {
      created: true,
      updated: false,
      ...(body.auth_profile?.status
        ? { status: body.auth_profile.status }
        : {}),
      ...(body.connect_url ? { connectUrl: body.connect_url } : {}),
    };
  }

  async updateAuthProfile(payload: {
    slug: string;
    name?: string;
    credentials?: Record<string, string>;
  }): Promise<EnsureAuthProfileResult> {
    const body = await this.authProfilesTool<{
      auth_profile?: { status?: string };
      connect_url?: string;
    }>({
      action: "update_auth_profile",
      auth_profile_slug: payload.slug,
      ...(payload.name ? { display_name: payload.name } : {}),
      ...(payload.credentials && Object.keys(payload.credentials).length > 0
        ? { credentials: payload.credentials }
        : {}),
    });
    return {
      created: false,
      updated: true,
      ...(body.auth_profile?.status
        ? { status: body.auth_profile.status }
        : {}),
      ...(body.connect_url ? { connectUrl: body.connect_url } : {}),
    };
  }

  /** Re-issue a connect token for an existing interactive-auth profile. */
  async reconnectAuthProfile(slug: string): Promise<string | undefined> {
    const body = await this.authProfilesTool<{ connect_url?: string }>({
      action: "update_auth_profile",
      auth_profile_slug: slug,
      reconnect: true,
    });
    return body.connect_url;
  }

  // ── Connections ───────────────────────────────────────────────────────────

  async listConnections(): Promise<RemoteConnection[]> {
    const body = await this.connectionsTool<{
      connections?: RemoteConnection[];
    }>({ action: "list", limit: 500 });
    return (body.connections ?? [])
      .filter(
        // Data connectors (credential_mode NULL) and BYO chat connections
        // (credential_mode 'byo') both round-trip through `connections`. Managed
        // chat installs ('managed') are owned by the OAuth/claim flow, never the
        // declarative config, so they are excluded from the diff.
        (connection) =>
          connection.credential_mode == null ||
          connection.credential_mode === "byo"
      )
      .map((connection) => {
        if (connection.credential_mode !== "byo") return connection;
        // The chat runtime folds its own adapter discriminator, settings, and
        // metadata into `config`. They are storage details, not declarative
        // connector options, so do not expose them to diff/bootstrap callers.
        const config = { ...(connection.config ?? {}) };
        delete config.platform;
        delete config.settings;
        delete config.chatMetadata;
        return {
          ...connection,
          // BYO chat rows use the `agentconn-` storage namespace. Restore the
          // authored slug so desired and remote state match.
          slug: connection.slug.startsWith("agentconn-")
            ? connection.slug.slice("agentconn-".length)
            : connection.slug,
          config,
        };
      });
  }

  /**
   * Apply a BYO chat connection (a chat connector with a credential in `config`)
   * through the secret-aware `apply_chat_connection` path. Keyed by the
   * declared connection `slug` as the stable id (server stores it as
   * `agentconn-<slug>`); no owning agent — chat routing is an Automation created
   * when a channel is linked. The server compares resolved credentials under a
   * PG advisory lock, so an unchanged declaration is a true no-op.
   */
  async applyChatConnection(payload: {
    slug: string;
    connector: string;
    /** Omitted means preserve the server-derived/stored display name. */
    name?: string;
    config: Record<string, unknown>;
  }): Promise<{ id: number; created: boolean; changed: boolean }> {
    const body = await this.connectionsTool<{
      connection?: RemoteConnection;
      created?: boolean;
      changed?: boolean;
      error?: string;
    }>({
      action: "apply_chat_connection",
      stable_id: payload.slug,
      connector_key: payload.connector,
      ...(payload.name ? { display_name: payload.name } : {}),
      config: payload.config,
    });
    if (body.error) throw new ApiError(body.error);
    if (!body.connection) {
      throw new ApiError(
        `apply chat connection "${payload.slug}" returned no connection payload`
      );
    }
    return {
      id: body.connection.id,
      created: body.created === true,
      changed: body.changed === true,
    };
  }

  async createConnection(payload: {
    slug: string;
    connector: string;
    name?: string;
    authProfileSlug?: string;
    appAuthProfileSlug?: string;
    config?: Record<string, unknown>;
    deviceWorkerId?: string;
  }): Promise<RemoteConnection> {
    const body = await this.connectionsTool<{ connection?: RemoteConnection }>({
      action: "create",
      connector_key: payload.connector,
      slug: payload.slug,
      ...(payload.name ? { display_name: payload.name } : {}),
      ...(payload.authProfileSlug
        ? { auth_profile_slug: payload.authProfileSlug }
        : {}),
      ...(payload.appAuthProfileSlug
        ? { app_auth_profile_slug: payload.appAuthProfileSlug }
        : {}),
      ...(payload.config ? { config: payload.config } : {}),
      ...(payload.deviceWorkerId
        ? { device_worker_id: payload.deviceWorkerId }
        : {}),
    });
    if (!body.connection) {
      throw new ApiError(
        `create connection "${payload.slug}" returned no connection payload`
      );
    }
    return body.connection;
  }

  async updateConnection(
    connectionId: number,
    payload: UpdateConnectionPayload
  ): Promise<RemoteConnection> {
    const body = await this.connectionsTool<{ connection?: RemoteConnection }>({
      action: "update",
      connection_id: connectionId,
      ...(payload.name !== undefined ? { display_name: payload.name } : {}),
      ...(payload.authProfileSlug !== undefined
        ? { auth_profile_slug: payload.authProfileSlug }
        : {}),
      ...(payload.appAuthProfileSlug !== undefined
        ? { app_auth_profile_slug: payload.appAuthProfileSlug }
        : {}),
      // `lobu apply` is declarative — replace, don't merge, so removed
      // manifest keys disappear remotely (server defaults to merge).
      ...(payload.config !== undefined
        ? { config: payload.config, replace_config: true }
        : {}),
      ...(payload.deviceWorkerId !== undefined
        ? { device_worker_id: payload.deviceWorkerId }
        : {}),
    });
    if (!body.connection) {
      throw new ApiError(
        `update connection #${connectionId} returned no connection payload`
      );
    }
    return body.connection;
  }

  // ── Feeds (managed per-connection) ────────────────────────────────────────

  async listFeeds(connectionId: number): Promise<RemoteFeed[]> {
    const body = await this.feedsTool<{ feeds?: RemoteFeed[] }>({
      action: "list_feeds",
      connection_id: connectionId,
      limit: 500,
    });
    return body.feeds ?? [];
  }

  async createFeed(payload: {
    connectionId: number;
    feedKey: string;
    name?: string;
    /** Cron string, or null for manual-only. */
    schedule?: string | null;
    config?: Record<string, unknown>;
  }): Promise<RemoteFeed> {
    const body = await this.feedsTool<{ feed?: RemoteFeed }>({
      action: "create_feed",
      connection_id: payload.connectionId,
      feed_key: payload.feedKey,
      ...(payload.name ? { display_name: payload.name } : {}),
      // Always send schedule when provided (including null) so the server does
      // not have to invent a default.
      ...(payload.schedule !== undefined ? { schedule: payload.schedule } : {}),
      ...(payload.config ? { config: payload.config } : {}),
    });
    if (!body.feed) {
      throw new ApiError(
        `create feed "${payload.feedKey}" returned no feed payload`
      );
    }
    return body.feed;
  }

  async updateFeed(
    feedId: number,
    payload: UpdateFeedPayload
  ): Promise<RemoteFeed> {
    const body = await this.feedsTool<{ feed?: RemoteFeed }>({
      action: "update_feed",
      feed_id: feedId,
      ...(payload.name !== undefined ? { display_name: payload.name } : {}),
      ...(payload.schedule !== undefined ? { schedule: payload.schedule } : {}),
      ...(payload.config !== undefined
        ? { config: payload.config, replace_config: true }
        : {}),
    });
    if (!body.feed) {
      throw new ApiError(`update feed #${feedId} returned no feed payload`);
    }
    return body.feed;
  }
}

function mapConnectorDefinitionItem(item: {
  id: string;
  name: string;
  detail?: Record<string, unknown>;
}): RemoteConnectorDefinition {
  const detail = item.detail ?? {};
  const installed = detail.installed !== false;
  return {
    key: item.id,
    ...(typeof detail.connector_definition_id === "number"
      ? { id: detail.connector_definition_id }
      : {}),
    name: item.name,
    version: typeof detail.version === "string" ? detail.version : undefined,
    options_schema:
      detail.options_schema && typeof detail.options_schema === "object"
        ? (detail.options_schema as Record<string, unknown>)
        : null,
    feeds_schema:
      detail.feeds_schema && typeof detail.feeds_schema === "object"
        ? (detail.feeds_schema as Record<string, unknown>)
        : null,
    auth_schema:
      detail.auth_schema && typeof detail.auth_schema === "object"
        ? (detail.auth_schema as Record<string, unknown>)
        : null,
    installed,
    installable: Boolean(detail.installable ?? !installed),
    catalog_origin:
      detail.catalog_origin === "catalog" || detail.catalog_origin === "org"
        ? detail.catalog_origin
        : installed
          ? "org"
          : "catalog",
    source_uri:
      typeof detail.source_uri === "string" ? detail.source_uri : null,
    mcp_config:
      detail.mcp_config &&
      typeof detail.mcp_config === "object" &&
      !Array.isArray(detail.mcp_config)
        ? (detail.mcp_config as Record<string, unknown>)
        : null,
  };
}

/**
 * Recognise duplicate-name errors from the admin tools without substring
 * matching the user-facing message. The server stamps a bracketed code into
 * the error message of every duplicate path `apply` upserts through
 * (`manage_entity_schema` create / add_rule → `[entity_type_exists]`,
 * `[relationship_type_exists]`, `[already_exists]`, all httpStatus 409).
 *
 * Anything else is NOT a duplicate. In particular a 422 schema-validation
 * error (`[invalid_schema]`, e.g. ">4 x-table-column fields") must surface
 * verbatim — the old status-only fallback treated any 4xx as "already
 * exists", retried with `action: update`, and buried the real message under
 * a misleading "Entity type not found" (issue #1177). The 409 fallback stays
 * as a belt-and-braces signal for duplicate paths that predate the codes.
 */
export function isDuplicateError(err: ApiError): boolean {
  if (typeof err.status !== "number") return false;
  const message = err.message.toLowerCase();
  if (
    message.includes("[entity_type_exists]") ||
    message.includes("[relationship_type_exists]") ||
    message.includes("[already_exists]")
  ) {
    return true;
  }
  return err.status === 409;
}

// ── Top-level resolver ─────────────────────────────────────────────────────

interface ResolvedClient {
  client: ApplyClient;
  apiBaseUrl: string;
  orgSlug: string;
}

export async function resolveApplyClient(opts: {
  url?: string;
  org?: string;
  applyId?: string;
  /** Set by `lobu rollback` — exempts the run from the promotions pause. */
  rollbackOf?: string;
  fetchImpl?: typeof fetch;
}): Promise<ResolvedClient> {
  const { token, apiBaseUrl, orgSlug } = await resolveApiClient({
    org: opts.org,
    apiUrl: opts.url,
    fetchImpl: opts.fetchImpl,
  });
  const client = new ApplyClient(
    {
      apiBaseUrl,
      orgSlug,
      token,
      applyId: opts.applyId,
      rollbackOf: opts.rollbackOf,
    },
    opts.fetchImpl
  );
  return { client, apiBaseUrl, orgSlug };
}
