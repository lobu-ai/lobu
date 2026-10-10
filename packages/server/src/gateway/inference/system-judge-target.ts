/**
 * Operator-owned target resolution for the judges.
 *
 * The judges are policy controls, so their credential is the DEPLOYMENT's, not
 * the tenant's. `resolveCompletionTarget` reads the org's `inference_providers`
 * rows, which is right for the fail-open enrichment features but wrong here: a
 * tenant who supplies the key behind the model that polices their own agent
 * controls the control. This resolver reads `config/providers.json` plus the
 * operator's environment instead, exactly like fresh-agent system-key
 * resolution does.
 *
 * A tenant may still NAME a model: an egress guardrail's own `model` field,
 * which reaches the judge as `ResolvedJudgeRule.judgeModel`. That ref only
 * resolves when it points at a provider this deployment already holds a system
 * key for, so the choice is bounded by the operator's own installed providers.
 * A ref naming anything else resolves to null, and the judge fails closed.
 */

import { createLogger, getErrorMessage } from "@lobu/core";
import type { ProviderConfigEntry } from "@lobu/core";
import { resolveEnv } from "../auth/mcp/string-substitution.js";
import {
  ProviderRegistryService,
  resolveProviderRegistryPath,
} from "../services/provider-registry-service.js";
import {
  type GatewayCompletionTarget,
  splitModelRef,
  isGatewayCompletionProtocol,
} from "./gateway-completion.js";

const logger = createLogger("system-judge-target");

/**
 * Registry instance cached per resolved path. A per-call instance re-read and
 * re-parsed config/providers.json from disk on every judge call, because the
 * service's own cache dies with the instance, and the judge sits on the egress
 * path — that is a disk read per proxied request.
 *
 * Keyed on the path rather than a bare singleton: the path is derived from the
 * environment, so a plain singleton would keep serving the first path it ever
 * saw and silently ignore a later one. That turns an unreadable registry into a
 * stale-but-valid answer, which is the opposite of failing closed.
 */
let cached:
  | { path: string | undefined; service: ProviderRegistryService }
  | undefined;
function getRegistry(): ProviderRegistryService {
  const path = resolveProviderRegistryPath();
  let entry = cached;
  if (!entry || entry.path !== path) {
    entry = { path, service: new ProviderRegistryService(path) };
    cached = entry;
  }
  return entry.service;
}

/**
 * Why a judge target could not be resolved. Both values are MISCONFIGURATION,
 * never a transient fault — the caller must fail closed without tripping the
 * circuit breaker, whose cooldown exists for upstreams that might recover.
 */
export type SystemJudgeTargetFailure =
  | "unqualified-ref"
  | "no-system-provider";

export type SystemJudgeTargetResult =
  | { ok: true; target: GatewayCompletionTarget }
  | { ok: false; reason: SystemJudgeTargetFailure; detail: string };

/**
 * Resolve `<slug>/<model>` against this deployment's system-key providers.
 *
 * Deliberately requires a QUALIFIED ref. `resolveCompletionTarget` can accept a
 * bare model id because it has an org default provider to fall back on; there
 * is no equivalent operator default, and guessing one would post the request to
 * a vendor that does not know the model. For a fail-closed control, "I cannot
 * tell which provider you meant" must be a denial, not a guess.
 */
export async function resolveSystemJudgeTarget(
  modelRef: string
): Promise<SystemJudgeTargetResult> {
  const ref = modelRef.trim();
  const parts = splitModelRef(ref);
  if (!parts) {
    return {
      ok: false,
      reason: "unqualified-ref",
      detail: `judge model "${ref}" is not a "<provider>/<model>" ref; an operator-owned judge cannot infer the provider`,
    };
  }

  let configs: Record<string, ProviderConfigEntry> = {};
  try {
    configs = await getRegistry().getProviderConfigs();
  } catch (err) {
    // Unreadable registry means NO provider is verifiably operator-keyed.
    // Fail closed rather than falling through to some other credential source.
    return {
      ok: false,
      reason: "no-system-provider",
      detail: `provider registry unreadable: ${getErrorMessage(err)}`,
    };
  }

  const config = configs[parts.slug];
  if (!config) {
    return {
      ok: false,
      reason: "no-system-provider",
      detail: `no provider "${parts.slug}" in the provider registry`,
    };
  }

  // The system key is the whole point: an org row must never satisfy this.
  const apiKey = config.envVarName ? resolveEnv(config.envVarName) : undefined;
  if (!apiKey) {
    return {
      ok: false,
      reason: "no-system-provider",
      detail: `provider "${parts.slug}" has no deployment credential (${config.envVarName ?? "no envVarName"} unset)`,
    };
  }

  // Use the shared client's protocol gate so judges and enrichment stay aligned.
  if (!isGatewayCompletionProtocol(config.sdkCompat)) {
    return {
      ok: false,
      reason: "no-system-provider",
      detail: `provider "${parts.slug}" speaks "${config.sdkCompat ?? "unknown"}", not the OpenAI-compatible protocol`,
    };
  }

  const baseUrl = config.upstreamBaseUrl;
  if (!baseUrl) {
    return {
      ok: false,
      reason: "no-system-provider",
      detail: `provider "${parts.slug}" declares no upstream base URL`,
    };
  }

  logger.debug(
    { slug: parts.slug, model: parts.model },
    "resolved operator-owned judge target"
  );

  return {
    ok: true,
    target: {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey,
      model: parts.model,
      ...(config.sdkCompat === "openai-responses" ? { sdkCompat: config.sdkCompat } : {}),
    },
  };
}
