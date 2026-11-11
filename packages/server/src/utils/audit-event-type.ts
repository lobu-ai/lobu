/**
 * The audit/lifecycle event vocabulary, in one dependency-free module.
 *
 * Both ends of the seam need it: `insert-event.ts` stamps the type at write
 * time and `automations/workspace-event.ts` reads it back at match time.
 * Keeping the key and its codec here rather than in the writer lets the reader
 * import them without an import cycle once the writer starts enqueueing
 * activations.
 *
 * Dotted and past-tense to match the event-type vocabulary already in use
 * (`feed.auto_paused`, `message.created`), NOT the underscored `origin_type`
 * audit tag, which stays an internal provenance field.
 */

export interface AuditEventType {
  /**
   * The domain object: `device`, `connection`, `entity`, `relationship`, …
   *
   * Free-form so a new subject costs no code here. State-change writers pass
   * their existing `AuditResourceKind` slugs, which are hyphenated and
   * sometimes compound (`agent-settings`, `auth-profile`) — kept as-is rather
   * than renamed, since those slugs are already the dashboard's pivot.
   */
  subject: string;
  /** Past-tense transition: `created`, `updated`, `deleted`, `linked`, … */
  op: string;
}

/**
 * Reserved metadata key carrying the formatted type.
 *
 * In the server-owned `_lobu_*` namespace, which `save_content` strips from
 * caller-supplied metadata, so an agent cannot forge a subscription target.
 */
export const AUDIT_EVENT_TYPE_METADATA_KEY = '_lobu_event_type';

/**
 * Prefix of the reserved `_lobu_idempotency_key` every audit writer stamps
 * (`audit:<originId>`). Recall reads it to tell the platform change log from
 * other rows that carry the event-type stamp.
 */
export const AUDIT_IDEMPOTENCY_KEY_PREFIX = 'audit:';

/** `{subject:'device', op:'created'}` -> `'device.created'`. */
export function formatAuditEventType(type: AuditEventType): string {
  return `${type.subject}.${type.op}`;
}

/**
 * The stamped type on a persisted row, or null when the row is not an audit
 * event. Non-string and empty values read as absent rather than throwing: the
 * events table is append-only, so rows predating the stamp are permanent and
 * must stay loadable.
 */
export function readAuditEventType(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  const value = metadata?.[AUDIT_EVENT_TYPE_METADATA_KEY];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
