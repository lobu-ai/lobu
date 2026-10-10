/**
 * Attribution for lazily-created system entities.
 *
 * `entities.created_by` is NOT NULL behind an ON DELETE RESTRICT FK, so every
 * entity the server creates on its own behalf — a promoted
 * keyed row — still needs a real live user to point
 * at. Callers that already know the responsible person (an Automation's creator,
 * the operator promoting a case) pass it through; the rest fall back to the
 * org's longest-standing owner/admin so the row is attributable to someone who
 * can actually be asked about it.
 *
 * Returns null when the org has no member at all. That is deliberately NOT an
 * throw: call sites decide whether a missing creator means skip or fail.
 */

import type { DbClient } from '../db/client';

export async function resolveEntityCreator(
  tx: DbClient,
  organizationId: string,
  createdBy: string | null | undefined
): Promise<string | null> {
  if (createdBy && createdBy.trim().length > 0) return createdBy;
  const rows = await tx<{ userId: string }>`
    SELECT "userId"
    FROM "member"
    WHERE "organizationId" = ${organizationId}
    ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
             "createdAt" ASC
    LIMIT 1
  `;
  return rows.length > 0 ? rows[0].userId : null;
}
