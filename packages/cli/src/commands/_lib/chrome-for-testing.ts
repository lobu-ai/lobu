import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

// `lobu browser` runs Chrome for Testing, not the user's Google Chrome: branded
// Chrome ignores --load-extension, which is how the Lobu extension gets into a
// named browser. Google publishes the builds and this version index.
const VERSIONS_URL =
  "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
const DOWNLOAD_HOST = "storage.googleapis.com";
/** How often `start` asks Google for a newer Stable build. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const VERSION_PATTERN = /^\d+(\.\d+)+$/;

const execFileAsync = promisify(execFile);

type ChromePlatform = "mac-arm64" | "mac-x64" | "linux64" | "linux-arm64";

interface LatestRecord {
  version: string;
  checkedAt: number;
}

export interface ResolveBrowserOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

function cacheRoot(): string {
  return join(homedir(), ".cache", "lobu", "chrome-for-testing");
}

function chromePlatform(): ChromePlatform {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  }
  if (process.platform === "linux") {
    if (process.arch === "x64") return "linux64";
    if (process.arch === "arm64") return "linux-arm64";
  }
  throw new Error(
    `lobu browser supports macOS and Linux on x64 or arm64, not ${process.platform}/${process.arch}.`
  );
}

function executablePath(versionDir: string, platform: ChromePlatform): string {
  const root = join(versionDir, `chrome-${platform}`);
  return platform.startsWith("mac")
    ? join(
        root,
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing"
      )
    : join(root, "chrome");
}

/** A build is usable once fully unpacked and marked complete. */
function isInstalled(versionDir: string, platform: ChromePlatform): boolean {
  return (
    existsSync(join(versionDir, ".complete")) &&
    existsSync(executablePath(versionDir, platform))
  );
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function installedVersions(
  root: string,
  platform: ChromePlatform
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        VERSION_PATTERN.test(entry) && isInstalled(join(root, entry), platform)
    )
    .sort(compareVersions);
}

async function readLatest(root: string): Promise<LatestRecord | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(root, "latest.json"), "utf8")
    ) as Partial<LatestRecord>;
    return typeof parsed.version === "string" &&
      typeof parsed.checkedAt === "number"
      ? { version: parsed.version, checkedAt: parsed.checkedAt }
      : null;
  } catch {
    return null;
  }
}

async function fetchStable(
  platform: ChromePlatform,
  fetchImpl: typeof fetch
): Promise<{ version: string; url: string }> {
  const response = await fetchImpl(VERSIONS_URL, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `Chrome for Testing version index returned ${response.status}`
    );
  }
  const index = (await response.json()) as {
    channels?: {
      Stable?: {
        version?: string;
        downloads?: { chrome?: Array<{ platform?: string; url?: string }> };
      };
    };
  };
  const stable = index.channels?.Stable;
  const url = stable?.downloads?.chrome?.find(
    (entry) => entry.platform === platform
  )?.url;
  if (!stable?.version || !VERSION_PATTERN.test(stable.version) || !url) {
    throw new Error(`Chrome for Testing has no Stable build for ${platform}`);
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== DOWNLOAD_HOST) {
    throw new Error(
      `Unexpected Chrome for Testing download origin: ${parsed.origin}`
    );
  }
  return { version: stable.version, url };
}

async function download(
  url: string,
  file: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Chrome for Testing download failed (${response.status})`);
  }
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    async function* limit(chunks: AsyncIterable<Buffer>) {
      let bytes = 0;
      for await (const chunk of chunks) {
        bytes += chunk.length;
        if (bytes > MAX_ARCHIVE_BYTES) {
          throw new Error("Chrome for Testing archive exceeds 1 GiB");
        }
        yield chunk;
      }
    },
    createWriteStream(file)
  );
}

async function unzip(archive: string, destination: string): Promise<void> {
  // macOS: ditto keeps the app bundle's framework symlinks and permissions.
  const [command, args] =
    process.platform === "darwin"
      ? ["ditto", ["-x", "-k", archive, destination]]
      : ["unzip", ["-q", archive, "-d", destination]];
  try {
    await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const missing = (error as { code?: unknown }).code === "ENOENT";
    throw new Error(
      missing
        ? `\`${command}\` is required to unpack Chrome for Testing; install it and retry.`
        : `Could not unpack Chrome for Testing: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function install(
  root: string,
  version: string,
  url: string,
  platform: ChromePlatform,
  fetchImpl: typeof fetch,
  log: (message: string) => void
): Promise<void> {
  const staging = await mkdtemp(join(root, `.staging-${version}-`));
  try {
    log(`Downloading Chrome for Testing ${version}…`);
    const archive = join(staging, "chrome.zip");
    await download(url, archive, fetchImpl);
    await unzip(archive, staging);
    await rm(archive);
    if (!existsSync(executablePath(staging, platform))) {
      throw new Error("Chrome for Testing archive has an unexpected layout");
    }
    await writeFile(join(staging, ".complete"), `${version}\n`);
    const target = join(root, version);
    try {
      await rename(staging, target);
    } catch (error) {
      // Another start may have published the same build while we downloaded.
      // Never replace it: a browser may already be executing from that path.
      const code = (error as NodeJS.ErrnoException).code;
      if (
        (code !== "EEXIST" && code !== "ENOTEMPTY") ||
        !isInstalled(target, platform)
      ) {
        throw error;
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Delete superseded builds that no running process was started from. A named
 * browser can stay open across several updates and keeps loading resources
 * from its own build, so only the process table proves a build is unused.
 */
async function prune(
  root: string,
  current: string,
  platform: ChromePlatform
): Promise<void> {
  let processes: string;
  try {
    ({ stdout: processes } = await execFileAsync(
      "ps",
      ["-axww", "-o", "command="],
      { maxBuffer: 64 * 1024 * 1024 }
    ));
  } catch {
    return;
  }
  for (const version of await installedVersions(root, platform)) {
    const dir = join(root, version);
    if (version !== current && !processes.includes(`${dir}/`)) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * The Chrome for Testing executable for named browsers. Uses the cached Stable
 * build, checking Google for a newer one at most once a day; a failed check
 * falls back to the newest cached build. `LOBU_BROWSER_PATH` points at an
 * existing Chromium or Chrome for Testing binary instead.
 */
export async function resolveBrowserExecutable(
  options: ResolveBrowserOptions = {}
): Promise<string> {
  const override = process.env.LOBU_BROWSER_PATH?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `LOBU_BROWSER_PATH points at a missing file: ${override}`
      );
    }
    return override;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.error(message));
  const platform = chromePlatform();
  const root = cacheRoot();
  await mkdir(root, { recursive: true });

  const installed = await installedVersions(root, platform);
  const latest = await readLatest(root);
  if (
    latest &&
    now() - latest.checkedAt < CHECK_INTERVAL_MS &&
    installed.includes(latest.version)
  ) {
    return executablePath(join(root, latest.version), platform);
  }

  let stable: { version: string; url: string };
  try {
    stable = await fetchStable(platform, fetchImpl);
  } catch (error) {
    const newest = installed.at(-1);
    if (!newest) throw error;
    log(
      `Could not check for a newer Chrome for Testing (${error instanceof Error ? error.message : String(error)}); using ${newest}.`
    );
    return executablePath(join(root, newest), platform);
  }

  if (!installed.includes(stable.version)) {
    await install(root, stable.version, stable.url, platform, fetchImpl, log);
    await prune(root, stable.version, platform);
  }
  await writeFile(
    join(root, "latest.json"),
    `${JSON.stringify({ version: stable.version, checkedAt: now() })}\n`
  );
  return executablePath(join(root, stable.version), platform);
}
