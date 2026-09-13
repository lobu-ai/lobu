/**
 * First-party client version floor (poll-time enforcement).
 *
 * Old clients must fail LOUD ("update and retry"), never silent: a worker
 * whose version predates a capability silently misbehaves (empty claim lanes,
 * unservable runs) with nothing anywhere reporting why. The legacy-compat
 * paths this replaces are counted by `lobu_legacy_compat_hits_total`; the
 * operational flow is: announce a floor → watch that series go quiet for the
 * 14-day grace window (store review + stragglers) → set MIN_CLIENT_VERSION →
 * delete the legacy arm once enforcement holds.
 *
 * Unset/empty MIN_CLIENT_VERSION disables enforcement entirely (every client
 * allowed, including ones that never report a version). A SET floor fails
 * closed: a missing or unparseable version cannot prove compliance, so it is
 * rejected with the same upgrade message. Fleet (non-user) workers ship with
 * the server and are never gated — enforcement applies to user-scoped device
 * polls only (see pollWorkerJob).
 *
 * Version shape follows the existing convention (supportsExactPageActivation):
 * dotted numerics `major.minor.patch[.build]`, compared numerically.
 */

/** Positive string from env (trimmed); falls back when unset/empty. */
function envFloor(): string | null {
  const raw = (process.env.MIN_CLIENT_VERSION ?? '').trim();
  return raw === '' ? null : raw;
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

/** True when no floor is configured, or the version meets it. */
export function meetsClientVersionFloor(
  version: unknown,
  floor: string | null = envFloor()
): boolean {
  if (floor == null) return true;
  const have = parseClientVersion(version);
  const want = parseClientVersion(floor);
  // An unparseable floor is operator misconfiguration: refuse nothing, so a
  // typo cannot brick the fleet. (The floor value itself is validated at
  // announcement time, not here.)
  if (want == null) return true;
  if (have == null) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i]! > want[i]!;
  }
  return true;
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
