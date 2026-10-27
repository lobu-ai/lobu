import { getContextToken } from "../../internal/credentials.js";
import {
  type DeviceState,
  loadDeviceState,
  saveDeviceState,
  updateDeviceState,
} from "../../internal/device-state.js";
import {
  extractApiError,
  fetchWithRetry,
  parseJsonResponse,
} from "../../internal/http.js";
import { loginCommand } from "../login.js";

// Mints and caches the worker-bound child PATs that `lobu daemon` and
// `lobu browser` hand to the devices they run. The caller's installation login
// is the parent credential; it never leaves this process.

export interface MintedDeviceCredential {
  workerId: string;
  workerApiToken: string;
  expiresAt: number;
  /**
   * Browser sign-in session the gateway mints only for a `chrome-extension`
   * device. Handed straight to that browser's side panel, never persisted.
   */
  sessionToken?: string;
}

interface MintDeviceCredentialOptions {
  gatewayOrigin: string;
  bearer: string;
  platform: string;
  workerId: string;
  label: string;
}

export class DeviceMintError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "DeviceMintError";
  }
}

const LOGIN_SETUP_MESSAGE = (contextName: string) =>
  `This Lobu installation is not logged in. Run \`lobu login --force --context ${contextName}\` in an interactive terminal, then retry.`;

export async function requireInstallationLogin(
  contextName: string
): Promise<string> {
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

export async function mintDeviceCredentialWithReauth({
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
  const sessionToken =
    typeof parsed?.session_token === "string" && parsed.session_token
      ? parsed.session_token
      : undefined;
  return {
    workerId,
    workerApiToken,
    expiresAt,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

export async function persistDeviceCredential(
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

export function canPrompt(): boolean {
  const ci = process.env.CI?.trim().toLowerCase();
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    (!ci || ci === "0" || ci === "false")
  );
}
