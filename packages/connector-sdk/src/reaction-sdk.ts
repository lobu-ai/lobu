/**
 * Reaction context types.
 *
 * The runtime SDK reaction scripts call is `ClientSDK` (defined in
 * `packages/server/src/sandbox/client-sdk.ts`); only the context
 * shape is shared across packages, so only those types live here.
 */

export interface ReactionEntity {
  id: number;
  name: string;
  entity_type: string;
  metadata: Record<string, unknown>;
}

/**
 * Context passed to reaction scripts containing the analysis results
 * and metadata about the completed Automation run. Reaction scripts have the
 * shape `default async (ctx: ReactionContext, client, params?)`.
 */
export interface ReactionContext {
  /** The extracted analysis data from the completed run */
  extracted_data: Record<string, unknown>;
  /** All entities the Automation is attached to */
  entities: ReactionEntity[];
  /**
   * The completed run and the arrival range it analyzed. `window_start` and
   * `window_end` bound `events.created_at`, not `occurred_at` — the range is
   * "what reached Lobu between these two instants", not a calendar period, so
   * it has no granularity to report.
   */
  window: {
    run_id: number;
    automation_id: number;
    window_start: string;
    window_end: string;
    content_analyzed: number;
  };
  /** Automation identity */
  automation: {
    id: number;
    slug: string;
    name: string;
    version: number;
  };
  /** Organization context */
  organization_id: string;
  /** Stable workspace slug for relative app permalinks. */
  organization_slug: string;
}

/** Context of a script executing the Automation itself, before completion. */
export interface AutomationScriptContext
  extends Omit<ReactionContext, 'extracted_data' | 'window'> {
  window: Omit<ReactionContext['window'], 'content_analyzed'>;
  /**
   * Durable event activations, frozen when the run is claimed. Empty for
   * scheduled and manual runs.
   */
  trigger_signals: unknown[];
}
