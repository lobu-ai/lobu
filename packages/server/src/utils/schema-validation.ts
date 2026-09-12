/**
 * Schema Validation Utility
 *
 * Validates entity metadata against JSON Schema (Draft 7) stored in entity_types table.
 * Uses ajv for validation with format support (uri, date, email, etc.).
 */

import { getDb } from '../db/client';
import type { ToolContext } from '../tools/registry';
import { formatAjvError, getAjv } from './ajv-singleton';
import { exceedsValidationLimits } from './metadata-limits';

// ============================================
// Types
// ============================================

interface ValidationError {
  path: string;
  message: string;
}

interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
}

interface MetadataValidationOptions {
  legacyAutomationEntityId?: number;
}

/**
 * Fetch the metadata schema for an entity type from the database.
 * Returns null if no schema is defined (allowing any metadata).
 *
 * Cross-org tolerance: an entity created in the caller's org may carry a
 * type from a public catalog (resolved via the schema search path in
 * `entity-management.ts:249-260`). To validate that entity's metadata we
 * must load the catalog's schema, not the caller's. Same lookup shape as
 * the create-side resolver: tenant first, then public catalogs.
 */
async function getEntityTypeSchema(
  entityType: string,
  ctx: ToolContext
): Promise<Record<string, unknown> | null> {
  const sql = getDb();

  const rows = await sql.unsafe(
    `SELECT et.metadata_schema
     FROM entity_types et
     LEFT JOIN organization o ON o.id = et.organization_id
     WHERE et.slug = $1
       AND et.deleted_at IS NULL
       AND (et.organization_id = $2 OR o.visibility = 'public')
     ORDER BY (et.organization_id = $2) DESC, et.id ASC
     LIMIT 1`,
    [entityType, ctx.organizationId]
  );

  return (rows[0]?.metadata_schema as Record<string, unknown>) ?? null;
}

// ============================================
// Validation Functions
// ============================================

/**
 * Metadata keys stamped by automation promotion (`promote-keyed-entities.ts`):
 * platform provenance, not part of any entity-type schema. Excluded from
 * validation so a promoted entity's metadata round-trips — read it, edit a
 * domain field, write it back — under an `additionalProperties: false`
 * schema. `source` is deliberately NOT here: it is a plausible domain field,
 * so it stays subject to the type's schema.
 */
const AUTOMATION_PROVENANCE_KEYS = [
  'automation_id',
  'stable_key',
  'run_id',
  'automation_output',
];

function withoutAutomationProvenanceKeys(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  if (!AUTOMATION_PROVENANCE_KEYS.some((key) => key in metadata)) return metadata;
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !AUTOMATION_PROVENANCE_KEYS.includes(key))
  );
}

function schemaMayDefineSource(schema: Record<string, unknown>): boolean {
  const properties = schema.properties;
  if (
    properties &&
    typeof properties === 'object' &&
    !Array.isArray(properties) &&
    Object.hasOwn(properties, 'source')
  ) return true;
  const patterns = schema.patternProperties;
  if (
    patterns &&
    typeof patterns === 'object' &&
    !Array.isArray(patterns) &&
    Object.keys(patterns).some((pattern) => new RegExp(pattern).test('source'))
  ) return true;
  if (Array.isArray(schema.required) && schema.required.includes('source')) return true;
  return schema.additionalProperties !== false;
}

/**
 * Validate entity metadata against the entity type's JSON schema.
 *
 * Returns { valid: true } if:
 * - Metadata passes schema validation
 * - No schema is defined for the entity type (allows any metadata)
 * - Metadata is undefined/null
 *
 * Returns { valid: false, errors: [...] } if validation fails.
 */
export async function validateEntityMetadata(
  entityType: string,
  metadata: Record<string, unknown> | undefined | null,
  ctx: ToolContext,
  options: MetadataValidationOptions = {}
): Promise<ValidationResult> {
  // No metadata provided - valid (defaults to empty object). An explicit empty
  // object still needs schema validation because the schema may require fields.
  if (!metadata) {
    return { valid: true };
  }

  // Bound untrusted input before ANY expensive work. The guard is cheap and
  // short-circuits, so rejecting an oversized/deeply-nested payload here also
  // saves the schema-fetch DB round-trip below — and avoids handing a DoS
  // payload to AJV. Pathologically large metadata is a vector regardless of
  // AJV config, so reject it as a normal validation failure.
  if (exceedsValidationLimits(metadata)) {
    return {
      valid: false,
      errors: [{ path: '/', message: 'metadata exceeds size/nesting limits' }],
    };
  }

  // Fetch schema for this entity type
  const schema = await getEntityTypeSchema(entityType, ctx);

  // No schema defined - allow any metadata
  if (!schema || Object.keys(schema).length === 0) {
    return { valid: true };
  }

  // Validate metadata against schema, ignoring platform provenance keys —
  // they are stamped by automation promotion outside this validator and would
  // otherwise fail every round-trip under additionalProperties: false.
  const ajv = getAjv();
  const validate = ajv.compile(schema);
  let candidate = withoutAutomationProvenanceKeys(metadata);
  let isValid = validate(candidate);
  // Old promotion stamped this exact marker even when source was not a domain
  // field. Only an update of an existing promoted row may ignore it, and only
  // when the schema does not define source as domain data.
  if (
    !isValid &&
    options.legacyAutomationEntityId != null &&
    candidate !== metadata &&
    candidate.source === 'automation_promotion' &&
    !schemaMayDefineSource(schema) &&
    validate.errors?.some(
      (error) => error.instancePath === '' &&
        error.keyword === 'additionalProperties' &&
        error.params.additionalProperty === 'source'
    )
  ) {
    const identities = await getDb()`
      SELECT 1
      FROM entity_identities
      WHERE entity_id = ${options.legacyAutomationEntityId}
        AND organization_id = ${ctx.organizationId}
        AND namespace = 'automation_key'
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (identities.length > 0) {
      candidate = { ...candidate };
      delete candidate.source;
      isValid = validate(candidate);
    }
  }
  if (candidate !== metadata) {
    // The AJV singleton runs with coerceTypes, mutating the validated object
    // in place — callers persist those coercions. When we validated a stripped
    // copy, propagate its top-level coercions back (nested objects are shared
    // by reference, so deeper coercions already landed).
    for (const [key, value] of Object.entries(candidate)) {
      metadata[key] = value;
    }
  }

  if (isValid) {
    return { valid: true };
  }

  // Format errors for client consumption
  const errors: ValidationError[] = (validate.errors ?? []).map((err) => ({
    path: err.instancePath || '/',
    message: formatAjvError(err),
  }));

  return { valid: false, errors };
}
