import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import type { DbClient } from "../../db/client.js";
import { resolveAutomationRunSkills } from "../automation-run-session.js";
import { WorkerGateway } from "../worker-dispatch/worker-gateway.js";

const TEST_ENCRYPTION_KEY = Buffer.from(
  "12345678901234567890123456789012"
).toString("base64");

describe("WorkerGateway session context", () => {
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (previousEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = previousEncryptionKey;
    }
  });

  test("syncs live skills for chat and pinned snapshots for Automation runs", async () => {
    // A DECLARED (SDK-embedded) agent has org-agnostic settings, so an orgless
    // token legitimately syncs its skills. (A DB-backed agent with an orgless
    // token would fail closed — covered by the cross-tenant test below.)
    const gateway = new WorkerGateway(
      { send: async () => undefined } as any,
      "https://gateway.example.com",
      {
        getWorkerConfig: async () => ({ mcpServers: {} }),
      } as any,
      {
        getSessionContext: async () => ({
          agentLayers: {
            identityMd: "I am Aria.",
            soulMd: "Be concise.",
            userMd: "Acme support.",
            unconfiguredNotice: "",
          },
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions:
            "## Skills\n\n- **Custom Skill** (`owner/custom-skill`)",
          mcpStatus: [],
        }),
      } as any,
      undefined,
      {
        isDeclaredAgent: () => true,
        getSettings: async () => ({
          get models() {
            throw new Error("Session context must not resolve models");
          },
          skillsConfig: {
            skills: [
              {
                name: "custom-skill",
                enabled: true,
                content: "# Custom Skill\n",
              },
            ],
          },
        }),
      } as any,
      async () => [
        {
          name: "pinned-automation-skill",
          content: "# Pinned Automation Skill\n",
        },
      ]
    );

    type SessionContextBody = {
      agentLayers: {
        identityMd: string;
        soulMd: string;
        userMd: string;
        unconfiguredNotice: string;
      };
      skillsConfig: Array<{ name: string; content: string }>;
      skillsInstructions: string;
    };

    const fetchContext = async (
      source?: string,
      conversationId = "conv-1"
    ): Promise<SessionContextBody> => {
      const token = generateWorkerToken("user-1", conversationId, "worker-a", {
        channelId: "channel-1",
        agentId: "agent-1",
        source,
      });
      const response = await gateway.getApp().request("/session-context", {
        headers: {
          authorization: `Bearer ${token}`,
          host: "gateway.example.com",
        },
      });
      expect(response.status).toBe(200);
      return (await response.json()) as SessionContextBody;
    };

    const chat = await fetchContext();
    expect(chat).not.toHaveProperty("providerConfig");
    expect(chat.agentLayers).toEqual({
      identityMd: "I am Aria.",
      soulMd: "Be concise.",
      userMd: "Acme support.",
      unconfiguredNotice: "",
    });
    expect(chat.skillsConfig).toEqual([
      { name: "custom-skill", content: "# Custom Skill\n" },
    ]);
    expect(chat.skillsInstructions).toContain("## Skills");
    expect(chat.skillsInstructions).toContain("owner/custom-skill");
    expect(chat.skillsInstructions).not.toContain("Built-in System Skills");

    const automationRun = await fetchContext(
      "automation-run",
      "agent-1_automation_42_run_99"
    );
    expect(automationRun.skillsConfig).toEqual([
      {
        name: "pinned-automation-skill",
        content: "# Pinned Automation Skill\n",
      },
    ]);
    expect(automationRun.skillsInstructions).toContain("pinned-automation-skill");
    expect(automationRun.skillsInstructions).not.toContain("custom-skill");

    // Other headless sources do not execute frozen Automation instructions.
    const connectorRepair = await fetchContext("connector-repair");
    expect(connectorRepair.skillsConfig).toHaveLength(1);
    expect(connectorRepair.skillsInstructions).toContain("## Skills");
  });

  test("ships the PUBLIC web origin, with the embedded /lobu mount stripped", async () => {
    // Prod runs PUBLIC_GATEWAY_URL=https://app.lobu.ai/lobu. The worker reaches
    // this endpoint over the INTERNAL dispatcher address, so the request Host
    // below is deliberately a cluster name: if the handler ever derives the
    // origin from the request instead of the configured public base, the agent
    // starts handing users links to a host they cannot open. Both halves of that
    // — the /lobu strip and the ignore-the-Host rule — are asserted here.
    const gateway = new WorkerGateway(
      { send: async () => undefined } as any,
      "https://app.lobu.ai/lobu",
      { getWorkerConfig: async () => ({ mcpServers: {} }) } as any,
      {
        getSessionContext: async () => ({
          agentLayers: {
            identityMd: "",
            soulMd: "",
            userMd: "",
            unconfiguredNotice: "",
          },
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [],
        }),
      } as any
    );

    const token = generateWorkerToken("user-1", "conv-1", "worker-a", {
      channelId: "channel-1",
      agentId: "agent-1",
    });

    const response = await gateway.getApp().request("/session-context", {
      headers: {
        authorization: `Bearer ${token}`,
        host: "lobu-gateway.default.svc.cluster.local:8080",
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { webOrigin?: string };
    expect(body).not.toHaveProperty("providerConfig");
    expect(body.webOrigin).toBe("https://app.lobu.ai");
    expect(body.webOrigin).not.toContain("/lobu");
    expect(body.webOrigin).not.toContain("cluster.local");
  });

  test("resolves pinned skills through the signed Automation run correlation", async () => {
    let queryValues: unknown[] = [];
    const db = (async (
      _strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      queryValues = values;
      return [
        {
          skills: JSON.stringify([
            { name: "pinned", content: "Frozen instructions." },
          ]),
        },
      ];
    }) as unknown as DbClient;

    const skills = await resolveAutomationRunSkills(
      {
        conversationId: "agent-1_automation_42_run_99",
        organizationId: "org-1",
        agentId: "agent-1",
      },
      db
    );

    expect(skills).toEqual([
      { name: "pinned", content: "Frozen instructions." },
    ]);
    expect(queryValues).toContain("agent-1");
    expect(queryValues).toContain(42);
    expect(queryValues).toContain(99);
    expect(queryValues).toContain("org-1");
  });

  test.each([undefined, "synthetic-org"])("keeps settings scoped to the token's org: %s", async organizationId => {
    const getSettings = mock(async () => ({
      skillsConfig: { skills: [{ name: "tenant-skill", enabled: true, content: "Tenant instructions" }] },
    }));
    const getSessionContext = mock(async () => ({
      agentLayers: { identityMd: "", soulMd: "", userMd: "", unconfiguredNotice: "" },
      platformInstructions: "", networkInstructions: "", skillsInstructions: "", mcpStatus: [],
    }));
    const gateway = new WorkerGateway(
      { send: async () => undefined } as never,
      "https://gateway.example.test",
      { getWorkerConfig: async () => ({ mcpServers: {} }) } as never,
      { getSessionContext } as never,
      undefined,
      { isDeclaredAgent: () => false, getSettings } as never,
    );
    const token = generateWorkerToken("synthetic-user", "synthetic-conversation", "synthetic-worker", {
      channelId: "synthetic-channel", agentId: "synthetic-shared-agent", organizationId,
    });
    const response = await gateway.getApp().request("/session-context", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty("providerConfig");
    expect(getSessionContext).toHaveBeenCalledWith("unknown", expect.objectContaining({
      organizationId, orgScoped: Boolean(organizationId),
    }), expect.any(Object));
    if (organizationId) {
      expect(getSettings).toHaveBeenCalledWith("synthetic-shared-agent", { organizationId });
      expect(body.skillsConfig).toEqual([{ name: "tenant-skill", content: "Tenant instructions" }]);
    } else {
      expect(getSettings).not.toHaveBeenCalled();
      expect(body.skillsConfig).toEqual([]);
    }
  });
});
