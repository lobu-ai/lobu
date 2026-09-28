import type { AutomationExecutionConfig } from '@lobu/core/contracts/tools/manage-automations';
import { ToolUserError } from '../utils/errors';
import { automationScriptExecutor } from '../tools/admin/automation-execution-config';
import {
  compileReactionScript,
  validateReactionDefaultExport,
} from './reaction-executor';

/** Validate the final script lane; permission checks still belong to the owning agent. */
export async function assertAutomationScriptExecutor(params: {
  executionConfig: unknown;
  agentId?: string | null;
  deviceWorkerId?: string | null;
  agentKind?: string | null;
  triggers?: ReadonlyArray<{ kind: string; output?: string }>;
  skills?: ReadonlyArray<unknown> | null;
  outputs?: Record<string, unknown> | null;
  validateSource?: boolean;
}): Promise<void> {
  const executor = automationScriptExecutor(params.executionConfig);
  if (!executor) return;
  if (!params.agentId || params.deviceWorkerId) {
    throw new ToolUserError(
      'A script executor requires an owning managed_agent_id and cannot be pinned to a device.',
      422
    );
  }
  if (
    params.agentKind ||
    params.triggers?.some((trigger) => trigger.output === 'reply_to_source')
  ) {
    throw new ToolUserError(
      'Script executors use silent triggers and send any replies through the SDK; device agent kinds and automatic model replies do not apply.',
      422
    );
  }
  if (
    params.skills?.length ||
    (params.outputs && Object.keys(params.outputs).length > 0)
  ) {
    throw new ToolUserError(
      'A script executor cannot use agent skills or extraction outputs. Read and persist data through the SDK in the script.',
      422
    );
  }
  const config = params.executionConfig as AutomationExecutionConfig;
  if (
    config.model ||
    config.effort ||
    config.permission_mode ||
    config.max_budget_usd != null ||
    config.finalize_nudges != null ||
    config.timeout_seconds != null
  ) {
    throw new ToolUserError(
      'A script executor uses the sandbox limits and owning agent permissions; model, CLI, timeout, and finalize settings do not apply.',
      422
    );
  }
  if (params.validateSource !== false) {
    await validateReactionDefaultExport(
      await compileReactionScript(executor.source),
      'Automation script'
    );
  }
}
