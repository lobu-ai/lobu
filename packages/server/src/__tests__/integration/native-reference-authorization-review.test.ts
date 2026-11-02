/**
 * Integration test: the REST reads behind the native event reference nodes
 * (automation-ref, connector-ref, agent-ref and the connector catalog) obey
 * the existing workspace permission contract. The frontend only supplies
 * selectors; these reads must not resolve a foreign workspace's records or a
 * private connection, and an archived Automation must stay resolvable through
 * the explicit status filter the reference uses.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestAgent,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
} from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';
import { TestApiClient } from '../setup/test-mcp-client';

const AGENT_ID = 'visible-reference-agent';
const CONNECTOR_KEY = 'reference.demo';

describe('native reference REST authorization', () => {
  let publicSlug: string;
  let privateSlug: string;
  let automationId: string;
  let visibleConnectionId: number;
  let hiddenConnectionId: number;
  let ownerApi: TestApiClient;
  let publicOwnerToken: string;
  let privateOwnerToken: string;

  const ids = (rows: Array<{ automation_id: string }>) =>
    rows.map((row) => String(row.automation_id));

  beforeAll(async () => {
    await cleanupTestDatabase();
    const publicOrg = await createTestOrganization({
      name: 'Reference public fixture',
      visibility: 'public',
    });
    const privateOrg = await createTestOrganization({
      name: 'Reference private fixture',
      visibility: 'private',
    });
    publicSlug = publicOrg.slug;
    privateSlug = privateOrg.slug;

    const publicOwner = await createTestUser({ email: 'reference-authorization@example.test' });
    await addUserToOrganization(publicOwner.id, publicOrg.id, 'owner');
    const privateOwner = await createTestUser({ email: 'reference-other@example.test' });
    await addUserToOrganization(privateOwner.id, privateOrg.id, 'owner');

    const oauthClient = await createTestOAuthClient();
    publicOwnerToken = (
      await createTestAccessToken(publicOwner.id, publicOrg.id, oauthClient.client_id, {
        scope: 'mcp:read',
      })
    ).token;
    privateOwnerToken = (
      await createTestAccessToken(privateOwner.id, privateOrg.id, oauthClient.client_id, {
        scope: 'mcp:read',
      })
    ).token;

    await createTestAgent({
      organizationId: publicOrg.id,
      ownerUserId: publicOwner.id,
      agentId: AGENT_ID,
    });
    await createTestConnectorDefinition({
      key: CONNECTOR_KEY,
      name: 'Reference fixture connector',
      organization_id: publicOrg.id,
    });
    const visible = await createTestConnection({
      organization_id: publicOrg.id,
      connector_key: CONNECTOR_KEY,
      visibility: 'org',
      created_by: publicOwner.id,
    });
    const hidden = await createTestConnection({
      organization_id: publicOrg.id,
      connector_key: CONNECTOR_KEY,
      visibility: 'private',
      created_by: publicOwner.id,
    });
    visibleConnectionId = Number(visible.id);
    hiddenConnectionId = Number(hidden.id);

    ownerApi = await TestApiClient.for({
      organizationId: publicOrg.id,
      userId: publicOwner.id,
      memberRole: 'owner',
    });
    const created = (await ownerApi.automations.create({
      slug: 'reference-test',
      name: 'Public reference',
      prompt: 'Fixture',
      managed_agent_id: AGENT_ID,
    })) as { automation_id: string };
    automationId = String(created.automation_id);
  });

  it('resolves public-workspace references anonymously and hides the private connection', async () => {
    const list = await post(`/api/${publicSlug}/manage_automations`, {
      body: { action: 'list', automation_id: automationId, status: 'active', include_details: false, limit: 1 },
    });
    expect(list.status).toBe(200);
    expect(ids((await list.json()).automations)).toEqual([automationId]);

    const connections = await post(`/api/${publicSlug}/manage_connections`, {
      body: {
        action: 'list',
        connection_ids: [visibleConnectionId, hiddenConnectionId],
        connector_key: CONNECTOR_KEY,
        limit: 5,
      },
    });
    expect(connections.status).toBe(200);
    const connectionIds = (await connections.json()).connections.map((row: { id: number }) => Number(row.id));
    expect(connectionIds).toContain(visibleConnectionId);
    expect(connectionIds).not.toContain(hiddenConnectionId);

    const agent = await post(`/api/${publicSlug}/manage_agents`, {
      body: { action: 'get', agent_id: AGENT_ID },
    });
    expect(agent.status).toBe(200);
    expect((await agent.json()).agent.id).toBe(AGENT_ID);

    const catalog = await post(`/api/${publicSlug}/manage_catalog`, {
      body: { action: 'list_installed', kinds: ['connectors'], include_catalog: true },
    });
    expect(catalog.status).toBe(200);

    const absent = await post(`/api/${publicSlug}/manage_automations`, {
      body: { action: 'list', automation_id: '999999', status: 'active', limit: 1 },
    });
    expect((await absent.json()).automations).toEqual([]);
  });

  it('refuses anonymous reads of the private workspace', async () => {
    const reads: Array<[string, Record<string, unknown>]> = [
      ['manage_automations', { action: 'list', automation_id: automationId, status: 'active', limit: 1 }],
      ['manage_connections', { action: 'list', connection_ids: [visibleConnectionId], connector_key: CONNECTOR_KEY, limit: 1 }],
      ['manage_agents', { action: 'get', agent_id: AGENT_ID }],
      ['manage_catalog', { action: 'list_installed', kinds: ['connectors'], include_catalog: true }],
    ];
    for (const [tool, body] of reads) {
      const response = await post(`/api/${privateSlug}/${tool}`, { body });
      expect([401, 403]).toContain(response.status);
    }
  });

  it('keeps an archived Automation resolvable only through the explicit archived filter', async () => {
    await ownerApi.automations.delete({ automation_ids: [automationId] });

    for (const status of [undefined, 'active']) {
      const response = await post(`/api/${publicSlug}/manage_automations`, {
        body: { action: 'list', automation_id: automationId, limit: 1, ...(status ? { status } : {}) },
      });
      expect((await response.json()).automations).toEqual([]);
    }

    const archived = await post(`/api/${publicSlug}/manage_automations`, {
      body: { action: 'list', automation_id: automationId, status: 'archived', limit: 1 },
    });
    const rows = (await archived.json()).automations;
    expect(ids(rows)).toEqual([automationId]);
    expect(rows[0].status).toBe('archived');
  });

  it('denies a public-workspace token outside its workspace and does not resolve foreign IDs inside the private one', async () => {
    const reads: Array<[string, Record<string, unknown>]> = [
      ['manage_automations', { action: 'list', automation_id: automationId, status: 'archived', limit: 1 }],
      ['manage_connections', { action: 'list', connection_ids: [visibleConnectionId], connector_key: CONNECTOR_KEY, limit: 1 }],
      ['manage_agents', { action: 'get', agent_id: AGENT_ID }],
      ['manage_catalog', { action: 'list_installed', kinds: ['connectors'], include_catalog: true }],
    ];
    for (const [tool, body] of reads) {
      const response = await post(`/api/${privateSlug}/${tool}`, { body, token: publicOwnerToken });
      expect([401, 403]).toContain(response.status);
    }

    const automations = await post(`/api/${privateSlug}/manage_automations`, {
      body: reads[0][1],
      token: privateOwnerToken,
    });
    expect(automations.status).toBe(200);
    expect((await automations.json()).automations).toEqual([]);

    const connections = await post(`/api/${privateSlug}/manage_connections`, {
      body: reads[1][1],
      token: privateOwnerToken,
    });
    expect(connections.status).toBe(200);
    expect((await connections.json()).connections).toEqual([]);

    const agent = await post(`/api/${privateSlug}/manage_agents`, {
      body: reads[2][1],
      token: privateOwnerToken,
    });
    expect([403, 404]).toContain(agent.status);
  });
});
