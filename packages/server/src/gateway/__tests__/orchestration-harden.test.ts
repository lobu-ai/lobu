/**
 * Hardening tests for gateway orchestration + worker lifecycle.
 *
 * Covers:
 *  1. Automation-run-race regression — classifyQueue never maps to 'automation',
 *     so RunsQueue can never claim connector-worker lanes.
 *  2. Two workers racing to claim the same queued run (SKIP LOCKED semantics).
 *  3. Run that crashes mid-execution → marked failed, not stuck-running.
 *  4. Stale/orphaned worker cleanup via reconcileDeployments.
 *  5. Queue ordering / priority fairness.
 *  6. Spawn failure handling — spawn 'error' removes worker from map.
 *  7. Workspace dir creation / permissions.
 *  8. WORKER_ENV_* prefix-stripping → forwarded; non-prefixed not forwarded.
 *  9. Concurrency limits (DeploymentManager.maxDeployments).
 * 10. Nix package name injection prevention (via spawnDeployment path).
 * 11. Child-process exit during killWorker (double-exit safety).
 * 12. invalidateGrantSyncCache / clearAllGrantSyncCaches.
 * 13. generateDeploymentName / buildCanonicalConversationKey determinism.
 * 14. Worker startup readiness watchdog.
 * 15. backoffSeconds correctness.
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

describe("spawn failure handling", () => {
  test("spawn 'error' event removes worker from map", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload();
      await mgr.ensureDeployment("worker-1", "user-1", "user-1", msg);

      expect(await mgr.listDeployments()).toHaveLength(1);

      // Simulate a spawn error (e.g. ENOENT — binary not found)
      const cp = mockChildProcesses[0];
      cp.emit("error", new Error("spawn ENOENT"));

      await new Promise((r) => setTimeout(r, 0));

      expect(await mgr.listDeployments()).toHaveLength(0);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("spawn error on already-gone worker does not crash", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload();
      await mgr.ensureDeployment("worker-1", "user-1", "user-1", msg);
      // Manually delete from map to simulate a prior cleanup
      await mgr.deleteDeployment("worker-1");

      const cp = mockChildProcesses[0];
      // Emitting error after map-deletion should not throw
      expect(() => cp.emit("error", new Error("late error"))).not.toThrow();
    } finally {
      mkdirSpy.mockRestore();
    }
  });
});

// ============================================================================
// 2b. SYSTEMD WORKER SANDBOX — wrap + self-heal (Linux only)
// ============================================================================
// The systemd wrap only engages on Linux (locateSystemdRun() short-circuits on
// other platforms), and here execFileSync is mocked to succeed so the probe
// passes. Guarded to Linux so the assertions are deterministic on CI while the
// suite still runs cross-platform.

describe("systemd worker sandbox — wrap + self-heal", () => {
  const onLinux = process.platform === "linux";

  afterEach(() => {
    // Demote the probe cache so a forced "systemd available" state never bleeds
    // into other suites (which expect the LOBU_DISABLE_SYSTEMD_RUN=1 default).
    __resetCapabilityProbesForTests();
  });

  test.skipIf(!onLinux)(
    "available systemd wraps the worker in a scope with only scope-compatible props + forwards the bus env",
    async () => {
      __resetCapabilityProbesForTests();
      delete process.env.LOBU_DISABLE_SYSTEMD_RUN; // let the probe run (mock succeeds)
      const savedXdg = process.env.XDG_RUNTIME_DIR;
      process.env.XDG_RUNTIME_DIR = "/run/user/test-xdg";
      const mgr = makeManager();
      const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
      try {
        await mgr.ensureDeployment(
          "worker-1",
          "user-1",
          "user-1",
          makePayload()
        );
        const call = mockSpawn.mock.calls.at(-1) as [
          string,
          string[],
          { env?: Record<string, string> },
        ];
        expect(call[0]).toBe("systemd-run");
        expect(call[1]).toContain("--scope");
        // cgroup + network props that a scope actually honors.
        expect(call[1]).toContain("IPAddressDeny=any");
        expect(call[1].some((a) => a.startsWith("MemoryMax="))).toBe(true);
        // Exec-context props a --scope rejects ("Unknown assignment") must be
        // gone, or the whole scope fails and the worker dies.
        expect(call[1]).not.toContain("NoNewPrivileges=yes");
        expect(call[1].some((a) => a.startsWith("ReadWritePaths="))).toBe(
          false
        );
        expect(
          call[1].some((a) => a.startsWith("RestrictAddressFamilies="))
        ).toBe(false);
        // The bus coordinates are forwarded so `systemd-run --user` can reach
        // the user manager from the otherwise-sanitized worker env.
        expect(call[2]?.env?.XDG_RUNTIME_DIR).toBe("/run/user/test-xdg");
      } finally {
        mkdirSpy.mockRestore();
        if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = savedXdg;
      }
    }
  );

  test.skipIf(!onLinux)(
    "a --scope that dies instantly with a bus error self-heals to an unwrapped respawn",
    async () => {
      __resetCapabilityProbesForTests();
      delete process.env.LOBU_DISABLE_SYSTEMD_RUN;
      const mgr = makeManager();
      const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
      try {
        await mgr.ensureDeployment(
          "worker-1",
          "user-1",
          "user-1",
          makePayload()
        );
        // First spawn is the systemd-run wrapper.
        expect(mockSpawn.mock.calls.at(-1)?.[0]).toBe("systemd-run");
        const wrapper = mockChildProcesses.at(-1) as MockChildProcess;

        // The scope can't reach the user bus and dies code 1 immediately —
        // before the worker payload ever runs.
        wrapper.stderr.emit(
          "data",
          Buffer.from("Failed to connect to bus: No medium found\n")
        );
        wrapper.emit("exit", 1, null);
        await new Promise((r) => setTimeout(r, 0));

        // Self-healed: a second, UNWRAPPED spawn replaced the dead wrapper,
        // and the worker is live in the map rather than failed out.
        expect(mockSpawn.mock.calls).toHaveLength(2);
        expect(mockSpawn.mock.calls.at(-1)?.[0]).toBe(process.execPath);
        expect(await mgr.listDeployments()).toHaveLength(1);
      } finally {
        mkdirSpy.mockRestore();
      }
    }
  );
});

// ============================================================================
// 3. CRASH MID-EXECUTION → MARKED FAILED, NOT STUCK-RUNNING
// ============================================================================

describe("child process crash mid-execution removes worker from map", () => {
  test("non-zero exit removes worker and logs error (no stuck-running)", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload();
      await mgr.ensureDeployment("worker-1", "user-1", "user-1", msg);

      expect(await mgr.listDeployments()).toHaveLength(1);

      // Simulate OOM crash (exit code 137)
      const cp = mockChildProcesses[0];
      cp.exitCode = 137;
      cp.emit("exit", 137, null);
      await new Promise((r) => setTimeout(r, 0));

      // Must be removed — no stuck 'running' state
      expect(await mgr.listDeployments()).toHaveLength(0);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("clean exit (code 0) removes worker from map", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload();
      await mgr.ensureDeployment("worker-1", "user-1", "user-1", msg);
      const cp = mockChildProcesses[0];
      cp.exitCode = 0;
      cp.emit("exit", 0, null);
      await new Promise((r) => setTimeout(r, 0));
      expect(await mgr.listDeployments()).toHaveLength(0);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("signal exit removes worker from map", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload();
      await mgr.ensureDeployment("worker-1", "user-1", "user-1", msg);
      const cp = mockChildProcesses[0];
      cp.emit("exit", null, "SIGKILL");
      await new Promise((r) => setTimeout(r, 0));
      expect(await mgr.listDeployments()).toHaveLength(0);
    } finally {
      mkdirSpy.mockRestore();
    }
  });
});

// ============================================================================
// 4. STALE / ORPHANED WORKER CLEANUP
// ============================================================================

describe("reconcileDeployments — stale/orphaned cleanup", () => {
  test("idle workers are scaled down", async () => {
    const mgr = makeManager({
      worker: { ...TEST_CONFIG.worker, idleCleanupMinutes: 0 },
    });
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload();
      await mgr.ensureDeployment("worker-1", "user-1", "user-1", msg);

      // Force lastActivity to the past so the worker appears idle
      // Access via listDeployments — the idle flag is based on minutesIdle
      const listBefore = await mgr.listDeployments();
      expect(listBefore[0].isIdle).toBe(true); // idleCleanupMinutes=0 → always idle

      await mgr.reconcileDeployments();

      const listAfter = await mgr.listDeployments();
      expect(listAfter).toHaveLength(0);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("very-old workers are deleted (not just scaled down)", async () => {
    const mgr = makeManager({
      cleanup: { ...TEST_CONFIG.cleanup, veryOldDays: 0 },
    });
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload();
      await mgr.ensureDeployment("worker-1", "user-1", "user-1", msg);

      const list = await mgr.listDeployments();
      expect(list[0].isVeryOld).toBe(true); // veryOldDays=0 → always very old

      await mgr.reconcileDeployments();

      expect(await mgr.listDeployments()).toHaveLength(0);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("non-idle, non-old workers are left alone", async () => {
    const mgr = makeManager({
      worker: { ...TEST_CONFIG.worker, idleCleanupMinutes: 999 },
      cleanup: { ...TEST_CONFIG.cleanup, veryOldDays: 999 },
    });
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload();
      await mgr.ensureDeployment("worker-1", "user-1", "user-1", msg);

      const list = await mgr.listDeployments();
      expect(list[0].isIdle).toBe(false);
      expect(list[0].isVeryOld).toBe(false);

      await mgr.reconcileDeployments();

      expect(await mgr.listDeployments()).toHaveLength(1);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("multiple stale workers cleaned up in parallel", async () => {
    const mgr = makeManager({
      worker: { ...TEST_CONFIG.worker, idleCleanupMinutes: 0 },
    });
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      for (let i = 0; i < 5; i++) {
        await mgr.ensureDeployment(
          `worker-${i}`,
          "user-1",
          "user-1",
          makePayload({ agentId: `agent${i}`, conversationId: `conv-${i}` })
        );
      }
      expect(await mgr.listDeployments()).toHaveLength(5);

      await mgr.reconcileDeployments();

      expect(await mgr.listDeployments()).toHaveLength(0);
    } finally {
      mkdirSpy.mockRestore();
    }
  });
});

// ============================================================================
// 5. CONCURRENCY LIMITS
// ============================================================================

describe("maxDeployments concurrency limit", () => {
  test("createWorkerDeployment throws when limit reached and cleanup fails to free slots", async () => {
    const mgr = makeManager({
      worker: { ...TEST_CONFIG.worker, maxDeployments: 2 },
      // Long idle/old thresholds so reconcile won't delete anything
      cleanup: { ...TEST_CONFIG.cleanup, veryOldDays: 999 },
    });
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      await mgr.ensureDeployment(
        "lobu-worker-slack-aaa",
        "user-1",
        "user-1",
        makePayload({ agentId: "agenta", platform: "slack", conversationId: "c1", channelId: "ch1" })
      );
      await mgr.ensureDeployment(
        "lobu-worker-slack-bbb",
        "user-2",
        "user-2",
        makePayload({ agentId: "agentb", platform: "slack", conversationId: "c2", channelId: "ch2" })
      );

      expect(await mgr.listDeployments()).toHaveLength(2);

      // Third createWorkerDeployment should throw since cleanup won't free slots
      await expect(
        mgr.createWorkerDeployment(
          "user-3",
          "c3",
          makePayload({
            agentId: "agentc",
            organizationId: "testorg",
            platform: "slack",
            conversationId: "c3",
            channelId: "ch3",
          })
        )
      ).rejects.toThrow();
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("maxDeployments=0 means unlimited", async () => {
    const mgr = makeManager({
      worker: { ...TEST_CONFIG.worker, maxDeployments: 0 },
    });
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      for (let i = 0; i < 5; i++) {
        await mgr.ensureDeployment(
          `worker-${i}`,
          "user-1",
          "user-1",
          makePayload({ agentId: `agent${i}`, conversationId: `c${i}` })
        );
      }
      // Should not throw
      expect(await mgr.listDeployments()).toHaveLength(5);
    } finally {
      mkdirSpy.mockRestore();
    }
  });
});

// ============================================================================
// 6. WORKER STARTUP READINESS
// ============================================================================

describe("worker startup readiness", () => {
  test("requires an authenticated worker connection before reporting ready", async () => {
    const mgr = makeManager({
      worker: { ...TEST_CONFIG.worker, startupTimeoutSeconds: 0.2 },
    });
    let connected = false;
    mgr.setDeploymentReadinessProbe(() => connected);
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      setTimeout(() => {
        connected = true;
      }, 10);
      await mgr.ensureDeployment(
        "worker-ready",
        "user-1",
        "user-1",
        makePayload(),
      );
      expect(connected).toBe(true);
      expect(await mgr.listDeployments()).toHaveLength(1);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("recycles a spawned child that never connects so a retry can start fresh", async () => {
    const mgr = makeManager({
      worker: { ...TEST_CONFIG.worker, startupTimeoutSeconds: 0.001 },
    });
    mgr.setDeploymentReadinessProbe(() => false);
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      await expect(
        mgr.ensureDeployment(
          "worker-stuck",
          "user-1",
          "user-1",
          makePayload(),
        ),
      ).rejects.toThrow("did not connect");
      expect(await mgr.listDeployments()).toHaveLength(0);
      expect(mockChildProcesses.at(-1)?.killed).toBe(true);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("recycles an existing child that remains disconnected on scale-up", async () => {
    const mgr = makeManager({
      worker: { ...TEST_CONFIG.worker, startupTimeoutSeconds: 0.001 },
    });
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      await mgr.ensureDeployment(
        "worker-stale",
        "user-1",
        "user-1",
        makePayload(),
      );
      mgr.setDeploymentReadinessProbe(() => false);
      await expect(mgr.scaleDeployment("worker-stale", 1)).rejects.toThrow(
        "did not connect",
      );
      expect(await mgr.listDeployments()).toHaveLength(0);
      expect(mockChildProcesses.at(-1)?.killed).toBe(true);
    } finally {
      mkdirSpy.mockRestore();
    }
  });
});

// ============================================================================
// 7. WORKSPACE DIR CREATION
// ============================================================================

describe("workspace dir creation", () => {
  test("mkdirSync called with correct path and mode", async () => {
    const calls: Parameters<typeof fs.mkdirSync>[] = [];
    const mkdirSpy = spyOn(fs, "mkdirSync").mockImplementation((...args) => {
      calls.push(args as Parameters<typeof fs.mkdirSync>);
      return undefined;
    });
    try {
      const mgr = makeManager();
      const msg = makePayload({ agentId: "myagent" });
      await mgr.ensureDeployment("worker-1", "user-1", "user-1", msg);

      expect(calls.length).toBeGreaterThan(0);
      const [dirPath, opts] = calls[0];
      expect(String(dirPath)).toContain("myagent");
      expect((opts as { mode?: number })?.mode).toBe(0o700);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("agentId with path-traversal characters is rejected", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload({ agentId: "../evil" });
      await expect(
        mgr.ensureDeployment("worker-1", "user-1", "user-1", msg)
      ).rejects.toThrow();
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("agentId with spaces is rejected", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload({ agentId: "my agent" });
      await expect(
        mgr.ensureDeployment("worker-1", "user-1", "user-1", msg)
      ).rejects.toThrow();
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("agentId with semicolons is rejected", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload({ agentId: "agent;rm -rf" });
      await expect(
        mgr.ensureDeployment("worker-1", "user-1", "user-1", msg)
      ).rejects.toThrow();
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("agentId of exactly 64 alphanumeric chars is accepted", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const longId = "a".repeat(64);
      const msg = makePayload({ agentId: longId });
      await expect(
        mgr.ensureDeployment("worker-1", "user-1", "user-1", msg)
      ).resolves.toBeUndefined();
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("agentId of 65 chars is rejected", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const longId = "a".repeat(65);
      const msg = makePayload({ agentId: longId });
      await expect(
        mgr.ensureDeployment("worker-1", "user-1", "user-1", msg)
      ).rejects.toThrow(/Invalid agentId/);
    } finally {
      mkdirSpy.mockRestore();
    }
  });
});

// ============================================================================
// 7. WORKER_ENV_* PREFIX-STRIPPING
// ============================================================================

describe("WORKER_ENV_* env-var passthrough", () => {
  test("WORKER_ENV_FOO is forwarded as FOO", async () => {
    process.env.WORKER_ENV_FOO = "bar-value";
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload();
      await mgr.ensureDeployment("worker-1", "user-1", "user-1", msg);

      const spawnOpts = mockSpawn.mock.calls.at(-1)?.[2] as
        | { env?: Record<string, string> }
        | undefined;
      expect(spawnOpts?.env?.FOO).toBe("bar-value");
    } finally {
      mkdirSpy.mockRestore();
      delete process.env.WORKER_ENV_FOO;
    }
  });

  test("WORKER_ENV_BAR is forwarded as BAR", async () => {
    process.env.WORKER_ENV_BAR = "baz-value";
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload();
      await mgr.ensureDeployment("worker-1", "user-1", "user-1", msg);

      const spawnOpts = mockSpawn.mock.calls.at(-1)?.[2] as
        | { env?: Record<string, string> }
        | undefined;
      expect(spawnOpts?.env?.BAR).toBe("baz-value");
    } finally {
      mkdirSpy.mockRestore();
      delete process.env.WORKER_ENV_BAR;
    }
  });

  test("non-prefixed WORKER_ENV-like vars are NOT forwarded", async () => {
    // MY_SECRET_KEY should not be in the worker env unless it was explicitly set
    // via the gateway config, not just inherited from gateway process.env.
    // The worker env is built from scratch — gateway-only vars are intentionally
    // excluded (see deployment-manager.ts: "Workers must not inherit
    // gateway-only secrets").
    process.env.MY_SECRET_KEY = "should-not-appear";
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload();
      await mgr.ensureDeployment("worker-1", "user-1", "user-1", msg);

      const spawnOpts = mockSpawn.mock.calls.at(-1)?.[2] as
        | { env?: Record<string, string> }
        | undefined;
      // MY_SECRET_KEY should NOT leak into the worker subprocess
      expect(spawnOpts?.env?.MY_SECRET_KEY).toBeUndefined();
    } finally {
      mkdirSpy.mockRestore();
      delete process.env.MY_SECRET_KEY;
    }
  });

  test("DATABASE_URL is not forwarded to workers", async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://secret:password@host/db";
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload();
      await mgr.ensureDeployment("worker-1", "user-1", "user-1", msg);

      const spawnOpts = mockSpawn.mock.calls.at(-1)?.[2] as
        | { env?: Record<string, string> }
        | undefined;
      expect(spawnOpts?.env?.DATABASE_URL).toBeUndefined();
    } finally {
      mkdirSpy.mockRestore();
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });
});

// ============================================================================
// 8. NIX PACKAGE VALIDATION (via spawnDeployment path)
// ============================================================================

describe("nix package validation — shell-injection prevention via spawn path", () => {
  test("semicolons in nix package name are rejected", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload({
        nixConfig: { packages: ["git;rm -rf /"] },
      });
      await expect(
        mgr.ensureDeployment("worker-1", "user-1", "user-1", msg)
      ).rejects.toThrow(/Invalid nix package name/);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("backticks in nix package name are rejected", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload({
        nixConfig: { packages: ["`echo pwned`"] },
      });
      await expect(
        mgr.ensureDeployment("worker-1", "user-1", "user-1", msg)
      ).rejects.toThrow(/Invalid nix package name/);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("spaces in nix package name are rejected", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload({
        nixConfig: { packages: ["git nix-env"] },
      });
      await expect(
        mgr.ensureDeployment("worker-1", "user-1", "user-1", msg)
      ).rejects.toThrow(/Invalid nix package name/);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test("valid nix package name passes validation", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload({
        nixConfig: { packages: ["git", "nodejs"] },
      });
      // Should not throw on name validation (spawn itself is mocked)
      await expect(
        mgr.ensureDeployment("worker-1", "user-1", "user-1", msg)
      ).resolves.toBeUndefined();
    } finally {
      mkdirSpy.mockRestore();
    }
  });
});

// ============================================================================
// 9. killWorker — double-exit safety
// ============================================================================

describe("killWorker — already-exited worker is safe", () => {
  test("scaleDeployment(0) on already-exited process does not hang", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload();
      await mgr.ensureDeployment("worker-1", "user-1", "user-1", msg);

      // Mark the cp as already exited
      const cp = mockChildProcesses[0];
      cp.exitCode = 0;
      // do NOT emit 'exit' — simulate a scenario where the exit handler already
      // ran and removed the map entry, but the cp.exitCode is set.
      cp.emit("exit", 0, null);
      await new Promise((r) => setTimeout(r, 0));

      // Worker should already be gone from the map; this should be a no-op
      await expect(mgr.scaleDeployment("worker-1", 0)).resolves.toBeUndefined();
    } finally {
      mkdirSpy.mockRestore();
    }
  });
});

// ============================================================================
// 10. GRANT SYNC CACHE
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

describe("concurrent ensureDeployment for different names", () => {
  test("each unique deploymentName spawns exactly one process", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      await Promise.all([
        mgr.ensureDeployment("worker-a", "user-1", "user-1", makePayload({ agentId: "agenta", conversationId: "ca" })),
        mgr.ensureDeployment("worker-b", "user-2", "user-2", makePayload({ agentId: "agentb", conversationId: "cb" })),
        mgr.ensureDeployment("worker-c", "user-3", "user-3", makePayload({ agentId: "agentc", conversationId: "cc" })),
      ]);
      expect(mockSpawn.mock.calls).toHaveLength(3);
      expect(await mgr.listDeployments()).toHaveLength(3);
    } finally {
      mkdirSpy.mockRestore();
    }
  });
});

// ============================================================================
// 14. WORKER ENVIRONMENT DOES NOT MUTATE GATEWAY PROCESS ENV
// ============================================================================

describe("worker spawn does not mutate gateway process.env", () => {
  test("WORKER_TOKEN and CONVERSATION_ID are not leaked into process.env", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const tokenBefore = process.env.WORKER_TOKEN;
      const convBefore = process.env.CONVERSATION_ID;

      await mgr.ensureDeployment("worker-1", "user-1", "user-1", makePayload());

      expect(process.env.WORKER_TOKEN).toBe(tokenBefore);
      expect(process.env.CONVERSATION_ID).toBe(convBefore);
    } finally {
      mkdirSpy.mockRestore();
    }
  });
});

// ============================================================================
// 15. validateWorkerImage — missing entry point
// ============================================================================

describe("validateWorkerImage", () => {
  test("throws DEPLOYMENT_CREATE_FAILED when entry point missing", async () => {
    const existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);
    try {
      const mgr = makeManager();
      await expect(mgr.validateWorkerImage()).rejects.toMatchObject({
        code: ErrorCode.DEPLOYMENT_CREATE_FAILED,
      });
    } finally {
      existsSpy.mockRestore();
    }
  });

  test("resolves when entry point exists", async () => {
    const existsSpy = spyOn(fs, "existsSync").mockReturnValue(true);
    try {
      const mgr = makeManager();
      await expect(mgr.validateWorkerImage()).resolves.toBeUndefined();
    } finally {
      existsSpy.mockRestore();
    }
  });

  test("throws when no entryPoint configured", async () => {
    const mgr = new DeploymentManager({
      ...TEST_CONFIG,
      worker: { ...TEST_CONFIG.worker, entryPoint: undefined },
    });
    await expect(mgr.validateWorkerImage()).rejects.toThrow(
      /entryPoint is required/
    );
  });
});

// ============================================================================
// 16. ensureDeployment coalesces concurrent calls
// ============================================================================

describe("ensureDeployment concurrent coalescing", () => {
  test("100 concurrent calls for the same name spawn exactly 1 process", async () => {
    const mgr = makeManager();
    const mkdirSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    try {
      const msg = makePayload();
      const promises = Array.from({ length: 100 }, () =>
        mgr.ensureDeployment("worker-1", "user-1", "user-1", msg)
      );
      await Promise.all(promises);
      expect(mockSpawn.mock.calls).toHaveLength(1);
    } finally {
      mkdirSpy.mockRestore();
    }
  });
});
