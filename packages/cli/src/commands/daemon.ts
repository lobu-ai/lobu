import {
  resolveDaemonLaunchContext,
  resolveDaemonWorkerId,
  startDaemonCommand,
} from "@lobu/connector-worker/daemon";
import { hostname } from "node:os";
import {
  addContext,
  apiUrlToGatewayOrigin,
  findContextByOrigin,
  getActiveOrg,
  loadContextConfig,
  type ResolvedContext,
  resolveContext,
} from "../internal/context.js";
import { getContextToken } from "../internal/credentials.js";
import {
  type DeviceState,
  loadDeviceState,
  saveDeviceState,
  updateDeviceState,
} from "../internal/device-state.js";
import {
  extractApiError,
  fetchWithRetry,
  parseJsonResponse,
} from "../internal/http.js";
import { deviceWizard } from "./_lib/device-wizard.js";
import { loginCommand } from "./login.js";

export interface DaemonOptions {
  apiUrl?: string;
  /** Exact installed CLI version advertised to the gateway. */
  cliVersion?: string;
  workerId?: string;
  platform?: string;
  capabilities?: string;
  label?: string;
  debug?: boolean;
  interactiveSession?: boolean;
}

interface DaemonTarget {
  gatewayOrigin: string;
  contextName?: string;
}

interface MintedDeviceCredential {
  workerId: string;
  workerApiToken: string;
  expiresAt: number;
}

interface MintDeviceCredentialOptions {
  gatewayOrigin: string;
  bearer: string;
  platform: string;
  workerId: string;
  label: string;
}

class DeviceMintError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "DeviceMintError";
  }
}

/**
 * How much of a child PAT's life must remain before a start or idle running
 * daemon re-mints it. A third of the server's 90-day expiry keeps rotations
 * rare while leaving time to ride out a temporary gateway outage.
 */
const CHILD_TOKEN_REFRESH_BUFFER_MS = 30 * 24 * 60 * 60 * 1000;
const CHILD_TOKEN_RETRY_MS = 60 * 1000;

/** Shown when `lobu daemon` can't find anything to authorize against. */
const SETUP_MESSAGE =
  "Could not determine a gateway to poll. Configure one of:\n" +
  "  - run `lobu login` to configure a context, or\n" +
  "  - pass --api-url <origin>.";

const LOGIN_SETUP_MESSAGE = (contextName: string) =>
  `This Lobu installation is not logged in. Run \`lobu login --force --context ${contextName}\` in an interactive terminal, then retry.`;

/**
 * Run a headless device worker against one Lobu installation.
 *
 * WORKER_API_TOKEN remains an escape hatch for unattended setups. Ordinarily
 * the command uses the target installation's named OAuth context to mint and
 * cache a worker-bound child PAT. The short-lived OAuth bearer is never handed
 * to the long-running worker and never crosses URL origins.
 */
export async function daemonCommand(options: DaemonOptions): Promise<void> {
  const explicitWorkerToken = process.env.WORKER_API_TOKEN?.trim();
  const target = await resolveDaemonTarget(options.apiUrl);

  const requestedPlatform = options.platform?.trim() || undefined;
  // The native macOS app owns the `macos` platform. A terminal daemon is a
  // headless device on every host, including a Mac running Herdr.
  const defaultPlatform = "headless";
  const launchContext = resolveDaemonLaunchContext({
    platform: requestedPlatform,
    defaultPlatform,
    ...(options.interactiveSession === false
      ? { interactiveSession: false as const }
      : {}),
  });
  const platform = launchContext.platform ?? defaultPlatform;
  const sessionLane = launchContext.interactiveSession !== undefined;
  const shortHost = hostname().split(".")[0] || hostname();
  const explicitWorkerId = options.workerId?.trim() || undefined;
  const sessionWorkerId = sessionLane
    ? resolveDaemonWorkerId(
        { workerId: explicitWorkerId },
        platform,
        shortHost,
        launchContext.interactiveSession
      )
    : undefined;

  let contextName = target.contextName;
  if (!explicitWorkerToken) {
    // Checked before any context is saved: an advanced platform override has no
    // login-based path, so a doomed start must not leave a new context behind.
    if (platform !== "headless") {
      throw new Error(
        `Login-based daemon setup supports the headless platform, not "${platform}". Omit --platform, or provide an explicit WORKER_API_TOKEN for this advanced platform override.`
      );
    }
    if (explicitWorkerId && !explicitWorkerId.startsWith(`${platform}:`)) {
      throw new Error(
        `Login-based daemon worker id "${explicitWorkerId}" does not match platform "${platform}". Use an id beginning with "${platform}:", or omit --worker-id.`
      );
    }
    if (!contextName) {
      contextName = await ensureInstallationContext(target.gatewayOrigin);
    }
  }

  // One cache slot per persisted identity: the host default shares the bare
  // platform key the wizard writes, while an explicit --worker-id gets its own.
  const statePlatform = explicitWorkerId
    ? `${platform}-worker-${explicitWorkerId}`
    : platform;
  // Agent-session identities are deterministic but ephemeral, so they get no
  // cache slot at all. Keep their PAT in this process only: a restart can mint
  // the same worker id again, while the server reaper owns cleanup of
  // abandoned unbound devices and tokens.
  const cachedState =
    contextName && !sessionLane
      ? await loadDeviceState(contextName, statePlatform)
      : null;

  let workerId = explicitWorkerId ?? sessionWorkerId ?? cachedState?.workerId;
  let workerApiToken = explicitWorkerToken;
  let workerCredentialExpiresAt: number | undefined;

  if (workerApiToken) {
    if (!workerApiToken.startsWith("owl_pat_")) {
      throw new Error(
        "WORKER_API_TOKEN must be a Lobu personal access token with an owl_pat_ prefix."
      );
    }
    if (!workerId) {
      workerId = await resolveHostWorkerId(
        platform,
        contextName,
        target.gatewayOrigin,
        workerApiToken
      );
    }
  } else {
    // Assigned above whenever WORKER_API_TOKEN is unset; restated so the mint
    // helpers below see a `string`.
    if (!contextName) throw new Error(SETUP_MESSAGE);

    if (
      workerId &&
      cachedState?.workerId === workerId &&
      hasUsableCachedWorkerToken(cachedState)
    ) {
      workerApiToken = cachedState.workerApiToken;
      workerCredentialExpiresAt = cachedState.expiresAt;
    } else {
      let mintBearer = cachedState?.workerApiToken;
      if (!workerId) {
        mintBearer = await requireInstallationLogin(contextName);
        workerId = await resolveHostWorkerId(
          platform,
          contextName,
          target.gatewayOrigin,
          mintBearer
        );
      }

      const bearer =
        mintBearer ?? (await requireInstallationLogin(contextName));
      const minted = await mintDeviceCredentialWithReauth({
        contextName,
        initialBearerIsChild:
          mintBearer !== undefined &&
          mintBearer === cachedState?.workerApiToken,
        initialChildExpiresAt: cachedState?.expiresAt,
        interactiveReauth: true,
        options: {
          gatewayOrigin: target.gatewayOrigin,
          bearer,
          platform,
          workerId,
          label: options.label?.trim() || shortHost,
        },
      });

      if (minted.workerId !== workerId) {
        throw new Error(
          `The gateway registered worker id "${minted.workerId}" instead of "${workerId}"; refusing to start with a mismatched credential.`
        );
      }
      if (!sessionLane) {
        await persistDeviceCredential(contextName, statePlatform, minted);
      }
      workerApiToken = minted.workerApiToken;
      workerCredentialExpiresAt = minted.expiresAt;
    }
  }

  // Every path above assigns both. Asserted at the package boundary because
  // the fallthrough is `startDaemonCommand`'s own boot check, whose message
  // tells the user to set WORKER_API_TOKEN — the wrong advice on the login path.
  if (!workerId || !workerApiToken) {
    throw new Error(
      `Could not resolve a device identity and credential for ${target.gatewayOrigin}.`
    );
  }

  const workerCredentialMaintenance =
    !explicitWorkerToken &&
    !sessionLane &&
    contextName &&
    workerCredentialExpiresAt
      ? createWorkerCredentialMaintenance({
          contextName,
          statePlatform,
          gatewayOrigin: target.gatewayOrigin,
          platform,
          workerId,
          label: options.label?.trim() || shortHost,
          initialCredential: {
            workerId,
            workerApiToken,
            expiresAt: workerCredentialExpiresAt,
          },
        })
      : undefined;

  const activeOrg = await getActiveOrg(contextName);

  await startDaemonCommand({
    apiUrl: target.gatewayOrigin,
    version: options.cliVersion,
    platform: sessionLane ? "headless" : requestedPlatform,
    defaultPlatform,
    workerId,
    label: options.label?.trim() || undefined,
    capabilities: (options.capabilities ?? "os.shell")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    workerApiToken,
    activeOrg,
    ...(workerCredentialMaintenance ? { workerCredentialMaintenance } : {}),
    debug: options.debug === true,
    ...(options.interactiveSession === false
      ? { interactiveSession: false as const }
      : {}),
  });
}

async function resolveDaemonTarget(
  explicitApiUrl: string | undefined
): Promise<DaemonTarget> {
  const explicit = explicitApiUrl?.trim();
  if (explicit) {
    const gatewayOrigin = requireGatewayOrigin(explicit);
    const matched = await findContextByOrigin(gatewayOrigin);
    return {
      gatewayOrigin,
      ...(matched ? { contextName: matched.name } : {}),
    };
  }

  // Only the lookup itself falls back to the setup message: an unusable URL has
  // to keep reporting the address the user actually configured.
  let context: ResolvedContext;
  try {
    context = await resolveContext();
  } catch {
    throw new Error(SETUP_MESSAGE);
  }
  const gatewayOrigin = requireGatewayOrigin(context.url);
  // LOBU_API_URL is an override just like --api-url: it must not inherit the
  // device state of the otherwise-current named context, only of a context
  // configured for that same origin.
  if (context.source !== "env") {
    return { gatewayOrigin, contextName: context.name };
  }
  const matched = await findContextByOrigin(gatewayOrigin);
  return {
    gatewayOrigin,
    ...(matched ? { contextName: matched.name } : {}),
  };
}

function requireGatewayOrigin(value: string): string {
  const origin = apiUrlToGatewayOrigin(value);
  try {
    return new URL(origin).origin;
  } catch {
    throw new Error(`Invalid gateway URL: ${value}`);
  }
}

async function ensureInstallationContext(
  gatewayOrigin: string
): Promise<string> {
  const matched = await findContextByOrigin(gatewayOrigin);
  if (matched) return matched.name;

  const config = await loadContextConfig();
  const host = new URL(gatewayOrigin).hostname.toLowerCase();
  const baseName = host || "lobu-installation";
  let name = baseName;
  let suffix = 2;
  while (config.contexts[name]) {
    name = `${baseName}-${suffix}`;
    suffix += 1;
  }
  await addContext(name, gatewayOrigin);
  console.log(
    `\n  Saved Lobu installation context "${name}" (${gatewayOrigin}).`
  );
  return name;
}

async function requireInstallationLogin(contextName: string): Promise<string> {
  const existing = await getContextToken(contextName);
  if (existing) return existing;
  return refreshInstallationLogin(contextName);
}

async function refreshInstallationLogin(contextName: string): Promise<string> {
  if (!canPrompt()) throw new Error(LOGIN_SETUP_MESSAGE(contextName));

  // The stored credential is absent, expired, revoked, or predates the daemon's
  // device_worker:run scope. Without --force `lobu login` can short-circuit on
  // that same credential with "Already logged in" and authorize nothing.
  await loginCommand({ context: contextName, force: true });
  const authenticated = await getContextToken(contextName);
  if (!authenticated) throw new Error(LOGIN_SETUP_MESSAGE(contextName));
  return authenticated;
}

async function mintDeviceCredentialWithReauth({
  contextName,
  initialBearerIsChild,
  initialChildExpiresAt,
  interactiveReauth,
  options,
}: {
  contextName: string;
  initialBearerIsChild: boolean;
  initialChildExpiresAt?: number;
  interactiveReauth: boolean;
  options: MintDeviceCredentialOptions;
}): Promise<MintedDeviceCredential> {
  try {
    return await mintDeviceCredential(options);
  } catch (error) {
    if (!isDeviceMintAuthError(error)) throw error;

    // Do not let OAuth silently undo revocation of a still-live child.
    if (initialBearerIsChild) {
      if (!interactiveReauth) throw error;
      if (
        typeof initialChildExpiresAt !== "number" ||
        initialChildExpiresAt > Date.now()
      ) {
        throw new DeviceMintError(
          "The stored device credential was rejected before its local expiry; refusing to replace a possibly revoked device automatically. Re-pair this device explicitly.",
          error.status,
          error.code
        );
      }
      const installationBearer = await requireInstallationLogin(contextName);
      try {
        return await mintDeviceCredential({
          ...options,
          bearer: installationBearer,
        });
      } catch (loginError) {
        if (!isDeviceMintAuthError(loginError)) throw loginError;
      }
    }

    // A stored login can be valid for ordinary MCP work but lack the newer
    // device_worker:run scope. Interactive starts repair it through the same
    // device-code flow; non-interactive starts receive the exact login command.
    if (!interactiveReauth) throw error;
    return mintDeviceCredential({
      ...options,
      bearer: await refreshInstallationLogin(contextName),
    });
  }
}

/**
 * True only for a refusal that re-authenticating can actually clear: an expired
 * or revoked bearer (401), or a bearer the endpoint refuses to mint from
 * (`insufficient_scope` — a missing `device_worker:run`, an MCP resource-bound
 * token, or a child reaching past its own worker id). Every other 403 is a
 * standing account condition (`personal_org_missing`); retrying it would
 * force-revoke a working login through `lobu login --force` and still fail.
 */
function isDeviceMintAuthError(error: unknown): error is DeviceMintError {
  if (!(error instanceof DeviceMintError)) return false;
  if (error.status === 401) return true;
  return error.status === 403 && error.code === "insufficient_scope";
}

function hasUsableCachedWorkerToken(state: DeviceState): boolean {
  return Boolean(
    state.workerApiToken?.startsWith("owl_pat_") &&
      typeof state.expiresAt === "number" &&
      !childTokenNeedsRefresh(state.expiresAt)
  );
}

function childTokenNeedsRefresh(expiresAt: number, now = Date.now()): boolean {
  return expiresAt <= now + CHILD_TOKEN_REFRESH_BUFFER_MS;
}

function createWorkerCredentialMaintenance(options: {
  contextName: string;
  statePlatform: string;
  gatewayOrigin: string;
  platform: string;
  workerId: string;
  label: string;
  initialCredential: MintedDeviceCredential & { expiresAt: number };
}): (activate: (workerApiToken: string) => void) => Promise<void> {
  const { contextName, statePlatform, initialCredential, ...mintTarget } =
    options;
  let current = initialCredential;
  let persistencePending = false;
  let retryAt = 0;

  return async (activate) => {
    const now = Date.now();
    if (now < retryAt) return;

    if (persistencePending) {
      try {
        await persistDeviceCredential(contextName, statePlatform, current);
        persistencePending = false;
        retryAt = 0;
      } catch (error) {
        if (current.expiresAt <= now) {
          throw new Error(
            `The rotated device credential could not be saved before it expired: ${String(error)}`
          );
        }
        retryAt = now + CHILD_TOKEN_RETRY_MS;
        warnCredentialMaintenance(
          "Could not save the rotated device credential",
          error
        );
      }
      return;
    }

    const { expiresAt } = current;
    if (!childTokenNeedsRefresh(expiresAt, now)) return;

    let minted: MintedDeviceCredential;
    try {
      minted = await mintDeviceCredentialWithReauth({
        contextName,
        initialBearerIsChild: true,
        initialChildExpiresAt: expiresAt,
        interactiveReauth: false,
        options: { ...mintTarget, bearer: current.workerApiToken },
      });
    } catch (error) {
      const permanent =
        error instanceof DeviceMintError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429;
      if (permanent || expiresAt <= now) throw error;
      retryAt = Math.min(now + CHILD_TOKEN_RETRY_MS, expiresAt);
      warnCredentialMaintenance(
        "Could not rotate the device credential",
        error
      );
      return;
    }

    if (minted.workerId !== mintTarget.workerId) {
      throw new Error(
        `The gateway rotated worker id "${mintTarget.workerId}" as "${minted.workerId}"; refusing to use a mismatched credential.`
      );
    }

    let persistenceError: unknown;
    try {
      await persistDeviceCredential(contextName, statePlatform, minted);
    } catch (error) {
      persistenceError = error;
    }

    activate(minted.workerApiToken);
    current = minted;
    retryAt = 0;
    if (persistenceError) {
      persistencePending = true;
      retryAt = Date.now() + CHILD_TOKEN_RETRY_MS;
      warnCredentialMaintenance(
        "Could not save the rotated device credential; it remains active in memory",
        persistenceError
      );
    }
  };
}

function warnCredentialMaintenance(message: string, error: unknown): void {
  process.stderr.write(
    `[daemon] ${message}; retrying: ${error instanceof Error ? error.message : String(error)}\n`
  );
}

async function mintDeviceCredential(
  options: MintDeviceCredentialOptions
): Promise<MintedDeviceCredential> {
  const url = `${options.gatewayOrigin}/api/me/devices/mint-child-token`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${options.bearer}`,
      "Content-Type": "application/json",
      "X-Lobu-Client": "cli",
    },
    body: JSON.stringify({
      platform: options.platform,
      worker_id: options.workerId,
      label: options.label,
    }),
  });
  const parsed = (await parseJsonResponse(res, url, (message: string) => {
    throw new DeviceMintError(message, res.status);
  })) as Record<string, unknown> | undefined;
  if (!res.ok) {
    const { message, code } = extractApiError(
      parsed,
      res.status,
      res.statusText
    );
    throw new DeviceMintError(
      `Could not authorize this device: ${message}`,
      res.status,
      code
    );
  }

  const workerId =
    typeof parsed?.worker_id === "string" ? parsed.worker_id : "";
  const workerApiToken =
    typeof parsed?.access_token === "string" ? parsed.access_token : "";
  const expiresAt =
    typeof parsed?.expires_at === "string"
      ? Date.parse(parsed.expires_at)
      : Number.NaN;
  if (
    !workerId ||
    !workerApiToken.startsWith("owl_pat_") ||
    !Number.isFinite(expiresAt)
  ) {
    throw new DeviceMintError(
      "The gateway returned an invalid device credential.",
      res.status
    );
  }
  return {
    workerId,
    workerApiToken,
    expiresAt,
  };
}

async function persistDeviceCredential(
  contextName: string,
  statePlatform: string,
  credential: MintedDeviceCredential
): Promise<void> {
  const state: DeviceState = {
    workerId: credential.workerId,
    workerApiToken: credential.workerApiToken,
    expiresAt: credential.expiresAt,
  };
  const existing = await loadDeviceState(contextName, statePlatform);
  if (existing) {
    await updateDeviceState(contextName, statePlatform, state);
    return;
  }
  try {
    await saveDeviceState(contextName, statePlatform, state);
  } catch (error) {
    const winner = await loadDeviceState(contextName, statePlatform);
    if (winner?.workerId !== state.workerId) throw error;
    await updateDeviceState(contextName, statePlatform, state);
  }
}

/**
 * Resolve a normal host identity for a device that has no cached one yet: the
 * TTY first-run wizard, else the deterministic `<platform>:<hostname>`. Callers
 * consume the cache themselves, so reaching here means there is nothing saved.
 */
async function resolveHostWorkerId(
  platform: string,
  contextName: string | undefined,
  gatewayOrigin: string,
  authorizationToken: string
): Promise<string> {
  const shortHost = hostname().split(".")[0] || hostname();
  const suggested = `${platform}:${shortHost}`;
  // A URL override with no matching context is stateless: it has no context to
  // save the wizard's choice under, so take the deterministic id.
  if (!contextName) return suggested;
  if (!canPrompt()) return suggested;

  const result = await deviceWizard({
    context: contextName,
    gatewayOrigin,
    platform,
    suggestedWorkerId: suggested,
    authorizationToken,
  });
  return result.workerId;
}

function canPrompt(): boolean {
  const ci = process.env.CI?.trim().toLowerCase();
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    (!ci || ci === "0" || ci === "false")
  );
}
