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
  [key: string]: unknown;
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
  profiles?: Draft[];
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

/** Run in the authorized external MCP caller before completeWindow, or to
 * recheck a completed window without mutating it. The
 * background reaction has no implicit cross-workspace OAuth grant. */
export async function verifySocialEvidence(
  client: EvidenceClient,
  policy: EvidencePolicy,
  runId: number,
  data: SocialData
) {
  if (data.briefings.length !== 1 || data.findings.length > 6)
    throw new Error("Expected one briefing and at most six findings");
  const briefing = data.briefings[0]!;
  const m = briefing.metadata;
  if (m.workflow !== policy.workflow || m.run_id !== runId)
    throw new Error("Briefing ownership/run mismatch");
  const coverage = m.coverage as Coverage[];
  if (
    !Array.isArray(coverage) ||
    coverage.length !== policy.platforms.length ||
    new Set(coverage.map((c) => c.platform)).size !== policy.platforms.length ||
    coverage.some((c) => !policy.platforms.includes(c.platform))
  )
    throw new Error("Coverage must name every configured platform once");
  const workspace = await client.org(policy.workspace);
  const { run: parent } = await workspace.operations.getRun(runId);
  const start = Date.parse(parent.created_at);
  if (
    !Number.isFinite(start) ||
    !["running", "claimed", "completed"].includes(parent.status)
  )
    throw new Error("Missing claimed processing window");
  const end = parent.completed_at
    ? Date.parse(parent.completed_at)
    : Date.now();
  if (!Number.isSafeInteger(Number(parent.automation_id)))
    throw new Error("Missing Automation identity");
  const [owner] = await workspace.query(
    `SELECT created_by FROM automations WHERE id = ${Number(parent.automation_id)}`
  );
  if (!owner?.created_by) throw new Error("Automation owner unavailable");
  const cache = new Map<string, Promise<SourcePost[]>>();
  const read = async (platform: string, receipt: Receipt) => {
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
      result = (async () => {
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
        const created = Date.parse(run.created_at);
        const completed = Date.parse(run.completed_at);
        if (
          run.status !== "completed" ||
          run.created_by_user_id !== owner.created_by ||
          !Number.isFinite(created) ||
          !Number.isFinite(completed) ||
          created < start ||
          completed < created ||
          completed > end
        )
          throw new Error(
            "Source receipt does not belong to this processing window"
          );
        if (platform === "linkedin" && run.operation_key === "read_home_feed") {
          if (policy.company_linkedin_path)
            throw new Error("Member timeline is outside company scope");
          if (!Array.isArray(run.output?.items))
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
        const value = run.output?.value;
        if (
          platform === "linkedin" &&
          policy.company_linkedin_path &&
          value?.page_url !==
            `https://www.linkedin.com${policy.company_linkedin_path}`
        )
          throw new Error(
            "LinkedIn receipt is outside the authorized company Page"
          );
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
      })();
      cache.set(key, result);
    }
    return result;
  };
  const issues: string[] = [];
  for (const c of coverage) {
    const posts = new Map<string, SourcePost>();
    let verifiedPages = 0;
    for (const receipt of c.read_receipts ?? []) {
      try {
        const rows = await read(c.platform, receipt);
        verifiedPages++;
        for (const p of rows) {
          if (
            !p.source_url ||
            !p.origin_id ||
            typeof p.text !== "string" ||
            !p.text.trim()
          )
            continue;
          posts.set(p.origin_id, p);
        }
      } catch (error) {
        issues.push(
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
    const incomplete = [...posts.values()].some(
      (p) => p.truncated !== false || p.media_unread !== false || !p.author
    );
    c.status = !verifiedPages
      ? "blocked"
      : incomplete ||
          c.recent_posts_read !== posts.size ||
          c.continuation_pending !== false ||
          c.stop_reason !== "source_exhausted" ||
          issues.some((issue) => issue.startsWith(`${c.platform}:`))
        ? "partial"
        : "read";
    c.detail = `Verified ${posts.size} unique text posts; ${c.recent_posts_read} dated within seven days. ${incomplete ? "Incomplete text or unread media. " : ""}${c.continuation_pending !== false ? "Continuation remains. " : ""}${issues.filter((issue) => issue.startsWith(`${c.platform}:`)).join("; ")}`;
  }
  const seen = new Set<string>();
  for (const f of data.findings) {
    const fm = f.metadata;
    if (
      fm.workflow !== policy.workflow ||
      fm.source_url !== f.source_url ||
      fm.review_status !== "pending" ||
      !Array.isArray(fm.read_receipts) ||
      !fm.read_receipts.length
    )
      throw new Error("Finding lacks its exact source receipt");
    const candidates: SourcePost[] = (
      await Promise.all(
        fm.read_receipts.map((r: Receipt) => read(fm.platform, r))
      )
    ).flat();
    const post = candidates.find(
      (p) => p.source_url === f.source_url && p.origin_id === fm.origin_id
    );
    const quote = String(fm.evidence_quote ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (
      !post ||
      !quote ||
      quote.length > 200 ||
      !post.text.replace(/\s+/g, " ").includes(quote)
    )
      throw new Error(
        "Finding excerpt is absent from the exact source receipt"
      );
    const key = `${fm.platform}:${fm.origin_id}`;
    if (seen.has(key)) throw new Error("Duplicate finding");
    seen.add(key);
  }
  m.evidence_verification = {
    version: 1,
    run_id: runId,
    issues,
    verified_findings: data.findings.length,
  };
  const graph = m.graph_candidates ?? [];
  if (!Array.isArray(graph) || graph.length > 100)
    throw new Error("Graph candidates must be a bounded array");
  const canonicalProfile = (url: string) => {
    const u = new URL(url);
    return `${u.origin.replace("www.", "")}${u.pathname.replace(/\/posts\/?$/, "").replace(/\/$/, "")}`.toLowerCase();
  };
  const graphSeen = new Set<string>();
  for (const g of graph) {
    g.evidence_verified = false;
    if (
      g.workspace !== policy.workspace ||
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
    const candidates: SourcePost[] = (
      await Promise.all(
        g.read_receipts.map((r: Receipt) => read(g.platform, r))
      )
    ).flat();
    const p = candidates.find(
      (p) => p.source_url === g.source_url && p.origin_id === g.origin_id
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
      const quote = String(claim.evidence_quote ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (
        !quote ||
        quote.length > 200 ||
        !p.text.replace(/\s+/g, " ").includes(quote) ||
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
  m.graph_status = graph.length ? "pending_ingestion" : "no_candidates";
  m.evidence_verification.verified_graph_candidates = graph.length;
  // Raw text is read above but is never copied into checkpoints or outputs.
  return data;
}
