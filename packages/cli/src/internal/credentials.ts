import { join } from "node:path";
import {
  type BaseCredential,
  credentialCanRefresh,
  credentialNeedsRefresh,
  deleteContextCredential,
  type OAuthClientInfo,
  readContextCredential,
  writeContextCredential,
} from "@lobu/core";
import {
  DEFAULT_CONTEXT_NAME,
  getCurrentContextName,
  LOBU_CONFIG_DIR,
  resolveContext,
  setActiveOrg,
  setCurrentContext,
} from "./context.js";
import { refreshTokens } from "./oauth.js";

const CREDENTIALS_FILE = join(LOBU_CONFIG_DIR, "credentials.json");

export type { OAuthClientInfo };

export interface Credentials extends BaseCredential {
  email?: string;
  name?: string;
  userId?: string;
  /** Local-init worker PAT used only by the gateway agent API. */
  localWorkerToken?: string;
}

// Per-process cache. `lobu apply` calls `getToken()` once per request; without
// this, each call re-reads + re-parses ~/.config/lobu/credentials.json.
// Writes invalidate so refreshed tokens are visible immediately.
const credentialsCache = new Map<string, Credentials | null>();

// In-flight refresh dedupe. Two concurrent `getToken()` callers from the same
// process would otherwise both hit the OAuth token endpoint with the same
// refresh token — and many issuers rotate refresh tokens on use, so the
// second call would land with a revoked token and force a re-login. Coalescing
// per-context so different contexts can still refresh in parallel.
const inFlightRefreshes = new Map<string, Promise<Credentials | null>>();

export async function loadCredentials(
  contextName?: string
): Promise<Credentials | null> {
  const target = await resolveContext(contextName);
  if (credentialsCache.has(target.name)) {
    return credentialsCache.get(target.name) ?? null;
  }

  const creds = await readContextCredential<Credentials>(
    CREDENTIALS_FILE,
    target.name,
    DEFAULT_CONTEXT_NAME
  );
  credentialsCache.set(target.name, creds);
  return creds;
}

export async function saveCredentials(
  creds: Credentials,
  contextName?: string
): Promise<void> {
  const target = await resolveContext(contextName);
  await writeContextCredential<Credentials>(
    CREDENTIALS_FILE,
    target.name,
    DEFAULT_CONTEXT_NAME,
    creds
  );
  credentialsCache.set(target.name, creds);
}

export async function clearCredentials(contextName?: string): Promise<void> {
  const target = await resolveContext(contextName);
  await deleteContextCredential<Credentials>(
    CREDENTIALS_FILE,
    target.name,
    DEFAULT_CONTEXT_NAME
  );
  credentialsCache.set(target.name, null);
}

/**
 * Get token from env var (CI/CD) or stored credentials.
 * Automatically refreshes expired tokens and clears stale credentials.
 *
 * For loopback contexts with no stored creds, transparently POSTs
 * /api/local-init to mint a fresh Better Auth session for the
 * embedded bootstrap user. Agent API callers should use getAgentApiToken(),
 * which returns the companion worker PAT when local-init provides one.
 */
export async function getToken(contextName?: string): Promise<string | null> {
  const envToken = process.env.LOBU_API_TOKEN;
  if (envToken) return envToken;

  return getCredentialsToken(contextName);
}

/**
 * Resolve one named context's own credential without the process-wide
 * `LOBU_API_TOKEN` override. Cross-context callers use this so a token meant
 * for the active local runtime is never forwarded to a Cloud context.
 */
export async function getContextToken(
  contextName?: string
): Promise<string | null> {
  const creds = await loadCredentials(contextName);
  if (!creds) return null;
  if (!credentialNeedsRefresh(creds)) return creds.accessToken;
  if (!credentialCanRefresh(creds)) return null;
  const refreshed = await refreshCredentials(creds, contextName);
  return refreshed?.accessToken ?? null;
}

/**
 * Token for the gateway agent API (`/lobu/api/v1/agents/*`). Local embedded
 * installs need the worker PAT from /api/local-init for that surface, while
 * admin REST + MCP need the Better Auth session token returned by getToken().
 */
export async function getAgentApiToken(
  contextName?: string
): Promise<string | null> {
  const envToken = process.env.LOBU_API_TOKEN;
  if (envToken) return envToken;

  const token = await getCredentialsToken(contextName);
  if (!token) return null;

  let creds = await loadCredentials(contextName);
  if (!creds?.localWorkerToken && (await isLoopbackContext(contextName))) {
    creds = await tryLocalInit(contextName);
  }
  return creds?.localWorkerToken ?? token;
}

async function getCredentialsToken(
  contextName?: string
): Promise<string | null> {
  let creds = await loadCredentials(contextName);
  if (!creds) {
    creds = await tryLocalInit(contextName);
  } else if (
    !creds.localWorkerToken &&
    (await isLoopbackContext(contextName))
  ) {
    // Heal credentials saved by older CLIs that stored only the local-init
    // worker PAT as accessToken. Re-mint so admin REST/MCP get the session
    // token while chat keeps the companion worker PAT.
    creds = (await tryLocalInit(contextName)) ?? creds;
  }
  if (!creds) return null;
  if (!credentialNeedsRefresh(creds)) return creds.accessToken;

  // Say why before dropping: a silent clear surfaces downstream as
  // "Not logged in", sending users to debug auth instead of re-running login.
  // Fires once per process — the clear poisons the cache to null, so later
  // getToken() calls take the `!creds` path above without repeating this.
  const staleNote =
    `\n  Saved login for "${contextName ?? DEFAULT_CONTEXT_NAME}" expired and ` +
    `could not be refreshed. Run \`lobu login\` to sign in again.\n`;
  if (!credentialCanRefresh(creds)) {
    process.stderr.write(staleNote);
    await clearCredentials(contextName);
    return null;
  }

  const refreshed = await refreshCredentials(creds, contextName);
  if (!refreshed) {
    process.stderr.write(staleNote);
    await clearCredentials(contextName);
    return null;
  }
  return refreshed.accessToken;
}

/**
 * Attempt zero-config sign-in against a local embedded server. POST
 * /api/local-init mints a Better Auth session for the bootstrap user
 * when the deployment is empty (no real signups yet) and refuses
 * proxied requests via the forwarded-* header guard, so this is safe to
 * fire unconditionally against loopback contexts.
 */
async function tryLocalInit(contextName?: string): Promise<Credentials | null> {
  const target = await resolveContext(contextName);
  if (!isLoopbackUrl(target.url)) return null;
  try {
    const res = await fetch(
      `${originFromContextUrl(target.url)}/api/local-init`,
      {
        method: "POST",
        headers: { "X-Lobu-Client": "cli" },
      }
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      device_token?: string;
      session_token?: string;
      user?: { id?: string; email?: string; name?: string };
      organization?: { id?: string; slug?: string; name?: string };
    };
    // Prefer the Better Auth session token for CLI commands. The worker PAT
    // from /api/local-init is intentionally device-scoped; session auth carries
    // the user's org membership and works for admin REST + MCP calls. Fall back
    // to device_token only against older local servers that did not return a
    // session token.
    const token = body.session_token ?? body.device_token;
    if (!token) return null;
    const creds: Credentials = {
      accessToken: token,
      ...(body.device_token ? { localWorkerToken: body.device_token } : {}),
      ...(body.user?.email ? { email: body.user.email } : {}),
      ...(body.user?.name ? { name: body.user.name } : {}),
      ...(body.user?.id ? { userId: body.user.id } : {}),
    };
    await saveCredentials(creds, target.name);
    // Bind the local-init org slug to the context so `lobu apply` /
    // `lobu chat` / `lobu org current` find it without a manual
    // `lobu org set <slug>`. The server's bootstrap auto-provisions the
    // single user's personal org and returns it in the response — that
    // slug is the source of truth for this loopback install.
    const orgSlug = body.organization?.slug?.trim();
    if (orgSlug) {
      await setActiveOrg(orgSlug, target.name).catch(() => undefined);
    }
    // Auto-switch the active context so subsequent `lobu apply` / `lobu chat`
    // invocations (without `-c <name>`) hit the same loopback server. Without
    // this, a user previously on the `lobu` cloud context who runs `lobu run`
    // locally still sees cloud for every other command — and the fact that a
    // local context exists is invisible. Announce on stderr so the change is
    // visible but doesn't pollute stdout pipelines.
    try {
      const current = await getCurrentContextName();
      if (current !== target.name) {
        await setCurrentContext(target.name);
        process.stderr.write(
          `Switched active context to "${target.name}" (lobu run)\n`
        );
      }
    } catch {
      // Best-effort — a write failure here shouldn't break the auth flow.
    }
    return creds;
  } catch {
    return null;
  }
}

async function isLoopbackContext(contextName?: string): Promise<boolean> {
  const target = await resolveContext(contextName);
  return isLoopbackUrl(target.url);
}

function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
    );
  } catch {
    return false;
  }
}

function originFromContextUrl(input: string): string {
  const url = new URL(input);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export async function refreshCredentials(
  existing?: Credentials | null,
  contextName?: string
): Promise<Credentials | null> {
  const target = await resolveContext(contextName);

  // Coalesce concurrent refresh attempts for the same context — see the
  // `inFlightRefreshes` declaration for the rotation-race rationale.
  const inFlight = inFlightRefreshes.get(target.name);
  if (inFlight) return inFlight;

  const promise = doRefreshCredentials(target, existing).finally(() => {
    inFlightRefreshes.delete(target.name);
  });
  inFlightRefreshes.set(target.name, promise);
  return promise;
}

async function doRefreshCredentials(
  target: { name: string },
  existing: Credentials | null | undefined
): Promise<Credentials | null> {
  const creds = existing ?? (await loadCredentials(target.name));
  if (!creds) return null;
  if (!credentialCanRefresh(creds)) return creds;
  // A still-valid access token must not be discarded just because it *could* be
  // refreshed: if the refresh token is stale (400 invalid_grant), an eager
  // refresh would collapse a live session to null, so `whoami` reports "Not
  // logged in" while every reactive-refresh command still works. Only refresh
  // when the token is actually near expiry — matching getAgentApiToken.
  if (!credentialNeedsRefresh(creds)) return creds;

  const result = await attemptRefresh(target, creds);
  if (result) return result;

  // Retry once: another CLI process may have rotated the token concurrently.
  // Re-read from disk to pick up the freshly written credentials.
  credentialsCache.delete(target.name);
  const freshCreds = await loadCredentials(target.name);
  if (
    freshCreds?.accessToken &&
    freshCreds.accessToken !== creds.accessToken &&
    !credentialNeedsRefresh(freshCreds)
  ) {
    return freshCreds;
  }

  if (
    freshCreds?.refreshToken &&
    freshCreds.refreshToken !== creds.refreshToken &&
    credentialCanRefresh(freshCreds)
  ) {
    return attemptRefresh(target, freshCreds);
  }

  return null;
}

async function attemptRefresh(
  target: { name: string },
  creds: Credentials
): Promise<Credentials | null> {
  if (!credentialCanRefresh(creds)) return null;

  const refreshed = await refreshTokens(
    creds.oauth.tokenEndpoint,
    { clientId: creds.oauth.clientId, clientSecret: creds.oauth.clientSecret },
    creds.refreshToken,
    // Replay the RFC 8707 indicator the grant was minted with. Without it the
    // issuer rejects a resource-scoped refresh outright (invalid_grant). An
    // unbound grant must send no indicator at all, so pass nothing.
    ...(creds.oauth.resource ? [{ resource: creds.oauth.resource }] : [])
  );
  if (!refreshed) return null;

  const updated: Credentials = {
    ...creds,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? creds.refreshToken,
    expiresAt:
      typeof refreshed.expiresIn === "number"
        ? Date.now() + refreshed.expiresIn * 1000
        : undefined,
  };

  await saveCredentials(updated, target.name);
  return updated;
}
