import { expect, mock, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { externalSocialReaction } from "../external-social.reaction";
import {
  type SocialData,
  socialEvidenceVerifierSource,
  type VerifySocialEvidence,
} from "../external-social-evidence";
import { readSocialTimelinePage } from "../social-timeline-reader";

// Exercise all receipt paths through the emitted script, without module imports
// or the host URL global, after the formatting changes made by MCP compilation.
const verifySocialEvidence: VerifySocialEvidence = runInNewContext(
  `${new Bun.Transpiler({ loader: "ts", minifyWhitespace: true }).transformSync(
    socialEvidenceVerifierSource()
  )}\nverifySocialEvidence;`
);

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
    input: {
      expression: `(${readSocialTimelinePage.toString()})({platform:"x",account_path:"/synthetic",page_path:"/home"})`,
    },
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

test("serialized reaction and preflight share the same briefing boundary", async () => {
  const h = fixture();
  await h.run();
  const script = `${externalSocialReaction(policy).replace("export default", "const reaction =")}\nreaction(ctx, client);`;
  const react = () =>
    runInNewContext(script, {
      ctx: {
        automation: { id: 1 },
        window: { run_id: 10 },
        extracted_data: h.data,
      },
      client: {
        query: async () => [{ created_by: "synthetic-owner" }],
        notifications: { send: async () => ({ event_id: 100 }) },
      },
    });
  expect((await react()).evidence_verified).toBe(true);
  h.data.briefings[0]!.metadata.coverage.push({ platform: "outside-policy" });
  await expect(h.run()).rejects.toThrow(
    "Coverage must name every configured platform once"
  );
  await expect(react()).rejects.toThrow(
    "Coverage must name every configured platform once"
  );
});

test("graph observations require source author and target links, independently of digest selection", async () => {
  const h = fixture();
  h.data.findings = [];
  h.source.output.value.posts = [
    Object.assign(
      { ...post },
      {
        author_url: "https://x.com/example",
        mentioned_profiles: [
          "mailto:example@example.test",
          "https://x.com/target",
        ],
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
  await h.run();
  expect(candidate.evidence_verified).toBe(true);
  expect(h.data.briefings[0]!.metadata.graph_status).toBe("pending_ingestion");
  candidate.claims[0]!.target.profile_url = "mailto:example@example.test";
  await expect(h.run()).rejects.toThrow("Invalid graph profile URL");
  candidate.claims[0]!.target.profile_url = ["https://x.com/target"] as any;
  await expect(h.run()).rejects.toThrow("Invalid graph profile URL");
  candidate.claims[0]!.target.profile_url = "https://x.com/target";
  const claim = candidate.claims[0]!;
  (candidate.claims as unknown[]) = [null];
  await expect(h.run()).rejects.toThrow("Invalid graph observation");
  candidate.claims = [claim];
  candidate.claims[0]!.target.profile_url = "https://x.com/guessed";
  await expect(h.run()).rejects.toThrow("target-profile evidence");
  expect(candidate.evidence_verified).toBe(false);
  candidate.claims[0]!.target.profile_url = "https://x.com/target";
  candidate.platform = "linkedin";
  h.source.output.value.platform = "linkedin";
  // A receipt grant alone must not expand the configured platform scope.
  await expect(
    verifySocialEvidence(
      h.client,
      {
        ...policy,
        receipt_workspaces: {
          ...policy.receipt_workspaces,
          linkedin: [policy.workspace],
        },
      },
      10,
      h.data
    )
  ).rejects.toThrow("Invalid graph observation");
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

test("malformed source profile lists fail with a named receipt error", async () => {
  for (const mentioned_profiles of ["https://x.com/target", null, [42]]) {
    const h = fixture();
    h.source.output.value.posts = [
      Object.assign({ ...post }, { mentioned_profiles }),
    ];
    await expect(h.run()).rejects.toThrow("Malformed source post");
  }
});

test("preflight refuses an invalid Automation identity before querying", async () => {
  for (const automation_id of [undefined, 0, -1, "invalid"]) {
    const h = fixture();
    const query = mock(async () => [{ created_by: "synthetic-owner" }]);
    h.client.org = async () => ({
      query,
      operations: {
        getRun: async () =>
          ({
            run: {
              automation_id,
              status: "claimed",
              created_at: new Date(now - 30000).toISOString(),
            },
          }) as any,
      },
    });
    await expect(h.run()).rejects.toThrow("Missing Automation identity");
    expect(query).not.toHaveBeenCalled();
  }
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

test("malformed model-written entries fail with named errors, not crashes", async () => {
  const h = fixture();
  (h.data.findings as unknown[]) = [null];
  await expect(h.run()).rejects.toThrow("Finding lacks its exact source");
  const coverage = fixture();
  (coverage.data.briefings[0]!.metadata.coverage as unknown[]) = [null];
  await expect(coverage.run()).rejects.toThrow("Coverage must name");
  (coverage.data.briefings as unknown[]) = [null];
  await expect(coverage.run()).rejects.toThrow("Briefing ownership");
  const receipts = fixture();
  receipts.data.findings = [];
  receipts.data.briefings[0]!.metadata.coverage[0].read_receipts = {};
  await receipts.run();
  expect(receipts.data.briefings[0]!.metadata.coverage[0].status).toBe(
    "blocked"
  );
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

test("X and company LinkedIn receipts require the supplied reader in the executed expression", async () => {
  for (const platform of ["x", "linkedin"]) {
    const h = fixture();
    const bound = {
      ...policy,
      platforms: [platform],
      receipt_workspaces: { [platform]: [policy.workspace] },
      ...(platform === "linkedin"
        ? { company_linkedin_path: "/company/synthetic/admin/feed/" }
        : {}),
    };
    h.source.output.value.platform = platform;
    Object.assign(h.source.output.value, {
      page_url: "https://www.linkedin.com/company/synthetic/admin/feed/",
    });
    h.data.briefings[0]!.metadata.coverage[0].platform = platform;
    h.data.findings[0]!.metadata.platform = platform;
    h.source.input.expression = `({identity_verified:true,posts:[]})`;
    await expect(
      verifySocialEvidence(h.client, bound, 10, h.data)
    ).rejects.toThrow("supplied timeline reader");
  }
});

test("other authorized browser sources retain their own reader contract", async () => {
  const h = fixture();
  h.source.input.expression = "readAuthorizedRedditTimeline()";
  h.source.output.value.platform = "reddit";
  h.data.briefings[0]!.metadata.coverage[0].platform = "reddit";
  h.data.findings[0]!.metadata.platform = "reddit";
  await expect(
    verifySocialEvidence(
      h.client,
      {
        ...policy,
        platforms: ["reddit"],
        receipt_workspaces: { reddit: [policy.workspace] },
      },
      10,
      h.data
    )
  ).resolves.toBe(h.data);
});

test("malformed retained posts are rejected before coverage or excerpt verification", async () => {
  for (const native of [false, true]) {
    for (const field of ["text", "source_url", "origin_id"]) {
      for (const invalid of field === "text"
        ? [undefined, 42]
        : [undefined, "", 42]) {
        const h = fixture();
        const malformed = { ...post, [field]: invalid };
        const bound = native
          ? {
              ...policy,
              platforms: ["linkedin"],
              receipt_workspaces: { linkedin: [policy.workspace] },
            }
          : policy;
        if (native) {
          h.source.operation_key = "read_home_feed";
          (h.source as any).output = {
            items: [
              {
                type: "post",
                text: malformed.text,
                url: malformed.source_url,
                id: malformed.origin_id,
              },
            ],
          };
          h.data.briefings[0]!.metadata.coverage[0].platform = "linkedin";
          h.data.findings[0]!.metadata.platform = "linkedin";
        } else {
          h.source.output.value.posts = [malformed] as (typeof post)[];
        }
        await expect(
          verifySocialEvidence(h.client, bound, 10, h.data)
        ).rejects.toThrow("Malformed source post");
        h.data.findings = [];
        await verifySocialEvidence(h.client, bound, 10, h.data);
        expect(h.data.briefings[0]!.metadata.coverage[0]).toMatchObject({
          status: "blocked",
          posts_read: 0,
        });
      }
    }
  }
});

test("native LinkedIn remains partial and cannot substitute for a company Page read", async () => {
  const h = fixture();
  const bound = {
    ...policy,
    platforms: ["linkedin"],
    receipt_workspaces: { linkedin: [policy.workspace] },
  };
  h.source.operation_key = "read_home_feed";
  (h.source as any).output = {
    items: [
      {
        type: "post",
        url: post.source_url,
        id: post.origin_id,
        text: post.text,
        author: post.author,
      },
    ],
  };
  h.data.briefings[0]!.metadata.coverage[0].platform = "linkedin";
  h.data.findings[0]!.metadata.platform = "linkedin";
  await verifySocialEvidence(h.client, bound, 10, h.data);
  expect(h.data.briefings[0]!.metadata.coverage[0]).toMatchObject({
    posts_read: 1,
    status: "partial",
  });
  await expect(
    verifySocialEvidence(
      h.client,
      { ...bound, company_linkedin_path: "/company/synthetic/admin/feed/" },
      10,
      h.data
    )
  ).rejects.toThrow("outside company scope");
  (h.source as any).output.items = [null];
  await expect(
    verifySocialEvidence(h.client, bound, 10, h.data)
  ).rejects.toThrow("Malformed LinkedIn source receipt");
});

test("a media-only post leaves its page verified but partial", async () => {
  const h = fixture();
  h.source.output.value.posts.push({
    ...post,
    source_url: "https://x.com/example/status/124",
    origin_id: "124",
    text: "",
    media_unread: true,
  });
  await verifySocialEvidence(h.client, policy, 10, h.data);
  expect(h.data.briefings[0]!.metadata.coverage[0]).toMatchObject({
    posts_read: 1,
    status: "partial",
  });
});
