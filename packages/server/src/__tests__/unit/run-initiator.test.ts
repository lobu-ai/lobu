import { describe, expect, it } from "vitest";
import {
	resolveRunInitiator,
	runPermalinkResource,
} from "../../tools/initiator";

describe("resolveRunInitiator", () => {
	it("records the agent session, client, and authorizing human", () => {
		expect(
			resolveRunInitiator({
				userId: "user_1",
				agentId: "personal-agent",
				clientId: "claude-ai",
				sourceContext: { platform: "mcp", conversationId: "conv-1" },
			}),
		).toEqual({
			initiatorKind: "agent_session",
			initiatorRef: {
				agent_id: "personal-agent",
				user_id: "user_1",
				client_id: "claude-ai",
				conversation_id: "conv-1",
				platform: "mcp",
			},
			createdByUserId: "user_1",
		});
	});

	it("records the platform sender of an unlinked chat turn, which has no user", () => {
		expect(
			resolveRunInitiator({
				userId: null,
				agentId: "team-bot",
				clientId: "lobu-worker",
				sourceContext: {
					platform: "slack",
					conversationId: "slack:C0SYNTH:1.0",
					userId: "U0SYNTHSENDER",
					teamId: "T0SYNTH",
				},
			}),
		).toEqual({
			initiatorKind: "agent_session",
			initiatorRef: {
				agent_id: "team-bot",
				user_id: null,
				client_id: "lobu-worker",
				conversation_id: "slack:C0SYNTH:1.0",
				platform: "slack",
				platform_user_id: "U0SYNTHSENDER",
				platform_team_id: "T0SYNTH",
			},
			createdByUserId: null,
		});
	});

	it("classifies a reaction as its automation, not its owning agent", () => {
		expect(
			resolveRunInitiator({
				userId: null,
				agentId: "personal-agent",
				actingAutomationId: 42,
				actingRunId: 99,
			}),
		).toEqual({
			initiatorKind: "automation",
			initiatorRef: {
				automation_id: 42,
				run_id: 99,
			},
			createdByUserId: null,
		});
	});

	it("records a plain human session", () => {
		expect(resolveRunInitiator({ userId: "user_1" })).toEqual({
			initiatorKind: "user",
			initiatorRef: { user_id: "user_1" },
			createdByUserId: "user_1",
		});
	});

	it("falls back to system for hand-built internal contexts", () => {
		expect(resolveRunInitiator({})).toEqual({
			initiatorKind: "system",
			initiatorRef: {},
			createdByUserId: null,
		});
	});
});

describe("runPermalinkResource", () => {
	const automation = {
		initiatorKind: "automation",
		initiatorRef: { automation_id: 42, run_id: 99 },
	};

	it("sends an Automation's run to that Automation's drill-down", () => {
		expect(runPermalinkResource(automation, 500, "personal-agent")).toEqual({
			kind: "automation_run",
			runId: 500,
			agentId: "personal-agent",
			automationId: 42,
		});
	});

	it("falls back to the workspace log when the owning agent is unknown", () => {
		expect(runPermalinkResource(automation, 500, null)).toEqual({
			kind: "run",
			runId: 500,
		});
	});

	it("leaves non-Automation runs on the workspace log", () => {
		expect(
			runPermalinkResource(
				{
					initiatorKind: "agent_session",
					initiatorRef: { agent_id: "personal-agent" },
				},
				500,
				"personal-agent",
			),
		).toEqual({ kind: "run", runId: 500 });
	});

	it("falls back for runs recorded before provenance existed", () => {
		expect(runPermalinkResource({}, 500, "personal-agent")).toEqual({
			kind: "run",
			runId: 500,
		});
	});

	it.each([
		null,
		"",
		0,
		-1,
		1.5,
		"not-a-number",
	])("falls back when an automation ref carries automation id %j", (automationId) => {
		expect(
			runPermalinkResource(
				{ initiatorKind: "automation", initiatorRef: { automation_id: automationId } },
				500,
				"personal-agent",
			),
		).toEqual({ kind: "run", runId: 500 });
	});
});
