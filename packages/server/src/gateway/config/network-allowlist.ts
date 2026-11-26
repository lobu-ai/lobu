import { createLogger, normalizeDomainPatterns } from "@lobu/core";

const logger = createLogger("network-allowlist");

/**
 * Load allowed domains from environment
 *
 * Rules:
 * - Not set: Complete isolation (deny all)
 * - "*": Unrestricted access (allow all)
 * - "domain1,domain2": Allowlist mode (deny by default, allow only these)
 */
export function loadAllowedDomains(): string[] {
  const allowedDomains = process.env.WORKER_ALLOWED_DOMAINS;
  if (!allowedDomains) {
    logger.warn(
      "⚠️  WORKER_ALLOWED_DOMAINS not set - workers will have NO internet access (complete isolation)"
    );
    return [];
  }

  const trimmed = allowedDomains.trim();

  // Special case: * means unrestricted access.
  if (trimmed === "*") {
    logger.debug("WORKER_ALLOWED_DOMAINS=* - unrestricted internet access");
    return ["*"];
  }

  const parsed =
    normalizeDomainPatterns(
      trimmed
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.length > 0)
    ) ?? [];

  logger.debug(`Loaded ${parsed.length} allowed domains from WORKER_ALLOWED_DOMAINS`);
  return parsed;
}

/**
 * Load disallowed domains from environment
 */
export function loadDisallowedDomains(): string[] {
  const disallowedDomains = process.env.WORKER_DISALLOWED_DOMAINS;
  if (!disallowedDomains) return [];

  const parsed =
    normalizeDomainPatterns(
      disallowedDomains
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.length > 0)
    ) ?? [];

  logger.debug(
    `Loaded ${parsed.length} disallowed domains from WORKER_DISALLOWED_DOMAINS`
  );
  return parsed;
}
