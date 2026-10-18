/**
 * Unit tests for the Automation run conversation-id derivation
 * (automation-run-intent.ts) and the shared approval-interaction row mapping
 * (approval-interaction.ts). Pure: no database.
 */

import { describe, expect, test } from "bun:test";
import {
	buildAutomationRunConversationId,
	parseAutomationRunConversationId,
} from "../../permissions/automation-run-intent.js";
import {
	flattenApprovalProposal,
	mapApprovalInteractionRow,
	resolveApprovalResourceKind,
} from "../approval-interaction.js";

describe("buildAutomationRunConversationId", () => {
	test("derives the prod-proven agent_automation_id_run_id shape", () => {
		expect(buildAutomationRunConversationId("developer", 120, 456)).toBe(
			"developer_automation_120_run_456",
		);
	});

	test("round-trips through parseAutomationRunConversationId", () => {
		const conversationId = buildAutomationRunConversationId("agent-1", 42, 99);
		expect(parseAutomationRunConversationId(conversationId)).toEqual({
			automationId: 42,
			runId: 99,
		});
	});

	test("parse rejects non-run and degenerate ids", () => {
		expect(parseAutomationRunConversationId("marketing_marketing")).toBeNull();
		expect(parseAutomationRunConversationId("caller_automation_5")).toBeNull();
		expect(parseAutomationRunConversationId("caller")).toBeNull();
		expect(
			parseAutomationRunConversationId("agent_automation_0_run_1"),
		).toBeNull();
	});
});

describe("resolveApprovalResourceKind", () => {
	test("stored resourceKind wins over the tool fallback", () => {
		expect(
			resolveApprovalResourceKind({
				resource_kind: "custom",
				tool: "manage_automations",
			}),
		).toBe("custom");
	});

	test("falls back by requesting tool", () => {
		expect(
			resolveApprovalResourceKind({
				resource_kind: null,
				tool: "manage_automations",
			}),
		).toBe("automation");
		expect(
			resolveApprovalResourceKind({ resource_kind: null, tool: "manage_agents" }),
		).toBe("agent");
		expect(
			resolveApprovalResourceKind({
				resource_kind: null,
				tool: "entity_field_change",
			}),
		).toBe("entity");
	});

	test("unknown tools stay null", () => {
		expect(
			resolveApprovalResourceKind({ resource_kind: null, tool: "query_sql" }),
		).toBeNull();
		expect(
			resolveApprovalResourceKind({ resource_kind: null, tool: null }),
		).toBeNull();
	});
});

describe("flattenApprovalProposal", () => {
	test("unwraps manage_automations { args } proposals", () => {
		expect(
			flattenApprovalProposal("automation", { args: { a: 1 } }),
		).toEqual({ a: 1 });
	});

	test("leaves other proposals untouched", () => {
		const proposal = { args: { a: 1 } };
		expect(flattenApprovalProposal("agent", proposal)).toBe(proposal);
		expect(flattenApprovalProposal(null, proposal)).toBe(proposal);
		expect(flattenApprovalProposal("automation", null)).toBeNull();
	});
});

describe("mapApprovalInteractionRow", () => {
	test("maps an automation approval row with flattened proposal", () => {
		expect(
			mapApprovalInteractionRow({
				event_id: 7,
				run_id: 9,
				action: "execute",
				proposal: { args: { automation_id: 3 } },
				current: null,
				fields: null,
				attribution: "agent",
				resource_kind: null,
				reason: "needs review",
				tool: "manage_automations",
			}),
		).toEqual({
			type: "tool-approval",
			eventId: 7,
			runId: 9,
			action: "execute",
			proposal: { automation_id: 3 },
			current: null,
			fields: null,
			attribution: "agent",
			resourceKind: "automation",
			reason: "needs review",
		});
	});

	test("coerces string ids and keeps explicit resourceKind", () => {
		const mapped = mapApprovalInteractionRow({
			event_id: "11",
			run_id: "13",
			action: null,
			proposal: null,
			current: { b: 2 },
			fields: null,
			attribution: null,
			resource_kind: "entity",
			reason: null,
			tool: "entity_change",
		});
		expect(mapped.eventId).toBe(11);
		expect(mapped.runId).toBe(13);
		expect(mapped.resourceKind).toBe("entity");
	});
});
