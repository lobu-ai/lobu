import { randomUUID } from "node:crypto";

import {
	ApproveAction,
	ApproveBatchAction,
	type ManageOperationsResult,
	RejectAction,
	RejectBatchAction,
} from "../schemas";
import type { Static } from "@sinclair/typebox";
import {
	agentExistsInOrg,
	resolveAutomationOwner,
	resolveWritePolicyDecision,
	automationIdFromPrincipalId,
} from "../../../../authz/entity-policy";
import { EntityRowValidationError } from "../../../../authz/entity-row-validation";
import { lockOrgForAclInvalidation } from "../../../../authz/acl-generation";
import { type DbClient, getDb, parsePgNumberArray, pgTextArray } from "../../../../db/client";
import { lockResolutionCandidate, wasResolutionRejected } from "../../../../entity-resolution/rejection";
import { droppedEvidence } from "../../../../entity-resolution/evidence-strength";
import { ResolutionFingerprintError } from "../../../../entity-resolution/staleness";
import type { Env } from "../../../../index";
import { resolveActionMode } from "../../../../operations/action-modes";
import { getOperationForConnection } from "../../../../operations/connector-operations";
import { validateOperationInput } from "../../../../operations/input-validation";
import { insertEvent } from "../../../../utils/insert-event";
import { recordEntityWriteDenial } from "../../../../utils/entity-write-denial-audit";
import logger from "../../../../utils/logger";
import { isAdminOrOwnerRole } from "../../../access-control";
import type { ToolContext } from "../../../registry";
import {
	type ApprovalReviewer,
	requireApprovalCard,
	supersedeActionEvent,
	terminalizeApprovalRunCompleted,
} from "../../approval-events";
import {
	applyEntityChangeProposal,
	asMergeProposal,
	ENTITY_CHANGE_ACTION_KEYS,
	type EntityChangeProposal,
	type MergeApprovalResolution,
	mergeReviewEventMetadata,
	refreshMergeProposalFingerprint,
	resolveMergeApproval,
} from "../../entity-field-approval";
import { AGENT_ASK_ACTION_KEY, isAgentAskProposal } from "../../../../notifications/ask";
import { validateAskAnswerForProposal } from "../../../../notifications/ask-schema";
import {
	applyManageAgentsProposal,
	MANAGE_AGENTS_ACTION_KEY,
	type ManageAgentsProposal,
} from "../../manage_agents";
import {
	applyManageAutomationsProposal,
	MANAGE_AUTOMATIONS_ACTION_KEY,
	type ManageAutomationsProposal,
} from "../../manage_automations";
import {
	applyManageEntitySchemaProposal,
	isManageEntitySchemaProposal,
	MANAGE_ENTITY_SCHEMA_ACTION_KEY,
	type StoredManageEntitySchemaProposal,
} from "../../manage_entity_schema";
import { runLeaseFence } from "../../../../runs/run-lease";
import { executeOperationInline } from "./execute";
import { qualifiedOperationKey } from "./shared";
/**
 * Durably persist a claimed run's apply/execution output in its OWN
 * transaction, BEFORE the terminalization attempt. If the terminal card write
 * then fails, only the terminal status rolls back — the only durable copy of a
 * successful external result (for agent_ask, the human's answer) survives, and
 * a retry can complete the run without re-running the mutation or losing the
 * output. Idempotent: re-writing the same value on a retry is a no-op.
 *
 * The guard (status='running' AND approval_status='approved') scopes the write
 * to the claimed state; a run reaped/terminalized concurrently is left alone.
 */
async function persistDurableApplyOutput(
	runId: number,
	organizationId: string,
	output: Record<string, unknown>,
	claimedBy: string,
): Promise<void> {
	const sql = getDb();
	await sql`
		UPDATE runs SET action_output = ${sql.json(output)}
		WHERE id = ${runId}
			AND organization_id = ${organizationId}
			AND approval_status = 'approved'
			${runLeaseFence(sql, claimedBy)}
	`;
}

/**
 * Re-attempt terminalization of a run whose apply/execution already succeeded
 * durably but whose 'completed' card write failed and rolled back. Detected by
 * the durable claim state: approval_status='approved' + status='running' +
 * action_output NOT NULL — only {@link persistDurableApplyOutput} sets
 * action_output on a non-terminal run, so the signal is unambiguous.
 *
 * Returns a result when the run was reconciled (terminalized from its durable
 * output, no apply re-run); null when the run is not in that state so the
 * caller falls through to the normal pending paths.
 */
async function tryReconcileTerminalization(
	args: Static<typeof ApproveAction>,
	ctx: ToolContext,
	reviewer: ApprovalReviewer | null,
): Promise<ManageOperationsResult | null> {
	const sql = getDb();
	const rows = await sql`
		SELECT run_type, action_key, action_input, action_output, claimed_by
		FROM runs
		WHERE id = ${args.run_id}
			AND organization_id = ${ctx.organizationId}
			AND approval_status = 'approved'
			AND status = 'running'
			AND action_output IS NOT NULL
			AND run_type = ANY(${pgTextArray(["internal", "action"])}::text[])
		LIMIT 1
	`;
	if (rows.length === 0) return null;
	const row = rows[0] as {
		run_type: string;
		action_key: string;
		action_input: unknown;
		action_output: Record<string, unknown>;
		claimed_by: string | null;
	};
	const output = row.action_output;
	let title: string;
	let content: string;
	let message: string;
	if (row.run_type === "internal") {
		const handler = getBuilderApprovalHandlers().find(
			(candidate) => candidate.actionKey === row.action_key,
		);
		if (!handler) return null;
		const desc = handler.describe(row.action_input);
		title = `${handler.nounLabel}: ${desc} — completed`;
		content = `Builder action completed: ${desc}`;
		message = `${handler.nounLabel} ${desc} approved and applied.`;
	} else {
		title = `${row.action_key} — completed`;
		content = `Operation completed: ${row.action_key}`;
		message = "Operation approved and executed.";
	}
	const eventId = await terminalizeApprovalRunCompleted(
		args.run_id,
		ctx.organizationId,
		output,
		{ title, content },
		reviewer,
		// This request did not claim the run — it is recovering one whose
		// terminal write failed. Fence on the owner as read so a concurrent
		// re-claim wins instead of being overwritten.
		row.claimed_by,
	);
	if (eventId === null) {
		return {
			error:
				"The approval was already decided while this request was in flight. Refresh before acting.",
		};
	}
	return {
		action: "approve",
		approved: true,
		run_id: args.run_id,
		event_id: eventId,
		message,
	};
}

/**
 * Resolve the acting user's display name for the approval audit trail. Approvals
 * are web-session only (`ctx.clientId` is rejected upstream), so `ctx.userId` is
 * always a real human here; we still guard on null for safety.
 */
async function resolveReviewer(
	ctx: ToolContext,
): Promise<ApprovalReviewer | null> {
  if (!ctx.userId) return null;
  const rows = await getDb()<{ name: string | null }>`
    SELECT name FROM "user" WHERE id = ${ctx.userId} LIMIT 1
  `;
  return { userId: ctx.userId, name: rows[0]?.name ?? null };
}

async function lockOrganizationForApproval(
	tx: DbClient,
	organizationId: string,
): Promise<void> {
	await tx`
		SELECT 1 FROM organization
		WHERE id = ${organizationId}
		FOR KEY SHARE
	`;
}

/**
 * Builder-gate approval handler: the per-family knobs the ONE generic
 * claim/approve/reject path varies over. manage_agents and manage_automations both
 * queue a pending `run_type='internal'` run keyed by `action_key`, hold the
 * proposal in `action_input`, and apply it via the handler's transactional or
 * non-transactional apply seam on approval — so the whole lifecycle is shared
 * and only these fields differ. Add a new builder family by registering another
 * handler here.
 */
interface BuilderApprovalHandler {
	/** `runs.action_key` this family's pending rows carry. */
	actionKey: string;
	/** Noun for the result message, e.g. "Agent" / "Automation". */
	nounLabel: string;
	/** The proposal shape stored in `action_input` is valid for this family. */
	isValidProposal(proposal: unknown): boolean;
	/**
	 * Apply the held proposal on approval (the family's write handler).
	 *
	 * Dispatch directly rather than through the routed tool surface: the approval
	 * path already verifies a human with authority, while resolve_approval itself
	 * intentionally requires only mcp:write. Re-entering routeAction would add a
	 * fresh-call mcp:admin gate after the run has been claimed.
	 *
	 * `input` is what the HUMAN supplied with their decision (`approve({ input })`),
	 * distinct from the agent-authored `proposal`. It was previously accepted by
	 * the tool contract and then dropped on the floor here, so a form-shaped
	 * approval reported success while discarding everything the reviewer typed.
	 */
	apply?(
		proposal: unknown,
		ctx: ToolContext,
		env: Env,
		ownerUserId: string | null,
		input: Record<string, unknown> | null,
	): Promise<unknown>;
	/** DB-only apply that must share claim, mutation, terminal card, and run commit. */
	applyInTransaction?(
		proposal: unknown,
		ctx: ToolContext,
		env: Env,
		ownerUserId: string | null,
		input: Record<string, unknown> | null,
		db: DbClient,
	): Promise<unknown>;
	/** One-line action id for event summaries, e.g. `create agent-7`. */
	describe(proposal: unknown): string;
	/**
	 * Optional pre-claim check on the human's `input`. A non-null string refuses
	 * the decision and leaves the run PENDING — the reviewer can answer again.
	 * Runs before the claim precisely so a rejected decision is retryable; a
	 * failure after the claim would burn the run.
	 */
	validateInput?(
		proposal: unknown,
		input: Record<string, unknown> | null,
	): string | null;
	/**
	 * Optional soft-failure detector for handlers that return `{ error }` /
	 * partial-failure summaries instead of throwing (manage_automations). A non-null
	 * string marks the apply failed even though it didn't throw.
	 */
	detectSoftFailure?(output: unknown): string | null;
}

/**
 * Soft failures from manage_automations write handlers that return errors instead
 * of throwing. create throws (ToolUserError); update returns `{ error: string }`
 * for invalid cron/timezone; delete returns a summary with per-id results and
 * never throws on individual archive failures. Partial delete success (some
 * succeeded, some failed) is treated as completed — the summary is preserved in
 * action_output so the reviewer can see which ids failed.
 */
function detectManageAutomationsApplyFailure(output: unknown): string | null {
	if (!output || typeof output !== "object") return null;
	const result = output as Record<string, unknown>;
	if (result.error) {
		return typeof result.error === "string"
			? result.error
			: String(result.error);
	}
	const summary = result.summary as
		| { total?: number; successful?: number; failed?: number }
		| undefined;
	if (
		summary &&
		typeof summary.failed === "number" &&
		summary.failed > 0 &&
		summary.successful === 0
	) {
		const total =
			typeof summary.total === "number" ? summary.total : summary.failed;
		return `Automation delete failed: 0 of ${total} succeeded`;
	}
	return null;
}

// Lazy: BUILDER_APPROVAL_HANDLERS used to be a top-level const that read
// MANAGE_AUTOMATIONS_ACTION_KEY during module init. Under the circular graph
// manage_operations → dispatch-chrome / manage_automations → … → manage_operations,
// that access hit TDZ and red-failed CI unit (`Cannot access 'MANAGE_AUTOMATIONS_ACTION_KEY'
// before initialization`). Defer until first call after all modules settle.
let builderApprovalHandlers: BuilderApprovalHandler[] | null = null;
function getBuilderApprovalHandlers(): BuilderApprovalHandler[] {
	if (builderApprovalHandlers) return builderApprovalHandlers;
	builderApprovalHandlers = [
		{
			actionKey: MANAGE_AGENTS_ACTION_KEY,
			nounLabel: "Agent",
			isValidProposal: (p) => p != null,
			apply: (p, ctx, env, owner) =>
				applyManageAgentsProposal(p as ManageAgentsProposal, ctx, env, owner),
			describe: (p) => {
				const proposal = p as ManageAgentsProposal;
				return `${proposal.action} ${proposal.agent_id}`;
			},
		},
		{
			actionKey: MANAGE_AUTOMATIONS_ACTION_KEY,
			nounLabel: "Automation",
			isValidProposal: (p) =>
				(p as ManageAutomationsProposal | null)?.args != null,
			apply: (p, ctx, env, owner) =>
				applyManageAutomationsProposal(
					p as ManageAutomationsProposal,
					ctx,
					env,
					owner,
				),
			describe: (p) => (p as ManageAutomationsProposal).args.action,
			detectSoftFailure: detectManageAutomationsApplyFailure,
		},
		{
			actionKey: MANAGE_ENTITY_SCHEMA_ACTION_KEY,
			nounLabel: "Entity schema",
			isValidProposal: isManageEntitySchemaProposal,
			applyInTransaction: (p, ctx, env, owner, _input, db) =>
				applyManageEntitySchemaProposal(
					p as StoredManageEntitySchemaProposal,
					ctx,
					env,
					owner,
					db,
				),
			describe: (p) => {
				const proposal = p as StoredManageEntitySchemaProposal;
				return `${proposal.action} ${String(proposal.args.slug)}`;
			},
		},
		{
			// An agent-authored ask. Unlike the builder families there is no held
			// mutation to apply — the human's ANSWER is the entire outcome, so
			// "apply" just returns it and the generic path persists it to
			// `runs.action_output` + the completed interaction event. That is what
			// the asking agent reads back via get_run.
			actionKey: AGENT_ASK_ACTION_KEY,
			nounLabel: "Question",
			isValidProposal: isAgentAskProposal,
			apply: async (_proposal, _ctx, _env, _owner, input) => ({
				answer: input ?? {},
			}),
			describe: (p) =>
				isAgentAskProposal(p) ? p.question : AGENT_ASK_ACTION_KEY,
			// An ask has no held mutation to fall back on: if the required fields
			// are missing there is nothing to record but an empty answer, and the
			// run would complete reporting success while the agent learns nothing.
			// Approving a blank form did exactly that (`{answer:{}}`).
			validateInput: (proposal, input) =>
				isAgentAskProposal(proposal)
					? validateAskAnswerForProposal(proposal, input)
					: null,
		},
	];
	return builderApprovalHandlers;
}

/**
 * Atomically claim a pending builder-gate run for ANY registered family. The
 * `action_key = ANY(...)` predicate + `RETURNING action_key` lets one query
 * cover every family and hand back the matching handler. Returns null when this
 * run_id isn't a pending builder run (caller falls through to the next approval
 * path). `run_type = 'internal'` scopes to builder runs; connector-operation
 * runs (`run_type='action'`) are handled separately.
 */
async function claimBuilderRun(
	runId: number,
	organizationId: string,
	decision: "approved" | "rejected",
	rejectReason?: string,
	db: DbClient = getDb(),
): Promise<{
	handler: BuilderApprovalHandler;
	proposal: unknown;
	requesterUserId: string | null;
	claimedBy: string;
} | null> {
	const sql = db;
	const handlers = getBuilderApprovalHandlers();
	const actionKeys = pgTextArray(handlers.map((h) => h.actionKey));
	// The approve branch runs the handler's apply OUTSIDE this transaction, so
	// the run sits `running` across a slow external call. Take the lease in the
	// same statement that approves it — an approved, running, unowned row is
	// what the reaper and a second approve both grab. The reject branch is
	// terminal in one statement and has no such window.
	const claimedBy = `gateway-inline-${randomUUID()}`;
	const rows =
		decision === "approved"
			? await sql`
          UPDATE runs
          SET approval_status = 'approved', status = 'running',
              claimed_by = ${claimedBy}, claimed_at = current_timestamp,
              last_heartbeat_at = current_timestamp
          WHERE id = ${runId}
            AND organization_id = ${organizationId}
            AND approval_status = 'pending'
            AND run_type = 'internal'
            AND action_key = ANY(${actionKeys})
          RETURNING action_input, created_by_user_id, action_key
        `
			: await sql`
          UPDATE runs
          SET approval_status = 'rejected', status = 'cancelled',
              error_message = ${rejectReason ?? "Rejected by user"}, completed_at = NOW()
          WHERE id = ${runId}
            AND organization_id = ${organizationId}
            AND approval_status = 'pending'
            AND run_type = 'internal'
            AND action_key = ANY(${actionKeys})
          RETURNING action_input, created_by_user_id, action_key
        `;
	if (rows.length === 0) return null;
	const row = rows[0] as {
		action_input: unknown;
		created_by_user_id: string | null;
		action_key: string;
	};
	const handler = handlers.find((h) => h.actionKey === row.action_key);
	if (!handler || !handler.isValidProposal(row.action_input)) return null;
	return {
		handler,
		proposal: row.action_input,
		requesterUserId: row.created_by_user_id,
		claimedBy,
	};
}

/** Mark a claimed builder run failed + supersede its card to 'failed'. */
async function failBuilderRun(
	runId: number,
	organizationId: string,
	handler: BuilderApprovalHandler,
	desc: string,
	errorMessage: string,
	reviewer: ApprovalReviewer | null,
	claimedBy: string,
): Promise<ManageOperationsResult> {
	// Atomic: the failed runs write and the 'failed' card supersede commit
	// together. The card guard runs INSIDE the transaction, so a missing card
	// throws while the tx is open and rolls the runs write back — the run must
	// never land terminal with no card.
	//
	// Fenced: apply() ran OUTSIDE any transaction, so the reaper or a second
	// approve can have taken the lease while it was in flight. Without the fence
	// this write clobbers whatever they recorded and supersedes the card to
	// 'failed' on a run that is no longer ours.
	const eventId = await getDb().begin(async (tx) => {
		const rows = await tx`
			UPDATE runs SET status = 'failed', completed_at = NOW(), error_message = ${errorMessage}
			WHERE id = ${runId} AND organization_id = ${organizationId}
			${runLeaseFence(tx, claimedBy)}
			RETURNING id
		`;
		if (rows.length === 0) return null;
		const cardId = await supersedeActionEvent(
			runId,
			organizationId,
			"failed",
			`${handler.nounLabel}: ${desc} — failed`,
			`Builder action failed: ${desc} — ${errorMessage}`,
			{ error_message: errorMessage },
			reviewer,
			tx,
		);
		requireApprovalCard(runId, cardId, "failed");
		return cardId;
	});
	if (eventId === null) {
		return {
			error:
				"The approval was already decided while this request was in flight. Refresh before acting.",
		};
	}
	return {
		action: "approve",
		approved: true,
		run_id: runId,
		event_id: eventId,
		message: `${handler.nounLabel} ${desc} approved but failed: ${errorMessage}`,
	};
}

/**
 * Approve + apply a builder-gate run of ANY registered family. Returns a result
 * when the run was a pending builder run; null to fall through to the next
 * approval path. Routes terminal events through {@link supersedeActionEvent}
 * (supersedesEventId is passed explicitly — origin-based auto-supersede needs a
 * non-null connection_id, which internal approval events don't have).
 */
/**
 * Run the family's optional `validateInput` against a still-pending builder run.
 * Returns the refusal message, or null when there is nothing to check (unknown
 * run, other family, no validator) — the caller then proceeds to the claim,
 * which is what decides whether this run was ours at all.
 */
async function validateBuilderRunInput(
	args: Static<typeof ApproveAction>,
	organizationId: string,
): Promise<string | null> {
	const rows = await getDb()`
    SELECT action_key, action_input
    FROM runs
    WHERE id = ${args.run_id}
      AND organization_id = ${organizationId}
      AND run_type = 'internal'
      AND approval_status = 'pending'
    LIMIT 1
  `;
	if (rows.length === 0) return null;
	const row = rows[0] as { action_key: string; action_input: unknown };
	const handler = getBuilderApprovalHandlers().find(
		(candidate) => candidate.actionKey === row.action_key,
	);
	return (
		handler?.validateInput?.(
			row.action_input,
			(args.input as Record<string, unknown> | undefined) ?? null,
		) ?? null
	);
}

async function tryApproveBuilderRun(
	args: Static<typeof ApproveAction>,
	ctx: ToolContext,
	env: Env,
): Promise<ManageOperationsResult | null> {
	// Validate the human's input BEFORE the claim. The claim flips
	// approval_status to 'approved', so refusing afterwards would leave a run
	// that can never be answered — the decision has to be rejectable while it is
	// still pending. The read is non-locking and the claim below stays atomic;
	// this only checks caller-supplied input, never shared state.
	const refusal = await validateBuilderRunInput(args, ctx.organizationId);
	if (refusal) return { error: refusal };

	const reviewer = await resolveReviewer(ctx);
	const input = (args.input as Record<string, unknown> | undefined) ?? null;
	const transaction = {
		attempt: null as { nounLabel: string; desc: string } | null,
	};
	let phaseOne;
	try {
		// Every builder family shares one claim + confirmed-card transaction.
		// DB-only mutations finish inside it; external/slow handlers return a
		// continuation that runs after this short transaction commits.
		phaseOne = await getDb().begin(async (tx) => {
			await lockOrganizationForApproval(tx, ctx.organizationId);
			const claim = await claimBuilderRun(
				args.run_id,
				ctx.organizationId,
				"approved",
				undefined,
				tx,
			);
			if (!claim) return null;
			const desc = claim.handler.describe(claim.proposal);
			const confirmedEventId = await supersedeActionEvent(
				args.run_id,
				ctx.organizationId,
				"confirmed",
				`${claim.handler.nounLabel}: ${desc} — executing`,
				`Builder action confirmed: ${desc}`,
				{},
				reviewer,
				tx,
			);
			requireApprovalCard(args.run_id, confirmedEventId, "confirmed");

			const applyInTransaction = claim.handler.applyInTransaction;
			if (!applyInTransaction) {
				const apply = claim.handler.apply;
				if (!apply) {
					throw new Error(`Approval handler ${claim.handler.actionKey} has no apply seam`);
				}
				return { kind: "external" as const, ...claim, apply, desc };
			}

			transaction.attempt = { nounLabel: claim.handler.nounLabel, desc };
			const output = await applyInTransaction(
				claim.proposal,
				ctx,
				env,
				claim.requesterUserId,
				input,
				tx,
			);
			const softFailure = claim.handler.detectSoftFailure?.(output) ?? null;
			if (softFailure) throw new Error(softFailure);
			await tx`
				UPDATE runs SET status = 'completed', completed_at = NOW(),
				  action_output = ${tx.json(output as Record<string, unknown>)}
				WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
			`;
			const eventId = await supersedeActionEvent(
				args.run_id,
				ctx.organizationId,
				"completed",
				`${claim.handler.nounLabel}: ${desc} — completed`,
				`Builder action completed: ${desc}`,
				{ output: output as Record<string, unknown> },
				reviewer,
				tx,
			);
			requireApprovalCard(args.run_id, eventId, "completed");
			return {
				kind: "completed" as const,
				result: {
					action: "approve" as const,
					approved: true as const,
					run_id: args.run_id,
					event_id: eventId,
					message: `${claim.handler.nounLabel} ${desc} approved and applied.`,
				},
			};
		});
	} catch (error) {
		const attempt = transaction.attempt;
		if (!attempt) throw error;
		const message = error instanceof Error ? error.message : String(error);
		const eventId = await getDb().begin(async (tx) => {
			await lockOrganizationForApproval(tx, ctx.organizationId);
			const reset = await tx`
				UPDATE runs SET approval_status = 'pending', status = 'pending',
				  error_message = ${message}
				WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
				  AND approval_status = 'pending' AND status = 'pending'
				RETURNING id
			`;
			if (reset.length === 0) return null;
			const failedEventId = await supersedeActionEvent(
				args.run_id,
				ctx.organizationId,
				"apply_failed",
				`${attempt.nounLabel}: ${attempt.desc} — apply failed, still pending`,
				`Applying the approved mutation failed: ${message}`,
				{ error_message: message },
				reviewer,
				tx,
			);
			requireApprovalCard(args.run_id, failedEventId, "apply_failed");
			return failedEventId;
		});
		if (eventId === null) {
			return {
				error:
					"The approval was already decided while this request was in flight. Refresh before acting.",
			};
		}
		return {
			error: `Failed to apply ${attempt.nounLabel.toLowerCase()}: ${message}. The approval is still pending.`,
			event_id: eventId,
		};
	}
	if (!phaseOne) return null;
	if (phaseOne.kind === "completed") return phaseOne.result;

	const { handler, apply, proposal, requesterUserId, desc, claimedBy } = phaseOne;

	// Apply runs OUTSIDE any transaction — the family's write can be
	// slow/network-bound and must not hold a DB transaction open. The catch
	// scope is DELIBERATELY only apply + its soft-failure detection: a failure
	// AFTER apply (the completed run/card transaction) is a PERSISTENCE
	// failure, not a business failure, and must not be recorded as 'failed' via
	// failBuilderRun.
	let output: unknown;
	try {
		output = await apply(
			proposal,
			ctx,
			env,
			requesterUserId,
			input,
		);
		// Some handlers return `{ error }` / partial-failure summaries instead of
		// throwing — treat those as failures so the run isn't marked completed
		// when nothing applied.
		const softFailure = handler.detectSoftFailure?.(output) ?? null;
		if (softFailure) {
			return failBuilderRun(
				args.run_id,
				ctx.organizationId,
				handler,
				desc,
				softFailure,
				reviewer,
				claimedBy,
			);
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return failBuilderRun(
			args.run_id,
			ctx.organizationId,
			handler,
			desc,
			errorMessage,
			reviewer,
			claimedBy,
		);
	}

	// Phase 2a (durable): persist the successful apply result BEFORE the
	// terminalization attempt, in its own transaction. If the terminal card
	// INSERT fails, only the completed status rolls back — the output (for
	// agent_ask, the human's answer) is already durable, so a retry can complete
	// the run without re-applying or losing the answer.
	await persistDurableApplyOutput(
		args.run_id,
		ctx.organizationId,
		output as unknown as Record<string, unknown>,
		claimedBy,
	);

	// Phase 2b (atomic): the terminal completed runs write + the 'completed'
	// card supersede commit together. The card guard runs INSIDE the tx, so a
	// missing card rolls the completed write back too. A failure here (the
	// persistence failure propagated to the caller) leaves the run claimed with
	// its output durable — the stale-run reaper or a re-approve reconciles it.
	const eventId = await terminalizeApprovalRunCompleted(
		args.run_id,
		ctx.organizationId,
		output as unknown as Record<string, unknown>,
		{
			title: `${handler.nounLabel}: ${desc} — completed`,
			content: `Builder action completed: ${desc}`,
		},
		reviewer,
		claimedBy,
	);
	if (eventId === null) {
		return {
			error:
				"The approval was already decided while this request was in flight. Refresh before acting.",
		};
	}
	return {
		action: "approve",
		approved: true,
		run_id: args.run_id,
		event_id: eventId,
		message: `${handler.nounLabel} ${desc} approved and applied.`,
	};
}

/**
 * Reject a builder-gate run of ANY registered family: cancel it without
 * applying the held mutation + supersede its card to 'rejected'. Returns a
 * result when the run was a pending builder run; null to fall through.
 */
async function tryRejectBuilderRun(
	args: Static<typeof RejectAction>,
	ctx: ToolContext,
	reason: string,
	reviewer: ApprovalReviewer | null,
): Promise<ManageOperationsResult | null> {
	// Atomic: the cancelled runs write and the 'rejected' card supersede commit
	// together. If the card INSERT fails, the run stays pending — never a
	// cancelled run with the timeline stuck at 'pending'.
	return getDb().begin(async (tx) => {
		const claimed = await claimBuilderRun(
			args.run_id,
			ctx.organizationId,
			"rejected",
			reason,
			tx,
		);
		if (!claimed) return null;

		const { handler, proposal } = claimed;
		const desc = handler.describe(proposal);
		const eventId = await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"rejected",
			`${handler.nounLabel}: ${desc} — rejected`,
			`Builder action rejected: ${desc}${args.reason ? ` — ${args.reason}` : ""}`,
			{ reason },
			reviewer,
			tx,
		);
		requireApprovalCard(args.run_id, eventId, "rejected");
		return {
			action: "reject",
			rejected: true,
			run_id: args.run_id,
			event_id: eventId,
		};
	});
}

/**
 * Claim a pending entity-change run held for approval. Mirrors claimBuilderRun.
 * Returns the held proposal, or null when this run is not a pending entity
 * change.
 */
async function claimEntityChangeRun(
	runId: number,
	organizationId: string,
	decision: "approved" | "rejected",
	rejectReason?: string,
	db: DbClient = getDb(),
): Promise<{ proposal: EntityChangeProposal } | null> {
	const sql = db;
	const actionKeys = pgTextArray([...ENTITY_CHANGE_ACTION_KEYS]);
	const rows =
		decision === "approved"
			? await sql`
          UPDATE runs
          SET approval_status = 'approved', status = 'running'
          WHERE id = ${runId}
            AND organization_id = ${organizationId}
            AND approval_status = 'pending'
            AND run_type = 'internal'
            AND action_key = ANY(${actionKeys}::text[])
          RETURNING action_input
        `
      : await sql`
          UPDATE runs
          SET approval_status = 'rejected', status = 'cancelled',
              error_message = ${rejectReason ?? "Rejected by user"}, completed_at = NOW()
          WHERE id = ${runId}
            AND organization_id = ${organizationId}
            AND approval_status = 'pending'
            AND run_type = 'internal'
            AND action_key = ANY(${actionKeys}::text[])
          RETURNING action_input
        `;
	if (rows.length === 0) return null;
	const proposal = (rows[0] as { action_input: EntityChangeProposal | null })
		.action_input;
	if (!proposal) return null;
	return { proposal };
}

function entityChangeOperation(
	proposal: EntityChangeProposal,
): "create" | "update" | "delete" | "merge" {
	return proposal.operation ?? "update";
}

function resolutionFingerprintOf(
	proposal: EntityChangeProposal,
): string | null {
	if (entityChangeOperation(proposal) !== "merge") return null;
	const fingerprint = (proposal as { resolution_fingerprint?: unknown })
		.resolution_fingerprint;
	return typeof fingerprint === "string" && fingerprint.length > 0
		? fingerprint
		: null;
}

function describeEntityChange(proposal: EntityChangeProposal): string {
	const operation = entityChangeOperation(proposal);
	if (operation === "update") {
		return Object.keys(
			(proposal as Extract<EntityChangeProposal, { operation?: "update" }>)
				.fields,
		).join(", ");
	}
	if (operation === "delete") {
		const deleteProposal = proposal as Extract<
			EntityChangeProposal,
			{ operation: "delete" }
		>;
		return deleteProposal.current?.name ?? `entity ${deleteProposal.entity_id}`;
	}
	if (operation === "merge") {
		const mergeProposal = proposal as Extract<
			EntityChangeProposal,
			{ operation: "merge" }
		>;
		const duplicates = mergeProposal.current.duplicates ?? [
			mergeProposal.current.loser,
		];
		return `${duplicates.map((entity) => String(entity.name ?? `entity ${entity.id}`)).join(", ")} into ${String(mergeProposal.current.winner.name ?? `entity ${mergeProposal.winner_entity_id}`)}`;
	}
	return (proposal as Extract<EntityChangeProposal, { operation: "create" }>)
		.entity_data.name;
}

/**
 * Non-admin authority: a member may decide a run ONLY when it is a pending
 * entity-change proposal that records them as the field owner
 * (action_input.owner_user_id, resolved at propose time from field_controls).
 * Checked BEFORE any claim so an unauthorized call can never flip run state.
 */
async function isPendingEntityRunOwner(
	runId: number,
	organizationId: string,
	userId: string | null,
): Promise<boolean> {
	if (!userId) return false;
	const actionKeys = pgTextArray([...ENTITY_CHANGE_ACTION_KEYS]);
	const rows = await getDb()`
    SELECT 1 FROM runs
    WHERE id = ${runId}
      AND organization_id = ${organizationId}
      AND run_type = 'internal'
      AND action_key = ANY(${actionKeys}::text[])
      AND approval_status = 'pending'
      AND action_input->>'owner_user_id' = ${userId}
    LIMIT 1
  `;
	return rows.length > 0;
}

/**
 * Approving or rejecting a run is a HUMAN decision — it must come from a verified
 * user session, never from any non-human context. This is the security floor
 * beneath {@link requireApprovalAuthority}'s role check.
 *
 * Rejecting `ctx.clientId` alone is not enough: an in-process automation/system
 * context runs with `userId=null` and NO client id, so it would slip past a
 * client-id-only guard AND past {@link isSystemContext}'s role bypass — letting
 * an automation approve a run it queued (sol review #3). We therefore require a
 * positive human identity: `userId` present, and no agent, OAuth client, or MCP
 * transport identity on the context. Returns an error result (surfaced to the
 * caller) or null when the context is a genuine human. One gate, called by
 * every approve/reject entry.
 */
function requireHumanApprovalContext(
	ctx: ToolContext,
	verb: "approve" | "reject",
): { error: string } | null {
	if (ctx.agentId || ctx.clientId || ctx.mcpSessionId) {
		return {
			error: `Operation ${verb === "approve" ? "approval" : "rejection"} requires a human web session. Agents cannot ${verb} operations.`,
		};
	}
	if (!ctx.userId) {
		return {
			error: `Operation ${verb === "approve" ? "approval" : "rejection"} requires a signed-in user. This request has no verified human identity.`,
		};
	}
	return null;
}

/**
 * The admin-or-run-owner gate shared by approve/reject, layered ON TOP of
 * {@link requireHumanApprovalContext} (which every caller runs first, so a
 * verified human identity is already guaranteed here). The tool-access tier
 * admits write-tier members so a recorded field owner can decide their own
 * run; everyone else non-admin gets the same admin-access denial the action
 * tier used to throw. No system-context bypass — a run decision is always human.
 */
async function requireApprovalAuthority(
	action: "approve" | "reject",
	runId: number,
	ctx: ToolContext,
): Promise<void> {
	if (isAdminOrOwnerRole(ctx.memberRole)) return;
	if (await isPendingEntityRunOwner(runId, ctx.organizationId, ctx.userId)) {
		return;
	}
	throw new Error(
		`This operation (${action}) requires admin or owner access. Ask an organization owner to grant elevated access.`,
	);
}

async function tryApproveEntityChangeRun(
	args: Static<typeof ApproveAction>,
	ctx: ToolContext,
	env: Env,
): Promise<ManageOperationsResult | null> {
	const sql = getDb();
	const actionKeys = pgTextArray([...ENTITY_CHANGE_ACTION_KEYS]);
	const [pending] = await sql<{
		action_input: EntityChangeProposal | null;
		parent_run_id: number | null;
	}>`
		SELECT action_input, parent_run_id
		FROM runs
		WHERE id = ${args.run_id}
		  AND organization_id = ${ctx.organizationId}
		  AND run_type = 'internal'
		  AND action_key = ANY(${actionKeys}::text[])
		  AND approval_status = 'pending'
		  AND status = 'pending'
		LIMIT 1
	`;
	if (!pending?.action_input) return null;
	const pendingProposal = pending.action_input;
	const pendingOperation = entityChangeOperation(pendingProposal);
	const reviewer = await resolveReviewer(ctx);

	const completeApproval = async (
		db: DbClient,
		proposal: EntityChangeProposal,
		mergeResolution?: MergeApprovalResolution,
		postCommitEffects?: Array<() => Promise<void>>,
	): Promise<ManageOperationsResult> => {
		const operation = entityChangeOperation(proposal);
		const description = describeEntityChange(proposal);
		const confirmedEventId = await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"confirmed",
			operation === "update"
				? "entity_field_change — applying"
				: `entity_${operation} — applying`,
			operation === "update"
				? `Field change confirmed: ${description}`
				: `Entity ${operation} confirmed: ${description}`,
			{},
			reviewer,
			db,
		);
		requireApprovalCard(args.run_id, confirmedEventId, "confirmed");

		const result = await applyEntityChangeProposal(
			proposal,
			ctx,
			env,
			db,
			mergeResolution,
			pending.parent_run_id == null ? null : Number(pending.parent_run_id),
			postCommitEffects,
		);
		const staleFields =
			operation === "update" &&
			result &&
			typeof result === "object" &&
			"stale" in result
				? Object.keys((result as { stale: Record<string, unknown> }).stale)
				: [];
		// The human re-edited every proposed field after the automation queued this — the
		// proposal is stale. Resolve the run without clobbering the newer human value.
		const allStale =
			operation === "update" &&
			result &&
			typeof result === "object" &&
			"applied" in result &&
			Object.keys((result as { applied: Record<string, unknown> }).applied)
				.length === 0 &&
			staleFields.length > 0;
		await db`
      UPDATE runs SET status = 'completed', completed_at = NOW(),
        action_output = ${db.json(result as unknown as Record<string, unknown>)}
      WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
    `;
		const summary = allStale
			? `Field change skipped — ${staleFields.join(", ")} already changed since proposed`
			: operation === "update"
				? `Field change applied: ${description}`
				: `Entity ${operation} applied: ${description}`;
		const eventId = await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"completed",
			allStale
				? "entity_field_change — skipped (stale)"
				: operation === "update"
					? "entity_field_change — completed"
					: `entity_${operation} — completed`,
			summary,
			{ output: result as unknown as Record<string, unknown> },
			reviewer,
			db,
		);
		requireApprovalCard(args.run_id, eventId, "completed");
		return {
			action: "approve",
			approved: true,
			run_id: args.run_id,
			event_id: eventId,
			message: allStale
				? `Field change skipped: ${staleFields.join(", ")} was changed by a human after the Automation proposed it.`
				: operation === "update"
					? `Field change approved and applied: ${description}.`
					: `Entity ${operation} approved and applied: ${description}.`,
		};
	};

	// Re-present a proposal when the current resolution keys are not a strict,
	// matching-only extension of what the reviewer saw. This also gives an
	// unstamped proposal a current fingerprint, so a later approval can succeed.
	const refreshStaleFingerprint = async (
		error: unknown,
		proposal: EntityChangeProposal,
		db: DbClient,
	): Promise<ManageOperationsResult | null> => {
		if (
			!(error instanceof ResolutionFingerprintError) ||
			entityChangeOperation(proposal) !== "merge"
		) {
			return null;
		}
		const dropped = droppedEvidence(
			asMergeProposal(proposal).evidence ?? [],
			error.assessment.evidence,
		);
		// Name what stopped holding in the reviewer's terms; the internal
		// fingerprint failure does not describe their contact evidence.
		const lostSummary =
			dropped.length > 0
				? ` No longer proven: ${dropped.map((item) => `${item.kind} ${item.identifier}`).join(", ")}.`
				: "";
		const reviewerMessage =
			dropped.length > 0
				? `Evidence has been re-checked and no longer supports what you reviewed.${lostSummary} Current finding: ${error.assessment.reason} Review it and approve again to apply, or reject it.`
				: `Evidence has been re-checked against the workspace as it stands now. Current finding: ${error.assessment.reason} Review it and approve again to apply, or reject it.`;
		const reset = await db`
      UPDATE runs SET approval_status = 'pending', status = 'pending', error_message = ${reviewerMessage}
      WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
		AND approval_status = 'approved' AND status = 'running'
		RETURNING id
    `;
		if (reset.length === 0) return null;
		const refreshedProposal = await refreshMergeProposalFingerprint(
			args.run_id,
			ctx,
			asMergeProposal(proposal),
			error.assessment,
			db,
		);
		const eventId = await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"pending",
			dropped.length > 0
				? "entity_merge — evidence no longer supports the merge"
				: "entity_merge — evidence re-checked, still pending",
			reviewerMessage,
			mergeReviewEventMetadata(refreshedProposal),
			reviewer,
			db,
			refreshedProposal as unknown as Record<string, unknown>,
		);
		if (eventId === undefined) {
			throw new Error(
				"Cannot refresh merge approval because its approval event is missing",
			);
		}
		return { error: reviewerMessage };
	};

	const applyFailure = async (
		error: unknown,
	): Promise<ManageOperationsResult> => {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const denial =
			error instanceof EntityRowValidationError &&
			error.verdict.outcome === "deny"
				? error.verdict
				: null;
		// Apply failures here are often transient/situational (entity gained
		// children before a non-force delete, schema changed, etc.). Put the run
		// BACK to pending instead of burning the proposal on one errant click —
		// the reviewer can retry after fixing the blocker, or reject it. The
		// reset and the 'apply_failed' card share one transaction so a card
		// failure cannot leave a pending run with no card.
		const reset = await sql.begin(async (tx) => {
			await lockOrganizationForApproval(tx, ctx.organizationId);
			const resetRows = await tx`
				UPDATE runs SET approval_status = 'pending', status = 'pending', error_message = ${errorMessage}
				WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
				AND (
				  (approval_status = 'approved' AND status = 'running')
				  OR (approval_status = 'pending' AND status = 'pending')
				)
				RETURNING id
			`;
			if (resetRows.length > 0) {
				if (denial) {
					const attemptId =
						`approval:run:${args.run_id}:${denial.operation}:` +
						`${denial.entityId ?? "new"}`;
					await recordEntityWriteDenial({
						organizationId: ctx.organizationId,
						attemptId,
						denialSource: "rule",
						operation: denial.operation,
						reason: denial.reason,
						deniedFields: denial.fields,
						entityId: denial.entityId,
						entityType: denial.entityType,
						entityOrganizationId: denial.entityOrganizationId,
						actor: { kind: "user", id: ctx.userId },
						automationId: pendingProposal.automation_id ?? null,
						runId: args.run_id,
						createdBy: ctx.userId,
						clientId: null,
						sql: tx,
					});
				}
				const eventId = await supersedeActionEvent(
					args.run_id,
					ctx.organizationId,
					"apply_failed",
					pendingOperation === "update"
						? "entity_field_change — apply failed, still pending"
						: `entity_${pendingOperation} — apply failed, still pending`,
					`Applying the approved change failed: ${errorMessage}. The approval is pending again — fix the blocker and approve once more, or reject it.`,
					{ error_message: errorMessage },
					reviewer,
					tx,
				);
				requireApprovalCard(args.run_id, eventId, "apply_failed");
			}
			return resetRows.length;
		});
		if (reset === 0) {
			return {
				error: `Failed to apply entity ${pendingOperation}: ${errorMessage}. The approval changed concurrently; refresh before retrying.`,
			};
		}
		return {
			error: `Failed to apply entity ${pendingOperation}: ${errorMessage}. The approval is back to pending — approve again after fixing the blocker, or reject it.`,
		};
	};

	const cancelPreviouslyRejectedMerge = async (
		db: DbClient,
	): Promise<ManageOperationsResult | null> => {
		const cancelled = await db`
			UPDATE runs
			SET approval_status = 'rejected', status = 'cancelled',
			    error_message = 'The same resolution candidate was already rejected',
			    completed_at = NOW()
			WHERE id = ${args.run_id}
			  AND organization_id = ${ctx.organizationId}
			  AND approval_status = 'approved'
			  AND status = 'running'
			RETURNING id
		`;
		if (cancelled.length === 0) return null;
		const eventId = await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"rejected",
			"entity_merge — rejected",
			"This unchanged duplicate candidate was already rejected in another Automation run.",
			{
				reject_reason: "The same resolution candidate was already rejected",
			},
			null,
			db,
		);
		requireApprovalCard(args.run_id, eventId, "rejected");
		return {
			error:
				"This duplicate candidate was already rejected. Refresh the Automation run.",
		};
	};

	if (pendingOperation === "merge") {
		try {
			return await sql.begin(async (tx) => {
				// The merge below bumps the org ACL generation, so claim the org
				// row before the approval-run and candidate entity rows —
				// organization deletion locks the parent and cascades downward, and
				// the reverse order deadlocks against it.
				await lockOrgForAclInvalidation(tx, ctx.organizationId);
				const claimed = await claimEntityChangeRun(
					args.run_id,
					ctx.organizationId,
					"approved",
					undefined,
					tx,
				);
				if (!claimed) return null;
				try {
					const mergeProposal = asMergeProposal(claimed.proposal);
					await lockResolutionCandidate(tx, {
						organizationId: ctx.organizationId,
						winnerId: mergeProposal.winner_entity_id,
						loserIds:
							mergeProposal.entity_ids ?? [mergeProposal.entity_id],
					});
					const reviewedFingerprint = resolutionFingerprintOf(
						claimed.proposal,
					);
					if (
						reviewedFingerprint &&
						(await wasResolutionRejected(tx, {
							organizationId: ctx.organizationId,
							fingerprint: reviewedFingerprint,
						}))
					) {
						return cancelPreviouslyRejectedMerge(tx);
					}
					const resolution = await resolveMergeApproval(
						mergeProposal,
						ctx.organizationId,
						tx,
					);
					if (
						resolution.fingerprint &&
						resolution.fingerprint !== reviewedFingerprint &&
						(await wasResolutionRejected(tx, {
							organizationId: ctx.organizationId,
							fingerprint: resolution.fingerprint,
						}))
					) {
						return cancelPreviouslyRejectedMerge(tx);
					}
					return await completeApproval(tx, claimed.proposal, resolution);
				} catch (error) {
					const refreshed = await refreshStaleFingerprint(
						error,
						claimed.proposal,
						tx,
					);
					if (refreshed) return refreshed;
					throw error;
				}
			});
		} catch (error) {
			return applyFailure(error);
		}
	}

	try {
		// The non-merge family runs claim + confirm + apply + terminal write +
		// completed card in ONE transaction, exactly like the merge family
		// above. Lifecycle hooks join that transaction; network effects are
		// collected and run only after it commits. The claim inside the tx is
		// authoritative — returning null falls through to the connector path,
		// and a rollback leaves the run exactly as it was.
		const postCommitEffects: Array<() => Promise<void>> = [];
		const result = await sql.begin(async (tx) => {
			await lockOrganizationForApproval(tx, ctx.organizationId);
			const claimedInTx = await claimEntityChangeRun(
				args.run_id,
				ctx.organizationId,
				"approved",
				undefined,
				tx,
			);
			if (!claimedInTx) return null;
			return await completeApproval(
				tx,
				claimedInTx.proposal,
				undefined,
				postCommitEffects,
			);
		});
		for (const effect of postCommitEffects) {
			try {
				await effect();
			} catch (error) {
				logger.error(
					{ error, runId: args.run_id },
					"Post-commit entity approval effect failed",
				);
			}
		}
		return result;
	} catch (error) {
		return applyFailure(error);
	}
}

/**
 * Reject a pending entity_field_change run. Returns a result when the run was a
 * pending field-change run; null to fall through.
 */
async function tryRejectEntityChangeRun(
	args: Static<typeof RejectAction>,
	ctx: ToolContext,
): Promise<ManageOperationsResult | null> {
	const sql = getDb();
	const actionKeys = pgTextArray([...ENTITY_CHANGE_ACTION_KEYS]);
	const [pending] = await sql<{ action_input: EntityChangeProposal | null }>`
		SELECT action_input
		FROM runs
		WHERE id = ${args.run_id}
		  AND organization_id = ${ctx.organizationId}
		  AND run_type = 'internal'
		  AND action_key = ANY(${actionKeys}::text[])
		  AND approval_status = 'pending'
		  AND status = 'pending'
		LIMIT 1
	`;
	if (!pending?.action_input) return null;
	const reason = args.reason ?? "Rejected by user";
	const reviewer = await resolveReviewer(ctx);
	const pendingIsMerge = entityChangeOperation(pending.action_input) === "merge";
	const reject = async (
		db: DbClient,
	): Promise<ManageOperationsResult | null> => {
		const claimed = await claimEntityChangeRun(
			args.run_id,
			ctx.organizationId,
			"rejected",
			reason,
			db,
		);
		if (!claimed) return null;
		if (pendingIsMerge) {
			const mergeProposal = asMergeProposal(claimed.proposal);
			await lockResolutionCandidate(db, {
				organizationId: ctx.organizationId,
				winnerId: mergeProposal.winner_entity_id,
				loserIds: mergeProposal.entity_ids ?? [mergeProposal.entity_id],
			});
		}
		const operation = entityChangeOperation(claimed.proposal);
		const description = describeEntityChange(claimed.proposal);
		const eventId = await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"rejected",
			operation === "update"
				? "entity_field_change — rejected"
				: `entity_${operation} — rejected`,
			operation === "update"
				? `Field change rejected: ${description}${args.reason ? ` — ${args.reason}` : ""}`
				: `Entity ${operation} rejected: ${description}${args.reason ? ` — ${args.reason}` : ""}`,
			// reject_reason, NOT reason: metadata.reason is the PROPOSER's rationale
			// and must survive the supersede for the card's "Reasoning" panel.
			{ reject_reason: reason },
			reviewer,
			db,
		);
		requireApprovalCard(args.run_id, eventId, "rejected");
		return {
			action: "reject",
			rejected: true,
			run_id: args.run_id,
			event_id: eventId,
		};
	};

	// Both families reject atomically: the cancelled runs write and the
	// 'rejected' card supersede commit together (claimEntityChangeRun and
	// supersedeActionEvent both run on the same tx handle).
	return sql.begin(reject);
}

export async function handleApprove(
	args: Static<typeof ApproveAction>,
	ctx: ToolContext,
	env: Env,
): Promise<ManageOperationsResult> {
	const humanGate = requireHumanApprovalContext(ctx, "approve");
	if (humanGate) return humanGate;
	await requireApprovalAuthority("approve", args.run_id, ctx);

	const sql = getDb();

	// A run whose apply already succeeded durably but whose terminal card write
	// failed is stuck in the claimed state (approved/running + action_output).
	// Re-approving reconciles it — completes the run from the durable output
	// WITHOUT re-running the external mutation — instead of reporting "not
	// pending approval" (which would strand the run until a reaper misfires).
	const reviewer = await resolveReviewer(ctx);
	const reconciled = await tryReconcileTerminalization(args, ctx, reviewer);
	if (reconciled) return reconciled;

	// Builder-gate runs (manage_agents / manage_automations create/update/delete)
	// reuse this same durable approval path but have run_type='internal' + no
	// connection. One generic path applies them via their registered handler
	// rather than the connector-operation executor.
	const builderResult = await tryApproveBuilderRun(args, ctx, env);
	if (builderResult) return builderResult;

	// Automation field-change gate (run_type='internal', action_key='entity_field_change'):
	// approve applies the proposed value to the entity (now human-owned).
	const fieldChangeResult = await tryApproveEntityChangeRun(args, ctx, env);
	if (fieldChangeResult) return fieldChangeResult;

	const pendingRows = await sql`
    SELECT id, connection_id, action_key, action_input,
           policy_principal_kind, policy_principal_id
    FROM runs
    WHERE id = ${args.run_id}
      AND organization_id = ${ctx.organizationId}
      AND approval_status = 'pending'
      AND run_type = 'action'
    LIMIT 1
  `;
	if (pendingRows.length === 0) {
		return { error: "Run not found or not pending approval" };
	}

	const pendingRun = pendingRows[0] as {
		id: number;
		connection_id: number;
		action_key: string;
		action_input: Record<string, unknown> | null;
		policy_principal_kind: string | null;
		policy_principal_id: string | null;
	};
	const resolved = await getOperationForConnection(
		ctx.organizationId,
		pendingRun.connection_id,
		pendingRun.action_key,
	);
	if (!resolved) {
		return {
			error: `Operation '${pendingRun.action_key}' is no longer available for this connection.`,
		};
	}

	// (sol #5) Re-evaluate the connector-action write-gate NOW, at approve time,
	// against the CURRENT connection mode + org policy — using the trusted
	// principal persisted when the run was queued (not the approver). A deny or
	// disabled installed after queueing but before this approval must cancel it,
	// not sail through on the stale queue-time check.
	const currentMode = resolveActionMode(
		resolved.operation,
		resolved.connection.config,
	);
	const recheckPrincipalKind =
		pendingRun.policy_principal_kind === "agent" ||
		pendingRun.policy_principal_kind === "automation"
			? pendingRun.policy_principal_kind
			: "user";
	// An automation-attributed run must fold its OWNING AGENT'S envelope at recheck too,
	// exactly as at queue time — else an agent-level deny installed before approval
	// would be missed. Re-resolve the owner from the persisted `automation:<id>` id
	// (no need to persist it separately).
	const recheckAutomationId = automationIdFromPrincipalId(
		pendingRun.policy_principal_id,
	);
	// Re-resolve the principal's resolvability from persistence. A AUTOMATION principal
	// re-resolves its owning agent via `automation:<id>`. A direct AGENT principal must be
	// existence-checked too: if the agent was DELETED between queue and approve, the
	// r16 cascade removed its deny/approval rows, so folding candidates for a gone
	// agent would fall back to the looser org default (connector_action → auto) and let
	// a human's Approve execute the run as a deleted agent — strictly looser than
	// before the delete. Either GONE → resolved:false → resolveWriteEffect denies,
	// cancelling the approval. (Same fail-closed invariant resolveActingPrincipal
	// enforces for live sessions; this is the persisted-principal path.)
	let recheckOwner: { ownerAgentId: string | null; resolved: boolean };
	if (recheckAutomationId != null) {
		recheckOwner = await resolveAutomationOwner(
			sql,
			recheckAutomationId,
			ctx.organizationId,
		);
	} else if (
		recheckPrincipalKind === "agent" &&
		pendingRun.policy_principal_id != null
	) {
		recheckOwner = {
			ownerAgentId: null,
			resolved: await agentExistsInOrg(
				sql,
				pendingRun.policy_principal_id,
				ctx.organizationId,
			),
		};
	} else {
		recheckOwner = { ownerAgentId: null, resolved: true };
	}
	const recheckDecision =
		recheckPrincipalKind === "user"
			? "allow"
			: await resolveWritePolicyDecision({
					organizationId: ctx.organizationId,
					resourceClass: "connector_action",
					principalKind: recheckPrincipalKind,
					principalId: pendingRun.policy_principal_id,
					ownerAgentId: recheckOwner.ownerAgentId,
					ownerResolved: recheckOwner.resolved,
					action: "execute",
					// Recheck against the SAME operation the run was queued under, using the
					// connector-qualified key (connector_key from the resolved connection +
					// the persisted action_key), so a per-op rule installed after queueing
					// still binds — mirrors the queue-time gate above.
					operationKey: qualifiedOperationKey(
						resolved.connection.connector_key,
						pendingRun.action_key,
					),
				});
	if (currentMode === "disabled" || recheckDecision === "deny") {
		const why =
			currentMode === "disabled"
				? `Operation '${pendingRun.action_key}' is now disabled on this connection.`
				: `Policy now denies '${pendingRun.action_key}' for the requesting principal.`;
		const reviewer = await resolveReviewer(ctx);
		// The claim re-asserts `approval_status = 'pending'`, so a run approved
		// concurrently (or otherwise no longer pending) matches ZERO rows. In
		// that case the decision did not happen and the card must NOT be
		// superseded — return an explicit changed-concurrently outcome instead
		// of writing a 'rejected' card over a live approval.
		const cancelled = await sql.begin(async (tx) => {
			const rows = await tx`
				UPDATE runs
				SET approval_status = 'rejected', status = 'cancelled',
					error_message = ${why}, completed_at = NOW()
				WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
					AND approval_status = 'pending'
				RETURNING id
			`;
			if (rows.length === 0) return false;
			const eventId = await supersedeActionEvent(
				args.run_id,
				ctx.organizationId,
				"rejected",
				`${pendingRun.action_key} — blocked by policy`,
				why,
				{ reason: why },
				reviewer,
				tx,
			);
			requireApprovalCard(args.run_id, eventId, "rejected");
			return true;
		});
		if (!cancelled) {
			return {
				error:
					"The approval was already decided while this request was in flight. Refresh before acting.",
			};
		}
		return { error: `${why} The approval was cancelled.` };
	}

	const approvedInput = args.input ?? pendingRun.action_input ?? {};
	const validationError = validateOperationInput(
		resolved.operation,
		approvedInput,
	);
	if (validationError) {
		return {
			error: `Invalid input for operation '${resolved.operation.operation_key}': ${validationError}`,
		};
	}

	// Phase 1 (atomic): claim the run (approval_status → approved) AND write the
	// 'confirmed' card in ONE transaction. If the card INSERT fails (or the card
	// is missing), the claim rolls back and the run stays pending — never an
	// approved run whose card the UI can't show.
	//
	// `local_action` runs are executed by a worker poll that claims
	// `status='pending'` rows, so they keep status 'pending'. Every other
	// backend executes inline below, so its status flips to 'running' IN the
	// same transaction as the claim + confirmed card — there is no separate
	// post-claim status write to race with the card.
	const setRunning = resolved.operation.backend !== "local_action";
	// Minted unconditionally so the fence value is never nullable. Only a run
	// that actually flips to `running` records it as its owner; a `local_action`
	// run stays unclaimed and returns before any fenced write.
	const inlineOwner = `gateway-inline-${randomUUID()}`;
	const claimed = await sql.begin(async (tx) => {
		// The lease is taken in the same statement that flips the run to
		// `running`: an approved, running, unowned row is exactly the window the
		// stale-run reaper and a second approve would both grab.
		const runningSet = setRunning
			? tx`, status = 'running', claimed_by = ${inlineOwner}, claimed_at = current_timestamp, last_heartbeat_at = current_timestamp`
			: tx``;
		const rows = await tx`
			UPDATE runs
			SET approval_status = 'approved'
				${runningSet},
				action_input = ${args.input ? tx.json(args.input) : tx`action_input`}
			WHERE id = ${args.run_id}
				AND organization_id = ${ctx.organizationId}
				AND approval_status = 'pending'
				AND run_type = 'action'
			RETURNING id, connection_id, action_key, action_input, created_by_user_id, claimed_by, run_metadata
		`;
		if (rows.length === 0) return null;
		// The confirmed card's event id is the run's approval identity for this
		// decision; both terminal branches report it, exactly as before.
		const confirmedEventId = await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"confirmed",
			`${(rows[0] as { action_key: string }).action_key} — executing`,
			`Operation confirmed: ${(rows[0] as { action_key: string }).action_key} — waiting for execution`,
			args.input ? { approved_input: args.input } : {},
			reviewer,
			tx,
		);
		requireApprovalCard(args.run_id, confirmedEventId, "confirmed");
		return { runRows: rows, eventId: confirmedEventId };
	});
	if (!claimed) return { error: "Run not found or not pending approval" };
	const { runRows, eventId } = claimed;
	const run = runRows[0] as {
		id: number;
		connection_id: number;
		action_key: string;
		action_input: Record<string, unknown> | null;
		created_by_user_id: string | null;
		run_metadata: Record<string, unknown> | null;
	};

	if (resolved.operation.backend === "local_action") {
		// Status stays 'pending' so the worker poll claims this run.
		return {
			action: "approve",
			approved: true,
			run_id: args.run_id,
			event_id: eventId,
			message: "Operation approved. The worker will execute it shortly.",
		};
	}

	// Execution runs OUTSIDE any transaction — it is network/connector work that
	// must not hold a DB transaction open. The executor defers its terminal runs
	// write so phase 2 below can pair it with the terminal card atomically.
	const result = await executeOperationInline(
		args.run_id,
		ctx.organizationId,
		resolved.connection,
		resolved.operation,
		(run.action_input ?? {}) as Record<string, unknown>,
		run.created_by_user_id,
		undefined,
		{ deferTerminalWrite: true, claimedBy: inlineOwner, runMetadata: run.run_metadata },
	);

	if (result.status === "completed") {
		// Phase 2a (durable): persist the execution output BEFORE the
		// terminalization attempt so a failed completed-card write cannot lose
		// the only durable record of an already-successful external mutation.
		await persistDurableApplyOutput(args.run_id, ctx.organizationId, result.output, inlineOwner);

		// Phase 2b (atomic): terminal completed runs write + 'completed' card.
		// The card guard runs INSIDE the tx so a missing card rolls the
		// completed runs write back.
		const terminalCardId = await terminalizeApprovalRunCompleted(
			args.run_id,
			ctx.organizationId,
			result.output,
			{
				title: `${run.action_key} — completed`,
				content: `Operation completed: ${run.action_key}`,
			},
			reviewer,
			inlineOwner,
		);
		if (terminalCardId === null) {
			return {
				error:
					"The approval was already decided while this request was in flight. Refresh before acting.",
			};
		}
		return {
			action: "approve",
			approved: true,
			run_id: args.run_id,
			event_id: eventId,
			message: "Operation approved and executed.",
		};
	}

	// Phase 2 (atomic): terminal failed runs write + 'failed' card. The card
	// guard runs INSIDE the tx so a missing card rolls the failed runs write
	// back.
	//
	// Fenced on the same lease as the completed lane above: with
	// deferTerminalWrite the inline execution wrote nothing, so this is the ONLY
	// terminal write for a failed inline apply. Unfenced it would overwrite a
	// reaper's or a re-claim's outcome and supersede the card to 'failed'.
	const failed = await sql.begin(async (tx) => {
		const rows = await tx`
			UPDATE runs SET status = 'failed', completed_at = NOW(),
				action_output = ${result.output ? tx.json(result.output) : null},
				error_message = ${result.error_message}
			WHERE id = ${args.run_id} AND organization_id = ${ctx.organizationId}
			${runLeaseFence(tx, inlineOwner)}
			RETURNING id
		`;
		if (rows.length === 0) return false;
		const cardId = await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"failed",
			`${run.action_key} — failed`,
			`Operation failed: ${run.action_key}${result.error_message ? ` — ${result.error_message}` : ""}`,
			{ error_message: result.error_message },
			reviewer,
			tx,
		);
		requireApprovalCard(args.run_id, cardId, "failed");
		return true;
	});
	if (!failed) {
		return {
			error:
				"The approval was already decided while this request was in flight. Refresh before acting.",
		};
	}
	return {
		action: "approve",
		approved: true,
		run_id: args.run_id,
		event_id: eventId,
		message: `Operation approved but execution failed: ${result.error_message}`,
	};
}

export async function handleReject(
	args: Static<typeof RejectAction>,
	ctx: ToolContext,
): Promise<ManageOperationsResult> {
	const humanGate = requireHumanApprovalContext(ctx, "reject");
	if (humanGate) return humanGate;
	await requireApprovalAuthority("reject", args.run_id, ctx);

	const sql = getDb();
	const reason = args.reason ?? "Rejected by user";
	const reviewer = await resolveReviewer(ctx);

	// Builder-gate run? Cancel it without applying the held mutation.
	const builderReject = await tryRejectBuilderRun(args, ctx, reason, reviewer);
	if (builderReject) return builderReject;

	// Automation field-change gate? Cancel it; the entity keeps its human-owned value.
	const fieldChangeReject = await tryRejectEntityChangeRun(args, ctx);
	if (fieldChangeReject) return fieldChangeReject;

	// Atomic: the cancelled runs write and the 'rejected' card commit together.
	const outcome = await sql.begin(async (tx) => {
		const updated = await tx`
			UPDATE runs
			SET approval_status = 'rejected', status = 'cancelled', error_message = ${reason}, completed_at = NOW()
			WHERE id = ${args.run_id}
				AND organization_id = ${ctx.organizationId}
				AND approval_status = 'pending'
				AND run_type = 'action'
			RETURNING id, action_key
		`;
		if (updated.length === 0) return null;

		const operationKey = (updated[0] as { action_key: string }).action_key;
		const eventId = await supersedeActionEvent(
			args.run_id,
			ctx.organizationId,
			"rejected",
			`${operationKey} — rejected`,
			`Operation rejected: ${operationKey}${args.reason ? ` — ${args.reason}` : ""}`,
			{ reason },
			reviewer,
			tx,
		);
		requireApprovalCard(args.run_id, eventId, "rejected");
		return eventId;
	});
	if (outcome === null) {
		return { error: "Run not found or not pending approval" };
	}

	return {
		action: "reject",
		rejected: true,
		run_id: args.run_id,
		event_id: outcome,
	};
}

/** Pending proposal runs produced by one Automation run. */
async function pendingChildRunIds(
	parentRunId: number,
	organizationId: string,
): Promise<number[]> {
	const sql = getDb();
	const rows = await sql<{ id: number }>`
    SELECT id FROM runs
    WHERE parent_run_id = ${parentRunId}
      AND organization_id = ${organizationId}
      AND approval_status = 'pending'
      AND run_type = 'internal'
    ORDER BY id ASC
  `;
	return rows.map((r) => Number(r.id));
}

/**
 * Pending connector-operation approvals (`run_type='action'`) matching an
 * explicit scope. This is the lane that accumulates — a queued operation nobody
 * decided sits pending until the long-horizon expiry sweep takes it terminal
 * (scheduled/expire-pending-approvals.ts).
 *
 * At least one narrowing filter is REQUIRED. Batch approve fires queued side
 * effects en masse, so there is deliberately no "everything pending in the org"
 * shape: the caller must name the connection, connector, operation, or Automation
 * they are deciding for. `older_than_days` only narrows further.
 */
async function pendingActionRunIdsForScope(
	scope: NonNullable<Static<typeof ApproveBatchAction>["scope"]>,
	organizationId: string,
): Promise<number[] | { error: string }> {
	const hasNarrowingFilter =
		scope.connection_id !== undefined ||
		scope.connector_key !== undefined ||
		scope.action_key !== undefined ||
		scope.automation_id !== undefined;
	if (!hasNarrowingFilter) {
		return {
			error:
				"A batch decision must be scoped: provide at least one of connection_id, connector_key, action_key, or automation_id. Approving every pending operation in the organization is not supported.",
		};
	}

	const sql = getDb();
	let where = sql`r.organization_id = ${organizationId}
    AND r.approval_status = 'pending'
    AND r.run_type = 'action'`;
	if (scope.connection_id !== undefined) {
		where = sql`${where} AND r.connection_id = ${scope.connection_id}`;
	}
	if (scope.connector_key !== undefined) {
		where = sql`${where} AND r.connector_key = ${scope.connector_key}`;
	}
	if (scope.action_key !== undefined) {
		where = sql`${where} AND r.action_key = ${scope.action_key}`;
	}
	if (scope.automation_id !== undefined) {
		where = sql`${where}
      AND r.policy_principal_kind = 'automation'
      AND r.policy_principal_id = ${`automation:${scope.automation_id}`}`;
	}
	if (scope.older_than_days !== undefined) {
		where = sql`${where} AND r.created_at < NOW() - (${scope.older_than_days}::int * interval '1 day')`;
	}

	const rows = await sql<{ id: number }>`
    SELECT r.id FROM runs r WHERE ${where} ORDER BY r.id ASC
  `;
	return rows.map((r) => Number(r.id));
}

/**
 * Resolve the pending set a batch action targets, from whichever scope the
 * caller supplied. Exactly one of `run_id` / `scope` is required — accepting
 * neither would mean an unscoped sweep, and accepting both would leave it
 * ambiguous which one bounded the blast radius.
 */
async function resolveBatchRunIds(
	args: {
		run_id?: number;
		scope?: Static<typeof ApproveBatchAction>["scope"];
	},
	organizationId: string,
): Promise<number[] | { error: string }> {
	if (args.run_id !== undefined && args.scope !== undefined) {
		return {
			error:
				"Provide either run_id or scope, not both — the batch must have exactly one bounded target.",
		};
	}
	if (args.run_id !== undefined) {
		return pendingChildRunIds(args.run_id, organizationId);
	}
	if (args.scope !== undefined) {
		return pendingActionRunIdsForScope(args.scope, organizationId);
	}
	return {
		error:
			"A batch decision requires a target: pass run_id (an Automation run's proposals) or scope (queued connector operations).",
	};
}

/** Fail-closed message when the pending set moved under the reviewer. Named per
 *  scope so a run batch still says "proposals" (what the reviewer saw) while
 *  a scoped connector batch says "approvals". */
function batchSetChangedError(isRunScope: boolean, verb: string): string {
	const noun = isRunScope ? "Pending proposals" : "Pending approvals";
	return `${noun} changed after this batch was loaded. Refresh before ${verb} the batch.`;
}

function batchRunSetChanged(
	pendingRunIds: number[],
	reviewedRunIds: number[] | undefined,
): boolean {
	if (!reviewedRunIds) return false;
	const reviewed = [...new Set(reviewedRunIds)].sort((a, b) => a - b);
	return (
		pendingRunIds.length !== reviewed.length ||
		pendingRunIds.some((runId, index) => runId !== reviewed[index])
	);
}

/**
 * Check the entire batch before deciding its first row. A member may own one
 * entity-change proposal in a run but not its siblings; checking only inside
 * each single-run handler would mutate the owned prefix before a later authority
 * failure aborted the request.
 */
async function requireBatchApprovalAuthority(
	action: "approve" | "reject",
	runIds: number[],
	ctx: ToolContext,
): Promise<void> {
	for (const runId of runIds) {
		await requireApprovalAuthority(action, runId, ctx);
	}
}

/**
 * Approve every pending approval in one bounded target, in one action. Reuses
 * the single-run approve path per row so each still applies through its own
 * gate/apply handler. Authority is preflighted across the full set before the
 * first mutation, then enforced again by each single-run path, so whoever may
 * approve every row individually is exactly who may bulk-approve them.
 *
 * The target is either an Automation run or an explicit
 * scope over queued connector operations. There is no unscoped variant: batch
 * approve fires real side effects en masse, so the blast radius must always be
 * named by the caller.
 */
export async function handleApproveBatch(
	args: Static<typeof ApproveBatchAction>,
	ctx: ToolContext,
	env: Env,
): Promise<ManageOperationsResult> {
	const humanGate = requireHumanApprovalContext(ctx, "approve");
	if (humanGate) return humanGate;
	const resolved = await resolveBatchRunIds(args, ctx.organizationId);
	if (!Array.isArray(resolved)) return resolved;
	const runIds = resolved;
	if (batchRunSetChanged(runIds, args.run_ids)) {
		return {
			error: batchSetChangedError(args.run_id !== undefined, "approving"),
		};
	}
	await requireBatchApprovalAuthority("approve", runIds, ctx);
	if (runIds.length === 0) {
		return {
			action: "approve_batch",
			...(args.run_id !== undefined ? { run_id: args.run_id } : {}),
			approved_count: 0,
			failed_count: 0,
			run_ids: [],
			message:
				args.run_id !== undefined
					? "No pending proposals for this run."
					: "No pending approvals matched this scope.",
		};
	}
	let approved = 0;
	let failed = 0;
	for (const runId of runIds) {
		const result = await handleApprove(
			{ action: "approve", run_id: runId },
			ctx,
			env,
		);
		if ("error" in result) failed += 1;
		else approved += 1;
	}
	return {
		action: "approve_batch",
		...(args.run_id !== undefined ? { run_id: args.run_id } : {}),
		approved_count: approved,
		failed_count: failed,
		run_ids: runIds,
		message: `Approved ${approved} of ${runIds.length} ${args.run_id !== undefined ? "proposals" : "approvals"}${failed > 0 ? ` (${failed} failed)` : ""}.`,
	};
}

/**
 * The automation + touched entities behind a run's proposals. Resolved from
 * the run and its change_set event (which carries
 * automation_id and the entity_ids the run touched), so the rejection feedback can
 * be keyed to the automation and associated with those entities.
 */
async function resolveRunRevisionContext(
	runId: number,
	organizationId: string,
): Promise<{ automationId: number | null; entityIds: number[] }> {
	const sql = getDb();
	const rows = await sql<{ automation_id: string | null; entity_ids: unknown }>`
    SELECT r.automation_id, change.entity_ids
    FROM runs r
    LEFT JOIN LATERAL (
      SELECT entity_ids FROM events
      WHERE run_id = r.id AND semantic_type = 'change_set'
      ORDER BY id DESC LIMIT 1
    ) change ON true
    WHERE r.id = ${runId}
      AND r.organization_id = ${organizationId}
      AND r.run_type = 'automation'
  `;
	if (rows.length === 0) return { automationId: null, entityIds: [] };
	return {
		automationId: rows[0].automation_id != null ? Number(rows[0].automation_id) : null,
		// entity_ids arrives as a raw PG array string under fetch_types:false — never
		// call .map on it directly. parsePgNumberArray handles both string and array.
		entityIds: parsePgNumberArray(rows[0].entity_ids),
	};
}

/**
 * Reject every pending proposal an automation run produced, feeding the reason back
 * so the automation's next run revises (the conversational revision loop — no inline
 * diff editor). Reuses the single-run reject path per proposal, then records the
 * reason as a `correction` feedback event keyed to the automation — the SAME channel
 * getRecentFeedbackSummary injects into future automation runs. That closes the loop
 * for real: the run view shows why the batch was rejected AND the automation's next
 * turn reads "Past Corrections from User Feedback" and adjusts, rather than the
 * feedback sitting inert (sol review #10).
 */
export async function handleRejectBatch(
	args: Static<typeof RejectBatchAction>,
	ctx: ToolContext,
): Promise<ManageOperationsResult> {
	const humanGate = requireHumanApprovalContext(ctx, "reject");
	if (humanGate) return humanGate;
	const resolved = await resolveBatchRunIds(args, ctx.organizationId);
	if (!Array.isArray(resolved)) return resolved;
	const runIds = resolved;
	if (batchRunSetChanged(runIds, args.run_ids)) {
		return {
			error: batchSetChangedError(args.run_id !== undefined, "rejecting"),
		};
	}
	await requireBatchApprovalAuthority("reject", runIds, ctx);
	const reason = args.reason ?? "Rejected by user";
	let rejected = 0;
	for (const runId of runIds) {
		const result = await handleReject(
			{ action: "reject", run_id: runId, reason },
			ctx,
		);
		if (!("error" in result)) rejected += 1;
	}
	// The `correction` feedback event is keyed to the
	// automation that produced the proposals so its next turn reads the rejection
	// and revises. A scope-targeted batch over queued connector operations has no
	// such producing run, so it records no correction; each rejected row still
	// supersedes its own card through the single-run reject path.
	if (rejected > 0 && args.run_id !== undefined) {
		const { automationId, entityIds } = await resolveRunRevisionContext(
			args.run_id,
			ctx.organizationId,
		);
		// A `correction` event — the durable, run-linked revision channel. Keyed to
		// the automation (getRecentFeedbackSummary reads by automation_id) and associated
		// with the entities the run touched, so both the automation's next turn and the
		// entity/run views surface it. field_path='$batch_reject' marks it a
		// whole-run rejection (distinct from a single-field correction); the reason
		// rides `note`, which the summary renders verbatim.
		await insertEvent({
			entityIds,
			organizationId: ctx.organizationId,
			originId: `run_${args.run_id}_batch_reject`,
			title: `Batch rejected — ${rejected} proposals`,
			content: `The user rejected this run's proposals: ${reason}`,
			semanticType: "correction",
			runId: args.run_id,
			createdBy: ctx.userId ?? null,
			metadata: {
				kind: "automation_batch_reject",
				automation_id: automationId,
				field_path: "$batch_reject",
				mutation: "set",
				note: reason,
				rejected_count: rejected,
				reason,
			},
		});
	}
	return {
		action: "reject_batch",
		...(args.run_id !== undefined ? { run_id: args.run_id } : {}),
		rejected_count: rejected,
		run_ids: runIds,
		message:
			rejected === 0
				? args.run_id !== undefined
					? "No pending proposals for this run."
					: "No pending approvals matched this scope."
				: args.run_id !== undefined
				? `Rejected ${rejected} proposals. The Automation's next run will see this feedback and revise.`
					: `Rejected ${rejected} queued operations.`,
	};
}
