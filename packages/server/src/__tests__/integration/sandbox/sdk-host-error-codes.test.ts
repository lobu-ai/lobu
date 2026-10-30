/**
 * A host failure caused by the caller's own input must reach the agent with a
 * typed code, not as an untyped ScriptError the run_sdk/query_sdk boundary
 * reports as INTERNAL. Each case drives the real tool through `executeTool`,
 * the same path an MCP client takes.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../index';
import type { AuthContext } from '../../../tools/execute';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const CONNECTOR_KEY = 'demo.sdk-host-error-codes';
// Runs well past the 5s statement cap, so Postgres stops it with 57014.
const SLOW_SQL = 'SELECT count(*) AS n FROM generate_series(1, 2000000000) AS g';

describe('SDK host user-input errors are typed', () => {
  let auth: AuthContext;
  let connectionId: number;
  let executeTool: typeof import('../../../tools/execute').executeTool;
  let closeDbSingleton: typeof import('../../../db/client').closeDbSingleton;

  beforeAll(async () => {
    // A sibling that imports sdk_run first can leave its cyclic registry entries
    // uninitialized in Vitest's shared module cache. Load from the tool entrypoint.
    vi.resetModules();
    ({ executeTool } = await import('../../../tools/execute'));
    ({ closeDbSingleton } = await import('../../../db/client'));
    const { initWorkspaceProvider } = await import('../../../workspace');
    await cleanupTestDatabase();
    await initWorkspaceProvider();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'SDK Host Error Codes' });
    const user = await createTestUser({ email: 'sdk-host-error-codes@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await createTestOAuthClient();
    auth = {
      organizationId: org.id,
      tokenOrganizationId: null,
      userId: user.id,
      memberRole: 'owner',
      agentId: null,
      requestedAgentId: null,
      isAuthenticated: true,
      clientId: client.client_id,
      tokenType: 'oauth',
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      requestUrl: 'http://localhost/mcp',
      baseUrl: 'http://localhost',
      scopedToOrg: false,
      allowCrossOrg: true,
      grantedOrganizationIds: [org.id],
      directSearchFederation: false,
    };

    await createTestConnectorDefinition({
      key: CONNECTOR_KEY,
      name: 'SDK host error codes',
      organization_id: org.id,
    });
    const sql = getTestDb();
    await sql`
      UPDATE connector_definitions
      SET actions_schema = ${sql.json({
        echo: {
          name: 'Echo',
          kind: 'write',
          input_schema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      })}
      WHERE organization_id = ${org.id} AND key = ${CONNECTOR_KEY}
    `;
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: CONNECTOR_KEY,
      created_by: user.id,
      visibility: 'org',
    });
    connectionId = connection.id;
  });

  afterAll(async () => {
    await closeDbSingleton?.();
  });

  const call = (tool: string, args: Record<string, unknown>) =>
    executeTool(tool, args, {} as Env, auth) as Promise<any>;
  const script = (body: string) => `export default async (ctx, client) => ${body};`;

  it.each([
    ['an unknown column', 'SELECT nope_column FROM events'],
    ['an unknown table', 'SELECT id FROM nope_table'],
  ])('reports client.query with %s as VALIDATION', async (_label, sql) => {
    const result = await call('query_sdk', { script: script(`client.query(${JSON.stringify(sql)})`) });
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ name: 'ValidationError', code: 'VALIDATION', retryable: false });
  });

  it('reports a client.query statement timeout with the same code query_sql returns', async () => {
    const viaSql = await call('query_sql', { sql: SLOW_SQL });
    expect(viaSql.error_code).toBe('UPSTREAM_TIMEOUT');

    const viaSdk = await call('query_sdk', { script: script(`client.query(${JSON.stringify(SLOW_SQL)})`) });
    expect(viaSdk.success).toBe(false);
    expect(viaSdk.error).toMatchObject({ code: viaSql.error_code, retryable: true, message: viaSql.error });
  }, 30_000);

  it('reports a client.org() target outside the grant as PERMISSION', async () => {
    const result = await call('query_sdk', {
      script: script(`(await client.org('unavailable-synthetic-workspace')).organizations.current()`),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ name: 'CrossOrgAccessDenied', code: 'PERMISSION', retryable: false });
  });

  it.each(['query_sdk', 'run_sdk'])('reports disabled cross-workspace access through %s as PERMISSION', async (tool) => {
    const result = await executeTool(tool, {
      script: script(`client.org('unavailable-synthetic-workspace')`),
    }, {} as Env, { ...auth, scopedToOrg: true, allowCrossOrg: false }) as any;
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ name: 'CrossOrgAccessDenied', code: 'PERMISSION', retryable: false });
  });

  it('reports invalid operation input as VALIDATION', async () => {
    const result = await call('run_sdk', {
      script: script(`client.operations.execute({ connection_id: ${connectionId}, operation_key: 'echo', input: {} })`),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ name: 'ClientSdkActionError', code: 'VALIDATION', retryable: false });
    expect(result.error.message).toContain("Invalid input for operation 'echo'");
  });

  it('classifies a Postgres runtime error in client.query by SQLSTATE, like query_sql', async () => {
    const divideByZero = 'SELECT 1 / 0 AS n';
    const viaSql = await call('query_sql', { sql: divideByZero });
    expect(viaSql.error_code).toBe('VALIDATION');

    const viaSdk = await call('query_sdk', { script: script(`client.query(${JSON.stringify(divideByZero)})`) });
    expect(viaSdk.success).toBe(false);
    expect(viaSdk.error).toMatchObject({ code: viaSql.error_code, message: viaSql.error });
  });
});
