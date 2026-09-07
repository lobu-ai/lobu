/**
 * The turn's workspace tools, run under Node against the same just-bash build
 * the guest bundles. What is pinned: the shell and the file tools share one
 * filesystem, the file tools keep pi's contracts (paths, limits, notices), the
 * bash policy runs before a command does, and the shell has no network.
 */
import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createWorkspace, WORKSPACE_ROOT } from "../agent-turn/workspace.js";

function toolMap(tools: AgentTool[]): Record<string, AgentTool> {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

async function run(tool: AgentTool, args: Record<string, unknown>): Promise<string> {
  const result = await tool.execute("call", args as never);
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("createWorkspace tools", () => {
  test("returns only the named tools, once each, in pi's shapes", () => {
    const tools = createWorkspace(["read", "bash", "read", "find"]).tools;
    expect(tools.map((t) => t.name)).toEqual(["read", "bash", "find"]);
    for (const tool of tools) {
      expect(tool.label).toBe(tool.name);
      expect((tool.parameters as { type: string }).type).toBe("object");
    }
    expect(createWorkspace([]).tools).toEqual([]);
  });

  test("bash, write, read, ls and find share one filesystem rooted at the workspace", async () => {
    const t = toolMap(createWorkspace(["bash", "read", "write", "ls", "find"]).tools);
    expect(await run(t.bash, { command: "pwd" })).toBe(`${WORKSPACE_ROOT}\n`);
    expect(await run(t.write, { file_path: "src/a.txt", content: "hello\nworld\n" })).toBe(
      "Successfully wrote 12 bytes to src/a.txt"
    );
    expect(await run(t.bash, { command: "cat src/a.txt | tr a-z A-Z && echo done > src/b.log" })).toBe("HELLO\nWORLD\n");
    expect(await run(t.read, { file_path: "src/b.log" })).toBe("done\n");
    expect(await run(t.read, { file_path: `${WORKSPACE_ROOT}/src/a.txt`, offset: 2, limit: 1 })).toBe(
      "world\n\n[Showing lines 2-2 of 3. 1 more lines. Use offset=3 to continue.]"
    );
    expect(await run(t.ls, {})).toBe("src/");
    expect(await run(t.ls, { path: "src" })).toBe("a.txt\nb.log");
    expect(await run(t.find, { pattern: "*.txt" })).toBe("src/a.txt");
    expect(await run(t.find, { pattern: "src/**/*.log" })).toBe("src/b.log");
    expect(await run(t.find, { pattern: "*.md" })).toBe("No files found matching pattern");
  });

  test("reports command failure, output truncation and the missing network the way the model expects", async () => {
    const t = toolMap(createWorkspace(["bash"]).tools);
    expect(await run(t.bash, { command: "echo oops >&2; exit 3" })).toBe("oops\n\n\nCommand exited with code 3");
    expect(await run(t.bash, { command: "true" })).toBe("(no output)");
    // 3000 numbers plus the trailing newline are 3001 lines; the last 2000 stay.
    const long = await run(t.bash, { command: "seq 1 3000" });
    expect(long.startsWith("1002\n1003\n")).toBe(true);
    expect(long).toContain("[Showing lines 1002-3001 of 3001]");
    // Built without fetch, so the network commands do not exist at all.
    const curl = await run(t.bash, { command: "curl https://example.com" });
    expect(curl).toContain("command not found");
    expect(curl).toContain("Command exited with code");
  });

  test("enforces the bash policy and the package-install block before running anything", async () => {
    const t = toolMap(
      createWorkspace(["bash", "ls"], { allowAll: false, allowPrefixes: ["echo ", "ls"], denyPrefixes: ["rm "] }).tools
    );
    expect(await run(t.bash, { command: "echo ok" })).toBe("ok\n");
    await expect(run(t.bash, { command: "rm -rf /" })).rejects.toThrow("Bash command denied by policy");
    await expect(run(t.bash, { command: "cat /etc/passwd" })).rejects.toThrow("Bash command not allowed by policy");
    await expect(run(t.bash, { command: "echo hi && pip install requests" })).rejects.toThrow(
      "not allowed by policy"
    );
    const open = toolMap(createWorkspace(["bash"]).tools);
    await expect(run(open.bash, { command: "pip install requests" })).rejects.toThrow("DIRECT PACKAGE INSTALL BLOCKED");
  });

  test("refuses what pi's tools refuse: missing paths, directories as files, binary reads, bad offsets", async () => {
    const t = toolMap(createWorkspace(["read", "write", "ls", "bash"]).tools);
    await expect(run(t.read, { file_path: "nope.txt" })).rejects.toThrow("File not found");
    await expect(run(t.read, {})).rejects.toThrow("Missing required parameter: file_path");
    await run(t.write, { file_path: "d/x.txt", content: "a\nb" });
    await expect(run(t.read, { file_path: "d" })).rejects.toThrow("Not a file");
    await expect(run(t.ls, { path: "d/x.txt" })).rejects.toThrow("Not a directory");
    await expect(run(t.read, { file_path: "d/x.txt", offset: 9 })).rejects.toThrow("beyond end of file");
    await run(t.bash, { command: "printf 'a\\0b' > bin.dat" });
    expect(await run(t.read, { file_path: "bin.dat" })).toContain("[Binary file: 3B.");
  });

  test("keeps every file-tool path inside the workspace root", async () => {
    const t = toolMap(createWorkspace(["read", "write", "ls", "find"]).tools);
    // just-bash's in-memory tree has /etc, /usr and the rest in it, and
    // `resolvePath` normalizes right past the root, so both spellings of an
    // escape have to be refused.
    for (const path of ["/etc/passwd", "../../escaped.txt", "a/../../../oops"]) {
      await expect(run(t.write, { file_path: path, content: "x" })).rejects.toThrow(
        "Path is outside the workspace"
      );
      await expect(run(t.read, { file_path: path })).rejects.toThrow("Path is outside the workspace");
    }
    for (const path of ["/", "..", "/etc"]) {
      await expect(run(t.ls, { path })).rejects.toThrow("Path is outside the workspace");
      await expect(run(t.find, { pattern: "*", path })).rejects.toThrow("Path is outside the workspace");
    }
    // An absolute path INSIDE the workspace is still the documented spelling.
    await run(t.write, { file_path: `${WORKSPACE_ROOT}/in.txt`, content: "x" });
    expect(await run(t.read, { file_path: "in.txt" })).toBe("x");
  });

  test("a non-positive limit falls back to the default instead of reporting nothing", async () => {
    // Without the clamp, limit=0 collected no rows and `ls` answered
    // "(empty directory)" for a populated directory — a claim about the
    // workspace, not about the argument. `find` said "No files found".
    const t = toolMap(createWorkspace(["write", "ls", "find"]).tools);
    await run(t.write, { file_path: "a.txt", content: "x" });
    await run(t.write, { file_path: "b.txt", content: "x" });
    expect(await run(t.ls, { limit: 0 })).toBe("a.txt\nb.txt");
    expect(await run(t.find, { pattern: "*.txt", limit: 0 })).toBe("a.txt\nb.txt");
    // A real limit still truncates and says so.
    expect(await run(t.ls, { limit: 1 })).toContain("1 entries limit reached");
  });

  test("each createWorkspace starts from an empty filesystem", async () => {
    const first = toolMap(createWorkspace(["write", "ls"]).tools);
    await run(first.write, { file_path: "kept.txt", content: "x" });
    expect(await run(first.ls, {})).toBe("kept.txt");
    const second = toolMap(createWorkspace(["ls"]).tools);
    expect(await run(second.ls, {})).toBe("(empty directory)");
  });
});

describe("edit and grep — pi's two remaining builtins, inside the isolate", () => {
  test("edit replaces each unique block once against the original and reports pi's message", async () => {
    const t = toolMap(createWorkspace(["write", "edit", "read"]).tools);
    await run(t.write, { file_path: "a.ts", content: "const a = 1;\nconst b = 2;\nconst c = 3;\n" });
    expect(
      await run(t.edit, {
        path: "a.ts",
        edits: [
          { oldText: "const a = 1;", newText: "const a = 10;" },
          { oldText: "const c = 3;", newText: "const c = 30;" },
        ],
      })
    ).toBe("Successfully replaced 2 block(s) in a.ts.");
    expect(await run(t.read, { file_path: "a.ts" })).toBe("const a = 10;\nconst b = 2;\nconst c = 30;\n");
    // pi's older single-replacement shape, and a JSON-string edits array.
    expect(await run(t.edit, { path: "a.ts", oldText: "const b = 2;", newText: "const b = 20;" })).toBe(
      "Successfully replaced 1 block(s) in a.ts."
    );
    expect(
      await run(t.edit, { path: "a.ts", edits: JSON.stringify([{ oldText: "const b = 20;", newText: "const b = 2;" }]) })
    ).toBe("Successfully replaced 1 block(s) in a.ts.");
  });

  test("edit refuses what pi refuses, in pi's words", async () => {
    const t = toolMap(createWorkspace(["write", "edit"]).tools);
    await run(t.write, { file_path: "b.txt", content: "one two\none three\n" });
    await expect(run(t.edit, { path: "b.txt", edits: [{ oldText: "four", newText: "x" }] })).rejects.toThrow(
      "Could not find the exact text in b.txt."
    );
    await expect(run(t.edit, { path: "b.txt", edits: [{ oldText: "one", newText: "x" }] })).rejects.toThrow(
      "Found 2 occurrences of the text in b.txt. The text must be unique."
    );
    await expect(run(t.edit, { path: "b.txt", edits: [{ oldText: "", newText: "x" }] })).rejects.toThrow(
      "oldText must not be empty in b.txt."
    );
    await expect(run(t.edit, { path: "b.txt", edits: [{ oldText: "two", newText: "two" }] })).rejects.toThrow(
      "No changes made to b.txt."
    );
    await expect(
      run(t.edit, {
        path: "b.txt",
        edits: [
          { oldText: "one two", newText: "a" },
          { oldText: "two\none", newText: "b" },
        ],
      })
    ).rejects.toThrow("overlap in b.txt");
    await expect(run(t.edit, { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow(
      "Could not edit file: missing.txt."
    );
    await expect(run(t.edit, { path: "b.txt", edits: [] })).rejects.toThrow("edits must contain at least one replacement");
    await expect(run(t.edit, { path: "../escape.txt", edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow(
      "Path is outside the workspace"
    );
  });

  test("edit keeps the file's line endings and BOM, and matches across pi's fuzzy normalisation", async () => {
    const ws = createWorkspace(["write", "edit", "read"]);
    const t = toolMap(ws.tools);
    await run(t.write, { file_path: "crlf.txt", content: "﻿first\r\nsecond\r\n" });
    await run(t.edit, { path: "crlf.txt", edits: [{ oldText: "second", newText: "2nd" }] });
    // `read` decodes the BOM away, as pi's does; the bytes on disk keep it: 3 (BOM) + 12.
    expect(await run(t.read, { file_path: "crlf.txt" })).toBe("first\r\n2nd\r\n");
    const bytes = await ws.fs.readFileBuffer(ws.resolve("crlf.txt"));
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.length).toBe(15);
    // Curly quotes in the file, straight quotes from the model: pi matches them.
    await run(t.write, { file_path: "q.txt", content: "say “hello”\n" });
    await run(t.edit, { path: "q.txt", edits: [{ oldText: 'say "hello"', newText: 'say "bye"' }] });
    expect(await run(t.read, { file_path: "q.txt" })).toBe('say "bye"\n');
  });

  test("grep searches the workspace tree with pi's output shape, filters, context and limits", async () => {
    const t = toolMap(createWorkspace(["write", "grep"]).tools);
    await run(t.write, { file_path: "src/a.ts", content: "import x\nconst TODO = 1;\n// todo later\n" });
    await run(t.write, { file_path: "src/b.md", content: "TODO in docs\n" });
    await run(t.write, { file_path: "node_modules/dep/c.ts", content: "TODO ignored\n" });
    expect(await run(t.grep, { pattern: "TODO" })).toBe("src/a.ts:2: const TODO = 1;\nsrc/b.md:1: TODO in docs");
    expect(await run(t.grep, { pattern: "todo", ignoreCase: true, glob: "*.ts" })).toBe(
      "src/a.ts:2: const TODO = 1;\nsrc/a.ts:3: // todo later"
    );
    expect(await run(t.grep, { pattern: "TODO", path: "src/b.md" })).toBe("b.md:1: TODO in docs");
    expect(await run(t.grep, { pattern: "const TODO = 1;", literal: true, context: 1 })).toBe(
      "src/a.ts-1- import x\nsrc/a.ts:2: const TODO = 1;\nsrc/a.ts-3- // todo later"
    );
    expect(await run(t.grep, { pattern: "TODO", limit: 1 })).toBe(
      "src/a.ts:2: const TODO = 1;\n\n[1 matches limit reached. Use limit=2 for more, or refine pattern]"
    );
    expect(await run(t.grep, { pattern: "nothing-here" })).toBe("No matches found");
    await expect(run(t.grep, { pattern: "[" })).rejects.toThrow("Invalid regex pattern");
    await expect(run(t.grep, { pattern: "x", path: "/etc" })).rejects.toThrow("Path is outside the workspace");
    await expect(run(t.grep, { pattern: "x", path: "nope" })).rejects.toThrow("Path not found");
  });

  test("grep truncates long lines the way pi does and says so", async () => {
    const t = toolMap(createWorkspace(["write", "grep"]).tools);
    await run(t.write, { file_path: "long.txt", content: `${"k".repeat(600)}\n` });
    const out = await run(t.grep, { pattern: "k" });
    expect(out).toContain("... [truncated]");
    expect(out).toContain("[Some lines truncated to 500 chars. Use read tool to see full lines]");
  });
});
