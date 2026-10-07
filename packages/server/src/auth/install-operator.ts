/**
 * Install-operator bootstrap.
 *
 * At first `lobu run` boot, this provisions a synthetic `install_operator`
 * user so headless installs (CI, containers, /tmp scaffolds without a
 * browser) can sign in via better-auth without a chicken-and-egg /sign-up
 * step. The operator's password is the install's `ENCRYPTION_KEY` —
 * already in `.env` for at-rest encryption, now doing double duty as the
 * install secret. See `docs/plans/install-operator-bootstrap.md` for the full
 * design.
 *
 * Idempotent. Safe to call on every boot.
 */

import { hostname } from 'node:os';
import { hashPassword } from 'better-auth/crypto';
import { assertEncryptionKey } from '@lobu/core';
import { getDb } from '../db/client';
import { generateSecureToken } from './oauth/utils';
import { ensurePersonalOrganization } from './personal-org-provisioning';
import logger from '../utils/logger';

export const INSTALL_OPERATOR_KIND = 'install_operator' as const;

/**
 * Deterministic synthetic email for the install operator. Not a real
 * deliverable address — no password reset / magic link will ever reach
 * it (and the carve-outs in `auth/index.tsx` reject those flows
 * anyway). Using `<hostname>` keeps it stable across reboots on the
 * same host; falls back to `localhost` when `hostname()` is empty.
 */
function installOperatorEmail(): string {
  return `install@${hostname() || 'localhost'}`.toLowerCase();
}

/**
 * Provision the install operator user + credential account + personal
 * org if they don't yet exist. Idempotent.
 *
 * Returns the operator user id (whether it existed or was just created)
 * so callers can chain further setup against the operator's personal org
 * if they want to.
 */
export async function ensureInstallOperator(): Promise<{
  userId: string;
  created: boolean;
}> {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error(
      'ensureInstallOperator: ENCRYPTION_KEY is required. Set it in .env or opt into ephemeral keys with LOBU_ALLOW_EPHEMERAL_ENCRYPTION_KEY=1 (which gateway.ts will generate before this is called).'
    );
  }
  // Validate shape NOW, not later. `hashPassword` happily accepts any
  // string, so a malformed key would bootstrap the operator fine — but
  // then every encrypt/decrypt call (saving a provider API key, etc.)
  // would 500 with the same canonical message. Fail at install instead
  // of leaving a half-broken operator that can sign in but can't
  // persist any encrypted secret.
  assertEncryptionKey(encryptionKey);

  const sql = getDb();

  // Convergent provisioning: every boot ensures each step exists. The
  // user/account rows are immutable (we never re-hash on top of an
  // existing password — that would silently rotate credentials when
  // ENCRYPTION_KEY changed). But the personal-org step lives outside
  // the user-creation txn, so a transient failure there used to leave
  // the operator permanently broken: subsequent boots would see the
  // user row and skip provisioning entirely, and `/api/local-init`
  // would loop forever on `personal_org_missing`. Now we check each
  // step independently and patch missing pieces.
  const existing = (await sql`
    SELECT id, email FROM "user"
     WHERE principal_kind = ${INSTALL_OPERATOR_KIND}
     LIMIT 1
  `) as unknown as Array<{ id: string; email: string }>;

  let userId: string;
  let userEmail: string;
  let created: boolean;

  if (existing.length > 0) {
    userId = existing[0]!.id;
    created = false;
    // Use the STORED email, never a fresh hostname-derived one. A rehomed
    // machine changes `hostname()` but the user row is immutable; passing the
    // recomputed email into personal-org provisioning makes
    // provisionMemberAndCoreIdentities refuse ("user does not own the member
    // email") on every boot forever. The stored value is the address the
    // account was born with.
    userEmail = existing[0]!.email.trim().toLowerCase();
  } else {
    userId = `user_install_${generateSecureToken(8)}`;
    userEmail = installOperatorEmail();
    const hashed = await hashPassword(encryptionKey);

    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO "user"
          (id, name, email, "emailVerified", principal_kind, "createdAt", "updatedAt")
        VALUES
          (${userId}, ${'Local Install'}, ${userEmail}, true,
           ${INSTALL_OPERATOR_KIND}, NOW(), NOW())
      `;

      // Better Auth's email-password adapter expects one `account` row
      // per user with providerId='credential' and the hashed password
      // stored in the `password` column. accountId matches userId by
      // convention.
      const accountId = `acct_install_${generateSecureToken(8)}`;
      await tx`
        INSERT INTO "account"
          (id, "accountId", "providerId", "userId", password,
           "createdAt", "updatedAt")
        VALUES
          (${accountId}, ${userId}, 'credential', ${userId}, ${hashed},
           NOW(), NOW())
      `;
    });
    created = true;
  }

  // Personal org provisioning is convergent: ensurePersonalOrganization
  // is itself idempotent (returns the existing org if one is already
  // tagged with this user.id in metadata). Running it on every boot
  // closes the gap where a transient failure on first boot used to
  // leave the operator without a personal org forever.
  try {
    await ensurePersonalOrganization({
      id: userId,
      email: userEmail,
      name: 'Local Install',
      username: null,
    });
  } catch (err) {
    logger.error(
      { err },
      '[install-operator] Personal-org provisioning failed; will retry on next boot'
    );
  }

  return { userId, created };
}
