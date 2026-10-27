import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveBrowserExecutable } from "../commands/_lib/chrome-for-testing";

const PLATFORM =
  process.platform === "darwin"
    ? process.arch === "arm64"
      ? "mac-arm64"
      : "mac-x64"
    : process.arch === "arm64"
      ? "linux-arm64"
      : "linux64";

const EXECUTABLE = PLATFORM.startsWith("mac")
  ? join(
      `chrome-${PLATFORM}`,
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing"
    )
  : join(`chrome-${PLATFORM}`, "chrome");

const DAY = 24 * 60 * 60 * 1000;

function versionIndex(version: string, url: string): Response {
  return Response.json({
    channels: {
      Stable: {
        version,
        downloads: { chrome: [{ platform: PLATFORM, url }] },
      },
    },
  });
}

describe("Chrome for Testing cache", () => {
  let home: string | undefined;
  const savedOverride = process.env.LOBU_BROWSER_PATH;

  afterEach(() => {
    mock.restore();
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
    if (savedOverride === undefined) delete process.env.LOBU_BROWSER_PATH;
    else process.env.LOBU_BROWSER_PATH = savedOverride;
  });

  function useHome(): string {
    delete process.env.LOBU_BROWSER_PATH;
    home = mkdtempSync(join(tmpdir(), "lobu-cft-"));
    spyOn(os, "homedir").mockReturnValue(home);
    return join(home, ".cache", "lobu", "chrome-for-testing");
  }

  function installVersion(root: string, version: string): string {
    const executable = join(root, version, EXECUTABLE);
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, "");
    writeFileSync(join(root, version, ".complete"), version);
    return executable;
  }

  test("LOBU_BROWSER_PATH skips the download entirely", async () => {
    const root = useHome();
    const binary = join(home!, "chromium");
    writeFileSync(binary, "");
    process.env.LOBU_BROWSER_PATH = binary;
    const fetchImpl = mock(() => Promise.reject(new Error("no network")));

    expect(
      await resolveBrowserExecutable({ fetchImpl: fetchImpl as never })
    ).toBe(binary);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(root)).toBe(false);
  });

  test("a check from today reuses the cached build without the network", async () => {
    const root = useHome();
    const executable = installVersion(root, "150.0.1.2");
    writeFileSync(
      join(root, "latest.json"),
      JSON.stringify({ version: "150.0.1.2", checkedAt: 1_000 })
    );
    const fetchImpl = mock(() => Promise.reject(new Error("no network")));

    expect(
      await resolveBrowserExecutable({
        fetchImpl: fetchImpl as never,
        now: () => 1_000 + DAY - 1,
      })
    ).toBe(executable);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("a failed check falls back to the newest cached build", async () => {
    const root = useHome();
    installVersion(root, "9.0.0.1");
    const newest = installVersion(root, "10.0.0.1");
    const log = mock(() => undefined);

    expect(
      await resolveBrowserExecutable({
        fetchImpl: (() => Promise.reject(new Error("offline"))) as never,
        log,
      })
    ).toBe(newest);
    expect(String(log.mock.calls[0]?.[0])).toContain("offline");
  });

  test("ignores a cached build whose executable is missing", async () => {
    const root = useHome();
    const executable = installVersion(root, "150.0.1.2");
    rmSync(executable);
    writeFileSync(
      join(root, "latest.json"),
      JSON.stringify({ version: "150.0.1.2", checkedAt: Date.now() })
    );
    await expect(
      resolveBrowserExecutable({
        fetchImpl: (() => Promise.reject(new Error("offline"))) as never,
      })
    ).rejects.toThrow("offline");
  });

  test("with nothing cached, a failed check is an error", async () => {
    useHome();
    await expect(
      resolveBrowserExecutable({
        fetchImpl: (() => Promise.reject(new Error("offline"))) as never,
      })
    ).rejects.toThrow("offline");
  });

  test("refuses a download outside Google's bucket", async () => {
    useHome();
    await expect(
      resolveBrowserExecutable({
        fetchImpl: (async () =>
          versionIndex(
            "150.0.1.2",
            "https://evil.example/chrome.zip"
          )) as never,
      })
    ).rejects.toThrow("Unexpected Chrome for Testing download origin");
  });

  test("concurrent starts publish one build and prune only builds nothing runs from", async () => {
    const root = useHome();
    installVersion(root, "148.0.0.1");
    const inUse = installVersion(root, "149.0.0.1");
    // Stands in for a browser still running from the older build.
    const browser = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "--", inUse],
      { stdio: "ignore" }
    );
    await new Promise<void>((resolve, reject) => {
      browser.once("spawn", resolve);
      browser.once("error", reject);
    });

    // A real archive, unpacked by the same system tool the CLI shells out to.
    const fixture = mkdtempSync(join(tmpdir(), "lobu-cft-zip-"));
    try {
      const executable = join(fixture, "tree", EXECUTABLE);
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, "#!/bin/sh\n");
      const archive = join(fixture, "chrome.zip");
      if (process.platform === "darwin") {
        execFileSync("ditto", [
          "-c",
          "-k",
          "--keepParent",
          join(fixture, "tree", `chrome-${PLATFORM}`),
          archive,
        ]);
      } else {
        execFileSync("zip", ["-qr", archive, `chrome-${PLATFORM}`], {
          cwd: join(fixture, "tree"),
        });
      }
      const bytes = readFileSync(archive);
      const url = `https://storage.googleapis.com/chrome-for-testing-public/150.0.1.2/${PLATFORM}/chrome-${PLATFORM}.zip`;
      const fetchImpl = mock(async (input: string) =>
        input === url ? new Response(bytes) : versionIndex("150.0.1.2", url)
      );

      const results = await Promise.all(
        Array.from({ length: 2 }, () =>
          resolveBrowserExecutable({
            fetchImpl: fetchImpl as never,
            now: () => 5_000,
            log: () => undefined,
          })
        )
      );
      const resolved = results[0]!;
      expect(results[1]).toBe(resolved);

      expect(resolved).toBe(join(root, "150.0.1.2", EXECUTABLE));
      expect(existsSync(resolved)).toBe(true);
      expect(existsSync(join(root, "148.0.0.1"))).toBe(false);
      expect(existsSync(join(root, "149.0.0.1"))).toBe(true);
      expect(
        JSON.parse(readFileSync(join(root, "latest.json"), "utf8"))
      ).toEqual({ version: "150.0.1.2", checkedAt: 5_000 });
    } finally {
      browser.kill();
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
