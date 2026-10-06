import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../setup/test-db';
import { addUserToOrganization, createTestOrganization, createTestUser } from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

describe('shared collection attribute selection', () => {
  let api: TestApiClient;
  const schema = {
    type: 'object', properties: {
      tier: { type: ['string', 'null'] }, seats: { type: 'number' }, active: { type: 'boolean' },
    },
  };
  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization();
    const other = await createTestOrganization();
    const user = await createTestUser();
    for (const target of [org, other]) {
      await addUserToOrganization(user.id, target.id, 'owner');
      const owner = await TestApiClient.for({ organizationId: target.id, userId: user.id, memberRole: 'owner' });
      await owner.entity_schema.createType({ slug: 'account', name: 'Accounts', metadata_schema: schema });
      await owner.entities.create({ type: 'account', name: 'Alpha 100%', metadata: { tier: 'large', seats: 100, active: true } });
      if (target.id === org.id) {
        api = owner;
        await owner.entities.create({ type: 'account', name: 'Beta', metadata: { tier: 'large', seats: 200, active: false } });
        await owner.entities.create({ type: 'account', name: 'Gamma', metadata: { tier: 'small', seats: 10, active: true } });
        await owner.entities.create({ type: 'account', name: 'Absent', metadata: { seats: 0 } });
        await owner.entities.create({ type: 'account', name: 'Null', metadata: { tier: null, seats: 0 } });
        await owner.entity_schema.createType({
          slug: 'source-account', name: 'Source accounts', metadata_schema: schema,
          backing: { sql: `SELECT name, slug, metadata->>'tier' AS tier, (metadata->>'seats')::numeric AS seats, (metadata->>'active')::boolean AS active FROM entities` },
        });
      }
    }
  });
  afterAll(cleanupTestDatabase);

  for (const entity_type of ['account', 'source-account']) {
    it(`${entity_type}: filters before pagination and counts within the caller's organization`, async () => {
      const filters = [{ field: 'tier', op: 'eq' as const, value: 'large' }];
      const first = await api.entities.list({ entity_type, filters, limit: 1 });
      const second = await api.entities.list({ entity_type, filters, limit: 1, offset: 1 });
      expect(first.metadata.total_count).toBe(2);
      expect(second.metadata.total_count).toBe(2);
      expect(first.metadata.has_more).toBe(true);
      expect(second.metadata.has_more).toBe(false);
      expect(new Set([...first.entities, ...second.entities].map(row => row.name))).toEqual(new Set(['Alpha 100%', 'Beta']));
      const beyond = await api.entities.list({ entity_type, filters, offset: 50 });
      expect(beyond.entities).toEqual([]);
      expect(beyond.metadata.total_count).toBe(2);
    });

    it(`${entity_type}: composes literal search, numeric ranges and boolean filters`, async () => {
      const result = await api.entities.list({ entity_type, search: '%', filters: [
        { field: 'seats', op: 'gte', value: 100 }, { field: 'active', op: 'eq', value: true },
      ] });
      expect(result.entities.map(row => row.name)).toEqual(['Alpha 100%']);
      expect(result.metadata.total_count).toBe(1);
      const wrongType = await api.entities.list({ entity_type, filters: [{ field: 'seats', op: 'gte', value: '100' }] });
      expect(wrongType.entities).toEqual([]);
    });

    it(`${entity_type}: treats absent attributes as null and binds SQL-looking values`, async () => {
      const result = await api.entities.list({ entity_type, filters: [{ field: 'tier', op: 'eq', value: null }] });
      expect(new Set(result.entities.map(row => row.name))).toEqual(new Set(['Absent', 'Null']));
      const injection = await api.entities.list({ entity_type, filters: [{ field: 'tier', op: 'eq', value: "large' OR true --" }] });
      expect(injection.entities).toEqual([]);
      await expect(api.entities.list({ entity_type, filters: [{ field: 'not_declared', op: 'eq', value: 'large' }] })).rejects.toThrow(/Unknown attribute/);
    });
  }
  it('rejects filters without a type', async () => {
    await expect(api.entities.list({ filters: [{ field: 'tier', op: 'eq', value: 'large' }] })).rejects.toThrow(/require entity_type/);
  });
});
