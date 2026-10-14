import { compareSemverish } from './device-manifests';

export type TeamDeviceAction = 'install' | 'advance' | 'active' | 'behind';

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
 * | 3 | V == D | `active`: the pinned private connection and its feeds are created if missing |
 * | 4 | V < D | `behind`: nothing is created or written — an existing connection keeps its status and feeds, a missing one waits for row 3, and the device cannot claim D's work until it advertises D, whatever the state of D's advertisers |
 *
 * Connection and feed status stay the user's: nothing here pauses or resumes.
 * Outside this function: a device that stops advertising the key keeps its
 * connection unchanged and simply cannot claim (row 5); a newer device going
 * offline or stale changes nothing (row 6); a team reconcile never archives
 * the shared definition (row 7); moving a device out is the existing PATCH
 * path (row 8).
 */
export function teamDeviceAction(
  installed: string | null | undefined,
  advertised: string
): TeamDeviceAction {
  if (!installed) return 'install';
  const order = compareSemverish(advertised, installed);
  if (order > 0) return 'advance';
  return order === 0 ? 'active' : 'behind';
}
