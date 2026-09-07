import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const workspace = createWorkspace(["write", "edit"]);
  await workspace.ready;
  return [
    {
      tools: createLobuTools(dir),
      read: (path: string) => readFile(join(dir, path)),
      seed: (path: string, data: string) => writeFile(join(dir, path), data),
    },
    {
      tools: workspace.tools,
      read: (path: string) =>
        workspace.fs.readFileBuffer(workspace.resolve(path)),
      seed: (path: string, data: string) =>
        workspace.fs.writeFile(workspace.resolve(path), data),
    },
  ];
}

describe("Lobu file tools on both runtimes", () => {
  test("offers the same write and edit schemas", async () => {
    const [node, isolate] = await lanes();
    for (const name of ["write", "edit"]) {
      const schema = (tools: typeof node.tools) =>
        JSON.parse(
          JSON.stringify(tools.find((tool) => tool.name === name)!.parameters)
        );
      expect(schema(isolate.tools)).toEqual(schema(node.tools));
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
