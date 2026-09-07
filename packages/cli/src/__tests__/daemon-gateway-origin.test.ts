import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as daemonModule from "@lobu/connector-worker/daemon";
import { daemonCommand } from "../commands/daemon";
import * as loginModule from "../commands/login";
import { apiUrlToGatewayOrigin } from "../internal/context";
import * as context from "../internal/context";
import * as credentials from "../internal/credentials";
import * as deviceState from "../internal/device-state";
import * as deviceWizardModule from "../commands/_lib/device-wizard";

/**
 * Context URLs carry the SDK path (`https://app.lobu.ai/api/v1`) but the worker
 * API is mounted at the app root, so handing the context URL straight to a
 * device worker builds `/api/v1/api/workers/poll` and every call 404s. Only
 * production contexts carry that path — a local context is a bare
 * `http://localhost:<port>` — so the mismatch is invisible in dev and shows up
 * only against prod.
 */

describe("apiUrlToGatewayOrigin", () => {
  test("strips the /api/v1 SDK path from a production context URL", () => {
    expect(apiUrlToGatewayOrigin("https://app.lobu.ai/api/v1")).toBe(
      "https://app.lobu.ai"
    );
  });

  test("leaves a bare local context origin alone, port included", () => {
    expect(apiUrlToGatewayOrigin("http://localhost:8795")).toBe(
      "http://localhost:8795"
    );
  });

  test("hands back an unparseable value trimmed rather than throwing", () => {
    // The user's first request then fails against the address they configured,
    // which is a better error than a stack trace from URL parsing.
    expect(apiUrlToGatewayOrigin("not a url/")).toBe("not a url");
  });
});

/**
 * Every env key `detectInteractiveSession` triggers on. The suite itself often
 * runs inside one of these agents, so leaving any of them set would silently
 * route `daemonCommand` down the per-session lane and make the host-device
 * assertions below pass or fail depending on where the tests are run.
 */
const SESSION_ENV_KEYS = [
  "WORKER_API_TOKEN",
  "CI",
  "CLAUDE_PID",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "OPENCODE_PID",
  "OPENCODE_SESSION_ID",
] as const;

describe("lobu daemon", () => {
  const originalEnv = new Map<string, string | undefined>();
  let originalStdinIsTTY: boolean | undefined;
  let originalStdoutIsTTY: boolean | undefined;
  let findContextByOriginSpy: ReturnType<
    typeof spyOn<typeof context, "findContextByOrigin">
  >;

  beforeEach(() => {
    for (const key of SESSION_ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    originalStdinIsTTY = process.stdin.isTTY;
    originalStdoutIsTTY = process.stdout.isTTY;
    process.env.WORKER_API_TOKEN = "owl_pat_durable-device-token";
    (process.stdin as { isTTY?: boolean }).isTTY = false;
    (process.stdout as { isTTY?: boolean }).isTTY = false;
    findContextByOriginSpy = spyOn(
      context,
      "findContextByOrigin"
    ).mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const [key, value] of originalEnv) restoreEnv(key, value);
    originalEnv.clear();
    (process.stdin as { isTTY?: boolean }).isTTY = originalStdinIsTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = originalStdoutIsTTY;
    mock.restore();
  });

  test("auto-discovers the gateway ORIGIN, not the context's SDK path", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    spyOn(deviceState, "loadDeviceState").mockResolvedValue(null);
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({});

    expect(start.mock.calls[0]?.[0]?.apiUrl).toBe("https://app.lobu.ai");
  });

  test.each([
    ["the os.shell default", undefined, ["os.shell"]],
    [
      "a normalized explicit list",
      " os.shell, ,computer_use ",
      ["os.shell", "computer_use"],
    ],
    ["an explicitly empty list", "", []],
  ])("forwards %s", async (_case, capabilities, expected) => {
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({
      apiUrl: "http://127.0.0.1:9564",
      workerId: "headless:test-capabilities",
      capabilities,
      interactiveSession: false,
    });

    expect(start.mock.calls[0]?.[0]?.capabilities).toEqual(expected);
  });

  test("forwards activeOrg to startDaemonCommand for permission management link", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    spyOn(context, "getActiveOrg").mockResolvedValue("test-org");
    spyOn(deviceState, "loadDeviceState").mockResolvedValue(null);
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({});

    expect(start.mock.calls[0]?.[0]?.activeOrg).toBe("test-org");
  });

  test("an explicit --api-url passes through without context-backed setup", async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    const load = spyOn(deviceState, "loadDeviceState").mockResolvedValue({
      workerId: "macos:cached-context-device",
    });
    const wizard = spyOn(deviceWizardModule, "deviceWizard").mockResolvedValue({
      workerId: "macos:wizard-device",
      source: "created",
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({
      apiUrl: "http://127.0.0.1:9564",
      cliVersion: "17.2.3-test",
    });

    expect(start.mock.calls[0]?.[0]).toMatchObject({
      apiUrl: "http://127.0.0.1:9564",
      version: "17.2.3-test",
    });
    expect(load).not.toHaveBeenCalled();
    expect(wizard).not.toHaveBeenCalled();
  });

  test("LOBU_API_URL is an override too and never borrows the context's device", async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:9564",
      source: "env",
    });
    const load = spyOn(deviceState, "loadDeviceState").mockResolvedValue({
      workerId: "macos:cached-context-device",
    });
    const wizard = spyOn(deviceWizardModule, "deviceWizard").mockResolvedValue({
      workerId: "macos:wizard-device",
      source: "created",
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({});

    expect(load).not.toHaveBeenCalled();
    expect(wizard).not.toHaveBeenCalled();
    expect(start.mock.calls[0]?.[0]?.workerId).not.toBe(
      "macos:cached-context-device"
    );
  });

  test("an explicit --worker-id wins over both the cache and the session lane", async () => {
    process.env.CODEX_THREAD_ID = "thread-exact";
    process.env.CODEX_SESSION_ID = "thread-exact";
    const load = spyOn(deviceState, "loadDeviceState").mockResolvedValue({
      workerId: "macos:cached-host",
    });
    const wizard = spyOn(deviceWizardModule, "deviceWizard").mockResolvedValue({
      workerId: "macos:wizard-host",
      source: "created",
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({
      apiUrl: "http://127.0.0.1:9564",
      workerId: "headless:attached-explicit",
    });

    expect(start.mock.calls[0]?.[0]).toMatchObject({
      workerId: "headless:attached-explicit",
      platform: "headless",
    });
    expect(load).not.toHaveBeenCalled();
    expect(wizard).not.toHaveBeenCalled();
  });

  test("auto-detected Codex bypasses the host cache and remains in the centralized session lane", async () => {
    process.env.CODEX_THREAD_ID = "thread-exact";
    process.env.CODEX_SESSION_ID = "thread-exact";
    const load = spyOn(deviceState, "loadDeviceState").mockResolvedValue({
      workerId: "macos:cached-host",
    });
    const wizard = spyOn(deviceWizardModule, "deviceWizard").mockResolvedValue({
      workerId: "macos:wizard-host",
      source: "created",
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({ apiUrl: "http://127.0.0.1:9564" });

    expect(start.mock.calls[0]?.[0]?.workerId).toMatch(/^headless:codex:/);
    expect(start.mock.calls[0]?.[0]?.platform).toBe("headless");
    expect(load).not.toHaveBeenCalled();
    expect(wizard).not.toHaveBeenCalled();
  });

  test("an authenticated Codex session keeps its minted child PAT in memory only", async () => {
    delete process.env.WORKER_API_TOKEN;
    process.env.CODEX_THREAD_ID = "thread-exact";
    process.env.CODEX_SESSION_ID = "thread-exact";
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8787",
      source: "config",
    });
    findContextByOriginSpy.mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8787",
    });
    spyOn(credentials, "getContextToken").mockResolvedValue(
      "oauth-installation-login"
    );
    const load = spyOn(deviceState, "loadDeviceState").mockResolvedValue(null);
    const save = spyOn(deviceState, "saveDeviceState").mockResolvedValue();
    const update = spyOn(deviceState, "updateDeviceState").mockResolvedValue();
    spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const workerId = JSON.parse(String(init?.body)).worker_id as string;
      return jsonResponse({
        worker_id: workerId,
        access_token: "owl_pat_session-child",
        expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      });
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({ apiUrl: "http://127.0.0.1:8787" });

    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      workerApiToken: "owl_pat_session-child",
      platform: "headless",
    });
    expect(start.mock.calls[0]?.[0]?.workerId).toMatch(/^headless:codex:/);
  });

  test("interactive boot with a cached device id does not re-prompt via the wizard", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8795",
      source: "config",
    });
    spyOn(deviceState, "loadDeviceState").mockResolvedValue({
      workerId: "headless:confirmed-box",
    });
    const wizard = spyOn(deviceWizardModule, "deviceWizard").mockResolvedValue({
      workerId: "macos:should-not-run",
      source: "created",
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    await daemonCommand({});

    // The cached id wins and the wizard never runs once a device is configured.
    expect(wizard).not.toHaveBeenCalled();
    expect(start.mock.calls[0]?.[0]?.workerId).toBe("headless:confirmed-box");
  });

  test("a stored installation login mints a worker-bound child PAT before daemon start", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8787",
      source: "config",
    });
    delete process.env.WORKER_API_TOKEN;
    spyOn(credentials, "getContextToken").mockResolvedValue(
      "oauth-installation-login"
    );
    spyOn(deviceState, "loadDeviceState").mockResolvedValue(null);
    const save = spyOn(deviceState, "saveDeviceState").mockResolvedValue();
    const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        worker_id: "headless:test-host",
        access_token: "owl_pat_minted-child",
        expires_at: expiresAt,
      })
    );
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({ workerId: "headless:test-host" });

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8787/api/me/devices/mint-child-token"
    );
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((request.headers as Record<string, string>).Authorization).toBe(
      "Bearer oauth-installation-login"
    );
    expect(JSON.parse(String(request.body))).toMatchObject({
      platform: "headless",
      worker_id: "headless:test-host",
    });
    expect(save).toHaveBeenCalledWith(
      "local",
      "headless-worker-headless:test-host",
      expect.objectContaining({
        workerId: "headless:test-host",
        workerApiToken: "owl_pat_minted-child",
      })
    );
    expect(start.mock.calls[0]?.[0]?.workerApiToken).toBe(
      "owl_pat_minted-child"
    );
  });

  test("a valid cached child PAT starts without OAuth or another mint", async () => {
    const now = Date.now();
    const nowSpy = spyOn(Date, "now").mockReturnValue(now);
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8787",
      source: "config",
    });
    delete process.env.WORKER_API_TOKEN;
    spyOn(deviceState, "loadDeviceState").mockResolvedValue({
      workerId: "headless:cached",
      workerApiToken: "owl_pat_cached-child",
      expiresAt: now + 60 * 86_400_000,
    });
    const getToken = spyOn(credentials, "getContextToken").mockResolvedValue(
      "oauth-should-not-be-read"
    );
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({})
    );
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({});

    expect(getToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      workerId: "headless:cached",
      workerApiToken: "owl_pat_cached-child",
    });

    const maintenance = start.mock.calls[0]?.[0]?.workerCredentialMaintenance;
    expect(maintenance).toBeDefined();
    nowSpy.mockReturnValue(now + 31 * 86_400_000);
    const order: string[] = [];
    const update = spyOn(deviceState, "updateDeviceState").mockImplementation(
      async () => {
        order.push("save");
      }
    );
    fetchSpy.mockResolvedValue(
      jsonResponse({
        worker_id: "headless:cached",
        access_token: "owl_pat_rotated-child",
        expires_at: new Date(now + 121 * 86_400_000).toISOString(),
      })
    );

    await maintenance?.((token) => order.push(`activate:${token}`));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(
      (
        (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<
          string,
          string
        >
      ).Authorization
    ).toBe("Bearer owl_pat_cached-child");
    expect(update).toHaveBeenCalledWith(
      "local",
      "headless",
      expect.objectContaining({ workerApiToken: "owl_pat_rotated-child" })
    );
    expect(order).toEqual(["save", "activate:owl_pat_rotated-child"]);
  });

  test("an unexpired rejected child PAT fails closed instead of undoing revocation with OAuth", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8787",
      source: "config",
    });
    delete process.env.WORKER_API_TOKEN;
    spyOn(deviceState, "loadDeviceState").mockResolvedValue({
      workerId: "headless:cached",
      workerApiToken: "owl_pat_revoked-child",
      expiresAt: Date.now() + 30 * 60_000,
    });
    const getToken = spyOn(credentials, "getContextToken").mockResolvedValue(
      "oauth-installation-login"
    );
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "revoked" }, 401)
    );
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await expect(daemonCommand({})).rejects.toThrow(
      /rejected before its local expiry.*possibly revoked/s
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(getToken).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  test("a locally expired child PAT retries with this installation's OAuth login", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8787",
      source: "config",
    });
    delete process.env.WORKER_API_TOKEN;
    spyOn(deviceState, "loadDeviceState").mockResolvedValue({
      workerId: "headless:cached",
      workerApiToken: "owl_pat_expired-child",
      expiresAt: Date.now() - 1,
    });
    const update = spyOn(deviceState, "updateDeviceState").mockResolvedValue();
    const getToken = spyOn(credentials, "getContextToken").mockResolvedValue(
      "oauth-installation-login"
    );
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "revoked" }, 401))
      .mockResolvedValueOnce(
        jsonResponse({
          worker_id: "headless:cached",
          access_token: "owl_pat_rotated-child",
          expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        })
      );
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({});

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(
      (
        (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<
          string,
          string
        >
      ).Authorization
    ).toBe("Bearer owl_pat_expired-child");
    expect(
      (
        (fetchSpy.mock.calls[1]?.[1] as RequestInit).headers as Record<
          string,
          string
        >
      ).Authorization
    ).toBe("Bearer oauth-installation-login");
    expect(getToken).toHaveBeenCalledWith("local");
    expect(update).toHaveBeenCalledWith(
      "local",
      "headless",
      expect.objectContaining({ workerApiToken: "owl_pat_rotated-child" })
    );
    expect(start.mock.calls[0]?.[0]?.workerApiToken).toBe(
      "owl_pat_rotated-child"
    );
  });

  test("a post-mint save failure activates once and retries only the local write", async () => {
    const now = Date.now();
    const nowSpy = spyOn(Date, "now").mockReturnValue(now);
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8787",
      source: "config",
    });
    delete process.env.WORKER_API_TOKEN;
    spyOn(deviceState, "loadDeviceState").mockResolvedValue({
      workerId: "headless:cached",
      workerApiToken: "owl_pat_cached-child",
      expiresAt: now + 60 * 86_400_000,
    });
    const update = spyOn(deviceState, "updateDeviceState")
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValue();
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        worker_id: "headless:cached",
        access_token: "owl_pat_rotated-child",
        expires_at: new Date(now + 121 * 86_400_000).toISOString(),
      })
    );
    spyOn(process.stderr, "write").mockImplementation(() => true);
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({});
    const maintenance = start.mock.calls[0]?.[0]?.workerCredentialMaintenance;
    nowSpy.mockReturnValue(now + 31 * 86_400_000);
    const activated: string[] = [];

    await maintenance?.((token) => activated.push(token));
    nowSpy.mockReturnValue(now + 31 * 86_400_000 + 60_001);
    await maintenance?.((token) => activated.push(token));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(2);
    expect(activated).toEqual(["owl_pat_rotated-child"]);
  });

  test("runtime rotation never falls back to installation OAuth after an expired child is rejected", async () => {
    const now = Date.now();
    const nowSpy = spyOn(Date, "now").mockReturnValue(now);
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8787",
      source: "config",
    });
    delete process.env.WORKER_API_TOKEN;
    spyOn(deviceState, "loadDeviceState").mockResolvedValue({
      workerId: "headless:cached",
      workerApiToken: "owl_pat_cached-child",
      expiresAt: now + 60 * 86_400_000,
    });
    const getToken = spyOn(credentials, "getContextToken").mockResolvedValue(
      "oauth-installation-login"
    );
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "expired" }, 401)
    );
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({});
    const maintenance = start.mock.calls[0]?.[0]?.workerCredentialMaintenance;
    nowSpy.mockReturnValue(now + 61 * 86_400_000);

    await expect(maintenance?.(() => undefined)).rejects.toThrow(
      /Could not authorize this device/
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(getToken).not.toHaveBeenCalled();
  });

  test("runtime rotation treats rate limiting as retryable while the child remains valid", async () => {
    const now = Date.now();
    const nowSpy = spyOn(Date, "now").mockReturnValue(now);
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8787",
      source: "config",
    });
    delete process.env.WORKER_API_TOKEN;
    spyOn(deviceState, "loadDeviceState").mockResolvedValue({
      workerId: "headless:cached",
      workerApiToken: "owl_pat_cached-child",
      expiresAt: now + 60 * 86_400_000,
    });
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "rate_limited" }, 429)
    );
    spyOn(process.stderr, "write").mockImplementation(() => true);
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({});
    const maintenance = start.mock.calls[0]?.[0]?.workerCredentialMaintenance;
    nowSpy.mockReturnValue(now + 31 * 86_400_000);
    await maintenance?.(() => {
      throw new Error("must not activate");
    });
    nowSpy.mockReturnValue(now + 31 * 86_400_000 + 30_000);
    await maintenance?.(() => {
      throw new Error("must not activate");
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("a stale installation login reruns device-code auth before retrying the mint", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8787",
      source: "config",
    });
    delete process.env.WORKER_API_TOKEN;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    spyOn(deviceState, "loadDeviceState").mockResolvedValue(null);
    const save = spyOn(deviceState, "saveDeviceState").mockResolvedValue();
    const getToken = spyOn(credentials, "getContextToken")
      .mockResolvedValueOnce("oauth-stale-scope")
      .mockResolvedValueOnce("oauth-refreshed-scope");
    const login = spyOn(loginModule, "loginCommand").mockResolvedValue();
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "insufficient_scope" }, 403))
      .mockResolvedValueOnce(
        jsonResponse({
          worker_id: "headless:test-host",
          access_token: "owl_pat_refreshed-child",
          expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        })
      );
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({ workerId: "headless:test-host" });

    expect(login).toHaveBeenCalledWith({ context: "local", force: true });
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(
      (
        (fetchSpy.mock.calls[1]?.[1] as RequestInit).headers as Record<
          string,
          string
        >
      ).Authorization
    ).toBe("Bearer oauth-refreshed-scope");
    expect(save).toHaveBeenCalled();
    expect(start.mock.calls[0]?.[0]?.workerApiToken).toBe(
      "owl_pat_refreshed-child"
    );
  });

  test("a 403 that re-authenticating cannot clear surfaces instead of forcing a new login", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8787",
      source: "config",
    });
    delete process.env.WORKER_API_TOKEN;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    spyOn(deviceState, "loadDeviceState").mockResolvedValue(null);
    spyOn(credentials, "getContextToken").mockResolvedValue(
      "oauth-installation-login"
    );
    const login = spyOn(loginModule, "loginCommand").mockResolvedValue();
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          error: "personal_org_missing",
          error_description: "User has no personal org to bind the device to.",
        },
        403
      )
    );
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await expect(
      daemonCommand({ workerId: "headless:test-host" })
    ).rejects.toThrow(/User has no personal org to bind the device to/);

    // `lobu login --force` revokes the stored credential on its way in, so a
    // 403 that a fresh grant cannot clear must never be retried that way.
    expect(login).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  test("a non-interactive start without a stored login refuses instead of polling unauthenticated", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8787",
      source: "config",
    });
    delete process.env.WORKER_API_TOKEN;
    spyOn(deviceState, "loadDeviceState").mockResolvedValue(null);
    spyOn(credentials, "getContextToken").mockResolvedValue(null);
    const login = spyOn(loginModule, "loginCommand").mockResolvedValue();
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({})
    );
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await expect(daemonCommand({})).rejects.toThrow(
      /not logged in.*lobu login --force --context local/s
    );
    // Without a TTY the device-code flow cannot be completed, so the command
    // names the login to run rather than hanging on a prompt.
    expect(login).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  test("a non-headless platform override refuses before saving an installation context", async () => {
    delete process.env.WORKER_API_TOKEN;
    findContextByOriginSpy.mockResolvedValue(undefined);
    const add = spyOn(context, "addContext").mockResolvedValue({
      currentContext: "lobu",
      contexts: {},
    } as Awaited<ReturnType<typeof context.addContext>>);
    const getToken = spyOn(credentials, "getContextToken");
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await expect(
      daemonCommand({ apiUrl: "https://buremba.lobu.ai", platform: "macos" })
    ).rejects.toThrow(/supports the headless platform, not "macos"/);

    // The mint endpoint only issues headless/chrome-extension credentials, so
    // this start is doomed — it must not leave a context behind on the way out.
    expect(add).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  test("a mismatched login-based worker id refuses before minting", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8787",
      source: "config",
    });
    delete process.env.WORKER_API_TOKEN;
    const load = spyOn(deviceState, "loadDeviceState");
    const getToken = spyOn(credentials, "getContextToken");
    const fetchSpy = spyOn(globalThis, "fetch");
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await expect(
      daemonCommand({ workerId: "chrome-extension:wrong-platform" })
    ).rejects.toThrow(/does not match platform "headless"/);

    expect(load).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  test("an explicit installation URL creates and logs into its own context instead of borrowing the active one", async () => {
    delete process.env.WORKER_API_TOKEN;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    findContextByOriginSpy.mockResolvedValue(undefined);
    spyOn(context, "loadContextConfig").mockResolvedValue({
      currentContext: "lobu",
      contexts: {
        lobu: { url: "https://app.lobu.ai/api/v1" },
      },
    } as Awaited<ReturnType<typeof context.loadContextConfig>>);
    const add = spyOn(context, "addContext").mockResolvedValue({
      currentContext: "lobu",
      contexts: {},
    } as Awaited<ReturnType<typeof context.addContext>>);
    const getToken = spyOn(credentials, "getContextToken")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("oauth-buremba");
    const login = spyOn(loginModule, "loginCommand").mockResolvedValue();
    spyOn(deviceState, "loadDeviceState").mockResolvedValue(null);
    spyOn(deviceState, "saveDeviceState").mockResolvedValue();
    spyOn(deviceWizardModule, "deviceWizard").mockResolvedValue({
      workerId: "headless:buremba-box",
      source: "created",
    });
    spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        worker_id: "headless:buremba-box",
        access_token: "owl_pat_buremba-child",
        expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      })
    );
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({ apiUrl: "https://buremba.lobu.ai" });

    expect(add).toHaveBeenCalledWith(
      "buremba.lobu.ai",
      "https://buremba.lobu.ai"
    );
    expect(login).toHaveBeenCalledWith({
      context: "buremba.lobu.ai",
      force: true,
    });
    expect(
      getToken.mock.calls.every(([name]) => name === "buremba.lobu.ai")
    ).toBe(true);
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      apiUrl: "https://buremba.lobu.ai",
      workerId: "headless:buremba-box",
      workerApiToken: "owl_pat_buremba-child",
    });
  });

  test("a fresh TTY runs the wizard once and forwards its chosen identity", async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:9564",
      source: "config",
    });
    spyOn(deviceState, "loadDeviceState").mockResolvedValue(null);
    const wizard = spyOn(deviceWizardModule, "deviceWizard").mockResolvedValue({
      workerId: "headless:chosen-by-wizard",
      source: "created",
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({});

    expect(wizard).toHaveBeenCalledTimes(1);
    expect(wizard.mock.calls[0]?.[0]).toMatchObject({
      context: "local",
      gatewayOrigin: "http://127.0.0.1:9564",
      platform: "headless",
    });
    expect(start.mock.calls[0]?.[0]?.workerId).toBe(
      "headless:chosen-by-wizard"
    );
  });

  test("CI never prompts even when attached to a pseudo-TTY", async () => {
    process.env.CI = "true";
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:9564",
      source: "config",
    });
    spyOn(deviceState, "loadDeviceState").mockResolvedValue(null);
    const wizard = spyOn(deviceWizardModule, "deviceWizard").mockResolvedValue({
      workerId: "macos:should-not-run",
      source: "created",
    });
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({});

    expect(wizard).not.toHaveBeenCalled();
    expect(start.mock.calls[0]?.[0]?.workerId).toContain(":");
  });

  test("--no-interactive-session is forwarded as an explicit opt-out", async () => {
    const start = spyOn(daemonModule, "startDaemonCommand").mockResolvedValue(
      undefined as never
    );

    await daemonCommand({
      apiUrl: "http://127.0.0.1:9564",
      interactiveSession: false,
    });

    expect(start.mock.calls[0]?.[0]?.interactiveSession).toBe(false);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}
