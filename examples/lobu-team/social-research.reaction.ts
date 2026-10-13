import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

export const input = {
  type: "object",
  required: ["summary", "coverage", "findings"],
  properties: {
    summary: { type: "string", maxLength: 1600 },
    coverage: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        required: ["platform", "status", "posts_read", "detail"],
        properties: {
          platform: { enum: ["linkedin", "x", "tiktok"] },
          status: { enum: ["read", "blocked", "partial"] },
          posts_read: { type: "integer", minimum: 0 },
          detail: { type: "string", maxLength: 600 },
        },
        additionalProperties: false,
      },
    },
    findings: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        required: [
          "platform",
          "source_url",
          "read_run_id",
          "quote",
          "summary",
          "why",
          "limits",
          "draft",
        ],
        properties: {
          platform: { enum: ["linkedin", "x", "tiktok"] },
          source_url: { type: "string", format: "uri" },
          read_run_id: { type: "integer", minimum: 1 },
          like_run_id: { type: "integer", minimum: 1 },
          quote: { type: "string", minLength: 20, maxLength: 100 },
          summary: { type: "string", minLength: 1, maxLength: 120 },
          why: { type: "string", minLength: 1, maxLength: 120 },
          limits: { type: "string", minLength: 1, maxLength: 120 },
          draft: { type: "string", maxLength: 350 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

type Platform = "linkedin" | "x" | "tiktok";
type Finding = {
  platform: Platform;
  source_url: string;
  read_run_id: number;
  like_run_id?: number;
  quote: string;
  summary: string;
  why: string;
  limits: string;
  draft: string;
};
const bindings = {
  linkedin: {
    connector: "linkedin",
    read: "linkedin-research",
    draft: "linkedin-drafts",
    readAction: "read_home_feed",
  },
  x: {
    connector: "chrome",
    read: "lobu-company-x-browser",
    draft: null,
    readAction: "evaluate",
  },
  tiktok: {
    connector: "tiktok.web",
    read: "tiktok-lobuteam",
    draft: "tiktok-drafts",
    readAction: "inspect_post",
  },
} as const;
const canonical = (value: string) => value.replace(/\/$/, "");
const permalinks = {
  linkedin:
    /^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:(?:activity|ugcPost|share):\d+$/,
  x: /^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+$/,
  tiktok: /^https:\/\/www\.tiktok\.com\/@[A-Za-z0-9_.]+\/(?:video|photo)\/\d+$/,
} as const;
const quoteText = (value: string) =>
  value
    .replace(/["“”‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;
const record = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};

// Notification limits count UTF-16 units; preserve whole surrogate pairs.
function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let end = Math.max(0, limit - 1);
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${value.slice(0, end)}…`;
}

function sourceRows(platform: Platform, output: Record<string, any>) {
  if (platform === "linkedin")
    return Array.isArray(output.items)
      ? output.items.filter((r: any) => r.type === "post")
      : [];
  if (platform === "tiktok") return [record(output.post)];
  const value = record(output.value);
  return Array.isArray(value.posts) ? value.posts : [];
}

export default async function deliverSocialResearch(
  ctx: ReactionContext,
  client: ReactionClient
) {
  const findings = ctx.extracted_data.findings as Finding[];
  const coverage = ctx.extracted_data.coverage as Array<{
    platform: Platform;
    status: string;
    posts_read: number;
    detail: string;
  }>;
  // The input schema fixes three entries but cannot require distinct platforms.
  if (new Set(coverage.map((c) => c.platform)).size !== 3)
    throw new Error(
      "Coverage must include each of LinkedIn, X and TikTok once"
    );
  const [owner] = await client.query(
    `SELECT created_by FROM automations WHERE id = ${ctx.automation.id}`
  );
  const recipient = record(owner).created_by;
  if (typeof recipient !== "string" || !recipient)
    throw new Error("Automation owner is unavailable");
  const { run: window } = await client.operations.getRun(ctx.window.run_id);
  const start = Date.parse(String(window.created_at));
  const end = Date.parse(String(window.completed_at));
  if (
    window.status !== "completed" ||
    window.automation_id !== ctx.automation.id ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start
  )
    throw new Error("Automation has no completed run receipt");
  type Operation = {
    operation_key: string;
    execution_targets: Array<{
      connection_id: number;
      slug: string;
      executable: boolean;
    }>;
  };
  // Background reactions have no user identity. Operation discovery resolves
  // the Automation owner's access, including private paired browser profiles.
  const available = new Map<Platform, Operation[]>();
  for (const platform of new Set(findings.map((f) => f.platform))) {
    const { operations } = (await client.operations.listAvailable({
      connector_key: bindings[platform].connector,
      limit: 100,
      include_input_schema: false,
    })) as { operations: Operation[] };
    available.set(platform, operations);
  }
  const seen = new Set<string>();
  const validated = [];
  // Validate the whole batch before queueing a draft or notifying anyone.
  for (const finding of findings) {
    const binding = bindings[finding.platform];
    const connection = available
      .get(finding.platform)
      ?.find((o) => o.operation_key === binding.readAction)
      ?.execution_targets.find((t) => t.slug === binding.read);
    if (!connection) throw new Error("Missing source connection or receipt");
    const { run } = await client.operations.getRun(finding.read_run_id);
    const created = Date.parse(String(run.created_at));
    const completed = Date.parse(String(run.completed_at));
    if (
      run.status !== "completed" ||
      run.connection_id !== connection.connection_id ||
      run.operation_key !== binding.readAction ||
      run.created_by_user_id !== recipient ||
      !Number.isFinite(created) ||
      !Number.isFinite(completed) ||
      created < start ||
      completed < created ||
      completed > end
    )
      throw new Error("Source receipt does not belong to this research window");
    const url = canonical(finding.source_url);
    if (!permalinks[finding.platform].test(url))
      throw new Error("Invalid source permalink");
    const row = sourceRows(finding.platform, record(run.output)).find(
      (r: any) => canonical(String(r.source_url ?? r.url ?? "")) === url
    );
    if (
      !row ||
      typeof row.text !== "string" ||
      quoteText(finding.quote).length < 20 ||
      !quoteText(row.text).includes(quoteText(finding.quote))
    )
      throw new Error("Finding quote is absent from its exact source receipt");
    const key = `social-research:${finding.platform}:${connection.connection_id}:${url}`;
    if (seen.has(key)) throw new Error("Duplicate source in findings");
    seen.add(key);
    let liked = false;
    if (finding.like_run_id) {
      if (finding.platform === "x")
        throw new Error("Automated X likes are not part of this workflow");
      const { run: like } = await client.operations.getRun(finding.like_run_id);
      const effect = record(like.output);
      const likedAt = Date.parse(String(like.created_at));
      const likedEnd = Date.parse(String(like.completed_at));
      if (
        like.status !== "completed" ||
        like.connection_id !== connection.connection_id ||
        like.operation_key !== "set_like" ||
        like.created_by_user_id !== recipient ||
        canonical(String(effect.post_url ?? "")) !== url ||
        effect.liked !== true ||
        !Number.isFinite(likedAt) ||
        !Number.isFinite(likedEnd) ||
        likedAt < start ||
        likedEnd < likedAt ||
        likedEnd > end
      )
        throw new Error("Like lacks a matching completed receipt");
      liked = true;
    }
    validated.push({ finding, key, url, liked, binding });
  }
  const source = {
    automation_id: ctx.automation.id,
    run_id: ctx.window.run_id,
  };
  const results = [];
  for (const { finding, key, url, liked, binding } of validated) {
    const previous = await client.query(
      `SELECT id FROM events WHERE metadata ? '_lobu_idempotency_key' AND metadata->>'_lobu_idempotency_key' = ${sqlString(key)} LIMIT 1`
    );
    if (previous.length) {
      results.push({ source_url: url, status: "already_delivered" });
      continue;
    }
    const draftConnection = available
      .get(finding.platform)
      ?.find((o) => o.operation_key === "prepare_comment")
      ?.execution_targets.find((t) => t.slug === binding.draft && t.executable);
    const pageUrl = finding.platform === "linkedin" ? `${url}/` : url;
    let draftRun: number | undefined;
    let draftStatus = finding.draft
      ? "Draft saved; browser handoff needs setup"
      : "No comment suggested";
    // TikTok's prepare_comment does not support photo posts.
    const photo = finding.platform === "tiktok" && url.includes("/photo/");
    if (finding.platform === "x" && finding.draft)
      draftStatus = "Draft saved for manual use on X";
    if (photo && finding.draft)
      draftStatus = "Draft saved for manual use on this TikTok photo post";
    if (finding.draft && draftConnection && !photo) {
      const staged = await client.operations.execute({
        connection_id: draftConnection.connection_id,
        operation_key: "prepare_comment",
        input: {
          post_url: pageUrl,
          body: finding.draft,
          ...(finding.platform === "linkedin" ? { reason: finding.why } : {}),
        },
        activation: { kind: "page_visit", urls: [pageUrl] },
        idempotency_key: `${key}:draft:${ctx.window.run_id}`,
        automation_source: source,
      });
      if (
        staged.status === "in_progress" &&
        typeof staged.run_id === "number"
      ) {
        draftRun = staged.run_id;
        draftStatus =
          "Use Open page to fill the draft in your connected browser; you click Post";
      } else draftStatus = `Draft operation: ${staged.status}`;
    }
    const draftBlock = finding.draft
      ? `Suggested comment:\n${finding.draft}`
      : "";
    const likeStatus = liked
      ? "Liked — verified."
      : "No automated like recorded.";
    // Keep the complete proposed draft; share the remaining space across context.
    const contextBudget = Math.floor(
      (1000 - draftBlock.length - likeStatus.length - draftStatus.length - 60) /
        3
    );
    const sent = await client.notifications.send({
      title: clip(`${finding.platform} · ${finding.summary}`, 180),
      body: [
        `Why it matters: ${clip(finding.why, contextBudget)}`,
        `Evidence: “${clip(finding.quote, contextBudget)}”`,
        `Context: ${clip(finding.limits, contextBudget)}`,
        likeStatus,
        draftBlock,
        draftStatus,
      ]
        .filter(Boolean)
        .join("\n\n"),
      recipients: [recipient],
      resource_url: url,
      ...(draftRun
        ? { browser_url: pageUrl, browser_handoff_run_id: draftRun }
        : {}),
      idempotency_key: key,
      automation_source: source,
    });
    results.push({
      source_url: url,
      notification_id: sent.event_id,
      draft_run_id: draftRun ?? null,
      draft_status: draftStatus,
    });
  }
  for (const blocked of coverage.filter((c) => c.status === "blocked")) {
    await client.notifications.send({
      title: `Social research could not read · ${blocked.platform}`,
      body: clip(blocked.detail, 1000),
      recipients: [recipient],
      idempotency_key: `social-research:setup:${ctx.automation.id}:${blocked.platform}:${new Date(start).toISOString().slice(0, 10)}`,
      automation_source: source,
    });
  }
  // Empty and blocked runs remain auditable; do not disguise unread sources as no findings.
  return { coverage, findings: results };
}
