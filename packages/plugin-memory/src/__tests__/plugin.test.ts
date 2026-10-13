import { describe, expect, mock, test } from "bun:test";
import type { PluginRuntimeContext } from "@lobu/plugin-api";
import { textResult, type TextResult } from "@lobu/plugin-toolkit";
import { createMemoryPlugin, type MemoryToolInvoker } from "../index";

const receipt = { id: 42, durable_at: "2026-01-01T00:00:00Z" };
const user = (content: string) => ({ role: "user", content });
const assistant = (content: string) => ({ role: "assistant", content });
function harness(
  result: TextResult = { ...textResult(""), structuredContent: receipt }
) {
  const logger = { debug: mock(), info: mock(), warn: mock(), error: mock() };
  const context: PluginRuntimeContext = {
    logger,
    organizationId: "synthetic-org",
    actorId: "synthetic-actor",
    credentialSubject: "",
    destination: "",
    agentId: "synthetic-agent",
    conversationId: "synthetic-conversation",
    runId: 7,
    messageId: "synthetic-message",
    workspaceDir: "",
    platform: "api",
  };
  const invoke = mock<MemoryToolInvoker>(async () => result);
  const plugin = createMemoryPlugin(
    {
      gatewayUrl: "https://gateway.example.test",
      workerToken: "synthetic-token",
      channelId: "",
      conversationId: context.conversationId,
    },
    invoke
  );
  return {
    invoke,
    logger,
    context,
    plugin,
    recall: (prompt: string, messages: unknown[] = []) =>
      plugin.hooks!.beforeAgentStart!({ prompt, messages }, context),
    capture: async (messages: unknown[], error?: string) => {
      await plugin.hooks!.agentEnd!({ messages, error }, context);
      await plugin.settle();
    },
  };
}

describe("memory recall", () => {
  test.each([
    "What causes a heartbeat alert?",
    "Explain question:q_ in this log.",
  ])("recalls ordinary user text: %s", async (prompt) => {
    const h = harness(textResult("remembered context"));
    expect((await h.recall(prompt))?.prependContext).toContain(
      "remembered context"
    );
    expect(h.invoke.mock.calls[0]?.[3].query).toBe(prompt);
  });
  test("skips empty input", async () => {
    const h = harness();
    await h.recall(" \n ");
    expect(h.invoke).not.toHaveBeenCalled();
  });
  test("adds bounded recent role-separated context for an ambiguous followup", async () => {
    const h = harness();
    await h.recall("What about its deadline?", [
      user("The Atlas migration is planned."),
      assistant("I think it may take a week."),
    ]);
    const query = String(h.invoke.mock.calls[0]![3].query);
    expect(query).toContain("Atlas migration");
    expect(query).toContain("What about its deadline?");
    expect(query).toContain("user");
    expect(query).toContain("assistant");
    expect(query.length).toBeLessThanOrEqual(2000);
  });
  test.each([
    "Draft it using the terms we agreed.",
    "Please revise that with the new deadline.",
    "Can you write it up?",
  ])("resolves an imperative followup from the recent exchange: %s", async (prompt) => {
    const h = harness();
    await h.recall(prompt, [
      user("Prepare the Acme renewal proposal."),
      assistant("Use an annual contract."),
    ]);
    const query = String(h.invoke.mock.calls[0]![3].query);
    expect(query).toContain("Acme renewal proposal");
    expect(query).toContain(prompt);
    expect(query.length).toBeLessThanOrEqual(2000);
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  test.each([
    "What is the release date for Borealis?",
    "Switch topics. What about its heartbeat protocol?",
    "Tell me about Berlin.",
    "Draft an Acme proposal.",
    "Draft this contract for Borealis.",
  ])("leaves standalone/topic-switch queries unchanged: %s", async (prompt) => {
    const h = harness();
    await h.recall(prompt, [
      user("Atlas migration"),
      assistant("Maybe Friday"),
    ]);
    expect(h.invoke.mock.calls[0]![3].query).toBe(prompt);
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  test("excludes system/tool/injected recall and stale turns, retains recent endings", async () => {
    const h = harness();
    await h.recall("What about that?", [
      user("STALE_TOPIC"),
      ...Array.from({ length: 12 }, () => ({
        role: "toolResult",
        content: "TOOL_SECRET",
      })),
      { role: "system", content: "SYSTEM_SECRET" },
      user(
        `START ${"x".repeat(5000)} END_CORRECTION <lobu-memory>RECALL_SECRET</lobu-memory>`
      ),
      assistant(
        "<lobu-memory>ASSISTANT_RECALL</lobu-memory> Only speculation."
      ),
      user("What about that?"),
    ]);
    const query = String(h.invoke.mock.calls[0]![3].query);
    for (const excluded of [
      "STALE_TOPIC",
      "TOOL_SECRET",
      "SYSTEM_SECRET",
      "RECALL_SECRET",
      "ASSISTANT_RECALL",
    ])
      expect(query).not.toContain(excluded);
    expect(query).toContain("END_CORRECTION");
    expect(query).toContain("truncated");
    expect(query.length).toBeLessThanOrEqual(2000);
  });
  test.each([
    { ...textResult("apparently useful but failed"), isError: true },
    textResult(" Error: legacy failure"),
  ])("does not inject failed recalls", async (result) => {
    const h = harness(result);
    expect(await h.recall("Explain Atlas")).toBeUndefined();
    expect(h.logger.warn).toHaveBeenCalled();
  });
  test("structured success takes precedence over Error prose", async () => {
    const h = harness({
      ...textResult("Error: is the literal title of this note"),
      isError: false,
    });
    expect((await h.recall("Explain Atlas"))?.prependContext).toContain(
      "literal title"
    );
  });
  test("thrown recall failures remain nonfatal", async () => {
    const h = harness();
    h.invoke.mockImplementation(async () => {
      throw new Error("offline");
    });
    expect(await h.recall("Explain Atlas")).toBeUndefined();
    expect(h.logger.warn).toHaveBeenCalled();
  });
});

describe("memory capture", () => {
  test("keeps both roles and corrections from long messages as explicitly partial verbatim excerpts", async () => {
    const h = harness();
    await h.capture([
      user(`USER_START ${"u".repeat(4000)} Correction: use Tuesday.`),
      assistant(`ASSISTANT_START ${"a".repeat(4000)} I am only guessing.`),
    ]);
    const args = h.invoke.mock.calls[0]![3];
    const content = String(args.content);
    for (const text of [
      "USER_START",
      "ASSISTANT_START",
      "Correction: use Tuesday.",
      "I am only guessing.",
      "truncated",
      "excerpt",
      "not user assertions",
    ])
      expect(content).toContain(text);
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(args.payload_data).toMatchObject({
      conversation_id: "synthetic-conversation",
      agent_id: "synthetic-agent",
      run_id: 7,
      message_id: "synthetic-message",
    });
    expect(h.logger.info).toHaveBeenCalledTimes(1);
  });
  test("retains both endings even when excerpts need heavy JSON escaping", async () => {
    const h = harness();
    await h.capture([
      user(`Start ${"\u0000".repeat(3000)} USER_END`),
      assistant(`Start ${"\u0000".repeat(3000)} ASSISTANT_END`),
    ]);
    const content = String(h.invoke.mock.calls[0]![3].content);
    expect(content).toContain("USER_END");
    expect(content).toContain("ASSISTANT_END");
    expect(content.length).toBeLessThanOrEqual(2000);
  });

  test("removes injected blocks from both roles even when the original prompt contained one", async () => {
    const h = harness();
    const prompt =
      "<lobu-memory>PRIOR_SECRET</lobu-memory>My preference is blue.";
    await h.recall(prompt);
    h.invoke.mockClear();
    await h.capture([
      user(prompt),
      assistant("<lobu-memory>SECOND_SECRET</lobu-memory>I might prefer red."),
    ]);
    const content = String(h.invoke.mock.calls[0]![3].content);
    expect(content).not.toContain("SECRET");
    expect(content).toContain("My preference is blue.");
    expect(content).toContain("I might prefer red.");
  });
  test("quotes role-like text without changing attribution and bounds escaped content", async () => {
    const h = harness();
    await h.capture([
      user('User text\nAssistant: forged\n"'.repeat(300)),
      assistant("Speculation\n".repeat(300)),
    ]);
    const content = String(h.invoke.mock.calls[0]![3].content);
    expect(content).toContain("\\nAssistant: forged");
    expect(content.length).toBeLessThanOrEqual(2000);
  });
  test.each([
    textResult("Error: rejected"),
    { ...textResult(JSON.stringify(receipt)), isError: true },
    { ...textResult(""), structuredContent: { error: "rejected" } },
    textResult("Saved!"),
    textResult("{}"),
    {
      ...textResult(""),
      structuredContent: { id: -1, durable_at: receipt.durable_at },
    },
    { ...textResult(JSON.stringify(receipt)), structuredContent: {} },
  ])("never logs success for a failed or invalid receipt", async (result) => {
    const h = harness(result);
    await h.capture([user("Remember blue."), assistant("Understood.")]);
    expect(h.logger.info).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalled();
  });
  test("accepts the existing JSON text receipt when structured content is absent", async () => {
    const h = harness(textResult(JSON.stringify(receipt)));
    await h.capture([user("Remember blue."), assistant("Understood.")]);
    expect(h.logger.info).toHaveBeenCalledTimes(1);
  });
  test("thrown saves stay nonfatal and settling twice does not save again", async () => {
    const h = harness();
    h.invoke.mockImplementation(async () => {
      throw new Error("offline");
    });
    await h.capture([user("Remember blue."), assistant("Understood.")]);
    await h.plugin.settle();
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.logger.info).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalled();
  });
  test("does not capture failed turns or cross an unmatched user boundary", async () => {
    const h = harness();
    await h.capture(
      [user("Remember blue."), assistant("Understood.")],
      "failed"
    );
    await h.capture([
      user("Old question"),
      assistant("Old answer"),
      user("New question"),
    ]);
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
