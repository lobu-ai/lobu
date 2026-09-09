#!/usr/bin/env node
// Prevent new, unsuppressed per-feature LLM transports in packages/server.
// Suggestion chips and query rewriting share gateway-completion.ts. The
// existing fail-closed egress judge remains explicitly suppressed pending its
// own migration and red→green coverage.
//
// COVERAGE (textual, deliberately — see HONEST GAP):
//   1. `fetch(...)` whose URL expression mentions a completions-style path
//      (/chat/completions, /v1/messages, /completions, /responses).
//   2. Importing a vendor SDK (@anthropic-ai/sdk, openai, @google/generative-ai,
//      @mistralai/*, cohere-ai, groq-sdk, replicate) anywhere outside the
//      allowlisted module.
//   3. Declaring a new per-feature credential triple: an identifier or string
//      matching <PREFIX>_API_KEY where a sibling <PREFIX>_BASE_URL or
//      <PREFIX>_MODEL also appears in the same file.
//
// HONEST GAP: this is textual, not type-aware — a call assembled through enough
// indirection (a URL built far from the fetch, an SDK re-exported by a local
// module) will not be caught. The durable backstop for those is review plus the
// fact that a NEW credential triple is itself flagged, and a hand-rolled client
// needs credentials from somewhere. It does not scan packages outside
// packages/server; connector-worker legitimately owns agent-turn model routing.
//
// Escape hatch: put `gateway-llm-ok` in a comment on the flagged line (or the
// line above) with a reason.
//
// No DB, no build — pure static text analysis.
// Run: `node scripts/check-gateway-llm-calls.mjs`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_SRC = join(REPO_ROOT, "packages/server/src");

// The ONE module allowed to speak HTTP to a model provider. Its whole job is
// being that seam, so it necessarily contains the patterns this gate forbids.
const ALLOWED_CLIENT =
  "packages/server/src/gateway/inference/gateway-completion.ts";

// `gateway/auth/**` is a DIFFERENT concern and is exempt from the credential-
// triple rule (it is still subject to the fetch + SDK rules). Those modules
// hand a credential to the agent's own CLI subprocess — they build the env a
// spawned `claude`/`codex` process reads, so naming ANTHROPIC_API_KEY /
// OPENAI_API_KEY is their whole job, not a hand-rolled transport. The gate is
// about the SERVER calling a model itself; forwarding a credential to the run
// path is exactly what it should keep doing.
const CREDENTIAL_RULE_EXEMPT_DIRS = ["packages/server/src/gateway/auth/"];

// Vendor SDKs that imply a hand-rolled, provider-pinned transport.
const VENDOR_SDKS = [
  "@anthropic-ai/sdk",
  "openai",
  "@google/generative-ai",
  "@google/genai",
  "cohere-ai",
  "groq-sdk",
  "replicate",
  "@mistralai/mistralai",
];

// Completion-ish endpoint paths. `/embeddings` is deliberately ABSENT: the
// embeddings package owns that path and it is not a chat completion.
const COMPLETION_PATHS = [
  "/chat/completions",
  "/v1/messages",
  "/responses",
  "/completions",
];

const violations = [];

/**
 * Suppressed if the flagged line carries `gateway-llm-ok`, or if the comment
 * block immediately above it does. Scanning the WHOLE contiguous comment block
 * (rather than just the previous line) is deliberate: a suppression is required
 * to state its reason, and a real reason rarely fits on one line — a
 * single-line window would push authors toward terse, uninformative excuses.
 * The scan stops at the first non-comment line, so it cannot reach across an
 * unrelated statement into some earlier block's marker.
 */
function isSuppressed(lines, idx) {
  if (/gateway-llm-ok/.test(lines[idx] ?? "")) return true;
  for (let i = idx - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    const isComment =
      line.startsWith("//") || line.startsWith("*") || line.startsWith("/*");
    if (!isComment) return false;
    if (/gateway-llm-ok/.test(line)) return true;
  }
  return false;
}

function stripComments(line) {
  return line
    .replace(/\/\*\*?.*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/, "$1")
    .replace(/^\s*\*.*$/, "")
    .replace(/^\s*\/\*.*$/, "");
}

/**
 * Code in the statement that STARTS at `idx`, spanning however many physical
 * lines it takes to close — balanced `(`/`{` for a call or import clause, or a
 * terminating `;`. Comments are removed so prose inside a multiline statement
 * cannot become a violation.
 *
 * Why not just the one line: prettier/biome split any construct that exceeds
 * the print width, so the real-world violations are
 *
 *   return fetch(                  import {
 *     "https://host/v1/chat/completions",   OpenAI,
 *   );                             } from "openai";
 *
 * where no single line holds both the keyword and the literal the rule looks
 * for. A line-local check was therefore weakest at exactly the shape a
 * formatter produces. Depth counting stops at the matching close so an
 * unrelated later statement cannot be dragged in, and a bounded lookahead
 * keeps a malformed file from scanning to EOF.
 */
function statementText(lines, idx) {
  const MAX_STATEMENT_LINES = 40;
  let depth = 0;
  let opened = false;
  let inBlockComment = false;
  const parts = [];
  for (let i = idx; i < lines.length && i < idx + MAX_STATEMENT_LINES; i++) {
    const line = lines[i];
    let code = "";
    let j = 0;
    while (j < line.length) {
      if (inBlockComment) {
        const closeIdx = line.indexOf("*/", j);
        if (closeIdx !== -1) {
          inBlockComment = false;
          j = closeIdx + 2;
        } else {
          break;
        }
      } else {
        if (line.startsWith("/*", j)) {
          inBlockComment = true;
          j += 2;
        } else if (
          line.startsWith("//", j) &&
          (j === 0 || line[j - 1] !== ":")
        ) {
          break;
        } else {
          code += line[j];
          j++;
        }
      }
    }
    parts.push(code);
    for (const ch of code) {
      if (ch === "(" || ch === "{") {
        depth++;
        opened = true;
      } else if (ch === ")" || ch === "}") {
        depth--;
      }
    }
    // A statement with no bracket at all (`import "openai";`) ends at its
    // semicolon; one that opened brackets ends when they balance.
    if (opened && depth <= 0) break;
    if (!opened && code.includes(";")) break;
  }
  return parts.join("\n");
}

function flag(file, lineNo, kind, snippet) {
  violations.push({
    file: relative(REPO_ROOT, file),
    line: lineNo,
    kind,
    snippet: snippet.trim().replace(/\s+/g, " ").slice(0, 100),
  });
}

/**
 * Find `<PREFIX>_API_KEY` occurrences that have a sibling `<PREFIX>_BASE_URL`
 * or `<PREFIX>_MODEL` in the same file — the signature of a new per-feature
 * credential triple. A lone `*_API_KEY` is NOT flagged: plenty of legitimate
 * non-LLM integrations carry one.
 */
function findCredentialTriples(text) {
  const keys = new Set();
  const siblings = new Set();
  for (const m of text.matchAll(
    /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)_API_KEY\b/g
  )) {
    keys.add(m[1]);
  }
  for (const m of text.matchAll(
    /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)_(?:BASE_URL|MODEL)\b/g
  )) {
    siblings.add(m[1]);
  }
  return [...keys].filter((k) => siblings.has(k));
}

/**
 * Walk for `.ts`/`.tsx` under `dir`.
 *
 * Hand-rolled rather than `fs.globSync`: that landed in Node 22.0 as
 * experimental and this repo's CI pins Node 22, where importing it throws
 * `does not provide an export named 'globSync'` — the gate then fails every
 * run for a reason that has nothing to do with the code it guards. `readdirSync`
 * with `withFileTypes` is stable across every version we support.
 */
function collectSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

let scannedCount = 0;
const files = collectSourceFiles(SERVER_SRC);

for (const file of files) {
  const rel = relative(REPO_ROOT, file);
  if (rel === ALLOWED_CLIENT) continue;
  // Tests legitimately construct fake upstreams and stub vendor clients.
  if (rel.includes("/__tests__/")) continue;
  if (file.endsWith(".d.ts")) continue;
  scannedCount++;

  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");

  const credentialRuleApplies = !CREDENTIAL_RULE_EXEMPT_DIRS.some((d) =>
    rel.startsWith(d)
  );
  const triples = credentialRuleApplies ? findCredentialTriples(text) : [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Strip comments so prose ABOUT the old design (a historical note, a
    // migration comment, a doc block naming the env var a module forwards)
    // does not trip the gate. Covers `// …`, a jsdoc continuation line `* …`,
    // and a single-line `/** … */`.
    //
    // The `//` rule must NOT fire on a scheme separator: stripping from the
    // `//` in `https://api.example/chat/completions` truncates the line to
    // `const u = "https:` and the literal URL — the most obvious way to
    // hand-roll a call — sails straight through. Require the `//` to be at
    // line start or preceded by something other than `:`.
    const code = stripComments(line);
    if (!code.trim()) continue;
    if (isSuppressed(lines, i)) continue;

    // 1. fetch() to a completions-style path.
    //
    // Match against the whole call expression, not the single physical line:
    // a formatter routinely splits `fetch(` from its URL argument, and a
    // line-local check silently exempted that — the most likely shape the
    // violation actually gets written in.
    if (/\bfetch\s*\(/.test(code)) {
      const callText = statementText(lines, i);
      for (const p of COMPLETION_PATHS) {
        if (callText.includes(p)) {
          flag(file, i + 1, "hand-rolled completion fetch", line);
          break;
        }
      }
    }

    // 2. Vendor SDK import.
    if (/\b(?:import|require)\b/.test(code)) {
      // Whole statement, not the line: `import {\n ... \n} from "openai"` is
      // the shape a formatter produces, and it carried the module literal on a
      // line with no `import` keyword on it.
      const importText = statementText(lines, i);
      for (const sdk of VENDOR_SDKS) {
        if (
          importText.includes(`"${sdk}"`) ||
          importText.includes(`'${sdk}'`) ||
          importText.includes(`"${sdk}/`) ||
          importText.includes(`'${sdk}/`)
        ) {
          flag(file, i + 1, `vendor SDK import (${sdk})`, line);
          break;
        }
      }
    }

    // 3. New per-feature credential triple.
    for (const prefix of triples) {
      if (code.includes(`${prefix}_API_KEY`)) {
        flag(file, i + 1, `per-feature credential triple (${prefix}_*)`, line);
        break;
      }
    }
  }
}

// Guard against a vacuous green: if the glob ever stops matching, the loop
// scans nothing and would report "clean" — silently disabling the gate.
if (!existsSync(SERVER_SRC)) {
  console.error(`✗ expected ${SERVER_SRC} to exist`);
  process.exit(1);
}
if (scannedCount === 0) {
  console.error(
    "✗ gateway-llm gate scanned ZERO packages/server/src files — the glob likely\n" +
      "  regressed. A clean result here would be vacuous; failing instead."
  );
  process.exit(1);
}
if (!existsSync(join(REPO_ROOT, ALLOWED_CLIENT))) {
  console.error(
    `✗ gateway-llm gate: the shared client ${ALLOWED_CLIENT} is missing.\n` +
      "  Unsuppressed gateway LLM calls are supposed to route through it; if it moved,\n" +
      "  update ALLOWED_CLIENT in scripts/check-gateway-llm-calls.mjs."
  );
  process.exit(1);
}

if (violations.length) {
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  console.error(`\n✗ gateway-llm gate failed (${violations.length}):\n`);
  for (const v of violations) {
    console.error(`  - ${v.file}:${v.line}  [${v.kind}]`);
    console.error(`      ${v.snippet}`);
  }
  console.error(
    "\nNew packages/server LLM calls go through\n" +
      "  gateway/inference/gateway-completion.ts\n" +
      "Do not add a per-feature *_API_KEY / *_BASE_URL / *_MODEL triple or a\n" +
      "second vendor client.\n\n" +
      "If a case is genuinely safe, add a `gateway-llm-ok` comment WITH A REASON\n" +
      "on the flagged line. See scripts/check-gateway-llm-calls.mjs.\n"
  );
  process.exit(1);
}

console.log(
  `✓ gateway-llm gate: ${scannedCount} packages/server/src files contain no unsuppressed one-off LLM client`
);
