/**
 * Shared cloud-provider preflight for chat ingress and agent model reporting.
 * This checks configured credentials and routes, not upstream health.
 * Callers without a catalog cannot check provider state.
 */

import type { ModelProviderModule } from "../modules/module-system.js";
import type { ProviderCatalogService } from "./provider-catalog.js";

type ModelPolicyCatalog = Pick<
  ProviderCatalogService,
  "getModelPolicy" | "findProviderForModel"
>;

function parseProviderFromModelRef(modelRef: string): string | null {
  const trimmed = modelRef.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return null;
  return trimmed.slice(0, slash);
}

export function webOriginFromGateway(publicGatewayUrl: string): string {
  const base = publicGatewayUrl.replace(/\/$/, "");
  return base.endsWith("/lobu") ? base.slice(0, -"/lobu".length) : base;
}

/**
 * Is this provider module usable RIGHT NOW for this agent/org — i.e. it has a
 * credential (system key or org-shared/agent key) AND a routable proxy mapping?
 * Both checks matter: a provider can be "installed" yet have no key, and a keyed
 * provider can still fail to produce a route (misconfigured upstream).
 */
async function providerIsRoutable(
  provider: ModelProviderModule,
  ctx: {
    publicGatewayUrl: string;
    agentId: string;
    organizationId: string;
    userId: string;
  }
): Promise<boolean> {
  const credentialCtx = {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
  };
  const hasCredentials =
    provider.hasSystemKey() ||
    (await provider.hasCredentials(ctx.agentId, credentialCtx));
  if (!hasCredentials) return false;
  const proxyBaseUrl = `${webOriginFromGateway(ctx.publicGatewayUrl)}/api/proxy`;
  const mappings = provider.getProxyBaseUrlMappings(
    proxyBaseUrl,
    ctx.agentId,
    credentialCtx
  );
  return Object.keys(mappings).length > 0;
}

type ModelProviderResolution =
  | { kind: "ok" }
  | { kind: "fallback"; model: string; from: string; to: string }
  // Callers render the CTA through the shared card path.
  | {
      kind: "error";
      text: string;
      cta: "agent-settings" | "provider-connect";
      provider: string;
      model: string;
    };

/**
 * Preflight the model a message will run on. Order of outcomes:
 *  - ok: the configured EXACT ref is allowed and its provider is routable.
 *  - fallback: it isn't routable (or, under a non-empty list, not allowed), but
 *    the agent has a listed ALTERNATE whose exact ref is routable → run that
 *    alternate. Alternates are tried in the agent's models[] order.
 *  - error: nothing usable → surface a setup link.
 *
 * The gate is EXACT: when the agent has a non-empty `models` list, a ref that
 * isn't in that list is rejected even if its PROVIDER prefix is listed — so
 * `models:["openai/gpt-5"]` does not admit `openai/other`. There is NO
 * org-default tail: an unroutable listed model falls back only to another
 * LISTED alternate, never to an unlisted model.
 *
 * `userId` is the principal whose credentials are checked. Credential lookup
 * already falls back to the agent owner's profiles for any other principal
 * (`AuthProfilesManager.listAgentOwnerProfiles`), so callers without a sender
 * pass the owner.
 */
export async function resolveModelProvider(params: {
  catalog: ModelPolicyCatalog | undefined;
  publicGatewayUrl: string;
  agentId: string;
  organizationId?: string;
  userId: string;
  modelRef?: unknown;
}): Promise<ModelProviderResolution> {
  if (typeof params.modelRef !== "string") return { kind: "ok" };
  const modelRef = params.modelRef.trim();
  const providerId = parseProviderFromModelRef(modelRef);
  if (!providerId) return { kind: "ok" };

  const catalog = params.catalog;
  if (!catalog || !params.organizationId) return { kind: "ok" };
  const organizationId = params.organizationId;

  const { modules, allowedRefs } = await catalog.getModelPolicy(
    params.agentId,
    organizationId
  );

  const routableCtx = {
    publicGatewayUrl: params.publicGatewayUrl,
    agentId: params.agentId,
    organizationId,
    userId: params.userId,
  };

  // A concrete ref is usable when (a) it clears the exact allow-list — always,
  // when the agent allows all providers — and (b) its provider module is
  // present and routable (keyed + a proxy route builds).
  const refIsAllowed = (ref: string): boolean =>
    allowedRefs === null || allowedRefs.includes(ref);
  const providerForRef = async (
    ref: string
  ): Promise<ModelProviderModule | undefined> =>
    catalog.findProviderForModel(ref, modules);

  // Happy path: the exact ref is allowed AND its provider is routable.
  if (refIsAllowed(modelRef)) {
    const provider = await providerForRef(modelRef);
    if (provider && (await providerIsRoutable(provider, routableCtx))) {
      return { kind: "ok" };
    }
  }

  // The configured ref can't run. Fall back to the agent's listed ALTERNATES,
  // in order — the exact refs the agent declared (not a provider's catalog
  // default), so multiple same-provider entries act as ordered fallbacks. When
  // the agent allows all providers there is no alternate list to walk; the
  // original ref was the only ask, so we go straight to the setup link.
  if (allowedRefs !== null) {
    for (const altRef of allowedRefs) {
      if (altRef === modelRef) continue;
      const altProvider = await providerForRef(altRef);
      if (!altProvider) continue;
      if (!(await providerIsRoutable(altProvider, routableCtx))) continue;
      return {
        kind: "fallback",
        model: altRef,
        from: modelRef,
        to: altProvider.providerId,
      };
    }
  }

  // Genuinely nothing usable. The two reasons take DIFFERENT fixes, so they map
  // to different CTA kinds: a model that isn't in the agent's allow-list is
  // fixed by picking an allowed one (agent-settings); a provider with no
  // credentials/route is fixed by connecting it (provider-connect). The caller
  // renders the text + CTA through the shared card path.
  const modelNotAllowed = !refIsAllowed(modelRef);
  const text = modelNotAllowed
    ? `I can't run this yet: the model \`${modelRef}\` isn't in this agent's allowed model list. Pick an allowed model to continue.`
    : `I can't run this yet: the provider for \`${modelRef}\` isn't connected or has no credentials. Connect it to continue.`;
  return {
    kind: "error",
    text,
    cta: modelNotAllowed ? "agent-settings" : "provider-connect",
    provider: providerId,
    model: modelRef,
  };
}
