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

  test("runs every 15 minutes under its durable slug", () => {
    expect(automation?.triggers?.[0]).toMatchObject({ cron: "*/15 * * * *" });
  });

  test("reads Apple Reminders live instead of declaring a stored source", () => {
    expect(Object.values(automation?.sources ?? {})).not.toContain(
      "@feed:reminders"
    );
    expect(automation?.prompt).toContain("client.feeds.readMany");
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

  test("never schedules the Apple Reminders feed", () => {
    const reminders = config.connections?.find(
      (item) => item.connector === "apple.reminders"
    );
    if (!reminders) return;
    expect(reminders.feeds).toEqual([{ feed: "reminders", schedule: null }]);
  });
});
