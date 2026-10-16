/**
 * Headerless WorkerToken auth on the org-scoped direct MCP endpoint.
 *
 * A device Automation run hands its spawned agent CLI (claude, opencode, the
 * lobu CLI via LOBU_MEMORY_URL) the per-run WorkerToken and an MCP URL. Those
 * clients speak raw streamable-HTTP MCP and cannot attach the gateway-internal
 * `x-lobu-memory-direct-auth` header. The verified token must retain its
 * organization and revocation boundaries when it enters the same auth lane.
 */

import { generateWorkerToken, verifyWorkerToken } from '@lobu/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { getRevokedTokenStore } from '../../../gateway/auth/revoked-token-store';
import { buildDeploymentWorkerToken } from '../../../gateway/orchestration/deployment-identity';
import { buildAutomationRunWorkerAccess } from '../../../gateway/services/run-worker-access';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

const AGENT_ID = 'headerless-agent';

const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'spawned-cli', version: '1.0.0' },
  },
  id: 0,
};

describe('worker-token MCP auth without the direct-auth header', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let otherOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let workerToken: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    org = await createTestOrganization({ name: 'Headerless Org' });
    otherOrg = await createTestOrganization({ name: 'Headerless Other Org' });
    const user = await createTestUser({});
    await addUserToOrganization(user.id, org.id, 'owner');
    await addUserToOrganization(user.id, otherOrg.id, 'owner');
    await createTestAgent({
      organizationId: org.id,
      agentId: AGENT_ID,
      ownerUserId: user.id,
    });
    // Agent ids are org-scoped, so reproducing the same id in the other org
    // proves the signed organization claim — not id uniqueness — is the fence.
    await createTestAgent({
      organizationId: otherOrg.id,
      agentId: AGENT_ID,
      ownerUserId: user.id,
    });
    workerToken = buildAutomationRunWorkerAccess({
      agentId: AGENT_ID,
      automationId: 1,
      runId: 1,
      organizationId: org.id,
    }).token;
  });

  it('a bare WorkerToken bearer opens a fresh MCP session on /mcp/<orgSlug>', async () => {
    const initResponse = await post(`/mcp/${org.slug}`, {
      body: INITIALIZE_BODY,
      token: workerToken,
    });
    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    // The session is usable, not merely opened: tools/list answers on it.
    await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      token: workerToken,
      headers: { 'mcp-session-id': sessionId as string },
    });
    const toolsResponse = await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      token: workerToken,
      headers: { 'mcp-session-id': sessionId as string },
    });
    expect(toolsResponse.status).toBe(200);
    const tools = (await toolsResponse.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    const names = (tools.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain('query_sdk');
    expect(names).toContain('run_sdk');
  });

  it('refuses the token on another org even when that org has the same agent id', async () => {
    const response = await post(`/mcp/${otherOrg.slug}`, {
      body: INITIALIZE_BODY,
      token: workerToken,
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('insufficient_scope');
  });

  it('keeps an Automation worker resolve_path call pinned to its signed workspace', async () => {
    const initResponse = await post(`/mcp/${org.slug}`, {
      body: INITIALIZE_BODY,
      token: workerToken,
    });
    const sessionId = initResponse.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      token: workerToken,
      headers: { 'mcp-session-id': sessionId as string },
    });
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'resolve_path',
          arguments: { path: `/${otherOrg.slug}`, include_bootstrap: true },
        },
      },
      token: workerToken,
      headers: { 'mcp-session-id': sessionId as string },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        content: [{ text: 'Workspace is not available for this authorization' }],
      },
    });
  });

  it('refuses a worker token with no signed organization context', async () => {
    const orglessToken = generateWorkerToken(AGENT_ID, 'orgless-conversation', 'api-orgless', {
      channelId: 'api-orgless',
      agentId: AGENT_ID,
      platform: 'api',
    });
    const response = await post(`/mcp/${org.slug}`, {
      body: INITIALIZE_BODY,
      token: orglessToken,
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('invalid_token');
  });

  it('refuses a chat deployment token with or without the request-controlled direct-auth header', async () => {
    const deploymentToken = buildDeploymentWorkerToken({
      userId: 'api-user',
      conversationId: 'interactive-conversation',
      deploymentName: 'api-headerless-agent',
      channelId: 'api-user',
      agentId: AGENT_ID,
      organizationId: org.id,
      platform: 'api',
    });

    const headerlessResponse = await post(`/mcp/${org.slug}`, {
      body: INITIALIZE_BODY,
      token: deploymentToken,
    });
    expect(headerlessResponse.status).toBe(403);
    expect(await headerlessResponse.json()).toMatchObject({ error: 'insufficient_scope' });

    const explicitHeaderResponse = await post(`/mcp/${org.slug}`, {
      body: INITIALIZE_BODY,
      token: deploymentToken,
      headers: { 'X-Lobu-Memory-Direct-Auth': '1' },
    });
    expect(explicitHeaderResponse.status).toBe(403);
    expect(await explicitHeaderResponse.json()).toMatchObject({
      error: 'insufficient_scope',
    });
  });

  it('fast-rejects a worker token on non-MCP routes with or without the direct-auth header', async () => {
    for (const headers of [undefined, { 'X-Lobu-Memory-Direct-Auth': '1' }]) {
      const label = headers ? 'with direct-auth header' : 'headerless';
      const response = await post(`/api/${org.slug}/query_sdk`, {
        body: { sql: 'return lobu.organization.id' },
        token: workerToken,
        headers,
      });
      expect(response.status, label).toBe(401);
      expect(await response.json(), label).toMatchObject({
        error: 'invalid_token',
        error_description: 'Worker tokens are only valid on MCP routes',
      });
    }
  });

  it('a bearer that is not a worker token still falls through to OAuth auth', async () => {
    const response = await post(`/mcp/${org.slug}`, {
      body: INITIALIZE_BODY,
      token: 'not-a-worker-token-and-not-a-pat',
    });
    // The headerless promotion must not swallow ordinary bearers: this one
    // does not match the worker-token envelope, so OAuth handles and rejects it.
    expect(response.status).toBe(401);
  });

  it('an explicit direct-auth header with a non-verifying bearer stays a hard 401', async () => {
    const response = await post(`/mcp/${org.slug}`, {
      body: INITIALIZE_BODY,
      token: 'not-a-worker-token-and-not-a-pat',
      headers: { 'X-Lobu-Memory-Direct-Auth': '1' },
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error_description?: string };
    expect(String(body.error_description)).toMatch(/worker token/i);
  });

  it('refuses a revoked worker token', async () => {
    const access = buildAutomationRunWorkerAccess({
      agentId: AGENT_ID,
      automationId: 1,
      runId: 2,
      organizationId: org.id,
    });
    const claims = verifyWorkerToken(access.token);
    if (!claims?.jti) throw new Error('minted Automation worker token has no jti');
    await getRevokedTokenStore().revoke(claims.jti, access.expiresAt);

    const response = await post(`/mcp/${org.slug}`, {
      body: INITIALIZE_BODY,
      token: access.token,
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('invalid_token');
  });
});
