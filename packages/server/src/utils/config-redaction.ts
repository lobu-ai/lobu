/**
 * Redaction for state-change audit snapshots. Mutation payloads can carry
 * resolved secret material — platform config arrives from `lobu apply` with
 * `$VAR`/`secret()` refs already resolved to plaintext — so every state
 * snapshot is passed through here before it is persisted into
 * `events.payload_data`.
 *
 * The denylist walk and sentinel live in @lobu/core (`secret-redaction`),
 * shared with the CLI's manifest hashing; this module adds the per-kind
 * rules that only the server needs.
 */

import { deepRedactSecrets, REDACTED_SENTINEL } from '@lobu/core';

export { REDACTED_SENTINEL };

/**
 * Resource kinds for config-change events. Mirrors the CLI apply DiffRow
 * `kind` union so per-kind counts and per-resource rows line up in the
 * deployments UI without a mapping table.
 */
export const CONFIG_RESOURCE_KINDS = [
  'agent',
  'agent-settings',
  'platform',
  'entity-type',
  'relationship-type',
  'automation',
  'connector-definition',
  'auth-profile',
  'connection',
  'feed',
  'inference-provider',
  'provider-key',
] as const;

export type ConfigResourceKind = (typeof CONFIG_RESOURCE_KINDS)[number];

const CONFIG_RESOURCE_KIND_SET = new Set<string>(CONFIG_RESOURCE_KINDS);

export function isConfigResourceKind(
  kind: unknown
): kind is ConfigResourceKind {
  return typeof kind === 'string' && CONFIG_RESOURCE_KIND_SET.has(kind);
}

/**
 * Server-emitted workspace identity resources; never part of `lobu apply`.
 *
 * A runtime const rather than a bare type union because the platform event
 * catalog enumerates these to decide what an Automation may subscribe to — a
 * type alone cannot be iterated, and a second hand-kept list would drift.
 */
export const WORKSPACE_AUDIT_RESOURCE_KINDS = [
  'organization',
  'member',
  'invitation',
] as const;

export type WorkspaceAuditResourceKind =
  (typeof WORKSPACE_AUDIT_RESOURCE_KINDS)[number];

export type AuditResourceKind = ConfigResourceKind | WorkspaceAuditResourceKind;

/**
 * Redact a post-change state snapshot before persisting it.
 *
 * On top of the deep-walk denylist, per-kind hard rules cover fields whose
 * secret-ness the key name can't reveal:
 *  - `auth-profile`: `credentials` replaced wholesale (connector-defined keys).
 *  - `platform` / `connection`: `config` deep-walked (denylist) — platform
 *    config values arrive as resolved plaintext from the CLI.
 *  - `inference-provider`: `apiKey`/`api_key` (already denylisted; kept
 *    explicit as a guarantee, not a heuristic).
 *  - `provider-key`: never snapshotted — state is forced to null.
 *  - `organization` / `member` / `invitation`: no additional hard rules;
 *    ordinary identity fields remain visible while the denylist still strips
 *    any unexpectedly nested secret material.
 */
export function redactConfigState(
  kind: AuditResourceKind,
  state: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (state === null) return null;
  if (kind === 'provider-key') return null;

  const redacted = deepRedactSecrets(state) as Record<string, unknown>;

  if (kind === 'auth-profile' && redacted.credentials != null) {
    redacted.credentials = REDACTED_SENTINEL;
  }
  if (kind === 'automation') {
    // Delivery target retains only the bounded routing ids — never secret
    // connector config. Stored values already carry just these keys, but the
    // audit snapshot is the enforcement point, not the writer.
    // connection_id is numeric per the contract (legacy string rows kept);
    // channel arrives as channel_id (contract) with a bare `channel` alias
    // tolerated for forward-compat.
    const target = redacted.delivery_target;
    if (target != null && typeof target === 'object' && !Array.isArray(target)) {
      const t = target as Record<string, unknown>;
      const connectionId =
        typeof t.connection_id === 'number' && Number.isFinite(t.connection_id)
          ? { connection_id: t.connection_id }
          : typeof t.connection_id === 'string'
            ? { connection_id: t.connection_id }
            : {};
      const channelId =
        typeof t.channel_id === 'string'
          ? { channel_id: t.channel_id }
          : typeof t.channel === 'string'
            ? { channel: t.channel }
            : {};
      redacted.delivery_target = { ...connectionId, ...channelId };
    }
    // Never persist compiled reaction bytes or credential-bearing executor
    // material — the source script + redacted config are sufficient for audit.
    if (redacted.reaction_script_compiled != null) {
      redacted.reaction_script_compiled = REDACTED_SENTINEL;
    }
  }
  return redacted;
}
