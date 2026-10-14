import type { EventEnvelope } from '@lobu/connector-sdk';
import type { ContentItem } from '@lobu/core/contracts/worker/protocol';
import type {
  ExecutionHooks,
  ExecutorJob,
  ExecutorResult,
  SyncExecutor,
} from './interface.js';
import { selectExecutor } from './select.js';

/**
 * Top-level entry point used by the daemon executor. Just delegates to the
 * `SyncExecutor` `selectExecutor` builds — always an `IsolateExecutor` — with
 * the V1 SDK shapes, no magic-key adapter layer in between.
 */
export async function executeCompiledConnector(params: {
  compiledCode: string;
  job: ExecutorJob;
  executor?: SyncExecutor;
  hooks?: ExecutionHooks;
  /**
   * Hard wall-clock limit for this connector run. Only applies to the
   * executor chosen here; an injected `executor` owns its own budget.
   */
  timeoutMs?: number;
  /** Hosts the connector may reach, in the shared egress grammar. Unset is
   *  unrestricted; an EMPTY list denies everything. */
  allowedDomains?: readonly string[];
}): Promise<ExecutorResult> {
  const executor =
    params.executor ??
    (await selectExecutor({ timeoutMs: params.timeoutMs, allowedDomains: params.allowedDomains }));
  return executor.execute(params.compiledCode, params.job, params.hooks);
}

/**
 * Convert a V1 EventEnvelope (the SDK's standard sync output) into the
 * gateway-bound ContentItem shape (without an embedding).
 */
export function envelopeToContentItem(event: EventEnvelope): ContentItem {
  const occurredAtIso =
    event.occurred_at instanceof Date
      ? event.occurred_at.toISOString()
      : (event.occurred_at as unknown as string);

  return {
    id: event.origin_id,
    title: event.title,
    payload_type: event.payload_type,
    payload_text: event.payload_text,
    payload_data: event.payload_data,
    attachments: event.attachments,
    author_name: event.author_name,
    occurred_at: occurredAtIso,
    source_url: event.source_url ?? undefined,
    score: typeof event.score === 'number' ? event.score : 0,
    metadata: event.metadata ?? {},
    origin_parent_id: event.origin_parent_id ?? undefined,
    origin_type: event.origin_type,
    semantic_type: event.semantic_type ?? event.origin_type,
    automation_signals: event.automation_signals,
  };
}
