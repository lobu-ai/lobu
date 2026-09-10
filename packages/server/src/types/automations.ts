/**
 * Shared Automation Types
 *
 * Single source of truth for automation-related types used across
 * backend tools, utils, and frontend components. TypeBox-first: each type is
 * derived from its schema via `Static<>`, so the runtime JSON Schema (surfaced
 * as MCP tool `outputSchema`) and the TS type cannot drift.
 */

import { type Static, Type } from '@sinclair/typebox';
import {
  AutomationExecutionConfigSchema,
  AutomationTriggerSchema,
  type AutomationTrigger,
  AutomationDeliveryTargetSchema,
  AutomationSourceSchema,
  type AutomationSource,
  AutomationOutputsSchema,
  type AutomationOutputs,
  type AutomationEntityOutput,
  type AutomationEventOutput,
} from '@lobu/core/contracts/tools/manage-automations';

export {
  AutomationTriggerSchema,
  type AutomationTrigger,
  AutomationSourceSchema,
  type AutomationSource,
};

// ============================================
// Automation Version
// ============================================

// ============================================
// Automation Window
// ============================================

/**
 * One reaction-log entry for a window (from automation_reactions). Surfaced on
 * get_automation windows so the UI can show what the reaction script did.
 */
export const AutomationWindowReactionSchema = Type.Object({
  id: Type.Integer(),
  reaction_type: Type.String(),
  tool_name: Type.String(),
  tool_args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  tool_result: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  created_at: Type.String(),
});
export type AutomationWindowReaction = Static<typeof AutomationWindowReactionSchema>;

/**
 * Automation window data as returned by get_automation
 */
export const AutomationWindowSchema = Type.Object({
  run_id: Type.Integer(),
  automation_id: Type.String(),
  automation_name: Type.String(),
  window_start: Type.String(),
  window_end: Type.String(),
  content_analyzed: Type.Integer(),
  extracted_data: Type.Record(Type.String(), Type.Unknown()),
  previous_extracted_data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  classification_stats: Type.Optional(
    Type.Record(Type.String(), Type.Record(Type.String(), Type.Integer()))
  ),
  model_used: Type.String(),
  client_id: Type.Optional(Type.String()),
  run_metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  execution_time_ms: Type.Integer(),
  created_at: Type.String(),
  version_id: Type.Optional(Type.Integer()),
  /** Reaction-script execution log for this window (newest first). */
  reactions: Type.Optional(Type.Array(AutomationWindowReactionSchema)),
});
export type AutomationWindow = Static<typeof AutomationWindowSchema>;

// ============================================
// Automation Outputs
// ============================================

export const OutputsSchema = AutomationOutputsSchema;
export type Outputs = AutomationOutputs;
export type EntityOutput = AutomationEntityOutput;
export type EventOutput = AutomationEventOutput;

// ============================================
// Version Info (for listing available versions)
// ============================================

export const AutomationVersionInfoSchema = Type.Object({
  version: Type.Integer(),
  name: Type.String(),
  created_at: Type.String(),
  is_current: Type.Boolean(),
});
export type AutomationVersionInfo = Static<typeof AutomationVersionInfoSchema>;

// ============================================
// Automation metadata (returned by get_automation)
// ============================================

const AutomationRunSchema = Type.Object({
  run_id: Type.Integer(),
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('claimed'),
    Type.Literal('running'),
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('cancelled'),
    Type.Literal('timeout'),
  ]),
  /** Write-time outcome classification (runs.outcome); omitted when unstamped. */
  outcome: Type.Optional(
    Type.Union([
      Type.Literal('infra_error'),
      Type.Literal('agent_error'),
      Type.Literal('scoreable'),
    ])
  ),
  error_message: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  created_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  completed_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export const AutomationMetadataSchema = Type.Object({
  automation_id: Type.String(),
  automation_name: Type.String(),
  slug: Type.String(),
  status: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
  triggers: Type.Optional(Type.Array(AutomationTriggerSchema)),
  next_run_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  consecutive_scheduled_failures: Type.Optional(Type.Integer({ minimum: 0 })),
  schedule_auto_paused_at: Type.Optional(
    Type.Union([Type.String(), Type.Null()])
  ),
  managed_agent_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  delivery_target: Type.Optional(
    Type.Union([AutomationDeliveryTargetSchema, Type.Null()])
  ),
  /**
   * Optional FK into `device_workers.id` pinning this automation (and its run)
   * to a specific device worker. NULL/undefined means any worker can claim.
   */
  device_worker_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** Preferred local agent runtime on the pinned device; null = device default. */
  agent_kind: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  execution_config: Type.Optional(
    Type.Union([AutomationExecutionConfigSchema, Type.Null()])
  ),
  version: Type.Integer(),
  sources: Type.Array(AutomationSourceSchema),
  prompt: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  outputs: Type.Optional(Type.Union([OutputsSchema, Type.Null()])),
  /** Version-owned config surfaced so the edit form can round-trip them
   *  (create_version preserves prev values on omit, but prefilling avoids
   *  the empty-form-state clobber). */
  classifiers: Type.Optional(Type.Array(Type.Unknown())),
  reactions_guidance: Type.Optional(Type.String()),
  available_versions: Type.Optional(Type.Array(AutomationVersionInfoSchema)),
  reaction_script: Type.Optional(Type.String()),
  automation_run: Type.Optional(AutomationRunSchema),
  /** Computed health: `degraded` when an active Automation is unverified,
   *  misses/stalls a firing, fails its latest run, or has a severe bounded
   *  recent failure pattern; else `healthy`. */
  health: Type.Optional(
    Type.Union([Type.Literal('healthy'), Type.Literal('degraded')])
  ),
  /** Reasons behind a `degraded` verdict (empty/omitted when healthy). */
  health_reasons: Type.Optional(Type.Array(Type.String())),
  /** Latest run error surfaced alongside the health verdict. */
  last_scheduling_error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** Latest run's write-time outcome classification (null until stamped). */
  last_run_outcome: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type AutomationMetadata = Static<typeof AutomationMetadataSchema>;

// ============================================
// Pending Analysis
// ============================================

const NextActionSchema = Type.Object({
  tool: Type.String(),
  params: Type.Record(Type.String(), Type.Unknown()),
  description: Type.String(),
});

export const UnprocessedRangeSchema = Type.Object({
  month: Type.String(),
  window_start: Type.String(),
  window_end: Type.String(),
  total_content: Type.Integer(),
  processed_content: Type.Integer(),
  unprocessed_content: Type.Integer(),
  status: Type.Union([
    Type.Literal('unprocessed'),
    Type.Literal('partial'),
    Type.Literal('complete'),
  ]),
});
export type UnprocessedRange = Static<typeof UnprocessedRangeSchema>;

export const PendingAnalysisSchema = Type.Object({
  /**
   * Source items not yet linked to any completed Automation run.
   *
   * Bounded by `occurred_at` for cost, not as an axis claim: the count is
   * capped and 90-day-scoped so the page query stays inside the frontend
   * timeout. The window bounds below are the arrival axis.
   */
  unprocessed_content_count: Type.Integer(),
  /**
   * The arrival range a claim would hand out: `[mark, now - settle)`. Null only
   * while the mark is younger than the settle budget (a just-created or
   * just-seeded Automation) — the only state in which an Automation has no
   * window to claim.
   */
  next_window: Type.Union([
    Type.Object({
      start: Type.String(),
      end: Type.String(),
    }),
    Type.Null(),
  ]),
  next_action: Type.Union([NextActionSchema, Type.Null()]),
  unprocessed_ranges: Type.Optional(Type.Array(UnprocessedRangeSchema)),
});
export type PendingAnalysis = Static<typeof PendingAnalysisSchema>;
