/**
 * Pure helpers for the optional Automation material-change digest (#3663).
 *
 * The digest is a built-in post-commit notification, separate from reaction
 * scripts that call `notify` themselves: after a successful run with material
 * entity changes, one digest is delivered through the Automation's explicit
 * `delivery_target` bound channel. Zero-material-change runs stay silent.
 *
 * Keying (idempotent retry, no duplicate on replay):
 *   task row:         source run + destination + material-change fingerprint
 *   notification row: `automation:{id}:run:{run}:digest:{fingerprint}:{connection}:{channel}`
 * both resolving against the same `_lobu_idempotency_key` unique index the
 * notification path already races on.
 *
 * Kept dependency-free (no DB, no scheduler) so unit tests and the UI preview
 * can share the exact content contract the delivery task sends.
 */

import { createHash } from 'node:crypto';

/** One entity write from `complete-window.ts`'s atomic promotion. */
export interface AutomationDigestChange {
  entityId: number;
  name: string;
  kind: 'created' | 'updated' | 'denied';
}

/** Material changes are applied writes only — a refusal is not a digest. */
export function materialDigestChanges(
  changes: AutomationDigestChange[]
): AutomationDigestChange[] {
  return changes.filter((c) => c.kind === 'created' || c.kind === 'updated');
}

/**
 * Stable fingerprint over the material changes. Canonical order (entity,
 * kind, name) so extraction order never changes the key a retry resolves on.
 */
export function fingerprintMaterialDigestChanges(
  changes: AutomationDigestChange[]
): string {
  const material = materialDigestChanges(changes);
  const canonical = [...material]
    .sort(
      (a, b) =>
        a.entityId - b.entityId ||
        (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    )
    .map((c) => [c.entityId, c.kind, c.name]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** The `change_set` idempotency key `complete-window.ts` writes. Single source
 *  so the digest task rehydrates the exact evidence the window committed. */
export function automationChangeSetIdempotencyKey(
  automationId: number,
  runId: number
): string {
  return `automation:${automationId}:run:${runId}:change_set`;
}

/** Durable digest-task key: source run + destination + fingerprint. */
export function automationDigestTaskKey(params: {
  sourceRunId: number;
  connectionId: number;
  channelId: string;
  fingerprint: string;
}): string {
  return `automation-digest:${params.sourceRunId}:${params.connectionId}:${params.channelId}:${params.fingerprint}`;
}

/** Notification producer key for the digest event itself. */
export function automationDigestNotificationKey(params: {
  automationId: number;
  sourceRunId: number;
  fingerprint: string;
  connectionId: number;
  channelId: string;
}): string {
  return (
    `automation:${params.automationId}:run:${params.sourceRunId}:digest:` +
    `${params.fingerprint}:${params.connectionId}:${params.channelId}`
  );
}

const DIGEST_PREVIEW_LINES = 20;

/**
 * Exact user-facing digest content for a material change set. The delivery
 * task and the UI preview both build from this, so what the author approves
 * before save is byte-for-byte what the channel receives.
 */
export function buildAutomationDigestContent(params: {
  automationName: string;
  changes: AutomationDigestChange[];
}): { title: string; body: string } {
  const material = materialDigestChanges(params.changes);
  const created = material.filter((c) => c.kind === 'created');
  const updated = material.filter((c) => c.kind === 'updated');
  const name = params.automationName.trim() || 'Automation';
  const title = `${name} applied ${created.length} new + ${updated.length} updated`;
  const lines = [...material]
    .sort(
      (a, b) =>
        a.entityId - b.entityId ||
        (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
    )
    .slice(0, DIGEST_PREVIEW_LINES)
    .map((c) =>
      c.kind === 'created'
        ? `+ ${c.name} (#${c.entityId})`
        : `~ ${c.name} (#${c.entityId})`
    );
  if (material.length > DIGEST_PREVIEW_LINES) {
    lines.push(`…and ${material.length - DIGEST_PREVIEW_LINES} more`);
  }
  return { title, body: lines.join('\n') };
}
