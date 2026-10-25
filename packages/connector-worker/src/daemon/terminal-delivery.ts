/**
 * Bounded delivery of an immutable terminal outcome. Execution and failure
 * reporting share the retry loop; action and agent-turn budgets differ.
 * WorkerDecodeError identifies an unreadable response, not an execution
 * failure, and is surfaced without retrying.
 */
import { WorkerDecodeError, WorkerHttpError } from './client.js';
import type {
  CompleteAgentTurnRequest,
  CompleteAgentTurnResponse,
  ExecutorClient,
} from './client.js';

interface TerminalDeliveryPolicy {
  deadlineMs: number;
  attempts: number;
  /** Pause before retry N (0-based), doubled each time; 0 retries at once. */
  backoffMs: number;
  retriable: (error: unknown) => boolean;
}

/** Actions: two attempts in 15s, anything but an undecodable answer retried. */
const ACTION_DELIVERY: TerminalDeliveryPolicy = {
  deadlineMs: 15_000,
  attempts: 2,
  backoffMs: 0,
  retriable: (error) => !(error instanceof WorkerDecodeError),
};

/**
 * Agent turns retry transient delivery failures across a short gateway outage.
 * Except for rate limiting (429), a 4xx is the gateway's decision and is not
 * retried. In particular, a divergent completion must retain its 409.
 */
const AGENT_TURN_DELIVERY: TerminalDeliveryPolicy = {
  deadlineMs: 60_000,
  attempts: 4,
  backoffMs: 1_000,
  retriable: isRetriableDeliveryFailure,
};

/**
 * A delivery failure's retry classification: HTTP 5xx/429 and transport errors
 * are retriable; an explicit decode failure or any other 4xx is not.
 */
export function isRetriableDeliveryFailure(err: unknown): boolean {
  if (err instanceof WorkerHttpError) return err.status >= 500 || err.status === 429;
  if (err instanceof WorkerDecodeError) return false;
  return true;
}

async function withTerminalDeliveryTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('terminal completion deadline exceeded')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Retry one immutable terminal payload without changing its outcome.
 *
 * A timed-out attempt is retried, not abandoned: a hung connection is the
 * commonest transient failure, and abandoning it there would leave the rest of
 * the deadline unused. The timeout does not cancel the in-flight request, so a
 * retry can reach a gateway that already accepted the first one -- that is
 * safe because both terminal writes are fenced: an action's by
 * `status = 'running' AND claimed_by = worker_id` (a second delivery answers
 * `already_finalized`), an agent turn's by the run row lock plus its stored
 * completion hash (an exact retry is acknowledged, a divergent one 409s).
 */
async function deliverTerminal<T>(
  send: () => Promise<T>,
  policy: TerminalDeliveryPolicy
): Promise<T> {
  const deadline = Date.now() + policy.deadlineMs;
  let lastError: unknown;
  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    if (attempt > 0 && policy.backoffMs > 0) {
      const pause = Math.min(policy.backoffMs * 2 ** (attempt - 1), deadline - Date.now());
      if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      // Split the remaining budget across the attempts still to come, so a hung
      // connection cannot spend the whole deadline before anything is retried.
      const attemptsLeft = policy.attempts - attempt;
      return await withTerminalDeliveryTimeout(
        send(),
        Math.max(1, Math.floor(remaining / attemptsLeft))
      );
    } catch (error) {
      if (!policy.retriable(error)) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function completeActionOnce(
  client: ExecutorClient,
  payload: Parameters<ExecutorClient['completeAction']>[0]
): Promise<void> {
  await deliverTerminal(() => client.completeAction(payload), ACTION_DELIVERY);
}

export function completeAgentTurnOnce(
  client: ExecutorClient,
  payload: CompleteAgentTurnRequest
): Promise<CompleteAgentTurnResponse> {
  return deliverTerminal(() => client.completeAgentTurn(payload), AGENT_TURN_DELIVERY);
}
