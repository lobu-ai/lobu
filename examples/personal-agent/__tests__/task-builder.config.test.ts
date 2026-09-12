import { describe, expect, test } from "bun:test";
import config from "../lobu.config";

describe("Task Builder notification contract", () => {
  const automation = config.automations?.find(
    (item) => item.slug === "hourly-task-collaborator"
  );

  test("queues a reaction for tasks without deadlines", () => {
    expect(automation?.reaction).toMatchObject({
      path: "./task-builder.reaction.ts",
    });
  });

  test("uses the Gmail feed's supported stable key", () => {
    expect(automation?.sources?.mail).toBe("@feed:threads");
  });

  test("persists optional proposed agent work with the task", () => {
    const task = config.entities?.find((item) => item.key === "task");
    expect(task?.properties).toHaveProperty("agent_help");
  });

  test("direct Gmail includes actionable service notices without scheduling mail copies", () => {
    const gmail = config.connections?.find(
      (item) => item.connector === "google.gmail"
    );
    expect(gmail?.feeds?.[0]).toMatchObject({
      schedule: null,
      config: { query: "-in:spam -in:trash", human_senders_only: false },
    });
  });
});
