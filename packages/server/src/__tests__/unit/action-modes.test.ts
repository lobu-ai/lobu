import { describe, expect, it } from 'bun:test';
import {
  defaultActionModeForOperation,
  getActionModes,
  resolveActionMode,
} from '../../operations/action-modes';

describe('operation action-mode defaults', () => {
  it('honors an explicit approval requirement even for a read-classified operation', () => {
    expect(
      defaultActionModeForOperation({
        kind: 'read',
        requires_approval: true,
      })
    ).toBe('approval');
  });
});

// Operation keys are connector-chosen strings. A key that names an
// Object.prototype member must resolve like any other key, not to the
// inherited member (which `execute` would treat as "no approval needed").
const PROTOTYPE_KEYS = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'];

describe('action-mode resolution for prototype-named operation keys', () => {
  it('falls back to the connector default when the key is unset', () => {
    for (const operation_key of PROTOTYPE_KEYS) {
      for (const config of [null, {}, { action_modes: {} }]) {
        expect(resolveActionMode({ operation_key, requires_approval: true }, config)).toBe(
          'approval'
        );
      }
    }
  });

  it('honors an explicit mode set for the key', () => {
    for (const operation_key of PROTOTYPE_KEYS) {
      const config = JSON.parse(`{"action_modes":{"${operation_key}":"disabled"}}`);
      expect(resolveActionMode({ operation_key, requires_approval: false }, config)).toBe(
        'disabled'
      );
      expect(getActionModes(config)).toEqual(
        expect.objectContaining({ [operation_key]: 'disabled' })
      );
    }
  });
});
