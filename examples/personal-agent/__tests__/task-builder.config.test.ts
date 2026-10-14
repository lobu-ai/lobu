import { describe, expect, test } from "bun:test";
import config from "../lobu.config";

describe("Task Collaborator keeps tasks in Apple Reminders", () => {
  const automation = config.automations?.find(
    (item) => item.slug === "task-collaborator"
  );

  test("stores no tasks in Lobu", () => {
    expect(config.entities?.some((item) => item.key === "task")).toBe(false);
    expect(automation?.outputs).toBeUndefined();
  });

  test("applies reminder changes in its reaction", () => {
    expect(automation?.reaction).toMatchObject({
      path: "./task-builder.reaction.ts",
    });
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

  test("uses the Gmail feed's supported stable key", () => {
    expect(automation?.sources?.mail).toBe("@feed:threads");
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

  test.each([
    "",
    "test-reminders-device",
  ])("declares an unscheduled Reminders feed only with a device pin (%s)", (deviceWorkerId) => {
    // A fresh process exercises both branches without leaking env or module cache.
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        'import config from "./lobu.config.ts"; console.log(JSON.stringify(config.connections?.find(item => item.connector === "apple.reminders") ?? null));',
      ],
      {
        cwd: `${import.meta.dir}/..`,
        env: { ...process.env, REMINDERS_DEVICE_WORKER_ID: deviceWorkerId },
      }
    );
    expect(result.exitCode).toBe(0);
    const reminders = JSON.parse(result.stdout.toString());
    expect(reminders).toEqual(
      deviceWorkerId
        ? {
            kind: "connection",
            slug: "reminders",
            connector: "apple.reminders",
            name: "Apple Reminders",
            deviceWorkerId,
            feeds: [{ feed: "reminders", schedule: null }],
          }
        : null
    );
  });
});
