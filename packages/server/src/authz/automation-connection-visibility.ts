import type { DbClient } from '../db/client';

interface AutomationConnectionVisibilityContext {
  organizationId: string;
  userId: string | null;
  actingAutomationId?: number | null;
}

/**
 * Resolve the user identity used for connection visibility and user-owned page
 * activation.
 *
 * Automation reactions are headless, so their execution context intentionally has
 * no user principal. They may still use private connections owned by their
 * durable creator. Policy, provenance, and approval checks continue to use the
 * autonomous Automation principal; this resolver supplies the human principal for
 * connection visibility and for an Automation's page-activation ownership.
 */
export async function resolveAutomationConnectionVisibilityUserId(
  ctx: AutomationConnectionVisibilityContext,
  sql: DbClient
): Promise<string | null> {
  if (ctx.userId !== null || ctx.actingAutomationId == null) {
    return ctx.userId;
  }

  const rows = await sql<{ created_by: string }>`
    SELECT created_by
    FROM automations
    WHERE id = ${ctx.actingAutomationId}
      AND organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
  return rows[0]?.created_by ?? null;
}
