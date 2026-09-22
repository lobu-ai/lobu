/**
 * HTTP retry helper for connector SDK.
 *
 * Exponential backoff with full jitter (5 retries, 1s → 16s). Whether an error
 * is worth retrying is decided by `classifyToolError`, the one catalog shared
 * with the server: an HTTP status or SQLSTATE the error carries always wins,
 * and message text is consulted only when it carries neither. A response
 * body or URL is never evidence — a 503 whose body says "invalid" is still a
 * 503.
 *
 * The backoff loop lives here rather than being imported from `@lobu/core`:
 * core's root entry drags winston, Sentry and OpenTelemetry into every
 * connector bundle, and the package root must stay loadable inside a V8
 * isolate. It keeps the semantics of core's `retryWithBackoff` for the one
 * configuration `withHttpRetry` uses: exponential, capped, full jitter.
 */

import {
  classifyToolError,
  isRetryable,
  type ToolErrorSignal,
} from '@lobu/core/connector-query-errors';
import { sdkLogger } from './logger.js';

interface BackoffOptions {
  maxRetries: number;
  baseDelay: number;
  /** Cap on the computed delay, applied before jitter. */
  maxDelay: number;
  shouldRetry: (error: Error) => boolean;
  onRetry: (attempt: number, error: Error) => void;
}

async function retryWithBackoff<T>(fn: () => Promise<T>, options: BackoffOptions): Promise<T> {
  const { maxRetries, baseDelay, maxDelay, shouldRetry, onRetry } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (!shouldRetry(lastError)) throw lastError;

      if (attempt < maxRetries) {
        // Full jitter: the capped exponential delay multiplied by [1, 2).
        const delay = Math.min(baseDelay * 2 ** attempt, maxDelay) * (1 + Math.random());

        // A throwing caller callback must not swallow the retry.
        try {
          onRetry(attempt + 1, lastError);
        } catch (callbackError) {
          sdkLogger.warn('onRetry callback threw', {
            error: callbackError instanceof Error ? callbackError.message : String(callbackError),
          });
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

/**
 * The structured signal an error carries, read off the error itself. An
 * `HttpStatusError` carries `status`; a postgres.js error carries a SQLSTATE
 * `code`. The message rides along only as the catalog's last resort, for
 * errors that arrive as text alone (a failed fetch inside the isolate is a
 * bare `TypeError('fetch failed: …')`).
 */
function errorSignal(error: unknown): ToolErrorSignal {
  if (!(error instanceof Error)) return { message: String(error) };
  const fields = error as Error & { status?: unknown; code?: unknown };
  return {
    httpStatus: typeof fields.status === 'number' ? fields.status : undefined,
    pgCode: typeof fields.code === 'string' ? fields.code : undefined,
    message: error.message,
  };
}

/** Whether a response with this HTTP status may succeed if the request is repeated. */
export function isTransientStatus(status: number): boolean {
  return isRetryable(classifyToolError({ httpStatus: status }));
}

/** Whether `error` may succeed if the identical call is repeated. */
function isTransientError(error: unknown): boolean {
  return isRetryable(classifyToolError(errorSignal(error)));
}

/**
 * Whether `error` proves the server refused the request without acting on it.
 * Only a 429 says so; a 5xx or a dropped connection says nothing about whether
 * a write landed.
 */
function isUnprocessed(error: unknown): boolean {
  return classifyToolError(errorSignal(error)) === 'RATE_LIMITED';
}

interface RetryOptions {
  operation?: string;
  context?: Record<string, any>;
  onRetry?: (error: Error, attempt: number) => void;
  /**
   * Whether repeating the call is safe when an earlier attempt may already have
   * taken effect. Default `true`. Pass `false` for a write (a send, a create): it
   * is then retried only on a 429, which proves the server did not act on it —
   * never on a 5xx or a dropped connection (RFC 9110 §9.2.2).
   */
  repeatable?: boolean;
}

/**
 * HTTP retry strategy
 * Exponential backoff with jitter for external API calls
 * - 5 retries
 * - 1s, 2s, 4s, 8s, 16s base delays (with multiplicative jitter)
 */
export async function withHttpRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const operation = options?.operation || 'HTTP operation';
  const totalRetries = 5;

  return retryWithBackoff(fn, {
    maxRetries: totalRetries,
    baseDelay: 1000,
    maxDelay: 16000,
    shouldRetry:
      options?.repeatable === false ? isUnprocessed : isTransientError,
    onRetry: (attempt, error) => {
      options?.onRetry?.(error, attempt);
      sdkLogger.debug(
        {
          operation,
          attempt,
          retriesLeft: totalRetries - attempt,
          error: error.message || String(error),
          context: options?.context,
        },
        `[Retry:HTTP] Attempt ${attempt} failed, ${totalRetries - attempt} retries left`
      );
    },
  });
}
