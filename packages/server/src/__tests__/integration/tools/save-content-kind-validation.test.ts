/** Kind resolution for saves linked to an entity whose type declares the kind. */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  primeMemberEventKinds,
  readEventKindRegistry,
  resolveEventKindDefinition,
  type EventKindDefinition,
  validateSaveContentSemanticType,
} from '../../../utils/event-kind-validation';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEntity, createTestOrganization } from '../../setup/test-fixtures';

describe('validateSaveContentSemanticType > entity-type kinds', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let alternative: Awaited<ReturnType<typeof createTestEntity>>;
  let unrelated: Awaited<ReturnType<typeof createTestEntity>>;
  const sql = getTestDb();
  const metadataSchema = {
    type: 'object',
    required: ['item'],
    properties: { item: { type: 'string', enum: ['post', 'comment'] } },
  };

  beforeAll(async () => {
    await cleanupTestDatabase();
    org = await createTestOrganization({ name: 'Kind Validation Org' });
    await ensureMemberEntityType(org.id);
    entity = await createTestEntity({ name: 'Kind Validation Topic', organization_id: org.id });
    alternative = await createTestEntity({
      name: 'Alternative Kind Validation Topic',
      entity_type: 'alternative-kind',
      organization_id: org.id,
    });
    unrelated = await createTestEntity({
      name: 'Unrelated Kind Validation Topic',
      entity_type: 'unrelated-kind',
      organization_id: org.id,
    });
    await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json({
        source_item: {
          description: 'A collected item',
          metadataSchema,
        },
      })}
      WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${entity.id})
    `;
    await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json({
        source_item: {
          metadataSchema: {
            type: 'object',
            properties: { item: { type: 'string', enum: ['reply'] } },
          },
        },
      })}
      WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${alternative.id})
    `;
    await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json({ other_kind: { description: 'An unrelated kind' } })}
      WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${unrelated.id})
    `;
  });

  async function setMemberKinds(kinds: Record<string, EventKindDefinition> | null) {
    // Write the actual schema: authoring no longer treats a cache as DB truth.
    await sql`
      UPDATE entity_types
      SET event_kinds = ${kinds === null ? null : JSON.stringify(kinds)}::jsonb
      WHERE organization_id = ${org.id} AND slug = '$member'
    `;
    primeMemberEventKinds(org.id, kinds);
  }

  beforeEach(async () => {
    await setMemberKinds({ note: { description: 'A note' } });
  });

  it('accepts metadata that matches the declared kind', async () => {
    const result = await validateSaveContentSemanticType(
      'source_item',
      { item: 'comment' },
      org.id,
      [entity.id]
    );
    expect(result.valid).toBe(true);
  });

  it('reports the metadata mismatch, not an unknown kind, when the linked type declares it', async () => {
    const result = await validateSaveContentSemanticType(
      'source_item',
      { item: 'reply' },
      org.id,
      [entity.id]
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Metadata validation failed for kind 'source_item'/);
    expect(result.errors.join('\n')).toContain('post');
    expect(result.errors.join('\n')).toContain('comment');
    expect(result.expectedSchema).toEqual(metadataSchema);
    expect(result.validKinds).toEqual(['source_item']);
    expect(result.suggestion).toBeNull();
  });

  it.each([false, true])(
    'preserves the declared mismatch in either entity order (reverse=%s)',
    async (reverse) => {
      const ids = [entity.id, unrelated.id];
      const result = await validateSaveContentSemanticType(
        'source_item',
        { item: 'reply' },
        org.id,
        reverse ? ids.reverse() : ids
      );
      expect(result.valid).toBe(false);
      expect(result.expectedSchema).toEqual(metadataSchema);
      expect(result.errors[0]).toContain("Metadata validation failed for kind 'source_item'");
    }
  );

  it.each([false, true])('accepts any matching linked schema (reverse=%s)', async (reverse) => {
    const ids = [entity.id, alternative.id];
    const result = await validateSaveContentSemanticType(
      'source_item',
      { item: 'reply' },
      org.id,
      reverse ? ids.reverse() : ids
    );
    expect(result.valid).toBe(true);
  });

  it('accepts a matching $member kind after a linked metadata mismatch', async () => {
    await setMemberKinds({ source_item: { description: 'An unrestricted item' } });
    const result = await validateSaveContentSemanticType(
      'source_item',
      { item: 'reply' },
      org.id,
      [entity.id]
    );
    expect(result.valid).toBe(true);
  });

  it('preserves the $member metadata error when it also declares the kind', async () => {
    const memberSchema = { type: 'object', required: ['member_item'] };
    await setMemberKinds({ source_item: { metadataSchema: memberSchema } });
    const result = await validateSaveContentSemanticType(
      'source_item',
      { item: 'reply' },
      org.id,
      [entity.id]
    );
    expect(result.valid).toBe(false);
    expect(result.expectedSchema).toEqual(memberSchema);
    expect(result.errors.join('\n')).toContain('member_item');
  });

  it('preserves permissive validation when there is no $member registry', async () => {
    await setMemberKinds(null);
    const result = await validateSaveContentSemanticType(
      'source_item',
      { item: 'reply' },
      org.id,
      [entity.id]
    );
    expect(result.valid).toBe(true);
  });

  it('still reports an unknown kind when no linked type or $member declares it', async () => {
    const result = await validateSaveContentSemanticType('missing_kind', {}, org.id, [entity.id]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid kind 'missing_kind'/);
  });
});

// Another replica changes the registry while this pod's 60s cache is warm. Write
// validation must read committed (or the caller's transaction) state, never the
// cached copy; rendering may keep using the cache.
describe('validateSaveContentSemanticType > stale per-pod cache', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  const sql = getTestDb();

  beforeAll(async () => {
    org = await createTestOrganization({ name: 'Kind Freshness Org' });
    await ensureMemberEntityType(org.id);
    entity = await createTestEntity({
      name: 'Kind Freshness Topic',
      entity_type: 'freshness-kind',
      organization_id: org.id,
    });
  });

  async function writeMemberKinds(kinds: Record<string, EventKindDefinition>) {
    await sql`
      UPDATE entity_types SET event_kinds = ${sql.json(kinds)}
      WHERE organization_id = ${org.id} AND slug = '$member'
    `;
  }

  it('accepts a kind registered after the cache warmed', async () => {
    await writeMemberKinds({ note: {}, new_kind: {} });
    primeMemberEventKinds(org.id, { note: {} });
    expect((await validateSaveContentSemanticType('new_kind', {}, org.id)).valid).toBe(true);
  });

  it('rejects a removed kind that the cache still holds', async () => {
    await writeMemberKinds({ note: {} });
    primeMemberEventKinds(org.id, { note: {}, retired: {} });
    expect((await validateSaveContentSemanticType('retired', {}, org.id)).valid).toBe(false);
  });

  it('enforces a tightened metadata schema over the loose cached one', async () => {
    await writeMemberKinds({
      report: {
        metadataSchema: {
          type: 'object',
          required: ['source_revision'],
          properties: { source_revision: { type: 'integer' } },
        },
      },
    });
    primeMemberEventKinds(org.id, { report: {} });
    const result = await validateSaveContentSemanticType('report', { text: 'x' }, org.id);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('source_revision');
  });

  it('bypasses the linked entity-type cache too', async () => {
    const setEntityKinds = (kinds: Record<string, EventKindDefinition>) => sql`
      UPDATE entity_types SET event_kinds = ${sql.json(kinds)}
      WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${entity.id})
    `;
    await writeMemberKinds({ note: {} });
    await setEntityKinds({ old_kind: {} });
    // Warm the render cache for this entity, then change the type underneath it.
    expect(await resolveEventKindDefinition('old_kind', org.id, [entity.id])).toEqual({});
    await setEntityKinds({ new_entity_kind: {} });
    const result = await validateSaveContentSemanticType('new_entity_kind', {}, org.id, [entity.id]);
    expect(result.valid).toBe(true);
  });

  it('validates against the caller transaction without leaking it into the render cache', async () => {
    await writeMemberKinds({ note: {} });
    primeMemberEventKinds(org.id, { note: {} });
    await sql
      .begin(async (tx) => {
        await tx`
          UPDATE entity_types SET event_kinds = ${tx.json({ note: {}, uncommitted: {} })}
          WHERE organization_id = ${org.id} AND slug = '$member'
        `;
        const result = await validateSaveContentSemanticType(
          'uncommitted',
          {},
          org.id,
          undefined,
          readEventKindRegistry(org.id, tx)
        );
        expect(result.valid).toBe(true);
        throw new Error('rollback');
      })
      .catch((error: Error) => {
        if (error.message !== 'rollback') throw error;
      });
    expect(await resolveEventKindDefinition('uncommitted', org.id)).toBeNull();
    expect((await validateSaveContentSemanticType('uncommitted', {}, org.id)).valid).toBe(false);
  });
});
