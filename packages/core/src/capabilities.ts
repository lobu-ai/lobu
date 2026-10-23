// Server-side capability authorization for device workers.
//
// Devices self-report their `platform` and a list of capability strings on
// each poll (see worker-api.ts). The gateway must not trust those strings
// blindly: a compromised or buggy device could claim arbitrary capabilities
// and start matching unrelated connectors. This registry maps each known
// platform to the capabilities it is allowed to advertise. Anything outside
// the allowlist is silently dropped (the device's effective capability set
// shrinks; nothing throws).
//
// The trusted-fleet path (no `platform` on the row — those workers run with
// WORKER_API_TOKEN and the `c.var.workerAuthMode !== 'user'` branch) bypasses
// authorization entirely; we trust them by definition.

// Capability strings — keep namespaced (`browser.*`, `os.*`, `ios.*`) so the
// registry stays readable as new device kinds land.
export const BROWSER_CAPABILITIES = [
  "browser.tabs",
  "browser.scripting",
  "browser.history",
  "browser.bookmarks",
  "browser.downloads",
  "browser.notifications",
  "browser.debugger",
  // browser.cookies intentionally absent in v1 — high-trust, not approved
] as const;

export const OS_CAPABILITIES = [
  "os.shell",
  "os.files",
  "os.notifications",
] as const;

export const IOS_CAPABILITIES = [
  "ios.notifications",
  "ios.share-sheet",
  "ios.files",
] as const;

// Capabilities the Mac bridge advertises (lobu-ai/owletto: apps/mac/Lobu/AppState.swift).
// One entry per Mac connector that runs on-device — adding a new Mac
// connector means adding its capability string here so the gateway lets
// the device claim its runs.
export const MAC_DEVICE_CAPABILITIES = [
  // The standalone Mac daemon opts into run-scoped Automation sessions by
  // advertising this capability. Legacy Swift workers omit it and retain the
  // existing instructions-only/legacy session handling.
  "automations.execute",
  "screentime",
  // Advertised only by Mac builds released before the Local Folder removal.
  // Drop with the `local.directory` platform allowance in device-manifests.ts.
  "local_directory",
  "healthkit",
  "photos",
  "calendar",
  "reminders",
  // Advertised only by Mac builds released before native meeting recording was
  // retired (owletto #1211); they still send the `apple.system_audio` manifest,
  // and one disallowed capability rejects the whole manifest payload. Drop this
  // once MIN_CLIENT_VERSION excludes those builds.
  "system_audio",
  "computer_use",
] as const;

// A server/VM with no UI or browser (the herdr box, a CI node, a k8s pod).
// The device daemon can run agent work and touch a shell/files, but has no
// browser to drive and no screen to notify. Keep this set small and honest -
// add strings here only as headless connectors actually land.
//
// `automations.execute` is the rolling-deploy-safe claim gate for headless
// Automation execution: the server only hands `run_type='automation'` runs to
// device workers that advertise it, so a daemon build that predates the
// automation lane can never claim one and wedge it. The daemon adds the string
// itself on the headless platform (WorkerClient.advertisedCapabilities), which
// is what makes it a build signal rather than an operator flag; whether a given
// host can launch the Automation's CLI is the separate `agent_kinds` gate.
export const HEADLESS_CAPABILITIES = [
  "os.shell",
  "os.files",
  "automations.execute",
] as const;

const PLATFORM_ALLOWLIST: Record<string, readonly string[]> = {
  macos: [
    ...OS_CAPABILITIES,
    ...BROWSER_CAPABILITIES,
    ...MAC_DEVICE_CAPABILITIES,
  ],
  ios: IOS_CAPABILITIES,
  "chrome-extension": BROWSER_CAPABILITIES,
  headless: HEADLESS_CAPABILITIES,
};

export interface CapabilityAuthorizationResult {
  authorized: string[];
  dropped: string[];
}

// The set of real platform keys, captured once.
//
// Membership must be tested against this rather than `key in PLATFORM_ALLOWLIST`
// or a bare index: `in` and property access both walk the prototype chain, so
// `"toString"` reads as a known platform and then yields a FUNCTION as its
// allowlist — which throws in `new Set(allowed)` below. Platform strings come
// straight off a worker's poll body, so that is attacker-chosen input reaching
// a 500.
//
// `Object.keys` rather than `Object.hasOwn`: this package targets ES2020 and
// `Object.hasOwn` is ES2022, and biome's `useObjectHasOwn` rewrites a
// `hasOwnProperty.call` guard back into the ES2022 form on every `check:fix`.
const KNOWN_PLATFORMS = new Set(Object.keys(PLATFORM_ALLOWLIST));

// Returns the subset of `declared` that the platform is allowed to advertise,
// plus the dropped tail for logging. `platform` of null/undefined/unknown is
// treated as "untrusted, unknown" and returns an empty authorized set —
// callers (worker-api.ts) gate on `workerAuthMode === 'user'` before calling
// this so trusted fleet workers never reach here.
export function authorizeCapabilities(
  platform: string | null | undefined,
  declared: readonly string[]
): CapabilityAuthorizationResult {
  // Gate the index on KNOWN_PLATFORMS (see above): a bare
  // `PLATFORM_ALLOWLIST[platform]` returns an inherited function for keys like
  // `toString`, which is truthy and then throws in `new Set(allowed)` below.
  const allowed =
    platform && KNOWN_PLATFORMS.has(platform)
      ? PLATFORM_ALLOWLIST[platform]
      : undefined;
  if (!allowed) {
    return { authorized: [], dropped: [...declared] };
  }
  const allowedSet = new Set(allowed);
  const authorized: string[] = [];
  const dropped: string[] = [];
  for (const cap of declared) {
    if (allowedSet.has(cap)) {
      authorized.push(cap);
    } else {
      dropped.push(cap);
    }
  }
  return { authorized, dropped };
}

export function isKnownPlatform(platform: string | null | undefined): boolean {
  // Same reason as above: `in` walks the prototype chain, so `toString` and
  // `constructor` would pass this check. The connector-worker CLI validates
  // `--platform` with it, so a bare `in` lets an operator start a daemon that
  // the server then rejects while authorizing capabilities.
  return !!platform && KNOWN_PLATFORMS.has(platform);
}
