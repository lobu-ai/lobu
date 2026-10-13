import { compareSemverish } from './device-manifests';

export type TeamDeviceAction = 'install' | 'advance' | 'active' | 'upgrade_paused';

/**
 * The one per-device decision for a device connector in a TEAM workspace,
 * taken against the workspace's INSTALLED definition version `installed` (D)
 * and the newest version of the key the device advertises `advertised` (V),
 * counting retained versions; a fresh device (7-day window) advertises even
 * while offline. Personal workspaces never consult this.
 *
 * | Row | Situation | Action |
 * |-----|-----------|--------|
 * | 1 | No D | `install`: the newest V among the member's fresh advertisers is installed and those devices are wired active; older ones then fall to row 4 |
 * | 2 | V > D | `advance`: the definition moves forward to V (forward only) and this device is wired active; other devices at D reach row 4 on their own reconcile |
 * | 3 | V == D | `active`: the pinned private connection is created if missing, resumed if upgrade-paused, its reason cleared |
 * | 4 | V < D | `upgrade_paused`: the pinned private connection exists and is PAUSED with the upgrade reason — created if missing, never active, never claim-authorized — whatever the state of D's advertisers (online, offline, stale, removed, moved away) |
 *
 * Outside this function: a device that stops advertising the key has its
 * connection paused with no definition change (row 5); a newer device
 * going offline or stale changes nothing (row 6, by row 4); a team reconcile
 * never archives the shared definition (row 7); moving a device out is the
 * existing PATCH path (row 8).
 */
export function teamDeviceAction(
  installed: string | null | undefined,
  advertised: string
): TeamDeviceAction {
  if (!installed) return 'install';
  const order = compareSemverish(advertised, installed);
  if (order > 0) return 'advance';
  return order === 0 ? 'active' : 'upgrade_paused';
}
