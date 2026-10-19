import {
  automationOwner,
  assertBriefingEnvelope,
  findingHasReceipt,
  type EvidencePolicy,
} from "./external-social-evidence";

/** Notifications do not inherit the external caller's cross-workspace grant.
 * They report preflight status, and never describe unchecked content as verified. */
export async function deliverExternalSocial(
  ctx: any,
  client: any,
  policy: EvidencePolicy
) {
  const d = ctx.extracted_data;
  const m = assertBriefingEnvelope(d, policy, ctx.window.run_id);
  const { automationId, ownerId } = await automationOwner(
    client,
    ctx.automation?.id
  );
  const b = d.briefings[0];
  const coverage = m.coverage;
  const preflight = m.evidence_verification;
  // This is the external caller's attestation, not a server-side receipt check.
  const verified =
    preflight?.version === 1 &&
    preflight.run_id === m.run_id &&
    preflight.verified_findings === d.findings.length &&
    Array.isArray(m.graph_candidates ?? []) &&
    preflight.verified_graph_candidates === (m.graph_candidates ?? []).length &&
    d.findings.length <= 6 &&
    Array.isArray(preflight.issues) &&
    coverage.every(
      (c: any) =>
        Number.isSafeInteger(c.posts_read) &&
        c.posts_read >= 0 &&
        Number.isSafeInteger(c.recent_posts_read) &&
        c.recent_posts_read >= 0 &&
        c.recent_posts_read <= c.posts_read &&
        ["read", "partial", "blocked"].includes(c.status) &&
        Array.isArray(c.read_receipts) &&
        (c.posts_read === 0 || c.read_receipts.length > 0)
    ) &&
    d.findings.every((f: any) => findingHasReceipt(f, policy));
  const summary = verified
    ? coverage
        .map(
          (c: any) => `${c.platform}: ${c.posts_read} text posts, ${c.status}`
        )
        .join("; ")
    : "Source verification missing. This completed window is not a verified scan; findings require reprocessing.";
  // The notification validator counts UTF-16 units; never end on a split
  // surrogate pair.
  let body = (
    summary + (verified ? `\n\n${String(b.content || "")}` : "")
  ).slice(0, 980);
  const last = body.charCodeAt(body.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) body = body.slice(0, -1);
  const sent = await client.notifications.send({
    title: verified
      ? "Social research briefing"
      : "Social research needs evidence",
    body,
    recipients: [ownerId],
    resource_url: `/${policy.workspace}/automations/${automationId}`,
    idempotency_key: `social-briefing:${automationId}:${ctx.window.run_id}`,
    automation_source: {
      automation_id: automationId,
      run_id: Number(ctx.window.run_id),
    },
  });
  return {
    evidence_verified: verified,
    verified_findings: verified ? d.findings.length : 0,
    notification_id: sent.event_id,
  };
}

export function externalSocialReaction(policy: EvidencePolicy) {
  return `${automationOwner.toString()}\n${assertBriefingEnvelope.toString()}\n${findingHasReceipt.toString()}\n${deliverExternalSocial.toString()}\nexport default async (ctx, client) => deliverExternalSocial(ctx, client, ${JSON.stringify(policy)});`;
}
