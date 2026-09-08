/**
 * `nixConfig` must reach the ENQUEUED payload's top-level field — that is the
 * only place the spawn path reads it from (`deployment-manager` wraps the
 * worker in `nix-shell -p <packages>` off `messageData.nixConfig`).
 *
 * `buildMessagePayload` does that lift for callers that use it, but two paths
 * hand-roll their `enqueueMessage` argument, so a resolved `nixConfig`
 * previously stayed nested inside `agentOptions` and was silently dropped.
 * These tests drive both of them — `ChatInstanceManager.routePlatformMessage`
 * and the direct-API `POST /api/v1/agents/{agentId}/messages` — with a
 * capturing queue, asserting the union (per-request ∪ agent settings) lands on
 * `payload.nixConfig` and NOT in `payload.agentOptions`. Legacy skill-level
 * `nixPackages` entries are unsupported and must contribute nothing.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { generateWorkerToken, type MessagePayload } from "@lobu/core";
import { ChatInstanceManager } from "../connections/chat-instance-manager.js";
import { createAgentApi } from "../routes/public/agent.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";

process.env.ENCRYPTION_KEY ||=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const AGENT_ID = "agent-1";
const ORG_ID = "org-1";

const AGENT_SETTINGS = {
  models: ["openai/gpt-5"],
  preApprovedTools: ["/mcp/test-memory/tools/*"],
  nixConfig: { packages: ["agent-pkg"] },
  skillsConfig: {
    skills: [
      // Neither legacy entry may reach nixConfig.
      {
        repo: "lobu/skills",
        name: "video",
        enabled: true,
        nixPackages: ["must-not-appear-enabled"],
      },
      {
        repo: "lobu/skills",
        name: "disabled-one",
        enabled: false,
        nixPackages: ["must-not-appear-disabled"],
      },
    ],
  },
};

function makeAgentSettingsStore() {
  return { getSettings: async () => AGENT_SETTINGS };
}

describe("enqueued payload carries the resolved nixConfig", () => {
  let enqueued: MessagePayload[];

  beforeEach(() => {
    enqueued = [];
  });

  test("routePlatformMessage lifts nixConfig out of agentOptions", async () => {
    const manager = Object.create(
      ChatInstanceManager.prototype,
    ) as ChatInstanceManager;

    // Only the seams routePlatformMessage touches — this asserts payload shape,
    // not connection selection or session persistence.
    Object.assign(manager, {
      services: {
        getSessionManager: () => ({ setSession: mock(async () => {}) }),
        getQueueProducer: () => ({
          enqueueMessage: mock(async (payload: MessagePayload) => {
            enqueued.push(payload);
          }),
        }),
        getAgentSettingsStore: makeAgentSettingsStore,
      },
      selectConnectionForPlatform: async () => ({
        id: "conn-1",
        organizationId: "org-1",
      }),
    });

    await manager.routePlatformMessage("telegram", "token-abcdefgh", "hi", {
      agentId: "agent-1",
      channelId: "chan-1",
      teamId: "team-1",
    });

    expect(enqueued).toHaveLength(1);
    const payload = enqueued[0]!;
    expect(payload.preApprovedTools).toEqual(AGENT_SETTINGS.preApprovedTools);
    expect(payload.agentOptions).not.toHaveProperty("preApprovedTools");
    expect(payload.nixConfig?.packages).toEqual(["agent-pkg"]);
    // The worker reads the top-level field; a copy left in agentOptions would
    // mean the lift never happened.
    expect(
      (payload.agentOptions as Record<string, unknown> | undefined)?.nixConfig,
    ).toBeUndefined();
  });

  test("the direct API path unions request and agent packages", async () => {
    // `POST /agents` persists its `nix` on the session; before the fix that
    // value was replayed into resolveAgentOptions and then dropped, so a
    // caller-supplied package never reached the worker.
    setAuthProvider(null);
    const app = createAgentApi({
      queueProducer: {
        enqueueMessage: mock(async (payload: MessagePayload) => {
          enqueued.push(payload);
          return "job-1";
        }),
      } as never,
      sessionManager: {
        getSession: async () => ({
          agentId: AGENT_ID,
          conversationId: "conv-1",
          channelId: "api_user-1",
          userId: "user-1",
          organizationId: ORG_ID,
          nixConfig: { packages: ["request-pkg"] },
        }),
        touchSession: async () => {},
        setSession: async () => {},
      } as never,
      sseManager: { hasClients: () => false } as never,
      publicGatewayUrl: "http://localhost:8787",
      artifactStore: {} as never,
      agentSettingsStore: makeAgentSettingsStore() as never,
      agentMetadataStore: {
        async getMetadata() {
          return { owner: { platform: "api", userId: "user-1" } };
        },
      } as never,
    });

    const token = generateWorkerToken(AGENT_ID, "conv-1", "deploy-1", {
      channelId: "api_user-1",
      agentId: AGENT_ID,
      organizationId: ORG_ID,
    });
    const res = await app.request(
      `/api/v1/agents/${AGENT_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: "hi" }),
      },
    );

    expect(res.status).toBe(200);
    expect(enqueued).toHaveLength(1);
    const payload = enqueued[0]!;
    expect(payload.preApprovedTools).toEqual(AGENT_SETTINGS.preApprovedTools);
    expect(payload.agentOptions).not.toHaveProperty("preApprovedTools");
    expect(payload.nixConfig?.packages).toEqual(["request-pkg", "agent-pkg"]);
    expect(
      (payload.agentOptions as Record<string, unknown> | undefined)?.nixConfig,
    ).toBeUndefined();
  });
});
