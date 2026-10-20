import { expect, mock, test } from "bun:test";
import { configureSocialResearch } from "../scripts/configure-social-research";

const reader = `const keys=['navigate','evaluate','close_tab']; let identity; if(identity?.profile!=='/synthetic') throw new Error('identity'); let data; const r = await read({connection_id:11,expression:"({timeline:['Following'],posts:[]})"}); data=r.output?.value; return {account:data.account, posts:data.posts,coverage:'First loaded page only; no scrolling'};`;
function harness(pendingAt?: number, status = "completed", script = reader) {
  const calls: string[] = [];
  const mutate = (name: string) =>
    mock(async (_input: Record<string, any>) => {
      calls.push(name);
      return calls.length === pendingAt
        ? { status: "pending_approval" }
        : { status: "completed" };
    });
  const automation = {
    slug: "x-market-scan",
    prompt: `Reader\n\`\`\`typescript\n${script}\n\`\`\``,
    automation_run: { status },
  };
  const automations = {
    get: mock(async () => ({ automation })),
    update: mutate("update"),
    setReactionScript: mutate("reaction"),
    createVersion: mutate("version"),
  };
  return {
    calls,
    automations,
    automation,
    run: () =>
      configureSocialResearch(
        { automations } as unknown as Parameters<
          typeof configureSocialResearch
        >[0],
        "42",
        "export default async()=>{}",
        "test-agent"
      ),
  };
}

test("reuses the X Automation and its reader, adds receipt evidence, and leaves cadence disabled", async () => {
  const h = harness();
  await h.run();
  expect(h.calls).toEqual(["update", "reaction", "version", "update"]);
  const version = h.automations.createVersion.mock.calls[0][0];
  expect(version.prompt).toContain("read_run_id=r.run_id");
  expect(version.prompt).toContain("return {read_run_id,account:");
  expect(version.outputs).toBeNull();
  expect(version.prompt).toContain("linkedin:live_messages");
  expect(version.prompt).toContain("tiktok:activity");
  expect(version.prompt).toContain("source_cursor");
  expect(version.prompt).toContain("social-x-fifty-v1");
  expect(version.prompt).toContain("50 unique posts per platform");
  expect(
    h.automations.update.mock.calls.every(
      ([args]) => args.triggers.length === 0
    )
  ).toBe(true);
  expect(
    h.automations.update.mock.calls[1][0].execution_config
  ).not.toHaveProperty("executor");
  // Configuration can be safely re-run without injecting another declaration.
  h.automation.prompt = version.prompt;
  await h.run();
  expect(h.automations.createVersion.mock.calls[1][0].prompt).toBe(
    version.prompt
  );
});

test("stops at policy approval and waits for active runs after disabling the schedule", async () => {
  for (const pendingAt of [1, 2, 3, 4]) {
    const h = harness(pendingAt);
    await expect(h.run()).rejects.toThrow("awaiting policy approval");
    expect(h.calls).toHaveLength(pendingAt);
  }
  for (const status of ["pending", "claimed", "running"]) {
    const h = harness(undefined, status);
    await expect(h.run()).rejects.toThrow("active social scan");
    expect(h.calls).toEqual(["update"]);
  }
});

test("a changed or missing source reader fails before configuration changes", async () => {
  for (const script of [
    "return [];",
    reader.replace("First loaded page only; no scrolling", "Unknown coverage"),
  ]) {
    const h = harness(undefined, "completed", script);
    await expect(h.run()).rejects.toThrow("reader shape changed");
    expect(h.calls).toEqual([]);
  }
});

test("legacy managed setup cannot replace a live external processor or its scope", async () => {
  const h = harness();
  Object.assign(h.automation, {
    execution_config: { executor: { kind: "external" } },
  });
  await expect(h.run()).rejects.toThrow("external");
  expect(h.calls).toEqual([]);
});
