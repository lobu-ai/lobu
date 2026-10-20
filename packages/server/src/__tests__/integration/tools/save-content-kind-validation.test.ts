/** Kind resolution for saves linked to an entity whose type declares the kind. */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  primeMemberEventKinds,
  validateSaveContentSemanticType,
} from '../../../utils/event-kind-validation';
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

  beforeEach(() => {
    primeMemberEventKinds(org.id, { note: { description: 'A note' } });
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
    primeMemberEventKinds(org.id, { source_item: { description: 'An unrestricted item' } });
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
    primeMemberEventKinds(org.id, { source_item: { metadataSchema: memberSchema } });
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
    primeMemberEventKinds(org.id, null);
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
