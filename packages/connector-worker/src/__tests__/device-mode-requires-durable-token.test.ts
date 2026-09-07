/**
 * A device daemon runs for weeks and snapshots its bearer once at startup —
 * `WorkerClient` never refreshes it.
 *
 * `lobu whoami --json` returns `workerToken ?? accessToken` (packages/cli
 * whoami.ts), so a user without a durable agent token silently receives their
 * OAuth SESSION token. That expires within 24h, after which the daemon polls
 * 401 forever and every scheduled os.files run stops — with no failure surfaced
 * anywhere the user would look.
 *
 * The daemon therefore refuses a non-durable credential at boot rather than
 * accepting one guaranteed to die. These tests pin that it fails CLOSED in
 * device mode and stays out of the fleet path, which authenticates with a
 * long-lived WORKER_API_TOKEN.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";

const BIN = path.join(import.meta.dir, "..", "bin.ts");
// Port 1 is never listening, so the daemon cannot get past its first poll —
// these tests assert on the STARTUP decision, not on any network semantics.
const DEAD_API = "http://127.0.0.1:1";

/** Run the daemon briefly and return whatever it wrote to stderr. */
async function runDaemon(
  env: Record<string, string | undefined>,
  args: string[]
): Promise<string> {
  const proc = Bun.spawn(["bun", BIN, "daemon", "--api-url", DEAD_API, ...args], {
    env: {
      ...process.env,
      WORKER_API_TOKEN: undefined,
      CODEX_THREAD_ID: undefined,
      CODEX_SESSION_ID: undefined,
      CLAUDE_PID: undefined,
      CLAUDE_CODE_SESSION_ID: undefined,
      CLAUDE_CODE_MESSAGING_SOCKET: undefined,
      CLAUDE_CODE_MESSAGING_TOKEN: undefined,
      OPENCODE_PID: undefined,
      OPENCODE_SESSION_ID: undefined,
      LOBU_OPENCODE_BRIDGE_SOCKET: undefined,
      LOBU_OPENCODE_BRIDGE_TOKEN: undefined,
      LOBU_ORG: undefined,
      ...env,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  // The guard exits immediately; the pass-through cases would run forever, so
  // cap them and read whatever startup output exists by then.
  const timer = setTimeout(() => proc.kill(), 8000);
  try {
    return await new Response(proc.stderr).text();
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}

const DEVICE_ARGS = [
  "--platform",
  "macos",
  "--worker-id",
  "test-device",
  "--capabilities",
  "os.files",
];

describe("device mode requires a durable token", () => {
  test("refuses to start with no token at all", async () => {
    const stderr = await runDaemon({}, DEVICE_ARGS);
    expect(stderr).toContain("device mode requires a durable personal access token");
    // The message must name the actual trap, not just the missing variable.
    expect(stderr).toContain("expires within 24h");
    expect(stderr).not.toContain("Starting worker daemon");
  }, 20000);

  test("refuses an OAuth session access token", async () => {
    // The exact shape `whoami` falls back to. It is a perfectly valid bearer
    // TODAY, which is what makes accepting it so damaging.
    const stderr = await runDaemon(
      { WORKER_API_TOKEN: "ya29.a0AfB_byC-oauth-access-token" },
      DEVICE_ARGS
    );
    expect(stderr).toContain("device mode requires a durable personal access token");
    expect(stderr).not.toContain("Starting worker daemon");
  }, 20000);

  test("accepts a durable PAT and proceeds to start", async () => {
    // Pins the guard as targeted — rejecting everything would satisfy both
    // assertions above while making device mode unusable.
    const stderr = await runDaemon(
      {
        WORKER_API_TOKEN: "owl_pat_durabletoken0123456789",
        LOBU_ORG: "test-org",
      },
      DEVICE_ARGS
    );
    expect(stderr).not.toContain("device mode requires a durable");
    expect(stderr).toContain("Starting worker daemon");
    expect(stderr).toContain("device mode: platform=macos");
    expect(stderr).toContain(
      "Manage action permissions (Approval vs Auto) at: http://127.0.0.1:1/test-org/connectors/device/test-device"
    );
  }, 20000);

  test("device mode without active org omits permission management link", async () => {
    const stderr = await runDaemon(
      { WORKER_API_TOKEN: "owl_pat_durabletoken0123456789" },
      DEVICE_ARGS
    );
    expect(stderr).toContain("Starting worker daemon");
    expect(stderr).toContain("device mode: platform=macos");
    expect(stderr).not.toContain("Manage action permissions");
  }, 20000);

  test("a fleet worker with no PAT is unaffected", async () => {
    // Fleet workers pass no --platform and authenticate with a long-lived
    // WORKER_API_TOKEN; the guard must not reach them.
    const stderr = await runDaemon({}, ["--worker-id", "test-fleet"]);
    expect(stderr).not.toContain("device mode requires a durable");
    expect(stderr).toContain("Starting worker daemon");
  }, 20000);

  test("refuses a worker id the device row cannot round-trip", async () => {
    // worker_id keys the (user_id, worker_id) upsert and is how Automation
    // pins find this device. A mangled value mints a SECOND device instead of
    // failing, and the pinned Automations simply stop running here.
    const stderr = await runDaemon(
      { WORKER_API_TOKEN: "owl_pat_durabletoken0123456789" },
      ["--platform", "macos", "--worker-id", "my device #1", "--capabilities", "os.files"]
    );
    expect(stderr).toContain("invalid --worker-id");
    expect(stderr).not.toContain("Starting worker daemon");
  }, 20000);

  test("refuses a worker id past the length cap", async () => {
    const stderr = await runDaemon(
      { WORKER_API_TOKEN: "owl_pat_durabletoken0123456789" },
      ["--platform", "macos", "--worker-id", "d".repeat(129), "--capabilities", "os.files"]
    );
    expect(stderr).toContain("invalid --worker-id");
    expect(stderr).not.toContain("Starting worker daemon");
  }, 20000);

  test("--help does not send users to a credential the guard rejects", async () => {
    // The guard and the setup instructions are edited in different places, so
    // they can drift apart silently: --help used to name the `lobu whoami
    // --json` workerToken, which is exactly the OAuth token refused above, so
    // following the documented setup could not produce a daemon that starts.
    const proc = Bun.spawn(["bun", BIN, "--help"], { stdout: "pipe" });
    const help = await new Response(proc.stdout).text();
    await proc.exited;

    expect(help).toContain("lobu token create");
    expect(help).toContain("owl_pat_");
    // `whoami` may only appear as the warning, never as the source to use.
    for (const line of help.split("\n").filter((l) => l.includes("whoami"))) {
      expect(line).not.toMatch(/requires|use|from/i);
    }
  }, 20000);
});
