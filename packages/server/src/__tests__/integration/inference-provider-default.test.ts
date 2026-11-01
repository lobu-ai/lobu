/**
 * Integration coverage for automatic org-default assignment, legacy repair,
 * OAuth defaults, and promotion after deletion.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  __resetEncryptionKeyCacheForTests,
  moduleRegistry,
  type ModuleInterface,
} from '@lobu/core';
import {
  createInferenceProvider,
  ensureOAuthInferenceProvider,
  getOrgDefaultModel,
  listInferenceProviders,
  setInferenceProviderDefault,
  softDeleteInferenceProvider,
  updateInferenceProviderCapabilities,
  readOrgSharedProviderApiKey,
} from '../../lobu/stores/provider-secrets';
import { resolveCompletionTarget } from '../../gateway/inference/gateway-completion';
import { getDb } from '../../db/client';
import { initWorkspaceProvider } from '../../workspace';
import { cleanupTestDatabase } from '../setup/test-db';
import { createTestOrganization, createTestUser, addUserToOrganization } from '../setup/test-fixtures';
import { buildClientSDK } from '../../sandbox/client-sdk';
import { executeTool, toToolContext, type AuthContext } from '../../tools/execute';
import type { Env } from '../../index';

let originalEncryptionKey: string | undefined;

async function newOrg() {
  return await createTestOrganization({ name: 'Provider Default Org' });
}

/** Create a provider, failing loudly on a slug conflict. */
async function create(
  organizationId: string,
  slug: string,
  model?: string,
) {
  const result = await createInferenceProvider({
    organizationId,
    slug,
    kind: slug,
    apiKey: `sk-${slug}`,
    capabilities: model ? { text: { model } } : {},
  });
  if ('error' in result) throw new Error(`unexpected conflict for ${slug}`);
  return result;
}

async function defaultSlug(organizationId: string): Promise<string | null> {
  const rows = (await getDb()`
    SELECT slug FROM inference_providers
    WHERE organization_id = ${organizationId} AND is_default AND deleted_at IS NULL
  `) as Array<{ slug: string }>;
  return rows[0]?.slug ?? null;
}

describe('inference provider org default', () => {
  async function providerClient(scopes = ['mcp:read', 'mcp:write', 'mcp:admin']) {
    const org = await newOrg();
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    const auth: AuthContext = {
      organizationId: org.id, tokenOrganizationId: org.id, userId: user.id,
      memberRole: 'owner', agentId: null, requestedAgentId: null, isAuthenticated: true,
      clientId: null, scopes, tokenType: 'pat', requestUrl: 'http://localhost/api/provider-test',
      baseUrl: '', scopedToOrg: true, allowCrossOrg: false,
    };
    const env: Env = { ENVIRONMENT: 'test', RATE_LIMIT_ENABLED: 'false' };
    return { auth, env, sdk: buildClientSDK(toToolContext(auth), env, { mode: 'full' }) };
  }

  it('SDK and MCP share provider writes, omitted capabilities and redacted responses', async () => {
    const { auth, env, sdk } = await providerClient();
    const created = await sdk.inferenceProviders.create({ slug: 'custom', kind: 'openai', apiKey: 'synthetic-initial-key',
      capabilities: { text: { model: 'synthetic-model', base_url: 'https://inference.example/v1' } } });
    expect(created.provider.isDefault).toBe(true);
    await sdk.inferenceProviders.update({ slug: 'custom', displayName: 'Renamed' });
    await sdk.inferenceProviders.setCapability({ slug: 'custom', modality: 'image', block: { model: 'synthetic-image' } });
    await sdk.inferenceProviders.rotateKey({ slug: 'custom', value: 'synthetic-rotated-key' });
    expect(await readOrgSharedProviderApiKey('custom', auth.organizationId!)).toBe('synthetic-rotated-key');
    const rotated = await executeTool('manage_inference_providers',
      { action: 'rotate_key', slug: 'custom', value: 'synthetic-mcp-key' }, env, auth);
    expect(rotated).toEqual({ success: true });
    expect(await sdk.inferenceProviders.setDefault({ slug: 'custom' })).toEqual({ success: true, slug: 'custom', isDefault: true });
    const listed = await executeTool('manage_inference_providers', { action: 'list' }, env, auth);
    expect(listed).toEqual(await sdk.inferenceProviders.list());
    expect(listed).toMatchObject({ providers: [{ slug: 'custom', displayName: 'Renamed', capabilities: {
      text: { model: 'synthetic-model', base_url: 'https://inference.example/v1' }, image: { model: 'synthetic-image' },
    } }] });
    expect(await readOrgSharedProviderApiKey('custom', auth.organizationId!)).toBe('synthetic-mcp-key');
    const audits = await getDb()`SELECT metadata, payload_data FROM events WHERE organization_id = ${auth.organizationId}`;
    const serialized = JSON.stringify([created, rotated, listed, audits]);
    expect(serialized).not.toContain('synthetic-initial-key');
    expect(serialized).not.toContain('synthetic-rotated-key');
    expect(serialized).not.toContain('synthetic-mcp-key');
    expect(serialized).not.toContain('api_key_ref');
    expect(await sdk.inferenceProviders.delete({ slug: 'custom' })).toEqual({ success: true });
    expect(await sdk.inferenceProviders.list()).toEqual({ providers: [] });
  });

  beforeAll(async () => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    __resetEncryptionKeyCacheForTests();
    await initWorkspaceProvider();
    await cleanupTestDatabase();
  });

  afterAll(() => {
    if (originalEncryptionKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
    __resetEncryptionKeyCacheForTests();
  });

  it('provider administration enforces role/scope and rejects unknown or invalid mutations atomically', async () => {
    const { auth, env, sdk } = await providerClient();
    const input = { slug: 'rejected', kind: 'openai', apiKey: 'synthetic-key', capabilities: { text: { model: 'model' } } };
    const deniedContexts: AuthContext[] = [ { ...auth, memberRole: 'member' }, { ...auth, scopes: ['mcp:read', 'mcp:write'] },
      { ...auth, userId: null, memberRole: null }, { ...auth, userId: null, memberRole: null, tokenType: 'session' } ];
    for (const denied of deniedContexts) {
      await expect(executeTool('manage_inference_providers', { action: 'create', ...input }, env, denied)).rejects.toThrow();
      await expect(buildClientSDK(toToolContext(denied), env).inferenceProviders.create(input)).rejects.toThrow();
    }
    await expect(sdk.inferenceProviders.create({ ...input, extra: true } as never)).rejects.toThrow(/unknown/i);
    await expect(sdk.inferenceProviders.create({ ...input, capabilities: { text: { model: 'model', extra: true } } } as never)).rejects.toThrow();
    await expect(sdk.inferenceProviders.create({ ...input, capabilities: { text: { base_url: 'http://inference.example' } } })).rejects.toThrow(/https/);
    expect(await sdk.inferenceProviders.list()).toEqual({ providers: [] });
    expect(await getDb()`SELECT name FROM agent_secrets WHERE organization_id = ${auth.organizationId}`).toHaveLength(0);
    const reader = buildClientSDK(toToolContext({ ...auth, scopes: ['mcp:read'], memberRole: 'member' }), env, { mode: 'read' });
    expect(await reader.inferenceProviders.list()).toEqual({ providers: [] });
    expect(reader.inferenceProviders.create).toBeUndefined();
  });

  it('SDK provider mutations roll back vault and config when transactional audit fails', async () => {
    const { auth, sdk } = await providerClient();
    const sql = getDb();
    await sql.unsafe("CREATE FUNCTION reject_sdk_provider_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.metadata->>'category' = 'config' THEN RAISE EXCEPTION 'synthetic audit rejection'; END IF; RETURN NEW; END $$");
    await sql.unsafe("CREATE TRIGGER reject_sdk_provider_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_sdk_provider_audit()");
    try {
      await expect(sdk.inferenceProviders.create({ slug: 'rollback', kind: 'openai', apiKey: 'synthetic-key' })).rejects.toThrow(/synthetic audit rejection/);
      expect(await sdk.inferenceProviders.list()).toEqual({ providers: [] });
      expect(await sql`SELECT name FROM agent_secrets WHERE organization_id = ${auth.organizationId}`).toHaveLength(0);
    } finally {
      await sql.unsafe('DROP TRIGGER reject_sdk_provider_audit ON events');
      await sql.unsafe('DROP FUNCTION reject_sdk_provider_audit()');
    }
  });

  it('(a) the first runnable provider an org creates becomes its default', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');

    expect(await defaultSlug(org.id)).toBe('openai');
    // The whole point: a model now resolves org-wide.
    expect(await getOrgDefaultModel(org.id)).toBe('openai/gpt-4o-mini');
  });

  it('(a2) create REPORTS the auto-promotion in its return value', async () => {
    const org = await newOrg();

    // The contract, not just the DB state: the caller cannot infer this from
    // its own request, and both the REST response and `lobu providers create
    // --json` publish it. The INSERT's RETURNING captures is_default BEFORE
    // promotion, so a naive implementation reports a stale `false` here.
    const first = await create(org.id, 'openai', 'gpt-4o-mini');
    expect(first.isDefault).toBe(true);

    // A later provider is NOT the default, and must say so.
    const second = await create(org.id, 'z-ai', 'glm-4.6');
    expect(second.isDefault).toBe(false);

    // A model-less row is never promoted, so it is never reported as default.
    const third = await create(org.id, 'groq');
    expect(third.isDefault).toBe(false);
  });

  it('(b) later providers do NOT steal the default', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await create(org.id, 'z-ai', 'glm-4.6');
    await create(org.id, 'xai', 'grok-4');

    expect(await defaultSlug(org.id)).toBe('openai');
    expect(await getOrgDefaultModel(org.id)).toBe('openai/gpt-4o-mini');
  });

  it('(c) deleting the default promotes the oldest survivor', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await create(org.id, 'z-ai', 'glm-4.6');
    await create(org.id, 'xai', 'grok-4');
    expect(await defaultSlug(org.id)).toBe('openai');

    expect(await softDeleteInferenceProvider(org.id, 'openai')).toBe(true);

    // z-ai was created before xai, so it inherits.
    expect(await defaultSlug(org.id)).toBe('z-ai');
    expect(await getOrgDefaultModel(org.id)).toBe('z-ai/glm-4.6');
  });

  it('(d) deleting a NON-default provider leaves the default alone', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await create(org.id, 'z-ai', 'glm-4.6');

    expect(await softDeleteInferenceProvider(org.id, 'z-ai')).toBe(true);
    expect(await defaultSlug(org.id)).toBe('openai');
  });

  it('(e) deleting the last provider leaves the org without a default', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');

    expect(await softDeleteInferenceProvider(org.id, 'openai')).toBe(true);
    expect(await defaultSlug(org.id)).toBeNull();
    expect(await getOrgDefaultModel(org.id)).toBeNull();
  });

  it('(f) re-creating after deleting everything defaults again', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await softDeleteInferenceProvider(org.id, 'openai');

    // A soft-deleted row must not count as "already has a provider", or the
    // org could never recover a default.
    await create(org.id, 'z-ai', 'glm-4.6');
    expect(await defaultSlug(org.id)).toBe('z-ai');
  });

  it('(g) an explicit set-default still wins over the auto-assignment', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await create(org.id, 'z-ai', 'glm-4.6');

    expect(await setInferenceProviderDefault(org.id, 'z-ai')).toBe('ok');
    expect(await defaultSlug(org.id)).toBe('z-ai');
    // Exactly one default survives the switch (partial unique index).
    const providers = await listInferenceProviders(org.id);
    expect(providers.filter((p) => p.isDefault)).toHaveLength(1);
  });

  /**
   * set-default must not report success for a choice the next read undoes.
   *
   * A model-less row resolves to null in `getOrgDefaultModel`, which then
   * REPAIRS the org by demoting it and promoting a runnable row. Accepting the
   * write would make the API claim to have stored something it immediately
   * reverts — the CLI printed "set as org default" for a selection that was
   * gone one request later.
   */
  it('(g2) set-default REJECTS a provider with no text model', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await create(org.id, 'groq'); // no text model

    expect(await setInferenceProviderDefault(org.id, 'groq')).toBe(
      'no_text_model',
    );
    // The prior default is untouched — a rejected write changes nothing.
    expect(await defaultSlug(org.id)).toBe('openai');
    expect(await getOrgDefaultModel(org.id)).toBe('openai/gpt-4o-mini');
  });

  it('(g3) an accepted set-default survives the next resolution', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await create(org.id, 'z-ai', 'glm-4.6');

    expect(await setInferenceProviderDefault(org.id, 'z-ai')).toBe('ok');
    // The round trip is the point: resolution must NOT repair this away.
    expect(await getOrgDefaultModel(org.id)).toBe('z-ai/glm-4.6');
    expect(await defaultSlug(org.id)).toBe('z-ai');
  });

  it('(h) two orgs each keep their own default', async () => {
    const orgA = await newOrg();
    const orgB = await newOrg();
    await create(orgA.id, 'openai', 'gpt-4o-mini');
    await create(orgB.id, 'z-ai', 'glm-4.6');

    expect(await getOrgDefaultModel(orgA.id)).toBe('openai/gpt-4o-mini');
    expect(await getOrgDefaultModel(orgB.id)).toBe('z-ai/glm-4.6');
  });

  it('(i) repairs a legacy org whose live providers have no default', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await getDb()`
      UPDATE inference_providers
      SET is_default = false
      WHERE organization_id = ${org.id}
    `;

    expect(await getOrgDefaultModel(org.id)).toBe('openai/gpt-4o-mini');
    expect(await defaultSlug(org.id)).toBe('openai');
  });

  /**
   * An OAuth row is NOT auto-promoted, even though it has a text model.
   *
   * OAuth credentials live in per-user `auth_profiles`; `oauth://` joins to no
   * `agent_secrets` row, so the org-shared key reader returns null for it. A
   * headless Automation run carries a synthetic user id with no profile, so an
   * OAuth org default hands every agent a model it cannot authenticate — it
   * fails at egress instead of falling back, which is worse than no default.
   */
  it('(j) an OAuth provider is NOT auto-promoted to org default', async () => {
    const org = await newOrg();
    await ensureOAuthInferenceProvider({
      organizationId: org.id,
      slug: 'claude',
      kind: 'claude',
      defaultModel: 'claude-sonnet-5',
    });

    expect(await defaultSlug(org.id)).toBeNull();
    expect(await getOrgDefaultModel(org.id)).toBeNull();
  });

  it('(j2) an API-key provider is promoted over an older OAuth row', async () => {
    const org = await newOrg();
    // OAuth first, so "oldest wins" alone would pick it.
    await ensureOAuthInferenceProvider({
      organizationId: org.id,
      slug: 'claude',
      kind: 'claude',
      defaultModel: 'claude-sonnet-5',
    });
    await create(org.id, 'openai', 'gpt-4o-mini');

    expect(await defaultSlug(org.id)).toBe('openai');
    expect(await getOrgDefaultModel(org.id)).toBe('openai/gpt-4o-mini');
  });

  /**
   * An OAuth row is rejected as an EXPLICIT default too, not just an automatic
   * one. Its credential lives in one user's `auth_profiles`
   * (`getProviderProfiles(agentId, provider, context.userId)`), so no other
   * member — and no headless Automation run, which carries a synthetic user id —
   * can read it. "The chooser holds the profile" is not enough: an org-wide
   * default is inherited by everyone else too.
   */
  it('(j3) an OAuth provider is rejected as an EXPLICIT org default', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await ensureOAuthInferenceProvider({
      organizationId: org.id,
      slug: 'claude',
      kind: 'claude',
      defaultModel: 'claude-sonnet-5',
    });

    // A DISTINCT reason from "no text model" — claude HAS one; the problem is
    // that its credential belongs to a single user. The route turns each into
    // its own message, because the fix differs.
    expect(await setInferenceProviderDefault(org.id, 'claude')).toBe(
      'oauth_provider',
    );
    // The prior, org-readable default is untouched.
    expect(await defaultSlug(org.id)).toBe('openai');
    expect(await getOrgDefaultModel(org.id)).toBe('openai/gpt-4o-mini');
  });

  it('(j4) a LEGACY oauth default is demoted and replaced on read', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await ensureOAuthInferenceProvider({
      organizationId: org.id,
      slug: 'claude',
      kind: 'claude',
      defaultModel: 'claude-sonnet-5',
    });
    // Simulate a row written before the oauth rule existed.
    await getDb()`
      UPDATE inference_providers SET is_default = (slug = 'claude')
      WHERE organization_id = ${org.id}
    `;
    expect(await defaultSlug(org.id)).toBe('claude');

    // Reading repairs it rather than handing out an unauthenticatable model.
    expect(await getOrgDefaultModel(org.id)).toBe('openai/gpt-4o-mini');
    expect(await defaultSlug(org.id)).toBe('openai');
  });

  it('(j5) converting the DEFAULT api-key row to oauth hands off the default', async () => {
    const org = await newOrg();
    // `zed` is the default (created first); `openai` is an eligible successor.
    await create(org.id, 'zed', 'zed-model');
    await create(org.id, 'openai', 'gpt-4o-mini');
    expect(await defaultSlug(org.id)).toBe('zed');

    // Signing in with OAuth converts the EXISTING api-key row in place. The
    // row keeps its id, but its credential becomes per-user — so the conversion
    // must clear its default flag before promotion can choose a successor.
    await ensureOAuthInferenceProvider({
      organizationId: org.id,
      slug: 'zed',
      kind: 'zed',
      defaultModel: 'zed-model',
    });

    expect(await defaultSlug(org.id)).toBe('openai');
    expect(await getOrgDefaultModel(org.id)).toBe('openai/gpt-4o-mini');
  });

  it('(j6) converting the ONLY provider to oauth leaves no default at all', async () => {
    const org = await newOrg();
    await create(org.id, 'zed', 'zed-model');
    expect(await defaultSlug(org.id)).toBe('zed');

    // No eligible successor exists. Default-less is CORRECT here — better than
    // a default every headless run would fail to authenticate.
    await ensureOAuthInferenceProvider({
      organizationId: org.id,
      slug: 'zed',
      kind: 'zed',
      defaultModel: 'zed-model',
    });

    expect(await defaultSlug(org.id)).toBeNull();
    expect(await getOrgDefaultModel(org.id)).toBeNull();
  });

  it('(j7) a row ALREADY oauth and still flagged default is repaired, not skipped', async () => {
    const org = await newOrg();
    await create(org.id, 'zed', 'zed-model');
    await create(org.id, 'openai', 'gpt-4o-mini');

    // First sign-in converts and demotes correctly (covered by j5).
    await ensureOAuthInferenceProvider({
      organizationId: org.id,
      slug: 'zed',
      kind: 'zed',
      defaultModel: 'zed-model',
    });
    expect(await defaultSlug(org.id)).toBe('openai');

    // Now recreate the legacy state this branch has to survive: an `oauth://`
    // row that is STILL flagged default. Rows predating the demote landed this
    // way, and a second ensureOAuthInferenceProvider call takes the
    // already-oauth path — which returns early. If that path does not clear the
    // flag, promotion cannot repair it either: the NOT EXISTS guard sees a
    // default present and no-ops, stranding the org on a credential only one
    // member can read.
    // Two statements: `inference_providers_org_default_live` is a partial
    // unique index, so a single UPDATE flipping both rows trips it mid-write.
    await getDb()`
      UPDATE inference_providers SET is_default = false
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
    `;
    await getDb()`
      UPDATE inference_providers SET is_default = true
      WHERE organization_id = ${org.id} AND slug = 'zed' AND deleted_at IS NULL
    `;
    expect(await defaultSlug(org.id)).toBe('zed');

    await ensureOAuthInferenceProvider({
      organizationId: org.id,
      slug: 'zed',
      kind: 'zed',
      defaultModel: 'zed-model',
    });

    expect(await defaultSlug(org.id)).toBe('openai');
    expect(await getOrgDefaultModel(org.id)).toBe('openai/gpt-4o-mini');
  });

  it('(k) an explicit model resolves with a row key and static OpenAI URL', async () => {
    const org = await newOrg();
    await create(org.id, 'openai');

    const target = await resolveCompletionTarget(org.id, 'openai/gpt-4o-mini');
    expect(target?.baseUrl).toBeTruthy();
    expect(target?.apiKey).toBe('sk-openai');
    expect(target?.model).toBe('gpt-4o-mini');
  });

  it('(l) an unrunnable default is replaced by the oldest runnable provider', async () => {
    const org = await newOrg();
    await create(org.id, 'openai', 'gpt-4o-mini');
    await create(org.id, 'z-ai', 'glm-4.6');
    await updateInferenceProviderCapabilities(org.id, 'openai', 'text', {});

    expect(await getOrgDefaultModel(org.id)).toBe('z-ai/glm-4.6');
    expect(await defaultSlug(org.id)).toBe('z-ai');
  });

  /**
   * The misrouting invariant, pinned to the resolver that now owns it.
   *
   * Sending a request to a guessed endpoint would mis-deliver it to the wrong
   * vendor with a model ID that vendor does not know — surfacing as a baffling
   * "400 <model> is not a valid model ID" rather than "this provider isn't
   * wired up". Returning null (feature skipped) is the correct failure: a
   * missing chip beats a wrong-vendor call. Mirrors `buildDynamicOpenAIModel`
   * in agent-worker/src/runtime/model-resolver.ts.
   */
  describe('misrouting invariant', () => {
    it('(m) an unregistered provider with no row base_url does NOT resolve', async () => {
      const org = await newOrg();
      // `kind` matches no registered module, so there is no upstream to
      // inherit — and it is not OpenAI, so it gets no public-endpoint default.
      await create(org.id, 'totally-unknown-vendor', 'some-model');

      expect(
        await resolveCompletionTarget(
          org.id,
          'totally-unknown-vendor/some-model'
        )
      ).toBeNull();
    });

    it('(n) a lookalike slug does not inherit the OpenAI public endpoint', async () => {
      const org = await newOrg();
      await create(org.id, 'openai-lookalike', 'gpt-4o-mini');

      expect(
        await resolveCompletionTarget(org.id, 'openai-lookalike/gpt-4o-mini')
      ).toBeNull();
    });

    it('(o) the org row base_url wins over any registered upstream', async () => {
      const org = await newOrg();
      const result = await createInferenceProvider({
        organizationId: org.id,
        slug: 'openai',
        kind: 'openai',
        apiKey: 'sk-tenant',
        capabilities: {
          text: { base_url: 'https://tenant.example/v1', model: 'gpt-4o-mini' },
        },
      });
      if ('error' in result) throw new Error('unexpected conflict');

      expect((await resolveCompletionTarget(org.id))?.baseUrl).toBe(
        'https://tenant.example/v1'
      );
    });

    it('(p) an OAuth-backed row has no API key, so it never resolves a target', async () => {
      const org = await newOrg();
      await ensureOAuthInferenceProvider({
        organizationId: org.id,
        slug: 'claude',
        kind: 'claude',
        defaultModel: 'claude-sonnet-5',
      });

      // Even asked for BY NAME, an oauth:// ref joins to no vault secret, so the
      // gateway transport declines rather than sending a keyless request.
      // Claude also uses the non-OpenAI `anthropic` protocol.
      expect(
        await resolveCompletionTarget(org.id, 'claude/claude-sonnet-5'),
      ).toBeNull();
    });

    /**
     * The POSITIVE half of the invariant. (m)/(n) prove an unregistered
     * provider resolves nothing; without this, a resolver that returned null
     * for EVERYTHING would still pass them. Provider rows need not define a
     * `base_url`, so registered providers must inherit their catalog upstream.
     */
    /**
     * A guardrail's `model` was historically a RAW model id posted to one
     * operator-configured base URL. Reinterpreting every override as
     * `<slug>/<model>` silently disabled chips for every existing value, so
     * both forms must resolve. The distinction cannot be "does it contain a
     * slash" — provider-native ids do (`anthropic/claude-sonnet-5`).
     */
    it('(q1) a BARE model override runs on the org default provider', async () => {
      const org = await newOrg();
      await create(org.id, 'openai', 'gpt-4o-mini');

      const target = await resolveCompletionTarget(org.id, 'gpt-4.1-mini');
      expect(target).not.toBeNull();
      expect(target?.model).toBe('gpt-4.1-mini');
      expect(target?.apiKey).toBe('sk-openai');
    });

    it('(q2) a provider-native override containing "/" is kept whole', async () => {
      const org = await newOrg();
      await create(org.id, 'openai', 'gpt-4o-mini');

      // `anthropic` is not a provider row in this org, so the whole string is
      // the model — NOT slug=anthropic. Splitting it would resolve nothing.
      const target = await resolveCompletionTarget(
        org.id,
        'anthropic/claude-sonnet-5',
      );
      expect(target?.model).toBe('anthropic/claude-sonnet-5');
      expect(target?.apiKey).toBe('sk-openai');
    });

    it('(q3) a qualified override still routes to THAT provider', async () => {
      const org = await newOrg();
      // z-ai is created FIRST, so it holds the org default; the override must
      // move both the model and the credentials to openai.
      await create(org.id, 'z-ai', 'glm-4.6');
      await create(org.id, 'openai', 'gpt-4o-mini');
      expect(await defaultSlug(org.id)).toBe('z-ai');

      const target = await resolveCompletionTarget(org.id, 'openai/gpt-4.1');
      expect(target?.model).toBe('gpt-4.1');
      expect(target?.apiKey).toBe('sk-openai');
    });

    it('(q) a REGISTERED provider with no row base_url inherits its registry upstream', async () => {
      const org = await newOrg();
      await create(org.id, 'groq', 'llama-3.3-70b-versatile');

      // The gateway registers config-driven provider modules at boot
      // (core-services `initializeClaudeServices`); a bare vitest process has
      // an empty registry, so stand one up the way that path does. Restored
      // afterwards — the registry is process-global.
      const registry = moduleRegistry as unknown as {
        modules: Map<string, ModuleInterface>;
      };
      const saved = new Map(registry.modules);
      try {
        moduleRegistry.register({
          name: 'groq-api-key',
          isEnabled: () => true,
          providerId: 'groq',
          providerDisplayName: 'Groq',
          sdkCompat: 'openai',
          // `providerId` + `getSecretEnvVarNames` are what mark this a
          // ModelProviderModule for getModelProviderModules()'s filter.
          getSecretEnvVarNames: () => [],
          getUpstreamConfig: () => ({
            slug: 'groq',
            upstreamBaseUrl: 'https://api.groq.com/openai/v1',
          }),
        } as unknown as ModuleInterface);

        const target = await resolveCompletionTarget(org.id);
        expect(target).not.toBeNull();
        // Not a guess and not OpenAI's endpoint — groq's declared upstream.
        expect(target?.baseUrl).toBe('https://api.groq.com/openai/v1');
        expect(target?.model).toBe('llama-3.3-70b-versatile');
        expect(target?.apiKey).toBe('sk-groq');
      } finally {
        registry.modules = saved;
      }
    });
  });

  /**
   * Multi-replica correctness (AGENTS.md hard invariant). Every
   * default-mutating path takes the same per-org `organization` row lock as its
   * FIRST statement, so concurrent writers serialize instead of racing.
   *
   * What the lock actually buys, precisely: the partial unique index
   * `inference_providers_org_default_live` already makes two live defaults
   * IMPOSSIBLE — it would abort the second write. So the lock is not what keeps
   * the count at one; it is what stops that abort from surfacing to a user as a
   * failed, unrelated "add provider" call. These tests therefore assert on
   * OUTCOMES (every concurrent call succeeds, exactly one default, org stays
   * resolvable) rather than on the lock's existence.
   */
  describe('concurrency', () => {
    it('(r) concurrent creates all succeed and yield exactly one default', async () => {
      const org = await newOrg();

      // Each of these promotes if the org has no default yet. Without
      // serialization several can pass that check together and collide on the
      // unique index — `create()` throws on any non-row result, so a lost race
      // fails this test rather than silently degrading.
      const results = await Promise.all([
        create(org.id, 'openai', 'gpt-4o-mini'),
        create(org.id, 'z-ai', 'glm-4.6'),
        create(org.id, 'groq', 'llama-3.3-70b-versatile'),
        create(org.id, 'xai', 'grok-4'),
      ]);
      expect(results).toHaveLength(4);

      const live = await listInferenceProviders(org.id);
      expect(live).toHaveLength(4);
      expect(live.filter((p) => p.isDefault)).toHaveLength(1);
      // Whichever won, the org resolves a runnable model — never null.
      expect(await getOrgDefaultModel(org.id)).not.toBeNull();
    });

    it('(s) concurrent delete + create keeps exactly one default', async () => {
      const org = await newOrg();
      await create(org.id, 'openai', 'gpt-4o-mini');
      await create(org.id, 'z-ai', 'glm-4.6');
      expect(await defaultSlug(org.id)).toBe('openai');

      // Racing the removal of THE default against a new arrival is the window
      // where a lost update would leave the org with zero (or two) defaults.
      await Promise.all([
        softDeleteInferenceProvider(org.id, 'openai'),
        create(org.id, 'groq', 'llama-3.3-70b-versatile'),
      ]);

      const live = await listInferenceProviders(org.id);
      expect(live.filter((p) => p.isDefault)).toHaveLength(1);
      expect(await getOrgDefaultModel(org.id)).not.toBeNull();
    });

    it('(t) concurrent lazy repairs promote once, not once per caller', async () => {
      const org = await newOrg();
      await create(org.id, 'openai', 'gpt-4o-mini');
      await create(org.id, 'z-ai', 'glm-4.6');
      // Force the legacy state where an org has providers but no default.
      await getDb()`
        UPDATE inference_providers
        SET is_default = false
        WHERE organization_id = ${org.id}
      `;

      const reads = await Promise.all(
        Array.from({ length: 5 }, () => getOrgDefaultModel(org.id)),
      );

      // Every concurrent reader agrees, and the repair happened once.
      expect(new Set(reads).size).toBe(1);
      expect(reads[0]).toBe('openai/gpt-4o-mini');
      const live = await listInferenceProviders(org.id);
      expect(live.filter((p) => p.isDefault)).toHaveLength(1);
    });
  });
});
