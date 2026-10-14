import { availableParallelism } from 'node:os';

const MIN_DEVICE_MAX_CONCURRENT_JOBS = 2;
const MAX_DEVICE_MAX_CONCURRENT_JOBS = 8;

/**
 * Default active-run limit for paired device daemons (macOS and headless).
 * Device runs mostly wait on I/O, so half the host's threads leaves room for
 * the user's own work; keep at least two slots so a long command cannot
 * monopolize the daemon, and cap the default to bound local agent load.
 */
export function defaultDeviceMaxConcurrentJobs(
  hostThreads: number = availableParallelism()
): number {
  return Math.min(
    MAX_DEVICE_MAX_CONCURRENT_JOBS,
    Math.max(MIN_DEVICE_MAX_CONCURRENT_JOBS, Math.floor(hostThreads / 2))
  );
}
