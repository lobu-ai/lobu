/**
 * Thrown from a feed `read` when the source deliberately withholds the
 * requested record (for example, a private person's communications). The read
 * is reported as withheld rather than failed: the caller is told the reason,
 * nothing is retried, and pagination continues past it.
 *
 * The platform keys on the error's own `code === 'withheld'`, never on this
 * class, so a connector on an older SDK opts in with
 * `Object.assign(new Error(reason), { code: 'withheld' })`. The message is the
 * human reason shown to the user.
 */
export class SourceWithheldError extends Error {
  readonly code = 'withheld' as const;

  constructor(reason: string) {
    super(reason);
    this.name = 'SourceWithheldError';
  }
}
