import { isSecretKey } from '@lobu/core';
import { scrubDiagnosticValue } from '@lobu/core';
import pino from 'pino';

/**
 * Logger utility using Pino for structured logging
 *
 * Log Levels:
 * - trace (10): Very detailed debugging
 * - debug (20): Debugging information
 * - info (30): Informational messages (default in production)
 * - warn (40): Warning messages
 * - error (50): Error messages
 * - fatal (60): Fatal errors
 */

// Determine log level from environment.
// Reads process.env.ENVIRONMENT (set to "production" by the Helm chart). The
// previous `(globalThis as any).ENVIRONMENT` was never assigned anywhere, so
// production silently logged at debug level (verbose + costly).
const getLogLevel = (): pino.Level => {
  const env = process.env.ENVIRONMENT || process.env.NODE_ENV || 'development';

  if (env === 'production') {
    return 'info';
  }
  return 'debug';
};

// pino's default error serializer only fires for the `err` key, so
// `logger.error({ error }, '...')` silently logs `error: {}` (Error's own
// fields are non-enumerable). Register the same serializer on the `error`
// key too so either spelling produces a real stack/message. Found during
// the 2026-05-16 prod outage where every queue failure logged `error: {}`
// and hid `column "events.search_tsv" does not exist`.
const errSerializer = pino.stdSerializers.err;

// Connector definitions may declare provider-specific signature headers, so
// filter header names at runtime instead of maintaining a finite path list.
const SIGNATURE_HTTP_HEADER_NAME_PATTERN = /(^|[-_])signature($|[-_])/i;

const HTTP_HEADER_PATHS = [
  'req.headers.*',
  'res.headers["set-cookie"]',
] as const;

function censorHttpHeader(value: unknown, path: string[]): unknown {
  const headerName = path[path.length - 1];
  return isSecretKey(headerName) || SIGNATURE_HTTP_HEADER_NAME_PATTERN.test(headerName)
    ? '[redacted]'
    : value;
}

/** Every emitted record is scrubbed before the infrastructure collector reads it. */
const diagnosticStream: pino.DestinationStream = {
  write(line: string): void {
    let parsed: unknown;
    try {
      parsed = scrubDiagnosticValue(JSON.parse(line));
    } catch {
      // Never fall back to emitting an unredacted record on a logging failure.
      process.stdout.write('{"level":"error","msg":"Log record could not be serialized safely"}\n');
      return;
    }
    if (parsed && typeof parsed === 'object') {
      process.stdout.write(`${JSON.stringify(parsed)}\n`);
    }
  },
};

const logger = pino(
  {
    level: getLogLevel(),
    base: { service: 'lobu-server', release: process.env.APP_GIT_SHA,
      environment: process.env.ENVIRONMENT || process.env.NODE_ENV || 'development' },
    browser: {
      asObject: false,
    },
    formatters: {
      level: (label) => {
        return { level: label };
      },
    },
    redact: {
      paths: [...HTTP_HEADER_PATHS],
      censor: censorHttpHeader,
    },
    serializers: {
      err: errSerializer,
      error: errSerializer,
    },
  },
  diagnosticStream
);

export default logger;
