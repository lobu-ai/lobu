import { createHash } from 'node:crypto';
import { ToolUserError } from './errors';

/**
 * A snapshot of authored configuration, bound to this particular row incarnation.
 * Callers project only authored fields: compiler outputs, counters and other
 * runtime bookkeeping must not invalidate an editor. Object key ordering is
 * irrelevant; array order remains meaningful. Identical authored state yields
 * the same token, including after a change is reverted.
 */
export function configRevision(
  kind: string,
  identity: string | number,
  authoredState: unknown
): string {
  const canonical = JSON.stringify(
    ['config-v1', kind, String(identity), authoredState],
    (_key, value: unknown) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
      }
      return value;
    }
  );
  return `cr1_${createHash('sha256').update(canonical).digest('hex')}`;
}

/** Invoke under the same database lock/transaction as the eventual mutation. */
export function assertExpectedRevision(
  expected: string | undefined,
  current: string
): void {
  if (!expected || expected !== current) {
    throw new ToolUserError(
      expected
        ? 'This configuration changed. Reload it and reapply the intended edit.'
        : 'expected_revision is required. Read the configuration before editing it.',
      409,
      'REVISION_CONFLICT'
    );
  }
}
