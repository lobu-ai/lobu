/**
 * Internal smoke-test dispatch endpoint.
 *
 * POST /api/internal/smoke/dispatch
 *
 * Inserts a synthetic chat_message run into `public.runs`. The runs-queue
 * MessageConsumer (running in the same app pod) claims it, spawns the
 * worker subprocess, the worker runs end-to-end, and on terminal cleanup
 * writes a row to `agent_transcript_snapshot`. The Helm post-upgrade
 * smoke-test Job polls that row to gate the release: if the snapshot
 * doesn't materialize with `terminal_status='completed'` within the
 * configured window, Helm rolls the release back.
 *
 * Why a dedicated endpoint and not "just call the public chat API":
 *   - The public Agent API requires an OAuth bearer / PAT from a real
 *     authenticated user — we can't easily mint one from inside a Helm
 *     post-upgrade Job without per-cluster bootstrap.
 *   - Real chat connections (Telegram/Slack) require platform-side
 *     secrets and webhook configuration that an in-cluster smoke Job
 *     shouldn't carry.
 *   - The path under test is the worker spawn + run completion pipeline,
 *     not the platform ingress. Synthesising the message directly into
 *     the runs queue exercises everything from MessageConsumer onward,
 *     which is exactly the surface that has been silently broken across
 *     the recent regressions (Phase 5 env flip, runs denormalize/revert,
 *     JobEventSchema, action_input JSONB shape).
 *
 * Auth model (four layers — all must pass):
 *   1. Bearer token equal to `process.env.SMOKE_TEST_TOKEN`
 *      (constant-time compare). The token is loaded into the deployment
 *      Secret and into the smoke-test Job's envFrom; ingress doesn't
 *      proxy it.
 *   2. The request MUST NOT carry any `x-forwarded-*` / `forwarded` /
 *      `x-real-ip` header. A standards-compliant reverse proxy or
 *      ingress controller (nginx, istio, traefik, etc.) adds at least
 *      one of these; the in-cluster smoke Job hits the
 *      `<release>-app` Service via cluster DNS, which never traverses
 *      ingress, so the headers are absent on legitimate calls.
 *   3. The Host header MUST start with the in-cluster app service
 *      hostname (`<release>-lobu-app`) — set explicitly by the smoke
 *      Job's curl URL. Public ingress traffic always carries the
 *      operator's external hostname (e.g. `app.lobu.ai`) in Host, so
 *      this rejects requests routed through ingress even if (2) is
 *      somehow bypassed by a non-compliant proxy. The required Host
 *      prefix is operator-configurable via `SMOKE_TEST_ALLOWED_HOST`
 *      env (defaults to "" — empty means "any Host accepted", which is
 *      only safe when (2) is honoured; operators are encouraged to set
 *      this).
 *   4. If `SMOKE_TEST_TOKEN` / `SMOKE_TEST_AGENT_ID` / `SMOKE_TEST_ORG_ID`
 *      are unset OR empty the endpoint returns 503 so the check fails
 *      closed: a deployment with partial configuration will fail its
 *      smoke gate.
 *
 * Isolation guarantees (server-pinned, not client-supplied):
 *   - The synthetic agent + organization identifiers come from
 *     `process.env.SMOKE_TEST_AGENT_ID` and `process.env.SMOKE_TEST_ORG_ID`
 *     — caller-supplied values are ignored. This makes it structurally
 *     impossible for a leaked token to trigger runs on a real tenant's
 *     agent: even with the token, the caller can only dispatch against
 *     the env-configured smoke namespace.
 *   - The conversationId is caller-supplied so each release gets a unique
 *     run id, but must carry the configured `smoke-` prefix.
 *   - The chat_message row is tagged with `idempotency_key=
 *     smoke:<conversationId>` so repeated calls within a deployment do
 *     not flood the queue.
 *
 * The actual snapshot poll lives in the smoke-test Job's shell loop
 * (charts/lobu/templates/smoke-test-job.yaml) — keeping the polling out
 * of this handler avoids tying up a Hono request for the full timeout
 * window.
 */

import {
	createLogger,
	getErrorMessage,
} from "@lobu/core";
import { Hono } from "hono";
import { getDb } from "../../../db/client.js";
import { constantTimeEqual } from "../../../utils/constant-time-equal.js";
import { routeFailure } from "../../../diagnostics.js";

const logger = createLogger("smoke-dispatch");

interface SmokeDispatchBody {
  conversationId?: string;
  messageText?: string;
}

/**
 * A request that passed through an ingress / reverse proxy carries at
 * least one of these headers. The smoke Job hits the in-cluster
 * `<release>-app` Service via cluster DNS — direct ClusterIP → Pod, no
 * ingress hop — so none of these headers are set on a legitimate call.
 * Reject any request that carries one: that's a clear sign the route was
 * reached through public ingress, which is never how the smoke Job
 * speaks to the app.
 */
const FORWARDED_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-server",
  "x-real-ip",
  "forwarded",
];

export function createSmokeRoutes(): Hono {
  const app = new Hono();

  app.post("/dispatch", async (c) => {
    const expected = process.env.SMOKE_TEST_TOKEN ?? "";
    const smokeAgentId = (process.env.SMOKE_TEST_AGENT_ID ?? "").trim();
    const smokeOrgId = (process.env.SMOKE_TEST_ORG_ID ?? "").trim();
    if (expected.length === 0 || smokeAgentId === "" || smokeOrgId === "") {
      // Fail closed: an operator that hasn't configured every piece of
      // the smoke trio (token + agent + org) cannot satisfy the gate.
      // Returning 503 here also makes the smoke Job's curl fail before
      // it can ever land a synthetic run in a partially-configured
      // tenant.
      return c.json(
        {
          error:
            "Smoke dispatch disabled (SMOKE_TEST_TOKEN/SMOKE_TEST_AGENT_ID/SMOKE_TEST_ORG_ID unset)",
        },
        503
      );
    }

    // Ingress-bypass defense (layer A — forwarded-headers).
    // A request that came through ingress carries x-forwarded-* headers;
    // the in-cluster smoke Job never does.
    for (const h of FORWARDED_HEADERS) {
      if (c.req.header(h)) {
        logger.warn(
          `Smoke dispatch refused: ${h} header present (request came through ingress)`
        );
        return c.json({ error: "Forwarded request refused" }, 403);
      }
    }

    // Ingress-bypass defense (layer B — Host header).
    // When the operator configures SMOKE_TEST_ALLOWED_HOST, the request's
    // Host header must start with that value. The chart wires this to
    // `<release>-lobu-app` so a request that came through public ingress
    // (Host: app.lobu.ai or similar) is rejected even if some
    // non-compliant proxy stripped the x-forwarded-* headers.
    const allowedHost = (process.env.SMOKE_TEST_ALLOWED_HOST ?? "").trim();
    if (allowedHost !== "") {
      const rawHost = (c.req.header("host") ?? "").toLowerCase();
      // Strip any :<port> suffix before comparing — operators set the
      // unsuffixed service DNS name, but curl sends "<host>:<port>".
      const hostPart = rawHost.split(":")[0] ?? "";
      const expected = allowedHost.toLowerCase();
      if (hostPart !== expected && !hostPart.startsWith(`${expected}.`)) {
        logger.warn(
          `Smoke dispatch refused: Host '${rawHost}' does not match SMOKE_TEST_ALLOWED_HOST '${allowedHost}'`
        );
        return c.json({ error: "Host header refused" }, 403);
      }
    }

    const auth = c.req.header("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return c.json({ error: "Missing bearer token" }, 401);
    }
    const provided = auth.substring(7);
    if (!constantTimeEqual(provided, expected)) {
      return c.json({ error: "Invalid smoke token" }, 401);
    }

    let body: SmokeDispatchBody;
    try {
      body = (await c.req.json()) as SmokeDispatchBody;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // agentId + organizationId are server-pinned from env, NOT caller-
    // supplied. The previous draft accepted them in the body, which a
    // codex review correctly flagged as convention-only isolation — a
    // leaked token could then trigger runs on real tenants. Here we
    // ignore the body fields entirely and force the smoke namespace.
    const agentId = smokeAgentId;
    const organizationId = smokeOrgId;
    const conversationId = body.conversationId?.trim();
    const messageText = body.messageText?.trim() || "smoke-test ping";

    if (!conversationId) {
      return c.json({ error: "conversationId is required" }, 400);
    }

    // Defence-in-depth: the synthetic conversationId must carry the
    // `smoke-` prefix the chart sets. Operators that override the prefix
    // can adjust this guard locally; production smoke runs always use
    // the default. This trades a tiny amount of operator flexibility for
    // an unambiguous audit trail.
    if (!conversationId.startsWith("smoke-")) {
      return c.json(
        {
          error: "conversationId must start with 'smoke-' for safety",
        },
        400
      );
    }

    const idempotencyKey = `smoke:${conversationId}`;
    const messageId = `smoke-msg-${Date.now()}`;

    // Synthetic MessagePayload. Mirrors the shape that
    // message-handler-bridge.ts builds for a real platform inbound, but
    // with platform="smoke" and a minimal platformMetadata block so
    // the chat-response bridge has nothing real to deliver to.
    const payload = {
      platform: "smoke",
      userId: "smoke-user",
      botId: "smoke",
      conversationId,
      teamId: "smoke",
      agentId,
      organizationId,
      messageId,
      messageText,
      channelId: conversationId,
      platformMetadata: {
        agentId,
        chatId: conversationId,
        senderId: "smoke-user",
        responseChannel: conversationId,
        responseId: messageId,
        responseThreadId: conversationId,
      },
      agentOptions: {},
    };

    const sql = getDb();

    // Insert directly into `public.runs` to mirror what RunsQueue.send
    // does — going through queueProducer would also work, but the
    // direct INSERT keeps this handler dependency-free and avoids
    // requiring the gateway to be fully initialised at smoke time. The
    // pg_notify wakeup is what cues MessageConsumer to claim the row.
    try {
      const result = await sql<{ id: number | string }>`
        INSERT INTO public.runs (
          run_type,
          queue_name,
          action_input,
          idempotency_key,
          max_attempts,
          attempts,
          status,
          run_at,
          priority,
          retry_delay_seconds
        ) VALUES (
          'chat_message',
          'messages',
          ${sql.json(payload)},
          ${idempotencyKey},
          1,
          0,
          'pending',
          now(),
          0,
          NULL
        )
        ON CONFLICT (idempotency_key)
          WHERE idempotency_key IS NOT NULL
            AND status IN ('pending', 'claimed', 'running')
        DO NOTHING
        RETURNING id
      `;

      let runId: number | null = null;
      if (result.length > 0 && result[0]) {
        runId = Number(result[0].id);
      } else {
        // ON CONFLICT swallowed the insert — surface the live run id so
        // the smoke job can still poll for its outcome.
        const existing = await sql<{ id: number | string }>`
          SELECT id FROM public.runs
          WHERE idempotency_key = ${idempotencyKey}
            AND status IN ('pending', 'claimed', 'running')
          ORDER BY id DESC
          LIMIT 1
        `;
        if (existing.length > 0 && existing[0]) {
          runId = Number(existing[0].id);
        }
      }

      if (runId === null) {
        return c.json({ error: "Failed to enqueue smoke run" }, 500);
      }

      // Fire pg_notify so the MessageConsumer wakes immediately rather
      // than waiting for the next poll tick. Matches the wakeup that
      // RunsQueue.send issues post-commit.
      try {
        await sql`SELECT pg_notify('runs_lobu:messages', 'chat_message')`;
      } catch (err) {
        logger.warn(
          `pg_notify after smoke dispatch failed (non-fatal): ${getErrorMessage(err)}`
        );
      }

      logger.info(
        `Smoke dispatch: runId=${runId} agentId=${agentId} org=${organizationId} conv=${conversationId}`
      );
      return c.json({ runId, idempotencyKey });
    } catch (err) {
      logger.error(
        `Smoke dispatch INSERT failed: ${getErrorMessage(err)}`
      );
      throw routeFailure(c.json({ error: "Internal error" }, 500), err);
    }
  });

  return app;
}
