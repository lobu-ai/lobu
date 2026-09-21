/**
 * `view-bundler` coverage: metadata comes from the module's own
 * `mountView(defineView(…))` call, the browser bundle is self-contained and
 * portable, and anything else fails loud at apply time.
 *
 * Fixtures live next to this test so the view bundle's `@lobu/views` + `react`
 * imports resolve from the worktree's node_modules (the same walk-up a real
 * project install provides).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const PIPELINE_SOURCE = `import { defineView, mountView, sql, useAction, useParams, useQuery } from "@lobu/views";

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
mountView(view, Pipeline);
`;

describe("bundleViewFromFile", () => {
  test("extracts metadata and bundles react + bridge with no SDK chain", async () => {
    const entry = mkView({ "views/deal/pipeline.tsx": PIPELINE_SOURCE });
    const bundled = await bundleViewFromFile(entry);
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
        "views/deal/board.tsx": `import { defineView, mountView } from "@lobu/views";
import { Board } from "../_lib/board";
export const view = defineView({ key: "board", attach: [{ type: "deal" }] });
export default function BoardView() { return Board({}); }
mountView(view, BoardView);
`,
        "views/_lib/board.tsx": `export function Board(_props: unknown) { return null; }
`,
      },
      "views/deal/board.tsx"
    );
    const bundled = await bundleViewFromFile(entry);
    expect(bundled.metadata.key).toBe("board");
    expect(bundled.compiledCode.length).toBeGreaterThan(10_000);
  });

  test("a module that never calls mountView fails loud", async () => {
    const entry = mkView(
      {
        "views/deal/nope.tsx": `import { defineView } from "@lobu/views";
export const view = defineView({ key: "nope", attach: [] });
export default function Nope() { return null; }
`,
      },
      "views/deal/nope.tsx"
    );
    await expect(bundleViewFromFile(entry)).rejects.toThrow(
      "must call mountView"
    );
  });

  test("an invalid key fails loud", async () => {
    const entry = mkView(
      {
        "views/deal/bad.tsx": `import { defineView, mountView } from "@lobu/views";
export const view = defineView({ key: "Custom_Name", attach: [] });
export default function Bad() { return null; }
mountView(view, Bad);
`,
      },
      "views/deal/bad.tsx"
    );
    await expect(bundleViewFromFile(entry)).rejects.toThrow("must match");
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
    expect(() =>
      assertBundlePortable(
        `fetch("file%3A%2F%2F%2FUsers%2Fsomeone%2FCode%2Flobu-proj%2Fx")`,
        entry
      )
    ).toThrow("must be portable");
    expect(() =>
      assertBundlePortable(
        `var x = "${encodeURIComponent(entry).toLowerCase()}";`,
        entry
      )
    ).toThrow("must be portable");
    expect(() => assertBundlePortable("var x = 1;", entry)).not.toThrow();
  });
});

describe("collectViewWatchFiles", () => {
  test("returns the entry plus its relative imports", async () => {
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
    expect(files).toContain(entry);
    expect(files.some((f) => f.endsWith("views/_lib/board.tsx"))).toBe(true);
  });
});
