/**
 * Connect Page Backend Routes
 *
 * Unauthenticated routes gated by connect tokens.
 * Handles the Connect Link flow for MCP clients:
 *
 * - GET  /connect/:token              → resolve token, return connector info
 * - POST /connect/:token/validate     → env_keys: store credentials, trigger validation run
 * - GET  /connect/:token/status       → poll validation run status
 * - POST /connect/:token/complete     → env_keys: finalize and activate connection
 * - POST /connect/:token/cancel       → reset credentials and cancel validation
 * - GET  /connect/:token/oauth/start    → redirect to OAuth provider
 * - GET  /connect/oauth/callback        → stable OAuth callback (token from ?state=)
 */

import { type Context, Hono } from 'hono';
import {
  generateCodeChallenge as buildPkceChallenge,
  generateCodeVerifier as buildPkceVerifier,
} from '../utils/pkce';
import { createMiddleware } from 'hono/factory';
import { createAuth } from '../auth';
import { getDb } from '../db/client';
import type { Env } from '../index';
import {
  ensureUniqueAuthProfileSlug,
  getAuthProfileById,
  getPrimaryAuthProfileForKind,
  normalizeAuthProfileSlug,
  normalizeAuthValues,
} from '../utils/auth-profiles';
import {
  persistAuthCredentials,
  toSecretRefAuthData,
} from '../utils/auth-credential-secrets';
import { type ConnectTokenRow, resolveConnectToken } from '../utils/connect-tokens';
import logger from '../utils/logger';
import { lockOAuthAppBinding, syncOAuthConnectionsForAuthProfile } from '../utils/oauth-connection-state';
import {
  isPersonalCredentialKind,
  resolveOAuthAppClientCredentials,
} from '../tools/admin/helpers/connection-helpers';
import { registerConnectorWebhook } from './webhook-registration';
import { mergeOAuthScopeAuthData, normalizeScopeList } from '../auth/oauth/scopes';
import { createSyncRun, describeSyncRunSkip } from '../runs/queue-service';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../utils/run-statuses';
import { buildConnectionAuthUrl, buildConnectionsUrl, getOrganizationSlug, getPublicWebUrl } from '../utils/url-builder';
import {
  ATLASSIAN_JIRA_ISSUES_FEED_KEY,
  isAtlassianMcpConfig,
  normalizeMcpProxyConfig,
} from '../operations/atlassian-mcp-feed';
import { reconcileAtlassianMcpJiraSite } from './atlassian-mcp-site';
import {
  jiraSiteConfigPatch,
  resolveJiraCloudSite,
  type JiraCloudSite,
} from './atlassian-resources';
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchUserInfoWithRaw,
} from './oauth-providers';
import { resolveSession } from '../auth/resolve-session';

interface OAuthAuthConfig {
  appAuthProfileId?: number;
  provider: string;
  scopes: string[];
  clientIdKey?: string;
  clientSecretKey?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  authParams?: Record<string, string>;
  tokenEndpointAuthMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
  usePkce?: boolean;
  pkceCodeVerifier?: string;
  redirectUri?: string;
  requestedScopes?: string[];
  resource?: string;
}

type ConnectTokenEnv = { Bindings: Env; Variables: { tokenRow: ConnectTokenRow } };

/**
 * Middleware that resolves the :token route param into a ConnectTokenRow.
 * Returns 404 if the token is missing, expired, or invalid.
 */
const requireConnectToken = createMiddleware<ConnectTokenEnv>(async (c, next) => {
  const token = c.req.param('token') as string;
  const tokenRow = await resolveConnectToken(token);
  if (!tokenRow) {
    return c.json({ error: 'Invalid or expired connect token' }, 404);
  }
  c.set('tokenRow', tokenRow);
  return next();
});

function getBaseUrl(c: Context<ConnectTokenEnv>): string {
  return getPublicWebUrl(c.req.url) ?? '';
}

const connectRoutes = new Hono<ConnectTokenEnv>();

async function getLatestValidationRun(
  connectionId: number,
  createdAfter: Date
): Promise<{
  id: number;
  status: string;
  error_message: string | null;
} | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, status, error_message
    FROM runs
    WHERE connection_id = ${connectionId}
      AND run_type = 'sync'
      AND created_at >= ${createdAfter.toISOString()}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;

  if (rows.length === 0) return null;

  const { id, status, error_message } = rows[0] as {
    id: unknown;
    status: string;
    error_message: string | null;
  };

  return { id: Number(id), status, error_message };
}

function getMissingRequiredFields(
  schema: Record<string, unknown> | null | undefined,
  config: Record<string, unknown> | null | undefined
): string[] {
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((field): field is string => typeof field === 'string')
    : [];

  if (required.length === 0) return [];

  const values = config ?? {};
  return required.filter((field) => {
    const value = values[field];
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim().length === 0;
    return false;
  });
}

/**
 * GET /connect/:token
 * Resolve a connect token and return connector metadata for the frontend.
 */
connectRoutes.get('/:token', async (c, next) => {
  const accept = c.req.header('Accept') ?? '';
  const token = c.req.param('token');

  // For browser navigation, redirect OAuth tokens straight to the consent screen
  if (accept.includes('text/html')) {
    const tokenRow = await resolveConnectToken(token);
    if (tokenRow?.auth_type === 'oauth') {
      return c.redirect(`${getBaseUrl(c)}/connect/${token}/oauth/start`);
    }
    return next();
  }

  const tokenRow = await resolveConnectToken(token);
  if (!tokenRow) {
    return c.json({ error: 'Invalid or expired connect token' }, 404);
  }

  // Fetch connector info for display
  const sql = getDb();
  const connectorRows = await sql`
    SELECT name, description, auth_schema
    FROM connector_definitions
    WHERE key = ${tokenRow.connector_key} AND status = 'active'
    LIMIT 1
  `;

  const connector = connectorRows[0] as
    | {
        name: string;
        description: string | null;
        auth_schema: Record<string, unknown> | null;
      }
    | undefined;

  // Fetch org name for display
  const orgRows = await sql`
    SELECT name FROM organization WHERE id = ${tokenRow.organization_id} LIMIT 1
  `;
  const orgName = (orgRows[0] as { name: string } | undefined)?.name ?? null;

  return c.json({
    connector_key: tokenRow.connector_key,
    connector_name: connector?.name ?? tokenRow.connector_key,
    connector_description: connector?.description ?? null,
    auth_type: tokenRow.auth_type,
    auth_config: tokenRow.auth_config,
    organization_name: orgName,
    expires_at: tokenRow.expires_at,
  });
});

/**
 * POST /connect/:token/validate
 * For env_keys auth: store credentials, activate feed, and create a validation sync run.
 * Connection stays in pending_auth until /complete is called.
 */
connectRoutes.post('/:token/validate', requireConnectToken, async (c) => {
  const tokenRow = c.get('tokenRow');

  if (tokenRow.auth_type !== 'env_keys') {
    return c.json(
      { error: 'This endpoint is for env_keys auth only. Use OAuth flow instead.' },
      400
    );
  }

  const body = await c.req.json<{ credentials: Record<string, string> }>();
  if (!body.credentials || typeof body.credentials !== 'object') {
    return c.json({ error: 'credentials object is required' }, 400);
  }

  if (!tokenRow.auth_profile_id || !tokenRow.connection_id) {
    return c.json({ error: 'This env auth flow is not attached to a pending connection.' }, 400);
  }
  const authProfileId = Number(tokenRow.auth_profile_id);
  const connectionId = Number(tokenRow.connection_id);

  const sql = getDb();

  // Find the first feed for this connection and ensure it has the schema-required config
  const feedRows = await sql`
    SELECT
      f.id,
      f.feed_key,
      f.config
    FROM feeds f
    WHERE connection_id = ${connectionId} AND f.deleted_at IS NULL
    ORDER BY id ASC
    LIMIT 1
  `;

  if (feedRows.length === 0) {
    return c.json({ error: 'No feeds configured for this connection' }, 400);
  }

  const feed = feedRows[0] as {
    id: unknown;
    feed_key: string;
    config: Record<string, unknown> | null;
  };

  const connectorRows = await sql`
    SELECT feeds_schema, options_schema
    FROM connector_definitions
    WHERE key = ${tokenRow.connector_key}
      AND status = 'active'
      AND organization_id = ${tokenRow.organization_id}
    LIMIT 1
  `;

  const connector = connectorRows[0] as
    | {
        feeds_schema: Record<string, unknown> | null;
        options_schema: Record<string, unknown> | null;
      }
    | undefined;

  const feedSchemas =
    connector?.feeds_schema && typeof connector.feeds_schema === 'object'
      ? connector.feeds_schema
      : null;
  const feedSchemaEntry =
    feedSchemas && typeof feedSchemas[feed.feed_key] === 'object'
      ? (feedSchemas[feed.feed_key] as Record<string, unknown>)
      : null;
  const configSchema =
    feedSchemaEntry && typeof feedSchemaEntry.configSchema === 'object'
      ? (feedSchemaEntry.configSchema as Record<string, unknown>)
      : connector?.options_schema;

  const missingFields = getMissingRequiredFields(configSchema, feed.config);
  if (missingFields.length > 0) {
    return c.json(
      {
        error:
          'Validation requires feed configuration before sync can run. ' +
          `Missing required fields for '${feed.feed_key}': ${missingFields.join(', ')}`,
      },
      400
    );
  }

  // Store credentials on the pending auth profile but keep connection in
  // pending_auth. The submitted values are bearer credentials (a postgres DSN
  // embeds its own password), so they go to the encrypted secret store and
  // only `secret://` refs land in `auth_data`. Secret write + profile/connection
  // updates share one transaction so a partial failure cannot leave a
  // decryptable secret without the matching auth_data ref.
  await sql.begin(async (tx) => {
    const credentialRefs = await toSecretRefAuthData({
      organizationId: tokenRow.organization_id,
      authProfileId,
      credentials: normalizeAuthValues(body.credentials),
      db: tx,
    });
    await tx`
      UPDATE auth_profiles
      SET auth_data = ${tx.json(credentialRefs)},
          status = 'pending_auth',
          updated_at = NOW()
      WHERE id = ${authProfileId}
        AND organization_id = ${tokenRow.organization_id}
    `;

    await tx`
      UPDATE connections
      SET status = 'pending_auth',
          updated_at = NOW()
      WHERE id = ${connectionId}
        AND organization_id = ${tokenRow.organization_id}
    `;

    // Activate feeds so the worker can pick them up for validation
    await tx`
      UPDATE feeds
      SET status = 'active',
          next_run_at = NOW(),
          updated_at = NOW()
      WHERE connection_id = ${connectionId}
    `;
  });

  const feedId = Number(feed.id);
  const created = await createSyncRun(feedId, c.env as unknown as Env);
  if (!created.ok) {
    return c.json(
      { error: describeSyncRunSkip(created.reason) },
      409
    );
  }
  const runId = created.runId;

  logger.info(
    { connection_id: tokenRow.connection_id, run_id: runId, feed_id: feedId },
    'Validation sync run created for env_keys connect flow'
  );

  return c.json({ status: 'validating', run_id: runId, feed_id: feedId });
});

/**
 * GET /connect/:token/status
 * Poll the status of a validation sync run.
 */
connectRoutes.get('/:token/status', requireConnectToken, async (c) => {
  const tokenRow = c.get('tokenRow');

  const runIdParam = c.req.query('run_id');
  if (!runIdParam) {
    return c.json({ error: 'run_id query parameter is required' }, 400);
  }

  const runId = Number(runIdParam);
  if (!Number.isFinite(runId) || runId <= 0) {
    return c.json({ error: 'Invalid run_id' }, 400);
  }

  const sql = getDb();
  const rows = await sql`
    SELECT status, items_collected, error_message
    FROM runs
    WHERE id = ${runId}
      AND connection_id = ${tokenRow.connection_id}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return c.json({ error: 'Run not found' }, 404);
  }

  const run = rows[0] as {
    status: string;
    items_collected: number;
    error_message: string | null;
  };

  return c.json({
    status: run.status,
    items_collected: run.items_collected,
    error_message: run.error_message,
  });
});

/**
 * POST /connect/:token/complete
 * Finalize env_keys connection: set connection active, mark token completed.
 * Credentials should already be stored via /validate.
 */
connectRoutes.post('/:token/complete', requireConnectToken, async (c) => {
  const tokenRow = c.get('tokenRow');
  const token = c.req.param('token');

  if (tokenRow.auth_type !== 'env_keys') {
    return c.json(
      { error: 'This endpoint is for env_keys auth only. Use OAuth flow instead.' },
      400
    );
  }

  if (!tokenRow.auth_profile_id || !tokenRow.connection_id) {
    return c.json({ error: 'This env auth flow is not attached to a pending connection.' }, 400);
  }

  const sql = getDb();
  const connectionRows = await sql`
    SELECT c.status, ap.auth_data
    FROM connections c
    JOIN auth_profiles ap ON ap.id = ${tokenRow.auth_profile_id}
    WHERE c.id = ${tokenRow.connection_id}
      AND c.organization_id = ${tokenRow.organization_id}
      AND ap.organization_id = ${tokenRow.organization_id}
    LIMIT 1
  `;

  if (connectionRows.length === 0) {
    return c.json({ error: 'Connection not found' }, 404);
  }

  const connection = connectionRows[0] as {
    auth_data: unknown;
    status: string;
  };

  if (Object.keys(normalizeAuthValues(connection.auth_data)).length === 0) {
    return c.json({ error: 'Validation required before activation' }, 409);
  }

  if (connection.status !== 'pending_auth') {
    return c.json({ error: `Connection is not awaiting validation (${connection.status})` }, 409);
  }

  const validationRun = await getLatestValidationRun(tokenRow.connection_id, tokenRow.created_at);
  if (!validationRun) {
    return c.json({ error: 'Validation required before activation' }, 409);
  }

  if (validationRun.status !== 'completed') {
    const message =
      validationRun.error_message ||
      `Validation has not completed successfully yet (status: ${validationRun.status})`;
    return c.json({ error: message, run_id: validationRun.id, status: validationRun.status }, 409);
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE auth_profiles
      SET status = 'active',
          updated_at = NOW()
      WHERE id = ${tokenRow.auth_profile_id}
        AND organization_id = ${tokenRow.organization_id}
    `;

    // Activate the connection (credentials already stored by /validate)
    await tx`
      UPDATE connections
      SET status = 'active',
          updated_at = NOW()
      WHERE id = ${tokenRow.connection_id}
        AND organization_id = ${tokenRow.organization_id}
    `;

    // Ensure feeds are active
    await tx`
      UPDATE feeds
      SET status = 'active',
          updated_at = NOW()
      WHERE connection_id = ${tokenRow.connection_id}
    `;

    // Mark token as completed
    await tx`
      UPDATE connect_tokens
      SET status = 'completed', completed_at = NOW()
      WHERE token = ${token}
    `;
  });

  logger.info(
    { connection_id: tokenRow.connection_id, connector_key: tokenRow.connector_key },
    'Connection activated via env_keys connect flow'
  );

  return c.json({ status: 'connected', connection_id: tokenRow.connection_id });
});

/**
 * POST /connect/:token/cancel
 * Cancel validation: clear credentials, pause feeds, cancel pending runs.
 * Allows the user to retry with new credentials.
 */
connectRoutes.post('/:token/cancel', requireConnectToken, async (c) => {
  const tokenRow = c.get('tokenRow');

  const sql = getDb();

  await sql.begin(async (tx) => {
    if (tokenRow.auth_profile_id) {
      // Clear auth_data AND drop the encrypted credential rows. Setting
      // auth_data to {} alone would leave decryptable agent_secrets behind.
      await persistAuthCredentials({
        organizationId: tokenRow.organization_id,
        authProfileId: Number(tokenRow.auth_profile_id),
        credentials: {},
        db: tx,
      });
      await tx`
        UPDATE auth_profiles
        SET status = 'pending_auth',
            updated_at = NOW()
        WHERE id = ${tokenRow.auth_profile_id}
          AND organization_id = ${tokenRow.organization_id}
      `;
    }

    if (tokenRow.connection_id) {
      await tx`
        UPDATE connections
        SET status = 'pending_auth',
            updated_at = NOW()
        WHERE id = ${tokenRow.connection_id}
          AND organization_id = ${tokenRow.organization_id}
      `;

      await tx`
        UPDATE feeds
        SET status = 'paused',
            updated_at = NOW()
        WHERE connection_id = ${tokenRow.connection_id}
      `;

      await tx`
        UPDATE runs
        SET status = 'cancelled',
            completed_at = NOW()
        WHERE connection_id = ${tokenRow.connection_id}
          AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
      `;
    }
  });

  logger.info(
    { connection_id: tokenRow.connection_id },
    'Validation cancelled for env_keys connect flow'
  );

  return c.json({ status: 'cancelled' });
});

/**
 * GET /connect/:token/oauth/start
 * Build OAuth URL and redirect to the provider's authorization page.
 */
connectRoutes.get('/:token/oauth/start', requireConnectToken, async (c) => {
  const tokenRow = c.get('tokenRow');
  const token = c.req.param('token');

  if (tokenRow.auth_type !== 'oauth') {
    return c.json({ error: 'This endpoint is for OAuth auth only.' }, 400);
  }

  const authConfig = tokenRow.auth_config as OAuthAuthConfig | null;

  if (!authConfig?.provider) {
    return c.json({ error: 'OAuth provider not configured for this connector' }, 400);
  }

  const { clientId, clientSecret, appAuthProfileId } =
    await resolveOAuthCredentialsForToken(tokenRow, authConfig);

  if (!clientId) {
    return c.json(
      {
        error:
          `OAuth client credentials not configured for provider '${authConfig.provider}'. ` +
          'Create an OAuth app auth profile first, then retry.',
      },
      500
    );
  }

  if (authConfig.tokenEndpointAuthMethod !== 'none' && !clientSecret) {
    return c.json(
      {
        error:
          `OAuth client secret not configured for provider '${authConfig.provider}'. ` +
          'Create an OAuth app auth profile first, then retry.',
      },
      500
    );
  }

  const baseUrl = getBaseUrl(c);
  const redirectUri = `${baseUrl}/connect/oauth/callback`;
  // Reusing a pending URL must send the challenge for the verifier saved on
  // that token; generating a new unsaved verifier makes the callback fail.
  let pkceCodeVerifier = authConfig.usePkce
    ? authConfig.pkceCodeVerifier ?? buildPkceVerifier()
    : undefined;

  const needsUpdate =
    authConfig.redirectUri !== redirectUri ||
    (authConfig.usePkce && !authConfig.pkceCodeVerifier) ||
    // Stamp the app actually used so the callback binds the grant to it.
    (!!appAuthProfileId && authConfig.appAuthProfileId !== appAuthProfileId);

  if (needsUpdate) {
    const configPatch = {
      ...(appAuthProfileId ? { appAuthProfileId } : {}),
      redirectUri,
    };
    const sql = getDb();
    // Concurrent opens must use the first saved verifier, including across
    // replicas. Patch only initialization fields so scope edits are retained.
    const [stored] = await sql`
      UPDATE connect_tokens
      SET auth_config = COALESCE(auth_config, '{}'::jsonb)
        || ${sql.json(configPatch)}::jsonb
        || ${pkceCodeVerifier
          ? sql`jsonb_build_object('pkceCodeVerifier', COALESCE(auth_config->>'pkceCodeVerifier', ${pkceCodeVerifier}::text))`
          : sql`'{}'::jsonb`}
      WHERE token = ${token} AND status = 'pending' AND expires_at > NOW()
      RETURNING auth_config
    `;
    if (!stored) return c.json({ error: 'Invalid or expired connect token' }, 404);
    if (pkceCodeVerifier) pkceCodeVerifier = stored.auth_config.pkceCodeVerifier;
  }

  const authUrl = buildAuthorizationUrl({
    provider: authConfig.provider,
    clientId,
    redirectUri,
    scopes: authConfig.scopes ?? [],
    state: token,
    authorizationUrl: authConfig.authorizationUrl,
    authParams: authConfig.authParams,
    codeChallenge: pkceCodeVerifier ? buildPkceChallenge(pkceCodeVerifier) : undefined,
    resource: authConfig.resource,
  });

  if (!authUrl) {
    return c.json({ error: `Unsupported OAuth provider: ${authConfig.provider}` }, 400);
  }

  return c.redirect(authUrl);
});

/**
 * GET /connect/oauth/callback
 * Stable OAuth callback -- token is extracted from the `state` query parameter.
 * This lets users register a single redirect URI with their OAuth provider.
 */
connectRoutes.get('/oauth/callback', async (c) => {
  const token = c.req.query('state');
  const code = c.req.query('code');
  const error = c.req.query('error');

  if (!token) {
    return c.json({ error: 'Missing state parameter' }, 400);
  }

  const tokenRow = await resolveConnectToken(token);
  if (!tokenRow) {
    return c.json({ error: 'Invalid or expired connect token' }, 404);
  }

  const baseUrl = getBaseUrl(c);
  // Resolve the token first: a denied or failed consent still has to land the
  // user back on the connection they were recovering, not on a bare error page.
  if (error) {
    return c.redirect(
      await oauthResultUrl(
        tokenRow,
        baseUrl,
        error === 'access_denied' ? 'cancelled' : 'failed'
      )
    );
  }
  if (!code) {
    return c.json({ error: 'Missing authorization code' }, 400);
  }
  const authConfig = tokenRow.auth_config as OAuthAuthConfig | null;
  return handleOAuthCallback(
    c,
    tokenRow,
    code,
    authConfig?.redirectUri || `${baseUrl}/connect/oauth/callback`
  );
});

async function resolveConnectActorUserId(
  c: Context<ConnectTokenEnv, string>,
  preferredUserId: string | null | undefined
): Promise<string | null> {
  if (preferredUserId && preferredUserId.trim().length > 0) {
    return preferredUserId;
  }

  try {
    const auth = await createAuth(c.env, c.req.raw);
    const session = await resolveSession(auth, c.req.raw.headers);
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

async function handleOAuthCallback(
  c: Context<ConnectTokenEnv, string>,
  tokenRow: ConnectTokenRow,
  code: string,
  redirectUri: string
) {
  const token = tokenRow.token;
  const authConfig = tokenRow.auth_config as OAuthAuthConfig | null;

  if (!authConfig?.provider) {
    return c.json({ error: 'OAuth provider not configured' }, 400);
  }

  const sql = getDb();
  const { clientId, clientSecret, appAuthProfileId } = await resolveOAuthCredentialsForToken(tokenRow, authConfig);

  if (!clientId) {
    return c.json({ error: 'OAuth client credentials not found' }, 500);
  }

  const baseUrl = getBaseUrl(c);

  const tokens = await exchangeCodeForTokens({
    provider: authConfig.provider,
    code,
    clientId,
    clientSecret,
    redirectUri,
    tokenUrl: authConfig.tokenUrl,
    tokenEndpointAuthMethod: authConfig.tokenEndpointAuthMethod,
    codeVerifier: authConfig.pkceCodeVerifier,
    resource: authConfig.resource,
  });

  if (!tokens) {
    return c.redirect(await oauthResultUrl(tokenRow, baseUrl, 'failed'));
  }

  // Jira 3LO tokens are site-agnostic — REST needs cloud_id. Discover the
  // unique accessible site once here so connection.config + external_tenant_id
  // are ready before the first source read / webhook register. Best-effort:
  // discovery failure or a multi-site grant does not fail OAuth; an ambiguous
  // connection must set config.cloud_id before its first Jira read.
  let jiraSite: JiraCloudSite | null = null;
  const [mcpDefinition] = (await sql`
    SELECT mcp_config
    FROM connector_definitions
    WHERE key = ${tokenRow.connector_key}
      AND organization_id = ${tokenRow.organization_id}
      AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 1
  `) as Array<{ mcp_config: Record<string, unknown> | null }>;
  const atlassianMcpConfig = isAtlassianMcpConfig(mcpDefinition?.mcp_config)
    ? normalizeMcpProxyConfig(mcpDefinition.mcp_config)
    : null;
  if (tokenRow.connector_key === 'jira') {
    jiraSite = await resolveJiraCloudSite(tokens.accessToken);
    if (jiraSite) {
      logger.info(
        {
          connector_key: tokenRow.connector_key,
          cloud_id: jiraSite.cloudId,
          site_url: jiraSite.siteUrl,
          site_count: jiraSite.resourceCount,
        },
        'Resolved Jira Cloud site after OAuth'
      );
    } else {
      logger.warn(
        { connector_key: tokenRow.connector_key },
        'Jira OAuth succeeded but did not resolve to one accessible Jira site'
      );
    }
  }

  const { raw: rawUserInfo, normalized: userInfo } = await fetchUserInfoWithRaw({
    provider: authConfig.provider,
    accessToken: tokens.accessToken,
    userinfoUrl: authConfig.userinfoUrl,
  });
  const grantedScopes = normalizeScopeList(tokens.scope);

  const actorUserId = (await resolveConnectActorUserId(c, tokenRow.created_by)) ?? 'connect-flow';

  let displayNameOverride: string | null = null;
  if (userInfo?.name) {
    const [row] = await sql`
      SELECT name FROM connector_definitions WHERE key = ${tokenRow.connector_key} LIMIT 1
    `;
    const connectorName = (row as { name: string } | undefined)?.name ?? tokenRow.connector_key;
    displayNameOverride = `${connectorName} (${userInfo.name})`;
  }

  let resolvedAuthProfileId = tokenRow.auth_profile_id;

  const committed = await sql.begin(async (tx) => {
    // Recheck the token and its target before replacing any credentials.
    // Old links must not overwrite a newer app binding.
    const pending = await tx`
      SELECT 1 FROM connect_tokens WHERE token = ${token}
        AND status = 'pending' AND expires_at > NOW() FOR UPDATE
    `;
    if (pending.length !== 1) return false;
    if (tokenRow.auth_profile_id) {
      if (!(await lockOAuthAppBinding(tx, tokenRow.organization_id,
        tokenRow.auth_profile_id, appAuthProfileId ?? null))) return false;
    }
    if (tokenRow.connection_id) {
      const [target] = await tx`
        SELECT app_auth_profile_id, auth_profile_id, account_id FROM connections
        WHERE id = ${tokenRow.connection_id} AND organization_id = ${tokenRow.organization_id}
          AND deleted_at IS NULL FOR UPDATE
      `;
      if (!target || target.auth_profile_id !== tokenRow.auth_profile_id ||
          (!tokenRow.auth_profile_id && target.account_id) ||
          (target.app_auth_profile_id && target.app_auth_profile_id !== appAuthProfileId)) return false;
    }
    const tokenTarget = tokenRow.connection_id ?? tokenRow.auth_profile_id ?? tokenRow.id;
    const generatedAccountId = `connect_${tokenTarget}_${Date.now()}`;
    const expiresAt = tokens.expiresIn
      ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
      : null;

    // Connector OAuth grants are not social-login identities. Different Lobu
    // connectors can authorize the same upstream user with different scopes and
    // refresh tokens (for example Gmail and Calendar). Keying these rows by the
    // provider's user id makes one connector overwrite another connector's grant.
    // Reuse an already-isolated connector account on reauth; legacy shared rows
    // are intentionally NOT reused so the next successful reauth repairs them.
    let grantAccountIdentity: string | null = null;
    if (resolvedAuthProfileId) {
      const existingGrantRows = (await tx`
        SELECT a."accountId"
        FROM auth_profiles ap
        JOIN account a ON a.id = ap.account_id
        WHERE ap.id = ${resolvedAuthProfileId}
          AND ap.organization_id = ${tokenRow.organization_id}
        LIMIT 1
      `) as Array<{ accountId: string }>;
      const existingIdentity = existingGrantRows[0]?.accountId;
      if (existingIdentity?.startsWith('lobu-connector:')) {
        grantAccountIdentity = existingIdentity;
      }
    }
    grantAccountIdentity ??= `lobu-connector:${tokenRow.organization_id}:${tokenRow.connector_key}:${tokenTarget}`;

    const upsertResult = await tx`
      INSERT INTO account (
        id, "accountId", "providerId", "userId",
        "accessToken", "refreshToken", "accessTokenExpiresAt",
        scope, "createdAt", "updatedAt"
      ) VALUES (
        ${generatedAccountId},
        ${grantAccountIdentity},
        ${authConfig!.provider},
        ${actorUserId},
        ${tokens.accessToken},
        ${tokens.refreshToken},
        ${expiresAt},
        ${tokens.scope},
        NOW(), NOW()
      )
      ON CONFLICT ("providerId", "accountId") DO UPDATE SET
        "accessToken" = EXCLUDED."accessToken",
        "refreshToken" = COALESCE(EXCLUDED."refreshToken", account."refreshToken"),
        "accessTokenExpiresAt" = EXCLUDED."accessTokenExpiresAt",
        scope = EXCLUDED.scope,
        "updatedAt" = NOW()
      RETURNING id
    `;
    const resolvedAccountId = (upsertResult[0] as { id: string }).id;

    // Resolve or create the auth profile.
    // Existing profiles (reconnect flow) get their account tokens refreshed.
    // Deferred profiles (connect / create_auth_profile) are created here as active.
    let authProfileId = resolvedAuthProfileId;

    if (authProfileId) {
      const existingProfileRows = await tx`
        SELECT auth_data
        FROM auth_profiles
        WHERE id = ${authProfileId}
          AND organization_id = ${tokenRow.organization_id}
        LIMIT 1
      `;
      const existingAuthData =
        (existingProfileRows[0] as { auth_data?: Record<string, unknown> } | undefined)
          ?.auth_data ?? {};
      await tx`
        UPDATE auth_profiles
        SET account_id = ${resolvedAccountId},
            provider = ${authConfig!.provider},
            status = 'active',
            auth_data = ${tx.json(
              mergeOAuthScopeAuthData(
                {
                  ...existingAuthData,
                  // The grant records the app that issued it; a later reconnect
                  // reuses that app rather than silently swapping clients.
                  ...(appAuthProfileId
                    ? { app_auth_profile_id: appAuthProfileId }
                    : {}),
                },
                {
                  requestedScopes: authConfig.requestedScopes ?? authConfig.scopes,
                  grantedScopes,
                  identity: rawUserInfo,
                }
              )
            )},
            display_name = COALESCE(display_name, ${displayNameOverride}),
            updated_at = NOW()
        WHERE id = ${authProfileId}
          AND organization_id = ${tokenRow.organization_id}
      `;
    } else {
      const meta = (tokenRow.auth_config as Record<string, unknown>)?.pendingProfileMeta as
        | { displayName: string; slug: string; connectorKey: string; provider: string }
        | undefined;
      if (meta) {
        // Insert auth profile inside the transaction so it can see the account row.
        // Cannot use createAuthProfile() here — it opens a separate connection that
        // cannot see uncommitted rows from this transaction.
        // ensureUniqueAuthProfileSlug() is safe to call outside tx — only reads committed rows.
        const profileSlug = await ensureUniqueAuthProfileSlug({
          organizationId: tokenRow.organization_id,
          slug: normalizeAuthProfileSlug(meta.slug, meta.displayName),
        });
        const profileRows = await tx`
          INSERT INTO auth_profiles (
            organization_id, slug, display_name, connector_key,
            profile_kind, status, auth_data, account_id, provider, created_by
          ) VALUES (
            ${tokenRow.organization_id},
            ${profileSlug},
            ${displayNameOverride ?? meta.displayName},
            ${meta.connectorKey},
            'oauth_account',
            'active',
            ${tx.json(
              mergeOAuthScopeAuthData(
                appAuthProfileId
                  ? { app_auth_profile_id: appAuthProfileId }
                  : {},
                {
                  requestedScopes: authConfig.requestedScopes ?? authConfig.scopes,
                  grantedScopes,
                  identity: rawUserInfo,
                }
              )
            )},
            ${resolvedAccountId},
            ${meta.provider.toLowerCase()},
            ${actorUserId}
          )
          RETURNING id
        `;
        authProfileId = Number((profileRows[0] as { id: unknown }).id);
      }
    }

    if (tokenRow.connection_id) {
      // This callback attaches a PERSONAL oauth_account grant (the else branch
      // above hard-codes profile_kind='oauth_account'; the if branch reuses a
      // profile this same OAuth-account flow created). The connection may have
      // been inserted with visibility='org' because the account profile did not
      // exist at connect time (resolveConnectionVisibility saw no kind). Now that
      // it is personal-credential-backed, DOWNGRADE it to 'private' — an org read
      // through the connection uses this user's token. Downgrade-only: we never
      // widen a connection here, and 'private' is the floor for personal creds.
      // Only on a first grant: a reconnect (token already bound to a profile)
      // must not re-narrow visibility an admin has since widened.
      const attachedKind = authProfileId
        ? (
            (await tx`
              SELECT profile_kind FROM auth_profiles
              WHERE id = ${authProfileId} AND organization_id = ${tokenRow.organization_id}
              LIMIT 1
            `) as Array<{ profile_kind: string }>
          )[0]?.profile_kind
        : undefined;
      const forcePrivate =
        !tokenRow.auth_profile_id && isPersonalCredentialKind(attachedKind);

      // Stamp Jira cloud_id via atomic JSONB merge so a concurrent replica
      // updating action_modes / webhook state is not clobbered by a full
      // config rewrite. Drop prior site keys then || the patch.
      if (jiraSite) {
        const sitePatch = jiraSiteConfigPatch(jiraSite);
        await tx`
          UPDATE connections
          SET account_id = ${resolvedAccountId},
              auth_profile_id = COALESCE(${authProfileId ?? null}, auth_profile_id),
              status = CASE WHEN status = 'paused' THEN status ELSE 'active' END,
              error_message = CASE WHEN status = 'paused' THEN error_message ELSE NULL END,
              visibility = CASE WHEN ${forcePrivate} THEN 'private' ELSE visibility END,
              display_name = COALESCE(display_name, ${displayNameOverride}),
              config = (
                (COALESCE(config, '{}'::jsonb)
                  - 'cloud_id' - 'site_cloud_id' - 'site_url' - 'site_name' - 'accessible_sites')
                || ${tx.json(sitePatch)}::jsonb
              ),
              external_tenant_id = COALESCE(${jiraSite.cloudId}, external_tenant_id),
              updated_at = NOW()
          WHERE id = ${tokenRow.connection_id}
            AND organization_id = ${tokenRow.organization_id}
        `;
      } else {
        await tx`
          UPDATE connections
          SET account_id = ${resolvedAccountId},
              auth_profile_id = COALESCE(${authProfileId ?? null}, auth_profile_id),
              status = CASE WHEN status = 'paused' THEN status ELSE 'active' END,
              error_message = CASE WHEN status = 'paused' THEN error_message ELSE NULL END,
              visibility = CASE WHEN ${forcePrivate} THEN 'private' ELSE visibility END,
              display_name = COALESCE(display_name, ${displayNameOverride}),
              updated_at = NOW()
          WHERE id = ${tokenRow.connection_id}
            AND organization_id = ${tokenRow.organization_id}
        `;
      }

      if (!tokenRow.auth_profile_id) {
        await tx`
          UPDATE feeds
          SET status = 'active', next_run_at = NOW(), updated_at = NOW()
          WHERE connection_id = ${tokenRow.connection_id}
        `;
      }
    }

    await tx`
      UPDATE connect_tokens
      SET status = 'completed', completed_at = NOW()
      WHERE token = ${token}
    `;

    resolvedAuthProfileId = authProfileId;
    return true;
  });

  if (!committed) return c.redirect(await oauthResultUrl(tokenRow, baseUrl, 'failed'));

  if (resolvedAuthProfileId) {
    await syncOAuthConnectionsForAuthProfile(tokenRow.organization_id, resolvedAuthProfileId);
  }

  // Rovo tokens target the MCP resource, not api.atlassian.com. Once the token
  // is durably attached, ask Rovo for its site and persist the identity. This is
  // best-effort like Jira REST discovery: ambiguous grants stay connected but
  // must select cloud_id before creating or reading a feed.
  if (tokenRow.connection_id && atlassianMcpConfig) {
    try {
      const feedRows = (await sql`
        SELECT id, config
        FROM feeds
        WHERE organization_id = ${tokenRow.organization_id}
          AND connection_id = ${tokenRow.connection_id}
          AND feed_key = ${ATLASSIAN_JIRA_ISSUES_FEED_KEY}
          AND deleted_at IS NULL
        ORDER BY id
      `) as Array<{ id: number; config: Record<string, unknown> | null }>;
      const feed = feedRows[0];
      const preferredCloudId =
        typeof feed?.config?.cloud_id === 'string'
          ? feed.config.cloud_id.trim() || undefined
          : undefined;
      const { site } = await reconcileAtlassianMcpJiraSite({
        organizationId: tokenRow.organization_id,
        connectionId: tokenRow.connection_id,
        connectorKey: tokenRow.connector_key,
        mcpConfig: atlassianMcpConfig,
        preferredCloudId,
        feedId: feed?.id,
        sql,
      });
      logger.info(
        {
          connector_key: tokenRow.connector_key,
          connection_id: tokenRow.connection_id,
          cloud_id: site.cloudId,
          site_url: site.siteUrl,
          site_count: site.resourceCount,
        },
        'Resolved Jira Cloud site through Atlassian MCP after OAuth'
      );
    } catch (error) {
      logger.warn(
        { connector_key: tokenRow.connector_key, connection_id: tokenRow.connection_id, error },
        'Atlassian MCP OAuth succeeded but Jira site reconciliation did not complete'
      );
    }
  }

  logger.info(
    {
      connection_id: tokenRow.connection_id,
      auth_profile_id: resolvedAuthProfileId,
      connector_key: tokenRow.connector_key,
      provider: authConfig.provider,
    },
    'Auth profile activated via OAuth connect flow'
  );

  // The connection is now active with resolvable credentials. If its connector
  // declares a webhook block and a live feed is configured, subscribe with the
  // provider once and stamp the verification scheme + secret onto the
  // connection. Best-effort (the helper swallows + logs failures) so a webhook
  // hiccup never breaks the OAuth completion redirect.
  if (tokenRow.connection_id) {
    await registerConnectorWebhook({
      organizationId: tokenRow.organization_id,
      connectionId: tokenRow.connection_id,
      request: c.req.raw,
    });
  }

  return c.redirect(await oauthResultUrl(tokenRow, baseUrl, 'connected'));
}

/**
 * Where the browser lands after consent. A token bound to a connection returns
 * to that connection's auth controls so the outcome is visible next to the
 * account it changed; a profile-only token returns to connector setup.
 */
async function oauthResultUrl(
  tokenRow: ConnectTokenRow,
  baseUrl: string,
  result: 'connected' | 'cancelled' | 'failed'
): Promise<string> {
  const ownerSlug = await getOrganizationSlug(tokenRow.organization_id);
  if (ownerSlug && tokenRow.connection_id) {
    return buildConnectionAuthUrl(
      ownerSlug,
      tokenRow.connector_key,
      tokenRow.connection_id,
      baseUrl,
      result
    );
  }
  if (result === 'connected') {
    return ownerSlug
      ? buildConnectionsUrl(ownerSlug, baseUrl, tokenRow.connector_key)
      : baseUrl;
  }
  return `${baseUrl}/connect/${tokenRow.token}?error=${result}`;
}

async function resolveOAuthCredentialsForToken(
  tokenRow: { connection_id: number | null; organization_id: string; connector_key: string },
  authConfig: OAuthAuthConfig
): Promise<{ clientId: string | null; clientSecret: string | null; appAuthProfileId?: number }> {
  const appAuthProfileId = await fetchAppAuthProfileId(
    tokenRow.connection_id,
    tokenRow.organization_id
  );
  return resolveOAuthClientCredentials(
    authConfig.provider,
    tokenRow.connector_key,
    tokenRow.organization_id,
    authConfig.appAuthProfileId ?? appAuthProfileId,
    authConfig.clientIdKey,
    authConfig.clientSecretKey
  );
}

async function fetchAppAuthProfileId(
  connectionId: number | null,
  organizationId: string
): Promise<number | null> {
  if (!connectionId) return null;
  const sql = getDb();
  const rows = await sql`
    SELECT app_auth_profile_id
    FROM connections
    WHERE id = ${connectionId}
      AND organization_id = ${organizationId}
    LIMIT 1
  `;
  return rows.length > 0
    ? Number((rows[0] as { app_auth_profile_id: unknown }).app_auth_profile_id) || null
    : null;
}

/**
 * A selected OAuth app must still be available; never substitute another app
 * for the app that issued a grant. With no selected app, resolve from:
 * 1. Primary org-level OAuth app auth profile for the connector/provider
 * 2. Deployment env vars (`${PROVIDER}_CLIENT_ID/_SECRET`) — the SAME fallback
 *    global login uses (`auth/config.ts resolveLoginProviderCredentials`), so an
 *    org can connect a connector whose app creds are env-configured with no
 *    hand-created `oauth_app` profile. APP-level only; the per-user account
 *    token (oauth_account) is resolved/required separately by the caller.
 */
async function resolveOAuthClientCredentials(
  provider: string,
  connectorKey: string,
  organizationId: string,
  appAuthProfileId?: number | null,
  clientIdKey?: string,
  clientSecretKey?: string
): Promise<{ clientId: string | null; clientSecret: string | null; appAuthProfileId?: number }> {
  const appProfile = appAuthProfileId
    ? await getAuthProfileById(organizationId, appAuthProfileId)
    : await getPrimaryAuthProfileForKind({
        organizationId,
        connectorKey,
        profileKind: 'oauth_app',
        provider,
      });
  if (appAuthProfileId && (!appProfile || appProfile.profile_kind !== 'oauth_app' ||
      appProfile.status !== 'active' ||
      appProfile.provider?.toLowerCase() !== provider.toLowerCase())) {
    return { clientId: null, clientSecret: null };
  }

  return {
    ...resolveOAuthAppClientCredentials({
      appProfileAuthData: appProfile?.auth_data,
      provider,
      clientIdKey,
      clientSecretKey,
    }),
    ...(appProfile ? { appAuthProfileId: appProfile.id } : {}),
  };
}

export { connectRoutes };
