/**
 * AGENT EVAL — does the context layer change the answer?
 *
 * The whole premise of a context layer is that pushing the governed "why" to an
 * agent changes what it concludes. This eval proves that, end to end, on stock
 * Lobu, by asking the SAME question two ways and asserting the answers differ:
 *
 *   Question: "Churn spiked to 550 in March 2026. Is that real, and what should
 *              the number be?"
 *
 *   (A) WITH the context layer  — the agent is handed the governed business
 *       events (the DATA-142 billing-migration incident + its structured
 *       adjustment) and the composed adjusted series. A correct answer cites the
 *       migration and corrects the number to ~50.
 *   (B) WITHOUT the context layer (baseline) — the agent is handed only the raw
 *       warehouse number and no business events. With nothing to go on it treats
 *       550 as real (or invents a cause).
 *
 * The eval ASSERTS: (A) references the billing migration / cites the source and
 * gives the corrected ~50; (B) does NOT. It prints both answers and PASS/FAIL.
 *
 * ── Real agent vs. deterministic proxy ────────────────────────────────────
 * A live agent needs a configured model provider. When one is present this eval
 * runs a REAL agent turn twice (via `lobu chat --json` against the running
 * gateway) and asserts on the model's actual text. When NO provider is
 * configured (the default for a throwaway local demo — `lobu run` ships no model
 * key), it CANNOT invoke a model, so it falls back to the strongest honest
 * proxy: it renders the exact context bundle that WOULD be pushed to the agent
 * in each arm and asserts the migration citation + corrected number are present
 * in (A) and absent from (B). The proxy is clearly labelled as such; wiring a
 * model provider (`lobu agents inference-providers`) and re-running is the
 * honest next step to see the live-agent version.
 *
 * Prereqs: `lobu run` is up here, and `seed:warehouse` + `seed` + `compose`'s
 * data are in place (run `bun run seed:warehouse && bun run seed` first).
 */

import { spawnSync } from "node:child_process";
import { WAREHOUSE_CONNECTION_SLUG } from "./lib/env.ts";
import { callTool, connectLocalGateway, type Gateway } from "./lib/gateway.ts";

const QUESTION =
  "Churn spiked to 550 in March 2026. Is that real, and what should the number be?";
const WITH_AGENT_ID = "analyst";
// The baseline agent is declared in lobu.config.ts with tools:{allowed:[],
// strict:true} — it cannot retrieve business-event context, so the WITHOUT arm
// is genuinely context-free, not just prompt-stripped.
const BASELINE_AGENT_ID = "baseline";
const ADJUSTED_MARCH = 50;
const MIGRATION_SOURCE = "https://linear.app/kelder/issue/DATA-142";

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
    // No row = the rollup found no March cancellations, which means the seed
    // didn't run (or the warehouse is empty). Fail loudly rather than fabricate
    // the expected 550/50 and pass on data that isn't there.
    throw new Error(
      "warehouse returned no March row — run `bun run seed:warehouse` first"
    );
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

// ── Real-agent turn via `lobu chat` (used when a model provider is wired) ───

interface ChatOutcome {
  text: string;
  noModel: boolean;
}

function runAgentTurn(
  gw: Gateway,
  agentId: string,
  prompt: string
): ChatOutcome {
  const res = spawnSync(
    "bunx",
    [
      "@lobu/cli",
      "chat",
      "--agent",
      agentId,
      // Thread the SAME gateway URL + org the scripts connected to (honors the
      // documented LOBU_URL override), instead of hardcoding a default.
      "--gateway",
      gw.base,
      "--org",
      gw.org,
      "--json",
      "--new",
      prompt,
    ],
    { encoding: "utf8", timeout: 180_000 }
  );
  const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  let text = "";
  let noModel = false;
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const ev = JSON.parse(trimmed) as {
        event?: string;
        errorCode?: string;
        error?: string;
        text?: string;
        content?: string;
        delta?: string;
      };
      // No-model shows up two ways depending on the gateway path: a typed
      // `errorCode: NO_MODEL_CONFIGURED`, OR a plain error event whose message
      // is "No model resolved for this run…" (no errorCode). Match BOTH — a
      // false negative here sends the eval down the live path and reports a
      // misleading FAIL (empty answers) instead of the honest proxy fallback.
      if (
        ev.errorCode === "NO_MODEL_CONFIGURED" ||
        (ev.event === "error" && /no model/i.test(ev.error ?? ""))
      ) {
        noModel = true;
      }
      // Accumulate any assistant text the stream carries; the exact field name
      // varies by event kind, so pull whichever text-bearing field is present.
      const chunk =
        (typeof ev.text === "string" ? ev.text : "") ||
        (typeof ev.content === "string" ? ev.content : "") ||
        (typeof ev.delta === "string" ? ev.delta : "");
      if (chunk) text += chunk;
    } catch {
      // non-JSON line (dependency-resolution noise) — ignore
    }
  }
  return { text: text.trim(), noModel };
}

// ── Assertions ─────────────────────────────────────────────────────────────
//
// Two SEPARATE signals, deliberately not folded into one. A context-aware
// answer must show BOTH; the baseline must show NEITHER. Folding them would let
// a one-sided answer (cites the migration but never corrects the number, or
// vice-versa) slip through and the PASS would no longer prove the context
// changed the answer.

/**
 * Does the answer cite the GOVERNED source, not just any plausible cause? We
 * require the incident's identifier (DATA-142) or its exact source URL — a bare
 * "migration"/"artifact" could be the model guessing, which would NOT prove it
 * used the pushed record. The whole point is that the context, not a lucky
 * guess, produced the answer.
 */
function citesMigration(answer: string): boolean {
  const a = answer.toLowerCase();
  return a.includes("data-142") || a.includes(MIGRATION_SOURCE.toLowerCase());
}

/** Does the answer give the corrected March number (~50, not the raw 550)? */
function correctsNumber(answer: string): boolean {
  // Match the corrected number as a WHOLE number token — a bare `includes("50")`
  // would also match inside the raw "550", so an answer that only ever repeats
  // 550 would be scored as if it had corrected to 50. Require ADJUSTED_MARCH to
  // appear with non-digit boundaries on both sides.
  const correctedToken = new RegExp(`(?:^|\\D)${ADJUSTED_MARCH}(?:\\D|$)`);
  return correctedToken.test(answer.toLowerCase());
}

// ── Run ─────────────────────────────────────────────────────────────────────

const gw = await connectLocalGateway();
console.log(`Connected to local gateway (org: ${gw.org})`);

const ctxRes = await callTool<{
  return_value?: { events: BusinessEvent[] };
  success: boolean;
  error?: { message: string };
}>(gw, "run_sdk", { script: CONTEXT_SCRIPT, timeout_ms: 60_000 });
if (!ctxRes.success || !ctxRes.return_value) {
  throw new Error(`context read failed: ${ctxRes.error?.message ?? "unknown"}`);
}
const events = ctxRes.return_value.events;
const march = await warehouseMarch(gw);

const withBlock = withContextBlock(events, march);
const baseBlock = baselineBlock(march);

// Probe: is a model wired up? One throwaway turn tells us.
console.log("\nProbing for a configured model provider…");
const probe = runAgentTurn(
  gw,
  WITH_AGENT_ID,
  "Reply with the single word READY."
);

let withAnswer: string;
let baseAnswer: string;
let mode: "live-agent" | "deterministic-proxy";

if (probe.noModel) {
  // ── Fallback: deterministic proxy ────────────────────────────────────────
  mode = "deterministic-proxy";
  console.log(
    "No model provider configured on this local install — the gateway cannot\n" +
      "run a live model (this is expected for a throwaway `lobu run`). Falling\n" +
      "back to the DETERMINISTIC PROXY: assert on the exact context bundle that\n" +
      "WOULD be pushed to the agent in each arm.\n"
  );
  // The proxy asserts on the RAW context bundle each arm would push — no
  // fabricated answer. If the WITH block genuinely carries the migration source
  // and the adjusted number, it passes; if the composition ever stops emitting
  // them, it fails. (Appending a hand-written "an agent would say…" answer would
  // rig the assertion to pass regardless of what the context actually contains.)
  withAnswer = withBlock;
  baseAnswer = baseBlock;
} else {
  // ── Real agent: two live turns ───────────────────────────────────────────
  mode = "live-agent";
  console.log("Model provider detected — running two REAL agent turns.\n");
  // Isolation is real: the WITH arm runs the `analyst` (governed context in the
  // prompt), the WITHOUT arm runs the `baseline` agent, declared in
  // lobu.config.ts with tools:{allowed:[],strict:true} so it CANNOT retrieve the
  // withheld context. Same model/settings, only the context differs.
  withAnswer = runAgentTurn(
    gw,
    WITH_AGENT_ID,
    `${withBlock}\n\nQuestion: ${QUESTION}\n` +
      "Use the governed context above. Cite the source and give the corrected number."
  ).text;
  baseAnswer = runAgentTurn(
    gw,
    BASELINE_AGENT_ID,
    `${baseBlock}\n\nQuestion: ${QUESTION}`
  ).text;
}

// ── Assert + report ──────────────────────────────────────────────────────────

// WITH context must show BOTH signals; the baseline must show NEITHER.
const withCites = citesMigration(withAnswer);
const withCorrects = correctsNumber(withAnswer);
const withPass = withCites && withCorrects;
const baseCites = citesMigration(baseAnswer);
const baseCorrects = correctsNumber(baseAnswer);
const basePass = !baseCites && !baseCorrects;
const pass = withPass && basePass;

console.log(`=== Agent eval (${mode}) ===\n`);
console.log("(A) WITH context layer:");
console.log(indent(withAnswer));
console.log(
  `\n  → cites migration? ${withCites ? "YES" : "NO"}; corrects to ~${ADJUSTED_MARCH}? ${withCorrects ? "YES" : "NO"} ⇒ ${withPass ? "PASS ✅" : "FAIL ❌"}`
);
console.log("\n(B) WITHOUT context layer (baseline):");
console.log(indent(baseAnswer));
console.log(
  `\n  → cites migration? ${baseCites ? "YES" : "NO"}; corrects the number? ${baseCorrects ? "YES" : "NO"} ⇒ correctly has neither? ${basePass ? "PASS ✅" : "FAIL ❌"}`
);

console.log(
  `\n${pass ? "PASS ✅" : "FAIL ❌"} — pushing the context layer ${
    pass ? "changed" : "did NOT change"
  } the answer.`
);
if (mode === "deterministic-proxy") {
  console.log(
    "\n(This was the deterministic proxy: it proves the pushed context contains " +
      "the governed correction and the baseline does not. Wire a model provider " +
      "via `lobu agents inference-providers` and re-run for the live-agent eval.)"
  );
}

if (!pass) process.exitCode = 1;

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}
