import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface DeviceState {
  workerId: string;
  /** Worker-bound child PAT minted by the installation login. */
  workerApiToken?: string;
  /** Epoch ms hard expiry for workerApiToken. */
  expiresAt?: number;
}

// Resolve lazily so home-directory overrides use the matching config root.
function devicesDir(): string {
  return join(homedir(), ".config", "lobu", "devices");
}

function statePath(context: string, platform: string): string {
  const key = `${encodeURIComponent(context)}--${encodeURIComponent(platform)}`;
  return join(devicesDir(), `${key}.json`);
}

export async function loadDeviceState(
  context: string,
  platform: string
): Promise<DeviceState | null> {
  try {
    const parsed = JSON.parse(
      await readFile(statePath(context, platform), "utf-8")
    ) as Partial<DeviceState>;
    if (
      typeof parsed.workerId !== "string" ||
      !WORKER_ID_PATTERN.test(parsed.workerId)
    ) {
      return null;
    }
    const workerApiToken =
      typeof parsed.workerApiToken === "string" &&
      parsed.workerApiToken.startsWith("owl_pat_")
        ? parsed.workerApiToken
        : undefined;
    const expiresAt =
      typeof parsed.expiresAt === "number" &&
      Number.isFinite(parsed.expiresAt) &&
      parsed.expiresAt > 0
        ? parsed.expiresAt
        : undefined;
    return {
      workerId: parsed.workerId,
      ...(workerApiToken ? { workerApiToken } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  } catch {
    return null;
  }
}

/** Replace credentials for an already-saved identity without changing its id. */
export async function updateDeviceState(
  context: string,
  platform: string,
  state: DeviceState
): Promise<void> {
  if (!WORKER_ID_PATTERN.test(state.workerId)) {
    throw new Error(`invalid device worker id '${state.workerId}'`);
  }
  if (
    state.workerApiToken !== undefined &&
    !state.workerApiToken.startsWith("owl_pat_")
  ) {
    throw new Error("invalid device worker token");
  }

  const current = await loadDeviceState(context, platform);
  if (!current || current.workerId !== state.workerId) {
    throw new Error(
      `Refusing to replace device state at ${statePath(context, platform)}: the saved worker id changed or became unreadable. Delete that file to redo setup.`
    );
  }

  const file = statePath(context, platform);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp).catch(() => undefined);
    throw error;
  }
}

/** Persist one completed setup without allowing two first boots to race. */
export async function saveDeviceState(
  context: string,
  platform: string,
  state: DeviceState
): Promise<void> {
  if (!WORKER_ID_PATTERN.test(state.workerId)) {
    throw new Error(`invalid device worker id '${state.workerId}'`);
  }
  if (
    state.workerApiToken !== undefined &&
    !state.workerApiToken.startsWith("owl_pat_")
  ) {
    throw new Error("invalid device worker token");
  }

  const dir = devicesDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);

  try {
    await writeFile(
      statePath(context, platform),
      `${JSON.stringify(state, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      // Either a concurrent first boot won the race, or the caller read an
      // unreadable/invalid file as "no identity yet" — `loadDeviceState`
      // reports both as null, so name both causes rather than guess.
      throw new Error(
        `Device state at ${statePath(context, platform)} already exists or is unreadable; stop any other daemon on this context, or delete that file to redo setup.`
      );
    }
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/** Forget one saved identity after its device has been removed. */
export async function deleteDeviceState(
  context: string,
  platform: string
): Promise<void> {
  await rm(statePath(context, platform), { force: true });
}
