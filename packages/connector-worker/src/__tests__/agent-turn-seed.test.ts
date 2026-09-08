/**
 * Seeded workspace files: the turn's non-image attachments and the agent's
 * enabled skills are written into the turn filesystem before the model runs,
 * so `cat` and `read` reach them exactly as they do on the subprocess lane.
 */
import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createWorkspace, INPUT_DIR, SKILLS_DIR, WORKSPACE_ROOT } from "../agent-turn/workspace.js";

function toolMap(tools: AgentTool[]): Record<string, AgentTool> {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

async function run(tool: AgentTool, args: Record<string, unknown>): Promise<string> {
  const result = await tool.execute("call", args as never);
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("seeded workspace files", () => {
  test("a non-image attachment's bytes land in input/ and are readable", async () => {
    const ws = createWorkspace(["bash", "read", "ls"]);
    await ws.seed([
      { path: `${INPUT_DIR}/notes.csv`, data: Buffer.from("a,b\n1,2\n").toString("base64") },
    ]);
    const t = toolMap(ws.tools);
    expect(await run(t.read, { file_path: `${INPUT_DIR}/notes.csv` })).toBe("a,b\n1,2\n");
    expect(await run(t.bash, { command: `cat ${INPUT_DIR}/notes.csv | wc -l` })).toBe("2\n");
  });

  test("binary bytes survive the seed exactly", async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]);
    const ws = createWorkspace(["bash"]);
    await ws.seed([{ path: `${INPUT_DIR}/blob.bin`, data: bytes.toString("base64") }]);
    const out = await ws.fs.readFileBuffer(`${INPUT_DIR}/blob.bin`);
    expect(Buffer.from(out).equals(bytes)).toBe(true);
  });

  test("a skill lands at .skills/<name>/SKILL.md", async () => {
    const ws = createWorkspace(["read"]);
    await ws.seed([{ path: `${SKILLS_DIR}/triage/SKILL.md`, text: "# Triage\nDo the thing.\n" }]);
    const t = toolMap(ws.tools);
    expect(await run(t.read, { file_path: `${SKILLS_DIR}/triage/SKILL.md` })).toContain("# Triage");
  });

  test("a seed cannot escape the workspace root", async () => {
    const ws = createWorkspace(["read"]);
    await expect(ws.seed([{ path: "../../etc/passwd", text: "x" }])).rejects.toThrow();
    await expect(ws.seed([{ path: "/etc/passwd", text: "x" }])).rejects.toThrow();
  });

  test("seeding works with no builtin tools selected", async () => {
    const ws = createWorkspace([]);
    await ws.seed([{ path: `${INPUT_DIR}/x.txt`, text: "hi" }]);
    expect(await ws.fs.readFile(`${WORKSPACE_ROOT}/input/x.txt`)).toBe("hi");
  });
});
