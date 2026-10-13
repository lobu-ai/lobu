import { createHash } from "node:crypto";
import { describe, expect, mock, test } from "bun:test";
import type { ReactionContext } from "@lobu/connector-sdk";
import { notify } from "../../../packages/server/src/tools/admin/notify";
import { getArgsValidator } from "../../../packages/server/src/tools/validate-args";
import reaction from "../social-research.reaction";

const url = "https://www.linkedin.com/feed/update/urn:li:activity:123456789/";
const text =
  "Agents need explicit decision boundaries and enough context to finish work.";
const revision = "a".repeat(64);
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
  const queued = new Map<string, Record<string, any>>();
  const execute = mock(async (args: Record<string, any>) => {
    const old = queued.get(args.idempotency_key);
    if (
      old &&
      (old.parent_run_id !== ctx.window.run_id ||
        JSON.stringify(old.input) !== JSON.stringify(args.input))
    )
      throw new Error(
        "Action idempotency key is already bound to a different request"
      );
    if (!old) {
      queued.set(args.idempotency_key, {
        id: 90,
        connection_id: args.connection_id,
        operation_key: args.operation_key,
        input: args.input,
        automation_id: 42,
        parent_run_id: ctx.window.run_id,
        created_by_user_id: "test-owner",
        status: "pending",
        approval_status: "auto",
      });
      receipts.get(ctx.window.run_id)!.output = structuredClone(
        ctx.extracted_data
      );
    }
    return { status: "in_progress", run_id: 90 };
  });
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
  const feedRows: Record<string, any>[] = [
    {
      id: "source-message",
      text,
      from_me: false,
      recalled: false,
      source_revision: revision,
      conversation_url:
        "https://www.linkedin.com/messaging/thread/test-thread/",
    },
  ];
  const readMany = mock(
    async (_input: any): Promise<any> => ({
      results: [{ feed_id: 51, ok: true, rows: feedRows }],
    })
  );
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("AS source_key"))
        return [{ source_key: createHash("sha256").update(sql).digest("hex") }];
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
      listRuns: async () => ({ runs: [...queued.values()], has_more: false }),
      listAvailable: async () => ({
        operations: [
          "read_home_feed",
          "evaluate",
          "inspect_post",
          "prepare_comment",
          "prepare_message",
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
    feeds: {
      list: async () => ({
        feeds: [{ id: 51, feed_key: "live_messages", connection_id: 11 }],
      }),
      readMany,
    },
    notifications: { send },
  } as unknown as Parameters<typeof reaction>[1];
  return {
    feedRows,
    readMany,
    receipts,
    delivered,
    queries,
    connections,
    send,
    execute,
    ctx,
    client,
    queued,
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

const inboxFinding = () => ({
  platform: "linkedin",
  feed_key: "live_messages",
  source_id: "source-message",
  source_revision: revision,
  quote: text,
  summary: "An incoming question",
  why: "It asks about agent review.",
  limits: "Text only.",
  draft: "Happy to explain the review flow.",
});

test("inbox cards re-read the source and queue a private message draft", async () => {
  const h = harness([]);
  h.ctx.extracted_data.inbox_findings = [inboxFinding()];
  await h.run();
  expect(h.readMany).toHaveBeenCalledTimes(1);
  expect(h.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      operation_key: "prepare_message",
      input: expect.objectContaining({
        conversation_url: h.feedRows[0].conversation_url,
        body: inboxFinding().draft,
      }),
      activation: {
        kind: "page_visit",
        urls: [h.feedRows[0].conversation_url],
      },
    })
  );
  expect(h.send).toHaveBeenCalledWith(
    expect.objectContaining({
      recipients: ["test-owner"],
      resource_url: h.feedRows[0].conversation_url,
      browser_handoff_run_id: 90,
    })
  );
  await h.run();
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.execute).toHaveBeenCalledTimes(1);
});

test("inbox cards at Unicode schema limits keep the draft within the notification limit", async () => {
  for (const platform of ["linkedin", "tiktok"]) {
    const h = harness([]);
    const f = {
      ...inboxFinding(),
      platform,
      feed_key: platform === "linkedin" ? "live_messages" : "messages",
      summary: "🧪".repeat(120),
      quote: "🧪".repeat(100),
      why: "🧪".repeat(120),
      limits: "🧪".repeat(120),
      draft: "🧪".repeat(350),
    };
    h.ctx.extracted_data.inbox_findings = [f];
    h.feedRows[0].text = f.quote;
    if (platform === "tiktok") {
      h.feedRows[0].conversation_url = "https://www.tiktok.com/messages";
      h.feedRows[0].conversation_name = "🧪".repeat(80);
      h.client.feeds.list = async () => ({
        feeds: [{ id: 51, feed_key: "messages", connection_id: 14 }],
      });
    }
    await h.run();
    const card = h.send.mock.calls[0][0];
    expect(card.body).toContain(f.draft);
    expect(card.body.length).toBeLessThanOrEqual(1000);
    expect(card.title.endsWith("\ud83e")).toBe(false);
  }
});

test("a failed draft enqueue preserves independent inbox cards and reports partial coverage", async () => {
  const h = harness([]);
  h.ctx.extracted_data.inbox_findings = [
    inboxFinding(),
    { ...inboxFinding(), source_id: "other-message", draft: "" },
  ];
  h.feedRows.push({ ...h.feedRows[0], id: "other-message" });
  h.execute.mockImplementationOnce(async () => {
    throw new Error("Synthetic enqueue failure");
  });
  const result = await h.run();
  expect(result.inbox_findings.some((f) => f.status === "partial")).toBe(true);
  expect(
    result.inbox_findings.some(
      (f) => f.source_id === "other-message" && f.notification_id
    )
  ).toBe(true);
  expect(
    h.send.mock.calls.some(([card]) =>
      card.title.includes("partially verified")
    )
  ).toBe(true);
});

test("invalid inbox evidence is skipped without discarding independent post findings", async () => {
  for (const changes of [
    { text: "unrelated" },
    { from_me: true },
    { recalled: true },
    { id: "another-message" },
  ]) {
    const h = harness();
    h.ctx.extracted_data.inbox_findings = [inboxFinding()];
    Object.assign(h.feedRows[0], changes);
    const result = await h.run();
    expect(result.inbox_findings[0]).toMatchObject({ status: "partial" });
    expect(result.findings).toHaveLength(1);
    expect(
      h.execute.mock.calls.every(
        ([args]) => args.operation_key === "prepare_comment"
      )
    ).toBe(true);
  }
});

test("edits outside the quote, media changes and missing revisions cannot stage stale replies", async () => {
  for (const changed of [
    {
      text: `${text} Actually, do not deliver anything until Friday.`,
      source_revision: "b".repeat(64),
    },
    { has_attachments: true },
    { has_uninspected_content: true },
    { source_revision: undefined },
  ]) {
    const h = harness([]);
    h.ctx.extracted_data.inbox_findings = [inboxFinding()];
    Object.assign(h.feedRows[0], changed);
    const result = await h.run();
    expect(result.inbox_findings[0]).toMatchObject({ status: "partial" });
    expect(h.execute).not.toHaveBeenCalled();
    expect(
      h.send.mock.calls.every(([card]) => !card.browser_handoff_run_id)
    ).toBe(true);
  }
});

test("bounded reread recovers a candidate displaced by first-page insertions", async () => {
  const h = harness([]);
  h.ctx.extracted_data.inbox_findings = [inboxFinding()];
  h.readMany.mockImplementationOnce(async () => ({
    results: [
      {
        feed_id: 51,
        ok: true,
        rows: Array.from({ length: 20 }, (_, i) => ({ id: `new-${i}` })),
        next_cursor: "next-page",
      },
    ],
  }));
  await h.run();
  expect(h.readMany).toHaveBeenCalledTimes(2);
  expect(h.execute.mock.calls[0][0].operation_key).toBe("prepare_message");
});

test("expired anchors report partial verification without retrying the failed source", async () => {
  const h = harness([]);
  h.ctx.extracted_data.inbox_findings = [
    { ...inboxFinding(), source_cursor: "expired-anchor" },
  ];
  h.readMany.mockImplementationOnce(async () => ({
    results: [{ feed_id: 51, ok: false, rows: [] }],
  }));
  const result = await h.run();
  expect(result.inbox_findings[0]).toMatchObject({ status: "partial" });
  expect(h.readMany).toHaveBeenCalledTimes(1);
  expect(h.execute).not.toHaveBeenCalled();
});

test("one failed inbox does not suppress another verified source or coverage notices", async () => {
  const h = harness([]);
  h.ctx.extracted_data.inbox_findings = [
    inboxFinding(),
    { ...inboxFinding(), source_id: "other", feed_key: "notifications" },
  ];
  h.ctx.extracted_data.inbox_coverage = [
    "linkedin:live_messages",
    "linkedin:notifications",
    "tiktok:messages",
    "tiktok:activity",
  ].map((source) => ({
    source,
    status: "read",
    items_read: 1,
    detail: "Read",
  }));
  h.client.feeds.list = async () => ({
    feeds: [
      { id: 51, connection_id: 11, feed_key: "live_messages" },
      { id: 52, connection_id: 11, feed_key: "notifications" },
    ],
  });
  h.readMany.mockImplementation(async ({ reads }) => ({
    results: reads.map((read: any) => ({
      feed_id: read.feed_id,
      ok: read.feed_id === 52,
      rows:
        read.feed_id === 52
          ? [{ ...h.feedRows[0], id: "other", source_url: url }]
          : [],
    })),
  }));
  const result = await h.run();
  expect(result.inbox_findings.some((x) => x.status === "partial")).toBe(true);
  expect(result.inbox_findings.some((x) => x.notification_id)).toBe(true);
  expect(
    h.send.mock.calls.some(([card]) =>
      card.title.includes("partially verified")
    )
  ).toBe(true);
  expect(h.send).toHaveBeenCalled();
});

test("draft recovery across windows preserves the original body after notification failure", async () => {
  const h = harness([]);
  h.ctx.extracted_data.inbox_findings = [inboxFinding()];
  h.send.mockImplementationOnce(async () => {
    throw new Error("Synthetic notification failure");
  });
  await expect(h.run()).rejects.toThrow("Synthetic notification failure");
  const original = inboxFinding().draft;
  h.ctx.window.run_id = 78;
  h.receipts.set(78, { ...h.receipts.get(77), output: null });
  h.ctx.extracted_data.inbox_findings = [
    { ...inboxFinding(), draft: "A regenerated answer" },
  ];
  await h.run();
  expect(h.queued.size).toBe(1);
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(h.send.mock.calls.at(-1)![0].body).toContain(original);
  expect(h.send.mock.calls.at(-1)![0].body).not.toContain(
    "A regenerated answer"
  );
  expect(h.send.mock.calls.at(-1)![0].browser_handoff_run_id).toBe(90);
});

test("concurrent identical inbox candidates retain one durable draft", async () => {
  const h = harness([]);
  h.ctx.extracted_data.inbox_findings = [inboxFinding()];
  await Promise.all([h.run(), h.run()]);
  expect(h.queued.size).toBe(1);
});

test("inbox discovery failure preserves independent post findings", async () => {
  const h = harness();
  h.ctx.extracted_data.inbox_findings = [
    { ...inboxFinding(), platform: "tiktok", feed_key: "messages" },
  ];
  const listAvailable = h.client.operations.listAvailable;
  h.client.operations.listAvailable = async (args?: any) => {
    if (args?.connector_key === "tiktok.web")
      throw new Error("Synthetic discovery failure");
    return listAvailable();
  };
  const result = await h.run();
  expect(result.findings).toHaveLength(1);
  expect(result.inbox_findings[0]).toMatchObject({ status: "partial" });
  expect(h.send.mock.calls.some(([card]) => card.browser_handoff_run_id)).toBe(
    true
  );
});

test.each([
  "no new draft",
  "target unavailable",
])("draft recovery keeps queued replies: %s", async (condition) => {
  const h = harness([]);
  h.ctx.extracted_data.inbox_findings = [inboxFinding()];
  h.send.mockImplementationOnce(async () => {
    throw new Error("Synthetic notification failure");
  });
  await expect(h.run()).rejects.toThrow("Synthetic notification failure");
  h.ctx.window.run_id = 78;
  h.receipts.set(78, { ...h.receipts.get(77), output: null });
  h.ctx.extracted_data.inbox_findings = [
    {
      ...inboxFinding(),
      draft: condition === "no new draft" ? "" : "New reply",
    },
  ];
  if (condition === "target unavailable") {
    const available = await h.client.operations.listAvailable();
    for (const operation of available.operations)
      for (const target of operation.execution_targets)
        target.executable = false;
    h.client.operations.listAvailable = async () => available;
  }
  await h.run();
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(h.send.mock.calls.at(-1)![0].body).toContain(inboxFinding().draft);
  expect(h.send.mock.calls.at(-1)![0].browser_handoff_run_id).toBe(90);
});

test("draft recovery cannot link an action still awaiting approval", async () => {
  const h = harness([]);
  h.ctx.extracted_data.inbox_findings = [inboxFinding()];
  h.send.mockImplementationOnce(async () => {
    throw new Error("Synthetic notification failure");
  });
  await expect(h.run()).rejects.toThrow("Synthetic notification failure");
  for (const run of h.queued.values()) run.approval_status = "pending";
  h.send.mockClear();
  const result = await h.run();
  expect(result.inbox_findings[0]).toMatchObject({ status: "partial" });
  expect(
    h.send.mock.calls.every(([card]) => !card.browser_handoff_run_id)
  ).toBe(true);
  expect(h.execute).toHaveBeenCalledTimes(1);
});

test("long source IDs retain distinct bounded delivery keys", async () => {
  const h = harness([]);
  const id = `source:${"a".repeat(480)}`;
  h.feedRows[0].id = id;
  h.ctx.extracted_data.inbox_findings = [{ ...inboxFinding(), source_id: id }];
  await h.run();
  expect(h.send.mock.calls[0][0].idempotency_key.length).toBeLessThan(250);
  h.feedRows[0].id = `${id}b`;
  h.ctx.extracted_data.inbox_findings = [
    { ...inboxFinding(), source_id: `${id}b` },
  ];
  await h.run();
  expect(h.send).toHaveBeenCalledTimes(2);
  expect(h.send.mock.calls[0][0].idempotency_key).not.toBe(
    h.send.mock.calls[1][0].idempotency_key
  );
});
