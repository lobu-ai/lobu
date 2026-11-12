/**
 * Read `LOBU_CLOUD_MODE` from the env. Truthy values (`1`, `true`, `yes`,
 * case-insensitive) enable cloud-mode guardrails that don't apply to
 * self-hosters running the same gateway in a single-tenant install — e.g.
 * rejecting Telegram polling mode, and refusing to re-anchor an anonymous
 * worker poll to an existing device owner.
 *
 * Re-read on every call so a process (or test harness) can flip the flag
 * without a restart. All call sites are cold-path, so caching isn't worth it.
 */
export function isCloudMode(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.LOBU_CLOUD_MODE;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * The DB egress config a connector run is authoritatively given: the policy plus
 * the operator's exact-match allow-host list.
 *
 * Both keys are OPERATOR deployment config read from the gateway's own env, and
 * both are injected LAST over tenant-supplied connection config so a tenant can
 * never widen its own egress boundary. `LOBU_DB_EGRESS_ALLOW_HOSTS` is a
 * comma-separated list of exact bare hosts (IPv6 without URL brackets) that
 * stay reachable under cloud mode — e.g. a Tailscale/CGNAT address — while
 * metadata, link-local, multicast and unspecified remain blocked for every host.
 */
export function dbEgressConfig(): {
  LOBU_DB_EGRESS_POLICY: 'block-private' | 'allow-private';
  LOBU_DB_EGRESS_ALLOW_HOSTS: string;
} {
  return {
    LOBU_DB_EGRESS_POLICY: isCloudMode() ? 'block-private' : 'allow-private',
    LOBU_DB_EGRESS_ALLOW_HOSTS: process.env.LOBU_DB_EGRESS_ALLOW_HOSTS ?? '',
  };
}
