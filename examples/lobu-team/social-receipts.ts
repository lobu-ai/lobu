import type {
  Coverage,
  EvidenceClient,
  EvidencePolicy,
  ReadingWindow,
  Receipt,
  SourcePost,
  SourceReader,
} from "./external-social-evidence";

/** Reject malformed retained rows before either counting or matching excerpts.
 * Empty text is valid: the reader returns it for media-only posts. */
function assertSourcePosts(posts: SourcePost[]): SourcePost[] {
  if (
    posts.some(
      (p) =>
        !p ||
        typeof p.text !== "string" ||
        (p.mentioned_profiles !== undefined &&
          (!Array.isArray(p.mentioned_profiles) ||
            p.mentioned_profiles.some((url) => typeof url !== "string"))) ||
        [p.source_url, p.origin_id].some(
          (value) => typeof value !== "string" || !value.trim()
        )
    )
  )
    throw new Error(
      "Malformed source post: expected source URL, identity, text and optional profile list"
    );
  return posts;
}

/** Normalize only the operation shapes accepted by this example. */
function readPostsFromOperation(
  run: any,
  platform: string,
  policy: EvidencePolicy,
  timelineReaderSource: string
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
  receipt: Receipt,
  timelineReaderSource: string
): Promise<SourcePost[]> {
  const c = await client.org(receipt.workspace);
  if (!("run_id" in receipt)) {
    // Stored HN events have no browser-operation run. Keep their exact
    // event version AND stable source identity. Stored text never proves
    // completeness, so every HN receipt stays partial.
    // Ingestion time is not read time: older stored posts may be read again
    // in this window, so event.created_at is not an operation-window boundary.
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
  return readPostsFromOperation(run, platform, policy, timelineReaderSource);
}

/** Cache each authorized receipt once across coverage, findings and candidates. */
export function createSourceReader(
  client: EvidenceClient,
  policy: EvidencePolicy,
  window: ReadingWindow,
  timelineReaderSource: string
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
    // A different stable identity must not borrow an already cached event receipt.
    const key = JSON.stringify([
      platform,
      receipt.workspace,
      "run_id" in receipt ? "run" : "event",
      receiptId,
      "run_id" in receipt ? null : receipt.origin_id,
    ]);
    let result = cache.get(key);
    if (!result) {
      result = loadSourcePosts(
        client,
        policy,
        window,
        platform,
        receipt,
        timelineReaderSource
      ).then(assertSourcePosts);
      cache.set(key, result);
    }
    return result;
  };
}

export async function verifyCoverage(
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
