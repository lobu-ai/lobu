/**
 * `view-bundler` coverage: metadata comes from the module's own `view`
 * export, the browser bundle mounts it through a synthetic entry, and
 * anything else fails loud at apply time.
 *
 * Fixtures live next to this test so the view bundle's `@lobu/views` +
 * `react` imports resolve from the worktree's node_modules (the same
 * walk-up a real project install provides).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  assertBundlePortable,
  bundleViewFromFile,
  collectViewWatchFiles,
} from "../view-bundler.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
  delete (globalThis as Record<string, unknown>).__lobuViewDefinition;
});

function mkView(
  files: Record<string, string>,
  entry = "views/deal/pipeline.tsx"
): string {
  // Fixtures live next to this test so the view bundle's `@lobu/views` +
  // `react` imports resolve from the worktree's node_modules (the same
  // walk-up a real project install provides). Removed in afterEach.
  const dir = mkdtempSync(join(import.meta.dir, "view-fixture-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return join(dir, entry);
}

function bundleFixture(entry: string) {
  const root = tempDirs.find((dir) => entry.startsWith(`${dir}/`));
  if (!root) throw new Error("Unknown fixture root");
  return bundleViewFromFile(entry, root);
}

const PIPELINE_SOURCE = `import { defineView, sql, useAction, useParams, useQuery } from "@lobu/views";

export const view = defineView({
  key: "pipeline",
  attach: [{ type: "deal" }],
  params: { by: { type: "string", default: "owner" } },
  actions: { markWon: { emits: "deal.won" } },
});

export default function Pipeline() {
  const [params, setParams] = useParams();
  // NOTE: sql called as a plain function (tag without backticks) so this
  // test file needs no nested template literals; the bundle path is identical.
  const deals = useQuery(sql(["SELECT id FROM deal WHERE stage = 'open'"]));
  const markWon = useAction("markWon");
  void deals;
  void markWon;
  void setParams;
  return String(params.by);
}
`;

describe("bundleViewFromFile", () => {
  test("extracts metadata and bundles react + bridge with no SDK chain", async () => {
    const entry = mkView({ "views/deal/pipeline.tsx": PIPELINE_SOURCE });
    const bundled = await bundleFixture(entry);
    expect(bundled.metadata.key).toBe("pipeline");
    expect(bundled.metadata.attach).toEqual([{ type: "deal" }]);
    expect(bundled.metadata.params).toEqual({
      by: { type: "string", default: "owner" },
    });
    expect(bundled.metadata.actions).toEqual({
      markWon: { emits: "deal.won" },
    });
    expect(bundled.compiledCode.length).toBeGreaterThan(10_000);
    // The hand-written bridge ships no ext-apps/zod chain (spike: 378 KB).
    expect(bundled.compiledCode).not.toContain("ext-apps");
    expect(bundled.compiledCode).not.toContain("@modelcontextprotocol");
    expect(bundled.compiledCode).not.toContain(
      "ui/notifications/tool-input-partial"
    );
    expect(bundled.compiledCode.length).toBeLessThan(300_000);
    // Portable: the temp project path leaked nowhere into the bytes.
    expect(bundled.compiledCode).not.toContain(entry);
  });

  test("bundles relative imports into the same artifact", async () => {
    const entry = mkView(
      {
        "views/deal/board.tsx": `import { defineView } from "@lobu/views";
import { Board } from "../_lib/board";
export const view = defineView({ key: "board", attach: [{ type: "deal" }] });
export default function BoardView() { return Board({}); }
`,
        "views/_lib/board.tsx": `export function Board(_props: unknown) { return <div>Board</div>; }
`,
      },
      "views/deal/board.tsx"
    );
    const bundled = await bundleFixture(entry);
    expect(bundled.metadata.key).toBe("board");
    expect(bundled.sourceFiles.entrypoint).toBe("views/deal/board.tsx");
    expect(Object.keys(bundled.sourceFiles.files).sort()).toEqual([
      "views/_lib/board.tsx",
      "views/deal/board.tsx",
    ]);
    expect(bundled.dependencies["@lobu/views"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(bundled.dependencies.react).toMatch(/^\d+\.\d+\.\d+$/);
    expect(bundled.compiledCode.length).toBeGreaterThan(10_000);
  });

  test("a module without a view export fails loud", async () => {
    const entry = mkView(
      {
        "views/deal/nope.tsx": `export default function Nope() { return null; }
`,
      },
      "views/deal/nope.tsx"
    );
    await expect(bundleFixture(entry)).rejects.toThrow(
      "must export const view"
    );
  });

  test("a module without a default export fails loud", async () => {
    const entry = mkView(
      {
        "views/deal/nodefault.tsx": `import { defineView } from "@lobu/views";
export const view = defineView({ key: "nodefault", attach: [] });
`,
      },
      "views/deal/nodefault.tsx"
    );
    await expect(bundleFixture(entry)).rejects.toThrow(
      "default-export component"
    );
  });

  test("an invalid key fails loud", async () => {
    const entry = mkView(
      {
        "views/deal/bad.tsx": `import { defineView } from "@lobu/views";
export const view = defineView({ key: "Custom_Name", attach: [] });
export default function Bad() { return null; }
`,
      },
      "views/deal/bad.tsx"
    );
    await expect(bundleFixture(entry)).rejects.toThrow("must match");
  });
});

describe("assertBundlePortable", () => {
  test("rejects embedded checkout paths and encoded file URLs", () => {
    const entry = "/Users/someone/Code/lobu-proj/views/a.tsx";
    expect(() => assertBundlePortable(`var x = "${entry}";`, entry)).toThrow(
      "must be portable"
    );
    expect(() =>
      assertBundlePortable(
        `fetch("file:///Users/someone/Code/lobu-proj/x")`,
        entry
      )
    ).toThrow("must be portable");
    expect(() => assertBundlePortable("var x = 1;", entry)).not.toThrow();
  });
});

describe("collectViewWatchFiles", () => {
  test("returns exactly the canonical entry plus its relative imports", async () => {
    const entry = mkView(
      {
        "views/deal/board.tsx": `import { x } from "../_lib/board";
export const y = x;
`,
        "views/_lib/board.tsx": `export const x = 1;
`,
      },
      "views/deal/board.tsx"
    );
    const files = await collectViewWatchFiles(entry);
    // Exact canonical set: a duplicated parent segment (.../deal/views/...)
    // must never appear, and every candidate must exist on disk.
    expect(files).toEqual(
      [entry, join(entry, "..", "..", "_lib", "board.tsx")].sort()
    );
    for (const file of files) {
      expect(existsSync(file)).toBe(true);
    }
  });
});
