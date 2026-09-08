import { afterEach, describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFindTool } from "@mariozechner/pi-coding-agent";
import { createWorkspace } from "../../../connector-worker/src/agent-turn/workspace";
import { createLobuTools } from "../runtime/tools";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function lanes() {
  const dir = await mkdtemp(join(tmpdir(), "lobu-file-parity-"));
  directories.push(dir);
  const workspace = createWorkspace(["write", "edit", "read", "ls", "find"]);
  await workspace.ready;
  return [
    {
      // Pi's default find shells out to `fd` (downloading it when absent);
      // Bun's Glob stands in for that process so the run stays hermetic while
      // Pi still owns the relativizing, limits and notices under test.
      tools: createLobuTools(dir).map((tool) =>
        tool.name !== "find"
          ? tool
          : createFindTool(dir, {
              operations: {
                exists: existsSync,
                glob: async (pattern, cwd, { ignore, limit }) =>
                  [
                    ...new Glob(pattern).scanSync({
                      cwd,
                      dot: true,
                      onlyFiles: false,
                    }),
                  ]
                    .filter(
                      (path) =>
                        !ignore.some((pattern) => new Glob(pattern).match(path))
                    )
                    .sort()
                    .slice(0, limit)
                    .map((path) => join(cwd, path)),
              },
            })
      ),
      read: (path: string) => readFile(join(dir, path)),
      seed: async (path: string, data: string) => {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), data);
      },
    },
    {
      tools: workspace.tools,
      read: (path: string) =>
        workspace.fs.readFileBuffer(workspace.resolve(path)),
      seed: async (path: string, data: string) => {
        await workspace.fs.mkdir(dirname(workspace.resolve(path)), {
          recursive: true,
        });
        await workspace.fs.writeFile(workspace.resolve(path), data);
      },
    },
  ];
}

describe("Lobu file tools on both runtimes", () => {
  test("offers the same read, write, edit, ls and find schemas", async () => {
    const [node, isolate] = await lanes();
    for (const name of ["read", "write", "edit", "ls", "find"]) {
      const schema = (tools: typeof node.tools) =>
        JSON.parse(
          JSON.stringify(tools.find((tool) => tool.name === name)!.parameters)
        );
      expect(schema(isolate.tools)).toEqual(schema(node.tools));
    }
  });

  test("uses Pi's read slicing and truncation, including continuation details", async () => {
    const fixtures = await lanes();
    for (const content of [
      "first\nsecond\nthird\n",
      "x\n".repeat(2500),
      "€".repeat(18000),
    ]) {
      for (const lane of fixtures) await lane.seed("a.txt", content);
      for (const extra of [
        {},
        { offset: 2, limit: 1 },
        { offset: 0, limit: 0 },
      ]) {
        if (extra.offset === 2 && !content.includes("\n")) continue;
        const results = await Promise.all(
          fixtures.map((lane) =>
            lane.tools
              .find((tool) => tool.name === "read")!
              .execute("read", { file_path: "a.txt", ...extra })
          )
        );
        expect(results[1]).toEqual(results[0]);
      }
    }
  });

  test("lists and finds real and in-memory files with Pi's results and limits", async () => {
    const fixtures = await lanes();
    for (const lane of fixtures) {
      for (const path of [
        ".hidden.txt",
        "src/a.txt",
        "src/nested/b.txt",
        "node_modules/ignored.txt",
        ".git/ignored.txt",
      ]) {
        await lane.seed(path, "fixture");
      }
    }
    for (const [name, args] of [
      ["ls", {}],
      ["ls", { path: "src", limit: 1 }],
      ["find", { pattern: "**/*.txt" }],
      ["find", { pattern: "src/**/*.txt", limit: 1 }],
      ["find", { pattern: "**/*.absent" }],
    ] as const) {
      const results = await Promise.all(
        fixtures.map((lane) =>
          lane.tools.find((tool) => tool.name === name)!.execute(name, args)
        )
      );
      expect(results[1]).toEqual(results[0]);
    }
    for (const lane of fixtures) {
      for (const name of ["read", "ls", "find"]) {
        await expect(
          lane.tools
            .find((tool) => tool.name === name)!
            .execute(
              "cancelled",
              { file_path: "src/a.txt", pattern: "**/*.txt" },
              AbortSignal.abort()
            )
        ).rejects.toThrow("Operation aborted");
      }
    }
  });

  test("writes and edits through the existing snake_case contract, including deletion", async () => {
    const results = [];
    for (const lane of await lanes()) {
      const write = lane.tools.find((tool) => tool.name === "write")!;
      const edit = lane.tools.find((tool) => tool.name === "edit")!;
      const written = await write.execute("write", {
        file_path: "a.txt",
        content: "hello world\n",
      });
      const edited = await edit.execute("edit", {
        file_path: "a.txt",
        old_string: "world",
        new_string: "Pi",
      });
      const deleted = await edit.execute("delete", {
        file_path: "a.txt",
        old_string: "hello ",
        new_string: "",
      });
      expect(new TextDecoder().decode(await lane.read("a.txt"))).toBe("Pi\n");
      results.push({ written, edited, deleted });
    }
    expect(results[1]).toEqual(results[0]);
  });

  test("cancellation prevents both writes and edits", async () => {
    for (const lane of await lanes()) {
      await lane.seed("a.txt", "before");
      const signal = AbortSignal.abort();
      for (const [name, args] of [
        ["write", { file_path: "a.txt", content: "after" }],
        [
          "edit",
          { file_path: "a.txt", old_string: "before", new_string: "after" },
        ],
      ] as const) {
        await expect(
          lane.tools
            .find((tool) => tool.name === name)!
            .execute(name, args, signal)
        ).rejects.toThrow("Operation aborted");
        expect(new TextDecoder().decode(await lane.read("a.txt"))).toBe(
          "before"
        );
      }
    }
  });

  test("preserves BOM and CRLF, returns the same diff, and failed edits leave bytes intact", async () => {
    const results = [];
    for (const lane of await lanes()) {
      await lane.seed("a.txt", "\ufeffsay “hello”\r\nsecond\r\n");
      const edit = lane.tools.find((tool) => tool.name === "edit")!;
      results.push(
        await edit.execute("edit", {
          file_path: "a.txt",
          old_string: 'say "hello"',
          new_string: "say hi",
        })
      );
      const bytes = Array.from(await lane.read("a.txt"));
      expect(bytes.slice(0, 3)).toEqual([0xef, 0xbb, 0xbf]);
      expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe(
        "say hi\r\nsecond\r\n"
      );
      await expect(
        edit.execute("missing", {
          file_path: "a.txt",
          old_string: "not present",
          new_string: "x",
        })
      ).rejects.toThrow("Could not find the exact text in a.txt");
      expect(Array.from(await lane.read("a.txt"))).toEqual(bytes);
    }
    expect(results[1]).toEqual(results[0]);
  });
});
