/**
 * Session resolution that does not depend on cookie order.
 *
 * One auth cookie name can exist at two scopes at once — host-only and
 * `Domain=`-scoped — and the browser sends both in one header. Position then
 * decides who authenticates, and position is not ours to choose: RFC 6265 §5.4
 * sends the oldest first, better-call's `parseCookies` keeps the first
 * occurrence (`if (!cookies.has(key))`), and `getSignedCookie` reads that one
 * and stops. An older stale twin therefore outranks every later sign-in, which
 * can never win because it is always the newer cookie. Prod, 2026-08-06:
 * `dead; good` → null, `good; dead` → the session.
 */

import { resolveBaseUrl } from './base-url';
import { convergeResponseCookieScope, sessionCookieName } from './session-cookie-scope';

/** Both spellings coexist: a jar can outlive an http→https switch. */
const SESSION_COOKIE_NAMES = [sessionCookieName(false), sessionCookieName(true)];

/**
 * `Cookie` is attacker-controlled and each probe is a session lookup, so an
 * unbounded loop amplifies one request into ~100. Real jars hold two or three.
 */
const MAX_CANDIDATES = 8;

type SessionCookieCandidate = { name: string; value: string };

/** Generic, so wrapping `getSession` never widens what a call site sees. */
type SessionReader = {
  api: { getSession: (opts: { headers: Headers }) => Promise<any> };
};
type SessionOf<A extends SessionReader> = Awaited<ReturnType<A['api']['getSession']>>;

/**
 * Every session cookie in a `Cookie` header, in the order sent.
 *
 * Each keeps the name it arrived under: `getSession` reads exactly one name and
 * is blind to the other spelling, so renaming a candidate hides it entirely.
 */
export function sessionCookieCandidates(
  cookieHeader: string | null | undefined
): SessionCookieCandidate[] {
  if (!cookieHeader) return [];
  const candidates: SessionCookieCandidate[] = [];
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    // Exact name, so `<name>_other` is never mistaken for `<name>`.
    const name = part.slice(0, eq).trim();
    if (!SESSION_COOKIE_NAMES.includes(name)) continue;
    const value = part.slice(eq + 1).trim();
    if (value) candidates.push({ name, value });
  }
  return candidates;
}

/**
 * `user`, not `user && session`: four call sites (auth/middleware.ts,
 * auth/oauth/routes.ts, connect/routes.ts, worker-api/auth-runs.ts) check
 * `user` alone, so a stricter test would reject on a duplicated jar what they
 * accept on a clean one.
 */
function isLive(session: any): boolean {
  return Boolean(session?.user);
}

/**
 * The jar minus its session cookies. Companions must survive a probe:
 * `better-auth.dont_remember` gates session-expiry refresh, so dropping it
 * would give a duplicated jar different refresh terms than a clean one.
 */
function nonSessionCookies(cookieHeader: string | null): string[] {
  if (!cookieHeader) return [];
  const kept: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const pair = part.trim();
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (SESSION_COOKIE_NAMES.includes(pair.slice(0, eq).trim())) continue;
    kept.push(pair);
  }
  return kept;
}

/**
 * Drop-in for `auth.api.getSession({ headers })` that resolves on merit.
 *
 * A one-cookie jar takes the original call unchanged; the extra lookups happen
 * only for a jar that is already broken.
 */
export async function resolveSession<A extends SessionReader>(
  auth: A,
  headers: Headers
): Promise<SessionOf<A>> {
  const live = await findLiveProbe(auth, headers);
  if (!live) return await auth.api.getSession({ headers });
  // Resolving on merit must not become "authenticate on anything".
  return (live.session ?? null) as SessionOf<A>;
}

/**
 * Probe an ambiguous jar one candidate at a time.
 *
 * `null` when the jar is not ambiguous. Otherwise the winning headers and the
 * session they produced — returning both keeps the lookup from being repeated —
 * with `session: null` when nothing verified.
 *
 * A probe changes exactly one thing: which session cookie is present. Other
 * headers and other cookies ride along, so `Authorization: Bearer` and origin
 * checks behave as before.
 */
async function findLiveProbe<A extends SessionReader>(
  auth: A,
  headers: Headers
): Promise<{ headers: Headers; session: SessionOf<A> | null } | null> {
  const cookieHeader = headers.get('cookie');
  const candidates = sessionCookieCandidates(cookieHeader);
  if (candidates.length <= 1) return null;

  const companions = nonSessionCookies(cookieHeader);
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    const probe = new Headers(headers);
    probe.set(
      'cookie',
      [...companions, `${candidate.name}=${candidate.value}`].join('; ')
    );
    const session = await auth.api.getSession({ headers: probe });
    if (isLive(session)) return { headers: probe, session };
  }
  // Placeholder headers: every caller branches on `session` before reading them.
  return { headers, session: null };
}

/**
 * The jar with its ambiguity already removed, for code that must hand the
 * request to a reader that resolves it itself — Better Auth's `/api/auth/*`
 * handler. That is where `get-session` lives, the call the web app uses to ask
 * whether it is signed in, so leaving it order-dependent would keep the brick
 * visible in the UI with every internal call site fixed.
 *
 * Ordinary jars come back by identity, so the common path does not even copy.
 */
export async function collapseSessionCookies<A extends SessionReader>(
  auth: A,
  headers: Headers
): Promise<Headers> {
  const live = await findLiveProbe(auth, headers);
  if (!live) return headers;
  if (live.session) return live.headers;

  // Nothing verified. Strip the session cookie rather than pass an arbitrary
  // dead twin, so sign-in and sign-out on this request cannot act on one.
  const companions = nonSessionCookies(headers.get('cookie'));
  const stripped = new Headers(headers);
  if (companions.length > 0) stripped.set('cookie', companions.join('; '));
  else stripped.delete('cookie');
  return stripped;
}

type AuthHandler = SessionReader & { handler: (request: Request) => Promise<Response> };

/**
 * Serve one Better Auth request the way `/api/auth/*` does: a JSON POST with an
 * empty body gets `{}` (better-call crashes on it), the cookie jar is collapsed
 * to the live session first, and the response's cookies are converged back to
 * one scope. Server-side callers that sign a browser out go through this too,
 * so the cookie hygiene is the same no matter which route triggered it.
 */
export async function serveAuthRequest(auth: AuthHandler, incoming: Request): Promise<Response> {
  let request = incoming;
  if (
    request.method === 'POST' &&
    (request.headers.get('content-type') || '').includes('application/json') &&
    request.headers.get('content-length') === '0'
  ) {
    request = new Request(request.url, { method: request.method, headers: request.headers, body: '{}' });
  }
  const collapsed = await collapseSessionCookies(auth, request.headers);
  if (collapsed !== request.headers) {
    request = new Request(request.url, {
      method: request.method,
      headers: collapsed,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.blob(),
    });
  }
  const response = await auth.handler(request);
  return convergeResponseCookieScope(response, {
    cookieDomain: process.env.AUTH_COOKIE_DOMAIN,
    isHttps: resolveBaseUrl({ request: incoming }).startsWith('https://'),
  });
}
