/**
 * Tells a long-running `lobu daemon` user that a newer CLI is published.
 *
 * A headless daemon runs for weeks on whatever version started it, and nothing
 * else tells its owner that it is outdated. The check reads the public
 * `@lobu/cli` dist-tags once at start and about once a day after that. It
 * never blocks the daemon and never fails it: any network, parse or version
 * problem is a silent skip. `LOBU_NO_UPDATE_CHECK=1` turns it off.
 */

const DIST_TAGS_URL =
  "https://registry.npmjs.org/-/package/@lobu/cli/dist-tags";
const CHECK_TIMEOUT_MS = 5_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OPT_OUT_ENV = "LOBU_NO_UPDATE_CHECK";

/** How a headless daemon user gets onto the latest CLI. */
export const CLI_DAEMON_UPGRADE_STEPS =
  "restart it with `npx -y @lobu/cli@latest daemon`, or run `npm install -g @lobu/cli@latest` and restart `lobu daemon`";

/**
 * Release components of `major.minor.patch`, ignoring any `-prerelease` or
 * `+build` suffix and a fourth build component; null when unparseable.
 */
function releaseOf(version: string): [number, number, number] | null {
  const core = version.trim().split("+")[0]?.split("-")[0] ?? "";
  const parts = core.split(".");
  if (parts.length < 3 || parts.length > 4) return null;
  const numbers = parts.map((part) =>
    part !== "" && [...part].every((char) => char >= "0" && char <= "9")
      ? Number(part)
      : Number.NaN
  );
  if (numbers.some((value) => !Number.isSafeInteger(value))) return null;
  const [major, minor, patch] = numbers as [number, number, number];
  return [major, minor, patch];
}

/**
 * True when `latest` is a strictly newer release than `current`. A canary
 * (`X.Y.Z-canary…`) is built after release X.Y.Z, so it is only behind a
 * strictly newer release.
 */
export function isNewerCliRelease(current: string, latest: string): boolean {
  const have = releaseOf(current);
  const want = releaseOf(latest);
  if (!have || !want) return false;
  const [haveMajor, haveMinor, havePatch] = have;
  const [wantMajor, wantMinor, wantPatch] = want;
  if (wantMajor !== haveMajor) return wantMajor > haveMajor;
  if (wantMinor !== haveMinor) return wantMinor > haveMinor;
  return wantPatch > havePatch;
}

/** The one line printed when a newer CLI exists, or null. Never throws. */
export async function checkForCliUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
  stopSignal?: AbortSignal
): Promise<string | null> {
  try {
    const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS);
    const response = await fetchImpl(DIST_TAGS_URL, {
      signal: stopSignal ? AbortSignal.any([stopSignal, timeout]) : timeout,
    });
    if (!response.ok) return null;
    const tags = (await response.json()) as { latest?: unknown } | null;
    const latest = typeof tags?.latest === "string" ? tags.latest : null;
    if (!latest || !isNewerCliRelease(currentVersion, latest)) return null;
    return `Lobu CLI ${latest} is available (this daemon runs ${currentVersion}). To update, ${CLI_DAEMON_UPGRADE_STEPS}. Set ${OPT_OUT_ENV}=1 to silence this check.`;
  } catch {
    return null;
  }
}

/**
 * Check now and about every 24h, printing to stderr when a newer CLI exists.
 * Returns a stop function. Does nothing when the running version is unknown
 * or the user opted out. The timer is unref'd so it never keeps the process
 * alive on its own.
 */
export function startCliUpdateNotifier(options: {
  currentVersion: string | undefined;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  print?: (line: string) => void;
  intervalMs?: number;
}): () => void {
  const env = options.env ?? process.env;
  const currentVersion = options.currentVersion?.trim();
  const optOut = env[OPT_OUT_ENV]?.trim();
  if (!currentVersion || (optOut && optOut !== "0")) return () => undefined;
  const print =
    options.print ?? ((line: string) => process.stderr.write(`${line}\n`));
  const controller = new AbortController();
  const check = () => {
    void checkForCliUpdate(
      currentVersion,
      options.fetchImpl,
      controller.signal
    ).then((line) => {
      if (line && !controller.signal.aborted) print(line);
    });
  };
  check();
  const timer = setInterval(check, options.intervalMs ?? CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    controller.abort();
  };
}
