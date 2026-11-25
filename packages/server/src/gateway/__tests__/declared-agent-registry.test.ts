import { describe, expect, test } from "bun:test";
import {
  buildRegistryMap,
  DeclaredAgentRegistry,
  entryFromAgentConfig,
} from "../services/declared-agent-registry.js";

describe("DeclaredAgentRegistry", () => {
  test("starts empty", () => {
    const registry = new DeclaredAgentRegistry();
    expect(registry.agentIds()).toEqual([]);
    expect(registry.has("anything")).toBe(false);
    expect(registry.get("anything")).toBeUndefined();
  });

  test("replaceAll wipes prior entries", () => {
    const registry = new DeclaredAgentRegistry();
    registry.replaceAll(new Map([["a", { settings: {}, credentials: [] }]]));
    expect(registry.has("a")).toBe(true);

    registry.replaceAll(new Map([["b", { settings: {}, credentials: [] }]]));
    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(true);
  });
});

describe("entryFromAgentConfig", () => {
  test("expands providers into an ordered concrete models list + credentials", () => {
    const entry = entryFromAgentConfig({
      id: "agent-1",
      name: "Agent 1",
      providers: [
        { id: "openai", model: "gpt-4o", key: "sk-1" },
        { id: "anthropic", model: "anthropic/claude-sonnet-5", secretRef: "vault://anth" },
      ],
      network: { allowed: ["github.com"] },
      nixPackages: ["jq"],
    } as any);

    // Bare declared models get slug-prefixed; already-prefixed refs pass through.
    expect(entry.settings.models).toEqual([
      "openai/gpt-4o",
      "anthropic/claude-sonnet-5",
    ]);
    expect(entry.settings.networkConfig).toEqual({
      allowedDomains: ["github.com"],
      deniedDomains: undefined,
    });
    expect(entry.settings.nixConfig).toEqual({ packages: ["jq"] });
    expect(entry.credentials).toEqual([
      { provider: "openai", key: "sk-1" },
      { provider: "anthropic", secretRef: "vault://anth" },
    ]);
  });

  test("#3(b): a provider with no declared model becomes a restriction sentinel (NOT dropped)", () => {
    const entry = entryFromAgentConfig({
      id: "agent-3",
      name: "Agent 3",
      providers: [{ id: "unknown-provider" }, { id: "openai", model: "gpt-4o" }],
    } as any);

    // The unresolvable provider is kept as a sentinel so the agent stays
    // RESTRICTED (gated), never dropped to allow-all.
    expect(entry.settings.models).toEqual([
      "unknown-provider/__unresolved__",
      "openai/gpt-4o",
    ]);
  });

  test("#3(b): an agent whose ONLY provider is unresolvable is restricted, not allow-all", () => {
    const entry = entryFromAgentConfig({
      id: "agent-4",
      name: "Agent 4",
      providers: [{ id: "unknown-provider" }],
    } as any);

    // A declared-provider agent must NEVER end with models undefined (= allow-all).
    expect(entry.settings.models).toEqual(["unknown-provider/__unresolved__"]);
    expect(entry.settings.models).not.toBeUndefined();
  });
});

describe("buildRegistryMap", () => {
  test("populates entries from SDK config agents", () => {
    const map = buildRegistryMap([
      {
        id: "agent-a",
        name: "Agent A",
        providers: [{ id: "openai", model: "gpt-4o", key: "sk-1" }],
      } as any,
      {
        id: "agent-b",
        name: "Agent B",
        providers: [{ id: "anthropic", model: "claude-sonnet-5", key: "sk-2" }],
      } as any,
    ]);

    expect(map.size).toBe(2);
    expect(map.get("agent-a")?.credentials).toEqual([
      { provider: "openai", key: "sk-1" },
    ]);
    expect(map.get("agent-b")?.credentials).toEqual([
      { provider: "anthropic", key: "sk-2" },
    ]);
  });
});
