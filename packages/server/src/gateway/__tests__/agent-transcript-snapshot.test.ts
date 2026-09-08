/**
 * Integration tests for the per-run agent_transcript_snapshot path.
 *
 * Backed by the embedded Postgres gateway harness (`ensureDbForGatewayTests`).
 * Covers the gateway-side surface: HTTP snapshot routes, advisory lock,
 * /agent-history fallback resolver, and schema constraints. The worker-side
 * helpers (hydrate / writeSnapshot) are tested in
 * `packages/agent-worker/src/runtime/__tests__/transcript-snapshot.test.ts`.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";
import { UserAgentsStore } from "../auth/user-agents-store.js";
import { createTranscriptRoutes } from "../worker-dispatch/transcript-routes.js";
import { buildApiConversationId } from "../services/api-conversation-id.js";
import { createAgentHistoryRoutes } from "../routes/public/agent-history.js";
import { readSnapshotJsonl } from "../services/transcript-snapshot.js";
import { readAutomationRunThreads } from "../services/automation-run-thread.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
});

/**
 * Insert a row in `runs` matching the `(org, agent, conv)` triple that the
 * snapshot route resolves run_id by. Returns the new run's id.
 */
async function insertRun(opts: {
  organizationId: string;
  agentId: string;
  conversationId: string;
  runType?: string;
  status?: string;
}): Promise<number> {
  const sql = getDb();
  const runType = opts.runType ?? "chat_message";
  const status = opts.status ?? "running";
  const rows = (await sql`
    INSERT INTO public.runs (
      organization_id, run_type, status, action_input,
      queue_name, run_at, created_at
    ) VALUES (
      ${opts.organizationId},
      ${runType},
      ${status},
      ${sql.json({ agentId: opts.agentId, conversationId: opts.conversationId })},
      ${runType},
      NOW(),
      NOW()
    )
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0]!.id;
}

function mintWorkerToken(opts: {
  organizationId: string;
  agentId: string;
  conversationId: string;
  /**
   * The per-run binding the gateway's MessageConsumer adds when minting
   * the per-job token. Omit to simulate a deployment-lifetime token
   * (e.g. WORKER_TOKEN) which should NOT be accepted by the snapshot
   * route — codex round 2 finding A on PR #865.
   */
  runId?: number;
}): string {
  return generateWorkerToken(
    "test-user",
    opts.conversationId,
    `lobu-worker-${opts.agentId}`,
    {
      channelId: `chan-${opts.conversationId}`,
      agentId: opts.agentId,
      organizationId: opts.organizationId,
      runId: opts.runId,
    }
  );
}

async function callRoute(
  method: "GET" | "POST" | "DELETE",
  path: string,
  token: string,
  body?: unknown
): Promise<Response> {
  const app = createTranscriptRoutes();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("agent_transcript_snapshot — snapshot route", () => {
  test("direct Automation run token writes the transcript surfaced in Recent", async () => {
    const agentId = "agent-automation-acp";
    const orgId = await seedAgentRow(agentId, {
      organizationId: "org_automation_acp",
    });
    const sql = getDb();
    const userId = "automation-acp-owner";
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${userId}, 'Automation ACP owner', 'automation-acp@example.test',
              false, now(), now())
      ON CONFLICT (id) DO NOTHING
    `;
    const [automation] = await sql<{ id: number }>`
      WITH next_id AS (SELECT nextval('automations_id_seq')::integer AS id)
      INSERT INTO automations (
        id, automation_group_id, organization_id, managed_agent_id, created_by, name, slug
      )
      SELECT id, id, ${orgId}, ${agentId}, ${userId}, 'ACP Automation', 'acp-' || id
      FROM next_id
      RETURNING id
    `;
    const automationId = Number(automation.id);
    const [run] = await sql<{ id: number }>`
      INSERT INTO runs (
        organization_id, run_type, automation_id, status, action_input,
        queue_name, run_at, created_at, completed_at
      ) VALUES (
        ${orgId}, 'automation', ${automationId}, 'completed', NULL,
        'automation', now(), now(), now()
      )
      RETURNING id
    `;
    const runId = Number(run.id);
    const conversationId = `${agentId}_automation_${automationId}_run_${runId}`;
    const token = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId,
    });
    const transcript =
      `${JSON.stringify({ type: "session", version: 3, id: "acp-session", timestamp: new Date().toISOString(), cwd: "/workspace" })}\n` +
      `${JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "Run the Automation" }] } })}\n` +
      `${JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "ACP trace is durable" }] } })}\n`;

    const response = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "completed",
      snapshotJsonl: transcript,
      runId,
    });
    expect(response.status).toBe(200);

    const recent = await readAutomationRunThreads({
      agentId,
      automationId,
      organizationId: orgId,
      limit: 10,
    });
    expect(recent.runs).toHaveLength(1);
    expect(JSON.stringify(recent.runs[0]?.messages)).toContain("ACP trace is durable");
  });

  test("happy-path-multi-turn: writes one row per terminal run, hydrates byte-for-byte", async () => {
    const orgId = await seedAgentRow("agent-happy", {
      organizationId: "org_happy",
    });
    const agentId = "agent-happy";
    const conversationId = "conv-happy";

    // Turn 1: insert a chat_message run, mint a per-run token, POST
    // a completed snapshot. Production mints a fresh token per dispatch
    // via MessageConsumer; we simulate that here.
    const run1 = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const token1 = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: run1,
    });
    const turn1 =
      `{"type":"session","version":3,"id":"s1","timestamp":"2026-05-18T10:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"u1","parentId":null,"timestamp":"2026-05-18T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"turn 1 user"}]}}\n` +
      `{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-05-18T10:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"turn 1 assistant"}]}}\n`;
    let res = await callRoute("POST", "/snapshot", token1, {
      terminalStatus: "completed",
      snapshotJsonl: turn1,
      runId: run1,
    });
    expect(res.status).toBe(200);

    // Turn 2: new run, new per-run token, append more entries, POST.
    const run2 = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const token2 = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: run2,
    });
    const turn2 =
      turn1 +
      `{"type":"message","id":"u2","parentId":"a1","timestamp":"2026-05-18T10:01:00Z","message":{"role":"user","content":[{"type":"text","text":"turn 2 user"}]}}\n` +
      `{"type":"message","id":"a2","parentId":"u2","timestamp":"2026-05-18T10:01:01Z","message":{"role":"assistant","content":[{"type":"text","text":"turn 2 assistant"}]}}\n`;
    res = await callRoute("POST", "/snapshot", token2, {
      terminalStatus: "completed",
      snapshotJsonl: turn2,
      runId: run2,
    });
    expect(res.status).toBe(200);

    // Two PG rows in run order, both completed.
    const sql = getDb();
    const rows = (await sql`
      SELECT run_id, terminal_status, byte_size
      FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId} AND agent_id = ${agentId}
      ORDER BY run_id ASC
    `) as Array<{
      run_id: number;
      terminal_status: string;
      byte_size: number;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      run_id: run1,
      terminal_status: "completed",
      byte_size: Buffer.byteLength(turn1, "utf-8"),
    });
    expect(rows[1]).toEqual({
      run_id: run2,
      terminal_status: "completed",
      byte_size: Buffer.byteLength(turn2, "utf-8"),
    });

    // Hydrate returns the latest (turn 2 bytes verbatim). GET doesn't
    // require a per-run binding — read scope is (org, agent, conv).
    res = await callRoute("GET", "/snapshot", token2);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(turn2);
  });

  test("large-snapshot-roundtrip: ~600 KB session survives PG TOAST", async () => {
    // Reproduces the largest-real-row case (633 KB measured across 2050
    // production session.jsonl rows). One synthetic `message` entry
    // padded to ~600 KB, framed as JSONL so the producer-shape assumption
    // holds — verifies PG TOAST + the route's MAX_SNAPSHOT_BYTES cap.
    const orgId = await seedAgentRow("agent-big", {
      organizationId: "org_big",
    });
    const agentId = "agent-big";
    const conversationId = "conv-big";
    const bigRunId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const token = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: bigRunId,
    });

    const padding = "x".repeat(600_000);
    const big =
      `{"type":"session","version":3,"id":"big","timestamp":"2026-05-18T10:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"big1","parentId":null,"timestamp":"2026-05-18T10:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"${padding}"}]}}\n`;

    let res = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "completed",
      snapshotJsonl: big,
      runId: bigRunId,
    });
    expect(res.status).toBe(200);

    // Round-trip is byte-identical.
    res = await callRoute("GET", "/snapshot", token);
    expect(res.status).toBe(200);
    const out = await res.text();
    expect(out.length).toBe(big.length);
    expect(out).toBe(big);
  });

  test("failed-run-not-replayed: hydrate skips failed snapshots and uses latest completed", async () => {
    const orgId = await seedAgentRow("agent-fail", {
      organizationId: "org_fail",
    });
    const agentId = "agent-fail";
    const conversationId = "conv-fail";

    // Completed run.
    const completedRun = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const completedJsonl = `{"type":"session","id":"good"}\n{"type":"message","id":"ok"}\n`;
    let res = await callRoute(
      "POST",
      "/snapshot",
      mintWorkerToken({
        organizationId: orgId,
        agentId,
        conversationId,
        runId: completedRun,
      }),
      {
        terminalStatus: "completed",
        snapshotJsonl: completedJsonl,
        runId: completedRun,
      }
    );
    expect(res.status).toBe(200);

    // Newer failed run with a dangling tool_use trace.
    const failedRun = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const failedJsonl = `{"type":"session","id":"bad"}\n{"type":"message","id":"dangling","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"x","input":{}}]}}\n`;
    res = await callRoute(
      "POST",
      "/snapshot",
      mintWorkerToken({
        organizationId: orgId,
        agentId,
        conversationId,
        runId: failedRun,
      }),
      {
        terminalStatus: "failed",
        snapshotJsonl: failedJsonl,
        runId: failedRun,
      }
    );
    expect(res.status).toBe(200);

    // Hydrate skips the failed row.
    res = await callRoute(
      "GET",
      "/snapshot",
      mintWorkerToken({
        organizationId: orgId,
        agentId,
        conversationId,
      })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(completedJsonl);

    // Sanity: both rows persisted; admin queries can still inspect failures.
    const sql = getDb();
    const both = (await sql`
      SELECT run_id, terminal_status FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId} AND agent_id = ${agentId}
      ORDER BY run_id ASC
    `) as Array<{ run_id: number; terminal_status: string }>;
    expect(both).toHaveLength(2);
    expect(both[0]).toEqual({ run_id: completedRun, terminal_status: "completed" });
    expect(both[1]).toEqual({ run_id: failedRun, terminal_status: "failed" });
  });

  test("failed-run-not-replayed (empty-history variant): no completed rows → hydrate 404s", async () => {
    const orgId = await seedAgentRow("agent-only-fail", {
      organizationId: "org_only_fail",
    });
    const agentId = "agent-only-fail";
    const conversationId = "conv-only-fail";
    const onlyFailRunId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const token = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: onlyFailRunId,
    });

    let res = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "failed",
      snapshotJsonl: `{"type":"session","id":"only-bad"}\n`,
      runId: onlyFailRunId,
    });
    expect(res.status).toBe(200);

    // Hydrate must 404 — the only snapshot is failed.
    res = await callRoute("GET", "/snapshot", token);
    expect(res.status).toBe(404);
  });

  test("mid-run-loss: crash before cleanup leaves no snapshot; hydrate falls back to previous completed run", async () => {
    // Models the "worker crashes mid-run before writeSnapshot fires" path.
    // We simulate by writing a completed snapshot for run 1, inserting a
    // run 2 row that NEVER posts a snapshot, then asserting hydrate
    // returns run 1's bytes. Verifies the documented trade-off: the
    // partial in-flight transcript is gone, but earlier history is intact.
    const orgId = await seedAgentRow("agent-crash", {
      organizationId: "org_crash",
    });
    const agentId = "agent-crash";
    const conversationId = "conv-crash";

    const priorRunId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const prior = `{"type":"session","id":"prior"}\n{"type":"message","id":"p1"}\n`;
    let res = await callRoute(
      "POST",
      "/snapshot",
      mintWorkerToken({
        organizationId: orgId,
        agentId,
        conversationId,
        runId: priorRunId,
      }),
      {
        terminalStatus: "completed",
        snapshotJsonl: prior,
        runId: priorRunId,
      }
    );
    expect(res.status).toBe(200);

    // Second run started, no snapshot written (the worker crashed).
    await insertRun({ organizationId: orgId, agentId, conversationId });

    // Hydrate returns the prior run's bytes verbatim — that's the resume
    // point for the next worker boot.
    res = await callRoute(
      "GET",
      "/snapshot",
      mintWorkerToken({
        organizationId: orgId,
        agentId,
        conversationId,
      })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(prior);
  });

  test("same-run retries extend monotonically and reject divergent snapshots", async () => {
    const orgId = await seedAgentRow("agent-race", {
      organizationId: "org_race",
    });
    const agentId = "agent-race";
    const conversationId = "conv-race";
    const raceRunId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const token = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: raceRunId,
    });

    const baseJsonl = `{"type":"session","id":"base"}\n`;
    const first = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "completed",
      snapshotJsonl: baseJsonl,
      runId: raceRunId,
    });
    expect(first.status).toBe(200);

    const extendedJsonl = `${baseJsonl}{"type":"message","id":"continued"}\n`;
    const second = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "completed",
      snapshotJsonl: extendedJsonl,
      runId: raceRunId,
    });
    expect(second.status).toBe(200);

    const divergent = await callRoute("POST", "/snapshot", token, {
      terminalStatus: "completed",
      snapshotJsonl: `${baseJsonl}{"type":"message","id":"divergent"}\n`,
      runId: raceRunId,
    });
    expect(divergent.status).toBe(409);

    // The monotonic extension survives; the divergent branch cannot replace it.
    const get = await callRoute("GET", "/snapshot", token);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(extendedJsonl);
  });

  test("rejects token without (org, agent, conv) scope", async () => {
    // Auth boundary: missing organizationId → 400.
    const token = generateWorkerToken("test-user", "conv-x", "lobu-worker-x", {
      channelId: "chan-x",
      agentId: "agent-x",
    });
    const res = await callRoute("GET", "/snapshot", token);
    expect(res.status).toBe(400);
  });

  test("authorises legacy runs whose action_input is a JSONB *string* (double-encoded)", async () => {
    // Live prod regression: pre-fix dispatch wrote `action_input` as
    // `'"{\\"agentId\\":...}"'` (jsonb_typeof = 'string') because the
    // RunsQueue INSERT did `JSON.stringify(data)` bound to a `$1::jsonb`
    // parameter via `tx.unsafe()`. Postgres then stored it as a JSONB
    // string, not a JSONB object. The verifier's `action_input ->> 'agentId'`
    // returned NULL on those rows → 403 every snapshot POST. We hand-roll
    // both row shapes here and assert the verifier accepts both — the
    // backward-compat path must keep working until existing in-flight
    // legacy rows drain.
    const orgId = await seedAgentRow("agent-jsonb-shape", {
      organizationId: "org_jsonb_shape",
    });
    const agentId = "agent-jsonb-shape";
    const conversationId = "conv-jsonb-shape";
    const sql = getDb();

    // Insert ONE legacy row (jsonb string) and ONE current row (jsonb object).
    // sql.unsafe with JSON.stringify + $1::jsonb reproduces the broken
    // production shape; sql.json reproduces the post-fix shape.
    const legacyJsonString = JSON.stringify({ agentId, conversationId });
    const legacyRows = await sql.unsafe<{ id: number }>(
      `INSERT INTO public.runs (
         organization_id, run_type, status, action_input,
         queue_name, run_at, created_at
       ) VALUES ($1, 'chat_message', 'running', $2::jsonb, 'chat_message', NOW(), NOW())
       RETURNING id`,
      [orgId, legacyJsonString]
    );
    const legacyRunId = Number(legacyRows[0]!.id);

    const objectRows = (await sql`
      INSERT INTO public.runs (
        organization_id, run_type, status, action_input,
        queue_name, run_at, created_at
      ) VALUES (
        ${orgId}, 'chat_message', 'running', ${sql.json({ agentId, conversationId })},
        'chat_message', NOW(), NOW()
      )
      RETURNING id
    `) as Array<{ id: number }>;
    const objectRunId = Number(objectRows[0]!.id);

    // Sanity-check the shapes — without this the test could pass for the
    // wrong reasons if a future Postgres-client release silently normalises
    // the string-shape on insert.
    const shapes = (await sql`
      SELECT id, jsonb_typeof(action_input) AS t
      FROM public.runs WHERE id IN (${legacyRunId}, ${objectRunId})
      ORDER BY id ASC
    `) as Array<{ id: number; t: string }>;
    const byId = new Map(shapes.map((r) => [Number(r.id), r.t]));
    expect(byId.get(legacyRunId)).toBe("string");
    expect(byId.get(objectRunId)).toBe("object");

    // Verifier accepts the legacy `string`-shape row.
    let res = await callRoute(
      "POST",
      "/snapshot",
      mintWorkerToken({
        organizationId: orgId,
        agentId,
        conversationId,
        runId: legacyRunId,
      }),
      {
        terminalStatus: "completed",
        snapshotJsonl: `{"type":"session","id":"legacy"}\n`,
        runId: legacyRunId,
      }
    );
    expect(res.status).toBe(200);

    // Verifier accepts the `object`-shape row.
    res = await callRoute(
      "POST",
      "/snapshot",
      mintWorkerToken({
        organizationId: orgId,
        agentId,
        conversationId,
        runId: objectRunId,
      }),
      {
        terminalStatus: "completed",
        snapshotJsonl: `{"type":"session","id":"modern"}\n`,
        runId: objectRunId,
      }
    );
    expect(res.status).toBe(200);

    // Verifier REJECTS when scope mismatches, regardless of row shape.
    res = await callRoute(
      "POST",
      "/snapshot",
      mintWorkerToken({
        organizationId: orgId,
        agentId: "wrong-agent",
        conversationId,
        runId: legacyRunId,
      }),
      {
        terminalStatus: "completed",
        snapshotJsonl: `{"type":"session","id":"x"}\n`,
        runId: legacyRunId,
      }
    );
    expect(res.status).toBe(403);

    res = await callRoute(
      "POST",
      "/snapshot",
      mintWorkerToken({
        organizationId: orgId,
        agentId,
        conversationId: "wrong-conv",
        runId: objectRunId,
      }),
      {
        terminalStatus: "completed",
        snapshotJsonl: `{"type":"session","id":"x"}\n`,
        runId: objectRunId,
      }
    );
    expect(res.status).toBe(403);
  });
});

describe("agent_transcript_snapshot — history fallback", () => {
  test("dead-worker-fallback-from-db: readSnapshotJsonl returns the latest completed snapshot's bytes", async () => {
    const orgId = await seedAgentRow("agent-hist", {
      organizationId: "org_hist",
    });
    const agentId = "agent-hist";
    const conversationId = "conv-hist";
    const runId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const jsonl =
      `{"type":"session","version":3,"id":"h","timestamp":"2026-05-18T14:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-18T14:00:01Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}\n`;

    const sql = getDb();
    await sql`
      INSERT INTO public.agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id,
         snapshot_jsonl, byte_size, terminal_status)
      VALUES
        (${orgId}, ${agentId}, ${conversationId}, ${runId},
         ${jsonl}, ${Buffer.byteLength(jsonl, "utf-8")}, 'completed')
    `;

    const out = await readSnapshotJsonl({
      agentId,
      organizationId: orgId,
      conversationId,
    });
    expect(out).toBe(jsonl);
    const prefix = await readSnapshotJsonl({
      agentId,
      organizationId: orgId,
      conversationId,
      prefixChars: 32,
    });
    expect(prefix).toBe(jsonl.slice(0, 32));
    const suffix = await readSnapshotJsonl({
      agentId,
      organizationId: orgId,
      conversationId,
      suffixChars: 32,
    });
    expect(suffix).toBe(jsonl.slice(-32));
  });

  test("dead-worker-no-snapshot: readSnapshotJsonl returns null on miss (no 500)", async () => {
    const out = await readSnapshotJsonl({
      agentId: "agent-does-not-exist",
      organizationId: undefined,
      conversationId: "conv-miss",
    });
    expect(out).toBeNull();
  });

  test("response-shape: hydrate bytes match what the disk path would parse", async () => {
    // Verifies the documented contract that snapshot bytes are byte-for-byte
    // identical to what the admin UI used to parse from session.jsonl on
    // disk. parseSessionEntries() in agent-history.ts splits on '\n' and
    // skips malformed lines — round-tripping our jsonl through PG and back
    // must preserve every newline.
    const orgId = await seedAgentRow("agent-shape", {
      organizationId: "org_shape",
    });
    const agentId = "agent-shape";
    const conversationId = "conv-shape";
    const runId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const lines = [
      `{"type":"session","version":3,"id":"s","timestamp":"2026-05-18T15:00:00Z","cwd":"/w"}`,
      `{"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-05-18T15:00:01Z","provider":"anthropic","modelId":"claude-sonnet-4"}`,
      `{"type":"message","id":"u1","parentId":"m1","timestamp":"2026-05-18T15:00:02Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`,
    ];
    const jsonl = `${lines.join("\n")}\n`;

    const sql = getDb();
    await sql`
      INSERT INTO public.agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id,
         snapshot_jsonl, byte_size, terminal_status)
      VALUES
        (${orgId}, ${agentId}, ${conversationId}, ${runId},
         ${jsonl}, ${Buffer.byteLength(jsonl, "utf-8")}, 'completed')
    `;

    const out = await readSnapshotJsonl({
      agentId,
      organizationId: orgId,
      conversationId,
    });
    expect(out).toBe(jsonl);
    // Splitting on \n recovers the same line set the history API parses.
    expect(out!.split("\n").filter((l) => l.length > 0)).toEqual(lines);
  });
});

describe("agent_transcript_snapshot — schema", () => {
  test("terminal_status CHECK constraint accepts valid and rejects invalid", async () => {
    const orgId = await seedAgentRow("agent-schema", {
      organizationId: "org_schema",
    });
    const agentId = "agent-schema";
    const conversationId = "conv-schema";
    const sql = getDb();

    // Each valid value succeeds.
    for (const status of [
      "completed",
      "failed",
      "timeout",
      "cancelled",
    ] as const) {
      const runId = await insertRun({
        organizationId: orgId,
        agentId,
        conversationId,
      });
      await sql`
        INSERT INTO public.agent_transcript_snapshot
          (organization_id, agent_id, conversation_id, run_id,
           snapshot_jsonl, byte_size, terminal_status)
        VALUES
          (${orgId}, ${agentId}, ${conversationId}, ${runId},
           ${`{"type":"session","id":"${status}"}\n`}, 32, ${status})
      `;
    }

    // Invalid status rejected.
    const runId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    let rejected = false;
    try {
      await sql`
        INSERT INTO public.agent_transcript_snapshot
          (organization_id, agent_id, conversation_id, run_id,
           snapshot_jsonl, byte_size, terminal_status)
        VALUES
          (${orgId}, ${agentId}, ${conversationId}, ${runId},
           ${`{"type":"session"}\n`}, 16, 'nope')
      `;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  test("org cascade: DELETE organization cascades into snapshot rows", async () => {
    const orgId = await seedAgentRow("agent-cascade", {
      organizationId: "org_cascade",
    });
    const agentId = "agent-cascade";
    const conversationId = "conv-cascade";
    const runId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const sql = getDb();
    await sql`
      INSERT INTO public.agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id,
         snapshot_jsonl, byte_size, terminal_status)
      VALUES
        (${orgId}, ${agentId}, ${conversationId}, ${runId},
         ${`{"type":"session","id":"x"}\n`}, 24, 'completed')
    `;

    // Deleting the org cascades into both runs and snapshots. (Deleting the
    // organization directly is unrealistic in production but the FK setup
    // is the same shape as pending_interactions / grants which also
    // cascade.) Pre-delete: 1 snapshot row.
    let count = (await sql`
      SELECT count(*)::int AS n FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId}
    `) as Array<{ n: number }>;
    expect(count[0]!.n).toBe(1);

    // The agents row references the org as well — drop it first so the
    // org delete can proceed without violating other FKs we don't own.
    await sql`DELETE FROM public.agents WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM public.runs WHERE organization_id = ${orgId}`;
    await sql`DELETE FROM public.organization WHERE id = ${orgId}`;

    count = (await sql`
      SELECT count(*)::int AS n FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId}
    `) as Array<{ n: number }>;
    expect(count[0]!.n).toBe(0);
  });

  test("run cascade: DELETE run cascades into the snapshot row referencing it", async () => {
    const orgId = await seedAgentRow("agent-runcasc", {
      organizationId: "org_runcasc",
    });
    const agentId = "agent-runcasc";
    const conversationId = "conv-runcasc";
    const runId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const sql = getDb();
    await sql`
      INSERT INTO public.agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id,
         snapshot_jsonl, byte_size, terminal_status)
      VALUES
        (${orgId}, ${agentId}, ${conversationId}, ${runId},
         ${`{"type":"session","id":"y"}\n`}, 24, 'completed')
    `;

    await sql`DELETE FROM public.runs WHERE id = ${runId}`;

    const count = (await sql`
      SELECT count(*)::int AS n FROM public.agent_transcript_snapshot
      WHERE run_id = ${runId}
    `) as Array<{ n: number }>;
    expect(count[0]!.n).toBe(0);
  });
});

// ─── Red→green for codex review findings on PR #865 ────────────────────────

describe("agent_transcript_snapshot — codex P1/P2 regressions", () => {
  test("P1#1 run-binding race: late POST attributes to the worker's claimed run, not the latest one", async () => {
    // PRE-FIX sequence: worker A finished execute() for run 100, started
    // cleanup() POST; run 101 was enqueued for the same conv before A's
    // POST arrived; the route's resolveLatestRunId() picked 101; A's
    // snapshot was stored under run_id=101; worker B's later POST for
    // run 101 hit a 409 and was silently dropped. The fix: worker sends
    // its claimed runId in the body and the route uses it verbatim.
    const orgId = await seedAgentRow("agent-bind", {
      organizationId: "org_bind",
    });
    const agentId = "agent-bind";
    const conversationId = "conv-bind";

    const run100 = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    // Simulate the next user message enqueuing run 101 before worker A's
    // late POST arrives — this is the exact race codex called out.
    const run101 = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    expect(run101).toBeGreaterThan(run100);

    // Worker A's per-run token — bound to run100, NOT run101.
    const tokenA = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: run100,
    });
    const aJsonl = `{"type":"session","id":"worker-A"}\n`;
    const res = await callRoute("POST", "/snapshot", tokenA, {
      terminalStatus: "completed",
      snapshotJsonl: aJsonl,
      // Worker A's claimed runId — even though run 101 is now the
      // "latest" for (org, agent, conv).
      runId: run100,
    });
    expect(res.status).toBe(200);

    // Assertion: the snapshot row is attributed to run100, not run101.
    const sql = getDb();
    const rows = (await sql`
      SELECT run_id, snapshot_jsonl FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId} AND agent_id = ${agentId}
    `) as Array<{ run_id: number; snapshot_jsonl: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.run_id).toBe(run100);
    expect(rows[0]!.snapshot_jsonl).toBe(aJsonl);

    // Now worker B for run 101 POSTs its own snapshot — with its own
    // per-run token. No UNIQUE collision because runs are disjoint.
    const tokenB = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: run101,
    });
    const bJsonl = `{"type":"session","id":"worker-B"}\n`;
    const res2 = await callRoute("POST", "/snapshot", tokenB, {
      terminalStatus: "completed",
      snapshotJsonl: bJsonl,
      runId: run101,
    });
    expect(res2.status).toBe(200);

    const both = (await sql`
      SELECT run_id, snapshot_jsonl FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId} AND agent_id = ${agentId}
      ORDER BY run_id ASC
    `) as Array<{ run_id: number; snapshot_jsonl: string }>;
    expect(both).toHaveLength(2);
    expect(both[0]).toEqual({ run_id: run100, snapshot_jsonl: aJsonl });
    expect(both[1]).toEqual({ run_id: run101, snapshot_jsonl: bJsonl });
  });

  test("P1#1 tenant safety: cannot POST a snapshot for a runId outside the JWT's (org, agent, conv) tuple", async () => {
    // A misbehaving worker that forges a runId belonging to a different
    // conversation must be rejected. Without this check, the runId-from-
    // body design would be more dangerous than the previous lookup.
    const orgA = await seedAgentRow("agent-scope", {
      organizationId: "org_scope_a",
    });
    const orgB = await seedAgentRow("agent-other", {
      organizationId: "org_scope_b",
    });
    const runInB = await insertRun({
      organizationId: orgB,
      agentId: "agent-other",
      conversationId: "conv-other",
    });

    // Token scoped to (orgA, agent-scope, conv-scope) but with the
    // forged runId from orgB. The route's first check (token.runId ===
    // body.runId) passes; the second (isRunOwnedByJwtScope) rejects.
    const tokenA = mintWorkerToken({
      organizationId: orgA,
      agentId: "agent-scope",
      conversationId: "conv-scope",
      runId: runInB,
    });
    const res = await callRoute("POST", "/snapshot", tokenA, {
      terminalStatus: "completed",
      snapshotJsonl: `{"type":"session","id":"forged"}\n`,
      // Forged: belongs to org B, not the JWT's scope.
      runId: runInB,
    });
    expect(res.status).toBe(403);

    // No row written under either org.
    const sql = getDb();
    const count = (await sql`
      SELECT count(*)::int AS n FROM public.agent_transcript_snapshot
    `) as Array<{ n: number }>;
    expect(count[0]!.n).toBe(0);
  });

  test("P2 tenant isolation: /api/v1/agents/:id/history/threads/:threadId/messages reads orgA's snapshot only, not orgB's, when both share the agentId", async () => {
    // PRE-FIX (round 1) sequence: `verifyOwnedAgentAccess` ran a fresh
    // `SELECT organization_id FROM public.agents WHERE id=? AND
    // owner_platform=? AND owner_user_id=? LIMIT 1` — owner_platform +
    // owner_user_id can BOTH match in two orgs simultaneously (same
    // human owns same agentId in two tenants), so the lookup leaked org
    // B's bytes to a session authenticated as org A roughly half the
    // time depending on row order. Codex round 2 finding B noted that
    // the round 1 test drove `readLatestSnapshotJsonl` directly (the
    // store-level helper), not the production `/history` auth path,
    // and missed the bug.
    //
    // FIX: org resolution moved to UserAgentsStore.findAgentOrganizations
    // (reads `agent_users` directly — the authoritative per-org owner
    // mapping). This test drives the HTTP route end-to-end so the
    // ownership-resolver code path is exercised.
    const sharedAgentId = "agent-shared";
    const orgA = "org_p2_a";
    const orgB = "org_p2_b";
    // Seed orgB FIRST so that under the round 1 bug the unscoped
    // `SELECT FROM agents WHERE id=? AND owner_*=? LIMIT 1` lookup
    // returns orgB (PG typically returns inserted-first rows first
    // without an ORDER BY). Both rows have the same owner so the
    // filter doesn't discriminate.
    await seedAgentRow(sharedAgentId, {
      organizationId: orgB,
      ownerPlatform: "external",
      ownerUserId: "u-shared",
    });
    await seedAgentRow(sharedAgentId, {
      organizationId: orgA,
      ownerPlatform: "external",
      ownerUserId: "u-shared",
    });

    // Map ownership in agent_users for ORG A ONLY. The race shape is:
    // BOTH `agents` rows (orgA, orgB) match `(id, owner_platform,
    // owner_user_id)`, but the user actually owns the agent only in
    // orgA (the orgB row was created by someone else with the same
    // owner_user_id). Round 1 resolves org via `agents` and can pick
    // orgB → leaks orgB's snapshot. Round 2 resolves via
    // `agent_users` (this row only) → correctly pins orgA.
    const userAgentsStore = new UserAgentsStore();
    await userAgentsStore.addAgent(
      "external",
      "u-shared",
      sharedAgentId,
      orgA
    );

    // Seed runs + completed snapshots in BOTH orgs. Sort run ids so the
    // orgB snapshot is "newer" globally — under the round 1 bug the
    // unscoped agents lookup could pick orgB even when the caller is
    // authenticated as orgA.
    const sql = getDb();
    const threadA = "thread-a";
    const threadB = "thread-b";
    const convA = buildApiConversationId({
      agentId: sharedAgentId,
      userId: "u-shared",
      organizationId: orgA,
      threadId: threadA,
    });
    const convB = buildApiConversationId({
      agentId: sharedAgentId,
      userId: "u-shared",
      organizationId: orgB,
      threadId: threadB,
    });
    const runA = await insertRun({
      organizationId: orgA,
      agentId: sharedAgentId,
      conversationId: convA,
    });
    const runB = await insertRun({
      organizationId: orgB,
      agentId: sharedAgentId,
      conversationId: convB,
    });
    expect(runB).toBeGreaterThan(runA);

    // Distinguishable JSONL: each org's snapshot contains a single
    // message entry whose `text` carries the org id. The /history
    // route parses these into the response, so a cross-tenant leak
    // shows up as the wrong text payload — not just byte mismatch.
    const aJsonl =
      `{"type":"session","version":3,"id":"sess-A","timestamp":"2026-05-18T10:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"m-A","parentId":null,"timestamp":"2026-05-18T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"FROM-ORG-A"}]}}\n`;
    const bJsonl =
      `{"type":"session","version":3,"id":"sess-B","timestamp":"2026-05-18T10:00:00Z","cwd":"/w"}\n` +
      `{"type":"message","id":"m-B","parentId":null,"timestamp":"2026-05-18T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"FROM-ORG-B"}]}}\n`;
    await sql`
      INSERT INTO public.agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id,
         snapshot_jsonl, byte_size, terminal_status)
      VALUES
        (${orgA}, ${sharedAgentId}, ${convA}, ${runA},
         ${aJsonl}, ${Buffer.byteLength(aJsonl, "utf-8")}, 'completed'),
        (${orgB}, ${sharedAgentId}, ${convB}, ${runB},
         ${bJsonl}, ${Buffer.byteLength(bJsonl, "utf-8")}, 'completed')
    `;

    try {
      // Authenticate as the shared user. The /history route's
      // ownership resolver should pin the org via agent_users; the
      // round 1 bug would have resolved via agents and picked either
      // org depending on row order.
      setAuthProvider(() => ({
        userId: "u-shared",
        platform: "external",
        exp: Date.now() + 60_000,
      }));

      const app = new Hono();
      app.route(
        "/api/v1/agents/:agentId/history",
        createAgentHistoryRoutes({
          userAgentsStore,
        })
      );

      // Multiple calls — flush any nondeterministic row-order
      // sampling. Under the round 1 bug roughly half would resolve
      // to orgB and return "FROM-ORG-B".
      for (let i = 0; i < 5; i++) {
        const response = await app.request(
          `/api/v1/agents/agent-shared/history/threads/${threadA}/messages`,
          {
            headers: { host: "localhost" },
            method: "GET",
          }
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          messages: Array<{
            content: Array<{ type: string; text: string }>;
          }>;
        };
        // The route MUST return orgA's content because that's the
        // org the (user, agent) pair resolves to via the round 2
        // fix's findAgentOrganizations. Under the round 1 bug the
        // unscoped `agents` lookup picked whichever row sorted first
        // and could return orgB's "FROM-ORG-B" text.
        expect(body.messages).toHaveLength(1);
        const text = body.messages[0]?.content?.[0]?.text;
        expect(text).toBe("FROM-ORG-A");
        expect(text).not.toBe("FROM-ORG-B");
      }
    } finally {
      setAuthProvider(null);
    }
  });

  test("A2 (codex round 2) — same-conv cross-run impersonation: deployment-lifetime token cannot POST under a sibling run's slot", async () => {
    // Round 1 made the snapshot route check `body.runId` belongs to
    // the JWT's (org, agent, conv) tuple. But the JWT itself carried
    // NO runId, so worker A bearing a same-conv token could POST any
    // same-scope `runs.id` — including run 101 (a sibling worker's
    // slot) — and overwrite worker B's snapshot. Codex round 2
    // finding A.
    //
    // FIX: the route now requires `tokenData.runId === body.runId`.
    // Deployment-lifetime tokens (no runId) ALWAYS 403. Per-run
    // tokens minted by MessageConsumer carry the exact run the worker
    // claimed.
    const orgId = await seedAgentRow("agent-A2", {
      organizationId: "org_a2",
    });
    const agentId = "agent-A2";
    const conversationId = "conv-A2";

    // Two sibling runs in the SAME (org, agent, conv).
    const claimedByA = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const claimedByB = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });

    // 1) A deployment-lifetime token (no runId) cannot POST under ANY
    //    run. Round 1's `body.runId belongs to JWT scope` would have
    //    let this through.
    const deploymentToken = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      // runId intentionally omitted — this is how the existing
      // WORKER_TOKEN is minted at deployment time.
    });
    const aJsonl = `{"type":"session","id":"impersonator"}\n`;
    const resDep = await callRoute("POST", "/snapshot", deploymentToken, {
      terminalStatus: "completed",
      snapshotJsonl: aJsonl,
      runId: claimedByB,
    });
    expect(resDep.status).toBe(403);

    // 2) A per-run token bound to claimedByA cannot POST under
    //    claimedByB. Token.runId !== body.runId.
    const tokenForA = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: claimedByA,
    });
    const resCross = await callRoute("POST", "/snapshot", tokenForA, {
      terminalStatus: "completed",
      snapshotJsonl: aJsonl,
      runId: claimedByB,
    });
    expect(resCross.status).toBe(403);

    // 3) Per-run token bound to claimedByA POSTing under claimedByA
    //    is the green case. Both fields match.
    const resGreen = await callRoute("POST", "/snapshot", tokenForA, {
      terminalStatus: "completed",
      snapshotJsonl: `{"type":"session","id":"legit-A"}\n`,
      runId: claimedByA,
    });
    expect(resGreen.status).toBe(200);

    // 4) Neither earlier 403 created a row.
    const sql = getDb();
    const rows = (await sql`
      SELECT run_id FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId} AND agent_id = ${agentId}
      ORDER BY run_id ASC
    `) as Array<{ run_id: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.run_id).toBe(claimedByA);
  });

  test("session-reset purges all snapshot rows for this conversation only", async () => {
    // Phase 5: workers (and the gateway-side bridge) must purge PG
    // snapshots on /new, otherwise the next pod boot rehydrates the
    // flushed conversation and the user-visible "Starting fresh" is a
    // lie. This test exercises the worker-side DELETE endpoint.
    const orgId = await seedAgentRow("agent-reset", {
      organizationId: "org_reset",
    });
    const agentId = "agent-reset";
    const conversationId = "conv-reset";

    // Seed 3 completed snapshots for this (org, agent, conv).
    for (let i = 0; i < 3; i++) {
      const runId = await insertRun({
        organizationId: orgId,
        agentId,
        conversationId,
      });
      const token = mintWorkerToken({
        organizationId: orgId,
        agentId,
        conversationId,
        runId,
      });
      const jsonl = `{"type":"message","id":"m${i}"}\n`;
      const res = await callRoute("POST", "/snapshot", token, {
        terminalStatus: "completed",
        snapshotJsonl: jsonl,
        runId,
      });
      expect(res.status).toBe(200);
    }

    // Seed an unrelated row in a SIBLING conversation that must NOT be
    // touched by the reset.
    const siblingConv = "conv-sibling";
    const siblingRun = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId: siblingConv,
    });
    const siblingToken = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId: siblingConv,
      runId: siblingRun,
    });
    let res = await callRoute("POST", "/snapshot", siblingToken, {
      terminalStatus: "completed",
      snapshotJsonl: `{"type":"sibling"}\n`,
      runId: siblingRun,
    });
    expect(res.status).toBe(200);

    // DELETE under a per-run token for the reset conversation.
    const resetRunId = await insertRun({
      organizationId: orgId,
      agentId,
      conversationId,
    });
    const resetToken = mintWorkerToken({
      organizationId: orgId,
      agentId,
      conversationId,
      runId: resetRunId,
    });
    res = await callRoute("DELETE", "/snapshot", resetToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBe(3);

    // Sibling conversation row survives; reset conversation has zero rows.
    const sql = getDb();
    const resetRows = (await sql`
      SELECT id FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId}
        AND agent_id = ${agentId}
        AND conversation_id = ${conversationId}
    `) as Array<{ id: number }>;
    expect(resetRows).toHaveLength(0);

    const siblingRows = (await sql`
      SELECT id FROM public.agent_transcript_snapshot
      WHERE organization_id = ${orgId}
        AND agent_id = ${agentId}
        AND conversation_id = ${siblingConv}
    `) as Array<{ id: number }>;
    expect(siblingRows).toHaveLength(1);

    // Second DELETE is idempotent — returns 200 with deleted=0.
    res = await callRoute("DELETE", "/snapshot", resetToken);
    expect(res.status).toBe(200);
    const body2 = (await res.json()) as { deleted: number };
    expect(body2.deleted).toBe(0);
  });
});

// Drop the auth-provider stub between tests so other suites that share the
// process aren't tainted by the P2 test above.
afterEach(() => {
  setAuthProvider(null);
});
