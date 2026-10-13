import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import type { ClientSDK } from "../../packages/server/src/sandbox/client-sdk";

export const input = {
  type: "object",
  required: [
    "summary",
    "coverage",
    "findings",
    "inbox_findings",
    "inbox_coverage",
  ],
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
    inbox_coverage: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        required: ["source", "status", "items_read", "detail"],
        properties: {
          source: {
            enum: [
              "linkedin:live_messages",
              "linkedin:notifications",
              "tiktok:messages",
              "tiktok:activity",
            ],
          },
          status: { enum: ["read", "partial", "blocked"] },
          items_read: { type: "integer", minimum: 0 },
          detail: { type: "string", maxLength: 600 },
        },
        additionalProperties: false,
      },
    },
    inbox_findings: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        required: [
          "platform",
          "feed_key",
          "source_id",
          "source_revision",
          "quote",
          "summary",
          "why",
          "limits",
          "draft",
        ],
        properties: {
          platform: { enum: ["linkedin", "tiktok"] },
          feed_key: {
            enum: ["live_messages", "notifications", "messages", "activity"],
          },
          source_id: { type: "string", minLength: 1, maxLength: 500 },
          source_revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
          source_cursor: { type: "string", maxLength: 100000 },
          quote: { type: "string", minLength: 1, maxLength: 100 },
          summary: { type: "string", minLength: 1, maxLength: 120 },
          why: { type: "string", minLength: 1, maxLength: 120 },
          limits: { type: "string", minLength: 1, maxLength: 120 },
          draft: { type: "string", maxLength: 350 },
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
type InboxFinding = {
  platform: "linkedin" | "tiktok";
  feed_key: string;
  source_id: string;
  source_revision: string;
  source_cursor?: string;
  quote: string;
  summary: string;
  why: string;
  limits: string;
  draft: string;
};
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
  // The executor supplies the existing full ClientSDK; feeds is not exposed in
  // the narrower legacy ReactionClient convenience type. No runtime extension.
  client: ReactionClient & Pick<ClientSDK, "feeds">
) {
  const findings = ctx.extracted_data.findings as Finding[];
  const inbox = (ctx.extracted_data.inbox_findings ?? []) as InboxFinding[];
  const inboxCoverage = (ctx.extracted_data.inbox_coverage ?? []) as Array<{
    source: string;
    status: string;
    items_read: number;
    detail: string;
  }>;
  if (
    inbox.length > 2 ||
    (inboxCoverage.length &&
      (inboxCoverage.length !== 4 ||
        new Set(inboxCoverage.map((c) => c.source)).size !== 4))
  )
    throw new Error("Invalid inbox coverage or finding count");
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
  for (const platform of new Set(
    [...findings, ...inbox].map((f) => f.platform)
  )) {
    try {
      const { operations } = (await client.operations.listAvailable({
        connector_key: bindings[platform].connector,
        limit: 100,
        include_input_schema: false,
      })) as { operations: Operation[] };
      available.set(platform, operations);
    } catch (error) {
      if (findings.some((finding) => finding.platform === platform))
        throw error;
      // Inbox verification reports the unavailable source independently below.
    }
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
  const inboxResults: Array<Record<string, unknown>> = [];
  const verificationIssues = new Set<string>();
  const partialInbox = (finding: InboxFinding, detail: string) => {
    const source = `${finding.platform}:${finding.feed_key}`;
    verificationIssues.add(source);
    const coverage = inboxCoverage.find((c) => c.source === source);
    if (coverage) Object.assign(coverage, { status: "partial", detail });
    else
      inboxCoverage.push({ source, status: "partial", items_read: 0, detail });
    inboxResults.push({
      source_id: finding.source_id,
      status: "partial",
      detail,
    });
  };
  // Verify at most two candidates, each with at most two source pages. A moved
  // or failed source must not suppress independently verified findings.
  // A model-supplied source ID/quote never suffices to queue a reply.
  const verifiedCandidates = await Promise.all(
    inbox.map(async (finding) => {
      try {
        const expectedFeeds =
          finding.platform === "linkedin"
            ? ["live_messages", "notifications"]
            : ["messages", "activity"];
        if (!expectedFeeds.includes(finding.feed_key))
          throw new Error("Inbox feed does not belong to this platform");
        const binding = bindings[finding.platform];
        const connection = available
          .get(finding.platform)
          ?.find((o) => o.operation_key === binding.readAction)
          ?.execution_targets.find((t) => t.slug === binding.read);
        if (!connection)
          throw new Error("Inbox source connection is unavailable");
        const listed = record(
          await client.feeds.list({
            connection_id: connection.connection_id,
            limit: 100,
          })
        );
        const feeds = Array.isArray(listed.feeds) ? listed.feeds : [];
        const feed = feeds.find(
          (f: any) =>
            f.feed_key === finding.feed_key &&
            f.connection_id === connection.connection_id
        );
        if (!feed) throw new Error("Inbox source feed is unavailable");
        let row: Record<string, any> | undefined;
        let cursor = finding.source_cursor;
        for (let attempt = 0; attempt < 2; attempt++) {
          const read = record(
            await client.feeds.readMany({
              reads: [
                { feed_id: feed.id, limit: 20, ...(cursor ? { cursor } : {}) },
              ],
              timeout_ms: 20000,
            })
          );
          const page = read.results?.[0];
          if (
            !page?.ok ||
            page.feed_id !== feed.id ||
            !Array.isArray(page.rows)
          )
            throw new Error(
              "Inbox verification read failed; source coverage is incomplete"
            );
          row = page.rows.find(
            (r: any) => String(r.origin_id ?? r.id) === finding.source_id
          );
          if (row || !page.next_cursor || page.next_cursor === cursor) break;
          cursor = page.next_cursor;
        }
        const message = ["messages", "live_messages"].includes(
          finding.feed_key
        );
        if (
          !row ||
          typeof row.text !== "string" ||
          !quoteText(finding.quote) ||
          !quoteText(row.text).includes(quoteText(finding.quote)) ||
          !/^[a-f0-9]{64}$/.test(finding.source_revision ?? "") ||
          row.source_revision !== finding.source_revision ||
          (message &&
            (row.from_me !== false ||
              row.recalled !== false ||
              row.has_attachments === true ||
              row.has_uninspected_content === true))
        )
          throw new Error(
            "Inbox finding lacks a matching incoming source record"
          );
        const url = String(
          message
            ? (row.conversation_url ?? row.source_url ?? "")
            : (row.source_url ?? row.url ?? "")
        );
        if (
          message &&
          finding.platform === "linkedin" &&
          !/^https:\/\/www\.linkedin\.com\/messaging\/thread\/[A-Za-z0-9_=-]+\/$/.test(
            url
          )
        )
          throw new Error("Invalid message conversation URL");
        const origin =
          finding.platform === "linkedin"
            ? "https://www.linkedin.com"
            : "https://www.tiktok.com";
        if (url !== origin && !url.startsWith(`${origin}/`))
          throw new Error("Invalid inbox source URL");
        const identity = JSON.stringify([
          finding.platform,
          connection.connection_id,
          finding.feed_key,
          finding.source_id,
        ]);
        const [hash] = await client.query(
          `SELECT encode(sha256(convert_to(${sqlString(identity)}, 'UTF8')), 'hex') AS source_key`
        );
        const digest = record(hash).source_key;
        if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
          throw new Error("Inbox source identity could not be hashed");
        const key = `social-inbox:${digest}`;
        if (seen.has(key))
          throw new Error("Invalid or duplicate inbox source identity");
        seen.add(key);
        return { finding, row, url, key, message };
      } catch (error) {
        partialInbox(
          finding,
          error instanceof Error ? error.message : "Inbox verification failed"
        );
        return null;
      }
    })
  );
  const verifiedInbox = verifiedCandidates.filter(
    (candidate) => candidate !== null
  );
  const source = {
    automation_id: ctx.automation.id,
    run_id: ctx.window.run_id,
  };
  // Runs already retain the original parent window and input. Recover from
  // that durable provenance instead of replaying an old key under a new parent.
  const recoverInboxDraft = async (
    finding: InboxFinding,
    connectionId: number,
    url: string
  ) => {
    const listed = record(
      await client.operations.listRuns({
        run_types: ["action"],
        automation_ids: [ctx.automation.id],
        connection_id: connectionId,
        operation_key: "prepare_message",
        limit: 50,
      })
    );
    const candidates = (Array.isArray(listed.runs) ? listed.runs : []).filter(
      (run: any) =>
        run.connection_id === connectionId &&
        run.automation_id === ctx.automation.id &&
        run.operation_key === "prepare_message" &&
        run.created_by_user_id === recipient &&
        run.input?.conversation_url === url &&
        Number.isSafeInteger(run.parent_run_id)
    );
    if (candidates.length > 8)
      throw new Error(
        "Draft recovery exceeds its bounded lookup; review existing drafts"
      );
    for (const run of candidates) {
      const { run: originalWindow } = await client.operations.getRun(
        run.parent_run_id
      );
      if (
        originalWindow?.automation_id !== ctx.automation.id ||
        originalWindow.status !== "completed"
      )
        continue;
      const prior = record(originalWindow.output).inbox_findings;
      if (!Array.isArray(prior)) continue;
      const originals = prior.filter(
        (f: InboxFinding) =>
          f.platform === finding.platform && f.draft === run.input.body
      );
      // Two indistinguishable bodies in one window cannot prove which source
      // created this run. Never guess a handoff association.
      if (originals.length !== 1) continue;
      const original = originals[0] as InboxFinding;
      if (
        original.feed_key !== finding.feed_key ||
        original.source_id !== finding.source_id
      )
        continue;
      if (original.source_revision !== finding.source_revision)
        throw new Error(
          "An existing draft uses an older source revision; review it before preparing another reply"
        );
      if (!["auto", "approved"].includes(run.approval_status))
        throw new Error(
          "The existing draft is not approved for browser handoff"
        );
      if (!["pending", "running", "claimed", "completed"].includes(run.status))
        throw new Error(
          "The existing draft is no longer available; no replacement was queued"
        );
      return {
        run_id: Number(run.id),
        finding: original,
        completed: run.status === "completed",
      };
    }
    return null;
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
  for (const item of verifiedInbox) {
    const { row, url, key, message } = item;
    let finding = item.finding;
    const previous = await client.query(
      `SELECT id FROM events WHERE metadata ? '_lobu_idempotency_key' AND metadata->>'_lobu_idempotency_key' = ${sqlString(key)} LIMIT 1`
    );
    if (previous.length) {
      inboxResults.push({
        source_id: finding.source_id,
        status: "already_delivered",
      });
      continue;
    }
    let draftRun: number | undefined;
    let draftStatus = finding.draft
      ? "Draft saved for manual use."
      : "No reply suggested.";
    if (message && finding.platform === "linkedin") {
      const target = available
        .get("linkedin")
        ?.find((o) => o.operation_key === "prepare_message")
        ?.execution_targets.find((t) => t.slug === bindings.linkedin.draft);
      if (target) {
        let prior;
        try {
          prior = await recoverInboxDraft(finding, target.connection_id, url);
        } catch (error) {
          partialInbox(
            finding,
            error instanceof Error ? error.message : "Draft recovery failed"
          );
          continue;
        }
        if (prior) {
          finding = prior.finding;
          draftRun = prior.run_id;
          draftStatus = prior.completed
            ? "The existing reply draft was already prepared; review it before sending."
            : "Use Open page to fill the existing reply; you click Send.";
        } else if (finding.draft && target.executable) {
          let staged;
          try {
            staged = await client.operations.execute({
              connection_id: target.connection_id,
              operation_key: "prepare_message",
              input: { conversation_url: url, body: finding.draft },
              activation: { kind: "page_visit", urls: [url] },
              idempotency_key: `${key}:draft`,
              automation_source: source,
            });
          } catch (error) {
            // A concurrent reaction or an ambiguous enqueue response may have
            // committed the draft. The uniqueness/provenance guards stay intact.
            try {
              prior = await recoverInboxDraft(
                finding,
                target.connection_id,
                url
              );
              if (!prior) throw error;
            } catch (recoveryError) {
              partialInbox(
                finding,
                recoveryError instanceof Error
                  ? recoveryError.message
                  : "Draft enqueue or recovery failed"
              );
              continue;
            }
            finding = prior.finding;
            staged = { status: "in_progress", run_id: prior.run_id };
          }
          if (
            staged.status === "in_progress" &&
            typeof staged.run_id === "number"
          ) {
            draftRun = staged.run_id;
            draftStatus = "Use Open page to fill the reply; you click Send.";
          } else draftStatus = `Draft operation: ${staged.status}`;
        } else if (finding.draft)
          draftStatus = "Draft saved; browser handoff needs setup.";
      } else if (finding.draft)
        draftStatus = "Draft saved; browser handoff needs setup.";
    }
    const draftBlock = [
      ...(message && finding.platform === "tiktok"
        ? [
            `Conversation: ${clip(String(row.conversation_name ?? row.conversation_id), 80)}`,
          ]
        : []),
      ...(finding.draft ? [`Suggested reply:\n${finding.draft}`] : []),
      draftStatus,
    ].join("\n\n");
    const contextBudget = Math.floor((1000 - draftBlock.length - 60) / 3);
    const sent = await client.notifications.send({
      title: clip(`${finding.platform} inbox · ${finding.summary}`, 180),
      body: [
        `Why it matters: ${clip(finding.why, contextBudget)}`,
        `Evidence: “${clip(finding.quote, contextBudget)}”`,
        `Context: ${clip(finding.limits, contextBudget)}`,
        draftBlock,
      ].join("\n\n"),
      recipients: [recipient],
      resource_url: url,
      ...(draftRun
        ? { browser_url: url, browser_handoff_run_id: draftRun }
        : {}),
      idempotency_key: key,
      automation_source: source,
    });
    inboxResults.push({
      source_id: finding.source_id,
      notification_id: sent.event_id,
      draft_run_id: draftRun ?? null,
    });
  }
  for (const blocked of inboxCoverage.filter(
    (c) => c.status === "blocked" || verificationIssues.has(c.source)
  )) {
    await client.notifications.send({
      title: `Social inbox ${blocked.status === "blocked" ? "could not read" : "partially verified"} · ${blocked.source}`,
      body: clip(blocked.detail, 1000),
      recipients: [recipient],
      idempotency_key: `social-inbox:setup:${ctx.automation.id}:${blocked.source}:${new Date(start).toISOString().slice(0, 10)}`,
      automation_source: source,
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
  return {
    coverage,
    inbox_coverage: inboxCoverage,
    findings: results,
    inbox_findings: inboxResults,
  };
}
