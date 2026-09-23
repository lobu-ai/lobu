import { describe, expect, it } from 'vitest';
import { isDeadlockDetected, isQueryCanceled, isUniqueViolation } from '../pg-errors';

describe('pg-errors', () => {
  describe('isQueryCanceled', () => {
    it('is true for a statement_timeout abort (SQLSTATE 57014)', () => {
      // postgres.js surfaces a statement_timeout cancellation as code 57014;
      // the embed-backfill discovery scan relies on this to skip a degraded
      // cycle instead of erroring (and to never run long enough to spike DB CPU).
      expect(isQueryCanceled({ code: '57014' })).toBe(true);
    });

    it('is false for other PG errors and non-errors', () => {
      expect(isQueryCanceled({ code: '23505' })).toBe(false); // unique violation
      expect(isQueryCanceled({ code: '57P03' })).toBe(false); // admin shutdown
      expect(isQueryCanceled(new Error('boom'))).toBe(false);
      expect(isQueryCanceled(null)).toBe(false);
      expect(isQueryCanceled(undefined)).toBe(false);
      expect(isQueryCanceled('57014')).toBe(false);
    });
  });

  describe('isUniqueViolation', () => {
    it('matches 23505 on the named constraint only', () => {
      expect(isUniqueViolation({ code: '23505', constraint: 'idx_foo' }, 'idx_foo')).toBe(true);
      expect(isUniqueViolation({ code: '23505', constraint_name: 'idx_foo' }, 'idx_foo')).toBe(true);
      expect(isUniqueViolation({ code: '23505', constraint: 'idx_bar' }, 'idx_foo')).toBe(false);
      expect(isUniqueViolation({ code: '23503', constraint: 'idx_foo' }, 'idx_foo')).toBe(false);
      expect(isUniqueViolation(null, 'idx_foo')).toBe(false);
    });
  });

  describe('isDeadlockDetected', () => {
    it('matches only SQLSTATE 40P01', () => {
      expect(isDeadlockDetected({ code: '40P01' })).toBe(true);
      expect(isDeadlockDetected({ code: '40001' })).toBe(false);
      expect(isDeadlockDetected(new Error('deadlock detected'))).toBe(false);
      expect(isDeadlockDetected(null)).toBe(false);
    });
  });
});
