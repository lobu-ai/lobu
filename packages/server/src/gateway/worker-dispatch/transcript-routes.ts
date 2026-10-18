/**
 * Worker-facing snapshot endpoints for Lobu agent transcripts.
 *
 * Mounted at `/worker/transcript/snapshot`:
 *   GET  → return the latest `terminal_status='completed'` snapshot for
 *          this worker's (org, agent, conversation), as raw JSONL bytes.
 *          404 when no completed snapshot exists.
 *   POST → write a snapshot row for the current run.
 *
 * Authentication is the existing worker JWT (Bearer token). All routing
 * inputs (org, agent, conv) come from the verified token — the request
 * body controls only the payload + terminal_status. Workers cannot
 * impersonate another conversation.
 *
 * Why these are separate from `agent-history.ts`: the worker is sandboxed
 * and has no `DATABASE_URL`. The snapshot write path must go through an
 * authenticated gateway hop. History reads for the web panel use
 * settings-cookie auth on `/history/threads/*`; worker JWT auth stays on
 * `/worker/transcript/*`.
 */

import type { WorkerTokenData } from "@lobu/core";
import {
	createLogger,
	getErrorMessage,
	verifyWorkerToken,
} from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";
import {
	AUTOMATION_CONVERSATION_SEGMENT,
	AUTOMATION_RUN_SEGMENT,
} from "../permissions/automation-run-intent.js";
import { MAX_SNAPSHOT_BYTES } from "../services/transcript-snapshot.js";

const logger = createLogger("worker-transcript");

interface SnapshotRow {
  snapshot_jsonl: string;
}

function authenticate(c: Context): WorkerTokenData | null {
  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.substring(7);
  return verifyWorkerToken(token);
}

/**
 * Verify the `runId` the worker claims belongs to the JWT's (org, agent,
 * conv) tuple. The worker can't lie its way into another conversation's
 * row: the runId is authoritatively set by whichever server path minted the
 * per-run token — the gateway's MessageConsumer from the runs-queue claim,
 * or `buildAutomationRunWorkerAccess` at device poll. A misbehaving worker
 * that POSTs a forged runId either targets one of its own runs (allowed) or
 * a run owned by a different (org, agent, conv) — this function returns
 * false in the latter case so the route rejects with 403.
 *
 * Codex P1#1 on PR #865 — the previous "latest run for (org, agent, conv)"
 * lookup at write time raced: worker A finishes execute() for run 100,
 * cleanup() POST is in flight; meanwhile run 101 is enqueued for the same
 * conv; A's POST hits the gateway and gets mis-attributed to run 101,
 * stealing the slot from worker B.
 */
async function isRunOwnedByJwtScope(
  runId: number,
  organizationId: string,
  agentId: string,
  conversationId: string
): Promise<boolean> {
  const sql = getDb();
  // `runs.action_input` is `jsonb` typed, but rows written before the
  // dispatch-path fix below stored a double-encoded JSON *string* (e.g.
  // `'"{\\"agentId\\":\\"marketing\\",...}"'`) instead of a JSONB object.
  // `action_input ->> 'agentId'` returns NULL on a JSONB string, which
  // would 403 every snapshot POST on rows enqueued before the fix rolled.
  // CASE on `jsonb_typeof` so both shapes authorize identically: object
  // rows use the direct `->>` accessor; string rows unwrap one layer via
  // `(action_input #>> '{}')::jsonb ->>` first. New rows (post fix below)
  // always take the 'object' branch; legacy in-flight rows take 'string'.
  const rows = await sql<{ ok: boolean }>`
    SELECT 1 AS ok
    FROM public.runs r
    LEFT JOIN public.automations automation
      ON automation.id = r.automation_id
     AND automation.organization_id = r.organization_id
    WHERE r.id = ${runId}
      AND r.organization_id = ${organizationId}
      AND (
        (
          CASE jsonb_typeof(r.action_input)
            WHEN 'object' THEN r.action_input ->> 'agentId'
            WHEN 'string' THEN (r.action_input #>> '{}')::jsonb ->> 'agentId'
            ELSE NULL
          END = ${agentId}
          AND CASE jsonb_typeof(r.action_input)
            WHEN 'object' THEN r.action_input ->> 'conversationId'
            WHEN 'string' THEN (r.action_input #>> '{}')::jsonb ->> 'conversationId'
            ELSE NULL
          END = ${conversationId}
        )
        -- Device-pinned Automation runs carry no agentId/conversationId in
        -- action_input: the identity is derived at poll time by
        -- buildAutomationRunWorkerAccess from (agent, automation, run). Prove
        -- ownership from the automation's own agent plus the same derived id
        -- (segments from automation-run-intent.ts, matching
        -- buildAutomationRunConversationId — this concat is per-row so it
        -- cannot bind a prebuilt id).
        OR (
          r.run_type = 'automation'
          AND automation.managed_agent_id = ${agentId}
          AND ${conversationId} =
            ${agentId} || ${AUTOMATION_CONVERSATION_SEGMENT} || r.automation_id::text || ${AUTOMATION_RUN_SEGMENT} || r.id::text
        )
      )
    LIMIT 1
  `;
  return rows.length > 0;
}

export function createTranscriptRoutes(): Hono {
  const app = new Hono();

  /** GET — hydrate latest completed snapshot for this (org, agent, conv). */
  app.get("/snapshot", async (c) => {
    const token = authenticate(c);
    if (!token) return c.json({ error: "Invalid token" }, 401);

    const { organizationId, agentId, conversationId } = token;
    if (!organizationId || !agentId || !conversationId) {
      // organizationId is optional on the WorkerTokenData type but
      // production tokens always set it. Reject defensively rather than
      // falling back to NULL and matching every tenant's snapshot.
      return c.json({ error: "Token missing required scope" }, 400);
    }

    const sql = getDb();
    const rows = await sql<SnapshotRow>`
      SELECT snapshot_jsonl
      FROM public.agent_transcript_snapshot
      WHERE organization_id = ${organizationId}
        AND agent_id = ${agentId}
        AND conversation_id = ${conversationId}
        AND terminal_status = 'completed'
      ORDER BY run_id DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return c.json({ error: "No snapshot found" }, 404);
    }
    return c.body(row.snapshot_jsonl, 200, {
      "content-type": "application/x-ndjson; charset=utf-8",
    });
  });

  /** POST — write a snapshot for the worker's current run. */
  app.post("/snapshot", async (c) => {
    const token = authenticate(c);
    if (!token) return c.json({ error: "Invalid token" }, 401);

    const { organizationId, agentId, conversationId } = token;
    if (!organizationId || !agentId || !conversationId) {
      return c.json({ error: "Token missing required scope" }, 400);
    }

    let body: {
      terminalStatus?: string;
      snapshotJsonl?: string;
      runId?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const terminalStatus = body.terminalStatus;
    const snapshotJsonl = body.snapshotJsonl;
    if (
      terminalStatus !== "completed" &&
      terminalStatus !== "failed" &&
      terminalStatus !== "timeout" &&
      terminalStatus !== "cancelled"
    ) {
      return c.json({ error: "Invalid terminalStatus" }, 400);
    }
    if (typeof snapshotJsonl !== "string" || snapshotJsonl.length === 0) {
      return c.json({ error: "Missing snapshotJsonl" }, 400);
    }
    const byteSize = Buffer.byteLength(snapshotJsonl, "utf-8");
    if (byteSize > MAX_SNAPSHOT_BYTES) {
      logger.warn(
        `Rejecting oversize snapshot (${byteSize} > ${MAX_SNAPSHOT_BYTES} bytes) for (${organizationId}, ${agentId}, ${conversationId})`
      );
      return c.json({ error: "Snapshot too large" }, 413);
    }

    // The worker MUST send the runId it claimed. Without it, we can't
    // safely attribute the snapshot — see codex P1#1 on PR #865 for why
    // the previous "resolve latest run for (org, agent, conv)" lookup
    // was unsound.
    const rawRunId = body.runId;
    const runId =
      typeof rawRunId === "number" && Number.isFinite(rawRunId) && rawRunId > 0
        ? rawRunId
        : null;
    if (runId === null) {
      return c.json({ error: "Missing or invalid runId" }, 400);
    }

    // The JWT must itself be bound to this exact runId. The deployment-
    // lifetime WORKER_TOKEN carries no `runId`, so it can never satisfy
    // this check — only a per-run JWT can. Without this, a worker
    // bearing a valid same-(org, agent, conv) deployment token could
    // POST under ANY same-scope run's slot, including the next pending
    // run, and overwrite a sibling worker's snapshot. Codex round 2
    // finding A on PR #865.
    if (token.runId !== runId) {
      logger.warn(
        `Token runId mismatch: token.runId=${token.runId ?? "<absent>"} body.runId=${runId}; rejecting snapshot`
      );
      return c.json({ error: "runId out of scope" }, 403);
    }

    // Tenant safety: verify the claimed runId actually belongs to the
    // JWT's scope. The token.runId === body.runId check above is a
    // necessary condition; this is the sufficient one. (A leaked or
    // mis-minted token whose runId points at a row in a different scope
    // gets caught here.) Otherwise a misbehaving worker could write its
    // snapshot under another conversation's run row.
    if (
      !(await isRunOwnedByJwtScope(
        runId,
        organizationId,
        agentId,
        conversationId
      ))
    ) {
      logger.warn(
        `Run ${runId} does not belong to (${organizationId}, ${agentId}, ${conversationId}); rejecting snapshot`
      );
      return c.json({ error: "runId out of scope" }, 403);
    }

    const sql = getDb();
    try {
      // A retry may hydrate the snapshot written by an earlier attempt, append
      // more transcript, then checkpoint the SAME run again after terminal
      // delivery failed. Permit that monotonic extension atomically. Reject a
      // divergent branch: two pods racing from the same base cannot overwrite
      // each other's different continuation, and the loser must not
      // acknowledge completion against bytes it did not persist.
      const inserted = await sql<{ id: number }>`
        INSERT INTO public.agent_transcript_snapshot AS existing
          (organization_id, agent_id, conversation_id, run_id,
           snapshot_jsonl, byte_size, terminal_status)
        VALUES
          (${organizationId}, ${agentId}, ${conversationId}, ${runId},
           ${snapshotJsonl}, ${byteSize}, ${terminalStatus})
        ON CONFLICT (organization_id, agent_id, conversation_id, run_id)
          DO UPDATE SET
            snapshot_jsonl = EXCLUDED.snapshot_jsonl,
            byte_size = EXCLUDED.byte_size,
            terminal_status = EXCLUDED.terminal_status
          WHERE left(EXCLUDED.snapshot_jsonl, length(existing.snapshot_jsonl))
            = existing.snapshot_jsonl
        RETURNING id
      `;
      if (inserted.length === 0) {
        return c.json({ error: "Snapshot conflicts with durable run" }, 409);
      }
      logger.info(
        `Wrote snapshot id=${inserted[0]!.id} run_id=${runId} byte_size=${byteSize} status=${terminalStatus}`
      );
      return c.json({ id: inserted[0]!.id });
    } catch (err) {
      logger.error(
        `Snapshot INSERT failed: ${getErrorMessage(err)}`
      );
      return c.json({ error: "Internal error" }, 500);
    }
  });

  /**
   * DELETE — purge all snapshot rows for this worker's (org, agent, conv).
   *
   * Called by the worker's session-reset path so the next boot doesn't
   * rehydrate the now-flushed conversation from Postgres. The local
   * session.jsonl is still unlinked separately by the reset handler;
   * this endpoint covers the second leg now that snapshot mode is the
   * default.
   *
   * Scope comes from the JWT; no body. Idempotent — deleting zero rows
   * is success.
   */
  app.delete("/snapshot", async (c) => {
    const token = authenticate(c);
    if (!token) return c.json({ error: "Invalid token" }, 401);

    const { organizationId, agentId, conversationId } = token;
    if (!organizationId || !agentId || !conversationId) {
      return c.json({ error: "Token missing required scope" }, 400);
    }

    const sql = getDb();
    try {
      const deleted = await sql<{ id: number }>`
        DELETE FROM public.agent_transcript_snapshot
        WHERE organization_id = ${organizationId}
          AND agent_id = ${agentId}
          AND conversation_id = ${conversationId}
        RETURNING id
      `;
      logger.info(
        `Purged ${deleted.length} snapshot row(s) for (${organizationId}, ${agentId}, ${conversationId}) on session reset`
      );
      return c.json({ deleted: deleted.length });
    } catch (err) {
      logger.error(
        `Snapshot DELETE failed: ${getErrorMessage(err)}`
      );
      return c.json({ error: "Internal error" }, 500);
    }
  });

  return app;
}
