/**
 * Cross-organization isolation. The single most important security guarantee
 * the SDK has to maintain — a workspace owner in org A must not be able to
 * read or mutate org B, and vice versa.
 *
 * Replaces deleted entity-types/cross-org and scoping/organization-access tests.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase } from '../../setup/test-db';

describe('cross-org isolation', () => {
  let clientA: TestApiClient;
  let clientB: TestApiClient;
  let orgIdB: string;
  let entityIdA: number;

  beforeAll(async () => {
    await cleanupTestDatabase();

    const orgA = await createTestOrganization({ name: 'Iso Org A' });
    const orgB = await createTestOrganization({ name: 'Iso Org B' });
    orgIdB = orgB.id;
    const userA = await createTestUser({ email: 'iso-a@test.com' });
    const userB = await createTestUser({ email: 'iso-b@test.com' });
    await addUserToOrganization(userA.id, orgA.id, 'owner');
    await addUserToOrganization(userB.id, orgB.id, 'owner');

    clientA = await TestApiClient.for({
      organizationId: orgA.id,
      userId: userA.id,
      memberRole: 'owner',
    });
    clientB = await TestApiClient.for({
      organizationId: orgB.id,
      userId: userB.id,
      memberRole: 'owner',
    });

    await clientA.entity_schema.createType({ slug: 'company', name: 'Company' });
    await clientB.entity_schema.createType({ slug: 'company', name: 'Company' });

    const entityA = (await clientA.entities.create({
      entity_type: 'company',
      name: 'Org A Only',
    })) as { entity: { id: number } };
    entityIdA = entityA.entity.id;
  });

  it('a different-org client cannot read another org\'s entity by id', async () => {
    await expect(clientB.entities.get({ entity_id: entityIdA })).rejects.toThrow(/not found/i);
  });

  it('list() in org B does not surface org A entities', async () => {
    const list = (await clientB.entities.list({ entity_type: 'company' })) as {
      entities?: Array<{ id: number; name: string }>;
    };
    const names = list.entities?.map((e) => e.name) ?? [];
    expect(names).not.toContain('Org A Only');
  });

  it('cannot delete an entity that lives in another org', async () => {
    await expect(clientB.entities.delete({ entity_id: entityIdA })).rejects.toThrow(
      /not found|access|admin/i
    );
  });

  it('an org A user with their own org context cannot fetch an org B entity', async () => {
    // Create an entity in B, then try to read it with A's context.
    const entityB = (await clientB.entities.create({
      entity_type: 'company',
      name: 'Org B Only',
    })) as { entity: { id: number } };
    await expect(clientA.entities.get({ entity_id: entityB.entity.id })).rejects.toThrow(/not found/i);
  });
});
