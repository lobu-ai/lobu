/**
 * `resolveWriteCreatorUserId` against the real schema.
 *
 * The unit tests stub `sql`, so they pin the branching but not the two actual
 * queries. This proves them end to end: the `automations JOIN "user"` lookup
 * resolves a live owner row, and the `resolveEntityCreator` fallback reads a live
 * `member`. Because both return an id that exists in `"user"`, the value is a valid
 * target for `entities_created_by_fkey` — which is the whole point: a headless
 * script-executor create can no longer land on the FK-invalid "system" sentinel.
 *
 * The last case drives the real `manage_entity` create call site
 * (`ctx.actingAutomationId` → `sessionAutomationId` → `entities.created_by`). The
 * test DB seeds a literal `system` user row (setup/test-db.ts), so the ORIGINAL
 * `entities_created_by_fkey` violation on the sentinel is invisible to the suite;
 * asserting the automation owner is what keeps manage_entity off the sentinel.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveWriteCreatorUserId } from '../../../authz/entity-policy';
import type { Env } from '../../../index';
import { manageEntity } from '../../../tools/admin/manage_entity';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, seedSystemEntityTypes } from '../../setup/test-fixtures';
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
    agentId: agent.agentId,
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

  it('manage_entity create under a headless automation session stamps the automation owner', async () => {
    await initWorkspaceProvider();
    await seedSystemEntityTypes();
    const org = await orgWithAutomation('Headless Create Org', 'precall-scan');
    const sql = getTestDb();
    // An "auto" entity-write policy for the owner agent, so the create clears the
    // mutation gate and reaches the insert (where created_by is stamped).
    const [policy] = await sql<{ id: number }[]>`
      INSERT INTO write_approval_policies (
        organization_id, resource_class, principal_kind, principal_id
      ) VALUES (${org.organizationId}, 'entity', 'agent', ${org.agentId})
      RETURNING id
    `;
    await sql`
      INSERT INTO write_policy_action_effects (policy_id, action, effect)
      VALUES (${policy.id}, 'create', 'auto')
    `;
    await sql`
      INSERT INTO entity_types (
        organization_id, slug, name, metadata_schema, created_at, updated_at
      ) VALUES (
        ${org.organizationId}, 'brand', 'Brand', ${sql.json({ type: 'object' })},
        current_timestamp, current_timestamp
      )
    `;

    // The script executor's shape: no user, acting as the automation.
    const headlessCtx = {
      organizationId: org.organizationId,
      userId: null,
      agentId: org.agentId,
      actingAutomationId: org.automationId,
      memberRole: 'owner',
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      mcpSessionId: 'session-headless-create',
    } as ToolContext;
    const res = (await manageEntity(
      { action: 'create', entity_type: 'brand', name: 'Acme Corp', slug: 'acme-headless-create' },
      {} as Env,
      headlessCtx
    )) as { action: string; entity?: { id: number } };
    expect(res.action).toBe('create');
    expect(res.entity?.id).toBeTruthy();

    const [row] = (await sql`
      SELECT created_by FROM entities WHERE id = ${res.entity?.id}
    `) as Array<{ created_by: string }>;
    expect(row.created_by).toBe(org.ownerUserId);
  });
});
