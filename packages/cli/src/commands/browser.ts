import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  apiUrlToGatewayOrigin,
  findContextByOrigin,
  loadContextConfig,
  resolveContext,
} from "../internal/context.js";
import { getContextToken } from "../internal/credentials.js";
import {
  deleteDeviceState,
  loadDeviceState,
} from "../internal/device-state.js";
import {
  extractApiError,
  fetchWithRetry,
  parseJsonResponse,
} from "../internal/http.js";
import { resolveBrowserExecutable } from "./_lib/chrome-for-testing.js";
import {
  DeviceMintError,
  type MintedDeviceCredential,
  mintDeviceCredentialWithReauth,
  persistDeviceCredential,
  requireInstallationLogin,
} from "./_lib/device-credential.js";
import {
  DeviceListError,
  fetchRemoteDevices,
  type RemoteDevice,
} from "./_lib/device-wizard.js";
import {
  encodeNativeMessage,
  readNativeMessage,
} from "./_lib/native-messaging.js";

// A named browser is a Chrome for Testing profile with the Lobu extension
// loaded, registered as its own `chrome-extension` device. The CLI never hands
// the extension a token on the command line: it installs itself as the
// profile's `ai.lobu.bridge` native messaging host, the same host the Mac app
// provides, and the extension's existing desktop pairing asks it for a device
// credential minted from this CLI's login.

const NATIVE_HOST_NAME = "ai.lobu.bridge";
const PLATFORM = "chrome-extension";
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const PAIR_TIMEOUT_MS = 90_000;
const PAIR_POLL_MS = 2_000;
const STOP_TIMEOUT_MS = 10_000;

const execFileAsync = promisify(execFile);

interface BrowserRecord {
  name: string;
  context: string;
  gatewayOrigin: string;
  workerId: string;
  label: string;
}

export interface BrowserStartOptions {
  context?: string;
  headless?: boolean;
}

function browsersRoot(): string {
  return join(homedir(), ".config", "lobu", "browsers");
}

function browserDir(name: string): string {
  return join(browsersRoot(), name);
}

function profileDir(name: string): string {
  return join(browserDir(name), "profile");
}

/** Device-state slot holding the latest credential handed to this browser. */
function credentialSlot(name: string): string {
  return `${PLATFORM}-browser-${name}`;
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (!NAME_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid browser name "${name}". Use 1-32 lowercase letters, digits, or hyphens, starting and ending with a letter or digit.`
    );
  }
  return trimmed;
}

function bundledExtensionDir(): string {
  return fileURLToPath(new URL("../chrome-extension/", import.meta.url));
}

/** Chrome derives an unpacked extension's id from its manifest `key`. */
async function extensionId(extensionDir: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(extensionDir, "manifest.json"), "utf8")
  ) as { key?: string };
  if (!manifest.key) {
    throw new Error("The bundled Lobu extension has no manifest key.");
  }
  return [
    ...createHash("sha256")
      .update(Buffer.from(manifest.key, "base64"))
      .digest("hex")
      .slice(0, 32),
  ]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("");
}

async function readRecord(name: string): Promise<BrowserRecord | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(browserDir(name), "browser.json"), "utf8")
    ) as Partial<BrowserRecord>;
    if (
      parsed.name !== name ||
      typeof parsed.context !== "string" ||
      typeof parsed.gatewayOrigin !== "string" ||
      typeof parsed.workerId !== "string" ||
      typeof parsed.label !== "string"
    ) {
      return null;
    }
    return parsed as BrowserRecord;
  } catch {
    return null;
  }
}

async function requireRecord(name: string): Promise<BrowserRecord> {
  const record = await readRecord(name);
  if (!record) {
    throw new Error(
      `No browser named "${name}". Run \`lobu browser list\` to see your browsers.`
    );
  }
  return record;
}

async function resolveTarget(
  contextOption: string | undefined
): Promise<{ context: string; gatewayOrigin: string }> {
  const resolved = await resolveContext(contextOption);
  const gatewayOrigin = apiUrlToGatewayOrigin(resolved.url);
  if (resolved.source !== "env") {
    return { context: resolved.name, gatewayOrigin };
  }
  // A LOBU_API_URL override only borrows the login of a context saved for it.
  const matched = await findContextByOrigin(gatewayOrigin);
  if (!matched) {
    throw new Error(
      `No saved context points at ${gatewayOrigin}. Run \`lobu login\` for it first.`
    );
  }
  return { context: matched.name, gatewayOrigin };
}

/** The pid of the browser that owns `name`'s profile, or null when none runs. */
async function runningPid(name: string): Promise<number | null> {
  const profile = profileDir(name);
  let lock: string;
  try {
    // Chrome points this at `<hostname>-<pid>` while it holds the profile.
    lock = await readlink(join(profile, "SingletonLock"));
  } catch {
    return null;
  }
  const pid = Number.parseInt(lock.slice(lock.lastIndexOf("-") + 1), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    // The lock outlives a crash, and pids are reused: confirm the process
    // really is a browser on this profile before trusting or signalling it.
    const { stdout } = await execFileAsync("ps", [
      "-ww",
      "-p",
      String(pid),
      "-o",
      "command=",
    ]);
    // Chrome follows the profile flag with further flags, so a trailing space
    // stops `/browsers/work/profile` matching `/browsers/work/profile-other`.
    const argument = `--user-data-dir=${profile}`;
    const command = stdout.trimEnd();
    return command.includes(`${argument} `) || command.endsWith(argument)
      ? pid
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether the browser's context still points at the gateway it paired with. A
 * context repointed elsewhere holds that other gateway's login, which must
 * never be sent to this browser's gateway. Read from the saved contexts, not
 * through LOBU_API_URL, which only overrides where a command connects.
 */
async function contextStillTargets(record: BrowserRecord): Promise<boolean> {
  const entry = (await loadContextConfig()).contexts[record.context];
  return (
    entry !== undefined &&
    apiUrlToGatewayOrigin(entry.url) === record.gatewayOrigin
  );
}

/**
 * Bearers for device requests, best first: the context's login, only while the
 * context still points at this browser's gateway, then the browser's own child
 * credential, which is bound to that gateway and outlives a lapsed login.
 */
async function deviceBearers(record: BrowserRecord): Promise<string[]> {
  const bearers: string[] = [];
  if (await contextStillTargets(record)) {
    const login = await getContextToken(record.context);
    if (login) bearers.push(login);
  }
  const cached = await loadDeviceState(
    record.context,
    credentialSlot(record.name)
  );
  if (cached?.workerId === record.workerId && cached.workerApiToken) {
    bearers.push(cached.workerApiToken);
  }
  if (bearers.length === 0) {
    throw new Error(
      `Context "${record.context}" is not logged in. Run \`lobu login --context ${record.context}\`.`
    );
  }
  return bearers;
}

/**
 * This browser's device, looked up with the first bearer the gateway accepts.
 * Returns that bearer too, so follow-up requests use a credential that works.
 */
async function findDevice(
  record: BrowserRecord
): Promise<{ device: RemoteDevice | null; bearer: string }> {
  let rejection: unknown;
  for (const bearer of await deviceBearers(record)) {
    try {
      const devices = await fetchRemoteDevices(record.gatewayOrigin, bearer);
      const device =
        devices.find((entry) => entry.worker_id === record.workerId) ?? null;
      return { device, bearer };
    } catch (error) {
      const rejected =
        error instanceof DeviceListError &&
        (error.status === 401 || error.status === 403);
      if (!rejected) throw error;
      rejection = error;
    }
  }
  throw rejection;
}

/**
 * Mint a fresh credential for this browser and persist it. The CLI login is
 * preferred: only a full-access login also gets the side panel's sign-in
 * session, which a device-only child credential cannot mint. Rotating the
 * cached child keeps the browser pairable after the login lapses.
 */
async function mintForBrowser(
  record: BrowserRecord,
  interactive: boolean
): Promise<MintedDeviceCredential> {
  // Minting can fall back to the context's login, or refresh it, so it never
  // runs once the context points at another gateway.
  if (!(await contextStillTargets(record))) {
    throw new Error(
      `Context "${record.context}" no longer points at ${record.gatewayOrigin}, where browser "${record.name}" is registered. Point it back, or run \`lobu browser rm ${record.name}\` and start the browser again.`
    );
  }
  const slot = credentialSlot(record.name);
  const cached = await loadDeviceState(record.context, slot);
  const cachedChild =
    cached?.workerId === record.workerId ? cached.workerApiToken : undefined;
  const login = interactive
    ? await requireInstallationLogin(record.context)
    : ((await getContextToken(record.context)) ?? undefined);
  const mint = (bearer: string, isChild: boolean) =>
    mintDeviceCredentialWithReauth({
      contextName: record.context,
      initialBearerIsChild: isChild,
      initialChildExpiresAt: cached?.expiresAt,
      interactiveReauth: interactive,
      options: {
        gatewayOrigin: record.gatewayOrigin,
        bearer,
        platform: PLATFORM,
        workerId: record.workerId,
        label: record.label,
      },
    });

  let minted: MintedDeviceCredential;
  if (login) {
    try {
      minted = await mint(login, false);
    } catch (error) {
      if (!cachedChild || !(error instanceof DeviceMintError)) throw error;
      minted = await mint(cachedChild, true);
    }
  } else if (cachedChild) {
    minted = await mint(cachedChild, true);
  } else {
    throw new Error(
      `Context "${record.context}" is not logged in. Run \`lobu browser start ${record.name}\` in a terminal.`
    );
  }
  if (minted.workerId !== record.workerId) {
    throw new Error(
      `The gateway registered this browser as "${minted.workerId}" instead of "${record.workerId}". Another device of yours already uses that id; remove it or pick a different browser name.`
    );
  }
  await persistDeviceCredential(record.context, slot, minted);
  return minted;
}

async function writeNativeHost(
  name: string,
  extensionDir: string
): Promise<void> {
  const dir = browserDir(name);
  const wrapper = join(dir, "native-host");
  const cliEntry = fileURLToPath(new URL("../../bin/lobu.js", import.meta.url));
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  // Chrome passes a host no arguments of our choosing, so the browser name is
  // baked into this per-browser script. Rewritten on every start so it follows
  // the CLI and Node the user runs now.
  await writeFile(
    wrapper,
    `#!/bin/sh\n# Generated by \`lobu browser start\`. Chrome runs this to pair the Lobu extension.\nexec ${quote(process.execPath)} ${quote(cliEntry)} browser native-host ${quote(name)}\n`,
    { mode: 0o700 }
  );
  await chmod(wrapper, 0o700);

  // Chrome looks for user-level hosts in <user-data-dir>/NativeMessagingHosts,
  // so this host serves only this browser and never the user's own Chrome.
  const hostsDir = join(profileDir(name), "NativeMessagingHosts");
  await mkdir(hostsDir, { recursive: true });
  await writeFile(
    join(hostsDir, `${NATIVE_HOST_NAME}.json`),
    `${JSON.stringify(
      {
        name: NATIVE_HOST_NAME,
        description: `Lobu pairing for the "${name}" browser`,
        path: wrapper,
        type: "stdio",
        allowed_origins: [
          `chrome-extension://${await extensionId(extensionDir)}/`,
        ],
      },
      null,
      2
    )}\n`
  );
}

async function waitForFirstPoll(
  record: BrowserRecord,
  previousSeenAt: string | null
): Promise<RemoteDevice> {
  const deadline = Date.now() + PAIR_TIMEOUT_MS;
  for (;;) {
    const { device } = await findDevice(record);
    // A poll stamps app_version; minting the credential only touches
    // last_seen_at, so a fresh device is not online until it has polled.
    if (
      device?.online &&
      device.app_version &&
      device.last_seen_at !== previousSeenAt
    ) {
      return device;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `The "${record.name}" browser opened but did not connect within ${PAIR_TIMEOUT_MS / 1000}s. Open the Lobu side panel in that window to see why; the pairing log is ${join(browserDir(record.name), "native-host.log")}.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, PAIR_POLL_MS));
  }
}

export async function browserStartCommand(
  rawName: string,
  options: BrowserStartOptions
): Promise<void> {
  const name = requireName(rawName);
  const extensionDir = bundledExtensionDir();
  if (!existsSync(join(extensionDir, "manifest.json"))) {
    throw new Error(
      `This lobu build does not include the Lobu extension (looked in ${extensionDir}).`
    );
  }

  let record = await readRecord(name);
  if (record && options.context && options.context !== record.context) {
    throw new Error(
      `Browser "${name}" belongs to context "${record.context}". Use \`--context ${record.context}\`, or \`lobu browser rm ${name}\` first.`
    );
  }
  if (!record) {
    const target = await resolveTarget(options.context);
    const shortHost = hostname().split(".")[0] || hostname();
    record = {
      name,
      context: target.context,
      gatewayOrigin: target.gatewayOrigin,
      workerId: `${PLATFORM}:${shortHost}:${name}`,
      label: `${name} (${shortHost})`,
    };
  }

  // Authorize up front, where a login prompt is still possible: the native
  // host later runs under Chrome with no terminal. Skipped while the cached
  // credential is live, because re-minting would revoke the one the extension
  // is using.
  const cached = await loadDeviceState(record.context, credentialSlot(name));
  if (
    cached?.workerId !== record.workerId ||
    !cached.expiresAt ||
    cached.expiresAt <= Date.now()
  ) {
    await mintForBrowser(record, true);
  }

  await mkdir(profileDir(name), { recursive: true });
  await writeFile(
    join(browserDir(name), "browser.json"),
    `${JSON.stringify(record, null, 2)}\n`
  );
  await writeNativeHost(name, extensionDir);

  const pid = await runningPid(name);
  if (pid) {
    const { device } = await findDevice(record);
    console.log(
      `Browser "${name}" is already running (pid ${pid}, device ${device?.online ? "online" : "offline"}).`
    );
    return;
  }

  const executable = await resolveBrowserExecutable();
  const { device: previous } = await findDevice(record);
  const child = spawn(
    executable,
    [
      `--user-data-dir=${profileDir(name)}`,
      `--load-extension=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(options.headless ? ["--headless=new"] : []),
    ],
    { detached: true, stdio: "ignore" }
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();

  console.log(`Starting browser "${name}"…`);
  const device = await waitForFirstPoll(record, previous?.last_seen_at ?? null);
  console.log(`Browser "${name}" is connected as device "${record.label}".`);
  console.log(`  Device id: ${device.id}`);
  console.log(
    `  Workspace context: ${record.context} (${record.gatewayOrigin})`
  );
  console.log(`  Profile: ${profileDir(name)}`);
}

export async function browserStopCommand(rawName: string): Promise<void> {
  const name = requireName(rawName);
  await requireRecord(name);
  const pid = await runningPid(name);
  if (!pid) {
    console.log(`Browser "${name}" is not running.`);
    return;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while ((await runningPid(name)) === pid) {
    if (Date.now() >= deadline) {
      process.kill(pid, "SIGKILL");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log(`Stopped browser "${name}".`);
}

export async function browserListCommand(options: {
  json?: boolean;
}): Promise<void> {
  let names: string[] = [];
  try {
    names = (await readdir(browsersRoot())).sort();
  } catch {
    // No browsers yet.
  }
  const rows: Array<{
    name: string;
    context: string;
    running: boolean;
    device: "online" | "offline" | "missing" | "unknown";
    profile: string;
  }> = [];
  for (const name of names) {
    const record = await readRecord(name);
    if (!record) continue;
    let device: (typeof rows)[number]["device"] = "unknown";
    try {
      const { device: found } = await findDevice(record);
      device = found ? (found.online ? "online" : "offline") : "missing";
    } catch {
      // Offline gateway or lapsed login: show the browser anyway.
    }
    rows.push({
      name,
      context: record.context,
      running: (await runningPid(name)) !== null,
      device,
      profile: profileDir(name),
    });
  }

  if (options.json) {
    console.log(JSON.stringify({ browsers: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("No browsers yet. Start one with `lobu browser start <name>`.");
    return;
  }
  for (const row of rows) {
    console.log(
      `${row.name}\t${row.running ? "running" : "stopped"}\tdevice ${row.device}\t${row.context}`
    );
  }
}

export async function browserRemoveCommand(rawName: string): Promise<void> {
  const name = requireName(rawName);
  const record = await requireRecord(name);
  if (await runningPid(name)) await browserStopCommand(name);

  const { device, bearer } = await findDevice(record);
  if (device) {
    const url = `${record.gatewayOrigin}/api/me/devices/${encodeURIComponent(device.id)}`;
    const res = await fetchWithRetry(url, {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${bearer}`,
        "X-Lobu-Client": "cli",
      },
    });
    if (!res.ok) {
      const parsed = await parseJsonResponse(res, url, (message: string) => {
        throw new Error(message);
      });
      const { message } = extractApiError(parsed, res.status, res.statusText);
      throw new Error(
        `Could not remove the "${name}" device, so its profile was kept: ${message}`
      );
    }
  }
  await deleteDeviceState(record.context, credentialSlot(name));
  await rm(browserDir(name), { recursive: true, force: true });
  console.log(`Removed browser "${name}" and its device.`);
}

/**
 * The native host's answer to one extension message. A `pair` request gets a
 * freshly minted device credential in the desktop bridge's reply shape; every
 * other message (the extension also publishes ambient tab context to a desktop
 * app, which a named browser does not have) is declined.
 */
export async function nativeHostReply(
  name: string,
  message: unknown,
  log: (line: string) => Promise<unknown>
): Promise<Record<string, unknown>> {
  if ((message as { op?: unknown } | null)?.op !== "pair") {
    return { ok: false, error: "unsupported" };
  }
  try {
    const record = await requireRecord(name);
    const minted = await mintForBrowser(record, false);
    await log(
      `paired worker ${minted.workerId} ${minted.sessionToken ? "with" : "without"} a side panel session`
    );
    return {
      gateway_url: record.gatewayOrigin,
      worker_id: minted.workerId,
      access_token: minted.workerApiToken,
      session_token: minted.sessionToken ?? null,
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await log(`pairing failed: ${text}`);
    return { error: text };
  }
}

/**
 * Native messaging host Chrome starts for the extension's desktop pairing.
 * stdout is the framed channel to Chrome, so every other line goes to a log.
 */
export async function browserNativeHostCommand(rawName: string): Promise<void> {
  const name = requireName(rawName);
  const logFile = join(browserDir(name), "native-host.log");
  const log = (line: string) =>
    appendFile(logFile, `${new Date().toISOString()} ${line}\n`).catch(
      () => undefined
    );
  console.log = (...args: unknown[]) => {
    void log(args.map(String).join(" "));
  };

  const reply = await nativeHostReply(
    name,
    await readNativeMessage(process.stdin),
    log
  );
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(encodeNativeMessage(reply), (error) =>
      error ? reject(error) : resolve()
    )
  );
}
