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
  priorRuns = [] as Array<Record<string, unknown>>,
} = {}) {
  const executed: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const runs = [...priorRuns];
  const client = {
    connections: { list: async () => ({ connections }) },
    operations: {
      listRuns: async ({
        limit,
        offset,
      }: {
        limit: number;
        offset: number;
      }) => ({
        runs: runs.slice(offset, offset + limit),
        total: runs.length,
        limit,
        offset,
        has_more: offset + limit < runs.length,
      }),
      execute: async (input: Record<string, unknown>) => {
        executed.push(input);
        // Record the staged run the way the queue does, under the window's run.
        const source = input.automation_source as {
          automation_id: number;
          run_id: number;
        };
        runs.unshift({
          automation_id: source.automation_id,
          parent_run_id: source.run_id,
          status: status === "in_progress" ? "pending" : "pending",
          approval_status: status === "pending_approval" ? "pending" : "auto",
          input: input.input,
        });
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
  return { client, executed, sent };
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

  test("scopes retry keys to the run so a later window can restage a failed draft", async () => {
    const h = harness({
      priorRuns: [
        {
          automation_id: 71,
          parent_run_id: 901,
          status: "failed",
          input: { post_url: POST },
        },
      ],
    });
    await stageLinkedInFlags(
      context([{ post_url: POST, draft: "a" }], 902),
      h.client
    );
    expect(h.executed.map((run) => run.idempotency_key)).toEqual([
      `linkedin-flag:902:${POST}/`,
    ]);
  });

  test("skips a post this Automation staged in an earlier window, in either URL form", async () => {
    for (const postUrl of [POST, `${POST}/`]) {
      const h = harness({
        priorRuns: [
          {
            automation_id: 71,
            parent_run_id: 800,
            status: "completed",
            input: { post_url: postUrl },
          },
        ],
      });
      await stageLinkedInFlags(
        context([{ post_url: POST, draft: "a" }]),
        h.client
      );
      expect(h.executed).toEqual([]);
      expect(h.sent).toEqual([]);
    }
  });

  test("restages failed drafts, replays this window's own runs, and ignores other Automations", async () => {
    const h = harness({
      priorRuns: [
        {
          automation_id: 71,
          parent_run_id: 800,
          status: "failed",
          input: { post_url: POST },
        },
        {
          automation_id: 71,
          parent_run_id: 901,
          status: "pending",
          input: { post_url: POST },
        },
        {
          automation_id: 99,
          parent_run_id: 700,
          status: "completed",
          input: { post_url: POST },
        },
      ],
    });
    await stageLinkedInFlags(
      context([{ post_url: POST, draft: "a" }]),
      h.client
    );
    expect(h.executed).toHaveLength(1);
  });

  test("pages through earlier runs before deciding", async () => {
    const filler = Array.from({ length: 150 }, (_, n) => ({
      automation_id: 71,
      parent_run_id: 800,
      status: "completed",
      input: {
        post_url: `https://www.linkedin.com/feed/update/urn:li:activity:${3000000000000000000 + n}`,
      },
    }));
    const h = harness({
      priorRuns: [
        ...filler,
        {
          automation_id: 71,
          parent_run_id: 800,
          status: "completed",
          input: { post_url: POST },
        },
      ],
    });
    await stageLinkedInFlags(
      context([{ post_url: POST, draft: "a" }]),
      h.client
    );
    expect(h.executed).toEqual([]);
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

  test("does not ask twice for an approval-held draft across windows", async () => {
    const h = harness({ status: "pending_approval" });
    await stageLinkedInFlags(
      context([{ post_url: POST, draft: "a" }], 901),
      h.client
    );
    await stageLinkedInFlags(
      context([{ post_url: POST, draft: "a" }], 902),
      h.client
    );
    expect(h.executed).toHaveLength(1);
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
    expect(flagger?.reaction).toBeTruthy();
    expect(flagger?.agentKind).toBe("claude-code");
    expect(profile?.agentKind).toBe("claude-code");
    expect(flagger?.deviceWorkerId).toBe(profile?.deviceWorkerId);
    expect(profile?.prompt).toContain('"linkedin-buremba"');
    // The flagger is virtual too: it reads the timeline live through
    // read_home_feed, so its only source is intentionally empty and the
    // prompt must drive the live read instead of a stored-posts source.
    expect(flagger?.sources).toEqual({
      none: "SELECT id FROM events WHERE false",
    });
    expect(flagger?.prompt).toContain('"read_home_feed"');
    expect(flagger?.prompt).toContain('"linkedin-buremba"');
    // Its only source is intentionally empty, so a scheduled run must not be
    // skipped as unchanged.
    expect(profile?.triggers).toEqual([
      expect.objectContaining({ kind: "schedule", skip_if_unchanged: false }),
    ]);
  });
});
