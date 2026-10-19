import { expect, mock, test } from "bun:test";
import { configureExternalSocial } from "../scripts/configure-external-social";
import { externalSocialPrompt } from "../external-social.prompt";
import { deliverExternalSocial } from "../external-social.reaction";

const policy = {
  workspace: "synthetic-team",
  workflow: "synthetic-social",
  platforms: ["x"],
  receipt_workspaces: { x: ["synthetic-team"] },
};
function fixture() {
  const automation = {
    version: 3,
    automation_name: "Social",
    description: "Research",
    prompt: "Owner policy: no likes. Keep company Page and voice profile.",
    sources: [{ name: "context", query: "SELECT CURRENT_TIMESTAMP" }],
    outputs: {
      findings: { event: "note" },
      briefings: { event: "observation" },
    },
    execution_config: { executor: { kind: "external" } },
    automation_run: { status: "completed" },
    reaction_script: "old",
    reactions_guidance: "Owner guidance: notify the owner.",
  };
  const client = {
    automations: {
      get: mock(async () => ({ automation })),
      setReactionScript: mock(async ({ reaction_script }: any) => {
        automation.reaction_script = reaction_script;
        return { status: "completed" };
      }),
      createVersion: mock(async (args: any) => {
        Object.assign(automation, args, { version: automation.version + 1 });
        return { status: "completed" };
      }),
    },
  };
  return {
    automation,
    client,
    run: () => configureExternalSocial(client as any, "10", 3, policy),
  };
}
test("external configuration preserves live owner instructions and output contracts without changing cadence", async () => {
  const h = fixture();
  await h.run();
  expect(h.automation.prompt).toContain("Owner policy: no likes");
  expect(h.automation.prompt).toContain("MANDATORY COMPLETION PREFLIGHT");
  expect(h.client.automations.createVersion.mock.calls[0][0].outputs).toEqual(
    h.automation.outputs
  );
  expect(h.automation.execution_config.executor.kind).toBe("external");
  expect(h.automation.reactions_guidance).toStartWith(
    "Owner guidance: notify the owner."
  );
  expect(h.automation.reactions_guidance).toContain(h.automation.prompt);
  await configureExternalSocial(h.client as any, "10", 4, policy);
  expect(h.client.automations.createVersion).toHaveBeenCalledTimes(1);
  expect(h.client.automations.setReactionScript).toHaveBeenCalledTimes(1);
});
test("version drift and active windows stop updates before mutation", async () => {
  for (const status of ["claimed", "pending", "running"]) {
    const h = fixture();
    h.automation.automation_run.status = status;
    await expect(h.run()).rejects.toThrow("active external");
    expect(h.client.automations.setReactionScript).not.toHaveBeenCalled();
  }
  const h = fixture();
  h.automation.version = 4;
  await expect(h.run()).rejects.toThrow("changed");
  expect(h.client.automations.setReactionScript).not.toHaveBeenCalled();
});
test("prompt upgrade is idempotent and embeds executable functions without local paths", () => {
  const prompt = externalSocialPrompt("Existing instructions", policy);
  expect(externalSocialPrompt(prompt, policy)).toBe(prompt);
  expect(prompt).not.toContain("/Users/");
  const code = [...prompt.matchAll(/```typescript\n([\s\S]*?)\n```/g)].map(
    (m) => m[1]
  );
  expect(code).toHaveLength(2);
  for (const source of code) expect(() => new Function(source!)).not.toThrow();
});
test("reaction reports missing evidence rather than silently delivering unverified findings", async () => {
  const send = mock(async (_input: Record<string, unknown>) => ({
    event_id: 100,
  }));
  const ctx = {
    automation: { id: 10 },
    window: { run_id: 20 },
    extracted_data: {
      briefings: [
        {
          content: "unsupported claim must not be sent",
          metadata: {
            workflow: policy.workflow,
            run_id: 20,
            coverage: [
              {
                platform: "x",
                posts_read: 50,
                status: "read",
                read_receipts: [],
              },
            ],
          },
        },
      ],
      findings: [],
    },
  };
  const result = await deliverExternalSocial(
    ctx,
    {
      query: async () => [{ created_by: "synthetic-owner" }],
      notifications: { send },
    },
    policy
  );
  expect(result.evidence_verified).toBe(false);
  expect(send.mock.calls[0][0].body).not.toContain("unsupported claim");
  expect(send.mock.calls[0][0].title).toBe("Social research needs evidence");
});

test("reaction requires the same numeric run identity as completion preflight", async () => {
  await expect(
    deliverExternalSocial(
      {
        window: { run_id: 20 },
        extracted_data: {
          briefings: [
            { metadata: { workflow: policy.workflow, run_id: "20" } },
          ],
          findings: [],
        },
      },
      {},
      policy
    )
  ).rejects.toThrow("Briefing ownership/run mismatch");
});

test("a verified briefing is delivered within the notification limit without splitting an emoji", async () => {
  const send = mock(async (_input: Record<string, unknown>) => ({
    event_id: 101,
  }));
  const receipt = { workspace: policy.workspace, run_id: 20 };
  const result = await deliverExternalSocial(
    {
      automation: { id: 10 },
      window: { run_id: 20 },
      extracted_data: {
        briefings: [
          {
            // Summary (21 units) plus two newlines puts the emoji across the 980 cut.
            content: `${"x".repeat(956)}😀`,
            metadata: {
              workflow: policy.workflow,
              run_id: 20,
              coverage: [
                {
                  platform: "x",
                  posts_read: 1,
                  recent_posts_read: 1,
                  status: "read",
                  read_receipts: [receipt],
                },
              ],
              evidence_verification: {
                version: 1,
                run_id: 20,
                issues: [],
                verified_findings: 0,
              },
            },
          },
        ],
        findings: [],
      },
    },
    {
      query: async () => [{ created_by: "synthetic-owner" }],
      notifications: { send },
    },
    policy
  );
  expect(result.evidence_verified).toBe(true);
  const body = send.mock.calls[0][0].body as string;
  expect(body.startsWith("x: 1 text posts, read\n\n")).toBe(true);
  expect(body).toHaveLength(979);
  expect(body.endsWith("x")).toBe(true);
});
