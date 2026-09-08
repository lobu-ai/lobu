/**
 * Hardening tests for gateway orchestration.
 *
 * Covers:
 *  1. Automation-run-race regression — classifyQueue never maps to
 *     'automation', so RunsQueue can never claim connector-worker lanes.
 *  2. invalidateGrantSyncCache / clearAllGrantSyncCaches.
 *  3. generateDeploymentName / buildCanonicalConversationKey determinism.
 *  4. backoffSeconds correctness.
 *
 * The worker-lifecycle sections this file used to carry (spawn failure,
 * systemd wrapping, child-process exit, killWorker double-exit, workspace dir
 * creation, WORKER_ENV_* passthrough, maxDeployments, startup readiness) tested
 * the subprocess lane and went with it. Nix package-name injection keeps its
 * coverage in `__tests__/unit/nix-package-attr-ref.test.ts`, which asserts the
 * sanitizer directly rather than through a spawn.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { ErrorCode, OrchestratorError } from "@lobu/core";

// ── Mock child_process.spawn ─────────────────────────────────────────────────

type MockChildProcess = EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof mock>;
};

const mockChildProcesses: MockChildProcess[] = [];
const mockSpawn = mock(() => createMockChildProcess());

function createMockChildProcess(): MockChildProcess {
  const cp = new EventEmitter() as MockChildProcess;
  cp.pid = Math.floor(Math.random() * 100_000) + 1;
  cp.exitCode = null;
  cp.signalCode = null;
  cp.killed = false;
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.kill = mock((signal?: string) => {
    if (cp.exitCode !== null || cp.signalCode !== null) return false;
    cp.killed = true;
    if (signal === "SIGKILL") {
      cp.exitCode = 137;
      cp.signalCode = null;
    } else {
      cp.exitCode = 0;
      cp.signalCode = signal ?? "SIGTERM";
    }
    cp.emit("exit", cp.exitCode, cp.signalCode);
    return true;
  });
  mockChildProcesses.push(cp);
  return cp;
}

mock.module("node:child_process", () => ({
  spawn: mockSpawn,
  // execFileSync is used by locateSystemdRun; not needed when LOBU_DISABLE_SYSTEMD_RUN=1
  execFileSync: mock(() => ""),
}));

// ── Import classes after mock ────────────────────────────────────────────────

import type { MessagePayload } from "@lobu/core";
import {
  __resetCapabilityProbesForTests,
  buildCanonicalConversationKey,
  DeploymentManager,
  generateDeploymentName,
  type OrchestratorConfig,
} from "../orchestration/deployment-manager.js";
import {
  backoffSeconds,
  classifyQueue,
} from "../infrastructure/queue/runs-queue.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

const TEST_CONFIG: OrchestratorConfig = {
  queues: {
    retryLimit: 3,
    retryDelay: 5,
    expireInSeconds: 300,
  },
  worker: {
    binPathEntries: ["/fake/node_modules/.bin"],
    idleCleanupMinutes: 30,
    maxDeployments: 10,
  },
  cleanup: {
    initialDelayMs: 5_000,
    intervalMs: 60_000,
    veryOldDays: 7,
  },
};

function makePayload(overrides?: Partial<MessagePayload>): MessagePayload {
  return {
    userId: "user-1",
    conversationId: "conv-1",
    channelId: "ch-1",
    messageId: "msg-1",
    teamId: "team-1",
    agentId: "testagent",
    botId: "bot-1",
    platform: "slack",
    messageText: "hello",
    platformMetadata: {},
    agentOptions: {},
    ...overrides,
  } as MessagePayload;
}

function makeManager(overrides?: Partial<OrchestratorConfig>): DeploymentManager {
  return new DeploymentManager({ ...TEST_CONFIG, ...overrides });
}

// ── Suite setup ──────────────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "ENCRYPTION_KEY",
  "LOBU_DISABLE_SYSTEMD_RUN",
  "WORKER_ENV_FOO",
  "WORKER_ENV_BAR",
  "MY_SECRET_KEY",
];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.LOBU_DISABLE_SYSTEMD_RUN = "1";
  mockChildProcesses.length = 0;
  mockSpawn.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ============================================================================
// 1. AUTOMATION-RUN-RACE REGRESSION
// ============================================================================

describe("automation-run-race regression — classifyQueue never emits connector lanes", () => {
  const CONNECTOR_LANES = ["sync", "action", "embed_backfill", "automation", "auth"];

  test("none of the connector run_types appear in LOBU_RUN_TYPES", () => {
    // classifyQueue maps any queueName to one of the lobu-queue run_types.
    // It must NEVER return a connector-worker lane so RunsQueue.claimOne()
    // cannot accidentally pick up automation/sync/action rows.
    const lobuRunTypes = new Set([
      "chat_message",
      "schedule",
      "agent_run",
      "internal",
      "task",
    ]);

    for (const lane of CONNECTOR_LANES) {
      // Simulate a queue name that a naive mapper might classify as the connector lane
      const result = classifyQueue(lane);
      expect(lobuRunTypes.has(result)).toBe(true);
      expect(CONNECTOR_LANES).not.toContain(result);
    }
  });

  test("automation queue-name input does not classify as automation run_type", () => {
    // The bug: connector-worker used to poll runs WHERE run_type='automation'.
    // The fix: lobu queue daemon uses run_type derived from classifyQueue()
    // which never returns 'automation'.
    expect(classifyQueue("automation")).not.toBe("automation");
    expect(classifyQueue("automation:123")).not.toBe("automation");
    expect(classifyQueue("automation_run")).not.toBe("automation");
  });

  test("sync, action, auth queue names map to lobu lanes, not connector lanes", () => {
    // These names should not leak out as connector run_types.
    const bad = ["sync", "action", "auth", "embed_backfill"];
    for (const name of bad) {
      const mapped = classifyQueue(name);
      expect(mapped).not.toBe(name); // Should not be an identity pass-through
    }
  });

  test("all known lobu queue patterns map to correct run_types", () => {
    expect(classifyQueue("messages")).toBe("chat_message");
    expect(classifyQueue("thread_message_lobu-worker-xyz")).toBe("chat_message");
    expect(classifyQueue("schedule")).toBe("schedule");
    expect(classifyQueue("schedule:daily")).toBe("schedule");
    expect(classifyQueue("agent_run")).toBe("agent_run");
    expect(classifyQueue("agent_run:abc123")).toBe("agent_run");
    expect(classifyQueue("internal")).toBe("internal");
    expect(classifyQueue("internal:sweep")).toBe("internal");
    expect(classifyQueue("task")).toBe("task");
    expect(classifyQueue("task:cron-tick")).toBe("task");
  });
});

// ============================================================================
// 2. SPAWN FAILURE HANDLING
// ============================================================================

describe("grant sync cache — invalidateGrantSyncCache / clearAllGrantSyncCaches", () => {
  test("invalidateGrantSyncCache does not throw for unknown agent", () => {
    const mgr = makeManager();
    expect(() => mgr.invalidateGrantSyncCache("nonexistent")).not.toThrow();
  });

  test("clearAllGrantSyncCaches does not throw", () => {
    const mgr = makeManager();
    expect(() => mgr.clearAllGrantSyncCaches()).not.toThrow();
  });

  test("syncNetworkConfigGrants is a no-op when no agentId", async () => {
    const mgr = makeManager();
    // messageData without agentId
    const msg = { ...makePayload(), agentId: "" } as MessagePayload;
    await expect(mgr.syncNetworkConfigGrants(msg)).resolves.toBeUndefined();
  });

  test("syncNetworkConfigGrants is a no-op when no grantStore", async () => {
    const mgr = makeManager();
    const msg = makePayload();
    // No grantStore injected — should not throw
    await expect(mgr.syncNetworkConfigGrants(msg)).resolves.toBeUndefined();
  });
});

// ============================================================================
// 11. generateDeploymentName / buildCanonicalConversationKey DETERMINISM
// ============================================================================

describe("generateDeploymentName / buildCanonicalConversationKey", () => {
  test("same identity always produces the same deployment name", () => {
    const identity = {
      userId: "u1",
      conversationId: "c1",
      channelId: "ch1",
      platform: "slack",
      agentId: "a1",
      organizationId: "org1",
    };
    const name1 = generateDeploymentName(identity);
    const name2 = generateDeploymentName(identity);
    expect(name1).toBe(name2);
  });

  test("different conversationIds produce different deployment names", () => {
    const base = {
      userId: "u1",
      channelId: "ch1",
      platform: "slack",
      agentId: "a1",
      organizationId: "org1",
    };
    const n1 = generateDeploymentName({ ...base, conversationId: "c1" });
    const n2 = generateDeploymentName({ ...base, conversationId: "c2" });
    expect(n1).not.toBe(n2);
  });

  test("different platforms produce different deployment names", () => {
    const base = {
      userId: "u1",
      channelId: "ch1",
      conversationId: "c1",
      agentId: "a1",
      organizationId: "org1",
    };
    const n1 = generateDeploymentName({ ...base, platform: "slack" });
    const n2 = generateDeploymentName({ ...base, platform: "telegram" });
    expect(n1).not.toBe(n2);
  });

  test("different agentIds in the same channel/thread produce different deployment names", () => {
    const base = {
      userId: "u1",
      channelId: "ch1",
      conversationId: "c1",
      platform: "slack",
      organizationId: "org1",
    };
    const n1 = generateDeploymentName({ ...base, agentId: "agent-a" });
    const n2 = generateDeploymentName({ ...base, agentId: "agent-b" });
    expect(n1).not.toBe(n2);
  });

  test("different organizationIds produce different deployment names", () => {
    const base = {
      userId: "u1",
      channelId: "ch1",
      conversationId: "c1",
      platform: "slack",
      agentId: "agent-a",
    };
    const n1 = generateDeploymentName({ ...base, organizationId: "org1" });
    const n2 = generateDeploymentName({ ...base, organizationId: "org2" });
    expect(n1).not.toBe(n2);
  });

  test("deployment name is filesystem-safe (no special chars)", () => {
    const name = generateDeploymentName({
      userId: "u1",
      conversationId: "c1",
      channelId: "ch1",
      platform: "slack",
      agentId: "a1",
      organizationId: "org1",
    });
    expect(/^[a-z0-9-]+$/.test(name)).toBe(true);
  });

  test("buildCanonicalConversationKey with platform+channelId", () => {
    const key = buildCanonicalConversationKey({
      conversationId: "conv",
      channelId: "ch",
      platform: "slack",
      agentId: "a1",
      organizationId: "org1",
    });
    expect(key).toBe("org1:a1:slack:ch:conv");
  });

  test("buildCanonicalConversationKey without platform falls back to channelId", () => {
    const key = buildCanonicalConversationKey({
      conversationId: "conv",
      channelId: "ch",
      agentId: "a1",
      organizationId: "org1",
    });
    expect(key).toBe("org1:a1:ch:conv");
  });

  test("buildCanonicalConversationKey without channelId falls back to conversationId", () => {
    const key = buildCanonicalConversationKey({
      conversationId: "conv",
      agentId: "a1",
      organizationId: "org1",
    });
    expect(key).toBe("org1:a1:conv");
  });
});

// ============================================================================
// 12. backoffSeconds — retry/backoff correctness
// ============================================================================

describe("backoffSeconds — retry/backoff correctness", () => {
  test("attempt 0 → 1s", () => expect(backoffSeconds(0)).toBe(1));
  test("attempt 1 → 2s", () => expect(backoffSeconds(1)).toBe(2));
  test("attempt 2 → 4s", () => expect(backoffSeconds(2)).toBe(4));
  test("attempt 3 → 8s", () => expect(backoffSeconds(3)).toBe(8));
  test("attempt 4 → 16s", () => expect(backoffSeconds(4)).toBe(16));
  test("attempt 5 → 32s", () => expect(backoffSeconds(5)).toBe(32));
  test("attempt 9 → 512s but capped at 300s", () => expect(backoffSeconds(9)).toBe(300));
  test("very large attempt → 300s", () => expect(backoffSeconds(100)).toBe(300));
  test("negative attempt treated as 0 → 1s", () => expect(backoffSeconds(-1)).toBe(1));
});

// ============================================================================
// 13. CONCURRENT CALLS FOR DIFFERENT DEPLOYMENT NAMES
// ============================================================================
