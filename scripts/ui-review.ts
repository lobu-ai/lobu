#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentUiReviewProof,
  buildProofBody,
  COMPARE_FILE_CAP,
  findProofComment,
  isArtifactProof,
  isHttpsArtifact,
  isUnhostedRange,
  type OwlettoPullRequest,
  parseProof,
  permittedFluxTailParent,
  proofMatches,
  selectOwlettoPullRequest,
  type UiReviewComment,
  type UiReviewProof,
} from "./lib/ui-review-proof";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const STATUS_CONTEXT = "ui-review";
const PARENT_MARKER = "<!-- lobu-ui-review-marker -->";

interface PullRequestView {
  number: number;
  url: string;
  baseRefOid: string;
  headRefOid: string;
}

interface ApiComment extends UiReviewComment {
  id: number;
}

interface Options {
  artifactUrl?: string;
  open: boolean;
}

function run(command: string, args: string[], input?: string): string {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    input,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown error").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function jsonCommand<T>(command: string, args: string[], input?: string): T {
  const output = run(command, args, input);
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error(`${command} returned invalid JSON`);
  }
}

const GH_READ_ATTEMPTS = 6;
const TRANSIENT_GH_ERROR =
  /unexpected end of JSON input|HTTP 5\d\d|timed out|ECONNRESET|EOF/i;

function ghApi<T>(endpoint: string, method = "GET", payload?: unknown): T {
  const args = ["api"];
  let input: string | undefined;
  if (method !== "GET") args.push("-X", method);
  args.push(endpoint);
  if (payload !== undefined) {
    args.push("--input", "-");
    input = JSON.stringify(payload);
  }
  // GitHub intermittently answers read endpoints with an empty HTTP 500, which
  // gh surfaces as "unexpected end of JSON input". Retry reads a bounded number
  // of times; writes are never retried.
  const retryDelayMs = Number(process.env.UI_REVIEW_GH_RETRY_MS ?? "500");
  const attempts = method === "GET" ? GH_READ_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return jsonCommand<T>("gh", args, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts || !TRANSIENT_GH_ERROR.test(message)) throw error;
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        retryDelayMs * attempt
      );
    }
  }
}

function ghApiPages<T>(endpoint: string): T[] {
  const pages = jsonCommand<T[][]>("gh", [
    "api",
    endpoint,
    "--paginate",
    "--slurp",
  ]);
  return pages.flat();
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    artifactUrl: process.env.ARTIFACT?.trim() || undefined,
    open: ["1", "true", "yes"].includes((process.env.OPEN ?? "").toLowerCase()),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--artifact": {
        const value = argv[index + 1];
        if (!value) throw new Error("--artifact requires an HTTPS URL");
        options.artifactUrl = value;
        index += 1;
        break;
      }
      case "--open":
        options.open = true;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.artifactUrl && !isHttpsArtifact(options.artifactUrl)) {
    throw new Error("--artifact must be a hosted HTTPS URL, not a local path");
  }
  return options;
}

export function githubRepoFromRemote(remote: string): string {
  const normalized = remote
    .trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^ssh:\/\/git@github\.com\//, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  if (!/^[^/]+\/[^/]+$/.test(normalized)) {
    throw new Error(`unsupported GitHub remote: ${remote}`);
  }
  return normalized;
}

function postStatus(
  repo: string,
  sha: string,
  state: "pending" | "success" | "error",
  description: string,
  targetUrl: string
): void {
  ghApi(`repos/${repo}/statuses/${sha}`, "POST", {
    state,
    context: STATUS_CONTEXT,
    description: description.slice(0, 140),
    target_url: targetUrl,
  });
}

function findComment(
  repo: string,
  issue: number,
  marker: string
): ApiComment | undefined {
  return ghApiPages<ApiComment>(`repos/${repo}/issues/${issue}/comments`).find(
    (comment) => comment.body.startsWith(marker)
  );
}

function writeComment(
  repo: string,
  issue: number,
  existing: ApiComment | undefined,
  body: string
): ApiComment {
  if (existing) {
    return ghApi<ApiComment>(
      `repos/${repo}/issues/comments/${existing.id}`,
      "PATCH",
      { body }
    );
  }
  return ghApi<ApiComment>(`repos/${repo}/issues/${issue}/comments`, "POST", {
    body,
  });
}

function upsertComment(
  repo: string,
  issue: number,
  marker: string,
  body: string
): ApiComment {
  return writeComment(repo, issue, findComment(repo, issue, marker), body);
}

function getPointer(repo: string, commit: string): string {
  const content = ghApi<{ sha?: string; type?: string }>(
    `repos/${repo}/contents/packages/owletto?ref=${commit}`
  );
  if (content.type !== "submodule" || !content.sha) {
    throw new Error(`packages/owletto is not a submodule at ${commit}`);
  }
  return content.sha;
}

function openPullRequest(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const result = spawnSync(command, [url], { stdio: "ignore" });
  if (result.status !== 0) {
    console.warn(`Could not open the browser automatically. Open ${url}`);
  }
}

function resolveOwlettoPullRequest(
  repo: string,
  headPointer: string
): OwlettoPullRequest | null {
  let candidate = headPointer;
  // A short bounded walk handles consecutive Flux image bumps without ever
  // treating arbitrary commits as visual-review proof for a product PR.
  for (let depth = 0; depth < 20; depth += 1) {
    const pulls = ghApi<OwlettoPullRequest[]>(
      `repos/${repo}/commits/${candidate}/pulls`
    );
    const pull = selectOwlettoPullRequest(pulls, candidate);
    if (pull) return pull;

    const commit = ghApi<Parameters<typeof permittedFluxTailParent>[0]>(
      `repos/${repo}/commits/${candidate}`
    );
    const parent = permittedFluxTailParent(commit);
    if (!parent) return null;
    candidate = parent;
  }
  return null;
}

function parentCommentBody(
  proof: UiReviewProof,
  proofUrl: string,
  lobuHead: string
): string {
  return `${PARENT_MARKER}
**UI review recorded** for Lobu head \`${lobuHead}\`.

- Owletto range: \`${proof.lobu_base_owletto_sha}\` → \`${proof.owletto_sha}\`
- Proof: ${proofUrl}`;
}

interface CompareResponse {
  status?: string;
  files?: Array<{
    filename: string;
    previous_filename?: string;
    status?: string;
    patch?: string;
  }>;
  commits?: Array<{ commit: { message: string } }>;
}

interface AgentVerdict {
  has_ui_surface: boolean;
  reasoning: string;
  verification_summary: string;
  reviewer: string;
}

function buildAgentContext(
  comparison: CompareResponse,
  basePointer: string,
  headPointer: string
): string {
  const files = comparison.files ?? [];
  const lines: string[] = [
    `## Range ${basePointer}...${headPointer}`,
    "",
    "### Changed files",
    ...files.map((f) => `- ${f.status ?? "modified"}: ${f.filename}`),
    "",
    "### Commit messages (squash PR bodies)",
    ...(comparison.commits ?? []).map((c) => `---\n${c.commit.message}`),
    "",
    "### Unified diffs",
  ];
  for (const file of files) {
    if (!file.patch) continue;
    lines.push(`--- ${file.filename} ---`, file.patch, "");
  }
  return lines.join("\n");
}

/**
 * Ask an independent reviewer CLI (the same one `make review` uses — see
 * ui-review-agent.sh) whether this range has any user-visible UI surface at
 * all. Returns null on ANY failure (reviewer unavailable, non-zero exit,
 * invalid verdict) so the caller falls back to requiring a real ARTIFACT —
 * this must never be the thing that silently waves through a real UI change.
 * UI_REVIEW_AGENT_SCRIPT overrides the script path — test-only, so a command
 * test can point this at a fake without spawning a real reviewer CLI.
 */
function tryAgentClassification(
  comparison: CompareResponse,
  basePointer: string,
  headPointer: string
): AgentVerdict | null {
  if (process.env.UI_REVIEW_AGENT === "0") return null;
  // The classifier may only judge a range it can see in full. A non-"ahead"
  // comparison is not the pointer delta being proposed, and at GitHub's
  // COMPARE_FILE_CAP the file list is truncated — buildAgentContext would then
  // describe a partial range, letting a "no UI surface" verdict be returned by
  // an agent that never saw the UI files. Both fall through to requiring a real
  // ARTIFACT, matching the guarantees isUnhostedRange already demands.
  const files = comparison.files ?? [];
  if (
    comparison.status !== "ahead" ||
    files.length === 0 ||
    files.length >= COMPARE_FILE_CAP
  ) {
    return null;
  }
  // A file whose patch GitHub omitted is content this range changed but the
  // agent cannot read, so the verdict would rest on the filename alone.
  if (files.some((file) => !file.patch)) return null;
  const dir = mkdtempSync(join(tmpdir(), "lobu-ui-review-agent-"));
  try {
    const contextFile = join(dir, "context.md");
    const outFile = join(dir, "verdict.json");
    writeFileSync(
      contextFile,
      buildAgentContext(comparison, basePointer, headPointer)
    );
    const agentScript =
      process.env.UI_REVIEW_AGENT_SCRIPT ??
      join(SCRIPT_DIR, "ui-review-agent.sh");
    const result = spawnSync(agentScript, [contextFile, outFile], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      console.log(
        `ui-review: agent classification unavailable (${(result.stderr || result.stdout || "").trim().slice(0, 300)})`
      );
      return null;
    }
    return JSON.parse(readFileSync(outFile, "utf8")) as AgentVerdict;
  } catch (error) {
    console.log(
      `ui-review: agent classification failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(): number {
  const options = parseOptions(process.argv.slice(2));
  const localHead = run("git", ["rev-parse", "HEAD"]);
  const lobuRepo = run("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
  const parentPr = jsonCommand<PullRequestView>("gh", [
    "pr",
    "view",
    "--json",
    "number,url,baseRefOid,headRefOid",
  ]);
  if (parentPr.headRefOid !== localHead) {
    throw new Error(
      `local HEAD ${localHead} is not PR #${parentPr.number} head ${parentPr.headRefOid}; update the branch first`
    );
  }
  postStatus(
    lobuRepo,
    localHead,
    "pending",
    "UI review in progress",
    parentPr.url
  );

  const owlettoRemote = run("git", [
    "config",
    "-f",
    ".gitmodules",
    "--get",
    "submodule.packages/owletto.url",
  ]);
  const owlettoRepo = githubRepoFromRemote(owlettoRemote);

  // The target branch can advance independently; review only this PR's range.
  // Filter in gh so a large parent diff cannot overflow the subprocess buffer.
  const mergeBase = run("gh", [
    "api",
    `repos/${lobuRepo}/compare/${parentPr.baseRefOid}...${parentPr.headRefOid}`,
    "--jq",
    ".merge_base_commit.sha // empty",
  ]);
  if (!mergeBase)
    throw new Error("GitHub comparison did not return a merge base");
  const basePointer = getPointer(lobuRepo, mergeBase);
  const headPointer = getPointer(lobuRepo, parentPr.headRefOid);
  if (basePointer === headPointer) {
    const parentComment = findComment(lobuRepo, parentPr.number, PARENT_MARKER);
    if (parentComment) {
      ghApi(`repos/${lobuRepo}/issues/comments/${parentComment.id}`, "PATCH", {
        body: `${PARENT_MARKER}
**UI review not applicable** for Lobu head \`${localHead}\`.

\`packages/owletto\` remains at \`${headPointer}\`.`,
      });
    }
    postStatus(
      lobuRepo,
      localHead,
      "success",
      "No Owletto pointer change",
      parentPr.url
    );
    console.log(
      `ui-review: not applicable; packages/owletto remains ${headPointer}`
    );
    return 0;
  }

  const owlettoPr = resolveOwlettoPullRequest(owlettoRepo, headPointer);
  if (!owlettoPr) {
    postStatus(
      lobuRepo,
      localHead,
      "error",
      "Owletto pointer has no reviewable merged product PR",
      parentPr.url
    );
    throw new Error(
      `Owletto ${headPointer} is neither a merged ${owlettoRepo} PR squash commit nor a permitted Flux deploy-only tail`
    );
  }

  const comparison = ghApi<CompareResponse>(
    `repos/${owlettoRepo}/compare/${basePointer}...${headPointer}`
  );
  const rangeFiles = comparison.files ?? [];
  if (comparison.status === "ahead" && isUnhostedRange(rangeFiles)) {
    const parentComment = findComment(lobuRepo, parentPr.number, PARENT_MARKER);
    if (parentComment) {
      ghApi(`repos/${lobuRepo}/issues/comments/${parentComment.id}`, "PATCH", {
        body: `${PARENT_MARKER}
**UI review not applicable** for Lobu head \`${localHead}\`.

\`${basePointer}...${headPointer}\` changes only unhosted trees (${rangeFiles.length} files, through Owletto #${owlettoPr.number}).`,
      });
    }
    postStatus(
      lobuRepo,
      localHead,
      "success",
      `Owletto ${basePointer.slice(0, 9)}...${headPointer.slice(0, 9)} touches only unhosted trees; no hosted UI to prove`,
      owlettoPr.html_url
    );
    console.log(
      `ui-review: not applicable; Owletto ${basePointer.slice(0, 9)}...${headPointer.slice(0, 9)} changes only unhosted trees (${rangeFiles.length} files)`
    );
    if (options.open) openPullRequest(owlettoPr.html_url);
    return 0;
  }

  const comments = ghApiPages<ApiComment>(
    `repos/${owlettoRepo}/issues/${owlettoPr.number}/comments`
  );
  let proofComment = findProofComment(comments, lobuRepo, parentPr.number);
  let currentProof = proofComment ? parseProof(proofComment.body) : null;
  const exactProof =
    currentProof &&
    proofMatches(
      currentProof,
      lobuRepo,
      basePointer,
      headPointer,
      parentPr.number,
      owlettoPr.number
    );

  const currentArtifactUrl =
    currentProof && isArtifactProof(currentProof)
      ? currentProof.artifact_url
      : undefined;

  if (
    !exactProof ||
    (options.artifactUrl && currentArtifactUrl !== options.artifactUrl)
  ) {
    if (!options.artifactUrl) {
      // No screenshot supplied — ask an independent reviewer whether this
      // range has any UI surface at all before demanding one. Fails closed:
      // any classification failure, or a `true` verdict, falls through to
      // the existing ARTIFACT-required error unchanged.
      const verdict = tryAgentClassification(
        comparison,
        basePointer,
        headPointer
      );
      if (verdict && verdict.has_ui_surface === false) {
        const agentProof: AgentUiReviewProof = {
          version: 1,
          lobu_repo: lobuRepo,
          lobu_pr: parentPr.number,
          lobu_base_owletto_sha: basePointer,
          owletto_sha: headPointer,
          owletto_pr: owlettoPr.number,
          no_ui_surface: true,
          reviewer: verdict.reviewer,
          reasoning: verdict.reasoning,
          verification_summary: verdict.verification_summary,
        };
        currentProof = agentProof;
        proofComment = writeComment(
          owlettoRepo,
          owlettoPr.number,
          proofComment,
          buildProofBody(agentProof)
        );
      } else {
        postStatus(
          lobuRepo,
          localHead,
          "error",
          "UI proof missing; rerun make ui-review with ARTIFACT=...",
          owlettoPr.html_url
        );
        if (options.open) openPullRequest(owlettoPr.html_url);
        throw new Error(
          `No current proof on ${owlettoPr.html_url}. Rerun with ARTIFACT=<hosted HTTPS comparison>.`
        );
      }
    } else {
      currentProof = {
        version: 1,
        lobu_repo: lobuRepo,
        lobu_pr: parentPr.number,
        lobu_base_owletto_sha: basePointer,
        owletto_sha: headPointer,
        owletto_pr: owlettoPr.number,
        artifact_url: options.artifactUrl,
      };
      proofComment = writeComment(
        owlettoRepo,
        owlettoPr.number,
        proofComment,
        buildProofBody(currentProof)
      );
    }
  }

  if (!currentProof || !proofComment) {
    throw new Error("UI proof publication did not return a usable comment");
  }

  // The proof is the deliverable: the before/after page is published on the
  // exact merged Owletto PR and linked from the parent, binding the evidence to
  // this pointer pair. Publishing it is what the gate now asserts — a human
  // reviews it on the PR like any other change, rather than blocking the check
  // behind a separate approval comment.
  upsertComment(
    lobuRepo,
    parentPr.number,
    PARENT_MARKER,
    parentCommentBody(currentProof, proofComment.html_url, localHead)
  );
  postStatus(
    lobuRepo,
    localHead,
    "success",
    `UI proof recorded for Owletto ${headPointer.slice(0, 9)}`,
    proofComment.html_url
  );

  console.log(`ui-review: proof recorded at ${proofComment.html_url}`);
  if (options.open) openPullRequest(owlettoPr.html_url);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
