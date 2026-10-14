/**
 * `/api/workers/*` admits only a device grant: `device_worker:run` with no MCP
 * resource audience. A general token — a personal access token handed to an
 * outside agent, an MCP app's grant — is consent to use workspace tools, not to
 * act as one of the user's machines, so it must not register a device.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestAccessToken,
  createTestOAuthClient,
  createTestPAT,
  seedOwnerContext,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

type Credential =
  | { kind: 'pat'; scope?: string }
  | { kind: 'oauth'; scope: string; resource: string | null };

async function pollAs(credential: Credential, workerId: string) {
  const { org, user } = await seedOwnerContext();
  const { token } =
    credential.kind === 'pat'
      ? await createTestPAT(user.id, org.id, { scope: credential.scope })
      : await createTestAccessToken(user.id, org.id, (await createTestOAuthClient()).client_id, {
          scope: credential.scope,
          resource: credential.resource,
        });
  const response = await post('/api/workers/poll', {
    token,
    body: { worker_id: workerId, platform: 'headless', app_version: 'test', capabilities: { 'os.shell': true } },
  });
  const rows = (await getTestDb()`
    SELECT 1 FROM device_workers WHERE worker_id = ${workerId}
  `) as unknown as Array<unknown>;
  return { status: response.status, registered: rows.length === 1 };
}

describe('worker endpoints admit only device grants', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('refuses a general personal access token', async () => {
    expect(await pollAs({ kind: 'pat' }, 'gate-pat-default')).toEqual({ status: 403, registered: false });
    expect(await pollAs({ kind: 'pat', scope: 'mcp:read mcp:write mcp:admin' }, 'gate-pat-admin')).toEqual({
      status: 403,
      registered: false,
    });
  });

  it('refuses a general OAuth grant with no MCP resource', async () => {
    expect(
      await pollAs({ kind: 'oauth', scope: 'mcp:read mcp:write mcp:admin', resource: null }, 'gate-oauth-admin')
    ).toEqual({ status: 403, registered: false });
  });

  it('refuses an MCP app grant even when it carries device_worker:run', async () => {
    const result = await pollAs(
      { kind: 'oauth', scope: 'mcp:read device_worker:run', resource: 'http://localhost/mcp' },
      'gate-mcp-device'
    );
    expect(result.registered).toBe(false);
    expect([401, 403]).toContain(result.status);
  });

  it('admits device grants', async () => {
    expect(await pollAs({ kind: 'pat', scope: 'device_worker:run' }, 'gate-pat-device')).toEqual({
      status: 200,
      registered: true,
    });
    expect(
      await pollAs({ kind: 'oauth', scope: 'mcp:read device_worker:run profile:read', resource: null }, 'gate-oauth-device')
    ).toEqual({ status: 200, registered: true });
  });
});
