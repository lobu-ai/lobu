import { describe, expect, test } from "bun:test";
import config from "../lobu.config";

describe("Lobu Team configuration", () => {
  test("owns office and product operations in one organization config", () => {
    expect(config.org).toBe("lobu-team");
    expect(config.organizationId).toBe("UdNAH1bb3csC842vhOgxAHVcfX4tYU5A");
    expect(config.automations?.map((automation) => automation.slug)).toEqual([
      "lobu-team-lunch-open",
      "lobu-team-lunch-finalize",
      "product-activity-digest",
      "engineering-task-runner-dogfood-35364",
    ]);
  });

  test("owns the engineering task schema and runner configuration", () => {
    const task = config.entities?.find(
      (entity) => entity.key === "engineering-task"
    );
    expect(task).toMatchObject({
      name: "Engineering Task",
      eventKinds: {
        "engineering-task.checkpoint": expect.any(Object),
        "engineering-task.decision": expect.any(Object),
        "engineering-task.verification_completed": expect.any(Object),
        "engineering-task.review_completed": expect.any(Object),
      },
    });

    const target = config.relationships?.find(
      (relationship) => relationship.key === "targets_repository"
    );
    expect(target?.rules).toEqual([
      {
        source: expect.objectContaining({ key: "engineering-task" }),
        target: "$resource",
      },
    ]);

    const runner = config.automations?.find(
      (automation) =>
        automation.slug === "engineering-task-runner-dogfood-35364"
    );
    expect(runner).toMatchObject({
      agent: "developer",
      triggers: [],
      deviceWorkerId: "66af4f1d-13c5-4d2d-b848-5b6b5dde7b63",
      agentKind: "opencode",
      tags: ["engineering-task", "dogfood"],
    });
    expect(runner?.sources?.task_history).toContain(
      "entity_ids @> ARRAY[35364]::bigint[]"
    );
    expect(runner?.prompt).toContain("entity_id: 35364");
    expect(runner?.prompt).toContain("Never edit a shared checkout");
    expect(runner?.prompt).toContain("engineering-task.checkpoint");

    expect(config.agents.find((agent) => agent.id === "developer")).toEqual({
      kind: "agent",
      id: "developer",
      name: "Developer",
      description:
        "A software development agent for Lobu repositories that works in the team Vercel sandbox, runs checks, creates pull requests, reviews previews, and coordinates approved merges.",
    });
  });

  test("uses one hosted Slack declaration for the whole team", () => {
    expect(
      config.connections?.filter(
        (connection) => connection.connector === "slack"
      )
    ).toEqual([
      expect.objectContaining({
        slug: "lobu-team-slack",
        credentialMode: "hosted",
        surfaces: ["dm", "channel"],
      }),
    ]);
  });

  test("keeps product activity and logs organization-owned", () => {
    expect(
      config.connections?.find(
        (connection) => connection.slug === "lobu-product-activity-db"
      )
    ).toMatchObject({ connector: "postgres" });
    expect(
      config.connections?.find(
        (connection) => connection.slug === "lobu-production-logs"
      )
    ).toMatchObject({ connector: "loki.activity" });

    const digest = config.automations?.find(
      (automation) => automation.slug === "product-activity-digest"
    );
    expect(digest?.triggers).toEqual([
      {
        kind: "schedule",
        cron: "5,25,45 * * * *",
        skip_if_unchanged: false,
      },
    ]);
    expect(digest?.sources).toEqual({
      reaction_window: "SELECT * FROM events WHERE FALSE",
    });
    expect(digest?.agent).toMatchObject({
      id: "product-ops",
      providers: [{ id: "gemini", model: "gemini-2.5-flash" }],
      tools: {
        allowed: [],
        strict: true,
        preApproved: ["/mcp/lobu-memory/tools/run_sdk"],
      },
    });
    expect(digest?.reaction).toMatchObject({
      kind: "reactionSource",
      path: "./product-activity-digest.reaction.ts",
    });
  });
});
