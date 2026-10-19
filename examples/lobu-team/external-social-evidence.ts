import { readSocialTimelinePage } from "./social-timeline-reader";

// Pin this before MCP compiles the verifier; runtime Function.toString() can
// change when the sandbox combines declarations or reformats the function.
const timelineReaderSource = readSocialTimelinePage.toString();

/** Tenant-owned external processing contract. No platform or storage changes. */
type Receipt =
  | { workspace: string; run_id: number }
  | { workspace: string; event_id: number; origin_id: string };
type SourcePost = {
  source_url: string;
  origin_id: string;
  text: string;
  author: string;
  author_url?: string;
  mentioned_profiles?: string[];
  occurred_at: string | null;
  truncated: boolean;
  media_unread: boolean;
};
type Coverage = {
  platform: string;
  status: "read" | "partial" | "blocked";
  posts_read: number;
  recent_posts_read: number;
  read_receipts: Receipt[];
  detail: string;
  continuation_pending?: boolean;
  stop_reason?: string;
};
type Draft = {
  title: string;
  content: string;
  source_url?: string;
  metadata: Record<string, any>;
};
export type SocialData = {
  briefings: Draft[];
  findings: Draft[];
};
export type EvidencePolicy = {
  workspace: string;
  workflow: string;
  platforms: string[];
  // Cross-workspace receipt reads are explicit and platform-bound.
  receipt_workspaces: Record<string, string[]>;
  company_linkedin_path?: string;
};
type EvidenceClient = {
  org(workspace: string): Promise<{
    operations: { getRun(id: number): Promise<{ run: any }> };
    query(sql: string): Promise<any[]>;
  }>;
};

type SourceReader = (
  platform: string,
  receipt: Receipt
) => Promise<SourcePost[]>;
type ReadingWindow = { ownerId: string; start: number; end: number };

/** Shared by completion preflight and its notification reaction. */
export function assertBriefingEnvelope(
  data: SocialData,
  policy: EvidencePolicy,
  runId: number
) {
  if (
    !Array.isArray(data.briefings) ||
    data.briefings.length !== 1 ||
    !Array.isArray(data.findings)
  )
    throw new Error("Expected one briefing and findings array");
  const m = data.briefings[0]?.metadata;
  if (m?.workflow !== policy.workflow || m.run_id !== runId)
    throw new Error("Briefing ownership/run mismatch");
  const coverage = m.coverage as Coverage[];
  if (
    !Array.isArray(coverage) ||
    coverage.length !== policy.platforms.length ||
    new Set(coverage.map((c) => c?.platform)).size !==
      policy.platforms.length ||
    coverage.some((c) => !policy.platforms.includes(c?.platform))
  )
    throw new Error("Coverage must name every configured platform once");
  return m;
}

export function findingHasReceipt(f: Draft, policy: EvidencePolicy) {
  const m = f?.metadata;
  return (
    m?.workflow === policy.workflow &&
    policy.platforms.includes(m.platform) &&
    m.source_url === f.source_url &&
    m.review_status === "pending" &&
    Array.isArray(m.read_receipts) &&
    m.read_receipts.length > 0
  );
}

/** Reject malformed retained rows before either counting or matching excerpts.
 * Empty text is valid: the reader returns it for media-only posts. */
function assertSourcePosts(posts: SourcePost[]): SourcePost[] {
  if (
    posts.some(
      (p) =>
        !p ||
        typeof p.text !== "string" ||
        [p.source_url, p.origin_id].some(
          (value) => typeof value !== "string" || !value.trim()
        )
    )
  )
    throw new Error(
      "Malformed source post: expected source URL, identity and text"
    );
  return posts;
}

/** Normalize only the operation shapes accepted by this example. */
function readPostsFromOperation(
  run: any,
  platform: string,
  policy: EvidencePolicy
): SourcePost[] {
  if (platform === "tiktok" && run.operation_key === "inspect_post") {
    const p = run.output?.post;
    const handle = p?.author?.handle;
    if (
      typeof p?.text !== "string" ||
      typeof handle !== "string" ||
      !handle ||
      typeof p.origin_id !== "string" ||
      !p.origin_id ||
      !["video", "photo"].some(
        (kind) =>
          p.source_url ===
          `https://www.tiktok.com/@${handle}/${kind}/${p.origin_id}`
      )
    )
      throw new Error("TikTok source identity is missing or inconsistent");
    // The connector returns the source's complete desc, but screenshots
    // are only samples and never prove that video/audio was understood.
    return [
      {
        source_url: p.source_url,
        origin_id: p.origin_id,
        text: p.text,
        author: p.author.name || handle,
        author_url: `https://www.tiktok.com/@${handle}`,
        occurred_at: p.created_at ?? null,
        truncated: false,
        media_unread: true,
      },
    ];
  }
  if (platform === "linkedin" && run.operation_key === "read_home_feed") {
    if (policy.company_linkedin_path)
      throw new Error("Member timeline is outside company scope");
    if (
      !Array.isArray(run.output?.items) ||
      run.output.items.some((p: any) => !p || typeof p !== "object")
    )
      throw new Error("Malformed LinkedIn source receipt");
    return run.output.items
      .filter((p: any) => p.type === "post")
      .map((p: any) => ({
        source_url: p.url,
        origin_id: p.id,
        text: p.text,
        author: p.author || "",
        occurred_at: null,
        truncated: true,
        media_unread: true,
      }));
  }
  if (run.operation_key !== "evaluate")
    throw new Error("Unsupported source receipt operation");
  // Bind the example's supported readers to their retained operation input.
  // This detects stale/ad-hoc readers; it is not proof against a malicious caller.
  if (
    (platform === "x" ||
      (platform === "linkedin" && policy.company_linkedin_path)) &&
    (typeof run.input?.expression !== "string" ||
      !run.input.expression.includes(timelineReaderSource))
  )
    throw new Error("Source receipt did not use the supplied timeline reader");
  const value = run.output?.value;
  if (
    platform === "linkedin" &&
    policy.company_linkedin_path &&
    value?.page_url !==
      `https://www.linkedin.com${policy.company_linkedin_path}`
  )
    throw new Error("LinkedIn receipt is outside the authorized company Page");
  if (
    !value ||
    value.visibility !== "visible" ||
    value.identity_verified !== true ||
    value.platform !== platform ||
    !Array.isArray(value.posts)
  )
    throw new Error(
      "Source receipt lacks a verified visible timeline snapshot"
    );
  return value.posts as SourcePost[];
}

async function loadSourcePosts(
  client: EvidenceClient,
  policy: EvidencePolicy,
  window: ReadingWindow,
  platform: string,
  receipt: Receipt
): Promise<SourcePost[]> {
  const c = await client.org(receipt.workspace);
  if (!("run_id" in receipt)) {
    // Stored HN events have no browser-operation run. Keep their exact
    // event version AND stable source identity; title-only stays partial.
    if (platform !== "hackernews" || !receipt.origin_id)
      throw new Error("Unsupported stored source");
    const [event] = await c.query(
      `SELECT id, origin_id, title, payload_text, source_url, author_name, occurred_at, connector_key FROM events WHERE id = ${receipt.event_id} LIMIT 1`
    );
    if (
      !event ||
      event.origin_id !== receipt.origin_id ||
      event.connector_key !== "hackernews"
    )
      throw new Error("Stored source identity mismatch");
    return [
      {
        source_url: event.source_url,
        origin_id: event.origin_id,
        text: event.payload_text || event.title || "",
        author: event.author_name || "",
        occurred_at: event.occurred_at,
        truncated: true,
        media_unread: true,
      },
    ];
  }
  const { run } = await c.operations.getRun(receipt.run_id);
  const created = Date.parse(run?.created_at);
  const completed = Date.parse(run?.completed_at);
  if (
    run?.status !== "completed" ||
    run.created_by_user_id !== window.ownerId ||
    !Number.isFinite(created) ||
    !Number.isFinite(completed) ||
    created < window.start ||
    completed < created ||
    completed > window.end
  )
    throw new Error("Source receipt does not belong to this processing window");
  return readPostsFromOperation(run, platform, policy);
}

/** Cache each authorized receipt once across coverage, findings and candidates. */
function createSourceReader(
  client: EvidenceClient,
  policy: EvidencePolicy,
  window: ReadingWindow
): SourceReader {
  const cache = new Map<string, Promise<SourcePost[]>>();
  return async (platform, receipt) => {
    if (!receipt || typeof receipt !== "object")
      throw new Error("Missing or out-of-scope source receipt");
    const receiptId = "run_id" in receipt ? receipt.run_id : receipt.event_id;
    if (
      !Number.isSafeInteger(receiptId) ||
      receiptId <= 0 ||
      !policy.receipt_workspaces[platform]?.includes(receipt.workspace)
    )
      throw new Error("Missing or out-of-scope source receipt");
    const key = `${platform}:${receipt.workspace}:${"run_id" in receipt ? "run" : "event"}:${receiptId}`;
    let result = cache.get(key);
    if (!result) {
      result = loadSourcePosts(client, policy, window, platform, receipt).then(
        assertSourcePosts
      );
      cache.set(key, result);
    }
    return result;
  };
}

async function verifyCoverage(
  coverage: Coverage[],
  read: SourceReader,
  end: number,
  issues: string[]
) {
  for (const c of coverage) {
    const posts = new Map<string, SourcePost>();
    const platformIssues: string[] = [];
    let verifiedPages = 0;
    let textless = false;
    for (const receipt of Array.isArray(c.read_receipts)
      ? c.read_receipts
      : []) {
      try {
        const rows = await read(c.platform, receipt);
        verifiedPages++;
        for (const p of rows) {
          if (p.text.trim()) posts.set(p.origin_id, p);
          else textless = true;
        }
      } catch (error) {
        platformIssues.push(
          `${c.platform}: ${error instanceof Error ? error.message : "receipt unavailable"}`
        );
      }
    }
    // Counts come from inspected source receipts, never model-written totals.
    c.posts_read = posts.size;
    c.recent_posts_read = [...posts.values()].filter((p) => {
      const t = Date.parse(p.occurred_at ?? "");
      return Number.isFinite(t) && t >= end - 7 * 86400000 && t <= end;
    }).length;
    const incomplete =
      textless ||
      [...posts.values()].some(
        (p) =>
          p.truncated !== false ||
          p.media_unread !== false ||
          !p.author ||
          !Number.isFinite(Date.parse(p.occurred_at ?? ""))
      );
    if (!verifiedPages) c.status = "blocked";
    else if (
      incomplete ||
      c.continuation_pending !== false ||
      c.stop_reason !== "source_exhausted" ||
      platformIssues.length
    )
      c.status = "partial";
    else c.status = "read";
    c.detail =
      `Verified ${posts.size} unique text posts; ${c.recent_posts_read} dated within seven days. ${incomplete ? "Incomplete text, unknown dates or unread media. " : ""}${c.continuation_pending !== false ? "Continuation remains. " : ""}${platformIssues.join("; ")}`.trim();
    issues.push(...platformIssues);
  }
}

async function findSourcePost(
  read: SourceReader,
  platform: string,
  receipts: Receipt[],
  sourceUrl: string | undefined,
  originId: string
) {
  const posts = (
    await Promise.all(receipts.map((r) => read(platform, r)))
  ).flat();
  return posts.find(
    (p) => p.source_url === sourceUrl && p.origin_id === originId
  );
}

function quoteInBody(body: string, value: unknown) {
  const quote = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return (
    quote.length > 0 &&
    quote.length <= 200 &&
    body.replace(/\s+/g, " ").includes(quote)
  );
}

async function verifyFindings(
  findings: Draft[],
  policy: EvidencePolicy,
  read: SourceReader
) {
  const seen = new Set<string>();
  for (const f of findings) {
    if (!findingHasReceipt(f, policy))
      throw new Error(
        "Finding lacks its exact source receipt or uses an out-of-scope platform"
      );
    const fm = f.metadata;
    const post = await findSourcePost(
      read,
      fm.platform,
      fm.read_receipts,
      f.source_url,
      fm.origin_id
    );
    if (!post || !quoteInBody(post.text, fm.evidence_quote))
      throw new Error(
        "Finding excerpt is absent from the exact source receipt"
      );
    const key = `${fm.platform}:${fm.origin_id}`;
    if (seen.has(key)) throw new Error("Duplicate finding");
    seen.add(key);
  }
}

function canonicalProfile(url: string) {
  // This function is embedded in MCP's V8 sandbox, which has no URL global.
  // Accept only ordinary HTTP(S) profile URLs, without credentials or ports.
  const parts = /^(https?):\/\/([a-z0-9.-]+)(\/[^?#]*)?(?:[?#].*)?$/i.exec(url);
  if (!parts) throw new Error("Invalid graph profile URL");
  return `${parts[1]}://${parts[2]!.replace(/^www\./i, "")}${(parts[3] || "/").replace(/\/posts\/?$/, "").replace(/\/$/, "")}`.toLowerCase();
}

async function verifyGraphCandidates(
  graph: any[],
  policy: EvidencePolicy,
  read: SourceReader
) {
  if (!Array.isArray(graph) || graph.length > 100)
    throw new Error("Graph candidates must be a bounded array");
  const graphSeen = new Set<string>();
  for (const g of graph) {
    if (!g || typeof g !== "object")
      throw new Error("Invalid graph observation");
    g.evidence_verified = false;
    if (
      g.workspace !== policy.workspace ||
      !policy.platforms.includes(g.platform) ||
      typeof g.connection !== "string" ||
      !g.connection ||
      typeof g.summary !== "string" ||
      !g.summary.trim() ||
      g.summary.length > 280 ||
      !Array.isArray(g.read_receipts) ||
      !g.read_receipts.length ||
      !Array.isArray(g.claims) ||
      g.claims.length > 20
    )
      throw new Error("Invalid graph observation");
    const p = await findSourcePost(
      read,
      g.platform,
      g.read_receipts,
      g.source_url,
      g.origin_id
    );
    if (
      !p?.author_url ||
      !g.subject?.profile_url ||
      canonicalProfile(p.author_url) !== canonicalProfile(g.subject.profile_url)
    )
      throw new Error("Graph subject lacks a matching author profile receipt");
    const key = `${g.workspace}:${g.connection}:${g.platform}:${g.origin_id}`;
    if (graphSeen.has(key)) throw new Error("Duplicate graph observation");
    graphSeen.add(key);
    for (const claim of g.claims) {
      if (!claim || typeof claim !== "object")
        throw new Error("Invalid graph observation");
      if (
        !quoteInBody(p.text, claim.evidence_quote) ||
        !claim.target?.profile_url ||
        !p.mentioned_profiles?.some(
          (url) =>
            canonicalProfile(url) === canonicalProfile(claim.target.profile_url)
        )
      )
        throw new Error(
          "Graph relationship lacks exact text and target-profile evidence"
        );
    }
    g.subject.profile_url = canonicalProfile(g.subject.profile_url);
    g.source_time = p.occurred_at;
    g.evidence_verified = true;
  }
  return graph.length;
}

/** Verify a claimed or completed window using its owner's retained source receipts. */
export async function verifySocialEvidence(
  client: EvidenceClient,
  policy: EvidencePolicy,
  runId: number,
  data: SocialData
) {
  const m = assertBriefingEnvelope(data, policy, runId);
  if (data.findings.length > 6)
    throw new Error("Expected at most six findings");
  const coverage = m.coverage as Coverage[];
  const workspace = await client.org(policy.workspace);
  // getRun answers {error} without a run for an unknown or foreign id.
  const { run: parent } = await workspace.operations.getRun(runId);
  const start = Date.parse(parent?.created_at);
  if (
    !Number.isFinite(start) ||
    !["running", "claimed", "completed"].includes(parent?.status)
  )
    throw new Error("Missing claimed processing window");
  const end = parent.completed_at
    ? Date.parse(parent.completed_at)
    : Date.now();
  const automationId = Number(parent.automation_id);
  if (!Number.isSafeInteger(automationId) || automationId <= 0)
    throw new Error("Missing Automation identity");
  const [owner] = await workspace.query(
    `SELECT created_by FROM automations WHERE id = ${automationId}`
  );
  if (!owner?.created_by) throw new Error("Automation owner unavailable");
  const read = createSourceReader(client, policy, {
    ownerId: owner.created_by,
    start,
    end,
  });
  const issues: string[] = [];
  await verifyCoverage(coverage, read, end, issues);
  await verifyFindings(data.findings, policy, read);
  const graphCount = await verifyGraphCandidates(
    m.graph_candidates ?? [],
    policy,
    read
  );
  m.graph_status = graphCount ? "pending_ingestion" : "no_candidates";
  m.evidence_verification = {
    version: 1,
    run_id: runId,
    issues,
    verified_findings: data.findings.length,
    verified_graph_candidates: graphCount,
  };
  // Raw source text stays in receipts, never in checkpoints or outputs.
  return data;
}

/** The MCP isolate has no imports; include the verifier's explicit dependencies. */
export function socialEvidenceVerifierSource() {
  return (
    `const timelineReaderSource = ${JSON.stringify(timelineReaderSource)};\n` +
    [
      assertSourcePosts,
      assertBriefingEnvelope,
      findingHasReceipt,
      findSourcePost,
      quoteInBody,
      readPostsFromOperation,
      loadSourcePosts,
      createSourceReader,
      verifyCoverage,
      verifyFindings,
      canonicalProfile,
      verifyGraphCandidates,
      verifySocialEvidence,
    ]
      .map((fn) => fn.toString())
      .join("\n\n")
  );
}
