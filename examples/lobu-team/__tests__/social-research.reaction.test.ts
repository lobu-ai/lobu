import { describe, expect, mock, test } from "bun:test";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import { notify } from "../../../packages/server/src/tools/admin/notify";
import { getArgsValidator } from "../../../packages/server/src/tools/validate-args";
import reaction from "../social-research.reaction";

const url = "https://www.linkedin.com/feed/update/urn:li:activity:123456789/";
const text =
  "Agents need explicit decision boundaries and enough context to finish work.";
const finding = () => ({
  platform: "linkedin",
  source_url: url,
  read_run_id: 81,
  quote: text,
  summary: "A concrete question about agent autonomy",
  why: "Relevant to Lobu's human review workflow.",
  limits: "Post text and returned comments only; no media inspected.",
  draft: "Which decisions have you found need human review?",
});

function harness(findings = [finding()]) {
  const receipts = new Map<number, Record<string, any>>([
    [
      77,
      {
        status: "completed",
        automation_id: 42,
        created_at: "2026-01-01T10:00:00Z",
        completed_at: "2026-01-01T10:10:00Z",
      },
    ],
    [
      81,
      {
        status: "completed",
        connection_id: 11,
        operation_key: "read_home_feed",
        created_by_user_id: "test-owner",
        created_at: "2026-01-01T10:01:00Z",
        completed_at: "2026-01-01T10:02:00Z",
        output: { items: [{ type: "post", url, text }] },
      },
    ],
  ]);
  const delivered = new Set<string>();
  const queries: string[] = [];
  const connections = [
    { id: 11, slug: "linkedin-research", status: "active" },
    { id: 12, slug: "linkedin-drafts", status: "active" },
    { id: 13, slug: "lobu-company-x-browser", status: "active" },
    { id: 14, slug: "tiktok-lobuteam", status: "active" },
  ];
  const validateSend = getArgsValidator(notify)!;
  const send = mock(async (args: Record<string, any>) => {
    validateSend({ action: "send", ...args });
    delivered.add(args.idempotency_key);
    return { event_id: 123, notified_count: 1, url: null };
  });
  const execute = mock(async (_args: Record<string, any>) => ({
    status: "in_progress",
    run_id: 90,
  }));
  const ctx = {
    extracted_data: {
      summary: "Research complete",
      findings,
      coverage: ["linkedin", "x", "tiktok"].map((platform) => ({
        platform,
        status: "read",
        posts_read: 1,
        detail: "Visible post text",
      })),
    },
    automation: { id: 42 },
    window: { run_id: 77 },
  } as unknown as ReactionContext;
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("FROM automations"))
        return [{ created_by: "test-owner" }];
      return [...delivered].some((key) => sql.includes(key))
        ? [{ id: 123 }]
        : [];
    },
    // Reactions have no user identity: the general list hides private profiles.
    // Operation discovery resolves the Automation owner's execution access.
    connections: { list: async () => ({ connections: [] }) },
    operations: {
      getRun: async (id: number) => ({ run: receipts.get(id) }),
      listAvailable: async () => ({
        operations: [
          "read_home_feed",
          "evaluate",
          "inspect_post",
          "prepare_comment",
        ].map((operation_key) => ({
          operation_key,
          execution_targets: connections.map((c) => ({
            connection_id: c.id,
            slug: c.slug,
            executable: c.status === "active",
          })),
        })),
      }),
      execute,
    },
    notifications: { send },
  } as unknown as ReactionClient;
  return {
    receipts,
    delivered,
    queries,
    connections,
    send,
    execute,
    ctx,
    run: () => reaction(ctx, client),
  };
}

describe("social research cards and browser actions", () => {
  test("queues an exact page-activated draft with its reason and existing handoff buttons", async () => {
    const h = harness();
    await h.run();
    expect(h.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        connection_id: 12,
        operation_key: "prepare_comment",
        activation: { kind: "page_visit", urls: [url] },
        input: { post_url: url, body: finding().draft, reason: finding().why },
      })
    );
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: ["test-owner"],
        browser_url: url,
        browser_handoff_run_id: 90,
        automation_source: { automation_id: 42, run_id: 77 },
        body: expect.stringContaining("Why it matters:"),
      })
    );
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  test("retries and new stored versions of the same source do not queue another draft", async () => {
    const h = harness();
    await h.run();
    h.receipts.get(81)!.output.items[0].id = "new-stored-version";
    await h.run();
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  test("validates the whole batch before effects, including source, owner and window", async () => {
    for (const mutate of [
      (r: Record<string, any>) => {
        r.output.items[0].url = url.replace("123456789", "987654321");
      },
      (r: Record<string, any>) => {
        r.output.items[0].text = "Unrelated source";
      },
      (r: Record<string, any>) => {
        r.created_by_user_id = "other-owner";
      },
      (r: Record<string, any>) => {
        r.completed_at = "2026-01-02T10:10:00Z";
      },
      (r: Record<string, any>) => {
        r.completed_at = "invalid";
      },
      (r: Record<string, any>) => {
        r.status = "running";
      },
    ]) {
      const h = harness();
      mutate(h.receipts.get(81)!);
      await expect(h.run()).rejects.toThrow();
      expect(h.execute).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    }
  });

  test("missing interactive setup preserves the draft without claiming a browser action", async () => {
    const h = harness();
    h.connections[1].status = "pending_auth";
    await h.run();
    expect(h.execute).not.toHaveBeenCalled();
    const card = h.send.mock.calls[0][0];
    expect(card.browser_handoff_run_id).toBeUndefined();
    expect(card.body).toContain(finding().draft);
    expect(card.body).toContain("needs setup");
  });

  test("only a matching successful like receipt is reported as liked", async () => {
    for (const invalid of [false, true]) {
      const h = harness();
      (h.ctx.extracted_data.findings as any[])[0].like_run_id = 82;
      h.receipts.set(82, {
        ...h.receipts.get(81),
        operation_key: "set_like",
        output: { post_url: url, liked: !invalid },
      });
      if (invalid) {
        await expect(h.run()).rejects.toThrow("matching completed receipt");
        expect(h.send).not.toHaveBeenCalled();
        expect(h.execute).not.toHaveBeenCalled();
      } else {
        await h.run();
        expect(h.send.mock.calls[0][0].body).toContain("Liked — verified.");
      }
    }
  });

  test("X replies remain text drafts and cannot claim an automated like", async () => {
    const xUrl = "https://x.com/example/status/123456789";
    const h = harness([{ ...finding(), platform: "x", source_url: xUrl }]);
    Object.assign(h.receipts.get(81)!, {
      connection_id: 13,
      operation_key: "evaluate",
      output: { value: { posts: [{ url: xUrl, text }] } },
    });
    await h.run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.send.mock.calls[0][0].body).toContain("manual use on X");
    expect(h.send.mock.calls[0][0].browser_url).toBeUndefined();
    const quiet = harness([
      { ...finding(), platform: "x", source_url: xUrl, draft: "" },
    ]);
    Object.assign(quiet.receipts.get(81)!, h.receipts.get(81));
    await quiet.run();
    expect(quiet.send.mock.calls[0][0].body).toContain("No comment suggested");
    expect(quiet.send.mock.calls[0][0].body).not.toContain("Draft saved");
    (h.ctx.extracted_data.findings as any[])[0].like_run_id = 82;
    await expect(h.run()).rejects.toThrow("Automated X likes");
  });

  test("TikTok videos use the existing draft contract while photos stay text-only", async () => {
    for (const kind of ["video", "photo"]) {
      const postUrl = `https://www.tiktok.com/@example/${kind}/123456789`;
      const h = harness([
        { ...finding(), platform: "tiktok", source_url: postUrl },
      ]);
      h.connections.push({ id: 15, slug: "tiktok-drafts", status: "active" });
      Object.assign(h.receipts.get(81)!, {
        connection_id: 14,
        operation_key: "inspect_post",
        output: { post: { source_url: postUrl, text } },
      });
      await h.run();
      if (kind === "video") {
        expect(h.execute.mock.calls[0][0].input).toEqual({
          post_url: postUrl,
          body: finding().draft,
        });
        expect(h.execute.mock.calls[0][0].activation).toEqual({
          kind: "page_visit",
          urls: [postUrl],
        });
      } else {
        expect(h.execute).not.toHaveBeenCalled();
        const body = h.send.mock.calls[0][0].body;
        expect(body).toContain(finding().draft);
        expect(body).not.toContain("needs setup");
      }
    }
  });

  test("blocked coverage is reported while a genuinely quiet scan sends nothing", async () => {
    const h = harness([]);
    await h.run();
    expect(h.send).not.toHaveBeenCalled();
    (h.ctx.extracted_data.coverage as any[])[0].status = "blocked";
    await h.run();
    expect(h.send.mock.calls[0][0].title).toBe(
      "Social research could not read · linkedin"
    );
    expect(h.execute).not.toHaveBeenCalled();
  });

  test("a schema-sized card passes the actual notification contract without losing its draft", async () => {
    const f = {
      ...finding(),
      summary: "s".repeat(120),
      quote: "q".repeat(100),
      why: "w".repeat(120),
      limits: "l".repeat(120),
      draft: "d".repeat(350),
    };
    const h = harness([f]);
    h.receipts.get(81)!.output.items[0].text = f.quote;
    await h.run();
    expect(h.send.mock.calls[0][0].body).toContain(f.draft);
  });

  test("three detailed blocked sources fit the notification and idempotency contracts", async () => {
    const h = harness([]);
    for (const c of h.ctx.extracted_data.coverage as any[]) {
      c.status = "blocked";
      c.detail = "Cannot access the connected browser. ".padEnd(600, "x");
    }
    await h.run();
    expect(h.send).toHaveBeenCalledTimes(3);
  });

  test("Unicode at schema limits preserves the full draft and fits the inbox", async () => {
    const f = {
      ...finding(),
      summary: "🧪".repeat(120),
      quote: "🧪".repeat(100),
      why: "🧪".repeat(120),
      limits: "🧪".repeat(120),
      draft: "🧪".repeat(350),
    };
    const h = harness([f]);
    h.receipts.get(81)!.output.items[0].text = f.quote;
    await h.run();
    const card = h.send.mock.calls[0][0];
    expect(card.body).toContain(f.draft);
    expect(card.body.length).toBeLessThanOrEqual(1000);
    expect(card.title.endsWith("\ud83e")).toBe(false);
  });
});
