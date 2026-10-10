import { X_IDENTITY } from '@lobu/connectors/x-identity';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import { IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY } from '../../identity/scope-projection';
import { buildEntityLinkUnion, entityLinkMatchSql, fetchEntityIdentityScopes } from '../content-search/entity-link';

describe('content-search X identity recall', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('recalls X events for an entity through the indexed x_user_id identity scope', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'X Identity Recall Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    const person = await createTestEntity({
      name: 'Alice X',
      entity_type: 'person',
      organization_id: org.id,
      created_by: user.id,
    });

    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, created_at, updated_at)
      VALUES (${org.id}, ${person.id}, ${X_IDENTITY.USER_ID}, '12345', NOW(), NOW())
    `;
    const event = await createTestEvent({
      organization_id: org.id,
      title: 'Alice posted on X',
      content: 'hello from x',
      connector_key: 'x',
      metadata: { x_user_id: '12345', x_handle: 'alice' },
    });
    await createTestEvent({
      organization_id: org.id,
      title: 'Different X user',
      content: 'not alice',
      connector_key: 'x',
      metadata: { x_user_id: '99999', x_handle: 'other' },
    });

    const scopes = await fetchEntityIdentityScopes(sql, person.id);
    expect(scopes).toContainEqual({
      namespace: X_IDENTITY.USER_ID,
      identifier: '12345',
      scopeKey: null,
    });

    const predicate = buildEntityLinkUnion({
      entityIdLiteral: person.id,
      scopes,
      alias: 'f',
      baseParamIndex: 1,
    });
    for (const candidate of [
      predicate,
      { sql: entityLinkMatchSql('$1::bigint', 'f'), params: [person.id] },
    ]) {
      const rows = await sql.unsafe(
        `SELECT f.id FROM events f WHERE ${candidate.sql} ORDER BY f.id`,
        candidate.params
      );
      expect(rows.map((row) => Number(row.id))).toEqual([event.id]);
    }
  });

  it('does not cross-link equal identifiers from different tenant scopes', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Tenant X Identity Recall Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    const tenantA = await createTestEntity({
      name: 'Tenant A person',
      entity_type: 'person',
      organization_id: org.id,
      created_by: user.id,
    });
    const tenantB = await createTestEntity({
      name: 'Tenant B person',
      entity_type: 'person',
      organization_id: org.id,
      created_by: user.id,
    });
    await sql`
      INSERT INTO entity_identities (
        organization_id, entity_id, namespace, identifier, scope_key, created_at, updated_at
      ) VALUES
        (${org.id}, ${tenantA.id}, ${X_IDENTITY.USER_ID}, 'shared-upstream-id', 'tenant-a', NOW(), NOW()),
        (${org.id}, ${tenantB.id}, ${X_IDENTITY.USER_ID}, 'shared-upstream-id', 'tenant-b', NOW(), NOW())
    `;
    const eventA = await createTestEvent({
      organization_id: org.id,
      content: 'tenant a event',
      connector_key: 'x-tenant-test',
      metadata: {
        x_user_id: 'shared-upstream-id',
        [IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY]: { x_user_id: 'tenant-a' },
      },
    });
    const eventB = await createTestEvent({
      organization_id: org.id,
      content: 'tenant b event',
      connector_key: 'x-tenant-test',
      metadata: {
        x_user_id: 'shared-upstream-id',
        [IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY]: { x_user_id: 'tenant-b' },
      },
    });
    for (const [entityId, expectedEventId] of [
      [tenantA.id, eventA.id],
      [tenantB.id, eventB.id],
    ] as const) {
      const scopes = await fetchEntityIdentityScopes(sql, entityId);
      const predicate = buildEntityLinkUnion({
        entityIdLiteral: entityId,
        scopes,
        alias: 'f',
        baseParamIndex: 1,
      });
      for (const candidate of [
        predicate,
        { sql: entityLinkMatchSql('$1::bigint', 'f'), params: [entityId] },
      ]) {
        const rows = await sql.unsafe(
          `SELECT f.id FROM events f WHERE ${candidate.sql} ORDER BY f.id`,
          candidate.params
        );
        expect(rows.map((row) => Number(row.id))).toEqual([expectedEventId]);
      }
    }

    const correlated = await sql.unsafe(
      `SELECT candidate.id AS entity_id, f.id FROM entities candidate
       JOIN events f ON ${entityLinkMatchSql('candidate.id', 'f')}
       WHERE candidate.id IN ($1, $2) ORDER BY candidate.id, f.id`,
      [tenantA.id, tenantB.id]
    );
    expect(correlated.map((row) => [Number(row.entity_id), Number(row.id)])).toEqual([
      [tenantA.id, eventA.id],
      [tenantB.id, eventB.id],
    ]);
  });
});
