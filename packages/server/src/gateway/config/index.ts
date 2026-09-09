#!/usr/bin/env bun

import type { AgentOptions, LogLevel } from "@lobu/core";
import {
  DEFAULTS as CORE_DEFAULTS,
  createLogger,
  getOptionalBoolean,
  getOptionalEnv,
  getOptionalNumber,
  getRequiredEnv,
  TIME,
} from "@lobu/core";
import type { OrchestratorConfig } from "../orchestration/deployment-manager.js";
import { normalizePublicGatewayUrl } from "../../utils/public-origin.js";

const logger = createLogger("cli-config");
const GATEWAY_DEFAULTS = {
  HTTP_PORT: 3000,
  PUBLIC_GATEWAY_URL: "",
  QUEUE_DIRECT_MESSAGE: "direct_message",
  QUEUE_MESSAGE_QUEUE: "message_queue",
  // Leave enough of the default 60s turn-liveness budget for the worst-case
  // warm path: a stale-worker check, two fresh starts, teardown, and backoff.
  WORKER_STARTUP_TIMEOUT_SECONDS: 10,
  WORKER_IDLE_CLEANUP_MINUTES: 60,
  MAX_WORKER_DEPLOYMENTS: 100,
  WORKER_STALE_TIMEOUT_MINUTES: 10,
  CLEANUP_INITIAL_DELAY_MS: TIME.FIVE_SECONDS_MS,
  CLEANUP_INTERVAL_MS: 60000,
  CLEANUP_VERY_OLD_DAYS: 7,
  LOBU_DEV_PROJECT_PATH: "/app",
  LOG_LEVEL: "INFO" as const,
  EMBEDDED_MAX_CONCURRENT_SESSIONS: 100,
  EMBEDDED_MAX_MEMORY_PER_SESSION_MB: 256,
  EMBEDDED_BASH_MAX_COMMAND_COUNT: 50_000,
  EMBEDDED_BASH_MAX_LOOP_ITERATIONS: 50_000,
  EMBEDDED_BASH_MAX_CALL_DEPTH: 50,
} as const;

const DEFAULTS = {
  ...CORE_DEFAULTS,
  ...GATEWAY_DEFAULTS,
} as const;

/** Recursively makes all properties optional */
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? U[]
    : T[P] extends object
      ? DeepPartial<T[P]>
      : T[P];
};

/**
 * Agent configuration passed programmatically via GatewayConfig.
 * Used in embedded mode to provision agents at startup without API calls.
 */
export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  identityMd?: string;
  soulMd?: string;
  userMd?: string;
  providers?: Array<{
    id: string;
    model?: string;
    key?: string;
    secretRef?: string;
  }>;
  connections?: Array<{ type: string; config: Record<string, string> }>;
  skills?: { enabled?: string[]; mcp?: Record<string, any> };
  network?: { allowed?: string[]; denied?: string[] };
  nixPackages?: string[];
}

/**
 * Complete gateway configuration - single source of truth
 * Platform-specific configs (like Slack) are built separately
 */
export interface GatewayConfig {
  agents?: AgentConfig[];
  agentDefaults: Partial<AgentOptions>;
  sessionTimeoutMinutes: number;
  logLevel: LogLevel;
  queues: {
    directMessage: string;
    messageQueue: string;
    retryLimit: number;
    retryDelay: number;
    expireInHours: number;
  };
  anthropicProxy: {
    enabled: boolean;
    anthropicBaseUrl?: string;
  };
  orchestration: OrchestratorConfig;
  mcp: {
    publicGatewayUrl: string;
  };
  auth: {
    /** OIDC issuer used to validate external/service tokens. */
    issuerUrl?: string;
  };
  secrets: {
    /** Read-only AWS Secrets Manager backend for `aws-sm://` refs. */
    aws: {
      region?: string;
    };
  };
}

/**
 * Derive the internal gateway URL for worker→gateway communication.
 * Embedded workers are subprocesses on the same host; the gateway is
 * served by `@lobu/server` on `PORT` under the `/lobu` mount.
 * `DISPATCHER_URL` is honoured if set so a caller can override (e.g. a
 * separate network namespace).
 */
export function getInternalGatewayUrl(): string {
  if (process.env.DISPATCHER_URL) {
    return process.env.DISPATCHER_URL;
  }
  const port = process.env.PORT || process.env.GATEWAY_PORT || "8787";
  return `http://127.0.0.1:${port}/lobu`;
}

/**
 * Loopback origin for org-scoped LOBU memory MCP endpoints (`/mcp/:orgSlug`).
 * Derived from {@link getInternalGatewayUrl} so PORT / DISPATCHER_URL are the
 * single source of truth — never PUBLIC_GATEWAY_URL / the public ingress.
 */
export function getLobuMemoryUpstreamOrigin(): string {
  return new URL(getInternalGatewayUrl()).origin;
}

/** Deep-merge utility: merges source into target, recursing into plain objects */
function deepMerge<T extends Record<string, any>>(
  target: T,
  source: Partial<T>
): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const srcVal = source[key];
    if (srcVal === undefined) continue;
    const tgtVal = result[key];
    if (
      tgtVal &&
      srcVal &&
      typeof tgtVal === "object" &&
      typeof srcVal === "object" &&
      !Array.isArray(tgtVal) &&
      !Array.isArray(srcVal)
    ) {
      result[key] = deepMerge(tgtVal as any, srcVal as any);
    } else {
      result[key] = srcVal as T[keyof T];
    }
  }
  return result;
}

/**
 * Build complete gateway configuration from environment variables,
 * optionally deep-merged with explicit overrides.
 *
 * @param overrides - Partial config that takes precedence over env vars.
 *   Useful for embedded mode where the host provides config programmatically.
 */
export function buildGatewayConfig(
  overrides?: DeepPartial<GatewayConfig>
): GatewayConfig {
  logger.debug("Building gateway configuration from environment variables");

  // DATABASE_URL is required; the queue / cache / probe paths read it directly
  // from process.env, so we just assert it's present here and let the rest of
  // the runtime trust the env.
  getRequiredEnv("DATABASE_URL");

  const defaultMemoryFlushEnabled = getOptionalBoolean(
    "AGENT_DEFAULT_MEMORY_FLUSH_ENABLED",
    true
  );
  const defaultMemoryFlushSoftThresholdTokens = getOptionalNumber(
    "AGENT_DEFAULT_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS",
    4000
  );
  const defaultMemoryFlushSystemPrompt = getOptionalEnv(
    "AGENT_DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT",
    "Session nearing compaction. Store durable memories now."
  );
  const defaultMemoryFlushPrompt = getOptionalEnv(
    "AGENT_DEFAULT_MEMORY_FLUSH_PROMPT",
    "Write any lasting notes to memory using available memory tools. Reply with NO_REPLY if nothing to store."
  );
  const publicGatewayUrlRaw = getOptionalEnv(
    "PUBLIC_GATEWAY_URL",
    DEFAULTS.PUBLIC_GATEWAY_URL
  );
  const publicGatewayUrl = publicGatewayUrlRaw
    ? normalizePublicGatewayUrl(publicGatewayUrlRaw)
    : "";
  const config: GatewayConfig = {
    agentDefaults: {
      allowedTools: process.env.ALLOWED_TOOLS?.split(","),
      disallowedTools: process.env.DISALLOWED_TOOLS?.split(","),
      runtime: process.env.AGENT_RUNTIME || process.env.AGENT_DEFAULT_RUNTIME,
      model: process.env.AGENT_DEFAULT_MODEL,
      timeoutMinutes: process.env.TIMEOUT_MINUTES
        ? Number(process.env.TIMEOUT_MINUTES)
        : undefined,
      compaction: {
        memoryFlush: {
          enabled: defaultMemoryFlushEnabled,
          softThresholdTokens: defaultMemoryFlushSoftThresholdTokens,
          systemPrompt: defaultMemoryFlushSystemPrompt,
          prompt: defaultMemoryFlushPrompt,
        },
      },
    },
    sessionTimeoutMinutes: getOptionalNumber(
      "SESSION_TIMEOUT_MINUTES",
      DEFAULTS.SESSION_TIMEOUT_MINUTES
    ),
    logLevel: (process.env.LOG_LEVEL as LogLevel) || DEFAULTS.LOG_LEVEL,
    queues: {
      directMessage: getOptionalEnv(
        "QUEUE_DIRECT_MESSAGE",
        DEFAULTS.QUEUE_DIRECT_MESSAGE
      ),
      messageQueue: getOptionalEnv(
        "QUEUE_MESSAGE_QUEUE",
        DEFAULTS.QUEUE_MESSAGE_QUEUE
      ),
      retryLimit: getOptionalNumber(
        "QUEUE_RETRY_LIMIT",
        DEFAULTS.QUEUE_RETRY_LIMIT
      ),
      retryDelay: getOptionalNumber(
        "QUEUE_RETRY_DELAY",
        DEFAULTS.QUEUE_RETRY_DELAY_SECONDS
      ),
      expireInHours: getOptionalNumber(
        "QUEUE_EXPIRE_HOURS",
        DEFAULTS.QUEUE_EXPIRE_HOURS
      ),
    },
    anthropicProxy: {
      enabled: true,
      anthropicBaseUrl:
        process.env.SECRET_PROXY_UPSTREAM_URL || process.env.ANTHROPIC_BASE_URL,
    },
    orchestration: {
      queues: {
        retryLimit: getOptionalNumber(
          "QUEUE_RETRY_LIMIT",
          DEFAULTS.QUEUE_RETRY_LIMIT
        ),
        retryDelay: getOptionalNumber(
          "QUEUE_RETRY_DELAY",
          DEFAULTS.QUEUE_RETRY_DELAY_SECONDS
        ),
        expireInSeconds:
          getOptionalNumber("QUEUE_EXPIRE_HOURS", DEFAULTS.QUEUE_EXPIRE_HOURS) *
          TIME.HOUR_SECONDS,
      },
      worker: {
        startupTimeoutSeconds: getOptionalNumber(
          "WORKER_STARTUP_TIMEOUT_SECONDS",
          DEFAULTS.WORKER_STARTUP_TIMEOUT_SECONDS
        ),
        idleCleanupMinutes: getOptionalNumber(
          "WORKER_IDLE_CLEANUP_MINUTES",
          DEFAULTS.WORKER_IDLE_CLEANUP_MINUTES
        ),
        maxDeployments: getOptionalNumber(
          "MAX_WORKER_DEPLOYMENTS",
          DEFAULTS.MAX_WORKER_DEPLOYMENTS
        ),
      },
      cleanup: {
        initialDelayMs: getOptionalNumber(
          "CLEANUP_INITIAL_DELAY_MS",
          DEFAULTS.CLEANUP_INITIAL_DELAY_MS
        ),
        intervalMs: getOptionalNumber(
          "CLEANUP_INTERVAL_MS",
          DEFAULTS.CLEANUP_INTERVAL_MS
        ),
        veryOldDays: getOptionalNumber(
          "CLEANUP_VERY_OLD_DAYS",
          DEFAULTS.CLEANUP_VERY_OLD_DAYS
        ),
      },
    },
    mcp: {
      publicGatewayUrl,
    },
    auth: {
      issuerUrl: getOptionalEnv("EXTERNAL_AUTH_ISSUER_URL", undefined),
    },
    secrets: {
      aws: {
        region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
      },
    },
  };

  logger.debug("Gateway configuration built successfully");

  if (overrides) {
    return deepMerge(config, overrides as Partial<GatewayConfig>);
  }

  return config;
}
