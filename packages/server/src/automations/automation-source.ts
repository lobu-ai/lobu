/**
 * Who to attribute a durable write to, resolved once for every write surface.
 *
 * An acting Automation reaches a handler on two channels: `ctx.actingAutomationId`,
 * stamped by the reaction executor and therefore trustworthy, and a caller-declared
 * `automation_source` argument, which is ordinary user input. Every surface used to
 * merge them inline with `ctx.actingAutomationId ?? args.automation_source?.automation_id`,
 * which trusts the declared half without ever checking it names an Automation in
 * this organization. That has three consequences, all silent:
 *
 *   - a foreign id misattributes the write to another Automation, and where the
 *     value reaches `events.automation_id` it also inherits that Automation's
 *     causal chain (`workspace-event-enqueue.ts`)
 *   - a NONEXISTENT id fails the `events_automation_id_fkey` constraint, and
 *     because audit writes are fire-and-forget the row is dropped entirely
 *   - a declared run belonging to a DIFFERENT Automation batches this
 *     proposal into that Automation's approval card
 *
 * `notify.ts` has validated this field for exactly these reasons since it was
 * added; `execute.ts` started doing so in #2952. This module is that same rule
 * in one place, so a new write surface inherits it instead of re-deriving it.
 *
 * Kept free of tool and gateway imports so any write surface can reach it.
 */

import { automationIdFromPrincipalId } from '../authz/entity-policy';
import { type DbClient, getDb } from '../db/client';
import { encodeExternalAutomationClaimOwner } from './external-claim-owner';

/** The Automation a durable write is attributed to, after verification. */
interface AutomationAttribution {
  automationId: number | null;
  runId: number | null;
}

/**
 * The `automation_source` shape every tool contract declares.
 *
 * Both halves are required: `manage_entity`, `save_content`, and `notify` all
 * type `run_id` as `Type.Number()`, so a declaration missing one is malformed
 * input, not a partial one to honor.
 */
interface DeclaredAutomationSource {
  automation_id: number;
  run_id: number;
}

/** The parts of a ToolContext this resolution reads. */
interface ActingAutomationSession {
  organizationId: string;
  actingAutomationId?: number | null;
  actingRunId?: number | null;
}

/**
 * Drop a declared source unless the Automation belongs to this organization AND
 * the run belongs to that Automation.
 *
 * The pairing is the half that is easy to miss: an org member can name their own
 * Automation next to someone else's `run_id` and land the proposal in that
 * run's approval card. `notify.ts` has paired the two the same way since it
 * was added.
 *
 * Returns null rather than throwing: attribution is a provenance hint, and a bad
 * hint should cost the caller its attribution, not fail their tool call.
 */
export async function verifiedAutomationSource(
  declared: { automationId: number; runId: number } | null,
  organizationId: string
): Promise<{ automationId: number; runId: number } | null> {
  if (!declared) return null;
  // `getDb()` is reached only AFTER the guard, and never as a default parameter:
  // a default is evaluated at call time, so it would run on every call — the
  // overwhelmingly common one with nothing declared included, and unit suites
  // that boot no database at all.
  const rows = await getDb()<{ id: number }>`
    SELECT a.id
    FROM automations a
    JOIN runs run
      ON run.id = ${declared.runId}
     AND run.automation_id = a.id
     AND run.organization_id = a.organization_id
     AND run.run_type = 'automation'
    WHERE a.id = ${declared.automationId}
      AND a.organization_id = ${organizationId}
    LIMIT 1
  `;
  return rows[0] ? declared : null;
}

/**
 * The declared Automation this caller is running right now, or null.
 *
 * A declared source may attribute a write, but it decides whose connector rules
 * apply only while this caller holds the declared run's unexpired window lease,
 * the same claim `claim_next_window` and `complete_window` check. Otherwise an
 * app, person or agent could name any Automation and borrow its Always allow.
 */
export async function leasedAutomationId(
  sql: DbClient,
  caller: LeaseCaller,
  declared: DeclaredAutomationSource | null | undefined
): Promise<number | null> {
  if (!declared) return null;
  return (await holdsWindowLease(sql, caller, declared.automation_id, declared.run_id))
    ? declared.automation_id
    : null;
}

/**
 * The Automation a held operation run was requested as, while this caller is
 * running it; otherwise null.
 *
 * An external processor's write takes its Automation's rules only under a window
 * lease (`leasedAutomationId`), so the run it holds names that Automation.
 * Confirming or withdrawing the run acts as the same Automation and needs a live
 * lease of it too. Any of its windows will do: the processor may have moved on to
 * the next window since the run was held.
 */
export async function leasedAutomationOfHeldRun(
  sql: DbClient,
  caller: LeaseCaller,
  runId: number
): Promise<number | null> {
  const [held] = await sql<{ policy_principal_kind: string | null; policy_principal_id: string | null }>`
    SELECT policy_principal_kind, policy_principal_id FROM runs
    WHERE id = ${runId} AND organization_id = ${caller.organizationId}
  `;
  const automationId = held?.policy_principal_kind === 'automation'
    ? automationIdFromPrincipalId(held.policy_principal_id)
    : null;
  if (automationId == null) return null;
  return (await holdsWindowLease(sql, caller, automationId, null)) ? automationId : null;
}

type LeaseCaller = {
  organizationId: string;
  userId: string | null;
  agentId?: string | null;
  clientId?: string | null;
};

/** Whether the caller holds an unexpired window lease of the Automation (of one run, when given). */
async function holdsWindowLease(
  sql: DbClient,
  caller: LeaseCaller,
  automationId: number,
  runId: number | null
): Promise<boolean> {
  if (!caller.userId && !caller.agentId && !caller.clientId) return false;
  const rows = await sql`
    SELECT 1 FROM runs
    WHERE automation_id = ${automationId}
      ${runId == null ? sql`` : sql`AND id = ${runId}`}
      AND organization_id = ${caller.organizationId}
      AND run_type = 'automation'
      AND status = 'running'
      AND claimed_by = ${encodeExternalAutomationClaimOwner(caller)}
      AND expires_at > current_timestamp
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * The Automation and run a write surface should record.
 *
 * The trusted session identity wins outright — including its run. Letting a
 * declared run through on a reaction session is what would let a script retag
 * its deferral into another Automation's approval batch, which is the precedence
 * every call site's comment already claimed without the code enforcing it.
 *
 * Off-session, the declared source is honored only once verified. An unverified
 * declaration yields no attribution at all rather than a half-applied one.
 */
export async function resolveAutomationAttribution(
  ctx: ActingAutomationSession,
  declared: DeclaredAutomationSource | null | undefined
): Promise<AutomationAttribution> {
  if (ctx.actingAutomationId != null) {
    return {
      automationId: ctx.actingAutomationId,
      runId: ctx.actingRunId ?? null,
    };
  }
  if (!declared) return { automationId: null, runId: null };
  const verified = await verifiedAutomationSource(
    { automationId: declared.automation_id, runId: declared.run_id },
    ctx.organizationId
  );
  return verified ?? { automationId: null, runId: null };
}
