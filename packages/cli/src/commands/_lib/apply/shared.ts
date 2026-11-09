import type {
  AutomationExecutionConfig,
  LegacyAutomationExecutionConfig,
} from "@lobu/core/contracts/tools/manage-automations";

/**
 * Shared structural types + tiny helpers used across the apply pipeline
 * (desired-state IR, wire client, diff, apply-cmd).
 *
 * Only shapes that are genuinely IDENTICAL on both sides of the wire belong
 * here — anything that encodes a server-specific response shape stays a
 * `Remote*` type in client.ts.
 */

/**
 * SQL-view backing for a derived entity type. Identical in the desired IR and
 * the wire snapshot: present only for derived (SQL-view-backed) entity types;
 * absent ⇒ stored (the default). `connection` (a slug) is present only for an
 * external-backed view; both sides omit it for an internal view, so it never
 * churns the diff.
 */
export interface EntityBacking {
  sql: string;
  connection?: string;
}

/** One relationship-type rule (source/target entity-type slugs). */
export interface RelationshipRule {
  source: string;
  target: string;
}

/** One Automation SQL data source. */
export interface AutomationSource {
  name: string;
  query: string;
  /** When true, source is context-only and is not linked into the Automation window. */
  context?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Preserve omitted options; replacing a legacy definition must be explicit. */
export function automationExecutionConfig(
  model: string | null | undefined,
  remote?: LegacyAutomationExecutionConfig | null,
  declared?: AutomationExecutionConfig | null
): LegacyAutomationExecutionConfig | null {
  if (declared !== undefined) return declared;
  if (model === undefined) return remote ?? null;
  if (remote?.executor)
    throw new Error(
      "Clear the legacy executor explicitly with executionConfig before changing its model."
    );
  const config = { ...remote };
  if (model === null) delete config.model;
  else config.model = model;
  return Object.keys(config).length > 0 ? config : null;
}

/**
 * Keys of locally-declared connector definitions whose key is already known.
 * A `null` key (an auto-discovered `*.connector.ts` the server compiles) can't
 * be in the set — the key is only resolved at install time.
 */
export function declaredConnectorKeys(
  definitions: ReadonlyArray<{ key: string | null }>
): Set<string> {
  return new Set(definitions.map((d) => d.key).filter((k): k is string => !!k));
}

/** Connector keys referenced by desired auth profiles and connections. */
export function referencedConnectorKeys(connectors: {
  authProfiles: ReadonlyArray<{ connector: string }>;
  connections: ReadonlyArray<{ connector: string }>;
}): Set<string> {
  return new Set<string>([
    ...connectors.authProfiles.map((p) => p.connector),
    ...connectors.connections.map((c) => c.connector),
  ]);
}
