/**
 * First-party client version floor (poll-time enforcement).
 *
 * Old clients must fail LOUD ("update and retry"), never silent: a worker
 * whose version predates a capability silently misbehaves (empty claim lanes,
 * unservable runs) with nothing anywhere reporting why. The operational flow
 * is: announce a floor → wait out the grace window (store review + stragglers)
 * → set MIN_CLIENT_VERSION → delete the legacy arms once enforcement holds.
 *
 * This is the ENFORCING gate, and it is the strong one: it makes a
 * version-gated precondition unreachable by construction, so deleting the arm
 * behind it is provable by reading code. Counting how many old clients still
 * call describes one window, not an invariant — a device asleep through it
 * re-enters the arm on wake — so such a counter corroborates, never gates.
 *
 * Floors are PER PLATFORM, and the lines DO NOT SHARE A SCALE:
 * `chrome-extension` reports its manifest version (0.x) while `macos` and
 * `headless` report the monorepo release line (majors in the tens), so a macOS
 * floor written against the Mac app's MARKETING_VERSION never binds. Read the
 * values off `device_workers`; never invent them (.env.example has the query).
 *
 * MIN_CLIENT_VERSION is a comma-separated `platform=version` map, e.g.
 * `chrome-extension=0.6.0,macos=19.2.0,headless=19.0.0`. Unset/empty disables
 * enforcement entirely; a platform with no entry is allowed. A SET floor for
 * a platform fails closed: a missing or unparseable client version cannot
 * prove compliance. Fleet (non-user) workers ship with the server and are
 * never gated — enforcement applies to user-scoped device polls only
 * (see pollWorkerJob).
 *
 * Version shape is the convention every first-party client already reports:
 * dotted numerics `major.minor.patch[.build]`, or the published
 * `major.minor.patch-canary.<timestamp>.g<sha>` format, compared by release
 * components. Canaries are built from commits after that base release. The
 * per-feature page-activation gate runs on this comparator too, against a
 * fixed floor of its own rather than MIN_CLIENT_VERSION.
 */

import { createLogger } from '@lobu/core';

const logger = createLogger('client-version-floor');

/**
 * Parse `platform=version` pairs; malformed entries are ignored (permissive).
 *
 * Ignoring them silently is the dangerous half: a typo (`macos=19.2`, two
 * parts) drops that platform's floor while the variable still *looks* set. So
 * warn, naming the entries. Memoized on the raw string because this runs on
 * every device poll — that bounds the warn to once per value and still
 * re-parses the moment the env changes.
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
    if (platform === '' || parseFloorVersion(version) == null) {
      ignored.push(trimmed);
      continue;
    }
    floors.set(platform, version);
  }
  if (ignored.length > 0) {
    // Which entries were ignored is the whole point of this warn: an operator
    // told that "some entry" dropped, but not which, is back at the silent
    // misconfiguration this exists to break.
    logger.warn(
      'MIN_CLIENT_VERSION: ignoring malformed entries — those platforms enforce NO floor',
      { ignored, enforcing: [...floors.keys()] }
    );
  }

  floorCache = { raw, floors };
  return floors;
}

/** Parse a release or published canary into its release components. */
export function parseClientVersion(
  value: unknown
): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+|-canary\.[1-9]\d*\.g[a-f0-9]{40})?$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Operator floors remain numeric releases, not a particular canary commit. */
function parseFloorVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string' || value.includes('-')) return null;
  return parseClientVersion(value);
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
  const want = parseFloorVersion(floor);
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
