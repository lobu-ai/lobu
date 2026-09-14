/**
 * Server-side assembly of connector-owned identity modules.
 *
 * This is the ONE place core code enumerates connectors for identity purposes.
 * Each connector owns its namespace constants + normalizers in its own package
 * (`@lobu/connectors/<key>-identity`); here we collect those self-descriptions
 * into the two things the server needs:
 *
 *   - `normalizeConnectorIdentityValue` — the ingest normalizer chain (each
 *     module gets first refusal via its `undefined` "not mine" sentinel; the
 *     caller falls back to generic SDK hygiene).
 *   - `CONNECTOR_RECALL_NAMESPACES` — the connector-contributed half of the
 *     event-recall namespace set. A startup + CI invariant asserts this exactly
 *     matches the physical `idx_events_metadata_<ns>` indexes.
 *
 * Adding a connector namespace: create/extend its `*-identity.ts` module in
 * `@lobu/connectors`, then add it to `CONNECTOR_IDENTITY_MODULES` below. Core
 * code never names a specific connector beyond this import list.
 */

import type { ConnectorIdentityModule } from '@lobu/connectors/connector-identity-module';
import { githubIdentityModule } from '@lobu/connectors/github-identity';
import { googleIdentityModule } from '@lobu/connectors/google-identity';
import { linkedInIdentityModule } from '@lobu/connectors/linkedin-identity';
import { slackIdentityModule } from '@lobu/connectors/slack-identity';
import { xIdentityModule } from '@lobu/connectors/x-identity';

/** Every connector identity module the server wires in. */
export const CONNECTOR_IDENTITY_MODULES: readonly ConnectorIdentityModule[] = [
  githubIdentityModule,
  googleIdentityModule,
  linkedInIdentityModule,
  slackIdentityModule,
  xIdentityModule,
];

/**
 * Normalize a value against every connector module, in registration order.
 * Returns the first module's result whose namespace it owns (`string` valid or
 * `null` invalid), or `undefined` when no connector owns the namespace — the
 * caller then applies generic SDK normalization.
 */
export function normalizeConnectorIdentityValue(
  namespace: string,
  raw: string,
): string | null | undefined {
  for (const module of CONNECTOR_IDENTITY_MODULES) {
    const result = module.normalize(namespace, raw);
    if (result !== undefined) return result;
  }
  return undefined;
}

/**
 * The connector-contributed event-recall namespaces (deduped, insertion order).
 * Combined with the generic recall namespaces to form the full recall set.
 */
export const CONNECTOR_RECALL_NAMESPACES: readonly string[] = Array.from(
  new Set(CONNECTOR_IDENTITY_MODULES.flatMap((m) => m.recallNamespaces)),
);
