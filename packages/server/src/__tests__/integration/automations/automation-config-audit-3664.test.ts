/**
 * #3664: automation runtime/config mutations emit immutable
 * resource_kind='automation' config events with actor provenance and
 * redacted before/after. No-op updates emit nothing; denied/failed attempts
 * stay in tool-invocation audit only; approval apply carries requester +
 * approval run; system auto-pause/reset are system-attributed.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { parsePositiveIntegerId } from '../../../utils/errors';
import { redactConfigState } from '../../../utils/config-redaction';
import { resetScheduledFailureState, recordScheduledExecutionFailure } from '../../../automations/scheduled-failure-policy';
import type { Env } from '../../../index';
import type { AuthContext } from '../../../tools/execute';
import { executeTool } from '../../../tools/execute';
import { initWorkspaceProvider } from '../../../workspace';
import {
  addUserToOrganization,
  createTestAgent,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

const TEST_ENV: Env = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  MAX_CONSECUTIVE_FAILURES: '3',
  RATE_LIMIT_ENABLED: 'false',
};

async function configEvents(orgId: string, resourceId?: string) {
  const sql = getTestDb();
  const rows = await sql`
    SELECT id, metadata, payload_data, created_by, client_id
    FROM events
    WHERE organization_id = ${orgId}
      AND semantic_type = 'change'
      AND metadata->>'category' = 'config'
      AND metadata->>'resource_kind' = 'automation'
      ${resourceId ? sql`AND metadata->>'resource_id' = ${resourceId}` : sql``}
    ORDER BY id ASC
  `;
  return rows as Array<Record<string, any>>;
}

async function invocationEvents(orgId: string, tool = 'manage_automations') {
  const sql = getTestDb();
  const rows = await sql`
    SELECT id, metadata, payload_data FROM events
    WHERE organization_id = ${orgId}
      AND metadata->>'category' = 'audit'
      AND metadata->>'tool_name' = ${tool}
    ORDER BY id ASC
  `;
  return rows as Array<Record<string, any>>;
}

describe('automation config audit #3664', () => {
  let orgId: string;
  let userId: string;
  let agentId: string;
  let owner: TestApiClient;
  let sessionCaller: TestApiClient;
  let patCaller: TestApiClient;
  let orgBId: string;
  let crossOrgCaller: TestApiClient;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await initWorkspaceProvider();
    const org = await createTestOrganization({ name: 'Audit 3664 Org' });
    const user = await createTestUser({ email: 'audit3664@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    orgId = org.id;
    userId = user.id;
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    agentId = agent.agentId;
    owner = await TestApiClient.for({ organizationId: org.id, userId: user.id, memberRole: 'owner', tokenType: 'oauth' });
    sessionCaller = await TestApiClient.for({ organizationId: org.id, userId: user.id, memberRole: 'owner', tokenType: 'session' });
    patCaller = await TestApiClient.for({ organizationId: org.id, userId: user.id, memberRole: 'owner', tokenType: 'pat' });
    const orgB = await createTestOrganization({ name: 'Audit 3664 Org B' });
    const userB = await createTestUser({ email: 'audit3664-b@test.com' });
    await addUserToOrganization(userB.id, orgB.id, 'owner');
    orgBId = orgB.id;
    crossOrgCaller = await TestApiClient.for({ organizationId: orgB.id, userId: userB.id, memberRole: 'owner', tokenType: 'oauth' });
  });

  it('create emits actor + before null + redacted after', async () => {
    const created = (await owner.automations.create({
      slug: 'audit-create',
      name: 'Audit Create',
      prompt: 'Do things.',
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      managed_agent_id: agentId,
      agent_kind: 'claude-code',
      model_config: { api_key: 'secret-should-redact' } as any,
    })) as { automation_id: string };
    expect(created.automation_id).toBeDefined();
    const rows = await configEvents(orgId, created.automation_id);
    expect(rows.length).toBe(1);
    const meta = rows[0].metadata as Record<string, any>;
    expect(meta.resource_kind).toBe('automation');
    expect(meta.op).toBe('created');
    expect(meta.action).toBe('create');
    expect(rows[0].created_by).toBe(userId);
    expect(meta.token_type).toBe('oauth');
    expect(meta.actor_source).toBe('api');
    const payload = rows[0].payload_data as Record<string, any>;
    expect(payload.before).toBeNull();
    expect(payload.state).toBeDefined();
    expect(payload.state.agent_kind).toBe('claude-code');
    // Secrets never persist, even under non-denylisted nesting.
    expect(JSON.stringify(payload.state)).not.toContain('secret-should-redact');
    // Create changedFields covers every config field in the after-state.
    for (const field of [
      'name', 'slug', 'status', 'version', 'entity_ids', 'schedule', 'timezone',
      'triggers', 'managed_agent_id', 'agent_kind', 'device_worker_id',
      'model_config', 'execution_config', 'sources', 'tags', 'delivery_target',
      'min_cooldown_seconds', 'prompt', 'description', 'outputs', 'classifiers',
      'reactions_guidance', 'reaction_script', 'reaction_input_schema',
    ]) {
      expect(meta.changed_fields).toContain(field);
    }
  });

  it('update emits before/after + changed fields; no-op emits nothing', async () => {
    const created = (await owner.automations.create({
      slug: 'audit-update',
      name: 'Audit Update',
      prompt: 'v1',
      triggers: [],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    const beforeCount = (await configEvents(orgId, created.automation_id)).length;

    await owner.automations.update({
      automation_id: created.automation_id,
      tags: ['audit-tag'],
    });
    let rows = await configEvents(orgId, created.automation_id);
    expect(rows.length).toBe(beforeCount + 1);
    const upd = rows[rows.length - 1];
    expect(upd.metadata.action).toBe('update');
    expect(upd.metadata.changed_fields).toContain('tags');
    expect(upd.created_by).toBe(userId);
    const payload = upd.payload_data as Record<string, any>;
    expect(payload.state.tags).toContain('audit-tag');

    // No-op: same value again → no new config event.
    await owner.automations.update({
      automation_id: created.automation_id,
      tags: ['audit-tag'],
    });
    rows = await configEvents(orgId, created.automation_id);
    expect(rows.length).toBe(beforeCount + 1);
  });

  it('update treats reversed-key JSONB as unchanged (canonical deep equality)', async () => {
    const created = (await owner.automations.create({
      slug: 'audit-noop-keyorder',
      name: 'Audit Noop Keyorder',
      prompt: 'v1',
      triggers: [],
      managed_agent_id: agentId,
      model_config: { z: 1, a: { d: 4, c: 3 }, m: 2 } as any,
      execution_config: { timeout_seconds: 60, max_budget_usd: 1.5 } as any,
    })) as { automation_id: string };
    const beforeCount = (await configEvents(orgId, created.automation_id)).length;

    // Same values, reversed key order at both levels → no new config event.
    const res = (await owner.automations.update({
      automation_id: created.automation_id,
      model_config: { m: 2, a: { c: 3, d: 4 }, z: 1 } as any,
      execution_config: { max_budget_usd: 1.5, timeout_seconds: 60 } as any,
    })) as { updated_fields: string[] };
    expect(res.updated_fields).toEqual([]);
    const rows = await configEvents(orgId, created.automation_id);
    expect(rows.length).toBe(beforeCount);
  });

  it('delivery_target retains numeric connection id + channel, drops secrets', () => {
    const redacted = redactConfigState('automation', {
      delivery_target: { connection_id: 541, channel_id: 'slack:C_TASKS', token: 'shh', secret: 'shh2' },
    }) as Record<string, any>;
    expect(redacted.delivery_target).toEqual({ connection_id: 541, channel_id: 'slack:C_TASKS' });
    const legacy = redactConfigState('automation', {
      delivery_target: { connection_id: 'c1', channel: 'ch1', token: 'shh' },
    }) as Record<string, any>;
    expect(legacy.delivery_target).toEqual({ connection_id: 'c1', channel: 'ch1' });
  });

  it('set_reaction_script emits transactional before/after', async () => {
    const created = (await owner.automations.create({
      slug: 'audit-reaction',
      name: 'Audit Reaction',
      prompt: 'react',
      triggers: [],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    const beforeCount = (await configEvents(orgId, created.automation_id)).length;
    await owner.automations.setReactionScript({
      automation_id: created.automation_id,
      reaction_script: 'export default async () => ({ summary: "hi" });',
    });
    const rows = await configEvents(orgId, created.automation_id);
    expect(rows.length).toBe(beforeCount + 1);
    expect(rows[rows.length - 1].metadata.action).toBe('set_reaction_script');
    expect(rows[rows.length - 1].metadata.changed_fields).toContain('reaction_script');
    expect(rows[rows.length - 1].metadata.changed_fields).toContain('reaction_input_schema');
    // Per-row cascade audit: the row carries its own before/after.
    const payload = rows[rows.length - 1].payload_data as Record<string, any>;
    expect(payload.before.reaction_script).toBeNull();
    expect(payload.before.reaction_input_schema).toBeNull();
    expect(payload.state.reaction_script).toContain('summary');
    expect(payload.state).toHaveProperty('reaction_input_schema');
  });

  it('set_reaction_script clear audits prior input schema', async () => {
    const created = (await owner.automations.create({
      slug: 'audit-reaction-clear',
      name: 'Audit Reaction Clear',
      prompt: 'react',
      triggers: [],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    await owner.automations.setReactionScript({
      automation_id: created.automation_id,
      reaction_script: 'export const input = { type: "object" }; export default async () => ({ summary: "hi" });',
    });
    const beforeClear = (await configEvents(orgId, created.automation_id)).length;
    await owner.automations.setReactionScript({
      automation_id: created.automation_id,
      reaction_script: '',
    });
    const rows = await configEvents(orgId, created.automation_id);
    expect(rows.length).toBe(beforeClear + 1);
    const last = rows[rows.length - 1];
    expect(last.metadata.action).toBe('set_reaction_script');
    expect(last.metadata.changed_fields).toContain('reaction_script');
    expect(last.metadata.changed_fields).toContain('reaction_input_schema');
    const payload = last.payload_data as Record<string, any>;
    expect(payload.before.reaction_script).toContain('summary');
    expect(payload.before).toHaveProperty('reaction_input_schema');
    expect(payload.state.reaction_script).toBeNull();
    expect(payload.state.reaction_input_schema).toBeNull();
  });

  it('create_from_version audits every copied config field', async () => {
    const source = (await owner.automations.create({
      slug: 'audit-cfv-source',
      name: 'Audit CFV Source',
      prompt: 'source prompt',
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      managed_agent_id: agentId,
      model_config: { model: 'm1' } as any,
      execution_config: { timeout_seconds: 30 } as any,
      tags: ['cfv-tag'],
    })) as { automation_id: string };
    await owner.automations.setReactionScript({
      automation_id: source.automation_id,
      reaction_script: 'export default async () => ({ summary: "cfv" });',
    });
    const sql = getTestDb();
    const [srcRow] = await sql`SELECT current_version_id FROM automations WHERE id = ${Number(source.automation_id)}`;
    const entity = await createTestEntity({
      name: 'CFV Target',
      organization_id: orgId,
      created_by: userId,
    });
    const cloned = (await owner.automations.createFromVersion({
      version_id: String(srcRow.current_version_id),
      entity_ids: [entity.id],
    })) as { created: Array<{ automation_id: string }> };
    const newId = cloned.created[0].automation_id;
    const rows = await configEvents(orgId, newId);
    expect(rows.length).toBe(1);
    const meta = rows[0].metadata as Record<string, any>;
    expect(meta.action).toBe('create_from_version');
    const payload = rows[0].payload_data as Record<string, any>;
    // Every copied field is represented in state…
    expect(payload.state.model_config).toEqual({ model: 'm1' });
    expect(payload.state.execution_config).toEqual({ timeout_seconds: 30 });
    expect(payload.state.tags).toContain('cfv-tag');
    expect(payload.state.reaction_script).toContain('cfv');
    expect(payload.state).toHaveProperty('reaction_input_schema');
    expect(payload.state.prompt).toBe('source prompt');
    // …and covered by changedFields. No overclaim: uncopied settings stay out.
    for (const field of [
      'model_config', 'execution_config', 'tags', 'reaction_script',
      'reaction_input_schema', 'triggers', 'schedule', 'timezone',
    ]) {
      expect(meta.changed_fields).toContain(field);
    }
    expect(meta.changed_fields).not.toContain('delivery_target');
    expect(meta.changed_fields).not.toContain('min_cooldown_seconds');
  });

  it('cross-org set_reaction_script reads as not-found and writes nothing', async () => {
    const created = (await owner.automations.create({
      slug: 'audit-reaction-xorg',
      name: 'Audit Reaction Xorg',
      prompt: 'react',
      triggers: [],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    const ownCount = (await configEvents(orgId, created.automation_id)).length;
    await expect(
      crossOrgCaller.automations.setReactionScript({
        automation_id: created.automation_id,
        reaction_script: 'export default async () => ({ summary: "evil" });',
      })
    ).rejects.toThrow(/not found/i);
    expect((await configEvents(orgId, created.automation_id)).length).toBe(ownCount);
    expect(await configEvents(orgBId, created.automation_id)).toEqual([]);
    const sql = getTestDb();
    const rows = await sql`SELECT reaction_script FROM automations WHERE id = ${Number(created.automation_id)}`;
    expect(rows[0]?.reaction_script).toBeNull();
  });

  it('cross-org update reads as not-found and writes nothing', async () => {
    const created = (await owner.automations.create({
      slug: 'audit-update-xorg',
      name: 'Audit Update Xorg',
      prompt: 'v1',
      triggers: [],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    const ownCount = (await configEvents(orgId, created.automation_id)).length;
    await expect(
      crossOrgCaller.automations.update({
        automation_id: created.automation_id,
        tags: ['evil-tag'],
      })
    ).rejects.toThrow(/not found/i);
    expect((await configEvents(orgId, created.automation_id)).length).toBe(ownCount);
  });

  it('create_version emits with prompt before/after', async () => {
    const created = (await owner.automations.create({
      slug: 'audit-version',
      name: 'Audit Version',
      prompt: 'v1 prompt',
      triggers: [],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    const beforeCount = (await configEvents(orgId, created.automation_id)).length;
    await owner.automations.createVersion({
      automation_id: created.automation_id,
      prompt: 'v2 prompt',
    });
    const rows = await configEvents(orgId, created.automation_id);
    expect(rows.length).toBe(beforeCount + 1);
    const last = rows[rows.length - 1];
    expect(last.metadata.action).toBe('create_version');
    const payload = last.payload_data as Record<string, any>;
    expect(payload.before.prompt).toBe('v1 prompt');
    expect(payload.state.prompt).toBe('v2 prompt');
  });

  it('create_version rename preserves the previous name in audit history', async () => {
    const created = (await owner.automations.create({
      slug: 'audit-version-rename',
      name: 'Original Name',
      prompt: 'v1 prompt',
      triggers: [],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    await owner.automations.createVersion({
      automation_id: created.automation_id,
      name: 'Renamed Automation',
      prompt: 'v2 prompt',
    });
    const rows = await configEvents(orgId, created.automation_id);
    const last = rows[rows.length - 1];
    expect(last.metadata.action).toBe('create_version');
    expect(last.metadata.changed_fields).toContain('name');
    const payload = last.payload_data as Record<string, any>;
    expect(payload.before.name).toBe('Original Name');
    expect(payload.state.name).toBe('Renamed Automation');
  });

  it.each([
    { label: 'draft proposed cadence', publish: false, propose: true },
    { label: 'published prompt only', publish: true, propose: false },
    { label: 'published cadence', publish: true, propose: true },
  ])('F6 coherent snapshots for $label', async ({ label, publish, propose }) => {
    const cadence = { kind: 'schedule' as const, cron: '0 9 * * *', timezone: 'Europe/London' };
    const proposed = { ...cadence, cron: '0 10 * * *', timezone: 'America/New_York' };
    const created = (await owner.automations.create({
      slug: label.replaceAll(' ', '-'), name: label, prompt: 'v1 prompt',
      triggers: [cadence], managed_agent_id: agentId,
    })) as { automation_id: string };
    await owner.automations.createVersion({
      automation_id: created.automation_id, prompt: 'v2 prompt',
      ...(propose ? { triggers: [proposed] } : {}), set_as_current: publish,
    });
    const last = (await configEvents(orgId, created.automation_id)).at(-1)!;
    expect(last.metadata.action).toBe('create_version');
    const { before, state } = last.payload_data;
    expect(before.prompt).toBe('v1 prompt');
    expect(state.prompt).toBe('v2 prompt');
    const touched = publish && propose;
    for (const field of ['schedule', 'timezone', 'triggers']) {
      // Full-document diff consumers must see the same projection on both sides.
      expect(Object.hasOwn(before, field)).toBe(Object.hasOwn(state, field));
      if (!touched) {
        expect(before[field]).toEqual(state[field]);
        expect(last.metadata.changed_fields).not.toContain(field);
      } else {
        expect(last.metadata.changed_fields).toContain(field);
      }
    }
    if (touched) {
      expect(before).toMatchObject({ schedule: cadence.cron, timezone: cadence.timezone, triggers: [cadence] });
      expect(state).toMatchObject({ schedule: proposed.cron, timezone: proposed.timezone, triggers: [proposed] });
    }
    const sql = getTestDb();
    const [live] = await sql`SELECT schedule, timezone, triggers FROM automations WHERE id = ${Number(created.automation_id)}`;
    const expected = touched ? proposed : cadence;
    expect(live).toMatchObject({ schedule: expected.cron, timezone: expected.timezone, triggers: [expected] });
  });

  it('delete invocation audit: all-failed is failure, partial stays success', async () => {
    const { recordToolInvocationAudit } = await import('../../../tools/audit');
    const baseCtx = {
      organizationId: orgId, userId, tokenType: 'oauth',
      clientId: null, agentId: null, mcpSessionId: null, mcpConversationId: null,
    } as any;
    const countInv = async () => (await invocationEvents(orgId)).length;

    const beforeAll = await countInv();
    await recordToolInvocationAudit({
      toolName: 'manage_automations',
      args: { action: 'delete', automation_ids: ['1', '2'] },
      result: {
        action: 'delete',
        results: [
          { automation_id: '1', success: false, message: 'nope' },
          { automation_id: '2', success: false, message: 'nope' },
        ],
        summary: { total: 2, successful: 0, failed: 2 },
      },
      durationMs: 1,
      ctx: baseCtx,
    });
    await recordToolInvocationAudit({
      toolName: 'manage_automations',
      args: { action: 'delete', automation_ids: ['1', '2'] },
      result: {
        action: 'delete',
        results: [
          { automation_id: '1', success: true, message: 'ok' },
          { automation_id: '2', success: false, message: 'nope' },
        ],
        summary: { total: 2, successful: 1, failed: 1 },
      },
      durationMs: 1,
      ctx: baseCtx,
    });
    const inv = await invocationEvents(orgId);
    expect(inv.length).toBe(beforeAll + 2);
    const [allFailed, partial] = inv.slice(-2);
    expect((allFailed.payload_data as any).success).toBe(false);
    expect((partial.payload_data as any).success).toBe(true);
  });

  it('delete emits deleted with before snapshot', async () => {
    const created = (await owner.automations.create({
      slug: 'audit-delete',
      name: 'Audit Delete',
      prompt: 'bye',
      triggers: [],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    await owner.automations.delete({ automation_ids: [created.automation_id] });
    const rows = await configEvents(orgId, created.automation_id);
    const last = rows[rows.length - 1];
    expect(last.metadata.op).toBe('deleted');
    expect(last.metadata.action).toBe('delete');
    expect((last.payload_data as any).before).toBeDefined();
    expect((last.payload_data as any).state).toBeNull();
  });

  it('session + PAT handler path carries token provenance on config events', async () => {
    const created = (await sessionCaller.automations.create({
      slug: 'audit-session',
      name: 'Audit Session',
      prompt: 's',
      triggers: [],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    await patCaller.automations.update({
      automation_id: created.automation_id,
      tags: ['session-pat-tag'],
    });
    // Handler-level (not direct-writer): the mutation path itself stamps the
    // session/PAT provenance on the config event.
    const rows = await configEvents(orgId, created.automation_id);
    const createRow = rows.find((r) => r.metadata.action === 'create');
    expect(createRow?.metadata.token_type).toBe('session');
    expect(createRow?.created_by).toBe(userId);
    const updateRow = rows.find((r) => r.metadata.action === 'update');
    expect(updateRow?.metadata.token_type).toBe('pat');
    expect(updateRow?.created_by).toBe(userId);
    expect(updateRow?.payload_data.state.tags).toContain('session-pat-tag');
  });

  it('session + PAT invocations are retained with action + automation id', async () => {
    const created = (await owner.automations.create({
      slug: 'audit-invocation',
      name: 'Audit Invocation',
      prompt: 's',
      triggers: [],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    // Direct-handler calls bypass the MCP dispatch that writes invocation
    // audit, so exercise the writer directly for web/session + PAT + denied.
    const { recordToolInvocationAudit } = await import('../../../tools/audit');
    const beforeInv = await invocationEvents(orgId);
    await recordToolInvocationAudit({
      toolName: 'manage_automations',
      args: { action: 'update', automation_id: created.automation_id },
      result: { automation_id: created.automation_id },
      durationMs: 1,
      ctx: { organizationId: orgId, userId, tokenType: 'session', clientId: null, agentId: null, mcpSessionId: 'sess-1', mcpConversationId: null },
    });
    await recordToolInvocationAudit({
      toolName: 'manage_automations',
      args: { action: 'delete', automation_ids: [created.automation_id] },
      error: new Error('denied'),
      durationMs: 1,
      ctx: { organizationId: orgId, userId, tokenType: 'pat', clientId: 'pat-client', agentId, mcpSessionId: null, mcpConversationId: 'conv-1' },
    });
    const inv = await invocationEvents(orgId);
    expect(inv.length).toBe(beforeInv.length + 2);
    const sessionRow = inv.find((r) => (r.payload_data as any).duration_ms === 1 && (r.metadata as any).token_type === 'session');
    expect(sessionRow).toBeDefined();
    expect((sessionRow!.payload_data as any).action).toBe('update');
    expect((sessionRow!.payload_data as any).automation_id).toBe(created.automation_id);
    expect((sessionRow!.metadata as any).automation_id).toBe(created.automation_id);
    expect((sessionRow!.metadata as any).mcp_session_id).toBe('sess-1');
    const deniedRow = inv.find((r) => (r.metadata as any).token_type === 'pat');
    expect(deniedRow).toBeDefined();
    expect((deniedRow!.payload_data as any).success).toBe(false);
    expect((deniedRow!.payload_data as any).automation_ids).toContain(created.automation_id);
    // Denied/failed invocations stay category='audit' — never category='config'.
    expect((deniedRow!.metadata as any).category).toBe('audit');
  });

  it.each(['9007199254740992', '900719925474099312345678901234567890', 'raw-id-canary'])('F1 rejects %s from the entire invocation event', async (rejected) => {
    const { recordToolInvocationAudit } = await import('../../../tools/audit');
    expect(() => parsePositiveIntegerId(rejected, 'automation_id')).toThrow();
    const maximum = '9007199254740991';
    expect(parsePositiveIntegerId(maximum, 'automation_id')).toBe(Number.MAX_SAFE_INTEGER);
    for (const args of [
      { action: 'update', automation_id: rejected },
      { action: 'delete', automation_ids: [rejected] },
      { action: 'delete', automation_id: rejected, automation_ids: [rejected, maximum, '42'] },
      { action: rejected, automation_id: maximum },
    ]) {
      const before = (await invocationEvents(orgId)).at(-1)?.id ?? 0;
      await recordToolInvocationAudit({
        toolName: 'manage_automations', args,
        error: new Error(`Rejected ${rejected}`), durationMs: 1,
        ctx: { organizationId: orgId, userId, tokenType: 'session' },
      });
      const sql = getTestDb();
      const rows = await sql`SELECT * FROM events WHERE organization_id = ${orgId}
        AND metadata->>'category' = 'audit' AND id > ${before} ORDER BY id`;
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toContain(rejected);
      const expectedIds = args.automation_ids?.includes(maximum) ? [maximum, '42'] : [];
      const expectedId = args.automation_id === maximum ? maximum : expectedIds[0] ?? null;
      expect(rows[0].payload_data.automation_id).toBe(expectedId);
      expect(rows[0].metadata.automation_id ?? null).toBe(expectedId);
      expect(rows[0].payload_data.automation_ids).toEqual(expectedIds);
      expect(rows[0].metadata.automation_ids ?? []).toEqual(expectedIds);
    }
  });

  it('failed validation emits no config event', async () => {
    const created = (await owner.automations.create({
      slug: 'audit-failed',
      name: 'Audit Failed',
      prompt: 'v1',
      triggers: [],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    const beforeCount = (await configEvents(orgId, created.automation_id)).length;
    await expect(
      owner.automations.update({ automation_id: created.automation_id, prompt: 'v2' } as any)
    ).rejects.toThrow();
    const rows = await configEvents(orgId, created.automation_id);
    expect(rows.length).toBe(beforeCount);
  });

  it('approval apply carries requester + approval run, not only approver', async () => {
    const { insertToolConfigChange } = await import('../../../tools/admin/helpers/config-audit');
    const { getTestDb: getDb } = await import('../../setup/test-db');
    const sql = getDb();
    // created_by is FK-bound to users.id — use a real approver user, not a
    // literal, so the insert exercises the real path instead of tripping FK.
    const approver = await createTestUser({ email: 'audit3664-approver@test.com' });
    await addUserToOrganization(approver.id, orgId, 'owner');
    const approverCtx = {
      organizationId: orgId,
      userId: approver.id,
      memberRole: 'owner',
      agentId: null,
      isAuthenticated: true,
      clientId: null,
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      tokenType: 'session',
      scopedToOrg: true,
      allowCrossOrg: false,
      approvalRunId: 999,
      approvalRequesterId: userId,
      approvalApproverId: approver.id,
    } as any;
    await insertToolConfigChange(approverCtx, {
      organizationId: orgId,
      resourceKind: 'automation',
      resourceId: '12345',
      op: 'updated',
      action: 'update',
      summary: 'approval apply test',
      before: { agent_kind: null },
      state: { agent_kind: 'codex' },
      changedFields: ['agent_kind'],
    }, sql);
    const rows = await configEvents(orgId, '12345');
    expect(rows.length).toBe(1);
    expect(rows[0].metadata.requested_by).toBe(userId);
    expect(rows[0].metadata.approved_by).toBe(approver.id);
    expect(rows[0].metadata.approval_run_id).toBe('999');
  });

  it('approval queue apply stamps requester + approval run on the config event', async () => {
    const created = (await owner.automations.create({
      slug: 'audit-approval-queue',
      name: 'Audit Approval Queue',
      prompt: 'queue me',
      triggers: [],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    const baseCtx = (boundAgentId: string | null, asUserId: string): AuthContext => ({
      organizationId: orgId,
      tokenOrganizationId: orgId,
      userId: asUserId,
      memberRole: 'owner',
      agentId: boundAgentId,
      requestedAgentId: boundAgentId,
      isAuthenticated: true,
      clientId: null,
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      tokenType: 'oauth',
      requestUrl: `http://localhost/api/${orgId}`,
      baseUrl: '',
      scopedToOrg: true,
      allowCrossOrg: false,
    });
    const agentCtx = baseCtx(agentId, userId);
    agentCtx.mcpSessionId = 'session-approval-3664';
    const pending = (await executeTool(
      'manage_automations',
      { action: 'update', automation_id: created.automation_id, tags: ['queued-tag'] },
      TEST_ENV,
      agentCtx
    )) as { status: string; run_id: number };
    expect(pending.status).toBe('pending_approval');
    const approveRes = (await executeTool(
      'manage_operations',
      { action: 'approve', run_id: pending.run_id },
      TEST_ENV,
      baseCtx(null, userId)
    )) as { approved?: true };
    expect(approveRes.approved).toBe(true);
    const rows = await configEvents(orgId, created.automation_id);
    const applied = rows.filter((r) => r.metadata.action === 'update');
    expect(applied.length).toBeGreaterThan(0);
    const last = applied[applied.length - 1];
    expect(last.metadata.requested_by).toBe(userId);
    expect(last.metadata.approved_by).toBe(userId);
    expect(String(last.metadata.approval_run_id)).toBe(String(pending.run_id));
    expect(last.payload_data.state.tags).toContain('queued-tag');
  });

  it('system auto-pause and reset emit system-attributed changes', async () => {
    const created = (await owner.automations.create({
      slug: 'audit-autopause',
      name: 'Audit Autopause',
      prompt: 'cron job',
      triggers: [{ kind: 'schedule', cron: '* * * * *' }],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    const sql = getTestDb();
    const beforeCount = (await configEvents(orgId, created.automation_id)).length;
    // Force threshold to 1 so one failure pauses.
    process.env.AUTOMATION_PAUSE_AFTER_CONSECUTIVE_FAILURES = '1';
    await recordScheduledExecutionFailure(sql, Number(created.automation_id), 'scheduled');
    let rows = await configEvents(orgId, created.automation_id);
    expect(rows.length).toBeGreaterThan(beforeCount);
    const pause = rows[rows.length - 1];
    expect(pause.metadata.action).toBe('auto_pause');
    expect(pause.metadata.actor_source).toBe('agent');
    expect(pause.metadata.token_type).toBe('system');
    expect(pause.created_by).toBeNull();
    await resetScheduledFailureState(sql, Number(created.automation_id));
    rows = await configEvents(orgId, created.automation_id);
    expect(rows[rows.length - 1].metadata.action).toBe('cadence_reset');
    expect(rows[rows.length - 1].metadata.token_type).toBe('system');
    delete process.env.AUTOMATION_PAUSE_AFTER_CONSECUTIVE_FAILURES;
  });
});
