import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  __resetEncryptionKeyCacheForTests,
  generateWorkerToken,
} from "@lobu/core";
import * as providerSecrets from "../../lobu/stores/provider-secrets.js";

const remoteFiles = new Map<string, Buffer>();
const mkdirMock = mock(async () => undefined);
const readdirMock = mock(async () => []);
const statMock = mock(async (remotePath: string) => ({
  size: remoteFiles.get(remotePath)?.byteLength ?? 0,
}));
const rmMock = mock(async (remotePath: string) => {
  remoteFiles.delete(remotePath);
});
const writeFilesMock = mock(async () => undefined);
const readFileToBufferMock = mock(async () => null);
const runCommandMock = mock(
  async (params: { args?: string[]; env?: Record<string, string> }) => {
  // args = ["-lc", <wrapper script>, "lobu-exec", <cwd>, <command>] — the
  // submitted command is the last positional, not the script at index 1.
  const command = params.args?.[4] ?? "";
  let stdout = "command stdout\n";
  let exitCode = 0;
  if (command.includes("echo remote output > output.txt")) {
    remoteFiles.set("/vercel/sandbox/output.txt", Buffer.from("remote output"));
  }
  if (command.includes("cat input.txt")) {
    const input = remoteFiles.get("/vercel/sandbox/input.txt");
    if (input) {
      stdout = input.toString("utf8");
    } else {
      stdout = "";
      exitCode = 1;
    }
  }
  if (command.includes("rm input.txt")) {
    remoteFiles.delete("/vercel/sandbox/input.txt");
  }
    return {
      exitCode,
      stdout: async () => stdout,
      stderr: async () => "",
    };
  }
);
const updateMock = mock(async () => undefined);
const getOrCreateMock = mock(async () => fakeSandbox);

const fakeSandbox = {
  name: "lobu-org-agent-hash",
  persistent: true,
  cwd: "/vercel/sandbox",
  networkPolicy: "deny-all",
  timeout: 60_000,
  vcpus: 2,
  keepLastSnapshots: undefined,
  snapshotExpiration: undefined,
  fs: {
    mkdir: mkdirMock,
    readdir: readdirMock,
    stat: statMock,
    rm: rmMock,
  },
  writeFiles: writeFilesMock,
  readFileToBuffer: readFileToBufferMock,
  runCommand: runCommandMock,
  update: updateMock,
};

mock.module("@vercel/sandbox", () => ({
  Sandbox: { getOrCreate: getOrCreateMock },
}));

// Env-bound credential resolution reads the vault. Mock it to a MISS (null) so
// the "sandbox pinned but deleted" case is deterministic and DB-free: the
// scoped key is gone, so a sandbox-bound resolution must fail closed.
const readSandboxSecretSpy = spyOn(
  providerSecrets,
  "readSandboxSecret"
).mockResolvedValue(null);

/**
 * Connector-contributed leases, mocked at the resolver boundary. The real
 * resolver reads `connections` and mints through the installation-token
 * registry; neither belongs in a route test, and both are covered by
 * `agent-tooling-resolver.test.ts`. What this file owns is the DELIVERY
 * contract: what the route does with a minted lease, and what it refuses to
 * take from the worker.
 */
const leasedEnv = new Map<string, string>();
let leaseMintThrows = false;
const resolveLeasedEnvMock = mock(async () => {
  if (leaseMintThrows) throw new Error("mint failed");
  return Object.fromEntries(leasedEnv);
});
mock.module("../agent-tooling/exec-credentials.js", () => ({
  resolveLeasedExecEnv: resolveLeasedEnvMock,
}));

// Importing the route pulls in the gateway runtime registry barrel, which
// registers the Vercel provider. The @vercel/sandbox mock above is installed
// first so the provider module binds to it.
const { createRuntimeRoutes } = await import("../routes/internal/runtime.js");
const { execArgv } = (await import("../runtime/providers/vercel.js")).__testOnly;
const { registerGatewayRuntimeProvider } = await import(
  "../runtime/registry.js"
);

/**
 * A provider that has no `ensurePackages`. `ensurePackages` is optional on the
 * contract precisely so "this backend cannot provision" is expressible; the
 * route must degrade rather than throw on a provider that omits it.
 */
const noProvisionExecMock = mock(async () => ({
  stdout: "no-provision stdout\n",
  stderr: "",
  exitCode: 0,
  meta: { name: "no-provision" },
}));
registerGatewayRuntimeProvider({
  id: "noprovision",
  credentialFields: [],
  canSelfAuth: () => true,
  exec: noProvisionExecMock,
});

const originalEnv = {
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  LOBU_VERCEL_SANDBOX_NAME_PREFIX: process.env.LOBU_VERCEL_SANDBOX_NAME_PREFIX,
  LOBU_VERCEL_SANDBOX_RUNTIME: process.env.LOBU_VERCEL_SANDBOX_RUNTIME,
  VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID,
  VERCEL_SANDBOX_DEFAULT_RUNTIME: process.env.VERCEL_SANDBOX_DEFAULT_RUNTIME,
  VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID,
  VERCEL_TOKEN: process.env.VERCEL_TOKEN,
  VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN,
};

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function token(
  options: {
    agentId?: string;
    runtimeProviderId?: string;
    sandboxId?: string;
    allowedDomains?: string[];
    deniedDomains?: string[];
    nixPackages?: string[];
  } = {}
): string {
  return generateWorkerToken("user-1", "conv-1", "deploy-1", {
    channelId: "chan-1",
    teamId: "team-1",
    platform: "slack",
    organizationId: "org-1",
    agentId: options.agentId,
    runtimeProviderId: options.runtimeProviderId,
    sandboxId: options.sandboxId,
    allowedDomains: options.allowedDomains,
    deniedDomains: options.deniedDomains,
    nixPackages: options.nixPackages,
  });
}

/**
 * The bash script of the Nth runCommand call.
 *
 * Two argv shapes reach the sandbox: provisioning runs a plain
 * `["-lc", <script>]`, while the agent's own command goes through `execArgv`,
 * which passes the cwd and the command as positionals after a fixed wrapper
 * script. In both cases the script under test is the LAST argv entry.
 */
function commandScript(index: number): string {
  const args = runCommandMock.mock.calls[index]?.[0]?.args;
  return args?.[args.length - 1] ?? "";
}

function setVercelSystemCreds(): void {
  process.env.VERCEL_PROJECT_ID = "prj_test";
  process.env.VERCEL_TEAM_ID = "team_test";
  process.env.VERCEL_TOKEN = "vercel_test_token";
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  __resetEncryptionKeyCacheForTests();
});

afterEach(async () => {
  restoreEnv("ENCRYPTION_KEY");
  restoreEnv("LOBU_VERCEL_SANDBOX_NAME_PREFIX");
  restoreEnv("LOBU_VERCEL_SANDBOX_RUNTIME");
  restoreEnv("VERCEL_PROJECT_ID");
  restoreEnv("VERCEL_SANDBOX_DEFAULT_RUNTIME");
  restoreEnv("VERCEL_TEAM_ID");
  restoreEnv("VERCEL_TOKEN");
  restoreEnv("VERCEL_OIDC_TOKEN");
  __resetEncryptionKeyCacheForTests();
  remoteFiles.clear();
  getOrCreateMock.mockClear();
  mkdirMock.mockClear();
  readdirMock.mockClear();
  writeFilesMock.mockClear();
  runCommandMock.mockClear();
  statMock.mockClear();
  readFileToBufferMock.mockClear();
  rmMock.mockClear();
  updateMock.mockClear();
  noProvisionExecMock.mockClear();
  leasedEnv.clear();
  leaseMintThrows = false;
  resolveLeasedEnvMock.mockClear();
  await fs.rm(path.resolve("workspaces", "verceltestagent"), {
    recursive: true,
    force: true,
  });
});

afterAll(() => {
  readSandboxSecretSpy.mockRestore();
});

describe("createRuntimeRoutes — infrastructure failures", () => {
  /**
   * A provider fault must not be reported as the agent's command failing.
   * Previously a 429 was flattened to a 500 whose message went to the command's
   * own stdout with exit 1, so the agent rewrote a correct command and retried
   * into an already-throttled endpoint.
   */
  function apiError(status: number): Error & { response: { status: number } } {
    // Shape of the Vercel SDK's APIError: message carries the status as text,
    // and the real status hangs off `response`.
    const error = new Error(
      `Status code ${status} is not ok`
    ) as Error & { response: { status: number } };
    error.response = { status };
    return error;
  }

  test("a throttled provision surfaces 429 + retryable, not a command failure", async () => {
    setVercelSystemCreds();
    getOrCreateMock.mockImplementationOnce(async () => {
      throw apiError(429);
    });
    const router = createRuntimeRoutes();

    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({ agentId: "verceltestagent", runtimeProviderId: "vercel" })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "echo hello" }),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("infrastructure");
    expect(body.retryable).toBe(true);
    // Provisioning precedes dispatch, so the command provably never ran.
    expect(body.outcome).toBe("not_started");
    expect(String(body.error)).toContain("provision sandbox");
    // The command must never have run.
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  test("a non-retryable provider fault surfaces 503 + retryable false", async () => {
    setVercelSystemCreds();
    getOrCreateMock.mockImplementationOnce(async () => {
      throw apiError(403);
    });
    const router = createRuntimeRoutes();

    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({ agentId: "verceltestagent", runtimeProviderId: "vercel" })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "echo hello" }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("infrastructure");
    expect(body.retryable).toBe(false);
    // Not retryable AND never ran — the two facts are independent.
    expect(body.outcome).toBe("not_started");
  });

  test("a log-fetch failure AFTER the command ran is not retryable", async () => {
    // The dangerous case: runCommand succeeded, so the command's side effects
    // already happened. Claiming it "did not run" and inviting a retry would
    // duplicate them.
    setVercelSystemCreds();
    runCommandMock.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: async () => {
        throw apiError(429);
      },
      stderr: async () => "",
    }));
    const router = createRuntimeRoutes();

    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({ agentId: "verceltestagent", runtimeProviderId: "vercel" })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "curl -X POST https://api.github.com/x" }),
    });

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("infrastructure");
    // Not retryable, despite the underlying 429 — the command already ran.
    expect(body.retryable).toBe(false);
    expect(body.outcome).toBe("completed");
    expect(res.status).toBe(503);
    expect(String(body.error)).toContain("MAY have completed");
    expect(String(body.error)).not.toContain("did not run");
  });

  test("a transport failure during the command is infrastructure, not exit 1", async () => {
    setVercelSystemCreds();
    runCommandMock.mockImplementationOnce(async () => {
      throw apiError(429);
    });
    const router = createRuntimeRoutes();

    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({ agentId: "verceltestagent", runtimeProviderId: "vercel" })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "echo hello" }),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("infrastructure");
    expect(body.retryable).toBe(true);
    // Dispatch can reject after the command has already started, so this must
    // never report "not_started" — that would invite an unsafe retry.
    expect(body.outcome).toBe("unknown");
    expect(String(body.error)).toContain("run command");
  });
});

describe("createRuntimeRoutes", () => {
  test("404s when the token selects no runtime provider", async () => {
    const router = createRuntimeRoutes();

    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({ agentId: "agent-1" })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "pwd" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "No runtime provider configured for this agent",
    });
  });

  test("404s when the token names an unknown provider", async () => {
    const router = createRuntimeRoutes();

    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "agent-1",
          runtimeProviderId: "made-up",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "pwd" }),
    });

    expect(res.status).toBe(404);
  });

  test("requires an agent-scoped worker token before sandbox work", async () => {
    const router = createRuntimeRoutes();

    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({ runtimeProviderId: "vercel" })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "pwd" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Token missing agent context" });
  });

  test("424s when the provider has no resolvable credentials", async () => {
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_OIDC_TOKEN;
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "pwd", workspaceDir }),
    });

    expect(res.status).toBe(424);
    expect(await res.json()).toEqual({
      error: "Runtime provider credentials unavailable",
    });
    expect(getOrCreateMock).not.toHaveBeenCalled();
  });

  test("proceeds via OIDC self-auth when no explicit credential but VERCEL_OIDC_TOKEN is present", async () => {
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    process.env.VERCEL_OIDC_TOKEN = "oidc.test.token";
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "pwd", workspaceDir }),
    });

    // No explicit creds + OIDC present → route lets the SDK self-auth (no 424).
    expect(res.status).toBe(200);
    expect(getOrCreateMock).toHaveBeenCalledTimes(1);
    // SDK self-resolves OIDC — no explicit token/teamId/projectId passed in.
    expect(getOrCreateMock.mock.calls[0]?.[0]).not.toHaveProperty("token");
  });

  test("424s for a sandbox-bound vault miss even when VERCEL_OIDC_TOKEN is present (no host-realm self-auth)", async () => {
    // The token names a specific sandboxId (a pinned sandbox), but the
    // vault read misses (mocked null → the sandbox was deleted). OIDC is
    // present, so the sandbox-less path would self-auth into the host realm. A
    // sandbox-bound miss must fail closed instead — a conversation pinned to a
    // deleted sandbox must NOT execute in the host realm.
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    process.env.VERCEL_OIDC_TOKEN = "oidc.test.token";
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
          sandboxId: "env-deleted",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "pwd", workspaceDir }),
    });

    expect(res.status).toBe(424);
    expect(await res.json()).toEqual({
      error: "Runtime provider credentials unavailable",
    });
    // Fail closed → no sandbox was created in the host realm.
    expect(getOrCreateMock).not.toHaveBeenCalled();
  });

  test("424s when required credentials are only partially configured", async () => {
    process.env.VERCEL_TOKEN = "vercel_test_token";
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "pwd", workspaceDir }),
    });

    expect(res.status).toBe(424);
    expect(getOrCreateMock).not.toHaveBeenCalled();
  });

  test("rejects a workspace path outside the token conversation", async () => {
    setVercelSystemCreds();
    const router = createRuntimeRoutes();

    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "pwd",
        workspaceDir: path.resolve("workspaces", "verceltestagent", "other"),
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Workspace does not match token conversation context",
    });
    expect(getOrCreateMock).not.toHaveBeenCalled();
  });

  test("resolves provider credentials from system env and passes them to the sandbox", async () => {
    setVercelSystemCreds();
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "pwd", workspaceDir }),
    });

    expect(res.status).toBe(200);
    expect(getOrCreateMock.mock.calls[0]?.[0]).toMatchObject({
      projectId: "prj_test",
      teamId: "team_test",
      token: "vercel_test_token",
    });
    // The worker never receives the credential — only stdout/stderr/exitCode.
    expect(JSON.stringify(await res.json())).not.toContain("vercel_test_token");
  });

  test("ignores a body-supplied provider and uses the signed token claim", async () => {
    setVercelSystemCreds();
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      // A compromised worker tries to switch providers via the body.
      body: JSON.stringify({ command: "pwd", workspaceDir, provider: "made-up" }),
    });

    expect(res.status).toBe(200);
    expect(getOrCreateMock).toHaveBeenCalledTimes(1);
  });

  test("ignores a body-supplied egress allowlist and uses the signed token claim", async () => {
    setVercelSystemCreds();
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
          // The gateway-signed allowlist for this agent.
          allowedDomains: ["github.com"],
        })}`,
        "content-type": "application/json",
      },
      // A compromised worker tries to widen egress to everything via the body.
      body: JSON.stringify({
        command: "pwd",
        workspaceDir,
        allowedDomains: ["*"],
      }),
    });

    expect(res.status).toBe(200);
    // The sandbox network policy reflects the TOKEN's allowlist, NOT the body's
    // "*": the body must not be able to escalate to an allow-all sandbox.
    expect(getOrCreateMock.mock.calls[0]?.[0]).toMatchObject({
      networkPolicy: { allow: ["github.com"] },
    });
  });

  test("executes in a persistent named sandbox without local file sync", async () => {
    setVercelSystemCreds();
    process.env.LOBU_VERCEL_SANDBOX_NAME_PREFIX = "lobu-test";
    process.env.VERCEL_SANDBOX_DEFAULT_RUNTIME = "node22";
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");
    await fs.mkdir(workspaceDir, { recursive: true });
    const subdir = path.join(workspaceDir, "nested");
    await fs.writeFile(path.join(workspaceDir, "input.txt"), "local input");
    remoteFiles.set("/vercel/sandbox/stale.txt", Buffer.from("stale"));

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
          // The egress allowlist now rides the signed token, not the body.
          allowedDomains: ["github.com", ".npmjs.org", "bad domain"],
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "pwd",
        cwd: subdir,
        workspaceDir,
        timeoutMs: 1_000,
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      stdout: "command stdout\n",
      stderr: "",
      exitCode: 0,
      sandbox: {
        name: "lobu-org-agent-hash",
        persistent: true,
        cwd: "/vercel/sandbox",
      },
    });
    expect(getOrCreateMock).toHaveBeenCalledTimes(1);
    expect(getOrCreateMock.mock.calls[0]?.[0]).toMatchObject({
      name: expect.stringMatching(
        /^lobu-test-org-1-verceltestagent-[a-f0-9]{16}$/
      ),
      persistent: true,
      runtime: "node22",
      resources: { vcpus: 1 },
      networkPolicy: { allow: ["github.com", "*.npmjs.org"] },
      keepLastSnapshots: { count: 1, deleteEvicted: true },
    });
    expect(remoteFiles.has("/vercel/sandbox/stale.txt")).toBe(true);
    // The cwd is established BY the command, not by a `cwd` option paired with a
    // separate `fs.mkdir()`. That mkdir was a real command execution in the SDK,
    // so it doubled the command-API rate and got the sandbox rate-limited.
    expect(runCommandMock.mock.calls[0]?.[0]).toMatchObject({
      cmd: "/bin/bash",
      // cwd and command are positional args, never interpolated. Asserted via
      // the provider's own builder so this cannot drift from production.
      args: execArgv("/vercel/sandbox/nested", "pwd"),
      timeoutMs: 1_000,
    });
    expect(runCommandMock.mock.calls[0]?.[0]).not.toHaveProperty("cwd");
    // The regression this guards: one exec must cost exactly one execution.
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(writeFilesMock).not.toHaveBeenCalled();
    expect(readFileToBufferMock).not.toHaveBeenCalled();
    expect(rmMock).not.toHaveBeenCalled();
  });

  test("ignores a body-supplied nix package list and uses the signed token claim", async () => {
    // The security invariant for packages, mirroring the egress one above: the
    // worker is the sandbox-ee, so it must not be able to name its own package
    // set. Every entry becomes a `nix profile install` argument.
    setVercelSystemCreds();
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
          allowedDomains: ["github.com"],
          // The gateway-signed package set for this agent.
          nixPackages: ["gh"],
        })}`,
        "content-type": "application/json",
      },
      // A compromised worker tries to install something its org never declared.
      body: JSON.stringify({
        command: "gh --version",
        workspaceDir,
        nixPackages: ["curl", "socat"],
      }),
    });

    expect(res.status).toBe(200);
    // Provisioning ran for the TOKEN's set only.
    const provision = commandScript(0);
    expect(provision).toContain("#gh\"");
    expect(provision).not.toContain("socat");
    expect(provision).not.toContain("#curl\"");
    // The response reports what was actually provisioned.
    expect((await res.json()).sandbox.packages).toMatchObject({
      installed: ["gh"],
      failed: [],
    });
  });

  test("provisions the signed packages before the command and puts them on PATH", async () => {
    setVercelSystemCreds();
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
          allowedDomains: ["github.com"],
          nixPackages: ["gh"],
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "gh auth status", workspaceDir }),
    });

    expect(res.status).toBe(200);
    expect(runCommandMock).toHaveBeenCalledTimes(2);
    // `fs.mkdir({ recursive: true })` is itself a sandbox command in the real
    // SDK. The fixed workspace root already exists, so provisioning must not
    // spend a third command (the rate-limit regression this provider avoids).
    expect(mkdirMock).not.toHaveBeenCalled();
    // Ordering matters: install first, then the agent's command.
    expect(commandScript(0)).toContain("nix profile install");
    expect(runCommandMock.mock.calls[0]?.[0]).toMatchObject({ sudo: true });
    expect(commandScript(1)).toBe(
      'export PATH="/opt/lobu-nix/profiles/fb2b7fce0940161406a6aa3e4d8b4aa6/bin:$PATH"\ngh auth status'
    );
    // The nix substituters must be in the policy the sandbox was created with,
    // or the install hangs against deny-by-default.
    expect(getOrCreateMock.mock.calls[0]?.[0]).toMatchObject({
      networkPolicy: {
        allow: [
          "github.com",
          "cache.nixos.org",
          "channels.nixos.org",
          "releases.nixos.org",
        ],
      },
    });
    // Provisioning and exec resolve the sandbox separately; both must ask for
    // the SAME policy. A divergence would make `getOrCreate` reconcile — i.e.
    // update the sandbox — on literally every command.
    expect(getOrCreateMock.mock.calls[1]?.[0]?.networkPolicy).toEqual(
      getOrCreateMock.mock.calls[0]?.[0]?.networkPolicy
    );
  });

  test("does not touch PATH or the network policy when the claim has no packages", async () => {
    setVercelSystemCreds();
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
          allowedDomains: ["github.com"],
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "pwd", workspaceDir }),
    });

    expect(res.status).toBe(200);
    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(commandScript(0)).toBe("pwd");
    // An agent that provisions nothing keeps exactly the operator's policy.
    expect(getOrCreateMock.mock.calls[0]?.[0]).toMatchObject({
      networkPolicy: { allow: ["github.com"] },
    });
    expect((await res.json()).sandbox).not.toHaveProperty("packages");
  });

  test("fails provisioning immediately when the signed denylist blocks a Nix host", async () => {
    setVercelSystemCreds();
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");
    runCommandMock.mockImplementationOnce(async () => ({
      exitCode: 75,
      stdout: async () => "",
      stderr: async () => "",
    }));

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
          allowedDomains: ["github.com"],
          deniedDomains: ["cache.nixos.org"],
          nixPackages: ["gh"],
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "gh --version", workspaceDir }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sandbox.packages).toMatchObject({
      installed: [],
      failed: ["gh"],
      cached: false,
    });
    expect(body.sandbox.packages.error).toContain(
      "Nix package hosts are blocked"
    );
    // The known policy conflict must not burn the five-minute provisioning
    // timeout. The first command is a local profile probe (no curl/Nix
    // install), followed by the agent's command.
    expect(runCommandMock).toHaveBeenCalledTimes(2);
    expect(commandScript(0)).not.toContain("curl");
    expect(commandScript(0)).toContain("exit 75");
    expect(commandScript(1)).toBe("gh --version");
  });

  test("reuses an exact cached package set even when Nix hosts are denied", async () => {
    setVercelSystemCreds();
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");
    runCommandMock.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: async () => "lobu-packages: cached\n",
      stderr: async () => "",
    }));

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
          deniedDomains: ["cache.nixos.org"],
          nixPackages: ["gh"],
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "gh --version", workspaceDir }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).sandbox.packages).toEqual({
      installed: ["gh"],
      failed: [],
      cached: true,
    });
    expect(commandScript(1)).toBe(
      'export PATH="/opt/lobu-nix/profiles/fb2b7fce0940161406a6aa3e4d8b4aa6/bin:$PATH"\ngh --version'
    );
    // The cached-profile selector relinks `profile` and rewrites the marker
    // inside a NIX_HOME the provision path created as root. Running it
    // unprivileged fails on permissions, so this recovery path — the ONLY way
    // a denied-host sandbox gets its packages — needs the same sudo the
    // installer uses.
    expect(runCommandMock.mock.calls[0]?.[0]).toMatchObject({ sudo: true });
  });

  test("drops a package name the nix validator rejects before it reaches a command line", async () => {
    setVercelSystemCreds();
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
          allowedDomains: ["github.com"],
          // A hostile declaration that somehow reached the mint: only `gh`
          // survives validation.
          nixPackages: ["gh", "x; touch /tmp/pwn", "$(id)"],
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "gh --version", workspaceDir }),
    });

    expect(res.status).toBe(200);
    const provision = commandScript(0);
    expect(provision).toContain("#gh\"");
    expect(provision).not.toContain("touch /tmp/pwn");
    expect(provision).not.toContain("$(id)");
    expect((await res.json()).sandbox.packages.installed).toEqual(["gh"]);
  });

  test("degrades honestly when provisioning fails instead of failing the turn", async () => {
    setVercelSystemCreds();
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");
    runCommandMock.mockImplementationOnce(async () => ({
      exitCode: 1,
      stdout: async () => "",
      stderr: async () => "nix: substituter unreachable",
    }));

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
          allowedDomains: ["github.com"],
          nixPackages: ["gh"],
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "gh --version", workspaceDir }),
    });

    // The turn still runs — a missing CLI must not take the agent down.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sandbox.packages).toMatchObject({
      installed: [],
      failed: ["gh"],
      cached: false,
    });
    // ...and it says so rather than pretending the tool is there.
    expect(body.sandbox.packages.error).toContain("exited 1");
    expect(runCommandMock).toHaveBeenCalledTimes(2);
    // A failed install must not expose an older profile left in the persistent
    // sandbox. The command runs with the base-image PATH only.
    expect(commandScript(1)).toBe("gh --version");
  });

  test("reports a marker-file hit as cached without reinstalling", async () => {
    setVercelSystemCreds();
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");
    // The provisioning script short-circuits on a marker match; the sandbox
    // filesystem — not gateway memory — is what remembers, so another replica
    // handling the next message reaches the same conclusion.
    runCommandMock.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: async () => "lobu-packages: cached\n",
      stderr: async () => "",
    }));

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
          allowedDomains: ["github.com"],
          nixPackages: ["gh"],
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "gh --version", workspaceDir }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).sandbox.packages).toMatchObject({
      installed: ["gh"],
      cached: true,
    });
    // A cache hit is a SUCCESS — the profile is real, so PATH must expose it.
    expect(commandScript(1)).toBe(
      'export PATH="/opt/lobu-nix/profiles/fb2b7fce0940161406a6aa3e4d8b4aa6/bin:$PATH"\ngh --version'
    );
  });

  test("a provider that cannot provision degrades instead of throwing", async () => {
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "noprovision",
          nixPackages: ["gh"],
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "gh --version", workspaceDir }),
    });

    expect(res.status).toBe(200);
    expect(noProvisionExecMock).toHaveBeenCalledTimes(1);
    const packages = (await res.json()).sandbox.packages;
    // Honest degradation: the tool is absent AND the result says why.
    expect(packages).toMatchObject({ installed: [], failed: ["gh"] });
    expect(packages.error).toContain("does not support package provisioning");
  });

  test("remote deletes do not mutate local workspace files", async () => {
    setVercelSystemCreds();
    process.env.LOBU_VERCEL_SANDBOX_NAME_PREFIX = "lobu-test";
    const workspaceDir = path.resolve("workspaces", "verceltestagent", "conv-1");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "input.txt"), "local input");
    remoteFiles.set("/vercel/sandbox/input.txt", Buffer.from("remote input"));

    const router = createRuntimeRoutes();
    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "rm input.txt", workspaceDir }),
    });

    expect(res.status).toBe(200);
    expect(remoteFiles.has("/vercel/sandbox/input.txt")).toBe(false);
    expect(
      await fs.readFile(path.join(workspaceDir, "input.txt"), "utf8")
    ).toBe("local input");
    expect(writeFilesMock).not.toHaveBeenCalled();
    expect(readFileToBufferMock).not.toHaveBeenCalled();
    expect(rmMock).not.toHaveBeenCalled();
  });
});

/**
 * Connector-contributed credentials on the isolate lane.
 *
 * A connector that declares `credential: 'lease'` (the GitHub connector's
 * `GH_TOKEN`) promises the agent an authenticated CLI. The retired subprocess
 * lane kept that promise by baking the lease into the worker's environment at
 * spawn; there is no worker process now, so the lease has to be minted
 * gateway-side and attached per command.
 *
 * Minting HERE is not a port of the old design but a better fit for it: the
 * subprocess lane had to recycle a warm worker before its lease lapsed,
 * because a process reads its env once at start. A per-command mint has no
 * such window.
 */
describe("createRuntimeRoutes — connector credential leases", () => {
  test("a declared lease reaches the sandbox as a real env var", async () => {
    setVercelSystemCreds();
    leasedEnv.set("GH_TOKEN", "ghs_minted_for_this_command");
    const router = createRuntimeRoutes();

    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "gh auth status" }),
    });

    expect(res.status).toBe(200);
    expect(runCommandMock.mock.calls[0]?.[0]?.env).toMatchObject({
      GH_TOKEN: "ghs_minted_for_this_command",
    });
  });

  /**
   * The worker is the sandbox-ee, so its body must not be able to name its own
   * credentials — the same rule the route already applies to `allowedDomains`
   * and `nixPackages`. A body value must neither introduce an env var nor
   * override a minted lease, or a compromised isolate could pin `GH_TOKEN` to
   * a token it controls and have the sandbox act as that identity.
   */
  test("a worker-supplied env cannot inject or override a credential", async () => {
    setVercelSystemCreds();
    leasedEnv.set("GH_TOKEN", "ghs_minted_for_this_command");
    const router = createRuntimeRoutes();

    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "gh auth status",
        env: {
          GH_TOKEN: "ghs_attacker_supplied",
          AWS_SECRET_ACCESS_KEY: "smuggled",
        },
      }),
    });

    expect(res.status).toBe(200);
    const sent = runCommandMock.mock.calls[0]?.[0]?.env ?? {};
    expect(sent.GH_TOKEN).toBe("ghs_minted_for_this_command");
    expect(sent).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });

  /**
   * Honest degradation, the rule the lease module already states: a connection
   * whose lease cannot be minted contributes nothing and the command still
   * runs. A `gh` that reports "not logged in" is a better failure than a turn
   * that dies, and far better than one that reports success having done
   * nothing.
   */
  test("a failed mint runs the command without the credential", async () => {
    setVercelSystemCreds();
    leaseMintThrows = true;
    const router = createRuntimeRoutes();

    const res = await router.request("/internal/runtime/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token({
          agentId: "verceltestagent",
          runtimeProviderId: "vercel",
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "gh auth status" }),
    });

    expect(res.status).toBe(200);
    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(runCommandMock.mock.calls[0]?.[0]?.env ?? {}).not.toHaveProperty(
      "GH_TOKEN"
    );
  });
});
