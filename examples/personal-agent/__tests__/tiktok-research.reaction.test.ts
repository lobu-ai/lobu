import { describe, expect, test } from "bun:test";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import notifyTikTokResearch from "../tiktok-research.reaction";

const finding = {
  inspection_run_id: 901,
  caption_quote: "I keep repeating my project context to my assistant.",
  why_useful: "A concrete memory problem to understand.",
  suggested_question: "Which project details do you have to repeat?",
};
const context = (
  findings: unknown[] = [finding],
  runId = 800
): ReactionContext => ({
  extracted_data: { summary: "Read one post and inspected it.", findings },
  entities: [],
  window: {
    run_id: runId,
    automation_id: 71,
    window_start: "2026-10-01T10:00:00Z",
    window_end: "2026-10-01T10:05:00Z",
    content_analyzed: 1,
  },
  automation: { id: 71, slug: "research", name: "Research", version: 1 },
  organization_id: "synthetic-org",
  organization_slug: "example",
});

const receipt = () => ({
  id: 901,
  status: "completed",
  connector_key: "tiktok.web",
  operation_key: "inspect_post",
  connection_id: 42,
  automation_id: 71,
  parent_run_id: 800,
  created_by_user_id: "synthetic-owner",
  created_at: "2026-10-01T10:01:00Z",
  completed_at: "2026-10-01T10:02:00Z",
  output: {
    post: {
      origin_id: "1234567890123456789",
      source_url: "https://www.tiktok.com/@synthetic/video/1234567890123456789",
      text: `${finding.caption_quote} How do you handle that?`,
      author: { name: "Synthetic creator" },
    },
  },
});

function harness() {
  const sends: Parameters<ReactionClient["notifications"]["send"]>[0][] = [];
  const events = new Map<string, number>();
  const completedWindow = {
    status: "completed",
    automation_id: 71,
    created_at: "2026-10-01T10:00:00Z",
    completed_at: "2026-10-01T10:05:00Z",
  };
  const runs: Record<number, Record<string, unknown>> = {
    800: completedWindow,
    801: completedWindow,
    901: receipt(),
  };
  let fail = false;
  const client = {
    query: async () => [{ created_by: "synthetic-owner" }],
    operations: { getRun: async (id: number) => ({ run: runs[id] ?? {} }) },
    notifications: {
      send: async (args: (typeof sends)[number]) => {
        if (fail) throw new Error("Delivery unavailable");
        sends.push(args);
        const key = args.idempotency_key ?? "";
        const existing = events.get(key);
        const eventId = existing ?? events.size + 1000;
        events.set(key, eventId);
        return {
          notified_count: existing ? 0 : 1,
          event_id: eventId,
          url: null,
        };
      },
    },
  } as unknown as ReactionClient;
  return {
    client,
    sends,
    runs,
    fail: () => {
      fail = true;
    },
  };
}

describe("TikTok research delivery", () => {
  test("delivers a grounded lead privately, deriving URL and owner from source", async () => {
    const h = harness();
    const result = await notifyTikTokResearch(context(), h.client);
    expect(result).toEqual({ findings: 1, notified: 1, event_ids: [1000] });
    expect(h.sends[0]).toMatchObject({
      recipients: ["synthetic-owner"],
      resource_url: receipt().output.post.source_url,
      automation_source: { automation_id: 71, run_id: 800 },
    });
    expect(h.sends[0]?.body).toContain(finding.caption_quote);
    expect(h.sends[0]?.body).toContain(
      "video/audio and claimed results are unverified"
    );
  });

  test("blocks the observed placeholder failure and an invented quote", async () => {
    for (const bad of [
      { creator: "User1", canonical_post_url: "url1" },
      {
        ...finding,
        caption_quote: "This claim does not exist in the real caption.",
      },
      { ...finding, inspection_run_id: 999 },
    ]) {
      const h = harness();
      await expect(
        notifyTikTokResearch(context([bad]), h.client)
      ).rejects.toThrow();
      expect(h.sends).toHaveLength(0);
    }
  });

  test("accepts typographic quotation differences without relaxing word matching", async () => {
    const h = harness();
    h.runs[901] = {
      ...receipt(),
      output: {
        post: {
          ...receipt().output.post,
          text: "My assistant’s memory stores “project context” across sessions.",
        },
      },
    };
    const quote =
      "My assistant's memory stores 'project context' across sessions.";
    const result = await notifyTikTokResearch(
      context([{ ...finding, caption_quote: quote }]),
      h.client
    );
    expect(result.notified).toBe(1);
    await expect(
      notifyTikTokResearch(
        context([
          { ...finding, caption_quote: quote.replace("stores", "deletes") },
        ]),
        h.client
      )
    ).rejects.toThrow("Unverified");
    expect(h.sends).toHaveLength(1);
  });

  test("rejects failed, foreign and stale inspection receipts before any delivery", async () => {
    for (const patch of [
      { status: "failed" },
      { operation_key: "set_like" },
      { connector_key: "other" },
      { connection_id: null },
      { created_by_user_id: "different-owner" },
      { created_at: "2026-09-01T10:01:00Z" },
      { completed_at: "2026-10-01T10:06:00Z" },
      { automation_id: 72 },
      { parent_run_id: 799 },
      {
        output: { post: { ...receipt().output.post, origin_id: "different" } },
      },
    ]) {
      const h = harness();
      h.runs[902] = { ...receipt(), ...patch };
      await expect(
        notifyTikTokResearch(
          context([finding, { ...finding, inspection_run_id: 902 }]),
          h.client
        )
      ).rejects.toThrow("Unverified");
      expect(h.sends).toHaveLength(0);
    }
  });

  test("accepts fresh owner receipts without parent fields, but rejects older ones", async () => {
    const h = harness();
    h.runs[901] = { ...receipt(), automation_id: null, parent_run_id: null };
    expect((await notifyTikTokResearch(context(), h.client)).notified).toBe(1);
    h.runs[901] = { ...h.runs[901], created_at: "2026-09-01T10:00:00Z" };
    await expect(notifyTikTokResearch(context(), h.client)).rejects.toThrow(
      "Unverified"
    );
    expect(h.sends).toHaveLength(1);
  });

  test("new windows and inspections of the same post replay the durable delivery key", async () => {
    const h = harness();
    await notifyTikTokResearch(context(), h.client);
    h.runs[902] = { ...receipt(), id: 902, parent_run_id: 801 };
    const repeat = await notifyTikTokResearch(
      context([{ ...finding, inspection_run_id: 902 }], 801),
      h.client
    );
    expect(repeat).toEqual({ findings: 1, notified: 0, event_ids: [1000] });
    expect(h.sends[0]?.idempotency_key).toEqual(h.sends[1]?.idempotency_key);
  });

  test("empty results stay silent; incomplete windows and delivery failures do not report success", async () => {
    const h = harness();
    expect(await notifyTikTokResearch(context([]), h.client)).toEqual({
      findings: 0,
      notified: 0,
      event_ids: [],
    });
    expect(h.sends).toHaveLength(0);
    h.fail();
    await expect(notifyTikTokResearch(context(), h.client)).rejects.toThrow(
      "Delivery unavailable"
    );
    h.runs[800] = { ...h.runs[800], status: "running" };
    await expect(notifyTikTokResearch(context(), h.client)).rejects.toThrow(
      "completed execution receipt"
    );
  });
});
