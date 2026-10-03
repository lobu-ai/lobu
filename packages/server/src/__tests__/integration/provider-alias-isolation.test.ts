import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { generateWorkerToken, moduleRegistry, type ModuleInterface } from '@lobu/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiKeyProviderModule } from '../../gateway/auth/api-key-provider-module';
import { ProviderCatalogService } from '../../gateway/auth/provider-catalog';
import { SecretProxy } from '../../gateway/proxy/secret-proxy';
import {
  createInferenceProvider, listInferenceProviders, rotateInferenceProviderKey,
  softDeleteInferenceProvider,
} from '../../lobu/stores/provider-secrets';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestAgent, createTestOrganization } from '../setup/test-fixtures';

describe('provider alias isolation over HTTP and Postgres', () => {
  const slug = 'synthetic-shared-provider';
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const servers: ReturnType<typeof serve>[] = [];
  const origins: string[] = [];
  const scopes: Array<{ org: string; agent: string; token: string }> = [];
  const registry = moduleRegistry as unknown as { modules: Map<string, ModuleInterface> };
  let previousModules: Map<string, ModuleInterface>;
  const profiles = { getBestProfile: vi.fn(async () => ({ credential: 'synthetic-profile-key', authType: 'api-key' })) };

  beforeAll(async () => {
    await cleanupTestDatabase();
    previousModules = registry.modules;
    registry.modules = new Map();
    const module = new ApiKeyProviderModule({
      providerId: 'openai', slug: 'openai', sdkCompat: 'openai',
      upstreamBaseUrl: 'https://api.openai.com/v1', envVarName: 'SYNTHETIC_PROVIDER_KEY',
      providerDisplayName: 'Synthetic fixture', providerIconUrl: '',
      apiKeyInstructions: '', apiKeyPlaceholder: '', authProfilesManager: profiles as never,
    });
    moduleRegistry.register(module);
    for (const letter of ['a', 'b', 'c']) {
      const org = await createTestOrganization({ name: `Synthetic alias org ${letter}` });
      const agent = await createTestAgent({ organizationId: org.id, agentId: `synthetic-alias-agent-${letter}` });
      scopes.push({ org: org.id, agent: agent.agentId,
        token: generateWorkerToken('synthetic-user', 'synthetic-conversation', `synthetic-deployment-${letter}`, {
          organizationId: org.id, agentId: agent.agentId, channelId: 'synthetic-channel',
        }),
      });
      const created = await createInferenceProvider({
        organizationId: org.id, slug, kind: 'openai',
        apiKey: `synthetic-${letter}-key`,
        capabilities: { text: { model: 'synthetic-model',
          ...(letter !== 'b' ? { base_url: `https://${letter}.example.com/v1` } : {}),
        } },
      });
      if ('error' in created) throw new Error('Synthetic provider creation failed');
      if (letter === 'c') {
        await getTestDb()`UPDATE agent_secrets SET expires_at = now() - interval '1 second'
          WHERE organization_id = ${org.id}`;
      }
    }

    const catalog = new ProviderCatalogService(
      { getSettings: async () => ({ models: [`${slug}/synthetic-model`] }) } as never,
      profiles as never, listInferenceProviders,
    );
    // The order that leaked B's credential before the fix. A second serving
    // replica below never hydrates this catalog at all.
    for (const scope of [scopes[1]!, scopes[0]!]) {
      expect(await catalog.getInstalledModules(scope.agent, scope.org)).toHaveLength(1);
    }
    for (let replica = 0; replica < 2; replica++) {
      const proxy = new SecretProxy({ defaultUpstreamUrl: 'https://default.example.com' }, { get: async () => null });
      proxy.registerUpstream(module.getUpstreamConfig()!, module.providerId);
      proxy.setAuthProfilesManager(profiles as never);
      proxy.setSystemKeyResolver(() => ({ value: 'synthetic-operator-key', kind: 'api-key' }));
      const server = serve({ fetch: proxy.getApp().fetch, port: 0, hostname: '127.0.0.1' });
      servers.push(server);
      if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
      origins.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }
    const fetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (origins.some(origin => url.startsWith(origin + '/'))) return fetch(input, init);
      requests.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    registry.modules = previousModules;
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await cleanupTestDatabase();
  });

  async function request(replica: number, scope: typeof scopes[number], credential = scope.token) {
    const response = await fetch(`${origins[replica]}/api/proxy/${slug}/a/${scope.agent}/o/${scope.org}/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'synthetic-model', stream: true }),
    });
    await response.text();
    return response.status;
  }

  it('couples each authenticated row URL/key on warm and cold replicas, with immediate rotation and revocation', async () => {
    const [a, b, c] = scopes;
    for (const replica of [0, 1]) {
      expect(await request(replica, b!)).toBe(200);
      expect(await request(replica, a!)).toBe(200);
    }
    expect(requests).toEqual([
      { url: 'https://api.openai.com/v1/responses', authorization: 'Bearer synthetic-b-key' },
      { url: 'https://a.example.com/v1/responses', authorization: 'Bearer synthetic-a-key' },
      { url: 'https://api.openai.com/v1/responses', authorization: 'Bearer synthetic-b-key' },
      { url: 'https://a.example.com/v1/responses', authorization: 'Bearer synthetic-a-key' },
    ]);
    expect(await rotateInferenceProviderKey(b!.org, slug, 'synthetic-b-rotated')).toBe('rotated');
    expect(await request(0, b!)).toBe(200);
    expect(requests.at(-1)!.authorization).toBe('Bearer synthetic-b-rotated');
    const count = requests.length;
    expect(await request(1, a!, b!.token)).toBe(403);
    expect(await request(1, c!)).toBe(401);
    expect(await softDeleteInferenceProvider(b!.org, slug)).toBe(true);
    expect(await request(1, b!)).toBe(401);
    expect(requests).toHaveLength(count);
    expect(profiles.getBestProfile).not.toHaveBeenCalled();
  });
});
