/**
 * `min_cooldown_seconds` must actually debounce event-triggered Automations.
 *
 * The column has existed (NOT NULL DEFAULT 0) and been writable through the
 * MCP contract, `defineAutomation`, and `lobu apply` since it was added, and no
 * dispatch path ever read it. An operator who set it got no debounce at all.
 *
 * WHERE THE CHECK LIVES: at the chokepoint that already serializes an Automation
 * activation — the `pg_advisory_xact_lock` inside `createAutomationEventRun` —
 * NOT in `findMatchingAutomationActivations`. The lookup is an unlocked SELECT,
 * so two concurrent deliveries would both read "no recent activation" and both
 * fire. `debounces two concurrent deliveries` below is the regression test for
 * that; it fails against a cooldown evaluated during the match.
 *
 * WHY ONLY THE EVENT PATH: a schedule already spaces its own firings — cron IS
 * the operator's cadence control — so a cooldown there is redundant. Applying
 * this debounce in the event activation path to a scheduled firing would also
 * bypass the scheduler's `next_run_at` advancement and leave the cursor due.
 * Event activations have no cursor to strand: suppressing one simply means that
 * event does not fire this Automation.
 */

import { readAutomationRevisionForContext } from './revision-fixture';
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	findMatchingAutomationActivations,
	queueAutomationActivations,
} from "../../../automations/activation";
import {
	claimAutomationCooldown,
	claimAutomationCooldownStandalone,
	lockAutomationForActivation,
} from "../../../automations/cooldown";
import {
	MAX_COALESCED_AUTOMATION_EVENT_INPUTS,
} from "../../../automations/workspace-event-contract";
import type { DbClient } from "../../../db/client";
import type { Env } from "../../../index";
import { createAutomationEventRun } from "../../../runs/queue-service";
import { manageAutomations } from "../../../tools/admin/manage_automations";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestConnection,
	seedOwnerContext,
} from "../../setup/test-fixtures";

interface Fixture {
	organizationId: string;
	automationId: number;
	signal: {
		connector_key: string;
		connection_id: string;
		event_type: string;
		label: string;
		input_text: string;
	};
}

let counter = 0;

type OwnerContext = Awaited<ReturnType<typeof seedOwnerContext>>["ctx"];

interface Workspace {
	organizationId: string;
	agentId: string;
	connectionId: string;
	ctx: OwnerContext;
}

async function automationWithCooldown(
	cooldownSeconds: number,
	options?: { reuse?: Workspace; activeRun?: "queue" | "coalesce" },
): Promise<Fixture & { workspace: Workspace }> {
	const sql = getTestDb();
	const slug = `cooldown-${++counter}`;

	let workspace: Workspace;
	if (options?.reuse) {
		workspace = options.reuse;
	} else {
		const seeded = await seedOwnerContext();
		workspace = {
			organizationId: seeded.org.id,
			ctx: seeded.ctx,
			agentId: (
				await createTestAgent({
					organizationId: seeded.org.id,
					ownerUserId: seeded.user.id,
				})
			).agentId,
			connectionId: (
				await createTestConnection({
					organization_id: seeded.org.id,
					connector_key: "github",
					created_by: seeded.user.id,
				})
			).id,
		};
	}
	const { organizationId, agentId, connectionId, ctx } = workspace;

	const created = await manageAutomations(
		{
			action: "create",
			slug,
			name: `Cooldown ${slug}`,
			prompt: "Summarize changed pull requests.",
			managed_agent_id: agentId,
			min_cooldown_seconds: cooldownSeconds,
			triggers: [
				{
					kind: "event",
					connector_key: "github",
					connection_id: connectionId,
					event_types: ["pull_request.updated"],
					execution: "window",
					active_run: options?.activeRun ?? "coalesce",
					output: "silent",
				},
			],
		},
		{} as Env,
		ctx,
	);
	if (created.action !== "create" || !("automation_id" in created)) {
		throw new Error("Automation creation did not complete");
	}
	const automationId = Number(created.automation_id);

	// Guard the fixture itself: if the contract ever stops persisting the field,
	// every assertion below would pass vacuously against cooldown 0.
	const [row] = await sql`
    SELECT min_cooldown_seconds FROM automations WHERE id = ${automationId}
  `;
	expect(Number(row.min_cooldown_seconds)).toBe(cooldownSeconds);

	return {
		organizationId,
		automationId,
		workspace,
		signal: {
			connector_key: "github",
			connection_id: connectionId,
			event_type: "pull_request.updated",
			label: "PR changed",
			input_text: "A pull request changed.",
		},
	};
}

async function priorActivation(
	fixture: Fixture,
	secondsAgo: number,
): Promise<void> {
	const sql = getTestDb();
	await sql`
    UPDATE automations
    SET last_event_activation_at = now() - make_interval(secs => ${secondsAgo})
    WHERE id = ${fixture.automationId}
  `;
}

async function match(fixture: Fixture) {
	const found = await findMatchingAutomationActivations(fixture.organizationId, {
		...fixture.signal,
		delivery_id: `event:cooldown:${++counter}`,
	});
	const activation = found.find(
		(candidate) => candidate.automationId === fixture.automationId,
	);
	if (!activation) throw new Error("Automation did not match its own signal");
	return activation;
}

async function activate(fixture: Fixture): Promise<"queued" | "suppressed"> {
	const activation = await match(fixture);
	const results = await queueAutomationActivations({
		matches: [activation],
		signal: {
			...fixture.signal,
			delivery_id: `event:cooldown:${++counter}`,
		},
	});
	return results.length > 0 ? "queued" : "suppressed";
}

async function automationRunCount(fixture: Fixture): Promise<number> {
	const sql = getTestDb();
	const [row] = await sql`
    SELECT count(*)::int AS n
    FROM runs
    WHERE automation_id = ${fixture.automationId} AND run_type = 'automation'
  `;
	return Number(row.n);
}

describe("min_cooldown_seconds debounces event-triggered Automations", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("suppresses an activation inside the cooldown window", async () => {
		const fixture = await automationWithCooldown(1800);
		await priorActivation(fixture, 60);

		expect(await activate(fixture)).toBe("suppressed");
		expect(await automationRunCount(fixture)).toBe(0);
	});

	it("allows an activation once the cooldown has elapsed", async () => {
		const fixture = await automationWithCooldown(1800);
		await priorActivation(fixture, 7200);

		expect(await activate(fixture)).toBe("queued");
		expect(await automationRunCount(fixture)).toBe(1);
	});

	it("allows the first activation when the Automation has never run", async () => {
		const fixture = await automationWithCooldown(1800);

		expect(await activate(fixture)).toBe("queued");
	});

	it("does not debounce at all when the cooldown is 0 (the default)", async () => {
		const fixture = await automationWithCooldown(0);
		await priorActivation(fixture, 1);

		expect(await activate(fixture)).toBe("queued");
	});

	it("consumes the window on the activation itself, not on run completion", async () => {
		// A burst that starts a run and immediately re-fires must be debounced by
		// the run it just started. `automations.last_fired_at` is stamped when a run
		// reaches a TERMINAL state, so a cooldown built on it would only take
		// effect after the first run happened to finish — hence the dedicated
		// dispatch-time cursor. `active_run: "queue"` so the second signal is
		// judged by the cooldown rather than folded into the pending run.
		const fixture = await automationWithCooldown(1800, { activeRun: "queue" });

		expect(await activate(fixture)).toBe("queued");
		expect(await activate(fixture)).toBe("suppressed");
		expect(await automationRunCount(fixture)).toBe(1);
	});

	it("debounces two concurrent deliveries, not just sequential ones", async () => {
		// With the check in `findMatchingAutomationActivations` both deliveries pass
		// the unlocked SELECT before either run exists, and two runs are created.
		// The claim only holds when it happens under the advisory lock that
		// already serializes `createAutomationEventRun`.
		// `active_run: "queue"`, not the fixture default: a coalescing trigger
		// folds the second signal into the pending run and correctly never
		// reaches the cooldown, which would mask the race this test exists for.
		const fixture = await automationWithCooldown(1800, { activeRun: "queue" });
		const activation = await match(fixture);

		const settled = await Promise.all(
			[1, 2].map((n) =>
				createAutomationEventRun({
					organizationId: fixture.organizationId,
					automationId: fixture.automationId,
					agentId: fixture.workspace.agentId,
					trigger: activation.trigger,
					signal: {
						...fixture.signal,
						// Distinct delivery ids: this must be debounced by the cooldown,
						// not incidentally by the delivery-id dedupe.
						delivery_id: `event:concurrent:${fixture.automationId}:${n}`,
					},
				}),
			),
		);

		const dispositions = settled.map((result) => result.disposition).sort();
		expect(dispositions).toEqual(["cooldown", "queued"]);
		expect(await automationRunCount(fixture)).toBe(1);
	});

	it("scopes the cooldown to one Automation, not the whole connection", async () => {
		const cooling = await automationWithCooldown(1800);
		// The sibling must ALSO have a non-zero cooldown, or it short-circuits on
		// `min_cooldown_seconds = 0` and never reaches the scoping predicate —
		// which would let a cooldown that ignores the Automation id pass unnoticed
		// (caught by mutation testing: a zero-cooldown sibling misses it).
		const sibling = await automationWithCooldown(1800, {
			reuse: cooling.workspace,
		});
		await priorActivation(cooling, 60);

		expect(await activate(cooling)).toBe("suppressed");
		expect(await activate(sibling)).toBe("queued");
	});

	it("does not consume the window when a signal coalesces into a pending run", async () => {
		// Coalescing folds a signal into a run that is already pending — the
		// Automation does not start again, so it must not count against the
		// operator's cooldown or a busy trigger would starve itself.
		const fixture = await automationWithCooldown(1800);
		const activation = await match(fixture);
		const queue = (deliveryId: string) =>
			createAutomationEventRun({
				organizationId: fixture.organizationId,
				automationId: fixture.automationId,
				agentId: fixture.workspace.agentId,
				trigger: activation.trigger,
				signal: { ...fixture.signal, delivery_id: deliveryId },
			});

		expect((await queue("event:coalesce:1")).disposition).toBe("queued");
		const [claimed] = await getTestDb()`
			SELECT last_event_activation_at
			FROM automations
			WHERE id = ${fixture.automationId}
		`;
		expect((await queue("event:coalesce:2")).disposition).toBe("coalesced");
		expect(await automationRunCount(fixture)).toBe(1);
		const [afterCoalesce] = await getTestDb()`
			SELECT last_event_activation_at
			FROM automations
			WHERE id = ${fixture.automationId}
		`;
		expect(afterCoalesce.last_event_activation_at).toEqual(
			claimed.last_event_activation_at,
		);
	});

	it("bounds a coalesced run and rolls overflow into another durable run", async () => {
		const fixture = await automationWithCooldown(0);
		const activation = await match(fixture);
		for (let index = 0; index <= MAX_COALESCED_AUTOMATION_EVENT_INPUTS; index++) {
			await createAutomationEventRun({
				organizationId: fixture.organizationId,
				automationId: fixture.automationId,
				agentId: fixture.workspace.agentId,
				trigger: activation.trigger,
				signal: {
					...fixture.signal,
					delivery_id: `event:bounded-coalesce:${index}`,
				},
			});
		}

		const rows = await getTestDb()<{
			delivery_count: number;
		}>`
			SELECT jsonb_array_length(approved_input->'delivery_ids') AS delivery_count
			FROM runs
			WHERE automation_id = ${fixture.automationId}
			  AND run_type = 'automation'
			ORDER BY id
		`;
		expect(rows.map((row) => Number(row.delivery_count))).toEqual([
			MAX_COALESCED_AUTOMATION_EVENT_INPUTS,
			1,
		]);
	});

	it("coalesces into a legacy pending run whose delivery_ids is JSON null", async () => {
		const fixture = await automationWithCooldown(0);
		const activation = await match(fixture);
		const queue = (deliveryId: string) =>
			createAutomationEventRun({
				organizationId: fixture.organizationId,
				automationId: fixture.automationId,
				agentId: fixture.workspace.agentId,
				trigger: activation.trigger,
				signal: { ...fixture.signal, delivery_id: deliveryId },
			});

		expect((await queue("event:legacy-null:1")).disposition).toBe("queued");
		await getTestDb()`
			UPDATE runs
			SET approved_input = jsonb_set(
				approved_input,
				'{delivery_ids}',
				'null'::jsonb
			)
			WHERE automation_id = ${fixture.automationId}
			  AND run_type = 'automation'
		`;

		expect((await queue("event:legacy-null:2")).disposition).toBe("coalesced");
		const [row] = await getTestDb()<{
			delivery_count: number;
		}>`
			SELECT jsonb_array_length(approved_input->'delivery_ids') AS delivery_count
			FROM runs
			WHERE automation_id = ${fixture.automationId}
			  AND run_type = 'automation'
		`;
		expect(Number(row.delivery_count)).toBe(2);
	});

	it("splits coalesced workspace roots before causal payload exceeds its bound", async () => {
		const fixture = await automationWithCooldown(0);
		const trigger = {
			kind: "event" as const,
			source: "workspace" as const,
			event_types: ["risk_detected"],
			execution: "window" as const,
			active_run: "coalesce" as const,
		};
		const queue = (deliveryId: string, rootEventIds: number[]) =>
			createAutomationEventRun({
				organizationId: fixture.organizationId,
				automationId: fixture.automationId,
				agentId: fixture.workspace.agentId,
				trigger,
				signal: {
					kind: "event",
					source: "workspace",
					event_id: rootEventIds[0] ?? 1,
					event_type: "risk_detected",
					delivery_id: deliveryId,
					occurred_at: "2026-08-11T00:00:00.000Z",
					root_event_ids: rootEventIds,
					causal_automation_ids: [9000],
					depth: 2,
				},
			});

		expect(
			(
				await queue(
					"workspace-event:bounded-roots:1",
					Array.from(
						{ length: MAX_COALESCED_AUTOMATION_EVENT_INPUTS },
						(_, index) => index + 1,
					),
				)
			).disposition,
		).toBe("queued");
		expect(
			(await queue("workspace-event:bounded-roots:2", [1000])).disposition,
		).toBe("queued");
		expect(
			(await queue("workspace-event:bounded-roots:3", [1001])).disposition,
		).toBe("coalesced");

		const rows = await getTestDb()<{
			delivery_count: number;
			root_count: number;
		}>`
			SELECT
				jsonb_array_length(approved_input->'delivery_ids') AS delivery_count,
				jsonb_array_length(
					approved_input->'trigger_signals'->0->'root_event_ids'
				) AS root_count
			FROM runs
			WHERE automation_id = ${fixture.automationId}
			  AND run_type = 'automation'
			ORDER BY id
		`;
		expect(
			rows.map((row) => ({
				deliveryCount: Number(row.delivery_count),
				rootCount: Number(row.root_count),
			})),
		).toEqual([
			{
				deliveryCount: 1,
				rootCount: MAX_COALESCED_AUTOMATION_EVENT_INPUTS,
			},
			{ deliveryCount: 2, rootCount: 1 },
		]);
	});

	it("measures the cooldown at claim time, not transaction start", async () => {
		const fixture = await automationWithCooldown(1);
		const sql = getTestDb();

		await sql.begin(async (tx) => {
			await lockAutomationForActivation(tx, fixture.automationId);
			await tx`
				UPDATE automations
				SET last_event_activation_at = now()
				WHERE id = ${fixture.automationId}
			`;
			await tx`SELECT pg_sleep(1.1)`;
			expect(await claimAutomationCooldown(tx, fixture.automationId)).toBe(true);
		});
	});

	describe("the cursor the reply_to_source path shares", () => {
		it("is consumed by a standalone claim, as the chat bridge makes it", async () => {
			// Reply targets are handed to the chat transport and never write a
			// `automation` run row, so a cooldown expressed over `runs` is a silent
			// no-op for them. Both paths claim `last_event_activation_at`, so the
			// operator gets one predicate regardless of an Automation's output mode.
			const fixture = await automationWithCooldown(1800);

			expect(await claimAutomationCooldownStandalone(fixture.automationId)).toBe(
				true,
			);
			expect(await claimAutomationCooldownStandalone(fixture.automationId)).toBe(
				false,
			);
		});

		it("does not consume the cursor at the 0 default", async () => {
			const fixture = await automationWithCooldown(0);
			const activation = await match(fixture);

			expect(activation.minCooldownSeconds).toBe(0);
			expect(await claimAutomationCooldownStandalone(fixture.automationId)).toBe(
				true,
			);
			expect(await claimAutomationCooldownStandalone(fixture.automationId)).toBe(
				true,
			);
			const [row] = await getTestDb()`
				SELECT last_event_activation_at
				FROM automations
				WHERE id = ${fixture.automationId}
			`;
			expect(row.last_event_activation_at).toBeNull();
		});

		it("clears a zero-cooldown activation stamp when cooldown is enabled", async () => {
			const fixture = await automationWithCooldown(0);
			await priorActivation(fixture, 60);

			await manageAutomations(
				{
					expected_revision: await readAutomationRevisionForContext(fixture.workspace.ctx, String(fixture.automationId)),
					action: "update",
					automation_id: String(fixture.automationId),
					min_cooldown_seconds: 300,
				},
				{} as Env,
				fixture.workspace.ctx,
			);

			const [row] = await getTestDb()`
				SELECT min_cooldown_seconds, last_event_activation_at
				FROM automations
				WHERE id = ${fixture.automationId}
			`;
			expect(Number(row.min_cooldown_seconds)).toBe(300);
			expect(row.last_event_activation_at).toBeNull();
		});

		it("preserves the activation cursor across positive cooldown changes", async () => {
			const fixture = await automationWithCooldown(300);
			await priorActivation(fixture, 60);
			const [before] = await getTestDb()`
				SELECT last_event_activation_at
				FROM automations
				WHERE id = ${fixture.automationId}
			`;

			await manageAutomations(
				{
					expected_revision: await readAutomationRevisionForContext(fixture.workspace.ctx, String(fixture.automationId)),
					action: "update",
					automation_id: String(fixture.automationId),
					min_cooldown_seconds: 600,
				},
				{} as Env,
				fixture.workspace.ctx,
			);

			const [after] = await getTestDb()`
				SELECT min_cooldown_seconds, last_event_activation_at
				FROM automations
				WHERE id = ${fixture.automationId}
			`;
			expect(Number(after.min_cooldown_seconds)).toBe(600);
			expect(after.last_event_activation_at).toEqual(
				before.last_event_activation_at,
			);
		});

		it("suppresses a reply when a background activation just consumed the window", async () => {
			// One Automation, one window: a background firing must debounce a reply
			// firing and vice versa, or a mixed-trigger Automation would get two
			// independent budgets.
			const fixture = await automationWithCooldown(1800);

			expect(await activate(fixture)).toBe("queued");
			expect(await claimAutomationCooldownStandalone(fixture.automationId)).toBe(
				false,
			);
		});
	});

	it("suppresses an activation for an Automation that no longer exists", async () => {
		const fixture = await automationWithCooldown(1800);
		const sql = getTestDb();
		await sql`DELETE FROM automations WHERE id = ${fixture.automationId}`;

		expect(await claimAutomationCooldownStandalone(fixture.automationId)).toBe(
			false,
		);
	});

	it("propagates a cooldown claim failure instead of reporting suppression", async () => {
		const error = new Error("cooldown database unavailable");
		const unavailableDb = {
			begin: async () => {
				throw error;
			},
		} as unknown as DbClient;

		await expect(
			claimAutomationCooldownStandalone(123, unavailableDb),
		).rejects.toBe(error);
	});
});
