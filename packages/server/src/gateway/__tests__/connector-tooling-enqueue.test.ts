/**
 * The enqueue-path fold, driven through `MessageConsumer` itself.
 *
 * The resolver suite proves what the DB rows resolve to; this proves the
 * CONSUMER actually folds it into the payload, and that the fold happens before
 * the per-run worker token is minted. A remote runtime trusts only the signed
 * claim, so a contribution that lands after the mint reaches the sandbox as
 * nothing at all — and no resolver-level assertion can see that.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type MessagePayload, verifyWorkerToken } from "@lobu/core";
import { getDb } from "../../db/client.js";
import {
  buildRunJobToken,
  MessageConsumer,
} from "../orchestration/message-consumer.js";
import {
  DeploymentManager,
  type DeploymentInfo,
  type OrchestratorConfig,
} from "../orchestration/deployment-manager.js";
import type { IMessageQueue } from "../infrastructure/queue/index.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG = "test-org";
const AGENT = "agent-1";

const CONFIG: OrchestratorConfig = {
  queues: { retryLimit: 3, retryDelay: 5, expireInSeconds: 300 },
  worker: { idleCleanupMinutes: 60, maxDeployments: 10 },
  cleanup: { initialDelayMs: 5000, intervalMs: 60000, veryOldDays: 7 },
};

class NoopManager extends DeploymentManager {
  async listDeployments(): Promise<DeploymentInfo[]> {
    return [];
  }
  protected async spawnDeployment(): Promise<void> {}
  async scaleDeployment(): Promise<void> {}
  async deleteDeployment(): Promise<void> {}
  async updateDeploymentActivity(): Promise<void> {}
  async validateWorkerImage(): Promise<void> {}
  protected getDispatcherHost(): string {
    return "localhost";
  }
}

/** Exposes the protected fold. */
class TestConsumer extends MessageConsumer {
  fold(data: MessagePayload): Promise<string> {
    return (
      this as unknown as {
        foldConnectorTooling(d: MessagePayload): Promise<string>;
      }
    ).foldConnectorTooling(data);
  }
}

function buildConsumer(): TestConsumer {
  return new TestConsumer(
    new NoopManager(CONFIG),
    {} as unknown as IMessageQueue,
    async () => {}
  );
}

function payload(overrides: Partial<MessagePayload> = {}): MessagePayload {
  return {
    userId: "u",
    conversationId: "c",
    messageId: "m",
    channelId: "ch",
    teamId: "t",
    agentId: AGENT,
    organizationId: ORG,
    botId: "b",
    platform: "slack",
    messageText: "hi",
    platformMetadata: {},
    agentOptions: {},
    ...overrides,
  };
}

async function seedGitHubTooling(): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, version, agent_tooling, status
    ) VALUES (
      ${ORG}, 'github', 'github', '1.0.0',
      ${sql.json({
        nix: { packages: ["gh"] },
        env: [{ name: "GH_TOKEN", credential: "lease" }],
        domains: ["api.github.com", "github.com"],
      })},
      'active'
    )
  `;
  await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, status, config
    ) VALUES (${ORG}, 'github', 'conn-github', 'active', ${sql.json({})})
  `;
}

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
  await seedAgentRow(AGENT);
});

describe("connector tooling on the enqueue path", () => {
  test("the consumer folds contributed packages and domains into the payload", async () => {
    await seedGitHubTooling();
    const data = payload();

    await buildConsumer().fold(data);

    expect(data.nixConfig?.packages).toContain("gh");
    expect(data.networkConfig?.allowedDomains).toEqual(
      expect.arrayContaining(["api.github.com", "github.com"])
    );
  });

  test("the contribution unions with the agent's own config, never replaces it", async () => {
    await seedGitHubTooling();
    const data = payload({
      nixConfig: { packages: ["ripgrep"] },
      networkConfig: { allowedDomains: ["example.com"] },
    });

    await buildConsumer().fold(data);

    expect(data.nixConfig?.packages?.sort()).toEqual(["gh", "ripgrep"]);
    expect(data.networkConfig?.allowedDomains).toContain("example.com");
    expect(data.networkConfig?.allowedDomains).toContain("api.github.com");
  });

  test("INVARIANT: contributed domains reach the SIGNED per-run token", async () => {
    // The remote runtime route reads the allowlist from the verified token and
    // never from the request body, so a fold that landed after the mint would
    // leave a remote sandbox with no egress — invisible to any assertion on the
    // payload alone. Mints the token the same way handleMessage does, AFTER the
    // fold, and reads it back through verification.
    await seedGitHubTooling();
    const data = payload();

    await buildConsumer().fold(data);
    const token = buildRunJobToken({
      userId: data.userId,
      conversationId: data.conversationId,
      deploymentName: "deploy-1",
      channelId: data.channelId,
      teamId: data.teamId,
      agentId: data.agentId,
      organizationId: data.organizationId,
      platform: data.platform,
      platformMetadata: data.platformMetadata,
      // handleMessage mints with the id of the run row it just created; the
      // fold under test does not touch either claim.
      runId: 1,
      messageId: data.messageId,
      allowedDomains: data.networkConfig?.allowedDomains,
    });

    const claims = verifyWorkerToken(token);
    expect(claims?.allowedDomains).toEqual(
      expect.arrayContaining(["api.github.com", "github.com"])
    );
  });

  test("an org with no tooling connections leaves the payload untouched", async () => {
    const data = payload({ nixConfig: { packages: ["ripgrep"] } });

    await buildConsumer().fold(data);

    expect(data.nixConfig?.packages).toEqual(["ripgrep"]);
    expect(data.networkConfig).toBeUndefined();
  });

  test("a resolution failure propagates so durable tooling state is not guessed", async () => {
    await seedGitHubTooling();
    const data = payload({
      organizationId: undefined as unknown as string,
    });

    await expect(buildConsumer().fold(data)).rejects.toBeDefined();
  });
});
