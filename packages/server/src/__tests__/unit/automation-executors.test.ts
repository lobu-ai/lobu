import { describe, expect, test } from "bun:test";
import type { AutomationTriggerInput } from "../../tools/admin/manage_automations/executors";
import {
	assertAutomationExecutorsResolve,
	resolveAutomationExecutor,
} from "../../tools/admin/manage_automations/executors";
import { getTool } from "../../tools/registry";
import { validateToolArgs } from "../../tools/validate-args";
import { ToolUserError } from "../../utils/errors";

const eventTrigger = (): AutomationTriggerInput => ({
	kind: "event",
	connector_key: "github",
	event_types: ["pull_request.created"],
});

const scheduleTrigger = (): AutomationTriggerInput => ({
	kind: "schedule",
	cron: "0 9 * * *",
});

describe("resolveAutomationExecutor", () => {
	// Legacy dual rows carried both agent_id and device_worker_id and always
	// ran on the device lane (#802). Resolution MUST be device-pin-first or
	// existing device-pinned automations flip to server dispatch.
	test("device pin takes precedence over the agent", () => {
		expect(
			resolveAutomationExecutor({ agentId: "a", deviceWorkerId: "d" }),
		).toEqual({ kind: "device", deviceWorkerId: "d", agentKind: null });
	});

	test("agent resolves when there is no device pin", () => {
		expect(resolveAutomationExecutor({ agentId: "agent-a" })).toEqual({
			kind: "agent",
			agentId: "agent-a",
		});
	});

	test("device carries its runtime kind", () => {
		expect(
			resolveAutomationExecutor({ deviceWorkerId: "d", agentKind: "codex" }),
		).toEqual({ kind: "device", deviceWorkerId: "d", agentKind: "codex" });
	});

	test("no executor resolves to null", () => {
		expect(resolveAutomationExecutor({})).toBeNull();
	});
});

describe("assertAutomationExecutorsResolve", () => {
	test("manual-only automations (no triggers) pass with or without an executor", () => {
		expect(() => assertAutomationExecutorsResolve([], {})).not.toThrow();
		expect(() => assertAutomationExecutorsResolve(undefined, {})).not.toThrow();
		expect(() =>
			assertAutomationExecutorsResolve([], { agentId: "a" }),
		).not.toThrow();
	});

	test("automated automations require an executor", () => {
		expect(() => assertAutomationExecutorsResolve([eventTrigger()], {})).toThrow(
			/executor/,
		);
		expect(() =>
			assertAutomationExecutorsResolve([scheduleTrigger()], {}),
		).toThrow(/executor/);
	});

	test("an agent satisfies automated triggers", () => {
		expect(() =>
			assertAutomationExecutorsResolve([eventTrigger(), scheduleTrigger()], {
				agentId: "agent-a",
			}),
		).not.toThrow();
	});

	test("a device pin satisfies automated triggers", () => {
		expect(() =>
			assertAutomationExecutorsResolve([eventTrigger()], {
				deviceWorkerId: "device-1",
			}),
		).not.toThrow();
	});
});

describe('reference capture executors', () => {
  const trigger = { kind: 'event', connector_key: 'synthetic.source', event_types: ['message.created'], capture: 'references' } as const;
  const capture = () => ({ ...trigger, event_types: [...trigger.event_types] });
  const external = { executionConfig: { executor: { kind: 'external' as const } } };
  test('accepts silent external capture without an agent or device', () => {
    expect(() => assertAutomationExecutorsResolve([capture()], external)).not.toThrow();
  });
  test.each([{ agentId: 'synthetic-agent' }, external])('rejects body-only capture match fields for every executor', defaults => {
    expect(() => assertAutomationExecutorsResolve([{ ...capture(), match: { channel_id: 'synthetic-channel' } }], defaults))
      .toThrow(/resource_ref\/resource_type/);
  });
  test('rejects non-capture external event execution and external replies', () => {
    expect(() => assertAutomationExecutorsResolve([eventTrigger()], external)).toThrow(/reference-capture/);
    expect(() => assertAutomationExecutorsResolve([{ ...capture(), output: 'reply_to_source' }], external)).toThrow(/silent capture/);
  });
  test('serves the capture and change-read fields through the real tool schemas', () => {
    const create = validateToolArgs('manage_automations', getTool('manage_automations')!.inputSchema, {
      action: 'create', slug: 'synthetic-source', name: 'Synthetic source', execution_config: external.executionConfig,
      triggers: [capture()],
    });
    expect((create as any).triggers[0].capture).toBe('references');
    const read = validateToolArgs('read_knowledge', getTool('read_knowledge')!.inputSchema,
      { automation_id: 123, view: 'changes', cursor: 'synthetic-opaque-cursor', limit: 25 });
    expect(read).toMatchObject({ view: 'changes', cursor: 'synthetic-opaque-cursor' });
  });
});

// `agent_kind` names the local CLI the device spawns. It was a free-text
// column with no FK and a free-text schema, so an unknown value wrote an
// Automation that resolved to no executor on the device and failed at dispatch
// — the write path never objected (#2504). Worse, the schema's own examples
// were "background" and "notifier", neither of which has ever had an
// executor, so an agent following the contract wrote a dead Automation.
describe("manage_automations agent_kind", () => {
	// Validate the schema the registry actually serves, not a direct import —
	// this is the copy every write lane (MCP, run_sdk, REST) resolves.
	const schema = getTool("manage_automations")?.inputSchema;
	if (!schema) throw new Error("manage_automations is not in the tool registry");

	const write = (agentKind: unknown) =>
		validateToolArgs("manage_automations", schema, {
			action: "create",
			slug: "s",
			name: "n",
			prompt: "p",
			device_worker_id: "device-1",
			agent_kind: agentKind,
		});

	// Every kind the Mac dispatcher registers an executor for. Adding a CLI
	// to AgentSpec.all without adding it here makes it unselectable.
	test.each(["claude-code", "codex", "opencode", "pi", "agy"])(
		"accepts %s",
		(kind) => {
			expect(() => write(kind)).not.toThrow();
		},
	);

	test("accepts null — the device's own default agent", () => {
		expect(() => write(null)).not.toThrow();
	});

	test("rejects a kind no executor implements", () => {
		expect(() => write("gemini-cli")).toThrow(ToolUserError);
		expect(() => write("background")).toThrow(ToolUserError);
		expect(() => write("claude_code")).toThrow(ToolUserError);
	});
});
