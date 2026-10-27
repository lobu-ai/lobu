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

  function useBrowserRecord(): void {
    home = mkdtempSync(join(tmpdir(), "lobu-browser-host-"));
    spyOn(os, "homedir").mockReturnValue(home);
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

  test("a later pairing rotates the cached child instead of using the login", async () => {
    useBrowserRecord();
    const login = spyOn(credentials, "getContextToken").mockResolvedValue(
      "login-token"
    );
    const mint = spyOn(deviceCredential, "mintDeviceCredentialWithReauth");
    mint.mockResolvedValueOnce({
      workerId: RECORD.workerId,
      workerApiToken: "owl_pat_first",
      expiresAt: Date.now() + 86_400_000,
    });
    mint.mockResolvedValueOnce({
      workerId: RECORD.workerId,
      workerApiToken: "owl_pat_second",
      expiresAt: Date.now() + 86_400_000,
    });

    await nativeHostReply(RECORD.name, { op: "pair" }, noLog);
    const reply = await nativeHostReply(RECORD.name, { op: "pair" }, noLog);

    expect(reply.access_token).toBe("owl_pat_second");
    expect(login).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[1]?.[0]).toMatchObject({
      initialBearerIsChild: true,
      options: { bearer: "owl_pat_first" },
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
