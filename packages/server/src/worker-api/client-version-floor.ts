/**
 * First-party client version floor (poll-time enforcement).
 *
 * Old clients must fail LOUD ("update and retry"), never silent: a worker
 * whose version predates a capability silently misbehaves (empty claim lanes,
 * unservable runs) with nothing anywhere reporting why. The operational flow
 * is: announce a floor → watch legacy-compat telemetry go quiet for the
 * 14-day grace window (store review + stragglers) → set MIN_CLIENT_VERSION →
 * delete the legacy arms once enforcement holds. (Telemetry lives with the
 * legacy arms on their own change; this module only enforces.)
 *
 * Floors are PER PLATFORM because the clients ship independent version lines
 * (extension manifest, Mac marketing version, CLI package version): a single
 * global value cannot gate one line without rejecting or ignoring the others.
 * MIN_CLIENT_VERSION is a comma-separated `platform=version` map, e.g.
 * `chrome-extension=0.9.0,macos=0.2.0,headless=20.1.0`. Unset/empty disables
 * enforcement entirely; a platform with no entry is allowed. A SET floor for
 * a platform fails closed: a missing or unparseable client version cannot
 * prove compliance. Fleet (non-user) workers ship with the server and are
 * never gated — enforcement applies to user-scoped device polls only
 * (see pollWorkerJob).
 *
 * Version shape follows the existing convention (supportsExactPageActivation):
 * dotted numerics `major.minor.patch[.build]`, compared numerically.
 */

/** Parse `platform=version` pairs; malformed entries are ignored (permissive). */
function envFloors(): Map<string, string> {
  const floors = new Map<string, string>();
  const raw = process.env.MIN_CLIENT_VERSION ?? '';
  for (const entry of raw.split(',')) {
    const cut = entry.indexOf('=');
    if (cut <= 0) continue;
    const platform = entry.slice(0, cut).trim();
    const version = entry.slice(cut + 1).trim();
    if (platform !== '' && parseClientVersion(version) != null) {
      floors.set(platform, version);
    }
  }
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
