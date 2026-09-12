/**
 * OAuth Provider Configurations & Helpers
 *
 * Provider-specific OAuth URLs, token exchange, and user info fetching.
 * Used by the Connect Link flow for unauthenticated OAuth completion.
 */

import logger from '../utils/logger';
import { fetchCredentialedPublicUrl } from '@lobu/connector-worker/egress';
import { cancelResponseBody } from '../utils/bounded-response';
import {
  readConnectorOAuthResponse,
  withConnectorOAuthDeadline,
} from '../utils/connector-oauth-http';

type OAuthTokenEndpointAuthMethod = 'client_secret_post' | 'client_secret_basic' | 'none';

interface OAuthProviderConfig {
  authorizationUrl: string;
  tokenUrl: string;
  userinfoUrl?: string;
  /** Extra params to include in the authorization URL */
  authParams?: Record<string, string>;
  tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
}

/**
 * `OAuthProviderConfig` with the endpoint URLs optional. Each consumer needs
 * only one of authorize / token / userinfo, so the resolver returns whatever it
 * could resolve and the caller null-checks the field it actually uses.
 */
type ResolvedProviderConfig = Omit<
  OAuthProviderConfig,
  'authorizationUrl' | 'tokenUrl'
> & {
  authorizationUrl?: string;
  tokenUrl?: string;
};

const providers: Record<string, OAuthProviderConfig> = {
  google: {
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    authParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
    tokenEndpointAuthMethod: 'client_secret_post',
  },
  github: {
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userinfoUrl: 'https://api.github.com/user',
    tokenEndpointAuthMethod: 'client_secret_post',
  },
  microsoft: {
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userinfoUrl: 'https://graph.microsoft.com/v1.0/me',
    authParams: {
      response_mode: 'query',
    },
    tokenEndpointAuthMethod: 'client_secret_post',
  },
  reddit: {
    authorizationUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    userinfoUrl: 'https://oauth.reddit.com/api/v1/me',
    authParams: {
      duration: 'permanent',
      response_type: 'code',
    },
    tokenEndpointAuthMethod: 'client_secret_basic',
  },
};

export function getBuiltinProviderConfig(provider: string): OAuthProviderConfig | null {
  return providers[provider] ?? null;
}

function resolveProviderConfig(params: {
  provider: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  authParams?: Record<string, string>;
  tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
}): ResolvedProviderConfig {
  const builtIn = providers[params.provider] ?? null;

  const authorizationUrl = params.authorizationUrl ?? builtIn?.authorizationUrl;
  const tokenUrl = params.tokenUrl ?? builtIn?.tokenUrl;
  const userinfoUrl = params.userinfoUrl ?? builtIn?.userinfoUrl;
  const authParams = {
    ...(builtIn?.authParams ?? {}),
    ...(params.authParams ?? {}),
  };
  const tokenEndpointAuthMethod =
    params.tokenEndpointAuthMethod ?? builtIn?.tokenEndpointAuthMethod ?? 'client_secret_post';

  return {
    ...(authorizationUrl ? { authorizationUrl } : {}),
    ...(tokenUrl ? { tokenUrl } : {}),
    ...(userinfoUrl ? { userinfoUrl } : {}),
    ...(Object.keys(authParams).length > 0 ? { authParams } : {}),
    tokenEndpointAuthMethod,
  };
}

/**
 * Build the OAuth authorization URL
 */
export function buildAuthorizationUrl(params: {
  provider: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  authorizationUrl?: string;
  authParams?: Record<string, string>;
  codeChallenge?: string;
  resource?: string;
}): string | null {
  const config = resolveProviderConfig({
    provider: params.provider,
    authorizationUrl: params.authorizationUrl,
    authParams: params.authParams,
  });
  if (!config.authorizationUrl) return null;

  const url = new URL(config.authorizationUrl);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', params.state);

  url.searchParams.set('scope', params.scopes.join(' '));
  if (params.resource) {
    url.searchParams.set('resource', params.resource);
  }

  // Add provider-specific or connector-specific extra params
  if (config.authParams) {
    for (const [key, value] of Object.entries(config.authParams)) {
      url.searchParams.set(key, value);
    }
  }

  if (params.codeChallenge) {
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }

  return url.toString();
}

interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string | null;
  tokenType: string;
}

/**
 * Exchange an authorization code for tokens
 */
export async function exchangeCodeForTokens(params: {
  provider: string;
  code: string;
  clientId: string;
  clientSecret?: string | null;
  redirectUri: string;
  tokenUrl?: string;
  tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
  codeVerifier?: string;
  resource?: string;
}): Promise<OAuthTokens | null> {
  const config = resolveProviderConfig({
    provider: params.provider,
    tokenUrl: params.tokenUrl,
    tokenEndpointAuthMethod: params.tokenEndpointAuthMethod,
  });
  if (!config.tokenUrl) return null;

  const authMethod = config.tokenEndpointAuthMethod ?? 'client_secret_post';

  const bodyParams: Record<string, string> = {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
  };

  if (params.codeVerifier) {
    bodyParams.code_verifier = params.codeVerifier;
  }
  if (params.resource) {
    bodyParams.resource = params.resource;
  }

  if (authMethod === 'client_secret_post') {
    bodyParams.client_id = params.clientId;
    if (params.clientSecret) {
      bodyParams.client_secret = params.clientSecret;
    }
  } else if (authMethod === 'none') {
    bodyParams.client_id = params.clientId;
  }

  const body = new URLSearchParams(bodyParams);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  if (authMethod === 'client_secret_basic') {
    const credentials = Buffer.from(`${params.clientId}:${params.clientSecret || ''}`).toString(
      'base64'
    );
    headers.Authorization = `Basic ${credentials}`;
  }

  // GitHub returns JSON only if Accept header is set
  if (params.provider === 'github') {
    headers.Accept = 'application/json';
  }

  try {
    // Connector definitions can supply this endpoint. Do not use the generic
    // first-party OAuth transport: pin public DNS and reject redirects so an
    // authorization code or client_secret body cannot be replayed elsewhere.
    const result = await withConnectorOAuthDeadline(async (signal) => {
      const response = await fetchCredentialedPublicUrl(config.tokenUrl!, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal,
      });
      const text = await readConnectorOAuthResponse(response);
      return { response, text };
    });

    if (!result.response.ok) {
      logger.error(
        { provider: params.provider, status: result.response.status, body: result.text },
        'OAuth token exchange failed'
      );
      return null;
    }

    const data = JSON.parse(result.text) as Record<string, unknown>;

    // Some providers (notably GitHub) return HTTP 200 with an error body
    // (e.g. `{ error: "bad_verification_code" }`) instead of a non-2xx status.
    // Treat a missing access_token as a failed exchange.
    if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
      logger.error(
        { provider: params.provider, body: data },
        'OAuth token exchange returned no access_token'
      );
      return null;
    }

    return {
      accessToken: data.access_token,
      refreshToken: (data.refresh_token as string) ?? null,
      expiresIn: (data.expires_in as number) ?? null,
      scope: (data.scope as string) ?? null,
      tokenType: (data.token_type as string) ?? 'Bearer',
    };
  } catch (error) {
    logger.error({ provider: params.provider, error }, 'OAuth token exchange error');
    return null;
  }
}

interface OAuthUserInfo {
  id: string;
  email: string | null;
  name: string | null;
}

async function fetchRawUserInfo(params: {
  provider: string;
  accessToken: string;
  userinfoUrl?: string;
}): Promise<Record<string, unknown> | null> {
  const config = resolveProviderConfig({
    provider: params.provider,
    userinfoUrl: params.userinfoUrl,
  });
  if (!config.userinfoUrl) return null;

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${params.accessToken}`,
    };

    // Reddit requires a User-Agent header for all API calls
    if (params.provider === 'reddit') {
      headers['User-Agent'] = 'lobu:connector:v1.0 (by /u/lobu)';
    }

    // userinfoUrl may also come from a connector definition and this request
    // carries a bearer token, so redirects are never credential-safe.
    const rawData = await withConnectorOAuthDeadline(async (signal) => {
      const response = await fetchCredentialedPublicUrl(config.userinfoUrl!, {
        headers,
        redirect: 'error',
        signal,
      });

      if (!response.ok) {
        await cancelResponseBody(response);
        return null;
      }

      return JSON.parse(await readConnectorOAuthResponse(response)) as Record<string, unknown>;
    });
    if (!rawData) return null;
    return rawData.data && typeof rawData.data === 'object'
      ? (rawData.data as Record<string, unknown>)
      : rawData;
  } catch (error) {
    logger.error({ provider: params.provider, error }, 'OAuth userinfo fetch error');
    return null;
  }
}

/**
 * Fetch raw and normalized user info in a single HTTP call.
 */
export async function fetchUserInfoWithRaw(params: {
  provider: string;
  accessToken: string;
  userinfoUrl?: string;
}): Promise<{ raw: Record<string, unknown> | null; normalized: OAuthUserInfo | null }> {
  const raw = await fetchRawUserInfo(params);
  if (!raw) return { raw: null, normalized: null };
  return { raw, normalized: normalizeUserInfo(params.provider, raw) };
}

export function normalizeUserInfo(provider: string, data: Record<string, unknown>): OAuthUserInfo | null {
  const id = data.id ?? data.sub;
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) return null;
  try {
    switch (provider) {
      case 'google':
        return {
          id: String(id),
          email: (data.email as string) ?? null,
          name: (data.name as string) ?? null,
        };
      case 'github':
        return {
          id: String(id),
          email: (data.email as string) ?? null,
          name: (data.name as string) ?? (data.login as string) ?? null,
        };
      case 'microsoft':
        return {
          id: String(id),
          email: (data.mail as string) ?? (data.userPrincipalName as string) ?? null,
          name: (data.displayName as string) ?? null,
        };
      case 'reddit':
        return {
          id: String(id),
          email: null,
          name: (data.name as string) ?? null,
        };
      default: {
        return {
          id: String(id),
          email: (data.email as string) ?? null,
          name: (data.name as string) ?? (data.username as string) ?? null,
        };
      }
    }
  } catch (error) {
    logger.error({ provider, error }, 'OAuth userinfo normalization error');
    return null;
  }
}
