import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildProofBody } from "../lib/ui-review-proof";

const UI_REVIEW_SCRIPT = resolve(import.meta.dir, "..", "ui-review.ts");
const BASE_POINTER = "1".repeat(40);
const HEAD_POINTER = "2".repeat(40);
const PRODUCT_POINTER = "4".repeat(40);
const BASE_COMMIT = "a".repeat(40);

interface MockState {
  comments: Record<string, Array<Record<string, unknown>>>;
  calls: Array<{
    endpoint: string;
    method: string;
    payload: Record<string, unknown>;
  }>;
  opened?: string;
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function command(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function createFixture(): {
  repo: string;
  bin: string;
  stateFile: string;
  head: string;
} {
  const root = mkdtempSync(join(tmpdir(), "lobu-ui-review-test-"));
  temporaryDirectories.push(root);
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const stateFile = join(root, "state.json");
  command(root, ["git", "init", "-q", repo]);
  command(repo, ["git", "config", "user.email", "test@example.com"]);
  command(repo, ["git", "config", "user.name", "Test"]);
  writeFileSync(
    join(repo, ".gitmodules"),
    '[submodule "packages/owletto"]\n\tpath = packages/owletto\n\turl = https://github.com/lobu-ai/owletto.git\n'
  );
  command(repo, ["git", "add", ".gitmodules"]);
  command(repo, ["git", "commit", "-q", "-m", "fixture"]);
  const head = command(repo, ["git", "rev-parse", "HEAD"]);
  writeFileSync(
    stateFile,
    JSON.stringify({ comments: {}, calls: [] } satisfies MockState)
  );
  command(root, ["mkdir", "-p", bin]);

  const mockGh = `#!/usr/bin/env bun
const args = process.argv.slice(2);
const stateFile = process.env.MOCK_STATE_FILE;
const state = JSON.parse(await Bun.file(stateFile).text());
const writeState = () => Bun.write(stateFile, JSON.stringify(state));
const output = (value) => process.stdout.write(JSON.stringify(value));

if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write("lobu-ai/lobu");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  output({
    number: 2500,
    url: "https://github.com/lobu-ai/lobu/pull/2500",
    baseRefOid: process.env.MOCK_BASE_COMMIT,
    headRefOid: process.env.MOCK_HEAD_COMMIT,
  });
  process.exit(0);
}
if (args[0] !== "api") process.exit(90);

const endpoint = args.find((arg) => arg.startsWith("repos/"));
const methodIndex = args.indexOf("-X");
const method = methodIndex === -1 ? "GET" : args[methodIndex + 1];
const input = await new Response(Bun.stdin.stream()).text();
const payload = input ? JSON.parse(input) : {};
state.calls.push({ endpoint, method, payload });

if (
  process.env.MOCK_FAIL_OWLETTO_COMMENTS === "1" &&
  endpoint === "repos/lobu-ai/owletto/issues/712/comments" &&
  method === "GET"
) {
  await writeState();
  console.error("mock comments failure");
  process.exit(92);
}

if (endpoint.startsWith("repos/lobu-ai/lobu/compare/")) {
  const mergeBase = process.env.MOCK_MISSING_MERGE_BASE === "1"
    ? undefined : { sha: process.env.MOCK_MERGE_BASE_COMMIT || process.env.MOCK_BASE_COMMIT };
  const jqIndex = args.indexOf("--jq");
  if (jqIndex !== -1) {
    if (args[jqIndex + 1] !== ".merge_base_commit.sha // empty") process.exit(93);
    process.stdout.write(mergeBase?.sha ?? "");
  } else {
    output({
      merge_base_commit: mergeBase,
      files: process.env.MOCK_LARGE_PARENT_COMPARISON === "1"
        ? [{ filename: "bun.lock", patch: "x".repeat(2 * 1024 * 1024) }] : [],
    });
  }
} else if (endpoint.includes("/contents/packages/owletto?ref=")) {
  const sha = process.env.MOCK_MERGE_BASE_COMMIT && endpoint.endsWith(process.env.MOCK_MERGE_BASE_COMMIT)
    ? process.env.MOCK_MERGE_BASE_POINTER
    : endpoint.endsWith(process.env.MOCK_BASE_COMMIT)
      ? process.env.MOCK_BASE_POINTER
      : process.env.MOCK_HEAD_POINTER;
  output({ type: "submodule", sha });
} else if (endpoint.includes("/commits/") && endpoint.endsWith("/pulls")) {
  const allowedFailures = Number(process.env.MOCK_PULLS_FAILURES || "0");
  state.pullsFailures = (state.pullsFailures || 0) + 1;
  if (state.pullsFailures <= allowedFailures) {
    await writeState();
    console.error("unexpected end of JSON input");
    process.exit(1);
  }
  const candidate = endpoint.split("/commits/")[1].split("/pulls")[0];
  const squash = process.env.MOCK_FLUX_TAIL === "1"
    ? process.env.MOCK_PRODUCT_POINTER
    : process.env.MOCK_HEAD_POINTER;
  output(candidate === squash ? [{
      number: 712,
      html_url: "https://github.com/lobu-ai/owletto/pull/712",
      merge_commit_sha: squash,
      merged_at: "2026-08-04T10:00:00Z",
    }] : []);
} else if (endpoint.includes("/commits/")) {
  output({
    commit: {
      author: { email: "fluxcd@lobu.ai" },
      message: "chore: update images",
    },
    files: [{ filename: "deploy/k8s/apps/lobu/base/helmrelease.yaml" }],
    parents: [{ sha: process.env.MOCK_PRODUCT_POINTER }],
  });
} else if (endpoint.startsWith("repos/lobu-ai/owletto/compare/")) {
  output({
    status: process.env.MOCK_COMPARE_STATUS || "ahead",
    // Default every mocked file to a readable patch. The agent classifier only
    // judges ranges whose content it can actually see, so a fixture without
    // patches would exercise the refusal path rather than the case under test.
    files: JSON.parse(
      process.env.MOCK_OWLETTO_FILES || '[{"filename":"src/app.tsx"}]'
    ).map((file) => ({ patch: "@@ -1 +1 @@\\n-old\\n+new", ...file })),
  });
} else if (endpoint.includes("/collaborators/") && endpoint.endsWith("/permission")) {
  output({ permission: "admin" });
} else if (endpoint.includes("/statuses/") && method === "POST") {
  output(payload);
} else if (new RegExp("/issues/[0-9]+/comments$").test(endpoint)) {
  if (method === "GET") {
    output([state.comments[endpoint] || []]);
  } else {
    const comments = state.comments[endpoint] || [];
    const comment = {
      id: 1000 + comments.length,
      body: payload.body,
      created_at: "2026-08-04T12:00:00Z",
      updated_at: "2026-08-04T12:00:00Z",
      html_url: "https://github.com/comment/" + (1000 + comments.length),
      user: { login: "agent" },
    };
    comments.push(comment);
    state.comments[endpoint] = comments;
    output(comment);
  }
} else if (new RegExp("/issues/comments/[0-9]+$").test(endpoint) && method === "PATCH") {
  const id = Number(endpoint.split("/").at(-1));
  let found;
  for (const comments of Object.values(state.comments)) {
    const comment = comments.find((candidate) => candidate.id === id);
    if (comment) {
      comment.body = payload.body;
      comment.updated_at = "2026-08-04T12:00:00Z";
      found = comment;
    }
  }
  output(found);
} else {
  console.error("unhandled mock gh call", method, endpoint);
  process.exit(91);
}
await writeState();
`;
  writeFileSync(join(bin, "gh"), mockGh);
  chmodSync(join(bin, "gh"), 0o755);
  const mockOpen = `#!/usr/bin/env bun
const stateFile = process.env.MOCK_STATE_FILE;
const state = JSON.parse(await Bun.file(stateFile).text());
state.opened = process.argv[2];
await Bun.write(stateFile, JSON.stringify(state));
`;
  for (const command of ["open", "xdg-open"]) {
    writeFileSync(join(bin, command), mockOpen);
    chmodSync(join(bin, command), 0o755);
  }
  return { repo, bin, stateFile, head };
}

/**
 * A fake ui-review-agent.sh standing in for a real reviewer CLI: writes the
 * given verdict straight to the out-file, ignoring the context it's handed.
 * Command tests exercise the plumbing (does ui-review.ts call it, parse its
 * output, and record the right proof kind) — not reviewer judgment quality,
 * which the standalone script + real CLI cover separately.
 */
function createFakeAgentScript(root: string, verdict: object): string {
  const path = join(root, "fake-agent.ts");
  writeFileSync(
    path,
    `#!/usr/bin/env bun\nawait Bun.write(process.argv[3], ${JSON.stringify(JSON.stringify(verdict))});\n`
  );
  chmodSync(path, 0o755);
  return path;
}

function runUiReview(
  fixture: ReturnType<typeof createFixture>,
  environment: Record<string, string> = {}
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(["bun", UI_REVIEW_SCRIPT], {
    cwd: fixture.repo,
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      MOCK_STATE_FILE: fixture.stateFile,
      MOCK_BASE_COMMIT: BASE_COMMIT,
      MOCK_HEAD_COMMIT: fixture.head,
      MOCK_BASE_POINTER: BASE_POINTER,
      MOCK_HEAD_POINTER: HEAD_POINTER,
      MOCK_PRODUCT_POINTER: PRODUCT_POINTER,
      // Every existing test exercises the ARTIFACT-required path, not the
      // agent-classification one — default it off so a missing ARTIFACT
      // falls straight to "proof missing" instead of spawning a real
      // reviewer CLI mid test-run. Tests of the agent path override this.
      UI_REVIEW_AGENT: "0",
      UI_REVIEW_GH_RETRY_MS: "0",
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function readState(path: string): MockState {
  return JSON.parse(readFileSync(path, "utf8")) as MockState;
}

function expectExit(
  result: ReturnType<typeof Bun.spawnSync>,
  expected: number
): void {
  if (result.exitCode !== expected) {
    throw new Error(
      `expected exit ${expected}, got ${result.exitCode}: ${new TextDecoder().decode(result.stderr)}`
    );
  }
}

describe("ui-review command", () => {
  it("resolves the merge base when the parent comparison exceeds the subprocess buffer", () => {
    const fixture = createFixture();
    const result = runUiReview(fixture, {
      MOCK_BASE_POINTER: HEAD_POINTER,
      MOCK_LARGE_PARENT_COMPARISON: "1",
    });
    expectExit(result, 0);
    expect(readState(fixture.stateFile).calls.at(-1)?.payload).toMatchObject({
      state: "success",
      description: "No Owletto pointer change",
    });
  });

  it("ignores a pointer update that landed only on the target branch", () => {
    const fixture = createFixture();
    const mergeBase = "b".repeat(40);
    const result = runUiReview(fixture, {
      MOCK_MERGE_BASE_COMMIT: mergeBase,
      MOCK_MERGE_BASE_POINTER: HEAD_POINTER,
    });
    expectExit(result, 0);
    const calls = readState(fixture.stateFile).calls;
    expect(calls.at(-1)?.payload).toMatchObject({
      state: "success",
      description: "No Owletto pointer change",
    });
    expect(
      calls.some((call) => call.endpoint.startsWith("repos/lobu-ai/owletto/"))
    ).toBe(false);
  });

  it("still requires UI proof when a PR and its target both update the pointer", () => {
    const fixture = createFixture();
    const result = runUiReview(fixture, {
      MOCK_BASE_POINTER: HEAD_POINTER,
      MOCK_MERGE_BASE_COMMIT: "b".repeat(40),
      MOCK_MERGE_BASE_POINTER: BASE_POINTER,
    });
    expectExit(result, 2);
    expect(readState(fixture.stateFile).calls.at(-1)?.payload).toMatchObject({
      state: "error",
      description: "UI proof missing; rerun make ui-review with ARTIFACT=...",
    });
  });

  it("fails closed when GitHub cannot identify the PR merge base", () => {
    const fixture = createFixture();
    const result = runUiReview(fixture, {
      MOCK_BASE_POINTER: HEAD_POINTER,
      MOCK_MISSING_MERGE_BASE: "1",
    });
    expectExit(result, 2);
    expect(
      readState(fixture.stateFile)
        .calls.filter((call) => call.endpoint.includes("/statuses/"))
        .at(-1)?.payload.state
    ).toBe("pending");
  });

  it("clears stale parent copy when the Owletto pointer no longer changes", () => {
    const fixture = createFixture();
    const state = readState(fixture.stateFile);
    const parentEndpoint = "repos/lobu-ai/lobu/issues/2500/comments";
    state.comments[parentEndpoint] = [
      {
        id: 900,
        body: "<!-- lobu-ui-review-marker -->\n**UI review awaiting approval**",
        created_at: "2026-08-04T11:00:00Z",
        updated_at: "2026-08-04T11:00:00Z",
        html_url: "https://github.com/comment/900",
        user: { login: "agent" },
      },
    ];
    writeFileSync(fixture.stateFile, JSON.stringify(state));
    const result = runUiReview(fixture, { MOCK_BASE_POINTER: HEAD_POINTER });

    expectExit(result, 0);
    const finalState = readState(fixture.stateFile);
    const status = finalState.calls
      .filter((call) => call.endpoint.includes("/statuses/"))
      .at(-1);
    expect(status?.payload).toMatchObject({
      context: "ui-review",
      state: "success",
      description: "No Owletto pointer change",
    });
    expect(finalState.comments[parentEndpoint]?.[0]?.body).toContain(
      "**UI review not applicable**"
    );
  });

  it("does not add a parent comment when UI review was never applicable", () => {
    const fixture = createFixture();
    const result = runUiReview(fixture, { MOCK_BASE_POINTER: HEAD_POINTER });

    expectExit(result, 0);
    const state = readState(fixture.stateFile);
    expect(state.comments["repos/lobu-ai/lobu/issues/2500/comments"]).toBe(
      undefined
    );
  });

  it("replaces an earlier success with pending before reading remote proof", () => {
    const fixture = createFixture();
    const state = readState(fixture.stateFile);
    state.calls.push({
      endpoint: `repos/lobu-ai/lobu/statuses/${fixture.head}`,
      method: "POST",
      payload: { context: "ui-review", state: "success" },
    });
    writeFileSync(fixture.stateFile, JSON.stringify(state));

    const result = runUiReview(fixture, {
      ARTIFACT: "https://claude.ai/code/artifact/test-proof",
      MOCK_FAIL_OWLETTO_COMMENTS: "1",
    });

    expectExit(result, 2);
    const statuses = readState(fixture.stateFile).calls.filter((call) =>
      call.endpoint.includes("/statuses/")
    );
    expect(statuses.at(-1)?.payload).toMatchObject({
      context: "ui-review",
      state: "pending",
    });
  });

  it("passes a complete deploy-only PR and clears stale parent proof copy", () => {
    const fixture = createFixture();
    const state = readState(fixture.stateFile);
    const parentEndpoint = "repos/lobu-ai/lobu/issues/2500/comments";
    state.comments[parentEndpoint] = [
      {
        id: 900,
        body: "<!-- lobu-ui-review-marker -->\n**UI review recorded**",
        created_at: "2026-08-04T11:00:00Z",
        updated_at: "2026-08-04T11:00:00Z",
        html_url: "https://github.com/comment/900",
        user: { login: "agent" },
      },
    ];
    writeFileSync(fixture.stateFile, JSON.stringify(state));

    const result = runUiReview(fixture, {
      OPEN: "1",
      MOCK_OWLETTO_FILES: JSON.stringify([
        { filename: "deploy/k8s/clusters/lobu-prod/apps.yaml" },
        { filename: "deploy/k8s/apps/lobu/base/helmrelease.yaml" },
      ]),
    });

    expectExit(result, 0);
    const finalState = readState(fixture.stateFile);
    expect(
      finalState.calls
        .filter((call) => call.endpoint.includes("/statuses/"))
        .at(-1)?.payload
    ).toMatchObject({
      context: "ui-review",
      state: "success",
      description:
        "Owletto 111111111...222222222 touches only unhosted trees; no hosted UI to prove",
      target_url: "https://github.com/lobu-ai/owletto/pull/712",
    });
    // The exemption is judged over the whole pointer range, so the range is what
    // the human-readable note must name.
    expect(finalState.comments[parentEndpoint]?.[0]?.body).toContain(
      `\`${"1".repeat(40)}...${"2".repeat(40)}\` changes only unhosted trees (2 files, through Owletto #712).`
    );
    expect(finalState.opened).toBe(
      "https://github.com/lobu-ai/owletto/pull/712"
    );
  });

  it("passes a Chrome/Mac/scripts range without calling it deploy-only", () => {
    const fixture = createFixture();
    // These trees ship real UI of their own — the exemption says hosted proof
    // is the wrong instrument, not that nothing is user-visible. The status is
    // durable on the commit, so it must not claim "deploy-only" here.
    const result = runUiReview(fixture, {
      MOCK_OWLETTO_FILES: JSON.stringify([
        { filename: "apps/chrome/src/sidepanel.ts" },
        { filename: "apps/mac/Sources/MacShellActionService.swift" },
        { filename: "scripts/check-bundle-size.mjs" },
      ]),
    });

    expectExit(result, 0);
    const description = readState(fixture.stateFile)
      .calls.filter((call) => call.endpoint.includes("/statuses/"))
      .at(-1)?.payload?.description as string;
    expect(description).toBe(
      "Owletto 111111111...222222222 touches only unhosted trees; no hosted UI to prove"
    );
    expect(description).not.toContain("deploy-only");
  });

  it("requires proof when an earlier commit left a UI change in the range", () => {
    const fixture = createFixture();
    // The head PR is deploy-only on its own, but the pointer moves across a
    // commit that touched `src/`. Judging by the head PR alone would skip proof
    // for a real UI change, so the exemption must read the whole range.
    const result = runUiReview(fixture, {
      MOCK_OWLETTO_FILES: JSON.stringify([
        { filename: "src/components/shell/responsive-app-shell.tsx" },
        { filename: "deploy/k8s/clusters/lobu-prod/apps.yaml" },
      ]),
    });

    expectExit(result, 2);
    const status = readState(fixture.stateFile)
      .calls.filter((call) => call.endpoint.includes("/statuses/"))
      .at(-1);
    expect(status?.payload).toMatchObject({
      context: "ui-review",
      state: "error",
      description: "UI proof missing; rerun make ui-review with ARTIFACT=...",
    });
  });

  it("requires proof when the pointer comparison diverged", () => {
    const fixture = createFixture();
    // A reviewer that would happily wave this through is installed on purpose:
    // without it the assertion would pass merely because no agent could spawn,
    // proving nothing about the divergence guard itself.
    const agentScript = createFakeAgentScript(fixture.repo, {
      has_ui_surface: false,
      reasoning: "deploy manifests only.",
      verification_summary: "n/a",
      reviewer: "claude",
    });
    const result = runUiReview(fixture, {
      UI_REVIEW_AGENT: "1",
      UI_REVIEW_AGENT_SCRIPT: agentScript,
      MOCK_COMPARE_STATUS: "diverged",
      MOCK_OWLETTO_FILES: JSON.stringify([
        { filename: "deploy/k8s/apps/lobu/base/helmrelease.yaml" },
      ]),
    });

    expectExit(result, 2);
    const status = readState(fixture.stateFile)
      .calls.filter((call) => call.endpoint.includes("/statuses/"))
      .at(-1);
    expect(status?.payload).toMatchObject({
      context: "ui-review",
      state: "error",
      description: "UI proof missing; rerun make ui-review with ARTIFACT=...",
    });
  });

  it("records an agent no-ui-surface proof when no ARTIFACT is given and the reviewer agrees", () => {
    const fixture = createFixture();
    const agentScript = createFakeAgentScript(fixture.repo, {
      has_ui_surface: false,
      reasoning:
        "Only tools.js (static import cleanup) and MacShellActionService.swift changed; neither renders anything.",
      verification_summary:
        "vitest 249/254 pass; Swift logic compiled and run, 9/9 assertions pass.",
      reviewer: "claude",
    });

    const result = runUiReview(fixture, {
      UI_REVIEW_AGENT: "1",
      UI_REVIEW_AGENT_SCRIPT: agentScript,
      MOCK_OWLETTO_FILES: JSON.stringify([
        { filename: "src/lib/api-client.ts" },
      ]),
    });

    expectExit(result, 0);
    const state = readState(fixture.stateFile);
    const proofComments =
      state.comments["repos/lobu-ai/owletto/issues/712/comments"];
    expect(proofComments?.[0]?.body).toContain("no UI surface");
    expect(proofComments?.[0]?.body).toContain("claude");
    expect(proofComments?.[0]?.body).toContain("Only tools.js");

    const status = state.calls
      .filter((call) => call.endpoint.includes("/statuses/"))
      .at(-1);
    expect(status?.payload).toMatchObject({
      context: "ui-review",
      state: "success",
    });

    const parentComment =
      state.comments["repos/lobu-ai/lobu/issues/2500/comments"]?.[0];
    expect(parentComment?.body).toContain("**UI review recorded**");
  });

  it("requires ARTIFACT when the comparison hit GitHub's file cap", () => {
    const fixture = createFixture();
    // At the cap GitHub truncates the file list, so a "no UI surface" verdict
    // would rest on a range the reviewer only partly saw.
    const agentScript = createFakeAgentScript(fixture.repo, {
      has_ui_surface: false,
      reasoning: "nothing user-visible in the files I was shown.",
      verification_summary: "n/a",
      reviewer: "claude",
    });

    const result = runUiReview(fixture, {
      UI_REVIEW_AGENT: "1",
      UI_REVIEW_AGENT_SCRIPT: agentScript,
      MOCK_OWLETTO_FILES: JSON.stringify(
        Array.from({ length: 300 }, (_, index) => ({
          filename: `deploy/k8s/generated/manifest-${index}.yaml`,
        }))
      ),
    });

    expectExit(result, 2);
    const status = readState(fixture.stateFile)
      .calls.filter((call) => call.endpoint.includes("/statuses/"))
      .at(-1);
    expect(status?.payload).toMatchObject({
      context: "ui-review",
      state: "error",
      description: "UI proof missing; rerun make ui-review with ARTIFACT=...",
    });
  });

  it("requires ARTIFACT when a changed file carries no readable patch", () => {
    const fixture = createFixture();
    // GitHub omits the patch for binary and oversized files. That content is
    // exactly where an icon or screenshot change hides, so the filename alone
    // must never be enough to clear the gate.
    const agentScript = createFakeAgentScript(fixture.repo, {
      has_ui_surface: false,
      reasoning: "the filenames look like build output.",
      verification_summary: "n/a",
      reviewer: "claude",
    });

    const result = runUiReview(fixture, {
      UI_REVIEW_AGENT: "1",
      UI_REVIEW_AGENT_SCRIPT: agentScript,
      MOCK_OWLETTO_FILES: JSON.stringify([
        { filename: "src/assets/logo.png", patch: null },
      ]),
    });

    expectExit(result, 2);
    const status = readState(fixture.stateFile)
      .calls.filter((call) => call.endpoint.includes("/statuses/"))
      .at(-1);
    expect(status?.payload).toMatchObject({
      context: "ui-review",
      state: "error",
      description: "UI proof missing; rerun make ui-review with ARTIFACT=...",
    });
  });

  it("still requires ARTIFACT when the reviewer finds real UI surface", () => {
    const fixture = createFixture();
    const agentScript = createFakeAgentScript(fixture.repo, {
      has_ui_surface: true,
      reasoning: "sidepanel.html copy and new icon assets changed.",
      verification_summary: "no screenshots in the source material.",
      reviewer: "claude",
    });

    const result = runUiReview(fixture, {
      UI_REVIEW_AGENT: "1",
      UI_REVIEW_AGENT_SCRIPT: agentScript,
      MOCK_OWLETTO_FILES: JSON.stringify([
        { filename: "src/components/shell/responsive-app-shell.tsx" },
      ]),
    });

    expectExit(result, 2);
    const status = readState(fixture.stateFile)
      .calls.filter((call) => call.endpoint.includes("/statuses/"))
      .at(-1);
    expect(status?.payload).toMatchObject({
      context: "ui-review",
      state: "error",
      description: "UI proof missing; rerun make ui-review with ARTIFACT=...",
    });
  });

  it("still requires ARTIFACT when the reviewer is unavailable (fails closed)", () => {
    const fixture = createFixture();
    const result = runUiReview(fixture, {
      UI_REVIEW_AGENT: "1",
      UI_REVIEW_AGENT_SCRIPT: join(fixture.repo, "does-not-exist.sh"),
      MOCK_OWLETTO_FILES: JSON.stringify([
        { filename: "src/components/shell/responsive-app-shell.tsx" },
      ]),
    });

    expectExit(result, 2);
    const status = readState(fixture.stateFile)
      .calls.filter((call) => call.endpoint.includes("/statuses/"))
      .at(-1);
    expect(status?.payload).toMatchObject({
      context: "ui-review",
      state: "error",
      description: "UI proof missing; rerun make ui-review with ARTIFACT=...",
    });
  });

  it("prefers an explicit ARTIFACT over an existing agent no-ui-surface proof", () => {
    const fixture = createFixture();
    const agentScript = createFakeAgentScript(fixture.repo, {
      has_ui_surface: false,
      reasoning: "no surface",
      verification_summary: "tests pass",
      reviewer: "claude",
    });
    const first = runUiReview(fixture, {
      UI_REVIEW_AGENT: "1",
      UI_REVIEW_AGENT_SCRIPT: agentScript,
      MOCK_OWLETTO_FILES: JSON.stringify([
        { filename: "src/lib/api-client.ts" },
      ]),
    });
    expectExit(first, 0);

    const second = runUiReview(fixture, {
      ARTIFACT: "https://claude.ai/code/artifact/override",
      MOCK_OWLETTO_FILES: JSON.stringify([
        { filename: "src/lib/api-client.ts" },
      ]),
    });
    expectExit(second, 0);

    const state = readState(fixture.stateFile);
    const proofComments =
      state.comments["repos/lobu-ai/owletto/issues/712/comments"];
    expect(proofComments).toHaveLength(1);
    expect(proofComments?.[0]?.body).toContain(
      "https://claude.ai/code/artifact/override"
    );
    expect(proofComments?.[0]?.body).not.toContain("no UI surface");
  });

  it("keeps its own proof when another Lobu PR pins the same Owletto commit", () => {
    const fixture = createFixture();
    const state = readState(fixture.stateFile);
    const proofEndpoint = "repos/lobu-ai/owletto/issues/712/comments";
    state.comments[proofEndpoint] = [
      {
        id: 800,
        body: buildProofBody({
          version: 1,
          lobu_repo: "lobu-ai/lobu",
          lobu_pr: 2499,
          lobu_base_owletto_sha: BASE_POINTER,
          owletto_sha: HEAD_POINTER,
          owletto_pr: 712,
          artifact_url: "https://claude.ai/code/artifact/other-pr",
        }),
        created_at: "2026-08-04T11:00:00Z",
        updated_at: "2026-08-04T11:00:00Z",
        html_url: "https://github.com/comment/800",
        user: { login: "agent" },
      },
      {
        id: 801,
        body: buildProofBody({
          version: 1,
          lobu_repo: "lobu-ai/lobu",
          lobu_pr: 2500,
          lobu_base_owletto_sha: BASE_POINTER,
          owletto_sha: HEAD_POINTER,
          owletto_pr: 712,
          artifact_url: "https://claude.ai/code/artifact/ours",
        }),
        created_at: "2026-08-04T12:00:00Z",
        updated_at: "2026-08-04T12:00:00Z",
        html_url: "https://github.com/comment/801",
        user: { login: "agent" },
      },
    ];
    writeFileSync(fixture.stateFile, JSON.stringify(state));

    const result = runUiReview(fixture);

    expectExit(result, 0);
    const finalState = readState(fixture.stateFile);
    expect(
      finalState.calls
        .filter((call) => call.endpoint.includes("/statuses/"))
        .at(-1)?.payload
    ).toMatchObject({ context: "ui-review", state: "success" });
    expect(finalState.comments[proofEndpoint]?.[0]?.body).toContain(
      "https://claude.ai/code/artifact/other-pr"
    );
  });

  it("adds its proof beside another PR's instead of overwriting it", () => {
    const fixture = createFixture();
    const state = readState(fixture.stateFile);
    const proofEndpoint = "repos/lobu-ai/owletto/issues/712/comments";
    state.comments[proofEndpoint] = [
      {
        id: 800,
        body: buildProofBody({
          version: 1,
          lobu_repo: "lobu-ai/lobu",
          lobu_pr: 2499,
          lobu_base_owletto_sha: BASE_POINTER,
          owletto_sha: HEAD_POINTER,
          owletto_pr: 712,
          artifact_url: "https://claude.ai/code/artifact/other-pr",
        }),
        created_at: "2026-08-04T11:00:00Z",
        updated_at: "2026-08-04T11:00:00Z",
        html_url: "https://github.com/comment/800",
        user: { login: "agent" },
      },
    ];
    writeFileSync(fixture.stateFile, JSON.stringify(state));

    const result = runUiReview(fixture, {
      ARTIFACT: "https://claude.ai/code/artifact/ours",
    });

    expectExit(result, 0);
    const comments = readState(fixture.stateFile).comments[proofEndpoint] ?? [];
    expect(comments[0]?.body).toContain(
      "https://claude.ai/code/artifact/other-pr"
    );
    expect(comments).toHaveLength(2);
    expect(comments[1]?.body).toContain("https://claude.ai/code/artifact/ours");
  });

  it("publishes the proof before it passes, in one run", () => {
    const fixture = createFixture();
    const result = runUiReview(fixture, {
      ARTIFACT: "https://claude.ai/code/artifact/test-proof",
    });

    expectExit(result, 0);
    const state = readState(fixture.stateFile);

    // The proof IS the gate now, so it has to reach the Owletto PR — a green
    // status with no evidence attached would assert nothing.
    const proofEndpoint = "repos/lobu-ai/owletto/issues/712/comments";
    const proof = state.comments[proofEndpoint]?.[0];
    expect(proof?.body).toContain("<!-- lobu-ui-review-proof ");
    expect(proof?.body).toContain("https://claude.ai/code/artifact/test-proof");

    const status = state.calls
      .filter((call) => call.endpoint.includes("/statuses/"))
      .at(-1);
    expect(status?.payload).toMatchObject({
      context: "ui-review",
      state: "success",
    });
    expect(status?.payload).toMatchObject({
      target_url: proof?.html_url,
    });
  });

  it("records exact-head proof on the product PR beneath a Flux-only tail", () => {
    const fixture = createFixture();
    const result = runUiReview(fixture, {
      ARTIFACT: "https://claude.ai/code/artifact/flux-tail-proof",
      MOCK_FLUX_TAIL: "1",
    });

    expectExit(result, 0);
    const state = readState(fixture.stateFile);
    const proof =
      state.comments["repos/lobu-ai/owletto/issues/712/comments"]?.[0];
    expect(proof?.body).toContain(HEAD_POINTER);
    expect(proof?.body).toContain(
      "https://claude.ai/code/artifact/flux-tail-proof"
    );
  });
  it("retries a transient GitHub 5xx on the commit pulls lookup", () => {
    const fixture = createFixture();
    const result = runUiReview(fixture, {
      ARTIFACT: "https://claude.ai/code/artifact/retry-proof",
      MOCK_PULLS_FAILURES: "2",
    });

    expectExit(result, 0);
    const state = readState(fixture.stateFile);
    const lookups = state.calls.filter((call) =>
      call.endpoint.endsWith("/pulls")
    );
    expect(lookups.length).toBe(3);
  });

  it("gives up with the GitHub error after bounded retries", () => {
    const fixture = createFixture();
    const result = runUiReview(fixture, {
      ARTIFACT: "https://claude.ai/code/artifact/retry-proof",
      MOCK_PULLS_FAILURES: "99",
    });

    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "unexpected end of JSON input"
    );
    const state = readState(fixture.stateFile);
    expect(
      state.calls.filter((call) => call.endpoint.endsWith("/pulls")).length
    ).toBe(6);
  });
});
