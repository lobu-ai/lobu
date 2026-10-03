import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuthProfile } from '../../../utils/auth-profiles';
import {
  applyEventAttributions,
  clearEntityLinkRulesCache,
} from '../../../utils/entity-link-upsert';
import { updateEntity } from '../../../utils/entity-management';
import { insertEvent } from '../../../utils/insert-event';
import { resolvePath } from '../../../tools/resolve_path';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

// The source is the test database itself, read through the real postgres
// connector; keys are synthetic.
const SOURCE_SQL = `SELECT n AS id, 'person-' || n AS slug, 'Person ' || n AS name, n * 10 AS score
  FROM generate_series(1, 50) n`;
const NAMESPACE = 'example_person_id';
const CONNECTOR = 'example-activity';
const FEED = 'activity';

describe('source-backed entity identity', () => {
  let orgId: string;
  let orgSlug: string;
  let userId: string;
  let api: TestApiClient;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Source Identity' });
    orgId = org.id;
    orgSlug = org.slug;
    const user = await createTestUser({ email: 'source-identity@example.test' });
    userId = user.id;
    await addUserToOrganization(userId, orgId, 'owner');
    const profile = await createAuthProfile({
      organizationId: orgId,
      connectorKey: 'postgres',
      displayName: 'Source database',
      profileKind: 'env',
      authData: { DATABASE_URL: process.env.DATABASE_URL as string },
    });
    await getTestDb()`INSERT INTO connections
      (organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by)
      VALUES (${orgId}, 'postgres', 'people-source', 'People source', 'active', ${profile.id}, 'private', ${userId})`;
    api = await TestApiClient.for({ organizationId: orgId, userId, memberRole: 'owner' });
    await api.entity_schema.createType({
      slug: 'person',
      name: 'Person',
      backing: { sql: SOURCE_SQL, connection: 'people-source', identity: NAMESPACE },
    });
    await createTestConnectorDefinition({
      key: CONNECTOR,
      name: 'Example activity',
      organization_id: orgId,
      feeds_schema: {
        [FEED]: {
          eventKinds: {
            touch: {
              attributions: [
                {
                  role: 'about',
                  autoCreate: true,
                  target: {
                    entityType: 'person',
                    titlePath: 'metadata.person_name',
                    identities: [{ namespace: NAMESPACE, eventPath: 'metadata.person_key', primary: true }],
                  },
                  traits: {
                    score: { eventPath: 'metadata.score', mergeStrategy: 'overwrite' },
                    label: { eventPath: 'metadata.label', mergeStrategy: 'prefer_non_empty' },
                    initial: { eventPath: 'metadata.initial', mergeStrategy: 'init_only' },
                  },
                },
              ],
            },
          },
        },
      },
    });
  }, 120_000);

  beforeEach(() => clearEntityLinkRulesCache());

  async function attribute(metadata: Record<string, unknown>) {
    const items = [{ origin_type: 'touch', metadata }];
    const resolution = await applyEventAttributions({ connectorKey: CONNECTOR, feedKey: FEED, orgId, items });
    return resolution.entityIdsByItem.get(0) ?? [];
  }

  function storedRows(slug: string) {
    return getTestDb()<{ id: number; name: string; metadata: Record<string, unknown> }>`
      SELECT e.id, e.name, e.metadata FROM entities e
      WHERE e.organization_id = ${orgId} AND e.slug = ${slug} AND e.deleted_at IS NULL`;
  }

  it('stores only an identity row keyed by the source key, once per key', async () => {
    const first = await attribute({
      person_key: 'person-7', person_name: 'Person 7', score: 999, label: 'Copied', initial: 'Initial',
    });
    const [created] = await storedRows('person-7');
    expect(created.metadata).toEqual({ aliases: ['person-7'] });
    const second = await attribute({
      person_key: 'person-7', person_name: 'Person 7', score: 123, label: 'Updated', initial: 'Changed',
    });
    const rows = await storedRows('person-7');
    expect(rows).toHaveLength(1);
    expect(first).toEqual([Number(rows[0].id)]);
    expect(second).toEqual(first);
    expect(rows[0].name).toBe('Person 7');
    expect(rows[0].metadata).toEqual({ aliases: ['person-7'] });
  });

  it('leaves an event without a source key unattributed', async () => {
    expect(await attribute({ person_name: 'No key' })).toEqual([]);
  });

  it('attributes concurrent observations to the same stored identity', async () => {
    for (const key of ['person-12', 'person-14', 'person-15', 'person-16', 'person-17']) {
      const results = await Promise.all(
        Array.from({ length: 16 }, () => attribute({ person_key: key, person_name: key })),
      );
      const rows = await storedRows(key);
      expect(rows).toHaveLength(1);
      for (const ids of results) expect(ids).toEqual([Number(rows[0].id)]);
    }
  });

  it('does not reuse a source slug owned by a different identity scope', async () => {
    async function attributeScoped(scope: string) {
      return applyEventAttributions({
        connectorKey: CONNECTOR,
        orgId,
        items: [{ origin_type: 'touch', metadata: { person_key: 'person-13', tenant: scope } }],
        rules: {
          touch: [{
            role: 'about', entityType: 'person', autoCreate: true,
            identities: [{
              namespace: NAMESPACE, eventPath: 'metadata.person_key', primary: true,
              scope: 'tenant', scopeKeyPath: 'metadata.tenant',
            }],
          }],
        },
      });
    }
    const first = await attributeScoped('tenant-a');
    expect(first.entityIdsByItem.get(0)).toHaveLength(1);
    const second = await attributeScoped('tenant-b');
    expect(second.entityIdsByItem.get(0) ?? []).toEqual([]);
    const identities = await getTestDb()`
      SELECT scope_key FROM entity_identities
      WHERE organization_id = ${orgId} AND namespace = ${NAMESPACE}
        AND identifier = 'person-13' AND deleted_at IS NULL`;
    expect(identities).toEqual([{ scope_key: 'tenant-a' }]);
  });

  it('resolves a stored identity with live source fields and real activity', async () => {
    const [entityId] = await attribute({ person_key: 'person-8', person_name: 'Stale name' });
    await insertEvent({
      entityIds: [entityId],
      organizationId: orgId,
      originId: 'touch-person-8',
      semanticType: 'touch',
      title: 'A source touch',
      originType: 'touch',
      connectorKey: CONNECTOR,
      metadata: {},
    });
    const result = await resolvePath({ path: `/${orgSlug}/person/person-8` }, {}, ownerToolContext(orgId, userId));
    expect(result.entity).toMatchObject({
      id: entityId,
      slug: 'person-8',
      name: 'Person 8',
      is_derived: true,
      metadata: { id: 8, slug: 'person-8', name: 'Person 8', score: 80 },
      total_content: 1,
    });
  });

  it('still resolves an unreferenced source record without storing it', async () => {
    const result = await resolvePath({ path: `/${orgSlug}/person/person-9` }, {}, ownerToolContext(orgId, userId));
    expect(result.entity).toMatchObject({ id: 0, slug: 'person-9', is_derived: true });
    expect(await storedRows('person-9')).toHaveLength(0);
  });

  it('refuses edits to a source-backed identity row', async () => {
    const [entityId] = await attribute({ person_key: 'person-10', person_name: 'Person 10' });
    await expect(
      updateEntity(entityId, { metadata: { score: 1 } }, {} as never, ownerToolContext(orgId, userId)),
    ).rejects.toMatchObject({ message: expect.stringContaining('source-backed') });
  });

  it('keeps identity rows across SQL edits but not across an identity change', async () => {
    await attribute({ person_key: 'person-11', person_name: 'Person 11' });
    await api.entity_schema.updateType({
      slug: 'person',
      backing: { sql: `${SOURCE_SQL} WHERE n > 0`, connection: 'people-source', identity: NAMESPACE },
    });
    await expect(
      api.entity_schema.updateType({
        slug: 'person',
        backing: { sql: SOURCE_SQL, connection: 'people-source', identity: 'other_namespace' },
      }),
    ).rejects.toThrow(/stored/);
    await expect(
      api.entity_schema.updateType({ slug: 'person', backing: { sql: SOURCE_SQL, connection: 'people-source' } }),
    ).rejects.toThrow(/stored/);
  });

  it('requires a connection for an identity, and keeps pure views row-free', async () => {
    await expect(
      api.entity_schema.createType({ slug: 'orphan', name: 'Orphan', backing: { sql: 'SELECT 1 AS id', identity: NAMESPACE } }),
    ).rejects.toThrow(/requires backing.connection/);
    await api.entity_schema.createType({
      slug: 'plain-view',
      name: 'Plain view',
      backing: { sql: SOURCE_SQL, connection: 'people-source' },
    });
    const [type] = await getTestDb()`SELECT id FROM entity_types WHERE organization_id = ${orgId} AND slug = 'plain-view'`;
    await expect(
      getTestDb()`INSERT INTO entities (organization_id, entity_type_id, name, slug, created_by)
        VALUES (${orgId}, ${type.id}, 'x', 'x', ${userId})`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});
