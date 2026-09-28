import type { AgentSettings } from "@lobu/core";
import { isUnresolvedModelRef } from "../model-sentinel.js";

/**
 * Enforce the EXACT-model allow-list against a requested model ref. This is the
 * pure core of the universal dispatch gate applied in the deployment manager —
 * the single point every dispatch lane (direct API, Listen bridge,
 * chat-instance, automation HTTP, scheduled-job direct enqueue) converges on
 * before a worker runs.
 *
 * Decision B semantics — NO org-default escalation:
 *   - `allowedRefs === null` (allow-all) ⇒ the requested model passes unchanged
 *     (but an `__unresolved__` sentinel is never a real model → dropped).
 *   - `allowedRefs === []` (deny-all — e.g. a not-found agent) ⇒ nothing
 *     qualifies, so any requested model is dropped (fail closed).
 *   - requested ref is EXACTLY in the list ⇒ passes unchanged, PROVIDED it is
 *     routable (when a routability predicate is supplied); an exact-but-
 *     unroutable ref is replaced with the first routable listed ref (fail
 *     closed if none), never sent dead to the worker.
 *   - requested ref is NOT in the list ⇒ replaced with the first LISTED ref that
 *     is non-sentinel AND routable. If none qualifies (all sentinels /
 *     none routable), the model is dropped (undefined) so the run FAILS CLOSED —
 *     it never escalates to an unlisted model.
 *
 * Provider health, when an `isHealthy` predicate is supplied, is a tie-breaker
 * layered on top (see the parameter doc).
 *
 * Returns the effective model ref, or undefined to run with no model (fail
 * closed / auto-detect for the allow-all case).
 */
export function enforceModelAllowList(
  requestedModel: string | undefined,
  allowedRefs: string[] | null,
  /**
   * Optional routability predicate. When provided, the REPLACEMENT for a
   * disallowed/sentinel requested model is the first listed ref that is BOTH
   * non-sentinel AND routable (`isRoutable(ref) === true`) — not merely the
   * first non-sentinel. The enqueue gate and friendly Listen bridge share
   * this rule: a list like ["xai/grok-4","openai/gpt-5"] with
   * xai UNCREDENTIALED and openai credentialed replaces onto openai/gpt-5, not a
   * dead xai/grok-4. Omitted ⇒ first non-sentinel (structural check only).
   */
  isRoutable?: (ref: string) => boolean,
  /**
   * Optional provider-health predicate. Health only ever REORDERS candidates
   * that are already routable — it never removes the last one. A quota-exhausted
   * provider still holds a valid key, so `isRoutable` cannot tell it apart from
   * a working one; without this, an agent listing
   * ["qwen/…" (429), "xai/grok-4" (active)] routes every turn to the dead head
   * even though the ordered list already names the alternate.
   *
   * Deliberately a PREFERENCE, not a filter. `inference_providers.status` is
   * written best-effort off an upstream response, so it can be stale or a false
   * positive; letting it exclude a candidate would turn a cosmetic mistake into
   * a stranded workspace. The strongest thing it may do is lose a tie to a
   * healthy sibling in the same list.
   */
  isHealthy?: (ref: string) => boolean,
): { model: string | undefined; replaced: boolean } {
  if (!requestedModel) return { model: undefined, replaced: false };
  // The first LISTED ref that is a legal replacement: non-sentinel, and (when a
  // routability predicate is supplied) routable. Only such a ref may substitute
  // for a disallowed/sentinel request; otherwise we fail closed.
  const isReplacement = (r: string): boolean =>
    !isUnresolvedModelRef(r) && (isRoutable ? isRoutable(r) : true);
  const replacements = allowedRefs?.filter(isReplacement) ?? [];
  // Among legal replacements, a healthy provider wins.
  const firstHealthyReplacement = isHealthy
    ? replacements.find((r) => isHealthy(r))
    : undefined;
  const firstReplacement = firstHealthyReplacement ?? replacements[0];

  // A sentinel is never a real, routable model. Drop it, but — for a MIXED
  // list like ["x/__unresolved__","openai/gpt-4o"] — replace it with the first
  // listed real+routable model rather than failing closed. Only when NO such
  // ref exists (all-sentinel, or none routable) do we fail closed (undefined).
  if (isUnresolvedModelRef(requestedModel)) {
    return { model: firstReplacement, replaced: true };
  }
  if (allowedRefs === null) return { model: requestedModel, replaced: false };
  if (allowedRefs.includes(requestedModel)) {
    // Exact-listed — but it may still be UNROUTABLE (uncredentialed provider).
    // An exact-listed request passes unchanged ONLY when there's no routability
    // predicate OR it is routable; otherwise fall through to the first routable
    // listed replacement (fail closed if none). Without this, an exact-but-dead
    // ref (e.g. requested "xai/grok-4" with xai uncredentialed) would reach the
    // worker and fail at run.
    if (!isRoutable || isRoutable(requestedModel)) {
      // Routable — but an UNHEALTHY provider yields to a listed healthy sibling.
      if (
        isHealthy &&
        !isHealthy(requestedModel) &&
        firstHealthyReplacement !== undefined
      ) {
        return { model: firstHealthyReplacement, replaced: true };
      }
      return { model: requestedModel, replaced: false };
    }
    return { model: firstReplacement, replaced: true };
  }
  // Out-of-list: replace with the first listed real+routable model; if none
  // qualifies (all sentinels / none routable), firstReplacement is undefined →
  // fail closed.
  return { model: firstReplacement, replaced: true };
}

/**
 * Reads the org's default model — the fallback tail. Injected (not imported) so
 * the resolver stays pure and DB-agnostic; the runtime passes
 * `getOrgDefaultModel` from the provider-secrets store.
 */
export type OrgDefaultModelReader = (
  organizationId: string,
) => Promise<string | null>;

/**
 * The agent-layer model ref — the middle of the layered fallback
 * `automation → agent → org default`. Pure and synchronous: it returns the head
 * of the agent's `models` list (an explicit `provider/model` ref), or undefined
 * when the list is empty/absent. The caller composes the tail:
 * `resolveEffectiveModelRef(settings) ?? await getOrgDefaultModel(orgId)`.
 *
 * The per-automation override sits ABOVE this and is injected at run-enqueue into
 * `agentOptions.model` (so it wins before this is consulted).
 */
export function resolveEffectiveModelRef(
  settings: Pick<AgentSettings, "models"> | null | undefined,
): string | undefined {
  const model = settings?.models?.[0]?.trim();
  return model ? model : undefined;
}

/**
 * Compose the full layered fallback for a run: the caller has already applied any
 * per-automation override (it wins upstream, injected into the run's `model`
 * option), so this resolves `agent.models[0] → org default`. Returns undefined
 * only when the agent pins nothing AND the org has no default — the worker then
 * surfaces its actionable "no model" error. `organizationId` may be undefined
 * (org-agnostic contexts), in which case only the agent layer is consulted.
 */
export async function composeEffectiveModelRef(
  settings: Pick<AgentSettings, "models"> | null | undefined,
  organizationId: string | undefined,
  getOrgDefaultModel: OrgDefaultModelReader,
): Promise<string | undefined> {
  const agentModel = resolveEffectiveModelRef(settings);
  if (agentModel) return agentModel;
  if (!organizationId) return undefined;
  return (await getOrgDefaultModel(organizationId)) ?? undefined;
}
