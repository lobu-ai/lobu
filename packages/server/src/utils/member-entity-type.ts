/**
 * Shared defaults and helpers for the built-in $member entity type.
 */

import { MEMBER_ROLES } from '../auth/member-role-policy';
import { getDb } from '../db/client';
import { type EventKindDefinition, primeMemberEventKinds } from './event-kind-validation';
import { GUIDANCE_SEMANTIC_TYPE } from './org-guidance';

interface MemberSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  format?: string;
  readOnly?: boolean;
  'x-email'?: boolean;
  'x-image'?: boolean;
  'x-table-column'?: boolean;
}

interface MemberMetadataSchema {
  type?: string;
  properties?: Record<string, MemberSchemaProperty>;
  required?: string[];
}

const BASE_MEMBER_EVENT_METADATA_SCHEMA = {
  type: 'object',
  properties: {
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    importance: { type: 'number', minimum: 0, maximum: 1 },
    namespace: { type: 'string' },
    status: { type: 'string', enum: ['active', 'archived', 'deleted'] },
  },
} as const;

const DEFAULT_MEMBER_EVENT_KINDS = {
  identity: {
    description: 'Facts about who a person or entity is',
    metadataSchema: BASE_MEMBER_EVENT_METADATA_SCHEMA,
  },
  preference: {
    description: 'User preferences and settings',
    metadataSchema: BASE_MEMBER_EVENT_METADATA_SCHEMA,
  },
  decision: {
    description: 'Decisions made by or about the member',
    metadataSchema: BASE_MEMBER_EVENT_METADATA_SCHEMA,
  },
  fact: {
    description: 'Verified facts or knowledge',
    metadataSchema: BASE_MEMBER_EVENT_METADATA_SCHEMA,
  },
  event: {
    description: 'Notable events or occurrences',
    metadataSchema: {
      type: 'object',
      properties: {
        ...BASE_MEMBER_EVENT_METADATA_SCHEMA.properties,
        valid_from: { type: 'string', format: 'date-time' },
        valid_to: { type: 'string', format: 'date-time' },
      },
    },
  },
  observation: {
    description: 'Observations and insights',
    metadataSchema: BASE_MEMBER_EVENT_METADATA_SCHEMA,
  },
  draft_reply: {
    description: 'A reply draft linked to the source event it responds to',
    metadataSchema: {
      type: 'object',
      properties: {
        ...BASE_MEMBER_EVENT_METADATA_SCHEMA.properties,
        platform: { type: 'string' },
        author: { type: 'string' },
        why: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        source_origin_id: { type: 'string' },
        source_event_id: { type: 'integer', minimum: 1 },
        source_connection_id: { type: 'integer', minimum: 1 },
      },
    },
  },
  todo: {
    description: 'Tasks and action items',
    metadataSchema: BASE_MEMBER_EVENT_METADATA_SCHEMA,
  },
  note: { description: 'General notes and content' },
  summary: { description: 'Summaries and digests' },
  content: { description: 'Generic content' },
  change: { description: 'Entity field changes and audit trail' },
  // Built-in org-wide context kind. Anchored by organization_id + semantic_type
  // (no $member/entity subject), it renders as "Organization Context" in every
  // agent prompt. Declared here so it validates through the normal $member
  // event_kinds registry rather than a code-level bypass in save_content; the
  // admin-only authorship/removal gates (org-guidance.ts) are orthogonal and
  // still apply. See issue #1913.
  guidance: { description: 'Organization-wide context injected into every agent prompt' },
} as const;

const DEFAULT_MEMBER_METADATA_SCHEMA = {
  type: 'object',
  properties: {
    email: {
      type: 'string',
      format: 'email',
      description: 'Email',
      'x-email': true,
      'x-table-column': true,
    },
    image_url: {
      type: 'string',
      format: 'uri',
      description: 'Profile image URL',
      'x-image': true,
    },
    role: {
      type: 'string',
      description: 'Role',
      enum: [...MEMBER_ROLES],
      'x-table-column': true,
    },
    status: {
      type: 'string',
      description: 'Status',
      enum: ['active', 'invited'],
      'x-table-column': true,
    },
    display_name: {
      type: 'string',
      description: 'Canonical display name from connectors',
      'x-table-column': true,
    },
    push_name: {
      type: 'string',
      description:
        'Self-chosen name from messaging platforms (WhatsApp push_name, Slack real_name)',
    },
    last_seen_at: {
      type: 'string',
      format: 'date-time',
      description: 'Most recent activity timestamp across connectors',
    },
    bio: {
      type: 'string',
      description: 'Free-form biography',
    },
  },
} as const satisfies MemberMetadataSchema;

function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function mergeEnumValues(existing: string[] | undefined, required: readonly string[]): string[] {
  const merged = [...(existing ?? [])];
  for (const value of required) {
    if (!merged.includes(value)) merged.push(value);
  }
  return merged;
}

function mergeMemberMetadataSchema(
  schema: Record<string, unknown> | null | undefined
): MemberMetadataSchema {
  const existing = (schema ?? null) as MemberMetadataSchema | null;
  const next: MemberMetadataSchema = {
    type: 'object',
    properties: { ...(existing?.properties ?? {}) },
    required: Array.isArray(existing?.required) ? [...existing.required] : undefined,
  };
  const properties = next.properties ?? {};

  const emailEntry =
    Object.entries(properties).find(([, prop]) => prop?.['x-email']) ??
    (properties.email ? ['email', properties.email] : undefined);
  if (emailEntry) {
    const [key, prop] = emailEntry;
    properties[key] = {
      ...prop,
      type: prop.type ?? 'string',
      format: prop.format ?? 'email',
      description: prop.description ?? 'Email',
      'x-email': true,
      'x-table-column': prop['x-table-column'] ?? true,
    };
  } else {
    properties.email = { ...DEFAULT_MEMBER_METADATA_SCHEMA.properties.email };
  }

  const imageEntry =
    Object.entries(properties).find(([, prop]) => prop?.['x-image']) ??
    (properties.image_url ? ['image_url', properties.image_url] : undefined);
  if (imageEntry) {
    const [key, prop] = imageEntry;
    properties[key] = {
      ...prop,
      type: prop.type ?? 'string',
      format: prop.format ?? 'uri',
      description: prop.description ?? 'Profile image URL',
      'x-image': true,
    };
  } else {
    properties.image_url = { ...DEFAULT_MEMBER_METADATA_SCHEMA.properties.image_url };
  }

  properties.role = properties.role
    ? {
        ...properties.role,
        type: 'string',
        enum: [...MEMBER_ROLES],
        description: properties.role.description ?? 'Role',
        'x-table-column': properties.role['x-table-column'] ?? true,
      }
    : { ...DEFAULT_MEMBER_METADATA_SCHEMA.properties.role };

  const statusProp = properties.status;
  properties.status = statusProp
    ? {
        ...statusProp,
        type: statusProp.type ?? 'string',
        description: statusProp.description ?? 'Status',
        enum: mergeEnumValues(
          statusProp.enum,
          DEFAULT_MEMBER_METADATA_SCHEMA.properties.status.enum
        ),
        'x-table-column': statusProp['x-table-column'] ?? true,
      }
    : { ...DEFAULT_MEMBER_METADATA_SCHEMA.properties.status };

  for (const key of ['display_name', 'push_name', 'last_seen_at', 'bio'] as const) {
    if (!properties[key]) {
      properties[key] = { ...DEFAULT_MEMBER_METADATA_SCHEMA.properties[key] };
    }
  }

  // user_id moved to entity_identities (namespace: auth_user_id). Drop the legacy scalar
  // from existing org schemas so the UI stops showing a stale field.
  delete properties.user_id;

  next.properties = properties;
  return next;
}

export async function ensureMemberEntityType(organizationId: string): Promise<void> {
  const sql = getDb();
  const existingRows = await sql`
    SELECT id, metadata_schema, event_kinds
    FROM entity_types
    WHERE slug = '$member'
      AND deleted_at IS NULL
      AND organization_id = ${organizationId}
    LIMIT 1
  `;

  if (existingRows.length === 0) {
    await sql`
      INSERT INTO entity_types (
        slug,
        name,
        description,
        icon,
        organization_id,
        metadata_schema,
        event_kinds,
        created_at,
        updated_at
      )
      VALUES (
        '$member',
        'Member',
        'Organization member',
        'user',
        ${organizationId},
        ${sql.json(DEFAULT_MEMBER_METADATA_SCHEMA)},
        ${sql.json(DEFAULT_MEMBER_EVENT_KINDS)},
        current_timestamp,
        current_timestamp
      )
      ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
      DO NOTHING
    `;
    // Prime this pod's cache with the seeded registry. A prior read may have
    // cached a `null` (no $member yet); overwrite it so the next validation in
    // this request sees the built-in kinds. (ON CONFLICT DO NOTHING means a
    // racing replica may have inserted first, but its event_kinds is the same
    // DEFAULT set, so priming with the default is still DB-accurate.)
    primeMemberEventKinds(
      organizationId,
      DEFAULT_MEMBER_EVENT_KINDS as unknown as Record<string, EventKindDefinition>
    );
    return;
  }

  const existing = existingRows[0];

  const mergedMetadataSchema = mergeMemberMetadataSchema(
    (existing.metadata_schema as Record<string, unknown> | null | undefined) ?? null
  );
  const existingMetadataSchema = (existing.metadata_schema ?? null) as MemberMetadataSchema | null;
  const shouldUpdateMetadataSchema = !memberMetadataSchemasEqual(
    existingMetadataSchema,
    mergedMetadataSchema
  );

  if (shouldUpdateMetadataSchema) {
    await sql`
      UPDATE entity_types
      SET metadata_schema = ${sql.json(mergedMetadataSchema)},
          updated_at = current_timestamp
      WHERE id = ${existing.id}
    `;
  }

  // Backfill ONLY system kinds introduced after org provisioning. They validate
  // through the registry, so an older explicit allowlist would otherwise reject
  // organization guidance or a declarative draft-reply output. Two deliberate
  // non-actions:
  // - A NULL registry is left NULL. NULL means "no allowlist, accept any kind"
  //   (validateKindAgainstDefinitions short-circuits to valid), so guidance
  //   already saves fine; materializing a partial registry would flip the org
  //   from accept-any to accept-only-system-kinds and reject the next note/fact
  //   save. The `event_kinds IS NOT NULL` guard preserves permissive mode.
  // - We do NOT restore older default kinds a non-null registry omits:
  //   `manage_entity_schema` lets an org intentionally remove a kind from its
  //   allowlist, and silently re-adding it would override that choice. Only the
  //   only newly introduced system kinds are added.
  //
  // Guarded UPDATE, then a SEPARATE read that primes the cache from current
  // committed truth:
  // - The UPDATE merges the system patch before `event_kinds` — a JSONB concat where the
  //   RIGHT (live DB) side wins per key, so an org's authored kinds, including any
  //   a CONCURRENT $member schema edit committed since our top-of-function SELECT,
  //   are preserved; only missing system keys are added. The guard skips the write
  //   when the registry is NULL (permissive) or both keys are already present (the
  //   hot path: this runs on every save).
  // - The read is a fresh statement whose snapshot opens AFTER the UPDATE returns,
  //   so it always reflects committed truth — including a `guidance` another
  //   replica backfilled concurrently. Two replicas racing this backfill: the one
  //   that loses the row-lock wait re-checks its WHERE against the winner's
  //   committed row (guidance now present), updates zero rows, then its SELECT
  //   still reads the winner's `guidance` and primes a registry that carries it.
  //   (A single-statement CTE that RETURNs-or-falls-back happens to be correct too
  //   — READ COMMITTED advances a blocked modifying statement's snapshot past the
  //   lock, so even its fallback SELECT sees the committed row — but two plain
  //   statements make that correctness obvious without leaning on EvalPlanQual
  //   snapshot-advance semantics. Verified against live PG.) Residual window: a
  //   backfill another replica COMMITS after this SELECT's snapshot opens isn't
  //   reflected until the 60s TTL lapses — the same bounded staleness every
  //   $member.event_kinds edit already has (the cache is TTL-only, never cross-pod
  //   busted), not a new regression.
  const requiredKindPatch = {
    guidance: DEFAULT_MEMBER_EVENT_KINDS.guidance,
    draft_reply: DEFAULT_MEMBER_EVENT_KINDS.draft_reply,
  };
  await sql`
    UPDATE entity_types
    SET event_kinds = ${sql.json(requiredKindPatch)} || event_kinds,
        updated_at = current_timestamp
    WHERE id = ${existing.id}
      AND event_kinds IS NOT NULL
      AND (
        NOT (event_kinds ? ${GUIDANCE_SEMANTIC_TYPE})
        OR NOT (event_kinds ? 'draft_reply')
      )
  `;
  const resolved = await sql<{ event_kinds: Record<string, EventKindDefinition> | null }>`
    SELECT event_kinds FROM entity_types WHERE id = ${existing.id}
  `;
  primeMemberEventKinds(organizationId, resolved.length > 0 ? resolved[0].event_kinds : null);
}

export function resolveMemberSchemaFieldsFromSchema(
  schema: Record<string, unknown> | null | undefined
): {
  emailField: string;
  imageField?: string;
} {
  const props = (schema as MemberMetadataSchema | null | undefined)?.properties;
  if (!props) return { emailField: 'email' };

  return {
    emailField: Object.entries(props).find(([, prop]) => prop?.['x-email'])?.[0] ?? 'email',
    imageField: Object.entries(props).find(([, prop]) => prop?.['x-image'])?.[0],
  };
}

function memberMetadataSchemasEqual(
  a: Record<string, unknown> | MemberMetadataSchema | null | undefined,
  b: Record<string, unknown> | MemberMetadataSchema | null | undefined
): boolean {
  const left = (a ?? null) as MemberMetadataSchema | null;
  const right = (b ?? null) as MemberMetadataSchema | null;
  if (left?.type !== right?.type) return false;
  if (!arraysEqual(left?.required, right?.required)) return false;

  const leftProps = left?.properties ?? {};
  const rightProps = right?.properties ?? {};
  const keys = new Set([...Object.keys(leftProps), ...Object.keys(rightProps)]);
  for (const key of keys) {
    if (JSON.stringify(leftProps[key] ?? null) !== JSON.stringify(rightProps[key] ?? null)) {
      return false;
    }
  }
  return true;
}
