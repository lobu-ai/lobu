import type { EntityTraitSpec } from '@lobu/connector-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import { createTestEntity, seedOwnerContext } from '../../__tests__/setup/test-fixtures';
import { applyEventAttributions, clearEntityLinkRulesCache } from '../entity-link-upsert';
import { updateEntity } from '../entity-management';

const CONNECTOR = 'test.trait-ownership';
const ENTITY_TYPE = 'test-contact';
const EMAIL = 'contact@example.test';

async function setupContact(metadata: Record<string, unknown> = {}) {
  const { org, user, ctx } = await seedOwnerContext({ orgName: 'Trait ownership test' });
  const entity = await createTestEntity({
    name: 'Test contact',
    entity_type: ENTITY_TYPE,
    organization_id: org.id,
    created_by: user.id,
  });
  const sql = getTestDb();
  await sql`UPDATE entities SET metadata = ${sql.json({ aliases: [EMAIL], ...metadata })}
    WHERE id = ${entity.id}`;
  await sql`INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
    VALUES (${org.id}, ${entity.id}, 'email', ${EMAIL})`;
  return { org, user, ctx, entity };
}

async function readContact(entityId: number) {
  const [row] = await getTestDb()<{
    metadata: Record<string, unknown>;
    field_controls: Record<string, unknown>;
    updated_at: Date;
  }[]>`SELECT metadata, field_controls, updated_at FROM entities WHERE id = ${entityId}`;
  return row;
}

function attribute(
  orgId: string,
  values: Record<string, unknown>,
  strategies: Record<string, EntityTraitSpec['mergeStrategy']>,
  email = EMAIL,
) {
  const item = { origin_type: 'contact', metadata: { email, ...values } };
  return {
    item,
    resolve: () => applyEventAttributions({
      orgId,
      connectorKey: CONNECTOR,
      items: [item],
      rules: {
        contact: [{
          role: 'about',
          entityType: ENTITY_TYPE,
          autoCreate: true,
          identities: [{ namespace: 'email', eventPath: 'metadata.email' }],
          traits: Object.fromEntries(Object.entries(strategies).map(([field, mergeStrategy]) => [
            field, { eventPath: `metadata.${field}`, mergeStrategy },
          ])),
        }],
      },
    }),
  };
}

describe('connector trait ownership', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it.each(['overwrite', 'prefer_non_empty'] as const)(
    '%s preserves human values, including explicit empty and null values',
    async (strategy) => {
      const { org, ctx, entity } = await setupContact({
        label: 'Initial label', empty: 'Initial value', cleared: 'Initial value',
      });
      await updateEntity(entity.id, {
        metadata: { label: 'Human label', empty: '', cleared: null },
      }, {}, ctx);
      const before = await readContact(entity.id);
      expect(Object.keys(before.field_controls).sort()).toEqual(['cleared', 'empty', 'label']);

      const source = { label: 'Source label', empty: 'Source value', cleared: 'Source value', fresh: 'New fact' };
      const { item, resolve } = attribute(org.id, source, {
        label: strategy, empty: strategy, cleared: strategy, fresh: strategy,
      });
      const resolved = await resolve();

      expect(resolved.entityIdsByItem.get(0)).toEqual([entity.id]);
      const after = await readContact(entity.id);
      expect(after.metadata).toMatchObject({
        label: 'Human label', empty: '', cleared: null, fresh: 'New fact',
      });
      expect(after.field_controls).toEqual(before.field_controls);
      // The source observation still reaches the event writer unchanged.
      expect(item.metadata).toMatchObject(source);
    },
  );

  it('keeps create-only, fill-only, and overwrite semantics for unowned fields', async () => {
    const { org } = await setupContact();
    const strategies = {
      initial: 'init_only', fill: 'prefer_non_empty', preserve: 'prefer_non_empty',
      skipEmpty: 'prefer_non_empty', replace: 'overwrite',
    } as const;
    const first = attribute(org.id, {
      initial: 'First', fill: '', preserve: 'First', skipEmpty: null, replace: 'First',
    }, strategies, 'new-contact@example.test');
    const resolved = await first.resolve();
    const [entityId] = resolved.entityIdsByItem.get(0)!;

    await attribute(org.id, {
      initial: 'Second', fill: 'Second', preserve: 'Second', skipEmpty: '', replace: null,
    }, strategies, 'new-contact@example.test').resolve();

    const row = await readContact(entityId);
    expect(row.metadata).toMatchObject({
      initial: 'First', fill: 'Second', preserve: 'First', skipEmpty: null, replace: null,
    });
    expect(row.field_controls).toEqual({});
  });

  it.each([false, true])('writes an explicit null to an absent unowned field (mixed batch: %s)', async (mixed) => {
    const { org, entity } = await setupContact();
    const values: Record<string, unknown> = { optional: null };
    const strategies: Record<string, EntityTraitSpec['mergeStrategy']> = { optional: 'overwrite' };
    if (mixed) {
      values.label = 'Source label';
      strategies.label = 'overwrite';
    }

    await attribute(org.id, values, strategies).resolve();

    const row = await readContact(entity.id);
    expect(row.metadata).toMatchObject(values);
    expect(row.field_controls).toEqual({});
  });

  it.each(['overwrite', 'prefer_non_empty'] as const)('%s does not rewrite state when all traits are human-owned', async (strategy) => {
    const { org, ctx, entity } = await setupContact({ label: 'Initial label' });
    await updateEntity(entity.id, { metadata: { label: '' } }, {}, ctx);
    const before = await readContact(entity.id);

    await attribute(org.id, { label: 'Source label' }, { label: strategy }).resolve();

    expect(await readContact(entity.id)).toEqual(before);
  });

  it('does not rewrite entity state for an unchanged observation', async () => {
    const { org, entity } = await setupContact({
      label: 'Same label', initial: 'Original',
      details: { one: 1, two: 2 }, tags: ['first', 'second'],
    });
    const before = await readContact(entity.id);

    await attribute(org.id, {
      label: 'Same label', initial: 'Ignored',
      details: { two: 2, one: 1 }, tags: ['first', 'second'],
    }, {
      label: 'overwrite', initial: 'init_only', details: 'overwrite', tags: 'overwrite',
    }).resolve();

    expect(await readContact(entity.id)).toEqual(before);
  });
});
