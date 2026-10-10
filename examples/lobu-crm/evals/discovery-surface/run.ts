/**
 * Discovery-surface eval runner.
 *
 * For each task × trial: seed a FRESH org with the minimal starting state, build
 * the Gemini discovery agent (default cloud MCP surface only), run the bare
 * intent, collect metrics from the agent event stream, then run the
 * deterministic state check + (for read tasks) the reply check.
 *
 * MUST run under node@22 (isolated-vm loads there, not under Bun). Use run.sh,
 * which sources GEMINI_API_KEY from the repo .env and invokes node@22 + tsx.
 *
 * Usage (via run.sh):
 *   ./run.sh [--trials N] [--tasks id,id]
 *
 * Metrics per cell:
 *   - statePass (DB-state check), replyPass (reply names right facts | null)
 *   - discovered (did it call search_sdk at all)
 *   - toolCalls, erroredCalls (arg fumbles / handler errors), maxIdenticalRun
 *   - rankOfFirstWrite (1-based index of the first run_sdk/query_sql/save_memory
 *     among tool calls — a proxy for "reached the right tool", -1 if never)
 *   - turns, elapsedMs, failNote
 *
 * Real Gemini calls only. No mocked model.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildDiscoveryAgent,
  GEMINI_MODEL_ID,
  type BuiltSession,
} from "./driver";
import { ensureMigrated, freshOrg, type SessionScope } from "./scenario";
import { replyCheck, TASKS, type EvalTask } from "./tasks";

interface CellMetrics {
  taskId: string;
  trial: number;
  statePass: boolean;
  replyPass: boolean | null;
  pass: boolean;
  discovered: boolean;
  toolCalls: number;
  erroredCalls: number;
  maxIdenticalRun: number;
  rankOfFirstWrite: number;
  turns: number;
  elapsedMs: number;
  stateDetail: string;
  replyDetail: string;
  failNote: string;
}

function parseArgs(): {
  trials: number;
  tasks: string[];
  scope: SessionScope;
} {
  const args = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1]! : def;
  };
  const trials = Number(get("--trials", "2"));
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error(
      `--trials must be a positive integer, got "${get("--trials", "2")}"`
    );
  }
  const scopeRaw = get("--scope", "admin");
  if (scopeRaw !== "admin" && scopeRaw !== "default") {
    throw new Error(`--scope must be admin|default, got "${scopeRaw}"`);
  }
  return {
    trials,
    tasks: get("--tasks", "").split(",").filter(Boolean),
    scope: scopeRaw,
  };
}

function lastAssistantText(session: BuiltSession["session"]): string {
  const msgs = session.agent.state.messages as Array<{
    role: string;
    content: unknown;
  }>;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== "assistant") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const text = c
        .filter((b: unknown) => (b as { type?: string }).type === "text")
        .map((b: unknown) => (b as { text?: string }).text ?? "")
        .join(" ");
      if (text.trim()) return text;
    }
  }
  return "";
}

/** Tool names that indicate the agent reached an execution/read surface. */
const WRITE_TOOLS = new Set([
  "run_sdk",
  "query_sdk",
  "query_sql",
  "save_memory",
]);

async function runCell(
  task: EvalTask,
  trial: number,
  scope: SessionScope
): Promise<CellMetrics> {
  const org = await freshOrg(`disc-${task.id}-${trial}-${Date.now()}`, scope);
  const seeded = await task.seed(org);
  const built = await buildDiscoveryAgent(org);

  let toolCalls = 0;
  let erroredCalls = 0;
  let turns = 0;
  let discovered = false;
  let rankOfFirstWrite = -1;
  const callSig: string[] = [];
  built.session.subscribe((ev: { type: string; [k: string]: unknown }) => {
    if (ev.type === "tool_execution_start") {
      toolCalls++;
      const name = String(ev.toolName);
      if (name === "search_sdk") discovered = true;
      if (rankOfFirstWrite === -1 && WRITE_TOOLS.has(name)) {
        rankOfFirstWrite = toolCalls;
      }
      callSig.push(`${name}:${JSON.stringify(ev.args ?? {})}`);
    } else if (ev.type === "tool_execution_end") {
      if (ev.isError) erroredCalls++;
    } else if (ev.type === "turn_start") {
      turns++;
    }
  });

  const t0 = Date.now();
  let failNote = "";
  try {
    await Promise.race([
      built.session.prompt(task.prompt(seeded)),
      new Promise((_r, rej) =>
        setTimeout(() => rej(new Error("turn timeout (240s)")), 240_000)
      ),
    ]);
  } catch (err) {
    failNote = err instanceof Error ? err.message : String(err);
  }
  const elapsedMs = Date.now() - t0;

  let maxIdenticalRun = callSig.length === 0 ? 0 : 1;
  let cur = 1;
  for (let i = 1; i < callSig.length; i++) {
    if (callSig[i] === callSig[i - 1]) {
      cur++;
      maxIdenticalRun = Math.max(maxIdenticalRun, cur);
    } else cur = 1;
  }

  const reply = lastAssistantText(built.session);
  const stateRes = await task.check(org, seeded);
  const replyRes = replyCheck(task.id, reply, seeded);
  const replyPass = replyRes ? replyRes.pass : null;

  // Tier-aware scoring. Under `default` (member `mcp:read mcp:write`) scope, an
  // `admin`-tier task's WRITE is legitimately blocked — completing it is
  // impossible by design, so counting a non-completion as a discovery failure
  // would be wrong. Instead score it a PASS when the agent DISCOVERED the right
  // operation and correctly ran into the admin gate (state not mutated + an
  // admin-access denial surfaced), and note it as "correctly-blocked".
  const tier = task.tier ?? "member-write";
  const blockedByScope =
    scope === "default" &&
    tier === "admin" &&
    !stateRes.pass &&
    discovered &&
    /admin (access|or owner)|requires .*admin|not a function|not available/i.test(
      `${failNote} ${reply}`
    );
  const pass = blockedByScope
    ? true
    : stateRes.pass && (replyPass === null || replyPass === true);
  if (blockedByScope) {
    failNote = failNote
      ? `${failNote} [correctly blocked: admin-tier under default scope]`
      : "correctly blocked: admin-tier under default scope";
  }

  return {
    taskId: task.id,
    trial,
    statePass: stateRes.pass,
    replyPass,
    pass,
    discovered,
    toolCalls,
    erroredCalls,
    maxIdenticalRun,
    rankOfFirstWrite,
    turns,
    elapsedMs,
    stateDetail: stateRes.detail,
    replyDetail: replyRes?.detail ?? "",
    failNote,
  };
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((100 * n) / d)}%`;
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error(
      "BLOCKER: GEMINI_API_KEY not set — cannot run real Gemini. Use run.sh (sources .env)."
    );
    process.exit(2);
  }
  await ensureMigrated();

  const opts = parseArgs();
  if (opts.tasks.length) {
    const known = new Set(TASKS.map((t) => t.id));
    const unknown = opts.tasks.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new Error(
        `--tasks has unknown id(s): ${unknown.join(", ")}. Known: ${[...known].join(", ")}`
      );
    }
  }
  const tasks = opts.tasks.length
    ? TASKS.filter((t) => opts.tasks.includes(t.id))
    : TASKS;

  console.log(
    `\n=== MCP discovery-surface eval: ${GEMINI_MODEL_ID} via gemini ===\n` +
      `scope=${opts.scope} tasks=${tasks.map((t) => t.id).join(",")} trials=${opts.trials}\n`
  );

  const all: CellMetrics[] = [];
  for (const task of tasks) {
    for (let trial = 1; trial <= opts.trials; trial++) {
      process.stdout.write(`running ${task.id} trial ${trial}... `);
      const m = await runCell(task, trial, opts.scope);
      all.push(m);
      console.log(
        `${m.pass ? "PASS" : "FAIL"} ` +
          `(disc=${m.discovered ? "y" : "n"} calls=${m.toolCalls} err=${m.erroredCalls} ` +
          `firstWrite=${m.rankOfFirstWrite} turns=${m.turns} ${(m.elapsedMs / 1000).toFixed(0)}s)` +
          `${m.failNote ? ` [${m.failNote}]` : ""}`
      );
    }
  }

  // Per-cell table.
  console.log("\n\n## Per-cell results\n");
  console.log(
    "| task | trial | pass | state | reply | disc | calls | fumbles | firstWrite | turns | sec | detail |"
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const m of all) {
    const detail =
      `${m.stateDetail}${m.replyDetail ? `; ${m.replyDetail}` : ""}`
        .replace(/\|/g, "/")
        .slice(0, 70);
    console.log(
      `| ${m.taskId} | ${m.trial} | ${m.pass ? "✅" : "❌"} | ${m.statePass ? "✅" : "❌"} | ${m.replyPass === null ? "—" : m.replyPass ? "✅" : "❌"} | ${m.discovered ? "y" : "n"} | ${m.toolCalls} | ${m.erroredCalls} | ${m.rankOfFirstWrite} | ${m.turns} | ${(m.elapsedMs / 1000).toFixed(0)} | ${detail} |`
    );
  }

  // Per-task summary.
  console.log("\n\n## Summary by task\n");
  console.log(
    "| task | pass rate | discovered rate | mean calls | mean fumbles |"
  );
  console.log("|---|---|---|---|---|");
  for (const task of tasks) {
    const cells = all.filter((m) => m.taskId === task.id);
    if (cells.length === 0) continue;
    const passes = cells.filter((m) => m.pass).length;
    const disc = cells.filter((m) => m.discovered).length;
    const meanCalls = (
      cells.reduce((s, m) => s + m.toolCalls, 0) / cells.length
    ).toFixed(1);
    const meanErr = (
      cells.reduce((s, m) => s + m.erroredCalls, 0) / cells.length
    ).toFixed(1);
    console.log(
      `| ${task.id} | ${pct(passes, cells.length)} (${passes}/${cells.length}) | ${pct(disc, cells.length)} | ${meanCalls} | ${meanErr} |`
    );
  }

  // Overall.
  console.log("\n\n## Overall\n");
  const passes = all.filter((m) => m.pass).length;
  const totalCalls = all.reduce((s, m) => s + m.toolCalls, 0);
  const totalErr = all.reduce((s, m) => s + m.erroredCalls, 0);
  const disc = all.filter((m) => m.discovered).length;
  console.log(
    "| model | pass rate | discovered rate | mean calls | fumble rate | mean turns | mean sec |"
  );
  console.log("|---|---|---|---|---|---|---|");
  console.log(
    `| ${GEMINI_MODEL_ID} | ${pct(passes, all.length)} (${passes}/${all.length}) | ${pct(disc, all.length)} | ${(totalCalls / all.length).toFixed(1)} | ${pct(totalErr, totalCalls)} (${totalErr}/${totalCalls}) | ${(all.reduce((s, m) => s + m.turns, 0) / all.length).toFixed(1)} | ${(all.reduce((s, m) => s + m.elapsedMs, 0) / all.length / 1000).toFixed(0)} |`
  );

  writeFileSync(
    fileURLToPath(new URL("./last-run.json", import.meta.url)),
    JSON.stringify(all, null, 2)
  );
  console.log("\nWrote raw metrics to last-run.json\n");
  process.exit(passes === all.length ? 0 : 1);
}

main();
