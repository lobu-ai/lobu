import type { ConnectionSetupOption, ConnectionSetupOptions } from '@lobu/core/contracts/tools/manage-connections';
import { ConnectionSetupOptionsSchema } from '@lobu/core/contracts/tools/manage-connections';
import { Value } from '@sinclair/typebox/value';
import { getDb } from '../db/client';
import { getWorkspaceProvider } from '../workspace';
import { MANAGED_CHAT_PLATFORMS } from '../preview/managed-platforms';
import { getPrimedBundledMethod, resolveAppInstallCredentials } from '../gateway/installation/app-install-credentials';
import { isCloudMode } from '../utils/cloud-mode';
import { resolveCloudOrigin } from './cloud-credential';
import { normalizeConnectorAuthSchema, getAppInstallationAuthMethods, getOAuthAuthMethods } from '../utils/connector-auth';

/** Public offers only. No memberships, account grants, profile IDs or credentials. */
export async function publicSetupOptions(connectorKey: string, origin: string): Promise<ConnectionSetupOptions> {
  const options: ConnectionSetupOption[] = [];
  const organizations = await getWorkspaceProvider().listOrganizations();
  for (const org of organizations) {
    if (org.visibility !== 'public') continue;
    for (const offer of org.managed_auth?.connectors ?? []) {
      if (offer.connector_key !== connectorKey) continue;
      const url = new URL('/connect/managed', origin);
      url.searchParams.set('org', org.slug);
      url.searchParams.set('connector', connectorKey);
      options.push({
        kind: 'managed_oauth', label: `Connect with ${org.name}`,
        description: 'Use the managed app. Your provider data can be accessed by your local Lobu runtime.',
        execution: 'local', configured: true, managed_by_org: org.slug, url: url.toString(),
        instructions: `Sign in to this cloud and authorize your account. Then use lobu init --from-org ${org.slug} with the same cloud CLI context to generate managedBy configuration. Existing projects should import that exact grant without replacing their configuration. The local runtime needs its own cloud login; never copy provider secrets.`,
      });
    }
  }
  // Hosted chat is connector-owned capability; readiness comes from the declared
  // app credentials, not the presence of a Slack-shaped URL in the client.
  for (const platform of MANAGED_CHAT_PLATFORMS) {
    if (connectorKey !== platform) continue;
    const method = getPrimedBundledMethod(platform, platform);
    if (!method) continue;
    const creds = resolveAppInstallCredentials(method);
    if (!creds.clientId || !creds.clientSecret || method.installShape !== 'oauth-code-exchange') continue;
    options.push({
      kind: 'hosted_chat', label: 'Use the hosted Lobu app',
      description: 'Chat with an agent in Lobu Cloud. This does not connect an independent local runtime or sync its messages locally.',
      execution: 'cloud', configured: true,
      url: new URL(`/lobu/${encodeURIComponent(method.provider)}/install`, origin).toString(),
      instructions: 'Use your cloud workspace and cloud agent. Complete app installation, then bind the intended DM or channel with a Lobu link code. Cloud device execution still uses cloud memory.',
    });
  }
  return { action: 'setup_options', connector_key: connectorKey, cloud_status: 'available', options: options.slice(0, 100) };
}

/** A trusted operator-selected origin; never forward caller cookies or tokens. */
export async function fetchCloudSetupOptions(connectorKey: string, origin: string, fetchImpl: typeof fetch = fetch): Promise<ConnectionSetupOptions> {
  const url = new URL('/api/connection-options', origin);
  url.searchParams.set('connector_key', connectorKey);
  const response = await fetchImpl(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Cloud setup discovery unavailable');
  // Public metadata stays bounded even if a configured upstream misbehaves.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Cloud setup discovery returned no body');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) throw new Error('Cloud setup response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Value.Check(ConnectionSetupOptionsSchema, result) || result.connector_key !== connectorKey || result.cloud_status !== 'available') throw new Error('Invalid cloud setup metadata');
  for (const option of result.options) {
    if (option.kind === 'local' || !option.configured || !option.url || new URL(option.url).origin !== new URL(origin).origin) throw new Error('Invalid cloud setup option');
  }
  return result;
}

export interface SetupOptionsDeps {
  cloudOrigin(): Promise<string | null>;
  cloudMode(): boolean;
  publicOptions: typeof publicSetupOptions;
  remoteOptions: typeof fetchCloudSetupOptions;
  localOption(organizationId: string, connectorKey: string, origin: string): Promise<ConnectionSetupOption | null>;
}

export async function localSetupOption(organizationId: string, connectorKey: string, origin: string): Promise<ConnectionSetupOption | null> {
  const sql = getDb();
  const rows = await sql`SELECT d.key AS installed_key, d.auth_schema, o.slug FROM "organization" o LEFT JOIN connector_definitions d ON d.organization_id = o.id AND d.key = ${connectorKey} AND d.status = 'active' WHERE o.id = ${organizationId} LIMIT 1`;
  if (!rows[0]) return null;
  const schema = normalizeConnectorAuthSchema(rows[0].auth_schema);
  // Catalog entries can start installation before an org definition exists.
  // Reuse the boot-primed declaration; an installed org schema remains authoritative.
  const app = rows[0].installed_key ? getAppInstallationAuthMethods(schema)[0] : getPrimedBundledMethod(connectorKey);
  const oauth = getOAuthAuthMethods(schema)[0];
  if (!app && !oauth) return null;
  const setupUrl = new URL(`/${encodeURIComponent(rows[0].slug)}/connectors/${encodeURIComponent(connectorKey)}`, origin);
  let configured = false;
  let url = setupUrl.toString();
  if (app) {
    const creds = resolveAppInstallCredentials(app);
    configured = app.installShape === 'oauth-code-exchange'
      ? !!(creds.clientId && creds.clientSecret)
      : !!(creds.appId && creds.privateKey && creds.appSlug);
    if (configured) url = new URL(`/lobu/${encodeURIComponent(app.provider)}/${app.installShape === 'github-app' ? 'app/install' : 'install'}`, origin).toString();
  } else if (oauth) {
    const profiles = await sql`SELECT 1 FROM auth_profiles WHERE organization_id = ${organizationId} AND profile_kind = 'oauth_app' AND status = 'active' AND (connector_key = ${connectorKey} OR lower(provider) = ${oauth.provider.toLowerCase()}) LIMIT 1`;
    configured = profiles.length > 0;
  }
  return { kind: 'local', label: configured ? 'Use this server’s app' : 'Use your own app', description: configured ? 'Connect through this Lobu server.' : 'Configure an app on this server if you prefer to manage its credentials.', execution: 'local', configured, url, instructions: configured ? 'Continue setup on this server.' : 'An administrator must configure the app before local authorization is available.' };
}

const DEFAULT_DEPS: SetupOptionsDeps = { cloudOrigin: resolveCloudOrigin, cloudMode: isCloudMode, publicOptions: publicSetupOptions, remoteOptions: fetchCloudSetupOptions, localOption: localSetupOption };

export async function connectionSetupOptions(connectorKey: string, organizationId: string, origin: string, deps: SetupOptionsDeps = DEFAULT_DEPS): Promise<ConnectionSetupOptions> {
  const local = await deps.localOption(organizationId, connectorKey, origin);
  let result: ConnectionSetupOptions = { action: 'setup_options', connector_key: connectorKey, cloud_status: 'not_configured', options: [] };
  try {
    const cloud = deps.cloudMode() ? origin : await deps.cloudOrigin();
    if (cloud) result = new URL(cloud).origin === new URL(origin).origin || deps.cloudMode()
      ? await deps.publicOptions(connectorKey, origin)
      : await deps.remoteOptions(connectorKey, cloud);
  } catch { result.cloud_status = 'unavailable'; }
  return { ...result, options: [...result.options, ...(local ? [local] : [])] };
}
