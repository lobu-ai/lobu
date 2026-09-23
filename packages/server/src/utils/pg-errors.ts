/**
 * PostgreSQL error helpers shared across scheduled tasks.
 */

/**
 * Check whether a caught error is a PG unique-violation (23505) on a
 * specific constraint.  Useful for idempotent INSERT … ON CONFLICT guards
 * that rely on a partial unique index rather than ON CONFLICT syntax.
 */
export function isUniqueViolation(error: unknown, constraintName: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const pg = error as { code?: string; constraint?: string; constraint_name?: string };
  const constraint = pg.constraint ?? pg.constraint_name;
  return pg.code === '23505' && constraint === constraintName;
}

/**
 * Check whether a caught error is a PG query-canceled (57014) — raised when a
 * statement exceeds `statement_timeout`. Callers that bound a scan with a
 * timeout use this to skip gracefully instead of erroring the whole tick.
 */
export function isQueryCanceled(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: string }).code === '57014';
}

/**
 * Check whether a caught error is a PG deadlock (40P01). Postgres aborts one
 * transaction of the cycle; the victim's work rolled back in full and is safe
 * to run again.
 */
export function isDeadlockDetected(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: string }).code === '40P01';
}
