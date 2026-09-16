/**
 * OAuth 2.0 device-code client used by `lobu login`.
 *
 * Shared OAuth flow used by Lobu MCP clients against
 * Lobu-hosted issuers: dynamic client registration (RFC 7591) +
 * device authorization grant (RFC 8628) + refresh-token grant.
 */

const CLIENT_NAME = "Lobu CLI";
const SOFTWARE_ID = "lobu-cli";
// `connections:token` is requested explicitly so the resulting login token can
// fetch managed-connector access tokens from the cloud (POST
// /oauth/connection-token). The server grants exactly the requested scope on the
// device-code path — it is NOT auto-appended — so `lobu login` must ask for it
// here. The endpoint's scope gate stays meaningful because nothing widens a
// token onto this scope unless the grant explicitly requested it.
// `device_worker:run` is required for Mac menubar + Chrome bridge flows that
// call POST /api/me/devices/mint-child-token and poll /api/workers/* — the
// server gates both on that scope. The old Owletto Mac OAuthClient requested it
// explicitly; the CLI must too so `lobu login` tokens work for device workers.
const SCOPE =
  "device_worker:run mcp:read mcp:write mcp:admin profile:read connections:token";
const GRANT_DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
const GRANT_REFRESH_TOKEN = "refresh_token";
/** RFC 8628 §3.5: on `slow_down`, the device MUST increase the interval by 5s. */
const SLOW_DOWN_BUMP_SECONDS = 5;

export const DEVICE_CODE_GRANT_TYPE = GRANT_DEVICE_CODE;

export interface OAuthDiscovery {
  issuer: string;
  authorizationEndpoint?: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  revocationEndpoint?: string;
  userinfoEndpoint?: string;
  grantTypesSupported: string[];
  /** auth.md `agent_auth.claim_email_endpoint` — present when the server supports the email user_claimed flow. */
  claimEmailEndpoint?: string;
}

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
}

interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  /**
   * RFC 8707 resource the issuer bound these tokens to, echoed back on the
   * token response. Persisted with the credential so every later refresh can
   * replay it — a resource-scoped grant refreshed without it is rejected.
   */
  resource?: string;
}

interface UserInfo {
  sub: string;
  email?: string;
  name?: string;
}

export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

/**
 * Find the OAuth issuer for an API URL by stripping the path and fetching
 * `<origin>/.well-known/oauth-authorization-server`. Both Lobu-hosted
 * issuers (community.lobu.ai, app.lobu.ai) and the embedded local gateway
 * publish discovery at the API origin.
 */
export async function discoverOAuth(apiUrl: string): Promise<OAuthDiscovery> {
  const origin = new URL(apiUrl).origin;
  const url = `${origin}/.well-known/oauth-authorization-server`;
  const meta = await getJson(url, "discovery");

  const tokenEndpoint = pickString(meta, "token_endpoint");
  if (!tokenEndpoint) {
    throw new OAuthError(
      "discovery_invalid",
      `Discovery doc at ${url} is missing token_endpoint.`
    );
  }

  return {
    issuer: pickString(meta, "issuer") ?? origin,
    authorizationEndpoint: pickString(meta, "authorization_endpoint"),
    tokenEndpoint,
    registrationEndpoint: pickString(meta, "registration_endpoint"),
    deviceAuthorizationEndpoint: pickString(
      meta,
      "device_authorization_endpoint"
    ),
    revocationEndpoint: pickString(meta, "revocation_endpoint"),
    userinfoEndpoint: pickString(meta, "userinfo_endpoint"),
    grantTypesSupported: Array.isArray(meta.grant_types_supported)
      ? (meta.grant_types_supported.filter(
          (g) => typeof g === "string"
        ) as string[])
      : [],
    claimEmailEndpoint: pickString(
      (meta.agent_auth ?? {}) as Record<string, unknown>,
      "claim_email_endpoint"
    ),
  };
}

/**
 * Register a public client capable of running the device-code grant.
 * `token_endpoint_auth_method: "none"` keeps the CLI from needing to
 * ship a client secret.
 */
export async function registerClient(
  registrationEndpoint: string,
  softwareVersion: string
): Promise<RegisteredClient> {
  const body = await postJson(registrationEndpoint, {
    client_name: CLIENT_NAME,
    software_id: SOFTWARE_ID,
    software_version: softwareVersion,
    grant_types: [GRANT_DEVICE_CODE, GRANT_REFRESH_TOKEN],
    token_endpoint_auth_method: "none",
    scope: SCOPE,
  });

  if (!body.ok) {
    throw new OAuthError("registration_failed", body.errorMessage);
  }
  const clientId = pickString(body.data, "client_id");
  if (!clientId) {
    throw new OAuthError(
      "registration_invalid",
      "Registration response was missing client_id."
    );
  }
  return { clientId, clientSecret: pickString(body.data, "client_secret") };
}

export async function startDeviceAuthorization(
  endpoint: string,
  client: RegisteredClient
): Promise<DeviceAuthorization> {
  const body = await postJson(endpoint, withClient(client, { scope: SCOPE }));
  if (!body.ok) {
    throw new OAuthError("device_authorization_failed", body.errorMessage);
  }

  const deviceCode = pickString(body.data, "device_code");
  const userCode = pickString(body.data, "user_code");
  const verificationUri = pickString(body.data, "verification_uri");
  if (!deviceCode || !userCode || !verificationUri) {
    throw new OAuthError(
      "device_authorization_invalid",
      "Device authorization response was missing required fields."
    );
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: pickString(body.data, "verification_uri_complete"),
    expiresIn: pickNumber(body.data, "expires_in") ?? 600,
    interval: Math.max(pickNumber(body.data, "interval") ?? 5, 1),
  };
}

type DevicePollResult =
  | { status: "pending"; bumpInterval: boolean }
  | { status: "complete"; tokens: TokenResponse }
  | { status: "error"; code: string; message: string };

/**
 * One iteration of the device-code polling loop. Returns `pending` for
 * `authorization_pending` / `slow_down` (with `bumpInterval` set when the
 * server asks us to back off), `complete` once the user approves, and
 * `error` for terminal failures.
 */
export async function pollDeviceToken(
  tokenEndpoint: string,
  client: RegisteredClient,
  deviceCode: string
): Promise<DevicePollResult> {
  const body = await postJson(
    tokenEndpoint,
    withClient(client, {
      grant_type: GRANT_DEVICE_CODE,
      device_code: deviceCode,
    })
  );

  if (body.ok && typeof body.data.access_token === "string") {
    return { status: "complete", tokens: parseTokenResponse(body.data) };
  }

  const code = pickString(body.data, "error") ?? "unknown_error";
  if (code === "authorization_pending") {
    return { status: "pending", bumpInterval: false };
  }
  if (code === "slow_down") {
    return { status: "pending", bumpInterval: true };
  }
  return {
    status: "error",
    code,
    message:
      pickString(body.data, "error_description") ??
      `Token endpoint returned ${body.status}.`,
  };
}

/**
 * RFC 6749 §6 refresh grant. `options.resource` MUST carry the RFC 8707
 * indicator the grant was minted with: the Lobu issuer compares it against the
 * resource stored on the refresh row and answers `invalid_grant` when it is
 * absent or different, so a resource-scoped login cannot be renewed without it.
 */
export async function refreshTokens(
  tokenEndpoint: string,
  client: RegisteredClient,
  refreshToken: string,
  options: { resource?: string } = {}
): Promise<TokenResponse | null> {
  const body = await postJson(
    tokenEndpoint,
    withClient(client, {
      grant_type: GRANT_REFRESH_TOKEN,
      refresh_token: refreshToken,
      ...(options.resource ? { resource: options.resource } : {}),
    })
  );
  if (!body.ok || typeof body.data.access_token !== "string") return null;
  return parseTokenResponse(body.data);
}

export async function fetchUserInfo(
  userinfoEndpoint: string,
  accessToken: string
): Promise<UserInfo | null> {
  let response: Response;
  try {
    response = await fetch(userinfoEndpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const data = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!data) return null;
  const sub = pickString(data, "sub");
  if (!sub) return null;
  return {
    sub,
    email: pickString(data, "email"),
    name: pickString(data, "name"),
  };
}

/** RFC 7009 — best-effort. Network failures are intentionally swallowed. */
export async function revokeToken(
  revocationEndpoint: string,
  client: RegisteredClient,
  token: string,
  hint: "access_token" | "refresh_token"
): Promise<void> {
  await postJson(
    revocationEndpoint,
    withClient(client, { token, token_type_hint: hint })
  );
}

export function bumpInterval(interval: number, slowDown: boolean): number {
  return slowDown ? interval + SLOW_DOWN_BUMP_SECONDS : interval;
}

function parseTokenResponse(data: Record<string, unknown>): TokenResponse {
  const accessToken = pickString(data, "access_token");
  if (!accessToken) {
    throw new OAuthError(
      "invalid_token_response",
      "Token endpoint response was missing access_token."
    );
  }
  return {
    accessToken,
    refreshToken: pickString(data, "refresh_token"),
    expiresIn: pickNumber(data, "expires_in"),
    resource: pickString(data, "resource"),
  };
}

type JsonResult =
  | { ok: true; status: number; data: Record<string, unknown> }
  | {
      ok: false;
      status: number;
      data: Record<string, unknown>;
      errorMessage: string;
    };

async function postJson(
  url: string,
  body: Record<string, unknown>
): Promise<JsonResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: {},
      errorMessage: `Network error: ${(err as Error).message}`,
    };
  }
  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (response.ok) return { ok: true, status: response.status, data };
  const errorMessage =
    pickString(data, "error_description") ??
    pickString(data, "error") ??
    `HTTP ${response.status}`;
  return { ok: false, status: response.status, data, errorMessage };
}

async function getJson(
  url: string,
  context: string
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw new OAuthError(
      `${context}_unreachable`,
      `Could not reach ${url}: ${(err as Error).message}`
    );
  }
  if (!response.ok) {
    throw new OAuthError(
      `${context}_failed`,
      `${url} returned HTTP ${response.status}.`
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

function withClient(
  client: RegisteredClient,
  fields: Record<string, unknown>
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    client_id: client.clientId,
    ...fields,
  };
  if (client.clientSecret) body.client_secret = client.clientSecret;
  return body;
}

function pickString(
  data: Record<string, unknown>,
  key: string
): string | undefined {
  const v = data[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pickNumber(
  data: Record<string, unknown>,
  key: string
): number | undefined {
  const v = data[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
