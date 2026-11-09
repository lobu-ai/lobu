/**
 * Per-modality inference-provider config resolved from an org's
 * `inference_providers` row (see db/migrations/20260702170000_inference_providers.sql).
 *
 * The capability services (image-generation, transcription STT/TTS) consume
 * this seam instead of resolving the org row + secret themselves — org
 * resolution (agentId → organizationId) and the store read stay in
 * `core-services.ts`, which already owns `resolveAgentOrgId`.
 *
 * SINGLE-READ INVARIANT: a resolver MUST read the row ONCE and return the
 * modality's `base_url`/`model`/`models_endpoint` together with the ROW's key.
 * Never re-read the base_url separately from the key — that split is the flip
 * vector the migration's URL invariant guards against. When
 * `capabilities.<modality>.base_url` is present the returned `baseUrl` is set,
 * and the service MUST use `apiKey` (the org row key) for that call.
 *
 * ABSENT-BLOCK SEMANTICS: `resolve` returns `null` when the org has no live
 * `inference_providers` row for `slug`, OR that row has no `capabilities.<modality>`
 * block. A `null` return means "fall back to today's static/hardcoded semantics"
 * — so existing orgs are byte-identical at cutover. A present block with no
 * `base_url` still resolves (baseUrl undefined) so `model`/`modelsEndpoint`
 * overrides apply against the static URL.
 */
import type { InferenceModality } from "@lobu/core/contracts/tools/manage-inference-providers";

export interface ResolvedInferenceProvider {
  /** The row's ONE decrypted api key (from resolveInferenceProviderConfig). */
  apiKey: string;
  /** capabilities.<modality>.base_url, when present. Undefined ⇒ use static URL. */
  baseUrl?: string;
  /** capabilities.<modality>.model, when present. */
  model?: string;
  /** capabilities.<modality>.models_endpoint (relative path), when present. */
  modelsEndpoint?: string;
}

/**
 * Resolve the org `inference_providers` config for `agentId` + provider `slug`
 * for one `modality`. Returns null when no row/block exists (⇒ static fallback).
 * Implementations MUST honor the single-read invariant documented above.
 */
export type InferenceProviderConfigSource = (
  agentId: string,
  slug: string,
  modality: InferenceModality
) => Promise<ResolvedInferenceProvider | null>;

export interface ResolvedInferenceProviderCredential
  extends ResolvedInferenceProvider {
  /** Catalog kind the row was created from; must match trusted catalog defaults. */
  kind: string;
}

/**
 * Resolve an org provider credential for a catalog-declared capability even
 * when the row has no per-modality override block. The returned fields still
 * come from one row read: a present block supplies its URL/model overrides;
 * an absent block supplies only the row key so the caller can use the trusted
 * provider-catalog defaults.
 */
export type InferenceProviderCredentialSource = (
  agentId: string,
  slug: string,
  modality: InferenceModality
) => Promise<ResolvedInferenceProviderCredential | null>;
