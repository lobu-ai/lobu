import { describe, expect, test } from "bun:test";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import config from "../lobu.config";
import stageLinkedInFlags from "../linkedin-flag.reaction";

const POST =
  "https://www.linkedin.com/feed/update/urn:li:activity:1111111111111111111";

const context = (flags: unknown, runId = 901): ReactionContext =>
  ({
    extracted_data: { flags },
    entities: [],
    window: {
      run_id: runId,
      automation_id: 71,
      window_start: "2026-09-10T10:00:00Z",
      window_end: "2026-09-10T13:00:00Z",
      content_analyzed: 2,
    },
  }) as unknown as ReactionContext;

function harness({
  connections = [{ id: 7, slug: "linkedin-buremba" }] as unknown[],
  status = "in_progress",
  flaggedUrls = [] as string[],
} = {}) {
  const executed: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const queries: string[] = [];
  const client = {
    connections: { list: async () => ({ connections }) },
    query: async (sql: string) => {
      queries.push(sql);
      return flaggedUrls.some((url) => sql.includes(`'${url}'`))
        ? [{ id: 1 }]
        : [];
    },
    operations: {
      execute: async (input: Record<string, unknown>) => {
        executed.push(input);
        return { status, run_id: 500 + executed.length };
      },
    },
    notifications: {
      send: async (input: Record<string, unknown>) => {
        sent.push(input);
        return { notified_count: 1, event_id: 1, url: null };
      },
    },
  } as unknown as ReactionClient;
  return { client, executed, sent, queries };
}

describe("LinkedIn flag reaction", () => {
  test("stages each draft on the trailing-slash page URL and links the notification", async () => {
    const h = harness();
    await stageLinkedInFlags(
      context([
        {
          post_url: POST,
          author: "Fixture Author",
          gist: "Warehouse market",
          why: "Matches the warehouse topic.",
          draft: "My take is the signal gets noisier.",
        },
      ]),
      h.client
    );

    expect(h.executed).toEqual([
      {
        connection_id: 7,
        operation_key: "prepare_comment",
        input: {
          post_url: POST,
          body: "My take is the signal gets noisier.",
          reason: "Matches the warehouse topic.",
        },
        activation: { kind: "page_visit", urls: [`${POST}/`] },
        idempotency_key: `linkedin-flag:901:${POST}/`,
        automation_source: { automation_id: 71, run_id: 901 },
      },
    ]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      title: "LinkedIn: Fixture Author · Warehouse market",
      browser_url: `${POST}/`,
      browser_handoff_run_id: 501,
      idempotency_key: `linkedin-flag:901:${POST}/`,
    });
  });

  test("skips flags without a LinkedIn post URL or draft, and caps at five", async () => {
    const h = harness();
    const valid = (n: number) => ({
      post_url: `https://www.linkedin.com/feed/update/urn:li:activity:${2000000000000000000 + n}`,
      draft: `Draft ${n}`,
    });
    await stageLinkedInFlags(
      context([
        {
          post_url: "https://evil.example/feed/update/urn:li:activity:1",
          draft: "x",
        },
        { post_url: POST, draft: "  " },
        ...[1, 2, 3, 4, 5, 6].map(valid),
      ]),
      h.client
    );
    expect(
      h.executed.map((run) => (run.input as { body: string }).body)
    ).toEqual(["Draft 1", "Draft 2", "Draft 3", "Draft 4", "Draft 5"]);
  });

  test("does nothing without flags and fails closed without the LinkedIn connection", async () => {
    const empty = harness({ connections: [] });
    await stageLinkedInFlags(context([]), empty.client);
    expect(empty.executed).toEqual([]);

    await expect(
      stageLinkedInFlags(
        context([{ post_url: POST, draft: "x" }]),
        empty.client
      )
    ).rejects.toThrow("linkedin-buremba");
    expect(empty.sent).toEqual([]);
  });

  test("scopes retry keys to the run so a later window can stage the same post", async () => {
    const h = harness();
    await stageLinkedInFlags(
      context([{ post_url: POST, draft: "a" }], 901),
      h.client
    );
    await stageLinkedInFlags(
      context([{ post_url: POST, draft: "a" }], 902),
      h.client
    );
    expect(h.executed.map((run) => run.idempotency_key)).toEqual([
      `linkedin-flag:901:${POST}/`,
      `linkedin-flag:902:${POST}/`,
    ]);
  });

  test("skips a post this Automation already flagged in either URL form", async () => {
    for (const flaggedUrl of [POST, `${POST}/`]) {
      const h = harness({ flaggedUrls: [flaggedUrl] });
      await stageLinkedInFlags(
        context([{ post_url: POST, draft: "a" }]),
        h.client
      );
      expect(h.executed).toEqual([]);
      expect(h.sent).toEqual([]);
      expect(h.queries[0]).toContain("automation_id = 71");
    }
  });

  test("leaves an approval-held draft to its approval notice and keeps going", async () => {
    const h = harness({ status: "pending_approval" });
    await stageLinkedInFlags(
      context([
        { post_url: POST, draft: "a" },
        {
          post_url:
            "https://www.linkedin.com/feed/update/urn:li:activity:2222222222222222222",
          draft: "b",
        },
      ]),
      h.client
    );
    expect(h.executed).toHaveLength(2);
    expect(h.sent).toEqual([]);
  });

  test("config wires both LinkedIn Automations to the assistant device", () => {
    const bySlug = new Map(
      (config.automations ?? []).map((automation) => [
        automation.slug,
        automation,
      ])
    );
    const flagger = bySlug.get("linkedin-feed-flagger");
    const profile = bySlug.get("linkedin-interest-profile-weekly");
    expect(flagger?.sources).toEqual({ posts: "@feed:home_feed" });
    expect(flagger?.reaction).toBeTruthy();
    expect(flagger?.agentKind).toBe("claude-code");
    expect(profile?.agentKind).toBe("claude-code");
    expect(flagger?.deviceWorkerId).toBe(profile?.deviceWorkerId);
    expect(profile?.prompt).toContain('"linkedin-buremba"');
  });
});
