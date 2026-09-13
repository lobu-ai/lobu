/**
 * Declarative authoring API. Each `define*` returns a branded plain object that
 * doubles as a typed handle (e.g. an {@link EntityType} can be passed to
 * {@link defineRelationshipType}, an {@link Agent} to {@link defineAutomation}).
 *
 * These are pure data producers with no side effects — `lobu apply` imports the
 * entrypoint, reads the {@link Project} default export, and maps it to the
 * server's desired state. Executable handlers (connector `sync`/`execute`,
 * Automation reactions) live in their own modules; these objects only declare
 * config and references.
 */

import type {
  AutomationEventTrigger,
  AutomationScheduleTrigger,
  AutomationWorkspaceEventTrigger,
  ConnectorClass,
  ConnectorRuntime,
  Dimension,
  EventSet,
  Measure,
  ReactionClient,
  AutomationScriptContext,
  ReactionContext,
  Segment,
} from "@lobu/connector-sdk";
import {
  Kind,
  OptionalKind,
  Type,
  type StringOptions,
  type TOptional,
  type TSchema,
  type TString,
} from "@sinclair/typebox";
import type { SecretRef } from "./secret.js";

/** A connector referenced by its key, or by the class produced by `defineConnector`. */
export type ConnectorRef = string | ConnectorClass;

// ---------------------------------------------------------------------------
// Memory schema
// ---------------------------------------------------------------------------

/**
 * Makes an entity type **derived**: its rows are a read-only SQL view over other
 * relations (events, other entities) instead of inserted/validated rows.
 *
 * Presence is the discriminant: an entity type with `backing` is derived; without
 * it, it is **stored** (the default — a curated entity like a Company or a
 * hand-named Trip). There is no separate `mode` field — "derived" just means
 * "has a view". Read a derived type's rows by running its SQL through `query_sql`.
 * NOTE: with the declared metric layer (see {@link Measure}), measures/dimensions
 * are DECLARED, not inferred on read — a derived type is in the metric catalog
 * only if it declares them.
 */
export interface EntityBacking {
  /** ANSI SELECT over other relations (events, entities, …). */
  sql: string;
  /**
   * Optional connection slug. When set, `sql` runs LIVE against that connection's
   * single external database (read-only, no copy) instead of Lobu's internal
   * store — see {@link defineConnection}. Omitted ⇒ the view runs over internal
   * events/entities (the default). Single-database only: `sql` may reference only
   * tables that exist in the bound connection's database.
   */
  connection?: string;
}

// ---------------------------------------------------------------------------
// Entity-bound metrics — the contract types live in `@lobu/connector-sdk`
// (shared by CLI authoring, connector federation, and server compile/validate;
// the config module may not import `@lobu/core` — see config-isolation.test.ts).
// Re-exported here so configs can import them alongside `defineEntityType`.
// ---------------------------------------------------------------------------
export type {
  Dimension,
  EventSet,
  FactMatchRule,
  Measure,
  MetricReadMode,
  MetricTier,
  Segment,
} from "@lobu/connector-sdk";

/**
 * An event kind (semantic type) declared on an entity type — its metadata
 * contract and optional render template. Mirrors the server's stored
 * `entity_types.event_kinds` shape and a connector feed's `eventKinds`.
 */
export interface EntityEventKind {
  /** Human description of the kind. */
  description?: string;
  /** JSON Schema for the event's metadata. Also the source of the default render template. */
  metadataSchema?: Record<string, unknown>;
  /**
   * Optional authored render template (render-DSL root node). When omitted,
   * events of this kind render a default field card built from `metadataSchema`.
   */
  jsonTemplate?: Record<string, unknown>;
  /**
   * Presentation-neutral user interactions declared by this kind. A template
   * references a key as `@name`; activating it appends the configured event.
   */
  interactions?: Record<string, { emits: string }>;
}

/**
 * The row handed to a write rule, one per row in the write.
 *
 * `patch` is the fully MERGED value set, not a delta — every key of the object
 * is present on every write, most of them carrying unchanged values. Use
 * {@link EntityWriteRow.changed}, which compares values, rather than inspecting
 * `patch` for a key.
 */
export interface EntityWriteRow<Fields = Record<string, unknown>> {
  /** The row as committed, read under its write lock. `{}` for a create. */
  committed: Partial<Fields> & Record<string, unknown>;
  /** The EFFECTIVE merged values — post approval-hold, so held fields are gone. */
  patch: Partial<Fields> & Record<string, unknown>;
  /** `{ ...committed, ...patch }`, i.e. the row as it would commit. */
  next: Partial<Fields> & Record<string, unknown>;
  /**
   * Deletes and merges use the existing row-shaped contract: they arrive as
   * `op: "update"` with `$deleted` or `$merged_into` changing respectively.
   */
  op: "create" | "update";
  /**
   * True when `field`'s value differs between {@link committed} and
   * {@link next}. Compared structurally, with `undefined` and `null` treated as
   * the same absence.
   *
   * This is a value comparison rather than a presence check because `patch` is
   * the merged value set: every field of the object arrives on every write, so
   * "is this key present" would be true for writes that never touched it.
   */
  changed: (field: string) => boolean;
  /** Reject the write. Terminal: nothing after it in the rule runs. */
  deny: (reason: string) => never;
  /**
   * Hold the write for human approval. The whole write is held, never part of
   * it — `fields` names what triggered the review, for the approver to read.
   * May be called more than once per row: the field sets are unioned and the
   * reasons joined, so every call's fields are recorded. A later `deny` wins.
   */
  escalate: (fields: string | string[], reason: string) => void;
}

/**
 * The shape a write-rule module's default export must satisfy. Used to
 * type-check the `<Rule>` generic on {@link rulesFromFile}.
 */
export type EntityWriteRule<Fields = Record<string, unknown>> = (
  row: EntityWriteRow<Fields>
) => void | Promise<void>;

/**
 * A local write-rule source file, compiled server-side at apply time and run at
 * the entity write seam. Carries only the path as plain data — the module is
 * NOT imported at config-eval time. Mirrors {@link ReactionSource}.
 */
export interface EntityRulesSource {
  readonly kind: "entityRulesSource";
  /** Path to the rule module, relative to the config file. */
  path: string;
}

/**
 * Reference a local write-rule file to compile + ship at apply time.
 *
 * ```ts
 * import type invoiceRules from "./rules/invoice.ts";
 * rules: rulesFromFile<typeof invoiceRules>("./rules/invoice.ts"),
 * ```
 *
 * A rule may only NARROW what is allowed — `deny` and `escalate`, no `allow`.
 * It runs at the physical writer, so it binds every caller equally: an agent,
 * the API and a connector sync all reach the same seam.
 */
export function rulesFromFile<
  _Rule extends EntityWriteRule<never> = EntityWriteRule<never>,
>(path: string): EntityRulesSource {
  return { kind: "entityRulesSource", path };
}

export interface EntityType {
  readonly kind: "entityType";
  /** Stable slug — diff key. */
  key: string;
  name?: string;
  description?: string;
  /** Required property names for the entity's metadata. Omit when the properties
   * use `field()`/TypeBox — the required list is then derived from which fields
   * are not marked `optional`. An explicit list always wins. */
  required?: string[];
  /**
   * JSON Schema properties for the entity's metadata. Author with the `field()`
   * shorthand (or bare TypeBox `Type.*` schemas) for labels, table-column
   * placement, and per-field optionality; raw JSON Schema objects stay valid.
   */
  properties?: Record<string, unknown>;
  /**
   * Event kinds (semantic types) valid for events linked to this entity type,
   * keyed by semantic_type. Declares each kind's metadata contract + optional
   * render template; applied declaratively so event types are git-audited like
   * the rest of the schema (mirrors a connector feed's `eventKinds`).
   */
  eventKinds?: Record<string, EntityEventKind>;
  /**
   * Write rules for this type, referenced with {@link rulesFromFile}. Compiled
   * server-side on apply and enforced at the entity write seam, so an illegal
   * state is rejected regardless of which caller proposed it.
   */
  rules?: EntityRulesSource;
  /**
   * Entity-resolution policy (the `x-lobu-resolution` metadata_schema key the
   * server reads to decide whether duplicate entities sharing a normalized
   * identity auto-merge or queue human review). Declared here so the policy is
   * git-audited like the rest of the schema; `lobu apply` folds it into the
   * type's metadata_schema. A rule's `fields` are metadata keys or identity
   * namespaces (e.g. `email`), `normalizer` is `email` | `phone` | `exact`, and
   * `onMatch` is `auto_merge` | `review`. When the key is absent, `person`
   * falls back to email/phone review rules; other entity types have no rules.
   */
  resolutionPolicy?: {
    rules: Array<{
      fields: string[];
      normalizer: "email" | "phone" | "exact";
      onMatch: "auto_merge" | "review";
    }>;
  };
  /**
   * Default view template (render-DSL root node, optionally with a `data_sources`
   * key) for this entity type's detail page. Applied declaratively and
   * git-audited. Under `prune`, omitting it clears any existing template (the
   * page falls back to the schema-derived default); without prune, omitting it
   * leaves a UI-authored template untouched.
   */
  viewTemplate?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /**
   * Present only for DERIVED types — a read-only SQL view (`{ sql }`). Omitted ⇒
   * the type is stored (the default; rows are inserted/validated). Presence is
   * the only discriminant; there is no separate `mode` field.
   */
  backing?: EntityBacking;
  /**
   * How events resolve to this entity, at named grains (the join key). The
   * compiler lowers `eventSets` + `measures` into backing SQL.
   */
  eventSets?: Record<string, EventSet>;
  /**
   * Governed aggregations. DECLARED — there is no on-read inference; an entity is
   * in the metric catalog only if it declares `measures`.
   */
  measures?: Record<string, Measure>;
  /** Governed group-bys. */
  dimensions?: Record<string, Dimension>;
  /** Reusable named population filters. */
  segments?: Record<string, Segment>;
}

/**
 * Entity property shorthand — a JSON Schema field with Lobu's display metadata
 * attached. Emits a TypeBox schema, so it composes with `Type.*` and
 * `Type.Object({...})` and survives `JSON.stringify` as a plain JSON Schema
 * object.
 *
 * The common case is a string column shown in the admin table — just the label:
 *
 * ```ts
 * properties: {
 *   name: field("Name"),                                     // string column
 *   stage: field("Stage", { enum: ["signal", "trial", "customer"] }),
 *   seats: field(Type.Integer(), "Seats"),                   // non-string column
 *   x_handle: field("X", { column: false }),                 // labeled, not a column
 *   email: field("Email", { optional: true }),               // optional (derived required)
 *   notes: Type.String(),                                    // bare TypeBox stays valid
 * }
 * ```
 *
 * `opts` are TypeBox string-schema options plus `column` (show as a table
 * column; default true) and `optional` (wrap in `Type.Optional`, which marks
 * the field optional in the entity's derived `required` array).
 */
export function field(
  label: string,
  opts: FieldOptions & { optional: true }
): TOptional<TString>;
export function field(
  label: string,
  opts?: FieldOptions & { optional?: false }
): TString;
export function field(
  label: string,
  opts: FieldOptions
): TString | TOptional<TString>;
/** Any TypeBox schema as a labeled table column — `field(Type.Integer(), "Seats")`. */
export function field<T extends TSchema>(schema: T, label: string): T;
export function field(
  labelOrSchema: string | TSchema,
  labelOrOpts?: string | FieldOptions
): TSchema {
  if (typeof labelOrSchema === "string") {
    const label = labelOrSchema;
    const opts = (labelOrOpts ?? {}) as FieldOptions;
    const { column, optional, ...schemaOpts } = opts;
    const base = Type.String({
      "x-table-label": label,
      ...(column !== false ? { "x-table-column": true } : {}),
      ...schemaOpts,
    });
    return optional ? Type.Optional(base) : base;
  }
  return {
    ...labelOrSchema,
    "x-table-label": String(labelOrOpts),
    "x-table-column": true,
  } as TSchema;
}

export interface FieldOptions extends StringOptions {
  /** Show this field as a column in the admin table. Default true. */
  column?: boolean;
  /** Make the field optional. Default false. Emits `Type.Optional(...)`. */
  optional?: boolean;
}

function isTypeBoxSchema(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { [Kind]?: unknown })[Kind] !== undefined
  );
}

function isOptionalSchema(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { [OptionalKind]?: unknown })[OptionalKind] !== undefined
  );
}

/**
 * Derive the entity's `required` list from its property schemas when the author
 * uses `field()`/TypeBox and supplies no explicit list: every field not wrapped
 * in `Type.Optional` is required. An explicit `required` always wins, and raw
 * JSON-Schema properties (no TypeBox types) keep today's all-optional default.
 */
function deriveRequired(
  required: string[] | undefined,
  properties: Record<string, unknown> | undefined
): string[] | undefined {
  if (required || !properties) return required;
  const usesTypeBox = Object.values(properties).some(isTypeBoxSchema);
  if (!usesTypeBox) return undefined;
  const derived = Object.entries(properties)
    .filter(([, schema]) => !isOptionalSchema(schema))
    .map(([key]) => key);
  return derived.length > 0 ? derived : undefined;
}

export function defineEntityType(config: Omit<EntityType, "kind">): EntityType {
  const { required, properties, ...rest } = config;
  const resolvedRequired = deriveRequired(required, properties);
  return {
    ...rest,
    kind: "entityType",
    ...(properties !== undefined
      ? { properties: stripSymbols(properties) }
      : {}),
    ...(resolvedRequired ? { required: resolvedRequired } : {}),
  };
}

/** Deep JSON round-trip drops TypeBox symbol keys (`Kind`, `Optional`), so the
 * stored properties stay pure JSON Schema and the apply diff against the remote
 * metadata_schema never churns on invisible symbol keys. */
function stripSymbols(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export interface RelationshipType {
  readonly kind: "relationshipType";
  key: string;
  name?: string;
  description?: string;
  /** Allowed source/target entity types (handle or slug). */
  rules?: Array<{ source: EntityType | string; target: EntityType | string }>;
  metadata?: Record<string, unknown>;
}

export function defineRelationshipType(
  config: Omit<RelationshipType, "kind">
): RelationshipType {
  return { ...config, kind: "relationshipType" };
}

// ---------------------------------------------------------------------------
// Connections & auth profiles (code declares wiring; the UI performs OAuth)
// ---------------------------------------------------------------------------

export type AuthProfileKind =
  | "env"
  | "oauth_app"
  | "oauth_account"
  | "browser_session";

export interface AuthProfile {
  readonly kind: "authProfile";
  /** Stable slug — diff key. */
  slug: string;
  connector: ConnectorRef;
  authKind: AuthProfileKind;
  name?: string;
  /**
   * Credential references. Values are `secret(...)` refs (or literal `$VAR`
   * strings). Only meaningful for `env` / `oauth_app`; the OAuth grant for
   * `oauth_account` / `browser_session` is performed at runtime in the UI.
   */
  credentials?: Record<string, string | SecretRef>;
}

export function defineAuthProfile(
  config: Omit<AuthProfile, "kind">
): AuthProfile {
  return { ...config, kind: "authProfile" };
}

export interface ConnectionFeed {
  /** Feed key from the connector definition. */
  feed: string;
  name?: string;
  /**
   * Sync cadence, with three distinct states:
   *   - a cron string — this config owns the cadence and sets it
   *   - `null`        — this config owns the cadence and clears it (manual-only)
   *   - omitted       — this config does NOT manage the cadence; apply leaves
   *                     whatever the feed already has, including a cron set in
   *                     the UI
   * Omitting used to collapse to `null`, so every apply silently wiped crons it
   * had never been told about.
   */
  schedule?: string | null;
  /**
   * Feed instance settings. Declaring this key REPLACES the remote config, so a
   * key you remove disappears; omitting it means this config does not manage
   * the settings and apply leaves the feed's stored config alone.
   */
  config?: Record<string, unknown>;
}

/**
 * Marks a connection as MANAGED by a cloud (public) org. The OAuth grant lives
 * in the cloud: a user joins the public `org`, connects normally (consent
 * against the managed app → a connection owned by them), and the local instance
 * fetches a fresh access token for its own user's connection at runtime via
 * `POST /oauth/connection-token`, authenticating with the instance's cloud PAT
 * (`LOBU_CLOUD_PAT`). The managed client secret + refresh token never leave the
 * cloud.
 *
 * The cloud origin is fixed by the instance's `LOBU_CLOUD_URL` — a connection
 * CANNOT supply a URL, so a malicious config can never redirect where the cloud
 * PAT is sent.
 */
export interface ManagedBy {
  /** The cloud (public) org the managed connector lives under. */
  org: string;
  /**
   * Stable slug of the exact caller-owned cloud connection grant. Generated by
   * `lobu init --from-org`; optional only so older single-grant configs continue
   * to work without silently choosing among multiple accounts.
   */
  connectionSlug?: string;
}

export interface Connection {
  readonly kind: "connection";
  /** Stable slug — diff key. */
  slug: string;
  connector: ConnectorRef;
  name?: string;
  /** Runtime/account auth profile (handle or slug). */
  authProfile?: AuthProfile | string;
  /** OAuth-app auth profile (handle or slug). */
  appAuthProfile?: AuthProfile | string;
  /**
   * Connection settings — same rule as a feed's `config`: declaring this key
   * REPLACES the remote config, omitting it leaves the connection's stored
   * settings (including anything set in the UI) alone.
   */
  config?: Record<string, unknown>;
  /**
   * Where this connection's credential lives:
   *   - `byo`: this is a chat connection whose credential is supplied here in
   *     `config` (e.g. `{ botToken: secret("SLACK_BOT_TOKEN") }`). Required
   *     for declarative BYO chat; omit for ordinary data connections. BYO chat
   *     does not support auth profiles, device pinning, or declarative feeds.
   *   - `hosted`: the **hosted Lobu bot** — no `config` needed. `lobu run`
   *     prints a `/lobu link <code>` you redeem by DMing the bot (or in a
   *     channel), which binds an agent by creating a message Automation. Only
   *     valid for slack/telegram. Hosted declarations do not support auth
   *     profiles, device pinning, or declarative feeds.
   *   - `managed`: an OAuth grant owned by a cloud (public) org; see
   *     {@link ManagedBy}. Set via `managedBy`, not usually by hand.
   */
  credentialMode?: "byo" | "hosted" | "managed";
  /**
   * Hosted chat only (`credentialMode: "hosted"`): which surfaces a
   * `/lobu link` code may bind — a DM with the bot, or a channel. Defaults to
   * `["dm"]`. Ignored for `byo`/`managed` connections.
   */
  surfaces?: Array<"dm" | "channel">;
  /**
   * Hosted chat only: short-lived claim-code TTL in minutes (capped by the
   * hosted API). Defaults to 15. Ignored for `byo`/`managed` connections.
   */
  codeTtlMinutes?: number;
  /**
   * Mark this connection as managed by a cloud (public) org — the grant lives
   * in the cloud and the local instance fetches its token at runtime. See
   * {@link ManagedBy}.
   */
  managedBy?: ManagedBy;
  /** UUID pinning syncs/actions to a specific device worker. */
  deviceWorkerId?: string;
  feeds?: ConnectionFeed[];
}

export function defineConnection(config: Omit<Connection, "kind">): Connection {
  return { ...config, kind: "connection" };
}

/**
 * The shape a connector module's default export must satisfy: a class extending
 * {@link ConnectorRuntime} (`export default class Foo extends ConnectorRuntime
 * {…}`). Used to type-check the `<Connector>` generic on
 * {@link connectorFromFile} against the referenced module.
 */
// The connector's checkpoint/config type params appear in both variance
// positions (the contravariant `sync(ctx: SyncContext<C, F>)` and the covariant
// `SyncResult<C>`), so `any` is the only instantiation that accepts every
// concrete subclass; `unknown`/`never` reject real connectors typed
// `ConnectorRuntime<MyCheckpoint, MyConfig>`. Only the constructor shape is
// load-bearing here, never the type params.
export type ConnectorClassExport = new (
  ...args: never[]
) => ConnectorRuntime<any, any>;

/**
 * A local connector source file to compile and ship at `lobu apply`. Built with
 * {@link connectorFromFile} and listed in {@link Project.connectors}. This is
 * explicit — only listed connectors are compiled and uploaded; there is no
 * `./connectors` directory auto-discovery. Connections reference the connector
 * by key (or its `defineConnector` class), independent of this list.
 */
export interface ConnectorSource {
  readonly kind: "connectorSource";
  /** Path to a `*.connector.ts`, relative to the config file. */
  path: string;
}

/**
 * Reference a local connector source file to compile + ship at apply time.
 *
 * Pass the connector's module type via the generic for go-to-def / rename and a
 * `tsc` error if the module's default export drifts from
 * {@link ConnectorClassExport} (a {@link ConnectorRuntime} subclass):
 *
 * ```ts
 * import type StripeCharges from "./stripe-charges.connector.ts";
 * connectorFromFile<typeof StripeCharges>("./stripe-charges.connector.ts"),
 * ```
 *
 * The `import type` is erased at compile time (zero runtime cost; jiti drops it),
 * so the connector module is never imported during config eval.
 */
export function connectorFromFile<
  _Connector extends ConnectorClassExport = ConnectorClassExport,
>(path: string): ConnectorSource {
  return { kind: "connectorSource", path };
}

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

/**
 * The shape an Automation reaction module's default export must satisfy:
 * `export default async (ctx, client, params?) => …`. Used to type-check the
 * `<Handler>` generic on {@link reactionFromFile} against the referenced module.
 */
export type ReactionHandler = (
  ctx: ReactionContext,
  client: ReactionClient,
  params?: Record<string, unknown>
) => Promise<unknown>;

export type AutomationScriptHandler = (
  ctx: AutomationScriptContext,
  client: ReactionClient,
  params?: Record<string, unknown>
) => Promise<unknown>;

export interface ScriptSource {
  readonly kind: "scriptSource";
  path: string;
  params?: Record<string, unknown>;
}

/** Execute a local TypeScript job directly, with the owning agent's SDK permissions. */
export function scriptFromFile<
  _Handler extends AutomationScriptHandler = AutomationScriptHandler,
>(path: string, params?: Record<string, unknown>): ScriptSource {
  return { kind: "scriptSource", path, ...(params ? { params } : {}) };
}

/**
 * A local reaction source file to compile + run in a sandboxed isolate when the
 * Automation fires. Built with {@link reactionFromFile} and set on
 * {@link Automation.reaction}. Like {@link ConnectorSource}, this carries only the
 * path as plain data — the handler module is NOT imported at config-eval time;
 * `lobu apply` reads the raw source and the server compiles it.
 */
export interface ReactionSource {
  readonly kind: "reactionSource";
  /** Path to a `*.reaction.ts`, relative to the config file. */
  path: string;
}

/**
 * Reference a local reaction source file to compile + ship at apply time.
 *
 * Pass the handler's module type via the generic for go-to-def / rename and a
 * `tsc` error if the module's default export drifts from {@link ReactionHandler}:
 *
 * ```ts
 * import type triage from "./inbound-triage.reaction.ts";
 * reaction: reactionFromFile<typeof triage>("./inbound-triage.reaction.ts"),
 * ```
 *
 * The `import type` is erased at compile time (zero runtime cost; jiti drops it),
 * so the handler module is never imported during config eval.
 */
export function reactionFromFile<
  _Handler extends ReactionHandler = ReactionHandler,
>(path: string): ReactionSource {
  return { kind: "reactionSource", path };
}

export interface AutomationEntityOutput {
  /** Stored entity type (a config handle or slug). */
  entity: EntityType | string;
  /**
   * One to four fields forming one exact composite identity tuple, scoped to
   * this Automation, output name, and entity type. Every row must contain every
   * field as a non-blank string (max 256 UTF-8 bytes), safe integer, or boolean.
   * Field order is significant; use durable source IDs rather than editable
   * labels.
   */
  key: string[];
  /** Optional fields used to build a readable entity name. Defaults to key. */
  name?: string[];
}

export interface AutomationEventOutput {
  /** Semantic type assigned to every standard event draft in this output. */
  event: string;
}

export type AutomationOutput = AutomationEntityOutput | AutomationEventOutput;

/**
 * Declarative event trigger. The persisted API contract uses an integer
 * `connection_id`; config may instead name a stable project connection handle
 * or slug, which `lobu apply` resolves after creating/updating connections.
 */
export type AutomationEventTriggerConfig = Omit<
  AutomationEventTrigger,
  "connection_id"
> & {
  connection_id?: number;
  connection?: Connection | string;
};

export type AutomationTriggerConfig =
  | AutomationEventTriggerConfig
  | AutomationWorkspaceEventTrigger
  | AutomationScheduleTrigger;

export interface Automation {
  readonly kind: "automation";
  /** Stable slug — diff key. */
  slug: string;
  /** Owning agent (handle or id). Every Automation belongs to exactly one agent. */
  agent: Agent | string;
  /** Script job or agent execution. Omitted preserves the stored executor; "agent" clears a script executor. */
  executor?: ScriptSource | "agent";
  name?: string;
  description?: string;
  /**
   * Connector events, declared event outputs from other Automations, and/or a
   * cadence that activate this Automation. Omit for manual-only execution.
   */
  triggers?: AutomationTriggerConfig[];
  /**
   * The task this Automation performs, in plain text — *what to do when it fires*,
   * as distinct from the reusable know-how in {@link Automation.skills}.
   *
   * Delivered to the agent verbatim, with no template expansion; the window's
   * data arrives separately in the knowledge-read payload. Skills are NOT
   * concatenated into it — they ship as files the agent reads on demand — so a
   * prompt saying "draft the brief using deal-brief" works without pasting the
   * skill body here.
   */
  prompt?: string;
  /**
   * Ordered skill names from the owning agent's skill library
   * ({@link Agent.skills}). `lobu apply` resolves each name to its body and
   * pins the pair onto the Automation's version, so a run gets the text as it
   * stood at apply time. Editing the library later does not reach an existing
   * Automation until the next `lobu apply`; re-applying is the explicit upgrade
   * action for a declarative project.
   *
   * Supply {@link Automation.prompt}, `skills`, a {@link Automation.reaction}
   * script, or an {@link Automation.executor} script. Any one is required for schedule triggers, event
   * triggers with execution `"window"`, and Automations with no triggers
   * (manual runs); an event trigger with execution `"turn"` may omit all
   * instruction sources, since the incoming event is the content and a built-in
   * default applies.
   */
  skills?: string[];
  /**
   * Named top-level arrays the Automation persists after each completed window.
   * Entity output schemas live on their entity types; event outputs use Lobu's
   * standard event draft. Event triggers on an Automation with outputs must use
   * execution `"window"`; conversational `"turn"` triggers belong in a
   * separate Automation. Omit for a run-result-only or reaction-only Automation.
   */
  outputs?: Record<string, AutomationOutput> | null;
  /**
   * Named SQL data sources. Value is either a query string or
   * `{ query, context? }` — `context: true` marks a context-only source
   * (included in the Automation payload's `sources` field but not the window's
   * event set).
   */
  sources?: Record<string, string | { query: string; context?: boolean }>;
  minCooldownSeconds?: number;
  tags?: string[];
  /** LLM guidance for the Automation's downstream reaction agent. */
  reactionsGuidance?: string;
  /** Agent-kind override for firings (e.g. "background", "notifier"). */
  agentKind?: string;
  /**
   * UUID pinning this Automation's runs to a specific device worker. Only
   * meaningful together with `agentKind` — the pinned device's local CLI
   * (selected by `agentKind`) executes the run.
   */
  deviceWorkerId?: string;
  /**
   * Model override for managed or device execution. Omit to preserve a stored
   * override; null removes it so execution uses the agent/provider defaults.
   */
  model?: string | null;
  /**
   * A sibling `.ts` reaction script (`./reactions/foo.reaction.ts`) compiled +
   * run in a sandboxed isolate when the Automation fires, built with
   * {@link reactionFromFile}. The script must `export default async (ctx,
   * client, params?) => …` ({@link ReactionHandler}). Kept in its own file (not
   * inline) so your IDE type-checks it; the path must stay under the config
   * directory.
   *
   * Omit to preserve a previously installed reaction. Set explicitly to `null`
   * to remove it — required when switching a reaction-driven Automation to a
   * script executor so the same work is not performed twice.
   */
  reaction?: ReactionSource | null;
}

export function defineAutomation(config: Omit<Automation, "kind">): Automation {
  return { ...config, kind: "automation" };
}

/**
 * Connector event trigger shorthand — *when this happens*. Produces the
 * canonical authoring form, which `lobu apply` normalizes exactly like the raw
 * literal so downstream defaults and connector event-catalog validation stay
 * unchanged.
 *
 * Connector key and event type are separate arguments because connector keys
 * may themselves contain dots (`google.gmail`); a single dotted string would
 * be ambiguous. Pass an array of event types to listen to several on one
 * trigger.
 *
 * ```ts
 * defineAutomation({
 *   slug: "triage",
 *   agent: ops,
 *   triggers: [
 *     on("slack", "message.created", {
 *       connection: supportChannel,          // optional connection handle/slug
 *       match: { channel_id: "#support" },   // optional exact-match filters
 *     }),
 *     every("0 9 * * 1", { timezone: "Europe/Istanbul" }),
 *   ],
 *   prompt: "Triage the incoming request…",
 * })
 * ```
 */
export function on(
  connectorKey: string,
  eventType: string | string[],
  opts?: Omit<
    AutomationEventTriggerConfig,
    "kind" | "source" | "connector_key" | "event_types"
  >
): AutomationEventTriggerConfig {
  return {
    ...opts,
    kind: "event",
    source: "connector",
    connector_key: connectorKey,
    event_types: Array.isArray(eventType)
      ? Array.from(new Set(eventType))
      : [eventType],
  };
}

/**
 * Schedule trigger shorthand — *on a cadence*. Produces the canonical schedule
 * trigger object; downstream cron and timezone validation remains unchanged.
 *
 * ```ts
 * every("0 9 * * 1", { timezone: "Europe/Istanbul" })
 * ```
 */
export function every(
  cron: string,
  opts?: Omit<AutomationScheduleTrigger, "kind" | "cron">
): AutomationScheduleTrigger {
  return { ...opts, kind: "schedule", cron };
}

/**
 * Context source shorthand — reference data handed to the agent for reasoning,
 * never linked into the window's event set. Emits the canonical
 * `{ query, context: true }` source object, so a projected `id` is not
 * interpreted as an `events.id`.
 *
 * ```ts
 * sources: {
 *   recent_events: "SELECT … FROM events …",   // event content (bare string)
 *   candidates: context("SELECT id, … FROM entities …"),  // reference data
 * }
 * ```
 */
export function context(query: string): { query: string; context: true } {
  return { query, context: true };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * Model suffix for a provider with no resolved concrete model. Kept in lockstep
 * with the server's `UNRESOLVED_MODEL_SUFFIX` (a `<slug>/__unresolved__` ref is
 * a restriction sentinel: it keeps the agent gated, never routes, never emits
 * `<slug>/auto`). Duplicated here rather than imported so the CLI never depends
 * on the server package.
 */
export const UNRESOLVED_MODEL_SUFFIX = "__unresolved__";

export interface ProviderConfig {
  /**
   * Provider slug (`openai`, `chatgpt`, an org inference-provider slug, …).
   * REQUIRED — a provider entry with no id is meaningless (it would map to a
   * `/__unresolved__` ref the server rejects).
   */
  id: string;
  /**
   * Concrete model id for this provider (`gpt-5`, or a provider-native id that
   * may itself contain slashes). OPTIONAL: some providers have no catalog
   * default (e.g. ChatGPT) and `lobu init --provider <id>` omits it; a provider
   * with no model maps to the `<slug>/__unresolved__` restriction sentinel in
   * the agent's ordered `models` list (the operator picks a concrete model
   * later). Never emits `<slug>/auto`.
   */
  model?: string;
  key?: string | SecretRef;
}

/** Modalities an org inference provider may declare a capability block for. */
export type InferenceModality = "text" | "image" | "stt" | "tts" | "embedding";

/**
 * Per-modality upstream override for an {@link OrgProvider}. Omit a modality
 * entirely to keep the provider's static (built-in) semantics for it. All fields
 * are optional; the server validates them (base_url must be https:// with no
 * userinfo/query/fragment, models_endpoint a relative path).
 */
export interface InferenceCapabilityBlock {
  /** Full base URL of the OpenAI-compatible endpoint (https:// only). */
  base_url?: string;
  /** Default model id for this modality. */
  model?: string;
  /** Relative path (`/models`) for model discovery. */
  models_endpoint?: string;
}

/**
 * An ORG-owned inference provider, declared at the PROJECT level
 * (`defineConfig({ providers: [...] })`) — NOT under an agent. `lobu apply`
 * reconciles these against the org's `/inference-providers` API: creates a
 * missing provider, updates changed per-modality capability blocks, and rotates
 * the API key when the config declares one (the key can't be read back, so the
 * rotate is idempotent — it is re-pushed on every apply).
 */
export interface OrgProvider {
  /** Stable slug identifying the provider within the org (create/update key). */
  slug: string;
  /** Provider kind, e.g. `openai` — how the gateway talks to the upstream. */
  kind: string;
  /** API key: a `secret(...)` ref or literal `$VAR` string resolved at apply time. */
  key: string | SecretRef;
  /** Optional human-readable display name. */
  displayName?: string;
  /** Optional per-modality upstream overrides. Omit ⇒ static semantics. */
  capabilities?: Partial<Record<InferenceModality, InferenceCapabilityBlock>>;
}

export interface NetworkConfig {
  /** Domains the worker may reach (exact or `.wildcard`). */
  allowed?: string[];
  /** Domains explicitly blocked (takes precedence over `allowed`). */
  denied?: string[];
}

/** Worker-side tool permissions. */
export interface ToolsConfig {
  /**
   * MCP tool grant patterns pre-approved by the operator (e.g.
   * `/mcp/gmail/tools/send_email`), bypassing the in-chat approval card.
   */
  preApproved?: string[];
  allowed?: string[];
  denied?: string[];
  /** Reject tool calls that aren't in `allowed`. */
  strict?: boolean;
}

export interface Agent {
  readonly kind: "agent";
  id: string;
  name?: string;
  description?: string;
  /**
   * Agent directory holding `SOUL.md` / `IDENTITY.md` / `USER.md`. Relative to
   * the config file; defaults to `./agents/<id>`. (Skills are referenced
   * explicitly via {@link Agent.skills}, not auto-discovered from this dir.)
   */
  dir?: string;
  /**
   * Skills this agent can use — built inline with {@link defineSkill} or loaded
   * from a `SKILL.md` with {@link skillFromFile}. Explicit list, no directory
   * auto-discovery; deduped by name.
   */
  skills?: Skill[];
  providers?: ProviderConfig[];
  network?: NetworkConfig;
  tools?: ToolsConfig;
  /** Guardrails enabled for this agent, by registered name. */
  guardrails?: string[];
  /** Nix packages provisioned into the worker environment. */
  nixPackages?: string[];
  // NOTE: the memory schema (entity/relationship types) and connections —
  // including chat connections (slack/telegram, `credentialMode: "byo" |
  // "hosted"`) — are declared at the PROJECT level (`defineConfig({ entities,
  // relationships, connections })`), matching the apply model. Agent binding
  // for a chat connection is an Automation with a channel trigger, not an
  // agent-scoped field here.
}

export function defineAgent(config: Omit<Agent, "kind">): Agent {
  return { ...config, kind: "agent" };
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * A skill an agent can use — an instruction block (`content`). Skills are
 * referenced explicitly from {@link Agent.skills}; there is no directory
 * auto-discovery.
 *
 * Build one of two ways, both producing this same object:
 *   - {@link defineSkill} — inline: `content` is a string, the rest is JSON.
 *   - {@link skillFromFile} — from a `SKILL.md` file (a directory containing
 *     one, or a `.md` path). The loader reads it at `lobu apply` and fills the
 *     fields from its frontmatter + body. `path` is mutually exclusive with the
 *     inline fields.
 *
 * Skills are instruction text only. Packages belong on the agent
 * ({@link Agent.nixPackages}) or on a connector's `agentTooling` — a skill
 * declares none.
 */
export interface Skill {
  readonly kind: "skill";
  /**
   * Skill name — the reference and dedup key. Required for inline skills. For
   * {@link skillFromFile}, derived from the file's frontmatter `name` (or its
   * folder name) when omitted.
   */
  name?: string;
  description?: string;
  /** The skill body (markdown instructions shown to the agent). */
  content?: string;
  /**
   * Load body + frontmatter from a `SKILL.md`, relative to the config file. Set
   * by {@link skillFromFile}; resolved by the loader. Mutually exclusive with
   * the inline fields above.
   */
  path?: string;
}

/** Declare a skill inline — `content` is the body, the rest is JSON frontmatter. */
export function defineSkill(
  config: Omit<Skill, "kind" | "path"> & { name: string }
): Skill {
  return { ...config, kind: "skill" };
}

/**
 * Reference a skill stored as a `SKILL.md` file. `path` is a directory holding
 * `SKILL.md` (or a `.md` file directly), relative to the config file. The
 * loader reads it at apply time; pass `name` to override the frontmatter name.
 */
export function skillFromFile(path: string, opts?: { name?: string }): Skill {
  return { kind: "skill", path, ...(opts?.name ? { name: opts.name } : {}) };
}

// ---------------------------------------------------------------------------
// Project (default export of lobu.config.ts)
// ---------------------------------------------------------------------------

export interface Project {
  readonly kind: "project";
  /** Lobu Cloud org slug this project applies to. */
  org?: string;
  /**
   * When true, `lobu apply` deletes definitions (entity/relationship types,
   * Automations, connector definitions) that are absent from this config —
   * INCLUDING ones created via the dashboard/API. Data, connections, auth
   * profiles, and agents are never pruned. Default false.
   */
  prune?: boolean;
  /** Display name used if `lobu apply` offers to provision the org. */
  orgName?: string;
  /** Org description. */
  orgDescription?: string;
  /** Resolved Lobu Cloud org id — `lobu apply` matches against it. */
  organizationId?: string;
  agents: Agent[];
  entities?: EntityType[];
  relationships?: RelationshipType[];
  connections?: Connection[];
  authProfiles?: AuthProfile[];
  automations?: Automation[];
  /**
   * Org-owned inference providers (`[[providers]]`). Reconciled by `lobu apply`
   * against the org's `/inference-providers` API. NOT pruned: a provider absent
   * from the config is reported as drift (deleting an org credential is
   * destructive), never auto-deleted.
   */
  providers?: OrgProvider[];
  /**
   * Local connector source files (`*.connector.ts`) to compile and ship,
   * built with {@link connectorFromFile}. Explicit list, no `./connectors`
   * auto-discovery; only listed connectors are uploaded.
   */
  connectors?: ConnectorSource[];
}

export function defineConfig(config: Omit<Project, "kind">): Project {
  return { ...config, kind: "project" };
}
