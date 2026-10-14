import { describe, expect, spyOn, test } from "bun:test";
import * as runtimeCheck from "../self-check/index";
import { WorkerClient } from "../daemon/client";
import { defaultDeviceMaxConcurrentJobs } from "../daemon/device-concurrency";
import { resolveDaemonLaunchContext, resolveDaemonMaxConcurrentJobs, startDaemonCommand } from "../daemon/start";
import { WorkerDaemon } from "../daemon/worker";

describe("device daemon concurrency default", () => {
  test("a headless device daemon admits more than one run by default", () => {
    expect(resolveDaemonMaxConcurrentJobs("headless", {}, 8)).toBe(4);
  });

  test("a fleet worker with no platform keeps the poll loop's single slot", () => {
    expect(resolveDaemonMaxConcurrentJobs(undefined, {}, 64)).toBeUndefined();
  });

  test("an inherited interactive session gets the device default without an explicit platform", () => {
    const { platform } = resolveDaemonLaunchContext({}, {
      CODEX_THREAD_ID: "synthetic-thread",
      CODEX_SESSION_ID: "synthetic-thread",
    });
    expect(resolveDaemonMaxConcurrentJobs(platform, {}, 8)).toBe(4);
  });

  test("WORKER_MAX_CONCURRENT_JOBS overrides the device default and applies to fleet workers", () => {
    expect(resolveDaemonMaxConcurrentJobs("headless", { WORKER_MAX_CONCURRENT_JOBS: "1" }, 8)).toBe(1);
    expect(resolveDaemonMaxConcurrentJobs(undefined, { WORKER_MAX_CONCURRENT_JOBS: "3" }, 8)).toBe(3);
  });

  test("the device default is half the host threads, clamped to [2, 8]", () => {
    expect(
      [1, 2, 4, 5, 8, 10, 16, 17, 32, 128].map((threads) => defaultDeviceMaxConcurrentJobs(threads))
    ).toEqual([2, 2, 2, 2, 4, 5, 8, 8, 8, 8]);
  });
});

describe("daemon startup capacity", () => {
  for (const platform of ["headless", "macos", undefined]) {
    for (const override of [undefined, "1", "12"]) {
      test(`${platform ?? "fleet"} startup advertises ${override ?? "default"} capacity`, async () => {
        const previousOverride = process.env.WORKER_MAX_CONCURRENT_JOBS;
        if (override === undefined) delete process.env.WORKER_MAX_CONCURRENT_JOBS;
        else process.env.WORKER_MAX_CONCURRENT_JOBS = override;
        const runtime = spyOn(runtimeCheck, "assertConnectorRuntimeLoadable").mockResolvedValue();
        const signals = spyOn(WorkerDaemon.prototype, "installShutdownSignals").mockImplementation(() => {});
        const start = spyOn(WorkerDaemon.prototype, "start").mockResolvedValue();
        const health = spyOn(WorkerClient.prototype, "healthCheck").mockResolvedValue(true);
        let daemon: WorkerDaemon | undefined;
        const poll = spyOn(WorkerClient.prototype, "poll").mockImplementation(async () => {
          daemon!.stop();
          return {};
        });
        try {
          daemon = await startDaemonCommand({
            apiUrl: "https://example.test",
            workerId: "synthetic-device",
            workerApiToken: "owl_pat_12345678901234567890123456789012",
            defaultPlatform: platform,
            interactiveSession: false,
          });
          start.mockRestore();
          await daemon.start();
          expect(poll).toHaveBeenCalledTimes(1);
          const advertised = poll.mock.calls[0][0];
          if (override !== undefined) expect(advertised).toBe(Number(override));
          else if (!platform) expect(advertised).toBe(1);
          else {
            // The exact default depends on the host; its derivation is pinned
            // with injected thread counts above. Here only the wiring matters.
            expect(advertised).toBeGreaterThanOrEqual(2);
            expect(advertised).toBeLessThanOrEqual(8);
          }
        } finally {
          daemon?.stop();
          for (const mock of [poll, health, start, signals, runtime]) mock.mockRestore();
          if (previousOverride === undefined) delete process.env.WORKER_MAX_CONCURRENT_JOBS;
          else process.env.WORKER_MAX_CONCURRENT_JOBS = previousOverride;
        }
      });
    }
  }
});
