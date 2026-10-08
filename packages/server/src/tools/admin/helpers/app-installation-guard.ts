/**
 * Guard against creating an UNBOUND `app_installation` connection.
 *
 * When a connector's primary auth method is `app_installation` (e.g. github),
 * a connection bound to an install is created by the App install callback's
 * `linkGithubAppInstallation`, which stamps `config.installation_ref`. The guard
 * rejects a create/connect that would resolve to `app_installation` auth with no
 * `installation_ref` — a dead, unbound connection — and points the user at the
 * install flow.
 *
 * SELECTION-AWARE: it must NOT block a connection that resolves to a DIFFERENT
 * auth method. github also declares oauth + env_keys, so a legit create/connect
 * that supplies an auth profile slug, env/PAT creds in config, or a managedBy
 * grant uses one of those methods — the guard skips entirely. Only when no such
 * intent is present (and there is no installation_ref) does the connection fall
 * through to the app_installation primary, which is what we reject.
 *
 * RESOLVED, NOT ASSERTED: a passed `auth_profile_slug` / `app_auth_profile_slug`
 * only satisfies the guard when it RESOLVES to a real auth profile for this
 * org/connector (same resolver the create/connect flow uses). A non-existent or
 * non-resolvable slug is treated as if no slug was provided — otherwise a caller
 * could assert a bogus slug to bypass the guard and create a dead, unbound
 * app_installation connection.
 *
 * Connector-agnostic: keys on the resolved auth method type (not on `github`),
 * so it covers any future app_installation connector.
 */

import { parseJsonObject } from '@lobu/core';
import { buildConnectionsUrl } from '../../../utils/url-builder';
import { resolveAuthProfileSlugToId } from '../../../utils/auth-profiles';
import type { ToolContext } from '../../registry';
import { getOrgUrlContext } from '../../view-urls';
import {
  getAppInstallationAuthMethods,
  getEnvAuthFieldKeys,
  getManagedByOrg,
  isPrimaryAuthMethodAppInstallation,
  normalizeConnectorAuthSchema,
} from '../../../utils/connector-auth';
import {
  buildAppInstallationSetupError,
  type ConnectorSetupError,
} from './connector-setup-errors';

export async function buildAppInstallationSetupUrl(
  ctx: ToolContext,
  connectorKey: string,
): Promise<string | undefined> {
  const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
  return ownerSlug && baseUrl
    ? buildConnectionsUrl(ownerSlug, baseUrl, undefined, {
        install: connectorKey,
      })
    : undefined;
}

function hasInstallationRef(config: Record<string, unknown>): boolean {
  const ref = config.installation_ref;
  return (
    (typeof ref === 'number' && Number.isFinite(ref)) ||
    (typeof ref === 'string' && ref.trim().length > 0)
  );
}

/**
 * Returns a structured connector-setup error to short-circuit the create/connect
 * handler when the connection would be an unbound app_installation connection,
 * else null.
 *
 * The caller passes the auth-INTENT signals it received so the guard can tell a
 * deliberate oauth/PAT/env/managed create from a bare one that falls through to
 * app_installation. An asserted auth-profile slug is RESOLVED against the org's
 * auth profiles (not trusted as a bare string) so a bogus slug can't bypass it.
 *
 * @param organizationId      the org the connection is being created in (slug scope)
 * @param authSchema          the connector definition's `auth_schema` (raw jsonb/string)
 * @param config              the connection `config` being created
 * @param connectorKey        for the (connector-agnostic) error message + slug scope
 * @param authProfileSlug     an explicitly selected credential profile (env/oauth_account/browser/interactive — NOT oauth_app)
 * @param appAuthProfileSlug  an explicitly selected OAuth app profile (oauth_app only)
 */
export async function rejectUnboundAppInstallationCreate(params: {
  organizationId: string;
  authSchema: unknown;
  config: unknown;
  connectorKey: string;
  authProfileSlug?: string | null;
  appAuthProfileSlug?: string | null;
  gatewayBaseUrl?: string;
  setupUrl?: string;
}): Promise<ConnectorSetupError | null> {
  const schema = normalizeConnectorAuthSchema(params.authSchema);
  // Only connectors whose PRIMARY method is app_installation are in scope.
  if (!isPrimaryAuthMethodAppInstallation(schema)) return null;

  const config = parseJsonObject(params.config);

  // Already bound (the install-callback shape) → allow.
  if (hasInstallationRef(config)) return null;

  // A deliberate non-app_installation auth selection → the connection will use
  // THAT method, not app_installation. Skip the guard — but only when the slug
  // RESOLVES to a real profile OF THE RIGHT KIND for this org/connector. An
  // asserted-but-bogus slug, OR one that resolves to the wrong kind for its
  // param, must NOT satisfy the guard (it would create a dead, unbound
  // app_installation connection), so resolve + kind-check it the same way the
  // create/connect flow does before trusting it as an alternate auth selection.
  //
  // `auth_profile_slug` is the connection's CREDENTIAL profile — any kind that
  // actually provides connection auth (env / oauth_account / browser_session /
  // interactive). An `oauth_app` carries only the app's client_id/secret, not
  // the connection's credentials, so it does NOT satisfy auth_profile_slug.
  if (params.authProfileSlug?.trim()) {
    const resolved = await resolveAuthProfileSlugToId({
      organizationId: params.organizationId,
      slug: params.authProfileSlug,
      connectorKey: params.connectorKey,
    });
    if (resolved && resolved.profile_kind !== 'oauth_app') return null;
  }
  // `app_auth_profile_slug` selects the OAuth app (local client credentials);
  // only an `oauth_app` profile is a valid target. resolveAuthProfileSlugToId's
  // expectedKind enforces that — a wrong-kind slug resolves to null here.
  if (params.appAuthProfileSlug?.trim()) {
    const resolvedApp = await resolveAuthProfileSlugToId({
      organizationId: params.organizationId,
      slug: params.appAuthProfileSlug,
      connectorKey: params.connectorKey,
      expectedKind: 'oauth_app',
    });
    if (resolvedApp) return null;
  }
  if (getManagedByOrg(config)) return null;
  // Env/PAT creds supplied directly in config (e.g. GITHUB_TOKEN) → env auth.
  const envKeys = getEnvAuthFieldKeys(schema);
  if (envKeys.some((key) => config[key] !== undefined && config[key] !== null)) {
    return null;
  }

  // No installation_ref and no other auth intent → this would resolve to the
  // app_installation primary with nothing to bind. Reject with install guidance.
  const method = getAppInstallationAuthMethods(schema)[0];
  if (!method) return null;
  return buildAppInstallationSetupError({
    connectorKey: params.connectorKey,
    method,
    gatewayBaseUrl: params.gatewayBaseUrl,
    setupUrl: params.setupUrl,
    hasByoMethod: schema.methods.some((m) => m.type === 'none'),
  });
}
