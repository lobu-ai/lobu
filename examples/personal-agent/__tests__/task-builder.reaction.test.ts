import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import notifyTasks from "../task-builder.reaction";

const help = {
  summary: "Audit the requested OAuth data-use details and draft a reply.",
  prompt:
    "Read the latest verification request, check the provider configuration and prepare a reply for review. Do not send it.",
};
const candidate = {
  action: "Respond to the OAuth verification request",
  status: "backlog",
  source_scope: "connection:101",
  source_origin_id: "synthetic-oauth-thread",
  task_key: "reply-verification",
  agent_help: help,
};
type DueTask = {
  id: number;
  name: string;
  due_date: string;
  priority: string | null;
};
const context = (tasks: unknown[]): ReactionContext => ({
  extracted_data: { tasks },
  entities: [],
  window: {
    run_id: 901,
    automation_id: 71,
    window_start: "2026-09-10T10:00:00Z",
    window_end: "2026-09-10T12:00:00Z",
    content_analyzed: 1,
  },
  automation: {
    id: 71,
    slug: "hourly-task-collaborator",
    name: "Task Builder",
    version: 1,
  },
  organization_id: "synthetic-org",
  organization_slug: "example",
});
function harness(
  metadata: Record<string, unknown> | null = candidate,
  changeKind: "created" | "updated" | "denied" | null = "created",
  dueTasks: DueTask[] = []
) {
  const sends: Parameters<ReactionClient["notifications"]["send"]>[0][] = [];
  const queries: string[] = [];
  let fail = false;
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith("SELECT md5('")) {
        const signature = sql.slice(
          "SELECT md5('".length,
          -"') AS digest".length
        );
        return [{ digest: createHash("md5").update(signature).digest("hex") }];
      }
      if (sql.includes("semantic_type = 'change_set'")) {
        return changeKind
          ? [{ metadata: { changes: [{ entityId: 42, kind: changeKind }] } }]
          : [];
      }
      if (sql.includes("AS due_date")) return dueTasks;
      return metadata
        ? [
            {
              id: 42,
              name: "OAuth verification",
              slug: "oauth-verification",
              metadata,
            },
          ]
        : [];
    },
    notifications: {
      send: async (input: (typeof sends)[number]) => {
        if (fail) throw new Error("notification unavailable");
        sends.push(input);
        return { success: true };
      },
    },
    log: () => undefined,
  } as unknown as ReactionClient;
  return {
    client,
    sends,
    queries,
    fail: () => {
      fail = true;
    },
  };
}
describe("Task Builder completion reaction", () => {
  test("an actionable service email without a deadline offers reviewable agent work", async () => {
    const h = harness();
    await notifyTasks(context([candidate]), h.client);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]?.title).toContain("Agent help available");
    const url = new URL(h.sends[0]!.resource_url!, "https://example.test");
    expect(url.pathname).toBe("/example/chat/personal-agent");
    expect(url.searchParams.get("new")).toBe("1");
    expect(url.searchParams.get("prompt")).toContain("Read its current status");
    expect(h.sends[0]?.idempotency_key).toBe("task-builder:task:42:notice:v1");
  });
  test("replays and wording changes address the same notification", async () => {
    const first = harness();
    await notifyTasks(context([candidate]), first.client);
    const reworded = { ...candidate, action: "Handle the OAuth review" };
    const second = harness(reworded);
    await notifyTasks(
      {
        ...context([reworded]),
        window: { ...context([]).window, run_id: 902 },
      },
      second.client
    );
    expect(first.sends[0]?.title).not.toBe(second.sends[0]?.title);
    expect(first.sends[0]?.idempotency_key).toBe(
      second.sends[0]?.idempotency_key
    );
  });
  test.each([
    "done",
    "dismissed",
  ])("does not notify a task closed as %s after extraction", async (status) => {
    const h = harness({ ...candidate, status });
    await notifyTasks(context([candidate]), h.client);
    expect(h.sends).toHaveLength(0);
  });
  test("does not notify when clearing agent help was denied", async () => {
    const h = harness(candidate, "updated");
    await notifyTasks(context([{ ...candidate, agent_help: null }]), h.client);
    expect(h.sends).toHaveLength(0);
  });
  test("does not notify an output whose write did not persist", async () => {
    const h = harness(null);
    await notifyTasks(context([candidate]), h.client);
    expect(h.sends).toHaveLength(0);
  });
  test("does not notify a denied task change", async () => {
    const h = harness(candidate, "denied");
    await notifyTasks(context([candidate]), h.client);
    expect(h.sends).toHaveLength(0);
  });
  test.each([
    null,
    { summary: "Human's plan", prompt: "A different plan" },
  ])("does not notify a denied or superseded proposal: %p", async (agent_help) => {
    const h = harness({ ...candidate, agent_help });
    await notifyTasks(context([candidate]), h.client);
    expect(h.sends).toHaveLength(0);
  });
  test("ordinary tasks still notify without claiming agent capabilities", async () => {
    const task = { ...candidate, agent_help: null };
    const h = harness(task);
    await notifyTasks(context([task]), h.client);
    expect(h.sends[0]?.title).toStartWith("Task:");
    expect(h.sends[0]?.resource_url).toBe("/example/task/oauth-verification");
  });
  test("resolves committed task IDs even when older tasks lack output metadata", async () => {
    const h = harness();
    await notifyTasks(context([candidate]), h.client);
    const entityQuery = h.queries.find((sql) => sql.includes("FROM entities"));
    expect(entityQuery).toContain("id IN (42)");
    expect(entityQuery).not.toContain("metadata->>'automation_output'");
  });
  test("an ordinary task notice does not suppress its later first agent offer", async () => {
    const plain = { ...candidate, agent_help: null };
    const first = harness(plain);
    await notifyTasks(context([plain]), first.client);
    const later = harness(candidate, "updated");
    await notifyTasks(context([candidate]), later.client);
    expect(first.sends[0]?.idempotency_key).not.toBe(
      later.sends[0]?.idempotency_key
    );
    expect(later.sends[0]?.title).toStartWith("Agent help available:");
  });
  test("withdrawing an offer does not send an ordinary task notice", async () => {
    const plain = { ...candidate, agent_help: null };
    const h = harness(plain, "updated");
    await notifyTasks(context([plain]), h.client);
    expect(h.sends).toHaveLength(0);
  });
  test("uses saved human wording in the notification", async () => {
    const h = harness({ ...candidate, action: "My reviewed action" });
    await notifyTasks(context([candidate]), h.client);
    expect(h.sends[0]?.title).toEndWith("My reviewed action");
  });
  test("escapes source identity and rejects incomplete output", async () => {
    const h = harness(null);
    await notifyTasks(
      context([{ ...candidate, source_origin_id: "sender's-thread" }]),
      h.client
    );
    expect(h.queries.find((sql) => sql.includes("FROM entities"))).toContain(
      "sender''s-thread"
    );
    await expect(
      notifyTasks(context([{ action: "missing identity" }]), h.client)
    ).rejects.toThrow("stable identity");
  });
  test("propagates a send failure to the existing reaction retry queue", async () => {
    const h = harness();
    h.fail();
    await expect(notifyTasks(context([candidate]), h.client)).rejects.toThrow(
      "notification unavailable"
    );
  });
  test("an empty completed extraction sends no new task notification", async () => {
    const h = harness();
    await notifyTasks(context([]), h.client);
    expect(h.sends).toHaveLength(0);
  });
  test("an empty extraction still sends the established due-task digest", async () => {
    const dueDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const h = harness(null, null, [
      {
        id: 7,
        name: "Review the synthetic deadline",
        due_date: dueDate,
        priority: "high",
      },
    ]);
    await notifyTasks(context([]), h.client);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]?.title).toBe("Task reminder — 1 overdue");
    expect(h.sends[0]?.body).toContain("OVERDUE");
    expect(h.sends[0]?.idempotency_key).toMatch(
      /^task-due-digest:\d{4}-\d{2}-\d{2}:[a-f0-9]{32}$/
    );
  });
  test("a full due digest keeps its notification key within the API limit", async () => {
    const dueTasks = Array.from({ length: 25 }, (_, i) => ({
      id: 100000 + i,
      name: `Synthetic deadline ${i}`,
      due_date: new Date(Date.now() - 3600000).toISOString(),
      priority: "high",
    }));
    const h = harness(null, null, dueTasks);
    await notifyTasks(context([]), h.client);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.idempotency_key!.length).toBeLessThanOrEqual(300);
    const replay = harness(null, null, dueTasks);
    await notifyTasks(context([]), replay.client);
    expect(replay.sends[0]!.idempotency_key).toBe(h.sends[0]!.idempotency_key);
    const changed = harness(null, null, dueTasks.slice(1));
    await notifyTasks(context([]), changed.client);
    expect(changed.sends[0]!.idempotency_key).not.toBe(
      h.sends[0]!.idempotency_key
    );
  });
});
