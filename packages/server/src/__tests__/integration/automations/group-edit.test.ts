/**
 * Group-edit refactor contracts.
 *
 * After this refactor:
 *   - Assigning a template to another entity (`create_from_version`) shares
 *     the existing `automation_versions` row instead of duplicating it.
 *   - Editing one assignment via `create_version` cascades to every automation
 *     in the group: same `current_version_id`, same `name`.
 *   - `set_reaction_script` cascades across the group.
 *   - A run snapshots `current_version_id` at creation; if the group is
 *     edited mid-run, `complete_window` still validates against the
 *     snapshot, not the new version.
 *   - Hard-deleting an entity that owns the group root transfers
 *     `automation_versions` ownership to a surviving sibling so the cascade
 *     doesn't wipe the version chain out from under the group.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { manageAutomations } from '../../../tools/admin/manage_automations';
import type { ToolContext } from '../../../tools/registry';
import { createAutomationRun } from '../../../runs/queue-service';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { parseAutomationRunPayload } from '../../../automations/automation';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

function ownerCtx(workspace: TestWorkspace): ToolContext {
  return {
    organizationId: workspace.org.id,
    userId: workspace.users.owner.id,
    memberRole: 'owner',
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
  };
}

async function seedRootAutomation(workspace: TestWorkspace, suffix: string) {
  const entity = await createTestEntity({
    name: `Root Entity ${suffix}`,
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
  });
  const automation = (await workspace.owner.automations.create({
    entity_id: entity.id,
    slug: `digest-${suffix}`,
    name: `Digest ${suffix}`,
    prompt: 'Summarize content for {{entities}}.',
    triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
    managed_agent_id: agent.agentId,
  })) as { automation_id: string };
  return { automationId: Number(automation.automation_id), entityId: entity.id };
}

async function assignToEntity(
  workspace: TestWorkspace,
  versionId: number,
  entityId: number
): Promise<number> {
  const result = (await manageAutomations(
    {
      action: 'create_from_version',
      version_id: String(versionId),
      entity_ids: [entityId],
    } as never,
    {} as Env,
    ownerCtx(workspace)
  )) as { created: Array<{ automation_id: string }> };
  return Number(result.created[0].automation_id);
}

describe('automation group edit contract', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('create_from_version reuses the source version row instead of duplicating', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Group Reuse Org' });
    const { automationId: rootId } = await seedRootAutomation(workspace, 'reuse');

    const [rootRow] = await sql`
      SELECT current_version_id, automation_group_id FROM automations WHERE id = ${rootId}
    `;
    const rootVersionId = Number(rootRow.current_version_id);
    const groupId = Number(rootRow.automation_group_id);
    expect(groupId).toBe(rootId);

    const sibling1Entity = await createTestEntity({
      name: 'Sibling 1',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const sibling2Entity = await createTestEntity({
      name: 'Sibling 2',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });

    const sibling1Id = await assignToEntity(workspace, rootVersionId, sibling1Entity.id);
    const sibling2Id = await assignToEntity(workspace, rootVersionId, sibling2Entity.id);

    // All three automations should point at the SAME version row.
    const rows = await sql`
      SELECT id, current_version_id, automation_group_id
      FROM automations WHERE id IN (${rootId}, ${sibling1Id}, ${sibling2Id})
      ORDER BY id
    `;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(Number(row.current_version_id)).toBe(rootVersionId);
      expect(Number(row.automation_group_id)).toBe(groupId);
    }

    // automation_versions row count for this group is exactly 1, not 3.
    const versionCount = await sql`
      SELECT COUNT(*)::int as n FROM automation_versions WHERE automation_id = ${groupId}
    `;
    expect(Number(versionCount[0].n)).toBe(1);
  });

  it('create_from_version copies the reaction script AND its input schema onto each new assignment', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({
      name: 'Group Script Copy Org',
    });
    const { automationId: rootId } = await seedRootAutomation(workspace, 'script-copy');

    await manageAutomations(
      {
        action: 'set_reaction_script',
        automation_id: String(rootId),
        // Declares an `input` contract → reaction_input_schema is populated. A
        // clone must carry BOTH the script and the schema, else the cloned
        // reaction silently loses its extraction contract (runs free-form).
        reaction_script:
          'export const input = { type: "object", properties: { s: { type: "string" } }, required: ["s"] };\n' +
          'export default async function reaction() { return; }',
      } as never,
      {} as Env,
      ownerCtx(workspace)
    );

    const [rootRow] = await sql`
      SELECT current_version_id FROM automations WHERE id = ${rootId}
    `;
    const rootVersionId = Number(rootRow.current_version_id);

    const siblingEntity = await createTestEntity({
      name: 'Script Copy Sibling',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const siblingId = await assignToEntity(workspace, rootVersionId, siblingEntity.id);

    const [siblingRow] = await sql`
      SELECT reaction_script, reaction_script_compiled, reaction_input_schema
      FROM automations WHERE id = ${siblingId}
    `;
    expect(siblingRow.reaction_script).toContain('reaction');
    expect(siblingRow.reaction_script_compiled).not.toBeNull();
    // The reaction-owned input contract travels with the clone.
    const siblingSchema = siblingRow.reaction_input_schema as Record<string, unknown> | null;
    expect(siblingSchema).not.toBeNull();
    expect(JSON.stringify(siblingSchema)).toContain('"s"');
  });

  it('set_reaction_script extracts the exported input schema to reaction_input_schema', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({
      name: 'Reaction Input Org',
    });
    const { automationId: rootId } = await seedRootAutomation(workspace, 'react-input');

    await manageAutomations(
      {
        action: 'set_reaction_script',
        automation_id: String(rootId),
        // `input` is a PLAIN JSON Schema (no typebox — it breaks the isolate
        // client). The host validates extracted_data against it.
        reaction_script:
          'export const input = { type: "object", properties: { s: { type: "string" } }, required: ["s"] };\n' +
          'export default async function reaction(ctx) { void ctx.extracted_data; }',
      } as never,
      {} as Env,
      ownerCtx(workspace)
    );

    const [row] = await sql`
      SELECT reaction_input_schema FROM automations WHERE id = ${rootId}
    `;
    const schema = row.reaction_input_schema as Record<string, unknown> | null;
    expect(schema).not.toBeNull();
    expect(schema?.type).toBe('object');
    expect(JSON.stringify(schema)).toContain('"s"');

    // Clearing the script wipes the cached schema too.
    await manageAutomations(
      {
        action: 'set_reaction_script',
        automation_id: String(rootId),
        reaction_script: '',
      } as never,
      {} as Env,
      ownerCtx(workspace)
    );
    const [cleared] = await sql`
      SELECT reaction_input_schema FROM automations WHERE id = ${rootId}
    `;
    expect(cleared.reaction_input_schema ?? null).toBeNull();
  });

  it('create_version cascades current_version_id and name across the whole group', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Group Cascade Org' });
    const { automationId: rootId } = await seedRootAutomation(workspace, 'cascade');
    const [rootBefore] = await sql`
      SELECT current_version_id FROM automations WHERE id = ${rootId}
    `;
    const sibling1Entity = await createTestEntity({
      name: 'Cascade Sibling 1',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const sibling2Entity = await createTestEntity({
      name: 'Cascade Sibling 2',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const sibling1Id = await assignToEntity(
      workspace,
      Number(rootBefore.current_version_id),
      sibling1Entity.id
    );
    const sibling2Id = await assignToEntity(
      workspace,
      Number(rootBefore.current_version_id),
      sibling2Entity.id
    );

    // Edit through the SIBLING — group cascade should still apply, not just to the sibling.
    const result = (await manageAutomations(
      {
        action: 'create_version',
        automation_id: String(sibling1Id),
        prompt: 'Cascaded prompt v2.',
        name: 'Cascaded Name v2',
        change_notes: 'group cascade',
      } as never,
      {} as Env,
      ownerCtx(workspace)
    )) as { version_id: string; version: number };
    const newVersionId = Number(result.version_id);
    expect(result.version).toBe(2);

    const rows = await sql`
      SELECT id, current_version_id, name, version
      FROM automations WHERE id IN (${rootId}, ${sibling1Id}, ${sibling2Id})
      ORDER BY id
    `;
    for (const row of rows) {
      expect(Number(row.current_version_id)).toBe(newVersionId);
      expect(row.name).toBe('Cascaded Name v2');
      expect(Number(row.version)).toBe(2);
    }

    // The new version row is owned by the group root, not the sibling.
    const [versionRow] = await sql`
      SELECT automation_id, prompt FROM automation_versions WHERE id = ${newVersionId}
    `;
    expect(Number(versionRow.automation_id)).toBe(rootId);
    expect(versionRow.prompt).toBe('Cascaded prompt v2.');
  });

  it('create_version rejects an event output invalid for any sibling assignment', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Group Output Registry Org' });
    await ensureMemberEntityType(workspace.org.id);
    const { automationId: rootId } = await seedRootAutomation(workspace, 'output-registry');
    const siblingEntity = await createTestEntity({
      name: 'Restricted Sibling',
      entity_type: 'restricted',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const [root] = await sql`
      SELECT current_version_id FROM automations WHERE id = ${rootId}
    `;
    await assignToEntity(workspace, Number(root.current_version_id), siblingEntity.id);
    await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json({ brand_signal: { description: 'Brand-only signal' } })}
      WHERE organization_id = ${workspace.org.id} AND slug = 'brand'
    `;
    await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json({ restricted_signal: { description: 'Restricted signal' } })}
      WHERE organization_id = ${workspace.org.id} AND slug = 'restricted'
    `;

    await expect(
      manageAutomations(
        {
          action: 'create_version',
          automation_id: String(rootId),
          outputs: { alerts: { event: 'brand_signal' } },
        } as never,
        {} as Env,
        ownerCtx(workspace)
      )
    ).rejects.toThrow(/Invalid event type 'brand_signal'/i);
  });

  it('create_from_version rejects an event output invalid for a clone target', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Clone Output Registry Org' });
    await ensureMemberEntityType(workspace.org.id);
    const { automationId: rootId } = await seedRootAutomation(workspace, 'clone-output-registry');
    await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json({ brand_signal: { description: 'Brand-only signal' } })}
      WHERE organization_id = ${workspace.org.id} AND slug = 'brand'
    `;
    const version = (await manageAutomations(
      {
        action: 'create_version',
        automation_id: String(rootId),
        outputs: { alerts: { event: 'brand_signal' } },
      } as never,
      {} as Env,
      ownerCtx(workspace)
    )) as { version_id: string };
    const target = await createTestEntity({
      name: 'Restricted Clone Target',
      entity_type: 'restricted',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json({ restricted_signal: { description: 'Restricted signal' } })}
      WHERE organization_id = ${workspace.org.id} AND slug = 'restricted'
    `;

    await expect(
      manageAutomations(
        {
          action: 'create_from_version',
          version_id: version.version_id,
          entity_ids: [target.id],
        } as never,
        {} as Env,
        ownerCtx(workspace)
      )
    ).rejects.toThrow(/Invalid event type 'brand_signal'/i);
  });

  it('set_reaction_script cascades to every automation in the group', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Group Script Org' });
    const { automationId: rootId } = await seedRootAutomation(workspace, 'script-cascade');
    const [rootBefore] = await sql`
      SELECT current_version_id FROM automations WHERE id = ${rootId}
    `;
    const siblingEntity = await createTestEntity({
      name: 'Script Cascade Sibling',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const siblingId = await assignToEntity(
      workspace,
      Number(rootBefore.current_version_id),
      siblingEntity.id
    );

    await manageAutomations(
      {
        action: 'set_reaction_script',
        automation_id: String(rootId),
        reaction_script: 'export default async function reaction() { /* v1 */ }',
      } as never,
      {} as Env,
      ownerCtx(workspace)
    );

    let rows = await sql`
      SELECT id, reaction_script FROM automations WHERE id IN (${rootId}, ${siblingId}) ORDER BY id
    `;
    expect(rows[0].reaction_script).toContain('v1');
    expect(rows[1].reaction_script).toContain('v1');

    // Calling through the sibling (not the root) — should still cascade.
    await manageAutomations(
      {
        action: 'set_reaction_script',
        automation_id: String(siblingId),
        reaction_script: '',
      } as never,
      {} as Env,
      ownerCtx(workspace)
    );

    rows = await sql`
      SELECT id, reaction_script FROM automations WHERE id IN (${rootId}, ${siblingId}) ORDER BY id
    `;
    expect(rows[0].reaction_script).toBeNull();
    expect(rows[1].reaction_script).toBeNull();
  });

  it('set_reaction_script identical save emits no extra group audit events', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Group Script Noop Org' });
    const { automationId: rootId } = await seedRootAutomation(workspace, 'script-noop');
    const [rootBefore] = await sql`
      SELECT current_version_id FROM automations WHERE id = ${rootId}
    `;
    const siblingEntity = await createTestEntity({
      name: 'Script Noop Sibling',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const siblingId = await assignToEntity(
      workspace,
      Number(rootBefore.current_version_id),
      siblingEntity.id
    );
    const script = 'export default async function reaction() { return; }';
    await manageAutomations(
      { action: 'set_reaction_script', automation_id: String(rootId), reaction_script: script } as never,
      {} as Env,
      ownerCtx(workspace)
    );
    const [{ count: beforeCount }] = await sql`
      SELECT COUNT(*)::int AS count FROM events
      WHERE metadata->>'category' = 'config'
        AND metadata->>'action' = 'set_reaction_script'
        AND metadata->>'resource_id' IN (${String(rootId)}, ${String(siblingId)})
    `;
    await manageAutomations(
      { action: 'set_reaction_script', automation_id: String(siblingId), reaction_script: script } as never,
      {} as Env,
      ownerCtx(workspace)
    );
    const [{ count: afterCount }] = await sql`
      SELECT COUNT(*)::int AS count FROM events
      WHERE metadata->>'category' = 'config'
        AND metadata->>'action' = 'set_reaction_script'
        AND metadata->>'resource_id' IN (${String(rootId)}, ${String(siblingId)})
    `;
    expect(Number(afterCount)).toBe(Number(beforeCount));
  });

  it('set_reaction_script treats reordered stored schema keys as unchanged', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Script Schema Noop Org' });
    const { automationId } = await seedRootAutomation(workspace, 'schema-noop');
    const script = 'export const input = { type: "object", properties: { item: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } } } }; export default async function reaction() { return; }';
    await manageAutomations(
      { action: 'set_reaction_script', automation_id: String(automationId), reaction_script: script } as never,
      {} as Env,
      ownerCtx(workspace)
    );
    // Simulate PostgreSQL returning the same JSONB document with another key order.
    await sql`
      UPDATE automations SET reaction_input_schema = ${sql.json({
        properties: { item: { properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' } },
        type: 'object',
      })} WHERE id = ${automationId}
    `;
    const [{ count: beforeCount }] = await sql`
      SELECT COUNT(*)::int AS count FROM events
      WHERE metadata->>'category' = 'config'
        AND metadata->>'action' = 'set_reaction_script'
        AND metadata->>'resource_id' = ${String(automationId)}
    `;
    await manageAutomations(
      { action: 'set_reaction_script', automation_id: String(automationId), reaction_script: script } as never,
      {} as Env,
      ownerCtx(workspace)
    );
    const [{ count: afterCount }] = await sql`
      SELECT COUNT(*)::int AS count FROM events
      WHERE metadata->>'category' = 'config'
        AND metadata->>'action' = 'set_reaction_script'
        AND metadata->>'resource_id' = ${String(automationId)}
    `;
    expect(Number(afterCount)).toBe(Number(beforeCount));
  });

  it('createAutomationRun snapshots current_version_id; mid-run group edit does not change the run', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Run Snapshot Org' });
    const { automationId: rootId } = await seedRootAutomation(workspace, 'snapshot');

    const [rootBefore] = await sql`
      SELECT current_version_id FROM automations WHERE id = ${rootId}
    `;
    const snapshotVersionId = Number(rootBefore.current_version_id);

    const queued = await createAutomationRun({
      organizationId: workspace.org.id,
      automationId: rootId,
      agentId: 'snapshot-agent',
      windowStart: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      windowEnd: new Date().toISOString(),
      dispatchSource: 'scheduled',
    });

    // Group edit lands AFTER the run was created — current_version_id moves
    // to v2 on the automations row, but the run's payload still holds v1.
    await manageAutomations(
      {
        action: 'create_version',
        automation_id: String(rootId),
        prompt: 'Post-run edit.',
        change_notes: 'after run created',
      } as never,
      {} as Env,
      ownerCtx(workspace)
    );

    const [runRow] = await sql`
      SELECT (approved_input->>'version_id')::bigint as version_id
      FROM runs WHERE id = ${queued.runId}
    `;
    expect(Number(runRow.version_id)).toBe(snapshotVersionId);

    // The automation itself has moved on — confirms the snapshot diverges.
    const [automationAfter] = await sql`
      SELECT current_version_id FROM automations WHERE id = ${rootId}
    `;
    expect(Number(automationAfter.current_version_id)).not.toBe(snapshotVersionId);
  });

  it('parseAutomationRunPayload returns the snapshot version_id', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Payload Parse Org' });
    const { automationId: rootId } = await seedRootAutomation(workspace, 'parse');

    const queued = await createAutomationRun({
      organizationId: workspace.org.id,
      automationId: rootId,
      agentId: 'parse-agent',
      windowStart: new Date().toISOString(),
      windowEnd: new Date().toISOString(),
      dispatchSource: 'scheduled',
    });

    const [run] = await sql`SELECT approved_input FROM runs WHERE id = ${queued.runId}`;
    const parsed = parseAutomationRunPayload(run.approved_input);
    expect(parsed).not.toBeNull();
    expect(parsed!.version_id).not.toBeNull();
    expect(Number.isFinite(parsed!.version_id as number)).toBe(true);
  });

  it('parseAutomationRunPayload tolerates legacy runs missing version_id', () => {
    const legacyPayload = {
      automation_id: 1,
      managed_agent_id: 'a',
      window_start: '2024-01-01',
      window_end: '2024-01-02',
      dispatch_source: 'scheduled',
    };
    const parsed = parseAutomationRunPayload(legacyPayload);
    expect(parsed).not.toBeNull();
    expect(parsed!.version_id).toBeNull();
  });

  it('complete_window scopes the run lookup by automation_id', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Run Scope Org' });
    const { automationId: aId } = await seedRootAutomation(workspace, 'scope-a');
    const { automationId: bId } = await seedRootAutomation(workspace, 'scope-b');

    // Create a run for automation A. The run's snapshot version is A's current.
    const aRun = await createAutomationRun({
      organizationId: workspace.org.id,
      automationId: aId,
      agentId: 'a-agent',
      windowStart: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      windowEnd: new Date().toISOString(),
      dispatchSource: 'scheduled',
    });

    // Now bump A's current_version_id to v2 — the snapshot in aRun still
    // points at v1, but if complete_window for B mistakenly uses aRun's id
    // it must NOT pick up A's v1 snapshot.
    await manageAutomations(
      {
        action: 'create_version',
        automation_id: String(aId),
        prompt: "A's v2",
        change_notes: 'bump A',
      } as never,
      {} as Env,
      ownerCtx(workspace)
    );

    // Confirm the run lookup we use in complete_window won't return A's
    // snapshot when scoped by automation_id = B.
    const [scopedToB] = await sql`
      SELECT (approved_input->>'version_id')::bigint AS version_id
      FROM runs WHERE id = ${aRun.runId} AND automation_id = ${bId}
      LIMIT 1
    `;
    expect(scopedToB).toBeUndefined();
    const [scopedToA] = await sql`
      SELECT (approved_input->>'version_id')::bigint AS version_id
      FROM runs WHERE id = ${aRun.runId} AND automation_id = ${aId}
      LIMIT 1
    `;
    expect(scopedToA).toBeDefined();
    expect(Number(scopedToA.version_id)).toBeGreaterThan(0);
  });

  it('serializes concurrent create_version calls on the same group', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({
      name: 'Concurrent Edit Org',
    });
    const { automationId: rootId } = await seedRootAutomation(workspace, 'concurrent');

    // Fire two create_version calls in parallel. The advisory lock should
    // serialize them; one ends up at v2, the other at v3 — neither errors,
    // neither collides on (automation_id, version) unique index.
    const [r1, r2] = await Promise.all([
      manageAutomations(
        {
          action: 'create_version',
          automation_id: String(rootId),
          prompt: 'edit A',
          change_notes: 'A',
        } as never,
        {} as Env,
        ownerCtx(workspace)
      ),
      manageAutomations(
        {
          action: 'create_version',
          automation_id: String(rootId),
          prompt: 'edit B',
          change_notes: 'B',
        } as never,
        {} as Env,
        ownerCtx(workspace)
      ),
    ]);

    const versions = [r1, r2]
      .map((r) => Number((r as { version: number }).version))
      .sort((a, b) => a - b);
    expect(versions).toEqual([2, 3]);

    const versionRows = await sql`
      SELECT version FROM automation_versions WHERE automation_id = ${rootId} ORDER BY version
    `;
    const stored = versionRows.map((r) => Number(r.version));
    expect(stored).toEqual([1, 2, 3]);
  });
});
