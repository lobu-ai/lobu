import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
  verifySocialEvidence,
  type SocialData,
} from "../external-social-evidence";
import { readSocialTimelinePage } from "../social-timeline-reader";

const now = Date.now();
const policy = {
  workspace: "synthetic-team",
  workflow: "synthetic-social",
  platforms: ["x"],
  receipt_workspaces: { x: ["synthetic-team"] },
};
const post = {
  source_url: "https://x.com/example/status/123",
  origin_id: "123",
  text: "A complete source body with a concrete claim",
  author: "Example",
  occurred_at: new Date(now - 86400000).toISOString(),
  truncated: false,
  media_unread: false,
};
function fixture() {
  const source = {
    status: "completed",
    operation_key: "evaluate",
    created_by_user_id: "synthetic-owner",
    created_at: new Date(now - 20000).toISOString(),
    completed_at: new Date(now - 10000).toISOString(),
    output: {
      value: {
        platform: "x",
        visibility: "visible",
        identity_verified: true,
        posts: [post],
      },
    },
  };
  const data: SocialData = {
    briefings: [
      {
        title: "Briefing",
        content: "Research",
        metadata: {
          workflow: policy.workflow,
          run_id: 10,
          coverage: [
            {
              platform: "x",
              status: "read",
              posts_read: 50,
              recent_posts_read: 50,
              read_receipts: [{ workspace: policy.workspace, run_id: 20 }],
              continuation_pending: false,
              stop_reason: "source_exhausted",
            },
          ],
        },
      },
    ],
    findings: [
      {
        title: "Finding",
        content: "A distilled claim",
        source_url: post.source_url,
        metadata: {
          workflow: policy.workflow,
          platform: "x",
          source_url: post.source_url,
          origin_id: post.origin_id,
          review_status: "pending",
          evidence_quote: "concrete claim",
          read_receipts: [{ workspace: policy.workspace, run_id: 20 }],
        },
      },
    ],
  };
  const client = {
    org: async (_workspace: string) => ({
      query: async () => [{ created_by: "synthetic-owner" }],
      operations: {
        getRun: async (id: number) => ({
          run:
            id === 10
              ? {
                  automation_id: 1,
                  status: "claimed",
                  created_at: new Date(now - 30000).toISOString(),
                  created_by_user_id: null,
                }
              : source,
        }),
      },
    }),
  };
  return {
    data,
    source,
    client,
    run: () => verifySocialEvidence(client, policy, 10, data),
  };
}

test("derives actual unique counts and verifies exact-source finding before completion", async () => {
  const h = fixture();
  h.source.output.value.posts.push(post);
  const result = await h.run();
  expect(result.briefings[0]!.metadata.coverage[0]).toMatchObject({
    posts_read: 1,
    recent_posts_read: 1,
    status: "read",
  });
  expect(
    result.briefings[0]!.metadata.evidence_verification.verified_findings
  ).toBe(1);
  expect(JSON.stringify(result)).not.toContain(post.text);
});

test("missing receipts, false quotes, wrong source and another owner's receipt cannot produce findings", async () => {
  for (const change of [
    (h: ReturnType<typeof fixture>) => {
      h.data.findings[0]!.metadata.read_receipts = [];
    },
    (h: ReturnType<typeof fixture>) => {
      h.data.findings[0]!.metadata.evidence_quote = "invented quote";
    },
    (h: ReturnType<typeof fixture>) => {
      h.data.findings[0]!.metadata.origin_id = "999";
    },
    (h: ReturnType<typeof fixture>) => {
      h.source.created_by_user_id = "different-owner";
    },
    (h: ReturnType<typeof fixture>) => {
      h.source.output.value.visibility = "hidden";
    },
    (h: ReturnType<typeof fixture>) => {
      h.source.created_at = new Date(now - 90000).toISOString();
    },
  ]) {
    const h = fixture();
    change(h);
    await expect(h.run()).rejects.toThrow();
  }
});

test("quiet windows with missing evidence become blocked, never successful empty scans", async () => {
  const h = fixture();
  h.data.findings = [];
  h.data.briefings[0]!.metadata.coverage[0].read_receipts = [];
  await h.run();
  expect(h.data.briefings[0]!.metadata.coverage[0]).toMatchObject({
    posts_read: 0,
    recent_posts_read: 0,
    status: "blocked",
  });
});

test("truncation, undated bodies, media and remaining pagination make coverage partial", async () => {
  for (const patch of [
    { truncated: true },
    { media_unread: true },
    { occurred_at: null },
  ]) {
    const h = fixture();
    h.source.output.value.posts = [{ ...post, ...patch } as typeof post];
    await h.run();
    expect(h.data.briefings[0]!.metadata.coverage[0].status).toBe("partial");
  }
  const h = fixture();
  h.data.briefings[0]!.metadata.coverage[0].continuation_pending = true;
  await h.run();
  expect(h.data.briefings[0]!.metadata.coverage[0].status).toBe("partial");
});

test("fully read older posts reduce the recent count without making coverage incomplete", async () => {
  const h = fixture();
  h.source.output.value.posts = [
    { ...post, occurred_at: new Date(now - 10 * 86400000).toISOString() },
  ];
  await h.run();
  expect(h.data.briefings[0]!.metadata.coverage[0]).toMatchObject({
    posts_read: 1,
    recent_posts_read: 0,
    status: "read",
  });
});

test("a receipt cannot be reused for another platform or an ungranted workspace", async () => {
  const h = fixture();
  h.data.findings[0]!.metadata.read_receipts[0].workspace = "private-other";
  await expect(h.run()).rejects.toThrow("out-of-scope");
  const other = fixture();
  other.data.findings[0]!.metadata.platform = "linkedin";
  await expect(other.run()).rejects.toThrow("out-of-scope");
});

test("graph observations require source author and target links, independently of digest selection", async () => {
  const h = fixture();
  h.data.findings = [];
  h.source.output.value.posts = [
    Object.assign(
      { ...post },
      {
        author_url: "https://x.com/example",
        mentioned_profiles: ["https://x.com/target"],
      }
    ),
  ];
  const candidate = {
    workspace: policy.workspace,
    connection: "synthetic-browser",
    platform: "x",
    origin_id: post.origin_id,
    source_url: post.source_url,
    summary: "Example mentions Target.",
    observed_at: new Date(now - 15000).toISOString(),
    subject: {
      kind: "person",
      label: "Example",
      profile_url: "https://x.com/example",
    },
    claims: [
      {
        predicate: "mentioned",
        target: {
          kind: "organization",
          label: "Target",
          profile_url: "https://x.com/target",
        },
        evidence_quote: "concrete claim",
      },
    ],
    read_receipts: [{ workspace: policy.workspace, run_id: 20 }],
    evidence_verified: false,
  };
  h.data.briefings[0]!.metadata.graph_candidates = [candidate];
  // MCP's V8 sandbox has standard JS globals but no browser URL constructor.
  await runInNewContext(
    `(${verifySocialEvidence.toString()})(client, policy, 10, data)`,
    { client: h.client, policy, data: h.data }
  );
  expect(candidate.evidence_verified).toBe(true);
  expect(h.data.briefings[0]!.metadata.graph_status).toBe("pending_ingestion");
  candidate.claims[0]!.target.profile_url = "https://x.com/guessed";
  await expect(h.run()).rejects.toThrow("target-profile evidence");
  expect(candidate.evidence_verified).toBe(false);
});

test("a verified empty page is distinguishable from missing source evidence", async () => {
  const h = fixture();
  h.data.findings = [];
  h.source.output.value.posts = [];
  await h.run();
  expect(h.data.briefings[0]!.metadata.coverage[0]).toMatchObject({
    status: "read",
    posts_read: 0,
  });
});

test("browser snapshot accepts label whitespace, returns full text and rejects hidden tabs", () => {
  const root = globalThis as any;
  const originalDocument = root.document;
  const originalLocation = root.location;
  const text = `${"complete body ".repeat(1000)}last sentence`;
  const card = {
    querySelector: (selector: string) =>
      selector.includes("tweetText")
        ? { innerText: text, querySelectorAll: () => [] }
        : selector === "time"
          ? {
              dateTime: post.occurred_at,
              closest: () => ({ href: post.source_url }),
            }
          : null,
  };
  try {
    root.document = {
      visibilityState: "visible",
      querySelector: () => ({ getAttribute: () => "/synthetic" }),
      querySelectorAll: (s: string) =>
        s.includes("role")
          ? [{ innerText: "Following ", getAttribute: () => "true" }]
          : [card],
    };
    root.location = {
      origin: "https://x.com",
      pathname: "/home",
      href: "https://x.com/home",
    };
    expect(
      readSocialTimelinePage({
        platform: "x",
        account_path: "/synthetic",
        page_path: "/home",
      }).posts[0].text
    ).toBe(text);
    root.document.visibilityState = "hidden";
    expect(() =>
      readSocialTimelinePage({
        platform: "x",
        account_path: "/synthetic",
        page_path: "/home",
      })
    ).toThrow("visible");
  } finally {
    root.document = originalDocument;
    root.location = originalLocation;
  }
});

test("an unknown window or source run fails with a named error, not a crash", async () => {
  const h = fixture();
  const org = h.client.org;
  h.client.org = async (workspace: string) => {
    const c = await org(workspace);
    return {
      ...c,
      operations: {
        getRun: async (id: number) =>
          id === 20
            ? ({ error: "Run not found" } as any)
            : c.operations.getRun(id),
      },
    };
  };
  await expect(h.run()).rejects.toThrow("processing window");
  h.client.org = async () => ({
    ...(await org(policy.workspace)),
    operations: { getRun: async () => ({ error: "Run not found" }) as any },
  });
  await expect(h.run()).rejects.toThrow("Missing claimed processing window");
});

test("TikTok native inspection verifies its full caption while media stays partial", async () => {
  const h = fixture();
  const tiktok = {
    ...policy,
    platforms: ["tiktok"],
    receipt_workspaces: { tiktok: [policy.workspace] },
  };
  h.source.operation_key = "inspect_post";
  const url = "https://www.tiktok.com/@example/video/123";
  (h.source as any).output = {
    post: {
      source_url: url,
      origin_id: "123",
      text: post.text,
      author: { handle: "example", name: "Example" },
      created_at: post.occurred_at,
    },
    frames: [{}],
    audio_inspected: false,
  };
  h.data.briefings[0]!.metadata.coverage[0].platform = "tiktok";
  const f = h.data.findings[0]!;
  f.source_url = url;
  Object.assign(f.metadata, { platform: "tiktok", source_url: url });
  const result = await verifySocialEvidence(h.client, tiktok, 10, h.data);
  expect(result.briefings[0]!.metadata.coverage[0]).toMatchObject({
    posts_read: 1,
    recent_posts_read: 1,
    status: "partial",
  });
  expect(
    result.briefings[0]!.metadata.evidence_verification.verified_findings
  ).toBe(1);
  (h.source as any).output.post.source_url =
    "https://www.tiktok.com/@other/video/123";
  await expect(
    verifySocialEvidence(h.client, tiktok, 10, h.data)
  ).rejects.toThrow("TikTok source identity");
});
