import { describe, expect, test } from "bun:test";
import {
  resolveAgentId,
  resolveAgentOptions,
} from "../services/platform-helpers.js";

describe("resolveAgentOptions model resolution (layered fallback)", () => {
  test("automation override (baseOptions.model) wins over the agent default", async () => {
    const settingsStore = {
      getSettings: async () => ({ models: ["openai/gpt-5"] }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "claude/claude-opus-4-8" },
			settingsStore as any,
      "org-1",
    );

    // The per-automation override is highest priority.
    expect(resolved.model).toBe("claude/claude-opus-4-8");
  });

  test("uses the agent models[0] when no automation override", async () => {
    const settingsStore = {
      getSettings: async () => ({ models: ["openai/gpt-5"] }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      {},
			settingsStore as any,
      "org-1",
    );

    expect(resolved.model).toBe("openai/gpt-5");
  });

  test("#6: a legacy 'auto' override is IGNORED and falls back to the agent default", async () => {
    // A stale Listen binding with model='auto' must NOT propagate as the run
    // model — `auto` is gone repo-wide. The malformed override is dropped and
    // the agent's models[0] wins.
    const settingsStore = {
      getSettings: async () => ({ models: ["openai/gpt-5"] }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "auto" },
			settingsStore as any,
      "org-1",
    );

    expect(resolved.model).toBe("openai/gpt-5");
    expect(resolved.model).not.toBe("auto");
  });

  test("#6: a bare (unqualified) override is IGNORED and falls back to the agent default", async () => {
    const settingsStore = {
      getSettings: async () => ({ models: ["openai/gpt-5"] }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "gpt-4o" }, // no provider prefix
			settingsStore as any,
      "org-1",
    );

    expect(resolved.model).toBe("openai/gpt-5");
  });

  test("a valid <provider>/<model> override still wins over the agent default", async () => {
    const settingsStore = {
      getSettings: async () => ({ models: ["openai/gpt-5"] }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "claude/claude-sonnet-5" },
			settingsStore as any,
      "org-1",
    );

    // Note: the exact-allow-list gate (deployment-manager backstop) validates
    // this later; resolveAgentOptions only ensures a WELL-FORMED override wins.
    expect(resolved.model).toBe("claude/claude-sonnet-5");
  });

  test("reads the agent row scoped to the caller's org (shared agent id across orgs)", async () => {
    // A shared agent id (e.g. "lobu-builder") exists in multiple orgs, each with
    // its own models list. The worker-dispatch path has no ambient orgContext,
    // so getSettings MUST receive the org explicitly — otherwise it reads an
    // arbitrary org's row and mis-resolves the model (the Gemini/Claude 404 bug).
    const rowsByOrg: Record<string, { models: string[] }> = {
      "org-a": { models: ["claude/claude-sonnet-4-6"] },
      "org-b": { models: ["gemini/gemini-2.5-flash"] },
    };
    const seenAgentIds: string[] = [];
    const settingsStore = {
      getSettings: async (
        agentId: string,
        context?: { organizationId?: string },
      ) => {
        seenAgentIds.push(agentId);
        // Mirror the store contract: an unscoped read is ambiguous. Simulate the
        // real bug by returning the WRONG org's row when no org is passed.
        const org = context?.organizationId ?? "org-a";
        return rowsByOrg[org] as any;
      },
    };

    const resolved = await resolveAgentOptions(
      "lobu-builder",
      {},
      settingsStore as any,
      "org-b",
    );

    // The store was queried for the right agent, and org-b's model resolved —
    // not the default/first org's Claude model.
    expect(seenAgentIds).toEqual(["lobu-builder"]);
    expect(resolved.model).toBe("gemini/gemini-2.5-flash");
  });

  test("clears model when neither automation nor agent nor org sets one (worker throws)", async () => {
    const settingsStore = {
      getSettings: async () => ({}) as any,
    };

    // organizationId undefined ⇒ no org lookup ⇒ nothing resolved.
    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "" },
			settingsStore as any,
      undefined,
    );

    expect(resolved.model).toBeUndefined();
  });
});

describe("resolveAgentId", () => {
  test("returns null when no binding and connection has no agent", async () => {
    const resolved = await resolveAgentId({
      platform: "telegram",
      channelId: "12345",
    });

    expect(resolved).toBeNull();
  });

  test("existing binding wins over connection agent", async () => {
    const bindingService = {
			resolveForConnection: async (
				connectionId: string,
        channelId: string,
				organizationId: string,
      ) => {
				expect(connectionId).toBe("conn-1");
        expect(channelId).toBe("C1");
				expect(organizationId).toBe("org-1");
				return { agentId: "bound-agent", platform: "slack", channelId };
      },
    };

    const resolved = await resolveAgentId({
      platform: "slack",
      channelId: "C1",
      teamId: "T1",
      agentId: "connection-agent",
			connectionId: "conn-1",
			organizationId: "org-1",
      automationSubscriptionService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "bound-agent",
      source: "subscription",
    });
  });

  test("per-binding model override propagates from the binding (Listen automation)", async () => {
    const bindingService = {
      resolveForConnection: async (
        _connectionId: string,
        channelId: string,
      ) => ({
        agentId: "bound-agent",
        platform: "slack",
        channelId,
        organizationId: "org-1",
        model: "openai/gpt-5",
      }),
    };

    const resolved = await resolveAgentId({
      platform: "slack",
      channelId: "C1",
      agentId: "connection-agent",
      connectionId: "conn-1",
      organizationId: "org-1",
      automationSubscriptionService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "bound-agent",
      source: "subscription",
      organizationId: "org-1",
      model: "openai/gpt-5",
    });
  });

  test("no binding + agentId routes to connection agent", async () => {
    const bindingService = {
			resolveForConnection: async () => null,
    };

    const resolved = await resolveAgentId({
      platform: "slack",
      channelId: "C1",
      teamId: "T1",
      agentId: "connection-agent",
      automationSubscriptionService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "connection-agent",
      source: "connection",
    });
  });

  test("no binding + no connection agent returns null", async () => {
    const bindingService = {
			resolveForConnection: async () => null,
    };

    const resolved = await resolveAgentId({
      platform: "slack",
      channelId: "C1",
      teamId: "T1",
      automationSubscriptionService: bindingService as any,
    });

    expect(resolved).toBeNull();
  });

  test("connection agent works on platforms without teamId (Telegram)", async () => {
    const bindingService = {
			resolveForConnection: async () => null,
    };

    const resolved = await resolveAgentId({
      platform: "telegram",
      channelId: "12345",
      agentId: "my-tg-agent",
      automationSubscriptionService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "my-tg-agent",
      source: "connection",
    });
  });

  test("resolver does NOT write bindings — pure side-effect-free", async () => {
    let createCount = 0;
    const bindingService = {
			resolveForConnection: async () => null,
      createChatAutomation: async () => {
        createCount += 1;
      },
    };

    await resolveAgentId({
      platform: "slack",
      channelId: "C1",
      teamId: "T1",
      agentId: "connection-agent",
      automationSubscriptionService: bindingService as any,
    });

    // Resolving an agent is a read: binding a channel is the bridge's job.
    expect(createCount).toBe(0);
  });
});

/**
 * The payload carries the resolved REF and nothing else — routing is the ref's
 * own business, decided by `resolveModelRef` in the worker.
 *
 * There used to be a permission flag (`automationModelOverride` here,
 * `allowInstalledProviderOverride` at the worker) that a `<provider>/<model>`
 * ref needed before it was allowed to beat the gateway's `defaultProvider`.
 * Only the per-run dispatch sites set it, so a ref that was just as explicit but
 * arrived from `agent.models[0]` or the org default authorized nothing.
 *
 * Measured on prod 2026-08-06: org `buremba` had agent `personal-agent` pinned to
 * `gemini/gemini-2.5-pro`, no Automation override, and NO z-ai provider, secret, or
 * system key of its own — yet 79 runs over three days failed with
 * `z.ai returned an error: 429 Insufficient balance`. `defaultProvider` is a
 * deployment-level fact and the ref is a run-level one, so the precedence was
 * backwards; the flag is gone and the ref always wins. These tests pin that the
 * resolver still picks the right ref and never re-grows a routing flag.
 */
describe("the layered fallback resolves the ref and adds no routing flag", () => {
  const storeWith = (models: string[]) =>
    ({ getSettings: async () => ({ models }) as any }) as any;

  test("an agent-level <provider>/<model> ref wins with no flag attached", async () => {
    const resolved = await resolveAgentOptions(
      "agent-1",
      {},
      storeWith(["gemini/gemini-2.5-pro"]),
      "org-1",
    );

    expect(resolved.model).toBe("gemini/gemini-2.5-pro");
    expect(resolved.automationModelOverride).toBeUndefined();
  });

  test("a per-automation override still wins over the agent default", async () => {
    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "qwen/qwen3.8-max-preview" },
      storeWith(["gemini/gemini-2.5-pro"]),
      "org-1",
    );

    expect(resolved.model).toBe("qwen/qwen3.8-max-preview");
    expect(resolved.automationModelOverride).toBeUndefined();
  });

  test("an unqualified agent model is passed through as-is", async () => {
    const resolved = await resolveAgentOptions(
      "agent-1",
      {},
      storeWith(["gpt-4o"]),
      "org-1",
    );

    expect(resolved.model).toBe("gpt-4o");
    expect(resolved.automationModelOverride).toBeUndefined();
  });

  // A malformed per-request override is dropped in favour of the agent default.
  test("a rejected 'auto' override falls back to the agent ref", async () => {
    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "auto" },
      storeWith(["gemini/gemini-2.5-pro"]),
      "org-1",
    );

    expect(resolved.model).toBe("gemini/gemini-2.5-pro");
    expect(resolved.automationModelOverride).toBeUndefined();
  });

  // The clearing branch that used to exist alongside the flag: a rejected
  // override must still fall through to a ref that names no provider at all.
  test("a rejected override falls through to an unqualified agent ref", async () => {
    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "auto" },
      storeWith(["gpt-4o"]),
      "org-1",
    );

    expect(resolved.model).toBe("gpt-4o");
    expect(resolved.automationModelOverride).toBeUndefined();
  });
});
