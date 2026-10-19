import {
  verifySocialEvidence,
  type EvidencePolicy,
} from "./external-social-evidence";
import { readSocialTimelinePage } from "./social-timeline-reader";

const marker = "\n\nEXTERNAL SOCIAL EVIDENCE CONTRACT v1\n";

/** Extend the current version, retaining account bindings, owner policy and
 * voice preferences. Never reapply an older managed-agent example wholesale. */
export function externalSocialPrompt(current: string, policy: EvidencePolicy) {
  const base = current.split(marker)[0];
  return `${base}${marker}
This contract refines reading and completion. Existing account/privacy/no-engagement limits remain authoritative.

EXTERNAL HANDOFF
At each host check-in select EACH authorized workspace and call operations.listActivity({kinds:["automation_due"]}). Do not only inspect the currently selected workspace. Process one claimed window at a time; honor another caller's lease. A due schedule is not a worker wakeup. Do not silently switch to a hosted agent or change schedules. Poll every minute while your host is awake. Report last check-in and unfinished claims in your host's own status.

READ COMPLETE BODIES; STORE SHORT DISTILLATIONS
Do not use slice/substring or character limits on source text BEFORE the model has read it. Chunk the returned post ARRAY into small pages (5-10 posts per tool result), not the post bodies. If tool output is truncated, fetch smaller pages before counting those posts as read. Expand visible Show more text within the owned scratch tab and inspect the result. Unexpanded text, missing authors, undated records, unread media and inaccessible threads remain explicit limitations. Keep checkpoints and final outputs short as already required; this restriction never permits reading only a fixed-length prefix of a body.
Use this snapshot function inside Chrome evaluate for X or company LinkedIn, with page_path/account_path/company_name from the existing bindings. It intentionally returns whole body fields and verifies visibility on EVERY page. Do not replace it with cached body snippets:
\`\`\`typescript
${readSocialTimelinePage.toString()}
\`\`\`
Keep each evaluate run_id and its workspace alongside the returned posts. Native TikTok inspect_post receipts verify the full caption and author but remain partial for video/audio; sampled frames are not full-media understanding. Native LinkedIn read_home_feed receipts are accepted only without a company Page binding, and remain partial because their completeness and dates are not proved. HN stored-event receipts use {workspace,event_id,origin_id}. Other browser sources must return the same envelope {platform,identity_verified,visibility,posts:[{source_url,origin_id,text,author,author_url,occurred_at,truncated,media_unread}]} only after verifying the existing allowed account in that same scratch tab. Never fabricate envelope fields or timestamps. Feed readMany rows are transient: a successful feed operation with output:null is NOT a retained text receipt. Read the exact candidate in a receipt-producing browser operation before creating a finding from it.

CONTINUATION AND RECOVERY
Thirty/fifty posts are sampling guidance, never a reason to claim all history. Continue accessible NEW posts within the existing source/time budgets. Save source-scoped stable origin IDs and real opaque cursors, or the last canonical browser anchor, in each platform checkpoint. Keep pending anchors/cursors separate from the latest seen head. On resume start from that source's checkpoint, overlap/deduplicate by workspace+connection+origin_id, and disclose when a browser anchor cannot be restored. Stop after four genuine no-growth passes at the bottom or the budget; record stop_reason and continuation_pending. A stalled feed is partial, not exhausted. Do not keep retrying a closed/detached tab: reconcile once, create one fresh owned scratch tab if allowed, then mark that source blocked on recurrence. Serialize every operation sharing a browser, including TikTok and X; close scratch tabs in finally.

UNDERSTANDING AND GRAPH CANDIDATES
Read and classify every returned post, not only the six digest selections. For relevant people/companies/products retain a short attributed observation: exact author/profile identifier, source post, observed time, claimed relationship, evidence excerpt <=200 characters, confidence and unresolved ambiguity. An author reposting a company is not proof they work there. Same-name or shared-domain matches are review candidates, never automatic identity merges. Inspect at most two candidate profiles/contexts per platform within EXISTING source authorization; company LinkedIn's company-page-only grant does not authorize personal profile reads.
Store short graph candidates in platform checkpoints and submit them in briefing.metadata.graph_candidates (at most 100), independently of the digest quota. Each candidate is {workspace,connection:<discovered source connection slug>,platform,origin_id,source_url,observed_at,source_time,summary:<own words, <=280 chars>,evidence_verified:false,read_receipts,subject:{kind:"person"|"organization"|"product",label,profile_url},claims:[{predicate:"employment"|"founder"|"announced_integration"|"mentioned"|"product_of",target:{kind,label,profile_url},evidence_quote}]}. The subject must be the observed author profile, not a guessed real person. A relationship target must have an actual profile link in the source body; omit unsupported relations and retain the plain observation. Preflight verifies source text and author/target links and marks accepted candidates evidence_verified:true. Matching a quote proves its attribution, not the truth of its claim. Never write graph entities or relationships yourself; the bounded handoff is reviewed separately and must preserve owner restrictions and unresolved identity rather than merging names. Until a graph write and exact readback receipt exist, report graph_status:"pending_ingestion", never "populated". Keep source access restricted unless public evidence and publication permission are independently established; do not move personal content to a company/public workspace.

MANDATORY COMPLETION PREFLIGHT
Briefing run_id must be the numeric claimed runId, not a string. Coverage status describes reading completeness; older dated posts reduce recent_posts_read without making an otherwise complete read partial. Every read_receipts entry names its workspace: {workspace,run_id}, or for HN {workspace,event_id,origin_id}. Never use [] for a claimed read. Coverage additionally records continuation_pending:boolean and stop_reason. Run the function below with the claimed runId and your proposed extracted_data BEFORE completeWindow, in the same authorized external caller that can read the allowed workspaces. Inspect its returned coverage and issues; only submit its RETURNED data. It computes counts from completed source receipts, rejects unsupported finding excerpts and marks truncated/unread/stalled sources partial. Fix invalid findings by rereading the exact source or removing the unsupported claim; never invent a receipt to pass validation. It does not inspect video audio, prove model comprehension, or grant graph publication permission.
\`\`\`typescript
${verifySocialEvidence.toString()}
const evidencePolicy = ${JSON.stringify(policy)};
// const verified = await verifySocialEvidence(client, evidencePolicy, runId, extracted_data);
// await workspace.automations.completeWindow({...originalCompletionArgs, extracted_data: verified});
\`\`\`
After completion inspect its reaction result as well as the run. Persisted output, verified findings, notification delivery and Market ingestion are separate outcomes. If source receipts cannot be read, retain the honest blocked/partial briefing and report the verification failure.
`;
}
