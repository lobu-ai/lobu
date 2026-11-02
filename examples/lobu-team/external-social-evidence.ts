import { createSourceReader, verifyCoverage } from "./social-receipts";
import { verifyFindings, verifyGraphCandidates } from "./social-observations";

/** Tenant-owned external processing contract. No platform or storage changes. */
export type Receipt =
  | { workspace: string; run_id: number }
  | { workspace: string; event_id: number; origin_id: string };
export type SourcePost = {
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
export type Coverage = {
  platform: string;
  status: "read" | "partial" | "blocked";
  posts_read: number;
  recent_posts_read: number;
  read_receipts: Receipt[];
  detail: string;
  continuation_pending?: boolean;
  stop_reason?: string;
};
export type Draft = {
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
  stored_sources?: Record<
    string,
    {
      connection_id: number;
      connector_key: string;
      semantic_types: string[];
    }
  >;
  personal_retention?: {
    workspace: string;
    sources: Record<
      string,
      Array<{
        connection_id: number;
        connector_key: string;
        device_worker_id?: string;
        allow_missing_device_receipt?: boolean;
      }>
    >;
  };
};
export type EvidenceClient = {
  org(workspace: string): Promise<{
    operations: { getRun(id: number): Promise<{ run: any }> };
    query(sql: string): Promise<any[]>;
  }>;
};

export type SourcePage = {
  posts: SourcePost[];
  limitations: string[];
};
export type SourceReader = (
  platform: string,
  receipt: Receipt
) => Promise<SourcePage>;
export type ReadingWindow = { ownerId: string; start: number; end: number };

/** The preflight and notification resolve the same validated Automation owner. */
export async function automationOwner(
  client: { query(sql: string): Promise<any[]> },
  input: unknown
) {
  const automationId = Number(input);
  if (!Number.isSafeInteger(automationId) || automationId <= 0)
    throw new Error("Missing Automation identity");
  const [owner] = await client.query(
    `SELECT created_by FROM automations WHERE id = ${automationId}`
  );
  if (!owner?.created_by) throw new Error("Automation owner unavailable");
  return { automationId, ownerId: owner.created_by };
}

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

/** Shared snapshot of notification coverage and result identities. Arrays keep
 * the comparison stable across JSON storage; this is still caller attestation. */
export function socialEvidenceShape(data: SocialData) {
  const m = data.briefings[0]!.metadata;
  return JSON.stringify([
    (m.coverage as Coverage[]).map((c) => [
      c.platform,
      c.status,
      c.posts_read,
      c.recent_posts_read,
      Array.isArray(c.read_receipts) ? c.read_receipts.length : -1,
    ]),
    data.findings.map((f) => [f?.metadata?.platform, f?.metadata?.origin_id]),
    Array.isArray(m.graph_candidates ?? [])
      ? (m.graph_candidates ?? []).map((g: any) => [
          g?.platform,
          g?.origin_id,
          g?.evidence_verified,
        ])
      : null,
  ]);
}

/** Verify a claimed or completed window using its owner's retained source receipts. */
async function verifyEvidenceAndSources(
  timelineReaderSource: string,
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
  const { ownerId } = await automationOwner(workspace, parent.automation_id);
  const read = createSourceReader(
    client,
    policy,
    {
      ownerId,
      start,
      end,
    },
    timelineReaderSource
  );
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
    version: 2,
    run_id: runId,
    attested: socialEvidenceShape(data),
    issues,
    verified_findings: data.findings.length,
    verified_graph_candidates: graphCount,
  };
  // Raw source text stays in receipts, never in checkpoints or outputs.
  return { data, read, workspace };
}

export async function verifySocialEvidence(
  timelineReaderSource: string,
  client: EvidenceClient,
  policy: EvidencePolicy,
  runId: number,
  data: SocialData
) {
  return (
    await verifyEvidenceAndSources(
      timelineReaderSource,
      client,
      policy,
      runId,
      data
    )
  ).data;
}

/** Owner-config opt-in. This reads retained evidence only; the trusted host
 * separately authorizes, saves and reads back personal source-owner archives.
 * It neither grants retention permission nor journals live provider reads. */
export async function verifySocialEvidenceForRetention(
  timelineReaderSource: string,
  client: EvidenceClient,
  policy: EvidencePolicy,
  runId: number,
  data: SocialData
) {
  const retention = policy.personal_retention;
  if (
    !retention ||
    retention.workspace !== policy.workspace ||
    policy.company_linkedin_path ||
    // This personal policy excludes TikTok; company retention has no approval.
    policy.platforms.includes("tiktok") ||
    policy.platforms.some(
      (platform) =>
        !retention.sources[platform]?.length ||
        policy.receipt_workspaces[platform]?.some(
          (workspace) => workspace !== policy.workspace
        )
    )
  )
    throw new Error("Personal source-owner retention is not configured");
  const envelope = assertBriefingEnvelope(data, policy, runId);
  const receiptSets = new Map<string, Map<string, Receipt>>();
  for (const platform of policy.platforms) {
    const references = [
      ...(envelope.coverage as Coverage[]).filter(
        (row) => row.platform === platform
      ),
      ...data.findings
        .filter((row) => row.metadata.platform === platform)
        .map((row) => row.metadata),
      ...(envelope.graph_candidates ?? []).filter(
        (row: any) => row.platform === platform
      ),
    ].flatMap((row) => row.read_receipts ?? []);
    const receipts = new Map<string, Receipt>();
    for (const receipt of references) {
      if (receipt.workspace !== policy.workspace)
        throw new Error("Foreign retention source");
      const key = JSON.stringify([
        receipt.workspace,
        "run_id" in receipt ? "run" : "event",
        "run_id" in receipt ? receipt.run_id : receipt.event_id,
        "run_id" in receipt ? null : receipt.origin_id,
      ]);
      receipts.set(key, receipt);
    }
    if (receipts.size > 32) throw new Error("Retention receipt bound exceeded");
    receiptSets.set(platform, receipts);
  }
  const {
    data: verified,
    read,
    workspace,
  } = await verifyEvidenceAndSources(
    timelineReaderSource,
    client,
    policy,
    runId,
    data
  );
  const metadata = verified.briefings[0]!.metadata;
  const sourcePages: Array<
    SourcePage & {
      platform: string;
      receipt: Receipt;
      connection_id: number;
      connector_key: string;
      device_attestation: "recorded" | "unavailable";
    }
  > = [];
  for (const platform of policy.platforms) {
    // The verifier keeps failed reads as coverage diagnostics. They cannot
    // supply findings/candidates, so do not turn an honest blocked source
    // into an archive requirement that prevents other sources completing.
    const coverage = (metadata.coverage as Coverage[]).find(
      (row) => row.platform === platform
    );
    if (coverage?.status === "blocked") continue;
    for (const receipt of receiptSets.get(platform)!.values()) {
      let page: SourcePage;
      try {
        page = await read(platform, receipt);
      } catch {
        // Failed coverage-only reads already appear in verifier diagnostics.
        // Finding/candidate receipt failures cannot reach here: they are fatal
        // in the baseline verifier. Binding/device checks below stay fatal.
        continue;
      }
      const source =
        "run_id" in receipt
          ? (await workspace.operations.getRun(receipt.run_id)).run
          : (
              await workspace.query(
                `SELECT id, connection_id, connector_key FROM events WHERE id = ${receipt.event_id} LIMIT 1`
              )
            )[0];
      const binding = retention.sources[platform]!.find(
        (candidate) =>
          candidate.connection_id === source?.connection_id &&
          candidate.connector_key === source?.connector_key
      );
      if (!binding) throw new Error("Retention source binding mismatch");
      const devices = [
        source.target_device_worker_id,
        source.executed_by_device_worker_id,
        source.device_worker_id,
      ].filter(Boolean);
      if (
        binding.device_worker_id &&
        (devices.some((id) => id !== binding.device_worker_id) ||
          (!devices.length && !binding.allow_missing_device_receipt))
      )
        throw new Error("Retention source device mismatch");
      sourcePages.push({
        platform,
        receipt,
        connection_id: source.connection_id,
        connector_key: source.connector_key,
        device_attestation: devices.length ? "recorded" : "unavailable",
        posts: page.posts.map((post) => ({
          source_url: post.source_url,
          origin_id: post.origin_id,
          text: post.text,
          author: typeof post.author === "string" ? post.author : "",
          ...(typeof post.author_url === "string"
            ? { author_url: post.author_url }
            : {}),
          ...(post.mentioned_profiles
            ? { mentioned_profiles: [...post.mentioned_profiles] }
            : {}),
          occurred_at:
            typeof post.occurred_at === "string" ? post.occurred_at : null,
          truncated: post.truncated !== false,
          media_unread: post.media_unread !== false,
        })),
        limitations: page.limitations,
      });
    }
  }
  return { verified, source_pages: sourcePages };
}
