import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

export const input = {
  type: "object",
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 2000 },
    findings: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        properties: {
          inspection_run_id: { type: "integer", minimum: 1 },
          caption_quote: { type: "string", minLength: 20, maxLength: 240 },
          why_useful: { type: "string", minLength: 1, maxLength: 220 },
          suggested_question: { type: "string", minLength: 1, maxLength: 160 },
        },
        required: [
          "inspection_run_id",
          "caption_quote",
          "why_useful",
          "suggested_question",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "findings"],
  additionalProperties: false,
} as const;

type Finding = {
  inspection_run_id: number;
  caption_quote: string;
  why_useful: string;
  suggested_question: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalized(value: string): string {
  return value
    .replace(/["“”‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export default async function notifyTikTokResearch(
  ctx: ReactionContext,
  client: ReactionClient
): Promise<{ findings: number; notified: number; event_ids: number[] }> {
  const findings = ctx.extracted_data.findings as Finding[];
  if (!Array.isArray(findings) || findings.length > 2) {
    throw new Error("Expected at most two inspected TikTok findings");
  }
  if (!findings.length) return { findings: 0, notified: 0, event_ids: [] };

  const [owner] = await client.query(
    `SELECT created_by FROM automations WHERE id = ${ctx.automation.id}`
  );
  const recipient = record(owner).created_by;
  if (typeof recipient !== "string" || !recipient) {
    throw new Error("TikTok research Automation has no owner");
  }
  const { run: windowRun } = await client.operations.getRun(ctx.window.run_id);
  const started = Date.parse(String(windowRun.created_at));
  const finished = Date.parse(String(windowRun.completed_at));
  if (
    windowRun.automation_id !== ctx.automation.id ||
    windowRun.status !== "completed" ||
    !Number.isFinite(started) ||
    !Number.isFinite(finished) ||
    finished < started
  ) {
    throw new Error("Research window has no completed execution receipt");
  }

  // Validate the entire batch before delivering any finding. The model supplies
  // reasoning, while the persisted read receipt supplies source identity.
  const verified = [];
  for (const finding of findings) {
    if (!Number.isSafeInteger(finding.inspection_run_id)) {
      throw new Error("Finding has no inspection receipt");
    }
    const { run } = await client.operations.getRun(finding.inspection_run_id);
    const inspected = Date.parse(String(run.created_at));
    const inspectedEnd = Date.parse(String(run.completed_at));
    const output = record(run.output);
    const post = record(output.post);
    const url = typeof post.source_url === "string" ? post.source_url : "";
    const identity =
      /^https:\/\/www\.tiktok\.com\/@[^/]+\/(?:video|photo)\/(\d+)$/.exec(url);
    if (
      run.status !== "completed" ||
      run.connector_key !== "tiktok.web" ||
      run.operation_key !== "inspect_post" ||
      !Number.isSafeInteger(run.connection_id) ||
      Number(run.connection_id) <= 0 ||
      run.created_by_user_id !== recipient ||
      // The managed SDK currently omits parent attribution on read operations.
      // Require an owner-issued receipt created AND completed during this run;
      // when explicit provenance exists it must also agree. This proves a fresh
      // source read, not exclusive membership in this agent's execution.
      (run.automation_id != null && run.automation_id !== ctx.automation.id) ||
      (run.parent_run_id != null && run.parent_run_id !== ctx.window.run_id) ||
      !Number.isFinite(inspected) ||
      !Number.isFinite(inspectedEnd) ||
      inspected < started ||
      inspectedEnd < inspected ||
      inspectedEnd > finished ||
      !identity ||
      identity[1] !== post.origin_id ||
      typeof post.text !== "string" ||
      typeof finding.caption_quote !== "string" ||
      normalized(finding.caption_quote).length < 20 ||
      !normalized(post.text).includes(normalized(finding.caption_quote))
    ) {
      throw new Error(
        `Unverified TikTok finding: inspection ${finding.inspection_run_id}`
      );
    }
    verified.push({ finding, post, url, connectionId: run.connection_id });
  }

  let notified = 0;
  const eventIds: number[] = [];
  for (const { finding, post, url, connectionId } of verified) {
    const author = record(post.author);
    const result = await client.notifications.send({
      title: `AI teammate research · ${String(author.name || author.handle || "TikTok").slice(0, 100)}`,
      body: [
        `Caption: “${finding.caption_quote}”`,
        `Why useful: ${finding.why_useful}`,
        `Question to explore: ${finding.suggested_question}`,
        "Caption-grounded lead; video/audio and claimed results are unverified.",
      ].join("\n\n"),
      recipients: [recipient],
      resource_url: url,
      // Source identity survives resyncs, new windows and reaction retries.
      idempotency_key: `tiktok-research:${connectionId}:${post.origin_id}`,
      automation_source: {
        automation_id: ctx.automation.id,
        run_id: ctx.window.run_id,
      },
    });
    notified += result.notified_count;
    if (result.event_id !== null) eventIds.push(result.event_id);
  }
  return { findings: verified.length, notified, event_ids: eventIds };
}
