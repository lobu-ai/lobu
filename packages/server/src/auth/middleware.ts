/**
 * Authentication middleware for Hono
 *
 * mcpAuth handles OAuth/PAT/session/anonymous.
 */

import type { Context, Next } from 'hono';
import type { Env } from '../index';
import { getWorkspaceProvider } from '../workspace';
import type { ResolveAuthNext } from '../workspace/types';
import { createAuth } from './index';
import type { AuthInfo } from './oauth/types';
import { resolveSession } from './resolve-session';
import logger from '../utils/logger';

// Extend Hono context with auth properties
declare module 'hono' {
  interface ContextVariableMap {
    user: {
      id: string;
      name: string;
      email: string;
      emailVerified: boolean;
      image?: string | null;
      phoneNumber?: string | null;
      phoneNumberVerified?: boolean | null;
    } | null;
    session: {
      id: string;
      userId: string;
      token: string;
      expiresAt: Date;
      activeOrganizationId?: string | null;
    } | null;
    organizationId: string | null;
    memberRole: string | null;
    mcpAuthInfo: AuthInfo | null;
    mcpIsAuthenticated: boolean;
    subdomainOrg: string | null;
    /**
     * TCP remote address of the actual peer, captured by the env-swap
     * middleware in server.ts / start-local.ts before c.env's bindings
     * (which include `incoming.socket`) are replaced with the app config.
     * Loopback-trust endpoints like `/api/local-init` use this to enforce
     * "real peer is loopback" regardless of what HOST the server bound to.
     */
    peerRemoteAddress: string | null;
    /**
     * How the current request authenticated. Set by `mcpAuth` /
     * `MultiTenantProvider.resolveAuth`. Admin-tier routes that previously
     * implicitly assumed web-session auth use this to refuse weak PATs.
     *
     * - `session`     — better-auth session cookie (web app)
     * - `pat`         — `owl_pat_*` bearer (Personal Access Token)
     * - `oauth`       — OAuth 2.1 access token bearer (incl. `lobu login`)
     * - `null`        — anonymous / unauthenticated request
     */
    authSource: 'session' | 'pat' | 'oauth' | null;
    /**
     * Set by the /api/workers/* middleware. Tells worker handlers what trust
     * model this request operates under.
     *
     * - `trusted`     — request matched WORKER_API_TOKEN (server-side fleet)
     * - `user`        — authenticated as a Lobu user (e.g. Lobu for Mac); poll
     *                   and stream MUST filter on `workerOrgIds`
     * - `anonymous`   — local dev only (no WORKER_API_TOKEN, no user auth)
     */
    workerAuthMode: 'trusted' | 'user' | 'anonymous' | null;
    /** The user.id when workerAuthMode === 'user', else null. */
    workerUserId: string | null;
    /** The user's org memberships when workerAuthMode === 'user', else null. */
    workerOrgIds: string[] | null;
  }
}

/**
 * Middleware: Require valid session
 */
export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const auth = await createAuth(c.env);
  try {
    const session = await resolveSession(auth, c.req.raw.headers);
    if (!session || !session.user) {
      return c.json({ error: 'Unauthorized', message: 'Valid session required' }, 401);
    }
    c.set('user', session.user);
    c.set('session', session.session);
    return next();
  } catch (error) {
    logger.error({ err: error }, '[Auth] Session check failed');
    return c.json({ error: 'Unauthorized', message: 'Session validation failed' }, 401);
  }
}

/**
 * Middleware: MCP authentication (optional auth for MCP endpoints)
 * Delegates entirely to WorkspaceProvider.resolveAuth.
 *
 * `next` is typed as `ResolveAuthNext` (`() => Promise<Response | void>`) so
 * callers that use `mcpAuth(c, cb)` with an `async` callback that may
 * short-circuit by returning a `Response` (e.g. the /api/workers/* gating
 * middleware) actually have that Response propagate back. Hono's own `Next`
 * (`() => Promise<void>`) is a subtype, so plain `app.use(..., mcpAuth)`
 * usage is unchanged.
 *
 * See `workspace/types.ts::ResolveAuthNext` for the widening rationale —
 * the prior `next as Next` cast silently dropped the cb's Response and
 * caused Bug B (workers/poll 500s with the undici RangeError).
 */
export async function mcpAuth(c: Context<{ Bindings: Env }>, next: ResolveAuthNext | Next) {
  return getWorkspaceProvider().resolveAuth(c, next as ResolveAuthNext);
}
