import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import {
  saveDeviceState,
  WORKER_ID_PATTERN,
} from "../../internal/device-state.js";
import {
  extractApiError,
  fetchWithRetry,
  parseJsonResponse,
} from "../../internal/http.js";

const NEW_DEVICE_CHOICE = "__lobu_new_device__";

export interface DeviceWizardOptions {
  context: string;
  gatewayOrigin: string;
  platform: string;
  suggestedWorkerId: string;
  /**
   * Bearer for `GET /api/me/devices`. Either the installation's OAuth login
   * (login-based setup) or an explicit `WORKER_API_TOKEN` — the wizard only
   * lists devices, so it never depends on which one it was handed.
   */
  authorizationToken: string;
  prompts?: DeviceWizardPrompts;
}

export interface RemoteDevice {
  id: string;
  worker_id: string;
  platform: string | null;
  online: boolean;
  label?: string | null;
  organization_slug?: string | null;
  /** Stamped by the device's first poll; minting a credential leaves it unset. */
  app_version?: string | null;
  last_seen_at?: string | null;
}

export interface DeviceWizardResult {
  workerId: string;
  source: "reused" | "created";
}

export interface DeviceWizardPrompts {
  select: (config: Parameters<typeof select>[0]) => Promise<string>;
  confirm: (config: Parameters<typeof confirm>[0]) => Promise<boolean>;
  input: (config: Parameters<typeof input>[0]) => Promise<string>;
}

export async function deviceWizard(
  options: DeviceWizardOptions
): Promise<DeviceWizardResult> {
  const prompts = options.prompts ?? { select, confirm, input };
  const devices = await fetchRemoteDevices(
    options.gatewayOrigin,
    options.authorizationToken
  );
  const reusable = devices.filter(
    (device) => device.platform === options.platform && !device.online
  );

  console.log();
  console.log(chalk.bold("  Set up this device as a Lobu worker"));
  console.log(
    chalk.dim(
      "  It polls the gateway for connector syncs, actions, and device Automations.\n"
    )
  );

  let workerId = options.suggestedWorkerId;
  let source: DeviceWizardResult["source"] = "created";
  let selectedDevice: RemoteDevice | undefined;

  if (reusable.length > 0) {
    const choice = await prompts.select({
      message: "Pick an offline device identity (or start a new one)",
      choices: [
        {
          value: NEW_DEVICE_CHOICE,
          name: chalk.dim("Start a new device"),
        },
        ...reusable.map((device) => ({
          value: device.id,
          name: `${device.label ?? device.worker_id}${
            device.organization_slug
              ? chalk.dim(` — ${device.organization_slug}`)
              : ""
          }`,
        })),
      ],
    });
    if (choice !== NEW_DEVICE_CHOICE) {
      selectedDevice = reusable.find((device) => device.id === choice);
      if (!selectedDevice) {
        throw new Error("Selected device is no longer available");
      }
      workerId = selectedDevice.worker_id;
      source = "reused";
    }
  }

  if (source === "created") {
    const confirmed = await prompts.confirm({
      message: `Register this machine as device "${chalk.bold(options.suggestedWorkerId)}"?`,
      default: true,
    });
    if (!confirmed) {
      workerId = (
        await prompts.input({
          message:
            "Enter a device id (letters, digits, dot, underscore, colon, hyphen):",
          validate: (value) =>
            WORKER_ID_PATTERN.test(value.trim())
              ? true
              : "Use 1-128 characters of letters, digits, dot, underscore, colon or hyphen",
        })
      ).trim();
    }

    const collision = devices.find((device) => device.worker_id === workerId);
    if (collision) {
      if (collision.platform !== options.platform) {
        throw new Error(
          `Device "${workerId}" is registered as ${collision.platform ?? "an unknown platform"}; choose a different id.`
        );
      }
      if (collision.online) {
        throw new Error(
          `Device "${workerId}" is already online; stop its daemon or choose a different id.`
        );
      }
      selectedDevice = collision;
      source = "reused";
    }
  }

  await saveDeviceState(options.context, options.platform, { workerId });

  console.log(chalk.green(`\n  Device identity "${workerId}" saved locally.`));
  if (source === "reused") {
    const workspace = selectedDevice?.organization_slug;
    console.log(
      chalk.dim(
        `  Reusing the existing device; server workspace: ${workspace ? `"${workspace}"` : "unattached"}.`
      )
    );
  } else {
    console.log(
      chalk.dim(
        "  Its workspace attachment is decided when this device is first authorized."
      )
    );
  }
  console.log(
    chalk.dim(
      `  Saved for context "${options.context}" on ${options.platform}; later runs reuse it.`
    )
  );
  console.log();

  return { workerId, source };
}

export async function fetchRemoteDevices(
  gatewayOrigin: string,
  token: string
): Promise<RemoteDevice[]> {
  const url = `${gatewayOrigin}/api/me/devices`;
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const parsed = (await parseJsonResponse(res, url, (message: string) => {
    throw new Error(message);
  })) as { devices?: unknown } | undefined;
  if (!res.ok) {
    const { message } = extractApiError(parsed, res.status, res.statusText);
    throw new Error(`Could not list devices: ${message}`);
  }
  if (!Array.isArray(parsed?.devices)) {
    throw new Error(
      "Could not list devices: gateway returned an invalid response"
    );
  }
  return parsed.devices.filter(isRemoteDevice);
}

function isRemoteDevice(value: unknown): value is RemoteDevice {
  if (!value || typeof value !== "object") return false;
  const device = value as Record<string, unknown>;
  return (
    typeof device.id === "string" &&
    device.id.length > 0 &&
    typeof device.worker_id === "string" &&
    device.worker_id.length > 0 &&
    (device.platform === null || typeof device.platform === "string") &&
    typeof device.online === "boolean"
  );
}
