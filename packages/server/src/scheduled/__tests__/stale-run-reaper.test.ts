/**
 * Integration test for the connector-lane stale-run reaper. Seeds three
 * connector runs into the test database and asserts the reaper only fails the one that
 * is in-progress with a stale `last_heartbeat_at`. Also exercises the
 * advisory-lock contention path: a second concurrent caller while the lock
 * is held no-ops instead of double-failing the row.
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import postgres from "postgres";
import { getDb } from "../../db/client";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup";
import { reapStaleRuns } from "../check-stalled-executions";

const ORG_ID = "reaper-org";
const STALE_THRESHOLD_SECONDS = 60;
const DROP_FAILED_APPROVAL_EVENT_TRIGGER = `
DROP TRIGGER IF EXISTS test_fail_stale_approval_event_trg ON events;
DROP FUNCTION IF EXISTS test_fail_stale_approval_event();
`;

beforeAll(async () => {
	await ensureDbForGatewayTests();
	process.env.RUNS_REAPER_STALE_AFTER_SECONDS = String(STALE_THRESHOLD_SECONDS);
	process.env.FEED_BACKOFF_BASE_MS = "60000";
	process.env.FEED_BACKOFF_MAX_MS = "60000";
	process.env.FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES = "20";
});

afterAll(() => {
	delete process.env.RUNS_REAPER_STALE_AFTER_SECONDS;
	delete process.env.FEED_BACKOFF_BASE_MS;
	delete process.env.FEED_BACKOFF_MAX_MS;
	delete process.env.FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES;
});

beforeEach(async () => {
	await resetTestDatabase();
	const sql = getDb();
	await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG_ID}, ${ORG_ID}, ${ORG_ID})
    ON CONFLICT (id) DO NOTHING
  `;
});

interface SeedRunOpts {
	status: "pending" | "claimed" | "running" | "completed";
	lastHeartbeatAgoSeconds: number | null;
	claimedAtAgoSeconds?: number | null;
	runType?:
		| "sync"
		| "action"
		| "embed_backfill"
		| "auth"
		| "automation"
		| "agent_turn";
	feedId?: number | null;
	createdAtAgoSeconds?: number;
	/** Defaults to 'auto' (worker-claimable). Set 'pending' for a human-approval run. */
	approvalStatus?: "auto" | "pending" | "approved" | "rejected" | "expired";
	createdAtAgoDays?: number;
	/** runs.dry_run — the connector executes for real, the server persists nothing. */
	dryRun?: boolean;
	/** runs.expires_at — explicit claim horizon. NULL when omitted. */
	expiresAtAgoSeconds?: number | null;
	/** Park this action until a matching browser page is visited. */
	pageActivation?: "waiting" | "activated";
}

async function seedRun(opts: SeedRunOpts): Promise<number> {
	const sql = getDb();
	const runType = opts.runType ?? "sync";
	const hbInterval =
		opts.lastHeartbeatAgoSeconds !== null
			? `current_timestamp - interval '${opts.lastHeartbeatAgoSeconds} seconds'`
			: "NULL";
	const claimInterval =
		opts.claimedAtAgoSeconds !== null && opts.claimedAtAgoSeconds !== undefined
			? `current_timestamp - interval '${opts.claimedAtAgoSeconds} seconds'`
			: "NULL";
	const createdAt =
		opts.createdAtAgoDays !== undefined
			? `current_timestamp - interval '${opts.createdAtAgoDays} days'`
			: `current_timestamp - interval '${opts.createdAtAgoSeconds ?? 0} seconds'`;
	const expiresAt =
		opts.expiresAtAgoSeconds !== undefined && opts.expiresAtAgoSeconds !== null
			? `current_timestamp - interval '${opts.expiresAtAgoSeconds} seconds'`
			: "NULL";
	const rows = (await sql.unsafe(
		`INSERT INTO runs (
       organization_id, run_type, feed_id, status, approval_status,
       claimed_at, last_heartbeat_at, claimed_by, created_at, dry_run, expires_at,
       activation_kind, activation_target_urls, activated_at,
       activated_by_device_worker_id, activation_tab_id
     ) VALUES (
       $1, $2, $3, $4, $5,
       ${claimInterval}, ${hbInterval}, 'test-worker', ${createdAt}, $6, ${expiresAt},
       $7, $8::text[],
       ${opts.pageActivation === "activated" ? "current_timestamp" : "NULL"},
       ${opts.pageActivation === "activated" ? "'00000000-0000-0000-0000-000000000001'::uuid" : "NULL"},
       ${opts.pageActivation === "activated" ? "17" : "NULL"}
     )
     RETURNING id`,
		[
			ORG_ID,
			runType,
			opts.feedId ?? null,
			opts.status,
			opts.approvalStatus ?? "auto",
			opts.dryRun ?? false,
			opts.pageActivation ? "page_visit" : null,
			opts.pageActivation ? '{"https://x.com/ada/status/123"}' : null,
		],
	)) as unknown as Array<{ id: number | string }>;
	return Number(rows[0].id);
}

async function seedFeed(feedId: number): Promise<void> {
	const sql = getDb();
	// Seed an org-scoped connection + feed at the requested id so the
	// runs.feed_id FK is satisfied. Each test bumps the id so the
	// partial-unique-index dedup logic exercises real rows.
	await sql.unsafe(
		`INSERT INTO connections (id, organization_id, connector_key, slug, status, created_at)
     VALUES ($1, $2, 'fake', $3, 'active', current_timestamp)
     ON CONFLICT (id) DO NOTHING`,
		[feedId, ORG_ID, `fake-${feedId}`],
	);
	await sql.unsafe(
		`INSERT INTO feeds (id, organization_id, connection_id, feed_key, status, created_at, updated_at)
     VALUES ($1, $2, $1, 'data', 'active', current_timestamp, current_timestamp)
     ON CONFLICT (id) DO NOTHING`,
		[feedId, ORG_ID],
	);
}

async function statusOf(runId: number): Promise<string> {
	const sql = getDb();
	const rows =
		(await sql`SELECT status FROM runs WHERE id = ${runId}`) as unknown as Array<{
			status: string;
		}>;
	return rows[0]?.status ?? "missing";
}

async function approvalStatusOf(runId: number): Promise<string> {
	const sql = getDb();
	const rows = (await sql`
    SELECT approval_status FROM runs WHERE id = ${runId}
  `) as unknown as Array<{ approval_status: string }>;
	return rows[0]?.approval_status ?? "missing";
}

async function seedApprovedActionCard(runId: number): Promise<void> {
	const sql = getDb();
	await sql`
    UPDATE runs SET action_key = 'stale_action' WHERE id = ${runId}
  `;
	await sql`
    INSERT INTO events (
      organization_id, origin_id, title, payload_text, run_id,
      semantic_type, interaction_type, interaction_status, metadata
    ) VALUES (
      ${ORG_ID}, ${`run_${runId}_confirmed`}, 'stale_action — executing',
      'Operation confirmed: stale_action', ${runId}, 'operation',
      'approval', 'approved', ${sql.json({
			status: "confirmed",
			action_key: "stale_action",
			run_id: runId,
		})}
    )
  `;
}

async function currentApprovalCardStatus(runId: number): Promise<string> {
	const rows = await getDb()<{
		interaction_status: string;
	}>`
    SELECT interaction_status
    FROM current_event_records
    WHERE organization_id = ${ORG_ID}
      AND run_id = ${runId}
      AND semantic_type = 'operation'
      AND interaction_type = 'approval'
  `;
	return rows[0]?.interaction_status ?? "missing";
}

describe("reapStaleRuns — connector lanes", () => {
	test("a stale never-claimed sync is a dispatch failure and preserves source health", async () => {
		const feedId = 3131;
		await seedFeed(feedId);
		const sql = getDb();
		await sql`
      UPDATE feeds
      SET last_sync_status = 'success',
          last_error = NULL,
          consecutive_failures = 19,
          first_failure_at = current_timestamp - INTERVAL '1 day',
          next_run_at = current_timestamp + INTERVAL '1 hour'
      WHERE id = ${feedId}
    `;
		const [feedBefore] = await sql`
      SELECT last_sync_status, last_error, consecutive_failures,
             first_failure_at, next_run_at, status
      FROM feeds WHERE id = ${feedId}
    `;
		const pendingId = await seedRun({
			status: "pending",
			lastHeartbeatAgoSeconds: null,
			runType: "sync",
			feedId,
			createdAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
		});

		const result = await reapStaleRuns();

		expect(result.reaped).toBe(1);
		expect(result.retriesCreated).toBe(0);
		expect(result.dispatchFailures).toHaveLength(1);
		expect(result.dispatchFailures[0]?.reason).toBe(
			"fleet_or_unpinned_no_claim",
		);
		expect(await statusOf(pendingId)).toBe("timeout");

		const pending = await sql`
      SELECT id FROM runs
      WHERE feed_id = ${feedId} AND run_type = 'sync' AND status = 'pending'
    `;
		expect(pending).toHaveLength(0);
		const [feed] = await sql`
      SELECT last_sync_status, last_error, consecutive_failures,
             first_failure_at, next_run_at, status
      FROM feeds WHERE id = ${feedId}
    `;
		expect(feed).toEqual(feedBefore);
	});

	test("classifies no device poll separately from a poll that was capability-ineligible", async () => {
		const sql = getDb();
		await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (
        'reaper-device-user', 'Reaper Device User', 'reaper-device@test.local',
        true, current_timestamp, current_timestamp
      )
    `;
		await sql`
      INSERT INTO connector_definitions (
        key, name, version, organization_id, status, required_capability,
        created_at, updated_at
      ) VALUES (
        'fake', 'Fake Device Connector', '1.0.0', ${ORG_ID}, 'active',
        'os.shell', current_timestamp, current_timestamp
      )
    `;
		await sql`
      INSERT INTO connector_versions (organization_id, connector_key, version)
      VALUES (${ORG_ID}, 'fake', '1.0.0')
      ON CONFLICT DO NOTHING
    `;
		const devices = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label,
        organization_id, last_seen_at
      ) VALUES
        (
          'reaper-device-user', 'reaper-offline', 'macos', ${sql.json(["os.shell"])},
          'Offline device', ${ORG_ID}, current_timestamp - INTERVAL '10 minutes'
        ),
        (
          'reaper-device-user', 'reaper-ineligible', 'macos', ${sql.json([])},
          'Ineligible device', ${ORG_ID}, current_timestamp
        )
      RETURNING id, worker_id
    `) as unknown as Array<{ id: string; worker_id: string }>;
		const offlineDevice = devices.find((device) => device.worker_id === "reaper-offline");
		const ineligibleDevice = devices.find(
			(device) => device.worker_id === "reaper-ineligible",
		);
		expect(offlineDevice).toBeDefined();
		expect(ineligibleDevice).toBeDefined();

		const offlineFeedId = 4101;
		const ineligibleFeedId = 4102;
		await seedFeed(offlineFeedId);
		await seedFeed(ineligibleFeedId);
		await sql`
      UPDATE connections
      SET device_worker_id = CASE id
        WHEN ${offlineFeedId} THEN ${offlineDevice?.id}::uuid
        WHEN ${ineligibleFeedId} THEN ${ineligibleDevice?.id}::uuid
      END
      WHERE id IN (${offlineFeedId}, ${ineligibleFeedId})
    `;
		const offlineRunId = await seedRun({
			status: "pending",
			lastHeartbeatAgoSeconds: null,
			runType: "sync",
			feedId: offlineFeedId,
			createdAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
		});
		const ineligibleRunId = await seedRun({
			status: "pending",
			lastHeartbeatAgoSeconds: null,
			runType: "sync",
			feedId: ineligibleFeedId,
			createdAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
		});
		await sql`
      UPDATE runs
      SET connection_id = feed_id,
          connector_key = 'fake',
          connector_version = '1.0.0'
      WHERE id IN (${offlineRunId}, ${ineligibleRunId})
    `;

		const result = await reapStaleRuns();
		const reasons = Object.fromEntries(
			result.dispatchFailures.map((failure) => [failure.runId, failure.reason]),
		);
		expect(reasons).toEqual({
			[offlineRunId]: "no_device_poll_during_pending_window",
			[ineligibleRunId]: "device_ineligible_required_capability",
		});
	});

	test("a fresh never-claimed sync remains pending", async () => {
		const pendingId = await seedRun({
			status: "pending",
			lastHeartbeatAgoSeconds: null,
			runType: "sync",
			createdAtAgoSeconds: 5,
		});

		const result = await reapStaleRuns();

		expect(result.reaped).toBe(0);
		expect(await statusOf(pendingId)).toBe("pending");
	});

	// #2044: a queued connector action awaiting HUMAN approval sits in
	// status='pending', approval_status='pending'. No worker will ever claim it,
	// so the claim-timeout must NOT reap it — otherwise the run is force-timed-out
	// before anyone can approve, and the approval URL points at a dead run.
	test("a stale action run awaiting human approval is NOT reaped", async () => {
		const approvalId = await seedRun({
			status: "pending",
			approvalStatus: "pending",
			lastHeartbeatAgoSeconds: null,
			runType: "action",
			createdAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
		});

		const result = await reapStaleRuns();

		expect(result.reaped).toBe(0);
		expect(await statusOf(approvalId)).toBe("pending");
	});

	// Control: the guard is narrow. An auto-approved (worker-claimable) action run
	// that never got claimed IS still reaped once stale — approval-gating is the
	// ONLY exemption, so genuinely-stuck worker runs still time out.
	test("a stale auto-approval action run IS still reaped", async () => {
		const autoId = await seedRun({
			status: "pending",
			approvalStatus: "auto",
			lastHeartbeatAgoSeconds: null,
			runType: "action",
			createdAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
		});

		const result = await reapStaleRuns();

		expect(result.reaped).toBe(1);
		expect(result.retriesCreated).toBe(0);
		expect(result.dispatchFailures).toEqual([
			expect.objectContaining({
				runId: autoId,
				runType: "action",
				reason: "fleet_or_unpinned_no_claim",
			}),
		]);
		expect(await statusOf(autoId)).toBe("timeout");
		const [row] = await getDb()`
			SELECT error_message FROM runs WHERE id = ${autoId}
		`;
		expect(row.error_message).toBe("worker_claim_timeout");
	});

	test("a page-activated action waits until its explicit expiry", async () => {
		const waitingId = await seedRun({
			status: "pending",
			approvalStatus: "auto",
			lastHeartbeatAgoSeconds: null,
			runType: "action",
			createdAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			expiresAtAgoSeconds: -3600,
			pageActivation: "waiting",
		});

		const result = await reapStaleRuns();
		expect(result.reaped).toBe(0);
		expect(await statusOf(waitingId)).toBe("pending");
	});

	test("a page-activated action times out after its explicit expiry", async () => {
		const waitingId = await seedRun({
			status: "pending",
			approvalStatus: "auto",
			lastHeartbeatAgoSeconds: null,
			runType: "action",
			createdAtAgoSeconds: 5,
			expiresAtAgoSeconds: 1,
			pageActivation: "waiting",
		});

		const result = await reapStaleRuns();
		expect(result.reaped).toBe(1);
		expect(await statusOf(waitingId)).toBe("timeout");
	});

	// #2044 REGRESSION GUARD — the single most important assertion here.
	//
	// The long-horizon expiry sweep (scheduled/expire-pending-approvals.ts) was
	// added to take undecided approvals terminal after DAYS. It must not have
	// leaked into the SHORT-horizon reaper: a fresh approval-pending run, and a
	// stale-by-CLAIM-horizon one, must both still survive this reaper untouched,
	// however long they sit, because no worker will ever claim them and the human
	// has not decided yet. If this fails, #2044 is re-broken and approval URLs
	// point at dead runs again.
	test("#2044: approval-pending runs survive the short-horizon reaper at every age", async () => {
		const fresh = await seedRun({
			status: "pending",
			approvalStatus: "pending",
			lastHeartbeatAgoSeconds: null,
			runType: "action",
			createdAtAgoSeconds: 1,
		});
		const pastClaimHorizon = await seedRun({
			status: "pending",
			approvalStatus: "pending",
			lastHeartbeatAgoSeconds: null,
			runType: "action",
			createdAtAgoSeconds: STALE_THRESHOLD_SECONDS * 50,
		});
		// Older than the LONG horizon too. Even here the short reaper must not act
		// — expiring this row is the expiry sweep's job, under its own vocabulary
		// ('expired'), not a claim timeout.
		const pastExpiryHorizon = await seedRun({
			status: "pending",
			approvalStatus: "pending",
			lastHeartbeatAgoSeconds: null,
			runType: "action",
			createdAtAgoDays: 30,
		});

		const result = await reapStaleRuns();

		expect(result.reaped).toBe(0);
		for (const id of [fresh, pastClaimHorizon, pastExpiryHorizon]) {
			expect(await statusOf(id)).toBe("pending");
			expect(await approvalStatusOf(id)).toBe("pending");
		}
	});

	// The reaper must also leave an already-EXPIRED row alone: it is terminal, and
	// re-reaping it would overwrite 'cancelled' with 'timeout' and lose the reason.
	test("an expired approval run is terminal and not re-reaped", async () => {
		const expiredId = await seedRun({
			status: "cancelled",
			approvalStatus: "expired",
			lastHeartbeatAgoSeconds: null,
			runType: "action",
			createdAtAgoDays: 30,
		});

		const result = await reapStaleRuns();

		expect(result.reaped).toBe(0);
		expect(await statusOf(expiredId)).toBe("cancelled");
		expect(await approvalStatusOf(expiredId)).toBe("expired");
	});

	test("a worker claim holding the row lock wins over pending expiration", async () => {
		const pendingId = await seedRun({
			status: "pending",
			lastHeartbeatAgoSeconds: null,
			runType: "sync",
			createdAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
		});
		const locker = postgres(process.env.DATABASE_URL as string, { max: 1 });
		try {
			await locker.begin(async (tx) => {
				await tx`SELECT id FROM runs WHERE id = ${pendingId} FOR UPDATE`;

				const result = await reapStaleRuns();
				expect(result.reaped).toBe(0);

				await tx`
          UPDATE runs
          SET status = 'claimed', claimed_at = current_timestamp, claimed_by = 'winning-worker'
          WHERE id = ${pendingId}
        `;
			});
		} finally {
			await locker.end();
		}

		expect(await statusOf(pendingId)).toBe("claimed");
		const afterClaim = await reapStaleRuns();
		expect(afterClaim.reaped).toBe(0);
		expect(await statusOf(pendingId)).toBe("claimed");
	});

	test("only the stale in-progress connector run is timed out", async () => {
		// 1. Fresh heartbeat — should be left alone.
		const freshId = await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: 5,
			claimedAtAgoSeconds: 120,
		});
		// 2. Stale heartbeat — should be reaped.
		const staleId = await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
		});
		// 3. Terminal state (completed) — must never be touched even if it had a
		//    stale heartbeat at the moment it completed.
		const terminalId = await seedRun({
			status: "completed",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 10,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 10,
		});

		const result = await reapStaleRuns();

		expect(result.acquired).toBe(true);
		expect(result.reaped).toBe(1);

		expect(await statusOf(freshId)).toBe("running");
		expect(await statusOf(staleId)).toBe("timeout");
		expect(await statusOf(terminalId)).toBe("completed");

		const sql = getDb();
		const reaped = (await sql`
      SELECT error_message FROM runs WHERE id = ${staleId}
    `) as unknown as Array<{ error_message: string | null }>;
		expect(reaped[0].error_message).toBe("worker_heartbeat_lost");
	});

	test("approved action timeout supersedes its card in the same transition", async () => {
		const runId = await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			runType: "action",
			approvalStatus: "approved",
		});
		await seedApprovedActionCard(runId);

		const result = await reapStaleRuns();

		expect(result.reaped).toBe(1);
		expect(await statusOf(runId)).toBe("timeout");
		expect(await currentApprovalCardStatus(runId)).toBe("failed");
	});

	test("approved action timeout rolls back when its card write fails", async () => {
		const runId = await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			runType: "action",
			approvalStatus: "approved",
		});
		await seedApprovedActionCard(runId);
		await getDb().unsafe(`
      CREATE OR REPLACE FUNCTION test_fail_stale_approval_event()
        RETURNS trigger AS $fn$
      BEGIN
        IF NEW.interaction_type = 'approval' AND NEW.interaction_status = 'failed' THEN
          RAISE EXCEPTION 'simulated stale approval-event write failure';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_stale_approval_event_trg
        BEFORE INSERT ON events
        FOR EACH ROW EXECUTE FUNCTION test_fail_stale_approval_event();
    `);

		try {
			const result = await reapStaleRuns();

			expect(result.reaped).toBe(0);
			expect(await statusOf(runId)).toBe("running");
			expect(await currentApprovalCardStatus(runId)).toBe("approved");
		} finally {
			await getDb().unsafe(DROP_FAILED_APPROVAL_EVENT_TRIGGER);
		}
	});

	// A claimed run whose APPLY already succeeded durably (action_output is
	// persisted on a running/approved run) is a "terminalization pending" row: the
	// external mutation already happened and only the completed card write failed.
	// The reaper must COMPLETE it from the durable output, never report a FALSE
	// timeout that would mislabel an already-successful external mutation.
	test("an approved action run with durable output is completed, not timed out", async () => {
		const runId = await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			runType: "action",
			approvalStatus: "approved",
		});
		await seedApprovedActionCard(runId);
		await getDb()`
			UPDATE runs SET action_output = ${getDb().json({ body: { created: true } })}
			WHERE id = ${runId}
		`;

		const result = await reapStaleRuns();

		expect(result.reaped).toBe(1);
		// (RED today: the reaper marks it 'timeout' + the card 'failed'.)
		expect(await statusOf(runId)).toBe("completed");
		expect(await currentApprovalCardStatus(runId)).toBe("completed");
		const [run] = (await getDb()`
			SELECT action_output FROM runs WHERE id = ${runId}
		`) as unknown as Array<{ action_output: Record<string, unknown> }>;
		expect(run.action_output).toEqual({ body: { created: true } });
	});

	test("approved action output completion rolls back when the completed card write fails", async () => {
		const runId = await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			runType: "action",
			approvalStatus: "approved",
		});
		await seedApprovedActionCard(runId);
		await getDb()`
			UPDATE runs SET action_output = ${getDb().json({ body: { created: true } })}
			WHERE id = ${runId}
		`;
		await getDb().unsafe(`
      CREATE OR REPLACE FUNCTION test_fail_stale_completed_event()
        RETURNS trigger AS $fn$
      BEGIN
        IF NEW.interaction_type = 'approval' AND NEW.interaction_status = 'completed' THEN
          RAISE EXCEPTION 'simulated stale completed-event write failure';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_stale_completed_event_trg
        BEFORE INSERT ON events
        FOR EACH ROW EXECUTE FUNCTION test_fail_stale_completed_event();
    `);

		try {
			const result = await reapStaleRuns();

			// The failed completed-card write rolls the completion back; the run
			// stays running (its durable output intact) for the next tick.
			expect(result.reaped).toBe(0);
			expect(await statusOf(runId)).toBe("running");
			expect(await currentApprovalCardStatus(runId)).toBe("approved");
		} finally {
			await getDb().unsafe(`
				DROP TRIGGER IF EXISTS test_fail_stale_completed_event_trg ON events;
				DROP FUNCTION IF EXISTS test_fail_stale_completed_event();
			`);
		}
	});

	test("claimed rows that never sent any heartbeat are reaped via claimed_at", async () => {
		const id = await seedRun({
			status: "claimed",
			lastHeartbeatAgoSeconds: null,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
		});
		const result = await reapStaleRuns();
		expect(result.reaped).toBe(1);
		expect(await statusOf(id)).toBe("timeout");
	});

	test("automation lane is excluded from this reaper", async () => {
		// Automation runs have their own dedicated 2h sweep in automations/automation.ts.
		const automationId = await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 10,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 10,
			runType: "automation",
		});
		const result = await reapStaleRuns();
		expect(result.reaped).toBe(0);
		expect(await statusOf(automationId)).toBe("running");
	});

	test("back-to-back calls do not double-fail the same row", async () => {
		// The advisory-lock guards cross-pod contention. Rather than simulate two
		// pods literally racing the SELECT-then-UPDATE, this proves the
		// function-level invariant the lock enforces: a row that's already been
		// reaped doesn't get reaped a second time even if the sweeper fires again.
		const staleId = await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
		});

		const first = await reapStaleRuns();
		expect(first.acquired).toBe(true);
		expect(first.reaped).toBe(1);
		expect(await statusOf(staleId)).toBe("timeout");

		// Second pass — same lock acquired, but the row is now `timeout` so the
		// WHERE clause excludes it. No double-fail, no parallel retry inserted.
		const second = await reapStaleRuns();
		expect(second.acquired).toBe(true);
		expect(second.reaped).toBe(0);
		expect(second.retriesCreated).toBe(0);
		expect(await statusOf(staleId)).toBe("timeout");
	});

	test("action, embed_backfill, auth lanes are reaped (parity with sync)", async () => {
		// All four connector lanes now emit `client.heartbeat()` from the
		// out-of-process executor (lobu#860 wired action + embed_backfill;
		// sync + auth already did). The reaper's WHERE clause covers all
		// four; staleness on `last_heartbeat_at` is a real failure signal
		// everywhere.
		const actionId = await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			runType: "action",
		});
		const embedId = await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			runType: "embed_backfill",
		});
		const authId = await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			runType: "auth",
		});

		const result = await reapStaleRuns();
		expect(result.reaped).toBe(3);
		expect(await statusOf(actionId)).toBe("timeout");
		expect(await statusOf(embedId)).toBe("timeout");
		expect(await statusOf(authId)).toBe("timeout");
	});

	describe("expires_at — ephemeral device action runs", () => {
		test("a pending run whose expires_at lapsed is terminalized as timeout even when younger than the coarse interval", async () => {
			// Ephemeral device/browser action runs carry an explicit claim horizon
			// (queue-service sets expires_at for approvalMode='device'). A lapsed
			// horizon must never be claimable later — the reaper terminalizes it
			// even though created_at is still inside the coarse window.
			const lapsedId = await seedRun({
				status: "pending",
				lastHeartbeatAgoSeconds: null,
				runType: "action",
				createdAtAgoSeconds: 5,
				expiresAtAgoSeconds: 1,
			});

			const result = await reapStaleRuns();
			expect(result.reaped).toBe(1);
			expect(await statusOf(lapsedId)).toBe("timeout");
		});

		test("a pending run with a future expires_at is untouched", async () => {
			const liveId = await seedRun({
				status: "pending",
				lastHeartbeatAgoSeconds: null,
				runType: "action",
				createdAtAgoSeconds: 5,
				expiresAtAgoSeconds: -60,
			});

			const result = await reapStaleRuns();
			expect(result.reaped).toBe(0);
			expect(await statusOf(liveId)).toBe("pending");
		});

		test("expires_at does not shorten the coarse horizon for non-action runs", async () => {
			const syncId = await seedRun({
				status: "pending",
				lastHeartbeatAgoSeconds: null,
				runType: "sync",
				createdAtAgoSeconds: 5,
				expiresAtAgoSeconds: 1,
			});

			const result = await reapStaleRuns();
			expect(result.reaped).toBe(0);
			expect(await statusOf(syncId)).toBe("pending");
		});

		test("a lapsed-expiry action run is never retried as a sync", async () => {
			const feedId = 7771;
			await seedFeed(feedId);
			const lapsedActionId = await seedRun({
				status: "pending",
				lastHeartbeatAgoSeconds: null,
				runType: "action",
				feedId,
				createdAtAgoSeconds: 5,
				expiresAtAgoSeconds: 1,
			});

			const result = await reapStaleRuns();
			expect(result.reaped).toBe(1);
			expect(result.retriesCreated).toBe(0);
			expect(await statusOf(lapsedActionId)).toBe("timeout");
		});

		test("terminalization is idempotent — a lapsed-expiry run is not re-reaped", async () => {
			const lapsedId = await seedRun({
				status: "pending",
				lastHeartbeatAgoSeconds: null,
				runType: "action",
				createdAtAgoSeconds: 5,
				expiresAtAgoSeconds: 1,
			});

			const first = await reapStaleRuns();
			expect(first.reaped).toBe(1);
			expect(await statusOf(lapsedId)).toBe("timeout");

			const second = await reapStaleRuns();
			expect(second.reaped).toBe(0);
			expect(await statusOf(lapsedId)).toBe("timeout");
		});

		test("#2044 × expires_at: an approval-pending run with a lapsed horizon is NOT reaped", async () => {
			// A queued action awaiting HUMAN approval sits at approval_status=
			// 'pending' — no worker will ever claim it, so the claim-timeout must
			// never reap it even if it carries an expires_at that lapsed (the
			// expiry is an ephemeral-device horizon; a human decision outlives it).
			const approvalId = await seedRun({
				status: "pending",
				approvalStatus: "pending",
				lastHeartbeatAgoSeconds: null,
				runType: "action",
				createdAtAgoSeconds: 5,
				expiresAtAgoSeconds: 1,
			});

			const result = await reapStaleRuns();
			expect(result.reaped).toBe(0);
			expect(await statusOf(approvalId)).toBe("pending");
		});

		test("a lapsed-expiry RUNNING row is not reaped (expires_at only governs pending claims)", async () => {
			// The expires_at term lives in the pending branch. A claimed/running
			// run is judged on heartbeat staleness, never on its claim horizon —
			// otherwise a long-but-live device action would be killed mid-flight.
			const runningId = await seedRun({
				status: "running",
				lastHeartbeatAgoSeconds: 5,
				claimedAtAgoSeconds: 5,
				runType: "action",
				expiresAtAgoSeconds: 1,
			});

			const result = await reapStaleRuns();
			expect(result.reaped).toBe(0);
			expect(await statusOf(runningId)).toBe("running");
		});
	});
});

describe("reapStaleRuns — atomic timeout + retry (lobu#862)", () => {
	test("a stale sync run gets timed out AND a retry queued in one statement", async () => {
		// Seed a stale sync run for a feed. After reapStaleRuns runs, we
		// should see exactly one timeout + one pending retry for the same
		// feed — both written in the same CTE so a process crash cannot
		// leave the row timed out with no retry queued.
		const feedId = 4242;
		await seedFeed(feedId);
		const staleId = await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			runType: "sync",
			feedId,
		});

		const result = await reapStaleRuns();
		expect(result.reaped).toBe(1);
		expect(result.retriesCreated).toBe(1);
		expect(await statusOf(staleId)).toBe("timeout");

		const sql = getDb();
		const retries = (await sql`
      SELECT id, status FROM runs
      WHERE feed_id = ${feedId} AND run_type = 'sync' AND status = 'pending'
    `) as unknown as Array<{ id: number | string; status: string }>;
		expect(retries.length).toBe(1);
	});

	test("non-sync stale runs do NOT produce retries (action/embed_backfill/auth)", async () => {
		// Only sync runs need a re-queue; the other lanes are reaped but
		// not retried.
		await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			runType: "action",
		});
		await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			runType: "embed_backfill",
		});
		await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			runType: "auth",
		});

		const result = await reapStaleRuns();
		expect(result.reaped).toBe(3);
		expect(result.retriesCreated).toBe(0);
	});

	test("two stale sync runs on the SAME feed produce exactly one retry (dedup via NOT EXISTS)", async () => {
		// Two stale runs that share a feed_id can only exist if one is in a
		// terminal status — the partial unique index `idx_runs_active_sync_per_feed`
		// forbids two simultaneously active syncs per feed. Simulate the
		// realistic case: a previously-completed sync, plus a stale running
		// one. The reaper should reap the running one and queue exactly
		// ONE retry for that feed (not two — the completed one is not
		// touched).
		//
		// This also exercises the dedup-against-itself trap: if the NOT
		// EXISTS predicate didn't exclude `timed_out.id`, the running row
		// would dedupe against itself and no retries would be queued.
		const feedId = 5151;
		await seedFeed(feedId);
		// First run already finished — terminal, not in the active set.
		await seedRun({
			status: "completed",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 10,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 10,
			runType: "sync",
			feedId,
		});
		const staleId = await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			runType: "sync",
			feedId,
		});

		const result = await reapStaleRuns();
		expect(result.reaped).toBe(1);
		expect(result.retriesCreated).toBe(1);
		expect(await statusOf(staleId)).toBe("timeout");

		// Exactly one pending row queued.
		const sql = getDb();
		const pending = (await sql`
      SELECT id FROM runs
      WHERE feed_id = ${feedId} AND run_type = 'sync' AND status = 'pending'
    `) as unknown as Array<{ id: number | string }>;
		expect(pending.length).toBe(1);
	});

	test("a pending sync that pre-exists prevents a duplicate retry being inserted", async () => {
		// Edge case: a pending sync exists for the feed, and an unrelated
		// stale auth run (no feed) is reaped in the same sweep. We should
		// reap the auth row, and NOT insert any sync retry — the pending
		// sync already covers the feed.
		//
		// (We can't co-exist a stale sync + a pending sync on the same
		// feed; the partial unique index forbids it. This test uses a
		// different lane to exercise the negative path.)
		const feedId = 6262;
		await seedFeed(feedId);
		await seedRun({
			status: "pending",
			lastHeartbeatAgoSeconds: null,
			runType: "sync",
			feedId,
		});
		const authId = await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			runType: "auth",
		});

		const result = await reapStaleRuns();
		expect(result.reaped).toBe(1);
		// No retry insert: auth lane doesn't queue retries.
		expect(result.retriesCreated).toBe(0);
		expect(await statusOf(authId)).toBe("timeout");

		// The pre-existing pending sync stays intact, no duplicates.
		const sql = getDb();
		const pending = (await sql`
      SELECT id FROM runs
      WHERE feed_id = ${feedId} AND run_type = 'sync' AND status = 'pending'
    `) as unknown as Array<{ id: number | string }>;
		expect(pending.length).toBe(1);
	});

	test("reaper output count and DB state agree (no UPDATE-without-INSERT gap)", async () => {
		// Reproducer for lobu#862: the previous shape (bulk UPDATE RETURNING
		// followed by a per-row INSERT loop) could leave a row timed-out
		// with no retry queued if the process crashed mid-loop. The CTE
		// version writes both in the same statement, so the SQL engine
		// guarantees they land together or not at all.
		//
		// Seed three stale sync runs for three different feeds. After the
		// reap there must be exactly three timeouts AND three retries —
		// observable atomicity from the caller's perspective.
		const feedIds = [9001, 9002, 9003];
		for (const feedId of feedIds) {
			await seedFeed(feedId);
			await seedRun({
				status: "running",
				lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
				claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
				runType: "sync",
				feedId,
			});
		}

		const result = await reapStaleRuns();
		expect(result.reaped).toBe(3);
		expect(result.retriesCreated).toBe(3);

		const sql = getDb();
		const counts = (await sql`
      SELECT status, count(*)::int AS n FROM runs
      WHERE feed_id IN ${sql(feedIds)} AND run_type = 'sync'
      GROUP BY status
      ORDER BY status
    `) as unknown as Array<{ status: string; n: number }>;
		const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.n]));
		expect(byStatus.pending).toBe(3);
		expect(byStatus.timeout).toBe(3);
	});
});

async function feedHealth(feedId: number) {
	const [row] = (await getDb()`
    SELECT last_sync_status, last_error, consecutive_failures, status,
           next_run_at > current_timestamp + INTERVAL '50 seconds' AS backed_off,
           next_run_at IS NULL AS unscheduled
    FROM feeds WHERE id = ${feedId}
  `) as unknown as Array<{
		last_sync_status: string | null;
		last_error: string | null;
		consecutive_failures: number;
		status: string;
		backed_off: boolean | null;
		unscheduled: boolean;
	}>;
	return row;
}

/**
 * A sync that crossed the worker-claim boundary is charged to the feed's
 * failure budget. The one immediate retry is for an active feed that was
 * healthy — a worker crash or deploy — so a sync that keeps dying backs off
 * and eventually pauses instead of re-queueing itself every reaper interval.
 */
describe("reapStaleRuns — a lost claimed sync is charged to its feed", () => {
	async function seedScheduledFeed(feedId: number, consecutiveFailures: number) {
		await seedFeed(feedId);
		await getDb()`
      UPDATE feeds
      SET schedule = '*/5 * * * *',
          consecutive_failures = ${consecutiveFailures},
          next_run_at = current_timestamp + INTERVAL '10 seconds'
      WHERE id = ${feedId}
    `;
	}

	async function seedLostSync(
		feedId: number,
		status: "claimed" | "running" = "running",
	): Promise<number> {
		return seedRun({
			status,
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			runType: "sync",
			feedId,
		});
	}

	test("a stale claim with no heartbeat is charged", async () => {
		const feedId = 8180;
		await seedScheduledFeed(feedId, 0);
		await seedLostSync(feedId, "claimed");

		const result = await reapStaleRuns();

		expect(result.retriesCreated).toBe(1);
		expect(await feedHealth(feedId)).toMatchObject({
			last_error: "worker_heartbeat_lost",
			consecutive_failures: 1,
		});
	});

	test("a healthy feed is charged once and still gets its immediate retry", async () => {
		const feedId = 8181;
		await seedScheduledFeed(feedId, 0);
		await seedLostSync(feedId);

		const result = await reapStaleRuns();

		expect(result.retriesCreated).toBe(1);
		expect(await feedHealth(feedId)).toMatchObject({
			last_sync_status: "failed",
			last_error: "worker_heartbeat_lost",
			consecutive_failures: 1,
			status: "active",
			backed_off: true,
		});
	});

	test("a feed that was already failing backs off instead of retrying immediately", async () => {
		const feedId = 8282;
		await seedScheduledFeed(feedId, 2);
		await seedLostSync(feedId);

		const result = await reapStaleRuns();

		expect(result.retriesCreated).toBe(0);
		expect(await feedHealth(feedId)).toMatchObject({
			consecutive_failures: 3,
			status: "active",
			backed_off: true,
		});
		const pending = (await getDb()`
      SELECT id FROM runs
      WHERE feed_id = ${feedId} AND run_type = 'sync' AND status = 'pending'
    `) as unknown as Array<{ id: number }>;
		expect(pending).toHaveLength(0);
	});

	test("a paused feed is charged without being resurrected", async () => {
		const feedId = 8333;
		await seedScheduledFeed(feedId, 0);
		await seedLostSync(feedId);
		await getDb()`
      UPDATE feeds
      SET status = 'paused', next_run_at = NULL
      WHERE id = ${feedId}
    `;

		const result = await reapStaleRuns();

		expect(result.retriesCreated).toBe(0);
		expect(await feedHealth(feedId)).toMatchObject({
			consecutive_failures: 1,
			status: "paused",
			unscheduled: true,
		});
		const pending = (await getDb()`
      SELECT id FROM runs
      WHERE feed_id = ${feedId} AND run_type = 'sync' AND status = 'pending'
    `) as unknown as Array<{ id: number }>;
		expect(pending).toHaveLength(0);
	});

	test("the failure that crosses the threshold pauses the feed", async () => {
		process.env.FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES = "3";
		try {
			const feedId = 8383;
			await seedScheduledFeed(feedId, 2);
			await seedLostSync(feedId);

			const result = await reapStaleRuns();

			expect(result.retriesCreated).toBe(0);
			expect(await feedHealth(feedId)).toMatchObject({
				consecutive_failures: 3,
				status: "paused",
				unscheduled: true,
			});
		} finally {
			process.env.FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES = "20";
		}
	});

	test("a manual feed stays unscheduled", async () => {
		const feedId = 8484;
		await seedFeed(feedId);
		await seedLostSync(feedId);

		await reapStaleRuns();

		expect(await feedHealth(feedId)).toMatchObject({
			consecutive_failures: 1,
			last_sync_status: "failed",
			unscheduled: true,
		});
	});
});

/**
 * A dry run (`runs.dry_run`) executes the connector for real but the server
 * persists nothing. The reaper is the one path that can undo that AFTER the
 * run was created: it re-queues a stale sync as a fresh run, and that INSERT
 * does not carry `dry_run`. Without a guard, a dry run that lost its worker
 * would come back as a REAL sync and persist everything the operator asked to
 * only preview — silently, on a timer, with no one watching.
 *
 * The never-claimed path is a dispatch failure for both real and dry syncs, so
 * neither may stamp connector/source failure state. The dry-run control keeps
 * that invariant explicit while its stronger no-resurrection rule is tested.
 *
 * The non-dry controls for both live above ("a stale never-claimed sync is a
 * dispatch failure and preserves source health" and "a stale sync run gets
 * timed out AND a retry queued in one statement") — without them these tests
 * would pass against a reaper that had stopped working entirely.
 */
describe("reapStaleRuns — dry runs are reaped but never resurrected", () => {
	test("a stale claimed dry sync is timed out and NOT retried as a real sync", async () => {
		const feedId = 7171;
		await seedFeed(feedId);
		const dryId = await seedRun({
			status: "running",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			runType: "sync",
			feedId,
			dryRun: true,
		});

		const result = await reapStaleRuns();

		// Reaped — a dry run still has to be finalized, it is real working state.
		expect(result.reaped).toBe(1);
		expect(await statusOf(dryId)).toBe("timeout");
		// But never re-queued. This is THE assertion: a retry here would be a
		// persisting sync the operator never asked for.
		expect(result.retriesCreated).toBe(0);

		const sql = getDb();
		const requeued = (await sql`
      SELECT id, dry_run FROM runs
      WHERE feed_id = ${feedId} AND run_type = 'sync' AND status = 'pending'
    `) as unknown as Array<{ id: number | string; dry_run: boolean }>;
		expect(requeued).toHaveLength(0);
		// A preview is not the feed's sync: it never touches the failure budget.
		expect(await feedHealth(feedId)).toMatchObject({
			consecutive_failures: 0,
			last_sync_status: null,
		});
	});

	test("a stale never-claimed dry sync stamps no feed failure state", async () => {
		const feedId = 7272;
		await seedFeed(feedId);
		const sql = getDb();
		await sql`
      UPDATE feeds
      SET last_sync_status = 'success',
          next_run_at = current_timestamp + INTERVAL '1 hour'
      WHERE id = ${feedId}
    `;
		const [before] = (await sql`
      SELECT last_sync_status, last_error, consecutive_failures, next_run_at, status
      FROM feeds WHERE id = ${feedId}
    `) as unknown as Array<Record<string, unknown>>;

		const dryId = await seedRun({
			status: "pending",
			lastHeartbeatAgoSeconds: null,
			runType: "sync",
			feedId,
			createdAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
			dryRun: true,
		});

		const result = await reapStaleRuns();

		expect(result.reaped).toBe(1);
		expect(await statusOf(dryId)).toBe("timeout");

		// Feed row is byte-identical: no 'failed' stamp, no failure increment,
		// no backoff of next_run_at, no auto-pause.
		const [after] = (await sql`
      SELECT last_sync_status, last_error, consecutive_failures, next_run_at, status
      FROM feeds WHERE id = ${feedId}
    `) as unknown as Array<Record<string, unknown>>;
		expect(after).toEqual(before);
	});
});

describe("agent turn lane", () => {
	test("reaps a stale agent turn and leaves a heartbeating one running", async () => {
		// The isolate turn lane runs on the SAME worker with the same claim and
		// heartbeat contract, so it belongs to this sweep. Without it a crashed
		// fleet worker leaves the turn `running` for good.
		const stale = await seedRun({
			status: "running",
			runType: "agent_turn",
			lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 2,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
		});
		const live = await seedRun({
			status: "running",
			runType: "agent_turn",
			lastHeartbeatAgoSeconds: 1,
			claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
		});

		const result = await reapStaleRuns();

		expect(result.reaped).toBe(1);
		expect(await statusOf(stale)).toBe("timeout");
		expect(await statusOf(live)).toBe("running");
		// The retry arm is sync-only: a turn is never re-run behind the user's
		// back, it just ends.
		expect(result.retriesCreated).toBe(0);
	});
});
