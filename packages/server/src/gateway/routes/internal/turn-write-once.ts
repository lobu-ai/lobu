import type { WorkerTokenData } from "@lobu/core";
import { TURN_INPUT_RUN_HEADER } from "@lobu/core/agent-tooling";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  agentTurnIdentityFromClaims,
  runTurnWriteOnce,
  withTurnInputRun,
} from "../../../tools/turn-write-idempotency.js";
import { ToolUserError } from "../../../utils/errors.js";
import { errorResponse } from "../shared/helpers.js";

/** A stored route answer: the JSON body to replay, or a marker for a binary one. */
type StoredResponse =
  | { status: number; body: unknown }
  | { status: number; binary: true };

const ALREADY_ATTEMPTED =
  "This was already attempted for this message and may have been delivered; it was not repeated.";
const ALREADY_GENERATED =
  "This was already generated for this message; delivery is unconfirmed and generation was not repeated.";

/**
 * Serve a worker write route at most once per input within receipt retention.
 *
 * The turn comes from the verified worker token, and the steered input from
 * `TURN_INPUT_RUN_HEADER`, which the key derivation verifies against the
 * turn's stored inputs. `args` are the validated, route-resolved arguments
 * that define the effect. A 4xx answer releases the claim and a 5xx keeps
 * it unresolved. A repeat replays the first JSON answer; a binary
 * answer (generated media, uploaded separately by the worker) is answered
 * with a 409 rather than generated again. This receipt does not confirm the
 * subsequent upload. A claim left by an attempt that never finished is
 * answered "already attempted". Non-turn workers run `send` exactly as before.
 */
export async function sendOncePerTurnInput(
  c: Context,
  worker: WorkerTokenData,
  surface: string,
  args: unknown,
  send: () => Promise<Response>
): Promise<Response> {
  const turn = withTurnInputRun(
    agentTurnIdentityFromClaims(worker),
    c.req.header(TURN_INPUT_RUN_HEADER)
  );
  let fresh: Response | undefined;
  let outcome;
  try {
    outcome = await runTurnWriteOnce<StoredResponse>(turn, surface, args, async () => {
      fresh = await send();
      // Status is the primitive: a 4xx is a refusal before the effect (the
      // same input may try again); a 5xx is a failure that may have struck
      // after it, so the claim stays and a repeat answers "attempted".
      if (fresh.status >= 500) return { retain: true };
      if (!fresh.ok) return { release: true };
      const type = fresh.headers.get("content-type") ?? "";
      return {
        store: type.includes("application/json")
          ? { status: fresh.status, body: await fresh.clone().json() }
          : { status: fresh.status, binary: true },
      };
    });
  } catch (error) {
    if (error instanceof ToolUserError) {
      return errorResponse(c, error.message, error.httpStatus as ContentfulStatusCode);
    }
    throw error;
  }
  if (outcome.kind === "ran") return fresh as Response;
  if (outcome.kind === "attempted") return errorResponse(c, ALREADY_ATTEMPTED, 409);
  const stored = outcome.result;
  if ("binary" in stored) return errorResponse(c, ALREADY_GENERATED, 409);
  return c.json(stored.body as Record<string, unknown>, stored.status as 200);
}
