/**
 * Deterministic check of the governed context fetched from the live gateway.
 *
 * WITH contains the billing-migration citation and repaired March number;
 * WITHOUT contains only the raw warehouse number. This does not invoke a model
 * or claim to measure answer quality. The example-owned integration fixture
 * exercises these same inputs through Lobu's real isolate/session runtime with
 * a synthetic provider and no tools, memory, or prior session in either arm.
 *
 * Prereqs: `lobu run`, `bun run seed:warehouse`, and `bun run seed`.
 */

import { WAREHOUSE_CONNECTION_SLUG } from "./lib/env.ts";
import { callTool, connectLocalGateway, type Gateway } from "./lib/gateway.ts";

const QUESTION =
  "Churn spiked to 550 in March 2026. Is that real, and what should the number be?";
const ADJUSTED_MARCH = 50;

// ── Pull the governed context out of the running gateway ───────────────────

interface BusinessEvent {
  event: string;
  type: string;
  date: string;
  source: string;
  affected_metrics: string[];
  expected_effect: string;
  adjustment: { op: string; cancel_reason?: string } | null;
}

const CONTEXT_SCRIPT = `
export default async (_ctx, client) => {
  const list = await client.entities.list({ entity_type: "business-event" });
  const events = (list.entities ?? []).map((ev) => ({
    event: ev.name,
    type: ev.metadata?.event_type,
    date: ev.metadata?.event_date,
    source: ev.metadata?.source_link,
    affected_metrics: ev.metadata?.affected_metrics ?? [],
    expected_effect: ev.metadata?.expected_effect ?? "",
    adjustment: ev.metadata?.adjustment ?? null,
  }));
  return { events };
};
`;

/** The live raw + repaired March numbers, straight from the warehouse. */
async function warehouseMarch(
  gw: Gateway
): Promise<{ raw: number; adjusted: number }> {
  const res = await callTool<{
    rows: Array<{ raw: number; adjusted: number }>;
    error?: string;
  }>(gw, "query_sql", {
    connection: WAREHOUSE_CONNECTION_SLUG,
    sql:
      "SELECT count(*)::int AS raw, " +
      // NULL-safe: `IS DISTINCT FROM` keeps a NULL-reason cancellation in the
      // repaired count (a plain `<>` would go NULL → dropped from the FILTER),
      // matching compose.ts's artifact predicate.
      "count(*) FILTER (WHERE cancel_reason IS DISTINCT FROM 'billing_migration_artifact')::int AS adjusted " +
      "FROM subscriptions WHERE cancelled_at IS NOT NULL " +
      "AND to_char(date_trunc('month', cancelled_at), 'YYYY-MM') = '2026-03'",
  });
  if (res.error) throw new Error(`warehouse read failed: ${res.error}`);
  const row = res.rows[0];
  if (!row) {
    throw new Error("warehouse returned no aggregate row");
  }
  return row;
}

/** Build the context block pushed to the agent in the WITH arm. */
function withContextBlock(
  events: BusinessEvent[],
  march: {
    raw: number;
    adjusted: number;
  }
): string {
  const relevant = events.filter((e) =>
    e.affected_metrics.includes("churn_rate")
  );
  const lines = relevant.map(
    (e) =>
      `- [${e.type}] ${e.event} (on ${e.date}, source ${e.source})\n` +
      `    ${e.expected_effect}` +
      (e.adjustment
        ? `\n    structured adjustment: ${JSON.stringify(e.adjustment)}`
        : "")
  );
  return (
    "GOVERNED CONTEXT (business events affecting churn_rate):\n" +
    lines.join("\n") +
    `\n\nComposed adjusted series for 2026-03: raw ${march.raw}, ` +
    `adjusted ${march.adjusted} (billing_migration_artifact rows subtracted).`
  );
}

/** Baseline arm: raw number only, no governed context. */
function baselineBlock(march: { raw: number }): string {
  return `The warehouse reports ${march.raw} cancellations for 2026-03. No other context is available.`;
}

/** Shared inputs for the deterministic demo and the real-runtime fixture. */
export function buildEvaluationCases(
  events: BusinessEvent[],
  march: { raw: number; adjusted: number }
): { withContext: string; baseline: string } {
  return {
    withContext: `${withContextBlock(events, march)}\n\nQuestion: ${QUESTION}`,
    baseline: `${baselineBlock(march)}\n\nQuestion: ${QUESTION}`,
  };
}

/** Require the incident identifier, including when it appears in its source URL. */
export function citesMigration(answer: string): boolean {
  return answer.toLowerCase().includes("data-142");
}

/** Does the answer give the corrected March number (~50, not the raw 550)? */
export function correctsNumber(answer: string): boolean {
  // Match the corrected number as a WHOLE number token — a bare `includes("50")`
  // would also match inside the raw "550", so an answer that only ever repeats
  // 550 would be scored as if it had corrected to 50. Require ADJUSTED_MARCH to
  // appear with non-digit boundaries on both sides.
  const correctedToken = new RegExp(`(?:^|\\D)${ADJUSTED_MARCH}(?:\\D|$)`);
  return correctedToken.test(answer.toLowerCase());
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const gw = await connectLocalGateway();
  console.log(`Connected to local gateway (org: ${gw.org})`);

  const ctxRes = await callTool<{
    return_value?: { events: BusinessEvent[] };
    success: boolean;
    error?: { message: string };
  }>(gw, "run_sdk", { script: CONTEXT_SCRIPT, timeout_ms: 60_000 });
  if (!ctxRes.success || !ctxRes.return_value) {
    throw new Error(
      `context read failed: ${ctxRes.error?.message ?? "unknown"}`
    );
  }
  const march = await warehouseMarch(gw);
  const cases = buildEvaluationCases(ctxRes.return_value.events, march);

  // Assert on actual context, never on a fabricated model answer. The runtime
  // fixture separately checks isolated turns with a synthetic provider.
  const withCites = citesMigration(cases.withContext);
  // Incident prose also mentions 50; it must not mask a changed warehouse result.
  const withCorrects =
    march.adjusted === ADJUSTED_MARCH && correctsNumber(cases.withContext);
  const withPass = withCites && withCorrects;
  const baseCites = citesMigration(cases.baseline);
  const baseCorrects = correctsNumber(cases.baseline);
  const basePass = !baseCites && !baseCorrects;
  const pass = withPass && basePass;

  console.log("=== Context eval (deterministic context check) ===\n");
  console.log("(A) WITH context layer:");
  console.log(indent(cases.withContext));
  console.log(
    `\n  → cites migration? ${withCites ? "YES" : "NO"}; corrects to ~${ADJUSTED_MARCH}? ${withCorrects ? "YES" : "NO"} ⇒ ${withPass ? "PASS ✅" : "FAIL ❌"}`
  );
  console.log("\n(B) WITHOUT context layer (baseline):");
  console.log(indent(cases.baseline));
  console.log(
    `\n  → cites migration? ${baseCites ? "YES" : "NO"}; corrects the number? ${baseCorrects ? "YES" : "NO"} ⇒ correctly has neither? ${basePass ? "PASS ✅" : "FAIL ❌"}`
  );
  console.log(
    `\n${pass ? "PASS ✅" : "FAIL ❌"} — the governed correction is ${pass ? "present only in the WITH context" : "missing or leaked into the baseline"}.`
  );
  console.log(
    "\nNo model was called. This checks the live context bundle, not model answer quality."
  );
  if (!pass) process.exitCode = 1;
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

if (import.meta.main) await main();
