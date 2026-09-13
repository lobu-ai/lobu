// Use simple console.log-based logger by default (unbuffered, 12-factor compliant)
// Set USE_WINSTON_LOGGER=true only if you need Winston features (file rotation, multiple transports)
const USE_WINSTON_LOGGER = process.env.USE_WINSTON_LOGGER === "true";
// Use JSON format for structured logging (better for Loki parsing in production)
const USE_JSON_FORMAT = process.env.LOG_FORMAT === "json";

import winston from "winston";

export interface Logger {
  error: (message: any, ...args: any[]) => void;
  warn: (message: any, ...args: any[]) => void;
  info: (message: any, ...args: any[]) => void;
  debug: (message: any, ...args: any[]) => void;
}

const SENSITIVE_LOG_KEY_PATTERN =
  /(?:credential|secret|token|password|api(?:_|-)?key|authorization)/i;

function createRedactingReplacer() {
  const seen = new WeakSet<object>();

  return (key: string, value: unknown) => {
    if (SENSITIVE_LOG_KEY_PATTERN.test(key)) return "[REDACTED]";

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack?.split("\n")[0],
      };
    }

    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular Reference]";
      seen.add(value);
    }

    return value;
  };
}

function safeStringify(value: unknown, space?: number): string {
  try {
    return JSON.stringify(value, createRedactingReplacer(), space);
  } catch {
    return "[unserializable]";
  }
}

// Simple console logger fallback for environments where Winston doesn't work (Bun + Alpine)
// Supports both formats: logger.info("message", data) AND pino-style logger.info({ data }, "message")
function createConsoleLogger(serviceName: string): Logger {
  const level = process.env.LOG_LEVEL || "info";
  const levels: Record<string, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  };
  const currentLevel = levels[level] ?? 2;

  const formatMessage = (lvl: string, message: any, ...args: any[]): string => {
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    let msgStr: string;

    // Handle pino-style format: logger.info({ key: value }, "message")
    if (
      typeof message === "object" &&
      message !== null &&
      !Array.isArray(message) &&
      !(message instanceof Error)
    ) {
      if (args.length > 0 && typeof args[0] === "string") {
        // Keep the metadata object as a trailing arg so it still renders.
        // Slicing it away accepted the signature and then dropped the payload,
        // emptying every structured diagnostic that uses this call shape.
        msgStr = args[0];
        args = [message, ...args.slice(1)];
      } else {
        // Just an object, stringify it
        msgStr = safeStringify(message);
      }
    } else {
      msgStr = String(message);
    }

    // Append remaining args
    if (args.length > 0) {
      msgStr += ` ${safeStringify(args.length === 1 ? args[0] : args)}`;
    }

    return `[${timestamp}] [${lvl}] [${serviceName}] ${msgStr}`;
  };

  return {
    error: (message: any, ...args: any[]) => {
      if (currentLevel >= 0)
        console.error(formatMessage("error", message, ...args));
    },
    warn: (message: any, ...args: any[]) => {
      if (currentLevel >= 1)
        console.warn(formatMessage("warn", message, ...args));
    },
    info: (message: any, ...args: any[]) => {
      if (currentLevel >= 2)
        console.log(formatMessage("info", message, ...args)); // lgtm[js/clear-text-logging] formatMessage redacts sensitive object keys before writing info logs.
    },
    debug: (message: any, ...args: any[]) => {
      if (currentLevel >= 3)
        // codeql[js/clear-text-logging]: formatMessage redacts sensitive object keys before writing debug logs.
        console.log(formatMessage("debug", message, ...args));
    },
  };
}

/**
 * Creates a logger instance for a specific service
 * Provides consistent logging format across all packages with level and timestamp
 * @param serviceName The name of the service using the logger
 * @returns A console logger by default, or Winston logger if USE_WINSTON_LOGGER=true
 */
export function createLogger(serviceName: string): Logger {
  // Use simple console.log logger by default (unbuffered, 12-factor compliant)
  // Set USE_WINSTON_LOGGER=true for Winston features (file rotation, multiple transports)
  if (!USE_WINSTON_LOGGER) {
    return createConsoleLogger(serviceName);
  }

  const isProduction = process.env.NODE_ENV === "production";
  const level = process.env.LOG_LEVEL || "info";

  // JSON format for structured logging (better for Loki/Grafana parsing)
  const jsonFormat = winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
    winston.format.json()
  );

  // Human-readable format for development
  const humanFormat = winston.format.combine(
    ...(isProduction ? [] : [winston.format.colorize()]),
    winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
      let metaStr = "";
      if (Object.keys(meta).length) {
        metaStr = ` ${safeStringify(meta, 0)}`;
      }
      return `[${timestamp}] [${level}] [${service}] ${message}${metaStr}`;
    })
  );

  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: USE_JSON_FORMAT ? jsonFormat : humanFormat,
    }),
  ];

  const logger = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      winston.format.errors({ stack: true }),
      winston.format.splat()
    ),
    defaultMeta: { service: serviceName },
    transports,
  });

  return logger;
}
