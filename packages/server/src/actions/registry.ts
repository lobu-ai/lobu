import { createAjv, formatAjvError } from '@lobu/core/ajv';
import {
  ActionDefinitionSchema,
  ActionKeySchema,
  type ActionDefinition,
  type ActionValueBinding,
  isActionFieldName,
} from '@lobu/core/contracts/tools/manage-actions';
import { Value } from '@sinclair/typebox/value';
import type { ValidateFunction } from 'ajv';
import type { DbClient } from '../db/client';
import { enforceAdminToolAllowlist, enforceRoleScopeAccess } from '../tools/access-control';
import type { ToolContext } from '../tools/registry';
import { ToolUserError } from '../utils/errors';
import { getEntityHooks } from '../utils/entity-hooks';
import { readEventKindRegistry, type EventKindDefinition } from '../utils/event-kind-validation';

const MAX_JSON_BYTES = 65_536;
const MAX_JSON_DEPTH = 16;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface ActionTypeRow {
  id: number;
  key: string;
  name: string;
  current_version: number;
  enabled: boolean;
}
export interface ActionVersionRow {
  id: number;
  version: number;
  definition: ActionDefinition;
}
interface TargetTypeRow {
  backing_sql: string | null;
  backing_source: string | null;
  event_kinds: Record<string, EventKindDefinition> | null;
}

function invalid(message: string): never {
  throw new ToolUserError(message, 422);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reject rich JS values before JSON serialization or recursive validators. */
export function assertActionJson(value: unknown, label: string): void {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > MAX_JSON_DEPTH) invalid(`${label} exceeds JSON complexity limits`);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null) invalid(`${label} must contain JSON values only`);
    if (seen.has(item)) invalid(`${label} must not contain cycles`);
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
    } else {
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null) invalid(`${label} must contain plain JSON objects`);
      for (const [key, child] of Object.entries(item)) {
        if (UNSAFE_KEYS.has(key)) invalid(`${label} contains an unsafe property name`);
        visit(child, depth + 1);
      }
    }
    seen.delete(item);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_JSON_BYTES) {
    invalid(`${label} exceeds ${MAX_JSON_BYTES} bytes`);
  }
}

function compileObjectSchema(schema: Record<string, unknown>, label: string): ValidateFunction {
  assertActionJson(schema, label);
  if (schema.type !== 'object') invalid(`${label} must declare type: object`);
  const checkKeywords = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) checkKeywords(child);
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === '$async' || key === '$ref' || key === '$dynamicRef' || key === '$recursiveRef') {
          invalid(`${label} does not support ${key}`);
        }
        checkKeywords(child);
      }
    }
  };
  checkKeywords(schema);
  try {
    return createAjv({
      allErrors: false,
      strict: false,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    }).compile(schema);
  } catch {
    invalid(`${label} is not a valid supported JSON Schema`);
  }
}

function checkSchemaValue(validate: ValidateFunction, value: unknown, label: string): void {
  if (validate(value)) return;
  const error = validate.errors?.[0];
  invalid(`${label}: ${error ? formatAjvError(error) : 'schema validation failed'}`);
}

async function readTargetType(
  sql: DbClient,
  organizationId: string,
  definition: ActionDefinition,
): Promise<TargetTypeRow> {
  if (definition.target.entityType.startsWith('$') || getEntityHooks(definition.target.entityType)) {
    invalid('Actions cannot target reserved entity types or entity lifecycle hooks');
  }
  const [row] = await sql<TargetTypeRow>`
    SELECT backing_sql, backing_source, event_kinds
    FROM entity_types
    WHERE organization_id = ${organizationId}
      AND slug = ${definition.target.entityType}
      AND deleted_at IS NULL
  `;
  if (!row) invalid('Action target entity type does not exist');
  if (row.backing_sql || row.backing_source) {
    invalid('Actions currently require an ordinary stored entity type');
  }
  return row;
}

async function readActionEventSchema(
  sql: DbClient,
  organizationId: string,
  definition: ActionDefinition,
  target?: TargetTypeRow,
): Promise<Record<string, unknown>> {
  // Event-kind definitions have no independent version history yet.
  if (definition.emits.schemaVersion !== 1) invalid('Only event schemaVersion 1 is supported');
  const kind = definition.emits.kind;
  const targetKinds = (target ?? await readTargetType(sql, organizationId, definition)).event_kinds;
  let kindDefinition = targetKinds && Object.hasOwn(targetKinds, kind) ? targetKinds[kind] : undefined;
  if (!kindDefinition) {
    const workspaceKinds = await readEventKindRegistry(organizationId, sql).member();
    kindDefinition = workspaceKinds && Object.hasOwn(workspaceKinds, kind) ? workspaceKinds[kind] : undefined;
  }
  if (!kindDefinition || !isRecord(kindDefinition.metadataSchema)) {
    invalid('Action event kind must be registered with a metadataSchema');
  }
  return kindDefinition.metadataSchema;
}

/** Recheck live membership; direct SDK/executor callers cannot synthesize a system writer. */
export async function requireActionPermission(
  sql: DbClient,
  ctx: ToolContext,
  permission: 'read' | 'write' | 'admin',
): Promise<void> {
  if (!ctx.userId || !ctx.organizationId) throw new ToolUserError('Authentication required', 401);
  const [member] = await sql<{ role: string }>`
    SELECT role FROM "member"
    WHERE "organizationId" = ${ctx.organizationId} AND "userId" = ${ctx.userId}
  `;
  if (!member) throw new ToolUserError('Workspace membership is required', 403);
  enforceAdminToolAllowlist(permission, 'manage_actions', ctx.adminTools);
  await enforceRoleScopeAccess(permission, { ...ctx, memberRole: member.role }, 'manage_actions',
    'Action invocation requires workspace membership with write access.', undefined, sql);
}

export async function validateActionDefinition(
  sql: DbClient,
  organizationId: string,
  definition: ActionDefinition,
): Promise<void> {
  assertActionJson(definition, 'Action definition');
  if (!Value.Check(ActionDefinitionSchema, definition)) invalid('Invalid action definition');
  const properties = definition.params.properties;
  if (!isRecord(properties) || Object.keys(properties).length > 50 ||
      definition.params.additionalProperties !== false) {
    invalid('Action params must declare at most 50 properties and additionalProperties:false');
  }
  for (const name of Object.keys(properties)) {
    if (!PARAM_NAME.test(name) || UNSAFE_KEYS.has(name)) invalid('Invalid action parameter name');
  }
  const requireParam = (name: string): void => {
    if (!Object.hasOwn(properties, name)) invalid(`Action parameter '${name}' is not declared`);
    if (!Array.isArray(definition.params.required) || !definition.params.required.includes(name)) {
      invalid(`Bound action parameter '${name}' must be required`);
    }
  };
  requireParam(definition.target.idParam);
  if (!Array.isArray(definition.params.required) || !definition.params.required.includes(definition.target.idParam)) {
    invalid('Action target idParam must be required');
  }
  const idSchema = properties[definition.target.idParam];
  if (!isRecord(idSchema) || idSchema.type !== 'integer') invalid('Action target idParam must have type: integer');
  compileObjectSchema(definition.params, 'Action params schema');
  const checkBinding = (binding: ActionValueBinding): void => {
    if ('param' in binding) requireParam(binding.param);
  };
  for (const [field, binding] of Object.entries(definition.set)) {
    if (!isActionFieldName(field)) invalid(`Action cannot write metadata field '${field}'`);
    checkBinding(binding);
  }
  for (const field of definition.requiredExpected ?? []) {
    if (!isActionFieldName(field)) invalid('Invalid requiredExpected field');
  }
  const transition = definition.transition;
  if (transition) {
    requireParam(transition.param);
    const binding = definition.set[transition.field];
    if (!binding || !('param' in binding) || binding.param !== transition.param) {
      invalid('Transition field must be set from its declared transition parameter');
    }
    const fromValues = transition.allowed.map((entry) => entry.from);
    if (new Set(fromValues).size !== fromValues.length) invalid('Transition sources must be unique');
  }
  for (const [field, binding] of Object.entries(definition.emits.payload)) {
    if (field.startsWith('_lobu_')) invalid('Action payload cannot override server attribution');
    checkBinding(binding);
  }
  const target = await readTargetType(sql, organizationId, definition);
  const eventSchema = await readActionEventSchema(sql, organizationId, definition, target);
  compileObjectSchema(eventSchema, 'Action event schema');
}

export function validateActionParams(
  definition: ActionDefinition,
  params: Record<string, unknown>,
): void {
  assertActionJson(params, 'Action params');
  checkSchemaValue(compileObjectSchema(definition.params, 'Action params schema'), params, 'Action params');
}

export async function validateActionEvent(
  sql: DbClient,
  organizationId: string,
  definition: ActionDefinition,
  payload: Record<string, unknown>,
): Promise<void> {
  assertActionJson(payload, 'Action event payload');
  const schema = await readActionEventSchema(sql, organizationId, definition);
  checkSchemaValue(compileObjectSchema(schema, 'Action event schema'), payload, 'Action event payload');
}

export async function getActionVersion(
  sql: DbClient,
  organizationId: string,
  key: string,
  version: number,
): Promise<{ id: number; key: string; version: number; versionId: number; enabled: boolean; definition: ActionDefinition }> {
  const [row] = await sql<{
    id: number; key: string; version: number; version_id: number; enabled: boolean; definition: ActionDefinition;
  }>`
    SELECT a.id, a.key, a.enabled, v.id AS version_id, v.version, v.definition
    FROM action_types a
    JOIN action_versions v ON v.action_type_id = a.id
    WHERE a.organization_id = ${organizationId} AND a.key = ${key} AND v.version = ${version}
  `;
  if (!row) throw new ToolUserError('Action version not found', 404);
  return {
    id: Number(row.id), key: row.key, version: Number(row.version),
    versionId: Number(row.version_id), enabled: row.enabled, definition: row.definition,
  };
}

export async function listActions(sql: DbClient, ctx: ToolContext): Promise<ActionTypeRow[]> {
  await requireActionPermission(sql, ctx, 'read');
  return sql<ActionTypeRow>`
    SELECT id, key, name, current_version, enabled FROM action_types
    WHERE organization_id = ${ctx.organizationId} ORDER BY key
  `;
}

export async function getAction(
  sql: DbClient,
  ctx: ToolContext,
  key: string,
  version?: number,
): Promise<{ action_type: ActionTypeRow; version: ActionVersionRow }> {
  await requireActionPermission(sql, ctx, 'read');
  const [row] = await sql<ActionTypeRow>`
    SELECT id, key, name, current_version, enabled FROM action_types
    WHERE organization_id = ${ctx.organizationId} AND key = ${key}
  `;
  if (!row) throw new ToolUserError('Action type not found', 404);
  const selected = await getActionVersion(sql, ctx.organizationId, key, version ?? Number(row.current_version));
  return {
    action_type: row,
    version: { id: selected.versionId, version: selected.version, definition: selected.definition },
  };
}

export async function publishAction(
  sql: DbClient,
  ctx: ToolContext,
  input: { key: string; name?: string; definition: ActionDefinition },
): Promise<{ action_type: ActionTypeRow; version: ActionVersionRow }> {
  if (!Value.Check(ActionKeySchema, input.key)) invalid('Invalid action key');
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 120)) {
    invalid('Invalid action name');
  }
  return sql.begin(async (tx) => {
    await requireActionPermission(tx, ctx, 'admin');
    await validateActionDefinition(tx, ctx.organizationId, input.definition);
    await tx`
      INSERT INTO action_types (organization_id, key, name, created_by_user_id)
      VALUES (${ctx.organizationId}, ${input.key}, ${input.name ?? input.key}, ${ctx.userId})
      ON CONFLICT (organization_id, key) DO NOTHING
    `;
    const [parent] = await tx<ActionTypeRow>`
      SELECT id, key, name, current_version, enabled FROM action_types
      WHERE organization_id = ${ctx.organizationId} AND key = ${input.key}
      FOR UPDATE
    `;
    const nextVersion = Number(parent.current_version) + 1;
    const [published] = await tx<ActionVersionRow>`
      INSERT INTO action_versions (action_type_id, version, definition, created_by_user_id)
      VALUES (${parent.id}, ${nextVersion}, ${tx.json(input.definition)}, ${ctx.userId})
      RETURNING id, version, definition
    `;
    const [updated] = await tx<ActionTypeRow>`
      UPDATE action_types
      SET current_version = ${nextVersion}, name = ${input.name ?? parent.name}, updated_at = now()
      WHERE id = ${parent.id}
      RETURNING id, key, name, current_version, enabled
    `;
    return { action_type: updated, version: published };
  });
}

export async function setActionEnabled(
  sql: DbClient,
  ctx: ToolContext,
  key: string,
  enabled: boolean,
): Promise<ActionTypeRow> {
  return sql.begin(async (tx) => {
    await requireActionPermission(tx, ctx, 'admin');
    const [row] = await tx<ActionTypeRow>`
      UPDATE action_types SET enabled = ${enabled}, updated_at = now()
      WHERE organization_id = ${ctx.organizationId} AND key = ${key}
      RETURNING id, key, name, current_version, enabled
    `;
    if (!row) throw new ToolUserError('Action type not found', 404);
    return row;
  });
}
