/**
 * `resolveCompletionTarget` protocol gating, against REAL provider rows.
 *
 * These features support API-key Chat Completions and Responses transports.
 * Unsupported protocols resolve to null so callers fail open without sending
 * a request the upstream cannot parse.
 *
 * A real row is required: the resolver returns null on a missing credential
 * LONG before it reaches the protocol check, so a registry-only test would
 * pass even with the check deleted.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  __resetEncryptionKeyCacheForTests,
  moduleRegistry,
  type ModuleInterface,
} from '@lobu/core';
import { createInferenceProvider } from '../../lobu/stores/provider-secrets';
import { resolveCompletionTarget } from '../../gateway/inference/gateway-completion';
import { ApiKeyProviderModule } from '../../gateway/auth/api-key-provider-module';
import { ChatGPTOAuthModule } from '../../gateway/auth/chatgpt/chatgpt-oauth-module';
import { getDb } from '../../db/client';
import { cleanupTestDatabase } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';

const registry = moduleRegistry as unknown as {
  modules: Map<string, ModuleInterface>;
};

let savedModules: Map<string, ModuleInterface>;

beforeAll(() => {
  process.env.LOBU_ENCRYPTION_KEY ||= 'a'.repeat(64);
  __resetEncryptionKeyCacheForTests();
  savedModules = new Map(registry.modules);
});

// The registry is process-global; a module leaking into the next test would
// silently change which one wins the providerId lookup.
afterEach(() => {
  registry.modules = new Map(savedModules);
});

afterAll(async () => {
  registry.modules = savedModules;
  await cleanupTestDatabase();
});

async function newOrgWithProvider(slug: string, model: string) {
  const org = await createTestOrganization();
  const orgId = org.id;
  const created = await createInferenceProvider({
    organizationId: orgId,
    slug,
    kind: slug,
    apiKey: 'sk-resolver-test',
    capabilities: { text: { model } },
  });
  if ('error' in created) throw new Error(`create failed: ${created.error}`);
  // main does not auto-promote; flag it so the resolver has a default to read.
  await getDb()`
    UPDATE inference_providers SET is_default = true
    WHERE organization_id = ${orgId} AND slug = ${slug}
  `;
  return orgId;
}

/** A second, NON-default provider in an existing org. */
async function addProvider(orgId: string, slug: string, model: string) {
  const created = await createInferenceProvider({
    organizationId: orgId,
    slug,
    kind: slug,
    apiKey: `sk-${slug}-test`,
    capabilities: { text: { model } },
  });
  if ('error' in created) throw new Error(`create failed: ${created.error}`);
}

function register(module: Record<string, unknown>) {
  moduleRegistry.register({
    isEnabled: () => true,
    getSecretEnvVarNames: () => [],
    ...module,
  } as unknown as ModuleInterface);
}

function registerOpenAiCompatible(providerId: string, upstreamBaseUrl: string) {
  register({
    name: `${providerId}-api-key`,
    providerId,
    providerDisplayName: providerId,
    sdkCompat: 'openai',
    getUpstreamConfig: () => ({ slug: providerId, upstreamBaseUrl }),
  });
}

describe('resolveCompletionTarget protocol gating', () => {
  it('resolves an API-key Responses provider with its transport', async () => {
    const orgId = await newOrgWithProvider('responses-provider', 'test-model');
    register({ name: 'responses-provider', providerId: 'responses-provider',
      sdkCompat: 'openai-responses',
      getUpstreamConfig: () => ({ slug: 'responses-provider', upstreamBaseUrl: 'https://responses.example.test/v1' }),
    });
    expect(await resolveCompletionTarget(orgId)).toMatchObject({
      sdkCompat: 'openai-responses', baseUrl: 'https://responses.example.test/v1', model: 'test-model',
    });
  });

  it.each(['openai', 'custom-openai'])('custom endpoint %s retains Chat Completions', async (slug) => {
    const org = await createTestOrganization();
    const created = await createInferenceProvider({ organizationId: org.id, slug, kind: 'openai',
      apiKey: 'sk-custom-test', capabilities: { text: { model: 'custom-model', base_url: 'https://custom.example.test/v1' } },
    });
    if ('error' in created) throw new Error(created.error);
    register({ name: 'openai', providerId: 'openai', sdkCompat: 'openai-responses',
      getUpstreamConfig: () => ({ slug: 'openai', upstreamBaseUrl: 'https://api.openai.com/v1' }),
    });
    const target = await resolveCompletionTarget(org.id, `${slug}/custom-model`);
    expect(target?.baseUrl).toBe('https://custom.example.test/v1');
    expect(target?.sdkCompat).toBeUndefined();
  });

  it.each(['openai', 'my-openai'])('catalog-prefilled endpoint %s uses Responses', async (slug) => {
    const org = await createTestOrganization();
    const created = await createInferenceProvider({
      organizationId: org.id, slug, kind: 'openai', apiKey: 'sk-official-test',
      capabilities: { text: { model: 'test-model', base_url: 'https://api.openai.com/v1/' } },
    });
    if ('error' in created) throw new Error(created.error);
    register({ name: 'openai', providerId: 'openai', sdkCompat: 'openai-responses',
      getUpstreamConfig: () => ({ slug: 'openai', upstreamBaseUrl: 'https://api.openai.com/v1' }),
    });
    expect(await resolveCompletionTarget(org.id, `${slug}/test-model`)).toMatchObject({
      baseUrl: 'https://api.openai.com/v1', sdkCompat: 'openai-responses', model: 'test-model',
    });
  });

  it.each([undefined, 'https://api.openai.com/v1/'])(
    'resolves the effective protocol with a deployment override and org URL %s', async (baseUrl) => {
      const prior = process.env.OPENAI_API_BASE_URL;
      try {
        process.env.OPENAI_API_BASE_URL = 'https://deployment.example.test/v1';
        const org = await createTestOrganization();
        const created = await createInferenceProvider({
          organizationId: org.id, slug: 'openai', kind: 'openai', apiKey: 'sk-override-test',
          capabilities: { text: { model: 'test-model', ...(baseUrl ? { base_url: baseUrl } : {}) } },
        });
        if ('error' in created) throw new Error(created.error);
        moduleRegistry.register(new ApiKeyProviderModule({
          providerId: 'openai', slug: 'openai', sdkCompat: 'openai-responses',
          upstreamBaseUrl: 'https://api.openai.com/v1', envVarName: 'OPENAI_API_KEY',
          providerDisplayName: 'OpenAI', providerIconUrl: '', apiKeyInstructions: '', apiKeyPlaceholder: '',
          authProfilesManager: {} as never,
        }) as unknown as ModuleInterface);
        const target = await resolveCompletionTarget(org.id, 'openai/test-model');
        expect(target?.baseUrl).toBe(baseUrl ? 'https://api.openai.com/v1' : process.env.OPENAI_API_BASE_URL);
        expect(target?.sdkCompat).toBe(baseUrl ? 'openai-responses' : undefined);
      } finally {
        if (prior === undefined) delete process.env.OPENAI_API_BASE_URL;
        else process.env.OPENAI_API_BASE_URL = prior;
      }
    },
  );

  // Seed a real credential so these refusals reach the protocol check instead
  // of passing accidentally at the earlier missing-credential guard.
  it.each([undefined, 'openai-codex'])(
    'does not resolve the unsupported gateway protocol %s',
    async (sdkCompat) => {
      const orgId = await newOrgWithProvider('test-provider', 'test-model');
      register({
        name: 'test-provider',
        providerId: 'test-provider',
        providerDisplayName: 'Test provider',
        sdkCompat,
        getUpstreamConfig: () => ({
          slug: 'test-provider',
          upstreamBaseUrl: 'https://provider.example.invalid',
        }),
      });
      expect(await resolveCompletionTarget(orgId)).toBeNull();
    },
  );

  it('declares the real ChatGPT Codex protocol without enabling Chat Completions', async () => {
    const cfg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../../../config/providers.json'), 'utf8'),
    ) as { providers: Array<{ id: string; providers: Array<{ sdkCompat?: string }> }> };
    const chatgpt = cfg.providers.find((g) => g.id === 'chatgpt');
    expect(chatgpt?.providers[0]?.sdkCompat).toBe('openai-codex');

    const module = new ChatGPTOAuthModule({} as never);
    expect(module.sdkCompat).toBe(chatgpt?.providers[0]?.sdkCompat);
    moduleRegistry.register(module as unknown as ModuleInterface);
    const orgId = await newOrgWithProvider('chatgpt', 'gpt-5.6-luna');
    expect(await resolveCompletionTarget(orgId)).toBeNull();
  });

  /**
   * `modelRef` overrides — the branch a guardrail's `model` field drives.
   *
   * Historically that field held a RAW model id (`gpt-4o-mini`) posted to one
   * operator-configured base URL. Now that credentials come from provider rows
   * a ref may ALSO be `<slug>/<model>`, and the two cannot be told apart by
   * looking for a "/": provider-native ids contain them (`anthropic/claude-…`,
   * `nvidia/moonshotai/kimi-k2.6`). So the resolver tries the prefix as a slug
   * and only accepts that reading if the org has such a row.
   *
   * All of this was previously untested — every other case here resolves the
   * org default with no ref at all.
   */
  describe('modelRef override', () => {
    it('a qualified <slug>/<model> ref routes to THAT provider, not the default', async () => {
      const orgId = await newOrgWithProvider('groq', 'llama-3.3-70b-versatile');
      await addProvider(orgId, 'together-ai', 'Qwen/Qwen2.5-72B-Instruct-Turbo');
      registerOpenAiCompatible('groq', 'https://api.groq.com/openai/v1');
      registerOpenAiCompatible('together-ai', 'https://api.together.xyz/v1');

      const target = await resolveCompletionTarget(orgId, 'together-ai/deepseek-ai/DeepSeek-V3');
      // The ref names a real row, so the prefix IS the slug — and the rest of
      // the string stays whole, slashes included.
      expect(target?.baseUrl).toBe('https://api.together.xyz/v1');
      expect(target?.model).toBe('deepseek-ai/DeepSeek-V3');
    });

    it('a BARE model ref borrows the default provider credentials', async () => {
      const orgId = await newOrgWithProvider('groq', 'llama-3.3-70b-versatile');
      registerOpenAiCompatible('groq', 'https://api.groq.com/openai/v1');

      const target = await resolveCompletionTarget(orgId, 'llama-3.1-8b-instant');
      // No "/" at all: the operator's raw model id runs on the org default.
      expect(target?.baseUrl).toBe('https://api.groq.com/openai/v1');
      expect(target?.model).toBe('llama-3.1-8b-instant');
    });

    it('a provider-native ref whose prefix is NOT a row is kept whole', async () => {
      const orgId = await newOrgWithProvider('openrouter', 'auto');
      registerOpenAiCompatible('openrouter', 'https://openrouter.ai/api/v1');

      // `anthropic/` is openrouter's MODEL namespace here, not a provider row.
      // Splitting on it would misroute to a provider the org does not have.
      const target = await resolveCompletionTarget(orgId, 'anthropic/claude-sonnet-5');
      expect(target?.baseUrl).toBe('https://openrouter.ai/api/v1');
      expect(target?.model).toBe('anthropic/claude-sonnet-5');
    });

    it('an override is skipped when the org has no default to borrow from', async () => {
      const org = await createTestOrganization();
      expect(await resolveCompletionTarget(org.id, 'some-model')).toBeNull();
    });
  });

  it('does NOT resolve an explicitly non-OpenAI protocol', async () => {
    const orgId = await newOrgWithProvider('anthropic', 'claude-sonnet-5');
    register({
      name: 'anthropic-api-key',
      providerId: 'anthropic',
      providerDisplayName: 'Anthropic',
      sdkCompat: 'anthropic',
      getUpstreamConfig: () => ({
        slug: 'anthropic',
        upstreamBaseUrl: 'https://api.anthropic.com',
      }),
    });

    expect(await resolveCompletionTarget(orgId)).toBeNull();
  });

  /** The positive control: same shape, only sdkCompat differs. */
  it('DOES resolve an OpenAI-compatible module', async () => {
    const orgId = await newOrgWithProvider('groq', 'llama-3.3-70b-versatile');
    register({
      name: 'groq-api-key',
      providerId: 'groq',
      providerDisplayName: 'Groq',
      sdkCompat: 'openai',
      getUpstreamConfig: () => ({
        slug: 'groq',
        upstreamBaseUrl: 'https://api.groq.com/openai/v1',
      }),
    });

    const target = await resolveCompletionTarget(orgId);
    expect(target).not.toBeNull();
    expect(target?.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(target?.model).toBe('llama-3.3-70b-versatile');
  });
});
