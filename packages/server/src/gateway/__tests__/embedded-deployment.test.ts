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
import path from "node:path";
import { ErrorCode, type MessagePayload, OrchestratorError } from "@lobu/core";
import type { OrchestratorConfig } from "../orchestration/deployment-manager.js";

// ---------------------------------------------------------------------------
// Mock child_process.spawn to return a fake ChildProcess
// ---------------------------------------------------------------------------
const mockChildProcesses: EventEmitter[] = [];
const mockSpawn = mock(() => createMockChildProcess());
// Capability probes (locateNixShell / locateSystemdRun) use execFileSync.
// Default: nix-shell is present so we can warm a positive cache; systemd-run
// is absent so workers spawn unwrapped in these unit tests.
const mockExecFileSync = mock((cmd: string) => {
  if (cmd === "nix-shell") return "nix-shell (Nix) 2.0";
  throw new Error(`ENOENT: ${cmd}`);
});

function createMockChildProcess() {
  const cp = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    killed: boolean;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof mock>;
  };
  cp.pid = Math.floor(Math.random() * 100000);
  cp.exitCode = null;
  cp.killed = false;
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.kill = mock((signal?: string) => {
    cp.killed = true;
    cp.exitCode = signal === "SIGKILL" ? 137 : 0;
    cp.emit("exit", cp.exitCode, signal);
    return true;
  });
  mockChildProcesses.push(cp);
  return cp;
}

mock.module("node:child_process", () => ({
  spawn: mockSpawn,
  execFileSync: mockExecFileSync,
}));

// ---------------------------------------------------------------------------
// Now import the class under test
// ---------------------------------------------------------------------------
import { DeploymentManager } from "../orchestration/deployment-manager.js";

// ---------------------------------------------------------------------------
// Test config & helpers
// ---------------------------------------------------------------------------
const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const originalDisableSystemdRun = process.env.LOBU_DISABLE_SYSTEMD_RUN;

const TEST_CONFIG: OrchestratorConfig = {
  queues: {
    connectionString: "postgres://localhost:5432/lobu",
    retryLimit: 3,
    retryDelay: 5,
    expireInSeconds: 300,
  },
  worker: {
    binPathEntries: ["/test/node_modules/.bin"],
    idleCleanupMinutes: 30,
    maxDeployments: 10,
  },
  cleanup: {
    initialDelayMs: 5000,
    intervalMs: 60000,
    veryOldDays: 7,
  },
};

function createTestMessagePayload(
  overrides?: Partial<MessagePayload>
): MessagePayload {
  return {
    userId: "user-1",
    conversationId: "conv-1",
    channelId: "ch-1",
    messageId: "msg-1",
    teamId: "team-1",
    agentId: "test-agent",
    botId: "bot-1",
    platform: "slack",
    messageText: "hello",
    platformMetadata: {},
    agentOptions: {},
    ...overrides,
  } as MessagePayload;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("DeploymentManager", () => {
  let manager: DeploymentManager;
  let mkdirSyncSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.LOBU_DISABLE_SYSTEMD_RUN = "1";
    manager = new DeploymentManager(TEST_CONFIG);
    mockChildProcesses.length = 0;
    mockSpawn.mockClear();
    mkdirSyncSpy = spyOn(fs, "mkdirSync").mockReturnValue(undefined);
  });

  afterEach(() => {
    mkdirSyncSpy.mockRestore();
    if (originalDisableSystemdRun === undefined) {
      delete process.env.LOBU_DISABLE_SYSTEMD_RUN;
    } else {
      process.env.LOBU_DISABLE_SYSTEMD_RUN = originalDisableSystemdRun;
    }
  });

  // =========================================================================
  // validateWorkerImage
  // =========================================================================
  describe("validateWorkerImage", () => {
    test("succeeds when worker entry point exists", async () => {
      const spy = spyOn(fs, "existsSync").mockReturnValue(true);
      await expect(manager.validateWorkerImage()).resolves.toBeUndefined();
      spy.mockRestore();
    });

    test("throws when worker entry point does not exist", async () => {
      const spy = spyOn(fs, "existsSync").mockReturnValue(false);
      try {
        await manager.validateWorkerImage();
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(OrchestratorError);
        expect((err as OrchestratorError).code).toBe(
          ErrorCode.DEPLOYMENT_CREATE_FAILED
        );
        expect((err as Error).message).toContain(
          "Worker entry point not found"
        );
      }
      spy.mockRestore();
    });
  });

  // =========================================================================
  // Lifecycle: create / list / scale / delete
  // =========================================================================
  describe("lifecycle", () => {
    test("ensureDeployment then listDeployments returns 1 entry", async () => {
      const msg = createTestMessagePayload();
      await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);
      const list = await manager.listDeployments();
      expect(list).toHaveLength(1);
      expect(list[0].deploymentName).toBe("worker-1");
      expect(list[0].replicas).toBe(1);
    });

    test("ensureDeployment spawns a child process", async () => {
      const msg = createTestMessagePayload();
      await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);
      expect(mockChildProcesses).toHaveLength(1);
      expect(mockChildProcesses[0]).toBeDefined();
      expect(mockSpawn.mock.calls.at(-1)?.[0]).toBe(process.execPath);
    });

    test("compiled worker entry points run with Node", async () => {
      const jsManager = new DeploymentManager({
        ...TEST_CONFIG,
        worker: {
          ...TEST_CONFIG.worker,
          entryPoint: "/test/packages/agent-worker/dist/index.js",
        },
      });
      const msg = createTestMessagePayload();

      await jsManager.ensureDeployment("worker-1", "user-1", "user-1", msg);

      const expectedNode = path.basename(process.execPath).startsWith("node")
        ? process.execPath
        : "node";
      expect(mockSpawn.mock.calls.at(-1)?.[0]).toBe(expectedNode);
      // The compiled (Node) worker is spawned with a V8 heap cap so a runaway
      // turn OOMs itself instead of the whole pod (buildWorkerInvocation).
      expect(mockSpawn.mock.calls.at(-1)?.[1]).toEqual([
        "--max-old-space-size=512",
        "/test/packages/agent-worker/dist/index.js",
      ]);
    });

    test("falls back to a plain spawn when nix packages are declared but nix-shell is absent", async () => {
      // Where nix-shell is unavailable (the prod app image bakes Chromium in
      // directly rather than via Nix), an agent that declares nix packages must
      // still spawn — degraded, without those packages — rather than crash the
      // worker with `spawn nix-shell ENOENT`. Force the absent path via the
      // operator flag so the test is deterministic regardless of host nix.
      const { __resetCapabilityProbesForTests } = await import(
        "../orchestration/deployment-manager.js"
      );
      const prev = process.env.LOBU_DISABLE_NIX_SHELL;
      delete process.env.LOBU_DISABLE_NIX_SHELL;
      __resetCapabilityProbesForTests();
      try {
        // Warm spawn: mock execFileSync reports nix-shell present, so this
        // wraps with nix-shell and caches a positive probe.
        const msgWarm = createTestMessagePayload({
          agentId: "agent-nix-warm",
          conversationId: "conv-nix-warm",
          nixConfig: { packages: ["chromium"] },
        });
        await manager.ensureDeployment(
          "worker-nix-warm",
          "user-1",
          "user-1",
          msgWarm
        );
        expect(mockSpawn.mock.calls.at(-1)?.[0]).toBe("nix-shell");

        process.env.LOBU_DISABLE_NIX_SHELL = "1";
        // Deliberately do NOT reset the capability probe cache — the kill-
        // switch must override a sticky positive cache.
        const msg = createTestMessagePayload({
          agentId: "agent-nix",
          conversationId: "conv-nix",
          nixConfig: { packages: ["chromium"] },
        });
        await manager.ensureDeployment("worker-nix", "user-1", "user-1", msg);
        const cmd = mockSpawn.mock.calls.at(-1)?.[0];
        // NOT nix-shell — fell back to the direct worker invocation.
        expect(cmd).not.toBe("nix-shell");
        expect(cmd).toBe(process.execPath);
      } finally {
        if (prev === undefined) delete process.env.LOBU_DISABLE_NIX_SHELL;
        else process.env.LOBU_DISABLE_NIX_SHELL = prev;
        __resetCapabilityProbesForTests();
      }
    });

    test("ensureDeployment with different names returns multiple entries", async () => {
      const msg1 = createTestMessagePayload({ agentId: "agent-a" });
      const msg2 = createTestMessagePayload({
        agentId: "agent-b",
        conversationId: "conv-2",
      });
      await manager.ensureDeployment("worker-1", "user-1", "user-1", msg1);
      await manager.ensureDeployment("worker-2", "user-1", "user-1", msg2);
      const list = await manager.listDeployments();
      expect(list).toHaveLength(2);
    });

    test("ensureDeployment is idempotent for the same name (sequential)", async () => {
      const msg = createTestMessagePayload();
      await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);
      await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);
      await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);
      expect(mockChildProcesses).toHaveLength(1);
      const list = await manager.listDeployments();
      expect(list).toHaveLength(1);
    });

    test("ensureDeployment coalesces concurrent calls for the same name", async () => {
      const msg = createTestMessagePayload();
      await Promise.all([
        manager.ensureDeployment("worker-1", "user-1", "user-1", msg),
        manager.ensureDeployment("worker-1", "user-1", "user-1", msg),
        manager.ensureDeployment("worker-1", "user-1", "user-1", msg),
      ]);
      expect(mockChildProcesses).toHaveLength(1);
      const list = await manager.listDeployments();
      expect(list).toHaveLength(1);
    });

    test("scaleDeployment(0) kills worker and removes from map", async () => {
      const msg = createTestMessagePayload();
      await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);
      await manager.scaleDeployment("worker-1", 0);
      const list = await manager.listDeployments();
      expect(list).toHaveLength(0);
    });

    test("deleteDeployment kills process and removes entry", async () => {
      const msg = createTestMessagePayload();
      await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);
      await manager.deleteDeployment("worker-1");
      const list = await manager.listDeployments();
      expect(list).toHaveLength(0);
    });

    test("deleteDeployment on non-existent name is a no-op", async () => {
      await expect(
        manager.deleteDeployment("nonexistent")
      ).resolves.toBeUndefined();
    });

    test("scaleDeployment(name, 0) on non-existent name is a no-op", async () => {
      await expect(
        manager.scaleDeployment("nonexistent", 0)
      ).resolves.toBeUndefined();
    });

    test("scaleDeployment(name, 1) on non-existent name rejects so MessageConsumer can re-spawn", async () => {
      // Silent no-op would strand the queued message forever (no worker, no
      // error, no retry); DeploymentManager.ensureDeployment catches this
      // and falls through to spawn a fresh worker.
      await expect(
        manager.scaleDeployment("nonexistent", 1)
      ).rejects.toThrow(/not running/);
    });

    test("listDeployments returns empty when no workers exist", async () => {
      const list = await manager.listDeployments();
      expect(list).toHaveLength(0);
    });

    // =====================================================================
    // Snapshot-mode cross-pod gate
    // =====================================================================
    // A snapshot-writing turn (one that carries a `runId`) hydrates from and
    // writes back to a SHARED Postgres snapshot. The cross-pod advisory lock
    // — keyed on (org, agent, conversationId) — is the only thing stopping two
    // replicas from both hydrating the same `completed` snapshot and writing
    // divergent next snapshots (one reply silently wins). If org or
    // conversationId is missing, the lock CANNOT be keyed, so the old code
    // silently skipped it and spawned an UNGUARDED worker. The manager must
    // now REFUSE to spawn instead (re-queueable failure), never run unguarded.
    describe("snapshot cross-pod gate", () => {
      test("refuses to spawn a snapshot-writing turn when organizationId is missing", async () => {
        const msg = createTestMessagePayload({
          runId: 42, // snapshot-writing turn
          organizationId: undefined, // org missing → lock cannot be keyed
          conversationId: "conv-1",
        });
        await expect(
          manager.ensureDeployment("worker-1", "user-1", "user-1", msg)
        ).rejects.toThrow(OrchestratorError);
        // No child spawned — the worker never ran unguarded.
        expect(mockChildProcesses).toHaveLength(0);
        expect(await manager.listDeployments()).toHaveLength(0);
      });

      test("refuses to spawn a snapshot-writing turn when conversationId is missing", async () => {
        const msg = createTestMessagePayload({
          runId: 42,
          organizationId: "org-1",
          conversationId: undefined as unknown as string,
        });
        await expect(
          manager.ensureDeployment("worker-1", "user-1", "user-1", msg)
        ).rejects.toThrow(OrchestratorError);
        expect(mockChildProcesses).toHaveLength(0);
      });

      test("legacy direct-enqueue turn (no runId) still spawns even with no org — never writes a shared snapshot", async () => {
        const msg = createTestMessagePayload({
          runId: undefined, // no shared snapshot write → no divergence risk
          organizationId: undefined,
          conversationId: "conv-1",
        });
        await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);
        expect(mockChildProcesses).toHaveLength(1);
      });

      // Two pods (two managers = two replicas) both receive the SAME
      // org-less snapshot-writing turn for the same conversation. Pre-fix,
      // each silently skipped the cross-pod lock and spawned its own worker —
      // both hydrate the same `completed` snapshot and write divergent next
      // snapshots (one reply silently wins). Post-fix, BOTH refuse: zero
      // duplicate spawns, so the divergent-snapshot race can't occur.
      test("two pods both refuse an org-less snapshot turn — no duplicate spawn across replicas", async () => {
        const pod1 = new DeploymentManager(TEST_CONFIG);
        const pod2 = new DeploymentManager(TEST_CONFIG);
        const msg = createTestMessagePayload({
          runId: 42,
          organizationId: undefined,
          conversationId: "conv-shared",
        });

        await expect(
          pod1.ensureDeployment("worker-x", "user-1", "user-1", msg)
        ).rejects.toThrow(OrchestratorError);
        await expect(
          pod2.ensureDeployment("worker-x", "user-1", "user-1", msg)
        ).rejects.toThrow(OrchestratorError);

        // Neither replica spawned a worker for the shared conversation.
        expect(mockChildProcesses).toHaveLength(0);
        expect(await pod1.listDeployments()).toHaveLength(0);
        expect(await pod2.listDeployments()).toHaveLength(0);
      });
    });
  });

  // =========================================================================
  // Activity tracking
  // =========================================================================
  describe("activity tracking", () => {
    test("lastActivity is set at creation time", async () => {
      const before = Date.now();
      const msg = createTestMessagePayload();
      await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);
      const after = Date.now();
      const list = await manager.listDeployments();
      const ts = list[0].lastActivity.getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    test("updateDeploymentActivity advances timestamp", async () => {
      const msg = createTestMessagePayload();
      await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);
      const listBefore = await manager.listDeployments();
      const tsBefore = listBefore[0].lastActivity.getTime();

      await new Promise((r) => setTimeout(r, 10));

      await manager.updateDeploymentActivity("worker-1");
      const listAfter = await manager.listDeployments();
      const tsAfter = listAfter[0].lastActivity.getTime();
      expect(tsAfter).toBeGreaterThan(tsBefore);
    });

    test("updateDeploymentActivity on non-existent is a no-op", async () => {
      await expect(
        manager.updateDeploymentActivity("nonexistent")
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // Subprocess-specific execution
  // =========================================================================
  describe("subprocess execution", () => {
    test("does not mutate gateway process.env", async () => {
      const envBefore = { ...process.env };
      const msg = createTestMessagePayload();
      await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);
      // Gateway process.env should not have new worker-specific vars added
      // (WORKSPACE_DIR, WORKER_TOKEN, etc. are passed to subprocess env, not process.env)
      expect(process.env.WORKSPACE_DIR).toBe(envBefore.WORKSPACE_DIR);
      expect(process.env.WORKER_TOKEN).toBe(envBefore.WORKER_TOKEN);
      expect(process.env.USER_ID).toBe(envBefore.USER_ID);
      expect(process.env.CONVERSATION_ID).toBe(envBefore.CONVERSATION_ID);
    });

    test("does not set globalThis.__lobuEmbeddedBashOps", async () => {
      const msg = createTestMessagePayload();
      await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);
      expect((globalThis as any).__lobuEmbeddedBashOps).toBeUndefined();
    });

    test("prepends the worker bin directory to subprocess PATH", async () => {
      // Treat every candidate worker bin dir as existing for this assertion;
      // in a workspace repo the local packages/<pkg>/node_modules/.bin is
      // hoisted to the root so the real fs.existsSync would filter everything
      // out.
      const existsSpy = spyOn(fs, "existsSync").mockReturnValue(true);
      try {
        const msg = createTestMessagePayload();
        await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);

        const spawnCall = mockSpawn.mock.calls.at(-1);
        expect(spawnCall).toBeDefined();

        const spawnOptions = spawnCall?.[2] as
          | { env?: Record<string, string> }
          | undefined;
        const pathEntries = (spawnOptions?.env?.PATH || "").split(":");
        expect(pathEntries).toContain("/test/node_modules/.bin");
      } finally {
        existsSpy.mockRestore();
      }
    });

    test("never forwards a runtime selector or provider credentials to the worker", async () => {
      // Runtime routing rides the conversation's per-turn pin (signed token +
      // payload), NOT a spawned env var. The worker env must carry neither a
      // LOBU_RUNTIME_PROVIDER selector nor any provider credential — even when
      // the gateway process itself has them set.
      const previous = {
        LOBU_RUNTIME_PROVIDER: process.env.LOBU_RUNTIME_PROVIDER,
        VERCEL_TOKEN: process.env.VERCEL_TOKEN,
        VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID,
        VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID,
      };
      process.env.LOBU_RUNTIME_PROVIDER = "vercel";
      process.env.VERCEL_TOKEN = "vercel-test-token";
      process.env.VERCEL_TEAM_ID = "team_test";
      process.env.VERCEL_PROJECT_ID = "prj_test";

      try {
        const msg = createTestMessagePayload();
        await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);

        const spawnCall = mockSpawn.mock.calls.at(-1);
        const spawnOptions = spawnCall?.[2] as
          | { env?: Record<string, string> }
          | undefined;

        expect(spawnOptions?.env?.LOBU_RUNTIME_PROVIDER).toBeUndefined();
        expect(spawnOptions?.env?.VERCEL_TOKEN).toBeUndefined();
        expect(spawnOptions?.env?.VERCEL_TEAM_ID).toBeUndefined();
        expect(spawnOptions?.env?.VERCEL_PROJECT_ID).toBeUndefined();
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    });

    test("child process exit removes worker from map", async () => {
      const msg = createTestMessagePayload();
      await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);
      expect(await manager.listDeployments()).toHaveLength(1);

      // Simulate child process exiting
      const cp = mockChildProcesses[0];
      cp.emit("exit", 1, null);

      // Give the event handler a tick to run
      await new Promise((r) => setTimeout(r, 0));

      expect(await manager.listDeployments()).toHaveLength(0);
    });
  });

  // =========================================================================
  // listDeployments shape
  // =========================================================================
  describe("listDeployments shape", () => {
    test("returns DeploymentInfo with expected fields", async () => {
      const msg = createTestMessagePayload();
      await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);
      const list = await manager.listDeployments();
      const info = list[0];
      expect(info.deploymentName).toBe("worker-1");
      expect(info.replicas).toBe(1);
      expect(info.lastActivity).toBeInstanceOf(Date);
      expect(typeof info.minutesIdle).toBe("number");
      expect(typeof info.daysSinceActivity).toBe("number");
      expect(typeof info.isIdle).toBe("boolean");
      expect(typeof info.isVeryOld).toBe("boolean");
    });

    test("newly created worker is not idle", async () => {
      const msg = createTestMessagePayload();
      await manager.ensureDeployment("worker-1", "user-1", "user-1", msg);
      const list = await manager.listDeployments();
      expect(list[0].isIdle).toBe(false);
      expect(list[0].isVeryOld).toBe(false);
    });
  });

  // =========================================================================
  // Worker sandbox fallback + opt-in fail-closed gate
  // =========================================================================
  // beforeEach sets LOBU_DISABLE_SYSTEMD_RUN=1, so locateSystemdRun() returns
  // null and the worker would run UNWRAPPED. These assert the posture: by
  // default the worker still runs (matching the prod container, which has no
  // systemd-run); only LOBU_REQUIRE_WORKER_SANDBOX=1 makes it fail closed.
  describe("worker sandbox fallback (systemd unavailable)", () => {
    const saved = { require: process.env.LOBU_REQUIRE_WORKER_SANDBOX };
    afterEach(() => {
      if (saved.require === undefined)
        delete process.env.LOBU_REQUIRE_WORKER_SANDBOX;
      else process.env.LOBU_REQUIRE_WORKER_SANDBOX = saved.require;
    });

    test("default (no requirement) spawns the worker unwrapped", async () => {
      delete process.env.LOBU_REQUIRE_WORKER_SANDBOX;
      await manager.ensureDeployment(
        "worker-1",
        "user-1",
        "user-1",
        createTestMessagePayload()
      );
      expect(mockChildProcesses).toHaveLength(1);
      // Unwrapped → the worker binary itself, not a systemd-run wrapper.
      expect(mockSpawn.mock.calls.at(-1)?.[0]).toBe(process.execPath);
    });

    test("LOBU_REQUIRE_WORKER_SANDBOX=1 without systemd refuses to spawn (fail closed)", async () => {
      process.env.LOBU_REQUIRE_WORKER_SANDBOX = "1";
      await expect(
        manager.ensureDeployment(
          "worker-1",
          "user-1",
          "user-1",
          createTestMessagePayload()
        )
      ).rejects.toThrow(OrchestratorError);
      // No un-sandboxed worker ever ran.
      expect(mockChildProcesses).toHaveLength(0);
      expect(await manager.listDeployments()).toHaveLength(0);
    });
  });
});
