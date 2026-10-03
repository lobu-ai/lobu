import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuthProfile } from '../../../utils/auth-profiles';
import {
  applyEventAttributions,
  clearEntityLinkRulesCache,
} from '../../../utils/entity-link-upsert';
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

// A source-backed type's records live in the source. Lobu's database must not
// grow with it: attributed events create no entity or identity rows, and the
// database refuses a stored row outright. The source is the test database
// itself, read through the real postgres connector; keys are synthetic.
const SOURCE_SQL = `SELECT n AS id, 'person-' || n AS slug, 'Person ' || n AS name
  FROM generate_series(1, 50) n`;
const CONNECTOR = 'example-activity';
const FEED = 'activity';

describe('source-backed entity types store nothing', () => {
  let orgId: string;
  let orgSlug: string;
  let userId: string;
  let personTypeId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Source Stores Nothing' });
    orgId = org.id;
    orgSlug = org.slug;
    const user = await createTestUser({ email: 'source-stores-nothing@example.test' });
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
    const api = await TestApiClient.for({ organizationId: orgId, userId, memberRole: 'owner' });
    await api.entity_schema.createType({
      slug: 'person',
      name: 'Person',
      backing: { sql: SOURCE_SQL, connection: 'people-source' },
    });
    const [type] = await getTestDb()<{ id: number }[]>`
      SELECT id FROM entity_types WHERE organization_id = ${orgId} AND slug = 'person'`;
    personTypeId = Number(type.id);
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
                    identities: [
                      { namespace: 'example_person_id', eventPath: 'metadata.person_key', primary: true },
                    ],
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

  async function rowCounts() {
    const [row] = await getTestDb()<{ entities: number; identities: number }[]>`
      SELECT
        (SELECT count(*)::int FROM entities WHERE organization_id = ${orgId}) AS entities,
        (SELECT count(*)::int FROM entity_identities WHERE organization_id = ${orgId}) AS identities`;
    return row;
  }

  it('attributed events create no entity or identity rows', async () => {
    const before = await rowCounts();
    const items = Array.from({ length: 20 }, (_, i) => ({
      origin_type: 'touch',
      metadata: { person_key: `person-${i + 1}`, person_name: `Person ${i + 1}` },
    }));
    const resolution = await applyEventAttributions({ connectorKey: CONNECTOR, feedKey: FEED, orgId, items });

    expect([...resolution.entityIdsByItem.values()].flat()).toEqual([]);
    expect(await rowCounts()).toEqual(before);
  });

  it('the database refuses a stored row on a source-backed type', async () => {
    await expect(
      getTestDb()`INSERT INTO entities (organization_id, entity_type_id, slug, name, created_by)
        VALUES (${orgId}, ${personTypeId}, 'person-3', 'Person 3', ${userId})`
    ).rejects.toThrow(/cannot have stored rows/);
  });

  it('a record still resolves live from the source', async () => {
    const result = await resolvePath(
      { path: `/${orgSlug}/person/person-7` },
      {},
      ownerToolContext(orgId, userId)
    );
    expect(result.entity).toMatchObject({ id: 0, name: 'Person 7', is_derived: true });
    expect(await rowCounts()).toEqual({ entities: 0, identities: 0 });
  });
});
