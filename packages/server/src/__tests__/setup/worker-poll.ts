/**
 * Play a device worker against the real worker routes.
 *
 * Integration tests stand in for the Chrome extension or the Mac app by polling
 * `/api/workers/poll` and answering what it hands out. An attempt-capped loop
 * is a hidden second time budget (attempts x (pause + poll round trip)) next to
 * the read's own timeout: when the job is handed out later than that, the
 * helper silently stops answering and the read fails on its timeout instead.
 * Bound the loop by what it serves: stop when the served promise settles, when
 * a handler says it is done, or at a wall-clock deadline the caller ties to
 * the served read's timeout. A job a poll already claimed is always answered,
 * so serving never strands a claimed run.
 */

type WorkerJob = Record<string, any>;

interface ServeWorkerJobsOptions<T> {
  /** One worker poll; resolves to the route's JSON body (a job, or an idle reply). */
  poll: () => Promise<WorkerJob | null>;
  /** Answer one handed-out job. Return `{ done: value }` to stop serving. */
  handle: (job: WorkerJob) => Promise<{ done: T } | undefined>;
  /** The read or operation being served; serving stops once it settles. */
  until?: Promise<unknown>;
  /** Wall-clock budget for starting polls, tied to the served read's timeout. */
  deadlineMs: number;
  /** Pause between polls. */
  intervalMs?: number;
}

/**
 * Returns the handler's `done` value, or `undefined` if serving stops without one.
 */
export async function serveWorkerJobs<T>(options: ServeWorkerJobsOptions<T>): Promise<T | undefined> {
  const deadline = Date.now() + options.deadlineMs;
  let settled = false;
  options.until?.finally(() => { settled = true; }).catch(() => {});
  while (!settled && Date.now() < deadline) {
    const job = await options.poll();
    if (job?.run_id) {
      const outcome = await options.handle(job);
      if (outcome) return outcome.done;
    }
    if (settled) return undefined;
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(options.intervalMs ?? 50, remainingMs)));
    }
  }
  return undefined;
}
