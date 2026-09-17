/**
 * Allowlist schema for query_sql validation.
 *
 * Sensitive columns (credentials, secrets, tokens, embeddings, PII) are
 * excluded. Three layers of enforcement:
 *   1. validateWithSchema() rejects SQL referencing unlisted tables/columns
 *   2. SAFE_COLUMN_DEFS is used by buildScopedQuery to emit explicit column lists
 *      in CTEs, so excluded columns are never reachable even if validation
 *      is bypassed
 *   3. columns that must stay QUERYABLE but carry secret values — the free-form
 *      `config` jsonb on `connections` / `feeds` — carry a redacting `expr`
 *      (see redactedConfigColumn) that the CTE emits in their place. Exclusion
 *      is not an option for those: legitimate operational queries read them.
 *
 * A column is only safe here if it is EXCLUDED or REDACTED. "It's only reachable
 * by admins" is not sufficient — `connections` and `feeds` are deliberately NOT
 * in ADMIN_ONLY_QUERYABLE_TABLES, and query_sql is member-safe.
 *
 * NAMING: relation and column names here are the canonical physical Automation
 * schema names. A column listed here MUST exist on the physical table: `buildColumnList`
 * emits an explicit projection into the generated CTE, so a stale name breaks
 * EVERY query against the relation — including ones that reference no column at
 * all. The drift test pins both directions.
 */

import { REDACTED_SENTINEL } from '@lobu/core';
import { Dialect, ast, parse, validateWithSchema } from '@polyglot-sql/sdk';

export interface ColumnDef {
  name: string;
  type: string;
  /** SQL expression to use in SELECT instead of the bare column name.
   *  When set, CTE generation emits `expr as "name"` (or `alias.expr as "name"`). */
  expr?: string;
}

function cols(...columns: Array<string | ColumnDef>): ColumnDef[] {
  return columns.map((column) =>
    typeof column === 'string' ? { name: column, type: 'text' } : column
  );
}

/**
 * SQL-side redaction for the free-form `config` jsonb on `connections` /
 * `feeds`.
 *
 * `config` cannot simply be dropped from the allowlist — it carries the
 * operational settings every legitimate query reads (host, channel, feed_key
 * options). But it is written VERBATIM by the connection/feed write paths
 * (split by feed SCOPE, never by secrecy), so connector options such as bot and
 * webhook tokens land in it as plaintext; free-form and legacy rows can carry
 * other credentials. `query_sql` is member-safe, and `connections` is
 * deliberately NOT in
 * {@link ADMIN_ONLY_QUERYABLE_TABLES}, so without this a plain member could
 * `SELECT config FROM connections` and read them.
 *
 * This is the CHOKEPOINT: `buildColumnList` emits this expression in the
 * generated CTE, so the redaction applies no matter how the caller shapes the
 * query (aliases, subselects, `->>` extraction — all read the redacted CTE).
 *
 * The denylist mirrors `isSecretKey` in @lobu/core (`secret-redaction`), which
 * is the single source of truth for the TypeScript serializers. String values
 * also fail closed when they contain URI userinfo (`scheme://user:password@`),
 * matching the value-shaped backstop in `deepRedactSecrets`. Keep both rules in
 * sync; `table-schema-redaction.test.ts` pins the key-name rule and URI case.
 *
 * Matching is RECURSIVE (the generated expression rebuilds `jsonb_each` /
 * `jsonb_array_elements` results so nested objects and arrays are walked). A
 * top-level-only pass is not sufficient: a proven repro planted the secret at
 * `config.nested.database.password`.
 *
 * Values are replaced with the sentinel, not deleted, so a query can still see
 * WHICH options are set.
 */
const SQL_SECRET_KEY_PATTERN =
  '(^|_)(token|secret|password|passwd|api_?key|secret_?(access_?)?key|credential|private_?key|refresh_?token|access_?token|client_?secret|session_?id|auth_?header)s?$';
const SQL_SECRET_EXACT_KEYS =
  "('authorization','auth','bearer','cookie','cookies','set_cookie','proxy_authorization','database_url','db_url','connection_string','dsn','dburl','databaseurl','connectionstring')";
// Bound the scheme quantifier to match `URI_CREDENTIAL_RE` in
// `@lobu/core/utils/secret-redaction` — see that file for the ReDoS rationale.
const SQL_URI_CREDENTIAL_PATTERN =
  '[a-z][a-z0-9+.-]{0,63}://[^/@[:space:]]*:[^/@[:space:]]*@';

/**
 * Placeholder for the source column inside an {@link ColumnDef.expr}.
 * {@link buildColumnList} substitutes it with `alias.<column>` (or the bare
 * quoted column when there is no alias), so an expression may reference the
 * column any number of times.
 */
const COLUMN_REF = '$COL$';

/**
 * Placeholder for the row's table qualifier inside an {@link ColumnDef.expr},
 * so an expression can read SIBLING columns of the same row. Substituted with
 * `alias.` (or the empty string when the caller has no alias, which is
 * unambiguous because such a CTE selects from a single table).
 */
const ROW_REF = '$ROW$';

/** SQL test for "this jsonb key is a denylisted secret name". */
const SQL_KEY_IS_SECRET = (keyExpr: string) => {
  // Mirrors `normalizeKey` in `@lobu/core/utils/secret-redaction`: splits
  // acronym-to-word boundaries (`AWSSecretKey` -> `AWS_Secret_Key`) and
  // lower-to-uppercase boundaries (`apiKey` -> `api_Key`). Bound acronym
  // runs to match TS ReDoS-safe quantifiers.
  const normalized =
    `lower(regexp_replace(regexp_replace(regexp_replace(` +
    `regexp_replace(${keyExpr}, '([A-Z]{1,32})([A-Z][a-z])', '\\1_\\2', 'g'), ` +
    `'([a-z0-9])([A-Z])', '\\1_\\2', 'g'), ` +
    `'[^a-zA-Z0-9]+', '_', 'g'), '^_+|_+$', '', 'g'))`;
  return (
    `${normalized} IN ${SQL_SECRET_EXACT_KEYS} ` +
    `OR ${normalized} ~ '${SQL_SECRET_KEY_PATTERN}'`
  );
};

/**
 * Marker for the expression that yields the set of key names the CONNECTOR
 * declares secret for the row being redacted. {@link buildColumnList}
 * substitutes it the same way it substitutes {@link COLUMN_REF}; a table with
 * no connector association (or a caller with no substitution) gets an empty
 * array, which degrades cleanly to heuristic-only redaction.
 */
export const DECLARED_SECRETS_REF = '$DECLARED$';

/**
 * The declared-secret key set for one `connections` row, as a correlated
 * subquery over that row's active `connector_definitions` entry.
 *
 * Connectors declare secrecy in two conventions, and the TypeScript
 * serializers honor BOTH on top of the keyname heuristic:
 *   - `options_schema.properties.<key>.format === "password"`
 *   - `auth_schema.methods[].fields[].secret === true`
 *
 * The SQL path previously had the heuristic ONLY, so a declared secret whose
 * name does not match the denylist (`signingMaterial`, `OPAQUE_HANDLE`, or
 * anything a custom connector chooses) was redacted by list()/get() but served
 * PLAINTEXT by query_sql — the same class of leak as the original P0, on a
 * member-reachable tool. This closes that gap by resolving the declarations in
 * SQL, so the two redactors cannot disagree about what a connector declared.
 *
 * `%ALIAS%` is replaced with the connections alias in scope.
 */
const DECLARED_SECRET_KEYS_SUBQUERY =
  // security-allowed: static SQL fragment built from string literals; %ALIAS% is replaced with a fixed table alias, never user input.
  `(SELECT COALESCE(array_agg(dk.k), ARRAY[]::text[]) FROM (` +
  `SELECT p.key AS k ` +
  `FROM public.connector_definitions cdsec, jsonb_each(cdsec.options_schema->'properties') p ` +
  `WHERE cdsec.key = %ALIAS%.connector_key ` +
  `AND cdsec.organization_id = %ALIAS%.organization_id ` +
  `AND cdsec.status = 'active' ` +
  `AND jsonb_typeof(cdsec.options_schema->'properties') = 'object' ` +
  `AND p.value->>'format' = 'password' ` +
  `UNION ` +
  // security-allowed: static SQL fragment (auth_schema UNION branch); no user input.
  `SELECT af->>'key' ` +
  `FROM public.connector_definitions cdsec, ` +
  `jsonb_array_elements(cdsec.auth_schema->'methods') am, ` +
  `jsonb_array_elements(am->'fields') af ` +
  `WHERE cdsec.key = %ALIAS%.connector_key ` +
  `AND cdsec.organization_id = %ALIAS%.organization_id ` +
  `AND cdsec.status = 'active' ` +
  `AND jsonb_typeof(cdsec.auth_schema->'methods') = 'array' ` +
  `AND jsonb_typeof(am->'fields') = 'array' ` +
  `AND af->>'secret' = 'true' ` +
  `AND af->>'key' IS NOT NULL` +
  `) dk)`;

/**
 * The declared-secret key set for one `feeds` row.
 *
 * A feed's own credentials are declared in
 * `feeds_schema[feed_key].configSchema.properties.<k>.format === "password"`.
 * `FeedDefinition.configSchema` is an unconstrained `Record<string, unknown>`,
 * so a CUSTOM connector may name such a field anything; no shipped connector
 * declares one today (all 27 audited, zero hits), which makes this latent
 * rather than live — but custom connector definitions are a supported feature,
 * and a redactor documented as total must not exempt a declaration site.
 *
 * `feeds` carries no `connector_key` of its own, so the definition is reached
 * through `connection_id` → `connections` → `connector_definitions`. Both hops
 * are org-scoped, so another tenant's definition can never decide what this row
 * redacts.
 */
const FEED_DECLARED_SECRET_KEYS_SUBQUERY =
  // security-allowed: static SQL fragment; %ALIAS% is replaced with a fixed table alias, never user input.
  `(SELECT COALESCE(array_agg(fp.key), ARRAY[]::text[]) ` +
  `FROM public.connections cfeed ` +
  `JOIN LATERAL (` +
  // security-allowed: static SQL fragment (feed definition lookup); no user input.
  `SELECT cdfeed.feeds_schema ` +
  `FROM public.connector_definitions cdfeed ` +
  `WHERE cdfeed.key = cfeed.connector_key ` +
  `AND cdfeed.organization_id = cfeed.organization_id ` +
  `AND cdfeed.status = 'active' ` +
  `ORDER BY cdfeed.updated_at DESC LIMIT 1` +
  `) cdf ON TRUE, ` +
  `jsonb_each(cdf.feeds_schema -> %ALIAS%.feed_key -> 'configSchema' -> 'properties') fp ` +
  `WHERE cfeed.id = %ALIAS%.connection_id ` +
  `AND cfeed.organization_id = %ALIAS%.organization_id ` +
  `AND jsonb_typeof(cdf.feeds_schema -> %ALIAS%.feed_key -> 'configSchema' -> 'properties') = 'object' ` +
  `AND fp.value->>'format' = 'password')`;

/** Bind {@link DECLARED_SECRET_KEYS_SUBQUERY} to a concrete table alias. */
export function declaredSecretKeysExpr(alias: string): string {
  return DECLARED_SECRET_KEYS_SUBQUERY.split('%ALIAS%').join(alias);
}

/** Bind {@link FEED_DECLARED_SECRET_KEYS_SUBQUERY} to a concrete table alias. */
export function feedDeclaredSecretKeysExpr(alias: string): string {
  return FEED_DECLARED_SECRET_KEYS_SUBQUERY.split('%ALIAS%').join(alias);
}

/**
 * How many levels of nesting the generated expression walks.
 *
 * Config nesting in practice is shallow — the deepest real shapes are
 * `config.headers.Authorization` and `config.database.password` (2 levels
 * under the root). 3 covers those with a level of headroom. The expression is
 * unrolled, so each extra level multiplies its size; this is the knob that
 * keeps the generated CTE reasonable.
 *
 * BELOW this depth a still-nested object/array is emitted WHOLLY REDACTED
 * rather than passed through. That is deliberately fail-closed: an
 * unexpectedly deep blob is rendered useless rather than leaked. It is also
 * why raising this number is safe but lowering it is not.
 */
const REDACTION_DEPTH = 3;

/**
 * Build a recursive jsonb-redaction expression, unrolled to a fixed depth.
 *
 * Unrolled rather than a `CREATE FUNCTION` so the guarantee lives entirely in
 * the generated CTE: no migration ordering to get wrong, and no deployment
 * window where the schema claims "redacted" while the database has no function
 * yet.
 *
 * Each level uses a DEPTH-SUFFIXED alias (`kv3`, `kv2`, …). Reusing one alias
 * lets the inner `jsonb_each` shadow the outer one, so every level would
 * re-test the OUTERMOST key and nested secrets would survive — that bug was
 * caught by the nested-probe case in table-schema-redaction.test.ts.
 */
function buildRedactionExpr(
  valueExpr: string,
  depth: number,
  /**
   * Whether keys at THIS level are also tested against the connector's
   * declared secret set. True only at the root: `options_schema.properties`
   * and `auth_schema…fields[].key` name TOP-LEVEL config keys, so applying the
   * set deeper would redact an unrelated nested key that merely shares a name.
   * Nested levels remain covered by the heuristic + URI shape.
   */
  applyDeclared = false
): string {
  // Bottom of the walk: anything still an object/array here is replaced
  // wholesale — fail-closed rather than emitting unredacted nested content.
  if (depth === 0) {
    return (
      `CASE ` +
      `WHEN jsonb_typeof(${valueExpr}) IN ('object','array') ` +
      `THEN to_jsonb('${REDACTED_SENTINEL}'::text) ` +
      `WHEN jsonb_typeof(${valueExpr}) = 'string' ` +
      `AND (${valueExpr} #>> '{}') ~* '${SQL_URI_CREDENTIAL_PATTERN}' ` +
      `THEN to_jsonb('${REDACTED_SENTINEL}'::text) ` +
      `ELSE ${valueExpr} END`
    );
  }
  const kv = `kv${depth}`;
  const el = `el${depth}`;
  const child = buildRedactionExpr(`${kv}.value`, depth - 1);
  const element = buildRedactionExpr(`${el}.value`, depth - 1);
  return (
    `CASE ` +
    // objects: rebuild, redacting denylisted keys and recursing into the rest
    `WHEN jsonb_typeof(${valueExpr}) = 'object' THEN (` +
    // security-allowed: static redaction SQL; ${kv}/${el} are code-generated aliases, not user input.
    `SELECT COALESCE(jsonb_object_agg(${kv}.key, ` +
    `CASE WHEN ${SQL_KEY_IS_SECRET(`${kv}.key`)}` +
    // Schema-declared secrets: the connector said this key is secret, whatever
    // it is named. Only applied at the root (see `applyDeclared`).
    // `= ANY(<subquery>)` would treat the subquery as a set of rows; the
    // subquery yields ONE text[] row, so the array is compared with `@>`
    // (contains) instead.
    (applyDeclared
      ? ` OR (${DECLARED_SECRETS_REF}) @> ARRAY[${kv}.key]::text[]`
      : '') +
    ` THEN to_jsonb('${REDACTED_SENTINEL}'::text) ELSE ${child} END), '{}'::jsonb) ` +
    `FROM jsonb_each(${valueExpr}) ${kv}) ` +
    // arrays: recurse elementwise (a list of header objects is a real shape)
    `WHEN jsonb_typeof(${valueExpr}) = 'array' THEN (` +
    // security-allowed: static redaction SQL; ${element}/${el} are code-generated aliases, not user input.
    `SELECT COALESCE(jsonb_agg(${element} ORDER BY ${el}.ordinality), '[]'::jsonb) ` +
    `FROM jsonb_array_elements(${valueExpr}) WITH ORDINALITY ${el}(value, ordinality)) ` +
    // credential-bearing URI scalars fail closed; unlike the TypeScript
    // serializer, SQL replaces the whole string rather than rebuilding userinfo
    `WHEN jsonb_typeof(${valueExpr}) = 'string' ` +
    `AND (${valueExpr} #>> '{}') ~* '${SQL_URI_CREDENTIAL_PATTERN}' ` +
    `THEN to_jsonb('${REDACTED_SENTINEL}'::text) ` +
    // remaining scalars pass through untouched
    `ELSE ${valueExpr} END`
  );
}

/**
 * The `config` column, redacted at the chokepoint.
 *
 * Both `connections` and `feeds` resolve their connector's DECLARED secret
 * fields on top of the keyname/URI heuristic — a declared secret with an
 * off-denylist name would otherwise be redacted by the TypeScript serializers
 * and served plaintext here. The two differ only in how the definition is
 * reached: a connection carries `connector_key` directly, a feed reaches it
 * through `connection_id` (see {@link feedDeclaredSecretKeysExpr}), which is
 * why `buildColumnList` binds the marker per table.
 */
function redactedConfigColumn(): ColumnDef {
  return {
    name: 'config',
    type: 'jsonb',
    expr: buildRedactionExpr(COLUMN_REF, REDACTION_DEPTH, true),
  };
}

export const QUERYABLE_SCHEMA = {
  tables: [
    // entities (excludes: embedding, content_tsv, content_hash)
    // entity_type is exposed as a derived column — the CTE JOINs entity_types
    // and aliases et.slug AS entity_type, so user queries can keep referencing it.
    {
      name: 'entities',
      columns: cols(
        'id',
        'entity_type',
        'entity_type_id',
        'parent_id',
        'name',
        'slug',
        'metadata',
        'enabled_classifiers',
        'created_at',
        'updated_at',
        'organization_id',
        'created_by',
        'content',
        'deleted_at',
        'merged_into'
      ),
    },
    // events (excludes: embedding)
    {
      name: 'events',
      columns: [
        ...cols(
          'id',
          'organization_id',
          'entity_ids',
          'origin_id',
          'title',
          'payload_type',
          'payload_text'
        ),
        // A tool-invocation audit row retains the caller's VERBATIM request,
        // readable only by its author or a workspace admin (see
        // `hydrateToolInvocationRequests`). `query_sql` has no per-row caller
        // gate, so it drops that key here. The CASE is load-bearing: an
        // unconditional `- 'request'` would silently delete a legitimate
        // `request` key from every OTHER event — connector-ingested payloads
        // and `save_memory` structured data are caller-shaped.
        {
          name: 'payload_data',
          type: 'jsonb',
          expr:
            `CASE WHEN ${ROW_REF}semantic_type = 'audit' ` +
            `AND ${ROW_REF}origin_type = 'tool_invocation' ` +
            `THEN ${COLUMN_REF} - 'request' ELSE ${COLUMN_REF} END`,
        },
        ...cols(
          'payload_template',
          'attachments',
          'author_name',
          'source_url',
          'occurred_at',
          'score',
          'metadata',
          'created_at',
          'origin_parent_id',
          'origin_type',
          'connector_key',
          'connection_id',
          'feed_key',
          'feed_id',
          'run_id',
          'semantic_type',
          'content_length',
          'search_tsv',
          'client_id',
          'created_by',
          'interaction_type',
          'interaction_status',
          'interaction_input_schema',
          'interaction_input',
          'interaction_output',
          'interaction_error',
          'supersedes_event_id',
          'identity_ns',
          'identity_key',
          // Readable for the same reason `run_id` is: provenance a source query
          // or reaction script can legitimately branch on ("skip rows some
          // Automation produced", "show me what v6 wrote"). Neither is sensitive,
          // and an Automation's own self-exclusion is enforced server-side by the
          // window predicate rather than by hiding the column.
          'automation_id',
          'automation_version_id'
        ),
      ],
    },
    // connections (excludes: credentials; `config` is REDACTED, not excluded —
    // see redactedConfigColumn)
    {
      name: 'connections',
      columns: [
        ...cols(
          'id',
          'organization_id',
          'connector_key',
          'slug',
          'display_name',
          'status',
          'account_id',
          'entity_ids'
        ),
        redactedConfigColumn(),
        ...cols(
          'error_message',
          'created_by',
          'created_at',
          'updated_at',
          'auth_profile_id',
          'app_auth_profile_id',
          'visibility',
          'deleted_at',
          'agent_id',
          'device_worker_id',
          'external_tenant_id',
          'credential_mode',
          // Connector-health alert claim (NULL → healthy). A plain timestamptz,
          // no secret: the SDK returns it, so SQL must too or org health can't
          // be audited from query_sql.
          'unhealthy_alerted_at'
        ),
      ],
    },
    // automations
    {
      name: 'automations',
      columns: cols(
        'id',
        'name',
        'slug',
        'description',
        'version',
        'current_version_id',
        'schedule',
        'timezone',
        'triggers',
        'next_run_at',
        'consecutive_scheduled_failures',
        'schedule_auto_paused_at',
        'managed_agent_id',
        'model_config',
        'execution_config',
        'status',
        'created_at',
        'updated_at',
        'entity_ids',
        'sources',
        'tags',
        'created_by',
        'organization_id',
        'reaction_script',
        'reaction_script_compiled',
        'reaction_input_schema',
        'connection_id',
        'source_automation_id',
        'automation_group_id',
        // Runtime columns for device pinning, delivery routing, and run
        // rate-limiting; query_sql exposes them so those settings are auditable.
        'device_worker_id',
        'agent_kind',
        'delivery_target',
        'min_cooldown_seconds',
        'last_fired_at',
        // Dispatch-time activation cursor. A positive min_cooldown_seconds
        // consumes it as the debounce window; a zero-cooldown chat reply stamps
        // it purely for observability, since that path writes no run row.
        // Distinct from last_fired_at, which is stamped when a run reaches a
        // terminal state.
        'last_event_activation_at',
        // Materialized ordering stamp: the completion time of this Automation's
        // most recent `completed` run, written by a trigger on `runs`. Plain
        // timestamptz, no secret, and it is what the listing orders by — so
        // SQL must expose it or the ordering can't be audited from query_sql.
        'last_run_completed_at',
        // Materialized eval quality, written by the scorer at score time. No
        // secret, and exposing it is the point: a quality number nobody can
        // query is a number nobody can check.
        'latest_eval_score',
        'latest_eval_at',
        'latest_eval_run_id'
      ),
    },
    // event_classifications
    {
      name: 'event_classifications',
      columns: cols(
        'id',
        'event_id',
        'classifier_id',
        'automation_id',
        'run_id',
        'values',
        'confidences',
        'source',
        'is_manual',
        'reasoning',
        'met_threshold',
        'threshold',
        'best_match_attribute',
        'embedding_confidence',
        'created_at',
        'excerpts'
      ),
    },
    // automation_versions
    // NO `sources` column: that lives on `automations`; a version row carries
    // `version_sources`. It was listed here and, because the CTE emits an
    // explicit projection, `wv."sources"` was injected into every query — the
    // relation was 100% unqueryable with an error naming a column no caller
    // wrote.
    {
      name: 'automation_versions',
      columns: cols(
        'id',
        'automation_id',
        'version',
        'name',
        'description',
        'prompt',
        'skills',
        'outputs',
        'classifiers',
        'reactions_guidance',
        'change_notes',
        'created_by',
        'created_at',
        'required_source_types',
        'recommended_source_types',
        'version_sources'
      ),
    },
    // oauth_clients (excludes: client_secret, client_secret_expires_at)
    {
      name: 'oauth_clients',
      columns: cols(
        'id',
        'client_id_issued_at',
        'redirect_uris',
        'token_endpoint_auth_method',
        'grant_types',
        'response_types',
        'client_name',
        'client_uri',
        'logo_uri',
        'scope',
        'contacts',
        'tos_uri',
        'policy_uri',
        'software_id',
        'software_version',
        'user_id',
        'organization_id',
        'metadata',
        'created_at',
        'updated_at'
      ),
    },
    // oauth_tokens (excludes: token_hash)
    {
      name: 'oauth_tokens',
      columns: cols(
        'id',
        'token_type',
        'client_id',
        'user_id',
        'organization_id',
        'scope',
        'resource',
        'parent_token_id',
        'expires_at',
        'revoked_at',
        'created_at'
      ),
    },
    // user (excludes: email, phoneNumber, phoneNumberVerified)
    {
      name: 'user',
      columns: cols(
        'id',
        'name',
        'emailVerified',
        'image',
        'createdAt',
        'updatedAt',
        'username',
        'principal_kind'
      ),
    },
    // feeds (`config` is REDACTED, not excluded — see redactedConfigColumn).
    // Internal sync cursors and transitional physical columns are excluded.
    {
      name: 'feeds',
      columns: [
        ...cols(
          'id',
          'organization_id',
          'connection_id',
          'feed_key',
          'status',
          'entity_ids'
        ),
        redactedConfigColumn(),
        ...cols(
          'schedule',
          'timezone',
          'next_run_at',
          'last_sync_at',
          'last_sync_status',
          'last_error',
          'consecutive_failures',
          'items_collected',
          'created_at',
          'updated_at',
          'pinned_version',
          'display_name',
          'deleted_at',
          'first_failure_at'
        ),
      ],
    },
    // channel_messages — chat-channel transcripts (channel feeds). Content is
    // membership-gated per row by the channel_messages CTE in execute-data-sources
    // (compileChannelMessagesVisibility): a row on an ACL-enforced Slack
    // connection is visible only to a channel member; a headless reader (null
    // principal) sees only non-enforced channels. Without that gate this table is
    // NOT safe to expose, which is why it was previously absent from the allowlist.
    {
      name: 'channel_messages',
      columns: cols(
        'id',
        'organization_id',
        'connection_id',
        'platform',
        'channel_id',
        'thread_id',
        'platform_message_id',
        'author_id',
        'author_name',
        'author_entity_id',
        'team_id',
        'is_bot',
        'text',
        'occurred_at',
        'created_at'
      ),
    },
    // connector_definitions (excludes: large *_config JSONB blobs)
    {
      name: 'connector_definitions',
      columns: cols(
        'id',
        'organization_id',
        'key',
        'name',
        'description',
        'version',
        'auth_schema',
        'feeds_schema',
        'actions_schema',
        'options_schema',
        'status',
        'created_at',
        'updated_at',
        'login_enabled',
        'favicon_domain',
        'required_capability',
        'runtime',
        'automation_events',
        'supports_execute',
        'agent_tooling'
      ),
    },
    // entity_relationships — org-scoped, live graph edges.
    {
      name: 'entity_relationships',
      columns: cols(
        'id',
        'organization_id',
        'from_entity_id',
        'to_entity_id',
        'relationship_type_id',
        'metadata',
        'confidence',
        'source',
        'created_by',
        'updated_by',
        'deleted_at',
        'created_at',
        'updated_at'
      ),
    },
    // device_workers — the caller's OWN registered devices.
    //
    // Excludes `user_id` (always the caller under the CTE's owner filter, so it
    // only invites correlation) and `connector_manifests` (free-form jsonb the
    // device writes verbatim, the same "written by the write path, not curated
    // for secrecy" risk class that forced redactedConfigColumn onto
    // connections.config; nothing needs it to pin an Automation).
    //
    // `id` is the point of the entry: it is the UUID that
    // `automations.device_worker_id` / `connections.device_worker_id` take, and
    // without it an agent had to reconstruct it from a device lifecycle event.
    {
      name: 'device_workers',
      columns: cols(
        'id',
        'worker_id',
        'platform',
        'app_version',
        'capabilities',
        'label',
        'last_seen_at',
        'organization_id',
        'agent_kinds'
      ),
    },
    // entity_relationship_types — local and public-catalog edge definitions.
    {
      name: 'entity_relationship_types',
      columns: cols(
        'id',
        'slug',
        'name',
        'description',
        'organization_id',
        'created_by',
        'metadata_schema',
        'is_symmetric',
        'inverse_type_id',
        'status',
        'deleted_at',
        'created_at',
        'updated_at',
        'metadata',
        'purpose'
      ),
    },
  ],
};

export const QUERYABLE_TABLE_NAMES = new Set(QUERYABLE_SCHEMA.tables.map((t) => t.name));

/**
 * Queryable tables that stay OWNER/ADMIN-only even when query_sql / metric_series
 * are member-accessible: the auth + identity tables. Members can read the
 * org's operational data (entities, events, connections, feeds, automations, …) but
 * not enumerate every OAuth token/app or the full user roster. Secret columns
 * (credentials, client_secret, token_hash, email, phone) are excluded from the
 * schema above, and the secret-carrying `config` jsonb is redacted in-place;
 * this is the table-level guard on top of that.
 *
 * Do NOT rely on this set to protect a column: `connections` and `feeds` are
 * intentionally member-readable, so a secret in one of their columns must be
 * excluded or redacted at the schema, not gated here.
 */
export const ADMIN_ONLY_QUERYABLE_TABLES: ReadonlySet<string> = new Set([
  'oauth_tokens',
  'oauth_clients',
  'user',
]);

/** table name → column definitions for use in CTE SELECT.
 *  Columns with `expr` project a SQL expression instead of the bare column
 *  (JSONB redaction or another SQL-side projection). */
export const SAFE_COLUMN_DEFS = new Map<string, ColumnDef[]>(
  QUERYABLE_SCHEMA.tables.map((t) => [t.name, t.columns])
);

/** Build a SELECT column list from column defs, optionally prefixed with a table alias. */
export function buildColumnList(
  defs: ColumnDef[],
  alias?: string,
  table?: string
): string {
  return defs
    .map((c) => {
      if (c.expr) {
        // `$COL$` marks every reference to the source column, so an expression
        // may use it more than once (the redaction CASE reads `config` three
        // times). Legacy expressions with no marker keep the old semantics:
        // alias-prefix the leading identifier.
        const ref = alias ? `${alias}."${c.name}"` : `"${c.name}"`;
        let prefixed = c.expr.includes(COLUMN_REF)
          ? c.expr.split(COLUMN_REF).join(ref)
          : alias
            ? c.expr.replace(/^(\w+)/, `${alias}.$1`)
            : c.expr;
        // `$ROW$` qualifies SIBLING columns of the same row, so an expression
        // can branch on another column (the events `payload_data` CASE reads
        // `semantic_type`/`origin_type`).
        prefixed = prefixed.split(ROW_REF).join(alias ? `${alias}.` : '');
        // `$DECLARED$` resolves to the connector's declared secret key set for
        // the row. It needs a table alias to correlate on, and the correlation
        // differs per table: `connections` carries `connector_key` directly,
        // `feeds` reaches the definition through `connection_id`. With no alias
        // — or an unrecognized table — there is nothing to correlate to, so it
        // degrades to the empty set: heuristic-only, never MORE exposed than
        // before, just less precise.
        if (prefixed.includes(DECLARED_SECRETS_REF)) {
          const declared =
            alias && table === 'connections'
              ? declaredSecretKeysExpr(alias)
              : alias && table === 'feeds'
                ? feedDeclaredSecretKeysExpr(alias)
                : `ARRAY[]::text[]`;
          prefixed = prefixed.split(DECLARED_SECRETS_REF).join(declared);
        }
        return `${prefixed} as "${c.name}"`;
      }
      return alias ? `${alias}."${c.name}"` : `"${c.name}"`;
    })
    .join(', ');
}

/**
 * Validate that SQL only references allowed tables and columns.
 * E200 = unknown table, E201 = unknown column.
 */
/**
 * Output-column aliases of the query's top-level SELECT. `ORDER BY`/`GROUP BY`
 * may reference these (valid SQL), but the schema validator treats them as
 * unknown columns — so we use this to suppress those false positives.
 * Best-effort: empty on parse failure. Only matches the alias NAME, never the
 * underlying expression, so an excluded column referenced as `SELECT credentials
 * AS x` is still rejected (the `credentials` reference itself fails).
 */
function outputAliases(sql: string): Set<string> {
  const out = new Set<string>();
  try {
    const res = parse(sql, Dialect.PostgreSQL);
    if (!res.success || !res.ast) return out;
    const root = Array.isArray(res.ast) ? res.ast[0] : res.ast;
    const data = ast.getExprData(root) as { expressions?: unknown[] };
    for (const item of data.expressions ?? []) {
      try {
        if (ast.getExprType(item as never) !== 'alias') continue;
        const a = (ast.getExprData(item as never) as { alias?: unknown }).alias;
        const name =
          typeof a === 'string'
            ? a
            : ((a as { name?: string; value?: string })?.name ??
              (a as { value?: string })?.value);
        if (typeof name === 'string' && name) out.add(name.toLowerCase());
      } catch {
        // skip malformed projection item
      }
    }
  } catch {
    // unparseable → no aliases; validator errors stand
  }
  return out;
}

/** Build one actionable error covering all unknown tables in a query. */
export function formatUnknownTablesError(
  tableNames: Iterable<string>,
  queryableTableNames: Iterable<string> = QUERYABLE_TABLE_NAMES
): string {
  const names = [...new Set(tableNames)].sort();
  const subject =
    names.length === 1
      ? `Unknown table '${names[0]}'`
      : `Unknown tables ${names.map((name) => `'${name}'`).join(', ')}`;
  const queryableTables = [...queryableTableNames].sort().join(', ');
  return (
    `${subject} — not in the queryable allowlist, so the query did not run. ` +
    `This is an error, not an empty result. ` +
    `Queryable tables are: ${queryableTables}.`
  );
}

export function validateTableQuery(
  sql: string,
  safeColumns: Map<string, ColumnDef[]> = SAFE_COLUMN_DEFS
): { valid: boolean; errors: string[] } {
  const schema = {
    tables: [...safeColumns].map(([name, columns]) => ({ name, columns })),
  };
  const result = validateWithSchema(sql, schema, 'postgresql', { checkReferences: true });
  const aliases = outputAliases(sql);
  const errors = (result.errors ?? []).filter((e: { code: string; message: string }) => {
    // E201 = unknown column. A reference to the query's OWN output alias (e.g.
    // `SELECT count(*) AS n … ORDER BY n`) is valid SQL, not an unknown column.
    if (e.code === 'E201') {
      const m = /Unknown column '([^']+)'/i.exec(e.message ?? '');
      if (m && aliases.has(m[1].toLowerCase())) return false;
      return true;
    }
    return e.code === 'E200'; // unknown table — always a real error
  });
  const unknownTables: string[] = [];
  const messages: string[] = [];
  for (const error of errors as Array<{ code: string; message: string }>) {
    const match = error.code === 'E200' ? /Unknown table '([^']+)'/i.exec(error.message) : null;
    if (match) unknownTables.push(match[1]);
    else messages.push(error.message);
  }
  if (unknownTables.length > 0) {
    messages.unshift(formatUnknownTablesError(unknownTables, safeColumns.keys()));
  }
  return {
    valid: messages.length === 0,
    errors: messages,
  };
}
