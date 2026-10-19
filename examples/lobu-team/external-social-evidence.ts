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
};
export type EvidenceClient = {
  org(workspace: string): Promise<{
    operations: { getRun(id: number): Promise<{ run: any }> };
    query(sql: string): Promise<any[]>;
  }>;
};

export type SourceReader = (
  platform: string,
  receipt: Receipt
) => Promise<SourcePost[]>;
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
export async function verifySocialEvidence(
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
  return data;
}
