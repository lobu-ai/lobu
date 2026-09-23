/**
 * Integration test for the notification → bot-connection delivery path.
 *
 * Exercises `resolveBotDeliveryTargets` against a real DB: it JOINs the org's
 * active chat connections to their Automation subscriptions and returns the channel(s)
 * each notification should post to. This is the path that was a silent no-op
 * after #846 removed the HTTP endpoints the old implementation called.
 */

import { Actions, Button, Card } from "chat";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	createNotificationForUsers,
	resolveBotDeliveryTargets,
	resolveNotificationDeliveryPlan,
} from "../../../notifications/service";
import { notify } from "../../../tools/admin/notify";
import type { ToolContext } from "../../../tools/registry";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAutomationSubscription } from "../../setup/automation-subscriptions";
import {
	addUserToOrganization,
  createTestAgent,
  createTestOrganization,
	createTestUser,
  insertChatConnectionRow,
} from "../../setup/test-fixtures";

async function seedSlackConnection(opts: {
  organizationId: string;
  agentId: string;
  connectionId: string;
	status?: "active" | "stopped" | "error" | "paused";
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await insertChatConnectionRow({
    id: opts.connectionId,
    organizationId: opts.organizationId,
    agentId: opts.agentId,
		platform: "slack",
		status: opts.status ?? "active",
    settings: opts.settings ?? {},
    metadata: opts.metadata ?? {},
  });
}

async function seedBinding(opts: {
  organizationId: string;
  agentId: string;
	connectionId: string;
  channelId: string;
  teamId?: string;
}): Promise<void> {
	const configuredBy = await createTestUser();
	await addUserToOrganization(configuredBy.id, opts.organizationId, "owner");
  await createTestAutomationSubscription({
    organizationId: opts.organizationId,
    agentId: opts.agentId,
    connectionSlug: opts.connectionId.startsWith("slackinst-")
      ? opts.connectionId
      : `agentconn-${opts.connectionId}`,
    platform: "slack",
    channelId: opts.channelId,
    teamId: opts.teamId ?? "T_TEST",
		configuredBy: configuredBy.id,
  });
}

describe("resolveBotDeliveryTargets", () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterAll(async () => {
    await cleanupTestDatabase();
  });

	it("resolves an active connection to its bound channel", async () => {
    const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "crm",
		});
    await seedSlackConnection({
      organizationId: org.id,
      agentId: agent.agentId,
			connectionId: "conn-1",
    });
    await seedBinding({
      organizationId: org.id,
      agentId: agent.agentId,
			connectionId: "conn-1",
			channelId: "slack:C0LEADS",
    });

    const targets = await resolveBotDeliveryTargets(org.id);

    expect(targets).toEqual([
			{
				connectionId: "conn-1",
				platform: "slack",
				channelKey: "slack:C0LEADS",
				teamId: "T_TEST",
			},
    ]);
  });

	it("returns one target when multiple Automations share a physical channel", async () => {
		const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "crm",
		});
		await seedSlackConnection({
			organizationId: org.id,
			agentId: agent.agentId,
			connectionId: "conn-shared",
		});
		for (let i = 0; i < 2; i++) {
			await seedBinding({
				organizationId: org.id,
				agentId: agent.agentId,
				connectionId: "conn-shared",
				channelId: "slack:C-SHARED",
			});
		}

		expect(await resolveBotDeliveryTargets(org.id)).toEqual([
			{
				connectionId: "conn-shared",
				platform: "slack",
				channelKey: "slack:C-SHARED",
				teamId: "T_TEST",
			},
		]);
	});

	it("deduplicates a retried notification by idempotency key", async () => {
		const org = await createTestOrganization();
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const params = {
			organizationId: org.id,
			type: "agent_message" as const,
			title: "Social signal",
			body: "A retry-safe Automation notification.",
			resourceUrl: `/${org.slug}/memory?content_ids=42`,
			idempotencyKey: "automation:71:run:9001:notification",
		};

		await Promise.all(
			Array.from({ length: 6 }, () =>
				createNotificationForUsers([user.id], params as never),
			),
		);

		const sql = getTestDb();
		const [events] = await sql`
			SELECT count(*)::int AS n
			FROM events
			WHERE organization_id = ${org.id}
			  AND semantic_type = 'notification'
			  AND metadata->>'_lobu_idempotency_key' = ${params.idempotencyKey}
		`;
		const [targets] = await sql`
			SELECT count(*)::int AS n
			FROM notification_targets nt
			JOIN events e ON e.id = nt.event_id
			WHERE e.organization_id = ${org.id}
			  AND e.metadata->>'_lobu_idempotency_key' = ${params.idempotencyKey}
		`;
		expect(Number(events.n)).toBe(1);
		expect(Number(targets.n)).toBe(1);
	});

	it("reports zero notified recipients when notify deduplicates a retry", async () => {
		const org = await createTestOrganization();
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const ctx = {
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
			isAuthenticated: true,
			tokenType: "oauth",
			scopedToOrg: false,
			allowCrossOrg: true,
			scopes: ["mcp:admin"],
			sourceContext: null,
		} as ToolContext;
		const args = {
			action: "send" as const,
			title: "Social signal",
			body: "A retry-safe Automation notification.",
			idempotency_key: "automation:71:run:9002:notification",
		};

		const first = (await notify(args, {} as never, ctx)) as {
			notified_count: number;
			event_id: number | null;
			url: string | null;
		};
		expect(first.notified_count).toBe(1);
		expect(first.event_id).toBeGreaterThan(0);
		expect(first.url).toBe(
			`/${org.slug}/events?content_ids=${first.event_id}`,
		);

		// A deduplicated retry still resolves to the durable notification the
		// first send landed — the caller gets a usable id/url, not an empty
		// success it cannot act on.
		const retry = (await notify(args, {} as never, ctx)) as {
			notified_count: number;
			event_id: number | null;
			url: string | null;
		};
		expect(retry.notified_count).toBe(0);
		expect(retry.event_id).toBe(first.event_id);
		expect(retry.url).toBe(first.url);
	});

	it("persists the card and a stable origin_id on the notification event", async () => {
		const org = await createTestOrganization();
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const ctx = {
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
			isAuthenticated: true,
			tokenType: "oauth",
			scopedToOrg: false,
			allowCrossOrg: true,
			scopes: ["mcp:admin"],
			sourceContext: null,
		} as ToolContext;
		const card = Card({
			title: "Ship the pricing change?",
			children: [Actions([Button({ id: "ship", label: "Ship it" })])],
		});

		const sent = (await notify(
			{
				action: "send" as const,
				title: "Ship the pricing change?",
				card: card as unknown as Record<string, unknown>,
			},
			{} as never,
			ctx,
		)) as { event_id: number | null };
		expect(sent.event_id).toBeGreaterThan(0);

		const sql = getTestDb();
		const [row] = await sql`
			SELECT origin_id, metadata
			FROM events
			WHERE id = ${Number(sent.event_id)}
		`;
		// The card is the notification's rendered form. Dropping it before storage
		// left every surface but the live fan-out with no way to render it.
		expect((row.metadata as Record<string, unknown>).card).toEqual(card);
		// Minted, not NULL: notifications had no stable identity at all before.
		expect(String(row.origin_id ?? "")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it("returns nothing for a connection with no binding", async () => {
    const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "crm",
		});
    await seedSlackConnection({
      organizationId: org.id,
      agentId: agent.agentId,
			connectionId: "conn-1",
    });
    // No binding seeded.

    expect(await resolveBotDeliveryTargets(org.id)).toEqual([]);
  });

	it("omits inactive connections", async () => {
    const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "crm",
		});
    await seedSlackConnection({
      organizationId: org.id,
      agentId: agent.agentId,
			connectionId: "conn-1",
			status: "stopped",
    });
    await seedBinding({
      organizationId: org.id,
      agentId: agent.agentId,
			connectionId: "conn-1",
			channelId: "slack:C0LEADS",
    });

    expect(await resolveBotDeliveryTargets(org.id)).toEqual([]);
  });

	it("prefixes a bare channel id with the platform", async () => {
    const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "crm",
		});
    await seedSlackConnection({
      organizationId: org.id,
      agentId: agent.agentId,
			connectionId: "conn-1",
    });
    await seedBinding({
      organizationId: org.id,
      agentId: agent.agentId,
			connectionId: "conn-1",
			channelId: "C0BARE",
    });

    const targets = await resolveBotDeliveryTargets(org.id);
    expect(targets).toEqual([
			{
				connectionId: "conn-1",
				platform: "slack",
				channelKey: "slack:C0BARE",
				teamId: "T_TEST",
			},
    ]);
  });

	it("honors the connectionId filter", async () => {
    const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "crm",
		});
		for (const id of ["conn-1", "conn-2"]) {
			await seedSlackConnection({
				organizationId: org.id,
				agentId: agent.agentId,
				connectionId: id,
			});
    }
		await seedBinding({
			organizationId: org.id,
			agentId: agent.agentId,
			connectionId: "conn-2",
			channelId: "slack:C1",
		});

		const targets = await resolveBotDeliveryTargets(org.id, "conn-2");
		expect(targets.map((t) => t.connectionId)).toEqual(["conn-2"]);
  });

	it("routes an Automation only to its configured channel and fails closed when that binding disappears", async () => {
		const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "personal-agent",
		});
		await seedSlackConnection({
			organizationId: org.id,
			agentId: agent.agentId,
			connectionId: "slackinst-routing",
			metadata: { teamId: "T_ROUTING" },
		});
		await seedBinding({
			organizationId: org.id,
			agentId: agent.agentId,
			connectionId: "slackinst-routing",
			channelId: "slack:C_TASKS",
			teamId: "T_ROUTING",
		});
		await seedBinding({
			organizationId: org.id,
			agentId: agent.agentId,
			connectionId: "slackinst-routing",
			channelId: "slack:C_FINANCE",
			teamId: "T_ROUTING",
		});

		const sql = getTestDb();
		const [connection] = await sql<{ id: number }>`
			SELECT id FROM connections
			WHERE organization_id = ${org.id}
			  AND slug = 'slackinst-routing'
		`;
		const subscriptions = await sql<{
			automation_id: number;
			channel_id: string;
		}>`
			SELECT automation_id, channel_id
			FROM automation_message_subscriptions
			WHERE organization_id = ${org.id}
			ORDER BY automation_id
		`;
		const tasks = subscriptions.find((row) => row.channel_id === "slack:C_TASKS")!;
		const finance = subscriptions.find((row) => row.channel_id === "slack:C_FINANCE")!;
		await sql`
			UPDATE automations
			SET delivery_target = ${sql.json({
				connection_id: Number(connection.id),
				channel_id: "slack:C_TASKS",
			})}
			WHERE id = ${finance.automation_id}
		`;

		const targeted = await resolveNotificationDeliveryPlan({
			organizationId: org.id,
			automationId: finance.automation_id,
			// A worker-supplied target cannot override the server-owned Automation route.
			connectionId: "slackinst-routing",
			channelId: "slack:C_FINANCE",
		});
		expect(targeted).toEqual({
			strictAutomationTarget: true,
			targets: [
				{
					connectionId: "slackinst-routing",
					platform: "slack",
					channelKey: "slack:C_TASKS",
					teamId: "T_ROUTING",
				},
			],
		});

		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const automationCtx = {
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
			isAuthenticated: true,
			tokenType: "oauth",
			scopedToOrg: false,
			allowCrossOrg: true,
			scopes: ["mcp:admin"],
			sourceContext: null,
			actingAutomationId: finance.automation_id,
		} as ToolContext;
		const repeatArgs = {
			action: "send" as const,
			title: "Strict Automation delivery",
			idempotency_key: "strict-automation-delivery",
		};
		const first = (await notify(
			repeatArgs,
			{} as never,
			automationCtx,
		)) as { event_id: number | null };

		await sql`UPDATE automations SET status = 'archived' WHERE id = ${tasks.automation_id}`;
		const unavailable = await resolveNotificationDeliveryPlan({
			organizationId: org.id,
			automationId: finance.automation_id,
		});
		// #finance is still bound, but a stale strict #tasks target must never fan
		// out there as a fallback.
		expect(unavailable).toEqual({
			strictAutomationTarget: true,
			targets: [],
		});

		const retry = (await notify(
			repeatArgs,
			{} as never,
			automationCtx,
		)) as { event_id: number | null; notified_count: number };
		expect(retry).toMatchObject({
			event_id: first.event_id,
			notified_count: 0,
		});

		await expect(
			notify(
				{ action: "send", title: "New strict Automation delivery" },
				{} as never,
				automationCtx,
			),
		).rejects.toThrow(/delivery channel is no longer available/);
	});

  // --- Hosted-preview cross-org delivery (the proactive-notification bug) ---
  // The shared preview bot is ONE connection, in its OWN org, under a placeholder
  // agent, that fans out to agents across many orgs. A `/lobu link <code>` writes
  // the binding under the LINKING org. So the org-scoped (org, agent) JOIN misses
  // it on both columns and proactive notifications (incl. reaction posts) drop.

	it("cross-org: delivers a tenant org binding through the shared previewMode connection", async () => {
    const hostOrg = await createTestOrganization(); // where the hosted preview conn lives
    const tenantOrg = await createTestOrganization(); // the org that /lobu link'd a channel
		await createTestAgent({ organizationId: hostOrg.id, agentId: "concierge" });
		await createTestAgent({
			organizationId: tenantOrg.id,
			agentId: "food-ordering",
		});

    await seedSlackConnection({
      organizationId: hostOrg.id,
			agentId: "concierge",
			connectionId: "preview-conn",
      settings: { previewMode: true },
      metadata: {}, // legacy tenantless hosted connection: serves all its bindings
    });
    await seedBinding({
      organizationId: tenantOrg.id, // binding lives in the TENANT org, not the conn's org
			agentId: "food-ordering", // and points at a DIFFERENT agent than the conn's
			connectionId: "preview-conn",
			channelId: "slack:C0LUNCH",
    });

    const targets = await resolveBotDeliveryTargets(tenantOrg.id);
    expect(targets).toEqual([
			{
				connectionId: "preview-conn",
				platform: "slack",
				channelKey: "slack:C0LUNCH",
				teamId: "T_TEST",
			},
    ]);
  });

	it("cross-org: does not expose a tenant binding to the preview connection owner", async () => {
		const hostOrg = await createTestOrganization();
		const tenantOrg = await createTestOrganization();
		await createTestAgent({ organizationId: hostOrg.id, agentId: "concierge" });
		await createTestAgent({
			organizationId: tenantOrg.id,
			agentId: "food-ordering",
		});
		await seedSlackConnection({
			organizationId: hostOrg.id,
			agentId: "concierge",
			connectionId: "preview-conn",
			settings: { previewMode: true },
		});
		await seedBinding({
			organizationId: tenantOrg.id,
			agentId: "food-ordering",
			connectionId: "preview-conn",
			channelId: "slack:C-TENANT",
		});

		expect(await resolveBotDeliveryTargets(hostOrg.id)).toEqual([]);
	});

	it("cross-org guardrail: a NORMAL (non-preview) connection in another org is never used", async () => {
    const otherOrg = await createTestOrganization();
    const tenantOrg = await createTestOrganization();
		await createTestAgent({ organizationId: otherOrg.id, agentId: "crm" });
		await createTestAgent({
			organizationId: tenantOrg.id,
			agentId: "food-ordering",
		});

    await seedSlackConnection({
      organizationId: otherOrg.id,
			agentId: "crm",
			connectionId: "normal-conn",
      settings: {}, // NOT previewMode
    });
    await seedBinding({
      organizationId: tenantOrg.id,
			agentId: "food-ordering",
			connectionId: "normal-conn",
			channelId: "slack:C0LUNCH",
    });

    // Multi-tenant wall: org-scoping holds for normal bots.
    expect(await resolveBotDeliveryTargets(tenantOrg.id)).toEqual([]);
  });

	it("cross-org: delivers through a previewMode connection when its workspace matches the binding", async () => {
		const hostOrg = await createTestOrganization();
		const tenantOrg = await createTestOrganization();
		await createTestAgent({ organizationId: hostOrg.id, agentId: "concierge" });
		await createTestAgent({
			organizationId: tenantOrg.id,
			agentId: "food-ordering",
		});

		await seedSlackConnection({
			organizationId: hostOrg.id,
			agentId: "concierge",
			connectionId: "preview-conn",
			settings: { previewMode: true },
			metadata: { teamId: "T_HOST" },
		});
		await seedBinding({
			organizationId: tenantOrg.id,
			agentId: "food-ordering",
			connectionId: "preview-conn",
			channelId: "slack:C0LUNCH",
			teamId: "T_HOST",
		});

		expect(await resolveBotDeliveryTargets(tenantOrg.id)).toHaveLength(1);
	});

	it("cross-org guardrail: does not deliver a previewMode binding from another workspace", async () => {
		const hostOrg = await createTestOrganization();
		const tenantOrg = await createTestOrganization();
		await createTestAgent({ organizationId: hostOrg.id, agentId: "concierge" });
		await createTestAgent({
			organizationId: tenantOrg.id,
			agentId: "food-ordering",
		});

		await seedSlackConnection({
			organizationId: hostOrg.id,
			agentId: "concierge",
			connectionId: "preview-conn",
			settings: { previewMode: true },
			metadata: { teamId: "T_HOST" },
		});
		await seedBinding({
			organizationId: tenantOrg.id,
			agentId: "food-ordering",
			connectionId: "preview-conn",
			channelId: "slack:C0LUNCH",
			teamId: "T_OTHER",
		});

		expect(await resolveBotDeliveryTargets(tenantOrg.id)).toEqual([]);
	});

	it("does not double-deliver when the org owns its own connection on that channel", async () => {
    const hostOrg = await createTestOrganization();
    const tenantOrg = await createTestOrganization();
		await createTestAgent({ organizationId: hostOrg.id, agentId: "concierge" });
    const tenantAgent = await createTestAgent({
      organizationId: tenantOrg.id,
			agentId: "food-ordering",
    });

    await seedSlackConnection({
      organizationId: hostOrg.id,
			agentId: "concierge",
			connectionId: "preview-conn",
      settings: { previewMode: true },
    });
    await seedSlackConnection({
      organizationId: tenantOrg.id,
      agentId: tenantAgent.agentId,
			connectionId: "own-conn",
    });
    await seedBinding({
      organizationId: tenantOrg.id,
      agentId: tenantAgent.agentId,
			connectionId: "own-conn",
			channelId: "slack:C0LUNCH",
    });

    // Only the org's own connection — the preview branch is skipped (NOT EXISTS).
    expect(await resolveBotDeliveryTargets(tenantOrg.id)).toEqual([
			{
				connectionId: "own-conn",
				platform: "slack",
				channelKey: "slack:C0LUNCH",
				teamId: "T_TEST",
			},
    ]);
  });
});

/**
 * Approvals must never ride the org-wide fan-out.
 *
 * An approval is a decision exactly one human makes; `notification_targets`
 * already addresses the org's admins and the run parks behind its approval URL,
 * so an unresolved chat target must deliver to NO channel rather than to every
 * channel any agent in the org is bound to. Before `deliveryScope: "targeted"`,
 * a Mac Shell `run` approval initiated over MCP (no chat coordinates at all)
 * posted once into each of the org's bound channels — three per approval in
 * prod.
 */
describe("resolveNotificationDeliveryPlan — targeted scope", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});
	afterAll(async () => {
		await cleanupTestDatabase();
	});

	async function seedTwoBoundChannels() {
		const org = await createTestOrganization();
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "crm",
		});
		await seedSlackConnection({
			organizationId: org.id,
			agentId: agent.agentId,
			connectionId: "conn-1",
		});
		await seedBinding({
			organizationId: org.id,
			agentId: agent.agentId,
			connectionId: "conn-1",
			channelId: "slack:C0LEADS",
		});
		await seedBinding({
			organizationId: org.id,
			agentId: agent.agentId,
			connectionId: "conn-1",
			channelId: "slack:C0OPS",
		});
		return org;
	}

	it("org scope still fans out to every bound channel with no target", async () => {
		const org = await seedTwoBoundChannels();

		const plan = await resolveNotificationDeliveryPlan({
			organizationId: org.id,
		});

		expect(plan.targets.map((t) => t.channelKey).sort()).toEqual([
			"slack:C0LEADS",
			"slack:C0OPS",
		]);
	});

	it("targeted scope delivers to NO channel when no target is given", async () => {
		const org = await seedTwoBoundChannels();

		const plan = await resolveNotificationDeliveryPlan({
			organizationId: org.id,
			deliveryScope: "targeted",
		});

		expect(plan.targets).toEqual([]);
	});

	it("targeted scope still honours an explicit channel", async () => {
		const org = await seedTwoBoundChannels();

		const plan = await resolveNotificationDeliveryPlan({
			organizationId: org.id,
			channelId: "slack:C0OPS",
			deliveryScope: "targeted",
		});

		expect(plan.targets.map((t) => t.channelKey)).toEqual(["slack:C0OPS"]);
	});

	it("targeted scope does not fall back org-wide when the target is unbound", async () => {
		const org = await seedTwoBoundChannels();

		const plan = await resolveNotificationDeliveryPlan({
			organizationId: org.id,
			channelId: "slack:C0DELETED",
			deliveryScope: "targeted",
		});

		expect(plan.targets).toEqual([]);
	});

	it("org scope DOES fall back org-wide when the target is unbound", async () => {
		const org = await seedTwoBoundChannels();

		const plan = await resolveNotificationDeliveryPlan({
			organizationId: org.id,
			channelId: "slack:C0DELETED",
		});

		expect(plan.targets.map((t) => t.channelKey).sort()).toEqual([
			"slack:C0LEADS",
			"slack:C0OPS",
		]);
	});
});
