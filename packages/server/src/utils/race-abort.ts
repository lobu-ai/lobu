/**
 * Race a promise against an AbortSignal. Rejects with the signal's reason on
 * abort. The `abort` listener is removed when aborted or the underlying promise settles
 * first so callers can re-use one signal across many calls (e.g. a sandbox
 * script making multiple `client.query` invocations) without stacking
 * listener leaks.
 */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const reason = () =>
      signal.reason instanceof Error ? signal.reason : new Error("AbortError: signal aborted");
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(reason());
    };
    // Always observe the supplied promise, even when cancellation already won.
    // Otherwise a later upstream rejection escapes as an unhandled rejection.
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
