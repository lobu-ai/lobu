/**
 * Identity-graph recall must stay inside the entity's organization.
 *
 * An entity's identity claim (`entity_identities`) links events that carry the
 * same identifier in `events.metadata->>'<namespace>'`. Any organization can
 * stamp any identifier value on its own entity, so a match on the identifier
 * alone would surface another organization's events (connector rows and saved
 * notes alike) through entity-scoped reads. Direct `entity_ids` attribution
 * remains an explicit cross-org bridge.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY } from '../../../identity/scope-projection';
import { getContent } from '../../../tools/get_content';
import {
  buildEntityLinkUnion,
  entityLinkMatchSql,
  fetchEntityIdentityScopes,
} from '../../../utils/content-search';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestEvent,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';
import { get } from '../../setup/test-helpers';

const SHARED_IDENTIFIER = 'USYNTHETIC0001';

describe.each([null, 'synthetic-tenant'])('entity identity recall with scope %s is organization-scoped', (scopeKey) => {
  let orgASlug: string;
  let orgAId: string;
  let userAId: string;
  let tokenA: string;
  let entityAId: number;
  let ownIdentityEventId: number;
  let ownDirectEventId: number;
  let crossOrgDirectEventId: number;
  let bridgedIdentityEventId: number;
  let foreignConnectorEventId: number;
  let foreignNoteEventId: number;
  const identityMetadata = {
    slack_user_id: SHARED_IDENTIFIER,
    ...(scopeKey === null ? {} : {
      [IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY]: { slack_user_id: scopeKey },
    }),
  };

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    const sql = getTestDb();

    const orgA = await createTestOrganization({ name: 'Recall Scope Org A' });
    const orgB = await createTestOrganization({ name: 'Recall Scope Org B' });
    orgASlug = orgA.slug;
    orgAId = orgA.id;

    const userA = await createTestUser({ email: 'recall-scope-a@test.example.com' });
    const userB = await createTestUser({ email: 'recall-scope-b@test.example.com' });
    userAId = userA.id;
    await addUserToOrganization(userA.id, orgA.id, 'owner');
    await addUserToOrganization(userB.id, orgB.id, 'owner');
    const oauthClient = await createTestOAuthClient();
    tokenA = (await createTestAccessToken(userA.id, orgA.id, oauthClient.client_id)).token;

    const entityA = await createTestEntity({ name: 'Org A Person', organization_id: orgA.id });
    const entityB = await createTestEntity({ name: 'Org B Person', organization_id: orgB.id });
    entityAId = Number(entityA.id);

    for (const org of [orgA, orgB]) {
      await createTestConnectorDefinition({
        key: 'recall-scope-connector',
        name: 'Recall Scope Connector',
        organization_id: org.id,
      });
    }
    const connectionA = await createTestConnection({
      organization_id: orgA.id,
      connector_key: 'recall-scope-connector',
    });
    const connectionB = await createTestConnection({
      organization_id: orgB.id,
      connector_key: 'recall-scope-connector',
    });

    // Both organizations claim the same identifier on their own entity.
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, scope_key)
      VALUES (${orgA.id}, ${entityA.id}, 'slack_user_id', ${SHARED_IDENTIFIER}, ${scopeKey}),
             (${orgB.id}, ${entityB.id}, 'slack_user_id', ${SHARED_IDENTIFIER}, ${scopeKey})
    `;

    ownIdentityEventId = Number(
      (
        await createTestEvent({
          entity_ids: [],
          connection_id: connectionA.id,
          content: 'Org A identity-linked event.',
          occurred_at: new Date('2025-07-01T10:00:00Z'),
          organization_id: orgA.id,
          metadata: identityMetadata,
        })
      ).id
    );
    ownDirectEventId = Number(
      (
        await createTestEvent({
          entity_id: entityA.id,
          connection_id: connectionA.id,
          content: 'Org A directly attributed event.',
          occurred_at: new Date('2025-07-02T10:00:00Z'),
          organization_id: orgA.id,
        })
      ).id
    );
    foreignConnectorEventId = Number(
      (
        await createTestEvent({
          entity_ids: [],
          connection_id: connectionB.id,
          content: 'Org B connector event carrying the shared identifier.',
          occurred_at: new Date('2025-07-03T10:00:00Z'),
          organization_id: orgB.id,
          metadata: identityMetadata,
        })
      ).id
    );
    // A saved note has no connection, so connection visibility cannot hide it.
    foreignNoteEventId = Number(
      (
        await createTestEvent({
          entity_ids: [],
          content: 'Org B saved note carrying the shared identifier.',
          semantic_type: 'note',
          occurred_at: new Date('2025-07-04T10:00:00Z'),
          organization_id: orgB.id,
          metadata: identityMetadata,
        })
      ).id
    );
    // A connection shared into Org A bridges this Org B event; Org A may see it.
    bridgedIdentityEventId = Number(
      (
        await createTestEvent({
          entity_ids: [],
          connection_id: connectionB.id,
          content: 'Org B event bridged into Org A carrying the shared identifier.',
          occurred_at: new Date('2025-07-06T10:00:00Z'),
          organization_id: orgB.id,
          metadata: identityMetadata,
        })
      ).id
    );
    await sql`UPDATE events SET linked_org_ids = ARRAY[${orgA.id}]::text[] WHERE id = ${bridgedIdentityEventId}`;
    crossOrgDirectEventId = Number(
      (
        await createTestEvent({
          entity_id: entityA.id,
          content: 'Org B note explicitly attributed to Org A entity.',
          semantic_type: 'note',
          occurred_at: new Date('2025-07-05T10:00:00Z'),
          organization_id: orgB.id,
        })
      ).id
    );
  });

  function expectAllowedEvents(ids: number[], bridged = true) {
    const allowed = [ownIdentityEventId, ownDirectEventId, crossOrgDirectEventId];
    if (bridged) allowed.push(bridgedIdentityEventId);
    expect([...ids].sort((a, b) => a - b)).toEqual(allowed.sort((a, b) => a - b));
    expect(ids).not.toContain(foreignConnectorEventId);
    expect(ids).not.toContain(foreignNoteEventId);
  }

  it('entityLinkMatchSql rejects foreign identity matches and preserves direct attribution', async () => {
    const rows = await getTestDb().unsafe<{ id: number | string }[]>(
      `SELECT f.id FROM events f WHERE ${entityLinkMatchSql('$1::bigint', 'f')}`,
      [entityAId]
    );
    expectAllowedEvents(rows.map((row) => Number(row.id)));
  });

  it('buildEntityLinkUnion rejects foreign identity matches and preserves direct attribution', async () => {
    const sql = getTestDb();
    const scopes = await fetchEntityIdentityScopes(sql, entityAId);
    expect(scopes).toEqual([{ namespace: 'slack_user_id', identifier: SHARED_IDENTIFIER, scopeKey }]);
    const link = buildEntityLinkUnion({
      entityIdLiteral: entityAId,
      scopes,
      alias: 'f',
      baseParamIndex: 1,
    });
    const rows = await sql.unsafe<{ id: number | string }[]>(
      `SELECT f.id FROM events f WHERE ${link.sql}`,
      link.params
    );
    expectAllowedEvents(rows.map((row) => Number(row.id)));
  });

  it('get_content rejects foreign identity matches and preserves direct attribution', async () => {
    const ctx = ownerToolContext(orgAId, userAId);
    const listed = await getContent({ entity_id: entityAId, limit: 50 }, {} as Env, ctx);
    // Org A cannot see Org B's connection, so connection visibility hides the bridged event.
    expectAllowedEvents(listed.content.map((item) => Number(item.id)), false);

    const scored = await getContent(
      { entity_id: entityAId, sort_by: 'score', limit: 50 },
      {} as Env,
      ctx
    );
    expectAllowedEvents(scored.content.map((item) => Number(item.id)), false);
  });

  it('content-distribution excludes foreign identity matches and counts direct attribution', async () => {
    const response = await get(`/api/${orgASlug}/entities/${entityAId}/content-distribution`, {
      token: tokenA,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      distribution: Array<{ date: string; count: number }>;
    };
    const byDate = Object.fromEntries(body.distribution.map((row) => [row.date, row.count]));
    expect(byDate).toEqual({ '2025-07-01': 1, '2025-07-02': 1, '2025-07-05': 1, '2025-07-06': 1 });
  });
});
