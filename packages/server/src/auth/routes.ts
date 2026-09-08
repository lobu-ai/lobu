/**
 * Authentication & Account Routes
 *
 * REST endpoints for account and token management:
 * - GET /api/accounts - List user's linked OAuth accounts
 * - GET /api/agents - List OAuth agents (clients) for an organization
 * - POST /api/:orgSlug/tokens - Create org-scoped personal access tokens
 */

import { createHmac } from 'node:crypto';
import { encrypt } from '@lobu/core';
import { type Context, Hono } from 'hono';
import { createDbClientFromEnv } from '../db/client';
import type { Env } from '../index';
import { errorMessage } from '../utils/errors';
import { resolveBaseUrl } from './base-url';
import { createAuth } from './index';
import { mcpAuth, requireAuth } from './middleware';
import { findExistingPersonalOrg } from './personal-org-provisioning';
import { hostOnlyExpiry, sessionCookieName } from './session-cookie-scope';
import { OAuthClientsStore } from './oauth/clients';
import { OAuthProvider } from './oauth/provider';
import { AVAILABLE_PAT_SCOPES, DEFAULT_SCOPES_STRING } from './oauth/scopes';
import { PersonalAccessTokenService } from './tokens';

const credentialRoutes = new Hono<{ Bindings: Env }>();

function getAuthenticatedUser(c: Context<{ Bindings: Env }>) {
  const user = c.get('user');
  if (!user) {
    throw new Error('Authenticated user missing from context');
  }
  return user;
}

/**
 * List user's linked OAuth accounts
 */
credentialRoutes.get('/accounts', requireAuth, async (c) => {
  const user = getAuthenticatedUser(c);
  const sql = createDbClientFromEnv(c.env);

  const result = await sql`
    SELECT
      id,
      "accountId",
      "providerId",
      "accessToken" IS NOT NULL as "hasAccessToken",
      "refreshToken" IS NOT NULL as "hasRefreshToken",
      "accessTokenExpiresAt",
      scope,
      "createdAt"
    FROM "account"
    WHERE "userId" = ${user.id}
    ORDER BY "createdAt" DESC
  `;
  return c.json({ accounts: result });
});

// ============================================
// OAuth Agents Routes
// ============================================

/**
 * List OAuth agents (clients) for an organization
 */
credentialRoutes.get('/agents', requireAuth, async (c) => {
  const user = getAuthenticatedUser(c);
  const orgSlug = c.req.query('org_slug');

  const sql = createDbClientFromEnv(c.env);

  let organizationId: string;

  if (orgSlug) {
    const membership = await sql`
      SELECT m."organizationId" as organization_id
      FROM "member" m
      JOIN "organization" o ON o.id = m."organizationId"
      WHERE m."userId" = ${user.id}
        AND o.slug = ${orgSlug}
      LIMIT 1
    `;
    if (membership.length === 0) {
      return c.json({ error: `Not a member of organization '${orgSlug}'` }, 403);
    }
    organizationId = membership[0].organization_id as string;
  } else {
    // Fall back to user's first org membership
    const defaultOrg = await sql`
      SELECT m."organizationId" as organization_id
      FROM "member" m
      WHERE m."userId" = ${user.id}
      ORDER BY m."createdAt" ASC
      LIMIT 1
    `;
    if (defaultOrg.length === 0) {
      return c.json({ error: 'No organization membership found' }, 404);
    }
    organizationId = defaultOrg[0].organization_id as string;
  }
  const clientsStore = new OAuthClientsStore(sql);
  const agents = await clientsStore.listClientsByOrganization(organizationId);

  return c.json({ agents });
});

// ============================================
// Org-scoped Personal Access Token Routes
// ============================================

// Mintable PAT scopes + default scope live in oauth/scopes.ts — the single
// source of truth for scope definitions.
const AVAILABLE_PAT_SCOPE_SET = new Set<string>(AVAILABLE_PAT_SCOPES);
const DEFAULT_PAT_SCOPE = DEFAULT_SCOPES_STRING;
const MAX_PAT_EXPIRY_DAYS = 3650;

function authorizeTokenCreation(c: Context<{ Bindings: Env }>) {
  const user = c.get('user');
  if (!user?.id) {
    return { error: c.json({ error: 'Unauthorized', message: 'Authentication required' }, 401) };
  }

  const organizationId = c.get('organizationId');
  if (!organizationId) {
    return { error: c.json({ error: 'Organization slug is required in URL' }, 400) };
  }

  const role = c.get('memberRole');
  if (role !== 'owner' && role !== 'admin') {
    return { error: c.json({ error: 'Token creation requires org owner or admin access' }, 403) };
  }

  const authSource = c.get('authSource');
  if (authSource === 'pat') {
    return {
      error: c.json(
        { error: 'Use `lobu login` with OAuth or a web session to create server tokens' },
        403
      ),
    };
  }

  const scopes = c.get('mcpAuthInfo')?.scopes ?? [];
  if (authSource === 'oauth' && !scopes.includes('mcp:admin')) {
    return { error: c.json({ error: 'Token creation requires mcp:admin scope' }, 403) };
  }

  return { user, organizationId };
}

function normalizePatScope(scope: unknown): string | undefined {
  if (scope === undefined || scope === null || scope === '') return DEFAULT_PAT_SCOPE;
  if (typeof scope !== 'string') {
    throw new Error('scope must be a space-separated string');
  }
  const scopes = Array.from(new Set(scope.split(/\s+/).map((value) => value.trim()).filter(Boolean)));
  if (scopes.length === 0) return DEFAULT_PAT_SCOPE;
  const invalid = scopes.filter((value) => !AVAILABLE_PAT_SCOPE_SET.has(value));
  if (invalid.length > 0) {
    throw new Error(`Invalid scope(s): ${invalid.join(', ')}`);
  }
  return scopes.join(' ');
}

function normalizeExpiryDays(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > MAX_PAT_EXPIRY_DAYS) {
    throw new Error(`expiresInDays must be an integer between 1 and ${MAX_PAT_EXPIRY_DAYS}`);
  }
  return days;
}

/**
 * Create an org-scoped Personal Access Token for servers/CI.
 * Requires an owner/admin web session or OAuth bearer with mcp:admin scope.
 */
credentialRoutes.post('/:orgSlug/tokens', mcpAuth, async (c) => {
  const authorized = authorizeTokenCreation(c);
  if ('error' in authorized) return authorized.error;

  const body = await c.req.json<{
    name?: string;
    description?: string;
    scope?: string;
    expiresInDays?: number;
  }>();

  const name = body.name?.trim();
  if (!name) {
    return c.json({ error: 'name is required' }, 400);
  }

  const description = typeof body.description === 'string' ? body.description.trim() : undefined;
  const sql = createDbClientFromEnv(c.env);
  const patService = new PersonalAccessTokenService(sql);

  try {
    const token = await patService.create(authorized.user.id, authorized.organizationId, name, {
      ...(description ? { description } : {}),
      scope: normalizePatScope(body.scope),
      expiresInDays: normalizeExpiryDays(body.expiresInDays),
    });
    return c.json({ token }, 201);
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }
});

/**
 * IPv4/IPv6 loopback peer check. Matches what
 * `packages/server/src/utils/loopback.ts:isLoopbackHost` did before it
 * was deleted in lobu#827, kept inline here so this file owns the
 * `/local-init` trust boundary without depending on that helper file
 * coming back.
 *
 * Accepts: 127.0.0.0/8, ::1, ::ffff:127.0.0.0/8 (IPv4-mapped IPv6).
 */
function isLoopbackAddress(addr: string): boolean {
  if (!addr) return false;
  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '[::1]') return true;
  // IPv4-mapped IPv6 form Node sometimes hands us when bound to ::
  const ipv4 = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
  return ipv4.startsWith('127.');
}

/**
 * Loopback trust boundary for /local-init. Returns an error payload when the
 * caller isn't a trusted loopback client, or null when it passes. Layered
 * checks: the TCP peer must be loopback (primary
 * boundary), no forwarded-* headers (a proxy fronting the bind isn't local),
 * and an X-Lobu-Client header (CSRF gate — a foreign web page can't add it
 * without a preflight, which CORS rejects).
 */
function assertLoopbackClient(
  c: Context<{ Bindings: Env }>
): { error: string; error_description: string } | null {
  const peer = c.var.peerRemoteAddress;
  const allowMissingPeer = c.env.LOBU_LOCAL_INIT_ALLOW_MISSING_PEER === '1';
  if (!peer && !allowMissingPeer) {
    return {
      error: 'missing_peer',
      error_description:
        'This endpoint requires a TCP peer address to enforce loopback. Set LOBU_LOCAL_INIT_ALLOW_MISSING_PEER=1 only in tests.',
    };
  }
  if (peer && !isLoopbackAddress(peer)) {
    return {
      error: 'non_loopback_peer',
      error_description:
        'This endpoint refuses non-loopback connections. The embedded runner should bind to 127.0.0.1; check HOST.',
    };
  }
  const proxied =
    c.req.header('x-forwarded-for') ||
    c.req.header('x-forwarded-host') ||
    c.req.header('x-forwarded-proto') ||
    c.req.header('x-real-ip') ||
    c.req.header('forwarded');
  // Tailscale Serve / local reverse proxies connect to 127.0.0.1 (peer is
  // loopback) but inject Forwarded-*. Public tunnels (Funnel, ngrok) look the
  // same — refuse by default so a misconfigured public frontend can't mint
  // passwordless sessions. Operators who intentionally reach a single-user
  // install over private Tailscale Serve set LOBU_LOCAL_INIT_ALLOW_PROXY=1.
  if (proxied && c.env.LOBU_LOCAL_INIT_ALLOW_PROXY !== '1') {
    return {
      error: 'proxied_request_refused',
      error_description:
        'This endpoint is for loopback callers only. Forwarded-* headers are not allowed. For private Tailscale Serve, set LOBU_LOCAL_INIT_ALLOW_PROXY=1 on the host (single-user installs only).',
    };
  }
  if (!c.req.header('x-lobu-client')) {
    return {
      error: 'missing_client_header',
      error_description:
        'This endpoint requires the X-Lobu-Client header (CSRF mitigation). Native clients and the SPA set it; foreign web pages can\'t.',
    };
  }
  return null;
}

/**
 * Mint a Better Auth session for a user and return the raw session token.
 *
 * The same token works two ways: baked into the session cookie (first-party
 * deep links, below) or sent as `Authorization: Bearer <token>` by non-cookie
 * clients (the CLI, the macOS app, and the Owletto extension's embedded
 * side-panel iframe). The cloud auth bridge resolves both — see
 * `createLobuAuthBridge`, which passes the request headers to Better Auth so
 * the `bearer()` plugin honours the header form.
 */
async function createSessionToken(
  c: Context<{ Bindings: Env }>,
  userId: string,
  activeOrganizationId?: string | null
): Promise<string | null> {
  const auth = await createAuth(c.env, c.req.raw);
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(
    userId,
    undefined,
    activeOrganizationId ? { activeOrganizationId } : undefined
  );
  return session?.token ?? null;
}

/**
 * Mint a Better Auth session for a user and return the first-party Set-Cookie
 * value (SameSite=Lax, +Secure on https). For deep links that land in a
 * top-level browser tab — the CLI/menu-bar `GET /exchange-token` and
 * `/local-init`. Cross-site embeds (the extension iframe) can't rely on this
 * cookie and use Bearer auth via `/extension-session` instead.
 */
async function mintSessionCookieValue(
  c: Context<{ Bindings: Env }>,
  userId: string
): Promise<
  | {
      cookieName: string;
      cookieHeader: string;
      hostOnlyExpiryHeader: string | null;
      sessionToken: string;
    }
  | { error: string }
> {
  const secret = c.env.BETTER_AUTH_SECRET;
  if (!secret) return { error: 'BETTER_AUTH_SECRET not set' };

  const sessionToken = await createSessionToken(c, userId);
  if (!sessionToken) return { error: 'failed to mint session' };

  // Cookie shape: `<token>.<base64(HMAC-SHA256(token, secret))>`, URL-encoded.
  const sig = createHmac('sha256', secret).update(sessionToken).digest('base64');
  const cookieValue = encodeURIComponent(`${sessionToken}.${sig}`);
  // __Secure- prefix iff the canonical baseURL is https — matches whatever
  // Better Auth would set during normal sign-in even when TLS is terminated
  // by a reverse proxy and the bind itself speaks plain HTTP.
  const baseUrl = resolveBaseUrl({ request: c.req.raw });
  const isHttps = baseUrl.startsWith('https://');
  const cookieName = sessionCookieName(isHttps);

  const parts = [
    `${cookieName}=${cookieValue}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 7}`,
  ];
  // Must carry the SAME Domain Better Auth uses — a host-only twin here bricks
  // login permanently. Why: auth/session-cookie-scope.ts.
  const cookieDomain = process.env.AUTH_COOKIE_DOMAIN;
  if (cookieDomain) parts.push(`Domain=${cookieDomain}`);
  if (isHttps) parts.push('Secure');
  return {
    cookieName,
    cookieHeader: parts.join('; '),
    // Kill any host-only twin left by an older build of this route (or by a
    // document.cookie plant) in the same response that sets the real cookie.
    hostOnlyExpiryHeader: cookieDomain ? hostOnlyExpiry(cookieName, isHttps) : null,
    sessionToken,
  };
}

/**
 * Resolve a `?token=…` deep-link credential to its user and organization.
 * Accepts all three credential shapes the deep-link callers hold:
 *   - Personal Access Tokens (`owl_pat_*`, `personal_access_tokens`)
 *   - OAuth 2.1 access tokens (`oauth_tokens`) — what the Owletto extension's
 *     device-code pairing issues; without this the cloud-paired iframe 401s at
 *     /api/exchange-token and renders signed-out
 *   - Better Auth session tokens (`session`) — the macOS menu bar / local-init
 *     hold one and deep-link into the SPA without ever issuing a PAT
 *
 * OAuthProvider.verifyAccessToken already covers the first two; the session
 * lookup is the fallback for the third.
 */
async function resolveDeepLinkToken(
  c: Context<{ Bindings: Env }>,
  token: string
): Promise<{ userId: string; organizationId: string | null } | null> {
  const sql = createDbClientFromEnv(c.env);
  const baseUrl = resolveBaseUrl({ request: c.req.raw });
  const authInfo = await new OAuthProvider(sql, baseUrl).verifyAccessToken(token);
  if (authInfo?.userId) {
    return {
      userId: authInfo.userId,
      organizationId: authInfo.organizationId,
    };
  }
  // Otherwise treat it as a Better Auth session token. Better Auth's adapter
  // looks it up by the raw token (the unsigned half of the cookie value).
  const auth = await createAuth(c.env, c.req.raw);
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.findSession(token);
  if (!session?.session?.userId) return null;
  return {
    userId: session.session.userId,
    organizationId: session.session.activeOrganizationId ?? null,
  };
}

/**
 * Exchange a deep-link token (PAT or Better Auth session token) for a
 * first-party Better Auth session cookie scoped to the same user, then 302 to
 * `next`.
 *
 * Lets a holder of a valid bootstrap PAT / menu-bar session hop into the
 * web UI without typing a password. `next` is restricted to relative paths
 * to prevent open-redirect abuse; Referrer-Policy keeps the token out of
 * the next page's Referer.
 *
 * GET only — the CLI/menu-bar deep link, in a top-level browser tab, with the
 * token in the query string. The cross-site extension iframe can't use this
 * cookie; it uses Bearer auth via `/extension-session` (see extension-bootstrap).
 */
async function handleExchangeToken(
  c: Context<{ Bindings: Env }>,
  token: string | undefined,
  rawNext: string | undefined
) {
  c.header('Referrer-Policy', 'no-referrer');

  const trimmed = token?.trim();
  if (!trimmed) {
    return c.json(
      { error: 'missing_token', error_description: 'token is required' },
      400
    );
  }

  const identity = await resolveDeepLinkToken(c, trimmed);
  if (!identity) {
    return c.json(
      { error: 'invalid_token', error_description: 'token is invalid, expired, or revoked' },
      401
    );
  }

  const minted = await mintSessionCookieValue(c, identity.userId);
  if ('error' in minted) {
    return c.json(
      { error: 'session_create_failed', error_description: minted.error },
      500
    );
  }
  c.header('Set-Cookie', minted.cookieHeader);
  if (minted.hostOnlyExpiryHeader) {
    c.header('Set-Cookie', minted.hostOnlyExpiryHeader, { append: true });
  }

  const next = rawNext ?? '/';
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  return c.redirect(safeNext, 302);
}

credentialRoutes.get('/exchange-token', async (c) =>
  handleExchangeToken(c, c.req.query('token'), c.req.query('next'))
);

/**
 * Exchange a deep-link token (PAT / OAuth / Better Auth session) for a fresh
 * Better Auth session token, returned in the JSON body for Bearer use.
 *
 * The Owletto extension's side-panel iframe is a CROSS-SITE iframe (top-level
 * origin `chrome-extension://…`); a session cookie set here is unreliable
 * inside that partition. So instead of a cookie, the iframe gets the raw
 * session token and sends it as `Authorization: Bearer` — which the cloud auth
 * bridge already accepts (it passes request headers to Better Auth's
 * `getSession`, and the `bearer()` plugin honours the header). Same token
 * shape `/local-init` hands non-cookie clients.
 */
credentialRoutes.post('/extension-session', async (c) => {
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');

  const body = await c.req.parseBody();
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) {
    return c.json(
      { error: 'missing_token', error_description: 'token is required' },
      400
    );
  }

  const identity = await resolveDeepLinkToken(c, token);
  if (!identity) {
    return c.json(
      { error: 'invalid_token', error_description: 'token is invalid, expired, or revoked' },
      401
    );
  }

  const sessionToken = await createSessionToken(
    c,
    identity.userId,
    identity.organizationId
  );
  if (!sessionToken) {
    return c.json(
      { error: 'session_create_failed', error_description: 'failed to mint session' },
      500
    );
  }
  return c.json({ session_token: sessionToken });
});

// TTL for SSE tickets — long enough to cover a single agent response (incl.
// EventSource auto-reconnects mid-stream), short enough that a leaked URL is
// near-useless. The SPA mints a fresh ticket per stream.
const SSE_TICKET_TTL_MS = 10 * 60 * 1000;

/**
 * Mint a short-lived ticket the embedded SPA appends to SSE URLs as `?token=`.
 *
 * EventSource can't send `Authorization`, so the cross-site iframe (which has
 * no session cookie) can't authenticate its streams the way `fetch` does. This
 * endpoint — authenticated by the Bearer session token the SPA already holds —
 * returns an encrypted, short-lived token (the same `verifySettingsToken`
 * shape) carrying just the user id. Stateless: any replica decrypts it, so it's
 * multi-replica safe with no shared store. The raw session token never goes in
 * a URL.
 */
credentialRoutes.get('/sse-ticket', async (c) => {
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');

  const authHeader = c.req.header('Authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!bearer) {
    return c.json(
      { error: 'unauthorized', error_description: 'Bearer token required' },
      401
    );
  }

  const identity = await resolveDeepLinkToken(c, bearer);
  if (!identity) {
    return c.json(
      { error: 'invalid_token', error_description: 'token is invalid, expired, or revoked' },
      401
    );
  }

  // platform: 'external' matches the owletto web/cookie session shape so the
  // agent-ownership check (`verifyOwnedAgentAccess`, which keys on platform)
  // resolves the SAME owner it would for a first-party web session. No jti →
  // no revocation lookup needed; the short TTL is the bound.
  const ticket = encrypt(
    JSON.stringify({
      userId: identity.userId,
      platform: 'external',
      exp: Date.now() + SSE_TICKET_TTL_MS,
    })
  );
  return c.json({ ticket });
});

/**
 * Bootstrap page for the Lobu extension's side-panel iframe.
 *
 * The extension mounts the iframe at this route with the deep-link token in the
 * URL **fragment** (`#token=…&worker=…`) — fragments are never sent to a server
 * and the page strips it from history immediately, so the long-lived token
 * never appears in a request URL, server log, or browser history entry. The
 * page POSTs the token to /api/extension-session (same-origin), stashes the
 * returned Better Auth session token in `sessionStorage` for the SPA to send as
 * `Authorization: Bearer`, then redirects the iframe to the app. No session
 * cookie is involved — a cross-site iframe can't depend on one.
 */
credentialRoutes.get('/extension-bootstrap', (c) => {
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
  // Inline script and style are allowed: the app's CSP sets only
  // frame-ancestors, no script-src or style-src. The page carries no markup an
  // injection could target.
  return c.html(
    `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="dark"><title>Connecting…</title><style>html,body{background:#0a0a0a;color:#a8a29e;margin:0;font:13px/1.45 system-ui,sans-serif}</style><body><script>
(function () {
  var h = new URLSearchParams(location.hash.slice(1));
  var token = h.get("token") || "";
  var worker = h.get("worker") || "";
  var run = h.get("run") || "";
  var agent = h.get("agent") || "";
  var thread = h.get("thread") || "";
  var message = h.get("message") || h.get("message_id") || "";
  // Strip the token out of the URL before doing anything else.
  history.replaceState(null, "", location.pathname);
  // Chrome extension deep links (sidepanel): conversation handoff, Memory run,
  // or device page. Prefer agent+thread (browser handoff conversation) over
  // run (Memory peek) over worker (device). SPA home (/) re-reads the hash.
  var next = "/";
  if (agent && thread) {
    next =
      "/#agent=" +
      encodeURIComponent(agent) +
      "&thread=" +
      encodeURIComponent(thread);
    if (message) {
      next += "&message=" + encodeURIComponent(message);
    }
  } else if (run) {
    next = "/#run=" + encodeURIComponent(run);
  } else if (worker) {
    next = "/#worker=" + encodeURIComponent(worker);
  }
  if (!token) { location.replace("/"); return; }
  var retried = false;
  var activeAttempt = null;
  function fail(msg) {
    // Surface a real error instead of redirecting to a token-less app, which
    // would just render signed-out and hang on a spinner — the exact failure
    // this whole flow exists to avoid. Retry re-submits the SAME deep-link
    // token captured in the URL fragment, so once it has failed at least once
    // we also offer an escape hatch to the panel's Settings (change-server /
    // re-pair) — the only path that recovers a token this page can't refresh.
    document.body.innerHTML =
      '<div style="font:14px/1.5 system-ui,sans-serif;color:#e7e5e4;padding:24px;max-width:24rem">' +
      '<p style="margin:0 0 .5rem;font-weight:600">Could not connect to Lobu.</p>' +
      '<p style="margin:0 0 1rem;color:#a8a29e"></p>' +
      '<button id="owl-retry" style="font:inherit;padding:.4rem .9rem;border:1px solid #3f3f46;border-radius:.4rem;background:#18181b;color:inherit;cursor:pointer">Retry</button>' +
      (retried
        ? '<button id="owl-settings" style="font:inherit;margin-left:.5rem;padding:.4rem .9rem;border:1px solid #3f3f46;border-radius:.4rem;background:#18181b;color:inherit;cursor:pointer">Change server</button>'
        : '') +
      '</div>';
    document.querySelectorAll("p")[1].textContent = msg;
    var b = document.getElementById("owl-retry");
    if (b) b.onclick = function () { retried = true; attempt(); };
    // The bootstrap page is a cross-origin iframe inside the extension side
    // panel and can't open Settings itself — ask the panel parent to switch to
    // its Settings view (origin-checked on the receiving end).
    var s = document.getElementById("owl-settings");
    if (s) s.onclick = function () {
      try { window.parent.postMessage({ owletto: "open-settings" }, "*"); } catch (e) {}
    };
  }
  function attempt() {
    if (activeAttempt) {
      clearTimeout(activeAttempt.timer);
      activeAttempt.controller.abort();
    }
    var current = { controller: new AbortController(), timer: null };
    activeAttempt = current;
    current.timer = setTimeout(function () {
      if (activeAttempt !== current) return;
      activeAttempt = null;
      current.controller.abort();
      fail("Connection timed out. Check your connection and retry.");
    }, 15000);
    document.body.textContent = "Connecting\\u2026";
    var body = new URLSearchParams();
    body.set("token", token);
    fetch("/api/extension-session", {
      signal: current.controller.signal,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (activeAttempt !== current) return;
        if (data && data.session_token) {
          try { sessionStorage.setItem("owletto.session_token", data.session_token); } catch (e) {}
          location.replace(next);
        } else {
          fail("Your session may have expired. Re-pair from the extension if this keeps happening.");
        }
      })
      .catch(function () {
        if (activeAttempt === current) fail("Network error reaching the gateway.");
      })
      .finally(function () {
        clearTimeout(current.timer);
        if (activeAttempt === current) activeAttempt = null;
      });
  }
  attempt();
})();
</script></body>`
  );
});

/**
 * Mint a Better Auth session + worker PAT for the install's single user.
 *
 * Used by the macOS menu bar and the CLI's `local` context — both run on
 * the same host as the server, both want a credential they can send as
 * `Authorization: Bearer <session-token>` without prompting the user for
 * an OAuth device flow.
 *
 * Identity model: the install has exactly one user (enforced by
 * `LOBU_SINGLE_USER` + the sign-up-blocking hook in auth/index.tsx).
 * Whatever email the operator used at /sign-up is the identity; local-init
 * finds that user and mints credentials for them. There is no pre-seeded
 * placeholder. When the DB has zero users, we return `no_user_yet` and
 * point the caller at /sign-up.
 *
 * Trust model:
 *   - Requires a loopback TCP peer (the server must be reached via 127.0.0.1
 *     on the host — Tailscale Serve qualifies; a remote TCP peer does not).
 *   - Refuses when any `x-forwarded-*` / `forwarded` header is present,
 *     unless `LOBU_LOCAL_INIT_ALLOW_PROXY=1` (opt-in for private Tailscale
 *     Serve). Public tunnels (Funnel, ngrok) must not set this — the bind
 *     looks local but the exposure isn't.
 *   - Refuses when the deployment has more than one user.
 *   - Refuses when the single user has no personal org (shouldn't happen —
 *     databaseHooks.user.create.after provisions one).
 *
 * Returns the session token in the response body too, so non-cookie
 * clients (CLI persisting to ~/.config/lobu/credentials.json, Mac app
 * persisting in OAuthCredentials) can send it as Bearer next time.
 */

credentialRoutes.post('/local-init', async (c) => {
  // Loopback trust boundary (TCP peer + forwarded-* + X-Lobu-Client). The
  // embedded runner binds 127.0.0.1, but an operator may override HOST=0.0.0.0
  // and expose this to the LAN — the peer check is the primary boundary, and
  // we fail CLOSED when peer metadata is absent (only in-process test fetches
  // lack it, which opt in via LOBU_LOCAL_INIT_ALLOW_MISSING_PEER).
  const guardError = assertLoopbackClient(c);
  if (guardError) {
    return c.json(guardError, 403);
  }

  const sql = createDbClientFromEnv(c.env);
  // Find the single user this install belongs to. Prefer the real human
  // (if one has signed up via /sign-up) over the synthetic install_operator
  // row (auto-provisioned at boot in ensureInstallOperator). Ordering by
  // principal_kind keeps 'install_operator' last so a human comes first
  // when both exist; on a fresh install before signup, only the operator
  // row exists and it gets minted credentials. See
  // docs/plans/install-operator-bootstrap.md.
  const userRows = (await sql`
    SELECT id, email, name, principal_kind
      FROM "user"
     ORDER BY
       CASE WHEN principal_kind = 'install_operator' THEN 1 ELSE 0 END ASC,
       "createdAt" ASC
     LIMIT 2
  `) as unknown as Array<{
    id: string;
    email: string;
    name: string;
    principal_kind: string;
  }>;

  if (userRows.length === 0) {
    // Should be unreachable: ensureInstallOperator runs before listen.
    // Treat as a defensive 500 rather than a 404 so the operator notices
    // the missing boot step instead of falling into the "sign up first"
    // copy path that no longer applies.
    return c.json(
      {
        error: 'unexpected_empty_user_table',
        error_description:
          'No user rows exist on this install. ensureInstallOperator() should run at boot — check server logs for a provisioning failure.',
      },
      500
    );
  }
  // After excluding the synthetic install_operator, "multiple users"
  // means the install has graduated past single-user mode and /local-init
  // no longer applies — those operators sign in via the normal
  // /api/auth/sign-in/email flow.
  const humanRows = userRows.filter((r) => r.principal_kind !== 'install_operator');
  if (humanRows.length > 1) {
    return c.json(
      {
        error: 'not_single_user',
        error_description:
          '/api/local-init is only for single-user local installs. This deployment has multiple users; sign in normally via /api/auth/sign-in/email.',
      },
      404
    );
  }
  // Prefer the human (if any); fall back to the install_operator on a
  // fresh install where no signup has happened yet.
  const user = humanRows[0] ?? userRows[0]!;

  // Find the user's personal org (provisioned by databaseHooks.user.create.after).
  const org = await findExistingPersonalOrg(user.id, sql);
  if (!org) {
    return c.json(
      {
        error: 'personal_org_missing',
        error_description:
          "User exists but has no personal org. databaseHooks.user.create.after may not have run; can't mint a worker PAT without an org binding.",
      },
      500
    );
  }

  const minted = await mintSessionCookieValue(c, user.id);
  if ('error' in minted) {
    return c.json(
      { error: 'session_create_failed', error_description: minted.error },
      500
    );
  }
  c.header('Set-Cookie', minted.cookieHeader);
  if (minted.hostOnlyExpiryHeader) {
    c.header('Set-Cookie', minted.hostOnlyExpiryHeader, { append: true });
  }

  // The session token alone is not enough for native worker callers — the
  // /api/workers/* middleware checks for `device_worker:run` / `mcp:admin`
  // in mcpAuthInfo.scopes, and a Better Auth session carries no scopes.
  // Mint a worker-scoped PAT alongside the session so the menu bar's
  // automation poll loop and the Chrome extension's device-worker poll both
  // work zero-config. PostgreSQL still holds the truth (PAT hash in
  // `personal_access_tokens`, session row in `session`); nothing on disk.
  const workerPat = await new PersonalAccessTokenService(sql).create(
    user.id,
    org.id,
    'local-init',
    {
      description: 'Auto-minted by POST /api/local-init for local-runner clients.',
      // `profile:read` lets the same PAT hit `/oauth/userinfo`, which the
      // gateway's `createApiAuthMiddleware` (used by `/lobu/api/v1/agents/*`)
      // and the CLI's `lobu apply` org-resolution path both call. Without it
      // the PAT works for `/api/<orgSlug>/*` and worker poll but is rejected
      // by the agent-session and userinfo endpoints with a confusing 403/404.
      scope: 'device_worker:run mcp:read mcp:write mcp:admin profile:read',
    }
  );

  return c.json({
    session_token: minted.sessionToken,
    cookie_name: minted.cookieName,
    // PAT plaintext — clients use this as `Authorization: Bearer <token>`
    // for everything (`/api/workers/poll`, MCP, REST). Long-lived; clients
    // are expected to persist in OS-level secure storage (Keychain,
    // chrome.storage.local, ~/.config/lobu/credentials.json).
    device_token: workerPat.token,
    device_token_scope: workerPat.scope,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
    organization: {
      id: org.id,
      slug: org.slug,
      name: org.name,
    },
  });
});

export { credentialRoutes };
