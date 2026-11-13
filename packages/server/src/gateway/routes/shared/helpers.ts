/**
 * Shared route helpers used across public and internal route modules.
 *
 * Keep this tiny and dependency-free — it exists to collapse the repetitive
 * "auth check / error JSON / context lookup" boilerplate that was previously
 * duplicated in every handler.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { SettingsTokenPayload } from "../../auth/settings/token-service.js";
import { verifySettingsSession } from "../public/settings-auth.js";
import type { WorkerContext } from "../internal/types.js";
import {
  type AgentOwnershipConfig,
  type AgentOwnershipResult,
  verifyOwnedAgentAccess,
} from "./agent-ownership.js";
import { routeFailure } from "../../../diagnostics.js";

/**
 * Return a standard JSON error response with the shape `{ error: message }`.
 * Mirrors the convention used across public and internal routes.
 */
export function errorResponse(
  c: Context,
  message: string,
  status: ContentfulStatusCode
): Response {
  return c.json({ error: message }, status);
}

/**
 * Parse the request body as JSON, or return a 400 error response.
 *
 * Collapses the repeated `try { body = await c.req.json() } catch { 400 }`
 * dance. Handlers call this and early-return when the result is a Response:
 *
 *   const body = await parseJsonBody<{ worker_id?: string }>(c);
 *   if (body instanceof Response) return body;
 */
export async function parseJsonBody<T = unknown>(
  c: Context,
  message = "Invalid JSON body"
): Promise<T | Response> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return errorResponse(c, message, 400);
  }
}

/**
 * Resolve the settings session payload, or return a 401 error response.
 *
 * Handlers should call this and early-return when the result is a Response:
 *
 *   const session = await requireSession(c);
 *   if (session instanceof Response) return session;
 */
export async function requireSession(
  c: Context
): Promise<SettingsTokenPayload | Response> {
  const payload = await verifySettingsSession(c);
  if (!payload) {
    return errorResponse(c, "Unauthorized", 401);
  }
  return payload;
}

/**
 * Return the worker context set by `authenticateWorker` middleware.
 *
 * The middleware has already validated the Bearer token and populated
 * `c.var.worker`. This helper throws if somehow called on a route that
 * wasn't wrapped with `authenticateWorker`, surfacing the wiring mistake
 * at the first request rather than producing confusing `undefined` errors
 * deeper in the handler.
 */
export function getVerifiedWorker(
  c: Context<WorkerContext>
): WorkerContext["Variables"]["worker"] {
  const worker = c.get("worker");
  if (!worker) {
    throw new Error(
      "Worker context missing — route must be wrapped with authenticateWorker middleware"
    );
  }
  return worker;
}

interface WithOwnedAgentOptions {
  /** Ownership stores used by `verifyOwnedAgentAccess`. */
  access: AgentOwnershipConfig;
  /** Logged on the unexpected-error 500 path, e.g. "Failed to delete agent". */
  errorLabel: string;
  /** Logger used for the 500 path. Matches `createLogger`'s (message, meta). */
  logger: { error: (message: string, meta?: unknown) => void };
  /** Status returned when ownership is denied (404 for agents, 403 elsewhere). */
  deniedStatus?: ContentfulStatusCode;
  /** Body message returned when ownership is denied. */
  deniedMessage?: string;
}

/**
 * Collapse the auth → agentId-param → ownership → try/catch preamble that every
 * agent-scoped CRUD handler reimplements.
 *
 * Contract preserved byte-for-byte from the inline handlers:
 *  - missing session → 401 `Unauthorized` (via `requireSession`)
 *  - missing `agentId` path param → 400 `Missing agentId`
 *  - admin sessions BYPASS the ownership check entirely; `access` is then
 *    `{ authorized: true }` with no owner fields, exactly like the inline code
 *  - non-admin sessions run `verifyOwnedAgentAccess`; on denial the configured
 *    `deniedStatus`/`deniedMessage` is returned (default 404 / "Agent not found
 *    or not owned by you")
 *  - the handler runs inside a try/catch that logs `errorLabel` and returns
 *    500 `Internal server error`
 *
 * The handler receives the resolved `{ session, agentId, access }` so callers
 * that need `ownerPlatform`/`ownerUserId` (delete) read them off `access`.
 */
export async function withOwnedAgent(
  c: Context,
  options: WithOwnedAgentOptions,
  handler: (ctx: {
    session: SettingsTokenPayload;
    agentId: string;
    access: AgentOwnershipResult;
  }) => Promise<Response>
): Promise<Response> {
  const session = await requireSession(c);
  if (session instanceof Response) return session;

  const agentId = c.req.param("agentId");
  if (!agentId) {
    return errorResponse(c, "Missing agentId", 400);
  }

  // Ownership resolution runs inside the try/catch so a thrown store error maps
  // to the same logged 500 the inline handlers produced.
  try {
    let access: AgentOwnershipResult = { authorized: true };
    if (!session.isAdmin) {
      access = await verifyOwnedAgentAccess(session, agentId, options.access);
      if (!access.authorized) {
        return errorResponse(
          c,
          options.deniedMessage ?? "Agent not found or not owned by you",
          options.deniedStatus ?? 404
        );
      }
    }

    return await handler({ session, agentId, access });
  } catch (error) {
    options.logger.error(options.errorLabel, { error, agentId });
    throw routeFailure(errorResponse(c, "Internal server error", 500), error);
  }
}
