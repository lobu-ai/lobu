import { describe, expect, test } from "bun:test";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import config from "../lobu.config";
import stageLinkedInFlags from "../linkedin-flag.reaction";

const POST =
  "https://www.linkedin.com/feed/update/urn:li:activity:1111111111111111111";

const context = (flags: unknown): ReactionContext =>
  ({
    extracted_data: { flags },
    entities: [],
    window: {
      run_id: 901,
      automation_id: 71,
      window_start: "2026-09-10T10:00:00Z",
      window_end: "2026-09-10T13:00:00Z",
      content_analyzed: 2,
    },
  }) as unknown as ReactionContext;

function harness(
  connections: unknown[] = [{ id: 7, slug: "linkedin-buremba" }]
) {
  const executed: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const client = {
    connections: { list: async () => ({ connections }) },
    operations: {
      execute: async (input: Record<string, unknown>) => {
        executed.push(input);
        return { status: "in_progress", run_id: 500 + executed.length };
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
        idempotency_key: `linkedin-flag:${POST}/`,
        automation_source: { automation_id: 71, run_id: 901 },
      },
    ]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      title: "LinkedIn: Fixture Author · Warehouse market",
      browser_url: `${POST}/`,
      browser_handoff_run_id: 501,
      idempotency_key: `linkedin-flag:${POST}/`,
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
    const empty = harness([]);
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
