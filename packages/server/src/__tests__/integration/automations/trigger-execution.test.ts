import { readAutomationRevision } from './revision-fixture';
import type {
	AutomationClaimNextWindowResult,
	AutomationTriggerResult,
} from "@lobu/core/contracts/tools/manage-automations";
import { beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "../../../db/client";
import { createAutomationRun } from "../../../runs/queue-service";
import { computePendingWindow } from "../../../utils/window-utils";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestEntity } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

describe("Automation trigger execution contract", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	async function createExternallyClaimedAutomation(
		lane: "managed_agent" | "device_worker",
	) {
		const sql = getTestDb();
		const workspace = await TestWorkspace.create({
			name: `${lane} External Lease Org`,
		});
		const entity = await createTestEntity({
			name: `${lane} External Lease Entity`,
			organization_id: workspace.org.id,
			created_by: workspace.users.owner.id,
		});
		let executor:
			| { managed_agent_id: string }
			| {
					managed_agent_id: null;
					device_worker_id: string;
					agent_kind: "claude-code";
				};
		if (lane === "managed_agent") {
			const agent = await createTestAgent({
				organizationId: workspace.org.id,
				ownerUserId: workspace.users.owner.id,
				agentId: "externally-leased-trigger-agent",
			});
			executor = { managed_agent_id: agent.agentId };
		} else {
			const [device] = await sql<{ id: string }>`
        INSERT INTO device_workers (
          user_id, worker_id, platform, capabilities, label, organization_id
        ) VALUES (
          ${workspace.users.owner.id}, 'externally-leased-trigger-device', 'macos',
          ${sql.json({})}, 'Externally Leased Device', ${workspace.org.id}
        )
        RETURNING id::text AS id
      `;
			executor = {
				managed_agent_id: null,
				device_worker_id: device.id,
				agent_kind: "claude-code",
			};
		}
		const automation = (await workspace.owner.automations.create({
			entity_id: entity.id,
			slug: `${lane}-external-lease`,
			name: `${lane} External Lease`,
			prompt: "Summarize the completed window.",
			triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
			...executor,
		})) as { automation_id: string };
		const windowStart = new Date();
		windowStart.setUTCHours(0, 0, 0, 0);
		windowStart.setUTCDate(windowStart.getUTCDate() - 2);
		await sql`
      UPDATE automations
      SET next_window_start = ${windowStart.toISOString()}::timestamptz
      WHERE id = ${Number(automation.automation_id)}
    `;
		const claim = (await workspace.owner.automations.claimNextWindow({
			automation_id: automation.automation_id,
		})) as AutomationClaimNextWindowResult;
		return { sql, workspace, automation, claim };
	}

	it("directs an agentless manual run through the external completion protocol", async () => {
		const workspace = await TestWorkspace.create({
			name: "External Trigger Org",
		});
		const entity = await createTestEntity({
			name: "External Trigger Entity",
			organization_id: workspace.org.id,
			created_by: workspace.users.owner.id,
		});
		const automation = (await workspace.owner.automations.create({
			entity_id: entity.id,
			slug: "external-trigger-contract",
			name: "External Trigger Contract",
			prompt: "Summarize the current window.",
			managed_agent_id: null,
		})) as { automation_id: string };

		const triggered = (await workspace.owner.automations.trigger({
			automation_id: automation.automation_id,
		})) as AutomationTriggerResult;

		expect(triggered).toEqual({
			action: "trigger",
			automation_id: automation.automation_id,
			run_id: triggered.run_id,
			status: "pending",
			created: true,
			execution: {
				lane: "external_client",
				owner: "caller",
				next_action: {
					kind: "complete_window",
					read: {
						method: "knowledge.read",
						input: {
							automation_id: Number(automation.automation_id),
							run_id: triggered.run_id,
						},
					},
					// biome-ignore lint/suspicious/noThenProperty: Exact public protocol assertion.
					then: "automations.completeWindow",
				},
			},
		});

		const retargetAgent = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId: workspace.users.owner.id,
			agentId: "external-retarget-agent",
		});
		await workspace.owner.automations.update({
			expected_revision: await readAutomationRevision(workspace.owner, automation.automation_id),
			automation_id: automation.automation_id,
			managed_agent_id: retargetAgent.agentId,
		});
		const retriggered = (await workspace.owner.automations.trigger({
			automation_id: automation.automation_id,
		})) as AutomationTriggerResult;
		expect(retriggered.run_id).toBe(triggered.run_id);
		expect(retriggered.created).toBe(false);
		expect(retriggered.execution).toEqual(triggered.execution);
	});

	it("coalesces concurrent external triggers without poisoning either transaction", async () => {
		const sql = getTestDb();
		const workspace = await TestWorkspace.create({
			name: "Concurrent Trigger Org",
		});
		const entity = await createTestEntity({
			name: "Concurrent Trigger Entity",
			organization_id: workspace.org.id,
			created_by: workspace.users.owner.id,
		});
		const automation = (await workspace.owner.automations.create({
			entity_id: entity.id,
			slug: "concurrent-trigger-contract",
			name: "Concurrent Trigger Contract",
			prompt: "Summarize the current window.",
			managed_agent_id: null,
		})) as { automation_id: string };

		const results = (await Promise.all([
			workspace.owner.automations.trigger({
				automation_id: automation.automation_id,
			}),
			workspace.owner.automations.trigger({
				automation_id: automation.automation_id,
			}),
		])) as AutomationTriggerResult[];

		expect(results.map((result) => result.created).sort()).toEqual([false, true]);
		expect(new Set(results.map((result) => result.run_id)).size).toBe(1);
		expect(results[0].execution).toEqual(results[1].execution);
		expect(results[0].execution.lane).toBe("external_client");
		const runs = await sql`
      SELECT id FROM runs WHERE automation_id = ${Number(automation.automation_id)}
    `;
		expect(runs).toHaveLength(1);
	});

	it("keeps the persisted device lane when the Automation is retargeted", async () => {
		const sql = getTestDb();
		const workspace = await TestWorkspace.create({
			name: "Device Trigger Org",
		});
		const entity = await createTestEntity({
			name: "Device Trigger Entity",
			organization_id: workspace.org.id,
			created_by: workspace.users.owner.id,
		});
		const [device] = await sql<{ id: string }>`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id
      ) VALUES (
        ${workspace.users.owner.id}, 'trigger-device-a', 'macos',
        ${sql.json({})}, 'Device A', ${workspace.org.id}
      )
      RETURNING id::text AS id
    `;
		const retargetAgent = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId: workspace.users.owner.id,
			agentId: "device-retarget-agent",
		});
		const automation = (await workspace.owner.automations.create({
			entity_id: entity.id,
			slug: "device-trigger-contract",
			name: "Device Trigger Contract",
			prompt: "Summarize the current window.",
			managed_agent_id: null,
			device_worker_id: device.id,
			agent_kind: "claude-code",
		})) as { automation_id: string };

		const first = (await workspace.owner.automations.trigger({
			automation_id: automation.automation_id,
		})) as AutomationTriggerResult;
		expect(first.execution).toEqual({
			lane: "device_worker",
			owner: "device",
			device_worker_id: device.id,
			agent_kind: "claude-code",
			next_action: { kind: "handled_elsewhere" },
		});
		expect(first.created).toBe(true);

		// Persisted dual-id snapshots still exist on the claim-next-window path.
		// Device-first resolution is authoritative for those rows.
		await sql`
      UPDATE runs
      SET approved_input = approved_input
        || jsonb_build_object('agent_id', ${retargetAgent.agentId}::text)
      WHERE id = ${first.run_id}
    `;
		await workspace.owner.automations.update({
			expected_revision: await readAutomationRevision(workspace.owner, automation.automation_id),
			automation_id: automation.automation_id,
			managed_agent_id: retargetAgent.agentId,
			device_worker_id: null,
			agent_kind: null,
		});
		await sql`
      UPDATE runs
      SET status = 'running', claimed_by = 'trigger-device-a', claimed_at = NOW()
      WHERE id = ${first.run_id}
    `;
		const retriggered = (await workspace.owner.automations.trigger({
			automation_id: automation.automation_id,
		})) as AutomationTriggerResult;

		expect(retriggered).toEqual({
			action: "trigger",
			automation_id: automation.automation_id,
			run_id: first.run_id,
			status: "running",
			created: false,
			execution: {
				lane: "device_worker",
				owner: "device",
				device_worker_id: device.id,
				agent_kind: "claude-code",
				next_action: { kind: "handled_elsewhere" },
			},
		});
	});

	it("keeps a native managed-agent claim handled elsewhere after retargeting", async () => {
		const sql = getTestDb();
		const workspace = await TestWorkspace.create({
			name: "Managed Trigger Org",
		});
		const entity = await createTestEntity({
			name: "Managed Trigger Entity",
			organization_id: workspace.org.id,
			created_by: workspace.users.owner.id,
		});
		const originalAgent = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId: workspace.users.owner.id,
			agentId: "trigger-original-agent",
		});
		const automation = (await workspace.owner.automations.create({
			entity_id: entity.id,
			slug: "managed-trigger-contract",
			name: "Managed Trigger Contract",
			prompt: "Summarize the current window.",
			managed_agent_id: originalAgent.agentId,
		})) as { automation_id: string };
		const pending = await computePendingWindow(
			sql as unknown as DbClient,
			Number(automation.automation_id),
		);
		const queued = await createAutomationRun({
			organizationId: workspace.org.id,
			automationId: Number(automation.automation_id),
			agentId: originalAgent.agentId,
			windowStart: pending.windowStart.toISOString(),
			windowEnd: pending.windowEnd.toISOString(),
			dispatchSource: "manual",
		});
		await sql`
      UPDATE runs
      SET status = 'running', claimed_by = 'lobu-dispatcher', claimed_at = NOW()
      WHERE id = ${queued.runId}
    `;
		await workspace.owner.automations.update({
			expected_revision: await readAutomationRevision(workspace.owner, automation.automation_id),
			automation_id: automation.automation_id,
			managed_agent_id: null,
		});

		const retriggered = (await workspace.owner.automations.trigger({
			automation_id: automation.automation_id,
		})) as AutomationTriggerResult;
		expect(retriggered).toEqual({
			action: "trigger",
			automation_id: automation.automation_id,
			run_id: queued.runId,
			status: "running",
			created: false,
			execution: {
				lane: "managed_agent",
				owner: "lobu",
				managed_agent_id: originalAgent.agentId,
				next_action: { kind: "handled_elsewhere" },
			},
		});
		const runs = await sql<{ status: string; approved_input: Record<string, unknown> }>`
      SELECT status, approved_input
      FROM runs
      WHERE automation_id = ${Number(automation.automation_id)}
    `;
		expect(runs).toHaveLength(1);
		expect(runs[0].status).toBe("running");
		expect(runs[0].approved_input.agent_id).toBe(originalAgent.agentId);
	});

	it.each(["managed_agent", "device_worker"] as const)(
		"uses the durable external claimant for a claimed %s snapshot",
		async (lane) => {
			const { sql, workspace, automation, claim } =
				await createExternallyClaimedAutomation(lane);
			const [before] = await sql<{
				status: string;
				claimed_by: string;
				expires_at: string;
			}>`
        SELECT status, claimed_by, expires_at::text
        FROM runs
        WHERE id = ${claim.run_id}
      `;

			const sameCaller = (await workspace.owner.automations.trigger({
				automation_id: automation.automation_id,
			})) as AutomationTriggerResult;
			expect(sameCaller).toEqual({
				action: "trigger",
				automation_id: automation.automation_id,
				run_id: claim.run_id,
				status: "running",
				created: false,
				execution: {
					lane: "external_client",
					owner: "caller",
					next_action: {
						kind: "resume_claim",
						method: "automations.claimNextWindow",
						input: {
							automation_id: automation.automation_id,
							run_id: claim.run_id,
						},
					},
				},
			});

			const otherCaller = (await workspace.admin.automations.trigger({
				automation_id: automation.automation_id,
			})) as AutomationTriggerResult;
			expect(otherCaller).toEqual({
				action: "trigger",
				automation_id: automation.automation_id,
				run_id: claim.run_id,
				status: "running",
				created: false,
				execution: {
					lane: "external_client",
					owner: "another_caller",
					next_action: { kind: "handled_elsewhere" },
				},
			});

			const [after] = await sql<{
				status: string;
				claimed_by: string;
				expires_at: string;
			}>`
        SELECT status, claimed_by, expires_at::text
        FROM runs
        WHERE id = ${claim.run_id}
      `;
			expect(after).toEqual(before);
		},
	);

	it("expires an external lease before retriggering fresh work", async () => {
		const { sql, workspace, automation, claim } =
			await createExternallyClaimedAutomation("device_worker");
		await sql`
      UPDATE runs
      SET expires_at = NOW() - INTERVAL '1 second'
      WHERE id = ${claim.run_id}
    `;

		const retriggered = (await workspace.owner.automations.trigger({
			automation_id: automation.automation_id,
		})) as AutomationTriggerResult;

		expect(retriggered.run_id).not.toBe(claim.run_id);
		expect(retriggered.created).toBe(true);
		expect(retriggered.execution.lane).toBe("device_worker");
		const [expired] = await sql<{ status: string; error_message: string | null }>`
      SELECT status, error_message
      FROM runs
      WHERE id = ${claim.run_id}
    `;
		expect(expired).toEqual({
			status: "timeout",
			error_message: "External Automation window lease expired",
		});
		await expect(
			workspace.owner.automations.claimNextWindow({
				automation_id: automation.automation_id,
				run_id: claim.run_id,
			}),
		).rejects.toThrow(/does not own an active lease/);
	});

	it.each(["unrecognized", "malformed_external"] as const)(
		"fails closed for an %s claimed execution",
		async (claimState) => {
			const { sql, workspace, automation, claim } =
				await createExternallyClaimedAutomation("managed_agent");
			if (claimState === "unrecognized") {
				await sql`
          UPDATE runs
          SET claimed_by = 'unrecognized-trigger-claim', expires_at = NULL
          WHERE id = ${claim.run_id}
        `;
			} else {
				await sql`
          UPDATE runs
          SET claimed_by = 'external:{"user_id":"partial"}',
              expires_at = NOW() + INTERVAL '5 minutes'
          WHERE id = ${claim.run_id}
        `;
			}

			await expect(
				workspace.owner.automations.trigger({
					automation_id: automation.automation_id,
				}),
			).rejects.toThrow(/no recognized active claimant/);
			const [after] = await sql<{ status: string; claimed_by: string }>`
        SELECT status, claimed_by
        FROM runs
        WHERE id = ${claim.run_id}
      `;
			expect(after.status).toBe("running");
			if (claimState === "unrecognized") {
				expect(after.claimed_by).toBe("unrecognized-trigger-claim");
			} else {
				expect(after.claimed_by).toBe('external:{"user_id":"partial"}');
			}
		},
	);

	it("preserves the managed-agent gateway preflight without creating a failed run", async () => {
		const sql = getTestDb();
		const workspace = await TestWorkspace.create({
			name: "Managed Preflight Org",
		});
		const entity = await createTestEntity({
			name: "Managed Preflight Entity",
			organization_id: workspace.org.id,
			created_by: workspace.users.owner.id,
		});
		const agent = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId: workspace.users.owner.id,
			agentId: "trigger-preflight-agent",
		});
		const automation = (await workspace.owner.automations.create({
			entity_id: entity.id,
			slug: "managed-trigger-preflight",
			name: "Managed Trigger Preflight",
			prompt: "Summarize the current window.",
			managed_agent_id: agent.agentId,
		})) as { automation_id: string };

		await expect(
			workspace.owner.automations.trigger({
				automation_id: automation.automation_id,
			}),
		).rejects.toThrow(/Embedded Lobu is not available/);
		const runs = await sql`
      SELECT id FROM runs WHERE automation_id = ${Number(automation.automation_id)}
    `;
		expect(runs).toHaveLength(0);
	});
});
