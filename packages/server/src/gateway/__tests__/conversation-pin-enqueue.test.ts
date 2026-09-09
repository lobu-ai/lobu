/**
 * Conversation sandbox pins are a dispatch boundary: a remote runtime trusts
 * the signed per-run token and does not resolve the conversation realm again.
 * A resolver error must therefore retry the durable message before any token
 * is minted or any worker input is delivered. A successful resolution keeps
 * stamping the immutable provider + sandbox pin into that token.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as core from "@lobu/core";
import type { MessagePayload } from "@lobu/core";
import type { AgentRuntimeSelection } from "../../lobu/stores/sandbox-store.js";
import type { IMessageQueue } from "../infrastructure/queue/index.js";
import type {
  DeploymentManager,
} from "../orchestration/deployment-manager.js";
import { generateDeploymentName } from "../orchestration/deployment-manager.js";
import { ensureEncryptionKey } from "./helpers/db-setup.js";

const mintWorkerToken = spyOn(core, "generateWorkerToken");
const { TestMessageConsumer } = await import("./helpers/test-message-consumer.js");
const resolveRuntimeSelection = mock(
  async (): Promise<AgentRuntimeSelection> => ({}),
);

class PinTestMessageConsumer extends TestMessageConsumer {
  protected resolveRuntimeSelection(): Promise<AgentRuntimeSelection> {
    return resolveRuntimeSelection();
  }
}

const DEPLOYMENT_NAME = generateDeploymentName({
  organizationId: "org-1",
  agentId: "agent-1",
  userId: "user-1",
  platform: "slack",
  channelId: "chan-1",
  conversationId: "conv-1",
});

function payload(): MessagePayload {
  return {
    messageId: "msg-1",
    userId: "user-1",
    channelId: "chan-1",
    conversationId: "conv-1",
    platform: "slack",
    organizationId: "org-1",
    agentId: "agent-1",
    messageText: "hi",
    platformMetadata: {},
  } as MessagePayload;
}

/**
 * `workerInputs` used to be filled from the queue's `thread_message_*` sends —
 * the managed subprocess lane's worker queue, now deleted. The pinned token is
 * stamped onto the payload well before the turn is produced, and
 * `recordRunInput` is the first seam that sees it, so the capture moves there.
 * Same payload, same token, same assertions.
 */
function makeQueue(): {
  queue: IMessageQueue;
  workerInputs: MessagePayload[];
  recordInput: (payload: MessagePayload, deploymentName: string) => Promise<void>;
} {
  const workerInputs: MessagePayload[] = [];
  const queue = {
    start: mock(async () => {}),
    stop: mock(async () => {}),
    createQueue: mock(async () => {}),
    send: mock(async () => "job-1"),
    work: mock(async () => {}),
    pauseWorker: mock(async () => {}),
    resumeWorker: mock(async () => {}),
    getQueueStats: mock(async () => ({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
    })),
    isHealthy: mock(() => true),
  } as unknown as IMessageQueue;
  const recordInput = async (payload: MessagePayload) => {
    workerInputs.push({ ...payload } as MessagePayload);
  };
  return { queue, workerInputs, recordInput };
}

function makeDeploymentManager(): DeploymentManager {
  return {
    listDeployments: mock(async () => [
      { deploymentName: DEPLOYMENT_NAME, status: "running" },
    ]),
    scaleDeployment: mock(async () => {}),
    updateDeploymentActivity: mock(async () => {}),
    syncNetworkConfigGrants: mock(async () => {}),
    createWorkerDeployment: mock(async () => {}),
    getProviderCatalogService: () => undefined,
  } as unknown as DeploymentManager;
}

async function handle(
  consumer: PinTestMessageConsumer,
  data: MessagePayload,
): Promise<void> {
  await (
    consumer as unknown as {
      handleMessage: (job: unknown) => Promise<void>;
    }
  ).handleMessage({ id: "1", data });
}

beforeAll(() => {
  ensureEncryptionKey();
});

beforeEach(() => {
  resolveRuntimeSelection.mockReset();
  mintWorkerToken.mockClear();
});

afterAll(() => {
  mintWorkerToken.mockRestore();
});

describe("conversation pin at the message-consumer chokepoint", () => {
  test("resolver failure retries before token mint or worker delivery", async () => {
    resolveRuntimeSelection.mockRejectedValue(
      new Error("pin database unavailable"),
    );
    const { queue, workerInputs, recordInput } = makeQueue();
    const data = payload();
    const consumer = new PinTestMessageConsumer(
      makeDeploymentManager(),
      queue,
      recordInput,
    );

    const dispatch = handle(consumer, data);

    await expect(dispatch).rejects.toMatchObject({
      code: core.ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
      shouldRetry: true,
    });
    expect(mintWorkerToken).not.toHaveBeenCalled();
    expect(data.runJobToken).toBeUndefined();
    expect(workerInputs).toHaveLength(0);
  });

  test("resolved realm remains pinned in the per-run worker token", async () => {
    resolveRuntimeSelection.mockResolvedValue({
      runtimeProviderId: "vercel",
      sandboxId: "sbx-pinned",
    });
    const { queue, workerInputs, recordInput } = makeQueue();
    const consumer = new PinTestMessageConsumer(
      makeDeploymentManager(),
      queue,
      recordInput,
    );

    // The producer needs Postgres. The pin is stamped before it runs.
    await handle(consumer, payload()).catch(() => {});

    expect(mintWorkerToken).toHaveBeenCalledTimes(1);
    expect(workerInputs).toHaveLength(1);
    const token = workerInputs[0]?.runJobToken;
    expect(token).toBeTruthy();
    expect(core.verifyWorkerToken(token as string)).toMatchObject({
      runtimeProviderId: "vercel",
      sandboxId: "sbx-pinned",
    });
  });

  test("a successful no-realm resolution still delivers an unpinned token", async () => {
    resolveRuntimeSelection.mockResolvedValue({});
    const { queue, workerInputs, recordInput } = makeQueue();
    const consumer = new PinTestMessageConsumer(
      makeDeploymentManager(),
      queue,
      recordInput,
    );

    // The producer needs Postgres. The pin is stamped before it runs.
    await handle(consumer, payload()).catch(() => {});

    expect(mintWorkerToken).toHaveBeenCalledTimes(1);
    expect(workerInputs).toHaveLength(1);
    const token = workerInputs[0]?.runJobToken;
    expect(token).toBeTruthy();
    const claims = core.verifyWorkerToken(token as string);
    expect(claims?.runtimeProviderId).toBeUndefined();
    expect(claims?.sandboxId).toBeUndefined();
  });
});
