import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../index';
import { mutationPrincipalId, resolveActingPrincipal, upsertEntityApprovalPolicy } from '../../authz/entity-policy';
import { CONNECTOR_PARENT_RUN_METADATA_KEY } from '../../authz/operation-run-policy';
import { createAutomationRun } from '../../runs/queue-service';
import {
  dispatchChromeAction,
  dispatchChromeActionToExtension,
  TARGET_BROWSER_CONNECTION_INPUT_KEY,
} from '../../worker-api/dispatch-chrome-action';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestConnectorDefinition,
  createTestConnection,
  createTestOrganization,
  createTestUser,
} from '../setup/test-fixtures';

const sql = getTestDb();
const app = new Hono<{ Bindings: Env }>();
app.post('/dispatch', dispatchChromeAction);

/** Exercise browser delegation from a real public operation with durable requester identity. */
async function seedParentAuthority(organizationId: string, runId: number) {
  const connectorKey = 'browser-parent-fixture';
  await createTestConnectorDefinition({ key: connectorKey, name: 'Browser parent fixture', organization_id: organizationId });
  await sql`UPDATE connector_definitions SET browser = ${sql.json({ origins: ['https://example.com', 'https://www.linkedin.com', 'https://x.com'] })}, actions_schema = ${sql.json({
    prepare_reply: { name: 'Prepare reply', kind: 'write' },
    prepare_comment: { name: 'Prepare comment', kind: 'write' },
  })} WHERE organization_id = ${organizationId} AND key = ${connectorKey}`;
  await sql`UPDATE connector_definitions SET actions_schema = ${sql.json({ navigate: { name: 'Navigate', kind: 'write' } })}
    WHERE organization_id = ${organizationId} AND key = 'chrome'`;
  const connection = await createTestConnection({ organization_id: organizationId, connector_key: connectorKey, createDefaultFeed: false });
  const [run] = await sql`SELECT created_by_user_id, automation_id FROM runs WHERE id = ${runId}`;
  let [browser] = await sql`SELECT dw.id FROM device_workers dw JOIN connections c ON c.device_worker_id = dw.id
    WHERE c.organization_id = ${organizationId} AND dw.organization_id = ${organizationId} AND c.connector_key = 'chrome' LIMIT 1`;
  if (!browser) {
    const owner = await createTestUser({ email: `browser-fixture-${runId}@example.test` });
    [browser] = await sql`INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id, last_seen_at)
      VALUES (${owner.id}, ${`fixture-browser-${runId}`}, 'chrome-extension', '["browser.debugger"]'::jsonb, ${organizationId}, now() - interval '1 day') RETURNING id`;
  }
  await sql`UPDATE connections SET device_worker_id = ${browser.id}::uuid WHERE id = ${connection.id}`;
  await sql`UPDATE device_workers SET app_version = '9.9.0' WHERE id = ${browser.id}::uuid`;
  const actor = await resolveActingPrincipal(sql, { organizationId, userId: run.created_by_user_id, sessionAutomationId: run.automation_id });
  await sql`UPDATE runs SET connection_id = ${connection.id}, connector_key = ${connectorKey},
    policy_principal_kind = ${actor.kind}, policy_principal_id = ${actor.id} WHERE id = ${runId}`;
  await upsertEntityApprovalPolicy(organizationId, { resourceClass: 'connector_action', connectorKey, effects: { execute: 'auto' } });
}

describe('dispatchChromeAction parent run authorization', () => {
  beforeEach(cleanupTestDatabase);
  afterAll(cleanupTestDatabase);

  it('accepts a claimed connector action parent', async () => {
    const org = await createTestOrganization({ name: 'Chrome action parent' });
    const [run] = (await sql`
      INSERT INTO runs (
        organization_id, run_type, action_key, status, claimed_by, claimed_at
      ) VALUES (
        ${org.id}, 'action', 'prepare_comment', 'running', 'connector-worker-1', NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    await seedParentAuthority(org.id, Number(run.id));

    const response = await app.request('/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent_run_id: Number(run.id),
        worker_id: 'connector-worker-1',
        action_key: 'navigate',
        action_input: { url: 'https://www.linkedin.com/' },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'failed',
      error_message: expect.stringMatching(
        /^\[lobu:dependency_unavailable:browser_offline\].*Chrome extension selected/,
      ),
    });
  });

  it('returns the existing not-found result for an invalid parent id', async () => {
    const org = await createTestOrganization({ name: 'Invalid Chrome parent' });

    await expect(
      dispatchChromeActionToExtension({
        organizationId: org.id,
        actionKey: 'navigate',
        actionInput: { url: 'https://example.com/' },
        parentRunId: -1,
      })
    ).resolves.toEqual({
      status: 'failed',
      error_message: 'Parent run -1 was not found in this organization.',
    });
  });

  it('inherits trusted context and changes Chrome flow ownership to the parent run', async () => {
    const org = await createTestOrganization({ name: 'Chrome context parent' });
    const user = await createTestUser({ email: 'chrome-context-parent@test.com' });
    await addUserToOrganization(user.id, org.id);
    await createTestConnectorDefinition({
      key: 'chrome',
      name: 'Chrome',
      organization_id: org.id,
    });
    const [worker] = await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id, last_seen_at
      ) VALUES (
        ${user.id}, 'ext-context-parent', 'chrome-extension',
        ${sql.json(['browser.tabs', 'browser.debugger'])}, 'Context Browser',
        ${org.id}, NOW()
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        created_by, visibility, device_worker_id, created_at, updated_at
      ) VALUES (
        ${org.id}, 'chrome', 'chrome-context-parent', 'Chrome', 'active',
        ${user.id}, 'org', ${worker.id}::uuid, NOW(), NOW()
      )
    `;
    const [parent] = await sql`
      INSERT INTO runs (
        organization_id, run_type, action_key, action_input, status,
        claimed_by, claimed_at, created_by_user_id, run_metadata
      ) VALUES (
        ${org.id}, 'action', 'prepare_comment', '{}'::jsonb, 'running',
        'connector-worker-context', NOW(), ${user.id},
        ${sql.json({
          unrelated: 'preserved',
          browser_context: {
            id: 'automation:700',
            title: 'Owletto · Automation 700',
            flow_id: 'run:700',
            kind: 'automation',
          },
        })}
      )
      RETURNING id
    `;
    const parentRunId = Number(parent.id);
    await seedParentAuthority(org.id, parentRunId);

    const responsePromise = app.request('/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent_run_id: parentRunId,
        worker_id: 'connector-worker-context',
        action_key: 'navigate',
        action_input: {
          url: 'https://example.com/',
          normal: 'kept',
          browser_context_id: 'forged-context',
          browser_context_title: 'forged title',
          browser_flow_id: 'forged-flow',
          holder_run_id: 123,
          parent_run_id: 456,
        },
      }),
    });

    await vi.waitFor(async () => {
      const children = await sql`
        SELECT id, action_input, run_metadata, policy_principal_kind, policy_principal_id
        FROM runs
        WHERE organization_id = ${org.id}
          AND connector_key = 'chrome'
          AND parent_run_id = ${parentRunId}
        ORDER BY id DESC
        LIMIT 1
      `;
      expect(children).toHaveLength(1);
      const child = children[0];
      expect(child.policy_principal_kind).toBe('user');
      expect(child.policy_principal_id).toBeNull();
      expect(child.action_input).toEqual({
        url: 'https://example.com/',
        normal: 'kept',
        allowed_origins: ['https://example.com', 'https://www.linkedin.com', 'https://x.com'],
      });
      expect(child.run_metadata).toEqual({
        [CONNECTOR_PARENT_RUN_METADATA_KEY]: parentRunId,
        // The parent was stored with the retired `id`; the child is not.
        browser_context: {
          title: 'Owletto · Automation 700',
          flow_id: String(parentRunId),
          kind: 'automation',
        },
      });
      await sql`
        UPDATE runs
        SET status = 'completed', action_output = '{}'::jsonb, completed_at = NOW()
        WHERE id = ${child.id}
      `;
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'completed' });
  });
});

/**
 * `target_browser_connection_id` lets an interactive action name the browser
 * its draft must appear in; it must match the parent connection's bound
 * browser. It is a routing directive with real blast radius: pointed at the wrong
 * connection it stages a draft in someone else's signed-in browser, so it
 * must resolve inside both the caller's org and connection-visibility scope,
 * then fail rather than fall back. (The built-in social connectors moved to
 * page activation and no longer stamp it; connectors that do must declare
 * their own copy of the key, since compiled connector code cannot import
 * from the server.)
 */
describe('dispatchChromeAction target browser routing', () => {
  beforeEach(cleanupTestDatabase);
  afterAll(cleanupTestDatabase);

  it('uses the wire key a connector must stamp', () => {
    expect(TARGET_BROWSER_CONNECTION_INPUT_KEY).toBe(
      'target_browser_connection_id'
    );
  });

  async function seedParentRun(
    orgId: string,
    createdByUserId?: string,
    automationId?: number,
    parentRunId?: number
  ): Promise<number> {
    const [run] = (await sql`
      INSERT INTO runs (
        organization_id, run_type, action_key, status, claimed_by, claimed_at,
        created_by_user_id, automation_id, parent_run_id
      ) VALUES (
        ${orgId}, 'action', 'prepare_reply', 'running', 'connector-worker-1', NOW(),
        ${createdByUserId ?? null}, ${automationId ?? null}, ${parentRunId ?? null}
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    await seedParentAuthority(orgId, Number(run.id));
    return Number(run.id);
  }

  async function dispatchWithTarget(
    runId: number,
    target: unknown
  ): Promise<{ status: string; error_message?: string }> {
    const response = await app.request('/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent_run_id: runId,
        worker_id: 'connector-worker-1',
        action_key: 'navigate',
        action_input: {
          url: 'https://x.com/i/web/status/2083959735481716957',
          [TARGET_BROWSER_CONNECTION_INPUT_KEY]: target,
        },
      }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { status: string; error_message?: string };
  }

  it('rejects a target that is not a connection id instead of picking a browser', async () => {
    const org = await createTestOrganization({ name: 'Target browser garbage' });
    const runId = await seedParentRun(org.id);

    for (const bad of ['macbook', '432', 0, -3, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const body = await dispatchWithTarget(runId, bad);
      expect(body.status).toBe('failed');
      expect(body.error_message).toContain(
        'must be a positive integer chrome connection id'
      );
    }
  });

  it('refuses a chrome connection owned by another organization', async () => {
    const other = await createTestOrganization({ name: 'Other org' });
    const user = await createTestUser({ email: 'other-org-chrome@test.com' });
    const [worker] = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id, last_seen_at
      ) VALUES (
        ${user.id}, 'ext-other-org', 'chrome-extension',
        ${sql.json(['browser.tabs', 'browser.debugger'])}, 'Other Ext',
        ${other.id}, NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const [conn] = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        created_by, visibility, device_worker_id, created_at, updated_at
      ) VALUES (
        ${other.id}, 'chrome', 'chrome-other', 'Chrome', 'active',
        ${user.id}, 'private', ${worker.id}::uuid, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    const caller = await createTestOrganization({ name: 'Calling org' });
    const runId = await seedParentRun(caller.id);

    const body = await dispatchWithTarget(runId, Number(conn.id));
    // Not "offline", and above all not a silent fall back to some other
    // browser — the connection is simply not visible from this org.
    expect(body.status).toBe('failed');
    expect(body.error_message).toContain(
      'is not an active chrome connection paired to a browser in this organization'
    );
  });

  it("refuses another member's private chrome connection in the same organization", async () => {
    const org = await createTestOrganization({ name: 'Private browser boundary' });
    const caller = await createTestUser({ email: 'private-browser-caller@test.com' });
    const owner = await createTestUser({ email: 'private-browser-owner@test.com' });
    await addUserToOrganization(caller.id, org.id);
    await addUserToOrganization(owner.id, org.id);

    const [worker] = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id, last_seen_at
      ) VALUES (
        ${owner.id}, 'ext-private-owner', 'chrome-extension',
        ${sql.json(['browser.tabs', 'browser.debugger'])}, 'Owner Ext',
        ${org.id}, NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const [conn] = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        created_by, visibility, device_worker_id, created_at, updated_at
      ) VALUES (
        ${org.id}, 'chrome', 'chrome-private-owner', 'Chrome', 'active',
        ${owner.id}, 'private', ${worker.id}::uuid, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const runId = await seedParentRun(org.id, caller.id);

    const body = await dispatchWithTarget(runId, Number(conn.id));
    expect(body.status).toBe('failed');
    expect(body.error_message).toContain(
      'is not an active chrome connection paired to a browser in this organization'
    );
  });

  it("accepts the requester's private chrome connection", async () => {
    const org = await createTestOrganization({ name: 'Private browser owner' });
    const caller = await createTestUser({ email: 'private-browser-owner@test.com' });
    await addUserToOrganization(caller.id, org.id);

    const [worker] = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id, last_seen_at
      ) VALUES (
        ${caller.id}, 'ext-private-caller', 'chrome-extension',
        ${sql.json(['browser.tabs', 'browser.debugger'])}, 'Caller Ext',
        ${org.id}, NOW() - INTERVAL '1 day'
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const [conn] = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        created_by, visibility, device_worker_id, created_at, updated_at
      ) VALUES (
        ${org.id}, 'chrome', 'chrome-private-caller', 'Chrome', 'active',
        ${caller.id}, 'private', ${worker.id}::uuid, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const runId = await seedParentRun(org.id, caller.id);

    const body = await dispatchWithTarget(runId, Number(conn.id));
    expect(body.status).toBe('failed');
    expect(body.error_message).toMatch(
      /^\[lobu:dependency_unavailable:browser_offline\].*The browser this action is set to open in is offline/
    );
  });

  it("accepts an Automation creator's private chrome connection", async () => {
    const org = await createTestOrganization({ name: 'Automation private browser' });
    await createTestConnectorDefinition({
      key: 'chrome',
      name: 'Chrome',
      organization_id: org.id,
    });
    const creator = await createTestUser({ email: 'automation-browser@test.com' });
    await addUserToOrganization(creator.id, org.id);
    const agent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: creator.id,
    });
    const [automation] = await sql`
      WITH next_id AS (SELECT nextval('automations_id_seq')::integer AS id)
      INSERT INTO automations (
        id, automation_group_id, organization_id, managed_agent_id, created_by, name, slug
      )
      SELECT id, id, ${org.id}, ${agent.agentId}, ${creator.id},
        'Private browser automation', 'private-browser-automation'
      FROM next_id
      RETURNING id
    `;
    const sourceRun = await createAutomationRun({
      organizationId: org.id,
      automationId: Number(automation.id),
      agentId: agent.agentId,
      windowStart: '2026-08-10T00:00:00.000Z',
      windowEnd: '2026-08-10T01:00:00.000Z',
      dispatchSource: 'manual',
    }, sql);
    const [worker] = await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id, last_seen_at
      ) VALUES (
        ${creator.id}, 'ext-automation-browser', 'chrome-extension',
        ${sql.json(['browser.tabs', 'browser.debugger'])}, 'Automation Browser',
        ${org.id}, NOW()
      )
      RETURNING id
    `;
    const [conn] = await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        created_by, visibility, device_worker_id, created_at, updated_at
      ) VALUES (
        ${org.id}, 'chrome', 'chrome-automation-private', 'Chrome', 'active',
        ${creator.id}, 'private', ${worker.id}::uuid, NOW(), NOW()
      )
      RETURNING id
    `;
    const runId = await seedParentRun(
      org.id,
      undefined,
      Number(automation.id),
      sourceRun.runId
    );

    const responsePromise = app.request('/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent_run_id: runId,
        worker_id: 'connector-worker-1',
        action_key: 'navigate',
        action_input: {
          url: 'https://x.com/i/web/status/2083959735481716957',
          [TARGET_BROWSER_CONNECTION_INPUT_KEY]: Number(conn.id),
        },
      }),
    });

    await vi.waitFor(async () => {
      const childRows = await sql`
        SELECT id, created_by_user_id, automation_id, parent_run_id, policy_principal_kind, policy_principal_id
        FROM runs
        WHERE organization_id = ${org.id}
          AND connector_key = 'chrome'
          AND id <> ${runId}
        ORDER BY id DESC
        LIMIT 1
      `;
      expect(childRows).toHaveLength(1);
      const child = childRows[0];
      expect(child.created_by_user_id).toBeNull();
      expect(Number(child.automation_id)).toBe(Number(automation.id));
      expect(Number(child.parent_run_id)).toBe(runId);
      expect(child.policy_principal_kind).toBe('automation');
      expect(child.policy_principal_id).toBe(mutationPrincipalId({ automationId: Number(automation.id) }));
      await sql`
        UPDATE runs
        SET status = 'completed', action_output = '{}'::jsonb, completed_at = NOW()
        WHERE id = ${child.id}
      `;
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'completed' });
  });

  it("refuses the requester's connection when pinned to another member's browser", async () => {
    const org = await createTestOrganization({ name: 'Mismatched browser owner' });
    const caller = await createTestUser({ email: 'mismatched-connection-owner@test.com' });
    const deviceOwner = await createTestUser({ email: 'mismatched-device-owner@test.com' });
    await addUserToOrganization(caller.id, org.id);
    await addUserToOrganization(deviceOwner.id, org.id);

    const [worker] = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id, last_seen_at
      ) VALUES (
        ${deviceOwner.id}, 'ext-mismatched-owner', 'chrome-extension',
        ${sql.json(['browser.tabs', 'browser.debugger'])}, 'Other Member Ext',
        ${org.id}, NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const [conn] = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        created_by, visibility, device_worker_id, created_at, updated_at
      ) VALUES (
        ${org.id}, 'chrome', 'chrome-mismatched-owner', 'Chrome', 'active',
        ${caller.id}, 'private', ${worker.id}::uuid, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const runId = await seedParentRun(org.id, caller.id);

    const body = await dispatchWithTarget(runId, Number(conn.id));
    expect(body.status).toBe('failed');
    expect(body.error_message).toContain(
      'is not an active chrome connection paired to a browser in this organization'
    );
  });

  it('refuses a same-org connection pinned to another org’s browser', async () => {
    // The connection passes the org check; its pin does not. Without the
    // organization_id equality on the join this resolves to a device worker in
    // a different tenant and stages the draft in that browser.
    const org = await createTestOrganization({ name: 'Caller with foreign pin' });
    const foreign = await createTestOrganization({ name: 'Foreign browser org' });
    const user = await createTestUser({ email: 'foreign-pin@test.com' });
    const [worker] = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id, last_seen_at
      ) VALUES (
        ${user.id}, 'ext-foreign-pin', 'chrome-extension',
        ${sql.json(['browser.tabs', 'browser.debugger'])}, 'Foreign Ext',
        ${foreign.id}, NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const [conn] = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        created_by, visibility, device_worker_id, created_at, updated_at
      ) VALUES (
        ${org.id}, 'chrome', 'chrome-foreign-pin', 'Chrome', 'active',
        ${user.id}, 'org', ${worker.id}::uuid, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const runId = await seedParentRun(org.id);

    const body = await dispatchWithTarget(runId, Number(conn.id));
    expect(body.status).toBe('failed');
    expect(body.error_message).toContain(
      'is not an active chrome connection paired to a browser in this organization'
    );
  });

  it('refuses a connection id that is not a chrome connection', async () => {
    const org = await createTestOrganization({ name: 'Non-chrome target' });
    const user = await createTestUser({ email: 'non-chrome@test.com' });
    const [conn] = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        created_by, visibility, created_at, updated_at
      ) VALUES (
        ${org.id}, 'x', 'x-main', 'X', 'active',
        ${user.id}, 'private', NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const runId = await seedParentRun(org.id);

    const body = await dispatchWithTarget(runId, Number(conn.id));
    expect(body.status).toBe('failed');
    expect(body.error_message).toContain(
      'is not an active chrome connection paired to a browser in this organization'
    );
  });
});
