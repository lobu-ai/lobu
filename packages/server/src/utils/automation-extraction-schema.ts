/**
 * Automation extraction schema — composed from named durable outputs and an
 * optional reaction input contract.
 *
 * Entity output rows derive from their entity type's `metadata_schema`, so the
 * same schema governs manual writes and Automation promotion. Event output rows
 * use the standard event-draft envelope with their declared metadata schema.
 * Output names are top-level arrays.
 *
 * Both the worker payload (poll.ts / get_content — ships the contract to the
 * device) and window completion (complete-window.ts — validates the returned
 * data) resolve the schema through this helper, so extraction and validation can
 * never drift. A schemaless entity type still contributes a required array of
 * objects. Returns null only when there are no outputs and no reaction schema;
 * callers then use the worker's free-form `{ summary }` fallback.
 */

import { createHash } from 'node:crypto';
import { type DbClient, parsePgNumberArray } from '../db/client';
import type { Outputs } from '../types/automations';
import { readEventKindRegistry, type EventKindRegistry } from './event-kind-validation';
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

async function eventOutputRowSchema(
  registry: EventKindRegistry,
  kind: string,
  entityIds: number[],
  metadataSchemas: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const memberKinds = await registry.member();
  // A missing member registry permits any metadata on the write path.
  if (!memberKinds) return AutomationEventDraftSchema;
  const kinds = await Promise.all(entityIds.map((id) => registry.entityType(id)));
  const definitions = [...kinds, memberKinds].flatMap((registry) =>
    registry?.[kind] ? [registry[kind]] : []
  );
  if (!definitions.length || definitions.some((definition) => !definition.metadataSchema)) {
    return AutomationEventDraftSchema;
  }
  return {
    ...AutomationEventDraftSchema,
    allOf: [{
      // Explicit row linkage can select a different entity type's kind. Its
      // authorization and metadata still validate in the persistence path.
      if: { not: { required: ['entity_ids'] } },
      then: {
        properties: {
          metadata: {
            anyOf: [
              // Save validation deliberately accepts empty metadata.
              { type: 'object', maxProperties: 0 },
              ...definitions.map((definition) => {
                const schema = definition.metadataSchema!;
                const key = `event_${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}`;
                // Each standalone schema needs its own reference scope. Store it
                // once so repeated outputs don't register duplicate $id values.
                metadataSchemas[key] = { $id: `urn:lobu:${key}`, ...schema };
                return { $ref: `#/$defs/${key}` };
              }),
            ],
          },
        },
      },
    }],
  };
}

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
 *  1. Named outputs → entity schemas or event drafts with event-kind metadata.
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
  let reactionSchema: Record<string, unknown> | null = null;
  let entityIds: number[] = [];
  if (automationId != null && automationId !== '') {
    const rows = await sql<{
      reaction_input_schema: Record<string, unknown> | string | null;
      entity_ids: unknown;
    }>`
      SELECT reaction_input_schema, entity_ids FROM automations
      WHERE id = ${automationId} AND organization_id = ${organizationId}
      LIMIT 1
    `;
    entityIds = parsePgNumberArray(rows[0]?.entity_ids);
    const raw = rows[0]?.reaction_input_schema ?? null;
    if (raw != null) {
      const schema = typeof raw === 'string' ? safeParse(raw) : raw;
      if (schema && typeof schema === 'object' && Object.keys(schema).length > 0) {
        reactionSchema = schema as Record<string, unknown>;
      }
    }
  }
  const registry = readEventKindRegistry(organizationId, sql);
  const metadataSchemas: Record<string, unknown> = {};
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
        items: await eventOutputRowSchema(registry, output.event, entityIds, metadataSchemas),
      };
    }
  }

  const outputNames = Object.keys(outputProperties);
  if (outputNames.length > 0) {
    const schema = mergeObjectSchemas(reactionSchema, outputProperties, outputNames);
    if (Object.keys(metadataSchemas).length > 0) {
      schema.$defs = { ...schema.$defs as Record<string, unknown>, ...metadataSchemas };
    }
    return schema;
  }
  return reactionSchema;
}
