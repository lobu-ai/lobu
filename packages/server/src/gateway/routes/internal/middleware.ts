import { verifyWorkerToken } from "@lobu/core";
import { getRevokedTokenStore } from "../../auth/revoked-token-store.js";
import { markAgentTurnToolStarted, StaleAgentTurnAttemptError } from "../../../runs/agent-turn-inputs.js";
import {
  CHAT_SENDER_NOT_LINKED,
  isConfinedChatTurn,
} from "../../orchestration/chat-turn-actor.js";

/**
 * Shared worker authentication middleware for internal routes.
 * Verifies the Bearer token from the Authorization header and sets
 * the decoded token data on `c.var.worker`.
 */
export const authenticateWorker = async (
  c: any,
  next: () => Promise<void>
): Promise<Response | undefined> => {
  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid authorization" }, 401);
  }
  const workerToken = authHeader.substring(7);
  const tokenData = verifyWorkerToken(workerToken);
  if (!tokenData) {
    return c.json({ error: "Invalid worker token" }, 401);
  }
  if (
    tokenData.jti &&
    (await getRevokedTokenStore().isRevoked(tokenData.jti))
  ) {
    return c.json({ error: "Invalid worker token" }, 401);
  }
  // Route templates, not suffix matching on a caller-authored URL.
  const route = `${c.req.method} ${c.req.routePath.replace(/^\/lobu(?=\/)/, "")}`;
  // Only routes that enforce capture (or known reads) may use this token.
  if (tokenData.executionMode === "capture" && !CAPTURE_ROUTES.has(route)) {
    return c.json({ error: "Route unavailable during capture" }, 403);
  }
  // A confined chat turn (reply-only or public visitor) answers in its own
  // thread and nothing more (orchestration/chat-turn-actor.ts).
  if (CONFINED_CHAT_DENIED_ROUTES.has(route) && isConfinedChatTurn(tokenData)) {
    return c.json({ error: CHAT_SENDER_NOT_LINKED }, 403);
  }
  // An agent turn's side-effecting call is recorded before it can act, so the
  // reaper never re-runs a dead attempt that made it (runs/agent-turn-inputs).
  // Reads are GET; anything else may have an effect, unknown routes included.
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    try {
      await markAgentTurnToolStarted(tokenData, GATEWAY_TOOL_ROUTES[route] ?? route);
    } catch (error) {
      if (error instanceof StaleAgentTurnAttemptError) {
        return c.json({ error: error.message }, 409);
      }
      return c.json({ error: "Could not record the tool call for this turn; it was not executed" }, 503);
    }
  }
  c.set("worker", tokenData);
  await next();
  return undefined;
};

/**
 * The model-facing tool behind each side-effecting route, so a retry note names
 * a call the way the model made it. An unlisted route is named by its template.
 */
const GATEWAY_TOOL_ROUTES: Record<string, string> = {
  "POST /internal/conversations/send": "send_message",
  "POST /internal/conversations/present-event": "present_event",
  "POST /internal/conversations/schedule-followup": "schedule_followup",
  "POST /internal/conversations/react": "react",
  "POST /internal/conversations/edit": "edit_message",
  "POST /internal/conversations/delete": "delete_message",
  "POST /internal/interactions/create": "ask_user",
  "POST /internal/files/upload": "upload_file",
  "POST /internal/files/upload-batch": "upload_file",
  "POST /internal/images/generate": "generate_image",
  "POST /internal/audio/synthesize": "generate_audio",
  "POST /internal/runtime/exec": "bash",
};

const CAPTURE_ROUTES = new Set([
  "GET /internal/conversations/list", "GET /internal/conversations/read",
  "GET /internal/images/capabilities", "GET /internal/audio/capabilities",
  "POST /internal/conversations/send", "POST /internal/conversations/present-event",
  "POST /internal/conversations/schedule-followup", "POST /internal/conversations/react",
  "POST /internal/conversations/edit", "POST /internal/conversations/delete",
  "POST /internal/interactions/create",
  "POST /internal/files/upload", "POST /internal/files/upload-batch",
  "POST /internal/images/generate", "POST /internal/audio/synthesize",
  "POST /internal/runtime/exec",
]);

/**
 * Routes a confined chat turn may not use: reading or posting into other
 * conversations, scheduling, media, and remote execution. Reacting to,
 * editing, and asking in its own thread stay available.
 */
const CONFINED_CHAT_DENIED_ROUTES = new Set([
  "GET /internal/conversations/list", "GET /internal/conversations/read",
  "POST /internal/conversations/send", "POST /internal/conversations/present-event",
  "POST /internal/conversations/schedule-followup",
  "POST /internal/files/upload", "POST /internal/files/upload-batch",
  "POST /internal/images/generate", "POST /internal/audio/synthesize",
  "POST /internal/runtime/exec",
]);
