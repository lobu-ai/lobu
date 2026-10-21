import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleViewFromFile } from "../../packages/cli/src/commands/_lib/view-bundler";
import { compileView } from "../../packages/server/src/views/views";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

const BOARD = `import { defineView, sql, useQuery } from "@lobu/views";
import { Card } from "@lobu/views/components";
import { useState } from "react";
import { label } from "../lib/label";
export const view = defineView({ key: "board", attach: [{ collection: "deal" }] });
export default function Board() {
  const [n] = useState(1);
  const q = useQuery<{ id: number }[]>(sql\`SELECT id FROM entities LIMIT 1\`);
  return <Card title={label("won") + n}>{q.data?.length ?? 0}</Card>;
}
`;

/**
 * `lobu apply` bundles a view in the author's checkout and the server rebuilds
 * stored views from the retained files when served. Both must produce the same
 * bytes, or every deploy rewrites the view `lobu apply` just stored and every
 * apply rewrites it back.
 */
describe("view compilers agree", () => {
  test.each([
    ["./helper.js", "helper.ts", 'export const label = "TS";'],
    ["./helper.jsx", "helper.tsx", 'export const label = "TSX";'],
    ["./helper.mjs", "helper.mts", 'export const label = "MTS";'],
    ["./helper.cjs", "helper.cts", 'exports.label = "CTS";'],
    ["./helper", "helper.json", '{"label":"JSON"}'],
    ["./helper", "helper/index.json", '{"label":"INDEX"}'],
    ["./helper.cjs", "helper.cjs", 'exports.label = "CJS";'],
    ["./helper.mjs", "helper.mjs", 'export const label = "MJS";'],
  ])("resolves %s from retained %s like the CLI", async (specifier, path, contents) => {
    const project = await mkdtemp(join(tmpdir(), "lobu-view-resolution-"));
    directories.push(project);
    await mkdir(join(project, "helper"));
    await writeFile(join(project, path), contents);
    await writeFile(
      join(project, "index.tsx"),
      `import { defineView } from "@lobu/views";
import { label } from ${JSON.stringify(specifier)};
export const view = defineView({ key: "board", attach: [] });
export default function Board() { return <div>{label}</div>; }`
    );
    const cli = await bundleViewFromFile(join(project, "index.tsx"), project);
    expect(await compileView(cli.sourceFiles)).toBe(cli.compiledCode);
  });

  test("the CLI bundle and the server rebuild of its retained files are identical", async () => {
    const project = await mkdtemp(join(tmpdir(), "lobu-view-compilers-"));
    directories.push(project);
    await mkdir(join(project, "views"));
    await mkdir(join(project, "lib"));
    await writeFile(join(project, "views/board.tsx"), BOARD);
    await writeFile(
      join(project, "lib/label.ts"),
      "export function label(s: string) { return s.toUpperCase(); }\n"
    );

    const cli = await bundleViewFromFile(
      join(project, "views/board.tsx"),
      project
    );
    expect(Object.keys(cli.sourceFiles.files).sort()).toEqual([
      "lib/label.ts",
      "views/board.tsx",
    ]);
    expect(cli.dependencies).toEqual({});
    expect(await compileView(cli.sourceFiles)).toBe(cli.compiledCode);
  });
});
