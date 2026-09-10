/**
 * Browser-affinity claim rules (PR #1826):
 *
 * When a connector outside the `chrome` / `chrome.*` native namespace is
 * pinned to a chrome-extension device, that pin means "scrape with this
 * browser", NOT "run the parent sync on the extension". Fleet claims parent
 * sync; the extension must not.
 *
 * Native Chrome connectors execute on the extension when pinned. The narrow
 * legacy-key exception additionally requires the selected run artifact to
 * be the validated Chrome device manifest; the key alone is not placement.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';
import { generateSecureToken } from '../../auth/oauth/utils';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestConnectorDefinition } from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

const DEBUGGER_CAPS = ['browser.tabs', 'browser.scripting', 'browser.debugger'];

async function seedOrg() {
  const sql = getTestDb();
  const userId = `user_${generateSecureToken(4)}`;
  const orgId = `org-aff-${generateSecureToken(4)}`;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, 'Affinity Owner', ${`${userId}@test.local`}, true, NOW(), NOW())
  `;
  await sql`
    INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
    VALUES (
      ${orgId}, 'Affinity Org', ${orgId}, 'private',
      ${sql.json({ personal_org_for_user_id: userId })}, NOW()
    )
  `;
  await sql`
    INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`mem_${generateSecureToken(4)}`}, ${orgId}, ${userId}, 'owner', NOW())
  `;
  return { userId, orgId };
}

async function seedExtWorker(userId: string, orgId: string): Promise<{
  deviceWorkerId: string;
  workerId: string;
}> {
  const sql = getTestDb();
  const workerId = `ext-${generateSecureToken(6)}`;
  const [row] = (await sql`
    INSERT INTO device_workers (
      user_id, worker_id, platform, app_version, capabilities, label, organization_id, last_seen_at
    ) VALUES (
      ${userId}, ${workerId}, 'chrome-extension', '0.1.0',
      ${sql.json(DEBUGGER_CAPS)}, 'Test Ext', ${orgId}, NOW()
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return { deviceWorkerId: String(row.id), workerId };
}

async function seedConnection(opts: {
  orgId: string;
  userId: string;
  connectorKey: string;
  deviceWorkerId: string | null;
}): Promise<number> {
  const sql = getTestDb();
  const slug = `${opts.connectorKey}-${generateSecureToken(4)}`.replace(/\./g, '-');
  const [row] = (await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      created_by, visibility, device_worker_id, created_at, updated_at
    ) VALUES (
      ${opts.orgId}, ${opts.connectorKey}, ${slug}, ${opts.connectorKey}, 'active',
      ${opts.userId}, 'private', ${opts.deviceWorkerId}::uuid, NOW(), NOW()
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function seedPendingSync(opts: {
  orgId: string;
  connectionId: number;
  connectorKey: string;
  connectorVersion?: string | null;
}): Promise<number> {
  const sql = getTestDb();
  const [row] = (await sql`
    INSERT INTO runs (
      organization_id, run_type, connection_id, connector_key,
      connector_version, approval_status, status, created_at
    ) VALUES (
      ${opts.orgId}, 'sync', ${opts.connectionId}, ${opts.connectorKey},
      ${opts.connectorVersion ?? null}, 'auto', 'pending', current_timestamp
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function seedPendingAction(opts: {
  orgId: string;
  connectionId: number;
  connectorKey: string;
  connectorVersion?: string | null;
  expiresAtAgoSeconds?: number | null;
  actionInput?: Record<string, unknown>;
  approvedInput?: Record<string, unknown> | null;
  runMetadata?: Record<string, unknown> | null;
  parentRunId?: number | null;
}): Promise<number> {
  const sql = getTestDb();
  const [row] = (await sql`
    INSERT INTO runs (
      organization_id, run_type, connection_id, connector_key, connector_version,
      action_key, action_input, approved_input, run_metadata,
      approval_status, status, created_at, expires_at, parent_run_id
    ) VALUES (
      ${opts.orgId}, 'action', ${opts.connectionId}, ${opts.connectorKey},
      ${opts.connectorVersion ?? null},
      'open_tab', ${sql.json(opts.actionInput ?? {})},
      ${opts.approvedInput == null ? null : sql.json(opts.approvedInput)},
      ${opts.runMetadata == null ? null : sql.json(opts.runMetadata)},
      'auto', 'pending', current_timestamp,
      ${opts.expiresAtAgoSeconds == null
        ? null
        : sql`current_timestamp - make_interval(secs => ${opts.expiresAtAgoSeconds})`},
      ${opts.parentRunId ?? null}
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function pollExtension(workerId: string, version = '0.6.1') {
  return post('/api/workers/poll', {
    body: {
      worker_id: workerId,
      platform: 'chrome-extension',
      app_version: version,
      label: 'Test Ext',
      capabilities: {
        'browser.tabs': true,
        'browser.scripting': true,
        'browser.debugger': true,
      },
    },
  });
}

async function pollFleet(
  workerId = 'fleet-affinity-worker',
  capabilities: Record<string, boolean> = {},
  capacityAvailable?: number,
) {
  const body: Record<string, unknown> = { worker_id: workerId, capabilities };
  if (capacityAvailable !== undefined) body.capacity_available = capacityAvailable;
  return post('/api/workers/poll', {
    body,
    token: 'test-fleet-token',
    env: { WORKER_API_TOKEN: 'test-fleet-token' },
  });
}

describe('browser-affinity poll claim', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.LOBU_CLOUD_MODE;
    delete process.env.WORKER_API_TOKEN;
  });
  afterEach(async () => {
    await cleanupTestDatabase();
    delete process.env.LOBU_CLOUD_MODE;
    delete process.env.WORKER_API_TOKEN;
  });

  it('fleet claims a LinkedIn sync pinned to a chrome-extension (browser affinity)', async () => {
    const { userId, orgId } = await seedOrg();
    const { deviceWorkerId } = await seedExtWorker(userId, orgId);
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'linkedin',
      deviceWorkerId,
    });
    const runId = await seedPendingSync({
      orgId,
      connectionId: connId,
      connectorKey: 'linkedin',
    });

    const res = await pollFleet('fleet-affinity-worker', {}, 1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run_id?: number;
      skipped_run_id?: number;
      connector_key?: string;
    };
    // Claimed by fleet. Without on-disk linkedin connector sources the poll
    // may fail-after-claim with skipped_run_id — either proves the claim path.
    const claimedId = Number(body.run_id ?? body.skipped_run_id);
    expect(claimedId).toBe(runId);

    const sql = getTestDb();
    const [row] = (await sql`
      SELECT claimed_by FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ claimed_by: string | null }>;
    expect(row.claimed_by).toBe('fleet-affinity-worker');
  });

  it('chrome-extension does NOT claim a LinkedIn sync pinned to itself (affinity, not job host)', async () => {
    const { userId, orgId } = await seedOrg();
    const { deviceWorkerId, workerId } = await seedExtWorker(userId, orgId);
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'linkedin',
      deviceWorkerId,
    });
    const runId = await seedPendingSync({
      orgId,
      connectionId: connId,
      connectorKey: 'linkedin',
    });

    // Warm registration + claim attempt
    const res = await pollExtension(workerId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run_id?: number };
    expect(body.run_id).toBeUndefined();

    const sql = getTestDb();
    const [row] = (await sql`
      SELECT status, claimed_by FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ status: string; claimed_by: string | null }>;
    expect(row.status).toBe('pending');
    expect(row.claimed_by).toBeNull();
  });

  it('chrome-extension still claims a chrome connector sync pinned to itself', async () => {
    const { userId, orgId } = await seedOrg();
    const { deviceWorkerId, workerId } = await seedExtWorker(userId, orgId);
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'chrome',
      deviceWorkerId,
    });
    const runId = await seedPendingSync({
      orgId,
      connectionId: connId,
      connectorKey: 'chrome',
    });

    // Register + claim. chrome may fail-after-claim without compiled sources.
    const res = await pollExtension(workerId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run_id?: number;
      skipped_run_id?: number;
      connector_key?: string;
    };
    const claimedId = Number(body.run_id ?? body.skipped_run_id);
    expect(claimedId).toBe(runId);

    const sql = getTestDb();
    const [row] = (await sql`
      SELECT claimed_by FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ claimed_by: string | null }>;
    expect(row.claimed_by).toBe(workerId);
  });

  it('treats a chrome-prefix lookalike as delegated affinity, not native execution', async () => {
    const { userId, orgId } = await seedOrg();
    const { deviceWorkerId, workerId } = await seedExtWorker(userId, orgId);
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'chromecast.demo',
      deviceWorkerId,
    });
    const runId = await seedPendingSync({
      orgId,
      connectionId: connId,
      connectorKey: 'chromecast.demo',
    });

    const extensionResponse = await pollExtension(workerId);
    expect(extensionResponse.status).toBe(200);
    expect(((await extensionResponse.json()) as { run_id?: number }).run_id).toBeUndefined();

    const fleetResponse = await pollFleet('fleet-chrome-prefix-affinity');
    expect(fleetResponse.status).toBe(200);
    const fleetBody = (await fleetResponse.json()) as {
      run_id?: number;
      skipped_run_id?: number;
    };
    expect(Number(fleetBody.run_id ?? fleetBody.skipped_run_id)).toBe(runId);

    const sql = getTestDb();
    const [row] = (await sql`
      SELECT claimed_by FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ claimed_by: string | null }>;
    expect(row.claimed_by).toBe('fleet-chrome-prefix-affinity');
  });

  it('does not let Chrome capability-claim a hashless manifest artifact without connector_manifests', async () => {
    const { userId, orgId } = await seedOrg();
    const { workerId } = await seedExtWorker(userId, orgId);
    const sql = getTestDb();
    const connectorKey = `test.hashless-chrome-${generateSecureToken(4)}`;
    const connectorVersion = '1.0.0';
    await createTestConnectorDefinition({
      key: connectorKey,
      name: 'Hashless Chrome manifest',
      version: connectorVersion,
      organization_id: orgId,
    });
    await sql`
      UPDATE connector_definitions
      SET required_capability = 'browser.scripting',
          runtime = ${sql.json({ platforms: ['chrome-extension'] })}
      WHERE organization_id = ${orgId}
        AND key = ${connectorKey}
        AND status = 'active'
    `;
    await sql`
      INSERT INTO connector_versions (
        organization_id, connector_key, version, compiled_code, compile_config_hash, created_at
      ) VALUES (
        ${orgId}, ${connectorKey}, ${connectorVersion},
        'module.exports = { sync: async () => ({ items: [] }) }',
        ${COMPILE_CONFIG_HASH}, NOW()
      )
      ON CONFLICT DO NOTHING
    `;
    await sql`
      UPDATE connector_versions
      SET compiled_code = NULL,
          compiled_code_hash = NULL,
          compile_config_hash = NULL,
          source_code = NULL,
          source_path = ${`device-manifest://chrome-extension/${connectorKey}@${connectorVersion}`}
      WHERE connector_key = ${connectorKey}
        AND version = ${connectorVersion}
        AND organization_id = ${orgId}
    `;
    const connectionId = await seedConnection({
      orgId,
      userId,
      connectorKey,
      deviceWorkerId: null,
    });
    const runId = await seedPendingSync({
      orgId,
      connectionId,
      connectorKey,
      connectorVersion,
    });

    // This poll intentionally omits connector_manifests. A legacy capability
    // fallback must never authorize Chrome, even when the selected artifact
    // is hashless and declares the Chrome runtime.
    const response = await pollExtension(workerId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { run_id?: number; skipped_run_id?: number };
    expect(body.run_id).toBeUndefined();
    expect(body.skipped_run_id).toBeUndefined();

    const [run] = (await sql`
      SELECT status, claimed_by FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ status: string; claimed_by: string | null }>;
    expect(run).toEqual({ status: 'pending', claimed_by: null });
  });

  it('fleet does NOT claim a macos-pinned non-browser-affinity sync (no regression)', async () => {
    const sql = getTestDb();
    const { userId, orgId } = await seedOrg();
    const workerId = `mac-${generateSecureToken(6)}`;
    const [mac] = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, app_version, capabilities, label, organization_id, last_seen_at
      ) VALUES (
        ${userId}, ${workerId}, 'macos', '0.1.0',
        ${sql.json(['local_directory'])}, 'Mac', ${orgId}, NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'local.directory',
      deviceWorkerId: String(mac.id),
    });
    const runId = await seedPendingSync({
      orgId,
      connectionId: connId,
      connectorKey: 'local.directory',
    });

    const res = await pollFleet('fleet-no-macos-steal');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run_id?: number };
    expect(body.run_id).toBeUndefined();

    const [row] = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ status: string }>;
    expect(row.status).toBe('pending');
  });

  it('chrome-extension does NOT claim an action run whose expires_at lapsed (ephemeral action horizon)', async () => {
    const { userId, orgId } = await seedOrg();
    const { deviceWorkerId, workerId } = await seedExtWorker(userId, orgId);
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'chrome',
      deviceWorkerId,
    });
    const runId = await seedPendingAction({
      orgId,
      connectionId: connId,
      connectorKey: 'chrome',
      expiresAtAgoSeconds: 60,
    });

    // Warm registration + claim attempt. The run is pending + auto-approved and
    // would otherwise match this device's claim branches — but its claim
    // horizon lapsed, so the poll must leave it untouched.
    const res = await pollExtension(workerId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run_id?: number };
    expect(body.run_id).toBeUndefined();

    const sql = getTestDb();
    const [row] = (await sql`
      SELECT status, claimed_by FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ status: string; claimed_by: string | null }>;
    expect(row.status).toBe('pending');
    expect(row.claimed_by).toBeNull();
  });

  it('chrome-extension still claims an action run with a live expires_at', async () => {
    const { userId, orgId } = await seedOrg();
    const { deviceWorkerId, workerId } = await seedExtWorker(userId, orgId);
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'chrome',
      deviceWorkerId,
    });
    const runId = await seedPendingAction({
      orgId,
      connectionId: connId,
      connectorKey: 'chrome',
      // expires_at in the future → claimable
      expiresAtAgoSeconds: -60,
    });

    const res = await pollExtension(workerId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run_id?: number;
      skipped_run_id?: number;
    };
    // chrome may fail-after-claim without compiled sources — either proves the
    // claim path reached this run.
    const claimedId = Number(body.run_id ?? body.skipped_run_id);
    expect(claimedId).toBe(runId);

    const sql = getTestDb();
    const [row] = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ status: string }>;
    expect(row.status).not.toBe('pending');
  });

  it('injects trusted Chrome grouping after selecting approved input', async () => {
    const { userId, orgId } = await seedOrg();
    await createTestConnectorDefinition({
      key: 'chrome',
      name: 'Chrome',
      organization_id: orgId,
    });
    const sql = getTestDb();
    await sql`
      UPDATE connector_versions
      SET compiled_code = 'export class ConnectorRuntime {}',
          compile_config_hash = ${COMPILE_CONFIG_HASH}
      WHERE connector_key = 'chrome'
    `;
    const { deviceWorkerId, workerId } = await seedExtWorker(userId, orgId);
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'chrome',
      deviceWorkerId,
    });
    const runId = await seedPendingAction({
      orgId,
      connectionId: connId,
      connectorKey: 'chrome',
      connectorVersion: '1.0.0',
      actionInput: {
        url: 'https://forged.example/input',
        browser_context_id: 'forged-context-input',
        browser_context_title: 'forged-title-input',
        browser_flow_id: 'forged-flow-input',
        holder_run_id: 111,
        parent_run_id: 222,
      },
      approvedInput: {
        url: 'https://approved.example/path',
        normal: 'preserved',
        browser_context_id: 'forged-context-approved',
        browser_context_title: 'forged-title-approved',
        browser_flow_id: 'forged-flow-approved',
        holder_run_id: 333,
        parent_run_id: 444,
      },
      runMetadata: {
        unrelated: { keep: true },
        browser_context: {
          id: 'conversation:abc123def456',
          title: 'Owletto · Conversation abc123def456',
          flow_id: 'conversation:abc123def456',
          kind: 'conversation',
        },
      },
      expiresAtAgoSeconds: -60,
    });

    const res = await pollExtension(workerId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run_id?: number;
      action_input?: Record<string, unknown>;
      run_metadata?: unknown;
    };
    expect(body.run_id).toBe(runId);
    expect(body.action_input).toEqual({
      url: 'https://approved.example/path',
      normal: 'preserved',
      browser_context_id: 'conversation:abc123def456',
      browser_context_title: 'Owletto · Conversation abc123def456',
      browser_flow_id: 'conversation:abc123def456',
    });
    expect(body.action_input).not.toHaveProperty('holder_run_id');
    expect(body).not.toHaveProperty('run_metadata');
  });

  // END-TO-END for page activation. x.prepare_reply navigates with
  // require_page_activation, which the server answers itself — it never reaches
  // the extension. Every mutating call AFTER that does, carrying a tab the user
  // owns: no lease, no site entry, no container. The extension's ownership guard
  // therefore refuses it unless the server hands down which tab the human
  // opened. This asserts the whole seam, because the two halves passing
  // separately is exactly how the regression shipped.
  it('hands a page-activated parent tab down to the extension, ignoring forgery', async () => {
    const { userId, orgId } = await seedOrg();
    await createTestConnectorDefinition({
      key: 'chrome',
      name: 'Chrome',
      organization_id: orgId,
    });
    const sql = getTestDb();
    await sql`
      UPDATE connector_versions
      SET compiled_code = 'export class ConnectorRuntime {}',
          compile_config_hash = ${COMPILE_CONFIG_HASH}
      WHERE connector_key = 'chrome'
    `;
    const { deviceWorkerId, workerId } = await seedExtWorker(userId, orgId);
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'chrome',
      deviceWorkerId,
    });

    // The parent: a draft the human activated by visiting the page. Tab 23 is
    // the user's own tab, recorded when they opened it.
    const [parent] = (await sql`
      INSERT INTO runs (
        organization_id, run_type, connection_id, connector_key, action_key,
        action_input, approval_status, status, created_at, expires_at,
        activation_kind, activation_target_urls, activated_at,
        activated_by_device_worker_id, activation_tab_id, created_by_user_id, run_metadata
      ) VALUES (
        ${orgId}, 'action', ${connId}, 'chrome', 'prepare_reply',
        ${sql.json({ body: 'draft' })}, 'auto', 'running',
        current_timestamp, current_timestamp + interval '1 day',
        'page_visit', ARRAY['https://x.example/status/1', 'https://x.example/status/2']::text[],
        current_timestamp, ${deviceWorkerId}::uuid, 23, ${userId}, ${sql.json({ page_activation_identity: 'exact', page_activation_url: 'https://x.example/status/1' })}
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    // The child: the mutating step. It forges the ownership fields, including
    // the activation tab, which is precisely why the gateway strips them.
    const runId = await seedPendingAction({
      orgId,
      connectionId: connId,
      connectorKey: 'chrome',
      connectorVersion: '1.0.0',
      parentRunId: Number(parent.id),
      actionInput: {
        tab_id: 23,
        expression: '1',
        activation_tab_id: 9999,
        activation_target_urls: ['https://forged.example/'],
        browser_flow_id: 'forged-flow',
      },
      expiresAtAgoSeconds: -60,
    });

    const oldClient = await pollExtension(workerId, '0.6.0');
    expect((await oldClient.json()).run_id).toBeUndefined();
    const res = await pollExtension(workerId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run_id?: number;
      action_input?: Record<string, unknown>;
    };
    expect(body.run_id).toBe(runId);
    // The server's resolution reached the worker, so the guard can authorize
    // the one tab the human opened...
    expect(body.action_input?.activation_tab_id).toBe(23);
    expect(body.action_input?.activation_target_urls).toEqual(['https://x.example/status/1']);
    // ...and neither forged field survived.
    expect(body.action_input?.browser_flow_id).not.toBe('forged-flow');
  });

  // A child whose parent was never page-activated must carry no stamp at all —
  // otherwise the field becomes a way to launder any tab into user-owned
  // authority.
  it('sends no activation stamp when the parent was never activated', async () => {
    const { userId, orgId } = await seedOrg();
    await createTestConnectorDefinition({
      key: 'chrome',
      name: 'Chrome',
      organization_id: orgId,
    });
    const sql = getTestDb();
    await sql`
      UPDATE connector_versions
      SET compiled_code = 'export class ConnectorRuntime {}',
          compile_config_hash = ${COMPILE_CONFIG_HASH}
      WHERE connector_key = 'chrome'
    `;
    const { deviceWorkerId, workerId } = await seedExtWorker(userId, orgId);
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'chrome',
      deviceWorkerId,
    });
    const [parent] = (await sql`
      INSERT INTO runs (
        organization_id, run_type, connection_id, connector_key, action_key,
        action_input, approval_status, status, created_at, expires_at,
        created_by_user_id
      ) VALUES (
        ${orgId}, 'action', ${connId}, 'chrome', 'scrape',
        ${sql.json({})}, 'auto', 'running',
        current_timestamp, current_timestamp + interval '1 day', ${userId}
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const runId = await seedPendingAction({
      orgId,
      connectionId: connId,
      connectorKey: 'chrome',
      connectorVersion: '1.0.0',
      parentRunId: Number(parent.id),
      actionInput: { tab_id: 5, expression: '1', activation_tab_id: 5 },
      expiresAtAgoSeconds: -60,
    });

    const res = await pollExtension(workerId);
    const body = (await res.json()) as {
      run_id?: number;
      action_input?: Record<string, unknown>;
    };
    expect(body.run_id).toBe(runId);
    expect(body.action_input).not.toHaveProperty('activation_tab_id');
  });

  // Two unparented chrome actions with no stored browser_context: the SDK
  // path. They must share one visible group (one standalone context id per
  // organization+connection) while keeping separate per-run flow ids, so ten
  // SDK navigates are one group with ten independently leased tabs rather than
  // ten groups. Helper-level coverage cannot see the poll wiring that decides
  // this, which is the only place the fallback chain is actually exercised.
  it('gives unparented chrome actions a shared standalone context with per-run flows', async () => {
    const { userId, orgId } = await seedOrg();
    await createTestConnectorDefinition({
      key: 'chrome',
      name: 'Chrome',
      organization_id: orgId,
    });
    const sql = getTestDb();
    await sql`
      UPDATE connector_versions
      SET compiled_code = 'export class ConnectorRuntime {}',
          compile_config_hash = ${COMPILE_CONFIG_HASH}
      WHERE connector_key = 'chrome'
    `;
    const { deviceWorkerId, workerId } = await seedExtWorker(userId, orgId);
    const connId = await seedConnection({
      orgId,
      userId,
      connectorKey: 'chrome',
      deviceWorkerId,
    });

    // No runMetadata and no parent run: the SDK shape the fallback chain
    // handles. Poll one at a time, since a poll claims a single run.
    const pollOne = async (url: string) => {
      const runId = await seedPendingAction({
        orgId,
        connectionId: connId,
        connectorKey: 'chrome',
        connectorVersion: '1.0.0',
        actionInput: { url },
        expiresAtAgoSeconds: -60,
      });
      const res = await pollExtension(workerId);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        run_id?: number;
        action_input?: Record<string, unknown>;
      };
      expect(body.run_id).toBe(runId);
      return { runId, input: body.action_input ?? {} };
    };

    const first = await pollOne('https://a.example/');
    const second = await pollOne('https://b.example/');

    // One visible group: same context id, in the standalone shape (not run:<id>,
    // which would mint a group per run — ten SDK navigates, ten groups).
    expect(first.input.browser_context_id).toBe(second.input.browser_context_id);
    expect(String(first.input.browser_context_id)).toMatch(/^run:standalone-/);
    expect(first.input.browser_context_title).toBe(second.input.browser_context_title);

    // Unshared ownership: each run leases its own tabs under its own flow.
    expect(first.input.browser_flow_id).toBe(String(first.runId));
    expect(second.input.browser_flow_id).toBe(String(second.runId));
    expect(first.input.browser_flow_id).not.toBe(second.input.browser_flow_id);
    // Authorization is the flow lease alone. The gateway sends no holder
    // mirror, so nothing but browser_flow_id can vouch for a tab.
    expect(first.input).not.toHaveProperty('holder_run_id');
  });
});
