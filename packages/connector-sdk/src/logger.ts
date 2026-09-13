/**
 * SDK logger.
 *
 * Deliberately self-contained. The package root must stay loadable inside a
 * V8 isolate, and `@lobu/core`'s root entry pulls winston, Sentry and
 * OpenTelemetry into every connector bundle — 6 MB of gateway internals whose
 * first `require('util')` throws where no Node runtime exists (guarded by
 * `packages/server/src/__tests__/integration/sandbox/connector-isolate-lane.test.ts`).
 *
 * This mirrors core's console logger so connector output keeps the same shape:
 * the `Logger` interface, `LOG_LEVEL` gating, pino-style `(meta, message)`
 * calls, and redaction of credential-looking keys before anything is written.
 *
 * `console` is the only sink on purpose. Every connector runtime owns
 * `console` — the fork lane inherits the worker's stdout and an isolate host
 * injects its own bridge — so routing logs is the host's job, not the SDK's.
 */

export interface Logger {
  error: (message: unknown, ...args: unknown[]) => void;
  warn: (message: unknown, ...args: unknown[]) => void;
  info: (message: unknown, ...args: unknown[]) => void;
  debug: (message: unknown, ...args: unknown[]) => void;
}

const SENSITIVE_LOG_KEY_PATTERN =
  /(?:credential|secret|token|password|api(?:_|-)?key|authorization)/i;

const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Read at call time so a host that injects `process.env` late still wins. */
function currentLevel(): number {
  const env =
    typeof process !== 'undefined' && process && typeof process.env === 'object'
      ? process.env
      : undefined;
  return LEVELS[env?.LOG_LEVEL ?? 'info'] ?? 2;
}

function createRedactingReplacer() {
  const seen = new WeakSet<object>();
  return (key: string, value: unknown) => {
    if (SENSITIVE_LOG_KEY_PATTERN.test(key)) return '[REDACTED]';
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack?.split('\n')[0] };
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular Reference]';
      seen.add(value);
    }
    return value;
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, createRedactingReplacer());
  } catch {
    return '[unserializable]';
  }
}

function formatMessage(level: string, serviceName: string, message: unknown, args: unknown[]): string {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let msgStr: string;
  let rest = args;
  // pino-style: logger.info({ meta }, 'message')
  if (typeof message === 'object' && message !== null && !Array.isArray(message) && !(message instanceof Error)) {
    if (rest.length > 0 && typeof rest[0] === 'string') {
      // Keep the metadata object as a trailing arg so it still renders.
      // Slicing it away accepted the signature and then dropped the payload,
      // leaving a connector diagnostic with its message but no fields.
      msgStr = rest[0];
      rest = [message, ...rest.slice(1)];
    } else {
      msgStr = safeStringify(message);
    }
  } else {
    msgStr = String(message);
  }
  if (rest.length > 0) {
    msgStr += ` ${safeStringify(rest.length === 1 ? rest[0] : rest)}`;
  }
  return `[${timestamp}] [${level}] [${serviceName}] ${msgStr}`;
}

export function createConsoleLogger(serviceName: string): Logger {
  return {
    error: (message, ...args) => {
      if (currentLevel() >= 0) console.error(formatMessage('error', serviceName, message, args));
    },
    warn: (message, ...args) => {
      if (currentLevel() >= 1) console.warn(formatMessage('warn', serviceName, message, args));
    },
    info: (message, ...args) => {
      // formatMessage redacts credential-looking keys before writing.
      if (currentLevel() >= 2) console.log(formatMessage('info', serviceName, message, args));
    },
    debug: (message, ...args) => {
      if (currentLevel() >= 3) console.log(formatMessage('debug', serviceName, message, args));
    },
  };
}

export const sdkLogger: Logger = createConsoleLogger('connector-sdk');
