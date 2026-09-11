/**
 * Shared types, utilities, and helpers used across manage_automations sub-handlers.
 */

import type { DbClient } from '../../../db/client';
import { getDb } from '../../../db/client';
import { ToolUserError } from '../../../utils/errors';
import {
  requireOrgReadAccess,
  requireOrgWriteAccess,
  requireReadAccess,
  requireWriteAccess,
} from '../../../utils/organization-access';
import { queryProjectsIdColumn } from '../../../utils/execute-data-sources';
import {
  validateAutomationSourceRef,
  resolveAutomationSourcesForSave,
  skillNamesFromPrompt,
} from '../../../automations/source-refs';
import { validateSaveContentSemanticType } from '../../../utils/event-kind-validation';
import type { ToolContext } from '../../registry';
import { Value } from '@sinclair/typebox/value';
import {
  AutomationEntityOutputSchema,
  AutomationEventOutputSchema,
  AutomationOutputsSchema,
  normalizeAutomationTags,
} from '@lobu/core/contracts/tools/manage-automations';

// ============================================
// Types
// ============================================

export interface AutomationOperationResult {
  automation_id: string;
  success: boolean;
  message: string;
  version?: number;
}

type AutomationAccessMode = 'read' | 'write';

interface AutomationAccessRow {
  id: string | number;
  organization_id: string | null;
  entity_ids: unknown;
}

// ============================================
// JSON coercion helpers
// ============================================

/**
 * Coerce a maybe-stringified JSON value into a parsed value. One helper, three
 * failure policies:
 *  - `keep`        — non-string passes through; bad string returns the raw string.
 *  - `throw`       — `null`/`undefined` → `undefined`; bad string throws `${label} must be valid JSON: …`.
 *  - `{ fallback }` — `null`/`undefined` or bad string → the supplied fallback.
 * `requireObject` (with `parseError`/`shapeError` messages) additionally rejects
 * non-object / array results — used for `extracted_data`.
 */
function coerceJson(value: unknown, opts: { onError: 'keep' }): unknown;
function coerceJson<T>(value: unknown, opts: { onError: 'throw'; label: string }): T | undefined;
function coerceJson<T>(value: unknown, opts: { onError: { fallback: T } }): T;
function coerceJson(
  value: unknown,
  opts: { requireObject: { parseError: string; shapeError: string } }
): Record<string, unknown>;
function coerceJson(
  value: unknown,
  opts: {
    onError?: 'keep' | 'throw' | { fallback: unknown };
    label?: string;
    requireObject?: { parseError: string; shapeError: string };
  }
): unknown {
  let parsed: unknown;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      if (opts.requireObject) throw new Error(opts.requireObject.parseError);
      if (opts.onError === 'keep') return value;
      if (opts.onError === 'throw') {
        throw new Error(`${opts.label} must be valid JSON: ${getErrorMessage(error)}`);
      }
      if (opts.onError) return opts.onError.fallback;
      throw error;
    }
  } else if (value === undefined || value === null) {
    if (opts.requireObject) {
      // fall through to the shape check below
    } else if (opts.onError === 'throw') {
      return undefined;
    } else if (opts.onError && opts.onError !== 'keep') {
      return opts.onError.fallback;
    }
    parsed = value;
  } else {
    parsed = value;
  }

  if (opts.requireObject) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(opts.requireObject.shapeError);
    }
  }
  return parsed;
}

export function parseJson(value: unknown): any {
  return coerceJson(value, { onError: 'keep' });
}

export function normalizeExtractedData(value: unknown): Record<string, unknown> {
  return coerceJson(value, {
    requireObject: {
      parseError: 'extracted_data must be a valid JSON object. Received an invalid JSON string.',
      shapeError:
        "extracted_data must be a JSON object matching the Automation's extraction contract.",
    },
  });
}

export function parseJsonInput<T>(value: unknown, label: string): T | undefined {
  return coerceJson<T>(value, { onError: 'throw', label });
}

export function normalizeStoredJsonField<T>(value: unknown, fallback: T): T {
  return coerceJson<T>(value, { onError: { fallback } });
}

export function toJsonParam(sql: DbClient, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  return sql.json(value);
}

export function toTextArrayParam(values: string[]): string {
  // Same trim/drop-empty/dedupe as the review's proposedAfter (one core helper),
  // so displayed tags == stored tags.
  const arr = normalizeAutomationTags(values);
  if (arr.length === 0) return '{}';
  return (
    '{' + arr.map((v) => '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}'
  );
}

export function summarizeResults(results: AutomationOperationResult[]) {
  const successful = results.filter((r) => r.success).length;
  return {
    total: results.length,
    successful,
    failed: results.length - successful,
  };
}

// ============================================
// Automation config validation
// ============================================

function validateAutomationConfig(input: {
  prompt?: string;
  classifiers?: unknown[];
  sources?: Array<{ name: string; query: string; context?: boolean }>;
}): string | null {
  // Instruction PRESENCE is trigger-shape-dependent (event-turn Automations may
  // run with no instruction text) and is enforced by assertAutomationInstructions
  // when either instructions or triggers change — here an absent or empty
  // prompt is structurally valid.
  //
  // Prompts are literal instruction text — no templating layer — so `{{` is
  // legal prose and there is nothing else to validate about the shape.
  if (input.prompt !== undefined && typeof input.prompt !== 'string') {
    return 'prompt must be a string';
  }

  // An Automation version declares only durable output targets. Entity row schemas
  // remain owned by entity types; event rows use the standard event draft.

  if (input.classifiers !== undefined) {
    if (!Array.isArray(input.classifiers)) {
      return 'classifiers must be an array';
    }
    // Guard the write hole behind the classifier corruption bug (#2033 item 4):
    // a classifier's `attribute_values` MUST be a keyed object-MAP, never an
    // array. An array shape read back through Object.entries becomes numeric
    // keys `{"0":…}` and, after embedding-stripping, the corrupted
    // `{"0":{},"1":{}}`. Reject the array shape at save time so it can never be
    // persisted into an automation version's `classifiers` blob.
    for (let i = 0; i < input.classifiers.length; i++) {
      const def = input.classifiers[i];
      if (def === null || typeof def !== 'object' || Array.isArray(def)) {
        return `classifiers[${i}]: each classifier definition must be an object`;
      }
      const attributeValues = (def as Record<string, unknown>).attribute_values;
      if (attributeValues !== undefined && attributeValues !== null) {
        if (typeof attributeValues !== 'object' || Array.isArray(attributeValues)) {
          return `classifiers[${i}].attribute_values: must be an object map keyed by value (got ${
            Array.isArray(attributeValues) ? 'array' : typeof attributeValues
          }). An array shape corrupts on read.`;
        }
      }
    }
  }

  if (input.sources) {
    for (const source of input.sources) {
      let refKind: ReturnType<typeof validateAutomationSourceRef>;
      try {
        refKind = validateAutomationSourceRef(source.name, source.query);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      if (refKind) continue;

      const trimmed = source.query.trim().toUpperCase();
      if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
        return `source "${source.name}": query must be a SELECT statement (read-only)`;
      }
      // Event sources need ids for signed window tokens and completion links.
      // Context rows are not event citations, so aggregates need no event id.
      if (!source.context && !queryProjectsIdColumn(source.query)) {
        return `source "${source.name}": query must project an "id" column (e.g. SELECT id, ... FROM events) so event content can be linked to the window.`;
      }
    }
  }

  return null;
}

/**
 * Run the shared automation-version validation (config shape + classifier/schema
 * source-path compatibility) and throw a `ToolUserError` (422) on the first
 * failure. Schedule validation is intentionally left to the caller because
 * `create` and `create_version` surface schedule errors with different error
 * types.
 */
export function assertAutomationVersionConfigValid(parsed: {
  prompt?: string;
  classifiers?: unknown[];
  sources?: Array<{ name: string; query: string; context?: boolean }>;
}): void {
  const validation = validateAutomationConfig({
    prompt: parsed.prompt,
    classifiers: parsed.classifiers,
    sources: parsed.sources,
  });
  if (validation) {
    throw new ToolUserError(`Automation validation failed: ${validation}`, 422);
  }
}

/**
 * Resolve every pinned skill name against the owning agent's library at save
 * time, and reject the write if any is missing or disabled.
 *
 * Fail closed rather than dropping the unknown entry: an Automation that silently
 * loses one of its skills still runs, unattended, with part of its instructions
 * gone — the failure surfaces as quietly wrong output hours later, on a run
 * nobody is watching. A 422 at save is the only point where the author is
 * present to see it.
 *
 * The name is validated but the CALLER's `content` is what gets stored: the
 * snapshot is the author's, taken at save time, and re-reading the body here
 * would silently upgrade a pin the author never agreed to. This checks that the
 * reference is real, not that the text still matches.
 */
export async function assertAutomationSkillsResolve(
  sql: DbClient,
  organizationId: string,
  agentId: string,
  skills: Array<{ name: string; content: string }>
): Promise<void> {
  if (skills.length === 0) return;
  if (skills.length > 5) {
    throw new ToolUserError('An Automation may pin at most 5 skills.', 422);
  }
  const invalidName = skills.find(
    (skill) => !/^[a-zA-Z0-9._-]+$/.test(skill.name)
  );
  if (invalidName) {
    throw new ToolUserError(
      `Skill "${invalidName.name}" cannot be pinned: names may contain only letters, numbers, ".", "_", and "-".`,
      422
    );
  }
  const empty = skills.find((skill) => !skill.content.trim());
  if (empty) {
    throw new ToolUserError(
      `Skill "${empty.name}" cannot be pinned because its body is empty.`,
      422
    );
  }
  const totalBytes = skills.reduce(
    (sum, skill) => sum + Buffer.byteLength(skill.content, 'utf8'),
    0
  );
  if (totalBytes > 32 * 1024) {
    throw new ToolUserError(
      `Pinned Automation skills contain ${totalBytes} bytes of text; the maximum is 32768 bytes (32KB).`,
      422
    );
  }

  const rows = await sql`
    SELECT skills_config
    FROM agents
    WHERE id = ${agentId}
      AND organization_id = ${organizationId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    throw new ToolUserError(
      `Agent ${agentId} was not found in this organization, so its skills cannot be resolved.`,
      422
    );
  }

  const library = Array.isArray(rows[0]?.skills_config?.skills)
    ? (rows[0].skills_config.skills as Array<Record<string, unknown>>)
    : [];
  const enabled = new Set(
    library
      .filter((entry) => entry.enabled !== false && typeof entry.name === 'string')
      .map((entry) => entry.name as string)
  );

  const unknown = skills.map((skill) => skill.name).filter((name) => !enabled.has(name));
  if (unknown.length > 0) {
    throw new ToolUserError(
      `Skill${unknown.length > 1 ? 's' : ''} ${unknown.map((n) => `"${n}"`).join(', ')} ` +
        `${unknown.length > 1 ? 'are' : 'is'} not enabled in agent ${agentId}'s skill library. ` +
        `Enable ${unknown.length > 1 ? 'them' : 'it'} on the agent, or remove ${unknown.length > 1 ? 'them' : 'it'} from this Automation.`,
      422
    );
  }

  const duplicates = skills
    .map((skill) => skill.name)
    .filter((name, index, all) => all.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new ToolUserError(
      `Skill "${duplicates[0]}" is listed more than once. Each skill may be pinned once per Automation.`,
      422
    );
  }
}

/**
 * Every `@[skill:…]` chip in the prompt must have a pinned entry in `skills[]`.
 *
 * Ref tokens survive into the instructions verbatim — nothing strips them (see
 * `automationSourcesFromPrompt`) — so an unpinned chip does not fail, it
 * degrades: the agent reads the literal `@[skill:deploy-runbook:…](…)` as if it
 * were guidance, with no `.skills/` file behind it. The web composer always
 * sends both halves; a CLI or MCP caller writing the token by hand can send the
 * prompt alone, and that is the case this catches.
 *
 * Names only — the pinned BODY still comes from the caller, never from a
 * save-time read of the live library.
 */
export function assertPromptSkillTokensPinned(
  prompt: string | null | undefined,
  skills: ReadonlyArray<{ name: string }> | null | undefined
): void {
  const referenced = skillNamesFromPrompt(prompt ?? '');
  if (referenced.length === 0) return;
  const pinned = new Set((skills ?? []).map((skill) => skill.name));
  const missing = referenced.filter((name) => !pinned.has(name));
  if (missing.length === 0) return;
  throw new ToolUserError(
    `The prompt references skill${missing.length > 1 ? 's' : ''} ` +
      `${missing.map((n) => `"${n}"`).join(', ')} that ${missing.length > 1 ? 'are' : 'is'} not ` +
      `pinned on this Automation. Pass ${missing.length > 1 ? 'them' : 'it'} in "skills" so the body is ` +
      `frozen with this version, or remove the reference from the prompt.`,
    422
  );
}

/**
 * Resolve every @ref source against the org at save time so a typo fails here
 * (loud 422) rather than silently producing empty context at read_knowledge.
 * Custom-SQL sources are skipped (id projection is already enforced by
 * {@link assertAutomationVersionConfigValid}). Call after the organization id is
 * known and before the automation/version row is persisted.
 */
export async function assertAutomationSourcesResolve(
  sql: DbClient,
  organizationId: string,
  sources: Array<{ name: string; query: string }>,
  // The Automation's entity_ids (empty/omitted for an org-scoped Automation), so
  // {{entityId}} in a custom-SQL source validates exactly as it runs.
  entityIds: number[] = []
): Promise<void> {
  try {
    await resolveAutomationSourcesForSave(sql, organizationId, sources, entityIds);
  } catch (err) {
    throw new ToolUserError(
      `Automation validation failed: ${err instanceof Error ? err.message : String(err)}`,
      422
    );
  }
}

// ============================================
// Foreign-key-shaped reference validation
// ============================================

/**
 * Resolve `managed_agent_id` against the caller's org before it is persisted.
 *
 * `automations.managed_agent_id` is nullable and carries NO foreign key to `agents`, so a
 * typo'd or cross-org id is accepted by the database and only surfaces as an
 * Automation that reports status 'active' / health 'healthy' and never runs — the
 * scheduler joins automations to agents on `managed_agent_id` (see automations/automation.ts),
 * so an unresolvable owner silently drops the row out of every scheduling pass.
 * `automations.create` already documents `throws: ["EntityNotFound"]` for this
 * case in src/sandbox/method-metadata.ts; this honours that contract.
 *
 * Org-scoped by design: `agents` ids are unique only WITHIN an org, so resolving
 * without the org fence would let one tenant name another tenant's agent.
 * Matches the 404 shape manage_agents' own get/update handlers emit.
 */
export async function assertAgentExists(
  sql: DbClient,
  organizationId: string,
  agentId: string | null | undefined
): Promise<void> {
  if (agentId == null) return;
  const rows = await sql<{ id: string }>`
    SELECT id FROM agents
    WHERE organization_id = ${organizationId} AND id = ${agentId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    throw new ToolUserError(`Agent "${agentId}" not found`, 404);
  }
}

/** Shape-check caller-supplied named outputs, including unknown-field typos. */
export function assertOutputsShape(outputs: unknown): void {
  if (outputs === undefined || outputs === null) return;
  if (typeof outputs === 'object' && !Array.isArray(outputs)) {
    for (const [name, raw] of Object.entries(outputs)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
        throw new ToolUserError(
          `Invalid outputs.${name}: output names must start with a letter and contain only letters, numbers, or underscores.`,
          400
        );
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const target = raw as Record<string, unknown>;
      const hasEntity = Object.hasOwn(target, 'entity');
      const hasEvent = Object.hasOwn(target, 'event');
      if (hasEntity === hasEvent) {
        throw new ToolUserError(
          `Invalid outputs.${name}: declare exactly one of 'entity' or 'event'.`,
          400
        );
      }
      const referenceField = hasEntity ? 'entity' : 'event';
      const reference = target[referenceField];
      if (typeof reference === 'string' && reference !== reference.trim()) {
        throw new ToolUserError(
          `Invalid outputs.${name}.${referenceField}: surrounding whitespace is not allowed.`,
          400
        );
      }
      if (target.event === 'guidance') {
        throw new ToolUserError(
          `Invalid outputs.${name}: Automations cannot author organization-wide guidance events.`,
          422
        );
      }
      const schema = hasEntity ? AutomationEntityOutputSchema : AutomationEventOutputSchema;
      const unknown = Object.keys(target).filter(
        (key) => !Object.hasOwn(schema.properties, key)
      );
      if (unknown.length > 0) {
        throw new ToolUserError(
          `Invalid outputs.${name}: unknown field(s) ${unknown.slice(0, 3).join(', ')}. Allowed: ${Object.keys(schema.properties).join(', ')}.`,
          400
        );
      }
    }
  }
  if (Value.Check(AutomationOutputsSchema, outputs)) return;
  // Dedupe by path — TypeBox emits both `Expected required property` and
  // `Expected <type>` for one missing field (same as validate-args).
  const seen = new Set<string>();
  const errs: string[] = [];
  for (const e of Value.Errors(AutomationOutputsSchema, outputs)) {
    const path = e.path || '/';
    if (seen.has(path)) continue;
    seen.add(path);
    errs.push(`${path}: ${e.message}`);
    if (errs.length >= 3) break;
  }
  throw new ToolUserError(`Invalid outputs: ${errs.join('; ')}`, 400);
}

/**
 * Resolve every entity output target against the org before it is persisted.
 */
export async function assertOutputEntityTypesExist(
  sql: DbClient,
  organizationId: string,
  outputs: Record<string, unknown> | null | undefined
): Promise<void> {
  if (!outputs) return;
  for (const [name, raw] of Object.entries(outputs)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rawType = (raw as Record<string, unknown>).entity;
    if (typeof rawType !== 'string' || !rawType.trim()) continue;
    const entityType = rawType.trim();
    const rows = await sql<{ id: number; metadata_schema: unknown; backing_sql: string | null }>`
      SELECT et.id, et.metadata_schema, et.backing_sql
      FROM entity_types et
      LEFT JOIN organization o ON o.id = et.organization_id
      WHERE et.slug = ${entityType}
        AND et.deleted_at IS NULL
        AND (et.organization_id = ${organizationId} OR o.visibility = 'public')
      ORDER BY (et.organization_id = ${organizationId}) DESC, et.id ASC
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new ToolUserError(
        `Unknown entity type '${entityType}' in outputs.${name}. Use client.entitySchema.listTypes() to list available types or client.entitySchema.createType(...) to create a custom type first.`,
        422
      );
    }
    if (rows[0].backing_sql) {
      throw new ToolUserError(
        `Invalid entity output outputs.${name}: '${entityType}' is a derived entity type and cannot receive persisted rows.`,
        422
      );
    }
    const metadataSchema = parseJson(rows[0].metadata_schema);
    const properties =
      metadataSchema &&
      typeof metadataSchema === 'object' &&
      !Array.isArray(metadataSchema) &&
      (metadataSchema as Record<string, unknown>).properties &&
      typeof (metadataSchema as Record<string, unknown>).properties === 'object' &&
      !Array.isArray((metadataSchema as Record<string, unknown>).properties)
        ? ((metadataSchema as Record<string, unknown>).properties as Record<string, unknown>)
        : null;
    if (!properties) continue;
    const target = raw as Record<string, unknown>;
    for (const field of [...((target.key as string[]) ?? []), ...((target.name as string[]) ?? [])]) {
      if (!Object.hasOwn(properties, field)) {
        throw new ToolUserError(
          `Unknown field '${field}' in outputs.${name}: entity type '${entityType}' does not declare that property.`,
          422
        );
      }
    }
  }
}

/** Validate declared event kinds at authoring time when the org has a registry. */
export async function assertOutputEventTypesExist(
  organizationId: string,
  outputs: Record<string, unknown> | null | undefined,
  entityIds: number[] = []
): Promise<void> {
  if (!outputs) return;
  for (const [name, raw] of Object.entries(outputs)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const event = (raw as Record<string, unknown>).event;
    if (typeof event !== 'string' || !event.trim()) continue;
    const validation = await validateSaveContentSemanticType(
      event.trim(),
      {},
      organizationId,
      entityIds.length > 0 ? entityIds : undefined
    );
    if (!validation.valid) {
      throw new ToolUserError(
        `Invalid event type '${event}' in outputs.${name}: ${validation.errors.join(' ')}`,
        422
      );
    }
  }
}

// ============================================
// Automation access control
// ============================================

function parseAutomationEntityIds(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number).filter((id) => Number.isFinite(id));
  if (typeof raw === 'string') {
    return raw
      .replace(/[{}]/g, '')
      .split(',')
      .filter(Boolean)
      .map(Number)
      .filter((id) => Number.isFinite(id));
  }
  return [];
}

async function getAutomationAccessRows(
  automationIds: string[],
  organizationId: string | null | undefined,
): Promise<AutomationAccessRow[]> {
  if (automationIds.length === 0) return [];
  const sql = getDb();
  // Always scope the read to the caller's org so a TOCTOU swap of automation_id
  // to another tenant's row cannot surface foreign organization_id/entity_ids
  // into the access check (and so mutating paths that reuse these ids stay
  // org-bound at the first load).
  if (!organizationId) return [];
  const placeholders = automationIds.map((_, idx) => `$${idx + 2}`).join(',');
  return sql.unsafe<AutomationAccessRow>(
    `SELECT id, organization_id, entity_ids FROM automations
     WHERE organization_id = $1 AND id IN (${placeholders})`,
    [organizationId, ...automationIds],
  );
}

/**
 * Existence probe across all orgs for the given automation ids, reading ONLY the
 * id column — never organization_id/entity_ids. The org-scoped
 * {@link getAutomationAccessRows} load stays the single source of truth for every
 * actual access decision (TOCTOU-safe); this probe exists purely to tell a
 * cross-org id (exists under another tenant — a 403 access fault) apart from an
 * id that exists nowhere (which a mutation handler must be allowed to report
 * per-id, e.g. delete's all-failed "not found or already archived" aggregate).
 */
async function findExistingAutomationIds(automationIds: string[]): Promise<Set<string>> {
  if (automationIds.length === 0) return new Set();
  const sql = getDb();
  const placeholders = automationIds.map((_, idx) => `$${idx + 1}`).join(',');
  const rows = await sql.unsafe<{ id: string | number }>(
    `SELECT id FROM automations WHERE id IN (${placeholders})`,
    automationIds,
  );
  return new Set(rows.map((row) => String(row.id)));
}

export async function requireAutomationAccess(
  sql: DbClient,
  automationIds: string[],
  ctx: ToolContext,
  mode: AutomationAccessMode,
  opts?: { allowMissing?: boolean }
): Promise<void> {
  const uniqueAutomationIds = [...new Set(automationIds)];
  const rows = await getAutomationAccessRows(uniqueAutomationIds, ctx.organizationId);
  if (rows.length !== uniqueAutomationIds.length) {
    // Some requested ids are absent from the caller's org. By default this is a
    // hard 403 — the strict gate every action but delete relies on, so no
    // action reaches a handler with an id it did not prove in-org.
    //
    // `allowMissing` (delete only) relaxes this ONE case: an id that exists
    // nowhere may fall through so the handler reports it per-id (delete's
    // all-failed "not found or already archived" aggregate). A cross-org id
    // (exists under another tenant) is STILL a 403 — never fall through for it,
    // or a caller could probe/hit foreign rows on the sequential id space.
    const foundIds = new Set(rows.map((row) => String(row.id)));
    const missingIds = uniqueAutomationIds.filter((id) => !foundIds.has(String(id)));
    if (opts?.allowMissing) {
      const existElsewhere = await findExistingAutomationIds(missingIds);
      if (existElsewhere.size > 0) {
        throw new ToolUserError(
          'Access denied: one or more Automations were not found in your organization',
          403,
        );
      }
    } else {
      throw new ToolUserError(
        'Access denied: one or more Automations were not found in your organization',
        403,
      );
    }
  }

  for (const row of rows) {
    const automationOrgId = row.organization_id ? String(row.organization_id) : null;
    if (!automationOrgId || automationOrgId !== ctx.organizationId) {
      // Cross-org access attempt is a client/permission fault, not a server
      // error — surface it as a 403 ToolUserError so the REST layer returns the
      // right status and it stays out of the operational alert feed.
      throw new ToolUserError(
        `Access denied: Automation ${row.id} does not belong to your organization`,
        403
      );
    }

    const entityIds = parseAutomationEntityIds(row.entity_ids);
    if (entityIds.length > 0) {
      for (const entityId of entityIds) {
        if (mode === 'write') {
          await requireWriteAccess(sql, entityId, ctx);
        } else {
          await requireReadAccess(sql, entityId, ctx);
        }
      }
      continue;
    }

    if (mode === 'write') {
      await requireOrgWriteAccess(sql, ctx);
    } else {
      await requireOrgReadAccess(sql, ctx);
    }
  }
}

// ============================================
// Batch content counting
// ============================================

import { entityLinkMatchSql } from '../../../utils/content-search';
import { getErrorMessage } from '@lobu/core';

/**
 * Batch count unanalyzed content for multiple automations in a single query.
 * Returns a map of automation_id -> count of content not yet analyzed by any run.
 */
export async function batchCountUnanalyzedContent(
  automationIds: number[]
): Promise<Map<number, { pending: number; historical: number }>> {
  if (automationIds.length === 0) {
    return new Map();
  }

  const sql = getDb();

  const placeholders = automationIds.map((_, i) => `$${i + 1}`).join(', ');

  // The "total content" count joins current_event_records on the entity link
  // for every automation in the result. On high-volume entities this scans
  // 100K+ rows per Automation and dominates list latency (8-12s on
  // prod for orgs with even a single Reddit-Digest-class automation).
  //
  // Cap the per-automation total at TOTAL_CAP rows. The badge derived from
  // `pending_count = total - analyzed` becomes "TOTAL_CAP+ - analyzed"
  // semantics above the cap; the only consumer is a list-row badge that
  // doesn't need exact counts above a threshold.
  const TOTAL_CAP = 1000;
  const result = await sql.unsafe(
    `
    WITH automation_entities AS (
      SELECT i.id as automation_id, unnest(i.entity_ids) as entity_id
      FROM automations i
      WHERE i.id IN (${placeholders})
        AND array_length(i.entity_ids, 1) > 0
    ),
    analyzed_counts AS (
      -- Link rows carry a denormalized automation_id, so count analyzed events
      -- directly without joining through runs.
      SELECT
        ie.automation_id,
        COUNT(DISTINCT iwc.event_id) as analyzed_count
      FROM (SELECT DISTINCT automation_id FROM automation_entities) ie
      LEFT JOIN automation_run_events iwc ON iwc.automation_id = ie.automation_id
      GROUP BY ie.automation_id
    ),
    total_counts AS (
      SELECT
        wid AS automation_id,
        (SELECT COUNT(*) FROM (
          SELECT 1 FROM automation_entities ie
          JOIN current_event_records f ON ${entityLinkMatchSql('ie.entity_id::bigint', 'f')}
          WHERE ie.automation_id = wid
          LIMIT ${TOTAL_CAP}
        ) capped) AS total_count
      FROM (SELECT DISTINCT automation_id AS wid FROM automation_entities) per_automation
    )
    SELECT
      ac.automation_id,
      CAST(GREATEST(COALESCE(tc.total_count, 0) - COALESCE(ac.analyzed_count, 0), 0) AS INTEGER) as pending_count,
      0 as historical_count
    FROM analyzed_counts ac
    LEFT JOIN total_counts tc ON tc.automation_id = ac.automation_id
    `,
    automationIds
  );

  const counts = new Map<number, { pending: number; historical: number }>();
  for (const row of result) {
    counts.set(Number(row.automation_id), {
      pending: (row.pending_count as number) ?? 0,
      historical: (row.historical_count as number) ?? 0,
    });
  }

  for (const id of automationIds) {
    if (!counts.has(id)) {
      counts.set(id, { pending: 0, historical: 0 });
    }
  }

  return counts;
}
