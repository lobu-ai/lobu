import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { AutomationExecutionConfigSchema } from "../contracts/tools/manage-automations.js";
import { buildDeviceChatPrompt } from "../contracts/worker/device-chat.js";
import {
  DeviceChatPollPayloadSchema,
  type DeviceChatPollPayload,
} from "../contracts/worker/protocol.js";

function payload(): DeviceChatPollPayload {
  return {
    chat: {
      agent_kind: "pi",
      message: "What changed today?",
      ephemeral_context: "Atlas has one urgent review.",
      history: [
        { role: "user", content: "Remember project Atlas." },
        { role: "assistant", content: "I will." },
      ],
      agent: {
        id: "agent-1",
        name: "Researcher",
        identity_md: "You are a careful researcher.",
        soul_md: "Prefer evidence.",
        user_md: "The user owns Atlas.",
      },
    },
    context: {
      device: { worker_id: "device-1" },
      user: { user_id: "user-1" },
      agent_session: {
        conversation_id: "conv-1",
        mcp_url: "https://lobu.test/mcp/acme",
        token: "run-token",
        expires_at: Date.now() + 60_000,
      },
    },
  };
}

describe("device chat contract", () => {
  test("Automation settings and device chat accept harness-defined effort strings", () => {
    for (const effort of ["medium", "xhigh", "custom-provider-mode"]) {
      const execution_config = { model: "test-model", effort };
      const envelope = payload();
      envelope.chat.execution_config = execution_config;
      expect(
        Value.Check(AutomationExecutionConfigSchema, execution_config)
      ).toBe(true);
      expect(Value.Check(DeviceChatPollPayloadSchema, envelope)).toBe(true);
    }
    expect(Value.Check(AutomationExecutionConfigSchema, { effort: 3 })).toBe(
      false
    );
  });

  test("the strict poll payload accepts the bounded device envelope", () => {
    expect(Value.Check(DeviceChatPollPayloadSchema, payload())).toBe(true);
  });

  test("the shared prompt carries agent layers, history, and the current turn", () => {
    const prompt = buildDeviceChatPrompt(payload());
    expect(prompt).toContain("Lobu agent Researcher");
    expect(prompt).toContain("## Identity\n\nYou are a careful researcher.");
    expect(prompt).toContain(
      "## Workspace context\n\nAtlas has one urgent review."
    );
    expect(prompt).toContain("User: Remember project Atlas.");
    expect(prompt).toContain("Assistant: I will.");
    expect(prompt).toContain("## Current user message\n\nWhat changed today?");
    expect(prompt).toContain("Return only the assistant reply on stdout");
  });
});
