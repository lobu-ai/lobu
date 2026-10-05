import { beforeEach, describe, expect, it } from 'vitest';
import { deviceSourceAttributionForRun, requestSourceAttribution } from '../../worker-api/device-source-attribution';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { TestWorkspace } from '../setup/test-mcp-client';

describe('device source attribution', () => {
  beforeEach(cleanupTestDatabase);

  it('takes requester IDs only from authenticated context', () => {
    expect(requestSourceAttribution({ isAuthenticated: true, tokenType: 'oauth', agentId: 'synthetic-agent', clientId: 'synthetic-client' }))
      .toEqual({ agent_id: 'synthetic-agent', client_id: 'synthetic-client' });
    expect(requestSourceAttribution({ isAuthenticated: false, tokenType: 'oauth', agentId: 'forged', clientId: 'forged' })).toEqual({});
    expect(requestSourceAttribution({ isAuthenticated: true, tokenType: 'session', clientId: 'not-an-oauth-client' })).toEqual({});
  });

  async function fixture(metadata: Record<string, unknown> = {}) {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Synthetic attribution workspace' });
    await sql`INSERT INTO agents (id, organization_id, name)
      VALUES ('synthetic-requester', ${workspace.org.id}, 'Research agent')`;
    await sql`INSERT INTO oauth_clients (id, client_name, redirect_uris)
      VALUES ('synthetic-client', 'Registered MCP client', ARRAY['https://client.example/callback'])`;
    const [device] = await sql`INSERT INTO device_workers (user_id, worker_id, platform, label, organization_id)
      VALUES (${workspace.users.owner.id}, 'synthetic-execution-worker', 'macos', 'Office Mac', ${workspace.org.id}) RETURNING id`;
    const [run] = await sql`INSERT INTO runs (organization_id, run_type, action_key, action_input, run_metadata, executed_by_device_worker_id)
      VALUES (${workspace.org.id}, 'action', 'observe',
        ${sql.json({ source_attribution: { agent_name: 'Impersonated owner', client_name: 'Fake client' } })},
        ${sql.json(metadata)}, ${device.id}::uuid) RETURNING id`;
    return { sql, workspace, deviceId: String(device.id), runId: Number(run.id) };
  }

  it('resolves registered names and the actual execution device without trusting action input', async () => {
    const f = await fixture({ source_attribution: { agent_id: 'synthetic-requester', client_id: 'synthetic-client' } });
    const result = await deviceSourceAttributionForRun(f.sql, f.runId, f.workspace.org.id, f.deviceId);
    expect(result).toMatchObject({ agent_id: 'synthetic-requester', agent_name: 'Research agent', client_name: 'Registered MCP client', device_label: 'Office Mac', device_platform: 'macos' });
    expect(JSON.stringify(result)).not.toContain('Impersonated');
    expect(JSON.stringify(result)).not.toContain('Fake client');
  });

  it('does not turn a target device into a requester when origin is missing', async () => {
    const f = await fixture();
    expect(await deviceSourceAttributionForRun(f.sql, f.runId, f.workspace.org.id, f.deviceId))
      .toMatchObject({ agent_id: null, client_id: null, device_label: 'Office Mac' });
  });

  it('resolves Automation and policy-principal agents when no direct requester was recorded', async () => {
    const f = await fixture();
    const [automation] = await f.sql`INSERT INTO automations (
      organization_id, managed_agent_id, created_by, automation_group_id, name
    ) VALUES (${f.workspace.org.id}, 'synthetic-requester', ${f.workspace.users.owner.id}, 0, 'Synthetic nightly report') RETURNING id`;
    await f.sql`UPDATE runs SET automation_id = ${automation.id} WHERE id = ${f.runId}`;
    expect(await deviceSourceAttributionForRun(f.sql, f.runId, f.workspace.org.id, f.deviceId))
      .toMatchObject({ automation_name: 'Synthetic nightly report', agent_id: 'synthetic-requester', agent_name: 'Research agent', client_id: null });
    await f.sql`UPDATE runs SET automation_id = NULL, policy_principal_kind = 'agent', policy_principal_id = 'synthetic-requester' WHERE id = ${f.runId}`;
    expect(await deviceSourceAttributionForRun(f.sql, f.runId, f.workspace.org.id, f.deviceId))
      .toMatchObject({ automation_name: null, agent_id: 'synthetic-requester', agent_name: 'Research agent' });
  });

  it('shows a claimed personal device executing in a team org, but never another poller', async () => {
    const f = await fixture();
    const personal = await TestWorkspace.create({ name: 'Synthetic personal workspace' });
    await f.sql`UPDATE device_workers SET organization_id = ${personal.org.id} WHERE id = ${f.deviceId}::uuid`;
    expect((await deviceSourceAttributionForRun(f.sql, f.runId, f.workspace.org.id, f.deviceId))?.device_label).toBe('Office Mac');
    expect((await deviceSourceAttributionForRun(f.sql, f.runId, f.workspace.org.id, '00000000-0000-4000-8000-000000000001'))?.device_label).toBeNull();
  });

  it('scopes both the run and its agent lookup to the organization', async () => {
    const f = await fixture({ source_attribution: { agent_id: 'synthetic-foreign-agent' } });
    const other = await TestWorkspace.create({ name: 'Other synthetic workspace' });
    await f.sql`INSERT INTO agents (id, organization_id, name)
      VALUES ('synthetic-foreign-agent', ${other.org.id}, 'Private other agent')`;
    expect((await deviceSourceAttributionForRun(f.sql, f.runId, f.workspace.org.id, f.deviceId))?.agent_name).toBeNull();
    expect(await deviceSourceAttributionForRun(f.sql, f.runId, other.org.id, f.deviceId)).toBeUndefined();
  });
});
