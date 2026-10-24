import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(import.meta.path), "../..");
const CTX_SCRIPT = join(REPO_ROOT, "scripts/ctx.sh");
const LAND_SCRIPT = join(REPO_ROOT, "scripts/land.sh");

let fixtureRoot: string;
let binDir: string;
let headSha: string;

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: fixtureRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

function runScript(script: string, env: Record<string, string> = {}) {
  return Bun.spawnSync(["bash", script], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      MOCK_GH_LOG: join(fixtureRoot, "gh.log"),
      MOCK_HEAD_SHA: headSha,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "lobu-dev-loop-"));
  binDir = join(fixtureRoot, "bin");
  mkdirSync(binDir);

  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test User");
  writeFileSync(join(fixtureRoot, ".gitignore"), "bin/\ngh.log*\n");
  writeFileSync(join(fixtureRoot, "tracked.txt"), "base\n");
  git("add", ".gitignore", "tracked.txt");
  git("commit", "-qm", "base");
  headSha = git("rev-parse", "HEAD");

  const gh = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_GH_LOG"
case "$1 $2" in
  "pr list")
    if [ "\${MOCK_LIST_FAIL:-0}" = "1" ]; then exit 1; fi
    exit 0
    ;;
  "pr view")
    if [ "\${MOCK_VIEW_FAIL:-0}" = "1" ]; then exit 1; fi
    if [[ " $* " == *"headRefOid"* ]]; then
      count_file="$MOCK_GH_LOG.head-count"
      count=0
      [ -f "$count_file" ] && count="$(cat "$count_file")"
      count=$((count + 1))
      printf '%s' "$count" > "$count_file"
      if [ "$count" -gt 1 ] && [ -n "\${MOCK_SECOND_HEAD_SHA:-}" ]; then
        printf '%s\\tmain\\n' "$MOCK_SECOND_HEAD_SHA"
      else
        printf '%s\\tmain\\n' "$MOCK_HEAD_SHA"
      fi
    else
      printf '%s\\n' deadbeef
    fi
    ;;
  "pr checks")
    printf '%b' "\${MOCK_CHECK_ROWS:-integration\\tpass\\thttps://checks/integration\\n}"
    exit "\${MOCK_CHECK_RC:-0}"
    ;;
  "pr merge")
    : > "\${MOCK_MERGED_FILE:?}"
    ;;
  api*)
    if [ "\${MOCK_API_FAIL:-0}" = "1" ]; then exit 1; fi
    printf '%b' "\${MOCK_REQUIRED:-integration\\n}"
    ;;
  *)
    echo "unexpected gh call: $*" >&2
    exit 2
    ;;
esac
`;
  writeFileSync(join(binDir, "gh"), gh);
  chmodSync(join(binDir, "gh"), 0o755);
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("land.sh", () => {
  test("squash-merges after every required check passes", () => {
    const mergedFile = join(fixtureRoot, "merged");
    const result = runScript(LAND_SCRIPT, {
      N: "42",
      TIMEOUT_MIN: "1",
      MOCK_MERGED_FILE: mergedFile,
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(mergedFile)).toBeTrue();
    expect(readFileSync(join(fixtureRoot, "gh.log"), "utf8")).toContain(
      `pr merge 42 --squash --match-head-commit ${headSha}`
    );
  });

  test("refuses a failed required check", () => {
    const mergedFile = join(fixtureRoot, "merged");
    const result = runScript(LAND_SCRIPT, {
      N: "42",
      TIMEOUT_MIN: "1",
      MOCK_CHECK_ROWS: "integration\tfail\thttps://checks/integration\n",
      MOCK_CHECK_RC: "1",
      MOCK_MERGED_FILE: mergedFile,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("FAILING checks");
    expect(existsSync(mergedFile)).toBeFalse();
  });

  test("accepts skipping and checks only required contexts", () => {
    const result = runScript(LAND_SCRIPT, {
      N: "42",
      CHECK_ONLY: "1",
      TIMEOUT_MIN: "1",
      MOCK_CHECK_ROWS: "integration\tskipping\thttps://checks/integration\n",
      MOCK_MERGED_FILE: join(fixtureRoot, "merged"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      "required checks are merge-satisfying"
    );
    expect(readFileSync(join(fixtureRoot, "gh.log"), "utf8")).toContain(
      "pr checks 42 --json"
    );
  });

  test("rechecks the PR head after waiting", () => {
    const mergedFile = join(fixtureRoot, "merged");
    const result = runScript(LAND_SCRIPT, {
      N: "42",
      TIMEOUT_MIN: "1",
      MOCK_SECOND_HEAD_SHA: "0000000000000000000000000000000000000000",
      MOCK_MERGED_FILE: mergedFile,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("local HEAD");
    expect(existsSync(mergedFile)).toBeFalse();
  });

  test("fails closed when GitHub cannot return the PR head", () => {
    const result = runScript(LAND_SCRIPT, {
      N: "42",
      TIMEOUT_MIN: "1",
      MOCK_VIEW_FAIL: "1",
      MOCK_MERGED_FILE: join(fixtureRoot, "merged"),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("refusing to merge blind");
  });

  test("fails closed when branch protection is unavailable", () => {
    const result = runScript(LAND_SCRIPT, {
      N: "42",
      TIMEOUT_MIN: "1",
      MOCK_API_FAIL: "1",
      MOCK_MERGED_FILE: join(fixtureRoot, "merged"),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("refusing to merge blind");
  });

  test("distinguishes a PR lookup failure from no open PR", () => {
    const result = runScript(LAND_SCRIPT, {
      TIMEOUT_MIN: "1",
      MOCK_LIST_FAIL: "1",
      MOCK_MERGED_FILE: join(fixtureRoot, "merged"),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("could not query GitHub");
  });
});

describe("ctx.sh", () => {
  test("includes unstaged and untracked files", () => {
    writeFileSync(join(fixtureRoot, "tracked.txt"), "changed\n");
    writeFileSync(join(fixtureRoot, "untracked.txt"), "new\n");

    const result = runScript(CTX_SCRIPT, { BASE: "HEAD", NOFETCH: "1" });
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("tracked.txt");
    expect(stdout).toContain("untracked.txt");
    expect(stdout).toContain("2 file(s) listed");
    expect(stdout).toContain("(none)");
  });

  test("fails when the default origin refresh fails", () => {
    git("remote", "add", "origin", join(fixtureRoot, "missing-origin"));

    const result = runScript(CTX_SCRIPT, { BASE: "HEAD" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("stale refs are acceptable");
  });
});
