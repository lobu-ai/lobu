import { describe, expect, it } from "bun:test";
import {
  type AgentUiReviewProof,
  buildProofBody,
  COMPARE_FILE_CAP,
  findProofComment,
  isArtifactProof,
  isUnhostedRange,
  isHttpsArtifact,
  parseProof,
  permittedFluxTailParent,
  proofMatches,
  selectOwlettoPullRequest,
  type UiReviewComment,
  type UiReviewProof,
} from "../lib/ui-review-proof";
import { githubRepoFromRemote } from "../ui-review";

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const OTHER_SHA = "3".repeat(40);

const proof: UiReviewProof = {
  version: 1,
  lobu_repo: "lobu-ai/lobu",
  lobu_pr: 2500,
  lobu_base_owletto_sha: BASE_SHA,
  owletto_sha: HEAD_SHA,
  owletto_pr: 712,
  artifact_url: "https://claude.ai/code/artifact/example",
};

describe("UI review proof", () => {
  it("derives the Owletto repository from supported GitHub remotes", () => {
    expect(githubRepoFromRemote("https://github.com/lobu-ai/owletto.git")).toBe(
      "lobu-ai/owletto"
    );
    expect(githubRepoFromRemote("git@github.com:lobu-ai/owletto.git")).toBe(
      "lobu-ai/owletto"
    );
    expect(() =>
      githubRepoFromRemote("https://example.com/owletto.git")
    ).toThrow("unsupported GitHub remote");
  });

  it("round-trips machine state without hiding the human-readable proof", () => {
    const body = buildProofBody(proof);

    expect(parseProof(body)).toEqual(proof);
    // The machine state rides in an HTML comment. A reader of the PR must still
    // get the range and the comparison link in prose, or the proof is inert.
    expect(body).toContain(HEAD_SHA);
    expect(body).toContain(proof.artifact_url);
    expect(body).toContain(`${proof.lobu_repo}#${proof.lobu_pr}`);
  });

  it("ignores comments that merely contain marker-like text", () => {
    expect(
      parseProof(
        `discussion <!-- lobu-ui-review-proof ${JSON.stringify(proof)} -->`
      )
    ).toBeNull();
  });

  it("picks the proof this Lobu PR owns when several share one Owletto PR", () => {
    const foreign: UiReviewProof = { ...proof, lobu_pr: 2499 };
    const fork: UiReviewProof = { ...proof, lobu_repo: "fork/lobu" };
    const comment = (body: string, id: string): UiReviewComment => ({
      body,
      created_at: "2026-08-04T10:00:00Z",
      html_url: `https://github.com/lobu-ai/owletto/pull/712#${id}`,
      user: { login: "agent" },
    });
    const comments = [
      comment("just discussing the proof", "chatter"),
      comment(buildProofBody(foreign), "foreign"),
      comment(buildProofBody(fork), "fork"),
      comment(buildProofBody(proof), "ours"),
    ];

    expect(
      findProofComment(comments, "lobu-ai/lobu", 2500)?.html_url
    ).toEndWith("#ours");
    expect(
      findProofComment(comments, "lobu-ai/lobu", 2499)?.html_url
    ).toEndWith("#foreign");
    expect(findProofComment(comments, "lobu-ai/lobu", 2501)).toBeUndefined();
  });

  it("selects only the merged PR whose squash commit is the pointer", () => {
    const pulls = [
      {
        number: 710,
        html_url: "https://example/710",
        merge_commit_sha: OTHER_SHA,
        merged_at: "now",
      },
      {
        number: 711,
        html_url: "https://example/711",
        merge_commit_sha: HEAD_SHA,
        merged_at: null,
      },
      {
        number: 712,
        html_url: "https://example/712",
        merge_commit_sha: HEAD_SHA,
        merged_at: "now",
      },
    ];

    expect(selectOwlettoPullRequest(pulls, HEAD_SHA)?.number).toBe(712);
    expect(selectOwlettoPullRequest(pulls, BASE_SHA)).toBeNull();
  });

  it("walks only the exact deploy-only Flux image tail", () => {
    const parent = "4".repeat(40);
    expect(
      permittedFluxTailParent({
        commit: {
          author: { email: "fluxcd@lobu.ai" },
          message: "chore: update images",
        },
        files: [{ filename: "deploy/k8s/apps/lobu/base/helmrelease.yaml" }],
        parents: [{ sha: parent }],
      })
    ).toBe(parent);

    for (const candidate of [
      {
        commit: {
          author: { email: "human@lobu.ai" },
          message: "chore: update images",
        },
        files: [{ filename: "deploy/app.yaml" }],
        parents: [{ sha: parent }],
      },
      {
        commit: {
          author: { email: "fluxcd@lobu.ai" },
          message: "chore: update images later",
        },
        files: [{ filename: "deploy/app.yaml" }],
        parents: [{ sha: parent }],
      },
      {
        commit: {
          author: { email: "fluxcd@lobu.ai" },
          message: "chore: update images",
        },
        files: [{ filename: "src/app.ts" }],
        parents: [{ sha: parent }],
      },
    ]) {
      expect(permittedFluxTailParent(candidate)).toBeNull();
    }
  });

  it("accepts only a complete unhosted-tree endpoint diff", () => {
    expect(
      isUnhostedRange([
        { filename: "deploy/k8s/clusters/lobu-prod/apps.yaml" },
        { filename: "deploy/k8s/apps/lobu/base/helmrelease.yaml" },
      ])
    ).toBe(true);

    // The range spans several merged PRs. A surviving UI change from an earlier
    // commit must still demand proof when the head PR is deploy-only on its own.
    expect(
      isUnhostedRange([
        { filename: "src/components/shell/responsive-app-shell.tsx" },
        { filename: "deploy/k8s/clusters/lobu-prod/apps.yaml" },
      ])
    ).toBe(false);

    // Markdown design notes have no hosted surface: not referenced by
    // vite.config.ts, never bundled into the SPA.
    expect(
      isUnhostedRange([
        { filename: "docs/tab-group-model.md" },
        { filename: "apps/chrome/tab-groups.js" },
      ])
    ).toBe(true);

    // `deploy/` is a path prefix, not a substring — and so is `docs/`.
    expect(isUnhostedRange([{ filename: "src/deploy/widget.tsx" }])).toBe(
      false
    );
    expect(isUnhostedRange([{ filename: "src/docs/viewer.tsx" }])).toBe(false);
    expect(
      isUnhostedRange([
        {
          filename: "deploy/k8s/archived-app.tsx",
          previous_filename: "src/app.tsx",
        },
      ])
    ).toBe(false);

    // Fail closed when the compare response tells us nothing, and when it may
    // have been truncated at the cap.
    // Every unhosted tree keeps its exemption — the agent classifier is an
    // ADDITION for hosted ranges, not a replacement for these. An extension- or
    // Mac-only range has no hosted URL to compare, so demanding ARTIFACT here
    // would be unsatisfiable rather than strict.
    expect(
      isUnhostedRange([
        { filename: "apps/chrome/src/sidepanel/index.ts" },
        { filename: "apps/mac/Owletto/AppDelegate.swift" },
        { filename: "scripts/check-manifest.mjs" },
      ])
    ).toBe(true);

    // A hosted path anywhere in the range still demands proof.
    expect(
      isUnhostedRange([
        { filename: "apps/chrome/src/sidepanel/index.ts" },
        { filename: "src/components/shell/responsive-app-shell.tsx" },
      ])
    ).toBe(false);

    expect(isUnhostedRange([])).toBe(false);
    expect(
      isUnhostedRange(
        Array.from({ length: COMPARE_FILE_CAP }, (_, index) => ({
          filename: `deploy/k8s/generated/${index}.yaml`,
        }))
      )
    ).toBe(false);
  });

  it("requires a hosted HTTPS artifact", () => {
    expect(isHttpsArtifact("https://claude.ai/code/artifact/example")).toBe(
      true
    );
    expect(isHttpsArtifact("http://localhost:9284/proof.html")).toBe(false);
    expect(isHttpsArtifact("/tmp/proof.html")).toBe(false);
  });

  it("round-trips an agent no-ui-surface proof alongside an artifact proof", () => {
    const agentProof: AgentUiReviewProof = {
      version: 1,
      lobu_repo: "lobu-ai/lobu",
      lobu_pr: 2920,
      lobu_base_owletto_sha: BASE_SHA,
      owletto_sha: HEAD_SHA,
      owletto_pr: 892,
      no_ui_surface: true,
      reviewer: "codex",
      reasoning:
        "Only apps/chrome/tools.js (static import cleanup) and apps/mac/Owletto/MacShellActionService.swift (a stderr-text heuristic) changed; neither renders anything a user sees.",
      verification_summary:
        "bunx vitest run apps/chrome — 249/254 pass (5 pre-existing unrelated failures); Swift logic compiled and run on Linux via a stub harness, 9/9 assertions pass.",
    };

    expect(isArtifactProof(agentProof)).toBe(false);
    expect(isArtifactProof(proof)).toBe(true);

    const body = buildProofBody(agentProof);
    expect(parseProof(body)).toEqual(agentProof);
    expect(body).toContain(agentProof.reasoning);
    expect(body).toContain(agentProof.verification_summary);
    expect(body).toContain(HEAD_SHA);

    // Sharing findProofComment/proofMatches with the artifact variant is the
    // point — a Lobu PR owns at most one proof regardless of which kind it is.
    const comment: UiReviewComment = {
      body,
      created_at: "2026-08-19T16:00:00Z",
      html_url: "https://github.com/lobu-ai/owletto/pull/892#agent-proof",
      user: { login: "agent" },
    };
    expect(findProofComment([comment], "lobu-ai/lobu", 2920)).toBe(comment);
    expect(
      proofMatches(agentProof, "lobu-ai/lobu", BASE_SHA, HEAD_SHA, 2920, 892)
    ).toBe(true);
  });

  it("rejects a malformed agent proof (missing reasoning/verification)", () => {
    const malformed = {
      version: 1,
      lobu_repo: "lobu-ai/lobu",
      lobu_pr: 2920,
      lobu_base_owletto_sha: BASE_SHA,
      owletto_sha: HEAD_SHA,
      owletto_pr: 892,
      no_ui_surface: true,
      reviewer: "codex",
      reasoning: "",
      verification_summary: "",
    };
    expect(
      parseProof(
        `<!-- lobu-ui-review-proof ${Buffer.from(JSON.stringify(malformed)).toString("base64url")} -->\nbody`
      )
    ).toBeNull();
  });

  it("matches only the exact repo/base/head/PR tuple a proof carries", () => {
    const matches = (candidate: UiReviewProof): boolean =>
      proofMatches(candidate, "lobu-ai/lobu", BASE_SHA, HEAD_SHA, 2500, 712);

    expect(matches(proof)).toBe(true);
    expect(matches({ ...proof, lobu_repo: "fork/lobu" })).toBe(false);
    expect(matches({ ...proof, lobu_base_owletto_sha: OTHER_SHA })).toBe(false);
    expect(matches({ ...proof, owletto_sha: OTHER_SHA })).toBe(false);
    expect(matches({ ...proof, lobu_pr: 2501 })).toBe(false);
    expect(matches({ ...proof, owletto_pr: 713 })).toBe(false);
  });
});
