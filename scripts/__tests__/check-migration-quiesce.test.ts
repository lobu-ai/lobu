import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  declaresNoQuiesce,
  migrationUpSection,
} from "../migration-quiesce.mjs";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CHECK = join(REPO_ROOT, "scripts/check-migration-quiesce.mjs");
const MIGRATIONS = join(REPO_ROOT, "db/migrations");

const NEW = "20261016000000_example.sql";
const OLD = "20261001000000_example.sql";

function migration(upComments: string) {
  return `-- migrate:up\n${upComments}\nALTER TABLE t ADD COLUMN IF NOT EXISTS c text;\n\n-- migrate:down\n-- lobu:no-quiesce\nALTER TABLE t DROP COLUMN c;\n`;
}

function runCheck(dir: string) {
  const result = Bun.spawnSync(["node", CHECK, dir], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

describe("check-migration-quiesce", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "check-migration-quiesce-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails a new migration that declares no deploy window", () => {
    writeFileSync(join(dir, NEW), migration("-- adds a column"));
    const { exitCode, stderr } = runCheck(dir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`${NEW}: declares no deploy window`);
  });

  it("does not count a marker that only appears in the down section", () => {
    writeFileSync(join(dir, NEW), migration(""));
    expect(runCheck(dir).exitCode).toBe(1);
  });

  it("does not count prose that mentions a marker mid-line", () => {
    writeFileSync(
      join(dir, NEW),
      migration("-- Intentionally no `lobu:no-quiesce`: this drops a column.")
    );
    expect(runCheck(dir).exitCode).toBe(1);
  });

  it("accepts lobu:no-quiesce, with or without a note", () => {
    writeFileSync(join(dir, NEW), migration("-- lobu:no-quiesce"));
    writeFileSync(
      join(dir, "20261016000001_other.sql"),
      migration("-- lobu:no-quiesce  (additive: nothing reads the column yet)")
    );
    expect(runCheck(dir).exitCode).toBe(0);
  });

  it("accepts lobu:quiesce with a reason", () => {
    writeFileSync(
      join(dir, NEW),
      migration(
        "-- lobu:quiesce the running code still selects the dropped column"
      )
    );
    expect(runCheck(dir).exitCode).toBe(0);
  });

  it("fails lobu:quiesce without a reason", () => {
    writeFileSync(join(dir, NEW), migration("-- lobu:quiesce"));
    const { exitCode, stderr } = runCheck(dir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("needs a reason");
  });

  it("fails a migration that declares both windows", () => {
    writeFileSync(
      join(dir, NEW),
      migration("-- lobu:no-quiesce\n-- lobu:quiesce drops a column")
    );
    const { exitCode, stderr } = runCheck(dir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("declares 2 deploy windows");
  });

  it("leaves migrations from before the rule alone", () => {
    writeFileSync(join(dir, OLD), migration("-- adds a column"));
    expect(runCheck(dir).exitCode).toBe(0);
  });

  it("passes on the repository's migrations", () => {
    const { exitCode, stderr } = runCheck(MIGRATIONS);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });
});

describe("declaresNoQuiesce", () => {
  // The expression scripts/migrate-up.mjs used before the reader moved here.
  const PREVIOUS_MARKER = /^--[ \t]*lobu:no-quiesce\b/m;

  it("answers exactly as before for every migration in the repository", () => {
    const files = readdirSync(MIGRATIONS).filter((file) =>
      file.endsWith(".sql")
    );
    expect(files.length).toBeGreaterThan(300);
    const disagreements = files.filter((file) => {
      const up = migrationUpSection(
        readFileSync(join(MIGRATIONS, file), "utf-8")
      );
      return declaresNoQuiesce(up) !== PREVIOUS_MARKER.test(up);
    });
    expect(disagreements).toEqual([]);
  });

  it("is not armed by lobu:quiesce", () => {
    expect(declaresNoQuiesce("-- lobu:quiesce drops a column\n")).toBe(false);
  });
});
