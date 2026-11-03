import {
  resolvedEventExecution,
  type AutomationSource,
  type AutomationTrigger,
} from '@lobu/core/contracts/tools/manage-automations';
import { parsePgNumberArray, type DbClient } from '../db/client';
import { finalizeDynamicQueryRows } from '../utils/content-read-bounds';
import { ToolUserError } from '../utils/errors';
import {
  inspectAutomationScriptExports,
  type AutomationScriptExports,
} from './reaction-executor';

export type PreparationSources = Record<string, Record<string, unknown>[]>;

export interface AutomationScriptSnapshot extends AutomationScriptExports {
  has_analysis: boolean;
  source: string;
  entities: number[];
  sources: AutomationSource[];
  source_names: string[];
  input_schema: Record<string, unknown> | null;
}

/** Snapshot the existing module, not a second source or execution mode. */
export async function snapshotAutomationScript(
  sql: DbClient,
  automationId: number,
  organizationId: string,
): Promise<AutomationScriptSnapshot | undefined> {
  const [row] = await sql`
    SELECT a.reaction_script_compiled, a.reaction_input_schema, a.entity_ids,
           a.execution_config, a.managed_agent_id, a.device_worker_id, a.triggers,
           a.sources, v.version_sources, v.prompt, v.skills, v.outputs, a.agent_kind
    FROM automations a
    LEFT JOIN automation_versions v ON v.id = a.current_version_id
    WHERE a.id = ${automationId} AND a.organization_id = ${organizationId}
    FOR SHARE OF a
  `;
  if (!row?.reaction_script_compiled) return undefined;
  const exports = await inspectAutomationScriptExports(row.reaction_script_compiled);
  // Installed legacy definitions retain their frozen execution contract.
  if (row.execution_config?.executor) {
    if (exports.has_prepare) assertPreparationConfiguration(row);
    return undefined;
  }
  const hasAnalysis = automationModuleHasAnalysis(row);
  if (!exports.has_prepare && hasAnalysis) return undefined;
  assertAutomationModuleConfiguration(row, exports);

  const sources: AutomationSource[] =
    (row.version_sources?.length ? row.version_sources : row.sources) ?? [];
  return {
    ...exports,
    has_analysis: hasAnalysis,
    source: row.reaction_script_compiled,
    entities: parsePgNumberArray(row.entity_ids),
    sources,
    input_schema: row.reaction_input_schema ?? null,
    source_names: [...new Set(['content', ...sources.map((source) => source.name)])],
  };
}

interface AutomationModuleConfiguration {
  execution_config?: unknown;
  managed_agent_id?: unknown;
  device_worker_id?: unknown;
  agent_kind?: unknown;
  triggers?: readonly AutomationTrigger[] | null;
  prompt?: string | null;
  skills?: readonly unknown[] | null;
  outputs?: Record<string, unknown> | null;
  reaction_input_schema?: unknown;
}

/** Authored analysis inputs determine the lifecycle; no separate mode is stored. */
export function automationModuleHasAnalysis(config: AutomationModuleConfiguration): boolean {
  return Boolean(config.prompt?.trim() || config.skills?.length ||
    config.reaction_input_schema || Object.keys(config.outputs ?? {}).length ||
    config.triggers?.some(trigger => trigger.kind === 'event' && resolvedEventExecution(trigger) === 'turn'));
}

export function assertAutomationModuleConfiguration(
  config: AutomationModuleConfiguration,
  exports: AutomationScriptExports,
): void {
  if (exports.has_prepare) assertPreparationConfiguration(config);
  if ((config.execution_config as { executor?: unknown } | null)?.executor ||
      automationModuleHasAnalysis(config)) return;
  if (!config.managed_agent_id || config.device_worker_id || config.agent_kind) {
    throw new ToolUserError('A code-only module requires an owning managed_agent_id and cannot use a device or agent kind.', 422);
  }
  const execution = config.execution_config as Record<string, unknown> | null;
  if (execution && Object.keys(execution).length) {
    throw new ToolUserError('A code-only module uses sandbox limits and owning-agent permissions; model, CLI, timeout and finalize settings do not apply.', 422);
  }
}

export function assertPreparationConfiguration(config: {
  execution_config?: unknown;
  managed_agent_id?: unknown;
  device_worker_id?: unknown;
  triggers?: readonly AutomationTrigger[] | null;
}): void {
  const execution = config.execution_config as { executor?: unknown } | null;
  if (
    execution?.executor ||
    (!config.managed_agent_id && !config.device_worker_id) ||
    config.triggers?.some(
      (trigger) => trigger.kind === 'event' && resolvedEventExecution(trigger) !== 'window'
    )
  ) {
    throw new ToolUserError(
      'Preparation requires an owning native agent and window execution; legacy executors and reply turns do not support prepare.',
      422,
    );
  }
}

/** Keep data bounded and disjoint from configured sources; never overwrite rows. */
export function validatePreparationSources(
  value: unknown,
  occupiedNames: readonly string[],
): PreparationSources {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolUserError(
      'Preparation must return an object of named arrays of records.', 422,
    );
  }
  const entries = Object.entries(value);
  if (entries.length > 32 || Buffer.byteLength(JSON.stringify(value), 'utf8') > 16_384) {
    throw new ToolUserError(
      'Preparation sources exceed 32 names or 16384 JSON bytes; return a summary or stored content references.',
      422,
    );
  }
  for (const [name, rows] of entries) {
    if (
      !name || name.length > 100 ||
      ['__proto__', 'constructor', 'prototype'].includes(name) ||
      occupiedNames.includes(name)
    ) {
      throw new ToolUserError(
        `Preparation source name is invalid or already configured: ${name}`, 422,
      );
    }
    if (
      !Array.isArray(rows) ||
      rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))
    ) {
      throw new ToolUserError(
        `Preparation source ${name} must be an array of records.`, 422,
      );
    }
    if (finalizeDynamicQueryRows(rows).sidecarCollisions.length) {
      throw new ToolUserError(
        `Preparation source ${name} conflicts with truncation metadata.`, 422,
      );
    }
  }
  return value as PreparationSources;
}
