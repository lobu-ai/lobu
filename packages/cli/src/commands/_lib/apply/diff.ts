import { type AgentSettings, isSystemEntityType } from "@lobu/core";
import type {
  InferenceCapabilityBlock,
  InferenceModality,
} from "../../../config/define.js";
import { ValidationError } from "../../memory/_lib/errors.js";
import { isPlatformOwnedRelationshipSlug } from "../platform-owned-types.js";
import type {
  RemoteAgent,
  RemoteAuthProfile,
  RemoteAutomation,
  RemoteConnection,
  RemoteConnectorDefinition,
  RemoteEntityType,
  RemoteFeed,
  RemoteInferenceProvider,
  RemoteRelationshipType,
  UpdateConnectionPayload,
  UpdateFeedPayload,
} from "./client.js";
import type {
  DesiredAgent,
  DesiredAuthProfile,
  DesiredAutomationTrigger,
  DesiredConnection,
  DesiredConnectorDefinition,
  DesiredEntityType,
  DesiredFeed,
  DesiredOrgProvider,
  DesiredRelationshipType,
  DesiredState,
  DesiredAutomation,
} from "./desired-state.js";
import {
  type AutomationSource,
  declaredConnectorKeys,
  referencedConnectorKeys,
} from "./shared.js";

// ── Diff verbs ──────────────────────────────────────────────────────────────

type DiffVerb = "create" | "update" | "noop" | "drift" | "delete";

interface BaseRow {
  verb: DiffVerb;
  /** Stable identifier for matching messages and UI. */
  id: string;
}

/**
 * The desired/remote/changed-fields triple shared by every per-resource row
 * kind. `changedFields` carries field-level changes when verb === "update" and
 * remains the sole input to apply-cmd routing and the audit `changed_fields`.
 */
interface ResourceRow<D, R> extends BaseRow {
  desired?: D;
  remote?: R;
  changedFields?: string[];
}

/**
 * Before/after pairs are restricted to the baseline-aware memory-schema rows.
 * The other resource rows include provider keys, BYO connection config, and
 * auth profiles whose values must never be printed in a plan, so they have no
 * field to populate and the unsafe version does not typecheck.
 *
 * Automations are deliberately excluded too, though they are not secret-bearing:
 * their values reach the plan only through the two-way `diffAutomation` row, whose
 * field identifiers differ from the projection's (`agent` vs `managed_agent_id`), and
 * the name-mapping table that reconciled them was not worth its weight.
 */
interface ValuePreviewRow {
  changedValues?: Array<{ field: string; from: unknown; to: unknown }>;
}

export interface AgentDiffRow
  extends ResourceRow<DesiredAgent["metadata"], RemoteAgent> {
  kind: "agent";
}

export interface SettingsDiffRow extends BaseRow {
  kind: "settings";
  desired?: Partial<AgentSettings>;
  changedFields?: string[];
}

export interface EntityTypeDiffRow
  extends ResourceRow<DesiredEntityType, RemoteEntityType>,
    ValuePreviewRow {
  kind: "entity-type";
}

export interface RelationshipTypeDiffRow
  extends ResourceRow<DesiredRelationshipType, RemoteRelationshipType>,
    ValuePreviewRow {
  kind: "relationship-type";
}

export interface AutomationDiffRow
  extends ResourceRow<DesiredAutomation, RemoteAutomation> {
  kind: "automation";
  /**
   * Field names that require a `create_version` + `upgrade` (vs a plain
   * `update`). Apply uses this to route writes to the right admin action.
   */
  versionBoundFields?: string[];
  /**
   * True when the desired automation declares a `reaction_script` — server stores
   * it write-only, so the diff can't tell whether it changed; apply always
   * re-pushes (idempotent). Matches the auth-profile credentials pattern.
   * An explicit `null` (reaction removal) also counts as declared; apply
   * clears it via `set_reaction_script`.
   */
  reactionScriptDeclared?: boolean;
}

export interface ConnectorDefinitionDiffRow extends BaseRow {
  kind: "connector-definition";
  desired?: DesiredConnectorDefinition;
  /**
   * Whether the desired connector is currently installed remotely. When the
   * connector key isn't known up front (a local `.ts` the server hasn't
   * compiled), this is `false` and the verb is "create" — `install_connector`
   * is idempotent and reports `updated: false` on apply if nothing changed.
   */
  installedRemotely?: boolean;
}

export interface AuthProfileDiffRow
  extends ResourceRow<DesiredAuthProfile, RemoteAuthProfile> {
  kind: "auth-profile";
  /** True for `oauth_account` / `browser_session` profiles not yet `active`. */
  needsAuth?: boolean;
}

/**
 * Field names `diffConnection` and `diffFeed` can report. `changedFields` is
 * the sole input to apply-cmd routing, and apply reads these exact strings back
 * to decide what goes in the update payload. Naming them here means a rename or
 * a typo on EITHER side fails the build, instead of silently dropping the field
 * from the wire and leaving the remote value stale.
 */

export interface ConnectionDiffRow
  extends ResourceRow<DesiredConnection, RemoteConnection> {
  kind: "connection";
  changedFields?: ConnectionField[];
}

export interface FeedDiffRow extends ResourceRow<DesiredFeed, RemoteFeed> {
  kind: "feed";
  /** Owning connection slug. */
  connectionSlug: string;
  changedFields?: FeedField[];
}

export interface InferenceProviderDiffRow
  extends ResourceRow<DesiredOrgProvider, RemoteInferenceProvider> {
  kind: "inference-provider";
  /**
   * True when the desired provider declares an API key — the server stores it
   * write-only (can't be read back), so the diff can't tell whether it changed;
   * apply always re-pushes (idempotent). Matches the auth-profile credentials /
   * automation reaction-script pattern.
   */
  keyDeclared?: boolean;
  /**
   * Modalities whose capability block differs from remote (or is new). Apply
   * PUTs each. On a create, every declared modality is listed.
   */
  capabilityModalities?: InferenceModality[];
}

/**
 * A blocking drift item: either a field moved remotely or a remote-only
 * definition is not safe to delete. Apply must not converge over it — the
 * whole run blocks and reports this.
 */
export interface BlockingDriftRow extends BaseRow {
  verb: "drift";
  /** Always true — distinguishes blocking drift from legacy non-blocking drift. */
  blocking: true;
  kind: "entity-type" | "relationship-type" | "automation";
  id: string;
  /** The moved field; absent for a whole remote-only definition. */
  field?: string;
  /** The remote value, or display metadata for a remote-only definition. */
  remoteChange?: unknown;
  /** What the config declares for that field — what apply would have written. */
  desiredChange?: unknown;
}

/**
 * The attribution baseline: what the remote looked like after the last
 * succeeded apply, plus the set of definition incarnation identities
 * (`${kind}:${id}`) this config actually applied. Drives "who moved".
 */
export interface AttributionSnapshot {
  entityTypes: RemoteEntityType[];
  relationshipTypes: RemoteRelationshipType[];
  automations: RemoteAutomation[];
}

export interface Baseline {
  /**
   * Whether the manifest contained attribution and ownership. An absent
   * baseline permits two-way convergence for declared definitions but never
   * provenance-dependent deletion.
   */
  recorded: boolean;
  attribution: AttributionSnapshot;
  /** `${kind}:${id}` — delete-eligible definition incarnation identities. */
  owned: Set<string>;
  /**
   * Connector key → version recorded after the last succeeded apply (from the
   * deployment manifest's `connector_versions`). Used to refuse config-expressed
   * connector deletes when the remote incarnation was edited post-baseline.
   */
  connectorVersions?: Record<string, string>;
}

export const ownedKey = (kind: string, id: number | string | undefined) =>
  id === undefined ? "" : `${kind}:${id}`;

export type DiffRow =
  | AgentDiffRow
  | SettingsDiffRow
  | EntityTypeDiffRow
  | RelationshipTypeDiffRow
  | AutomationDiffRow
  | ConnectorDefinitionDiffRow
  | AuthProfileDiffRow
  | ConnectionDiffRow
  | FeedDiffRow
  | InferenceProviderDiffRow
  | BlockingDriftRow;

export interface DiffPlan {
  rows: DiffRow[];
  /** Aggregate counters for the summary line. */
  counts: {
    create: number;
    update: number;
    noop: number;
    drift: number;
    /**
     * Definitions absent from the config that apply will delete. Always 0
     * unless the config declares prune (`computeDiff({ prune: true })`);
     * otherwise those remote-only definitions are reported as `drift`.
     */
    delete: number;
  };
  /**
   * Informational, non-actionable notes — e.g. "connector X is installed
   * remotely but not declared locally". Rendered after the plan; never block
   * apply.
   */
  notes: string[];
}

// ── Equality helpers ───────────────────────────────────────────────────────

/**
 * Stable structural equality for JSON-shaped values. Sorts object keys before
 * stringifying so `{a:1,b:2}` and `{b:2,a:1}` compare equal.
 *
 * `undefined` and `null` both canonicalize to `"null"` so missing-on-one-side
 * fields don't show as drift. Empty arrays and empty objects are preserved
 * as themselves — clearing a remote allowlist by setting it to `[]` must
 * produce an `update`, not a `noop`.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/**
 * Deterministic serialization (sorted keys, undefined dropped). Exported for
 * the deployment manifest hash (deployment.ts), which must be stable across
 * key-insertion order.
 */
export function canonical(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ── Generic diff-row builder ───────────────────────────────────────────────

/** One comparable field: a label plus a "did it change?" predicate. */
interface DiffField<D, R, F extends string = string> {
  name: F;
  changed: (desired: D, remote: R) => boolean;
}

/** `(a ?? "") !== (b ?? "")` — the canonical optional-string comparison. */
function stringChanged(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  return (a ?? "") !== (b ?? "");
}

/**
 * Compare an OPTIONAL display name. When the config omits it (undefined/empty),
 * the operator has no opinion — the server keeps its derived/stored name (e.g.
 * a feed `display_name` defaulted from the feed key), so an omitted name must
 * NOT churn the plan into a perpetual "name changed" update. Only a name the
 * operator explicitly set, and that differs, is a real change.
 */
function optionalNameChanged(
  desired: string | null | undefined,
  remote: string | null | undefined
): boolean {
  if (desired == null || desired === "") return false;
  return stringChanged(desired, remote);
}

/**
 * One updatable field of a resource: how to tell whether it changed, and how it
 * appears in the update payload. Keeping both halves in one entry is the point
 * — the diff's field list and the wire payload used to be two hand-maintained
 * lists that had to agree by eye, and they silently disagreed for `schedule`
 * and `config`.
 */
interface FieldSpec<D, R, P> {
  changed: (desired: D, remote: R) => boolean;
  /** The payload fragment this field contributes when it HAS changed. */
  payload: (desired: D) => Partial<P>;
}

/**
 * A resource's field table. The payload type `P` is carried on the table's own
 * type rather than inferred from the entries, so {@link buildUpdatePayload}
 * returns the real payload shape instead of whichever fragment happens to be
 * declared first.
 */
interface FieldTable<D, R, P, F extends string> {
  readonly fields: Record<F, FieldSpec<D, R, P>>;
}

/**
 * Declares a field table with `D`/`R`/`P` pinned and the KEYS still inferred,
 * so the field-name union stays derived from the entries — there is no second
 * list to keep in sync, and a payload fragment that isn't part of `P` is a
 * compile error at the entry that wrote it.
 */
function defineFieldTable<D, R, P>() {
  return <T extends Record<string, FieldSpec<D, R, P>>>(
    fields: T
  ): FieldTable<D, R, P, Extract<keyof T, string>> => ({ fields });
}

/**
 * Every updatable connection field. `ConnectionField` is derived from this
 * object's keys, so the union and the table cannot drift: adding a key here
 * adds it to the union, and there is nowhere else to add one.
 *
 * BYO chat connections never reach `updateConnection` (apply routes them to the
 * secret-aware chat-upsert), so the BYO branches below only govern diffing.
 */
const CONNECTION_FIELDS = defineFieldTable<
  DesiredConnection,
  RemoteConnection,
  UpdateConnectionPayload
>()({
  name: {
    changed: (d, r) => optionalNameChanged(d.name, r.display_name),
    payload: (d) => ({ name: d.name }),
  },
  // `auth`/`app_auth`/`device_worker_id` are not part of the chat-upsert
  // payload (`apply_chat_connection` only persists slug/connector/name/config),
  // and a BYO chat declaration can't even set them (map-config rejects them).
  // Never diff them for BYO, or a remote row carrying a stray value would
  // report a perpetual "update" that apply can't clear.
  auth: {
    changed: (d, r) =>
      d.credentialMode === "byo"
        ? false
        : (d.authProfileSlug ?? null) !== (r.auth_profile_slug ?? null),
    payload: (d) => ({ authProfileSlug: d.authProfileSlug ?? null }),
  },
  app_auth: {
    changed: (d, r) =>
      d.credentialMode === "byo"
        ? false
        : (d.appAuthProfileSlug ?? null) !== (r.app_auth_profile_slug ?? null),
    payload: (d) => ({ appAuthProfileSlug: d.appAuthProfileSlug ?? null }),
  },
  config: {
    // A BYO chat connection's config holds a resolved secret (plaintext) on the
    // desired side, stored as a `secret://` ref remotely — the CLI can't compare
    // them, so it can't detect a token rotation. Always mark it as changed so
    // the row reaches the idempotent chat-upsert, which does the secret-aware
    // comparison server-side under an advisory lock and no-ops when nothing
    // actually changed. Data connectors deep-equal as before.
    // Undeclared is not a difference, same rule as `name` and the feed fields. A
    // connection block with no `config` key does not manage the connection's
    // settings, so a config set in the UI is left alone instead of being
    // replaced with `{}`.
    changed: (d, r) =>
      d.credentialMode === "byo"
        ? true
        : d.config !== undefined && !deepEqual(d.config, r.config ?? {}),
    // A declared config still REPLACES — a key removed from the config must
    // disappear remotely.
    payload: (d) => ({ config: d.config }),
  },
  device_worker_id: {
    changed: (d, r) =>
      d.credentialMode === "byo"
        ? false
        : (d.deviceWorkerId ?? null) !== (r.device_worker_id ?? null),
    // null unpins to the server, a uuid moves it to that device.
    payload: (d) => ({ deviceWorkerId: d.deviceWorkerId ?? null }),
  },
});

/** Every updatable feed field. See {@link CONNECTION_FIELDS}. */
const FEED_FIELDS = defineFieldTable<
  DesiredFeed,
  RemoteFeed,
  UpdateFeedPayload
>()({
  name: {
    changed: (d, r) => optionalNameChanged(d.name, r.display_name),
    payload: (d) => ({ name: d.name }),
  },
  schedule: {
    // Undeclared is not a difference — the same rule `optionalNameChanged`
    // applies to `name`. Only a declared value (a cron, or an explicit `null`
    // meaning clear) can put this row into `update`.
    changed: (d, r) =>
      d.schedule !== undefined && (d.schedule ?? null) !== (r.schedule ?? null),
    payload: (d) => ({ schedule: d.schedule ?? null }),
  },
  config: {
    changed: (d, r) =>
      d.config !== undefined && !deepEqual(d.config, r.config ?? {}),
    payload: (d) => ({ config: d.config }),
  },
});

export type ConnectionField = keyof typeof CONNECTION_FIELDS.fields;
export type FeedField = keyof typeof FEED_FIELDS.fields;

/** Adapts a field table to the `fields` array `buildDiffRow` consumes. */
function tableToFields<D, R, P, F extends string>(
  table: FieldTable<D, R, P, F>
): ReadonlyArray<DiffField<D, R, F>> {
  return (Object.keys(table.fields) as F[]).map((name) => ({
    name,
    changed: table.fields[name].changed,
  }));
}

/**
 * Builds an update payload from the diff's changed-field list: a field the
 * config does not declare produces no changed-field, so it never appears as a
 * key and the server leaves it alone.
 */
export function buildUpdatePayload<D, R, P, F extends string>(
  table: FieldTable<D, R, P, F>,
  changedFields: readonly F[] | undefined,
  desired: D
): Partial<P> {
  let payload: Partial<P> = {};
  for (const name of changedFields ?? []) {
    payload = { ...payload, ...table.fields[name].payload(desired) };
  }
  return payload;
}

/** The connection and feed field tables, for apply to build payloads from. */
export const UPDATE_FIELD_TABLES = {
  connection: CONNECTION_FIELDS,
  feed: FEED_FIELDS,
} as const;

/**
 * The shared create / noop / update shape behind most `diffX` functions.
 * `extras` is merged into every row (create/noop/update); `updateExtras`
 * adds verb-specific props derived from the changed-field list (e.g.
 * `willRestart`). `changedFields` is attached automatically on update.
 */
function buildDiffRow<D, R, K extends string, F extends string = string>(opts: {
  kind: K;
  id: string;
  desired: D;
  remote: R | undefined;
  fields: ReadonlyArray<DiffField<D, R, F>>;
  extras?: Record<string, unknown>;
  updateExtras?: (changed: F[]) => Record<string, unknown>;
}): {
  kind: K;
  verb: DiffVerb;
  id: string;
  desired: D;
  remote?: R;
  changedFields?: F[];
} & Record<string, unknown> {
  const extras = opts.extras ?? {};
  if (!opts.remote) {
    return {
      kind: opts.kind,
      verb: "create",
      id: opts.id,
      desired: opts.desired,
      ...extras,
    };
  }
  const remote = opts.remote;
  const changed = opts.fields
    .filter((f) => f.changed(opts.desired, remote))
    .map((f) => f.name);
  if (changed.length === 0) {
    return {
      kind: opts.kind,
      verb: "noop",
      id: opts.id,
      desired: opts.desired,
      remote,
      ...extras,
    };
  }
  return {
    kind: opts.kind,
    verb: "update",
    id: opts.id,
    desired: opts.desired,
    remote,
    changedFields: changed,
    ...extras,
    ...(opts.updateExtras?.(changed) ?? {}),
  };
}

// ── Per-resource diff ──────────────────────────────────────────────────────

function diffAgent(
  desired: DesiredAgent["metadata"],
  remote: RemoteAgent | undefined
): AgentDiffRow {
  return buildDiffRow({
    kind: "agent",
    id: desired.agentId,
    desired,
    remote,
    fields: [
      { name: "name", changed: (d, r) => d.name !== r.name },
      {
        name: "description",
        changed: (d, r) => stringChanged(d.description, r.description),
      },
    ],
  }) as AgentDiffRow;
}

/**
 * Compare desired settings against what's currently stored.
 *
 * Redacted-value handling: server never returns secret values in cleartext;
 * any string starting with `***` from the GET response is treated as opaque
 * and the diff records `<field>:redacted` instead of comparing values. The
 * AgentSettings shape currently has no redacted leaf strings, so this is a
 * forward-compatible guard rather than a hot path today.
 *
 * Field set: limited to the keys lobu.config.ts can express today. The agent's
 * model configuration is a single ordered `models` list of explicit
 * `<provider>/<model>` refs (the merged defaultModel + installedProviders).
 */
const SETTINGS_FIELDS: Array<keyof AgentSettings> = [
  "networkConfig",
  "nixConfig",
  "skillsConfig",
  "toolsConfig",
  "guardrails",
  "preApprovedTools",
  "models",
  "soulMd",
  "userMd",
  "identityMd",
];

function diffSettings(
  agentId: string,
  desired: Partial<AgentSettings>,
  remote: AgentSettings | null
): SettingsDiffRow {
  const changed: string[] = [];
  for (const field of SETTINGS_FIELDS) {
    if (!(field in desired)) continue;
    if (!deepEqual(desired[field], remote?.[field])) {
      changed.push(field);
    }
  }
  // Special case: when the agent itself is being created, the matching settings
  // patch is always considered a "create" so the user sees both rows in the
  // plan. The caller is responsible for setting `verb: "create"` from outside
  // when needed; here we only key off field equality.
  if (changed.length === 0) {
    return { kind: "settings", verb: "noop", id: agentId, desired };
  }
  return {
    kind: "settings",
    verb: "update",
    id: agentId,
    desired,
    changedFields: changed,
  };
}

function diffEntityType(
  desired: DesiredEntityType,
  remote: RemoteEntityType | undefined,
  prune: boolean
): EntityTypeDiffRow {
  return buildDiffRow({
    kind: "entity-type",
    id: desired.slug,
    desired,
    remote,
    fields: [
      { name: "name", changed: (d, r) => stringChanged(d.name, r.name) },
      {
        name: "description",
        changed: (d, r) => stringChanged(d.description, r.description),
      },
      {
        // required — prune-aware, like eventKinds. Declared: diff and set on
        // change. Omitted + prune: a present remote set is a removal (apply
        // clears it). Omitted + no prune: unmanaged, never churns — so an
        // extension-only declaration (e.g. resolutionPolicy) is a noop on
        // repeat apply instead of a perpetual update that wipes the live core.
        name: "required",
        changed: (d, r) =>
          d.required !== undefined
            ? !deepEqual(d.required, r.required ?? [])
            : prune && (r.required ?? []).length > 0,
      },
      {
        // properties — prune-aware, like eventKinds (see `required` above).
        // An already-cleared empty object is not a removal: flagging it would
        // re-report an update on every apply instead of converging.
        name: "properties",
        changed: (d, r) =>
          d.properties !== undefined
            ? !deepEqual(d.properties, r.properties)
            : prune &&
              r.properties !== undefined &&
              Object.keys(r.properties).length > 0,
      },
      {
        // Derived types store metadata_schema verbatim (no inferred superset),
        // so a plain properties + backing diff is exact and idempotent.
        name: "backing",
        changed: (d, r) => !deepEqual(d.backing, r.backing),
      },
      {
        // metrics_config round-trips verbatim; both sides omit it for a
        // non-metric type, so deepEqual(undefined, undefined) ⇒ no churn.
        name: "metrics",
        changed: (d, r) => !deepEqual(d.metrics, r.metrics),
      },
      {
        // event_kinds — prune-aware, like viewTemplate. event_kinds can be
        // authored out-of-band via manage_entity_schema (a connector feed, the
        // UI, an agent), so a config that simply doesn't declare them must NOT
        // wipe them. Declared: diff and set on change. Omitted + prune: a
        // present remote set is a removal (apply clears it). Omitted + no prune:
        // unmanaged, never churns — the out-of-band kinds are left alone.
        name: "eventKinds",
        changed: (d, r) =>
          d.eventKinds !== undefined
            ? !deepEqual(d.eventKinds, r.eventKinds)
            : prune && r.eventKinds !== undefined,
      },
      {
        // Resolution policy — prune-aware, like eventKinds. Declared: diff
        // against the remote x-lobu-resolution and set on change. Omitted +
        // prune: a present remote policy is a removal (apply clears it).
        // Omitted + no prune: unmanaged, never churns — an out-of-band authored
        // policy is preserved (the server keeps it), matching the carry-forward
        // in upsertEntityType.
        name: "resolutionPolicy",
        changed: (d, r) => {
          if (d.resolutionPolicy !== undefined) {
            const desired = d.resolutionPolicy["x-lobu-resolution"];
            const remote = r.schemaExtras?.["x-lobu-resolution"];
            return !deepEqual(desired, remote);
          }
          return prune && r.schemaExtras?.["x-lobu-resolution"] !== undefined;
        },
      },
      {
        // Write rules — prune-aware, like eventKinds. Compares SOURCE, never the
        // compiled artifact: the server owns compilation, so a compiler change
        // must not read as a rule change.
        name: "rules",
        changed: (d, r) =>
          d.rulesSource !== undefined
            ? d.rulesSource.sourceCode !== (r.rulesSource ?? undefined)
            : prune && r.rulesSource != null,
      },
      {
        // View template — prune-aware. Declared: diff against the remote current
        // default (apply sets on change). Omitted + prune: a present remote
        // template is a removal (apply clears it). Omitted + no prune: unmanaged
        // (never churns), so a UI-authored template is left alone.
        name: "viewTemplate",
        changed: (d, r) =>
          d.viewTemplate !== undefined
            ? !deepEqual(d.viewTemplate, r.viewTemplate)
            : prune && r.viewTemplate !== undefined,
      },
    ],
  }) as EntityTypeDiffRow;
}

function diffRelationshipType(
  desired: DesiredRelationshipType,
  remote: RemoteRelationshipType | undefined
): RelationshipTypeDiffRow {
  return buildDiffRow({
    kind: "relationship-type",
    id: desired.slug,
    desired,
    remote,
    fields: [
      { name: "name", changed: (d, r) => stringChanged(d.name, r.name) },
      {
        name: "description",
        changed: (d, r) => stringChanged(d.description, r.description),
      },
      {
        name: "rules",
        changed: (d, r) => !deepEqual(d.rules ?? [], r.rules ?? []),
      },
    ],
  }) as RelationshipTypeDiffRow;
}

// ── Three-way attribution (baseline-aware) ───────────────────────────────────
//
// With a baseline, a declared definition's fields are compared three ways
// (desired / remote / attribution). `configMoved` fields converge (config
// wins); `remoteMoved` fields block (the remote changed and the config didn't,
// or both moved — never guess). Without a baseline entry, any mismatch blocks.

type FieldOutcome = "noop" | "configMoved" | "remoteMoved";

function classifyField(
  desired: unknown,
  remote: unknown,
  attribution: unknown | undefined
): FieldOutcome {
  if (deepEqual(desired, remote)) return "noop";
  // `undefined` is a VALID prior field value (e.g. a property the config is
  // adding that neither the remote nor the baseline had) — presence in the
  // baseline is the callers' concern, not a field-value sentinel here.
  if (deepEqual(remote, attribution)) return "configMoved";
  return "remoteMoved";
}

interface ThreeWayResult<Field extends string = string> {
  changedFields: Field[];
  /**
   * The same changes as `changedFields`, carrying the values the plan is
   * about to move `from` → `to`. Derived from the very triples the classifier
   * compared, so the rendered pair is exactly what the decision was made on —
   * a renderer that re-read the values off `desired`/`remote` would have to
   * re-encode per-kind quirks (`resolutionPolicy` lives under
   * `schemaExtras["x-lobu-resolution"]`, `required` normalizes to `[]` under
   * prune) and would drift from the classifier the first time one changed.
   */
  changedValues: Array<{ field: Field; from: unknown; to: unknown }>;
  blockingFields: Array<{
    field: Field;
    remoteChange: unknown;
    desiredChange: unknown;
  }>;
}

/** Three-way per-field classification over a list of (name, desired, remote, attribution) triples. */
function classifyThreeWay<Field extends string>(
  triples: Array<{
    field: Field;
    desired: unknown;
    remote: unknown;
    attribution: unknown | undefined;
  }>
): ThreeWayResult<Field> {
  const changedFields: Field[] = [];
  const changedValues: ThreeWayResult<Field>["changedValues"] = [];
  const blockingFields: ThreeWayResult<Field>["blockingFields"] = [];
  for (const t of triples) {
    const outcome = classifyField(t.desired, t.remote, t.attribution);
    if (outcome === "configMoved") {
      changedFields.push(t.field);
      changedValues.push({ field: t.field, from: t.remote, to: t.desired });
    } else if (outcome === "remoteMoved") {
      blockingFields.push({
        field: t.field,
        remoteChange: t.remote,
        desiredChange: t.desired,
      });
    }
  }
  return { changedFields, changedValues, blockingFields };
}

/** Entity-type fields compared per-property-key, three-way, with the baseline. */
function compareEntityTypeThreeWay(
  desired: DesiredEntityType,
  remote: RemoteEntityType,
  attribution: RemoteEntityType | undefined,
  prune: boolean
): ThreeWayResult {
  const triples: Array<{
    field: string;
    desired: unknown;
    remote: unknown;
    attribution: unknown | undefined;
  }> = [
    {
      field: "name",
      desired: desired.name,
      remote: remote.name,
      attribution: attribution?.name,
    },
    {
      field: "description",
      desired: desired.description,
      remote: remote.description,
      attribution: attribution?.description,
    },
    {
      // Under prune, omitting required means "clear to []" — normalize so an
      // already-empty remote does not perpetual-update (undefined ≠ []).
      field: "required",
      desired:
        desired.required !== undefined
          ? desired.required
          : prune
            ? []
            : undefined,
      remote: remote.required ?? [],
      attribution: attribution?.required ?? [],
    },
    {
      field: "backing",
      desired: desired.backing,
      remote: remote.backing,
      attribution: attribution?.backing,
    },
    {
      field: "metrics",
      desired: desired.metrics,
      remote: remote.metrics,
      attribution: attribution?.metrics,
    },
    {
      field: "eventKinds",
      desired: desired.eventKinds,
      remote: remote.eventKinds,
      attribution: attribution?.eventKinds,
    },
    {
      field: "viewTemplate",
      desired: desired.viewTemplate,
      remote: remote.viewTemplate,
      attribution: attribution?.viewTemplate,
    },
    {
      field: "resolutionPolicy",
      desired: desired.resolutionPolicy?.["x-lobu-resolution"],
      remote: remote.schemaExtras?.["x-lobu-resolution"],
      attribution: attribution?.schemaExtras?.["x-lobu-resolution"],
    },
    {
      field: "rules",
      desired: desired.rulesSource?.sourceCode,
      remote: remote.rulesSource ?? undefined,
      attribution: attribution?.rulesSource ?? undefined,
    },
  ];
  const propKeys = new Set<string>();
  for (const p of Object.keys(desired.properties ?? {})) propKeys.add(p);
  for (const p of Object.keys(remote.properties ?? {})) propKeys.add(p);
  for (const key of [...propKeys].sort()) {
    triples.push({
      field: `properties.${key}`,
      desired: desired.properties?.[key],
      remote: remote.properties?.[key],
      attribution: attribution?.properties?.[key],
    });
  }
  // Facets the config omits are UNMANAGED outside prune (the server keeps them
  // — eventKinds/viewTemplate/properties round-trip untouched). Only under
  // prune does omission mean "remove". Without this, an unchanged omitted facet
  // would be misclassified as config-moved and executePlan would clear it.
  // name/description are unmanaged under BOTH prune and non-prune: upsert
  // never clears them when omitted, so a configMoved classification would
  // perpetual-update without effect.
  const alwaysUnmanaged = new Set(["name", "description"]);
  const omittableOutsidePrune = new Set([
    "required",
    "backing",
    "metrics",
    "eventKinds",
    "viewTemplate",
    "resolutionPolicy",
    "rules",
  ]);
  return classifyThreeWay(
    triples.filter((t) => {
      if (t.desired !== undefined) return true;
      if (alwaysUnmanaged.has(t.field)) return false;
      if (
        !prune &&
        (omittableOutsidePrune.has(t.field) ||
          t.field.startsWith("properties."))
      ) {
        return false;
      }
      return true;
    })
  );
}

/** Relationship-type fields, three-way with the baseline. */
function compareRelationshipTypeThreeWay(
  desired: DesiredRelationshipType,
  remote: RemoteRelationshipType,
  attribution: RemoteRelationshipType | undefined
): ThreeWayResult {
  // name/description are unmanaged when omitted (upsert never clears them).
  const triples = [
    {
      field: "name",
      desired: desired.name,
      remote: remote.name,
      attribution: attribution?.name,
    },
    {
      field: "description",
      desired: desired.description,
      remote: remote.description,
      attribution: attribution?.description,
    },
    {
      field: "rules",
      desired: desired.rules ?? [],
      remote: remote.rules ?? [],
      attribution: attribution?.rules ?? [],
    },
  ];
  return classifyThreeWay(
    triples.filter(
      (t) =>
        t.desired !== undefined ||
        (t.field !== "name" && t.field !== "description")
    )
  );
}

/**
 * A declared definition against a baseline: the three-way compare. Emits the
 * converging update row (config-moved fields) plus blocking-drift rows
 * (remote-moved fields). A declared-but-absent-from-baseline definition is
 * ambiguous and blocks as a whole.
 */
function diffEntityTypeWithBaseline(
  desired: DesiredEntityType,
  remote: RemoteEntityType | undefined,
  baseline: Baseline | undefined,
  prune: boolean
): { row: EntityTypeDiffRow; blocking: BlockingDriftRow[] } {
  if (!remote) {
    return { row: diffEntityType(desired, remote, prune), blocking: [] };
  }
  if (!baseline?.recorded) {
    return { row: diffEntityType(desired, remote, prune), blocking: [] };
  }
  const attr = baseline.attribution.entityTypes.find(
    (a) => a.slug === desired.slug
  );
  if (!attr) {
    // No baseline entry — ambiguous only when this apply would actually CHANGE
    // the remote. A definition the apply leaves untouched is a noop, so an
    // existing org can establish its first baseline without blocking. The test
    // is prune-aware because the projection is: under prune an omitted
    // eventKinds/viewTemplate/backing is a removal, so it does not compare
    // equal and the ambiguity blocks instead of recording a phantom baseline.
    const inSync = deepEqual(
      effectiveEntityTypeAfterApply(desired, remote, prune),
      remoteEntityTypeFacets(remote)
    );
    if (inSync) {
      return {
        row: {
          kind: "entity-type",
          verb: "noop",
          id: desired.slug,
          desired,
          remote,
        },
        blocking: [],
      };
    }
    return {
      row: {
        kind: "entity-type",
        verb: "noop",
        id: desired.slug,
        desired,
        remote,
      },
      blocking: [
        {
          kind: "entity-type",
          verb: "drift",
          blocking: true,
          id: desired.slug,
          // Field-qualified so blocked candidates use action=revert, not delete.
          field: "definition",
        },
      ],
    };
  }
  const threeWay = compareEntityTypeThreeWay(desired, remote, attr, prune);
  return {
    row: {
      kind: "entity-type",
      verb: threeWay.changedFields.length > 0 ? "update" : "noop",
      id: desired.slug,
      desired,
      remote,
      ...(threeWay.changedFields.length > 0
        ? {
            changedFields: threeWay.changedFields,
            changedValues: threeWay.changedValues,
          }
        : {}),
    },
    blocking: threeWay.blockingFields.map((b) => ({
      kind: "entity-type",
      verb: "drift",
      blocking: true,
      id: desired.slug,
      field: b.field,
      remoteChange: b.remoteChange,
      desiredChange: b.desiredChange,
    })),
  };
}

function diffRelationshipTypeWithBaseline(
  desired: DesiredRelationshipType,
  remote: RemoteRelationshipType | undefined,
  baseline: Baseline | undefined
): { row: RelationshipTypeDiffRow; blocking: BlockingDriftRow[] } {
  if (isPlatformOwnedRelationshipType("relationship-type", desired.slug)) {
    // A config may declare it, but the declaration binds to the platform's row
    // rather than managing it.
    // Emitting create/update here would fail the apply outright once the server
    // classifies the type as authorization-bearing, and a recorded baseline
    // would otherwise raise blocking drift for a row apply never wrote.
    // This is the only entry point for the desired-side relationship diff, so
    // the check belongs here rather than in the field-level helper below.
    return {
      row: {
        kind: "relationship-type",
        verb: "noop",
        id: desired.slug,
        desired,
        remote,
      } as RelationshipTypeDiffRow,
      blocking: [],
    };
  }
  if (!remote) {
    return { row: diffRelationshipType(desired, remote), blocking: [] };
  }
  if (!baseline?.recorded) {
    return { row: diffRelationshipType(desired, remote), blocking: [] };
  }
  const attr = baseline.attribution.relationshipTypes.find(
    (a) => a.slug === desired.slug
  );
  if (!attr) {
    // Same first-baseline test as entity types: block only when the apply would
    // change the remote. An omitted optional name/description is not an
    // operator opinion (upsert never clears them), so it must not block.
    const inSync = deepEqual(
      effectiveRelationshipTypeAfterApply(desired, remote),
      remoteRelationshipTypeFacets(remote)
    );
    if (inSync) {
      return {
        row: {
          kind: "relationship-type",
          verb: "noop",
          id: desired.slug,
          desired,
          remote,
        },
        blocking: [],
      };
    }
    return {
      row: {
        kind: "relationship-type",
        verb: "noop",
        id: desired.slug,
        desired,
        remote,
      },
      blocking: [
        {
          kind: "relationship-type",
          verb: "drift",
          blocking: true,
          field: "definition",
          id: desired.slug,
        },
      ],
    };
  }
  const threeWay = compareRelationshipTypeThreeWay(desired, remote, attr);
  return {
    row: {
      kind: "relationship-type",
      verb: threeWay.changedFields.length > 0 ? "update" : "noop",
      id: desired.slug,
      desired,
      remote,
      ...(threeWay.changedFields.length > 0
        ? {
            changedFields: threeWay.changedFields,
            changedValues: threeWay.changedValues,
          }
        : {}),
    },
    blocking: threeWay.blockingFields.map((b) => ({
      kind: "relationship-type",
      verb: "drift",
      blocking: true,
      id: desired.slug,
      field: b.field,
      remoteChange: b.remoteChange,
      desiredChange: b.desiredChange,
    })),
  };
}

/**
 * The entity-type facets a comparison cares about, normalized so an absent
 * collection and an empty one compare equal.
 */
export interface EntityTypeFacets {
  name: string | undefined;
  description: string | undefined;
  required: string[];
  properties: Record<string, unknown>;
  backing: unknown;
  metrics: unknown;
  eventKinds: unknown;
  viewTemplate: unknown;
  schemaExtras: Record<string, unknown>;
}

const normalizeEntityFacets = (e: {
  name?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  backing?: unknown;
  metrics?: unknown;
  eventKinds?: unknown;
  viewTemplate?: unknown;
  schemaExtras?: Record<string, unknown>;
}): EntityTypeFacets => ({
  name: e.name,
  description: e.description,
  required: e.required ?? [],
  properties: e.properties ?? {},
  backing: e.backing,
  metrics: e.metrics,
  eventKinds: e.eventKinds,
  viewTemplate: e.viewTemplate,
  schemaExtras: e.schemaExtras ?? {},
});

/** The live remote entity type, in the comparable facet shape. */
const remoteEntityTypeFacets = (r: RemoteEntityType): EntityTypeFacets =>
  normalizeEntityFacets(r);

/**
 * What the remote entity type BECOMES after this apply: declared values, plus
 * the facets the write provably leaves alone — name/description (upsert never
 * clears them), and, outside prune, every omitted facet including remote-only
 * property keys (`upsertEntityType` merges them back). Under prune an omitted
 * clearable facet is removed, so it projects to its cleared value.
 *
 * Single source for BOTH the recorded attribution baseline and the
 * "already in sync?" test that lets an existing org establish its first
 * baseline: a second, prune-blind projection is what made prune-managed
 * eventKinds/viewTemplate/backing look inherited and recorded a phantom noop.
 */
export const effectiveEntityTypeAfterApply = (
  d: DesiredEntityType,
  r: RemoteEntityType | undefined,
  prune: boolean
): EntityTypeFacets => {
  // Outside prune, extras authored out-of-band survive; under prune the apply
  // clears x-lobu-resolution when the config omits resolutionPolicy. Declared
  // policy always overlays (config wins).
  const schemaExtras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(r?.schemaExtras ?? {})) {
    if (
      prune &&
      key === "x-lobu-resolution" &&
      d.resolutionPolicy === undefined
    )
      continue;
    schemaExtras[key] = value;
  }
  if (d.resolutionPolicy) Object.assign(schemaExtras, d.resolutionPolicy);
  const inherit = <T>(declared: T | undefined, live: T | undefined) =>
    declared !== undefined ? declared : prune ? undefined : live;
  // Declared keys win; outside prune the remote-only keys survive the rebuild.
  const declaredProperties = d.properties;
  const properties =
    declaredProperties === undefined
      ? inherit(undefined, r?.properties)
      : prune
        ? declaredProperties
        : {
            ...Object.fromEntries(
              Object.entries(r?.properties ?? {}).filter(
                ([key]) => !(key in declaredProperties)
              )
            ),
            ...declaredProperties,
          };
  return normalizeEntityFacets({
    // Never cleared by omission, under prune or not.
    name: d.name !== undefined ? d.name : r?.name,
    description: d.description !== undefined ? d.description : r?.description,
    required: d.required !== undefined ? d.required : prune ? [] : r?.required,
    properties,
    backing: inherit(d.backing, r?.backing),
    metrics: inherit(d.metrics, r?.metrics),
    eventKinds: inherit(d.eventKinds, r?.eventKinds),
    viewTemplate: inherit(d.viewTemplate, r?.viewTemplate),
    schemaExtras,
  });
};

export interface RelationshipTypeFacets {
  name: string | undefined;
  description: string | undefined;
  rules: unknown[];
}

/** The live remote relationship type, in the comparable facet shape. */
const remoteRelationshipTypeFacets = (
  r: RemoteRelationshipType
): RelationshipTypeFacets => ({
  name: r.name,
  description: r.description,
  rules: r.rules ?? [],
});

/**
 * What the remote relationship type BECOMES after this apply. name/description
 * are never cleared by omission (upsert only sets what is declared); omitted
 * `rules` ARE cleared — `upsertRelationshipType` writes `[]`.
 */
export const effectiveRelationshipTypeAfterApply = (
  d: DesiredRelationshipType,
  r: RemoteRelationshipType | undefined
): RelationshipTypeFacets => ({
  name: d.name !== undefined ? d.name : r?.name,
  description: d.description !== undefined ? d.description : r?.description,
  rules: d.rules ?? [],
});

/**
 * `member_of` is minted and maintained by the connector ACL syncs. A config may
 * legitimately DECLARE it — `examples/personal-agent/lobu.config.ts` does — but
 * apply must not create, update, or delete it, declared or not. `lobu memory
 * seed` shares the rule and the same slug set.
 */
function isPlatformOwnedRelationshipType(kind: string, slug: string): boolean {
  return kind === "relationship-type" && isPlatformOwnedRelationshipSlug(slug);
}

/** Classify a remote-only definition without deleting unproven ownership. */
function remoteOnlyDefinitionRow(
  kind: "entity-type" | "relationship-type" | "automation",
  remote: {
    slug: string;
    id?: number | string;
    name?: string | null;
    description?: string | null;
  },
  baseline: Baseline | undefined,
  prune: boolean,
  unchangedSinceBaseline: (slug: string) => boolean
): DiffRow {
  // Off prune this apply cannot delete the definition, so blocking on it
  // protects nothing and only stalls the rest of the plan. Connector
  // definitions already scope their delete/block pair this way.
  if (isPlatformOwnedRelationshipType(kind, remote.slug)) {
    // Absent from config on purpose: the platform owns it. Reporting drift here
    // would block every apply whose config does not declare it, and deleting it
    // would revoke access wholesale.
    return { kind, verb: "noop", id: remote.slug, remote } as DiffRow;
  }
  if (!prune) {
    return { kind, verb: "drift", id: remote.slug, remote } as DiffRow;
  }
  // Prune may delete only a recorded, owned incarnation that is unchanged;
  // unowned, edited, and unrecorded all block, since deleting the wrong
  // definition is unrecoverable.
  const owned =
    baseline?.recorded === true &&
    remote.id !== undefined &&
    baseline.owned.has(ownedKey(kind, remote.id));
  if (owned && unchangedSinceBaseline(remote.slug)) {
    return { kind, verb: "delete", id: remote.slug, remote } as DiffRow;
  }
  return {
    kind,
    verb: "drift",
    blocking: true,
    id: remote.slug,
    remote,
    // Restrict terminal output to display metadata; schema bodies and Automation
    // prompts can contain sensitive values.
    remoteChange: {
      name: remote.name,
      description: remote.description,
    },
  } as DiffRow;
}

// Automation three-way — whole-definition, over a normalized camelCase
// projection of the fields the diff cares about. Write-only fields
// (`reactionScript`) are excluded (always-repush, never attributed).
//
// Optional fields the config omits are UNMANAGED — same contract as the
// two-way `diffAutomation` (only declared fields converge) and as entity-type
// omittable facets. Projecting an omitted field as `[]`/`null` would make
// every apply that leaves remote-only sources/skills/tags intact look like
// remote-moved drift and permanently block re-apply.

interface AutomationProjection {
  executor?: unknown;
  agent?: string | null;
  name?: string | null;
  description?: string | null;
  triggers?: DesiredAutomationTrigger[];
  prompt?: string | null;
  skills?: Array<{ name: string; content: string }> | null;
  sources?: AutomationSource[] | null;
  reactionsGuidance?: string | null;
  deviceWorkerId?: string | null;
  model?: string | null;
  minCooldownSeconds?: number | null;
  tags?: string[] | null;
  agentKind?: string | null;
  outputs?: Record<string, unknown> | null;
  classifiers?: unknown[] | null;
}

/**
 * Desired Automation → projection. For fields the two-way diff only compares
 * when declared, an omitted value inherits the live remote (unmanaged) so
 * three-way attribution never false-blocks on preserved remote state.
 * Always-managed fields (`triggers`, `prompt`, `outputs`, `agent`, `name`)
 * use the same defaults as `diffAutomation`.
 */
export const projectDesiredAutomation = (
  d: DesiredAutomation,
  remote?: RemoteAutomation
): AutomationProjection => ({
  executor:
    d.executor !== undefined
      ? d.executor
      : (remote?.execution_config?.executor ?? null),
  agent: d.agent ?? null,
  // Name/description are optional in config; the server defaults name to the
  // slug. Inherit live remote when omitted so a second apply does not
  // false-block against the server default.
  name: d.name !== undefined ? d.name : (remote?.name ?? null),
  description:
    d.description !== undefined
      ? (d.description ?? null)
      : (remote?.description ?? null),
  triggers: d.triggers ?? [],
  prompt: d.prompt ?? "",
  skills:
    d.skillSnapshots !== undefined ? d.skillSnapshots : (remote?.skills ?? []),
  sources: d.sources !== undefined ? d.sources : (remote?.sources ?? []),
  reactionsGuidance:
    d.reactionsGuidance !== undefined
      ? d.reactionsGuidance
      : (remote?.reactions_guidance ?? null),
  deviceWorkerId:
    d.deviceWorkerId !== undefined
      ? d.deviceWorkerId
      : (remote?.device_worker_id ?? null),
  model:
    d.model !== undefined
      ? d.model
      : typeof remote?.execution_config?.model === "string"
        ? (remote.execution_config.model as string)
        : null,
  minCooldownSeconds:
    d.minCooldownSeconds !== undefined
      ? d.minCooldownSeconds
      : (remote?.min_cooldown_seconds ?? null),
  tags: d.tags !== undefined ? d.tags : (remote?.tags ?? []),
  agentKind:
    d.agentKind !== undefined ? d.agentKind : (remote?.agent_kind ?? null),
  // Config is declarative for outputs: omitting means "no durable outputs".
  outputs: d.outputs ?? null,
  classifiers:
    d.classifiers !== undefined ? d.classifiers : (remote?.classifiers ?? []),
});

const projectRemoteAutomation = (
  w: RemoteAutomation
): AutomationProjection => ({
  executor: w.execution_config?.executor ?? null,
  agent: w.managed_agent_id ?? null,
  // `?? null` mirrors projectDesiredAutomation: an unnamed remote Automation must
  // compare EQUAL to the desired side that inherited it, or deepEqual(null,
  // undefined) false-blocks the first baseline.
  name: w.name ?? null,
  description: w.description ?? null,
  triggers: w.triggers ?? [],
  prompt: w.prompt ?? "",
  skills: w.skills ?? [],
  sources: w.sources ?? [],
  reactionsGuidance: w.reactions_guidance ?? null,
  deviceWorkerId: w.device_worker_id ?? null,
  model:
    typeof w.execution_config?.model === "string"
      ? (w.execution_config.model as string)
      : null,
  minCooldownSeconds: w.min_cooldown_seconds ?? null,
  tags: w.tags ?? [],
  agentKind: w.agent_kind ?? null,
  outputs: w.outputs ?? null,
  classifiers: w.classifiers ?? [],
});

function diffAutomationWithBaseline(
  desired: DesiredAutomation,
  remote: RemoteAutomation | undefined,
  baseline: Baseline | undefined
): { row: AutomationDiffRow; blocking: BlockingDriftRow[] } {
  if (!remote) {
    return { row: diffAutomation(desired, remote), blocking: [] };
  }
  if (!baseline?.recorded) {
    return { row: diffAutomation(desired, remote), blocking: [] };
  }
  const attr = baseline.attribution.automations.find(
    (a) => a.slug === desired.slug
  );
  if (!attr) {
    const inSync = deepEqual(
      projectDesiredAutomation(desired, remote),
      projectRemoteAutomation(remote)
    );
    if (inSync) {
      return {
        row: {
          kind: "automation",
          verb: "noop",
          id: desired.slug,
          desired,
          remote,
        },
        blocking: [],
      };
    }
    return {
      row: {
        kind: "automation",
        verb: "noop",
        id: desired.slug,
        desired,
        remote,
      },
      blocking: [
        {
          kind: "automation",
          verb: "drift",
          blocking: true,
          id: desired.slug,
          // Field-qualified so blocked candidates record action=revert (not
          // delete) — this is a declared Automation whose remote moved.
          field: "definition",
        },
      ],
    };
  }
  // Per-field three-way: a remote-moved agent must not block a concurrent
  // config prompt change once the agent is adopted (desired==remote for that
  // field). Whole-object compare treated any residual mismatch as one block.
  const dProj = projectDesiredAutomation(desired, remote);
  const rProj = projectRemoteAutomation(remote);
  const aProj = projectRemoteAutomation(attr);
  const fieldNames = Object.keys(dProj) as Array<keyof AutomationProjection>;
  const threeWay = classifyThreeWay(
    fieldNames.map((field) => ({
      field,
      desired: dProj[field],
      remote: rProj[field],
      attribution: aProj[field],
    }))
  );
  if (threeWay.blockingFields.length > 0) {
    return {
      row: {
        kind: "automation",
        verb: "noop",
        id: desired.slug,
        desired,
        remote,
      },
      blocking: threeWay.blockingFields.map((b) => ({
        kind: "automation" as const,
        verb: "drift" as const,
        blocking: true as const,
        id: desired.slug,
        field: b.field,
        remoteChange: b.remoteChange,
        desiredChange: b.desiredChange,
      })),
    };
  }
  // No remote-moved fields — converge config-moved (or noop) via two-way.
  return { row: diffAutomation(desired, remote), blocking: [] };
}

/**
 * Automation drift fields split into two routing categories:
 *   - **scalar** lives on the `automations` row → `manage_automations update`.
 *   - **version-bound** lives on the `automation_versions` row → must go through
 *     `create_version` + `upgrade` (server-side bumps `current_version_id`).
 * The diff returns both lists; apply-cmd routes accordingly.
 *
 * Reaction scripts aren't returned by Automation lists (write-only on the row),
 * so we can't compare them — apply always re-pushes when declared (idempotent),
 * and an explicit `null` is a declared removal routed to `set_reaction_script`.
 * Remote automations without a desired model are reported as drift, never deleted.
 */
function diffAutomation(
  desired: DesiredAutomation,
  remote: RemoteAutomation | undefined
): AutomationDiffRow {
  const reactionScriptDeclared = desired.reactionScript !== undefined;
  if (!remote) {
    return {
      kind: "automation",
      verb: "create",
      id: desired.slug,
      desired,
      ...(reactionScriptDeclared ? { reactionScriptDeclared: true } : {}),
    };
  }

  const scalar: string[] = [];
  if (!deepEqual(desired.triggers ?? [], remote.triggers ?? [])) {
    scalar.push("triggers");
  }
  if (desired.agent !== (remote.managed_agent_id ?? "")) {
    scalar.push("managed_agent_id");
  }
  if (
    desired.deviceWorkerId !== undefined &&
    desired.deviceWorkerId !== (remote.device_worker_id ?? undefined)
  ) {
    scalar.push("device_worker_id");
  }
  if (
    desired.minCooldownSeconds !== undefined &&
    desired.minCooldownSeconds !== (remote.min_cooldown_seconds ?? undefined)
  ) {
    scalar.push("min_cooldown_seconds");
  }
  if (
    desired.tags !== undefined &&
    !deepEqual(desired.tags, remote.tags ?? [])
  ) {
    scalar.push("tags");
  }
  if (
    desired.agentKind !== undefined &&
    desired.agentKind !== (remote.agent_kind ?? undefined)
  ) {
    scalar.push("agent_kind");
  }
  if (
    (desired.model !== undefined &&
      desired.model !== (remote.execution_config?.model ?? null)) ||
    (desired.executor !== undefined &&
      !deepEqual(desired.executor, remote.execution_config?.executor ?? null))
  ) {
    scalar.push("execution_config");
  }

  const versionBound: string[] = [];
  // name/description are version-owned (manage_automations create_version only;
  // update rejects them). Only compare when declared so an omitted name
  // inherits the server slug default without perpetual churn.
  if (desired.name !== undefined && desired.name !== (remote.name ?? "")) {
    versionBound.push("name");
  }
  if (
    desired.description !== undefined &&
    (desired.description ?? null) !== (remote.description ?? null)
  ) {
    versionBound.push("description");
  }
  if (desired.prompt !== (remote.prompt ?? "")) {
    versionBound.push("prompt");
  }
  // Compare the resolved snapshots, not the config's name list. Editing a
  // SKILL.md changes no name, so a name-level diff would report "no changes"
  // and leave every Automation pinned to the old body — re-apply is how a config
  // project takes a skill update, and this comparison is what makes it land.
  if (
    desired.skillSnapshots !== undefined &&
    !deepEqual(desired.skillSnapshots, remote.skills ?? [])
  ) {
    versionBound.push("skills");
  }
  // Sources live on the automations row but are written as part of create_version
  // when changed (server copies them to the version's per-assignment scope).
  // Diff against `remote.sources` (also from the row) and route through
  // create_version so the version chain stays consistent.
  if (
    desired.sources !== undefined &&
    !deepEqual(desired.sources, remote.sources ?? [])
  ) {
    versionBound.push("sources");
  }
  if (
    desired.reactionsGuidance !== undefined &&
    desired.reactionsGuidance !== (remote.reactions_guidance ?? "")
  ) {
    versionBound.push("reactions_guidance");
  }
  // Config is declarative: removing `outputs` means "no durable outputs", just
  // like writing `outputs: null`. Compare that resolved value so deleting the
  // declaration clears the previous version instead of silently inheriting it.
  if (!deepEqual(desired.outputs ?? null, remote.outputs ?? null)) {
    versionBound.push("outputs");
  }
  if (
    desired.classifiers !== undefined &&
    !deepEqual(desired.classifiers, remote.classifiers ?? [])
  ) {
    versionBound.push("classifiers");
  }
  const changed = [...scalar, ...versionBound];
  if (reactionScriptDeclared) changed.push("reaction_script");
  if (changed.length === 0) {
    return {
      kind: "automation",
      verb: "noop",
      id: desired.slug,
      desired,
      remote,
    };
  }
  return {
    kind: "automation",
    verb: "update",
    id: desired.slug,
    desired,
    remote,
    changedFields: changed,
    ...(versionBound.length > 0 ? { versionBoundFields: versionBound } : {}),
    ...(reactionScriptDeclared ? { reactionScriptDeclared: true } : {}),
  };
}

// ── Connectors ─────────────────────────────────────────────────────────────

const INTERACTIVE_AUTH_KINDS: ReadonlySet<string> = new Set([
  "oauth_account",
  "browser_session",
]);

function connectorDefinitionId(def: DesiredConnectorDefinition): string {
  return def.key ?? def.sourceFile;
}

function diffConnectorDefinition(
  desired: DesiredConnectorDefinition,
  installedKeys: ReadonlySet<string>
): ConnectorDefinitionDiffRow {
  const id = connectorDefinitionId(desired);
  // The CLI can't compare source hashes (the server compiles, and the stored
  // hash is of the *compiled* output) — so we always emit a "sync" row;
  // `install_connector` is idempotent and reports `updated:false` on apply
  // when the code is byte-identical, so this never churns remote state.
  const installedRemotely = desired.key
    ? installedKeys.has(desired.key)
    : false;
  return {
    kind: "connector-definition",
    // "update" (re-push) when already installed; `install_connector` is
    // idempotent and reports `updated:false` if the code is unchanged.
    verb: installedRemotely ? "update" : "create",
    id,
    desired,
    installedRemotely,
  };
}

function diffAuthProfile(
  desired: DesiredAuthProfile,
  remote: RemoteAuthProfile | undefined
): AuthProfileDiffRow {
  if (!remote) {
    return {
      kind: "auth-profile",
      verb: "create",
      id: desired.slug,
      desired,
      needsAuth: INTERACTIVE_AUTH_KINDS.has(desired.kind),
    };
  }
  // `connector` / `kind` are immutable — `update_auth_profile` can't change
  // them, so reusing a slug for a different connector/kind would silently push
  // credentials into the wrong profile. Hard-stop instead.
  if (
    remote.connector_key !== desired.connector ||
    remote.profile_kind !== desired.kind
  ) {
    throw new ValidationError(
      `${desired.sourceFile}: auth_profile "${desired.slug}" is bound to ${remote.connector_key}/${remote.profile_kind} remotely, but the manifest declares ${desired.connector}/${desired.kind} — delete it manually or use a new slug`
    );
  }
  const changed: string[] = [];
  if ((desired.name ?? "") !== (remote.display_name ?? "")) {
    changed.push("name");
  }
  // Credentials can't be read back from the server (write-only secrets). For
  // non-interactive kinds with declared credentials, always re-push them
  // (idempotent) so rotated secrets propagate — show as a redacted "credentials"
  // change. Interactive kinds never carry credentials in the manifest.
  const declaresCredentials =
    !INTERACTIVE_AUTH_KINDS.has(desired.kind) &&
    desired.credentials !== undefined &&
    Object.keys(desired.credentials).length > 0;
  if (declaresCredentials) changed.push("credentials");
  const needsAuth =
    INTERACTIVE_AUTH_KINDS.has(desired.kind) && remote.status !== "active";
  if (changed.length === 0 && !needsAuth) {
    return {
      kind: "auth-profile",
      verb: "noop",
      id: desired.slug,
      desired,
      remote,
    };
  }
  return {
    kind: "auth-profile",
    verb: changed.length > 0 ? "update" : "noop",
    id: desired.slug,
    desired,
    remote,
    ...(changed.length > 0 ? { changedFields: changed } : {}),
    ...(needsAuth ? { needsAuth: true } : {}),
  };
}

function diffConnection(
  desired: DesiredConnection,
  remote: RemoteConnection | undefined
): ConnectionDiffRow {
  if (!remote) {
    return {
      kind: "connection",
      verb: "create",
      id: desired.slug,
      desired,
    };
  }
  // `connector` is immutable — `update` can't change `connector_key`, so a
  // slug bound to a different connector remotely must be a hard error, never
  // an "update" that mutates auth/config on the wrong connector.
  if (remote.connector_key !== desired.connector) {
    throw new ValidationError(
      `${desired.sourceFile}: connection "${desired.slug}" is bound to connector "${remote.connector_key}" remotely, but the manifest declares "${desired.connector}" — delete it manually or use a new slug`
    );
  }
  return buildDiffRow<
    DesiredConnection,
    RemoteConnection,
    "connection",
    ConnectionField
  >({
    kind: "connection",
    id: desired.slug,
    desired,
    remote,
    fields: tableToFields(CONNECTION_FIELDS),
  }) as ConnectionDiffRow;
}

function diffFeed(
  connectionSlug: string,
  desired: DesiredFeed,
  remote: RemoteFeed | undefined
): FeedDiffRow {
  return buildDiffRow<DesiredFeed, RemoteFeed, "feed", FeedField>({
    kind: "feed",
    id: `${connectionSlug}/${desired.feedKey}`,
    desired,
    remote,
    extras: { connectionSlug },
    fields: tableToFields(FEED_FIELDS),
  }) as unknown as FeedDiffRow;
}

/**
 * Diff one org inference provider. The API key is write-only (never read back),
 * so a declared key always marks the row for a re-push (idempotent PUT) — this
 * alone escalates a create, and on an existing provider is folded into whether
 * the row counts as an update. Capability blocks are compared per-modality; any
 * modality that is new or differs is listed in `capabilityModalities` for apply
 * to PUT. `kind`/`displayName` changes also count as an update.
 */
function diffInferenceProvider(
  desired: DesiredOrgProvider,
  remote: RemoteInferenceProvider | undefined
): InferenceProviderDiffRow {
  const keyDeclared = desired.apiKey.length > 0;

  if (!remote) {
    return {
      kind: "inference-provider",
      verb: "create",
      id: desired.slug,
      desired,
      keyDeclared,
      capabilityModalities: Object.keys(
        desired.capabilities
      ) as InferenceModality[],
    };
  }

  // `kind` and `displayName` are immutable after create: the server exposes no
  // update path for them (only per-modality capabilities + key rotation). Diffing
  // them here would push a change `executePlan` can't persist, so the drift would
  // resurface on every apply. `kind` is load-bearing (provider type ↔ credential),
  // so a mismatch is a hard error; `displayName` is cosmetic and simply not diffed.
  if (desired.kind !== remote.kind) {
    throw new ValidationError(
      `Inference provider "${desired.slug}" has kind "${desired.kind}" but the server has "${remote.kind}". ` +
        `A provider's kind is immutable — delete and recreate it under a new slug to change the type.`
    );
  }

  const changed: string[] = [];

  // Per-modality capability comparison. Only modalities the config declares are
  // considered — an omitted modality means "no opinion" and never churns.
  const capabilityModalities: InferenceModality[] = [];
  for (const [modality, block] of Object.entries(desired.capabilities) as [
    InferenceModality,
    InferenceCapabilityBlock,
  ][]) {
    if (!deepEqual(block, remote.capabilities?.[modality] ?? {})) {
      capabilityModalities.push(modality);
    }
  }
  if (capabilityModalities.length > 0) changed.push("capabilities");

  // A write-only key can't be diffed, so a declared key always warrants a
  // re-push — surface that as an update so the plan isn't a silent noop.
  const verb: DiffVerb = changed.length > 0 || keyDeclared ? "update" : "noop";

  return {
    kind: "inference-provider",
    verb,
    id: desired.slug,
    desired,
    remote,
    ...(changed.length > 0 ? { changedFields: changed } : {}),
    keyDeclared,
    ...(capabilityModalities.length > 0 ? { capabilityModalities } : {}),
  };
}

// ── Top-level diff ─────────────────────────────────────────────────────────

export interface RemoteSnapshot {
  agents: RemoteAgent[];
  /** keyed by agentId */
  agentSettings: Map<string, AgentSettings | null>;
  entityTypes: RemoteEntityType[];
  relationshipTypes: RemoteRelationshipType[];
  automations: RemoteAutomation[];
  connectorDefinitions: RemoteConnectorDefinition[];
  authProfiles: RemoteAuthProfile[];
  connections: RemoteConnection[];
  /** Feeds keyed by connection ID. */
  feedsByConnectionId: Map<number, RemoteFeed[]>;
  /** Org-owned inference providers (from `GET /inference-providers`). */
  inferenceProviders: RemoteInferenceProvider[];
}

/**
 * The subset of {@link DesiredState} the diff consumes — everything except the
 * apply-only knobs (prune flag, org metadata, requiredSecrets).
 */
type DesiredStateForDiff = Pick<
  DesiredState,
  "agents" | "memorySchema" | "automations" | "connectors" | "providers"
>;

interface ComputeDiffOptions {
  /** Limit the diff to a subset of resource kinds. */
  only?: "agents" | "memory";
  /**
   * When true, the config declares `prune: true`: it's the source of truth for
   * *definitions*, so a remote definition (entity type, relationship type,
   * automation, connector definition) absent from desired is emitted as a `delete`
   * row instead of an ignored `drift` — INCLUDING definitions created via the
   * dashboard/API. Data (entity/relationship instances), connections, auth
   * profiles, feeds, and agents are never pruned. Default (false)
   * reports those remote-only definitions as `drift`.
   */
  prune?: boolean;
  /**
   * Target org id. The entity/relationship-type list endpoints also return
   * *public* definitions owned by OTHER orgs, which this org neither manages
   * nor can delete — so a remote type whose `organization_id` differs is
   * excluded from drift/delete entirely. Omit to disable the filter (tests).
   */
  orgId?: string;
  /**
   * Attribution baseline (the last succeeded deployment's effective-remote
   * snapshot + owned incarnation identities). When recorded, entity/rel types
   * and Automations get the three-way compare: block when the remote moved
   * (`remote ≠ attribution` AND `desired ≠ remote`), converge only when the
   * config moved (`remote == attribution`). Without a recorded baseline,
   * declared definitions use the ordinary two-way diff; remote-only prune
   * candidates block because ownership cannot be proven.
   */
  baseline?: Baseline;
}

export function computeDiff(
  desired: DesiredStateForDiff,
  remote: RemoteSnapshot,
  opts: ComputeDiffOptions = {}
): DiffPlan {
  const rows: DiffRow[] = [];
  const only = opts.only;
  const prune = opts.prune ?? false;
  const baseline = opts.baseline;
  // A remote entity/relationship type is this org's to manage (drift/prune)
  // only when it's org-owned. The list endpoints also surface public types
  // from other orgs (`organization_id` differs) — never drift or delete those.
  const orgId = opts.orgId;
  const ownsDefinition = (definitionOrgId: string | undefined): boolean =>
    orgId === undefined ||
    definitionOrgId === undefined ||
    definitionOrgId === orgId;
  // Platform-owned entity types must NEVER be pruned (`$` slug prefix).
  const isSystemSlug = (slug: string): boolean => slug.startsWith("$");
  // Automations the platform/connectors create outside the config (e.g. Slack
  // chat-link bindings) carry a `system:<kind>` tag and are NOT config-owned.
  // They must never block an apply or be pruned — like Terraform, unmanaged
  // resources are ignored, not fought.
  const isSystemTagged = (tags: string[] | null | undefined): boolean =>
    (tags ?? []).some((t) => t.startsWith("system:"));
  const isSystemAutomation = (automation: RemoteAutomation): boolean =>
    isSystemSlug(automation.slug) || isSystemTagged(automation.tags);

  if (only !== "memory") {
    const remoteByAgent = new Map(remote.agents.map((a) => [a.agentId, a]));
    const desiredAgentIds = new Set(
      desired.agents.map((a) => a.metadata.agentId)
    );

    for (const agent of desired.agents) {
      const remoteAgent = remoteByAgent.get(agent.metadata.agentId);
      rows.push(diffAgent(agent.metadata, remoteAgent));

      const settingsRow = diffSettings(
        agent.metadata.agentId,
        agent.settings,
        remote.agentSettings.get(agent.metadata.agentId) ?? null
      );
      // If the agent itself is new, escalate the matching settings row to
      // `create` — that's the operator's mental model: the settings are part
      // of the agent's creation, not a follow-up update.
      if (!remoteAgent && settingsRow.verb !== "noop") {
        rows.push({ ...settingsRow, verb: "create" });
      } else if (!remoteAgent) {
        // No desired-side fields set; still emit a create row so the plan
        // shows the apply step actually happens.
        rows.push({ ...settingsRow, verb: "create" });
      } else {
        rows.push(settingsRow);
      }
    }

    // Drift: remote agents not in desired state. v1 reports, never deletes.
    for (const remoteAgent of remote.agents) {
      if (!desiredAgentIds.has(remoteAgent.agentId)) {
        rows.push({
          kind: "agent",
          verb: "drift",
          id: remoteAgent.agentId,
          remote: remoteAgent,
        });
      }
    }
  }

  if (only !== "agents") {
    // Restrict entity/relationship types to the ones THIS org owns, for both
    // matching and prune. The list endpoints also return public types from
    // other orgs; the server returns them after the org's own rows, so a naive
    // slug→row Map would let a foreign public type shadow the org's own
    // definition (false noop/update) — and prune must never touch them.
    const ownedEntityTypes = remote.entityTypes.filter((e) =>
      ownsDefinition(e.organization_id)
    );
    const remoteEntityBySlug = new Map(
      ownedEntityTypes.map((e) => [e.slug, e])
    );
    const desiredEntitySlugs = new Set(
      desired.memorySchema.entityTypes.map((e) => e.slug)
    );
    for (const entity of desired.memorySchema.entityTypes) {
      const { row, blocking } = diffEntityTypeWithBaseline(
        entity,
        remoteEntityBySlug.get(entity.slug),
        baseline,
        prune
      );
      rows.push(row);
      rows.push(...blocking);
    }
    for (const remoteEntity of ownedEntityTypes) {
      if (!desiredEntitySlugs.has(remoteEntity.slug)) {
        // Code-managed: delete. The server refuses an entity-type delete while
        // instances exist (the data is exempt), surfacing a clear error.
        // `$…` system types are never pruned or owned-deleted.
        if (isSystemEntityType(remoteEntity)) {
          rows.push({
            kind: "entity-type",
            verb: "drift",
            id: remoteEntity.slug,
            remote: remoteEntity,
          });
          continue;
        }
        rows.push(
          remoteOnlyDefinitionRow(
            "entity-type",
            remoteEntity,
            baseline,
            prune,
            (slug) => {
              // Looked up BY slug, so only the facets can differ.
              const a = baseline?.attribution.entityTypes.find(
                (x) => x.slug === slug
              );
              return (
                !!a &&
                deepEqual(
                  remoteEntityTypeFacets(remoteEntity),
                  remoteEntityTypeFacets(a)
                )
              );
            }
          )
        );
      }
    }

    const ownedRelTypes = remote.relationshipTypes.filter((r) =>
      ownsDefinition(r.organization_id)
    );
    const remoteRelBySlug = new Map(ownedRelTypes.map((r) => [r.slug, r]));
    const desiredRelSlugs = new Set(
      desired.memorySchema.relationshipTypes.map((r) => r.slug)
    );
    for (const rel of desired.memorySchema.relationshipTypes) {
      const { row, blocking } = diffRelationshipTypeWithBaseline(
        rel,
        remoteRelBySlug.get(rel.slug),
        baseline
      );
      rows.push(row);
      rows.push(...blocking);
    }
    for (const remoteRel of ownedRelTypes) {
      if (!desiredRelSlugs.has(remoteRel.slug)) {
        if (isSystemSlug(remoteRel.slug)) {
          rows.push({
            kind: "relationship-type",
            verb: "drift",
            id: remoteRel.slug,
            remote: remoteRel,
          });
          continue;
        }
        rows.push(
          remoteOnlyDefinitionRow(
            "relationship-type",
            remoteRel,
            baseline,
            prune,
            (slug) => {
              // Looked up BY slug, so only the facets can differ.
              const a = baseline?.attribution.relationshipTypes.find(
                (x) => x.slug === slug
              );
              return (
                !!a &&
                deepEqual(
                  remoteRelationshipTypeFacets(remoteRel),
                  remoteRelationshipTypeFacets(a)
                )
              );
            }
          )
        );
      }
    }

    const remoteAutomationBySlug = new Map(
      remote.automations.map((w) => [w.slug, w])
    );
    const desiredAutomationSlugs = new Set(
      desired.automations.map((w) => w.slug)
    );
    for (const automation of desired.automations) {
      const { row, blocking } = diffAutomationWithBaseline(
        automation,
        remoteAutomationBySlug.get(automation.slug),
        baseline
      );
      rows.push(row);
      rows.push(...blocking);
    }
    for (const remoteAutomation of remote.automations) {
      if (!desiredAutomationSlugs.has(remoteAutomation.slug)) {
        if (isSystemAutomation(remoteAutomation)) {
          rows.push({
            kind: "automation",
            verb: "drift",
            id: remoteAutomation.slug,
            remote: remoteAutomation,
          });
          continue;
        }
        rows.push(
          remoteOnlyDefinitionRow(
            "automation",
            {
              slug: remoteAutomation.slug,
              id: remoteAutomation.automation_id,
              name: remoteAutomation.name,
              description: remoteAutomation.description,
            },
            baseline,
            prune,
            (slug) => {
              const a = baseline?.attribution.automations.find(
                (x) => x.slug === slug
              );
              return (
                !!a &&
                deepEqual(
                  projectRemoteAutomation(remoteAutomation),
                  projectRemoteAutomation(a)
                )
              );
            }
          )
        );
      }
    }
  }

  const notes: string[] = [];

  // Connectors run only on a full apply (`--only agents|memory` skips them).
  const desiredConnectors = desired.connectors ?? {
    definitions: [],
    authProfiles: [],
    connections: [],
  };
  // Sort remote collections so drift rows + notes render deterministically
  // regardless of server response ordering.
  const remoteConnectorDefinitions = [
    ...(remote.connectorDefinitions ?? []),
  ].sort((a, b) => a.key.localeCompare(b.key));
  const remoteAuthProfiles = [...(remote.authProfiles ?? [])].sort((a, b) =>
    a.slug.localeCompare(b.slug)
  );
  const remoteConnections = [...(remote.connections ?? [])].sort((a, b) =>
    a.slug.localeCompare(b.slug)
  );
  const remoteFeedsByConnectionId =
    remote.feedsByConnectionId ?? new Map<number, RemoteFeed[]>();
  if (!only) {
    const installedKeys = new Set(
      remoteConnectorDefinitions.filter((d) => d.installed).map((d) => d.key)
    );
    const declaredKeys = declaredConnectorKeys(desiredConnectors.definitions);
    // Connectors referenced by a desired auth profile / connection are (or
    // will be) installed in the org too — bundled ones included — so they
    // aren't "undeclared".
    const referencedKeys = referencedConnectorKeys(desiredConnectors);
    // Auto-discovered `.connector.ts` files whose key the CLI can't know up
    // front (the server compiles them). When any exist, suppress the
    // "undeclared remote connector" notes entirely — we can't tell which
    // remote connector corresponds to which local file.
    const hasUnnamedLocalDefs = desiredConnectors.definitions.some(
      (d) => d.key === null
    );
    for (const def of desiredConnectors.definitions) {
      rows.push(diffConnectorDefinition(def, installedKeys));
    }
    // Bundled connectors referenced by a desired auth-profile / connection that
    // the org doesn't have installed yet — `lobu apply` will install them from
    // the catalog's server-side `source_uri`. Surface them as plan rows so the
    // operator approves these connector-definition mutations too. (Skipped when
    // a locally-supplied connector declares the same key — that one wins.)
    const installableByKey = new Map(
      remoteConnectorDefinitions
        .filter((d) => d.installable && (d.source_uri || d.managed_mcp_source))
        .map((d) => [d.key, d])
    );
    for (const key of [...referencedKeys].sort()) {
      if (declaredKeys.has(key)) continue; // a local def supplies this key
      const entry = installableByKey.get(key);
      if (installedKeys.has(key)) {
        if (entry?.managed_mcp_source) {
          rows.push({
            kind: "connector-definition",
            verb: "update",
            id: key,
          });
        }
        continue;
      }
      if (!entry?.source_uri && !entry?.managed_mcp_source) continue;
      rows.push({
        kind: "connector-definition",
        verb: "create",
        id: key,
        // No `desired` — this is a bundled install, handled by
        // `installConnectorDefinitions`'s bundled-referenced loop, not the
        // plan-row loop. The render falls back to `id` (the connector key).
      });
    }
    // Connector keys still wired to a surviving remote connection / auth profile.
    // Those are exempt from prune, so their connector must not be deleted —
    // uninstalling it would orphan the connection.
    const liveConnectorKeys = new Set<string>([
      ...remoteConnections.map((c) => c.connector_key),
      ...remoteAuthProfiles.map((p) => p.connector_key),
    ]);
    // Remote connector definitions not declared/referenced locally. Code-managed
    // orgs delete them; UI-managed orgs just get a note (never auto-uninstall).
    // Suppressed entirely when any local `*.connector.ts` has an unresolved key
    // (`null`) — we can't tell which remote def corresponds to which local file.
    if (!hasUnnamedLocalDefs) {
      for (const def of remoteConnectorDefinitions) {
        if (!def.installed) continue;
        if (declaredKeys.has(def.key) || referencedKeys.has(def.key)) {
          continue;
        }
        if (prune && !liveConnectorKeys.has(def.key)) {
          // With a baseline, only delete connectors THIS config applied
          // (owned incarnation) whose version is still the one we recorded —
          // a post-baseline edit (new version on the same row id) is both-moved
          // and blocks. A UI-created/unowned connector is never auto-deleted.
          const owned =
            baseline?.owned.has(ownedKey("connector-definition", def.id)) ??
            false;
          const versionAtBaseline = baseline?.connectorVersions?.[def.key];
          const editedAfterBaseline =
            owned &&
            versionAtBaseline !== undefined &&
            def.version !== undefined &&
            versionAtBaseline !== def.version;
          // Uninstall only when a recorded baseline proves this incarnation is
          // owned; otherwise the blocking row preserves it.
          if (baseline?.recorded && owned && !editedAfterBaseline) {
            rows.push({
              kind: "connector-definition",
              verb: "delete",
              id: def.key,
            });
          } else {
            rows.push({
              kind: "connector-definition",
              verb: "drift",
              blocking: true,
              id: def.key,
              remote: def,
            } as DiffRow);
          }
        } else {
          notes.push(
            `connector "${def.key}" is installed remotely but not declared in connectors/ — uninstall it manually if it's no longer wanted (lobu apply never auto-uninstalls connectors).`
          );
        }
      }
    }

    const remoteAuthBySlug = new Map(
      remoteAuthProfiles.map((p) => [p.slug, p])
    );
    const desiredAuthSlugs = new Set(
      desiredConnectors.authProfiles.map((p) => p.slug)
    );
    for (const profile of desiredConnectors.authProfiles) {
      rows.push(diffAuthProfile(profile, remoteAuthBySlug.get(profile.slug)));
    }
    for (const remoteProfile of remoteAuthProfiles) {
      if (!desiredAuthSlugs.has(remoteProfile.slug)) {
        rows.push({
          kind: "auth-profile",
          verb: "drift",
          id: remoteProfile.slug,
          remote: remoteProfile,
        });
      }
    }

    const remoteConnBySlug = new Map(remoteConnections.map((c) => [c.slug, c]));
    const desiredConnSlugs = new Set(
      desiredConnectors.connections.map((c) => c.slug)
    );
    for (const conn of desiredConnectors.connections) {
      const remoteConn = remoteConnBySlug.get(conn.slug);
      rows.push(diffConnection(conn, remoteConn));
      // Nested feeds — diffed by feed_key within the connection. Only diffable
      // when the connection already exists remotely; for a new connection the
      // feeds are created right after the connection-creation step.
      const remoteFeeds = remoteConn
        ? [...(remoteFeedsByConnectionId.get(remoteConn.id) ?? [])].sort(
            (a, b) => a.feed_key.localeCompare(b.feed_key)
          )
        : [];
      const remoteFeedByKey = new Map(remoteFeeds.map((f) => [f.feed_key, f]));
      const desiredFeedKeys = new Set(conn.feeds.map((f) => f.feedKey));
      for (const feed of conn.feeds) {
        rows.push(diffFeed(conn.slug, feed, remoteFeedByKey.get(feed.feedKey)));
      }
      for (const remoteFeed of remoteFeeds) {
        if (!desiredFeedKeys.has(remoteFeed.feed_key)) {
          rows.push({
            kind: "feed",
            verb: "drift",
            id: `${conn.slug}/${remoteFeed.feed_key}`,
            connectionSlug: conn.slug,
            remote: remoteFeed,
          });
        }
      }
    }
    for (const remoteConn of remoteConnections) {
      if (!desiredConnSlugs.has(remoteConn.slug)) {
        rows.push({
          kind: "connection",
          verb: "drift",
          id: remoteConn.slug,
          remote: remoteConn,
        });
      }
    }
  }

  // Org-owned inference providers. Full-apply only (org-scoped, neither
  // "agents" nor "memory"). A provider in the config but not remote → create; a
  // matching one whose capabilities/kind/displayName differ (or that declares a
  // key, which is write-only and always re-pushed) → update; a remote provider
  // absent from the config → drift (NEVER delete: an org credential is
  // destructive to remove, so drop it in the UI/API, not via apply).
  if (only === undefined) {
    // `?? []` mirrors the `desired.connectors ?? {…}` defensive default above —
    // test literals build a partial DesiredStateForDiff.
    const desiredProviders = desired.providers ?? [];
    const remoteProviders = remote.inferenceProviders ?? [];
    const remoteProviderBySlug = new Map(
      remoteProviders.map((p) => [p.slug, p])
    );
    const desiredProviderSlugs = new Set(desiredProviders.map((p) => p.slug));
    for (const provider of desiredProviders) {
      rows.push(
        diffInferenceProvider(provider, remoteProviderBySlug.get(provider.slug))
      );
    }
    for (const remoteProvider of remoteProviders) {
      if (!desiredProviderSlugs.has(remoteProvider.slug)) {
        rows.push({
          kind: "inference-provider",
          verb: "drift",
          id: remoteProvider.slug,
          remote: remoteProvider,
        });
      }
    }
  }

  const counts = { create: 0, update: 0, noop: 0, drift: 0, delete: 0 };
  for (const row of rows) counts[row.verb]++;

  notes.sort();
  return { rows, counts, notes };
}
