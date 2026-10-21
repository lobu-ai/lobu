/**
 * `view-bundler` coverage: the declaration is read from the module's own
 * `defineView({...})` literal (never by running it), the browser bundle mounts it through a synthetic entry, and
 * anything else fails loud at apply time.
 *
 * Fixtures have no installed runtime packages: the shell supplies them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
});

function mkView(
  files: Record<string, string>,
  entry = "views/deal/pipeline.tsx"
): string {
  const dir = mkdtempSync(join(tmpdir(), "view-fixture-"));
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
  attach: [{ collection: "deal" }],
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
  test("extracts metadata and reads react + bridge from the shell runtime", async () => {
    const entry = mkView({ "views/deal/pipeline.tsx": PIPELINE_SOURCE });
    const bundled = await bundleFixture(entry);
    expect(bundled.definition.key).toBe("pipeline");
    expect(bundled.definition.attach).toEqual([{ collection: "deal" }]);
    expect(bundled.definition.params).toEqual({
      by: { type: "string", default: "owner" },
    });
    expect(bundled.definition.actions).toEqual({
      markWon: { emits: "deal.won" },
    });
    // React and the bridge come from the shell runtime, never the bundle.
    expect(bundled.compiledCode).toContain(
      'globalThis.__lobuViews["@lobu/views"]'
    );
    expect(bundled.compiledCode.length).toBeLessThan(8 * 1024);
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

  test("reads the first-party components kit from the shell runtime", async () => {
    const entry = mkView(
      {
        "views/deal/cards.tsx": `import { defineView } from "@lobu/views";
import { Card, DataTable, formatCompact } from "@lobu/views/components";
export const view = defineView({ key: "cards", attach: [{ collection: "deal" }], params: { label: { type: "string", default: "1.5K" } } });
const ROWS = [{ id: 1 }, { id: 2 }];
export default function CardsView() {
  return <Card title={formatCompact(1500)}><DataTable columns={[{ key: "id", header: "ID", sortable: true }]} rows={ROWS} keyOf={(r) => r.id} sort={{ key: "id", dir: "asc" }} /></Card>;
}
`,
      },
      "views/deal/cards.tsx"
    );
    const bundled = await bundleFixture(entry);
    expect(bundled.definition.key).toBe("cards");
    expect(bundled.definition.params).toEqual({
      label: { type: "string", default: "1.5K" },
    });
    // The shell supplies the kit; its implementation stays out of the view.
    expect(bundled.compiledCode).toContain(
      'globalThis.__lobuViews["@lobu/views/components"]'
    );
    expect(bundled.compiledCode).not.toContain("aria-sort");
    expect(bundled.compiledCode.length).toBeLessThan(300_000);
    expect(bundled.compiledCode).not.toContain(entry);
  });
  test("bundles relative imports into the same artifact", async () => {
    const entry = mkView(
      {
        "views/deal/board.tsx": `import { defineView } from "@lobu/views";
import { Board } from "../_lib/board";
export const view = defineView({ key: "board", attach: [{ collection: "deal" }] });
export default function BoardView() { return Board({}); }
`,
        "views/_lib/board.tsx": `export function Board(_props: unknown) { return <div>Board</div>; }
`,
      },
      "views/deal/board.tsx"
    );
    const bundled = await bundleFixture(entry);
    expect(bundled.definition.key).toBe("board");
    expect(bundled.sourceFiles.entrypoint).toBe("views/deal/board.tsx");
    expect(Object.keys(bundled.sourceFiles.files).sort()).toEqual([
      "views/_lib/board.tsx",
      "views/deal/board.tsx",
    ]);
    // The shell supplies the runtime packages, so a view importing only them
    // retains no dependencies and the server can rebuild it from its files.
    expect(bundled.dependencies).toEqual({});
  });

  test.each([
    "file%3A%2F%2F%2FUsers%2Fforeign-builder%2Fproject%2Fview.tsx",
    "FiLe:%2f%2f%2fhome%2fforeign-builder%2fproject%2fview.tsx",
  ])("rejects a generated bundle containing %s", async (path) => {
    const entry = mkView({
      "views/deal/pipeline.tsx": `import { defineView } from "@lobu/views";
export const view = defineView({ key: "pipeline", attach: [] });
export default function Pipeline() { return ${JSON.stringify(path)}; }
`,
    });
    await expect(bundleFixture(entry)).rejects.toThrow("must be portable");
  });

  test("rejects an encoded checkout path in the generated bundle", async () => {
    const entry = mkView({ "views/deal/pipeline.tsx": PIPELINE_SOURCE });
    const encodedPath = encodeURIComponent(entry).replace(
      /%[0-9A-F]{2}/g,
      (s) => s.toLowerCase()
    );
    writeFileSync(
      entry,
      `import { defineView } from "@lobu/views";
export const view = defineView({ key: "pipeline", attach: [] });
export default function Pipeline() { return ${JSON.stringify(encodedPath)}; }
`
    );
    await expect(bundleFixture(entry)).rejects.toThrow("must be portable");
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

  test("a declaration that would have to run fails loud, naming the field", async () => {
    const entry = mkView(
      {
        "views/deal/computed.tsx": `import { defineView } from "@lobu/views";
import { formatCompact } from "@lobu/views/components";
export const view = defineView({ key: "computed", attach: [], params: { label: { type: "string", default: formatCompact(1500) } } });
export default function Computed() { return null; }
`,
      },
      "views/deal/computed.tsx"
    );
    await expect(bundleFixture(entry)).rejects.toThrow(
      "defineView.params.label.default must be written out as a literal"
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
    await expect(bundleFixture(entry)).rejects.toThrow(/defineView\.key: /);
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

  test("allows ordinary URL encoding and literal percent signs", () => {
    expect(() =>
      assertBundlePortable(
        'var label = "100% complete"; var url = "https://example.test/search?q=hello%20world";',
        "/Users/synthetic-builder/project/view.tsx"
      )
    ).not.toThrow();
  });

  test.each([
    "/tmp/synthetic%20builder/project/view.tsx",
    "/tmp/synthetic%2Fbuilder/project/view.tsx",
  ])("rejects literal percent escapes in checkout paths: %s", (entry) => {
    expect(() =>
      assertBundlePortable(`var path = ${JSON.stringify(entry)};`, entry)
    ).toThrow("must be portable");
  });
});

describe("collectViewWatchFiles", () => {
  test("watches a shell-runtime view without installing the runtime locally", async () => {
    const entry = mkView({
      "views/deal/pipeline.tsx": `import { defineView } from "@lobu/views";
import { Card } from "@lobu/views/components";
import { label } from "./label";
export const view = defineView({ key: "pipeline", attach: [] });
export default function Pipeline() { return <Card title={label} />; }`,
      "views/deal/label.ts": 'export const label = "Pipeline";',
    });
    await bundleFixture(entry);
    expect(await collectViewWatchFiles(entry)).toEqual(
      [entry, join(entry, "..", "label.ts")].sort()
    );
  });

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
