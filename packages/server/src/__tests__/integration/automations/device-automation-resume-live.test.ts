/**
 * Live device-automation resume round-trip.
 *
 * `@lobu/connector-worker`'s `automation-arm-e2e` drives the daemon against a
 * *stub* gateway whose resume decision is scripted, so it can only prove the
 * daemon honours a decision it was handed. This suite binds the REAL Hono app
 * to a real port over the real test Postgres and lets the REAL
 * `complete-automation` handler decide: a CLI that exits 0 without ever
 * calling completeWindow must be granted exactly `finalize_nudges` resumes,
 * be re-spawned with the nudge in its prompt, and then fail the run.
 *
 * That is the seam the two runtimes share — the daemon's resume loop and the
 * server's nudge budget only agree if `finalize_attempt` round-trips, so this
 * is where a drift between them shows up.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import {
	executeClaimedAutomationRun,
	executeRun,
	WorkerClient,
} from "@lobu/connector-worker/daemon";
import type { PollResponse } from "@lobu/core/contracts/worker/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateSecureToken, hashToken } from "../../../auth/oauth/utils";
import type { DbClient } from "../../../db/client";
import type { Env } from "../../../index";
import { app } from "../../../index";
import { createAutomationRun } from "../../../runs/queue-service";
import { computePendingWindow } from "../../../utils/window-utils";
import { getFreePort } from "../../setup/free-port";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestEntity } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

const testEnv = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	RATE_LIMIT_ENABLED: "false",
} as unknown as Env;

let baseUrl: string;
let server: ReturnType<typeof serve>;
let tmp: string;
let fakeBinary: string;
let invocationLog: string;

/** Every argv the fake CLI was spawned with, one record per invocation. */
function invocations(): string[] {
	const raw = readFileSync(invocationLog, "utf8");
	return raw.split("---INVOCATION---").slice(1);
}

beforeAll(async () => {
	tmp = mkdtempSync(path.join(os.tmpdir(), "lobu-resume-live-"));
	fakeBinary = path.join(tmp, "pi");
	invocationLog = path.join(tmp, "invocations.log");
	// Exits 0 with output but never calls completeWindow — the exact shape that
	// must earn a resume rather than a silent success.
	writeFileSync(
		fakeBinary,
		`#!/bin/sh
echo "---INVOCATION---" >> "$FAKE_CLI_LOG"
printf '%s\\n' "$@" >> "$FAKE_CLI_LOG"
echo "I looked around and then forgot to finalize."
exit 0
`
	);
	chmodSync(fakeBinary, 0o755);
	process.env.FAKE_CLI_LOG = invocationLog;

	const port = await getFreePort();
	server = serve({
		fetch: (request: Request) => app.fetch(request, testEnv),
		port,
		hostname: "127.0.0.1",
	});
	baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(tmp, { recursive: true, force: true });
});

/** Automation + a `running` run claimed by a real device worker, with a
 * worker-bound PAT the daemon can authenticate with. */
async function liveDeviceRun(workerId: string) {
	const sql = getTestDb();
	const workspace = await TestWorkspace.create({ name: "Resume Live Org" });
	const entity = await createTestEntity({
		name: "Resume Live Entity",
		organization_id: workspace.org.id,
		created_by: workspace.users.owner.id,
	});
	const agent = await createTestAgent({
		organizationId: workspace.org.id,
		ownerUserId: workspace.users.owner.id,
		agentId: "resume-live-agent",
		name: "Resume Live Agent",
	});

	const created = (await workspace.owner.automations.create({
		entity_id: entity.id,
		slug: "resume-live",
		name: "Resume Live",
		prompt: "Summarize the window.",
		triggers: [
			{
				kind: "schedule",
				cron: "0 9 * * *",
				execution: "window",
				active_run: "coalesce",
				skip_if_unchanged: false,
			},
		],
		managed_agent_id: agent.agentId,
	})) as { automation_id: string };
	const automationId = Number(created.automation_id);

	// The device row the run is pinned to; complete-automation cross-checks the
	// token's (user_id, worker_id) against approved_input.device_worker_id.
	const [device] = (await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label)
    VALUES (${workspace.users.owner.id}, ${workerId}, 'macos', ${sql.json({})}, 'Live Test Mac')
    RETURNING id
  `) as unknown as Array<{ id: string }>;
	const deviceWorkerId = String(device.id);
	const { windowStart, windowEnd } = await computePendingWindow(sql as unknown as DbClient, automationId);
	const queued = await createAutomationRun({
		organizationId: workspace.org.id,
		automationId,
		agentId: agent.agentId,
		windowStart: windowStart.toISOString(),
		windowEnd: windowEnd.toISOString(),
		dispatchSource: "scheduled",
		deviceWorkerId,
		agentKind: "pi",
	});

	await sql`
    UPDATE runs
    SET status = 'running', claimed_at = NOW(), claimed_by = ${workerId}
    WHERE id = ${queued.runId}
  `;

	const token = `owl_pat_${generateSecureToken(24)}`;
	await sql`
    INSERT INTO personal_access_tokens (
      token_hash, token_prefix, user_id, organization_id, name, scope, worker_id,
      created_at, updated_at
    ) VALUES (
      ${hashToken(token)}, ${token.substring(0, 12)}, ${workspace.users.owner.id},
      ${workspace.org.id}, ${`Live worker PAT (${workerId})`}, 'device_worker:run',
      ${workerId}, NOW(), NOW()
    )
  `;

	return { sql, workspace, automationId, runId: queued.runId, token };
}

function automationJob(runId: number, organizationId: string): PollResponse {
	return {
		run_id: runId,
		run_type: "automation",
		organization_id: organizationId,
		payload: {
			automation: {
				id: "resume-live",
				name: "Resume Live",
				slug: "resume-live",
				agent_kind: "pi",
				prompt: "Summarize the window.",
			},
			event: {
				trigger_event_id: null,
				fired_at: "2026-08-19T00:00:00Z",
				payload: {},
			},
			context: { device: { worker_id: "live-resume-worker" }, user: {} },
		},
	} as unknown as PollResponse;
}

describe("device automation resume — live server round-trip", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
		writeFileSync(invocationLog, "");
	});

	it("grants one resume, re-spawns with the nudge, then fails the run", async () => {
		const workerId = "live-resume-worker";
		const { sql, workspace, runId, token } = await liveDeviceRun(workerId);

		const client = new WorkerClient({
			apiUrl: baseUrl,
			workerId,
			authToken: token,
			capabilities: {},
		});

		// Through the public dispatch switch, not the arm directly — the
		// run_type routing is part of what must hold.
		const result = await executeRun(
			client,
			automationJob(runId, workspace.org.id),
			{} as never,
			{
				heartbeatIntervalMs: 60_000,
				generateEmbeddings: false,
				timeoutMs: 30_000,
				binaryOverrides: { pi: fakeBinary },
			}
		);

		// Budget defaults to 1: the first spawn plus exactly one resume.
		const spawns = invocations();
		expect(spawns).toHaveLength(2);
		expect(spawns[0]).not.toContain("FINALIZE NUDGE");
		expect(spawns[1]).toContain("FINALIZE NUDGE");

		const [run] = (await sql`
      SELECT status, approved_input->>'finalize_nudge_count' AS nudges,
             error_message, exit_reason, output_tail
      FROM runs WHERE id = ${runId}
    `) as unknown as Array<{
			status: string;
			nudges: string | null;
			error_message: string | null;
			exit_reason: string | null;
			output_tail: string | null;
		}>;
		expect(run.status).toBe("failed");
		expect(Number(run.nudges)).toBe(1);
		expect(run.error_message ?? "").toContain("completeWindow");
		// The exit report the daemon actually posted is what stamped the run.
		expect(run.exit_reason).toBe("ok");
		expect(run.output_tail ?? "").toContain("forgot to finalize");
		expect(result.error).toBeUndefined();
	});

	// The one-shot handoff a native bridge uses. Same real server, same real
	// complete-automation handler — what differs is that the CLAIM happened
	// elsewhere, so these pin that the entry point still stamps the row and that
	// its one hard requirement (the claiming worker's id) is load-bearing.
	it("executes an already-claimed run and stamps the row through the real handler", async () => {
		const workerId = "live-resume-worker";
		const { sql, workspace, runId, token } = await liveDeviceRun(workerId);

		const result = await executeClaimedAutomationRun({
			apiUrl: baseUrl,
			workerId,
			authToken: token,
			job: automationJob(runId, workspace.org.id),
			timeoutMs: 30_000,
			heartbeatIntervalMs: 60_000,
			binaryOverrides: { pi: fakeBinary },
		});

		// Identical outcome to the daemon's own dispatch above: the resume budget
		// is the server's, so both entry points must land in the same place.
		expect(invocations()).toHaveLength(2);
		const [run] = (await sql`
      SELECT status, approved_input->>'finalize_nudge_count' AS nudges,
             exit_reason, output_tail
      FROM runs WHERE id = ${runId}
    `) as unknown as Array<{
			status: string;
			nudges: string | null;
			exit_reason: string | null;
			output_tail: string | null;
		}>;
		expect(run.status).toBe("failed");
		expect(Number(run.nudges)).toBe(1);
		expect(run.exit_reason).toBe("ok");
		expect(run.output_tail ?? "").toContain("forgot to finalize");
		expect(result.error).toBeUndefined();
	});

	it("a worker id that did not claim the run loses the report SILENTLY", async () => {
		const workerId = "live-resume-worker";
		const { sql, workspace, runId, token } = await liveDeviceRun(workerId);

		// A second registered device of the same user. Reporting as it is refused
		// 403 (`authorizeRunForWorker` requires `claimed_by === worker_id`), which
		// `isRetriableDeliveryFailure` classifies as non-retriable — so the arm
		// gives up after ONE attempt, logs an undelivered exit report, and returns
		// no error. The loss is invisible to the caller, which is why `workerId` is
		// a hard requirement on the one-shot entry point rather than a default.
		const otherWorkerId = "live-resume-worker-2";
		await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label)
      VALUES (${workspace.users.owner.id}, ${otherWorkerId}, 'macos', ${sql.json({})}, 'Other Mac')
    `;

		const result = await executeClaimedAutomationRun({
			apiUrl: baseUrl,
			workerId: otherWorkerId,
			authToken: token,
			job: automationJob(runId, workspace.org.id),
			timeoutMs: 30_000,
			heartbeatIntervalMs: 60_000,
			binaryOverrides: { pi: fakeBinary },
		});

		// The agent still ran, once — the wrong id costs the REPORT, not the work,
		// and the non-retriable 403 means no second delivery attempt either.
		expect(invocations()).toHaveLength(1);
		const [run] = (await sql`
      SELECT status, exit_reason FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ status: string; exit_reason: string | null }>;
		expect(run.status).toBe("running");
		expect(run.exit_reason).toBeNull();
		// And it reports no error, which is exactly what makes it silent.
		expect(result.error).toBeUndefined();
	});
});
