/**
 * The turn's workspace tools, run under Node against the same just-bash build
 * the guest bundles. Local bash and the file tools share one filesystem; a
 * pinned remote bash does not. The file tools keep pi's contracts (paths,
 * limits, notices), and bash policy runs before either shell executes.
 */
import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { truncateTail } from "@mariozechner/pi-coding-agent";
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
      "world\n\n[1 more lines in file. Use offset=3 to continue.]"
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

  test("describes a remote bash separately from the in-memory file workspace", async () => {
    const remote = {
      exec: async () => ({ status: 200, stdout: "remote\n", stderr: "", exitCode: 0 }),
    };
    const t = toolMap(createWorkspace(["bash", "read"], undefined, remote).tools);
    expect(t.bash.description).toContain("pinned remote sandbox");
    expect(t.bash.description).toContain("does not share the file tools' in-memory workspace");
    expect(t.bash.description).not.toContain("workspace has no network access");
    expect(await run(t.bash, { command: "pwd" })).toBe("remote\n");
    await expect(run(t.bash, { command: "pip install requests" })).rejects.toThrow(
      "Use the sandbox packages configured by an admin"
    );
  });

  test("retains Pi's UTF-8 tail when one output line exceeds the byte cap", async () => {
    const workspace = createWorkspace(["bash"]);
    await workspace.ready;
    for (const content of [" ".repeat(51200) + "x", "€".repeat(18000)]) {
      await workspace.fs.writeFile(workspace.resolve("large.txt"), content);
      const expected = truncateTail(content);
      const output = await run(workspace.tools[0], { command: "cat large.txt" });
      expect(output.startsWith(expected.content)).toBe(true);
      expect(output).toContain("[Showing lines 1-1 of 1 (50.0KB limit)]");
      expect(output).not.toContain("�");
      expect(expected.lastLinePartial).toBe(true);
    }
  });

  test("cancelled read, ls and find refuse before reading the workspace", async () => {
    const workspace = createWorkspace(["read", "ls", "find"]);
    await workspace.ready;
    await workspace.fs.writeFile(workspace.resolve("a.txt"), "before");
    for (const tool of workspace.tools) {
      await expect(tool.execute("cancelled", { file_path: "a.txt", pattern: "*.txt" }, AbortSignal.abort()))
        .rejects.toThrow("Operation aborted");
    }
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
  test("edit uses the shared file parameters and refuses paths outside the workspace", async () => {
    const t = toolMap(createWorkspace(["write", "edit", "read"]).tools);
    await run(t.write, { file_path: "a.txt", content: "one two\n" });
    expect(await run(t.edit, { file_path: "a.txt", old_string: "two", new_string: "three" })).toBe(
      "Successfully replaced 1 block(s) in a.txt."
    );
    expect(await run(t.read, { file_path: "a.txt" })).toBe("one three\n");
    await expect(run(t.edit, { file_path: "../escape.txt", old_string: "a", new_string: "b" })).rejects.toThrow("Path is outside the workspace");
    await expect(run(t.edit, { file_path: "missing.txt", old_string: "a", new_string: "b" })).rejects.toThrow("Could not edit file: missing.txt");
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
