/**
 * Authorization-purpose classification contract.
 *
 * `member_of` is both an ACL primitive and ordinary domain vocabulary, and
 * `ensureMemberOfType` upserts on (organization_id, slug) — so it ADOPTS a
 * pre-existing row rather than create-or-failing.
 *
 * lobu#2825 shipped the classification mechanism inert, after making every ACL
 * writer set the transaction-local flag. This follow-up stamps `member_of`, so
 * the tests pin both the shared helper's repair path and the initializer
 * that now arms the trigger for each organization.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ensureMemberOfType } from '../../../authz/access-graph';
import { ensureRelationshipType } from '../../../utils/edge-writes';
import { PURPOSE_AUTHORIZATION } from '../../../utils/relationship-validation';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';

async function purposeOf(orgId: string, slug: string): Promise<string | null> {
  const sql = getTestDb();
  const rows = await sql<{ purpose: string | null }[]>`
    SELECT purpose FROM entity_relationship_types
    WHERE organization_id = ${orgId} AND slug = ${slug} AND status = 'active'
    LIMIT 1
  `;
  return rows.length > 0 ? rows[0].purpose : null;
}

describe('relationship type purpose', () => {
  let orgId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Purpose Org' });
    orgId = org.id;
  });

  it('stamps authorization when a caller supplies the purpose at create', async () => {
    await ensureRelationshipType({
      organizationId: orgId,
      slug: 'member_of',
      name: 'Member of',
      description: 'ACL membership',
      purpose: PURPOSE_AUTHORIZATION,
    });
    expect(await purposeOf(orgId, 'member_of')).toBe('authorization');
  });

  it('classifies member_of at initialization', async () => {
    // #2825 established the writer flag in the earlier release. Reverting this
    // initializer to omit the purpose would now leave an org's ACL type
    // unguarded from its next sync onward.
    await ensureMemberOfType(orgId);
    expect(await purposeOf(orgId, 'member_of')).toBe('authorization');
  });

  it('repairs an unclassified member_of it adopts on the next sync', async () => {
    // The backfill classifies rows that exist when it runs. This covers the
    // other source of unclassified rows: one created during the deploy window by
    // a pod still running the pre-classification code. Without this repair such
    // a row is a live ACL type the trigger ignores — permanently, since nothing
    // else revisits it.
    const sql = getTestDb();
    await sql`
      INSERT INTO entity_relationship_types
        (slug, name, description, organization_id, is_symmetric, created_by, created_at, updated_at)
      VALUES ('member_of', 'Member of', 'pre-classification row', ${orgId}, false, NULL,
              current_timestamp, current_timestamp)
    `;
    expect(await purposeOf(orgId, 'member_of')).toBeNull();

    await ensureMemberOfType(orgId);
    expect(await purposeOf(orgId, 'member_of')).toBe('authorization');
  });

  it('repairs an unclassified row it adopts', async () => {
    // The rolling-deploy case: an older pod created `member_of` without the
    // classification. Because this statement upserts rather than create-or-fails,
    // it lands on that row — and leaving it unclassified would drop every
    // member's access once the ACL reads require the stamp.
    const sql = getTestDb();
    await sql`
      INSERT INTO entity_relationship_types
        (slug, name, description, organization_id, is_symmetric, created_by, created_at, updated_at)
      VALUES ('member_of', 'Member of', 'legacy row', ${orgId}, false, NULL,
              current_timestamp, current_timestamp)
    `;
    expect(await purposeOf(orgId, 'member_of')).toBeNull();

    await ensureRelationshipType({
      organizationId: orgId,
      slug: 'member_of',
      name: 'Member of',
      description: 'ACL membership',
      purpose: PURPOSE_AUTHORIZATION,
    });
    expect(await purposeOf(orgId, 'member_of')).toBe('authorization');
  });

  it('is idempotent across repeated syncs', async () => {
    const opts = {
      organizationId: orgId,
      slug: 'member_of',
      name: 'Member of',
      description: 'ACL membership',
      purpose: PURPOSE_AUTHORIZATION,
    };
    const first = await ensureRelationshipType(opts);
    const second = await ensureRelationshipType(opts);
    expect(second).toBe(first);
    expect(await purposeOf(orgId, 'member_of')).toBe('authorization');
  });

  it('does not clear an existing classification when a caller omits purpose', async () => {
    // Every relationship type shares this function. An unclassified upsert must
    // never strip a stamp, or it would silently declassify the ACL type.
    await ensureRelationshipType({
      organizationId: orgId,
      slug: 'member_of',
      name: 'Member of',
      description: 'ACL membership',
      purpose: PURPOSE_AUTHORIZATION,
    });
    await ensureRelationshipType({
      organizationId: orgId,
      slug: 'member_of',
      name: 'Member of',
      description: 'no purpose supplied',
    });
    expect(await purposeOf(orgId, 'member_of')).toBe('authorization');
  });

  it('leaves ordinary domain types unclassified', async () => {
    await ensureRelationshipType({
      organizationId: orgId,
      slug: 'billed_to',
      name: 'Billed to',
      description: 'ERP vocabulary',
    });
    expect(await purposeOf(orgId, 'billed_to')).toBeNull();
  });

  it('rejects a purpose value outside the enum at the database', async () => {
    const sql = getTestDb();
    await expect(
      sql`
        INSERT INTO entity_relationship_types
          (slug, name, organization_id, created_at, updated_at, purpose)
        VALUES ('bogus', 'Bogus', ${orgId}, current_timestamp, current_timestamp, 'superuser')
      `
    ).rejects.toThrow(/entity_relationship_types_purpose_check/);
  });
});
