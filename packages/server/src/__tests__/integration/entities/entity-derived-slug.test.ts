/**
 * `entities_slug_parent_unique` has no `deleted_at` predicate, so a tombstone
 * keeps its slug. A slug the platform DERIVES from a name must step past a
 * tombstone; an explicit slug, and a live namesake, must still fail loudly.
 *
 * `-` marks where a page path ends and a view begins
 * (`/<org>/<type>/<slug>/-/views/<key>`), so a record stored under that slug
 * would have a page the web host parses as a view path. Derived slugs never are
 * one (slugify trims dashes); an explicit slug has to be refused.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { createEntity, deleteEntity, updateEntity } from '../../../utils/entity-management';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEntity, seedOwnerContext } from '../../setup/test-fixtures';

const env = {} as Env;

/** A tombstoned `brand` holding `slug` (also seeds the `brand` type). */
async function tombstone(organizationId: string, slug: string) {
  const entity = await createTestEntity({ name: `Seed ${slug}`, organization_id: organizationId });
  const sql = getTestDb();
  await sql`UPDATE entities SET deleted_at = current_timestamp, slug = ${slug} WHERE id = ${entity.id}`;
}

describe('derived entity slugs and tombstones', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('steps a derived slug past every tombstone holding it', async () => {
    const { org, user } = await seedOwnerContext({ orgName: 'Derived slug org' });
    await tombstone(org.id, 'acme-corp');
    await tombstone(org.id, 'acme-corp-2');

    const created = await createEntity({
      entity_type: 'brand',
      name: 'Acme Corp',
      organization_id: org.id,
      created_by: user.id,
    });
    expect(created.slug).toBe('acme-corp-3');
  });

  it('keeps rejecting a live namesake', async () => {
    const { org, user } = await seedOwnerContext({ orgName: 'Live namesake org' });
    await createTestEntity({ name: 'Acme Corp', organization_id: org.id });

    await expect(
      createEntity({
        entity_type: 'brand',
        name: 'Acme Corp',
        organization_id: org.id,
        created_by: user.id,
      })
    ).rejects.toThrow('Entity already exists with this name or unique field');
  });

  it('keeps rejecting an explicit slug a tombstone holds', async () => {
    const { org, user } = await seedOwnerContext({ orgName: 'Explicit slug org' });
    await tombstone(org.id, 'acme-corp');

    await expect(
      createEntity({
        entity_type: 'brand',
        name: 'Another Name',
        slug: 'acme-corp',
        organization_id: org.id,
        created_by: user.id,
      })
    ).rejects.toThrow('Entity already exists with this name or unique field');
  });

  it('rejects a live namesake that already received a suffix', async () => {
    const { org, user } = await seedOwnerContext({ orgName: 'Suffixed namesake org' });
    await tombstone(org.id, 'acme-corp');
    const data = {
      entity_type: 'brand',
      name: 'Acme Corp',
      organization_id: org.id,
      created_by: user.id,
    };
    const created = await createEntity(data);
    expect(created.slug).toBe('acme-corp-2');

    await expect(createEntity(data))
      .rejects.toThrow('Entity already exists with this name or unique field');
  });

  it('allows only one concurrent namesake past a tombstone', async () => {
    const { org, user } = await seedOwnerContext({ orgName: 'Concurrent slug org' });
    await tombstone(org.id, 'acme-corp');
    const data = {
      entity_type: 'brand',
      name: 'Acme Corp',
      organization_id: org.id,
      created_by: user.id,
    };

    const results = await Promise.allSettled([createEntity(data), createEntity(data)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
      { reason: { message: 'Entity already exists with this name or unique field' } },
    ]);
    const sql = getTestDb();
    const live = await sql`
      SELECT slug FROM entities
      WHERE organization_id = ${org.id} AND name = 'Acme Corp' AND deleted_at IS NULL
    `;
    expect(live).toEqual([{ slug: 'acme-corp-2' }]);
  });

  it('rejects renaming onto a live suffixed namesake but permits updating that namesake', async () => {
    const { org, user, ctx } = await seedOwnerContext({ orgName: 'Rename namesake org' });
    await tombstone(org.id, 'acme-corp');
    const existing = await createEntity({
      entity_type: 'brand',
      name: 'Acme Corp',
      organization_id: org.id,
      created_by: user.id,
    });
    const other = await createTestEntity({ name: 'Placeholder', organization_id: org.id });

    await expect(updateEntity(other.id, { name: 'Acme Corp' }, env, ctx))
      .rejects.toMatchObject({ code: '23505' });
    const updated = await updateEntity(existing.id, { name: 'Acme Corp' }, env, ctx);
    expect(updated.slug).toBe('acme-corp-2');
  });

  it('renames onto a name only a tombstone holds', async () => {
    const { org, ctx } = await seedOwnerContext({ orgName: 'Rename slug org' });
    const gone = await createTestEntity({ name: 'Acme Corp', organization_id: org.id });
    await deleteEntity(gone.id, false, env, ctx);
    const renamed = await createTestEntity({ name: 'Placeholder', organization_id: org.id });

    const updated = await updateEntity(renamed.id, { name: 'Acme Corp' }, env, ctx);
    expect(updated.slug).toBe('acme-corp-2');
  });

  it("refuses the view path marker '-' as an explicit slug on create and rename", async () => {
    const { org, user, ctx } = await seedOwnerContext({ orgName: 'Slug marker org' });
    const record = await createTestEntity({ name: 'Launch', organization_id: org.id });
    const sql = getTestDb();
    const slugs = async () =>
      (
        await sql<{ slug: string }[]>`
          SELECT slug FROM entities WHERE organization_id = ${org.id} ORDER BY id`
      ).map((row) => row.slug);
    const before = await slugs();

    await expect(
      createEntity({
        entity_type: 'brand',
        name: 'Dash',
        slug: '-',
        organization_id: org.id,
        created_by: user.id,
      })
    ).rejects.toThrow(/Slug '-' is reserved/);
    await expect(updateEntity(record.id, { slug: '-' }, env, ctx)).rejects.toThrow(
      /Slug '-' is reserved/
    );
    // Neither call wrote anything: no new row, and the record keeps its slug.
    expect(await slugs()).toEqual(before);
  });
});
