/**
 * Integration test: an exact-identifier query must rank the identifier's
 * owner first.
 *
 * QA repro (SEARCH_REPROS ISSUE 17.1, app.lobu.ai v1.6.0 @ b293f4d): query
 * "instinct-agent-test2@mail.instinct.com" (the exact email of member
 * "Instinct Test Two") returned member "Instinct Agent" at 0.5 above the
 * email's actual owner at 0.38 - fuzzy name trigrams beat the exact email
 * because entity search never consulted entity_identities at all.
 *
 * Fix: queryEntities gains an exact-identifier arm - a caller-org
 * entity_identities row whose identifier equals the query (case-insensitive)
 * matches at score 1.0 in the fuzzy, blended and non-fuzzy branches.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../tools/registry';
import { search } from '../../../tools/search';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const EMAIL = 'instinct-agent-test2@mail.instinct.com';

function ctxFor(orgId: string, userId: string): ToolContext {
  return {
    organizationId: orgId,
    userId,
    memberRole: 'owner',
    isAuthenticated: true,
    tokenType: 'oauth',
    scopedToOrg: false,
    allowCrossOrg: true,
    scopes: ['mcp:read'],
  };
}

describe('search_memory > exact-identifier entity match', () => {
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await initWorkspaceProvider();
    await seedSystemEntityTypes();

    const org = await createTestOrganization({ name: 'Identifier Match Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'id-owner@example.com' });
    userId = user.id;
    await addUserToOrganization(user.id, org.id, 'owner');

    // The decoy: its NAME trigram-matches the email query.
    await createTestEntity({ name: 'Instinct Agent', organization_id: orgId });

    // The right answer: name shares little with the email; the email lives
    // only in entity_identities, exactly as a connector-claimed member email.
    const rightMember = await createTestEntity({
      name: 'Instinct Test Two',
      organization_id: orgId,
    });
    const sql = getTestDb();
    await sql`
      INSERT INTO entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector
      ) VALUES (
        ${orgId}, ${rightMember.id}, 'email', ${EMAIL}, 'test:fixture'
      )
    `;
  });

  it('ranks the identifier owner first at full score', async () => {
    const result = await search(
      { query: EMAIL, include_content: false },
      {} as Parameters<typeof search>[1],
      ctxFor(orgId, userId)
    );

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].name).toBe('Instinct Test Two');
    expect(result.matches[0].match_score).toBe(1.0);
  });

  it('matches identifiers case-insensitively', async () => {
    const result = await search(
      { query: EMAIL.toUpperCase(), include_content: false },
      {} as Parameters<typeof search>[1],
      ctxFor(orgId, userId)
    );
    expect(result.matches[0]?.name).toBe('Instinct Test Two');
  });

  it('non-fuzzy mode still matches exact identifiers', async () => {
    const result = await search(
      { query: EMAIL, fuzzy: false, include_content: false },
      {} as Parameters<typeof search>[1],
      ctxFor(orgId, userId)
    );
    expect(result.matches.map((m) => m.name)).toContain('Instinct Test Two');
  });
});
