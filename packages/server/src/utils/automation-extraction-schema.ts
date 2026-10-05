/**
 * Automation extraction schema — composed from named durable outputs and an
 * optional reaction input contract.
 *
 * Entity output rows derive from their entity type's `metadata_schema`, so the
 * same schema governs manual writes and Automation promotion. Event output rows
 * use one standard event-draft envelope. Output names are top-level arrays.
 *
 * Both the worker payload (poll.ts / get_content — ships the contract to the
 * device) and window completion (complete-window.ts — validates the returned
 * data) resolve the schema through this helper, so extraction and validation can
 * never drift. A schemaless entity type still contributes a required array of
 * objects. Returns null only when there are no outputs and no reaction schema;
 * callers then use the worker's free-form `{ summary }` fallback.
 */

import type { DbClient } from '../db/client';
import type { Outputs } from '../types/automations';
import {
  MAX_STABLE_KEY_COMPONENT_BYTES,
} from './stable-keys';

export const MAX_AUTOMATION_OUTPUT_ROWS = 500;

const STABLE_KEY_VALUE_SCHEMA = {
  anyOf: [
    {
      type: 'string',
      minLength: 1,
      maxLength: MAX_STABLE_KEY_COMPONENT_BYTES,
    },
    {
      type: 'integer',
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    { type: 'boolean' },
  ],
};

function entityOutputRowSchema(
  metadataSchema: Record<string, unknown> | null,
  keyFields: string[]
): Record<string, unknown> {
  return {
    allOf: [
      metadataSchema ?? { type: 'object' },
      {
        type: 'object',
        properties: Object.fromEntries(
          keyFields.map((field) => [field, STABLE_KEY_VALUE_SCHEMA])
        ),
        required: keyFields,
      },
    ],
  };
}

/**
 * Resolve an entity type's `metadata_schema` (JSON Schema Draft-7), tenant-first
 * then public catalog — the same precedence as `schema-validation.ts` and the
 * keyed-promotion type resolver, so derivation and promotion agree on the type.
 */
async function resolveEntityTypeMetadataSchema(
  sql: DbClient,
  organizationId: string,
  entityTypeSlug: string
): Promise<Record<string, unknown> | null> {
  const rows = await sql<{ metadata_schema: Record<string, unknown> | string | null }>`
    SELECT et.metadata_schema
    FROM entity_types et
    LEFT JOIN organization o ON o.id = et.organization_id
    WHERE et.slug = ${entityTypeSlug}
      AND et.deleted_at IS NULL
      AND (et.organization_id = ${organizationId} OR o.visibility = 'public')
    ORDER BY (et.organization_id = ${organizationId}) DESC, et.id ASC
    LIMIT 1
  `;
  const raw = rows[0]?.metadata_schema ?? null;
  if (raw == null) return null;
  const schema = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!schema || typeof schema !== 'object' || Object.keys(schema).length === 0) {
    return null;
  }
  return schema as Record<string, unknown>;
}

function safeParse(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export const AutomationEventDraftSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    content: { type: 'string', minLength: 1 },
    title: { type: 'string' },
    metadata: { type: 'object' },
    author: { type: 'string' },
    source_url: { type: 'string' },
    occurred_at: { type: 'string', format: 'date-time' },
    parent_event_id: { type: 'integer', minimum: 1 },
    payload_type: { enum: ['text', 'markdown'] },
    idempotency_key: { type: 'string', minLength: 1, maxLength: 255 },
    entity_ids: {
      type: 'array',
      items: { type: 'integer', minimum: 1 },
      minItems: 1,
      uniqueItems: true,
    },
  },
  required: ['content'],
  additionalProperties: false,
};

function mergeObjectSchemas(
  reaction: Record<string, unknown> | null,
  outputProperties: Record<string, unknown>,
  outputNames: string[]
): Record<string, unknown> {
  if (!reaction || reaction.type !== 'object') {
    return {
      type: 'object',
      properties: outputProperties,
      required: outputNames,
    };
  }
  const reactionProperties =
    reaction.properties && typeof reaction.properties === 'object'
      ? (reaction.properties as Record<string, unknown>)
      : {};
  const reactionRequired = Array.isArray(reaction.required)
    ? reaction.required.filter((value): value is string => typeof value === 'string')
    : [];
  const mergedProperties = { ...reactionProperties };
  for (const [name, outputSchema] of Object.entries(outputProperties)) {
    const reactionSchema = reactionProperties[name];
    // A reaction may refine a declared output (for example, require domain
    // metadata inside a standard event draft). Preserve both contracts instead
    // of silently replacing the reaction's property with the durable-output
    // property. `allOf` also makes an incompatible refinement fail validation
    // before either persistence or side effects run.
    mergedProperties[name] = reactionSchema
      ? { allOf: [reactionSchema, outputSchema] }
      : outputSchema;
  }
  return {
    ...reaction,
    properties: mergedProperties,
    required: [...new Set([...reactionRequired, ...outputNames])],
  };
}

/**
 * Derive an automation's extraction schema. Precedence:
 *  1. Named outputs → entity metadata schemas or the standard event draft.
 *  2. Reaction Automation → the reaction's exported `input` schema, cached on
 *     `automations.reaction_input_schema` when the automation is created or its script
 *     is set. A property that is also a declared output refines that output via
 *     JSON Schema `allOf`; reaction-only properties are added alongside it.
 *  3. Otherwise null — the worker runs the free-form `{ summary }` fallback.
 *
 * Both the worker payload and complete_window validation resolve through here,
 * so extraction and validation can never drift. `automationId` enables the reaction
 * lookup; omit it to skip step 2 (entity-typed-only callers).
 */
export async function deriveAutomationExtractionSchema(
  sql: DbClient,
  organizationId: string,
  outputs: Outputs | null | undefined,
  automationId?: string | number | null
): Promise<Record<string, unknown> | null> {
  const outputProperties: Record<string, unknown> = {};
  for (const [name, output] of Object.entries(outputs ?? {})) {
    if ('entity' in output) {
      const metadataSchema = await resolveEntityTypeMetadataSchema(
        sql,
        organizationId,
        output.entity
      );
      outputProperties[name] = {
        type: 'array',
        maxItems: MAX_AUTOMATION_OUTPUT_ROWS,
        items: entityOutputRowSchema(metadataSchema, output.key),
      };
    } else {
      outputProperties[name] = {
        type: 'array',
        maxItems: MAX_AUTOMATION_OUTPUT_ROWS,
        items: AutomationEventDraftSchema,
      };
    }
  }

  let reactionSchema: Record<string, unknown> | null = null;
  if (automationId != null && automationId !== '') {
    const rows = await sql<{ reaction_input_schema: Record<string, unknown> | string | null }>`
      SELECT reaction_input_schema FROM automations
      WHERE id = ${automationId} AND organization_id = ${organizationId}
      LIMIT 1
    `;
    const raw = rows[0]?.reaction_input_schema ?? null;
    if (raw != null) {
      const schema = typeof raw === 'string' ? safeParse(raw) : raw;
      if (schema && typeof schema === 'object' && Object.keys(schema).length > 0) {
        reactionSchema = schema as Record<string, unknown>;
      }
    }
  }
  const outputNames = Object.keys(outputProperties);
  if (outputNames.length > 0) {
    return mergeObjectSchemas(reactionSchema, outputProperties, outputNames);
  }
  return reactionSchema;
}
