/**
 * Server-side enforcement of the promotions pause.
 *
 * A `lobu rollback` pauses promotions for the org so a later `lobu apply`
 * cannot silently re-push the config that was just rolled back. The pause row
 * has lived server-side since #2068, but only the CLI ever honoured it
 * (`apply-cmd.ts` asked, then refused locally), so anything posting straight at
 * the API — CI holding a PAT, or a client predating the check — walked through
 * the exact gate the feature was built to close. Gating the deployment SUMMARY
 * route would not have helped: that record is written after `executePlan` has
 * already mutated the org, and the CLI swallows its failure, so rejecting it
 * blocks nothing and only destroys the audit trail of the offending apply.
 *
 * The seam is the apply header. `x-lobu-apply-id` marks a request as part of a
 * `lobu apply` run, so gating on it freezes promotions without freezing the
 * product: interactive edits from Owletto and one-off API calls carry no such
 * header and are unaffected. This is deliberately a workflow guard, not an
 * authorization credential: it stops cooperating `lobu apply` clients from
 * accidentally re-promoting, but an otherwise-authorized caller can omit the
 * header and remains free to make an ordinary one-off edit.
 *
 * Read-tier calls stay allowed. `lobu apply` reads current config to compute
 * its diff, and `--dry-run` is how an operator inspects what a resume would do;
 * blocking reads would make a paused org undiagnosable.
 *
 * Rollbacks stay allowed. Rolling back FURTHER, because the first rollback did
 * not fix it, is the main thing an operator does while paused. `rollback-cmd`
 * sets the pause before its first mutation to close the re-promotion window, so
 * a blanket block would strand the rollback behind the pause it just created.
 * A rollback declares itself with `x-lobu-rollback-of`, which is checked
 * against a real, restorable deployment in the already-authorized org. The
 * header classifies a CLI workflow; it is not an authentication credential and
 * never chooses the user or organization.
 */

import { getDb } from '../db/client';
import { parseApplyId } from './apply-context';
import { ToolUserError } from './errors';

export interface DeploymentPauseState {
  pausedAt: string | null;
  applyId: string | null;
  rollbackOf: string | null;
  pausedBy: string | null;
}

/** Whether this org owns a deployment snapshot the rollback CLI can restore. */
export async function isRestorableDeployment(
  organizationId: string,
  applyId: string
): Promise<boolean> {
  const sql = getDb();
  const target = await sql`
    SELECT 1
    FROM events
    WHERE organization_id = ${organizationId}
      AND origin_id = ${`deployment_${applyId}`}
      AND semantic_type = 'change'
      AND metadata->>'category' = 'deployment'
      AND metadata->>'apply_id' = ${applyId}
      AND metadata->>'status' IN ('succeeded', 'partial_failure')
      AND jsonb_typeof(payload_data->'manifest') = 'object'
      AND jsonb_typeof(payload_data->'manifest'->'state') = 'object'
    LIMIT 1
  `;
  return target.length > 0;
}

/** Thrown when a paused org receives a mutating apply-run request. */
export class DeploymentsPausedError extends ToolUserError {
  readonly pause: DeploymentPauseState;

  constructor(pause: DeploymentPauseState) {
    super(
      `Deployments are paused for this organization — a rollback restored deployment ${
        pause.rollbackOf ?? '?'
      }. Applying now would re-promote the config that was just rolled back. Reconcile your config repo, then run \`lobu apply --resume\`.`,
      // Same status as checkApplyPause's direct-route refusal, so the REST tool
      // proxy returns the actionable message instead of a 500.
      409
    );
    this.name = 'DeploymentsPausedError';
    this.pause = pause;
  }
}

/**
 * The pause blocking this request, or null if it may proceed. A no-op for every
 * caller that is not a mutating apply-run request — see the module note for why
 * each carve-out exists.
 */
export async function getBlockingPause(params: {
  organizationId: string | null | undefined;
  applyId: string | null;
  rollbackOf: string | null;
  isReadOnly: boolean;
}): Promise<DeploymentPauseState | null> {
  const { organizationId, applyId, rollbackOf, isReadOnly } = params;

  // Not part of an apply run: UI and one-off API edits are never gated.
  if (!organizationId || !applyId) return null;
  // The diff and `--dry-run` must keep working while paused.
  if (isReadOnly) return null;

  const sql = getDb();
  const rows = await sql`
    SELECT paused_at, apply_id, rollback_of, paused_by
    FROM deployment_pause
    WHERE organization_id = ${organizationId}
    LIMIT 1
  `;
  if (rows.length === 0) return null;

  // A rollback may proceed, but only if its claim checks out: the deployment it
  // says it is undoing has to be a restorable deployment in THIS org. An event
  // with a colliding origin_id, a blocked drift report, or a pre-snapshot
  // deployment is not a rollback target and must not turn into an exemption.
  if (rollbackOf && (await isRestorableDeployment(organizationId, rollbackOf))) return null;

  const row = rows[0];
  return {
    pausedAt:
      row.paused_at instanceof Date
        ? row.paused_at.toISOString()
        : typeof row.paused_at === 'string'
          ? row.paused_at
          : null,
    applyId: row.apply_id ?? null,
    rollbackOf: row.rollback_of ?? null,
    pausedBy: row.paused_by ?? null,
  };
}

/** Throwing form, for the tool funnel where a thrown error is the idiom. */
export async function assertDeploymentsNotPaused(
  params: Parameters<typeof getBlockingPause>[0]
): Promise<void> {
  const pause = await getBlockingPause(params);
  if (pause) throw new DeploymentsPausedError(pause);
}

/**
 * Hono-side pause check for the auth funnel. Returns a 409 to short-circuit, or
 * null to let the request through.
 *
 * Three exemptions carry the design:
 *
 *  - Tool-proxy calls are left to `executeTool`'s own guard. Apply's READS go
 *    through that proxy as POSTs (`manage_entity_schema` list, `manage_feeds`
 *    get, …), so the method-based rule below would classify them as mutations
 *    and break `--dry-run` against a paused org — the exact carve-out the
 *    feature promises. The proxy decides read-vs-write from the tool args, which
 *    is the only signal that is actually correct there.
 *  - `POST /deployments` records the outcome after the apply has stopped. It is
 *    audit-only (the route independently validates admin authority and the
 *    summary body), so blocking it would erase the evidence of a refused run.
 *  - `DELETE /deployments/pause` is how `lobu apply --resume` clears the pause.
 *    Gating it would make the pause unexitable.
 *
 * For everything else the HTTP method is the signal: every direct read the CLI
 * issues is a GET, every direct mutation is POST/PATCH/PUT/DELETE.
 */
export async function checkApplyPause(
  c: {
    req: { method: string; path: string; header: (name: string) => string | undefined };
    get: (key: string) => unknown;
    json: (body: unknown, status: 409) => Response;
  },
  applyId: string,
  requestedToolName: string | null
): Promise<Response | null> {
  // The tool proxy gates itself, with an args-aware read/write signal.
  if (requestedToolName) return null;

  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return null;

  // These are exact routes, not suffix matches: an unrelated endpoint named
  // `*/deployments/pause` must not inherit either escape hatch.
  if (method === 'POST' && /^\/api\/[^/]+\/deployments\/?$/.test(c.req.path)) return null;
  if (method === 'DELETE' && /^\/api\/[^/]+\/deployments\/pause\/?$/.test(c.req.path)) return null;

  const pause = await getBlockingPause({
    organizationId: (c.get('organizationId') as string | null) ?? null,
    applyId: parseApplyId(applyId),
    rollbackOf: parseApplyId(c.req.header('x-lobu-rollback-of')),
    isReadOnly: false,
  });
  if (!pause) return null;

  return c.json(
    {
      error: new DeploymentsPausedError(pause).message,
      paused: true,
      pausedAt: pause.pausedAt,
      rollbackOf: pause.rollbackOf,
      pausedBy: pause.pausedBy,
    },
    409
  );
}
