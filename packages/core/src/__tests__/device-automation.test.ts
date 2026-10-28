import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { AutomationExecutionConfigSchema } from "../contracts/tools/manage-automations.js";
import type { AutomationPollPayload } from "../contracts/worker/protocol.js";
import {
  isEventTurn,
  workspaceEventIds,
} from "../contracts/worker/device-automation.js";

function payload(
  triggerExecution?: string,
  workspaceEventId?: number
): AutomationPollPayload {
  const eventPayload: Record<string, unknown> = { automation_id: 42 };
  if (triggerExecution != null)
    eventPayload.trigger_execution = triggerExecution;
  if (workspaceEventId != null) {
    eventPayload.trigger_signal = {
      kind: "event",
      source: "workspace",
      event_id: workspaceEventId,
    };
  }
  return {
    automation: {
      id: "42",
      name: "Inbox triage",
      slug: "inbox-triage",
      agent_kind: "claude-code",
      prompt: "do the thing",
    },
    event: {
      trigger_event_id: null,
      fired_at: "2026-07-30T00:00:00Z",
      payload: eventPayload,
    },
    context: { device: { worker_id: "mac-1" }, user: { user_id: "u1" } },
  };
}

describe("turn detection", () => {
  test("trigger_execution 'turn' is an event turn", () => {
    expect(isEventTurn(payload("turn"))).toBe(true);
  });

  test("trigger_execution 'window' is not a turn", () => {
    expect(isEventTurn(payload("window"))).toBe(false);
  });

  test("a scheduled run carries no trigger_execution and is a window run", () => {
    expect(isEventTurn(payload())).toBe(false);
  });
});

describe("workspace event ids", () => {
  test("single trigger_signal", () => {
    expect(workspaceEventIds(payload("window", 40))).toEqual([40]);
  });

  test("trigger_signals array, deduped, connector signals skipped", () => {
    const p = payload("window", 40);
    (p.event.payload as Record<string, unknown>).trigger_signals = [
      { kind: "event", source: "workspace", event_id: 40 },
      { kind: "connector", source: "workspace", event_id: 41 },
      { kind: "event", source: "workspace", event_id: 40 },
      { kind: "event", source: "workspace", event_id: 42 },
    ];
    expect(workspaceEventIds(p)).toEqual([40, 42]);
  });
});

describe("Automation execution config", () => {
  test("accepts harness-defined effort strings and rejects non-strings", () => {
    for (const effort of ["medium", "xhigh", "custom-provider-mode"]) {
      expect(
        Value.Check(AutomationExecutionConfigSchema, {
          model: "test-model",
          effort,
        })
      ).toBe(true);
    }
    expect(Value.Check(AutomationExecutionConfigSchema, { effort: 3 })).toBe(
      false
    );
  });
});
