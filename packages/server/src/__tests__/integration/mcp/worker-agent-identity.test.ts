import { generateWorkerToken, mintGatewayMcpToken } from '@lobu/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { clearInMemoryMcpSessionsForTests } from '../../../mcp-handler';
import { buildClientSDK } from '../../../sandbox/client-sdk';
import type { Env } from '../../../index';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

const AGENT_ID = 'personal-agent';
const OTHER_AGENT_ID = 'other-agent';

describe('worker MCP session agent identity', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let workerToken: string;
  let otherWorkerToken: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Worker Identity Org' });
    user = await createTestUser({});
    await addUserToOrganization(user.id, org.id, 'owner');
    await createTestAgent({
      organizationId: org.id,
      agentId: AGENT_ID,
      ownerUserId: user.id,
    });
    await createTestAgent({
      organizationId: org.id,
      agentId: OTHER_AGENT_ID,
      ownerUserId: user.id,
    });
    const rawWorkerToken = generateWorkerToken(
      user.id,
      'conv-agent-turn-1',
      'test-deployment',
      {
        channelId: 'api-conv-agent-turn-1',
        agentId: AGENT_ID,
        organizationId: org.id,
        platform: 'api',
        source: 'internal',
      }
    );
    const rawOtherWorkerToken = generateWorkerToken(user.id, 'conv-agent-turn-2', 'test-deployment', {
      channelId: 'api-conv-agent-turn-2',
      agentId: OTHER_AGENT_ID,
      organizationId: org.id,
      platform: 'api',
      source: 'internal',
    });
    const narrowedWorkerToken = mintGatewayMcpToken(rawWorkerToken);
    const narrowedOtherWorkerToken = mintGatewayMcpToken(rawOtherWorkerToken);
    if (!narrowedWorkerToken || !narrowedOtherWorkerToken) {
      throw new Error('failed to narrow test worker credentials for the MCP hop');
    }
    workerToken = narrowedWorkerToken;
    otherWorkerToken = narrowedOtherWorkerToken;
  });

  /** Mirror the gateway proxy handshake, whose initialize metadata omits agentId. */
  async function initWorkerMcpSession(options?: {
    clientInfoAgentId?: string;
  }): Promise<string> {
    const initResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'lobu-gateway',
            version: '1.0.0',
            ...(options?.clientInfoAgentId ? { agentId: options.clientInfoAgentId } : {}),
          },
        },
        id: 0,
      },
      token: workerToken,
      headers: { 'X-Lobu-Memory-Direct-Auth': '1' },
    });
    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get('mcp-session-id');
    const initBody = await initResponse.json();
    if (!sessionId) {
      throw new Error(
        `initialize returned no mcp-session-id: ${JSON.stringify(initBody)}`
      );
    }
    expect(initBody.result?.instructions).toContain(
      "You have persistent memory. Use it proactively — don't wait to be asked."
    );
    expect(initBody.result?.instructions).toContain('### Saving (do this automatically)');
    expect(initBody.result?.instructions).not.toContain('### Writes and approvals');
    await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      token: workerToken,
      headers: {
        'X-Lobu-Memory-Direct-Auth': '1',
        'mcp-session-id': sessionId,
      },
    });
    return sessionId;
  }

  async function callTool<T>(
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    token = workerToken
  ): Promise<T> {
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      token,
      headers: {
        'X-Lobu-Memory-Direct-Auth': '1',
        'X-MCP-Format': 'json',
        'mcp-session-id': sessionId,
      },
    });
    const json = await response.json();
    if (json.error) {
      throw new Error(`MCP error [${json.error.code}]: ${json.error.message}`);
    }
    if (json.result?.isError) {
      throw new Error(json.result.content?.[0]?.text ?? 'tool call failed');
    }
    return JSON.parse(json.result.content[0].text) as T;
  }

  it('queues an identity link from an agent conversation turn for human approval instead of applying it', async () => {
    const sessionId = await initWorkerMcpSession();
    const root = await createTestEntity({
      name: 'Jane Doe',
      entity_type: 'person',
      organization_id: org.id,
      created_by: user.id,
    });
    const member = await createTestEntity({
      name: 'J. Doe',
      entity_type: 'person',
      organization_id: org.id,
      created_by: user.id,
    });
    const human = buildClientSDK({ ...ownerToolContext(org.id, user.id), tokenType: 'session' }, {} as Env);
    await human.entitySchema.updateType({ slug: 'person', metadata_schema: {
      'x-lobu-resolution': { rules: [{ fields: ['record_key'], normalizer: 'exact', onMatch: 'review' }] },
    } });
    await human.entitySchema.createRelType({ slug: 'same_person', name: 'Same person', purpose: 'identity' });
    await human.entitySchema.addRule({ slug: 'same_person', source_entity_type_slug: 'person', target_entity_type_slug: 'person' });
    const sql = getTestDb();
    await sql`UPDATE entities SET metadata = '{"record_key":"shared-fixture"}'::jsonb WHERE id IN (${member.id}, ${root.id})`;
    const before = await sql`SELECT id, name, metadata, deleted_at FROM entities WHERE id IN (${member.id}, ${root.id}) ORDER BY id`;

    const result = await callTool<{
      approval_queued?: boolean;
      approval_run_id?: number;
    }>(sessionId, 'manage_entity', {
      action: 'link',
      from_entity_id: member.id,
      to_entity_id: root.id,
      relationship_type_slug: 'same_person',
    });

    expect(result.approval_queued).toBe(true);
    expect(result.approval_run_id).toEqual(expect.any(Number));

    expect(await sql`SELECT id, name, metadata, deleted_at FROM entities WHERE id IN (${member.id}, ${root.id}) ORDER BY id`).toEqual(before);
    expect(await sql`SELECT id FROM entity_relationships WHERE organization_id = ${org.id}
      AND from_entity_id = ${member.id} AND to_entity_id = ${root.id} AND deleted_at IS NULL`).toEqual([]);
    const [run] = await sql`
      SELECT approval_status, action_input FROM runs WHERE id = ${result.approval_run_id}
    `;
    expect(run.approval_status).toBe('pending');
    expect(run.action_input.requester).toEqual({ kind: 'agent', id: AGENT_ID, userId: user.id });
  });

  it('binds the token-verified agent even when initialize clientInfo names a different agent', async () => {
    const sql = getTestDb();
    await sql`
      UPDATE agents SET last_used_at = NULL
      WHERE organization_id = ${org.id} AND id IN (${AGENT_ID}, ${OTHER_AGENT_ID})
    `;

    // A compromised/misbehaving client could ask for another agent's identity
    // in clientInfo — the worker JWT's binding must win.
    const sessionId = await initWorkerMcpSession({ clientInfoAgentId: OTHER_AGENT_ID });
    await callTool(sessionId, 'manage_entity', { action: 'list', entity_type: 'person' });

    const rows = await sql<{ id: string; last_used_at: string | null }[]>`
      SELECT id, last_used_at FROM agents
      WHERE organization_id = ${org.id} AND id IN (${AGENT_ID}, ${OTHER_AGENT_ID})
      ORDER BY id
    `;
    const byId = new Map(rows.map((r) => [r.id, r.last_used_at]));
    expect(byId.get(AGENT_ID)).not.toBeNull();
    expect(byId.get(OTHER_AGENT_ID)).toBeNull();
  });

  it('rejects switching an established live session to another worker agent', async () => {
    const sessionId = await initWorkerMcpSession();

    await expect(
      callTool(sessionId, 'manage_entity', { action: 'list' }, otherWorkerToken)
    ).rejects.toThrow('Session agent changed. Re-initialize.');
  });

  it('recovers a persisted worker session with the same verified agent', async () => {
    const sessionId = await initWorkerMcpSession();
    clearInMemoryMcpSessionsForTests();

    await expect(
      callTool(sessionId, 'manage_entity', { action: 'list' })
    ).resolves.toBeDefined();
  });

  it('rejects switching a recovered session to another worker agent', async () => {
    const sessionId = await initWorkerMcpSession();
    clearInMemoryMcpSessionsForTests();

    await expect(
      callTool(sessionId, 'manage_entity', { action: 'list' }, otherWorkerToken)
    ).rejects.toThrow('MCP session expired or not recognized.');
  });
});
