/**
 * Connection action mode resolution.
 *
 * Each connection.config carries an `action_modes` map keyed by operation_key
 * with one of three values: 'disabled' | 'approval' | 'auto'. For operations
 * the user has never explicitly configured (e.g. the connector update adds a
 * new op after install), we fall back to the connector's
 * op.requires_approval default.
 */

import type { OperationDescriptor } from './types';

type ActionMode = 'disabled' | 'approval' | 'auto';

function isActionMode(value: unknown): value is ActionMode {
  return value === 'disabled' || value === 'approval' || value === 'auto';
}

/**
 * Pull a sanitized `action_modes` map out of a raw connection.config blob.
 * Anything that isn't a recognized mode is dropped silently — readers must
 * then fall back to {@link defaultActionModeForOperation}.
 */
export function getActionModes(
  config: Record<string, unknown> | null | undefined
): Record<string, ActionMode> {
  // Null prototype: operation keys are connector-chosen strings, and a key
  // like `toString` or `__proto__` must be an ordinary own entry, never an
  // inherited member that readers mistake for a configured mode.
  const out: Record<string, ActionMode> = Object.create(null);
  if (!config || typeof config !== 'object') return out;
  const raw = (config as Record<string, unknown>).action_modes;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isActionMode(value)) out[key] = value;
  }
  return out;
}

/**
 * Default mode when the user never set this op on the connection.
 * - explicitly approval-gated operations → approval (including remote reads)
 * - other reads → auto
 * - writes with destructiveHint → approval
 * - other writes → auto
 * `disabled` requires an explicit user opt-in.
 */
export function defaultActionModeForOperation(operation: {
  requires_approval: boolean;
  kind?: 'read' | 'write';
  annotations?: { destructiveHint?: boolean };
}): ActionMode {
  if (operation.requires_approval) return 'approval';
  if (operation.kind === 'read') return 'auto';
  if (operation.annotations?.destructiveHint === true) return 'approval';
  return 'auto';
}

export function resolveActionMode(
  operation: {
    requires_approval: boolean;
    operation_key: string;
    kind?: 'read' | 'write';
    annotations?: { destructiveHint?: boolean };
  },
  config: Record<string, unknown> | null | undefined
): ActionMode {
  const modes = getActionModes(config);
  return modes[operation.operation_key] ?? defaultActionModeForOperation(operation);
}

/**
 * Filter a list of operations against a connection's action_modes,
 * dropping anything in 'disabled' mode. listOperations applies this to
 * connection-scoped listings unless the caller opts into includeDisabled
 * to render enablement help.
 */
export function filterOperationsByActionModes<T extends OperationDescriptor>(
  operations: T[],
  config: Record<string, unknown> | null | undefined
): T[] {
  return operations.filter(
    (operation) => resolveActionMode(operation, config) !== 'disabled'
  );
}
