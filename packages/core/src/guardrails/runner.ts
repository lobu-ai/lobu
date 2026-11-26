import { createLogger } from "../logger";
import type { GuardrailRegistry } from "./registry";
import type {
  Guardrail,
  GuardrailContext,
  GuardrailRunOutcome,
  GuardrailStage,
} from "./types";

const logger = createLogger("guardrail-runner");

/**
 * Run all enabled guardrails for `stage` in parallel. Resolves with the first
 * trip (others keep running but their results are discarded), or `{tripped: null}`
 * if every guardrail passes. A thrown guardrail is logged and treated as a
 * pass — guardrails must fail closed on their own if they want halt-on-error
 * semantics.
 *
 * The returned outcome includes `ran`, a snapshot of which guardrails had
 * produced a result at the moment the race ended (on first trip, or when all
 * settled). Guardrails still running after short-circuit are intentionally
 * not reflected — they complete in the background and their output is
 * discarded.
 */
export async function runGuardrails<S extends GuardrailStage>(
  registry: GuardrailRegistry,
  stage: S,
  enabled: readonly string[],
  ctx: GuardrailContext[S]
): Promise<GuardrailRunOutcome> {
  if (enabled.length === 0) {
    return { tripped: null, ran: [] };
  }
  const guardrails = registry.resolve(stage, enabled) as Guardrail<S>[];
  return runGuardrailInstances(stage, guardrails, ctx);
}

/**
 * Like {@link runGuardrails} but takes already-resolved {@link Guardrail}
 * instances instead of names. Used by the gateway's aggregator, which renames
 * each registry-backed built-in after the library row that enables it. Same
 * parallel-race + first-trip short-circuit + fail-open-on-throw semantics as
 * the name-based path.
 */
export async function runGuardrailInstances<S extends GuardrailStage>(
  stage: S,
  guardrails: readonly Guardrail<S>[],
  ctx: GuardrailContext[S]
): Promise<GuardrailRunOutcome> {
  if (guardrails.length === 0) {
    return { tripped: null, ran: [] };
  }

  const ran: string[] = [];
  let tripped: GuardrailRunOutcome["tripped"] = null;

  return await new Promise<GuardrailRunOutcome>((resolve) => {
    let settled = false;
    let remaining = guardrails.length;

    const finish = () => {
      if (settled) return;
      settled = true;
      // Snapshot `ran` — background guardrails keep pushing to the live array
      // after short-circuit, and consumers shouldn't see those late appends.
      resolve({ tripped, ran: [...ran] });
    };

    for (const g of guardrails) {
      Promise.resolve()
        .then(() => g.run(ctx))
        .then((result) => {
          ran.push(g.name);
          if (!tripped && result.tripped) {
            tripped = {
              guardrail: g.name,
              reason: result.reason,
              metadata: result.metadata,
            };
            logger.info(
              { guardrail: g.name, stage, reason: result.reason },
              "Guardrail tripped"
            );
            // Short-circuit: resolve immediately on first trip. Other
            // guardrails continue running but their outcome is discarded.
            finish();
          }
        })
        .catch((err) => {
          logger.error(
            {
              guardrail: g.name,
              stage,
              error: err instanceof Error ? err.message : String(err),
            },
            "Guardrail threw; treating as pass"
          );
        })
        .finally(() => {
          remaining -= 1;
          if (remaining === 0) finish();
        });
    }
  });
}
