import type { DbClient } from '../db/client';
import { ToolUserError, errorMessage } from './errors';
import { assertNotAclManagedEdge } from './relationship-validation';

type UnknownRecord = Record<string, unknown>;

interface ConnectorRelationshipReference {
  feedKey: string;
  eventKind: string;
  type: string;
}

interface ConnectorRelationshipMetadata {
  key: string;
  feeds: UnknownRecord | null;
}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function context(metadata: ConnectorRelationshipMetadata, feedKey: string, eventKind: string): string {
  return `Connector '${metadata.key}' feed '${feedKey}' event kind '${eventKind}'`;
}

/**
 * Validate the connector-local declaration graph and return the relationship
 * type references the organization-scoped preflight must resolve.
 */
export function validateConnectorRelationshipDeclarations(
  metadata: ConnectorRelationshipMetadata
): ConnectorRelationshipReference[] {
  const references: ConnectorRelationshipReference[] = [];
  if (!metadata.feeds) return references;

  for (const [feedKey, feedValue] of Object.entries(metadata.feeds)) {
    const feed = record(feedValue);
    if (!feed) continue;
    const eventKinds = record(feed.eventKinds);
    if (!eventKinds) continue;

    for (const [eventKind, eventKindValue] of Object.entries(eventKinds)) {
      const declaration = record(eventKindValue);
      if (!declaration) continue;
      const label = context(metadata, feedKey, eventKind);
      const names = new Set<string>();

      if (declaration.attributions !== undefined) {
        if (!Array.isArray(declaration.attributions)) {
          throw new Error(`${label}: attributions must be an array.`);
        }
        for (const attributionValue of declaration.attributions) {
          const attribution = record(attributionValue);
          if (!attribution) {
            throw new Error(`${label}: every attribution must be an object.`);
          }
          if (!Object.hasOwn(attribution, 'name')) continue;
          if (typeof attribution.name !== 'string' || attribution.name.trim().length === 0) {
            throw new Error(`${label}: attribution name must be a non-empty string.`);
          }
          if (names.has(attribution.name)) {
            throw new Error(`${label}: duplicate attribution name '${attribution.name}'.`);
          }
          names.add(attribution.name);
        }
      }

      if (declaration.relationships === undefined) continue;
      if (!Array.isArray(declaration.relationships)) {
        throw new Error(`${label}: relationships must be an array.`);
      }

      const triples = new Set<string>();
      for (const relationshipValue of declaration.relationships) {
        const relationship = record(relationshipValue);
        if (!relationship) {
          throw new Error(`${label}: every relationship must be an object.`);
        }
        for (const field of ['type', 'from', 'to'] as const) {
          const value = relationship[field];
          if (typeof value !== 'string' || value.trim().length === 0) {
            throw new Error(`${label}: relationship ${field} must be a non-empty string.`);
          }
        }

        const type = relationship.type as string;
        const from = relationship.from as string;
        const to = relationship.to as string;
        for (const [side, name] of [
          ['from', from],
          ['to', to],
        ] as const) {
          if (!names.has(name)) {
            throw new Error(
              `${label}: relationship ${side} reference '${name}' does not resolve to a named attribution.`
            );
          }
        }

        const triple = `${type}\u0000${from}\u0000${to}`;
        if (triples.has(triple)) {
          throw new Error(
            `${label}: duplicate relationship declaration '${type}' (${from} -> ${to}).`
          );
        }
        triples.add(triple);
        references.push({ feedKey, eventKind, type });
      }
    }
  }

  return references;
}

/**
 * Resolve every declared relationship type against the target organization's
 * active schema and refuse authorization-bearing edge vocabularies.
 */
export async function preflightConnectorRelationshipTypes(params: {
  sql: DbClient;
  organizationId: string;
  metadata: ConnectorRelationshipMetadata;
}): Promise<void> {
  const references = validateConnectorRelationshipDeclarations(params.metadata);
  const firstReferenceByType = new Map<string, ConnectorRelationshipReference>();
  for (const reference of references) {
    if (!firstReferenceByType.has(reference.type)) {
      firstReferenceByType.set(reference.type, reference);
    }
  }

  for (const [type, reference] of firstReferenceByType) {
    // Only ACTIVE rows are unique per (organization_id, slug) — the unique index
    // is partial — so a slug can carry several archived rows alongside the live
    // one, in any id order. Rank the live row first and fall back to the newest
    // so a same-slug tombstone cannot mask an active type.
    const rows = (await params.sql`
      SELECT slug, status, deleted_at, purpose
      FROM entity_relationship_types
      WHERE organization_id = ${params.organizationId}
        AND slug = ${type}
      ORDER BY (status = 'active' AND deleted_at IS NULL) DESC, id DESC
      LIMIT 1
    `) as unknown as Array<{
      slug: string;
      status: string;
      deleted_at: Date | string | null;
      purpose: string | null;
    }>;
    const label = context(params.metadata, reference.feedKey, reference.eventKind);
    const row = rows[0];
    if (!row) {
      throw new ToolUserError(
        `${label}: relationship type '${type}' does not exist in this organization.`,
        400
      );
    }
    if (row.status !== 'active' || row.deleted_at !== null) {
      throw new ToolUserError(`${label}: relationship type '${type}' is not active.`, 400);
    }
    try {
      assertNotAclManagedEdge(row, 'connector relationship preflight');
    } catch (error) {
      // Keep the status the ACL guard chose. Re-wrapping as a bare Error would
      // turn its deliberate 403 into a 500 plus an error-log alert, for what is a
      // caller-fixable connector definition.
      throw new ToolUserError(
        `${label}: ${errorMessage(error)}`,
        error instanceof ToolUserError ? error.httpStatus : 403
      );
    }
  }
}
