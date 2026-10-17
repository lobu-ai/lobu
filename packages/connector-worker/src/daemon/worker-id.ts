/**
 * Shared device-daemon worker-id shape.
 *
 * Accepted `--worker-id` shape. Deliberately narrow: the default is
 * `<platform>:<short-hostname>` (or a session-derived id in a supported
 * interactive agent), and anything a shell, a URL path, or a JSON payload
 * would mangle has no business being a durable device identity.
 */

/**
 * `worker_id` is the device's identity: the server upserts on
 * (user_id, worker_id) and Automation pins resolve the device row through it.
 * An unusable value therefore does not fail loudly — it mints a second device
 * and the pinned Automations go quiet on this one. Reject it at boot instead.
 */
export const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function assertValidWorkerId(workerId: string): void {
  if (!WORKER_ID_PATTERN.test(workerId)) {
    throw new Error(
      `invalid --worker-id '${workerId}': expected 1-128 characters of ` +
        'letters, digits, dot, underscore, colon or hyphen'
    );
  }
}
