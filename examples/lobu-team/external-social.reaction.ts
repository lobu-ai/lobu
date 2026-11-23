import { findingHasReceipt } from "./social-observations";
import {
  automationOwner,
  assertBriefingEnvelope,
  socialEvidenceShape,
  type EvidencePolicy,
} from "./external-social-evidence";

const PLATFORM_NAMES: Record<string, string> = {
  reddit: "Reddit",
  linkedin: "LinkedIn",
  x: "X",
  hackernews: "Hacker News",
};
const platformName = (p: string) => PLATFORM_NAMES[p] ?? p;
// The notification validator counts UTF-16 units; never end on a split
// surrogate pair.
function cut(text: string, units: number) {
  const out = text.slice(0, units);
  const last = out.charCodeAt(out.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? out.slice(0, -1) : out;
}

/** The processor posts each reply-worthy item itself while it holds the
 * window, so a clean run sends nothing here. This reaction speaks only when the
 * owner has something to act on: an unread source or an unverified scan.
 * Notifications do not inherit the external caller's cross-workspace grant,
 * and never describe unchecked content as verified. */
export async function deliverExternalSocial(
  ctx: any,
  client: any,
  policy: EvidencePolicy
) {
  const d = ctx.extracted_data;
  let m: ReturnType<typeof assertBriefingEnvelope>;
  try {
    m = assertBriefingEnvelope(d, policy, ctx.window.run_id);
  } catch (error) {
    // The completed output is stored; a retry would reject it again.
    return ctx.fail(error instanceof Error ? error.message : String(error));
  }
  const { automationId, ownerId } = await automationOwner(
    client,
    ctx.automation?.id
  );
  const coverage = m.coverage;
  const preflight = m.evidence_verification;
  // This is the external caller's attestation, not a server-side receipt check.
  const verified =
    preflight?.version === 2 &&
    preflight.run_id === m.run_id &&
    Array.isArray(preflight.issues) &&
    preflight.attested === socialEvidenceShape(d) &&
    d.findings.every((f: any) => findingHasReceipt(f, policy));
  // A source counts as unread when it was blocked, or when its read was partial
  // and yielded no post at all (every card skipped): nothing from it was checked.
  const blocked = coverage.filter(
    (c: any) =>
      c.status === "blocked" ||
      (c.status === "partial" && Number(c.posts_read) === 0)
  );
  const result = {
    evidence_verified: verified,
    verified_findings: verified ? d.findings.length : 0,
    notification_id: null as number | null,
  };
  if (verified && blocked.length === 0) return result;

  const names = (list: any[]) =>
    list.map((c: any) => platformName(c.platform)).join(", ");
  const title = verified
    ? `Couldn't read ${names(blocked)} today`
    : "Check today's social suggestions before using them";
  const body = verified
    ? [
        `Today's social scan couldn't read ${names(blocked)}, so nothing from ${blocked.length === 1 ? "it" : "them"} was checked.`,
        ...blocked
          .filter((c: any) => String(c.detail ?? "").trim())
          .map(
            (c: any) =>
              `${platformName(c.platform)}: ${cut(String(c.detail).trim(), 200)}`
          ),
        "The other sources were read; anything worth replying to was posted separately.",
      ].join("\n")
    : `Today's scan of ${names(coverage)} finished without checking its findings against the posts they quote. Double-check any reply suggestion from this run against the original post before using it.`;
  const sent = await client.notifications.send({
    title,
    body: cut(body, 980),
    recipients: [ownerId],
    resource_url: `/${policy.workspace}/automations/${automationId}`,
    idempotency_key: `social-briefing:${automationId}:${ctx.window.run_id}`,
    automation_source: {
      automation_id: automationId,
      run_id: Number(ctx.window.run_id),
    },
  });
  return { ...result, notification_id: sent.event_id };
}
