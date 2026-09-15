/**
 * `resolveWriteCreatorUserId` against the real schema.
 *
 * The unit tests stub `sql`, so they pin the branching but not the two actual
 * queries. This proves them end to end: the `automations JOIN "user"` lookup
 * resolves a live owner row, and the `resolveEntityCreator` fallback reads a live
 * `member`. Because both return an id that exists in `"user"`, the value is a valid
 * target for `entities_created_by_fkey` — which is the whole point: a headless
 * script-executor create can no longer land on the FK-invalid "system" sentinel.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveWriteCreatorUserId } from '../../../authz/entity-policy';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

async function orgWithAutomation(name: string, slug: string) {
  const workspace = await TestWorkspace.create({ name });
  const ownerUserId = workspace.users.owner.id;
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: `${slug}-agent`,
  });
  const api = await TestApiClient.for({
    organizationId: workspace.org.id,
    userId: ownerUserId,
    memberRole: 'owner',
  });
  const created = (await api.automations.create({
    slug,
    prompt: 'Anything.',
    managed_agent_id: agent.agentId,
  })) as { automation_id: string };
  return {
    organizationId: workspace.org.id,
    ownerUserId,
    automationId: Number(created.automation_id),
  };
}

describe('resolveWriteCreatorUserId (real DB)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('a headless session automation resolves to the automation owner (a real user row)', async () => {
    const org = await orgWithAutomation('Scan Org', 'scan');
    const creator = await resolveWriteCreatorUserId(getTestDb(), {
      organizationId: org.organizationId,
      userId: null,
      sessionAutomationId: org.automationId,
    });
    expect(creator).toBe(org.ownerUserId);
  });

  it('falls back to the org owner/admin when there is no session automation', async () => {
    const org = await orgWithAutomation('Fallback Org', 'fallback');
    const creator = await resolveWriteCreatorUserId(getTestDb(), {
      organizationId: org.organizationId,
      userId: null,
    });
    expect(creator).toBe(org.ownerUserId);
  });

  it('an explicit user id is returned untouched, never querying an automation', async () => {
    const org = await orgWithAutomation('Passthrough Org', 'passthrough');
    const creator = await resolveWriteCreatorUserId(getTestDb(), {
      organizationId: org.organizationId,
      userId: org.ownerUserId,
      sessionAutomationId: org.automationId,
    });
    expect(creator).toBe(org.ownerUserId);
  });

  it('an unknown session automation still resolves a real user via the org fallback', async () => {
    const org = await orgWithAutomation('Ghost Org', 'ghost');
    const creator = await resolveWriteCreatorUserId(getTestDb(), {
      organizationId: org.organizationId,
      userId: null,
      sessionAutomationId: 2_147_483_000,
    });
    // The JOIN finds no such automation, so it falls back to the org owner — never
    // "system", so the returned id is always a valid entities.created_by FK target.
    expect(creator).toBe(org.ownerUserId);
  });
});
