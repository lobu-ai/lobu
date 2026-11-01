/** Shared inference-provider actions for REST, MCP and ClientSDK. OAuth stays interactive. */
import { isSdkCompat } from '@lobu/core';
import {
  CreateInferenceProviderAction, DeleteInferenceProviderAction, ListInferenceProvidersAction,
  ManageInferenceProvidersSchema, ManageInferenceProvidersResultSchema,
  RotateInferenceProviderKeyAction, SetDefaultInferenceProviderAction,
  SetInferenceProviderCapabilityAction, UpdateInferenceProviderAction,
  type InferenceProviderCreateInput, type InferenceProviderUpdateInput,
  type InferenceProviderSetDefaultInput, type InferenceProviderSetCapabilityInput,
  type InferenceProviderRotateKeyInput, type InferenceProviderDeleteInput,
} from '@lobu/core/contracts/tools/manage-inference-providers';
import { type DbClient, getDb } from '../../db/client';
import { buildProviderCatalog } from '../../gateway/auth/provider-catalog';
import { getOAuthProviderConfig, getOAuthProviderConfigs } from '../../gateway/auth/oauth/providers';
import { orgBucketAgentId } from '../../gateway/auth/settings/user-auth-profile-store';
import { ProviderRegistryService, resolveProviderRegistryPath } from '../../gateway/services/provider-registry-service';
import { getLobuCoreServices } from '../../lobu/gateway';
import { orgContext } from '../../lobu/stores/org-context';
import {
  createInferenceProvider, ensureOAuthInferenceProvider, getInferenceProviderBySlug,
  listInferenceProviders, lockInferenceProviderDefaults, rotateInferenceProviderKey,
  setInferenceProviderDefault, softDeleteInferenceProvider, updateInferenceProviderCapabilities,
  updateInferenceProviderCoreFields, validateCapabilityBlock,
  type InferenceProviderRow,
} from '../../lobu/stores/provider-secrets';
import { ToolUserError } from '../../utils/errors';
import logger from '../../utils/logger';
import type { ToolContext } from '../registry';
import { enforceRoleScopeAccess } from '../access-control';
import { action, defineActionTool } from './action-tool';
import { insertToolConfigChange } from './helpers/config-audit';

export { ManageInferenceProvidersSchema, ManageInferenceProvidersResultSchema };
const tool = defineActionTool('manage_inference_providers', {
  list: action(ListInferenceProvidersAction, list),
  create: action(CreateInferenceProviderAction, create),
  update: action(UpdateInferenceProviderAction, update),
  set_default: action(SetDefaultInferenceProviderAction, setDefault),
  set_capability: action(SetInferenceProviderCapabilityAction, setCapability),
  rotate_key: action(RotateInferenceProviderKeyAction, rotateKey),
  delete: action(DeleteInferenceProviderAction, remove),
});
export const manageInferenceProviders = tool.run;

function summary(row: InferenceProviderRow) {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    displayName: row.displayName,
    capabilities: row.capabilities,
    hasCustomUpstream: row.hasCustomUpstream,
    status: row.status,
    createdAt: row.createdAt,
  };
}

function providerAuditState(
  row: Pick<InferenceProviderRow,
    'slug' | 'kind' | 'displayName' | 'capabilities' | 'hasCustomUpstream' | 'status' | 'isDefault'
  > | null,
): Record<string, unknown> | null {
  return row ? {
    slug: row.slug,
    kind: row.kind,
    displayName: row.displayName,
    capabilities: row.capabilities,
    hasCustomUpstream: row.hasCustomUpstream,
    status: row.status,
    isDefault: row.isDefault,
  } : null;
}

export async function providerAuditTransaction<T>(
  ctx: ToolContext,
  slug: string,
  mutate: (tx: DbClient, before: Record<string, unknown> | null) => Promise<T>,
): Promise<T> {
  // Org-shared credentials never inherit the action router's userless system bypass.
  await enforceRoleScopeAccess('admin', ctx, 'Inference-provider management');
  const orgId = ctx.organizationId;
  return getDb().begin(async (tx) => {
    await lockInferenceProviderDefaults(tx, orgId);
    const before = providerAuditState(await getInferenceProviderBySlug(orgId, slug, tx));
    const providersBefore = await listInferenceProviders(orgId, tx);
    const result = await mutate(tx, before);
    const providersAfter = await listInferenceProviders(orgId, tx);
    for (const previous of providersBefore) {
      if (previous.slug === slug) continue;
      const next = providersAfter.find(provider => provider.slug === previous.slug);
      if (!next || previous.isDefault === next.isDefault) continue;
      await insertToolConfigChange(ctx, {
        resourceKind: 'inference-provider',
        resourceId: next.slug,
        op: 'updated',
        summary: `Inference provider '${next.slug}' ${next.isDefault ? 'promoted to' : 'cleared as'} org default`,
        before: providerAuditState(previous),
        state: providerAuditState(next),
        changedFields: ['isDefault'],
      }, tx);
    }
    return result;
  });
}

async function ensureVisibleOAuthProvidersForUser(ctx: ToolContext): Promise<void> {
  const orgId = ctx.organizationId;
  const user = ctx.tokenType === 'session' && ctx.userId ? { id: ctx.userId } : undefined;
  if (!user?.id) return;
  const authProfilesManager = getLobuCoreServices()?.getAuthProfilesManager?.();
  if (!authProfilesManager) return;

  for (const config of Object.values(getOAuthProviderConfigs())) {
    const profiles = await orgContext.run({ organizationId: orgId }, () =>
      authProfilesManager.getProviderProfiles(
        orgBucketAgentId(orgId),
        config.id,
        user.id
      )
    );
    if (profiles.length === 0) continue;
    await ensureOAuthInferenceProvider({
      organizationId: orgId,
      slug: config.id,
      kind: config.id,
      displayName: config.name,
      defaultModel: config.defaultModel,
      createdBy: user.id,
    });
  }
}

async function list(_args: object, ctx: ToolContext) {
  await ensureVisibleOAuthProvidersForUser(ctx);
  return { providers: await listInferenceProviders(ctx.organizationId) };
}

async function create(body: InferenceProviderCreateInput, ctx: ToolContext) {
  const orgId = ctx.organizationId;
  const slug = body.slug.trim();
  const kind = body.kind.trim();
  const apiKey = body.apiKey.trim();
  if (!kind) {
    throw new ToolUserError('Body must include a `kind` string', 400);
  }
  if (!apiKey) {
    throw new ToolUserError('Body must include a non-empty `apiKey` string', 400);
  }
  for (const [modality, block] of Object.entries(body.capabilities ?? {})) {
    const error = validateCapabilityBlock(modality, block);
    if (error) throw new ToolUserError(error, 400);
  }
  // Known catalog kinds must accept API keys AND speak a routable wire
  // protocol — a subscription kind can speak one and still have nothing an API
  // key may reach. Unknown kinds pass because custom endpoints are synthesized
  // as OpenAI-compatible providers. Read the default from configs because the
  // catalog contains only provider modules registered in this process.
  let catalogDefaultModel: string | undefined;
  // The upstream this `kind` already resolves to. An alias row (slug !== kind)
  // with no base_url of its own is synthesized against it, so its presence is
  // what decides whether such a row will route.
  let catalogBaseUrl: string | undefined;
  try {
    const registry = new ProviderRegistryService(resolveProviderRegistryPath());
    const configs = await registry.getProviderConfigs();
    const catalog = buildProviderCatalog(configs);
    const entry = catalog.find((e) => e.slug === kind);
    if (
      entry &&
      (!entry.supportedAuthTypes.includes("api-key") ||
        !isSdkCompat(entry.sdkCompat))
    ) {
      throw new ToolUserError(`Provider '${kind}' can't be added with an API key — it signs in instead.`, 400);
    }
    catalogDefaultModel = configs[kind]?.defaultModel ?? undefined;
    // The EXACT expression `getModelPolicy` evaluates — argless
    // `buildProviderCatalog()`, then the same auth-method and `sdkCompat`
    // gates. These two must agree: a text model is what
    // `promoteOldestRunnableProvider` keys on, so a row seeded as routable and
    // then dropped at routing becomes the org DEFAULT and breaks every
    // allow-all agent in the org.
    //
    // `configs[kind].upstreamBaseUrl` looks equivalent and is not. It gives
    // `claude` a URL, but claude registers as an OAuth module rather than an
    // ApiKeyProviderModule, so the catalog reports "" and synthesis refuses
    // it — trusting providers.json would seed exactly that unroutable row.
    const catalogEntry = buildProviderCatalog().find((e) => e.slug === kind);
    catalogBaseUrl =
      catalogEntry?.supportedAuthTypes.includes("api-key") &&
      isSdkCompat(catalogEntry.sdkCompat)
        ? catalogEntry.baseUrl || undefined
        : undefined;
  } catch (err) {
    if (err instanceof ToolUserError) throw err;
    // Fail open on catalog-load errors: don't block creation on a metadata
    // read. The synthesize path still gates routing downstream.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[inference-providers create] catalog gate check failed; allowing"
    );
  }

  // Seed the curated model so each API caller need not duplicate catalog
  // defaults — and so a row cannot be born unroutable.
  //
  // `resolveInferenceProviderConfig` selects `capabilities -> <modality>` and
  // returns null when the block is absent, so `resolveUrlInvariant` answers
  // `no-custom-upstream` and the row's own org key is NEVER read. With no
  // deployment env key that resolves to no credential at all: the provider is
  // dropped from routing and the model goes upstream with its slug prefix
  // intact, surfacing as an opaque "400 invalid model ID".
  //
  // Merge into the caller's text block rather than replacing it — dropping a
  // tenant `base_url` would silently re-point the org at the catalog URL.
  //
  // Seed ONLY a row that will actually route. A text model is also the
  // predicate `promoteOldestRunnableProvider` uses to choose the org default,
  // so seeding an unroutable row would promote it to default and break every
  // allow-all agent in the org. `getModelPolicy` keys its module map by the
  // row's SLUG, so the row resolves to a module only when one of:
  //   - slug === kind    → the catalog's own static module answers to it,
  //   - a text base_url  → `synthesizeOrgProviderModule` routes there, or
  //   - the kind has a catalog upstream → synthesis falls back to it, which is
  //     what makes an alias slug (slug=my-gemini, kind=gemini) routable.
  // Only a kind the catalog does not know at all matches none of these; such a
  // row is dropped by the policy and must not look configured.
  const requestedCapabilities =
    body.capabilities ?? {};
  const hasTextModel = !!requestedCapabilities.text?.model?.trim();
  const wouldRoute =
    slug === kind ||
    !!requestedCapabilities.text?.base_url?.trim() ||
    !!catalogBaseUrl;
  const capabilities =
    hasTextModel || !catalogDefaultModel || !wouldRoute
      ? requestedCapabilities
      : {
          ...requestedCapabilities,
          text: {
            ...requestedCapabilities.text,
            model: catalogDefaultModel,
          },
        };
  if (!capabilities.text?.model) {
    // Nothing seeded: unknown kind, no catalog default, or a kind with no
    // upstream to fall back to. Say so at creation — otherwise the row's only
    // symptom is a far-away 400 naming a different provider.
    logger.warn(
      { slug, kind, wouldRoute },
      "[inference-providers create] created with no text model — this provider will not route until `capabilities.text.model` is set (a row whose `kind` is not in the catalog also needs `capabilities.text.base_url`)"
    );
  }

  return providerAuditTransaction(ctx, slug, async (tx, before) => {
    const result = await createInferenceProvider({
      organizationId: orgId,
      slug,
      kind,
      displayName: body.displayName ?? null,
      apiKey,
      capabilities,
      createdBy: ctx.userId,
    }, tx);
    if ('error' in result) {
      throw new ToolUserError(`A provider with slug '${result.slug}' already exists`, 409);
    }
    await insertToolConfigChange(ctx, {
      before,
      resourceKind: 'inference-provider',
      resourceId: result.slug,
      op: 'created',
      summary: `Inference provider '${result.slug}' created`,
      state: providerAuditState(result),
    }, tx);
    return { provider: { ...summary(result), isDefault: result.isDefault } };
  });
}

async function update(args: InferenceProviderUpdateInput, ctx: ToolContext) {
  return providerAuditTransaction(ctx, args.slug, async (tx, before) => {
    // A blank name leaves the stored name unchanged, as the REST route always did.
    const result = await updateInferenceProviderCoreFields(
      ctx.organizationId,
      args.slug,
      { displayName: args.displayName?.trim() || undefined },
      tx,
    );
    if (!result) {
      throw new ToolUserError('Provider not found', 404);
    }
    await insertToolConfigChange(ctx, {
      before,
      resourceKind: 'inference-provider',
      resourceId: result.slug,
      op: 'updated',
      summary: `Inference provider '${result.slug}' renamed`,
      state: providerAuditState(result),
      changedFields: ['displayName'],
    }, tx);
    return { provider: summary(result) };
  });
}

async function setDefault(args: InferenceProviderSetDefaultInput, ctx: ToolContext) {
  const { slug } = args;
  return providerAuditTransaction(ctx, slug, async (tx, before) => {
    const result = await setInferenceProviderDefault(ctx.organizationId, slug, tx);
    if (result === 'not_found') {
      throw new ToolUserError('Provider not found', 404);
    }
    if (result === 'no_text_model') {
      throw new ToolUserError(
        `Provider '${slug}' has no text model configured, so it cannot be the org default. Set one with: lobu providers set-capability ${slug} text --model <model>`,
        400,
      );
    }
    if (result === 'oauth_provider') {
      throw new ToolUserError(
        `Provider '${slug}' is signed in with OAuth, so its credential belongs to one user. An org default is inherited by every member and by headless Automation runs, which cannot read that token. Use a provider added with an API key instead.`,
        400,
      );
    }
    await insertToolConfigChange(ctx, {
      before,
      resourceKind: 'inference-provider',
      resourceId: slug,
      op: 'updated',
      summary: `Inference provider '${slug}' set as org default`,
      state: providerAuditState(await getInferenceProviderBySlug(ctx.organizationId, slug, tx)),
      changedFields: ['isDefault'],
    }, tx);
    return { success: true as const, slug, isDefault: true as const };
  });
}

async function setCapability(args: InferenceProviderSetCapabilityInput, ctx: ToolContext) {
  const error = validateCapabilityBlock(args.modality, args.block);
  if (error) throw new ToolUserError(error, 400);
  return providerAuditTransaction(ctx, args.slug, async (tx, before) => {
    const result = await updateInferenceProviderCapabilities(
      ctx.organizationId, args.slug, args.modality, args.block, tx,
    );
    if (!result) {
      throw new ToolUserError('Provider not found', 404);
    }
    await insertToolConfigChange(ctx, {
      before,
      resourceKind: 'inference-provider',
      resourceId: result.slug,
      op: 'updated',
      summary: `Inference provider '${result.slug}' ${args.modality} capabilities updated`,
      state: providerAuditState(result),
      changedFields: [`capabilities.${args.modality}`],
    }, tx);
    return { provider: summary(result) };
  });
}

async function rotateKey(args: InferenceProviderRotateKeyInput, ctx: ToolContext) {
  const value = args.value.trim();
  if (!value) {
    throw new ToolUserError('Body must include a non-empty `value` string', 400);
  }
  return providerAuditTransaction(ctx, args.slug, async (tx, before) => {
    const result = await rotateInferenceProviderKey(ctx.organizationId, args.slug, value, tx);
    if (result === 'not_found') {
      throw new ToolUserError('Provider not found', 404);
    }
    if (result === 'oauth_provider') {
      throw new ToolUserError(
        `Provider '${args.slug}' signs in via OAuth — it has no API key to rotate`,
        400,
      );
    }
    await insertToolConfigChange(ctx, {
      before,
      resourceKind: 'inference-provider',
      resourceId: args.slug,
      op: 'updated',
      summary: `Inference provider '${args.slug}' API key rotated`,
      state: providerAuditState(await getInferenceProviderBySlug(ctx.organizationId, args.slug, tx)),
      changedFields: ['apiKey'],
    }, tx);
    return { success: true as const };
  });
}

async function remove(args: InferenceProviderDeleteInput, ctx: ToolContext) {
  await providerAuditTransaction(ctx, args.slug, async (tx, before) => {
    if (!await softDeleteInferenceProvider(ctx.organizationId, args.slug, tx)) {
      throw new ToolUserError('Provider not found', 404);
    }
    await insertToolConfigChange(ctx, {
      before,
      resourceKind: 'inference-provider',
      resourceId: args.slug,
      op: 'deleted',
      summary: `Inference provider '${args.slug}' deleted`,
      state: null,
    }, tx);
  });
  // Only the interactive session may revoke its own subscription profile.
  const config = getOAuthProviderConfig(args.slug);
  const manager = getLobuCoreServices()?.getAuthProfilesManager?.();
  if (ctx.tokenType === 'session' && !ctx.headlessResult && ctx.userId && config && manager) {
    await orgContext.run({ organizationId: ctx.organizationId }, () =>
      manager.deleteProviderProfiles(orgBucketAgentId(ctx.organizationId), config.id, { userId: ctx.userId! }));
  }
  return { success: true as const };
}
