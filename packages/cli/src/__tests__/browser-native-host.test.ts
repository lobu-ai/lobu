import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The extension's own parser for a desktop bridge reply: the host must satisfy
// exactly what the shipped extension reads.
import { readNativePairResponse } from "../../../owletto/apps/chrome/panel-session.js";
import {
  browserListCommand,
  browserRemoveCommand,
  browserStartCommand,
  browserStopCommand,
  nativeHostReply,
} from "../commands/browser";
import * as chromeForTesting from "../commands/_lib/chrome-for-testing";
import * as deviceCredential from "../commands/_lib/device-credential";
import {
  encodeNativeMessage,
  readNativeMessage,
} from "../commands/_lib/native-messaging";
import * as contextConfig from "../internal/context";
import * as credentials from "../internal/credentials";
import { loadDeviceState } from "../internal/device-state";

const RECORD = {
  name: "work",
  context: "synthetic",
  gatewayOrigin: "https://gateway.example",
  workerId: "chrome-extension:testhost:work",
  label: "work (testhost)",
};

async function* chunks(...parts: Buffer[]): AsyncIterable<Buffer> {
  for (const part of parts) yield part;
}

describe("native messaging framing", () => {
  test("decodes a message split across chunks", async () => {
    const frame = encodeNativeMessage({ op: "pair", worker_id: "w" });
    expect(frame.readUInt32LE(0)).toBe(frame.length - 4);
    const decoded = await readNativeMessage(
      chunks(frame.subarray(0, 3), frame.subarray(3, 9), frame.subarray(9))
    );
    expect(decoded).toEqual({ op: "pair", worker_id: "w" });
  });

  test("returns null when Chrome closes the port mid-message", async () => {
    const frame = encodeNativeMessage({ op: "pair" });
    expect(await readNativeMessage(chunks(frame.subarray(0, 6)))).toBeNull();
  });

  test("refuses an oversized request", async () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(64 * 1024 * 1024, 0);
    await expect(readNativeMessage(chunks(header))).rejects.toThrow(
      "too large"
    );
  });
});

describe("native host pairing reply", () => {
  let home: string | undefined;

  afterEach(() => {
    mock.restore();
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  /** Save the browser's context, pointing at `url`. */
  function useContextUrl(url: string): void {
    spyOn(contextConfig, "loadContextConfig").mockResolvedValue({
      currentContext: RECORD.context,
      contexts: { [RECORD.context]: { url } },
    } as Awaited<ReturnType<typeof contextConfig.loadContextConfig>>);
  }

  function useBrowserRecord(): void {
    home = mkdtempSync(join(tmpdir(), "lobu-browser-host-"));
    spyOn(os, "homedir").mockReturnValue(home);
    useContextUrl(`${RECORD.gatewayOrigin}/api/v1`);
    const dir = join(home, ".config", "lobu", "browsers", RECORD.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "browser.json"), JSON.stringify(RECORD));
  }

  const noLog = async () => undefined;

  test("reports launch errors before waiting for the device to connect", async () => {
    useBrowserRecord();
    await deviceCredential.persistDeviceCredential(
      RECORD.context,
      "chrome-extension-browser-work",
      {
        workerId: RECORD.workerId,
        workerApiToken: "owl_pat_child",
        expiresAt: Date.now() + 86_400_000,
      }
    );
    const existsSync = fs.existsSync;
    const readFile = fsPromises.readFile;
    const isManifest = (path: unknown) =>
      String(path).endsWith("/chrome-extension/manifest.json");
    spyOn(fs, "existsSync").mockImplementation(
      (path) => isManifest(path) || existsSync(path)
    );
    spyOn(fsPromises, "readFile").mockImplementation(((
      path: string,
      options: never
    ) =>
      isManifest(path)
        ? Promise.resolve(
            JSON.stringify({
              key: Buffer.from("synthetic-key").toString("base64"),
            })
          )
        : readFile(path, options)) as typeof fsPromises.readFile);
    spyOn(credentials, "getContextToken").mockResolvedValue("login-token");
    spyOn(chromeForTesting, "resolveBrowserExecutable").mockResolvedValue(
      join(home!, "missing-browser")
    );
    const fetch = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ devices: [] }))
      .mockResolvedValue(
        Response.json({ error: "unexpected device poll" }, { status: 400 })
      );
    spyOn(console, "log").mockImplementation(() => undefined);

    await expect(browserStartCommand(RECORD.name, {})).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    "",
    "-other",
  ])("stop matches the whole profile argument (suffix: %s)", async (suffix) => {
    useBrowserRecord();
    const profile = join(
      home!,
      ".config",
      "lobu",
      "browsers",
      RECORD.name,
      "profile"
    );
    mkdirSync(profile);
    const child = spawn(
      process.execPath,
      [
        "-e",
        "setInterval(() => {}, 1000)",
        "--",
        `--user-data-dir=${profile}${suffix}`,
      ],
      { stdio: "ignore" }
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      symlinkSync(`testhost-${child.pid}`, join(profile, "SingletonLock"));
      const kill = spyOn(process, "kill").mockImplementation(() => {
        if (suffix) throw new Error("must not signal another profile");
        return child.kill();
      });
      spyOn(console, "log").mockImplementation(() => undefined);
      await browserStopCommand(RECORD.name);
      expect(kill).toHaveBeenCalledTimes(suffix ? 0 : 1);
    } finally {
      child.kill();
    }
  });

  describe("after the context is repointed at another gateway", () => {
    function useRepointedContext(): void {
      useBrowserRecord();
      useContextUrl("https://other-gateway.example/api/v1");
      spyOn(credentials, "getContextToken").mockResolvedValue(
        "other-gateway-login"
      );
    }

    test("pairing refuses before any request or login refresh", async () => {
      useRepointedContext();
      const mint = spyOn(deviceCredential, "mintDeviceCredentialWithReauth");
      const login = spyOn(deviceCredential, "requireInstallationLogin");
      const fetch = spyOn(globalThis, "fetch");

      const reply = await nativeHostReply(RECORD.name, { op: "pair" }, noLog);

      expect(String(reply.error)).toContain("no longer points at");
      expect(mint).not.toHaveBeenCalled();
      expect(login).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    test("device requests use the browser's own child credential, never the login", async () => {
      useRepointedContext();
      await deviceCredential.persistDeviceCredential(
        RECORD.context,
        "chrome-extension-browser-work",
        {
          workerId: RECORD.workerId,
          workerApiToken: "owl_pat_child",
          expiresAt: Date.now() + 86_400_000,
        }
      );
      const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({ devices: [] })
      );
      spyOn(console, "log").mockImplementation(() => undefined);

      await browserListCommand({ json: true });

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${RECORD.gatewayOrigin}/api/me/devices`);
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer owl_pat_child"
      );
    });
  });

  describe("with a stored login the gateway rejects", () => {
    async function useRevokedLogin() {
      useBrowserRecord();
      await deviceCredential.persistDeviceCredential(
        RECORD.context,
        "chrome-extension-browser-work",
        {
          workerId: RECORD.workerId,
          workerApiToken: "owl_pat_child",
          expiresAt: Date.now() + 86_400_000,
        }
      );
      spyOn(credentials, "getContextToken").mockResolvedValue("revoked-login");
      spyOn(console, "log").mockImplementation(() => undefined);
      return spyOn(globalThis, "fetch").mockImplementation((async (
        _url: string,
        init: RequestInit
      ) => {
        const auth = (init.headers as Record<string, string>).Authorization;
        if (auth !== "Bearer owl_pat_child") {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        return init.method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json({
              devices: [
                {
                  id: "device-1",
                  worker_id: RECORD.workerId,
                  platform: "chrome-extension",
                  online: true,
                },
              ],
            });
      }) as typeof fetch);
    }

    const bearersSent = (fetch: { mock: { calls: unknown[][] } }) =>
      fetch.mock.calls.map(
        ([, init]) =>
          `${(init as RequestInit).method ?? "GET"} ${((init as RequestInit).headers as Record<string, string>).Authorization}`
      );

    test("list falls back to the browser's child credential", async () => {
      const fetch = await useRevokedLogin();
      const log = spyOn(console, "log").mockImplementation(() => undefined);

      await browserListCommand({ json: true });

      expect(bearersSent(fetch)).toEqual([
        "GET Bearer revoked-login",
        "GET Bearer owl_pat_child",
      ]);
      expect(
        JSON.parse(String(log.mock.calls[0]?.[0])).browsers[0].device
      ).toBe("online");
    });

    test("rm deletes the device with the credential the gateway accepted", async () => {
      const fetch = await useRevokedLogin();

      await browserRemoveCommand(RECORD.name);

      expect(bearersSent(fetch)).toEqual([
        "GET Bearer revoked-login",
        "GET Bearer owl_pat_child",
        "DELETE Bearer owl_pat_child",
      ]);
    });
  });

  test("declines anything but a pair request", async () => {
    useBrowserRecord();
    expect(
      await nativeHostReply(RECORD.name, { op: "ambient_context" }, noLog)
    ).toEqual({ ok: false, error: "unsupported" });
  });

  test("answers a pair request in the shape the extension reads, minted from the login", async () => {
    useBrowserRecord();
    spyOn(credentials, "getContextToken").mockResolvedValue("login-token");
    const mint = spyOn(
      deviceCredential,
      "mintDeviceCredentialWithReauth"
    ).mockResolvedValue({
      workerId: RECORD.workerId,
      workerApiToken: "owl_pat_child",
      expiresAt: Date.now() + 86_400_000,
      sessionToken: "panel-session",
    });

    const reply = await nativeHostReply(
      RECORD.name,
      { op: "pair", platform: "chrome-extension" },
      noLog
    );

    expect(readNativePairResponse(reply)).toEqual({
      gatewayUrl: RECORD.gatewayOrigin,
      workerId: RECORD.workerId,
      accessToken: "owl_pat_child",
      sessionToken: "panel-session",
    });
    expect(mint.mock.calls[0]?.[0]).toMatchObject({
      contextName: RECORD.context,
      initialBearerIsChild: false,
      interactiveReauth: false,
      options: {
        gatewayOrigin: RECORD.gatewayOrigin,
        bearer: "login-token",
        platform: "chrome-extension",
        workerId: RECORD.workerId,
        label: RECORD.label,
      },
    });
    expect(
      await loadDeviceState(RECORD.context, "chrome-extension-browser-work")
    ).toMatchObject({
      workerId: RECORD.workerId,
      workerApiToken: "owl_pat_child",
    });
  });

  async function cacheChild(token: string): Promise<void> {
    await deviceCredential.persistDeviceCredential(
      RECORD.context,
      "chrome-extension-browser-work",
      {
        workerId: RECORD.workerId,
        workerApiToken: token,
        expiresAt: Date.now() + 86_400_000,
      }
    );
  }

  test("re-pairing mints from the login even with a cached child, so the side panel stays signed in", async () => {
    useBrowserRecord();
    await cacheChild("owl_pat_cached");
    spyOn(credentials, "getContextToken").mockResolvedValue("login-token");
    // A device-only child cannot mint a web session; only the login can.
    const mint = spyOn(
      deviceCredential,
      "mintDeviceCredentialWithReauth"
    ).mockImplementation(async ({ options }) => ({
      workerId: RECORD.workerId,
      workerApiToken: "owl_pat_rotated",
      expiresAt: Date.now() + 86_400_000,
      ...(options.bearer === "login-token"
        ? { sessionToken: "panel-session" }
        : {}),
    }));

    const reply = await nativeHostReply(RECORD.name, { op: "pair" }, noLog);

    expect(readNativePairResponse(reply)?.sessionToken).toBe("panel-session");
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[0]?.[0]).toMatchObject({
      initialBearerIsChild: false,
      options: { bearer: "login-token" },
    });
  });

  test("with the login lapsed, pairing rotates the cached child", async () => {
    useBrowserRecord();
    await cacheChild("owl_pat_cached");
    spyOn(credentials, "getContextToken").mockResolvedValue(null);
    const mint = spyOn(
      deviceCredential,
      "mintDeviceCredentialWithReauth"
    ).mockResolvedValue({
      workerId: RECORD.workerId,
      workerApiToken: "owl_pat_rotated",
      expiresAt: Date.now() + 86_400_000,
    });

    const reply = await nativeHostReply(RECORD.name, { op: "pair" }, noLog);

    expect(reply.access_token).toBe("owl_pat_rotated");
    expect(mint.mock.calls[0]?.[0]).toMatchObject({
      initialBearerIsChild: true,
      options: { bearer: "owl_pat_cached" },
    });
  });

  test("a login the gateway refuses falls back to the cached child", async () => {
    useBrowserRecord();
    await cacheChild("owl_pat_cached");
    spyOn(credentials, "getContextToken").mockResolvedValue("old-login");
    const mint = spyOn(deviceCredential, "mintDeviceCredentialWithReauth");
    mint.mockRejectedValueOnce(
      new deviceCredential.DeviceMintError(
        "Could not authorize this device: insufficient_scope",
        403,
        "insufficient_scope"
      )
    );
    mint.mockResolvedValueOnce({
      workerId: RECORD.workerId,
      workerApiToken: "owl_pat_rotated",
      expiresAt: Date.now() + 86_400_000,
    });

    const reply = await nativeHostReply(RECORD.name, { op: "pair" }, noLog);

    expect(reply.access_token).toBe("owl_pat_rotated");
    expect(mint.mock.calls[1]?.[0]).toMatchObject({
      initialBearerIsChild: true,
      options: { bearer: "owl_pat_cached" },
    });
  });

  test("refuses a credential minted for another worker id", async () => {
    useBrowserRecord();
    spyOn(credentials, "getContextToken").mockResolvedValue("login-token");
    spyOn(deviceCredential, "mintDeviceCredentialWithReauth").mockResolvedValue(
      {
        workerId: "some-other-uuid",
        workerApiToken: "owl_pat_child",
        expiresAt: Date.now() + 86_400_000,
      }
    );
    const lines: string[] = [];

    const reply = await nativeHostReply(
      RECORD.name,
      { op: "pair" },
      async (line) => lines.push(line)
    );

    expect(readNativePairResponse(reply)).toBeNull();
    expect(String(reply.error)).toContain("instead of");
    expect(lines.join("\n")).toContain("pairing failed");
    expect(
      await loadDeviceState(RECORD.context, "chrome-extension-browser-work")
    ).toBeNull();
  });

  test("reports a lapsed login instead of prompting", async () => {
    useBrowserRecord();
    spyOn(credentials, "getContextToken").mockResolvedValue(null);
    const mint = spyOn(deviceCredential, "mintDeviceCredentialWithReauth");

    const reply = await nativeHostReply(RECORD.name, { op: "pair" }, noLog);

    expect(String(reply.error)).toContain("lobu browser start work");
    expect(mint).not.toHaveBeenCalled();
  });

  test("reports an unknown browser", async () => {
    useBrowserRecord();
    const reply = await nativeHostReply("other", { op: "pair" }, noLog);
    expect(String(reply.error)).toContain('No browser named "other"');
  });
});
