import { verifyWorkerToken } from "@lobu/core";
import type { Context, Next } from "hono";
import { orgContext } from "../../lobu/stores/org-context.js";
import {
  verifySettingsSession,
  verifySettingsSessionOrToken,
} from "../routes/public/settings-auth.js";
import type { ExternalAuthClient } from "./external/client.js";
import { getRevokedTokenStore } from "./revoked-token-store.js";

export const TOKEN_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/**
 * Caller identity surfaced to handlers via `c.get("authContext")` after a
 * successful auth check. `organizationId` is the token-bound or personal-org
 * id when the auth path can resolve one (worker token payload, or
 * `/oauth/userinfo` org slug); otherwise undefined. `createAgent` treats it as
 * the caller's authoritative org for the tenant guard and as the session's
 * org fallback.
 */
interface ApiAuthContext {
  userId?: string;
  organizationId?: string;
}

declare module "hono" {
  interface ContextVariableMap {
    authContext?: ApiAuthContext;
  }
}

/**
 * Creates a Hono middleware that enforces the standard auth check:
 *   1. Settings session cookie  2. Worker token (local)  3. External OAuth
 *
 * The worker-token check is local + cheap, so it runs before the remote OIDC
 * userinfo fetch — a valid worker token never needs to round-trip to the
 * identity provider.
 *
 * On a successful check, the caller's identity is attached to the Hono context
 * as `authContext`. When that includes an `organizationId`, the rest of the
 * request runs inside `orgContext.run()` so Postgres-backed stores (which read
 * the org id from AsyncLocalStorage via `getOrgId()`) see the same tenant.
 * `createLobuAuthBridge` already wraps PAT-authenticated requests this way;
 * this is the equivalent for the worker-token and external-OAuth paths, which
 * `createLobuAuthBridge` doesn't cover.
 */
export function createApiAuthMiddleware(opts: {
  externalAuthClient?: ExternalAuthClient;
  allowWorkerToken?: boolean;
  allowSettingsSession?: boolean;
  /**
   * Also accept the settings session via a `?token=` query param (an encrypted,
   * short-lived ticket) for specific **GET** requests. Needed for EventSource
   * streams: the embedded panel can't send an Authorization header, so the
   * caller must opt in only for the exact stream route that needs it. Mutations
   * and unrelated GET routes still require cookie/header auth.
   */
  allowSettingsQueryToken?: (c: Context) => boolean;
}) {
  const revokedTokens = getRevokedTokenStore();

  const runWithContext = (
    ctx: ApiAuthContext,
    c: Context,
    next: Next
  ): Promise<void> | void => {
    c.set("authContext", ctx);
    if (ctx.organizationId) {
      return orgContext.run({ organizationId: ctx.organizationId }, () =>
        next()
      );
    }
    return next();
  };

  return async (c: Context, next: Next) => {
    // 1. Try settings session cookie when explicitly allowed (and, when opted
    //    in for this route, a `?token=` ticket for header-less EventSource SSE
    //    clients). verifySettingsSession now enforces jti revocation internally.
    if (opts.allowSettingsSession) {
      // The `?token=` ticket is accepted only for GET routes the caller opts
      // into (EventSource SSE); mutations and unrelated GETs always require an
      // Authorization header if the cookie path doesn't authenticate.
      const allowQueryToken =
        c.req.method === "GET" && opts.allowSettingsQueryToken?.(c) === true;
      const session = allowQueryToken
        ? await verifySettingsSessionOrToken(c, "token")
        : await verifySettingsSession(c);
      if (session) {
        return runWithContext({ userId: session.userId }, c, next);
      }
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }
    const token = authHeader.substring(7);

    // 2. Try worker token when explicitly allowed for the route (local check).
    if (opts.allowWorkerToken !== false) {
      const workerData = verifyWorkerToken(token);
      if (workerData) {
        const tokenAge = Date.now() - workerData.timestamp;
        if (tokenAge <= TOKEN_EXPIRATION_MS) {
          if (workerData.jti && (await revokedTokens.isRevoked(workerData.jti))) {
            return c.json({ success: false, error: "Unauthorized" }, 401);
          }
          return runWithContext(
            {
              userId: workerData.userId,
              organizationId: workerData.organizationId,
            },
            c,
            next
          );
        }
      }
    }

    // 3. Try external OAuth token (validated against MEMORY_URL userinfo).
    if (opts.externalAuthClient) {
      try {
        const userInfo = await opts.externalAuthClient.fetchUserInfo(token);
        if (userInfo?.sub) {
          return runWithContext(
            {
              userId: userInfo.sub,
              organizationId: userInfo.organizationId,
            },
            c,
            next
          );
        }
      } catch {
        // Token not valid for external auth, continue to next method
      }
    }

    return c.json({ success: false, error: "Unauthorized" }, 401);
  };
}
