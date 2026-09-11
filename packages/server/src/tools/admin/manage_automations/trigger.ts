/**
 * Trigger and reaction script action handlers for manage_automations:
 *   trigger, set_reaction_script
 */

import { getDb, type DbClient } from "../../../db/client";
import type { Env } from "../../../index";
import { isLobuGatewayRunning } from "../../../lobu/gateway";
import { ToolUserError } from "../../../utils/errors";
import logger from "../../../utils/logger";
import {
  dispatchPendingAutomationRuns,
  enqueueAutomationRunForAutomationInTransaction,
  getAutomationRunInfo,
  parseAutomationRunPayload,
} from "../../../automations/automation";
import {
  compileReactionScript,
  extractReactionInputSchema,
  validateReactionDefaultExport,
} from "../../../automations/reaction-executor";
import { assertAutomationInstructions } from "../../../automations/triggers";
import type {
  AutomationTrigger,
  AutomationTriggerExecution,
  AutomationTriggerResult,
} from "@lobu/core/contracts/tools/manage-automations";
import type { ToolContext } from "../../registry";
import { recordToolConfigChange } from "../helpers/config-audit";
import { requireExists } from "../helpers/db-helpers";
import type { ManageAutomationsArgs } from "../manage_automations";
import {
  encodeExternalAutomationClaimOwner,
  expireExternalClaims,
  isExternalAutomationClaimOwner,
} from "./claim-next-window";
import { resolveAutomationExecutor } from "./executors";

async function loadTriggerExecution(
  sql: DbClient,
  runId: number,
  automationId: number,
  automationIdString: string,
  ctx: ToolContext,
): Promise<{
  execution: AutomationTriggerExecution;
  shouldDispatch: boolean;
}> {
  const [run] = await sql<{
    approved_input: unknown;
    status: string;
    claimed_by: string | null;
    expires_at: string | Date | null;
    device_claimed_by: string | null;
  }>`
    SELECT r.approved_input, r.status, r.claimed_by, r.expires_at,
           (
             SELECT dw.worker_id
             FROM device_workers dw
             WHERE dw.id::text = r.approved_input->>'device_worker_id'
             LIMIT 1
           ) AS device_claimed_by
    FROM runs r
    WHERE r.id = ${runId}
      AND r.automation_id = ${automationId}
      AND r.run_type = 'automation'
    LIMIT 1
    FOR UPDATE
  `;
  if (!run) {
    throw new Error("Automation run is missing a valid dispatch payload.");
  }
  const payload = parseAutomationRunPayload(run.approved_input);
  if (!payload || payload.automation_id !== automationId) {
    throw new Error("Automation run is missing a valid dispatch payload.");
  }
  const executor = resolveAutomationExecutor({
    agentId: payload.agent_id,
    deviceWorkerId: payload.device_worker_id,
    agentKind: payload.agent_kind,
  });
  let persistedExecution: AutomationTriggerExecution;
  if (executor?.kind === "agent") {
    persistedExecution = {
      lane: "managed_agent",
      owner: "lobu",
      managed_agent_id: executor.agentId,
      next_action: { kind: "handled_elsewhere" },
    };
  } else if (executor?.kind === "device") {
    persistedExecution = {
      lane: "device_worker",
      owner: "device",
      device_worker_id: executor.deviceWorkerId,
      agent_kind: executor.agentKind,
      next_action: { kind: "handled_elsewhere" },
    };
  } else {
    persistedExecution = {
      lane: "external_client",
      owner: "caller",
      next_action: {
        kind: "complete_window",
        read: {
          method: "knowledge.read",
          input: { automation_id: payload.automation_id, run_id: runId },
        },
        // biome-ignore lint/suspicious/noThenProperty: Public protocol field required by the trigger handoff contract.
        then: "automations.completeWindow",
      },
    };
  }

  if (run.status === "pending") {
    return { execution: persistedExecution, shouldDispatch: true };
  }
  if (run.status !== "claimed" && run.status !== "running") {
    throw new ToolUserError(
      `Automation run ${runId} is no longer active.`,
      409,
    );
  }

  const claimedBy = run.claimed_by?.trim();
  if (!claimedBy) {
    throw new ToolUserError(
      `Automation run ${runId} has no recognized active claimant.`,
      409,
    );
  }
  if (isExternalAutomationClaimOwner(claimedBy)) {
    const leaseExpiresAt =
      run.expires_at == null ? Number.NaN : new Date(run.expires_at).getTime();
    if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.now()) {
      throw new ToolUserError(
        `Automation run ${runId} has no recognized active claimant.`,
        409,
      );
    }
    if (claimedBy === encodeExternalAutomationClaimOwner(ctx)) {
      return {
        execution: {
          lane: "external_client",
          owner: "caller",
          next_action: {
            kind: "resume_claim",
            method: "automations.claimNextWindow",
            input: { automation_id: automationIdString, run_id: runId },
          },
        },
        shouldDispatch: false,
      };
    }
    return {
      execution: {
        lane: "external_client",
        owner: "another_caller",
        next_action: { kind: "handled_elsewhere" },
      },
      shouldDispatch: false,
    };
  }

  const nativeManagedClaim =
    executor?.kind === "agent" &&
    (claimedBy === "lobu-dispatcher" || claimedBy === `lobu:${executor.agentId}`);
  const nativeDeviceClaim =
    executor?.kind === "device" && claimedBy === run.device_claimed_by;
  if (!nativeManagedClaim && !nativeDeviceClaim) {
    throw new ToolUserError(
      `Automation run ${runId} has no recognized active claimant.`,
      409,
    );
  }
  return { execution: persistedExecution, shouldDispatch: false };
}

// ============================================
// handleTrigger
// ============================================

export async function handleTrigger(
  args: ManageAutomationsArgs,
  _env: Env,
  ctx: ToolContext,
): Promise<AutomationTriggerResult> {
  const sql = getDb();

  if (!args.automation_id) {
    throw new ToolUserError("automation_id is required for trigger action", 400);
  }
  const automationIdString = args.automation_id;
  const automationId = Number(automationIdString);

  const queued = await sql.begin(async (tx) => {
    // Manual trigger recovery must reconcile an expired external window lease
    // before enqueueing, otherwise the queue reuses that still-"active" run
    // and loadTriggerExecution fails closed instead of creating fresh work.
    await expireExternalClaims(tx, automationId);
    const run = await enqueueAutomationRunForAutomationInTransaction(
      automationId,
      "manual",
      tx,
    );
    const loaded = await loadTriggerExecution(
      tx,
      run.runId,
      automationId,
      automationIdString,
      ctx,
    );
    if (
      loaded.shouldDispatch &&
      loaded.execution.lane === "managed_agent" &&
      !isLobuGatewayRunning()
    ) {
      throw new Error("Embedded Lobu is not available.");
    }
    return { ...run, ...loaded };
  });
  const dispatch = queued.shouldDispatch
    ? await dispatchPendingAutomationRuns({
        db: sql,
        runIds: [queued.runId],
      })
    : { failed: 0 };
  const runInfo = await getAutomationRunInfo(queued.runId, sql);

  if (dispatch.failed > 0) {
    throw new Error(
      runInfo?.error_message || "Failed to dispatch Automation run.",
    );
  }

  return {
    action: "trigger",
    automation_id: automationIdString,
    run_id: queued.runId,
    status: runInfo?.status ?? queued.status,
    created: queued.created,
    execution: queued.execution,
  };
}

// ============================================
// handleSetReactionScript
// ============================================

export async function handleSetReactionScript(
  args: ManageAutomationsArgs,
  _env: Env,
  ctx: ToolContext,
): Promise<{
  action: "set_reaction_script";
  automation_id: string;
  has_script: boolean;
  message: string;
}> {
  const sql = getDb();

  if (!args.automation_id) {
    throw new ToolUserError("automation_id is required for set_reaction_script", 400);
  }

  await requireExists(sql, "automations", args.automation_id, "Automation");

  // Reaction script is a group-shared field — every assignment in the
  // group runs the same reactions after completion. Resolve the group once
  // and cascade across all assignments so we don't silently fork.
  const groupRows = await sql`
    SELECT automation_group_id FROM automations WHERE id = ${args.automation_id} LIMIT 1
  `;
  const groupId = Number(groupRows[0].automation_group_id);

  const script = args.reaction_script;

  if (!script || script.trim() === "") {
    // Clearing the reaction can orphan a prompt-less Automation: removing the
    // only instruction source leaves a schedule/window/manual Automation with
    // nothing to run on. Re-run the instruction rule against every assignment's
    // final state (triggers per-assignment; prompt/skills group-shared through
    // the current version) and reject the clear if it would leave any
    // assignment invalid.
    const groupState = await sql`
      SELECT w.id, w.triggers, cv.prompt, cv.skills, w.execution_config->'executor'->>'source' AS executor_source
      FROM automations w
      LEFT JOIN automation_versions cv ON cv.id = w.current_version_id
      WHERE w.automation_group_id = ${groupId}
    `;
    for (const assignment of groupState) {
      try {
        assertAutomationInstructions(
          (assignment.triggers ?? []) as AutomationTrigger[],
          assignment.prompt as string | null | undefined,
          (assignment.skills ?? null) as Array<{ name: string; content: string }> | null,
          null,
          assignment.executor_source as string | null,
        );
      } catch (err) {
        if (err instanceof ToolUserError) {
          throw new ToolUserError(
            `Cannot remove the reaction script: ${err.message}`,
            422
          );
        }
        throw err;
      }
    }
    await sql`
      UPDATE automations
      SET reaction_script = NULL, reaction_script_compiled = NULL,
          reaction_input_schema = NULL
      WHERE automation_group_id = ${groupId}
    `;
    recordToolConfigChange(ctx, {
      resourceKind: "automation",
      resourceId: args.automation_id,
      op: "updated",
      summary: `Automation ${args.automation_id} reaction script removed`,
      state: {
        id: args.automation_id,
        automation_group_id: groupId,
        reaction_script: null,
        reaction_input_schema: null,
      },
      changedFields: ["reaction_script"],
    });
    return {
      action: "set_reaction_script",
      automation_id: String(args.automation_id),
      has_script: false,
      message: "Reaction script removed.",
    };
  }

  const compiledCode = await compileReactionScript(script);
  await validateReactionDefaultExport(compiledCode);
  // Derive the reaction's extraction contract from its exported `input` schema,
  // so the worker is told the exact shape the reaction will Value.Parse. NULL
  // when the reaction declares no `input` (free-form `{ summary }` fallback).
  const reactionInputSchema = await extractReactionInputSchema(script);

  await sql`
    UPDATE automations
    SET reaction_script = ${script}, reaction_script_compiled = ${compiledCode},
        reaction_input_schema = ${reactionInputSchema ? sql.json(reactionInputSchema) : null}
    WHERE automation_group_id = ${groupId}
  `;

  logger.info(
    `[manage_automations] Set reaction script for automation ${args.automation_id}`,
  );

  recordToolConfigChange(ctx, {
    resourceKind: "automation",
    resourceId: args.automation_id,
    op: "updated",
    summary: `Automation ${args.automation_id} reaction script updated`,
    // Snapshot of the fields just written (row not refetched); compiled code
    // is intentionally omitted to keep the state small.
    state: {
      id: args.automation_id,
      automation_group_id: groupId,
      reaction_script: script,
      reaction_input_schema: reactionInputSchema ?? null,
    },
    changedFields: ["reaction_script"],
  });

  return {
    action: "set_reaction_script",
    automation_id: String(args.automation_id),
    has_script: true,
    message:
      "Reaction script compiled and saved. It will auto-execute on future complete_window calls.",
  };
}
