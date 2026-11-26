import type {
  GuardrailContext,
  GuardrailStage,
  InputGuardrailContext,
  OutputGuardrailContext,
  PreToolGuardrailContext,
} from "@lobu/core";
import { safeStringify } from "./safe-stringify.js";

/**
 * Extract the inspectable text from a guardrail stage's context for the
 * built-in pii-scan.
 *
 * `pre-tool` has no single text field, so the tool arguments are serialized.
 * `safeStringify` is used so BigInt / circular tool args don't throw — a
 * thrown guardrail is treated as a pass by the runner, which would silently
 * weaken the check exactly when the input is weird enough to deserve scrutiny.
 */
export function extractStageText<S extends GuardrailStage>(
  stage: S,
  ctx: GuardrailContext[S]
): string {
  switch (stage) {
    case "input":
      return (ctx as InputGuardrailContext).message;
    case "output":
      return (ctx as OutputGuardrailContext).text;
    case "pre-tool":
      return safeStringify((ctx as PreToolGuardrailContext).arguments);
    default:
      return "";
  }
}
