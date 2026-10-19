import type { EvidencePolicy } from "./external-social-evidence";

/** Notifications do not inherit the external caller's cross-workspace grant.
 * They report preflight status, and never describe unchecked content as verified. */
export async function deliverExternalSocial(
  ctx: any,
  client: any,
  policy: EvidencePolicy
) {
  const d = ctx.extracted_data;
  if (
    !Array.isArray(d.briefings) ||
    d.briefings.length !== 1 ||
    !Array.isArray(d.findings)
  )
    throw new Error("Expected one briefing and findings array");
  const b = d.briefings[0];
  const m = b.metadata;
  if (m?.workflow !== policy.workflow || m.run_id !== ctx.window.run_id)
    throw new Error("Briefing ownership/run mismatch");
  const coverage = m.coverage;
  if (
    !Array.isArray(coverage) ||
    coverage.length !== policy.platforms.length ||
    new Set(coverage.map((c: any) => c.platform)).size !==
      policy.platforms.length ||
    coverage.some((c: any) => !policy.platforms.includes(c.platform))
  )
    throw new Error("Invalid platform coverage");
  const preflight = m.evidence_verification;
  const verified =
    preflight?.version === 1 &&
    preflight.run_id === m.run_id &&
    preflight.verified_findings === d.findings.length &&
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
    d.findings.every(
      (f: any) =>
        f.metadata?.workflow === policy.workflow &&
        policy.platforms.includes(f.metadata.platform) &&
        f.metadata.source_url === f.source_url &&
        f.metadata.review_status === "pending" &&
        Array.isArray(f.metadata.read_receipts) &&
        f.metadata.read_receipts.length > 0
    );
  const [owner] = await client.query(
    `SELECT created_by FROM automations WHERE id = ${Number(ctx.automation.id)}`
  );
  if (!owner?.created_by) throw new Error("Automation owner unavailable");
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
    recipients: [owner.created_by],
    resource_url: `/${policy.workspace}/automations/${ctx.automation.id}`,
    idempotency_key: `social-briefing:${ctx.automation.id}:${ctx.window.run_id}`,
    automation_source: {
      automation_id: Number(ctx.automation.id),
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
  return `${deliverExternalSocial.toString()}\nexport default async (ctx, client) => deliverExternalSocial(ctx, client, ${JSON.stringify(policy)});`;
}
