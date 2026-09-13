/**
 * First-party client version floor (poll-time enforcement).
 *
 * Old clients must fail LOUD ("update and retry"), never silent: a worker
 * whose version predates a capability silently misbehaves (empty claim lanes,
 * unservable runs) with nothing anywhere reporting why. The operational flow
 * is: announce a floor → wait out the grace window (store review + stragglers)
 * → set MIN_CLIENT_VERSION → delete the legacy arms once enforcement holds.
 *
 * This module is the ENFORCING gate, and it is the strong one. Legacy-compat
 * telemetry going quiet is a statement about observed traffic in a window, not
 * an invariant — a device asleep for 15 days re-enters a legacy arm the moment
 * it wakes. A floor, by contrast, makes a version-gated precondition
 * unreachable by construction, so deleting the arm behind it is provable by
 * reading code. Treat the counters as corroboration, never as the gate.
 *
 * Floors are PER PLATFORM because the clients ship independent version lines:
 * a single global value cannot gate one line without rejecting or ignoring the
 * others. Critically, those lines DO NOT SHARE A SCALE — `chrome-extension`
 * reports its extension manifest version (0.x) while `macos` and `headless`
 * both report the daemon/monorepo line (19.x). A macOS floor written against
 * the Mac app's MARKETING_VERSION sits below every real row and enforces
 * nothing. Read the values off `device_workers` before setting them; never
 * invent them (see .env.example for the query).
 *
 * MIN_CLIENT_VERSION is a comma-separated `platform=version` map, e.g.
 * `chrome-extension=0.6.0,macos=19.2.0,headless=19.0.0`. Unset/empty disables
 * enforcement entirely; a platform with no entry is allowed. A SET floor for
 * a platform fails closed: a missing or unparseable client version cannot
 * prove compliance. Fleet (non-user) workers ship with the server and are
 * never gated — enforcement applies to user-scoped device polls only
 * (see pollWorkerJob).
 *
 * Version shape follows the existing convention (supportsExactPageActivation):
 * dotted numerics `major.minor.patch[.build]`, compared numerically.
 */

import { createLogger } from '@lobu/core';

const logger = createLogger('client-version-floor');

/**
 * Parse `platform=version` pairs; malformed entries are ignored (permissive).
 *
 * Ignoring them silently is the dangerous half: a typo (`macos=19.2`, two
 * parts) drops that platform's floor while the variable still *looks* set, so
 * the operator believes they are enforcing and nothing is. Warn once per
 * distinct value — this runs on every device poll, so the parse is memoized on
 * the raw string (which also re-parses correctly the moment the env changes,
 * as tests do).
 */
let floorCache: { raw: string; floors: Map<string, string> } | null = null;

function envFloors(): Map<string, string> {
  const raw = process.env.MIN_CLIENT_VERSION ?? '';
  if (floorCache?.raw === raw) return floorCache.floors;

  const floors = new Map<string, string>();
  const ignored: string[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const cut = trimmed.indexOf('=');
    const platform = cut > 0 ? trimmed.slice(0, cut).trim() : '';
    const version = cut > 0 ? trimmed.slice(cut + 1).trim() : '';
    if (platform !== '' && parseClientVersion(version) != null) {
      floors.set(platform, version);
    } else {
      ignored.push(trimmed);
    }
  }
  if (ignored.length > 0) {
    logger.warn(
      { ignored, enforcing: [...floors.keys()] },
      '[clientVersionFloor] ignoring malformed MIN_CLIENT_VERSION entries — those platforms enforce NO floor'
    );
  }

  floorCache = { raw, floors };
  return floors;
}

/** Parse `1.2.3[.4]` into numeric parts; null when the shape is unknown. */
export function parseClientVersion(
  value: unknown
): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value)) return null;
  const [major, minor, patch] = value.split('.').map(Number);
  return [major, minor, patch];
}

/** True when the platform has no floor, or the version meets it. */
export function meetsClientVersionFloor(
  platform: string | null | undefined,
  version: unknown,
  floors: Map<string, string> = envFloors()
): boolean {
  const floor = (platform != null ? floors.get(platform) : undefined) ?? null;
  if (floor == null) return true;
  const have = parseClientVersion(version);
  const want = parseClientVersion(floor);
  // floors map values are validated on parse, so an unparseable floor here
  // cannot happen; stay permissive rather than bricking the fleet on it.
  if (want == null) return true;
  if (have == null) return false;
  const [haveMajor, haveMinor, havePatch] = have;
  const [wantMajor, wantMinor, wantPatch] = want;
  if (haveMajor !== wantMajor) return haveMajor > wantMajor;
  if (haveMinor !== wantMinor) return haveMinor > wantMinor;
  return havePatch >= wantPatch;
}

/** Human-facing update message naming the client when we know it. */
export function clientFloorMessage(
  platform: string | null | undefined
): string {
  const label =
    platform === 'chrome-extension'
      ? 'the Chrome extension'
      : platform === 'macos'
        ? 'the Mac app'
        : platform === 'headless'
          ? 'the headless worker'
          : 'your Lobu client';
  return `Update ${label} to continue (this server requires a newer version)`;
}
