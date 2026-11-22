import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../bump-submodule.sh", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "bump-submodule-")));

function git(cwd: string, ...args: string[]) {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error(r.stderr);
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("bump-submodule.sh", () => {
  it("places the bump worktree under the main checkout when run from a task worktree", () => {
    const main = join(root, "main");
    mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    writeFileSync(
      join(main, ".gitmodules"),
      '[submodule "packages/sub"]\n\tpath = packages/sub\n\turl = ./sub\n'
    );
    git(main, "add", ".gitmodules");
    git(main, "commit", "-qm", "base");
    const task = join(main, ".claude", "worktrees", "task");
    git(main, "worktree", "add", "-q", task, "-b", "task");
    // An existing bump worktree in the main checkout must stop the run before
    // it fetches, which proves where the script resolves the worktree root.
    mkdirSync(join(main, ".claude", "worktrees", "bump-x"));

    const r = spawnSync("bash", [script, "packages/sub"], {
      cwd: task,
      encoding: "utf8",
      env: { ...process.env, NAME: "x" },
    });

    expect(r.stderr).toContain(
      `worktree ${join(main, ".claude", "worktrees", "bump-x")} already exists`
    );
    expect(r.status).toBe(1);
  });
});
